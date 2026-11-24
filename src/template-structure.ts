import type {TemplateEditorSnapshot,WordStructureOperation} from './contract-types';

export type EditorRegion=NonNullable<TemplateEditorSnapshot['regions']>[number]&{operationId?:string;insertedRow?:boolean};
export function documentRegions(snapshot:TemplateEditorSnapshot):EditorRegion[]{
  const operations=snapshot.wordOperations??[];const rows=snapshot.wordStructure?.rows??[];
  const result:EditorRegion[]=[];
  const inserted=(op:WordStructureOperation)=>{
    if(op.type==='insert-paragraph')result.push({id:`op:${op.id}`,kind:'paragraph',text:op.text,readOnly:false,operationId:op.id});
    if(op.type==='insert-table-row')op.cells.forEach((text,index)=>result.push({id:`op:${op.id}:cell:${index}`,kind:'table-cell',text,readOnly:false,rowId:`op:${op.id}`,cellIndex:index,operationId:op.id,insertedRow:true}));
  };
  for(const region of snapshot.regions??[]){
    const row=rows.find(item=>item.id===region.rowId);
    for(const op of operations)if((op.type==='insert-paragraph'&&op.anchorId===region.id&&op.position==='before')||(op.type==='insert-table-row'&&op.anchorRowId===row?.id&&row.regionIds[0]===region.id&&op.position==='before'))inserted(op);
    const deleted=operations.some(op=>(op.type==='delete-paragraph'&&op.targetId===region.id)||(op.type==='delete-table-row'&&op.targetRowId===region.rowId));
    if(!deleted)result.push(region);
    for(const op of operations)if((op.type==='insert-paragraph'&&op.anchorId===region.id&&op.position==='after')||(op.type==='insert-table-row'&&op.anchorRowId===row?.id&&row.regionIds.at(-1)===region.id&&op.position==='after'))inserted(op);
  }
  return result;
}
export function editDocumentRegion(snapshot:TemplateEditorSnapshot,id:string,text:string):TemplateEditorSnapshot{
  const region=documentRegions(snapshot).find(item=>item.id===id);
  if(!region||region.readOnly)throw new Error('This text is protected or no longer available.');
  if(!region.operationId)return {...snapshot,regions:snapshot.regions?.map(item=>item.id===id?{...item,text}:item)};
  return {...snapshot,wordOperations:snapshot.wordOperations?.map(op=>{
    if(op.id!==region.operationId)return op;
    if(op.type==='insert-paragraph')return {...op,text};
    if(op.type==='insert-table-row')return {...op,cells:op.cells.map((cell,index)=>index===region.cellIndex?text:cell)};
    return op;
  })};
}
export function deletionImpact(before:TemplateEditorSnapshot,after:TemplateEditorSnapshot){
  const tags=(snapshot:TemplateEditorSnapshot)=>documentRegions(snapshot).flatMap(region=>[...region.text.matchAll(/\{([a-z][a-z0-9_]{0,63})\}/gi)].map(match=>match[1]));
  const previous=tags(before),next=tags(after);const removed=[...new Set(previous)].filter(key=>previous.filter(item=>item===key).length>next.filter(item=>item===key).length);
  const unused=removed.filter(key=>!next.includes(key));return {removed,unused};
}
