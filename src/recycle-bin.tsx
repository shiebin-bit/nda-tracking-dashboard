import {useCallback,useEffect,useRef,useState} from 'react';
import {ArchiveRestore,RefreshCw,Trash2} from 'lucide-react';
import {Badge,Empty,SearchBox} from './components';
import {ApiError,NdaRepository} from './storage';
import {contractsApi} from './contracts-api';
import type {RecycleBin,RecycledContract,RecycledNdaRecord} from './recycle-types';

const repository=new NdaRepository();
const timestamp=(value:string)=>new Intl.DateTimeFormat('en-MY',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(value));
type Props={confirm:(message:string)=>Promise<boolean>;onRestoreAgreement:(record:RecycledNdaRecord,requestId:string)=>Promise<boolean>};

export function RecycleBinPage({confirm,onRestoreAgreement}:Props){
  const [data,setData]=useState<RecycleBin|null>(null);
  const [tab,setTab]=useState<'records'|'contracts'>('records');
  const [search,setSearch]=useState('');
  const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const requests=useRef(new Map<string,string>());
  const loadSequence=useRef(0);
  const load=useCallback(async()=>{const sequence=++loadSequence.current;try{const result=await repository.recycleBin();if(sequence!==loadSequence.current)return;setData(result);setError('');}catch(e){if(sequence===loadSequence.current)setError(e instanceof Error?e.message:'The recycle bin is temporarily unavailable.');}finally{if(sequence===loadSequence.current)setLoading(false);}},[]);
  useEffect(()=>{void load();return()=>{++loadSequence.current;};},[load]);
  useEffect(()=>{const refresh=()=>{if(!busy)void load();};window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[busy,load]);
  const restore=async(item:RecycledNdaRecord|RecycledContract)=>{
    const agreement='fields' in item;
    const name=agreement?String(item.fields.Recipient||'Unnamed agreement'):item.values.recipient.name||'Unnamed contract';
    const message=agreement
      ?`Restore ${name}? Its original ${String(item.fields.Status||'Pending')} status is kept. Pending agreements become eligible for future reminders under the saved rules.`
      :`Restore ${name}? Saved document versions and activity will be available again. Any linked tracking agreement keeps its current status.`;
    if(!await confirm(message))return;
    ++loadSequence.current;setBusy(true);setError('');setNotice('');
    const key=`${agreement?'record':'contract'}:${item.id}:${item.version}`;
    const requestId=requests.current.get(key)??crypto.randomUUID();requests.current.set(key,requestId);
    try{
      if(agreement){if(!await onRestoreAgreement(item,requestId)){await load();setError('The agreement could not be restored. Review the refreshed list and try again.');return;}}
      else await contractsApi.restore(item.id,item.version,requestId);
      requests.current.delete(key);setNotice(`${agreement?'Agreement':'Contract'} restored.`);await load();
    }catch(e){
      if(e instanceof ApiError&&['version_conflict','not_in_recycle_bin','renewal_parent_recycled'].includes(e.code))await load();
      setError(e instanceof ApiError&&e.code==='renewal_parent_recycled'?'Restore the previous agreement first, then restore this renewal.':e instanceof ApiError&&e.code==='version_conflict'?'This item changed in another window. Review the refreshed list and try again.':e instanceof Error?e.message:'Restore failed. Refresh the list and try again.');
    }
    finally{setBusy(false);}
  };
  const query=search.trim().toLowerCase();
  const records=(data?.records??[]).filter(r=>`${r.reference??''} ${r.fields.Recipient??''} ${r.fields.Discloser??''} ${r.fields.PIC??''} ${r.fields['No.']??''}`.toLowerCase().includes(query));
  const contracts=(data?.contracts??[]).filter(c=>`${c.reference??''} ${c.values.recipient.name} ${c.values.discloser.name} ${c.values.pic}`.toLowerCase().includes(query));
  const rows=tab==='records'?records:contracts;
  return <div className="recycle-workspace">
    <p className="recycle-explainer"><Trash2 size={18}/><span>Deleted items stay here until you restore them. Agreements in the recycle bin are excluded from future reminder checks. History and contract files are kept.</span></p>
    <section className="panel">
      <div className="recycle-tabs" role="group" aria-label="Recycled item type">
        <button className={tab==='records'?'selected':''} aria-pressed={tab==='records'} disabled={busy} onClick={()=>{setTab('records');setSearch('');}}>Agreements <span>{data?.records.length??'—'}</span></button>
        <button className={tab==='contracts'?'selected':''} aria-pressed={tab==='contracts'} disabled={busy} onClick={()=>{setTab('contracts');setSearch('');}}>Contracts <span>{data?.contracts.length??'—'}</span></button>
      </div>
      <div className="recycle-tools"><SearchBox value={search} onChange={setSearch} placeholder="Search deleted name, PIC or agreement number…"/><button className="button secondary" disabled={busy||loading} onClick={()=>{setLoading(true);void load();}}><RefreshCw size={16}/>Refresh</button></div>
      {error&&<div className="notice error recycle-feedback" role="alert">{error} <button className="text-button" disabled={busy} onClick={()=>void load()}>Try again</button></div>}
      {notice&&<p className="notice green recycle-feedback" role="status">{notice}</p>}
      {loading?<p className="recycle-loading" role="status">Loading recycle bin…</p>:!data?<Empty title="Recycle bin unavailable">Reconnect and refresh to view deleted items.</Empty>:!rows.length?<Empty title={query?'No matching items':`No deleted ${tab==='records'?'agreements':'contracts'}`}>{query?'Try another name or clear your search.':'Deleted items will appear here and can be restored individually.'}</Empty>:<ul className="recycle-list">{rows.map(item=>{
        const agreement='fields' in item;
        const name=agreement?String(item.fields.Recipient||'Unnamed agreement'):item.values.recipient.name||'Unnamed contract';
        return <li key={item.id}><div className="recycle-item-heading"><strong>{name}</strong><Badge tone="gray">{agreement?String(item.fields.Status||'Pending'):item.status==='signed'?'Signed':'Draft'}</Badge></div>
          <p>{agreement?`${item.reference||'Agreement'} · Excel #${String(item.fields['No.']??'—')} · PIC: ${String(item.fields.PIC||'Unassigned')}`:`${item.reference||'Document'} · PIC: ${item.values.pic||'Unassigned'}`}</p>
          <p className="recycle-item-meta">Deleted {timestamp(item.deletedAt)} MYT · {item.deletedBy}</p>
          {!agreement&&item.linkedNdaHistoricalId&&<small>The linked tracking agreement is managed separately.</small>}
          {agreement&&item.renewedFromId&&<small>Restore the previous agreement first if it is also in the recycle bin.</small>}
          <button className="button secondary recycle-restore" disabled={busy} aria-label={`Restore ${name}`} onClick={()=>void restore(item)}><ArchiveRestore size={16}/>{busy?'Working…':'Restore'}</button>
        </li>;
      })}</ul>}
      <div className="table-bottom"><span>{rows.length} {tab==='records'?'agreement':'contract'}{rows.length===1?'':'s'}{query?' matching your search':''}</span><span>Full database backups include the recycle bin.</span></div>
    </section>
    <p className="recycle-backup-note">NDA register JSON backups contain active agreements only. Restore agreements from this recycle bin before restoring an NDA register backup.</p>
  </div>;
}
