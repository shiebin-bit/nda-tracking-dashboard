import { randomUUID } from 'node:crypto';
import type { Pool } from './db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyFields, type Fields } from '../src/core';
import { PgNdaStore } from './store';
import { sqliteTestPool } from './sqlite-test-helper';

describe('SQLite follow-up notes',()=>{
  let pool:Pool; let store:PgNdaStore; let cleanup:()=>Promise<void>;
  const fields=(recipient:string):Fields=>({...createEmptyFields(),Recipient:recipient,'Date of Agreement':'2026-01-01',Duration:1,UOM:'years',PIC:'Lee',Status:'Pending'});
  beforeAll(async()=>{
    ({pool,cleanup}=await sqliteTestPool('nda-follow-up')); store=new PgNdaStore(pool);
  });
  afterAll(async()=>{await cleanup?.();});

  it('adds, trims, replays, and restores a note without duplicate bumps',async()=>{
    const created=await store.create({fields:fields('Acme')}); const record=created.snapshot.records[0]; const requestId=randomUUID();
    const added=await store.addFollowUpNote(record.id,{requestId,expectedVersion:record.version,text:'  Called recipient.  '});
    expect(added.revision).toBe('2');
    expect(added.snapshot.records[0]).toMatchObject({version:2,fields:record.fields});
    expect(added.snapshot.history.at(-1)).toMatchObject({id:requestId,ndaId:record.id,type:'follow-up-added',actor:'Local user',summary:'Added follow-up note.',changes:[{field:'Follow-up note',before:null,after:'Called recipient.'}]});
    const replayed=await store.addFollowUpNote(record.id,{requestId,expectedVersion:1,text:'Called recipient.'});
    expect(replayed.revision).toBe(added.revision); expect(replayed.snapshot.records[0].version).toBe(2);
    const restored=await store.restore({expectedRevision:added.revision,snapshot:added.snapshot});
    expect(restored.snapshot.history.some(event=>event.id===requestId)).toBe(true);
  });

  it('serializes identical concurrent requests and rejects stale or conflicting requests',async()=>{
    const state=await store.state();
    const first=await store.create({fields:fields('Concurrent')}); const record=first.snapshot.records.find(item=>item.fields.Recipient==='Concurrent')!;
    const requestId=randomUUID();
    const [left,right]=await Promise.all([
      store.addFollowUpNote(record.id,{requestId,expectedVersion:record.version,text:'Same note'}),
      store.addFollowUpNote(record.id,{requestId,expectedVersion:record.version,text:'Same note'}),
    ]);
    expect(left.revision).toBe(right.revision);
    const current=await store.state();
    expect(current.snapshot.history.filter(event=>event.id===requestId)).toHaveLength(1);
    expect(current.snapshot.records.find(item=>item.id===record.id)?.version).toBe(2);
    await expect(store.addFollowUpNote(record.id,{requestId,expectedVersion:2,text:'Different'})).rejects.toMatchObject({code:'request_id_conflict'});
    await expect(store.addFollowUpNote(record.id,{requestId:randomUUID(),expectedVersion:1,text:'Stale'})).rejects.toMatchObject({code:'version_conflict'});
    expect((await store.state()).revision).toBe(current.revision);
    expect(BigInt(current.revision)).toBeGreaterThan(BigInt(state.revision));
  });

  it('rejects invalid IDs and note bodies without database changes',async()=>{
    const current=await store.state(); const record=current.snapshot.records[0];
    for(const body of [
      {requestId:'bad',expectedVersion:record.version,text:'note'},
      {requestId:randomUUID(),expectedVersion:record.version,text:'   '},
      {requestId:randomUUID(),expectedVersion:record.version,text:'bad\0note'},
      {requestId:randomUUID(),expectedVersion:record.version,text:'x'.repeat(2001)},
    ]) await expect(store.addFollowUpNote(record.id,body)).rejects.toMatchObject({status:400});
    expect((await store.state()).revision).toBe(current.revision);
  });
});
