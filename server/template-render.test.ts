import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { createFfmContractDefaults, templateData } from '../src/contract-core.js';
import { applyDocxEditor, inspectDocxTemplate, inspectPdfTemplate, normalizeFieldSchema, renderPdfTemplate, resolveTemplateFields } from './template-render.js';

function docx(xml: string): Buffer {
  const zip=new PizZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml',xml);
  return zip.generate({type:'nodebuffer'});
}

const documentXml=(body:string)=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;

describe('managed template rendering',()=>{
  it('validates calendar dates and formats custom date aliases in English',()=>{
    const fields=normalizeFieldSchema([{key:'signed_on',source:'custom_date',label:'Signature date',type:'date'}]);
    expect(resolveTemplateFields(createFfmContractDefaults(),{custom_date:'2026-11-17'},fields).signed_on).toBe('17 November 2026');
    expect(()=>resolveTemplateFields(createFfmContractDefaults(),{custom_date:'2026-02-30'},fields)).toThrow(/valid date/);
    expect(()=>resolveTemplateFields(createFfmContractDefaults(),{custom_date:'30 February 2026'},fields)).toThrow(/valid date/);
  });
  it('preserves unchanged Word runs and only rewrites the edited region',()=>{
    const source=docx(documentXml('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>'));
    const snapshot=inspectDocxTemplate(source);
    const unchanged=new PizZip(applyDocxEditor(source,snapshot)).file('word/document.xml')!.asText();
    expect(unchanged).toContain('<w:t>Hello </w:t>');
    expect(unchanged).toContain('<w:t>world</w:t>');
    snapshot.regions![1].text='Changed {project_name}';
    const edited=new PizZip(applyDocxEditor(source,snapshot)).file('word/document.xml')!.asText();
    expect(edited).toContain('<w:t>Hello </w:t>');
    expect(edited).toContain('Changed {project_name}');
  });

  it('marks Word fields and drawings read-only and rejects entity declarations',()=>{
    const protectedDoc=docx(documentXml('<w:p><w:r><w:instrText> PAGE </w:instrText><w:t>1</w:t></w:r></w:p><w:p><w:r><w:drawing/><w:t>Image</w:t></w:r></w:p>'));
    expect(inspectDocxTemplate(protectedDoc).regions?.every((region)=>region.readOnly)).toBe(true);
    expect(()=>inspectDocxTemplate(docx(`<!DOCTYPE x [<!ENTITY y "z">]>${documentXml('<w:p><w:r><w:t>&y;</w:t></w:r></w:p>')}`))).toThrow(/DTD|entity/i);
  });

  it('keeps supplier identifiers out of template fields',()=>{
    expect(()=>normalizeFieldSchema([{key:'supplier_code',label:'Supplier ID',type:'text'}])).toThrow(/dashboard-only/i);
    expect(()=>normalizeFieldSchema([{key:'internal',label:'Internal',type:'text',source:'supplierId'}])).toThrow(/dashboard-only/i);
  });

  it('does not let custom fields override canonical agreement values',()=>{
    const values=createFfmContractDefaults(); values.recipient.name='Authoritative Supplier';
    expect(templateData(values,{recipient_name:'Wrong Supplier',project_name:'Project Cedar'})).toMatchObject({recipient_name:'Authoritative Supplier',project_name:'Project Cedar'});
  });

  it('renders placements on rotated PDF pages and reports their visual page sizes',async()=>{
    const pdf=await PDFDocument.create();
    for(const rotation of [0,90,180,270]){const page=pdf.addPage([300,200]);page.setRotation(degrees(rotation));}
    const source=Buffer.from(await pdf.save({useObjectStreams:false}));
    const inspected=await inspectPdfTemplate(source);
    expect(inspected.pages?.map((page)=>[page.width,page.height,page.rotation])).toEqual([[300,200,0],[200,300,90],[300,200,180],[200,300,270]]);
    const fields=[{key:'label',label:'Label',type:'text' as const,required:true,source:'label'}];
    const output=await renderPdfTemplate(source,{format:'pdf',fields,placements:[0,90,180,270].map((_rotation,index)=>({field:'label',page:index+1,x:10,y:10,width:100,height:20,fontSize:10,align:'left'}))},{label:'Visible'});
    expect(output.subarray(0,5).toString()).toBe('%PDF-');
  });

  it('rejects PDF action dictionaries even when PDF loading succeeds',async()=>{
    const pdf=await PDFDocument.create();pdf.addPage();pdf.catalog.set(PDFName.of('OpenAction'),pdf.context.obj({S:PDFName.of('JavaScript'),JS:'alert(1)'}));
    await expect(inspectPdfTemplate(Buffer.from(await pdf.save({useObjectStreams:true})))).rejects.toThrow(/scripts|actions/i);
  });
});
