import {ApiError} from './storage';
import type {Contract,ContractDetails,ContractListItem,ContractTemplate,ContractValues,DocumentJob,ImportPreflightRow,SignedFileSummary} from './contract-types';
import type {RecycledContract} from './recycle-types';

export class ContractApiError extends ApiError {
  constructor(message:string,status:number,code:string|undefined,readonly details:unknown){super(message,status,code);}
}
export type TrackingDifference={field:string;expected:unknown;actual:unknown};
export function trackingDifferences(error:unknown):TrackingDifference[]{
  if(!(error instanceof ContractApiError)||error.code!=='tracking_mismatch')return [];
  const fields=(error.details as {fields?:unknown}|undefined)?.fields;
  return Array.isArray(fields)?fields.filter((item):item is TrackingDifference=>!!item&&typeof item==='object'&&typeof item.field==='string'):[];
}

export async function contractRequest<T>(path:string,body?:unknown,method=body?'POST':'GET'):Promise<T>{
  const response=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new ContractApiError(data?.error?.message||`Request failed (${response.status}).`,response.status,data?.error?.code,data?.error?.details);
  return data as T;
}
export const contractsApi={
  list:()=>contractRequest<{contracts:ContractListItem[]}>('/contracts'),
  templates:()=>contractRequest<{templates:ContractTemplate[]}>('/contract-templates'),
  detail:(id:string)=>contractRequest<{contract:ContractDetails}>(`/contracts/${id}`),
  recycle:(id:string,expectedVersion:number,requestId:string)=>contractRequest<{contract:RecycledContract}>(`/contracts/${id}`,{expectedVersion,requestId},'DELETE'),
  restore:(id:string,expectedVersion:number,requestId:string)=>contractRequest<{contract:Contract}>(`/recycle-bin/contracts/${id}/restore`,{expectedVersion,requestId}),
  create:(values:ContractValues,requestId:string)=>contractRequest<{contract:Contract}>('/contracts',{values,requestId}),
  update:(id:string,expectedVersion:number,values:ContractValues)=>contractRequest<{contract:Contract}>(`/contracts/${id}`,{expectedVersion,values},'PATCH'),
  duplicate:(id:string,requestId:string)=>contractRequest<{contract:Contract}>(`/contracts/${id}/duplicate`,{requestId}),
  fromRecord:(id:string,requestId:string)=>contractRequest<{contract:Contract}>(`/records/${id}/contract-draft`,{requestId}),
  refresh:(id:string,expectedVersion:number,requestId:string)=>contractRequest<{contract:Contract}>(`/contracts/${id}/refresh-from-record`,{expectedVersion,requestId}),
  generate:(id:string,expectedVersion:number,requestId:string)=>contractRequest<{job:DocumentJob}>(`/contracts/${id}/generations`,{expectedVersion,requestId}),
  batch:(contracts:{id:string;expectedVersion:number}[],requestId:string)=>contractRequest<{job:DocumentJob}>('/document-jobs/batch',{contracts,requestId}),
  jobs:()=>contractRequest<{jobs:DocumentJob[]}>('/document-jobs'),
  job:(id:string)=>contractRequest<{job:DocumentJob}>(`/document-jobs/${id}`),
  retry:(id:string,requestId:string)=>contractRequest<{job:DocumentJob}>(`/document-jobs/${id}/retry`,{requestId}),
  preflight:(rows:{rowNumber:number;values:ContractValues}[])=>contractRequest<{rows:ImportPreflightRow[]}>('/contracts/imports/preflight',{rows}),
  import:(rows:{rowNumber:number;values:ContractValues}[],requestId:string)=>contractRequest<{contracts:Contract[]}>('/contracts/imports',{rows,requestId}),
  uploadSigned:async(id:string,expectedVersion:number,versionId:string,file:File,requestId:string)=>{
    const form=new FormData();form.append('requestId',requestId);form.append('expectedVersion',String(expectedVersion));form.append('versionId',versionId);
    form.append('file',file.type?file:new File([file],file.name,{type:'application/pdf',lastModified:file.lastModified}));
    const response=await fetch(`/api/contracts/${encodeURIComponent(id)}/signed-files`,{method:'POST',credentials:'same-origin',body:form});
    const data=await response.json().catch(()=>null);
    if(!response.ok)throw new ContractApiError(data?.error?.message||`Upload failed (${response.status}).`,response.status,data?.error?.code,data?.error?.details);
    return data as {contract:Contract;signedFile:SignedFileSummary};
  },
  sign:(id:string,body:{requestId:string;expectedVersion:number;versionId:string;signedFileId:string;agreementDate:string;pic:string})=>contractRequest<{contract:Contract;recordId:string;revision:string}>(`/contracts/${id}/confirm-signed`,body),
};
export const artifactUrl=(id:string,download=false)=>`/api/document-artifacts/${encodeURIComponent(id)}/content${download?'?download=1':''}`;
export const signedFileUrl=(id:string,download=false)=>`/api/contract-signed-files/${encodeURIComponent(id)}/content${download?'?download=1':''}`;
