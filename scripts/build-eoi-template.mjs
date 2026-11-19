import { readFile, writeFile } from 'node:fs/promises';
import PizZip from 'pizzip';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/build-eoi-template.mjs input.docx output.docx');
const zip = new PizZip(await readFile(input));
const file = zip.file('word/document.xml');
if (!file) throw new Error('Input is not a DOCX document.');
const decode = (v) => v.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const encode = (v) => v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const paragraphText = (p) => [...p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m)=>decode(m[1])).join('');
const setParagraphText = (p,value) => { let first=true; return p.replace(/(<w:t\b[^>]*>)[\s\S]*?(<\/w:t>)/g,(_m,a,b)=>{ if(!first)return `${a}${b}`; first=false; return `${a}${encode(value)}${b}`; }); };
let xml=file.asText();
xml=xml.replace(/<w:p(?=\s|>)[^>]*>(?:(?!<w:p(?=\s|>))[\s\S])*?<\/w:p>/g,(p)=>{
  const before=paragraphText(p); if(!before)return p;
  const after=before.replace(/\[Project Name \/ Brief Description\]/g,'{project_name} – {project_description}').replace(/\[Proposed Transaction\]/g,'{project_name}')
    .replace(/\[The recipient \/ You\/ The Company\]|\[The recipient\]/g,'{recipient_name}').replace(/\[FFM\]/g,'FFM')
    .replace(/the this email/g,'this document').replace(/Information\)as\s+strictly/g,'Information”) as strictly')
    .replace(/purpose of evaluating and responding to this Project\s*not disclose/g,'purpose of evaluating and responding to this Project and shall not disclose')
    .replace(/processingyour/g,'processing your').replace(/RFI process/g,'EOI process');
  return after===before?p:setParagraphText(p,after);
});
const font='<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>';
const boldFont='<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>';
const row=(label,value)=>`<w:tr><w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr><w:p><w:r>${boldFont}<w:t>${label}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/></w:tcPr><w:p><w:r>${font}<w:t xml:space="preserve">${value||' '}</w:t></w:r></w:p><w:p><w:r>${font}<w:t xml:space="preserve"> </w:t></w:r></w:p></w:tc></w:tr>`;
const signature=`<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r>${boldFont}<w:t>ACKNOWLEDGEMENT OF INTEREST</w:t></w:r></w:p><w:p><w:r>${font}<w:t xml:space="preserve">For and on behalf of {recipient_name}</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B7B7B7"/><w:left w:val="single" w:sz="4" w:color="B7B7B7"/><w:bottom w:val="single" w:sz="4" w:color="B7B7B7"/><w:right w:val="single" w:sz="4" w:color="B7B7B7"/><w:insideH w:val="single" w:sz="4" w:color="D9D9D9"/><w:insideV w:val="single" w:sz="4" w:color="D9D9D9"/></w:tblBorders></w:tblPr>${row('Authorised representative','{representative_name}')}${row('Designation','{representative_designation}')}${row('Signature','')}${row('Date','{document_date}')}</w:tbl><w:p><w:r>${font}<w:t xml:space="preserve">Project: {project_name}</w:t></w:r></w:p>`;
xml=xml.replace(/(<w:sectPr\b)/,`${signature}$1`);
zip.file('word/document.xml',xml);
await writeFile(output,zip.generate({type:'nodebuffer',compression:'DEFLATE'}));
