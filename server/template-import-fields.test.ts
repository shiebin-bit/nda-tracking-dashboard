import {describe,expect,it} from 'vitest';
import {recognizeImportFields} from './template-import-fields.js';
import type {TemplateEditorSnapshot} from '../src/contract-types.js';
const source=(texts:string[]):TemplateEditorSnapshot=>({format:'docx',fields:[],regions:texts.map((text,i)=>({id:`r-${i}`,text,kind:'paragraph',readOnly:false}))});
describe('EOI import recognition',()=>{
  it('binds exact bracket labels in revised EOI without guessing legal text',()=>{
    const original=source(['proposed [Project Name / Brief Description]','[The recipient / You/ The Company] shall','[The recipient] shall','[The recipient] acknowledges','[Section 4] The recipient discloses.']);
    const result=recognizeImportFields(original,'eoi');
    expect(result.fields.map(f=>f.key)).toEqual(['project_name','recipient_name']);
    expect(result.fields.every(f=>f.appearance?.fontWeight==='bold')).toBe(true);
    expect(result.regions![1].text).toBe('{recipient_name} shall');
    expect(result.regions![4].text).toBe('[Section 4] The recipient discloses.');
    expect(original.fields).toHaveLength(0);
  });
  it('retains protected content and NDA square brackets',()=>{
    const original=source(['[Project Name]']);original.regions![0].readOnly=true;
    expect(recognizeImportFields(original,'eoi').fields).toHaveLength(0);
    expect(recognizeImportFields(source(['[Project Name]']),'nda').fields).toHaveLength(0);
  });
  it('reuses existing source bindings and avoids conflicting keys',()=>{
    const original=source(['[Project Name]']);original.fields=[{key:'project_name',label:'Other',type:'text',source:'other',required:false}];
    const result=recognizeImportFields(original,'eoi');
    expect(result.regions![0].text).toBe('{project_name_2}');
    expect(result.fields[1].source).toBe('project_name');
  });
});
