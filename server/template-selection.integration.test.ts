import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {sqliteTestPool} from './sqlite-test-helper';
import {PgContractStore,seedContractTemplates} from './contract-store';
import {createFfmContractDefaults} from '../src/contract-core';

describe('explicit published template version generation',()=>{
  it('freezes an earlier published version, preserves the default and rejects another family',async()=>{
    const {pool,cleanup}=await sqliteTestPool('template-selection');
    try{
      await seedContractTemplates(pool);
      const store=new PgContractStore(pool);
      const nda=(await pool.query("SELECT * FROM contract_template WHERE document_type='nda' LIMIT 1")).rows[0];
      const newerId=randomUUID();
      await pool.query('UPDATE contract_template SET active=0 WHERE id=$1',[nda.id]);
      await pool.query(`INSERT INTO contract_template(id,template_key,template_version,name,file_name,mime_type,content,checksum,tags,active,family_id,document_type,template_format,field_schema)
        VALUES($1,$2,'next',$3,$4,$5,$6,$7,$8,1,$9,'nda','docx',$10)`,[newerId,nda.template_key,nda.name,nda.file_name,nda.mime_type,nda.content,nda.checksum,nda.tags,nda.family_id,nda.field_schema]);
      await pool.query('UPDATE template_family SET published_template_id=$2 WHERE id=$1',[nda.family_id,newerId]);
      const values=createFfmContractDefaults();values.recipient.name='Supplier';values.recipient.registrationNumber='123';values.recipient.address='Address';values.purpose='Project evaluation';
      const {contract}=await store.create({requestId:randomUUID(),values,templateFamilyId:nda.family_id});
      const command={requestId:randomUUID(),expectedVersion:contract.version,templateId:nda.id};
      const selected=await store.enqueueGeneration(contract.id,command);
      expect((await pool.query('SELECT template_id,template_version FROM document_job_item WHERE job_id=$1',[selected.job.id])).rows[0]).toMatchObject({template_id:nda.id,template_version:nda.template_version});
      expect((await store.enqueueGeneration(contract.id,command)).job.id).toBe(selected.job.id);
      const latest=await store.enqueueGeneration(contract.id,{requestId:randomUUID(),expectedVersion:contract.version});
      expect((await pool.query('SELECT template_id FROM document_job_item WHERE job_id=$1',[latest.job.id])).rows[0].template_id).toBe(newerId);
      const foreign=randomUUID();
      await pool.query(`INSERT INTO template_family(id,family_key,name,document_type,template_format,active,created_at,updated_at) VALUES($1,$2,'Other','nda','docx',1,now(),now())`,[foreign,foreign]);
      const {contract:other}=await store.create({requestId:randomUUID(),values,templateFamilyId:foreign});
      await expect(store.enqueueGeneration(other.id,{requestId:randomUUID(),expectedVersion:other.version,templateId:nda.id})).rejects.toMatchObject({code:'template_family_mismatch'});
      expect((await pool.query('SELECT active FROM contract_template WHERE id=$1',[newerId])).rows[0].active).toBe(1);
      const unlinked=await store.create({requestId:randomUUID(),values});
      await expect(store.enqueueGeneration(unlinked.contract.id,{requestId:randomUUID(),expectedVersion:unlinked.contract.version,templateId:nda.id})).rejects.toMatchObject({code:'template_unavailable'});
      await pool.query('UPDATE template_family SET active=0 WHERE id=$1',[nda.family_id]);
      await expect(store.enqueueGeneration(unlinked.contract.id,{requestId:randomUUID(),expectedVersion:unlinked.contract.version,templateId:newerId})).rejects.toMatchObject({code:'template_unavailable'});
    }finally{await cleanup();}
  });
});
