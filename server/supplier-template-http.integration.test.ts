import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import type { Pool } from './db';
import { sqliteTestPool } from './sqlite-test-helper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLUMNS, createEmptyFields } from '../src/core';
import { createFfmContractDefaults } from '../src/contract-core';
import { createHandler } from './app';


describe('supplier, project and template HTTP workflow',()=>{
  let cleanup:()=>Promise<void>;let pool:Pool;let server:ReturnType<typeof createServer>;let port:number;
  const allowedHosts=new Set<string>();
  const email={validateAutomaticSettings:async()=>undefined};

  beforeAll(async()=>{
    ({pool,cleanup}=await sqliteTestPool('nda-supplier-http'));
    server=createServer(createHandler(pool,{port:3000,publicDir:'missing',allowedHosts,bodyLimitBytes:10*1024*1024,
      backupStatusDir:'server/__missing_backup_status__',converterUrl:'http://127.0.0.1:1'},email as never));
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));port=(server.address() as AddressInfo).port;
    allowedHosts.add(`127.0.0.1:${port}`);
  });
  afterAll(async()=>{
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await cleanup?.();
  });

  async function json(path:string,method='GET',value?:unknown){
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:value===undefined?undefined:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
    return {status:response.status,body:await response.json() as any};
  }

  it('returns stable resource envelopes, enforces versions and links a record without changing the Excel fields',async()=>{
    const supplierResult=await json('/api/suppliers','POST',{requestId:randomUUID(),supplierCode:'0007-A',companyName:'Example Supplier',
      registrationNumber:'REG-7',address:'Supplier address',contact:{name:'Ann',designation:'Manager',address:'Contact address',email:'ann@example.com'}});
    expect(supplierResult).toMatchObject({status:201,body:{supplier:{supplierCode:'0007-A',companyName:'Example Supplier',version:1}}});
    const supplier=supplierResult.body.supplier;
    expect(await json('/api/suppliers')).toMatchObject({status:200,body:{suppliers:[{id:supplier.id}]}});
    const duplicate=await json('/api/suppliers','POST',{supplierCode:'0007-a',companyName:'Duplicate'});
    expect(duplicate).toMatchObject({status:409,body:{error:{code:'duplicate_code'}}});
    const conflict=await json(`/api/suppliers/${supplier.id}`,'PATCH',{...supplier,companyName:'Changed',expectedVersion:99});
    expect(conflict).toMatchObject({status:409,body:{error:{code:'version_conflict'}}});

    const projectResult=await json('/api/projects','POST',{requestId:randomUUID(),projectCode:'P-01',name:'Supplier evaluation',description:'Evaluation project'});
    expect(projectResult).toMatchObject({status:201,body:{project:{projectCode:'P-01',status:'active',version:1}}});
    expect(await json('/api/projects')).toMatchObject({status:200,body:{projects:[{id:projectResult.body.project.id}]}});

    const fields={...createEmptyFields(),Recipient:'Example Supplier','Date of Agreement':'2026-01-01',Duration:1,UOM:'Years',PIC:'Lee',Status:'Pending'};
    const created=await json('/api/records','POST',{fields});expect(created.status).toBe(200);
    const record=created.body.snapshot.records[0];
    const linked=await json(`/api/records/${record.id}/supplier`,'PATCH',{supplierId:supplier.id,expectedVersion:record.version});
    expect(linked).toMatchObject({status:200,body:{snapshot:{records:[{supplierId:supplier.id,supplierCode:'0007-A',version:2}]}}});
    expect(Object.keys(linked.body.snapshot.records[0].fields).sort()).toEqual([...COLUMNS].sort());
    expect(linked.body.snapshot.records[0].fields).not.toHaveProperty('Supplier ID');
    const detail=await json(`/api/suppliers/${supplier.id}`);
    expect(detail).toMatchObject({status:200,body:{supplier:{id:supplier.id,agreements:[{id:record.id}]}}});
  });

  it('classifies an explicitly reviewed agreement/document group and reports omitted related items',async()=>{
    const source=(await json('/api/suppliers','POST',{supplierCode:'CLASS-SOURCE',companyName:'Source Supplier'})).body.supplier;
    const target=(await json('/api/suppliers','POST',{supplierCode:'CLASS-TARGET',companyName:'Target Supplier'})).body.supplier;
    const fields={...createEmptyFields(),Recipient:'Classified Supplier','Date of Agreement':'2026-02-01',Duration:1,UOM:'Years',PIC:'Lee',Status:'Pending'};
    const created=await json('/api/records','POST',{fields});
    const record=created.body.snapshot.records.find((item:any)=>item.fields.Recipient==='Classified Supplier');
    const linked=await json(`/api/records/${record.id}/supplier`,'PATCH',{supplierId:source.id,expectedVersion:record.version});
    const linkedRecord=linked.body.snapshot.records.find((item:any)=>item.id===record.id);
    const drafted=await json(`/api/records/${record.id}/contract-draft`,'POST',{requestId:randomUUID()});
    const document=drafted.body.contract;

    const omitted=await json(`/api/suppliers/${target.id}/assignments`,'POST',{
      agreements:[],documents:[{id:document.id,expectedVersion:document.version}],
    });
    expect(omitted).toMatchObject({status:409,body:{error:{code:'related_items_required',details:{agreementIds:[record.id],documentIds:[]}}}});

    const assigned=await json(`/api/suppliers/${target.id}/assignments`,'POST',{
      agreements:[{id:record.id,expectedVersion:linkedRecord.version}],
      documents:[{id:document.id,expectedVersion:document.version}],
    });
    expect(assigned).toMatchObject({status:200,body:{agreementsChanged:1,documentsChanged:1,supplier:{id:target.id}}});
    expect(assigned.body.supplier.agreements).toEqual(expect.arrayContaining([
      expect.objectContaining({id:record.id,reference:expect.stringMatching(/^AGR-\d{6,}$/),version:linkedRecord.version+1}),
    ]));
    expect(assigned.body.supplier.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({id:document.id,reference:expect.stringMatching(/^DOC-\d{6,}$/),linkedNdaId:record.id,recipient:'Classified Supplier'}),
    ]));
  });

  it('imports a PDF template, serves immutable source bytes, and requires a current preview before publishing',async()=>{
    const pdf=await PDFDocument.create();pdf.addPage([595,842]);const bytes=Buffer.from(await pdf.save());
    const form=new FormData();form.set('requestId',randomUUID());form.set('key','supplier-eoi');form.set('name','Supplier EOI');form.set('documentType','eoi');
    form.set('file',new Blob([bytes],{type:'application/pdf'}),'supplier-eoi.pdf');
    const importedResponse=await fetch(`http://127.0.0.1:${port}/api/contract-templates/import`,{method:'POST',body:form});
    expect(importedResponse.status).toBe(201);const imported=await importedResponse.json() as any;
    expect(imported).toMatchObject({family:{key:'supplier-eoi',documentType:'eoi',format:'pdf'},draft:{version:1,format:'pdf'}});
    const draft=imported.draft;

    const source=await fetch(`http://127.0.0.1:${port}/api/contract-template-drafts/${draft.id}/source`);
    expect(source.status).toBe(200);expect(Buffer.compare(Buffer.from(await source.arrayBuffer()),bytes)).toBe(0);
    const requestId=randomUUID();
    const blocked=await json(`/api/contract-template-drafts/${draft.id}/publish`,'POST',{requestId,expectedVersion:1,version:'1.0'});
    expect(blocked).toMatchObject({status:409,body:{error:{code:'template_preview_required'}}});

    const preview=await fetch(`http://127.0.0.1:${port}/api/contract-template-drafts/${draft.id}/preview`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({values:createFfmContractDefaults(),customValues:{}}),
    });
    expect(preview.status).toBe(200);expect(preview.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await preview.arrayBuffer()).subarray(0,5).toString()).toBe('%PDF-');
    const published=await json(`/api/contract-template-drafts/${draft.id}/publish`,'POST',{requestId:randomUUID(),expectedVersion:1,version:'1.0'});
    expect(published).toMatchObject({status:201,body:{template:{key:'supplier-eoi',version:'1.0',documentType:'eoi',format:'pdf'}}});
    const stale=await json(`/api/contract-template-drafts/${draft.id}`,'PATCH',{expectedVersion:99,name:'Changed',editorSnapshot:draft.editorSnapshot});
    expect(stale).toMatchObject({status:409,body:{error:{code:'version_conflict'}}});
  });
});
