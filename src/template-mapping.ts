import type {TemplateEditorSnapshot,TemplateFieldDefinition} from './contract-types';
import {documentRegions,editDocumentRegion} from './template-structure';

export interface TextSelection {regionId:string;start:number;end:number;text:string}
const tagPattern=/\{([a-z][a-z0-9_]{0,63})\}/gi;
export function fieldLocations(snapshot:TemplateEditorSnapshot){
  const result=new Map<string,{regionId:string;label:string;readOnly:boolean}[]>();
  for(const [index,region] of documentRegions(snapshot).entries()){
    for(const match of region.text.matchAll(tagPattern)){
      const list=result.get(match[1])??[];list.push({regionId:region.id,label:`${region.kind==='table-cell'?'Table cell':'Paragraph'} ${index+1}`,readOnly:region.readOnly});result.set(match[1],list);
    }
  }
  for(const placement of snapshot.placements??[]){const list=result.get(placement.field)??[];list.push({regionId:`page-${placement.page}`,label:`Page ${placement.page}`,readOnly:false});result.set(placement.field,list);}
  return result;
}
function matchesOutsideTags(text:string,needle:string):number[]{
  if(!needle)return [];
  const tags=[...text.matchAll(tagPattern)].map(match=>({start:match.index,end:match.index+match[0].length}));
  const positions:number[]=[];let from=0;
  while(from<=text.length-needle.length){const at=text.indexOf(needle,from);if(at<0)break;if(!tags.some(tag=>at<tag.end&&at+needle.length>tag.start))positions.push(at);from=at+needle.length;}
  return positions;
}
export function selectionMatchCount(snapshot:TemplateEditorSnapshot,selection:TextSelection):number{
  return documentRegions(snapshot).filter(region=>!region.readOnly).reduce((count,region)=>count+matchesOutsideTags(region.text,selection.text).length,0);
}
export function bindSelectedText(snapshot:TemplateEditorSnapshot,selection:TextSelection,field:TemplateFieldDefinition,all:boolean):TemplateEditorSnapshot{
  const region=documentRegions(snapshot).find(item=>item.id===selection.regionId);
  if(!region||region.readOnly||!selection.text.trim()||selection.start<0||selection.end<=selection.start||region.text.slice(selection.start,selection.end)!==selection.text)throw new Error('This selection has changed or is protected. Select the text again.');
  if(!matchesOutsideTags(region.text,selection.text).includes(selection.start))throw new Error('Select ordinary document text, outside existing field placeholders.');
  if(!/^[a-z][a-z0-9_]{0,63}$/i.test(field.key))throw new Error('Choose a valid field key.');
  let next=structuredClone(snapshot);
  for(const item of documentRegions(snapshot)){
    if(item.readOnly||(!all&&item.id!==selection.regionId))continue;
    const positions=all?matchesOutsideTags(item.text,selection.text):[selection.start];let text=item.text;
    for(const at of positions.reverse())text=text.slice(0,at)+`{${field.key}}`+text.slice(at+selection.text.length);
    next=editDocumentRegion(next,item.id,text);
  }
  const fields=snapshot.fields.some(item=>item.key===field.key)?snapshot.fields.map(item=>item.key===field.key?structuredClone(field):structuredClone(item)):[...structuredClone(snapshot.fields),structuredClone(field)];
  return {...next,fields};
}
export function newTemplateField(source:string,key:string,label:string,eoi=false):TemplateFieldDefinition{
  return {key,label,type:/date/.test(source)?'date':source==='duration'?'number':'text',required:false,source:source||null,...(eoi&&['recipient_name','project_name'].includes(source)?{appearance:{fontWeight:'bold' as const}}:{})};
}
export function bindPlaceholder(snapshot:TemplateEditorSnapshot,key:string,field:TemplateFieldDefinition):TemplateEditorSnapshot{
  let next=structuredClone(snapshot);
  for(const region of documentRegions(snapshot))if(!region.readOnly&&region.text.includes(`{${key}}`))next=editDocumentRegion(next,region.id,region.text.split(`{${key}}`).join(`{${field.key}}`));
  if(next.placements)next.placements=next.placements.map(item=>item.field===key?{...item,field:field.key}:item);
  if(!next.fields.some(item=>item.key===field.key))next.fields.push(structuredClone(field));
  return next;
}
