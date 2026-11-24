import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {Pool,withTransaction} from './db.js';
import {verifySqliteBackup} from './sqlite-backup.js';
import {SQLITE_APPLICATION_ID,SQLITE_SCHEMA_V1} from './sqlite-schema.js';

const directories:string[]=[];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
async function file(){const directory=await mkdtemp(join(tmpdir(),'nda-sqlite-db-'));directories.push(directory);return join(directory,'workspace.sqlite');}
async function legacyFile(){
  const path=await file();const db=new DatabaseSync(path);
  try{db.function('now',()=>new Date().toISOString());db.exec(`${SQLITE_SCHEMA_V1}PRAGMA application_id=${SQLITE_APPLICATION_ID};PRAGMA user_version=1;`);}
  finally{db.close();}
  return path;
}
describe('SQLite workspace lifecycle',()=>{
  it('reopens without resetting settings, recycled rows or counters',async()=>{
    const path=await file();let pool=new Pool(path);
    await pool.query("UPDATE workspace SET revision=9,settings=json_set(settings,'$.recipientEmail','owner@example.com')");
    await pool.query("UPDATE reference_counter SET next_value=25 WHERE kind='agreement'");
    await pool.end();pool=new Pool(path);
    try{expect((await pool.query('SELECT revision,settings FROM workspace')).rows[0]).toMatchObject({revision:9,settings:{recipientEmail:'owner@example.com'}});expect((await pool.query("SELECT next_value FROM reference_counter WHERE kind='agreement'")).rows[0].next_value).toBe(25);}
    finally{await pool.end();}
  });
  it('rejects an unrelated or future database without changing its metadata or contents',async()=>{
    for(const future of [false,true]){
      const path=await file();if(future){const pool=new Pool(path);await pool.end();}
      let db=new DatabaseSync(path);db.exec(future?'PRAGMA user_version=99;':"CREATE TABLE unrelated(value TEXT);INSERT INTO unrelated VALUES('keep');");db.close();
      expect(()=>new Pool(path)).toThrow(/supported NDA Tracker workspace version/);
      db=new DatabaseSync(path,{readOnly:true});try{expect(Object.values(db.prepare('PRAGMA user_version').get()!)[0]).toBe(future?99:0);if(!future)expect(db.prepare('SELECT value FROM unrelated').get()!.value).toBe('keep');}finally{db.close();}
    }
  });
  it('rolls back a failed transaction before the next queued writer proceeds',async()=>{
    const pool=new Pool(await file());
    try{
      const failed=withTransaction(pool,async client=>{await client.query('UPDATE workspace SET revision=100');throw new Error('cancel transaction');});
      const next=withTransaction(pool,async client=>{await client.query('UPDATE workspace SET revision=revision+1');});
      await expect(failed).rejects.toThrow('cancel transaction');await next;
      expect((await pool.query('SELECT revision FROM workspace')).rows[0].revision).toBe(1);
    }finally{await pool.end();}
  });
  it('validates and migrates exact v1 workspaces after retaining a verified legacy safety backup',async()=>{
    const path=await legacyFile();const pool=new Pool(path);await pool.end();
    const db=new DatabaseSync(path,{readOnly:true});
    try{
      expect(Object.values(db.prepare('PRAGMA user_version').get()!)[0]).toBe(2);
      expect(db.prepare('SELECT filename_fields FROM document_settings WHERE id=1').get()!.filename_fields)
        .toBe('["type","supplier","project","date"]');
      expect(db.prepare("SELECT 1 FROM schema_migration WHERE name='sqlite-v2'").get()).toBeTruthy();
    }finally{db.close();}
    const backups=await readdir(join(dirname(path),'backups','migrations'));
    expect(backups).toHaveLength(1);
    const safety=join(dirname(path),'backups','migrations',backups[0]);
    await expect(verifySqliteBackup(safety)).rejects.toThrow(/supported NDA Tracker database version/);
    await expect(verifySqliteBackup(safety,{allowLegacyV1:true})).resolves.toBeUndefined();
  });
  it('rejects a tampered v1 schema before saving a backup or changing metadata',async()=>{
    const path=await legacyFile();let db=new DatabaseSync(path);db.exec('CREATE TABLE injected(value TEXT)');db.close();
    expect(()=>new Pool(path)).toThrow(/modified database schema/);
    db=new DatabaseSync(path,{readOnly:true});
    try{expect(Object.values(db.prepare('PRAGMA user_version').get()!)[0]).toBe(1);expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='document_settings'").get()).toBeUndefined();}
    finally{db.close();}
    await expect(readdir(join(dirname(path),'backups','migrations'))).rejects.toThrow();
  });
  it('does not mutate v1 when its required safety backup cannot be created',async()=>{
    const path=await legacyFile();const backupBlocker=join(dirname(path),'backups');await writeFile(backupBlocker,'not a directory');
    expect(()=>new Pool(path)).toThrow();
    const db=new DatabaseSync(path,{readOnly:true});
    try{expect(Object.values(db.prepare('PRAGMA user_version').get()!)[0]).toBe(1);expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='document_settings'").get()).toBeUndefined();}
    finally{db.close();}
  });
  it('rejects invalid current document settings on reopen',async()=>{
    const path=await file();const pool=new Pool(path);await pool.end();
    let db=new DatabaseSync(path);db.prepare("UPDATE document_settings SET filename_fields='[\"type\",\"type\"]' WHERE id=1").run();db.close();
    expect(()=>new Pool(path)).toThrow(/invalid document settings/);
    db=new DatabaseSync(path,{readOnly:true});try{expect(Object.values(db.prepare('PRAGMA user_version').get()!)[0]).toBe(2);}
    finally{db.close();}
  });
  it('can migrate a verified disposable restore stage without creating a nested safety backup',async()=>{
    const path=await legacyFile();const pool=new Pool(path,{skipMigrationSafetyBackup:true});await pool.end();
    await expect(verifySqliteBackup(path)).resolves.toBeUndefined();
    await expect(readdir(join(dirname(path),'backups','migrations'))).rejects.toThrow();
  });
});
