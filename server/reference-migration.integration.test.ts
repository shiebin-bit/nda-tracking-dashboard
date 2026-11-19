import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from './db';
import { sqliteTestPool } from './sqlite-test-helper';

describe('SQLite display reference allocation',()=>{
  let pool:Pool;let cleanup:()=>Promise<void>;
  beforeAll(async()=>{({pool,cleanup}=await sqliteTestPool('nda-references'));});
  afterAll(async()=>{await cleanup?.();});

  it('allocates immutable unique references across active and recycled rows',async()=>{
    for(const [id,position,deleted] of [['agreement-first',10,null],['agreement-recycled',20,'2026-04-01']] as const){
      await pool.query(`INSERT INTO nda_record(id,position,version,source,created_at,updated_at,fields,fingerprint,deleted_at,deleted_by)
        VALUES($1,$2,1,'manual',now(),now(),'{}',$1,$3,$4)`,[id,position,deleted,deleted?'Local user':null]);
    }
    for(const [id,deleted] of [['document-first',null],['document-recycled','2026-04-01']] as const){
      await pool.query(`INSERT INTO contract(id,version,status,"values",created_at,updated_at,deleted_at,deleted_by)
        VALUES($1,1,'draft','{}',now(),now(),$2,$3)`,[id,deleted,deleted?'Local user':null]);
    }
    expect((await pool.query('SELECT id,reference_code FROM nda_record ORDER BY position')).rows).toEqual([
      {id:'agreement-first',reference_code:'AGR-000001'},{id:'agreement-recycled',reference_code:'AGR-000002'},
    ]);
    expect((await pool.query('SELECT id,reference_code FROM contract ORDER BY rowid')).rows).toEqual([
      {id:'document-first',reference_code:'DOC-000001'},{id:'document-recycled',reference_code:'DOC-000002'},
    ]);
    await pool.query("UPDATE reference_counter SET next_value=1000000 WHERE kind IN ('agreement','document')");
    await pool.query(`INSERT INTO nda_record(id,position,version,source,created_at,updated_at,fields,fingerprint)
      VALUES('agreement-million',30,1,'manual',now(),now(),'{}','million')`);
    await pool.query(`INSERT INTO contract(id,version,status,"values",created_at,updated_at)
      VALUES('document-million',1,'draft','{}',now(),now())`);
    expect((await pool.query("SELECT reference_code FROM nda_record WHERE id='agreement-million'")).rows[0].reference_code).toBe('AGR-1000000');
    expect((await pool.query("SELECT reference_code FROM contract WHERE id='document-million'")).rows[0].reference_code).toBe('DOC-1000000');
    await expect(pool.query("UPDATE contract SET reference_code='DOC-999999' WHERE id='document-first'"))
      .rejects.toMatchObject({code:'ERR_SQLITE_ERROR'});
  });
});
