import {
  Operon,
  OperonConfig,
  WorkflowContext,
  TransactionContext,
  CommunicatorContext,
  WorkflowParams,
  WorkflowHandle,
  OperonWorkflowPermissionDeniedError
} from "src/";
import {
  generateOperonTestConfig,
  teardownOperonTestDb,
  TestKvTable
} from './helpers';
import { v1 as uuidv1 } from 'uuid';
import { sleep } from "src/utils";
import { WorkflowConfig, StatusString } from "src/workflow";

describe('operon-tests', () => {
  const testTableName = 'operon_test_kv';

  let operon: Operon;
  let username: string;
  let config: OperonConfig;

  beforeAll(async () => {
    config = generateOperonTestConfig();
    username = config.poolConfig.user || "postgres";
    await teardownOperonTestDb(config);
  });

  beforeEach(async () => {
    operon = new Operon(config);
    await operon.init();
    operon.registerTopic("testTopic", ["defaultRole"]);
    await operon.pool.query(`DROP TABLE IF EXISTS ${testTableName};`);
    await operon.pool.query(`CREATE TABLE IF NOT EXISTS ${testTableName} (id SERIAL PRIMARY KEY, value TEXT);`);
  });

  afterEach(async () => {
    await operon.destroy();
  });

  test('simple-function', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
      await sleep(10);
      return JSON.stringify(rows[0]);
    };
    operon.registerTransaction(testFunction);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: string = await workflowCtxt.transaction(testFunction, name);
      return funcResult;
    };

    const testWorkflowConfig: WorkflowConfig = {
      rolesThatCanRun: ["operonAppAdmin", "operonAppUser"],
    }
    operon.registerWorkflow(testWorkflow, testWorkflowConfig);

    const params: WorkflowParams = {
      runAs: "operonAppAdmin",
    }
    const workflowHandle: WorkflowHandle<string> = operon.workflow(testWorkflow, params, username);
    expect(typeof workflowHandle.getWorkflowUUID()).toBe('string');
    await expect((await workflowHandle.getStatus()).status).resolves.toBe(StatusString.PENDING);
    const workflowResult: string = await workflowHandle.getResult();
    expect(JSON.parse(workflowResult)).toEqual({"current_user": username});
    
    await operon.flushWorkflowOutputBuffer();
    await expect((await workflowHandle.getStatus()).status).resolves.toBe(StatusString.SUCCESS);
    const retrievedHandle = operon.retrieveWorkflow<string>(workflowHandle.getWorkflowUUID());
    expect(retrievedHandle).not.toBeNull();
    await expect((await retrievedHandle.getStatus()).status).resolves.toBe(StatusString.SUCCESS);
    expect(JSON.parse(await retrievedHandle.getResult())).toEqual({"current_user": username});
  });

  test('simple-function-permission-denied', async() => {
    const testFunction = async (txnCtxt: TransactionContext) => {
      void txnCtxt;
      await sleep(1);
      return;
    };
    operon.registerTransaction(testFunction);

    const testWorkflow = async (workflowCtxt: WorkflowContext) => {
      await workflowCtxt.transaction(testFunction);
      return;
    };
    // Register the workflow as runnable only by admin
    const testWorkflowConfig: WorkflowConfig = {
      rolesThatCanRun: ["operonAppAdmin"],
    }
    operon.registerWorkflow(testWorkflow, testWorkflowConfig);

    const params: WorkflowParams = {
      runAs: "operonAppUser",
    }
    await expect(operon.workflow(testWorkflow, params).getResult()).rejects.toThrow(
      OperonWorkflowPermissionDeniedError
    );
  });

  test('simple-function-default-user-permission-denied', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
      return JSON.stringify(rows[0]);
    };
    operon.registerTransaction(testFunction);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: string = await workflowCtxt.transaction(testFunction, name);
      return funcResult;
    };

    const testWorkflowConfig: WorkflowConfig = {
      rolesThatCanRun: ["operonAppAdmin", "operonAppUser"],
    }
    operon.registerWorkflow(testWorkflow, testWorkflowConfig);

    const hasPermissionSpy = jest.spyOn(operon, 'hasPermission');
    await expect(operon.workflow(testWorkflow, {}, username).getResult()).rejects.toThrow(
      OperonWorkflowPermissionDeniedError
    );
    expect(hasPermissionSpy).toHaveBeenCalledWith(
      "defaultRole",
      testWorkflowConfig
    );
  });

  test('return-void', async() => {
    const testFunction = async (txnCtxt: TransactionContext) => {
      void txnCtxt;
      await sleep(1);
      return;
    };
    operon.registerTransaction(testFunction);
    const workflowUUID = uuidv1();
    await expect(operon.transaction(testFunction, {workflowUUID: workflowUUID})).resolves.toBeFalsy();
    await expect(operon.transaction(testFunction, {workflowUUID: workflowUUID})).resolves.toBeFalsy();
    await expect(operon.transaction(testFunction, {workflowUUID: workflowUUID})).resolves.toBeFalsy();
  });

  test('tight-loop', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      void txnCtxt;
      await sleep(1);
      return name;
    };
    operon.registerTransaction(testFunction);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: string = await workflowCtxt.transaction(testFunction, name);
      return funcResult;
    };
    operon.registerWorkflow(testWorkflow);

    for (let i = 0; i < 100; i++) {
      await expect(operon.workflow(testWorkflow, {}, username).getResult()).resolves.toBe(username);
    }
  });
  

  test('abort-function', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName}(value) VALUES ($1) RETURNING id`, [name]);
      if (name === "fail") {
        await txnCtxt.rollback();
      }
      return Number(rows[0].id);
    };
    operon.registerTransaction(testFunction);

    const testFunctionRead = async (txnCtxt: TransactionContext, id: number) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>(`SELECT id FROM ${testTableName} WHERE id=$1`, [id]);
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };
    operon.registerTransaction(testFunctionRead);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, name);
      const checkResult: number = await workflowCtxt.transaction(testFunctionRead, funcResult);
      return checkResult;
    };
    operon.registerWorkflow(testWorkflow);

    for (let i = 0; i < 10; i++) {
      await expect(operon.workflow(testWorkflow, {}, username).getResult()).resolves.toBe(i + 1);
    }
    
    // Should not appear in the database.
    await expect(operon.workflow(testWorkflow, {}, "fail").getResult()).resolves.toBe(-1);
  });

  test('multiple-aborts', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName}(value) VALUES ($1) RETURNING id`, [name]);
      if (name !== "fail") {
        // Recursively call itself so we have multiple rollbacks.
        await testFunction(txnCtxt, "fail");
      }
      await txnCtxt.rollback();
      return Number(rows[0].id);
    };
    operon.registerTransaction(testFunction);

    const testFunctionRead = async (txnCtxt: TransactionContext, id: number) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>(`SELECT id FROM ${testTableName} WHERE id=$1`, [id]);
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };
    operon.registerTransaction(testFunctionRead);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, name);
      const checkResult: number = await workflowCtxt.transaction(testFunctionRead, funcResult);
      return checkResult;
    };
    operon.registerWorkflow(testWorkflow);

    // Should not appear in the database.
    const workflowResult: number = await operon.workflow(testWorkflow, {}, "test").getResult();
    expect(workflowResult).toEqual(-1);
  });


  test('oaoo-simple', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName}(value) VALUES ($1) RETURNING id`, [name]);
      if (name === "fail") {
        await txnCtxt.rollback();
      }
      return Number(rows[0].id);
    };
    operon.registerTransaction(testFunction);

    const testFunctionRead = async (txnCtxt: TransactionContext, id: number) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>(`SELECT id FROM ${testTableName} WHERE id=$1`, [id]);
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };
    operon.registerTransaction(testFunctionRead);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, name);
      const checkResult: number = await workflowCtxt.transaction(testFunctionRead, funcResult);
      return checkResult;
    };
    operon.registerWorkflow(testWorkflow);

    let workflowResult: number;
    const uuidArray: string[] = [];
    for (let i = 0; i < 10; i++) {
      const workflowUUID: string = uuidv1();
      uuidArray.push(workflowUUID);
      workflowResult = await operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, username).getResult();
      expect(workflowResult).toEqual(i + 1);
    }
    // Should not appear in the database.
    const failUUID: string = uuidv1();
    workflowResult = await operon.workflow(testWorkflow, {workflowUUID: failUUID}, "fail").getResult();
    expect(workflowResult).toEqual(-1);

    // Rerunning with the same workflow UUID should return the same output.
    for (let i = 0; i < 10; i++) {
      const workflowUUID: string = uuidArray[i];
      const workflowResult: number = await operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, username).getResult();
      expect(workflowResult).toEqual(i + 1);
    }
    // Given the same workflow UUID but different input, should return the original execution.
    workflowResult = await operon.workflow(testWorkflow, {workflowUUID: failUUID}, "hello").getResult();
    expect(workflowResult).toEqual(-1);
  });


  test('simple-communicator', async() => {
    let counter = 0;
    const testCommunicator = async (commCtxt: CommunicatorContext) => {
      void commCtxt;
      await sleep(1);
      return counter++;
    };
    operon.registerCommunicator(testCommunicator);

    const testWorkflow = async (workflowCtxt: WorkflowContext) => {
      const funcResult = await workflowCtxt.external(testCommunicator);
      return funcResult ?? -1;
    };
    operon.registerWorkflow(testWorkflow);

    const workflowUUID: string = uuidv1();

    let result: number = await operon.workflow(testWorkflow, {workflowUUID: workflowUUID}).getResult();
    expect(result).toBe(0);

    // Test OAOO. Should return the original result.
    result = await operon.workflow(testWorkflow, {workflowUUID: workflowUUID}).getResult();
    expect(result).toBe(0);
  });

  test('simple-workflow-notifications', async() => {
    const receiveWorkflow = async(ctxt: WorkflowContext) => {
      const test = await ctxt.recv("testTopic", "test", 2) as number;
      const fail = await ctxt.recv("testTopic", "fail", 0) ;
      return test === 0 && fail === null;
    }
    operon.registerWorkflow(receiveWorkflow);

    const sendWorkflow = async(ctxt: WorkflowContext) => {
      return await ctxt.send("testTopic", "test", 0);
    }
    operon.registerWorkflow(sendWorkflow);

    const workflowUUID = uuidv1();
    const promise = operon.workflow(receiveWorkflow, {workflowUUID: workflowUUID}).getResult();
    const send = await operon.workflow(sendWorkflow, {}).getResult();
    expect(send).toBe(true);
    expect(await promise).toBe(true);
    const retry = await operon.workflow(receiveWorkflow, {workflowUUID: workflowUUID}).getResult();
    expect(retry).toBe(true);
  });

  test('simple-operon-notifications', async() => {
    // Send and have a receiver waiting.
    const promise = operon.recv({}, "testTopic", "test", 2);
    const send = await operon.send({}, "testTopic", "test", 123);
    expect(send).toBe(true);
    expect(await promise).toBe(123);

    // Send and then receive.
    await expect(operon.send({}, "testTopic", "test2", 456)).resolves.toBe(true);
    await sleep(10);
    await expect(operon.recv({}, "testTopic", "test2", 1)).resolves.toBe(456);
  });

  test('notification-oaoo',async () => {
    const sendWorkflowUUID = uuidv1();
    const recvWorkflowUUID = uuidv1();
    const promise = operon.recv({workflowUUID: recvWorkflowUUID}, "testTopic", "test", 1);
    const send = await operon.send({workflowUUID: sendWorkflowUUID}, "testTopic", "test", 123);
    expect(send).toBe(true);

    expect(await promise).toBe(123);

    // Send again with the same UUID but different input.
    // Even we sent it twice, it should still be 123.
    await expect(operon.send({workflowUUID: sendWorkflowUUID}, "testTopic", "test", 123)).resolves.toBe(true);

    await expect(operon.recv({workflowUUID: recvWorkflowUUID}, "testTopic", "test", 1)).resolves.toBe(123);

    // Receive again with the same workflowUUID, should get the same result.
    await expect(operon.recv({workflowUUID: recvWorkflowUUID}, "testTopic", "test", 1)).resolves.toBe(123);

    // Receive again with the different workflowUUID.
    await expect(operon.recv({}, "testTopic", "test", 2)).resolves.toBeNull();
  });

  test('endtoend-oaoo', async () => {
    let num = 0;
  
    const testFunction = async (txnCtxt: TransactionContext, code: number) => {
      void txnCtxt;
      await sleep(1);
      return code + 1;
    };
  
    const testWorkflow = async (workflowCtxt: WorkflowContext, code: number) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, code);
      num += 1;
      return funcResult;
    };
    operon.registerTransaction(testFunction, {readOnly: true});
    operon.registerWorkflow(testWorkflow);
  
    const workflowUUID = uuidv1();
    await expect(operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 10).getResult()).resolves.toBe(11);
    expect(num).toBe(1);
  
    await operon.flushWorkflowOutputBuffer();
    // Run it again with the same UUID, should get the same output.
    await expect(operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 10).getResult()).resolves.toBe(11);
    // The workflow should not run at all.
    expect(num).toBe(1);
  });

  test('readonly-recording', async() => {
    let num = 0;
    let workflowCnt = 0;

    const readFunction = async (txnCtxt: TransactionContext, id: number) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`SELECT value FROM ${testTableName} WHERE id=$1`, [id]);
      num += 1;
      if (rows.length === 0) {
        return null;
      }
      return rows[0].value;
    };
    operon.registerTransaction(readFunction, {readOnly: true});

    const writeFunction = async (txnCtxt: TransactionContext, id: number, name: string) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName} (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value RETURNING value;`, [id, name]);
      return rows[0].value;
    };
    operon.registerTransaction(writeFunction, {});

    const testWorkflow = async (workflowCtxt: WorkflowContext, id: number, name: string) => {
      await workflowCtxt.transaction(readFunction, id);
      workflowCnt += 1;
      await workflowCtxt.transaction(writeFunction, id, name);
      workflowCnt += 1; // Make sure the workflow actually runs.
      throw Error("dumb test error");
    };
    operon.registerWorkflow(testWorkflow, {});

    const workflowUUID = uuidv1();

    // Invoke the workflow, should get the error.
    await expect(operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 123, "test").getResult()).rejects.toThrowError(new Error("dumb test error"));
    expect(num).toBe(1);
    expect(workflowCnt).toBe(2);

    // Invoke it again, should return the recorded same error.
    await expect(operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 123, "test").getResult()).rejects.toThrowError(new Error("dumb test error"));
    expect(num).toBe(1);
    expect(workflowCnt).toBe(2);
  });

  test('retrieve-workflowstatus', async() => {
    // Test workflow status changes correctly.
    let resolve1: () => void;
    const promise1 = new Promise<void>((resolve) => {
      resolve1 = resolve;
    });

    let resolve2: () => void;
    const promise2 = new Promise<void>((resolve) => {
      resolve2 = resolve;
    });

    let resolve3: () => void;
    const promise3 = new Promise<void>((resolve) => {
      resolve3 = resolve;
    });

    const writeFunction = async (txnCtxt: TransactionContext, id: number, name: string) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName} (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value RETURNING value;`, [id, name]);
      return rows[0].value!;
    };
    operon.registerTransaction(writeFunction, {});

    const testWorkflow = async (workflowCtxt: WorkflowContext, id: number, name: string) => {
      await promise1;
      const value = await workflowCtxt.transaction(writeFunction, id, name);
      resolve3();  // Signal the execution has done.
      await promise2;
      return value;
    };
    operon.registerWorkflow(testWorkflow, {});

    const workflowUUID = uuidv1();

    const workflowHandle = operon.workflow(testWorkflow,  {workflowUUID: workflowUUID}, 123, "hello");

    expect(workflowHandle.getWorkflowUUID()).toBe(workflowUUID);
    await expect((await workflowHandle.getStatus()).status).resolves.toBe(StatusString.PENDING);

    // Retrieve handle, should get the unknown status.
    await expect((await operon.retrieveWorkflow<string>(workflowUUID).getStatus()).status).resolves.toBe(StatusString.UNKNOWN);

    resolve1!();
    await promise3;

    // TODO: check pending state.

    // Proceed to the end.
    resolve2!();
    await expect(workflowHandle.getResult()).resolves.toBe("hello");
  
    // Flush workflow output buffer so the retrieved handle can proceed and the status would transition to SUCCESS.
    await operon.flushWorkflowOutputBuffer();
    const retrievedHandle = operon.retrieveWorkflow<string>(workflowUUID);
    expect(retrievedHandle).not.toBeNull();
    expect(retrievedHandle.getWorkflowUUID()).toBe(workflowUUID);
    await expect(retrievedHandle.getResult()).resolves.toBe("hello");
    await expect((await workflowHandle.getStatus()).status).resolves.toBe(StatusString.SUCCESS);
    await expect((await retrievedHandle.getStatus()).status).resolves.toBe(StatusString.SUCCESS);
  });
});

