import { useEffect, useRef, type ReactNode } from 'react';
import { X, Search, Inbox, ChevronLeft, ChevronRight } from 'lucide-react';
import { derive, dateLabel, type NdaRecord } from './core';
import { phaseClasses, phaseNames } from './fields';

export function Modal({title,children,onClose,drawer=false,wide=false}:{title:string;children:ReactNode;onClose:()=>void;drawer?:boolean;wide?:boolean}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const el=ref.current!;el.showModal();return()=>el.close();},[]);
  return <dialog ref={ref} className={`dialog ${drawer?'drawer':''} ${wide?'wide':''}`} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}} aria-label={title}>
    <header className="dialog-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label={`Close ${title}`}><X size={21}/></button></header>{children}
  </dialog>;
}
export function Badge({children,tone='gray'}:{children:ReactNode;tone?:string}){return <span className={`badge ${tone}`}><i/>{children}</span>;}
export function StatusBadge({status}:{status:unknown}){return <Badge tone={status==='Resolved'?'green':'amber'}>{String(status||'Pending')}</Badge>;}
export function ExpiryBadge({record,today}:{record:NdaRecord;today:string}){const d=derive(record,today);return <Badge tone={phaseClasses[d.phase]}>{d.remainingDays===null?'Date missing':d.remainingDays<0?`${Math.abs(d.remainingDays)} days overdue`:d.remainingDays===0?'Due today':`${d.remainingDays} days left`}</Badge>;}
export function Empty({title,children}:{title:string;children?:ReactNode}){return <div className="empty"><Inbox size={34}/><h3>{title}</h3><p>{children}</p></div>;}
export function SearchBox({value,onChange,placeholder='Search company, PIC or agreement…'}:{value:string;onChange:(s:string)=>void;placeholder?:string}){return <div className="search"><Search size={17}/><input aria-label="Search records" placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)}/>{value&&<button className="icon-button" aria-label="Clear search" onClick={()=>onChange('')}><X size={15}/></button>}</div>;}
export function RecordTable({records,today,onOpen}:{records:NdaRecord[];today:string;onOpen:(r:NdaRecord)=>void}){
  const [page,setPage]=usePager(records);
  const count=Math.max(1,Math.ceil(records.length/8));const current=Math.min(page,count-1);
  return <>{records.length===0?<Empty title="No matching agreements">Try another search or clear the filters.</Empty>:<div className="table-scroll"><table className="record-table"><thead><tr><th>Recipient / company</th><th>PIC</th><th>Agreement date</th><th>Expires on</th><th>Remaining days</th><th>Follow-up</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{records.slice(current*8,current*8+8).map(r=><tr key={r.id}><td><button className="record-link" onClick={()=>onOpen(r)}><span className="company-symbol">{String(r.fields.Recipient||'?').split(' ').map(s=>s[0]).slice(0,2).join('')}</span><span><strong>{String(r.fields.Recipient||'Unnamed recipient')}</strong><small>{String(r.fields.Department||'No department')} <span className="source-number">· #{String(r.fields['No.']??'—')}</span></small></span></button></td><td>{String(r.fields.PIC||'—')}</td><td>{dateLabel(String(r.fields['Date of Agreement']||''))}</td><td>{dateLabel(derive(r,today).expiryDate)}</td><td><ExpiryBadge record={r} today={today}/></td><td><StatusBadge status={r.fields.Status}/></td><td><button className="icon-button" aria-label={`View ${r.fields.Recipient}`} onClick={()=>onOpen(r)}><ChevronRight size={18}/></button></td></tr>)}</tbody></table></div>}
    <div className="table-bottom"><span>{records.length?`${current*8+1}–${Math.min((current+1)*8,records.length)} of ${records.length} agreements`:'0 agreements'}</span><div className="pagination"><button className="icon-button" disabled={current===0} aria-label="Previous page" onClick={()=>setPage(current-1)}><ChevronLeft size={17}/></button><span>{current+1} / {count}</span><button className="icon-button" disabled={current+1>=count} aria-label="Next page" onClick={()=>setPage(current+1)}><ChevronRight size={17}/></button></div></div>
  </>;
}
import {useState} from 'react';
function usePager(records:NdaRecord[]):[number,(n:number)=>void]{const [page,setPage]=useState(0);useEffect(()=>setPage(0),[records]);return [page,setPage];}
export function StageName({record,today}:{record:NdaRecord;today:string}){const d=derive(record,today);return <Badge tone={phaseClasses[d.phase]}>{phaseNames[d.phase]}</Badge>;}
export function download(name:string,data:string,type='application/json'){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
