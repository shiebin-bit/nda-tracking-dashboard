import { randomUUID } from 'node:crypto';
import type { Pool } from './db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyFields } from '../src/core';
import { contractValuesToTracking, createFfmContractDefaults } from '../src/contract-core';
import { PgNdaStore } from './store';
import { PgSupplierStore } from './supplier-store';
import { PgContractStore, seedContractTemplates } from './contract-store';
import { sqliteTestPool } from './sqlite-test-helper';

describe('supplier and project SQLite persistence',()=>{
  let pool:Pool;let suppliers:PgSupplierStore;let nda:PgNdaStore;let contracts:PgContractStore;let cleanup:()=>Promise<void>;
  beforeAll(async()=>{
    ({pool,cleanup}=await sqliteTestPool('nda-supplier'));await seedContractTemplates(pool);
    suppliers=new PgSupplierStore(pool);nda=new PgNdaStore(pool);contracts=new PgContractStore(pool);
  });
  afterAll(async()=>{await cleanup?.();});

  it('preserves manual supplier IDs, rejects case-insensitive duplicates, and manages shared projects',async()=>{
    const supplier=await suppliers.createSupplier({supplierCode:'000a-17',companyName:'Example Supplier',registrationNumber:'REG-1',contact:{email:'contact@example.com'}});
    expect(supplier).toMatchObject({supplierCode:'000a-17',companyName:'Example Supplier',version:1});
    await expect(suppliers.createSupplier({supplierCode:'000A-17',companyName:'Duplicate'})).rejects.toMatchObject({code:'duplicate_code'});
    const updated=await suppliers.updateSupplier(supplier.id,{...supplier,companyName:'Example Supplier Updated',expectedVersion:1});
    expect(updated).toMatchObject({version:2,companyName:'Example Supplier Updated'});
    const project=await suppliers.createProject({projectCode:'P-01',name:'Feed evaluation',description:'Supplier evaluation'});
    expect(project).toMatchObject({projectCode:'P-01',status:'active',version:1});
    await expect(suppliers.createProject({projectCode:'p-01',name:'Duplicate'})).rejects.toMatchObject({code:'duplicate_code'});
    // Unicode checks share the writer transaction; failed duplicates add no row.
    await expect(suppliers.createSupplier({supplierCode:'000É-QA',companyName:'Original'})).resolves.toBeDefined();
    await expect(suppliers.createSupplier({supplierCode:'000é-QA',companyName:'Duplicate'})).rejects.toMatchObject({code:'duplicate_code'});
    await pool.query("UPDATE supplier SET deleted_at=now(),deleted_by='QA' WHERE supplier_code='000É-QA'");
    await expect(suppliers.createProject({projectCode:'É-QA',name:'Original'})).resolves.toBeDefined();
    await expect(suppliers.createProject({projectCode:'é-QA',name:'Duplicate'})).rejects.toMatchObject({code:'duplicate_code'});
  });

  it('links an NDA explicitly and carries the supplier into a renewal without adding it to the 26 fields',async()=>{
    const supplier=(await suppliers.listSuppliers())[0];
    const fields={...createEmptyFields(),Recipient:'Example Supplier','Date of Agreement':'2026-01-01',Duration:1,UOM:'Years',PIC:'Lee',Status:'Pending'};
    const created=await nda.create({fields});const record=created.snapshot.records[0];
    const linked=await nda.linkSupplier(record.id,{supplierId:supplier.id,expectedVersion:record.version});
    const linkedRecord=linked.snapshot.records[0];
    expect(linkedRecord).toMatchObject({supplierId:supplier.id,supplierCode:'000a-17',version:2});
    expect(Object.keys(linkedRecord.fields)).toHaveLength(26);
    const renewed=await nda.renew(record.id,{expectedVersion:linkedRecord.version,fields:{...fields,'Date of Agreement':'2027-01-01'}});
    const child=renewed.snapshot.records.find(item=>item.renewedFromId===record.id)!;
    expect(child).toMatchObject({supplierId:supplier.id,supplierCode:'000a-17'});
    const details=await suppliers.supplier(supplier.id);
    expect(details.agreements.map(item=>item.id)).toEqual(expect.arrayContaining([record.id,child.id]));
  });

  it('does not create supplier masters during register restore and records unmatched links',async()=>{
    const before=await nda.state();const supplierId=before.snapshot.records.find(item=>item.supplierId)?.supplierId;
    expect(supplierId).toBeTruthy();
    await pool.query("UPDATE supplier SET deleted_at=now(),deleted_by='Local user' WHERE id=$1",[supplierId]);
    const restored=await nda.restore({expectedRevision:before.revision,snapshot:before.snapshot});
    expect(restored.snapshot.records.every(item=>!item.supplierId)).toBe(true);
    expect(restored.snapshot.history.at(-1)).toMatchObject({type:'supplier-links-missing',actor:'System'});
    expect(await suppliers.listSuppliers()).toEqual([]);
  });

  it('allocates stable display references, preserves them by record ID on restore, and ignores a reference supplied for a new ID',async()=>{
    const fields={...createEmptyFields(),Recipient:'Reference Supplier','Date of Agreement':'2026-01-01',Duration:1,UOM:'Years',PIC:'Lee',Status:'Pending'};
    const first=(await nda.create({fields})).snapshot.records.find(item=>item.fields.Recipient==='Reference Supplier')!;
    const second=(await nda.create({fields:{...fields,Recipient:'Second Reference Supplier'}})).snapshot.records.find(item=>item.fields.Recipient==='Second Reference Supplier')!;
    expect(first.reference).toMatch(/^AGR-\d{6,}$/);expect(second.reference).toMatch(/^AGR-\d{6,}$/);expect(second.reference).not.toBe(first.reference);
    const draft=(await contracts.draftForRecord(first.id,{requestId:randomUUID()})).contract;
    expect(draft.reference).toMatch(/^DOC-\d{6,}$/);
    await expect(pool.query('UPDATE nda_record SET reference_code=$2 WHERE id=$1',[first.id,'AGR-999999']))
      .rejects.toMatchObject({code:'ERR_SQLITE_ERROR'});
    const before=await nda.state();
    const added={...structuredClone(second),id:randomUUID(),reference:'AGR-999999',fields:{...second.fields,Recipient:'Restored new ID'}};
    const restored=await nda.restore({expectedRevision:before.revision,snapshot:{...before.snapshot,records:[...before.snapshot.records,added]}});
    expect(restored.snapshot.records.find(item=>item.id===first.id)?.reference).toBe(first.reference);
    const allocated=restored.snapshot.records.find(item=>item.id===added.id)?.reference;
    expect(allocated).toMatch(/^AGR-\d{6,}$/);expect(allocated).not.toBe('AGR-999999');
    const recycled=await nda.recycle(second.id,{requestId:randomUUID(),expectedVersion:second.version});
    expect(recycled.snapshot.records.some(item=>item.id===second.id)).toBe(false);
    expect((await nda.recycledRecords()).find(item=>item.id===second.id)?.reference).toBe(second.reference);
  });

  it('assigns agreements and signed documents atomically and requires every linked counterpart explicitly',async()=>{
    const supplier=await suppliers.createSupplier({supplierCode:'CLASS-01',companyName:'Classification Supplier'});
    const fields={...createEmptyFields(),Recipient:'Classification Supplier','Date of Agreement':'2026-01-01',Duration:1,UOM:'Years',PIC:'Lee',Status:'Pending'};
    const state=await nda.create({fields});const record=state.snapshot.records.find(item=>item.fields.Recipient==='Classification Supplier')!;
    const document=(await contracts.draftForRecord(record.id,{requestId:randomUUID()})).contract;
    const template=(await pool.query('SELECT * FROM contract_template WHERE active=true AND document_type=\'nda\' LIMIT 1')).rows[0];
    const artifactId=randomUUID();const versionId=randomUUID();const immutable=Buffer.from('immutable generated document bytes');
    await pool.query(`INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
      VALUES($1,$2,'docx','immutable.docx','application/octet-stream',$3,'immutable-checksum',now())`,[artifactId,document.id,immutable]);
    await pool.query(`INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
      template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,NULL,now())`,[versionId,document.id,template.id,template.template_key,
      template.template_version,template.checksum,template.content,JSON.stringify(document.values),artifactId]);
    await pool.query(`UPDATE contract SET status='signed',signed_version_id=$2,signed_at=now() WHERE id=$1`,[document.id,versionId]);
    await expect(suppliers.assignItems(supplier.id,{agreements:[],documents:[{id:document.id,expectedVersion:document.version}]}))
      .rejects.toMatchObject({code:'related_items_required',details:{agreementIds:[record.id],documentIds:[]}});
    await expect(suppliers.assignItems(supplier.id,{agreements:[{id:record.id,expectedVersion:record.version}],documents:[]}))
      .rejects.toMatchObject({code:'related_items_required',details:{agreementIds:[],documentIds:[document.id]}});
    await expect(suppliers.assignItems(supplier.id,{agreements:[{id:record.id,expectedVersion:record.version+1}],documents:[{id:document.id,expectedVersion:document.version}]}))
      .rejects.toMatchObject({code:'version_conflict'});
    expect((await nda.state()).snapshot.records.find(item=>item.id===record.id)?.supplierId).toBeFalsy();
    const assigned=await suppliers.assignItems(supplier.id,{agreements:[{id:record.id,expectedVersion:record.version}],documents:[{id:document.id,expectedVersion:document.version}]});
    expect(assigned).toMatchObject({agreementsChanged:1,documentsChanged:1,supplier:{id:supplier.id}});
    expect(assigned.supplier.agreements).toEqual(expect.arrayContaining([expect.objectContaining({id:record.id,reference:record.reference})]));
    expect(assigned.supplier.documents).toEqual(expect.arrayContaining([expect.objectContaining({id:document.id,reference:document.reference,linkedNdaId:record.id,recipient:'Classification Supplier'})]));
    const stored=await pool.query(`SELECT c.status,c.project_id,c."values" AS "values",a.content,cv.values_snapshot,cv.template_bytes
      FROM contract c JOIN contract_version cv ON cv.id=c.signed_version_id JOIN document_artifact a ON a.id=cv.docx_artifact_id WHERE c.id=$1`,[document.id]);
    expect(stored.rows[0]).toMatchObject({status:'signed',project_id:null,values:document.values,values_snapshot:document.values});
    expect(Buffer.compare(stored.rows[0].content,immutable)).toBe(0);expect(Buffer.compare(stored.rows[0].template_bytes,template.content)).toBe(0);
    expect((await nda.state()).snapshot.history.at(-1)).toMatchObject({type:'supplier-linked',summary:'Assigned NDA record to supplier.'});
    const activity=await pool.query('SELECT type,details FROM contract_activity WHERE contract_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[document.id]);
    expect(activity.rows[0]).toMatchObject({type:'supplier-assigned',details:{supplierId:supplier.id,supplierCode:'CLASS-01'}});
    const other=await suppliers.createSupplier({supplierCode:'CLASS-02',companyName:'Other Classification Supplier'});
    const assignedAgreement=assigned.supplier.agreements.find(item=>item.id===record.id)!;
    await expect(nda.linkSupplier(record.id,{supplierId:other.id,expectedVersion:assignedAgreement.version}))
      .rejects.toMatchObject({code:'related_items_required',details:{agreementIds:[],documentIds:[document.id]}});
    const retry=await suppliers.assignItems(supplier.id,{agreements:[{id:record.id,expectedVersion:record.version}],documents:[{id:document.id,expectedVersion:document.version}]});
    expect(retry).toMatchObject({revision:assigned.revision,agreementsChanged:0,documentsChanged:0});
    expect((await pool.query('SELECT count(*) count FROM contract_activity WHERE contract_id=$1 AND type=\'supplier-assigned\'',[document.id])).rows[0].count).toBe(1);
  });

  it('keeps post-generation supplier classification when the signed document is confirmed',async()=>{
    const source=await suppliers.createSupplier({supplierCode:'CONFIRM-SOURCE',companyName:'Confirm Source'});
    const target=await suppliers.createSupplier({supplierCode:'CONFIRM-TARGET',companyName:'Confirm Target'});
    const values=createFfmContractDefaults();
    values.recipient.name='Confirmation Supplier';values.recipient.registrationNumber='202601000001';
    values.recipient.address='1 Supplier Road';values.purpose='Evaluate confidential materials';
    values.agreementDate='2026-05-01';values.pic='Lee';values.department='Legal';
    const initial=await nda.create({fields:{...createEmptyFields(),...contractValuesToTracking(values),Status:'Pending'}});
    const created=initial.snapshot.records.find(item=>item.fields.Recipient===values.recipient.name)!;
    const linked=await nda.linkSupplier(created.id,{supplierId:source.id,expectedVersion:created.version});
    const record=linked.snapshot.records.find(item=>item.id===created.id)!;
    const draft=(await contracts.draftForRecord(record.id,{requestId:randomUUID()})).contract;
    expect(draft.supplierId).toBe(source.id);

    const template=(await pool.query("SELECT * FROM contract_template WHERE active=true AND document_type='nda' LIMIT 1")).rows[0];
    const docxId=randomUUID();const pdfId=randomUUID();const versionId=randomUUID();
    await pool.query(`INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
      VALUES($1,$3,'docx','classification.docx','application/octet-stream',$4,$6,now()),
            ($2,$3,'pdf','classification.pdf','application/pdf',$5,$7,now())`,
    [docxId,pdfId,draft.id,Buffer.from('docx'),Buffer.from('%PDF-test'),randomUUID(),randomUUID()]);
    await pool.query(`INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
      template_bytes,values_snapshot,supplier_id_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
    [versionId,draft.id,template.id,template.template_key,template.template_version,template.checksum,template.content,
      JSON.stringify(draft.values),source.id,docxId,pdfId]);
    const upload=await contracts.uploadSignedFile(draft.id,{requestId:randomUUID(),expectedVersion:draft.version,versionId,
      originalFileName:'signed.pdf',contentType:'application/pdf',content:Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF')});
    const assigned=await suppliers.assignItems(target.id,{
      agreements:[{id:record.id,expectedVersion:record.version}],
      documents:[{id:draft.id,expectedVersion:upload.contract.version}],
    });
    const assignedDocument=assigned.supplier.documents.find(item=>item.id===draft.id)!;
    const confirmed=await contracts.confirmSigned(draft.id,{requestId:randomUUID(),expectedVersion:assignedDocument.version,
      versionId,signedFileId:upload.signedFile.id,agreementDate:values.agreementDate,pic:values.pic});
    expect(confirmed.contract).toMatchObject({status:'signed',supplierId:target.id,linkedNdaId:record.id});
    expect((await contracts.getContract(draft.id)).supplierId).toBe(target.id);
    expect((await contracts.getContract(draft.id)).versions[0].supplierId).toBe(source.id);
  });
});
