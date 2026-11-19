import {expandSupplierSelection} from './supplier-selection';
import {useEffect,useMemo,useState} from 'react';
import {Badge,Empty,Modal,SearchBox} from './components';
import {contractsApi,contractRequest} from './contracts-api';
import {NdaRepository} from './storage';
import type {NdaRecord} from './core';
import type {ContractListItem} from './contract-types';
import type {Supplier} from './supplier-types';


type Item={key:string;reference:string;name:string;kind:string;status:string;supplierId:string|null;document:boolean};
export function SupplierAssignmentDialog({supplier,suppliers,onClose,onAssigned}:{supplier:Supplier;suppliers:Supplier[];onClose:()=>void;onAssigned:()=>void}){
  const [records,setRecords]=useState<NdaRecord[]>([]);const [documents,setDocuments]=useState<ContractListItem[]>([]);
  const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [error,setError]=useState('');
  const [tab,setTab]=useState<'documents'|'agreements'>('documents');const [query,setQuery]=useState('');const [unassigned,setUnassigned]=useState(true);const [seeds,setSeeds]=useState(new Set<string>());
  const load=async()=>{setLoading(true);setError('');try{const [state,list]=await Promise.all([new NdaRepository().load(),contractsApi.list()]);setRecords(state.records);setDocuments(list.contracts);}catch(e){setError(e instanceof Error?e.message:'Items could not be loaded.');}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const expanded=useMemo(()=>expandSupplierSelection(records,documents,seeds),[records,documents,seeds]);
  const selectedKeys=new Set([...expanded.agreements.map(r=>`agreement:${r.id}`),...expanded.documents.map(d=>`document:${d.id}`)]);
  const all:Item[]=[...records.map(r=>({key:`agreement:${r.id}`,reference:r.reference??'',name:String(r.fields.Recipient||'Unnamed agreement'),kind:'Agreement',status:String(r.fields.Status),supplierId:r.supplierId??null,document:false})),...documents.map(d=>({key:`document:${d.id}`,reference:d.reference??'',name:d.values.recipient.name||'Unnamed draft',kind:d.documentType.toUpperCase(),status:d.status==='signed'?'Signed':'Draft',supplierId:d.supplierId,document:true}))];
  const candidates=all.filter(item=>(tab==='documents'?item.document:!item.document)&&(!unassigned||!item.supplierId)&&`${item.reference} ${item.name} ${item.kind} ${suppliers.find(s=>s.id===item.supplierId)?.supplierCode??''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const changes=all.filter(item=>selectedKeys.has(item.key)&&item.supplierId!==supplier.id);
  const reassigned=changes.filter(item=>!!item.supplierId).length;
  const tooMany=expanded.agreements.length>100||expanded.documents.length>100;
  const toggle=(key:string)=>setSeeds(old=>{const next=new Set(old);if(next.has(key))next.delete(key);else next.add(key);return next;});
  const submit=async()=>{if(!changes.length||tooMany)return;setSaving(true);setError('');try{await contractRequest(`/suppliers/${encodeURIComponent(supplier.id)}/assignments`,{agreements:expanded.agreements.map(r=>({id:r.id,expectedVersion:r.version})),documents:expanded.documents.map(d=>({id:d.id,expectedVersion:d.version}))});onAssigned();}catch(e){setError(e instanceof Error?e.message:'The assignment could not be saved.');}finally{setSaving(false);}};
  return <Modal title="Assign existing items" wide onClose={()=>!saving&&onClose()}><div className="dialog-body">
    <p className="dialog-intro">Group existing agreements and documents under <strong>{supplier.supplierCode} · {supplier.companyName}</strong>. Document content, files and reminder rules stay unchanged.</p>
    <div className="assignment-tabs" role="group" aria-label="Item category"><button className={tab==='documents'?'selected':''} aria-pressed={tab==='documents'} onClick={()=>setTab('documents')}>Documents ({documents.length})</button><button className={tab==='agreements'?'selected':''} aria-pressed={tab==='agreements'} onClick={()=>setTab('agreements')}>Agreements ({records.length})</button></div>
    <div className="assignment-tools"><SearchBox value={query} onChange={setQuery} placeholder="Search ID, company or supplier…"/><label><input type="checkbox" checked={unassigned} onChange={e=>setUnassigned(e.target.checked)}/>Unassigned only</label></div>
    {error&&<div className="notice error" role="alert">{error}<button className="text-button" disabled={saving} onClick={()=>{setSeeds(new Set());void load();}}>Reload items</button></div>}
    {loading?<p role="status">Loading agreements and documents…</p>:!candidates.length?<Empty title="No matching items">Clear the search or turn off Unassigned only to include items already assigned.</Empty>:<ul className="assignment-list">{candidates.map(item=>{const required=selectedKeys.has(item.key)&&!seeds.has(item.key);const current=suppliers.find(s=>s.id===item.supplierId);return <li key={item.key}><label><input type="checkbox" checked={selectedKeys.has(item.key)} disabled={saving||required} onChange={()=>toggle(item.key)}/><span><strong>{item.reference} · {item.name}</strong><small>{item.kind} · {item.status} · {current?`Current supplier: ${current.supplierCode}`:'Supplier not linked'}</small>{required&&<small>Included with its linked agreement/document</small>}</span></label></li>;})}</ul>}
    {!!selectedKeys.size&&<section className="assignment-review"><h3>Assignment review · {expanded.documents.length} documents / {expanded.agreements.length} agreements</h3><p>Linked documents and their tracking agreements move together. The full selection below will be assigned to {supplier.supplierCode}.</p><ul>{all.filter(item=>selectedKeys.has(item.key)).map(item=><li key={item.key}><span>{item.reference} · {item.name}</span><Badge tone={item.supplierId===supplier.id?'gray':'green'}>{item.supplierId===supplier.id?'Already linked':item.supplierId?'Move supplier':'Link'}</Badge></li>)}</ul>{reassigned>0&&<p className="error-text">{reassigned} items will move from their current supplier.</p>}<button className="text-button" disabled={saving} onClick={()=>setSeeds(new Set())}>Clear selection</button></section>}
    {tooMany&&<p role="alert" className="error-text">Assign up to 100 agreements and 100 documents at a time.</p>}
  </div><div className="dialog-actions"><button className="button secondary" disabled={saving} onClick={onClose}>Cancel</button><button className="button primary" disabled={loading||saving||!changes.length||tooMany} onClick={()=>void submit()}>{saving?'Assigning…':`Assign ${changes.length} items to ${supplier.supplierCode}`}</button></div></Modal>;
}
