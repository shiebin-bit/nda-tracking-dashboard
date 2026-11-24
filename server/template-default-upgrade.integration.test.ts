import {mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,expect,it} from 'vitest';
import {sqliteTestPool} from './sqlite-test-helper';
import {seedContractTemplates} from './contract-store';

async function originalTemplates(){
  const directory=await mkdtemp(join(tmpdir(),'nda-original-eoi-'));
  const eoi=JSON.parse(await readFile('templates/eoi-template-map.json','utf8'));
  await writeFile(join(directory,'eoi-template-map.json'),JSON.stringify(Array.isArray(eoi)?eoi.find(item=>item.version==='1.0'):eoi));
  for(const file of ['template-map.json','ffm-nda-v1.docx','ffm-eoi-v1.docx'])await copyFile(resolve('templates',file),join(directory,file));
  return directory;
}
describe('packaged EOI additive version upgrade',()=>{
  it('activates 1.1 only for untouched defaults and never changes old published bytes',async()=>{
    const {pool,cleanup}=await sqliteTestPool('nda-eoi-upgrade');const directory=await originalTemplates();
    try{await seedContractTemplates(pool,directory);const before=(await pool.query("SELECT * FROM contract_template WHERE document_type='eoi'")).rows[0];
      await seedContractTemplates(pool);const current=(await pool.query("SELECT t.* FROM template_family f JOIN contract_template t ON t.id=f.published_template_id WHERE f.family_key='ffm-eoi'")).rows[0];expect(current.template_version).toBe('1.1');
      const old=(await pool.query('SELECT content,checksum,active FROM contract_template WHERE id=$1',[before.id])).rows[0];expect(old.content).toEqual(before.content);expect(old.checksum).toBe(before.checksum);expect(old.active).toBe(0);
      const draft=(await pool.query('SELECT source_checksum,editor_snapshot FROM template_draft WHERE family_id=$1',[current.family_id])).rows[0];expect(draft.source_checksum).toBe(current.checksum);expect(draft.editor_snapshot.fields.filter((f:any)=>['recipient_name','project_name'].includes(f.key)).every((f:any)=>f.appearance.fontWeight==='bold')).toBe(true);
      await seedContractTemplates(pool);expect((await pool.query("SELECT count(*) count FROM contract_template WHERE document_type='eoi'")).rows[0].count).toBe(2);
    }finally{await cleanup();await rm(directory,{recursive:true,force:true});}
  });
  it('keeps saved unpublished edits and leaves the additive version available to copy',async()=>{
    const {pool,cleanup}=await sqliteTestPool('nda-eoi-custom');const directory=await originalTemplates();
    try{await seedContractTemplates(pool,directory);await pool.query("UPDATE template_draft SET name='My unpublished EOI',version=version+1 WHERE family_id=(SELECT id FROM template_family WHERE family_key='ffm-eoi')");
      const before=(await pool.query("SELECT * FROM template_draft WHERE name='My unpublished EOI'")).rows[0];await seedContractTemplates(pool);
      const after=(await pool.query('SELECT * FROM template_draft WHERE id=$1',[before.id])).rows[0];expect(after).toEqual(before);
      expect((await pool.query("SELECT t.template_version FROM template_family f JOIN contract_template t ON t.id=f.published_template_id WHERE f.family_key='ffm-eoi'")).rows[0].template_version).toBe('1.0');
      expect((await pool.query("SELECT active FROM contract_template WHERE document_type='eoi' AND template_version='1.1'")).rows[0].active).toBe(0);
    }finally{await cleanup();await rm(directory,{recursive:true,force:true});}
  });
  it('keeps even a saved draft whose text was not changed',async()=>{
    const {pool,cleanup}=await sqliteTestPool('nda-eoi-noop');const directory=await originalTemplates();
    try{await seedContractTemplates(pool,directory);await pool.query("UPDATE template_draft SET version=version+1 WHERE family_id=(SELECT id FROM template_family WHERE family_key='ffm-eoi')");
      const before=(await pool.query("SELECT * FROM template_draft WHERE family_id=(SELECT id FROM template_family WHERE family_key='ffm-eoi')")).rows[0];
      await seedContractTemplates(pool);expect((await pool.query('SELECT * FROM template_draft WHERE id=$1',[before.id])).rows[0]).toEqual(before);
    }finally{await cleanup();await rm(directory,{recursive:true,force:true});}
  });

});
