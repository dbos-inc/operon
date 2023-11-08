#!/usr/bin/env node

import { deploy } from "./deploy";
import { Command } from 'commander';
import { login } from "./login";
import { registerUser } from "./register";
import { deleteApp } from "./delete";
import { getAppLogs } from "./monitor";
import { createUserDb, getUserDb, deleteUserDb } from "./userdb";

const program = new Command();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../../package.json') as { version: string };
program.
  version(packageJson.version);

///////////////////////
/* CLOUD DEPLOYMENT  */
///////////////////////

program
  .command('login')
  .description('Log in Operon cloud')
  .requiredOption('-u, --userName <string>', 'User name for login', )
  .action((options: { userName: string }) => {
    login(options.userName);
  });

program
  .command('deploy')
  .description('Deploy an application to the cloud')
  .requiredOption('-n, --name <string>', 'Specify the app name')
  .option('-h, --host <string>', 'Specify the host', 'localhost')
  .option('-p, --port <port>', 'Specify the port', '8080')
  .action(async (options: { name: string, host: string, port: string }) => {
    await deploy(options.name, options.host, options.port);
  });

program
  .command('register')
  .description('Register a user and log in Operon cloud')
  .requiredOption('-u, --userName <string>', 'User name', )
  .option('-h, --host <string>', 'Specify the host', 'localhost')
  .option('-p, --port <port>', 'Specify the port', '8080')
  .action(async (options: { userName: string, host: string, port: string }) => {
    const success = await registerUser(options.userName, options.host, options.port);
    // Then, log in as the user.
    if (success) {
      login(options.userName);
    }
  });

program
  .command('delete')
  .description('Delete a previously deployed application')
  .requiredOption('-n, --name <string>', 'Specify the app name')
  .option('-h, --host <string>', 'Specify the host', 'localhost')
  .option('-p, --port <port>', 'Specify the port', '8080')
  .action(async (options: { name: string, host: string, port: string }) => {
    await deleteApp(options.name, options.host, options.port);
  });

program
  .command('logs')
  .description('Print the microVM logs of a deployed application')
  .requiredOption('-n, --name <string>', 'Specify the app name')
  .option('-h, --host <string>', 'Specify the host', 'localhost')
  .option('-p, --port <port>', 'Specify the port', '8080')
  .action(async (options: { name: string, host: string, port: string }) => {
    await getAppLogs(options.name, options.host, options.port);
  });

const userdb = program
  .command('userdb')
  .description('Create, delete or check status of a user database')
  //.requiredOption('-o, --operation <string>', 'Specify the operation name')
  // .option('-h, --host <string>', 'Specify the host', 'localhost')
  // .option('-p, --port <port>', 'Specify the port', '8080')
  .action(async (options: {  host: string, port: string }) => {
    console.log("npx userdb command " + options.host + ":" + options.port )
  });  

userdb
  .command('create')
  .argument('<dbname>', 'database name')
  .option('-h, --host <string>', 'Specify the host', 'localhost')
  .option('-p, --port <port>', 'Specify the port', '8080')
  .action((async (dbname, options: { host: string, port: string }) => {
    console.log("npx userdb create command with " + dbname + " at " + options.host + ":"+ options.port)
    await createUserDb(options.host, options.port, dbname, "postgres", "postgres")
  }))


userdb
  .command('status')
  .argument('<dbname>', 'database name')
  .option('-h, --host <string>', 'Specify the host', 'localhost')
  .option('-p, --port <port>', 'Specify the port', '8080')
  .action((async (dbname, options: { host: string, port: string }) => {
    console.log("npx userdb status command with " + dbname + " at " + options.host + ":"+ options.port)
    await getUserDb(options.host, options.port, dbname)
  })) 

userdb
  .command('delete')
  .argument('<dbname>', 'database name')
  .option('-h, --host <string>', 'Specify the host', 'localhost')
  .option('-p, --port <port>', 'Specify the port', '8080')
  .action((async (dbname, options: { host: string, port: string }) => {
    console.log("npx userdb delete command with " + dbname + " at " + options.host + ":"+ options.port)
    await deleteUserDb(options.host, options.port, dbname)
  })) 

program.parse(process.argv);

// If no arguments provided, display help by default
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
