import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {assertBackupDestination,type Pool} from './db.js';
import type {BackupStatus} from '../src/backup-types.js';
import {backupPlan} from './backup-worker.js';
import {readBackupStatus} from './backup-status.js';
import {SQLITE_APPLICATION_ID,SQLITE_SCHEMA,SQLITE_USER_VERSION} from './sqlite-schema.js';

const TABLES=['workspace','nda_record','history_event','restore_archive','supplier','project','template_family','template_draft','contract','contract_template','contract_version','contract_activity','contract_request','document_job','document_job_item','document_artifact','contract_signed_file','email_job','email_delivery','email_request','schema_migration','reference_counter'];
let schemaSignature:string|undefined;
function signature(db:DatabaseSync):string{return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name").all().map(row=>({...row,sql:String(row.sql).replace(/\s+/g,' ').trim()})));}
function expectedSchema():string{if(!schemaSignature){const db=new DatabaseSync(':memory:');try{db.function('now',()=>new Date().toISOString());db.exec(SQLITE_SCHEMA);schemaSignature=signature(db);}finally{db.close();}}return schemaSignature;}
export async function verifySqliteBackup(path:string):Promise<void>{
  const details=await stat(path);
  if(!details.isFile()||details.size<100)throw new Error('This is not a complete NDA Tracker database backup.');
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    db.exec('PRAGMA trusted_schema=OFF');
    if(Object.values(db.prepare('PRAGMA application_id').get()!)[0]!==SQLITE_APPLICATION_ID||Object.values(db.prepare('PRAGMA user_version').get()!)[0]!==SQLITE_USER_VERSION)throw new Error('This file is not a supported NDA Tracker database version.');
    const check=db.prepare('PRAGMA integrity_check').all();
    if(check.length!==1||Object.values(check[0])[0]!=='ok')throw new Error('The database backup failed its integrity check.');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    if(TABLES.some(t=>!tables.has(t)))throw new Error('The file does not contain a complete NDA Tracker workspace.');
    if(signature(db)!==expectedSchema())throw new Error('This backup has an unsupported or modified database schema.');
    if(!db.prepare("SELECT 1 FROM schema_migration WHERE name='sqlite-v1'").get())throw new Error('This backup version is not supported.');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('The database backup has broken document references.');
    for(const [table,content,checksum] of [['document_artifact','content','checksum'],['contract_signed_file','content','checksum'],['contract_template','content','checksum'],['template_draft','source_content','source_checksum'],['contract_version','template_bytes','template_checksum'],['document_job_item','template_bytes','template_checksum']]){
      for(const row of db.prepare(`SELECT ${checksum} checksum,${content} content FROM ${table}`).iterate()){
        if(createHash('sha256').update(row.content as Uint8Array).digest('hex')!==row.checksum)throw new Error('A document in the backup failed its checksum check.');
      }
    }
  }finally{db.close();}
}
async function digest(path:string):Promise<string>{const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
export async function saveSqliteBackup(pool:Pool,path:string):Promise<{sizeBytes:number;sha256:string}>{
  await assertBackupDestination(pool.path,path);
  const target=resolve(path);await mkdir(dirname(target),{recursive:true});
  const temp=`${target}.${randomUUID()}.partial`;
  try{
    await pool.backupTo(temp);await verifySqliteBackup(temp);
    const result={sizeBytes:(await stat(temp)).size,sha256:await digest(temp)};
    await rename(temp,target);return result;
  }finally{await rm(temp,{force:true}).catch(()=>undefined);}
}
function emptyStatus():BackupStatus{return {enabled:true,schedule:{localTime:'02:00',timeZone:'Asia/Kuala_Lumpur',retainSuccessful:14},state:'never',lastAttempt:null,lastSuccess:null,nextAttemptAt:null,successfulBackupCount:0,statusUpdatedAt:null,observedAt:new Date().toISOString()};}

/** One owner: the per-user desktop backend. Online snapshots include every BLOB. */
export class SqliteBackupService{
  private timer:NodeJS.Timeout|null=null;private pending:Promise<void>|null=null;
  private status=emptyStatus();
  private recovered=false;
  constructor(private pool:Pool,private directory:string){}
  async start():Promise<void>{
    await mkdir(this.directory,{recursive:true});
    const previous=await readBackupStatus(this.directory);
    if(previous.lastSuccess||previous.lastAttempt)this.status={...previous,state:previous.state==='unavailable'?(previous.lastAttempt?.status==='failed'?'failed':previous.lastSuccess?'succeeded':'never'):previous.state};
    this.timer=setInterval(()=>void this.tick(),30_000);this.timer.unref();void this.tick();
  }
  async stop():Promise<void>{if(this.timer)clearInterval(this.timer);this.timer=null;await this.pending;}
  private async persist(){
    this.status.statusUpdatedAt=new Date().toISOString();this.status.observedAt=this.status.statusUpdatedAt;
    const temp=join(this.directory,`.status-${randomUUID()}.tmp`);
    await writeFile(temp,JSON.stringify(this.status),{flag:'wx'});await rename(temp,join(this.directory,'status.json'));
  }
  private tick():Promise<void>{if(this.pending)return this.pending;this.pending=this.run().catch(error=>console.error(JSON.stringify({level:'error',event:'sqlite_backup_failed',message:error instanceof Error?error.message:'Backup failed'}))).finally(()=>{this.pending=null;});return this.pending;}
  private async run():Promise<void>{
    if(!this.recovered){
      this.recovered=true;
      const names=(await readdir(this.directory)).filter(n=>/^nda-auto-\d{4}-\d{2}-\d{2}-\d{8}T\d{6}Z\.sqlite$/.test(n)).sort().reverse();
      for(const fileName of names){
        if(this.status.lastSuccess&&fileName<=this.status.lastSuccess.fileName)break;
        try{
          const path=join(this.directory,fileName);await verifySqliteBackup(path);const info=await stat(path);const slotDate=fileName.slice(9,19);const completedAt=info.mtime.toISOString();
          this.status.lastSuccess={slotDate,completedAt,fileName,sizeBytes:info.size,sha256:await digest(path)};this.status.lastAttempt={slotDate,status:'succeeded',startedAt:completedAt,completedAt,error:null,warning:null};this.status.state='succeeded';this.status.successfulBackupCount=names.length;break;
        }catch{/* A corrupt finalized file cannot claim a daily backup slot. */}
      }
    }
    const now=new Date();const plan=backupPlan(this.status,now);this.status.nextAttemptAt=plan.nextAttemptAt;
    if(!plan.due){await this.persist();return;}
    const startedAt=now.toISOString();this.status.state='running';this.status.lastAttempt={slotDate:plan.slotDate,status:'running',startedAt,completedAt:null,error:null,warning:null};await this.persist();
    try{
      const stamp=startedAt.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
      const fileName=`nda-auto-${plan.slotDate}-${stamp}.sqlite`;
      const result=await saveSqliteBackup(this.pool,join(this.directory,fileName));const completedAt=new Date().toISOString();
      this.status.state='succeeded';this.status.lastAttempt={slotDate:plan.slotDate,status:'succeeded',startedAt,completedAt,error:null,warning:null};
      this.status.lastSuccess={slotDate:plan.slotDate,completedAt,fileName,...result};
      const names=(await readdir(this.directory)).filter(n=>/^nda-auto-\d{4}-\d{2}-\d{2}-\d{8}T\d{6}Z\.sqlite$/.test(n)&&basename(n)===n).sort().reverse();
      let removed=0;for(const name of names.slice(14)){try{await rm(join(this.directory,name));removed++;}catch{this.status.lastAttempt.warning='The latest backup is safe, but some older backups could not be removed.';}}
      this.status.successfulBackupCount=names.length-removed;
    }catch(error){this.status.state='failed';this.status.lastAttempt={slotDate:plan.slotDate,status:'failed',startedAt,completedAt:new Date().toISOString(),error:error instanceof Error?error.message:'Backup failed.',warning:null};}
    this.status.nextAttemptAt=backupPlan(this.status,new Date()).nextAttemptAt;await this.persist();
  }
}
