import {afterEach,describe,expect,it} from 'vitest';
import {DocumentSettingsStore} from './document-settings';
import {sqliteTestPool} from './sqlite-test-helper';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});

describe('document settings store',()=>{
  it('returns defaults and performs an optimistic independent update',async()=>{
    const {pool,cleanup}=await sqliteTestPool('document-settings');cleanups.push(cleanup);
    const store=new DocumentSettingsStore(pool);
    await expect(store.get()).resolves.toEqual({
      revision:0,
      settings:{filenameFields:['type','supplier','project','date']},
    });
    await expect(store.update(0,{filenameFields:['project','type']})).resolves.toEqual({
      revision:1,
      settings:{filenameFields:['project','type']},
    });
    expect((await pool.query('SELECT revision FROM workspace WHERE id=1')).rows[0].revision).toBe(0);
    await expect(store.update(0,{filenameFields:[]})).rejects.toMatchObject({status:409,code:'revision_conflict'});
  });

  it('rejects malformed, duplicate and unsupported filename fields',async()=>{
    const {pool,cleanup}=await sqliteTestPool('document-settings-invalid');cleanups.push(cleanup);
    const store=new DocumentSettingsStore(pool);
    await expect(store.update(0,{filenameFields:['type','type']} as never)).rejects.toMatchObject({status:400});
    await expect(store.update(0,{filenameFields:['other']} as never)).rejects.toMatchObject({status:400});
    await expect(store.update(-1,{filenameFields:[]})).rejects.toMatchObject({status:400});
  });
});
