import { describe, expect, it } from 'vitest';
import { createEmptyFields, type Snapshot } from '../src/core';
import { assertRevision, normalizeSettings, normalizeSnapshot } from './domain';

const settings={recipientEmail:'',ccEmail:'',senderEmail:'',sendTime:'09:00',timeZone:'Asia/Kuala_Lumpur' as const};
const fields={...createEmptyFields(),Recipient:'Acme','Date of Agreement':'2026-01-01',Duration:1,UOM:'years',PIC:'Lee',Status:'Pending'};
const base:Snapshot={schemaVersion:1,records:[{id:'seed-001',fields,version:1,source:'seed',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}],history:[],settings:{...settings,reminderDays:[90,60,45,30]},initializedAt:'2026-01-01T00:00:00Z'};

describe('server domain validation',()=>{
  it('migrates legacy settings missing reminder days',()=>{
    expect(normalizeSettings(settings,true).reminderDays).toEqual([90,60,45,30]);
  });
  it('validates optional settings email addresses',()=>{
    expect(()=>normalizeSettings({...settings,recipientEmail:'bad',reminderDays:[30]})).toThrow(/valid email/);
  });
  it('accepts legacy text IDs and rejects orphan links before restore',()=>{
    expect(normalizeSnapshot(base).records[0].id).toBe('seed-001');
    expect(()=>normalizeSnapshot({...base,history:[{id:'history-seed-001',ndaId:'missing',type:'x',timestamp:'2026-01-01T00:00:00Z',actor:'x',summary:'x',changes:[]}]})).toThrow(/missing NDA/);
    expect(()=>normalizeSnapshot({...base,records:[{...base.records[0],renewedFromId:'missing'}]})).toThrow(/missing renewed-from/);
  });
  it('rejects revisions above PostgreSQL bigint range',()=>{
    expect(assertRevision('9223372036854775807')).toBe('9223372036854775807');
    expect(()=>assertRevision('9223372036854775808')).toThrow(/supported range/);
  });
  it('strictly validates restored follow-up note events without changing other history types',()=>{
    const note={id:'123e4567-e89b-42d3-a456-426614174000',ndaId:'seed-001',type:'follow-up-added',timestamp:'2026-10-20T00:00:00Z',actor:'Local user',summary:'Added follow-up note.',changes:[{field:'Follow-up note',before:null,after:'Called recipient.'}]};
    expect(normalizeSnapshot({...base,history:[note]}).history[0]).toMatchObject(note);
    expect(()=>normalizeSnapshot({...base,history:[{...note,changes:[{...note.changes[0],after:'  untrimmed  '}]}]})).toThrow(/valid follow-up note/);
    expect(()=>normalizeSnapshot({...base,history:[{...note,actor:'Someone else'}]})).toThrow(/valid follow-up note/);
    expect(()=>normalizeSnapshot({...base,history:[{...note,changes:[...note.changes,{field:'extra',before:null,after:'x'}]}]})).toThrow(/valid follow-up note/);
  });
});
