import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it} from 'vitest';
import {createFfmContractDefaults} from '../src/contract-core';
import {PgContractStore,seedContractTemplates} from './contract-store';
import {sqliteTestPool} from './sqlite-test-helper';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});

describe('version-bound generated document naming',()=>{
  it('uses frozen generation values and binds shared artifacts and archives to the exact version',async()=>{
    const {pool,cleanup}=await sqliteTestPool('document-naming');cleanups.push(cleanup);
    await seedContractTemplates(pool);
    const store=new PgContractStore(pool);
    const values=createFfmContractDefaults();values.recipient.name='Draft Supplier';
    const created=await store.create({requestId:randomUUID(),values});
    const contractId=created.contract.id;
    const reference=created.contract.reference;
    const template=(await pool.query("SELECT * FROM contract_template WHERE document_type='nda' ORDER BY created_at,id LIMIT 1")).rows[0];
    await pool.query("UPDATE document_settings SET revision=1,filename_fields=$1 WHERE id=1",[['supplier','project','date','type']]);

    const docxId=randomUUID();const pdfId=randomUUID();const v1=randomUUID();const v2=randomUUID();
    await pool.query(`INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
      VALUES($1,$3,'docx','stored-original.docx','application/octet-stream',$4,'docx',now()),
            ($2,$3,'pdf','stored-original.pdf','application/pdf',$5,'pdf',now())`,
    [docxId,pdfId,contractId,Buffer.from('same immutable docx'),Buffer.from('%PDF-test')]);
    const insertVersion=async(id:string,ordinal:number,supplier:string,project:string,createdAt:string,pdf:string|null)=>pool.query(
      `INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
       template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,custom_values_snapshot,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id,contractId,ordinal,template.id,template.template_key,template.template_version,template.checksum,template.content,
        JSON.stringify({...values,recipient:{...values.recipient,name:supplier}}),docxId,pdf,JSON.stringify({project_name:project}),createdAt]);
    await insertVersion(v1,1,'Supplier One / Asia','Project One','2026-01-01T16:30:00.000Z',null);
    await insertVersion(v2,2,'Supplier Two','Project Two','2026-02-02T01:00:00.000Z',pdfId);

    const exact=await store.artifact(docxId,v1);
    expect(exact.fileName).toBe(`Supplier One Asia_Project One_2026-01-02_NDA_${reference}_v1.docx`);
    expect(exact.content.toString()).toBe('same immutable docx');
    const latest=await store.artifact(docxId);
    expect(latest.versionId).toBe(v2);
    expect(latest.fileName).toContain(`Supplier Two_Project Two_2026-02-02_NDA_${reference}_v2.docx`);
    expect((await pool.query('SELECT file_name FROM document_artifact WHERE id=$1',[docxId])).rows[0].file_name).toBe('stored-original.docx');

    const other=await store.create({requestId:randomUUID(),values});const otherArtifact=randomUUID();const otherVersion=randomUUID();
    await pool.query(`INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
      VALUES($1,$2,'docx','other.docx','application/octet-stream',$3,'other',now())`,[otherArtifact,other.contract.id,Buffer.from('other')]);
    await pool.query(`INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,
      template_checksum,template_bytes,values_snapshot,docx_artifact_id,created_at)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,now())`,[otherVersion,other.contract.id,template.id,template.template_key,
      template.template_version,template.checksum,template.content,JSON.stringify(values),otherArtifact]);
    await expect(store.artifact(docxId,otherVersion)).rejects.toMatchObject({status:404});

    const jobId=randomUUID();
    await pool.query("INSERT INTO document_job(id,status,created_at,updated_at) VALUES($1,'partial',now(),now())",[jobId]);
    await pool.query(`INSERT INTO document_job_item(id,job_id,contract_id,status,attempts,values_snapshot,template_id,
      template_key,template_version,template_checksum,template_file_name,template_bytes,version_id,docx_artifact_id,
      custom_values_snapshot,created_at,updated_at)
      VALUES($1,$2,$3,'partial',3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())`,
    [randomUUID(),jobId,contractId,JSON.stringify(values),template.id,template.template_key,template.template_version,
      template.checksum,template.file_name,template.content,v1,docxId,JSON.stringify({project_name:'Project One'})]);
    const archive=await store.archivePlan(jobId);
    expect(archive.entries).toEqual([expect.objectContaining({artifactId:docxId,versionId:v1})]);
    expect(archive.entries[0].fileName).toContain(`Supplier One Asia_Project One_2026-01-02_NDA_${reference}_v1.docx`);
    await expect(pool.query('DELETE FROM contract_template WHERE id=$1',[template.id])).rejects.toThrow(/immutable/);
  });
});
