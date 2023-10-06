import { TransactionContext, OperonTransaction, GetApi, HandlerContext } from '@dbos-inc/operon'
import { Knex } from 'knex';

type KnexTransactionContext = TransactionContext<Knex>;

interface operon_hello {
  greeting_id: number;
  greeting: string;
}
export class Hello {

  @GetApi('/greeting/:name')
  static async helloHandler(handlerCtxt: HandlerContext, name: string) {
    return handlerCtxt.invoke(Hello).helloTransaction(name);
  }

  @OperonTransaction()
  static async helloTransaction(txnCtxt: KnexTransactionContext, name: string) {
    const logger = txnCtxt.getLogger();
    const greeting = `Hello, ${name}!`
    logger.info('log message with context data', true);
    logger.warn('warning without context data');
    logger.error(new Error('oops'));
    logger.error(new Error('oops with context data'), true);
    const rows = await txnCtxt.client<operon_hello>("operon_hello")
      .insert({ greeting: greeting })
      .returning("greeting_id");
    return `Greeting ${rows[0].greeting_id}: Hello, ${name}!\n`;
  }
}
