import { createServer } from 'node:http';
import { createHandler } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { EmailScheduler, EmailService } from './email.js';
import { seedContractTemplates } from './contract-store.js';
import { DocumentWorker } from './document-worker.js';

const config = loadConfig();
const pool = createPool();
await migrate(pool);
await seedContractTemplates(pool);
const email = new EmailService(pool,config);
const scheduler = new EmailScheduler(email);
const documents = new DocumentWorker(pool,config.converterUrl);
const server = createServer(createHandler(pool,config,email));
server.listen(config.port,'0.0.0.0',()=>{
  console.log(JSON.stringify({level:'info',event:'server_listening',port:config.port}));
  scheduler.start();
  void documents.start();
});

async function shutdown(signal:string):Promise<void>{
  console.log(JSON.stringify({level:'info',event:'shutdown',signal}));
  setTimeout(()=>process.exit(1),25_000).unref();
  await scheduler.stop();
  await documents.stop();
  server.close(async()=>{await pool.end();process.exit(0);});
}
process.on('SIGTERM',()=>void shutdown('SIGTERM'));
process.on('SIGINT',()=>void shutdown('SIGINT'));
