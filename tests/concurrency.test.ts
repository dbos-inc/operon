import { CommunicatorContext, Operon, OperonConfig, TransactionContext, WorkflowContext } from "src/";
import { v1 as uuidv1 } from 'uuid';
import { sleep } from "src/utils";
import { generateOperonTestConfig, teardownOperonTestDb } from "./helpers";
import { WorkflowStatus } from "src/workflow";

describe('concurrency-tests', () => {
  let operon: Operon;
  const testTableName = 'operon_concurrency_test_kv';

  let config: OperonConfig;

  beforeAll(async () => {
    config = generateOperonTestConfig();
    await teardownOperonTestDb(config);
  });

  beforeEach(async () => {
    operon = new Operon(config);
    await operon.init();
    await operon.pool.query(`DROP TABLE IF EXISTS ${testTableName};`);
    await operon.pool.query(`CREATE TABLE IF NOT EXISTS ${testTableName} (id INTEGER PRIMARY KEY, value TEXT);`);
  });

  afterEach(async () => {
    await operon.destroy();
  });

  test('duplicate-transaction',async () => {
    // Run two transactions concurrently with the same UUID.
    // Both should return the correct result but only one should execute.
    const remoteState = {
      cnt: 0
    };
    const testFunction = async (txnCtxt: TransactionContext, id: number) => {
      await sleep(10);
      remoteState.cnt += 1;
      return id;
    };
    operon.registerTransaction(testFunction);

    const workflowUUID = uuidv1();
    let results = await Promise.allSettled([
      operon.transaction(testFunction, {workflowUUID: workflowUUID}, 10),
      operon.transaction(testFunction, {workflowUUID: workflowUUID}, 10)
    ]);
    expect((results[0] as PromiseFulfilledResult<number>).value).toBe(10);
    expect((results[1] as PromiseFulfilledResult<number>).value).toBe(10);
    expect(remoteState.cnt).toBe(1);

    // Read-only transactions would execute twice.
    remoteState.cnt = 0;
    operon.registerTransaction(testFunction, {readOnly: true});
    const readUUID = uuidv1();
    results = await Promise.allSettled([
      operon.transaction(testFunction, {workflowUUID: readUUID}, 12),
      operon.transaction(testFunction, {workflowUUID: readUUID}, 12)
    ]);
    expect((results[0] as PromiseFulfilledResult<number>).value).toBe(12);
    expect((results[1] as PromiseFulfilledResult<number>).value).toBe(12);
    expect(remoteState.cnt).toBe(2);
  });

  test('concurrent-gc',async () => {
    clearInterval(operon.flushBufferID);

    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });

    let resolve2: () => void;
    const promise2 = new Promise<void>((r) => {
      resolve2 = r;
    });

    let wfCounter = 0;
    let funCounter = 0;

    const testWorkflow = async(ctxt: WorkflowContext) => {
      if (wfCounter++ === 1) {
        resolve2!();
        await promise;
      }
      await ctxt.transaction(testFunction);
    }
    operon.registerWorkflow(testWorkflow);

    const testFunction = async (ctxt: TransactionContext) => {
      void ctxt;
      await sleep(1);
      funCounter++;
      return;
    };
    operon.registerTransaction(testFunction);

    const uuid = uuidv1();
    await operon.workflow(testWorkflow, {workflowUUID: uuid}).getResult();
    const handle = operon.workflow(testWorkflow, {workflowUUID: uuid});
    await promise2;
    await operon.flushWorkflowOutputBuffer();
    resolve!();
    await handle.getResult();

    expect(funCounter).toBe(1);
    expect(wfCounter).toBe(2);
  });

  test('duplicate-communicator',async () => {
    // Run two communicators concurrently with the same UUID; both should succeed.
    // Since we only record the output after the function, it may cause more than once executions.
    let counter = 0;
    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });

    let resolve2: () => void;
    const promise2 = new Promise<void>((r) => {
      resolve2 = r;
    });

    const testFunction = async (ctxt: CommunicatorContext, id: number) => {
      if (counter++ === 1) {
        await promise;
        resolve2();
      } else {
        resolve();
        await promise2;
      }
      void ctxt;
      return id;
    };
    operon.registerCommunicator(testFunction, {retriesAllowed: false});

    const testWorkflow = async (workflowCtxt: WorkflowContext, id: number) => {
      const funcResult = await workflowCtxt.external(testFunction, id);
      return funcResult ?? "error";
    };
    operon.registerWorkflow(testWorkflow);

    const workflowUUID = uuidv1();
    const results = await Promise.allSettled([
      operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 11).getResult(),
      operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 11).getResult()
    ]);
    expect((results[0] as PromiseFulfilledResult<number>).value).toBe(11);
    expect((results[1] as PromiseFulfilledResult<number>).value).toBe(11);

    expect(counter).toBe(2);
  });

  test('duplicate-notifications',async () => {
    // Run two send/recv concurrently with the same UUID, both should succeed.
    // It's a bit hard to trigger conflicting send because the transaction runs quickly.

    // Disable flush workflow output background task for tests.
    // Workflow output buffer should be updated in the same transaction with send/recv for temporary workflows.
    clearInterval(operon.flushBufferID);
    
    const recvUUID = uuidv1();
    const sendUUID = uuidv1();
    operon.registerTopic('testTopic', ['defaultRole']);
    const recvResPromise = Promise.allSettled([
      operon.recv({workflowUUID: recvUUID}, 'testTopic', 'testmsg', 2),
      operon.recv({workflowUUID: recvUUID}, 'testTopic', 'testmsg', 2)
    ]);

    // Send would trigger both to receive, but only one can succeed.
    await sleep(10); // Both would be listening to the notification.
    await expect(operon.send({workflowUUID: sendUUID}, "testTopic", "testmsg", "hello")).resolves.toBe(true);
    const recvRes = await recvResPromise;
    expect((recvRes[0] as PromiseFulfilledResult<boolean>).value).toBe("hello");
    expect((recvRes[1] as PromiseFulfilledResult<boolean>).value).toBe("hello");

    // Make sure we retrieve results correctly.
    const sendHandle = await operon.retrieveWorkflow(sendUUID);
    await expect(sendHandle!.getStatus()).resolves.toBe(WorkflowStatus.SUCCESS);
    await expect(sendHandle!.getResult()).resolves.toBe(true);

    const recvHandle = await operon.retrieveWorkflow(recvUUID);
    await expect(recvHandle!.getStatus()).resolves.toBe(WorkflowStatus.SUCCESS);
    await expect(recvHandle!.getResult()).resolves.toBe("hello");
  });

});
