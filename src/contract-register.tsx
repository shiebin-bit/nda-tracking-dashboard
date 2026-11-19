import {FileText, Upload} from 'lucide-react';
import {Badge, Empty, SearchBox} from './components';
import type {ContractListItem, DocumentJob} from './contract-types';
import type {Project,Supplier} from './supplier-types';
import {contractStages, getContractProgress, matchesContractFilters, runningContractJob, type ContractProgress} from './contract-workflow';

const time=(value:string)=>new Intl.DateTimeFormat('en-MY',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(value));
interface Props {
  contracts:ContractListItem[]; jobs:DocumentJob[]; loading:boolean; busy:boolean;
  search:string; status:string; stage:string; pic:string; documentType:string; supplier:string; project:string; selected:string[]; suppliers:Supplier[]; projects:Project[];
  onSearch:(value:string)=>void; onStatus:(value:string)=>void; onStage:(value:string)=>void; onPic:(value:string)=>void; onDocumentType:(value:string)=>void; onSupplier:(value:string)=>void; onProject:(value:string)=>void;
  onSelected:(value:string[])=>void; onOpen:(contract:ContractListItem)=>void;
  onNext:(contract:ContractListItem,progress:ContractProgress)=>void; onUpload:(contract:ContractListItem)=>void; onBatch:()=>void;
}

export function ContractRegister(props:Props) {
  const {contracts,jobs,busy,loading,search,status,stage,pic,documentType,supplier,project,selected,suppliers,projects,onSearch,onStatus,onStage,onPic,onDocumentType,onSupplier,onProject,onSelected,onOpen,onNext,onUpload,onBatch}=props;
  const rows=contracts.map(contract=>({contract,progress:getContractProgress(contract,contract.latestGeneration,!!runningContractJob(jobs,contract.id))}));
  const filtered=rows.filter(({contract,progress})=>matchesContractFilters(contract,progress,{search,status,stage,pic})&&(documentType==='all'||contract.documentType===documentType)&&(supplier==='all'||(supplier==='unlinked'?!contract.supplierId:contract.supplierId===supplier))&&(project==='all'||(project==='unlinked'?!contract.projectId:contract.projectId===project)));
  const selectable=filtered.filter(({contract})=>contract.status==='draft').map(({contract})=>contract.id);
  const pics=Array.from(new Set(contracts.map(c=>c.values.pic.trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
  // Keep a selected PIC available even if a refresh removes the last matching record.
  if(pic.startsWith('pic:')&&!pics.includes(pic.slice(4)))pics.push(pic.slice(4));
  const toggle=(id:string,checked:boolean)=>onSelected(checked?Array.from(new Set([...selected,id])):selected.filter(value=>value!==id));
  const clearFilters=()=>{onSearch('');onStatus('all');onStage('all');onPic('all');onDocumentType('all');onSupplier('all');onProject('all');};
  const next=({contract,progress}:{contract:ContractListItem;progress:ContractProgress})=><button className="button secondary contract-next-button" disabled={busy} onClick={()=>onNext(contract,progress)}>{progress.action==='upload'&&<Upload size={15}/>}<span>{progress.action==='generate'?'Review & generate':progress.actionLabel}</span></button>;
  return <>
    <div className="contract-list-tools">
      <SearchBox value={search} onChange={onSearch} placeholder="Search document ID, client or PIC…"/>
      <div className="contract-list-filters">
        <label>Status<select aria-label="Filter contract status" value={status} onChange={e=>onStatus(e.target.value)}><option value="all">All statuses</option><option value="draft">Drafts</option><option value="signed">Signed</option></select></label>
        <label>Stage<select aria-label="Filter contract stage" value={stage} onChange={e=>onStage(e.target.value)}><option value="all">All stages</option>{contractStages.map(s=><option key={s.value} value={s.value}>{s.label} ({rows.filter(r=>r.progress.stage===s.value).length})</option>)}</select></label>
        <label>PIC<select aria-label="Filter contract PIC" value={pic} onChange={e=>onPic(e.target.value)}><option value="all">All PICs</option><option value="unassigned">Unassigned</option>{pics.map(name=><option key={name} value={`pic:${name}`}>{name}</option>)}</select></label>
        <label>Type<select aria-label="Filter document type" value={documentType} onChange={e=>onDocumentType(e.target.value)}><option value="all">NDA & EOI</option><option value="nda">NDA</option><option value="eoi">EOI</option></select></label>
        <label>Supplier<select aria-label="Filter supplier" value={supplier} onChange={e=>onSupplier(e.target.value)}><option value="all">All suppliers</option><option value="unlinked">Not linked</option>{suppliers.map(item=><option key={item.id} value={item.id}>{item.supplierCode} · {item.companyName}</option>)}</select></label>
        <label>Project<select aria-label="Filter project" value={project} onChange={e=>onProject(e.target.value)}><option value="all">All projects</option><option value="unlinked">No project</option>{projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
    </div>
    <div className="contract-selection-bar"><label><input type="checkbox" aria-label="Select all matching contracts" disabled={busy||!selectable.length} checked={!!selectable.length&&selectable.every(id=>selected.includes(id))} ref={el=>{if(el)el.indeterminate=selectable.some(id=>selected.includes(id))&&!selectable.every(id=>selected.includes(id));}} onChange={e=>onSelected(e.target.checked?Array.from(new Set([...selected,...selectable])):selected.filter(id=>!selectable.includes(id)))}/><span>{filtered.length} of {contracts.length} contracts</span></label><div><span>{selected.length} selected{selected.some(id=>!filtered.some(r=>r.contract.id===id))?' · includes hidden contracts':''}</span>{selected.length>0&&<button className="text-button" onClick={()=>onSelected([])}>Clear selection</button>}<button className="button secondary" disabled={busy||!selected.length||selected.length>100} onClick={onBatch}><FileText size={15}/>Generate selected ({selected.length})</button></div>{selected.length>100&&<p className="error-text" role="status">Select up to 100 contracts per batch.</p>}</div>
    {loading?<p className="contract-loading" role="status">Loading contracts…</p>:!filtered.length?<Empty title={contracts.length?'No matching contracts':'Your first contract starts here'}>{contracts.length?<><span>Try another search, stage or PIC.</span> <button className="text-button" onClick={clearFilters}>Clear filters</button></>:'Add a client, review the FFM details and generate the agreement.'}</Empty>:<>
      <div className="table-scroll contract-desktop-register" tabIndex={0} role="region" aria-label="Contract list; scroll horizontally for more columns">
        <table className="record-table contract-table contract-list-table"><thead><tr><th scope="col">Select</th><th scope="col">Document / supplier</th><th scope="col">Stage</th><th scope="col">Purpose</th><th scope="col">Updated · Malaysia time</th><th scope="col">Tracking</th><th scope="col">Next step</th></tr></thead><tbody>{filtered.map(row=>{const {contract:c,progress}=row;return <tr key={c.id}>
          <td><input type="checkbox" aria-label={`Select ${c.values.recipient.name||'unnamed draft'}`} disabled={busy||c.status==='signed'} checked={selected.includes(c.id)} onChange={e=>toggle(c.id,e.target.checked)}/></td>
          <td><button className="record-link" disabled={busy} onClick={()=>onOpen(c)}><span><strong>{c.documentType.toUpperCase()} · {c.values.recipient.name||'Unnamed draft'}</strong><small>{c.reference} · {suppliers.find(s=>s.id===c.supplierId)?.supplierCode||'Supplier not linked'}{c.projectId?` · ${projects.find(p=>p.id===c.projectId)?.name||'Project'}`:''}</small></span></button></td>
          <td><Badge tone={progress.tone}>{progress.label}</Badge></td><td><span className="contract-purpose" title={c.values.purpose}>{c.values.purpose||'Not filled in'}</span></td><td>{time(c.updatedAt)}</td><td>{c.linkedNdaId?'Linked':c.linkedNdaHistoricalId?'Record unavailable':'Not tracking'}</td>
          <td>{next(row)}{c.currentSignedFileId&&progress.action!=='view'&&<button className="text-button contract-secondary-action" disabled={busy} onClick={()=>onOpen(c)}>View signed copy</button>}{progress.action==='generate'&&<button className="text-button contract-secondary-action" disabled={busy} onClick={()=>onUpload(c)}>Upload signed copy</button>}</td>
        </tr>;})}</tbody></table>
      </div>
      <ul className="contract-mobile-register" aria-label="Contracts">{filtered.map(row=>{const {contract:c,progress}=row;return <li key={c.id}>
        <div className="contract-mobile-title"><input type="checkbox" aria-label={`Select ${c.values.recipient.name||'unnamed draft'}`} disabled={busy||c.status==='signed'} checked={selected.includes(c.id)} onChange={e=>toggle(c.id,e.target.checked)}/><button className="record-link" disabled={busy} onClick={()=>onOpen(c)}><strong>{c.documentType.toUpperCase()} · {c.values.recipient.name||'Unnamed draft'}</strong></button></div>
        <small className="document-reference">{c.reference} · {suppliers.find(s=>s.id===c.supplierId)?.supplierCode||'Supplier not linked'}</small><Badge tone={progress.tone}>{progress.label}</Badge><p className="contract-mobile-purpose">{c.values.purpose||'Purpose not filled in'}</p><dl><div><dt>PIC</dt><dd>{c.values.pic||'Not assigned'}</dd></div><div><dt>Tracking</dt><dd>{c.linkedNdaId?'Linked':c.linkedNdaHistoricalId?'Record unavailable':'Not tracking'}</dd></div><div className="contract-mobile-updated"><dt>Updated · Malaysia time</dt><dd>{time(c.updatedAt)}</dd></div></dl>
        <div className="contract-mobile-actions">{next(row)}<button className="text-button" disabled={busy} onClick={()=>onOpen(c)}>Open contract</button>{progress.action==='generate'&&<button className="text-button" disabled={busy} onClick={()=>onUpload(c)}>Upload signed copy</button>}</div>
      </li>;})}</ul>
    </>}
  </>;
}
