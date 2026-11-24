import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { PDFDocument } from 'pdf-lib';
import type { Pool } from './db.js';
import { applyDocxEditor, inspectDocxTemplate, sourceChecksum } from './template-render.js';
import { sqliteTestPool } from './sqlite-test-helper.js';
import { PgTemplateStore } from './template-store.js';

function docx(text: string): Buffer {
  const zip=new PizZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  return zip.generate({type:'nodebuffer'});
}

function docxBody(body:string):Buffer{
  const zip=new PizZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  return zip.generate({type:'nodebuffer'});
}

describe('template version and draft reset store',()=>{
  let pool:Pool; let cleanup:()=>Promise<void>; let store:PgTemplateStore;
  const familyId=randomUUID(); const oldId=randomUUID(); const currentId=randomUUID(); const draftId=randomUUID();
  const oldContent=docx('Published {recipient_name}'); const currentContent=docx('Current {recipient_name}');
  const fields=[{key:'recipient_name',label:'Supplier company',type:'text',required:true,source:'recipient_name',appearance:{fontWeight:'bold'}}];

  beforeAll(async()=>{
    ({pool,cleanup}=await sqliteTestPool('template-store'));
    store=new PgTemplateStore(pool);
    await pool.query(`INSERT INTO template_family(id,family_key,name,document_type,template_format,active,created_at,updated_at)
      VALUES($1,'test-family','Test family','eoi','docx',1,now(),now())`,[familyId]);
    const oldSnapshot=inspectDocxTemplate(oldContent);oldSnapshot.fields=fields as any;
    const currentSnapshot=inspectDocxTemplate(currentContent);currentSnapshot.fields=fields as any;
    for(const [id,version,content,active,snapshot] of [[oldId,'1.0',oldContent,0,oldSnapshot],[currentId,'1.1',currentContent,1,currentSnapshot]] as const){
      await pool.query(`INSERT INTO contract_template(id,template_key,template_version,name,file_name,mime_type,content,checksum,tags,active,
        family_id,document_type,template_format,field_schema,editor_snapshot,created_at)
        VALUES($1,'legacy-template-key',$2,$3,$4,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',$5,$6,$7,$8,$9,'eoi','docx',$10,$11,now())`,
      [id,version,`Version ${version}`,`test-${version}.docx`,content,sourceChecksum(content),JSON.stringify(['recipient_name']),active,familyId,JSON.stringify(fields),JSON.stringify(snapshot)]);
    }
    await pool.query('UPDATE template_family SET published_template_id=$2 WHERE id=$1',[familyId,currentId]);
    const stale=inspectDocxTemplate(docx('Unpublished work {recipient_name}'));stale.fields=fields as any;
    stale.regions![0].text='Stale editor region {recipient_name}';
    await pool.query(`INSERT INTO template_draft(id,family_id,version,name,file_name,source_content,source_checksum,editor_snapshot,created_at,updated_at)
      VALUES($1,$2,4,'Unpublished work','draft.docx',$3,$4,$5,now(),now())`,
    [draftId,familyId,docx('Unpublished work {recipient_name}'),sourceChecksum(docx('Unpublished work {recipient_name}')),JSON.stringify(stale)]);
  });

  afterAll(async()=>cleanup?.());

  it('lists inactive same-family versions and returns immutable published source',async()=>{
    const versions=await store.listPublishedVersions(familyId);
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({id:oldId,version:'1.0',active:false}),
      expect.objectContaining({id:currentId,version:'1.1',active:true}),
    ]));
    const source=await store.sourcePublished(oldId);
    expect(source.content.equals(oldContent)).toBe(true);
    expect(source).toMatchObject({fileName:'test-1.0.docx',format:'docx'});
  });

  it('guards replacement, enforces optimistic versions, and replays one reset exactly once',async()=>{
    await expect(store.resetDraftFromPublished(familyId,{templateId:oldId,expectedVersion:4,requestId:randomUUID()}))
      .rejects.toMatchObject({status:409,code:'template_draft_replace_confirmation_required'});
    await expect(store.resetDraftFromPublished(familyId,{templateId:oldId,expectedVersion:3,requestId:randomUUID(),confirmReplace:true}))
      .rejects.toMatchObject({status:409,code:'version_conflict'});

    const requestId=randomUUID();
    const input={templateId:oldId,expectedVersion:4,requestId,confirmReplace:true};
    const first=await store.resetDraftFromPublished(familyId,input);
    const replay=await store.resetDraftFromPublished(familyId,input);
    expect(replay).toEqual(first);
    expect(first.draft).toMatchObject({id:draftId,version:5,name:'Version 1.0'});
    expect(first.draft.editorSnapshot.regions?.[0].text).toBe('Published {recipient_name}');
    expect(first.draft.editorSnapshot.fields).toEqual(fields);
    const rendered=applyDocxEditor((await store.sourceDraft(draftId)).content,first.draft.editorSnapshot);
    expect(inspectDocxTemplate(rendered).regions?.[0].text).toBe('Published {recipient_name}');
    await expect(store.resetDraftFromPublished(familyId,{...input,templateId:currentId}))
      .rejects.toMatchObject({status:409,code:'request_id_conflict'});
  });

  it('keeps publish idempotent and reports duplicate version conflicts',async()=>{
    await pool.query('UPDATE template_draft SET preview_version=version,preview_checksum=$2 WHERE id=$1',[draftId,'preview']);
    const requestId=randomUUID();
    const input={requestId,expectedVersion:5,version:'2.0',name:'Published two'};
    const first=await store.publishDraft(draftId,input);
    expect(await store.publishDraft(draftId,input)).toEqual(first);
    await expect(store.publishDraft(draftId,{...input,requestId:randomUUID()}))
      .rejects.toMatchObject({status:409,code:'template_version_conflict'});
    expect((await store.sourcePublished(oldId)).content.equals(oldContent)).toBe(true);
  });

  it('creates a missing PDF draft from source bytes while retaining saved placements',async()=>{
    const pdfFamilyId=randomUUID();const pdfTemplateId=randomUUID();
    const pdf=await PDFDocument.create();pdf.addPage([300,200]);const content=Buffer.from(await pdf.save({useObjectStreams:false}));
    const pdfFields=[{key:'label',label:'Label',type:'text',required:false,source:'label',appearance:{fontWeight:'bold'}}];
    const placements=[{field:'label',page:1,x:10,y:10,width:100,height:20,fontSize:10,font:'times',align:'left'}];
    await pool.query(`INSERT INTO template_family(id,family_key,name,document_type,template_format,active,created_at,updated_at)
      VALUES($1,'pdf-family','PDF family','nda','pdf',1,now(),now())`,[pdfFamilyId]);
    await pool.query(`INSERT INTO contract_template(id,template_key,template_version,name,file_name,mime_type,content,checksum,tags,active,
      family_id,document_type,template_format,field_schema,editor_snapshot,created_at)
      VALUES($1,'pdf-family','1.0','PDF one','one.pdf','application/pdf',$2,$3,$4,1,$5,'nda','pdf',$6,$7,now())`,
    [pdfTemplateId,content,sourceChecksum(content),JSON.stringify(['label']),pdfFamilyId,JSON.stringify(pdfFields),JSON.stringify({format:'pdf',fields:pdfFields,placements})]);
    await pool.query('UPDATE template_family SET published_template_id=$2 WHERE id=$1',[pdfFamilyId,pdfTemplateId]);
    const resetInput={templateId:pdfTemplateId,expectedVersion:null,requestId:randomUUID()};
    const result=await store.resetDraftFromPublished(pdfFamilyId,resetInput);
    expect(result.draft).toMatchObject({version:1,format:'pdf',editorSnapshot:{fields:pdfFields,placements}});
    expect((await store.sourceDraft(result.draft.id)).content.equals(content)).toBe(true);
    const updated=await store.updateDraft(result.draft.id,{expectedVersion:1,name:'Edited PDF draft',editorSnapshot:result.draft.editorSnapshot});
    expect(updated.draft.version).toBe(2);
    expect(await store.resetDraftFromPublished(pdfFamilyId,resetInput)).toEqual(result);
    await expect(store.previewDraft(result.draft.id,{expectedVersion:1})).rejects.toMatchObject({status:409,code:'version_conflict'});
    expect((await store.previewDraft(result.draft.id,{expectedVersion:2})).content.subarray(0,5).toString()).toBe('%PDF-');
    const preview=await store.previewPublished(pdfTemplateId,{});
    expect(preview.content.subarray(0,5).toString()).toBe('%PDF-');
    expect(preview.fileName).toBe('PDF-one-1.0-preview.pdf');
  });

  it('recovers legacy Word field definitions when the published schema is empty',async()=>{
    const legacyFamilyId=randomUUID();const legacyTemplateId=randomUUID();
    const content=docx('Legacy {recipient_name} and repeated {recipient_name} for {purpose}');
    await pool.query(`INSERT INTO template_family(id,family_key,name,document_type,template_format,active,created_at,updated_at)
      VALUES($1,'legacy-nda-fields','Legacy NDA','nda','docx',1,now(),now())`,[legacyFamilyId]);
    await pool.query(`INSERT INTO contract_template(id,template_key,template_version,name,file_name,mime_type,content,checksum,tags,active,
      family_id,document_type,template_format,field_schema,editor_snapshot,created_at)
      VALUES($1,'legacy-nda-fields','1','Legacy NDA','legacy.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        $2,$3,$4,1,$5,'nda','docx','[]',NULL,now())`,
    [legacyTemplateId,content,sourceChecksum(content),JSON.stringify(['recipient_name','purpose']),legacyFamilyId]);
    await pool.query('UPDATE template_family SET published_template_id=$2 WHERE id=$1',[legacyFamilyId,legacyTemplateId]);

    expect((await store.listPublishedVersions(legacyFamilyId))[0].fieldSchema.map(field=>field.key))
      .toEqual(['recipient_name','purpose']);
    const result=await store.resetDraftFromPublished(legacyFamilyId,{
      templateId:legacyTemplateId,expectedVersion:null,requestId:randomUUID(),
    });
    expect(result.draft.editorSnapshot.fields.map(field=>field.key)).toEqual(['recipient_name','purpose']);
    expect(result.draft.editorSnapshot.fields[0]).toMatchObject({
      key:'recipient_name',source:'recipient_name',type:'text',required:false,
    });
  });

  it('applies deterministic EOI placeholder recognition during import',async()=>{
    const imported=await store.importTemplate({
      requestId:randomUUID(),
      key:`eoi-import-${randomUUID()}`,
      name:'Imported EOI',
      documentType:'eoi',
      fileName:'imported-eoi.docx',
      contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content:docx('[Supplier name] is interested in [Project name].'),
    });
    expect(imported.draft.editorSnapshot.fields.map(field=>field.key)).toEqual(['recipient_name','project_name']);
    expect(imported.draft.editorSnapshot.regions?.[0].text).toBe('{recipient_name} is interested in {project_name}.');
  });

  it('normalizes structural changes against source and publishes a baked, rebased snapshot',async()=>{
    const row=(text:string)=>`<w:tr><w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc></w:tr>`;
    const content=docxBody(`<w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Remove</w:t></w:r></w:p><w:tbl>${row('Row one')}${row('Row two')}</w:tbl>`);
    const imported=await store.importTemplate({requestId:randomUUID(),key:`structure-${randomUUID()}`,name:'Structure template',documentType:'nda',fileName:'structure.docx',contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',content});
    const snapshot=imported.draft.editorSnapshot;
    await expect(store.updateDraft(imported.draft.id,{expectedVersion:1,name:'Structure template',editorSnapshot:{...snapshot,regions:[snapshot.regions![0],snapshot.regions![0],...snapshot.regions!.slice(2)]}}))
      .rejects.toMatchObject({status:400,code:'invalid_template_structure'});
    const edited={...structuredClone(snapshot),wordOperations:[
      {id:'insert-p',type:'insert-paragraph' as const,anchorId:'r-1',position:'after' as const,text:'Inserted'},
      {id:'delete-p',type:'delete-paragraph' as const,targetId:'r-2'},
      {id:'insert-row',type:'insert-table-row' as const,anchorRowId:'row-1',position:'after' as const,cells:['New row']},
      {id:'delete-row',type:'delete-table-row' as const,targetRowId:'row-2'},
    ]};
    edited.regions![1].text='Edited before paragraph deletion';
    edited.regions![3].text='Edited before row deletion';
    const saved=await store.updateDraft(imported.draft.id,{expectedVersion:1,name:'Structure template',editorSnapshot:edited});
    expect(saved.draft.editorSnapshot.wordOperations).toHaveLength(4);
    await pool.query('UPDATE template_draft SET preview_version=version,preview_checksum=$2 WHERE id=$1',[imported.draft.id,'preview']);
    const published=(await store.publishDraft(imported.draft.id,{requestId:randomUUID(),expectedVersion:2,version:'1.0',name:'Structure template'})).template;
    expect(published.editorSnapshot?.wordOperations).toEqual([]);
    const publishedSource=(await store.sourcePublished(published.id)).content;
    expect(inspectDocxTemplate(publishedSource).regions?.map(region=>region.text)).toEqual(['First','Inserted','Row one','New row']);
    expect((await store.sourceDraft(imported.draft.id)).content.equals(content)).toBe(true);
    const reset=await store.resetDraftFromPublished(imported.family.id,{templateId:published.id,expectedVersion:2,requestId:randomUUID(),confirmReplace:true});
    expect(reset.draft.editorSnapshot.wordOperations).toEqual([]);
    expect(reset.draft.editorSnapshot.regions?.map(region=>region.text)).toEqual(['First','Inserted','Row one','New row']);
  });

  it('hydrates legacy saved r-N edits without shifting across self-closing paragraphs',async()=>{
    const content=docxBody('<w:p><w:r><w:t>A</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>B</w:t></w:r></w:p><w:p><w:r><w:t>C</w:t></w:r></w:p>');
    const imported=await store.importTemplate({requestId:randomUUID(),key:`legacy-regions-${randomUUID()}`,name:'Legacy region IDs',documentType:'nda',fileName:'legacy-regions.docx',contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',content});
    const legacySnapshot={format:'docx',fields:[],regions:[
      {id:'r-1',kind:'paragraph',text:'A',readOnly:false},
      {id:'r-2',kind:'paragraph',text:'Saved B edit',readOnly:false},
      {id:'r-3',kind:'paragraph',text:'Saved C edit',readOnly:false},
    ],warnings:[]};
    await pool.query('UPDATE template_draft SET editor_snapshot=$2 WHERE id=$1',[imported.draft.id,JSON.stringify(legacySnapshot)]);
    const hydrated=(await store.listDrafts()).find(draft=>draft.id===imported.draft.id)!;
    expect(hydrated.editorSnapshot.regions?.map(region=>[region.id,region.text])).toEqual([['r-1','A'],['r-2','Saved B edit'],['r-3','Saved C edit']]);
    const saved=await store.updateDraft(imported.draft.id,{expectedVersion:1,name:'Legacy region IDs',editorSnapshot:hydrated.editorSnapshot});
    expect(saved.draft.editorSnapshot.regions?.map(region=>region.text)).toEqual(['A','Saved B edit','Saved C edit']);
  });
});
