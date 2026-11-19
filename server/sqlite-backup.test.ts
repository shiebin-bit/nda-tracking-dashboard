import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {Pool} from './db.js';
import {seedContractTemplates} from './contract-store.js';
import {saveSqliteBackup,verifySqliteBackup} from './sqlite-backup.js';

const directories:string[]=[];const pools:Pool[]=[];
afterEach(async()=>{for(const pool of pools.splice(0))await pool.end();for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'nda-backup-test-'));directories.push(directory);const pool=new Pool(join(directory,'workspace.sqlite'));pools.push(pool);await seedContractTemplates(pool);return {directory,pool};}
describe('complete SQLite backup validation',()=>{
  it('refuses the open database, Windows case aliases and working sidecars as a backup target',async()=>{
    const {pool}=await fixture();
    for(const target of [pool.path,`${pool.path}-wal`,`${pool.path}-shm`,...(process.platform==='win32'?[pool.path.toUpperCase()]:[])])await expect(saveSqliteBackup(pool,target)).rejects.toThrow(/active database/);
    expect((await pool.query('SELECT count(*) n FROM contract_template')).rows[0].n).toBe(2);
  });
  it('creates a complete verified snapshot including published template bytes',async()=>{
    const {directory,pool}=await fixture();const file=join(directory,'complete.sqlite');
    const result=await saveSqliteBackup(pool,file);expect(result.sizeBytes).toBeGreaterThan(100);expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifySqliteBackup(file)).resolves.toBeUndefined();
    const db=new DatabaseSync(file,{readOnly:true});try{expect(Number(db.prepare('SELECT count(*) n FROM contract_template').get()!.n)).toBe(2);expect(Number(db.prepare('SELECT count(*) n FROM reference_counter').get()!.n)).toBe(2);}finally{db.close();}
  });
  it('rejects extra triggers before a restored database can execute them',async()=>{
    const {directory,pool}=await fixture();const file=join(directory,'modified.sqlite');await saveSqliteBackup(pool,file);
    const db=new DatabaseSync(file);try{db.exec("CREATE TRIGGER unwanted AFTER UPDATE ON workspace BEGIN DELETE FROM nda_record; END;");}finally{db.close();}
    await expect(verifySqliteBackup(file)).rejects.toThrow(/modified database schema/);
  });
  it('rejects corrupted editable-template bytes even when integrity and foreign keys are valid',async()=>{
    const {directory,pool}=await fixture();const content=Buffer.from('original template bytes');const hash=createHash('sha256').update(content).digest('hex');
    await pool.query(`UPDATE template_draft SET source_content=$1,source_checksum=$2 WHERE id=(SELECT id FROM template_draft LIMIT 1)`,[content,hash]);
    const file=join(directory,'corrupt-template.sqlite');await saveSqliteBackup(pool,file);
    const db=new DatabaseSync(file);try{db.prepare("UPDATE template_draft SET source_content=? WHERE id=(SELECT id FROM template_draft LIMIT 1)").run(Buffer.from('corrupted template bytes'));}finally{db.close();}
    await expect(verifySqliteBackup(file)).rejects.toThrow(/checksum/);
  });
});
