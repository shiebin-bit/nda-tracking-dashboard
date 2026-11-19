import { createServer } from 'node:http';
import { createHandler } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { EmailScheduler, EmailService } from './email.js';
import { seedContractTemplates } from './contract-store.js';
import { DocumentWorker } from './document-worker.js';
import {saveSqliteBackup,SqliteBackupService} from './sqlite-backup.js';
import {stopLocalConverter} from './local-converter.js';

const config = loadConfig();
const pool = createPool();
await migrate(pool);
await seedContractTemplates(pool);
const email = new EmailService(pool,config);
const scheduler = new EmailScheduler(email);
const documents = new DocumentWorker(pool,config.converterUrl);
const backups = new SqliteBackupService(pool,config.backupStatusDir??'backups/automatic');
const server = createServer(createHandler(pool,config,email));
await backups.start();
server.listen(config.port,'127.0.0.1',()=>{
  const address=server.address();const port=typeof address==='object'&&address?address.port:config.port;
  config.allowedHosts.add(`127.0.0.1:${port}`);config.allowedHosts.add(`localhost:${port}`);
  console.log(JSON.stringify({level:'info',event:'server_listening',port}));
  process.send?.({type:'ready',port});
  scheduler.start();
  void documents.start();
});

let stopping=false;
async function shutdown(signal:string):Promise<void>{
  if(stopping)return;stopping=true;
  console.log(JSON.stringify({level:'info',event:'shutdown',signal}));
  setTimeout(()=>process.exit(1),25_000).unref();
  await scheduler.stop();
  await stopLocalConverter();
  await documents.stop();
  await backups.stop();
  server.close(async()=>{await pool.end();process.exit(0);});
}
process.on('SIGTERM',()=>void shutdown('SIGTERM'));
process.on('SIGINT',()=>void shutdown('SIGINT'));
if(config.desktopMode&&process.send){
  process.on('message',message=>{
    if(!message||typeof message!=='object')return;
    const input=message as {type?:string;id?:string;path?:string};
    if(input.type==='shutdown')void shutdown('desktop');
    if(input.type==='wake')void scheduler.tick();
    if(input.type==='backup'&&typeof input.path==='string'&&typeof input.id==='string'){
      void saveSqliteBackup(pool,input.path).then(result=>process.send?.({type:'result',id:input.id,result})).catch(error=>process.send?.({type:'result',id:input.id,error:error instanceof Error?error.message:'Backup failed.'}));
    }
  });
  process.on('disconnect',()=>void shutdown('desktop-disconnected'));
}
