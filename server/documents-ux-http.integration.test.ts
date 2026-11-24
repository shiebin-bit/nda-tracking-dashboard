import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import {sqliteTestPool} from './sqlite-test-helper';
import type {Pool} from './db';
import {createHandler} from './app';
import {DocumentWorker} from './document-worker';
import {createFfmContractDefaults} from '../src/contract-core';

describe('document settings and template version HTTP integration',()=>{
  let pool:Pool,cleanup:()=>Promise<void>,server:ReturnType<typeof createServer>,origin:string;
  beforeAll(async()=>{({pool,cleanup}=await sqliteTestPool('nda-documents-ux'));const allowedHosts=new Set<string>();server=createServer(createHandler(pool,{port:3000,publicDir:'missing',allowedHosts,bodyLimitBytes:10*1024*1024,converterUrl:'http://127.0.0.1:1'}, {validateAutomaticSettings:async()=>{throw new Error('Naming changes must not validate or change mail.');}} as never));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;allowedHosts.add(new URL(origin).host);});
  afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await cleanup?.();});
  const json=async(path:string,body?:unknown,method=body?'POST':'GET')=>{const response=await fetch(origin+'/api'+path,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json() as any};};
  it('stores ordered naming settings independently and rejects stale or duplicate fields',async()=>{
    const before=(await json('/state')).body;
    const original=await json('/document-settings');expect(original.status).toBe(200);
    const update=await json('/document-settings',{expectedRevision:original.body.revision,settings:{filenameFields:['supplier','type','date']}},'PUT');expect(update).toMatchObject({status:200,body:{settings:{filenameFields:['supplier','type','date']}}});
    expect((await json('/document-settings',{expectedRevision:original.body.revision,settings:{filenameFields:[]}},'PUT')).status).toBe(409);
    expect((await json('/document-settings',{expectedRevision:update.body.revision,settings:{filenameFields:['supplier','supplier']}},'PUT')).status).toBe(400);
    expect((await json('/state')).body).toEqual(before);
  });
  it('copies a published PDF version safely, keeps old bytes and names real downloads from frozen version data',async()=>{
    const pdf=await PDFDocument.create();pdf.addPage([595,842]);const bytes=await pdf.save();
    const form=new FormData();form.set('requestId',randomUUID());form.set('key','ux-eoi');form.set('name','UX EOI');form.set('documentType','eoi');form.set('file',new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),'ux-eoi.pdf');
    const imported=await fetch(origin+'/api/contract-templates/import',{method:'POST',body:form});expect(imported.status).toBe(201);const {family,draft:initial}=await imported.json() as any;
    const editorSnapshot={...initial.editorSnapshot,fields:[{key:'supplier',label:'Supplier',type:'text',required:true,source:'project_name',appearance:{fontWeight:'bold'}}],placements:[{field:'supplier',page:1,x:30,y:760,width:400,height:24,fontSize:11,align:'left'}]};
    const saved=await json('/contract-template-drafts/'+initial.id,{expectedVersion:initial.version,editorSnapshot},'PATCH');expect(saved.status).toBe(200);const draft=saved.body.draft;
    const preview=await fetch(origin+`/api/contract-template-drafts/${draft.id}/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:draft.version})});expect(preview.status).toBe(200);
    const published=await json(`/contract-template-drafts/${draft.id}/publish`,{requestId:randomUUID(),expectedVersion:draft.version,version:'1.0'});expect(published.status).toBe(201);const template=published.body.template;
    const oldSource=await fetch(origin+`/api/contract-templates/${template.id}/source`);expect(Buffer.from(await oldSource.arrayBuffer())).toEqual(Buffer.from(bytes));
    const denied=await json(`/contract-templates/families/${family.id}/draft`,{requestId:randomUUID(),templateId:template.id,expectedVersion:draft.version});expect(denied.status).toBe(409);
    const input={requestId:randomUUID(),templateId:template.id,expectedVersion:draft.version,confirmReplace:true};const copied=await json(`/contract-templates/families/${family.id}/draft`,input);expect(copied.status).toBe(201);expect(copied.body.draft.editorSnapshot.placements).toEqual(draft.editorSnapshot.placements);
    expect(await json(`/contract-templates/families/${family.id}/draft`,input)).toEqual(copied);
    const current=copied.body.draft;
    const publishedPreview=await fetch(origin+`/api/contract-templates/${template.id}/preview`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});expect(publishedPreview.status).toBe(200);
    expect((await json(`/contract-template-drafts/${current.id}/publish`,{requestId:randomUUID(),expectedVersion:current.version,version:'1.1'})).status).toBe(409);
    expect((await json(`/contract-templates/families/${family.id}/versions`)).body.templates.map((t:any)=>t.id)).toEqual([template.id]);
    const supplier=(await json('/suppliers',{supplierCode:'0001-UX',companyName:'供应商 Example'})).body.supplier;
    const project=(await json('/projects',{projectCode:'P-UX',name:'Original project',description:''})).body.project;
    const values=createFfmContractDefaults();values.recipient.name='供应商 Example';
    const contract=(await json('/contracts',{requestId:randomUUID(),values,documentType:'eoi',supplierId:supplier.id,projectId:project.id,templateFamilyId:family.id,customValues:{}})).body.contract;
    const generated=await json(`/contracts/${contract.id}/generations`,{requestId:randomUUID(),expectedVersion:contract.version});expect(generated.status).toBe(202);
    const worker=new DocumentWorker(pool,'http://127.0.0.1:1',10,10);
    try{await worker.start();await expect.poll(async()=>{const job=(await pool.query('SELECT status FROM document_job WHERE id=$1',[generated.body.job.id])).rows[0];return job.status;},{timeout:5000}).toBe('complete');}finally{await worker.stop();}
    const detail=(await json('/contracts/'+contract.id)).body.contract;const version=detail.versions[0];
    const url=`/api/document-artifacts/${version.pdfArtifactId}/content?download=1&versionId=${version.id}`;
    const download=await fetch(origin+url);expect(download.status).toBe(200);expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''");expect(decodeURIComponent(download.headers.get('content-disposition')!)).toContain('供应商 Example_EOI_');expect(decodeURIComponent(download.headers.get('content-disposition')!)).toContain(contract.reference);expect(Buffer.from(await download.arrayBuffer()).subarray(0,5).toString()).toBe('%PDF-');
    expect((await fetch(origin+url.replace(version.id,randomUUID()))).status).toBe(404);
    expect((await pool.query('SELECT count(*) count FROM nda_record')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT count(*) count FROM email_delivery')).rows[0].count).toBe(0);
  });
});
