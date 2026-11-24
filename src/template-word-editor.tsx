import {useEffect,useState} from 'react';
import {Undo2} from 'lucide-react';
import type {TemplateEditorSnapshot,WordStructureOperation} from './contract-types';
import type {TextSelection} from './template-mapping';
import {deletionImpact,documentRegions,editDocumentRegion,type EditorRegion} from './template-structure';

export function WordTextEditor({snapshot,onChange,onMap,canUndo,onUndo,onEndEdit,confirm}:{snapshot:TemplateEditorSnapshot;onChange:(snapshot:TemplateEditorSnapshot,group?:string)=>void;onMap:(selection:TextSelection)=>void;canUndo:boolean;onUndo:()=>void;onEndEdit:()=>void;confirm:(message:string)=>Promise<boolean>}){
  const regions=documentRegions(snapshot);const [selection,setSelection]=useState<TextSelection|null>(null);
  useEffect(()=>setSelection(null),[snapshot]);
  const add=(operation:WordStructureOperation)=>onChange({...snapshot,wordOperations:[...snapshot.wordOperations??[],operation]});
  const remove=async(region:EditorRegion)=>{
    let operations=snapshot.wordOperations??[];let label='paragraph';
    if(region.operationId){operations=operations.filter(op=>op.id!==region.operationId);if(region.insertedRow)label='table row';}
    else if(region.rowId){label='table row';operations=operations.filter(op=>!(op.type==='insert-table-row'&&op.anchorRowId===region.rowId));operations=[...operations,{id:crypto.randomUUID(),type:'delete-table-row',targetRowId:region.rowId}];}
    else {operations=operations.filter(op=>!(op.type==='insert-paragraph'&&op.anchorId===region.id));operations=[...operations,{id:crypto.randomUUID(),type:'delete-paragraph',targetId:region.id}];}
    const next={...snapshot,wordOperations:operations};const impact=deletionImpact(snapshot,next);
    const message=`Delete this ${label}?${impact.removed.length?' Affected fields: '+impact.removed.join(', ')+'.':''}${impact.unused.length?' Their final occurrences will be removed, so these field definitions will also be removed: '+impact.unused.join(', ')+'.':''} Insertions anchored to it will also be removed. You can Undo before leaving the editor. Published versions are unchanged.`;
    if(await confirm(message))onChange({...next,fields:next.fields.filter(field=>!impact.unused.includes(field.key))});
  };
  const rowActions=(region:EditorRegion)=>{
    const row=snapshot.wordStructure?.rows.find(item=>item.id===region.rowId);if(!row)return null;
    const remaining=(snapshot.wordStructure?.rows??[]).filter(item=>item.tableId===row.tableId&&!item.readOnly&&!(snapshot.wordOperations??[]).some(op=>op.type==='delete-table-row'&&op.targetRowId===item.id)).length;
    return <div className="template-row-actions"><strong>Table row · {row.cellCount} cells</strong><div className="template-structure-actions"><button type="button" className="text-button" disabled={row.readOnly} title={row.reason} onClick={()=>add({id:crypto.randomUUID(),type:'insert-table-row',anchorRowId:row.id,position:'before',cells:Array(row.cellCount).fill('')})}>+ Row above</button><button type="button" className="text-button" disabled={row.readOnly} title={row.reason} onClick={()=>add({id:crypto.randomUUID(),type:'insert-table-row',anchorRowId:row.id,position:'after',cells:Array(row.cellCount).fill('')})}>+ Row below</button><button type="button" className="text-button danger" disabled={row.readOnly||remaining<=1} title={row.readOnly?row.reason:remaining<=1?'Keep at least one original editable row in this table.':undefined} onClick={()=>void remove(region)}>Delete row</button></div>{row.readOnly&&<small>{row.reason||'This row has a protected structure.'}</small>}</div>;
  };
  return <><div className="panel-heading"><div><h2>Document text</h2><p>Add or remove body paragraphs and simple table rows. Select text to set a field. Save and preview to check pagination.</p></div><button type="button" className="text-button" disabled={!canUndo} onClick={()=>{onUndo();setSelection(null);}}><Undo2 size={14}/>Undo edit</button></div><div className="template-region-list">{regions.map((region,index)=>{
    const firstInRow=region.rowId&&regions[index-1]?.rowId!==region.rowId;
    return <div className={`template-region ${region.readOnly?'readonly':''} ${region.operationId?'inserted':''}`} key={region.id}>
      {firstInRow&&!region.operationId&&rowActions(region)}
      {firstInRow&&region.insertedRow&&<div className="template-row-actions"><strong>New table row</strong><button type="button" className="text-button danger" onClick={()=>void remove(region)}>Remove new row</button></div>}
      <div className="template-region-heading"><label htmlFor={`region-${region.id}`}>{region.operationId?'New ':''}{region.kind==='table-cell'?'Table cell':'Paragraph'} {index+1}{region.readOnly?' · protected':''}</label>{!region.readOnly&&selection?.regionId===region.id&&<button type="button" className="button secondary" onMouseDown={e=>e.preventDefault()} onClick={()=>{const selected=selection;setSelection(null);onMap(selected);}}>Set as field</button>}</div>
      <textarea id={`region-${region.id}`} rows={Math.max(2,Math.min(7,Math.ceil(region.text.length/90)))} value={region.text} readOnly={region.readOnly} onBlur={onEndEdit} onSelect={event=>{const target=event.currentTarget;setSelection(!region.readOnly&&target.selectionEnd>target.selectionStart?{regionId:region.id,start:target.selectionStart,end:target.selectionEnd,text:target.value.slice(target.selectionStart,target.selectionEnd)}:null);}} onChange={e=>{setSelection(null);onChange(editDocumentRegion(snapshot,region.id,e.target.value),'region:'+region.id);}}/>
      {region.kind==='paragraph'&&(region.operationId?<button type="button" className="text-button danger" onClick={()=>void remove(region)}>Remove new paragraph</button>:<><div className="template-structure-actions"><button type="button" className="text-button" disabled={!region.structureEditable} title={region.structureReason} onClick={()=>add({id:crypto.randomUUID(),type:'insert-paragraph',anchorId:region.id,position:'before',text:''})}>+ Paragraph above</button><button type="button" className="text-button" disabled={!region.structureEditable} title={region.structureReason} onClick={()=>add({id:crypto.randomUUID(),type:'insert-paragraph',anchorId:region.id,position:'after',text:''})}>+ Paragraph below</button><button type="button" className="text-button danger" disabled={!region.structureEditable} title={region.structureReason} onClick={()=>void remove(region)}>Delete paragraph</button></div>{!region.structureEditable&&<small className="template-structure-reason">{region.structureReason||'Save and reopen to inspect structural editing support.'}</small>}</>)}
    </div>;
  })}</div></>;
}
