import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import PizZip from 'pizzip';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { createFfmContractDefaults, templateData } from '../src/contract-core.js';
import { renderContractDocx } from './document-worker.js';
import { applyDocxEditor, inspectDocxTemplate, inspectPdfTemplate, normalizeFieldSchema, renderPdfTemplate, resolveTemplateFields, sourceChecksum } from './template-render.js';

function docx(xml: string): Buffer {
  const zip=new PizZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
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

  it('inserts and deletes top-level paragraphs while preserving source formatting and unrelated parts',()=>{
    const source=docx(documentXml([
      '<w:p w:rsidR="00112233"><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:tab/><w:t>Anchor</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Remove me</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Keep me</w:t></w:r></w:p>',
    ].join('')));
    const sourceZip=new PizZip(source);sourceZip.file('word/styles.xml','<styles>unchanged</styles>');const withStyles=sourceZip.generate({type:'nodebuffer'}) as Buffer;
    const snapshot=inspectDocxTemplate(withStyles);
    expect(snapshot.regions?.map(region=>region.structureEditable)).toEqual([true,true,true]);
    snapshot.wordOperations=[
      {id:'insert-1',type:'insert-paragraph',anchorId:'r-1',position:'after',text:'Inserted {project_name}'},
      {id:'delete-1',type:'delete-paragraph',targetId:'r-2'},
    ];
    const rendered=applyDocxEditor(withStyles,snapshot);const zip=new PizZip(rendered);const xml=zip.file('word/document.xml')!.asText();
    expect(zip.file('word/styles.xml')!.asText()).toBe('<styles>unchanged</styles>');
    expect(xml).toContain('<w:spacing w:after="120"/>');expect(xml).toContain('<w:rPr><w:i/></w:rPr>');
    expect(xml.match(/<w:tab\/>/g)).toHaveLength(1);
    expect(xml.match(/w:rsidR="00112233"/g)).toHaveLength(1);expect(xml).not.toContain('Remove me');
    expect(inspectDocxTemplate(rendered).regions?.map(region=>region.text)).toEqual(['Anchor','Inserted {project_name}','Keep me']);
  });

  it('inserts and deletes simple table rows with matching cell formatting',()=>{
    const row=(left:string,right:string,extra='')=>`<w:tr ${extra}><w:trPr/><w:tc><w:tcPr><w:tcW w:w="1000"/></w:tcPr><w:p><w:pPr/><w:r><w:rPr><w:b/></w:rPr><w:t>${left}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr/><w:p><w:r><w:t>${right}</w:t></w:r></w:p></w:tc></w:tr>`;
    const source=docx(documentXml(`<w:tbl><w:tblPr/>${row('A1','A2','w:rsidR="ABC"')}${row('B1','B2')}</w:tbl>`));
    const snapshot=inspectDocxTemplate(source);
    expect(snapshot.wordStructure?.rows).toEqual([
      expect.objectContaining({id:'row-1',cellCount:2,regionIds:['r-1','r-2'],readOnly:false}),
      expect.objectContaining({id:'row-2',cellCount:2,regionIds:['r-3','r-4'],readOnly:false}),
    ]);
    expect(snapshot.regions?.slice(0,2).map(region=>region.cellIndex)).toEqual([0,1]);
    snapshot.wordOperations=[
      {id:'insert-row',type:'insert-table-row',anchorRowId:'row-1',position:'after',cells:['New left','New right']},
      {id:'delete-row',type:'delete-table-row',targetRowId:'row-2'},
    ];
    const rendered=applyDocxEditor(source,snapshot);const xml=new PizZip(rendered).file('word/document.xml')!.asText();
    expect(xml.match(/w:rsidR="ABC"/g)).toHaveLength(1);expect(xml).not.toContain('B1');expect(xml).not.toContain('B2');
    expect(xml.match(/<w:tcW w:w="1000"\/>/g)).toHaveLength(2);
    expect(inspectDocxTemplate(rendered).regions?.map(region=>region.text)).toEqual(['A1','A2','New left','New right']);
  });

  it('protects merged, nested and header rows and refuses deletion of the last editable row',()=>{
    const simple='<w:tr><w:tc><w:p><w:r><w:t>Only</w:t></w:r></w:p></w:tc></w:tr>';
    const source=docx(documentXml(`<w:tbl>${simple}<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Merged</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Outer</w:t></w:r></w:p><w:tbl>${simple}</w:tbl></w:tc></w:tr></w:tbl>`));
    const snapshot=inspectDocxTemplate(source);const rows=snapshot.wordStructure!.rows;
    expect(rows.find(row=>row.id==='row-1')?.readOnly).toBe(false);
    expect(rows.some(row=>row.isHeader&&row.readOnly)).toBe(true);
    expect(rows.some(row=>/Merged/.test(row.reason??''))).toBe(true);
    expect(rows.some(row=>/nested/i.test(row.reason??''))).toBe(true);
    snapshot.wordOperations=[{id:'delete-only',type:'delete-table-row',targetRowId:'row-1'}];
    expect(()=>applyDocxEditor(source,snapshot)).toThrow(/at least one editable table row/i);
  });

  it('protects section paragraphs and rows inside content controls',()=>{
    const row='<w:tr><w:tc><w:p><w:r><w:t>Controlled</w:t></w:r></w:p></w:tc></w:tr>';
    const source=docx(documentXml(`<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>Section</w:t></w:r></w:p><w:sdt><w:sdtContent><w:tbl>${row}</w:tbl></w:sdtContent></w:sdt>`));
    const snapshot=inspectDocxTemplate(source);
    expect(snapshot.regions?.[0]).toMatchObject({structureEditable:false});
    expect(snapshot.wordStructure?.rows[0]).toMatchObject({readOnly:true});
    expect(snapshot.wordStructure?.rows[0].reason).toMatch(/protected/i);
    snapshot.wordOperations=[{id:'unsafe',type:'insert-paragraph',anchorId:'r-1',position:'after',text:'No'}];
    expect(()=>applyDocxEditor(source,snapshot)).toThrow(/unavailable|protected/i);
  });

  it('preserves legacy r-N IDs around self-closing and nested textbox paragraphs',()=>{
    const selfClosing=docx(documentXml('<w:p><w:r><w:t>A</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>B</w:t></w:r></w:p><w:p><w:r><w:t>C</w:t></w:r></w:p>'));
    expect(inspectDocxTemplate(selfClosing).regions?.map(region=>[region.id,region.text])).toEqual([['r-1','A'],['r-2','B'],['r-3','C']]);

    const textbox=docx(documentXml('<w:p><w:r><w:txbxContent><w:p><w:r><w:t>Inner textbox</w:t></w:r></w:p></w:txbxContent></w:r></w:p><w:p><w:r><w:t>Body after</w:t></w:r></w:p>'));
    expect(inspectDocxTemplate(textbox).regions?.map(region=>({id:region.id,text:region.text,readOnly:region.readOnly}))).toEqual([
      {id:'r-1',text:'Inner textbox',readOnly:true},
      {id:'r-2',text:'Body after',readOnly:false},
    ]);
  });

  it('keeps comment ranges and revision property changes out of structural editing',()=>{
    const source=docx(documentXml([
      '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Commented text</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>',
      '<w:p><w:pPr><w:pPrChange w:id="2"><w:pPr/></w:pPrChange></w:pPr><w:r><w:t>Changed formatting</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:trPr><w:trPrChange w:id="3"><w:trPr/></w:trPrChange></w:trPr><w:tc><w:p><w:r><w:t>Changed row</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ].join('')));
    const snapshot=inspectDocxTemplate(source);
    expect(snapshot.regions?.[0]).toMatchObject({readOnly:false,structureEditable:false});
    expect(snapshot.regions?.[1]).toMatchObject({readOnly:false,structureEditable:false});
    expect(snapshot.wordStructure?.rows[0]).toMatchObject({readOnly:true});
    expect(snapshot.wordStructure?.rows[0].reason).toMatch(/protected/i);
    snapshot.wordOperations=[{id:'comment-delete',type:'delete-paragraph',targetId:'r-1'}];
    expect(()=>applyDocxEditor(source,snapshot)).toThrow(/unavailable|protected/i);
  });

  it('splices selections across styled runs without flattening surrounding OOXML',()=>{
    const source=docx(documentXml('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Pré selec</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>tion 😄 post</w:t></w:r></w:p>'));
    const snapshot=inspectDocxTemplate(source);
    snapshot.regions![0].text='Pré {supplier_name} & <合作> 😄 post';
    const edited=new PizZip(applyDocxEditor(source,snapshot)).file('word/document.xml')!.asText();
    expect(edited).toContain('<w:rPr><w:b/></w:rPr>');
    expect(edited).toContain('<w:rPr><w:i/></w:rPr>');
    expect(inspectDocxTemplate(docx(edited)).regions?.[0].text).toBe('Pré {supplier_name} & <合作> 😄 post');
    expect(edited).toContain('&amp; &lt;合作&gt;');
    expect(edited).toContain('😄 post');
  });

  it('keeps styled text between multiple disjoint replacements in one paragraph',()=>{
    const source=docx(documentXml('<w:p><w:r><w:t>A old </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>MIDDLE</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t> old Z</w:t></w:r></w:p>'));
    const snapshot=inspectDocxTemplate(source);
    snapshot.regions![0].text='A {project_name} MIDDLE {project_name} Z';
    snapshot.fields=normalizeFieldSchema([{key:'project_name',label:'Project',type:'text',appearance:{fontWeight:'bold'}}]);
    const edited=new PizZip(applyDocxEditor(source,snapshot)).file('word/document.xml')!.asText();
    expect(edited).toContain('<w:rPr><w:i/></w:rPr><w:t>MIDDLE</w:t>');
    expect(edited).toContain('<w:rPr><w:u w:val="single"/></w:rPr>');
    expect(edited.match(/\{project_name\}/g)).toHaveLength(2);
    expect(edited.match(/<w:b\/>/g)).toHaveLength(2);
  });

  it('reports overly complex edits instead of silently flattening mixed styles',()=>{
    const source=docx(documentXml(`<w:p><w:r><w:t>${'a'.repeat(3000)}</w:t></w:r></w:p>`));
    const snapshot=inspectDocxTemplate(source);snapshot.regions![0].text='b'.repeat(3000);
    expect(()=>applyDocxEditor(source,snapshot)).toThrow(/too many text changes/);
  });

  it('applies explicit bold and normal weight to every isolated field occurrence',()=>{
    const source=docx(documentXml([
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{project_name}</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Hello {recipient_name} world</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Again {recipient_name}.</w:t></w:r></w:p>',
    ].join('')));
    const snapshot=inspectDocxTemplate(source);
    snapshot.fields=normalizeFieldSchema([
      {key:'project_name',label:'Project',type:'text',appearance:{fontWeight:'normal'}},
      {key:'recipient_name',label:'Supplier',type:'text',appearance:{fontWeight:'bold'}},
    ]);
    const edited=new PizZip(applyDocxEditor(source,snapshot)).file('word/document.xml')!.asText();
    expect(edited).toContain('<w:b w:val="0"/><w:bCs w:val="0"/>');
    expect(edited.match(/<w:b\/>/g)).toHaveLength(2);
    expect(edited.match(/<w:bCs\/>/g)).toHaveLength(2);
    expect(edited).toContain('<w:t xml:space="preserve">Hello </w:t>');
    const values=createFfmContractDefaults();values.recipient.name='Rendered Supplier';
    const rendered=new PizZip(renderContractDocx(Buffer.from(applyDocxEditor(source,snapshot)),values)).file('word/document.xml')!.asText();
    expect(rendered).toContain('Rendered Supplier');
    expect(rendered.match(/<w:b\/>/g)).toHaveLength(2);
  });

  it('consolidates tags split across runs and text nodes before applying appearance',()=>{
    const source=docx(documentXml('<w:p><w:r><w:t>Before {rec</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>ipient</w:t><w:t>_name}</w:t></w:r><w:r><w:t> after</w:t></w:r></w:p>'));
    const snapshot=inspectDocxTemplate(source);
    snapshot.fields=normalizeFieldSchema([{key:'recipient_name',label:'Supplier',type:'text',appearance:{fontWeight:'bold'}}]);
    const edited=new PizZip(applyDocxEditor(source,snapshot)).file('word/document.xml')!.asText();
    const tagRuns=edited.split('</w:r>').filter(run=>run.includes('{recipient_name}'));
    expect(tagRuns).toHaveLength(1);expect(tagRuns[0]).toContain('<w:b/>');
    expect(edited).toContain('Before ');expect(edited).toContain(' after');
    expect(inspectDocxTemplate(docx(edited)).regions?.[0].text).toBe('Before {recipient_name} after');
  });

  it('marks Word fields and drawings read-only and rejects entity declarations',()=>{
    const protectedDoc=docx(documentXml('<w:p><w:r><w:instrText> PAGE </w:instrText><w:t>1</w:t></w:r></w:p><w:p><w:r><w:drawing/><w:t>Image</w:t></w:r></w:p>'));
    expect(inspectDocxTemplate(protectedDoc).regions?.every((region)=>region.readOnly)).toBe(true);
    expect(()=>inspectDocxTemplate(docx(`<!DOCTYPE x [<!ENTITY y "z">]>${documentXml('<w:p><w:r><w:t>&y;</w:t></w:r></w:p>')}`))).toThrow(/DTD|entity/i);
  });

  it('leaves bookmark-protected paragraphs byte-for-byte unchanged',()=>{
    const paragraph='<w:p><w:bookmarkStart w:id="0" w:name="anchor"/><w:r><w:t>Protected</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>';
    const source=docx(documentXml(paragraph));
    const snapshot=inspectDocxTemplate(source);
    expect(snapshot.regions![0].readOnly).toBe(true);
    snapshot.regions![0].text='Attempted change';
    snapshot.fields=normalizeFieldSchema([{key:'protected',label:'Protected',type:'text',appearance:{fontWeight:'bold'}}]);
    const edited=new PizZip(applyDocxEditor(source,snapshot)).file('word/document.xml')!.asText();
    expect(edited).toContain(paragraph);
    expect(edited).not.toContain('Attempted change');
  });

  it('keeps supplier identifiers out of template fields',()=>{
    expect(()=>normalizeFieldSchema([{key:'supplier_code',label:'Supplier ID',type:'text'}])).toThrow(/dashboard-only/i);
    expect(()=>normalizeFieldSchema([{key:'internal',label:'Internal',type:'text',source:'supplierId'}])).toThrow(/dashboard-only/i);
    expect(()=>normalizeFieldSchema([{key:'name',label:'Name',type:'text',appearance:{fontWeight:'heavy'}}])).toThrow(/font weight/i);
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

  it('maps bold PDF fields to bold standard-font variants',async()=>{
    const pdf=await PDFDocument.create();pdf.addPage([300,200]);
    const source=Buffer.from(await pdf.save({useObjectStreams:false}));
    const fields=normalizeFieldSchema([{key:'label',label:'Label',type:'text',appearance:{fontWeight:'bold'}}]);
    const output=await renderPdfTemplate(source,{format:'pdf',fields,placements:[{field:'label',page:1,x:10,y:10,width:100,height:20,fontSize:10,font:'times',align:'left'}]},{label:'Visible'});
    expect(output.toString('latin1')).toContain('/BaseFont /Times-Bold');
  });

  it('detects uppercase placeholders and handles empty self-closing run properties',()=>{
    const source=docx(documentXml('<w:p><w:r><w:rPr/><w:t>{Recipient_Name}</w:t></w:r></w:p>'));
    const snapshot=inspectDocxTemplate(source);expect(snapshot.fields.map(field=>field.key)).toContain('Recipient_Name');
    snapshot.fields=normalizeFieldSchema([{key:'Recipient_Name',label:'Supplier',type:'text',appearance:{fontWeight:'bold'}}]);
    const xml=new PizZip(applyDocxEditor(source,snapshot)).file('word/document.xml')!.asText();
    expect(xml).toContain('<w:rPr><w:b/><w:bCs/></w:rPr>');
  });

  it.skipIf(!existsSync('C:/Windows/Fonts/times.ttf'))('keeps a Unicode font for bold PDF fields',async()=>{
    const original=process.env.NDA_DOCUMENT_FONT_PATH;const originalBold=process.env.NDA_DOCUMENT_BOLD_FONT_PATH;
    try{
      process.env.NDA_DOCUMENT_FONT_PATH='C:/Windows/Fonts/times.ttf';
      process.env.NDA_DOCUMENT_BOLD_FONT_PATH='C:/missing-bold-font.ttf';
      const pdf=await PDFDocument.create();pdf.addPage([300,200]);
      const fields=normalizeFieldSchema([{key:'label',label:'Label',type:'text',appearance:{fontWeight:'bold'}}]);
      const output=await renderPdfTemplate(Buffer.from(await pdf.save({useObjectStreams:false})),{format:'pdf',fields,placements:[{field:'label',page:1,x:10,y:10,width:200,height:30,fontSize:10,font:'times'}]},{label:'供应商'});
      expect(output.toString('latin1')).toContain('/Identity-H');
    }finally{
      if(original===undefined)delete process.env.NDA_DOCUMENT_FONT_PATH;else process.env.NDA_DOCUMENT_FONT_PATH=original;
      if(originalBold===undefined)delete process.env.NDA_DOCUMENT_BOLD_FONT_PATH;else process.env.NDA_DOCUMENT_BOLD_FONT_PATH=originalBold;
    }
  });

  it('ships EOI 1.1 as an additive bold-field asset without changing 1.0 text',async()=>{
    const definitions=JSON.parse(await readFile('templates/eoi-template-map.json','utf8')) as any[];
    const old=await readFile('templates/ffm-eoi-v1.docx');const next=await readFile('templates/ffm-eoi-v1.1.docx');
    expect(sourceChecksum(old)).toBe('b7e7ab1a130d755e2856a11f4882aafbe0a6082a76465675e6e6c09de4939eb4');
    expect(inspectDocxTemplate(next).regions?.map(region=>region.text).filter(text=>text.trim())).toEqual(inspectDocxTemplate(old).regions?.map(region=>region.text).filter(text=>text.trim()));
    expect(definitions.find(item=>item.version==='1.0')?.fileName).toBe('ffm-eoi-v1.docx');
    expect(definitions.find(item=>item.version==='1.1')?.fields.filter((field:any)=>field.appearance?.fontWeight==='bold').map((field:any)=>field.key)).toEqual(['recipient_name','project_name']);
    const xml=new PizZip(next).file('word/document.xml')!.asText();const runs=xml.split('</w:r>');
    for(const key of ['recipient_name','project_name']){
      const matches=runs.filter(run=>run.includes(`{${key}}`));
      expect(matches.length).toBeGreaterThan(0);expect(matches.every(run=>run.includes('<w:b/>'))).toBe(true);
    }
  });

  it('rejects PDF action dictionaries even when PDF loading succeeds',async()=>{
    const pdf=await PDFDocument.create();pdf.addPage();pdf.catalog.set(PDFName.of('OpenAction'),pdf.context.obj({S:PDFName.of('JavaScript'),JS:'alert(1)'}));
    await expect(inspectPdfTemplate(Buffer.from(await pdf.save({useObjectStreams:true})))).rejects.toThrow(/scripts|actions/i);
  });
});
