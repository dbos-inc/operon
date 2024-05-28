import { DBOSContext, DBOSContextImpl } from "./context";
import { Span } from "@opentelemetry/sdk-trace-base";
import { GlobalLogger as Logger } from "./telemetry/logs";
import { WorkflowContextImpl } from "./workflow";
import { WorkflowContextDebug } from "./debugger/debug_workflow";
import { Pool } from "pg";

export interface QueryResultBase {
  rowCount: number;
}

export interface QueryResultRow {
  [column: string]: any;
}

export interface QueryResult<R extends QueryResultRow = any> extends QueryResultBase {
  rows: R[];
}

export type StoredProcedure<R> = (ctxt: StoredProcedureContext, ...args: unknown[]) => Promise<R>;

export interface StoredProcedureContext extends Pick<DBOSContext, 'logger' | 'workflowUUID'> {
  query<R extends QueryResultRow = any>(sql: string, ...params: unknown[]): Promise<QueryResult<R>>;
}

export class StoredProcedureContextImpl extends DBOSContextImpl implements StoredProcedureContext {
  constructor(
    readonly client: Pool,
    workflowContext: WorkflowContextImpl | WorkflowContextDebug,
    span: Span,
    logger: Logger,
    operationName: string
  ) {
    super(operationName, span, logger, workflowContext);
  }
  async query<R extends QueryResultRow = any>(sql: string, ...params: unknown[]): Promise<QueryResult<R>> {
    const { rowCount, rows } = await this.client.query<R>(sql, params);
    return { rowCount: rowCount ?? rows.length, rows };
  }
}
