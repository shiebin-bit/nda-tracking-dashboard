import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool,withTransaction} from './db.js';

const directories:string[]=[];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
async function file(){const directory=await mkdtemp(join(tmpdir(),'nda-sqlite-db-'));directories.push(directory);return join(directory,'workspace.sqlite');}
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
});
