import { TelemetryCollector } from "./collector";
import { LogSeverity, TelemetrySignal } from "./signals";
import { OperonContext } from "src/context";

interface ILogger {
  log(context: OperonContext, severity: string, message: string): void;
  collector: TelemetryCollector;
}

export class Logger implements ILogger {
  constructor(readonly collector: TelemetryCollector) {}

  log(context: OperonContext, severity: LogSeverity, message: string): void {
    const signal: TelemetrySignal = {
      workflowUUID: context.workflowUUID,
      operationName: context.operationName,
      runAs: context.authenticatedUser,
      timestamp: Date.now(),
      severity: severity,
      logMessage: message,
      stack: "",
    };

    // Retrieve 3 frames above: this frame, the transaction/workflow/communicator/handler frame + 1 line for the class name ("Error")
    // Also remove "at" from the beginning
    const stack = new Error().stack?.split("\n")[3].trim().substring(3);
    if (stack) {
      signal.stack = stack;
    }

    this.collector.push(signal);
  }
}
