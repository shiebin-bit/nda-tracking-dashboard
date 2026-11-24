import { readFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import PizZip from 'pizzip';
import type {
  ContractValues,
  PdfFieldPlacement,
  TemplateEditorSnapshot,
  TemplateFieldDefinition,
  TemplateRegion,
  WordStructureOperation,
  WordTableRow,
} from '../src/contract-types.js';
import { englishDate, normalizeCustomValues, templateData } from '../src/contract-core.js';
import { isValidIsoDate } from '../src/core.js';
import { badRequest } from './errors.js';

export const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_PARTS = 2_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_TYPE = 'application/pdf';

export const TEMPLATE_CONTENT_TYPES = { docx: DOCX_TYPE, pdf: PDF_TYPE } as const;

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlUnescape(value: string): string {
  return value.replace(/&#x([0-9a-f]+);/gi, (_match, digits) => String.fromCodePoint(Number.parseInt(digits,16)))
    .replace(/&#([0-9]+);/g, (_match, digits) => String.fromCodePoint(Number.parseInt(digits,10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function textOfXml(xml: string): string {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => xmlUnescape(match[1])).join('');
}

interface TextReplacement { start: number; end: number; text: string[] }

function textReplacements(original: string[], replacement: string[]): TextReplacement[] {
  let prefix=0;
  while(prefix<original.length&&prefix<replacement.length&&original[prefix]===replacement[prefix]) prefix+=1;
  let suffix=0;
  while(suffix<original.length-prefix&&suffix<replacement.length-prefix
    &&original[original.length-1-suffix]===replacement[replacement.length-1-suffix]) suffix+=1;
  const before=original.slice(prefix,original.length-suffix);const after=replacement.slice(prefix,replacement.length-suffix);
  if(!before.length&&!after.length) return [];
  // A bounded LCS keeps multiple edits distinct without allowing a very large
  // paragraph replacement to allocate an unbounded dynamic-programming table.
  const columns=after.length+1;
  if(before.length*after.length>4_000_000) throw badRequest('This paragraph has too many text changes to preserve its formatting safely. Save fewer changes at a time, or edit this paragraph in Word before importing it.', 'template_edit_too_complex');
  const lcs=new Uint16Array((before.length+1)*columns);
  for(let oldIndex=before.length-1;oldIndex>=0;oldIndex-=1){
    for(let newIndex=after.length-1;newIndex>=0;newIndex-=1){
      const index=oldIndex*columns+newIndex;
      lcs[index]=before[oldIndex]===after[newIndex]?lcs[(oldIndex+1)*columns+newIndex+1]+1
        :Math.max(lcs[(oldIndex+1)*columns+newIndex],lcs[index+1]);
    }
  }
  const changes:TextReplacement[]=[];let oldIndex=0;let newIndex=0;let active:TextReplacement|null=null;
  const flush=()=>{if(active){changes.push(active);active=null;}};
  while(oldIndex<before.length||newIndex<after.length){
    if(oldIndex<before.length&&newIndex<after.length&&before[oldIndex]===after[newIndex]){
      flush();oldIndex+=1;newIndex+=1;continue;
    }
    active??={start:prefix+oldIndex,end:prefix+oldIndex,text:[]};
    const insert=newIndex<after.length&&(oldIndex===before.length
      ||lcs[oldIndex*columns+newIndex+1]>=lcs[(oldIndex+1)*columns+newIndex]);
    if(insert){active.text.push(after[newIndex]);newIndex+=1;}
    else{oldIndex+=1;active.end=prefix+oldIndex;}
  }
  flush();return changes;
}

function replaceRegionText(xml: string, text: string): string {
  const matches = [...xml.matchAll(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g)];
  if (!matches.length) {
    const closeRun = xml.indexOf('</w:r>');
    if (closeRun >= 0) return `${xml.slice(0, closeRun)}<w:t xml:space="preserve">${xmlEscape(text)}</w:t>${xml.slice(closeRun)}`;
    const closeParagraph = xml.indexOf('</w:p>');
    if (closeParagraph >= 0) return `${xml.slice(0, closeParagraph)}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>${xml.slice(closeParagraph)}`;
    return xml;
  }

  const originalParts = matches.map((match) => Array.from(xmlUnescape(match[2])));
  const original = originalParts.flat();
  const changes=textReplacements(original,Array.from(text));

  let cursor = 0;
  const ranges = originalParts.map((part) => {
    const range = { start: cursor, end: cursor + part.length };
    cursor = range.end;
    return range;
  });
  const values=originalParts.map(()=>[] as string[]);let position=0;let changeIndex=0;
  const nodeAt=(offset:number)=>{
    const index=ranges.findIndex(({end})=>end>offset);
    return index<0?ranges.length-1:index;
  };
  while(position<original.length||changeIndex<changes.length){
    const change=changes[changeIndex];
    if(change&&change.start===position){
      values[nodeAt(position)].push(...change.text);position=change.end;changeIndex+=1;continue;
    }
    if(position>=original.length) break;
    values[nodeAt(position)].push(original[position]);position+=1;
  }

  let output = xml;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const value=values[index].join('');
    let open = match[1];
    if ((/^\s/u.test(value) || /\s$/u.test(value)) && !/\bxml:space\s*=/.test(open)) open = open.replace(/>$/, ' xml:space="preserve">');
    const rendered = `${open}${xmlEscape(value)}${match[3]}`;
    output = `${output.slice(0, match.index!)}${rendered}${output.slice(match.index! + match[0].length)}`;
  }
  return output;
}

function runPropertiesWithWeight(properties: string | undefined, weight: 'normal'|'bold'): string {
  const controls = weight === 'bold' ? '<w:b/><w:bCs/>' : '<w:b w:val="0"/><w:bCs w:val="0"/>';
  if (!properties || /\/\s*>$/.test(properties)) return `<w:rPr>${controls}</w:rPr>`;
  const cleaned = properties.replace(/<w:(?:b|bCs)(?=\s|\/?>)[^>]*(?:\/>|>[\s\S]*?<\/w:(?:b|bCs)>)/g, '');
  return cleaned.replace('</w:rPr>', `${controls}</w:rPr>`);
}

interface SimpleWordRun {
  xml: string;
  index: number;
  open: string;
  properties?: string;
  textOpen: string;
  text: string;
}

const PROTECTED_WORD_CONTENT=/<w:instrText\b|<w:fldChar\b|<w:del\b|<w:ins\b|<w:drawing\b|<w:pict\b|<w:bookmark(Start|End)\b|<w:txbxContent\b/;
const PROTECTED_WORD_STRUCTURE=/<w:(?:instrText|fldChar|fldSimple|del|ins|moveFrom|moveTo|drawing|pict|bookmarkStart|bookmarkEnd|[A-Za-z0-9]+Range(?:Start|End)|commentReference|annotationRef|permStart|permEnd|[A-Za-z0-9]+PrChange|cellIns|cellDel|cellMerge|footnoteReference|endnoteReference|footnoteRef|endnoteRef|proofErr|txbxContent|sdt|customXml|sectPr|object|altChunk)\b/;

function simpleWordRun(match: RegExpMatchArray): SimpleWordRun | null {
  const xml=match[0];const open=/^<w:r(?=\s|>)[^>]*>/.exec(xml)?.[0];
  const properties=/<w:rPr(?=\s|\/?>)[^>]*(?:\/>|>[\s\S]*?<\/w:rPr>)/.exec(xml)?.[0];
  const textNodes=[...xml.matchAll(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g)];
  const remainder=xml.replace(/^<w:r(?=\s|>)[^>]*>/,'').replace(/<\/w:r>$/,'')
    .replace(properties??'','').replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g,'').trim();
  if(!open||!textNodes.length||remainder) return null;
  return {xml,index:match.index!,open,properties,textOpen:/^<w:t\b[^>]*>/.exec(textNodes[0][0])?.[0]??'<w:t>',text:textOfXml(xml)};
}

function renderSimpleWordRun(run:SimpleWordRun,text:string,weight?:'normal'|'bold'):string{
  let textOpen=run.textOpen;
  if((/^\s/u.test(text)||/\s$/u.test(text))&&!/\bxml:space\s*=/.test(textOpen)) textOpen=textOpen.replace(/>$/,' xml:space="preserve">');
  const properties=weight?runPropertiesWithWeight(run.properties,weight):(run.properties??'');
  return `${run.open}${properties}${textOpen}${xmlEscape(text)}</w:t></w:r>`;
}

function applyIsolatedFieldAppearance(xml: string, fields: TemplateFieldDefinition[]): string {
  const weights = new Map(fields.filter((field) => field.appearance).map((field) => [field.key.toLowerCase(), field.appearance!.fontWeight]));
  return xml.replace(/<w:p(?=\s|>)[^>]*>(?:(?!<w:p(?=\s|>))[\s\S])*?<\/w:p>/g,(paragraph)=>{
    if(PROTECTED_WORD_CONTENT.test(paragraph)) return paragraph;
    const matches=[...paragraph.matchAll(/<w:r(?=\s|>)[^>]*>[\s\S]*?<\/w:r>/g)];
    const groups:SimpleWordRun[][]=[];let current:SimpleWordRun[]=[];
    for(const match of matches){
      const run=simpleWordRun(match);
      const previous=current.at(-1);
      const adjacent=previous&&!paragraph.slice(previous.index+previous.xml.length,match.index!).trim();
      if(!run||previous&&!adjacent){if(current.length)groups.push(current);current=[];}
      if(run)current.push(run);
    }
    if(current.length)groups.push(current);
    let output=paragraph;
    for(let groupIndex=groups.length-1;groupIndex>=0;groupIndex-=1){
      const group=groups[groupIndex];const text=group.map(run=>run.text).join('');
      let offset=0;const ranges=group.map(run=>{const range={start:offset,end:offset+run.text.length,run};offset+=run.text.length;return range;});
      const tags=[...text.matchAll(/\{([a-z][a-z0-9_]{0,63})\}/gi)]
        .map(match=>({start:match.index!,end:match.index!+match[0].length,text:match[0],weight:weights.get(match[1].toLowerCase())}))
        .filter(tag=>tag.weight!==undefined||!ranges.some(range=>tag.start>=range.start&&tag.end<=range.end));
      if(!tags.length)continue;
      const runAt=(position:number)=>ranges.find(range=>range.end>position)?.run??ranges.at(-1)!.run;
      const pieces:string[]=[];let position=0;let tagIndex=0;
      while(position<text.length){
        const tag=tags[tagIndex];
        if(tag&&tag.start===position){pieces.push(renderSimpleWordRun(runAt(position),tag.text,tag.weight));position=tag.end;tagIndex+=1;continue;}
        const range=ranges.find(item=>item.end>position)!;const end=Math.min(range.end,tag?.start??text.length);
        if(end<=position){tagIndex+=1;continue;}
        pieces.push(renderSimpleWordRun(range.run,text.slice(position,end)));position=end;
      }
      const start=group[0].index;const end=group.at(-1)!.index+group.at(-1)!.xml.length;
      output=`${output.slice(0,start)}${pieces.join('')}${output.slice(end)}`;
    }
    return output;
  });
}

function docxSafety(zip: PizZip): { warnings: string[]; mainXml: string } {
  const parts = Object.values(zip.files).filter((file) => !file.dir);
  if (!parts.length || parts.length > MAX_ZIP_PARTS) throw badRequest('The Word package has an unsafe number of parts.', 'unsafe_template');
  let expanded = 0;
  for (const part of parts) {
    const declared = Number((part as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
    if (!Number.isFinite(declared) || declared < 0) throw badRequest('The Word package has an invalid part size.', 'unsafe_template');
    expanded += declared;
    if (expanded > MAX_UNCOMPRESSED_BYTES) throw badRequest('The expanded Word package is too large.', 'unsafe_template');
    if (/vbaProject|activeX|embeddings|customUI|oleObject/i.test(part.name)) {
      throw badRequest('Word templates cannot contain macros, embedded objects or active content.', 'unsafe_template');
    }
  }
  const relationships = parts.filter((file) => file.name.endsWith('.rels')).map((file) => file.asText()).join('\n');
  if (/TargetMode\s*=\s*["']External["']/i.test(relationships)) {
    throw badRequest('Word templates cannot contain external relationships.', 'unsafe_template');
  }
  const mainXml = zip.file('word/document.xml')?.asText();
  if (!mainXml) throw badRequest('The file is not a valid Word document.', 'invalid_template');
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(mainXml)) throw badRequest('Word templates cannot contain DTD or entity declarations.', 'unsafe_template');
  const parseErrors: string[] = [];
  const parsed = new DOMParser({ errorHandler: (level, message) => { if (level !== 'warning') parseErrors.push(message); } }).parseFromString(mainXml, 'application/xml');
  if (parseErrors.length || parsed.getElementsByTagName('parsererror').length) throw badRequest('The Word document XML is invalid.', 'invalid_template');
  const warnings: string[] = [];
  if (/<w:instrText\b|<w:fldChar\b/.test(mainXml)) warnings.push('Word fields are protected and cannot be edited in the dashboard.');
  if (/<w:trackRevisions\b|<w:ins\b|<w:del\b/.test(mainXml)) warnings.push('Tracked changes were detected; accept or reject them in Word before publishing.');
  return { warnings, mainXml };
}

interface WordSpan { id: string; start: number; openEnd: number; closeStart: number; end: number; xml: string }
interface WordParagraphSpan extends WordSpan { tableId?: string; rowId?: string; cellIndex?: number; protectedAncestor: boolean }
interface WordCellSpan extends WordSpan { rowId: string; index: number; paragraphIds: string[] }
interface WordRowSpan extends WordSpan { tableId: string; cells: WordCellSpan[]; paragraphIds: string[]; nestedTable: boolean; protectedAncestor:boolean }
interface WordTableSpan extends WordSpan { parentTableId?: string; rowIds: string[] }
interface WordDocumentStructure {
  paragraphs: WordParagraphSpan[];
  rows: WordRowSpan[];
  tables: WordTableSpan[];
}

const LEGACY_WORD_PARAGRAPH=/<w:p(?=\s|>)[^>]*>(?:(?!<w:p(?=\s|>))[\s\S])*?<\/w:p>/g;

function inspectWordXml(mainXml: string): WordDocumentStructure {
  type OpenSpan={name:'tbl'|'tr'|'tc'|'p';id:string;start:number;openEnd:number;tableId?:string;rowId?:string;cellIndex?:number;protectedAncestor:boolean};
  const tables:WordTableSpan[]=[];const rows:WordRowSpan[]=[];const cells:WordCellSpan[]=[];const paragraphs:WordParagraphSpan[]=[];
  const open:OpenSpan[]=[];const protection:string[]=[];let tableCount=0;let rowCount=0;let cellCount=0;let paragraphCount=0;
  const token=/<\/?w:(tbl|tr|tc|p|sdt|customXml|txbxContent|ins|del)(?=[\s>])[^>]*>/g;
  for(const match of mainXml.matchAll(token)){
    const raw=match[0];const closing=raw.startsWith('</');const selfClosing=/\/\s*>$/.test(raw);const name=match[1];const position=match.index!;
    if(['sdt','customXml','txbxContent','ins','del'].includes(name)){
      if(closing){const at=protection.lastIndexOf(name);if(at>=0)protection.splice(at,1);}
      else if(!selfClosing)protection.push(name);
      continue;
    }
    const structural=name as OpenSpan['name'];
    if(!closing){
      const currentTable=[...open].reverse().find(item=>item.name==='tbl');
      const currentRow=[...open].reverse().find(item=>item.name==='tr');
      const currentCell=[...open].reverse().find(item=>item.name==='tc');
      const id=structural==='tbl'?`t-${++tableCount}`:structural==='tr'?`row-${++rowCount}`:structural==='tc'?`cell-${++cellCount}`:`r-${++paragraphCount}`;
      const entry:OpenSpan={name:structural,id,start:position,openEnd:position+raw.length,tableId:currentTable?.id,rowId:currentRow?.id,cellIndex:currentCell?.cellIndex,protectedAncestor:protection.length>0};
      if(structural==='tc') entry.cellIndex=cells.filter(item=>item.rowId===currentRow?.id).length+open.filter(item=>item.name==='tc'&&item.rowId===currentRow?.id).length;
      open.push(entry);
      if(selfClosing) open.pop();
      continue;
    }
    let index=open.length-1;while(index>=0&&open[index].name!==structural)index-=1;
    if(index<0)continue;
    const entry=open[index];open.splice(index,1);const closeStart=position;const end=position+raw.length;const xml=mainXml.slice(entry.start,end);
    if(structural==='tbl'){
      const table:WordTableSpan={id:entry.id,start:entry.start,openEnd:entry.openEnd,closeStart,end,xml,parentTableId:entry.tableId,rowIds:[]};
      tables.push(table);
    }else if(structural==='tr'){
      const row:WordRowSpan={id:entry.id,start:entry.start,openEnd:entry.openEnd,closeStart,end,xml,tableId:entry.tableId??'',cells:[],paragraphIds:[],nestedTable:false,protectedAncestor:entry.protectedAncestor};
      rows.push(row);
    }else if(structural==='tc'){
      cells.push({id:entry.id,start:entry.start,openEnd:entry.openEnd,closeStart,end,xml,rowId:entry.rowId??'',index:entry.cellIndex??0,paragraphIds:[]});
    }else{
      paragraphs.push({id:entry.id,start:entry.start,openEnd:entry.openEnd,closeStart,end,xml,tableId:entry.tableId,rowId:entry.rowId,cellIndex:entry.cellIndex,protectedAncestor:entry.protectedAncestor});
    }
  }
  tables.sort((a,b)=>a.start-b.start);rows.sort((a,b)=>a.start-b.start);cells.sort((a,b)=>a.start-b.start);paragraphs.sort((a,b)=>a.start-b.start);
  // Region IDs predate the structural scanner and are persisted in draft
  // snapshots. Preserve the exact paragraph enumeration used by the original
  // tempered regex so self-closing and outer nested paragraphs cannot shift
  // saved r-N edits onto another paragraph after an upgrade.
  const legacyIds=new Map([...mainXml.matchAll(LEGACY_WORD_PARAGRAPH)].map((match,index)=>[match.index!,`r-${index+1}`]));
  for(let index=paragraphs.length-1;index>=0;index-=1){const legacyId=legacyIds.get(paragraphs[index].start);if(!legacyId)paragraphs.splice(index,1);else paragraphs[index].id=legacyId;}
  for(const table of tables)table.rowIds=rows.filter(row=>row.tableId===table.id).map(row=>row.id);
  for(const row of rows){
    row.cells=cells.filter(cell=>cell.rowId===row.id);
    row.paragraphIds=paragraphs.filter(p=>p.rowId===row.id).map(p=>p.id);
    row.nestedTable=tables.some(table=>table.parentTableId===row.tableId&&table.start>row.start&&table.end<row.end);
  }
  for(const cell of cells)cell.paragraphIds=paragraphs.filter(p=>p.rowId===cell.rowId&&p.start>cell.start&&p.end<cell.end).map(p=>p.id);
  return {paragraphs,rows,tables};
}

function rowProtectionReason(row:WordRowSpan, structure:WordDocumentStructure):string|undefined{
  const table=structure.tables.find(item=>item.id===row.tableId);
  if(!table||table.parentTableId)return 'Nested table rows cannot be changed in the dashboard.';
  if(row.protectedAncestor)return 'This row is inside protected Word content.';
  if(row.nestedTable)return 'Rows containing nested tables cannot be changed in the dashboard.';
  if(/<w:p(?=[\s/>])[^>]*\/\s*>/.test(row.xml))return 'Rows with unsupported empty Word paragraphs cannot be changed in the dashboard.';
  if(/<w:(?:vMerge|hMerge|gridSpan)\b/.test(row.xml))return 'Merged table rows cannot be changed in the dashboard.';
  if(/<w:tblHeader\b/.test(row.xml))return 'Header rows cannot be changed in the dashboard.';
  if(PROTECTED_WORD_STRUCTURE.test(row.xml))return 'This row contains protected Word content.';
  if(!row.cells.length||row.cells.some(cell=>cell.paragraphIds.length!==1))return 'Only rows with one paragraph in each cell can be changed in the dashboard.';
  return undefined;
}

function inspectedWordSnapshot(mainXml:string,warnings:string[]):TemplateEditorSnapshot{
  const structure=inspectWordXml(mainXml);
  const rowMetadata:WordTableRow[]=structure.rows.map(row=>{
    const reason=rowProtectionReason(row,structure);
    return {id:row.id,tableId:row.tableId,regionIds:row.paragraphIds,cellCount:row.cells.length,readOnly:!!reason,...(reason?{reason}:{}),...(/<w:tblHeader\b/.test(row.xml)?{isHeader:true}:{})};
  });
  const rows=new Map(rowMetadata.map(row=>[row.id,row]));
  const regions:TemplateRegion[]=structure.paragraphs.map(paragraph=>{
    const row=paragraph.rowId?rows.get(paragraph.rowId):undefined;
    const readOnly=paragraph.protectedAncestor||PROTECTED_WORD_CONTENT.test(paragraph.xml);
    const inTable=!!paragraph.tableId;
    const structureEditable=!inTable&&!readOnly&&!PROTECTED_WORD_STRUCTURE.test(paragraph.xml);
    return {id:paragraph.id,kind:inTable?'table-cell':'paragraph',text:textOfXml(paragraph.xml),readOnly,
      structureEditable, ...(structureEditable?{}:{structureReason:inTable?(row?.reason??'Use the table row controls to change table structure.'):'This paragraph contains protected Word content.'}),
      ...(paragraph.rowId?{rowId:paragraph.rowId}:{}),...(paragraph.cellIndex!==undefined?{cellIndex:paragraph.cellIndex}:{})};
  });
  const fields=[...new Set(regions.flatMap(region=>[...region.text.matchAll(/\{([a-z][a-z0-9_]{0,63})\}/gi)].map(match=>match[1])))]
    .map((key):TemplateFieldDefinition=>({key,label:key.replace(/_/g,' '),type:'text',required:false,source:key}));
  return {format:'docx',fields,regions,wordStructure:{rows:rowMetadata},wordOperations:[],warnings};
}

export function inspectDocxTemplate(content: Buffer): TemplateEditorSnapshot {
  if (!content.length || content.length > MAX_TEMPLATE_BYTES) throw badRequest('Template files must not exceed 20 MiB.', 'template_too_large');
  let zip: PizZip;
  try { zip = new PizZip(content); } catch { throw badRequest('The file is not a valid Word document.', 'invalid_template'); }
  const { warnings, mainXml } = docxSafety(zip);
  return inspectedWordSnapshot(mainXml,warnings);
}

function safeCloneXml(xml:string):string{
  return xml.replace(/\s+(?:w:rsid[A-Za-z0-9]*|w14:(?:paraId|textId))\s*=\s*(?:"[^"]*"|'[^']*')/g,'');
}

function firstElementXml(xml:string,tag:string):string{
  const match=new RegExp(`<${tag}(?=[\\s/>])[^>]*(?:/\\s*>|>[\\s\\S]*?<\\/${tag}>)`).exec(xml);
  return match?safeCloneXml(match[0]):'';
}

function clonedTextNode(text:string):string{
  const space=/^\s|\s$/u.test(text)?' xml:space="preserve"':'';
  return `<w:t${space}>${xmlEscape(text)}</w:t>`;
}

function cloneParagraphWithText(paragraphXml:string,text:string):string{
  const properties=firstElementXml(paragraphXml,'w:pPr');const runProperties=firstElementXml(paragraphXml,'w:rPr');
  return `<w:p>${properties}<w:r>${runProperties}${clonedTextNode(text.normalize('NFC'))}</w:r></w:p>`;
}

function cloneTableRowWithText(row:WordRowSpan,structure:WordDocumentStructure,cells:string[]):string{
  const rowProperties=firstElementXml(row.xml,'w:trPr');
  const rendered=row.cells.map((cell,index)=>{
    const cellProperties=firstElementXml(cell.xml,'w:tcPr');const paragraph=structure.paragraphs.find(item=>item.id===cell.paragraphIds[0])!;
    return `<w:tc>${cellProperties}${cloneParagraphWithText(paragraph.xml,cells[index])}</w:tc>`;
  }).join('');
  return `<w:tr>${rowProperties}${rendered}</w:tr>`;
}

function validateWordOperationsForRender(snapshot:TemplateEditorSnapshot,structure:WordDocumentStructure):WordStructureOperation[]{
  const operations=snapshot.wordOperations??[];
  if(!Array.isArray(operations)||operations.length>200)throw badRequest('Word structure changes must contain at most 200 operations.','invalid_template_structure');
  const paragraphs=new Map(structure.paragraphs.map(item=>[item.id,item]));const rows=new Map(structure.rows.map(item=>[item.id,item]));
  const rowMetadata=new Map((snapshot.wordStructure?.rows??[]).map(row=>[row.id,row]));const ids=new Set<string>();const deleted=new Set<string>();
  for(const operation of operations){
    if(!operation||typeof operation!=='object'||typeof operation.id!=='string'||!operation.id||operation.id.length>100||ids.has(operation.id))throw badRequest('Word structure operation IDs must be unique.','invalid_template_structure');
    ids.add(operation.id);
    if(operation.type==='insert-paragraph'){
      const anchor=paragraphs.get(operation.anchorId);if(!anchor||anchor.tableId||anchor.protectedAncestor||PROTECTED_WORD_STRUCTURE.test(anchor.xml))throw badRequest('Paragraph insertion anchor is unavailable or protected.','template_structure_conflict');
      if(operation.position!=='before'&&operation.position!=='after'||typeof operation.text!=='string'||operation.text.length>50_000)throw badRequest('Paragraph insertion is invalid.','invalid_template_structure');
      if(deleted.has(`p:${operation.anchorId}`))throw badRequest('A deleted paragraph cannot also be an insertion anchor.','invalid_template_structure');
    }else if(operation.type==='delete-paragraph'){
      const target=paragraphs.get(operation.targetId);if(!target||target.tableId||target.protectedAncestor||PROTECTED_WORD_STRUCTURE.test(target.xml))throw badRequest('Paragraph deletion target is unavailable or protected.','template_structure_conflict');
      const key=`p:${operation.targetId}`;if(deleted.has(key))throw badRequest('A paragraph cannot be deleted more than once.','invalid_template_structure');deleted.add(key);
      if(operations.some(item=>item.type==='insert-paragraph'&&item.anchorId===operation.targetId))throw badRequest('A deleted paragraph cannot also be an insertion anchor.','invalid_template_structure');
    }else if(operation.type==='insert-table-row'){
      const anchor=rows.get(operation.anchorRowId);const meta=rowMetadata.get(operation.anchorRowId);if(!anchor||!meta||meta.readOnly)throw badRequest('Table row insertion anchor is unavailable or protected.','template_structure_conflict');
      if(operation.position!=='before'&&operation.position!=='after'||!Array.isArray(operation.cells)||operation.cells.length!==anchor.cells.length||operation.cells.some(text=>typeof text!=='string'||text.length>50_000))throw badRequest('Inserted table row cells do not match the source row.','invalid_template_structure');
      if(deleted.has(`row:${operation.anchorRowId}`))throw badRequest('A deleted table row cannot also be an insertion anchor.','invalid_template_structure');
    }else if(operation.type==='delete-table-row'){
      const target=rows.get(operation.targetRowId);const meta=rowMetadata.get(operation.targetRowId);if(!target||!meta||meta.readOnly)throw badRequest('Table row deletion target is unavailable or protected.','template_structure_conflict');
      const key=`row:${operation.targetRowId}`;if(deleted.has(key))throw badRequest('A table row cannot be deleted more than once.','invalid_template_structure');deleted.add(key);
      if(operations.some(item=>item.type==='insert-table-row'&&item.anchorRowId===operation.targetRowId))throw badRequest('A deleted table row cannot also be an insertion anchor.','invalid_template_structure');
    }else throw badRequest('Unknown Word structure operation.','invalid_template_structure');
  }
  for(const table of structure.tables.filter(item=>!item.parentTableId)){
    const editable=table.rowIds.filter(id=>!rowMetadata.get(id)?.readOnly);const removed=editable.filter(id=>deleted.has(`row:${id}`));
    if(editable.length&&removed.length>=editable.length)throw badRequest('At least one editable table row must remain.','invalid_template_structure');
  }
  return operations;
}

export function applyDocxEditor(content: Buffer, snapshot: TemplateEditorSnapshot): Buffer {
  const zip = new PizZip(content);
  const { mainXml } = docxSafety(zip);const structure=inspectWordXml(mainXml);const inspected=inspectedWordSnapshot(mainXml,[]);
  const operations=validateWordOperationsForRender({...snapshot,wordStructure:inspected.wordStructure},structure);
  const sourceRegions=new Map((inspected.regions??[]).map(region=>[region.id,region]));const changedRegions=new Map((snapshot.regions??[]).map(region=>[region.id,region]));
  const rangeChanges:{start:number;end:number;text:string}[]=[];const insertions=new Map<number,string[]>();
  const addInsertion=(position:number,text:string)=>insertions.set(position,[...(insertions.get(position)??[]),text]);
  const deletedParagraphs=new Set(operations.filter((operation):operation is Extract<WordStructureOperation,{type:'delete-paragraph'}>=>operation.type==='delete-paragraph').map(operation=>operation.targetId));
  const deletedRows=new Set(operations.filter((operation):operation is Extract<WordStructureOperation,{type:'delete-table-row'}>=>operation.type==='delete-table-row').map(operation=>operation.targetRowId));
  for(const paragraph of structure.paragraphs){
    const original=sourceRegions.get(paragraph.id)!;const changed=changedRegions.get(paragraph.id);
    if(!changed||original.readOnly||changed.text===original.text||deletedParagraphs.has(paragraph.id)||(paragraph.rowId&&deletedRows.has(paragraph.rowId)))continue;
    rangeChanges.push({start:paragraph.start,end:paragraph.end,text:replaceRegionText(paragraph.xml,changed.text.normalize('NFC'))});
  }
  const paragraphs=new Map(structure.paragraphs.map(item=>[item.id,item]));const rows=new Map(structure.rows.map(item=>[item.id,item]));
  for(const operation of operations){
    if(operation.type==='insert-paragraph'){
      const anchor=paragraphs.get(operation.anchorId)!;addInsertion(operation.position==='before'?anchor.start:anchor.end,cloneParagraphWithText(anchor.xml,operation.text));
    }else if(operation.type==='delete-paragraph'){
      const target=paragraphs.get(operation.targetId)!;
      rangeChanges.push({start:target.start,end:target.end,text:''});
    }else if(operation.type==='insert-table-row'){
      const anchor=rows.get(operation.anchorRowId)!;const clone=cloneTableRowWithText(anchor,structure,operation.cells);
      addInsertion(operation.position==='before'?anchor.start:anchor.end,clone);
    }else{
      const target=rows.get(operation.targetRowId)!;
      rangeChanges.push({start:target.start,end:target.end,text:''});
    }
  }
  rangeChanges.sort((a,b)=>a.start-b.start);for(let index=1;index<rangeChanges.length;index+=1)if(rangeChanges[index].start<rangeChanges[index-1].end)throw badRequest('Word structure changes overlap.','invalid_template_structure');
  const events=[...new Set([...rangeChanges.map(change=>change.start),...insertions.keys()])].sort((a,b)=>a-b);let cursor=0;const pieces:string[]=[];
  for(const position of events){if(position<cursor)throw badRequest('Word structure changes overlap.','invalid_template_structure');pieces.push(mainXml.slice(cursor,position),...(insertions.get(position)??[]));const change=rangeChanges.find(item=>item.start===position);if(change){pieces.push(change.text);cursor=change.end;}else cursor=position;}
  pieces.push(mainXml.slice(cursor));let output=applyIsolatedFieldAppearance(pieces.join(''),snapshot.fields??[]);
  const parseErrors:string[]=[];const parsed=new DOMParser({errorHandler:(level,message)=>{if(level!=='warning')parseErrors.push(message);}}).parseFromString(output,'application/xml');
  if(parseErrors.length||parsed.getElementsByTagName('parsererror').length)throw badRequest('Edited Word structure is invalid.','invalid_template_structure');
  inspectedWordSnapshot(output,[]);
  zip.file('word/document.xml', output);
  const rendered = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
  if (rendered.length > MAX_TEMPLATE_BYTES) throw badRequest('Edited template exceeds 20 MiB.', 'template_too_large');
  return rendered;
}

export async function inspectPdfTemplate(content: Buffer): Promise<TemplateEditorSnapshot> {
  validatePdfBytes(content);
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(content, { updateMetadata: false }); } catch { throw badRequest('Encrypted or invalid PDFs cannot be used as templates.', 'invalid_template'); }
  assertSafePdfObjects(pdf);
  if (pdf.getPageCount() > MAX_PDF_PAGES) throw badRequest(`PDF templates must not exceed ${MAX_PDF_PAGES} pages.`, 'template_too_large');
  return { format: 'pdf', fields: [], placements: [], pages: pdf.getPages().map((page,index) => {
    const crop=page.getCropBox(); const rotation=((page.getRotation().angle%360)+360)%360;
    return {page:index+1,width:rotation===90||rotation===270?crop.height:crop.width,height:rotation===90||rotation===270?crop.width:crop.height,rotation};
  }), warnings: [] };
}

export function validatePdfBytes(content: Buffer): void {
  if (!content.length || content.length > MAX_TEMPLATE_BYTES) throw badRequest('Template files must not exceed 20 MiB.', 'template_too_large');
  if (!content.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw badRequest('The file is not a valid PDF.', 'invalid_template');
  const source = content.toString('latin1');
  if (/\/Encrypt\b|\/JavaScript\b|\/JS\b|\/EmbeddedFiles\b|\/Launch\b/.test(source)) {
    throw badRequest('Encrypted PDFs and PDFs with scripts or embedded files cannot be templates.', 'unsafe_template');
  }
}

function assertSafePdfObjects(pdf: PDFDocument): void {
  const blocked = ['JavaScript','JS','EmbeddedFiles','Launch','OpenAction','AA','RichMedia'];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    const source = String(object);
    if (blocked.some((name) => source.includes(`/${name}`))) throw badRequest('PDFs with scripts, actions, or embedded files cannot be templates.', 'unsafe_template');
  }
  const names = pdf.catalog.get(PDFName.of('Names'));
  if (names && /\/(JavaScript|EmbeddedFiles)\b/.test(String(names))) throw badRequest('PDFs with scripts or embedded files cannot be templates.', 'unsafe_template');
}

export function normalizeFieldSchema(value: unknown): TemplateFieldDefinition[] {
  if (!Array.isArray(value) || value.length > 100) throw badRequest('Template fields must be an array of at most 100 fields.', 'invalid_template_fields');
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badRequest(`Template field ${index + 1} is invalid.`, 'invalid_template_fields');
    const raw = entry as Record<string, unknown>;
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key) || seen.has(key.toLowerCase())) throw badRequest(`Template field key ${key || index + 1} is invalid or duplicated.`, 'invalid_template_fields');
    const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : null;
    if (/^(supplier_?id|supplier_?code)$/i.test(key) || (source && /^(supplierId|supplierCode|supplier_?id|supplier_?code)$/i.test(source))) {
      throw badRequest('Supplier ID is dashboard-only and cannot be inserted into a document template.', 'forbidden_template_field');
    }
    seen.add(key.toLowerCase());
    const type = raw.type === 'number' || raw.type === 'date' ? raw.type : 'text';
    let appearance: TemplateFieldDefinition['appearance'];
    if (raw.appearance !== undefined) {
      if (!raw.appearance || typeof raw.appearance !== 'object' || Array.isArray(raw.appearance)) throw badRequest(`Template field ${key} appearance is invalid.`, 'invalid_template_fields');
      const fontWeight = (raw.appearance as Record<string, unknown>).fontWeight;
      if (fontWeight !== 'normal' && fontWeight !== 'bold') throw badRequest(`Template field ${key} font weight is invalid.`, 'invalid_template_fields');
      appearance = { fontWeight };
    }
    return { key, label: String(raw.label ?? key).trim().slice(0, 120), type, required: raw.required === true, source, ...(appearance ? { appearance } : {}) };
  });
}

export function normalizePdfPlacements(value: unknown, fields: TemplateFieldDefinition[]): PdfFieldPlacement[] {
  if (!Array.isArray(value) || value.length > 500) throw badRequest('PDF placements must be an array of at most 500 items.', 'invalid_template_fields');
  const keys = new Set(fields.map((field) => field.key));
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badRequest(`PDF placement ${index + 1} is invalid.`, 'invalid_template_fields');
    const raw = entry as Record<string, unknown>; const field = String(raw.field ?? '');
    const n = (key: string) => Number(raw[key]);
    const page = n('page'); const x = n('x'); const y = n('y'); const width = n('width'); const height = n('height'); const fontSize = n('fontSize');
    if (!keys.has(field) || !Number.isSafeInteger(page) || page < 1 || ![x,y,width,height,fontSize].every(Number.isFinite)
      || x < 0 || y < 0 || width <= 0 || height <= 0 || fontSize < 4 || fontSize > 72) throw badRequest(`PDF placement ${index + 1} is invalid.`, 'invalid_template_fields');
    const align = raw.align === 'center' || raw.align === 'right' ? raw.align : 'left';
    const font = raw.font === 'helvetica' || raw.font === 'courier' ? raw.font : 'times';
    return { field, page, x, y, width, height, fontSize, font, align };
  });
}

export function resolveTemplateFields(values: ContractValues, customValues: unknown, fields: TemplateFieldDefinition[]): Record<string, string> {
  const data = templateData(values, normalizeCustomValues(customValues));
  const output: Record<string, string> = {};
  for (const field of fields) {
    let value = String(data[field.source ?? field.key] ?? '');
    if (field.required && !value.trim()) throw badRequest(`${field.label} is required for document generation.`, 'validation_failed');
    if (field.type === 'number' && value && !Number.isFinite(Number(value))) throw badRequest(`${field.label} must be a number.`, 'validation_failed');
    if (field.type === 'date' && value) {
      if (isValidIsoDate(value)) value = englishDate(value);
      else {
        const parsed = /^\d{1,2} [A-Za-z]+ \d{4}$/.test(value) ? new Date(`${value} UTC`) : new Date(NaN);
        if (!Number.isFinite(parsed.getTime()) || englishDate(parsed.toISOString().slice(0,10)) !== value) {
          throw badRequest(`${field.label} must be a valid date.`, 'validation_failed');
        }
      }
    }
    output[field.key] = value;
  }
  return { ...data, ...output };
}

async function embedPdfFont(pdf: PDFDocument, requested: 'times'|'helvetica'|'courier', weight: 'normal'|'bold') {
  if(requested==='helvetica') return pdf.embedFont(weight === 'bold' ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  if(requested==='courier') return pdf.embedFont(weight === 'bold' ? StandardFonts.CourierBold : StandardFonts.Courier);
  const configured = (process.env.NDA_DOCUMENT_FONT_PATH ?? process.env.NDA_TEMPLATE_FONT_PATH)?.trim();
  if (configured) {
    const bold = process.env.NDA_DOCUMENT_BOLD_FONT_PATH?.trim()
      || (basename(configured).toLowerCase()==='times.ttf' ? join(dirname(configured),'timesbd.ttf') : undefined);
    const candidates = weight==='bold' && bold ? [bold,configured] : [configured];
    for (const candidate of candidates) {
      try {
        const bytes = await readFile(candidate);
        const fontkit = (await import('@pdf-lib/fontkit')).default;
        pdf.registerFontkit(fontkit);
        return await pdf.embedFont(bytes, { subset: true });
      } catch { /* Try the configured regular Unicode font before standard fallback. */ }
    }
  }
  return pdf.embedFont(weight==='bold' ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman);
}

export async function renderPdfTemplate(content: Buffer, snapshot: TemplateEditorSnapshot, values: Record<string, string>): Promise<Buffer> {
  validatePdfBytes(content);
  const pdf = await PDFDocument.load(content, { updateMetadata: false });
  assertSafePdfObjects(pdf);
  const fonts=new Map<string,Awaited<ReturnType<typeof embedPdfFont>>>(); const pages = pdf.getPages();
  const fieldWeights = new Map((snapshot.fields ?? []).map((field) => [field.key, field.appearance?.fontWeight ?? 'normal']));
  for (const placement of snapshot.placements ?? []) {
    const fontName=placement.font??'times'; const fontWeight=fieldWeights.get(placement.field) ?? 'normal'; const fontKey=`${fontName}:${fontWeight}`; let font=fonts.get(fontKey);
    if(!font){font=await embedPdfFont(pdf,fontName,fontWeight);fonts.set(fontKey,font);}
    const page = pages[placement.page - 1];
    if (!page) throw badRequest(`PDF placement refers to missing page ${placement.page}.`, 'invalid_template_fields');
    const crop=page.getCropBox(); const pageWidth=crop.width; const pageHeight=crop.height;
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const visualWidth = angle === 90 || angle === 270 ? pageHeight : pageWidth;
    const visualHeight = angle === 90 || angle === 270 ? pageWidth : pageHeight;
    if (placement.x + placement.width > visualWidth || placement.y + placement.height > visualHeight) throw badRequest(`PDF field ${placement.field} is outside page ${placement.page}.`, 'invalid_template_fields');
    const value = values[placement.field] ?? '';
    const textWidth = font.widthOfTextAtSize(value, placement.fontSize);
    if (textWidth > placement.width || font.heightAtSize(placement.fontSize) > placement.height) throw badRequest(`${placement.field} does not fit its PDF field area.`, 'field_overflow');
    const visualX = placement.align === 'center' ? placement.x + (placement.width - textWidth) / 2
      : placement.align === 'right' ? placement.x + placement.width - textWidth : placement.x;
    const visualY = placement.y + Math.max(0, (placement.height - font.heightAtSize(placement.fontSize)) / 2);
    const local = angle === 90 ? { x: pageWidth - visualY, y: visualX }
      : angle === 180 ? { x: pageWidth - visualX, y: pageHeight - visualY }
        : angle === 270 ? { x: visualY, y: pageHeight - visualX }
          : { x: visualX, y: visualY };
    page.drawText(value, { x:crop.x+local.x, y:crop.y+local.y, size: placement.fontSize, font, maxWidth: placement.width, rotate: degrees(angle) });
  }
  const output = Buffer.from(await pdf.save({ useObjectStreams: false }));
  if (output.length > MAX_TEMPLATE_BYTES) throw badRequest('Generated PDF exceeds 20 MiB.', 'template_too_large');
  return output;
}

export function sourceChecksum(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
