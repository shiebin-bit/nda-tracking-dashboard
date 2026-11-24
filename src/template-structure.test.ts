import {describe,expect,it} from 'vitest';
import type {TemplateEditorSnapshot} from './contract-types';
import {deletionImpact,documentRegions,editDocumentRegion} from './template-structure';
import {bindSelectedText,fieldLocations,newTemplateField,selectionMatchCount} from './template-mapping';

const base:TemplateEditorSnapshot={format:'docx',fields:[newTemplateField('','client','Client')],regions:[{id:'r1',kind:'paragraph',text:'{client}',readOnly:false},{id:'r2',kind:'table-cell',text:'Existing',readOnly:false,rowId:'row1',cellIndex:0},{id:'r3',kind:'table-cell',text:'Cell',readOnly:false,rowId:'row1',cellIndex:1}],wordStructure:{rows:[{id:'row1',tableId:'table1',regionIds:['r2','r3'],cellCount:2,readOnly:false}]}};
describe('Word structure editor view',()=>{
  it('shows inserted paragraphs and complete rows in source order, hiding deleted source text',()=>{
    const snapshot={...base,wordOperations:[{id:'p',type:'insert-paragraph' as const,anchorId:'r1',position:'after' as const,text:'New paragraph'},{id:'row',type:'insert-table-row' as const,anchorRowId:'row1',position:'before' as const,cells:['A','B']},{id:'delete',type:'delete-table-row' as const,targetRowId:'row1'}]};
    expect(documentRegions(snapshot).map(item=>item.text)).toEqual(['{client}','New paragraph','A','B']);
    expect(editDocumentRegion(snapshot,'op:row:cell:1','Changed').wordOperations?.[1]).toMatchObject({cells:['A','Changed']});
    expect(snapshot.wordOperations[1]).toMatchObject({cells:['A','B']});
  });
  it('maps and counts fields in inserted text, excluding deleted paragraphs',()=>{
    const snapshot={...base,wordOperations:[{id:'p',type:'insert-paragraph' as const,anchorId:'r1',position:'after' as const,text:'Example Example'},{id:'del',type:'delete-paragraph' as const,targetId:'r1'}]};
    const selected={regionId:'op:p',start:0,end:7,text:'Example'};
    expect(selectionMatchCount(snapshot,selected)).toBe(2);
    const mapped=bindSelectedText(snapshot,selected,newTemplateField('','new_name','New name'),true);
    expect(mapped.wordOperations?.[0]).toMatchObject({text:'{new_name} {new_name}'});
    expect(fieldLocations(mapped).has('client')).toBe(false);expect(fieldLocations(mapped).get('new_name')).toHaveLength(2);
  });
  it('reports last field occurrences for atomic deletion and undo without changing the source',()=>{
    const before=structuredClone(base);const after={...before,wordOperations:[{id:'del',type:'delete-paragraph' as const,targetId:'r1'}]};
    expect(deletionImpact(before,after)).toEqual({removed:['client'],unused:['client']});
    expect(documentRegions(before)[0].text).toBe('{client}');
    const repeated={...base,regions:[...base.regions!,{id:'r4',kind:'paragraph' as const,text:'Also {client}',readOnly:false}]};
    expect(deletionImpact(repeated,{...repeated,wordOperations:after.wordOperations})).toEqual({removed:['client'],unused:[]});
  });
});
