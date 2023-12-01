/* eslint-disable @typescript-eslint/no-explicit-any */
import { DBOSExecutor, DBOSNull, dbosNull } from "./dbos-executor";
import { transaction_outputs } from "../schemas/user_db_schema";
import { IsolationLevel, Transaction, TransactionContext, TransactionContextImpl } from "./transaction";
import { Communicator, CommunicatorContext, CommunicatorContextImpl } from "./communicator";
import { DBOSError, DBOSNotRegisteredError, DBOSWorkflowConflictUUIDError } from "./error";
import { serializeError, deserializeError } from "serialize-error";
import { sleep } from "./utils";
import { SystemDatabase } from "./system_database";
import { UserDatabaseClient } from "./user_database";
import { SpanStatusCode } from "@opentelemetry/api";
import { Span } from "@opentelemetry/sdk-trace-base";
import { HTTPRequest, DBOSContext, DBOSContextImpl } from './context';
import { getRegisteredOperations } from "./decorators";

export type Workflow<T extends any[], R> = (ctxt: WorkflowContext, ...args: T) => Promise<R>;

// Utility type that removes the initial parameter of a function
export type TailParameters<T extends (arg: any, args: any[]) => any> = T extends (arg: any, ...args: infer P) => any ? P : never;

// local type declarations for transaction and communicator functions
type TxFunc = (ctxt: TransactionContext<any>, ...args: any[]) => Promise<any>;
type CommFunc = (ctxt: CommunicatorContext, ...args: any[]) => Promise<any>;

// Utility type that only includes transaction/communicator functions + converts the method signature to exclude the context parameter
export type WFInvokeFuncs<T> = {
  [P in keyof T as T[P] extends TxFunc | CommFunc ? P : never]: T[P] extends  TxFunc | CommFunc ? (...args: TailParameters<T[P]>) => ReturnType<T[P]> : never;
}

export interface WorkflowParams {
  workflowUUID?: string;
  parentCtx?: DBOSContextImpl;
}

export interface WorkflowConfig {
  // TODO: add workflow config here.
}

export interface WorkflowStatus {
  readonly status: string; // The status of the workflow.  One of PENDING, SUCCESS, or ERROR.
  readonly workflowName: string; // The name of the workflow function.
  readonly authenticatedUser: string; // The user who ran the workflow. Empty string if not set.
  readonly assumedRole: string; // The role used to run this workflow.  Empty string if authorization is not required.
  readonly authenticatedRoles: string[]; // All roles the authenticated user has, if any.
  readonly request: HTTPRequest; // The parent request for this workflow, if any.
}

export interface PgTransactionId {
  txid: string;
}

interface BufferedResult {
  output: unknown;
  txn_snapshot: string;
}

export const StatusString = {
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  ERROR: "ERROR",
} as const;

export interface WorkflowContext extends DBOSContext {
  invoke<T extends object>(targetClass: T): WFInvokeFuncs<T>;
  childWorkflow<T extends any[], R>(wf: Workflow<T, R>, ...args: T): Promise<WorkflowHandle<R>>;

  send<T extends NonNullable<any>>(destinationUUID: string, message: T, topic?: string): Promise<void>;
  recv<T extends NonNullable<any>>(topic?: string, timeoutSeconds?: number): Promise<T | null>;
  setEvent<T extends NonNullable<any>>(key: string, value: T): Promise<void>;

  getEvent<T extends NonNullable<any>>(workflowUUID: string, key: string, timeoutSeconds?: number): Promise<T | null>;
  retrieveWorkflow<R>(workflowUUID: string): WorkflowHandle<R>;
}

export class WorkflowContextImpl extends DBOSContextImpl implements WorkflowContext {
  functionID: number = 0;
  readonly #wfe;
  readonly resultBuffer: Map<number, BufferedResult> = new Map<number, BufferedResult>();
  readonly isTempWorkflow: boolean;

  constructor(
    wfe: DBOSExecutor,
    parentCtx: DBOSContextImpl | undefined,
    workflowUUID: string,
    readonly workflowConfig: WorkflowConfig,
    workflowName: string
  ) {
    const span = wfe.tracer.startSpan(
      workflowName,
      {
        workflowUUID: workflowUUID,
        operationName: workflowName,
        runAs: parentCtx?.authenticatedUser ?? "",
      },
      parentCtx?.span,
    );
    super(workflowName, span, wfe.logger, parentCtx);
    this.workflowUUID = workflowUUID;
    this.#wfe = wfe;
    this.isTempWorkflow = wfe.tempWorkflowName === workflowName;
    if (wfe.config.application) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      this.applicationConfig = wfe.config.application;
    }
  }

  functionIDGetIncrement(): number {
    return this.functionID++;
  }

  /**
   * Check if an operation has already executed in a workflow.
   * If it previously executed successfully, return its output.
   * If it previously executed and threw an error, throw that error.
   * Otherwise, return DBOSNull.
   * Also return the transaction snapshot information of this current transaction.
   */
  async checkExecution<R>(client: UserDatabaseClient, funcID: number): Promise<BufferedResult> {
    // Note: we read the current snapshot, not the recorded one!
    const rows = await this.#wfe.userDatabase.queryWithClient<transaction_outputs & { recorded: boolean }>(
      client,
      "(SELECT output, error, pg_current_snapshot()::text as txn_snapshot, true as recorded FROM dbos.transaction_outputs WHERE workflow_uuid=$1 AND function_id=$2 UNION ALL SELECT null as output, null as error, pg_current_snapshot()::text as txn_snapshot, false as recorded) ORDER BY recorded",
      this.workflowUUID,
      funcID
    );

    if (rows.length === 0 || rows.length > 2) {
      this.logger.error("Unexpected! This should never happen. Returned rows: " + rows.toString());
      throw new DBOSError("This should never happen. Returned rows: " + rows.toString());
    }

    const res: BufferedResult = {
      output: dbosNull,
      txn_snapshot: ""
    }
    // recorded=false row will be first because we used ORDER BY.
    res.txn_snapshot = rows[0].txn_snapshot;
    if (rows.length === 2) {
      if (JSON.parse(rows[1].error) !== null) {
        throw deserializeError(JSON.parse(rows[1].error));
      } else {
        res.output = JSON.parse(rows[1].output) as R;
      }
    }
    return res;
  }

  async prepareDebugExecution<R>(client: UserDatabaseClient, funcID: number): Promise<BufferedResult & {txn_id: string}> {
    // Note: we read the recorded snapshot and transaction ID!
    const query = "SELECT output, error, txn_snapshot, txn_id FROM operon.transaction_outputs WHERE workflow_uuid=$1 AND function_id=$2";

    const rows = await this.#wfe.userDatabase.queryWithClient<transaction_outputs>(
      client,
      query,
      this.workflowUUID,
      funcID
    );

    if (rows.length === 0 || rows.length > 1) {
      this.logger.error("Unexpected! This should never happen during debug. Returned rows: " + rows.toString());
      throw new DBOSError("This should never happen during debug. Returned rows: " + rows.toString());
    }

    if (JSON.parse(rows[0].error) != null) {
      throw deserializeError(JSON.parse(rows[0].error)); // We don't replay errors.
    }

    const res: BufferedResult & {txn_id: string}= {
      output: rows[0].output as R,
      txn_snapshot: rows[0].txn_snapshot,
      txn_id: rows[0].txn_id,
    }

    // Send a signal to the debug proxy.
    await this.#wfe.userDatabase.queryWithClient(client, `--proxy(${res.txn_snapshot},${res.txn_id})`);

    return res;
  }

  /**
   * Write all entries in the workflow result buffer to the database.
   * If it encounters a primary key error, this indicates a concurrent execution with the same UUID, so throw an DBOSError.
   */
  async flushResultBuffer(client: UserDatabaseClient): Promise<void> {
    const funcIDs = Array.from(this.resultBuffer.keys());
    if (funcIDs.length === 0) {
      return;
    }
    funcIDs.sort();
    try {
      let sqlStmt = "INSERT INTO dbos.transaction_outputs (workflow_uuid, function_id, output, error, txn_id, txn_snapshot) VALUES ";
      let paramCnt = 1;
      const values: any[] = [];
      for (const funcID of funcIDs) {
        // Capture output and also transaction snapshot information.
        // Initially, no txn_id because no queries executed.
        const recorded = this.resultBuffer.get(funcID);
        const output = recorded!.output;
        const txnSnapshot = recorded!.txn_snapshot;
        if (paramCnt > 1) {
          sqlStmt += ", ";
        }
        sqlStmt += `($${paramCnt++}, $${paramCnt++}, $${paramCnt++}, $${paramCnt++}, null, $${paramCnt++})`;
        values.push(this.workflowUUID, funcID, JSON.stringify(output), JSON.stringify(null), txnSnapshot);
      }
      this.logger.debug(sqlStmt);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await this.#wfe.userDatabase.queryWithClient(client, sqlStmt, ...values);
    } catch (error) {
      if (this.#wfe.userDatabase.isKeyConflictError(error)) {
        // Serialization and primary key conflict (Postgres).
        throw new DBOSWorkflowConflictUUIDError(this.workflowUUID);
      } else {
        throw error;
      }
    }
  }

  /**
   * Buffer a placeholder value to guard an operation against concurrent executions with the same UUID.
   */
  guardOperation(funcID: number, txnSnapshot: string) {
    const guardOutput: BufferedResult = {
      output: null,
      txn_snapshot: txnSnapshot,
    }
    this.resultBuffer.set(funcID, guardOutput);
  }

  /**
   * Write a guarded operation's output to the database.
   */
  async recordGuardedOutput<R>(client: UserDatabaseClient, funcID: number, output: R): Promise<string> {
    const serialOutput = JSON.stringify(output);
    const rows = await this.#wfe.userDatabase.queryWithClient<transaction_outputs>(client, "UPDATE dbos.transaction_outputs SET output=$1, txn_id=(select pg_current_xact_id_if_assigned()::text) WHERE workflow_uuid=$2 AND function_id=$3 RETURNING txn_id;", serialOutput, this.workflowUUID, funcID);
    return rows[0].txn_id;  // Must have a transaction ID because we inserted the guard before.
  }

  /**
   * Record an error in a guarded operation to the database.
   */
  async recordGuardedError(client: UserDatabaseClient, funcID: number, err: Error) {
    const serialErr = JSON.stringify(serializeError(err));
    await this.#wfe.userDatabase.queryWithClient(client, "UPDATE dbos.transaction_outputs SET error=$1 WHERE workflow_uuid=$2 AND function_id=$3;", serialErr, this.workflowUUID, funcID);
  }

  /**
   * Invoke another workflow as its child workflow and return a workflow handle.
   * The child workflow is guaranteed to be executed exactly once, even if the workflow is retried with the same UUID.
   * We pass in itself as a parent context adn assign the child workflow with a deterministic UUID "this.workflowUUID-functionID", which appends a function ID to its own UUID.
   * We also pass in its own workflowUUID and function ID so the invoked handle is deterministic.
   */
  async childWorkflow<T extends any[], R>(wf: Workflow<T, R>, ...args: T): Promise<WorkflowHandle<R>> {
    // Note: cannot use invoke for childWorkflow because of potential recursive types on the workflow itself.
    const funcId = this.functionIDGetIncrement();
    const childUUID: string = this.workflowUUID + "-" + funcId;
    if (this.#wfe.debugMode) {
      return this.#wfe.debugWorkflow(wf, { parentCtx: this, workflowUUID: childUUID }, this.workflowUUID, funcId, ...args);
    }
    return this.#wfe.internalWorkflow(wf, { parentCtx: this, workflowUUID: childUUID }, this.workflowUUID, funcId, ...args);
  }

  /**
   * Execute a transactional function.
   * The transaction is guaranteed to execute exactly once, even if the workflow is retried with the same UUID.
   * If the transaction encounters a Postgres serialization error, retry it.
   * If it encounters any other error, throw it.
   */
  async transaction<T extends any[], R>(txn: Transaction<T, R>, ...args: T): Promise<R> {
    const config = this.#wfe.transactionConfigMap.get(txn.name);
    if (config === undefined) {
      throw new DBOSNotRegisteredError(txn.name);
    }
    const readOnly = config.readOnly ?? false;
    let retryWaitMillis = 1;
    const backoffFactor = 2;
    const funcId = this.functionIDGetIncrement();
    const span: Span = this.#wfe.tracer.startSpan(
      txn.name,
      {
        workflowUUID: this.workflowUUID,
        operationName: txn.name,
        runAs: this.authenticatedUser,
        readOnly: readOnly,
        isolationLevel: config.isolationLevel,
      },
      this.span,
    );
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const wrappedTransaction = async (client: UserDatabaseClient): Promise<R> => {
        // Check if this execution previously happened, returning its original result if it did.

        const tCtxt = new TransactionContextImpl(
          this.#wfe.userDatabase.getName(), client, this,
          span, this.#wfe.logger, funcId, txn.name,
        );
        const check: BufferedResult = await this.checkExecution<R>(client, funcId);
        if (check.output !== dbosNull) {
          tCtxt.span.setAttribute("cached", true);
          tCtxt.span.setStatus({ code: SpanStatusCode.OK });
          this.#wfe.tracer.endSpan(tCtxt.span);
          return check.output as R;
        }

        // Flush the result buffer, setting a guard to block concurrent executions with the same UUID.
        this.guardOperation(funcId, check.txn_snapshot);
        if (!readOnly) {
          await this.flushResultBuffer(client);
        }

        // Execute the user's transaction.
        const result = await txn(tCtxt, ...args);

        // Record the execution, commit, and return.
        if (readOnly) {
          // Buffer the output of read-only transactions instead of synchronously writing it.
          const guardOutput: BufferedResult = {
            output: result,
            txn_snapshot: check.txn_snapshot,
          }
          this.resultBuffer.set(funcId, guardOutput);
        } else {
          // Synchronously record the output of write transactions and obtain the transaction ID.
          const pg_txn_id = await this.recordGuardedOutput<R>(client, funcId, result);
          tCtxt.span.setAttribute("transaction_id", pg_txn_id);
          this.resultBuffer.clear();
        }

        return result;
      };

      try {
        const result = await this.#wfe.userDatabase.transaction(wrappedTransaction, config);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        if (this.#wfe.userDatabase.isRetriableTransactionError(err)) {
          // serialization_failure in PostgreSQL
          span.addEvent("TXN SERIALIZATION FAILURE", { retryWaitMillis });
          // Retry serialization failures.
          await sleep(retryWaitMillis);
          retryWaitMillis *= backoffFactor;
          continue;
        }

        // Record and throw other errors.
        const e: Error = err as Error;
        await this.#wfe.userDatabase.transaction(async (client: UserDatabaseClient) => {
          await this.flushResultBuffer(client);
          await this.recordGuardedError(client, funcId, e);
        }, { isolationLevel: IsolationLevel.ReadCommitted });
        this.resultBuffer.clear();
        span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        throw err;
      } finally {
        this.#wfe.tracer.endSpan(span);
      }
    }
  }

  /**
   * Execute a communicator function.
   * If it encounters any error, retry according to its configured retry policy until the maximum number of attempts is reached, then throw an DBOSError.
   * The communicator may execute many times, but once it is complete, it will not re-execute.
   */
  async external<T extends any[], R>(commFn: Communicator<T, R>, ...args: T): Promise<R> {
    const commConfig = this.#wfe.communicatorConfigMap.get(commFn.name);
    if (commConfig === undefined) {
      throw new DBOSNotRegisteredError(commFn.name);
    }

    const funcID = this.functionIDGetIncrement();

    const span: Span = this.#wfe.tracer.startSpan(
      commFn.name,
      {
        workflowUUID: this.workflowUUID,
        operationName: commFn.name,
        runAs: this.authenticatedUser,
        retriesAllowed: commConfig.retriesAllowed,
        intervalSeconds: commConfig.intervalSeconds,
        maxAttempts: commConfig.maxAttempts,
        backoffRate: commConfig.backoffRate,
      },
      this.span,
    );
    const ctxt: CommunicatorContextImpl = new CommunicatorContextImpl(this, funcID, span, this.#wfe.logger, commConfig, commFn.name);

    await this.#wfe.userDatabase.transaction(async (client: UserDatabaseClient) => {
      await this.flushResultBuffer(client);
    }, { isolationLevel: IsolationLevel.ReadCommitted });
    this.resultBuffer.clear();

    // Check if this execution previously happened, returning its original result if it did.
    const check: R | DBOSNull = await this.#wfe.systemDatabase.checkOperationOutput<R>(this.workflowUUID, ctxt.functionID);
    if (check !== dbosNull) {
      ctxt.span.setAttribute("cached", true);
      ctxt.span.setStatus({ code: SpanStatusCode.OK });
      this.#wfe.tracer.endSpan(ctxt.span);
      return check as R;
    }

    // Execute the communicator function.  If it throws an exception, retry with exponential backoff.
    // After reaching the maximum number of retries, throw an DBOSError.
    let result: R | DBOSNull = dbosNull;
    let err: Error | DBOSNull = dbosNull;
    if (ctxt.retriesAllowed) {
      let numAttempts = 0;
      let intervalSeconds: number = ctxt.intervalSeconds;
      while (result === dbosNull && numAttempts++ < ctxt.maxAttempts) {
        try {
          result = await commFn(ctxt, ...args);
        } catch (error) {
          if (numAttempts < ctxt.maxAttempts) {
            // Sleep for an interval, then increase the interval by backoffRate.
            await sleep(intervalSeconds);
            intervalSeconds *= ctxt.backoffRate;
          }
          ctxt.span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          this.#wfe.tracer.endSpan(ctxt.span);
        }
      }
    } else {
      try {
        result = await commFn(ctxt, ...args);
      } catch (error) {
        err = error as Error;
        ctxt.span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        this.#wfe.tracer.endSpan(ctxt.span);
      }
    }

    // `result` can only be dbosNull when the communicator timed out
    if (result === dbosNull) {
      // Record the error, then throw it.
      err = err === dbosNull ? new DBOSError("Communicator reached maximum retries.", 1) : err;
      await this.#wfe.systemDatabase.recordOperationError(this.workflowUUID, ctxt.functionID, err as Error);
      ctxt.span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      this.#wfe.tracer.endSpan(ctxt.span);
      throw err;
    } else {
      // Record the execution and return.
      await this.#wfe.systemDatabase.recordOperationOutput<R>(this.workflowUUID, ctxt.functionID, result as R);
      ctxt.span.setStatus({ code: SpanStatusCode.OK });
      this.#wfe.tracer.endSpan(ctxt.span);
      return result as R;
    }
  }

  /**
   * Send a message to a workflow identified by a UUID.
   * The message can optionally be tagged with a topic.
   */
  async send<T extends NonNullable<any>>(destinationUUID: string, message: T, topic?: string): Promise<void> {
    const functionID: number = this.functionIDGetIncrement();

    await this.#wfe.userDatabase.transaction(async (client: UserDatabaseClient) => {
      await this.flushResultBuffer(client);
    }, { isolationLevel: IsolationLevel.ReadCommitted });
    this.resultBuffer.clear();

    await this.#wfe.systemDatabase.send(this.workflowUUID, functionID, destinationUUID, message, topic);
  }

  /**
   * Consume and return the oldest unconsumed message sent to your UUID.
   * If a topic is specified, retrieve the oldest message tagged with that topic.
   * Otherwise, retrieve the oldest message with no topic.
   */
  async recv<T extends NonNullable<any>>(topic?: string, timeoutSeconds: number = DBOSExecutor.defaultNotificationTimeoutSec): Promise<T | null> {
    const functionID: number = this.functionIDGetIncrement();

    await this.#wfe.userDatabase.transaction(async (client: UserDatabaseClient) => {
      await this.flushResultBuffer(client);
    }, { isolationLevel: IsolationLevel.ReadCommitted });
    this.resultBuffer.clear();

    return this.#wfe.systemDatabase.recv(this.workflowUUID, functionID, topic, timeoutSeconds);
  }

  /**
   * Emit a workflow event, represented as a key-value pair.
   * Events are immutable once set.
   */
  async setEvent<T extends NonNullable<any>>(key: string, value: T) {
    const functionID: number = this.functionIDGetIncrement();

    await this.#wfe.userDatabase.transaction(async (client: UserDatabaseClient) => {
      await this.flushResultBuffer(client);
    }, { isolationLevel: IsolationLevel.ReadCommitted });
    this.resultBuffer.clear();

    await this.#wfe.systemDatabase.setEvent(this.workflowUUID, functionID, key, value);
  }

  /**
   * Generate a proxy object for the provided class that wraps direct calls (i.e. OpClass.someMethod(param))
   * to use WorkflowContext.Transaction(OpClass.someMethod, param);
   */
  invoke<T extends object>(object: T): WFInvokeFuncs<T> {
    const ops = getRegisteredOperations(object);

    const proxy: any = {};
    for (const op of ops) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      proxy[op.name] = op.txnConfig
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        ? (...args: any[]) => this.transaction(op.registeredFunction as Transaction<any[], any>, ...args)
        : op.commConfig
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        ? (...args: any[]) => this.external(op.registeredFunction as Communicator<any[], any>, ...args)
        : undefined;
    }
    return proxy as WFInvokeFuncs<T>;
  }

  /**
   * Wait for a workflow to emit an event, then return its value.
   */
  getEvent<T extends NonNullable<any>>(targetUUID: string, key: string, timeoutSeconds: number = DBOSExecutor.defaultNotificationTimeoutSec): Promise<T | null> {
    const functionID: number = this.functionIDGetIncrement();
    return this.#wfe.systemDatabase.getEvent(targetUUID, key, timeoutSeconds, this.workflowUUID, functionID);
  }

  /**
   * Retrieve a handle for a workflow UUID.
   */
  retrieveWorkflow<R>(targetUUID: string): WorkflowHandle<R> {
    const functionID: number = this.functionIDGetIncrement();
    return new RetrievedHandle(this.#wfe.systemDatabase, targetUUID, this.workflowUUID, functionID);
  }

}

/**
 * Object representing an active or completed workflow execution, identified by the workflow UUID.
 * Allows retrieval of information about the workflow.
 */
export interface WorkflowHandle<R> {
  /**
   * Retrieve the workflow's status.
   * Statuses are updated asynchronously.
   */
  getStatus(): Promise<WorkflowStatus | null>;
  /**
   * Await workflow completion and return its result.
   */
  getResult(): Promise<R>;
  /**
   * Return the workflow's UUID.
   */
  getWorkflowUUID(): string;
}

/**
 * The handle returned when invoking a workflow with DBOSExecutor.workflow
 */
export class InvokedHandle<R> implements WorkflowHandle<R> {
  constructor(readonly systemDatabase: SystemDatabase, readonly workflowPromise: Promise<R>, readonly workflowUUID: string, readonly workflowName: string,
    readonly callerUUID?: string, readonly callerFunctionID?: number) {}

  getWorkflowUUID(): string {
    return this.workflowUUID;
  }

  async getStatus(): Promise<WorkflowStatus | null> {
    return this.systemDatabase.getWorkflowStatus(this.workflowUUID, this.callerUUID, this.callerFunctionID);
  }

  async getResult(): Promise<R> {
    return this.workflowPromise;
  }
}

/**
 * The handle returned when retrieving a workflow with DBOSExecutor.retrieve
 */
export class RetrievedHandle<R> implements WorkflowHandle<R> {
  constructor(readonly systemDatabase: SystemDatabase, readonly workflowUUID: string, readonly callerUUID?: string, readonly callerFunctionID?: number) {}

  getWorkflowUUID(): string {
    return this.workflowUUID;
  }

  async getStatus(): Promise<WorkflowStatus | null> {
    return await this.systemDatabase.getWorkflowStatus(this.workflowUUID, this.callerUUID, this.callerFunctionID);
  }

  async getResult(): Promise<R> {
    return await this.systemDatabase.getWorkflowResult<R>(this.workflowUUID);
  }
}
