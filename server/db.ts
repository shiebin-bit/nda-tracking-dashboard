import {createHash,randomUUID} from 'node:crypto';
import {backup,DatabaseSync,StatementSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import {mkdir,rename,rm,stat} from 'node:fs/promises';
import {basename,dirname,extname,join,resolve} from 'node:path';
import {
  SQLITE_APPLICATION_ID,
  SQLITE_LEGACY_USER_VERSION,
  SQLITE_MIGRATION_SQL_V2,
  SQLITE_MIGRATION_V1,
  SQLITE_MIGRATION_V2,
  SQLITE_SCHEMA_V1,
  SQLITE_USER_VERSION,
} from './sqlite-schema.js';
import {parseDocumentNamingSettings} from '../src/document-settings.js';

export interface QueryResult<T=any>{rows:T[];rowCount:number}
export interface PoolClient{query<T=any>(sql:string,params?:unknown[]):Promise<QueryResult<T>>;release():void}

/** A backup may replace a saved backup, never an open database or its sidecars. */
export async function assertBackupDestination(source:string,target:string):Promise<void>{
  const canonical=(value:string)=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
  if(['','-wal','-shm'].some(suffix=>canonical(target)===canonical(`${source}${suffix}`)))throw new Error('Choose a backup location outside the active database and its working files.');
  const existing=await stat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing){const current=await stat(source);if(current.ino!==0&&existing.dev===current.dev&&existing.ino===current.ino)throw new Error('The backup location points to the active database.');}
}

function parameters(values:unknown[]):Record<string,string|number|bigint|Uint8Array|null>{
  const result:Record<string,string|number|bigint|Uint8Array|null>={};
  values.forEach((value,index)=>{
    let normalized=value as string|number|bigint|Uint8Array|null;
    if(value===undefined)normalized=null;
    else if(typeof value==='boolean')normalized=value?1:0;
    else if(value instanceof Date)normalized=value.toISOString();
    else if(Array.isArray(value)||typeof value==='object'&&value!==null&&!Buffer.isBuffer(value)&&!(value instanceof Uint8Array))normalized=JSON.stringify(value);
    result[`$${index+1}`]=normalized;
  });
  return result;
}

const JSON_COLUMNS=new Set(['settings','filename_fields','fields','changes','preimage','tags','values','details','values_snapshot','response_body','cc_emails','field_schema','editor_snapshot','custom_values','custom_values_snapshot']);
function mapRow<T>(row:Record<string,unknown>):T{
  for(const [key,value] of Object.entries(row)){
    if(value instanceof Uint8Array&&!Buffer.isBuffer(value))row[key]=Buffer.from(value);
    if(JSON_COLUMNS.has(key)&&typeof value==='string'){
      try{row[key]=JSON.parse(value);}catch{throw new Error(`Database JSON column ${key} is invalid.`);}
    }
  }
  return row as T;
}

function statementRows<T>(statement:StatementSync,params:unknown[]):QueryResult<T>{
  const bound=parameters(params);
  if(statement.columns().length){const rows=(statement.all(bound) as Record<string,unknown>[]).map(mapRow<T>);return {rows,rowCount:rows.length};}
  return {rows:[],rowCount:Number(statement.run(bound).changes)};
}

class SerialGate{
  private tail:Promise<void>=Promise.resolve();
  async enter():Promise<()=>void>{let release!:()=>void;const next=new Promise<void>(resolve=>{release=resolve;});const prior=this.tail;this.tail=prior.then(()=>next);await prior;return release;}
}

class Client implements PoolClient{
  private closed=false;
  constructor(private readonly owner:Pool,private readonly releaseGate:()=>void){}
  async query<T=any>(sql:string,params:unknown[]=[]):Promise<QueryResult<T>>{if(this.closed)throw new Error('Database client was released.');return this.owner.execute<T>(sql,params);}
  release():void{if(!this.closed){this.closed=true;this.releaseGate();}}
}

function schemaSignature(database:DatabaseSync):string{
  return JSON.stringify(database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name").all()
    .map(row=>({...row,sql:String(row.sql).replace(/\s+/g,' ').trim()})));
}

let legacySchemaSignature:string|undefined;
let currentSchemaSignature:string|undefined;
function expectedLegacySchemaSignature():string{
  if(!legacySchemaSignature){
    const database=new DatabaseSync(':memory:');
    try{registerFunctions(database);database.exec(SQLITE_SCHEMA_V1);legacySchemaSignature=schemaSignature(database);}
    finally{database.close();}
  }
  return legacySchemaSignature;
}

function expectedCurrentSchemaSignature():string{
  if(!currentSchemaSignature){
    const database=new DatabaseSync(':memory:');
    try{registerFunctions(database);database.exec(`${SQLITE_SCHEMA_V1}${SQLITE_MIGRATION_SQL_V2}`);currentSchemaSignature=schemaSignature(database);}
    finally{database.close();}
  }
  return currentSchemaSignature;
}

function registerFunctions(database:DatabaseSync):void{
  database.function('now',{deterministic:false},()=>new Date().toISOString());
  database.function('octet_length',{deterministic:true},(value:unknown)=>value instanceof Uint8Array?value.byteLength:Buffer.byteLength(String(value??'')));
  database.function('jsonb_array_length',{deterministic:true},(value:unknown)=>{const parsed=typeof value==='string'?JSON.parse(value):value;return Array.isArray(parsed)?parsed.length:0;});
}

function validateLegacyV1(database:DatabaseSync):void{
  const integrity=database.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw new Error('The NDA Tracker workspace failed its integrity check. Restore a verified backup before upgrading.');
  if(database.prepare('PRAGMA foreign_key_check').all().length)throw new Error('The NDA Tracker workspace has broken document references. Restore a verified backup before upgrading.');
  if(schemaSignature(database)!==expectedLegacySchemaSignature())throw new Error('This NDA Tracker workspace has an unsupported or modified database schema.');
  const markers=database.prepare('SELECT name FROM schema_migration ORDER BY name').all().map(row=>row.name);
  if(markers.length!==1||markers[0]!==SQLITE_MIGRATION_V1)throw new Error('This NDA Tracker workspace has unsupported migration markers.');
}

function validateCurrentV2(database:DatabaseSync):void{
  const integrity=database.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw new Error('The NDA Tracker workspace failed its integrity check. Restore a verified backup before continuing.');
  if(database.prepare('PRAGMA foreign_key_check').all().length)throw new Error('The NDA Tracker workspace has broken document references. Restore a verified backup before continuing.');
  if(schemaSignature(database)!==expectedCurrentSchemaSignature())throw new Error('This NDA Tracker workspace has an unsupported or modified database schema.');
  const markers=database.prepare('SELECT name FROM schema_migration ORDER BY name').all().map(row=>row.name);
  if(markers.length!==2||markers[0]!==SQLITE_MIGRATION_V1||markers[1]!==SQLITE_MIGRATION_V2)throw new Error('This NDA Tracker workspace has unsupported migration markers.');
  const settings=database.prepare('SELECT id,revision,filename_fields FROM document_settings').all();
  if(settings.length!==1||settings[0].id!==1||!Number.isSafeInteger(Number(settings[0].revision))||Number(settings[0].revision)<0)throw new Error('This NDA Tracker workspace has invalid document settings.');
  try{parseDocumentNamingSettings({filenameFields:JSON.parse(String(settings[0].filename_fields))});}
  catch{throw new Error('This NDA Tracker workspace has invalid document settings.');}
}

function migrationBackupPath(databasePath:string):string{
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const extension=extname(databasePath);
  const stem=basename(databasePath,extension).replace(/[^A-Za-z0-9._-]/g,'_')||'workspace';
  const directory=join(dirname(databasePath),'backups','migrations');
  mkdirSync(directory,{recursive:true});
  return join(directory,`${stem}-pre-v2-${stamp}-${randomUUID().slice(0,8)}.sqlite`);
}

function saveMigrationSafetyBackup(database:DatabaseSync,databasePath:string):void{
  const target=migrationBackupPath(databasePath);
  try{
    database.prepare('VACUUM INTO ?').run(target);
    const snapshot=new DatabaseSync(target,{readOnly:true});
    try{
      const applicationId=Object.values(snapshot.prepare('PRAGMA application_id').get()!)[0];
      const version=Object.values(snapshot.prepare('PRAGMA user_version').get()!)[0];
      if(applicationId!==SQLITE_APPLICATION_ID||version!==SQLITE_LEGACY_USER_VERSION)throw new Error('Migration safety backup metadata is invalid.');
      validateLegacyV1(snapshot);
      for(const [table,content,checksum] of [['document_artifact','content','checksum'],['contract_signed_file','content','checksum'],['contract_template','content','checksum'],['template_draft','source_content','source_checksum'],['contract_version','template_bytes','template_checksum'],['document_job_item','template_bytes','template_checksum']]){
        for(const row of snapshot.prepare(`SELECT ${checksum} checksum,${content} content FROM ${table}`).iterate()){
          if(createHash('sha256').update(row.content as Uint8Array).digest('hex')!==row.checksum)throw new Error('A document in the migration safety backup failed its checksum check.');
        }
      }
    }finally{snapshot.close();}
  }catch(error){
    try{rmSync(target,{force:true});}catch{/* retain no unverified backup */}
    throw error;
  }
}

export interface PoolOptions{
  /** Only for a disposable restore staging copy; never use for the active workspace. */
  skipMigrationSafetyBackup?:boolean;
}

export class Pool{
  readonly dialect='sqlite' as const;
  readonly path:string;
  private readonly database:DatabaseSync;
  private readonly gate=new SerialGate();
  private closed=false;
  constructor(path:string,options:PoolOptions={}){
    this.path=resolve(path);mkdirSync(dirname(this.path),{recursive:true});this.database=new DatabaseSync(this.path);
    // Check identity before changing journal mode, metadata or schema. A newer
    // workspace must never be silently downgraded by an older installer.
    const applicationId=Object.values(this.database.prepare('PRAGMA application_id').get()!)[0];
    const version=Object.values(this.database.prepare('PRAGMA user_version').get()!)[0];
    const tables=this.database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    const empty=!tables.length&&applicationId===0&&version===0;
    const legacy=tables.length>0&&applicationId===SQLITE_APPLICATION_ID&&version===SQLITE_LEGACY_USER_VERSION;
    const current=tables.length>0&&applicationId===SQLITE_APPLICATION_ID&&version===SQLITE_USER_VERSION;
    if(!empty&&!legacy&&!current){this.database.close();throw new Error('This is not a supported NDA Tracker workspace version. Use a compatible installer or restore a supported backup.');}
    registerFunctions(this.database);
    try{
      if(legacy){validateLegacyV1(this.database);if(!options.skipMigrationSafetyBackup)saveMigrationSafetyBackup(this.database,this.path);}
      if(current)validateCurrentV2(this.database);
      this.database.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=10000;PRAGMA secure_delete=ON;PRAGMA temp_store=MEMORY;');
      if(empty){
        this.database.exec(`BEGIN IMMEDIATE;${SQLITE_SCHEMA_V1} PRAGMA application_id=${SQLITE_APPLICATION_ID};PRAGMA user_version=${SQLITE_LEGACY_USER_VERSION};COMMIT;`);
      }
      if(empty||legacy){
        this.database.exec(`BEGIN IMMEDIATE;${SQLITE_MIGRATION_SQL_V2} PRAGMA user_version=${SQLITE_USER_VERSION};COMMIT;`);
      }
      if(empty||legacy)validateCurrentV2(this.database);
    }
    catch(error){try{this.database.exec('ROLLBACK');}catch{/* no transaction was active */}finally{this.database.close();}throw error;}
  }
  execute<T>(sql:string,params:unknown[]):QueryResult<T>{if(this.closed)throw new Error('Database is closed.');return statementRows<T>(this.database.prepare(sql),params);}
  async query<T=any>(sql:string,params:unknown[]=[]):Promise<QueryResult<T>>{const release=await this.gate.enter();try{return this.execute<T>(sql,params);}finally{release();}}
  async connect():Promise<PoolClient>{return new Client(this,await this.gate.enter());}
  async backupTo(target:string):Promise<void>{
    await assertBackupDestination(this.path,target);
    const destination=resolve(target);await mkdir(dirname(destination),{recursive:true});const temporary=`${destination}.partial`;await rm(temporary,{force:true});
    // The online backup API reads a consistent snapshot (including WAL) without
    // holding the application's serial writer gate for the duration of a large copy.
    const source=new DatabaseSync(this.path,{readOnly:true});
    try{await backup(source,temporary);
      // A backup artifact must be one portable file, not a WAL database whose
      // latest pages depend on adjacent -wal/-shm sidecars.
      const verified=new DatabaseSync(temporary);try{verified.exec('PRAGMA journal_mode=DELETE;');const row=verified.prepare('PRAGMA integrity_check').get() as Record<string,unknown>;if(!Object.values(row).includes('ok'))throw new Error('SQLite backup integrity check failed.');}finally{verified.close();}
      await rm(destination,{force:true});await rename(temporary,destination);if(!(await stat(destination)).isFile())throw new Error('SQLite backup was not finalized.');
    }finally{source.close();for(const suffix of ['','-wal','-shm'])await rm(`${temporary}${suffix}`,{force:true}).catch(()=>undefined);}
  }
  async end():Promise<void>{const release=await this.gate.enter();try{this.database.close();this.closed=true;}finally{release();}}
}

export function createPool(path=process.env.NDA_SQLITE_PATH):Pool{
  if(!path){if(process.env.DATABASE_URL)throw new Error('NDA_SQLITE_PATH is required for the desktop runtime; PostgreSQL DATABASE_URL is not accepted.');throw new Error('NDA_SQLITE_PATH is required.');}
  return new Pool(path);
}
export async function migrate(_database:Pool):Promise<void>{/* Pool initializes or upgrades through the current schema atomically. */}
export async function withTransaction<T>(pool:Pool,work:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await pool.connect();try{await client.query('BEGIN IMMEDIATE');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}
