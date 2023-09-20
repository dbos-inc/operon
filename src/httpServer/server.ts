import Koa from 'koa';
import Router from '@koa/router';
import { bodyParser } from '@koa/bodyparser';
import cors from "@koa/cors";
import { forEachMethod } from "../decorators";
import { APITypes, ArgSources, OperonHandlerRegistration, HandlerContext } from "./handler";
import { OperonTransaction } from "../transaction";
import { OperonWorkflow } from "../workflow";
import { OperonDataValidationError, OperonError, OperonResponseError, isOperonClientError } from "../error";
import { Operon } from "../operon";
import { serializeError } from 'serialize-error';

export class OperonHttpServer {
  readonly app: Koa;
  readonly router: Router;

  /**
   * Create a Koa app.
   * @param operon User pass in an Operon instance.
   * TODO: maybe call operon.init() somewhere in this class?
   */
  constructor(readonly operon: Operon, koa ?: Koa, router ?: Router) {
    if (!router) {
      router = new Router();
    }
    this.router = router;

    if (!koa) {
      koa = new Koa();

      koa.use(bodyParser());
      koa.use(cors());
    }
    this.app = koa;

    // Register operon endpoints.
    OperonHttpServer.registerDecoratedEndpoints(this.operon, this.router);
    this.app.use(this.router.routes()).use(this.router.allowedMethods());
  }

  /**
   * Register Operon endpoints and attach to the app. Then start the server at the given port.
   * @param port
   */
  listen(port: number) {
    // Start the HTTP server.
    this.app.listen(port, () => {
      console.log(`[Operon Server]: Server is running at http://localhost:${port}`);
    });
  }

  static registerDecoratedEndpoints(operon : Operon, irouter : unknown) {
    const router = irouter as Router;
    // Register user declared endpoints, wrap around the endpoint with request parsing and response.
    forEachMethod((registeredOperation) => {
      const ro = registeredOperation as OperonHandlerRegistration<unknown, unknown[], unknown>;
      if (ro.apiURL) {
        // Wrapper function that parses request and send response.
        const wrappedHandler = async (koaCtxt: Koa.Context, koaNext: Koa.Next) => {
          const oc: HandlerContext = new HandlerContext(operon, koaCtxt);
          oc.request = koaCtxt.req;

          // Parse the arguments.
          const args: unknown[] = [];
          ro.args.forEach((marg, idx) => {
            marg.argSource = marg.argSource ?? ArgSources.DEFAULT;  // Assign a default value.
            if (idx === 0) {
              return; // Do not parse the context.
            }

            let foundArg = undefined;
            if ((ro.apiType === APITypes.GET && marg.argSource === ArgSources.DEFAULT) || marg.argSource === ArgSources.QUERY) {
              foundArg = koaCtxt.request.query[marg.name];
              if (foundArg) {
                args.push(foundArg);
              }
            } else if ((ro.apiType === APITypes.POST && marg.argSource === ArgSources.DEFAULT) || marg.argSource === ArgSources.BODY) {
              if (!koaCtxt.request.body) {
                throw new OperonDataValidationError(`Argument ${marg.name} requires a method body.`);
              }
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
              foundArg = koaCtxt.request.body[marg.name];
              if (foundArg) {
                args.push(foundArg);
              }
            }

            // Try to parse the argument from the URL if nothing found.
            if (!foundArg) {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
              args.push(koaCtxt.params[marg.name]);
            }
          });

          // Finally, invoke the transaction/workflow/plain function.
          try {
            // For transaction/workflow or handler that hasn't set the body, set the body to the function return value.
            if (ro.txnConfig) {
              koaCtxt.body = await operon.transaction(ro.registeredFunction as OperonTransaction<unknown[], unknown>, { parentCtx: oc }, ...args);
            } else if (ro.workflowConfig) {
              koaCtxt.body = await operon.workflow(ro.registeredFunction as OperonWorkflow<unknown[], unknown>, { parentCtx: oc }, ...args).getResult();
            } else {
              // Directly invoke the handler code.
              const retValue = await ro.invoke(undefined, [oc, ...args]);

              // Set the body to the return value unless the body is already set by the handler.
              if (koaCtxt.body === undefined) {
                koaCtxt.body = retValue;
              }
            }
          } catch (e) {
            oc.log("ERROR", JSON.stringify(serializeError(e), null, '\t').replace(/\\n/g, '\n'));
            if (e instanceof Error) {
              let st = ((e as OperonResponseError)?.statusCode || 500);
              const operonErrorCode = (e as OperonError)?.operonErrorCode;
              if (operonErrorCode && isOperonClientError(operonErrorCode)) {
                st = 400;  // Set to 400: client-side error.
              }
              koaCtxt.status = st;
              koaCtxt.body = {
                status: st,
                message: e.message,
                details: e,
              }
            } else {
              koaCtxt.body = e;
              koaCtxt.status = 500;
            }
          } finally {
            await koaNext();
          }
        };

        // Actually register the endpoint.
        if (ro.apiType === APITypes.GET) {
          router.get(ro.apiURL, wrappedHandler);
        } else if (ro.apiType === APITypes.POST) {
          router.post(ro.apiURL, wrappedHandler);
        }
      }
    });
  }
}
