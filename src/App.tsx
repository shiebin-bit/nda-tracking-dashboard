import {useEffect,useState,useCallback,useRef} from 'react';
import {LayoutDashboard,Plus,History,Settings2,PanelLeftClose,Menu,FileSpreadsheet,ChevronRight,Check,Mail,AlertTriangle,X,Database,Files,Trash2,Building2,LayoutTemplate} from 'lucide-react';
import {NdaRepository,ApiError} from './storage';
import {todayMY,dateLabel,derive,getCandidates,createEmptyFields,type Snapshot,type NdaRecord,type Fields} from './core';
import {Overview,InputPage,HistoryPage,SettingsPage} from './pages';
import {ImportDialog,DetailDrawer,EmailPreview} from './dialogs';
import {download,Modal} from './components';
import {ContractsPage} from './contracts';
import {RecycleBinPage} from './recycle-bin';
import {SuppliersPage} from './suppliers';
import {TemplatesPage} from './templates';

const repo=new NdaRepository();
const loadArchives=()=>repo.listArchives();
type Page='overview'|'contracts'|'suppliers'|'templates'|'input'|'history'|'settings'|'recycle';
const nav=[{id:'overview' as Page,label:'Overview',icon:LayoutDashboard},{id:'contracts' as Page,label:'Documents',icon:Files},{id:'suppliers' as Page,label:'Suppliers',icon:Building2},{id:'templates' as Page,label:'Templates',icon:LayoutTemplate},{id:'input' as Page,label:'Input',icon:Plus},{id:'history' as Page,label:'History',icon:History},{id:'settings' as Page,label:'Settings',icon:Settings2},{id:'recycle' as Page,label:'Recycle bin',icon:Trash2}];
export interface Editor {record?:NdaRecord;renewal?:boolean;key:number;}
export function App(){
  const [data,setData]=useState<Snapshot|null>(null);const [fatal,setFatal]=useState('');const [page,setPage]=useState<Page>('overview');
  const [today,setToday]=useState(()=>todayMY());const [busy,setBusy]=useState(false);const [toast,setToast]=useState<{text:string;error?:boolean}|null>(null);
  const [editor,setEditor]=useState<Editor>({key:0});const [dirty,setDirty]=useState(false);
  const [noteDirty,setNoteDirty]=useState(false);
  const [detail,setDetail]=useState<string|null>(null);const [showImport,setShowImport]=useState(false);const [preview,setPreview]=useState(false);
  const [contractTarget,setContractTarget]=useState<string|null>(null);
  const [collapsed,setCollapsed]=useState(false);const [mobile,setMobile]=useState(false);
  const [settingsRevision,setSettingsRevision]=useState(0);
  const [settingsSection,setSettingsSection]=useState<'email'|null>(null);
  const [confirmation,setConfirmation]=useState<{message:string;resolve:(answer:boolean)=>void}|null>(null);
  const snapshotRequest=useRef(0);
  const recycleRequests=useRef(new Map<string,string>());
  const confirmAction=(message:string)=>new Promise<boolean>(resolve=>setConfirmation({message,resolve}));
  const finishConfirmation=(answer:boolean)=>{confirmation?.resolve(answer);setConfirmation(null);};
  const activityRef=useRef({dirty:dirty||noteDirty,busy});activityRef.current={dirty:dirty||noteDirty,busy};
  const load=useCallback(()=>{const request=++snapshotRequest.current;return repo.load().then(snapshot=>{if(request===snapshotRequest.current&&!activityRef.current.dirty&&!activityRef.current.busy){setData(snapshot);setFatal('');}}).catch(e=>{if(request===snapshotRequest.current)setFatal(e.message||'The database could not be reached.');});},[]);
  useEffect(()=>{void load();const tick=()=>setToday(todayMY());const refresh=()=>{tick();if(!document.hidden&&!activityRef.current.dirty&&!activityRef.current.busy)void load();};const id=window.setInterval(tick,30000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(id);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};},[load]);
  useEffect(()=>{if(!toast)return;const id=setTimeout(()=>setToast(null),6000);return()=>clearTimeout(id);},[toast]);
  useEffect(()=>{if(!dirty)return;const handler=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[dirty]);
  useEffect(()=>{if(page!=='settings'||settingsSection!=='email')return;const section=document.getElementById('email-sending-records');if(section){section.scrollIntoView({block:'start'});section.focus({preventScroll:true});setSettingsSection(null);}},[page,settingsSection]);
  const navigate=async(p:Page)=>{if((dirty||noteDirty)&&!await confirmAction('Leave this form and discard unsaved changes?'))return;setDirty(false);setNoteDirty(false);setDetail(null);setPage(p);setMobile(false);if(p==='input')setEditor({key:Date.now()});window.scrollTo(0,0);};
  const openEditor=async(record?:NdaRecord,renewal=false)=>{if(dirty&&!await confirmAction('Discard unsaved changes?'))return;setDirty(false);setNoteDirty(false);setDetail(null);setEditor({record,renewal,key:Date.now()});setPage('input');setMobile(false);window.scrollTo(0,0);};
  const perform=async(task:()=>Promise<Snapshot>,message:string,conflictRecordId?:string,propagateError=false):Promise<boolean>=>{++snapshotRequest.current;setBusy(true);try{const snapshot=await task();++snapshotRequest.current;setData(snapshot);setFatal('');setToast({text:message});return true;}catch(e){if(propagateError)throw e;let text=e instanceof Error?e.message:'The change could not be saved.';if(conflictRecordId&&e instanceof ApiError&&e.code==='version_conflict'){try{const latest=await repo.load();if(latest.records.some(record=>record.id===conflictRecordId)){++snapshotRequest.current;setData(latest);text='This agreement changed in another window. The latest version is loaded; your note is kept. Review it and save again.';}}catch{text='This agreement changed, but the latest version could not be loaded. Your note is kept; reconnect and try again.';}}setToast({text,error:true});return false;}finally{setBusy(false);}};
  const save=async(fields:Fields)=>{const r=editor.record;const ok=await perform(()=>r?editor.renewal?repo.renew(r.id,r.version,fields):repo.update(r.id,r.version,fields):repo.create(fields),editor.renewal?'Renewal saved. The previous agreement is resolved.':r?'Agreement updated.':'Agreement created.');if(ok){setDirty(false);setPage('overview');setEditor({key:Date.now()});}return ok;};
  const changeStatus=async(r:NdaRecord)=>{const status=r.fields.Status==='Resolved'?'Pending':'Resolved';if(!await confirmAction(status==='Resolved'?`Mark ${r.fields.Recipient} as resolved? Reminders for this agreement will stop.`:`Reopen ${r.fields.Recipient}? Reminder rules will apply again.`))return;const ok=await perform(()=>repo.update(r.id,r.version,{...r.fields,Status:status}),status==='Resolved'?'Agreement resolved.':'Agreement reopened.');if(ok){setNoteDirty(false);setDetail(null);}};
  const recycleAgreement=async(r:NdaRecord)=>{
    if(!await confirmAction(`Move ${String(r.fields.Recipient||'this agreement')} to the recycle bin? It will leave the register and future reminder checks. History, linked contracts and their files are kept. You can restore it from Recycle bin.`))return;
    const key=`${r.id}:${r.version}`;const requestId=recycleRequests.current.get(key)??crypto.randomUUID();recycleRequests.current.set(key,requestId);
    const ok=await perform(()=>repo.recycle(r.id,r.version,requestId),'Agreement moved to Recycle bin.');
    if(ok){recycleRequests.current.delete(key);setNoteDirty(false);setDetail(null);}
  };
  useEffect(()=>{document.documentElement.dataset.ndaDirty=String(dirty||noteDirty);return()=>{delete document.documentElement.dataset.ndaDirty;};},[dirty,noteDirty]);
  if(!data)return <main className="loading-shell"><img className="loading-logo" src="/ffm-logo.png" alt="FFM"/><h1>NDA Tracker</h1>{fatal?<><p className="error-text">{fatal}</p><p>Restart NDA Tracker. Your saved data remains in your Windows user data folder.</p><button className="button primary" onClick={()=>{setFatal('');void load();}}>Try again</button></>:<p>Connecting to the database…</p>}</main>;
  const selected=data.records.find(r=>r.id===detail);const candidateCount=getCandidates(data.records,today,data.settings.reminderDays).length;
  return <div className={`app-shell ${collapsed?'collapsed':''} ${mobile?'mobile-open':''}`}>
    <a href="#main" className="skip-link">Skip to content</a>
    {mobile&&<button className="nav-scrim" aria-label="Close navigation" onClick={()=>setMobile(false)}/>}
    <aside className="sidebar"><button className="brand" onClick={()=>navigate('overview')}><span className="brand-icon ffm-brand-icon"><img src="/ffm-logo.png" alt=""/></span><span>NDA<span className="brand-light"> tracker</span></span></button><button className="mobile-close icon-button" aria-label="Close navigation" onClick={()=>setMobile(false)}><X/></button>
      <div className="workspace-name"><div><strong>Agreement register</strong><small>Expiry & follow-up</small></div></div>
      <p className="nav-label">WORKSPACE</p><nav aria-label="Main navigation">{nav.map(n=><button key={n.id} className={`nav-item ${page===n.id?'active':''}`} aria-current={page===n.id?'page':undefined} title={n.label} onClick={()=>navigate(n.id)} disabled={busy}><n.icon size={19}/><span>{n.label}</span>{page===n.id&&<i/>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-note"><Database size={16}/><div><strong>Local workspace</strong><small>SQLite · Brevo email</small></div></div><button className="collapse-button" aria-label={collapsed?'Expand sidebar':'Collapse sidebar'} onClick={()=>setCollapsed(!collapsed)}><PanelLeftClose size={18}/><span>Collapse sidebar</span></button></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumbs"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={()=>setMobile(true)}><Menu size={22}/></button><span>Agreement register</span><ChevronRight size={13}/><strong>{nav.find(n=>n.id===page)?.label}</strong></div><div className="saved" role="status">{fatal?<AlertTriangle size={14}/>:<Check size={14}/>}<span>{fatal?'Connection interrupted':busy?'Saving…':dirty||noteDirty?'Unsaved changes':toast?.error?'Could not save':'All changes saved'}</span></div></header>
      <main id="main"><div className="page-heading"><div><h1>{page==='overview'?'Agreement overview':page==='input'?(editor.renewal?'Renew agreement':editor.record?'Edit agreement':'New agreement'):page==='history'?'History & records':page==='contracts'?'Documents':page==='suppliers'?'Suppliers':page==='templates'?'Templates':page==='recycle'?'Recycle bin':'Workspace settings'}</h1><p className="subtitle">{page==='overview'?`${dateLabel(today)} · Malaysia time (UTC+8)`:page==='input'?`${editor.record?.reference?editor.record.reference+' · ':''}Record agreement details and assign follow-up responsibility.`:page==='history'?'Find agreements and review changes made in this workspace.':page==='contracts'?'Prepare NDA and EOI documents, keep signed copies, then start tracking.':page==='suppliers'?'Keep supplier IDs, projects and linked documents together.':page==='templates'?'Import, map, preview and publish controlled document templates.':page==='recycle'?'Restore deleted agreements and contracts.':'Manage reminder preferences, email delivery and backups.'}</p></div>{!['input','contracts','suppliers','templates','recycle'].includes(page)&&<div className="heading-actions"><button className="button secondary" onClick={()=>setShowImport(true)} disabled={busy}><FileSpreadsheet size={17}/>Import Excel</button><button className="button primary" onClick={()=>openEditor()} disabled={busy}><Plus size={18}/>New NDA</button></div>}</div>
        {fatal&&<div className="notice error" role="alert"><AlertTriangle size={18}/><div><strong>Database connection interrupted</strong><p>{fatal} The displayed records may be out of date.</p><button className="text-button" onClick={()=>void load()}>Reconnect</button></div></div>}
        {page==='overview'&&<Overview data={data} today={today} exportUnavailable={busy||!!fatal} onOpen={r=>setDetail(r.id)} onPreview={()=>setPreview(true)} onNew={()=>openEditor()} onViewEmailRecords={()=>{setSettingsSection('email');void navigate('settings');}}/>}
        {page==='contracts'&&<ContractsPage records={data.records} openContractId={contractTarget} onContractOpened={()=>setContractTarget(null)} onDirty={setDirty} onTracked={()=>{setDirty(false);setTimeout(()=>void load(),0);}} onEditRecord={record=>void openEditor(record)} confirm={confirmAction}/>}
        {page==='suppliers'&&<SuppliersPage records={data.records} onDirty={setDirty} confirm={confirmAction} onLinked={()=>void load()} onOpenAgreement={id=>setDetail(id)} onOpenDocument={id=>{setContractTarget(id);setPage('contracts');window.scrollTo(0,0);}}/>}
        {page==='templates'&&<TemplatesPage onDirty={setDirty} confirm={confirmAction}/>}
        {page==='recycle'&&<RecycleBinPage confirm={confirmAction} onRestoreAgreement={(record,requestId)=>perform(()=>repo.restoreRecord(record.id,record.version,requestId),'Agreement restored.',undefined,true)} />}
        {page==='input'&&<InputPage key={editor.key} editor={editor} data={data} today={today} busy={busy} onDirty={setDirty} onSave={save} onCancel={()=>navigate('overview')}/>}
        {page==='history'&&<HistoryPage data={data} today={today} onOpen={r=>setDetail(r.id)} onPreview={()=>setPreview(true)}/>}
        {page==='settings'&&<SettingsPage key={settingsRevision} data={data} busy={busy} onDirty={setDirty} onPreview={()=>setPreview(true)} onSave={async s=>{const ok=await perform(()=>repo.updateSettings(s,data.revision!),'Settings saved.');if(ok)setDirty(false);return ok;}} loadArchives={loadArchives} onRestoreArchive={async id=>{const ok=await perform(()=>repo.restoreArchive(id,data.revision!),'Database version recovered.');if(ok){setDirty(false);setSettingsRevision(value=>value+1);}return ok;}} onBackup={()=>download(`nda-backup-${today}.json`,JSON.stringify(data,null,2))} onRestore={async b=>{const ok=await perform(()=>repo.restore(b,data.revision!),'Database backup restored.');if(ok){setDirty(false);setSettingsRevision(value=>value+1);}return ok;}}/>}
        <footer className="page-footer"><span><span className="dot"/>Local SQLite database · {data.records.length} agreements</span><button onClick={()=>setPreview(true)}><Mail size={13}/>{candidateCount} reminder{candidateCount===1?'':'s'} today · {data.settings.automaticRemindersEnabled?'Auto on':'Auto off'}</button></footer>
      </main>
    </div>
    {selected&&<DetailDrawer key={selected.id} record={selected} onSupplierChanged={()=>void load()} today={today} history={data.history.filter(h=>h.ndaId===selected.id)} onClose={()=>{setNoteDirty(false);setDetail(null);}} onEdit={()=>openEditor(selected)} onRenew={()=>openEditor(selected,true)} onStatus={()=>void changeStatus(selected)} onDelete={()=>void recycleAgreement(selected)} onAddNote={(text,requestId)=>perform(()=>repo.addFollowUp(selected.id,selected.version,text,requestId),'Follow-up note saved.',selected.id)} onDraftChange={setNoteDirty} onConfirmDiscard={()=>confirmAction('Discard the unsaved follow-up note?')} busy={busy}/>}
    {showImport&&<ImportDialog records={data.records} onClose={()=>setShowImport(false)} onImport={async rows=>{const ok=await perform(()=>repo.importRows(rows),'Excel records imported.');if(ok)setShowImport(false);return ok;}} busy={busy}/>}
    {preview&&<EmailPreview data={data} today={today} onClose={()=>setPreview(false)} onSettings={()=>{setPreview(false);navigate('settings');}}/>}
    {confirmation&&<Modal title="Confirm change" onClose={()=>finishConfirmation(false)}><div className="dialog-body"><p>{confirmation.message}</p></div><div className="dialog-actions"><button className="button secondary" onClick={()=>finishConfirmation(false)}>Cancel</button><button className="button primary" onClick={()=>finishConfirmation(true)}>Confirm</button></div></Modal>}
    {toast&&<div className={`toast ${toast.error?'error':''}`} role={toast.error?'alert':'status'}>{toast.error?<AlertTriangle size={18}/>:<Check size={18}/>}<span>{toast.text}</span><button aria-label="Dismiss notification" onClick={()=>setToast(null)}><X size={16}/></button></div>}
  </div>;
}
