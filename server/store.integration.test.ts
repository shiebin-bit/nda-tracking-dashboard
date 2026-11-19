import type { Pool } from './db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyFields, type Fields } from '../src/core';
import { PgNdaStore } from './store';
import { sqliteTestPool } from './sqlite-test-helper';

describe('SQLite store integration',()=>{
  let pool:Pool; let store:PgNdaStore; let cleanup:()=>Promise<void>;
  const valid=(recipient:string,overrides:Partial<Fields>={}):Fields=>({...createEmptyFields(),Recipient:recipient,'Date of Agreement':'2026-01-01',Duration:1,UOM:'years',PIC:'Lee',Status:'Pending',...overrides});
  beforeAll(async()=>{
    ({pool,cleanup}=await sqliteTestPool('nda-store')); store=new PgNdaStore(pool);
  });
  afterAll(async()=>{await cleanup?.();});

  it('creates records, rejects invalid statuses, and detects stale versions',async()=>{
    await expect(store.create({fields:valid('Bad',{Status:'Waiting'})})).rejects.toMatchObject({status:400});
    expect((await store.state()).snapshot.records).toHaveLength(0);
    const created=await store.create({fields:valid('Acme')}); const record=created.snapshot.records[0];
    const updated=await store.update(record.id,{expectedVersion:1,fields:{...record.fields,PIC:'New PIC'}});
    expect(updated.snapshot.records[0]).toMatchObject({version:2,fields:{PIC:'New PIC'}});
    await expect(store.update(record.id,{expectedVersion:1,fields:record.fields})).rejects.toMatchObject({status:409,code:'version_conflict'});
  });

  it('rolls back renewal when new fields fail validation',async()=>{
    const current=await store.state(); const old=current.snapshot.records[0]; const revision=current.revision;
    await expect(store.renew(old.id,{expectedVersion:old.version,fields:valid('Renewed',{PIC:null})})).rejects.toMatchObject({status:400});
    const after=await store.state(); expect(after.revision).toBe(revision); expect(after.snapshot.records).toHaveLength(1);
    expect(after.snapshot.records[0].fields.Status).toBe('Pending');
  });

  it('serializes concurrent imports and skips exact duplicates',async()=>{
    const row=valid('Imported',{PIC:null});
    const [first,second]=await Promise.all([store.importRows({rows:[row]}),store.importRows({rows:[row]})]);
    expect(Math.max(first.snapshot.records.length,second.snapshot.records.length)).toBe(2);
    expect((await store.state()).snapshot.records.filter(record=>record.fields.Recipient==='Imported')).toHaveLength(1);
    const before=await store.state();
    await expect(store.importRows({rows:[row,{...row,Status:'Invalid'}]})).rejects.toMatchObject({status:400});
    expect((await store.state()).revision).toBe(before.revision);
  });

  it('checks settings revisions and archives restore preimages for rollback',async()=>{
    const current=await store.state(); const settings={...current.snapshot.settings,reminderDays:[120,30]};
    const changed=await store.updateSettings({expectedRevision:current.revision,settings});
    expect(changed.snapshot.settings.reminderDays).toEqual([120,30]);
    await expect(store.updateSettings({expectedRevision:current.revision,settings})).rejects.toMatchObject({status:409,code:'revision_conflict'});
    const restored=await store.restore({expectedRevision:changed.revision,snapshot:{...changed.snapshot,records:[],history:[]}});
    expect(restored.archiveId).toBeTruthy(); expect(restored.snapshot.records).toHaveLength(0);
    await expect(store.listArchives()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({id:restored.archiveId,records:changed.snapshot.records.length,history:changed.snapshot.history.length}),
    ]));
    const rolledBack=await store.restoreArchive(restored.archiveId!,{expectedRevision:restored.revision});
    expect(rolledBack.snapshot.records).toHaveLength(changed.snapshot.records.length);
  });
});
