import { describe, expect, it, vi } from 'vitest';
import { createEmptyFields, type Snapshot, type StateEnvelope } from './core';
import { NdaRepository } from './storage';

const snapshot: Snapshot = {
  schemaVersion:1, records:[], history:[], initializedAt:'2026-10-19T00:00:00.000Z',
  settings:{recipientEmail:'',ccEmail:'',senderEmail:'',sendTime:'09:00',timeZone:'Asia/Kuala_Lumpur',reminderDays:[90,60,45,30]},
};

function response(body:unknown,status=200):Response {
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
}

describe('HTTP NdaRepository',()=>{
  it('adds the server revision to loaded snapshots',async()=>{
    const fetcher=vi.fn(async()=>response({revision:'7',snapshot} satisfies StateEnvelope));
    const result=await new NdaRepository('/api',fetcher as typeof fetch).load();
    expect(result.revision).toBe('7');
    expect(fetcher).toHaveBeenCalledWith('/api/state',expect.objectContaining({credentials:'same-origin'}));
  });
  it('sends explicit revisions for settings and restore writes',async()=>{
    const fetcher=vi.fn(async()=>response({revision:'9',snapshot})); const repo=new NdaRepository('/api',fetcher as typeof fetch);
    await repo.updateSettings(snapshot.settings,'8'); await repo.restore(snapshot,'9');
    const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
    expect(JSON.parse(calls[0][1].body as string)).toEqual({expectedRevision:'8',settings:snapshot.settings});
    expect(JSON.parse(calls[1][1].body as string)).toEqual({expectedRevision:'9',snapshot});
  });
  it('sends record versions and fields',async()=>{
    const fetcher=vi.fn(async()=>response({revision:'1',snapshot})); const fields=createEmptyFields();
    await new NdaRepository('/api',fetcher as typeof fetch).update('legacy/id',3,fields);
    const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
    expect(calls[0][0]).toBe('/api/records/legacy%2Fid');
    expect(JSON.parse(calls[0][1].body as string)).toEqual({expectedVersion:3,fields});
  });
  it('surfaces structured conflict errors',async()=>{
    const fetcher=vi.fn(async()=>response({error:{code:'revision_conflict',message:'Reload first.'}},409));
    await expect(new NdaRepository('/api',fetcher as typeof fetch).load()).rejects.toEqual(
      expect.objectContaining({status:409,code:'revision_conflict',message:'Reload first.'}),
    );
  });
  it('rejects malformed successful envelopes',async()=>{
    const fetcher=vi.fn(async()=>response({snapshot}));
    await expect(new NdaRepository('/api',fetcher as typeof fetch).load()).rejects.toMatchObject({status:502,code:'invalid_response'});
  });
  it('loads restore archive summaries independently of state envelopes',async()=>{
    const archives=[{id:'archive-1',createdAt:'2026-10-19T01:00:00.000Z',records:11,history:12}];
    const fetcher=vi.fn(async()=>response({archives}));
    await expect(new NdaRepository('/api',fetcher as typeof fetch).listArchives()).resolves.toEqual(archives);
    expect((fetcher.mock.calls as unknown as [string,RequestInit][])[0][0]).toBe('/api/backups/archives');
  });
});
