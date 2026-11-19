import {contractRequest} from './contracts-api';
import type {Project,Supplier,SupplierDetails} from './supplier-types';
export type {Project,Supplier,SupplierDetails} from './supplier-types';
export type SupplierInput=Pick<Supplier,'supplierCode'|'companyName'|'registrationNumber'|'address'|'contact'>;
export type ProjectInput=Pick<Project,'projectCode'|'name'|'description'>;

export const suppliersApi={
  list:()=>contractRequest<{suppliers:Supplier[]}>('/suppliers'),
  detail:(id:string)=>contractRequest<{supplier:SupplierDetails}>(`/suppliers/${encodeURIComponent(id)}`),
  create:(input:SupplierInput,requestId:string)=>contractRequest<{supplier:Supplier}>('/suppliers',{...input,requestId}),
  update:(id:string,expectedVersion:number,input:SupplierInput)=>contractRequest<{supplier:Supplier}>(`/suppliers/${encodeURIComponent(id)}`,{...input,expectedVersion},'PATCH'),
  projects:()=>contractRequest<{projects:Project[]}>('/projects'),
  createProject:(input:ProjectInput,requestId:string)=>contractRequest<{project:Project}>('/projects',{...input,requestId}),
  updateProject:(id:string,expectedVersion:number,input:ProjectInput)=>contractRequest<{project:Project}>(`/projects/${encodeURIComponent(id)}`,{...input,expectedVersion},'PATCH'),
  linkRecord:(recordId:string,expectedVersion:number,supplierId:string|null)=>contractRequest<unknown>(`/records/${encodeURIComponent(recordId)}/supplier`,{expectedVersion,supplierId},'PATCH'),
};
