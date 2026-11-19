import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './db';

const url=process.env.TEST_DATABASE_URL;
const suite=url?describe:describe.skip;

suite('display reference migration',()=>{
  const schema=`test_reference_migration_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let admin:Pool;let pool:Pool;

  beforeAll(async()=>{
    admin=new Pool({connectionString:url});
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
  });

  afterAll(async()=>{
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('deterministically backfills active and recycled rows, then allocates immutable unique references',async()=>{
    await pool.query(`CREATE TABLE schema_migration (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory=resolve(process.cwd(),'migrations');
    const files=(await readdir(directory)).filter(name=>/^00[1-9]_[a-z0-9_-]+\.sql$/i.test(name)).sort();
    for(const name of files){
      await pool.query(await readFile(resolve(directory,name),'utf8'));
      await pool.query('INSERT INTO schema_migration(name) VALUES($1)',[name]);
    }

    await pool.query(`INSERT INTO nda_record(id,position,version,source,created_at,updated_at,fields,fingerprint,deleted_at,deleted_by)
      VALUES
      ('agreement-later',20,1,'manual','2026-02-01','2026-02-01','{}','later',NULL,NULL),
      ('agreement-first-recycled',10,1,'manual','2026-03-01','2026-03-01','{}','first','2026-04-01','Local user')`);
    await pool.query(`INSERT INTO contract(id,version,status,values,created_at,updated_at,deleted_at,deleted_by)
      VALUES
      ('document-later',1,'draft','{}','2026-02-01','2026-02-01',NULL,NULL),
      ('document-first-recycled',1,'draft','{}','2026-01-01','2026-01-01','2026-04-01','Local user')`);

    await migrate(pool);

    expect((await pool.query('SELECT id,reference_code FROM nda_record ORDER BY position')).rows).toEqual([
      {id:'agreement-first-recycled',reference_code:'AGR-000001'},
      {id:'agreement-later',reference_code:'AGR-000002'},
    ]);
    expect((await pool.query('SELECT id,reference_code FROM contract ORDER BY created_at,id')).rows).toEqual([
      {id:'document-first-recycled',reference_code:'DOC-000001'},
      {id:'document-later',reference_code:'DOC-000002'},
    ]);

    const nextAgreement=await pool.query(`INSERT INTO nda_record(id,position,version,source,created_at,updated_at,fields,fingerprint)
      VALUES('agreement-next',30,1,'manual',now(),now(),'{}','next') RETURNING reference_code`);
    const nextDocument=await pool.query(`INSERT INTO contract(id,version,status,values,created_at,updated_at)
      VALUES('document-next',1,'draft','{}',now(),now()) RETURNING reference_code`);
    expect(nextAgreement.rows[0].reference_code).toBe('AGR-000003');
    expect(nextDocument.rows[0].reference_code).toBe('DOC-000003');
    await pool.query("SELECT setval('nda_record_reference_seq',999999,true),setval('contract_reference_seq',999999,true)");
    const millionthAgreement=await pool.query(`INSERT INTO nda_record(id,position,version,source,created_at,updated_at,fields,fingerprint)
      VALUES('agreement-million',40,1,'manual',now(),now(),'{}','million') RETURNING reference_code`);
    const millionthDocument=await pool.query(`INSERT INTO contract(id,version,status,values,created_at,updated_at)
      VALUES('document-million',1,'draft','{}',now(),now()) RETURNING reference_code`);
    expect(millionthAgreement.rows[0].reference_code).toBe('AGR-1000000');
    expect(millionthDocument.rows[0].reference_code).toBe('DOC-1000000');
    await expect(pool.query("UPDATE contract SET reference_code='DOC-999999' WHERE id='document-next'"))
      .rejects.toMatchObject({code:'23514'});
  });
});
