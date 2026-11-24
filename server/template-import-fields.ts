import type {DocumentType, TemplateEditorSnapshot} from '../src/contract-types.js';

// Deliberately small, exact aliases. Legal references and ordinary prose are not guessed.
const aliases: Record<string, {key:string;label:string}> = {
  'project name / brief description': {key:'project_name',label:'Project name / brief description'},
  'project name': {key:'project_name',label:'Project name'},
  'the recipient / you/ the company': {key:'recipient_name',label:'Supplier company'},
  'the recipient': {key:'recipient_name',label:'Supplier company'},
  'supplier name': {key:'recipient_name',label:'Supplier company'},
};

export function recognizeImportFields(input:TemplateEditorSnapshot,type:DocumentType):TemplateEditorSnapshot {
  if(input.format!=='docx'||type!=='eoi')return input;
  const snapshot=structuredClone(input);let count=0;
  for(const region of snapshot.regions??[]){
    if(region.readOnly)continue;
    region.text=region.text.replace(/\[([^\[\]\r\n]{1,100})\]/g,(text,label:string)=>{
      const match=aliases[label.trim().replace(/\s+/g,' ').toLowerCase()];
      if(!match)return text;
      let field=snapshot.fields.find(f=>(f.source??f.key)===match.key);
      if(!field){
        let key=match.key;let suffix=2;
        while(snapshot.fields.some(f=>f.key.toLowerCase()===key.toLowerCase()))key=`${match.key}_${suffix++}`;
        field={key,label:match.label,type:'text',required:true,source:match.key,appearance:{fontWeight:'bold'}};
        snapshot.fields.push(field);
      }
      count++;return `{${field.key}}`;
    });
  }
  if(count)snapshot.warnings=[...snapshot.warnings??[],`Recognized ${count} bracketed EOI placeholders and bound them to supplier/project data. Review these mappings and preview every page before publishing. Other text was retained.`];
  if(!snapshot.fields.length)snapshot.warnings=[...snapshot.warnings??[],'No variable fields were recognized. Use {field_name} placeholders, or select document text and choose Set as field. Ordinary names and blank signature lines are not automatically changed.'];
  return snapshot;
}
