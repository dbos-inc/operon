import { execSync, SpawnSyncReturns } from "child_process";
import { GlobalLogger } from "../telemetry/logs";
import { ConfigFile, constructPoolConfig } from "./config";
import { PoolConfig, Client } from "pg";
import { createUserDBSchema, userDBIndex, userDBSchema } from "../../schemas/user_db_schema";
import { ExistenceCheck, migrateSystemDatabase } from "../system_database";
import { schemaExistsQuery, txnOutputIndexExistsQuery, txnOutputTableExistsQuery } from "../user_database";
import { db_wizard } from "./db_wizard";

export async function migrate(configFile: ConfigFile, logger: GlobalLogger) {
  const userDBName = configFile.database.app_db_name;
  logger.info(`Starting migration: creating database ${userDBName} if it does not exist`);

  if (!(await checkDatabaseExists(configFile, logger))) {
    let postgresConfig: PoolConfig = constructPoolConfig(configFile)
    postgresConfig = await db_wizard(postgresConfig);
    const app_database = postgresConfig.database
    postgresConfig.database = "postgres"
    const postgresClient = new Client(postgresConfig);
    let connection_failed = true;
    try {
      await postgresClient.connect()
      connection_failed = false;
      await postgresClient.query(`CREATE DATABASE ${app_database}`);
    } catch (e) {
      if (e instanceof Error) {
        if (connection_failed) {
          logger.error(`Error connecting to database ${postgresConfig.host}:${postgresConfig.port} with user ${postgresConfig.user}: ${e.message}`);
        } else {
          logger.error(`Error creating database ${app_database}: ${e.message}`);
        }
      } else {
        logger.error(e);
      }
      return 1;
    } finally {
      await postgresClient.end()
    }
  }

  const migrationCommands = configFile.database.migrate;

  try {
    migrationCommands?.forEach((cmd) => {
      logger.info(`Executing migration command: ${cmd}`);
      const migrateCommandOutput = execSync(cmd, { encoding: 'utf-8' });
      logger.info(migrateCommandOutput.trimEnd());
    });
  } catch (e) {
    logMigrationError(e, logger, "Error running migration")
    return 1;
  }

  logger.info("Creating DBOS tables and system database.");
  try {
    await createDBOSTables(configFile);
  } catch (e) {
    if (e instanceof Error) {
      logger.error(`Error creating DBOS system database: ${e.message}`);
    } else {
      logger.error(e);
    }
    return 1;
  }

  logger.info("Migration successful!")
  return 0;
}

export async function checkDatabaseExists(configFile: ConfigFile, logger: GlobalLogger) {
  let pgUserConfig: PoolConfig = constructPoolConfig(configFile)
  pgUserConfig = await db_wizard(pgUserConfig);
  const pgUserClient = new Client(pgUserConfig);

  try {
    await pgUserClient.connect(); // Try to establish a connection
    await pgUserClient.end();
    logger.info(`Database ${pgUserConfig.database} exists!`)
    return true; // If successful, return true
  } catch (error) {
    logger.info(`Database ${pgUserConfig.database} does not exist, creating...`)
    return false; // If connection fails, return false
  }
}

export function rollbackMigration(configFile: ConfigFile, logger: GlobalLogger) {
  logger.info("Starting Migration Rollback");

  let dbType = configFile.database.app_db_client;
  if (dbType === undefined) {
    dbType = "knex";
  }

  const rollbackcommands = configFile.database.rollback;

  try {
    rollbackcommands?.forEach((cmd) => {
      logger.info("Executing " + cmd);
      const migrateCommandOutput = execSync(cmd, { encoding: 'utf-8' });
      logger.info(migrateCommandOutput.trimEnd());
    });
  } catch (e) {
    logMigrationError(e, logger, "Error rolling back migration.");
    return 1;
  }
  return 0;
}

// Create DBOS system DB and tables.
// TODO: replace this with knex to manage schema.
async function createDBOSTables(configFile: ConfigFile) {
  const logger = new GlobalLogger();

  const userPoolConfig: PoolConfig = constructPoolConfig(configFile)

  const systemPoolConfig = { ...userPoolConfig };
  systemPoolConfig.database = configFile.database.sys_db_name ?? `${userPoolConfig.database}_dbos_sys`;

  const pgUserClient = new Client(userPoolConfig);
  await pgUserClient.connect();

  // Create DBOS table/schema in user DB.
  // Always check if the schema/table exists before creating it to avoid locks.
  const schemaExists = await pgUserClient.query<ExistenceCheck>(schemaExistsQuery);
  if (!schemaExists.rows[0].exists) {
    await pgUserClient.query(createUserDBSchema);
  }
  const txnOutputTableExists = await pgUserClient.query<ExistenceCheck>(txnOutputTableExistsQuery);
  if (!txnOutputTableExists.rows[0].exists) {
    await pgUserClient.query(userDBSchema);
  }
  const txnIndexExists = await pgUserClient.query<ExistenceCheck>(txnOutputIndexExistsQuery);
  if (!txnIndexExists.rows[0].exists) {
    await pgUserClient.query(userDBIndex);
  }

  // Create the DBOS system database.
  const dbExists = await pgUserClient.query<ExistenceCheck>(`SELECT EXISTS (SELECT FROM pg_database WHERE datname = '${systemPoolConfig.database}')`);
  if (!dbExists.rows[0].exists) {
    await pgUserClient.query(`CREATE DATABASE ${systemPoolConfig.database}`);
  }

  // Load the DBOS system schema.
  const pgSystemClient = new Client(systemPoolConfig);
  await pgSystemClient.connect();

  try {
    await migrateSystemDatabase(systemPoolConfig);
  } catch (e) {
    const tableExists = await pgSystemClient.query<ExistenceCheck>(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'dbos' AND table_name = 'operation_outputs')`);
    if (tableExists.rows[0].exists) {
      // If the table has been created by someone else. Ignore the error.
      logger.warn(`System tables creation failed, may conflict with concurrent tasks: ${(e as Error).message}`);
    } else {
      throw e;
    }
  } finally {
    await pgSystemClient.end();
    await pgUserClient.end();
  }
}

type ExecSyncError<T> = Error & SpawnSyncReturns<T>;
//Test to determine if e can be treated as an ExecSyncError.
function isExecSyncError(e: Error): e is ExecSyncError<string | Buffer> {
  if (
    //Safeguard against NaN. NaN type is number but NaN !== NaN
    "pid" in e && (typeof e.pid === 'number' && e.pid === e.pid) &&
    "stdout" in e && (Buffer.isBuffer(e.stdout) || typeof e.stdout === 'string') &&
    "stderr" in e && (Buffer.isBuffer(e.stderr) || typeof e.stderr === 'string')
  ) {
    return true;
  }
  return false
}

function logMigrationError(e: unknown, logger: GlobalLogger, title: string) {
  logger.error(title);
  if (e instanceof Error && isExecSyncError(e)) {
    const stderr = e.stderr;
    if (e.stderr.length > 0) {
      logger.error(`Standard Error: ${stderr.toString().trim()}`);
    }
    const stdout = e.stdout;
    if (stdout.length > 0) {
      logger.error(`Standard Output: ${stdout.toString().trim()}`);
    }
    if (e.message) {
      logger.error(e.message);
    }
    if (e.error?.message) {
      logger.error(e.error?.message);
    }
  } else {
    logger.error(e);
  }
}
