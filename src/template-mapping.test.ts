import {describe,expect,it} from 'vitest';
import {bindPlaceholder,bindSelectedText,fieldLocations,newTemplateField,selectionMatchCount} from './template-mapping';
import type {TemplateEditorSnapshot} from './contract-types';
describe('selected text field mapping',()=>{
  const snapshot:TemplateEditorSnapshot={format:'docx',fields:[newTemplateField('','client_name','Client')],regions:[{id:'r1',kind:'paragraph',text:'ABC & 名称 and ABC & 名称. {client_name}',readOnly:false},{id:'r2',kind:'table-cell',text:'ABC & 名称',readOnly:false},{id:'r3',kind:'paragraph',text:'ABC & 名称',readOnly:true}]};
  const selection={regionId:'r1',start:0,end:8,text:'ABC & 名称'};
  it('binds all editable exact matches atomically without modifying protected areas',()=>{expect(selectionMatchCount(snapshot,selection)).toBe(3);const mapped=bindSelectedText(snapshot,selection,newTemplateField('recipient_name','supplier','Supplier',true),true);expect(mapped.regions?.[0].text).toBe('{supplier} and {supplier}. {client_name}');expect(mapped.regions?.[1].text).toBe('{supplier}');expect(mapped.regions?.[2].text).toBe('ABC & 名称');expect(snapshot.regions?.[0].text).toContain('ABC');expect(mapped.fields.at(-1)?.appearance?.fontWeight).toBe('bold');expect(fieldLocations(mapped).get('supplier')).toHaveLength(3);});
  it('replaces only the selected occurrence and reuses existing field definitions',()=>{const mapped=bindSelectedText(snapshot,selection,snapshot.fields[0],false);expect(mapped.fields).toHaveLength(1);expect(mapped.regions?.[0].text).toBe('{client_name} and ABC & 名称. {client_name}');});
  it('rejects stale, protected and existing placeholder selections',()=>{expect(()=>bindSelectedText(snapshot,{...selection,text:'old'},snapshot.fields[0],false)).toThrow();expect(()=>bindSelectedText(snapshot,{...selection,regionId:'r3'},snapshot.fields[0],true)).toThrow();const start=snapshot.regions![0].text.indexOf('client_name');expect(()=>bindSelectedText(snapshot,{regionId:'r1',start,end:start+11,text:'client_name'},snapshot.fields[0],true)).toThrow();});
  it('finds unbound placeholders, repeated fields and PDF positions',()=>{const positions=fieldLocations({format:'pdf',fields:[],placements:[{field:'unbound',page:2,x:1,y:1,width:20,height:20,fontSize:10,align:'left'}]});expect(positions.get('unbound')?.[0].label).toBe('Page 2');});
  it('rebinds case-variant placeholders to the exact existing key without duplicate fields',()=>{
    const input={format:'docx' as const,fields:[newTemplateField('recipient_name','recipient_name','Supplier')],regions:[{id:'r',kind:'paragraph' as const,text:'{Recipient_Name} and {recipient_name}',readOnly:false}]};
    const bound=bindPlaceholder(input,'Recipient_Name',input.fields[0]);expect(bound.fields).toHaveLength(1);expect(bound.regions?.[0].text).toBe('{recipient_name} and {recipient_name}');
  });
  it('recognizes uppercase imported tags and protects them from replacement',()=>{
    const upper={format:'docx' as const,fields:[],regions:[{id:'r',kind:'paragraph' as const,text:'{Recipient_Name} Example',readOnly:false}]};
    expect(fieldLocations(upper).get('Recipient_Name')).toHaveLength(1);
    expect(selectionMatchCount(upper,{regionId:'r',start:1,end:15,text:'Recipient_Name'})).toBe(0);
    expect(()=>bindSelectedText(upper,{regionId:'r',start:1,end:15,text:'Recipient_Name'},newTemplateField('','field','Field'),false)).toThrow(/outside existing/);
    expect(bindSelectedText(upper,{regionId:'r',start:17,end:24,text:'Example'},newTemplateField('recipient_name','Recipient_Name','Supplier'),false).regions?.[0].text).toBe('{Recipient_Name} {Recipient_Name}');
  });

});
