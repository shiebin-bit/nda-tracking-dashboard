import {useEffect,useRef,useState} from 'react';
import {Download,FileUp,Printer,Upload} from 'lucide-react';
import {Badge,Modal} from './components';
import {PdfPreview} from './pdf-preview';
import {signedFileUrl} from './contracts-api';
import {ApiError} from './storage';
import type {ContractDetails} from './contract-types';

const MAX_BYTES=20*1024*1024;
const time=(value:string)=>new Intl.DateTimeFormat('en-MY',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(value));
const size=(bytes:number)=>bytes<1024*1024?`${Math.ceil(bytes/1024)} KB`:`${(bytes/(1024*1024)).toFixed(1)} MiB`;

export function SignedCopyPanel({contract,busy,dirty,onUpload,onConfirm}:{contract:ContractDetails|null;busy:boolean;dirty:boolean;onUpload:()=>void;onConfirm:()=>void}){
  const [selected,setSelected]=useState('');
  const frame=useRef<HTMLIFrameElement>(null);
  useEffect(()=>setSelected(contract?.currentSignedFileId??''),[contract?.id,contract?.currentSignedFileId]);
  const files=contract?.signedFiles??[];
  const file=files.find(f=>f.id===selected)??files.find(f=>f.id===contract?.currentSignedFileId);
  const current=!!file&&file.id===contract?.currentSignedFileId;
  const version=contract?.versions.find(v=>v.id===file?.sourceVersionId);
  const print=()=>{if(!file)return;try{if(!frame.current?.contentWindow)throw new Error();frame.current.contentWindow.focus();frame.current.contentWindow.print();}catch{window.open(signedFileUrl(file.id),'_blank','noopener,noreferrer');}};
  return <section className="signed-copy-panel" aria-label="Signed copy">
    <div className="contract-preview-heading"><h2>Signed copy</h2><Badge tone={file?'green':contract?.status==='signed'?'amber':'gray'}>{!file?contract?.status==='signed'?'File missing':'Not uploaded':current?contract?.status==='signed'?'Saved':'Awaiting confirmation':'Previous copy'}</Badge></div>
    {!file?<p className="signed-copy-intro">{contract?.status==='signed'?`This ${contract.documentType.toUpperCase()} is already marked Signed. Upload its final PDF to complete the file record; existing tracking stays unchanged.`:'After everyone has signed, upload one complete PDF here. Generated drafts are kept separately.'}</p>:<>
      <label className="field">Saved signed copy<select aria-label="Saved signed copy" value={file.id} onChange={e=>setSelected(e.target.value)}>{files.map(f=><option key={f.id} value={f.id}>Copy {f.ordinal} · {time(f.uploadedAt)}{f.id===contract?.currentSignedFileId?' · Current':''}</option>)}</select></label>
      <p className="signed-file-name">{file.originalFileName}</p><p className="contract-help">{size(file.sizeBytes)} · Generated version {version?.ordinal??'—'} · Uploaded by {file.uploadedBy}</p>
      <div className="contract-actions"><a className="button secondary" href={signedFileUrl(file.id,true)}><Download size={15}/>Signed PDF</a><button className="button secondary" onClick={print}><Printer size={15}/>Print signed copy</button></div>
      <PdfPreview iframeRef={frame} title={`Signed PDF copy ${file.ordinal}`} className="contract-pdf signed-copy-pdf" src={signedFileUrl(file.id)}/>
      <a className="text-button" href={signedFileUrl(file.id)} target="_blank" rel="noreferrer">Open signed PDF in a new tab</a>
      {!current&&<p className="notice amber">This is a previous upload. <button className="text-button" onClick={()=>setSelected(contract?.currentSignedFileId??'')}>Show current copy</button></p>}
    </>}
    <div className="signed-copy-primary"><button className={`button ${file?'secondary':'primary'}`} disabled={busy||dirty||!contract} onClick={onUpload}><Upload size={16}/>{file?'Replace signed copy':'Upload signed copy'}</button>
      {file&&current&&contract?.status==='draft'&&<button className="button primary" disabled={busy||dirty||!version?.complete} onClick={onConfirm}>{contract.documentType==='eoi'?'Confirm signed EOI':'Confirm signed & start tracking'}</button>}
    </div>
    {dirty&&<p className="contract-help">Save or discard form changes before uploading or confirming.</p>}
    {!contract&&<p className="contract-help">Save this draft and generate Word & PDF first.</p>}
    {files.length>1&&<p className="contract-help">All {files.length} uploaded copies are kept. Replacing the file does not change tracking details.</p>}
  </section>;
}

export function SignedCopyUploadDialog({contract,onClose,onSave,onGenerate,confirm}:{contract:ContractDetails;onClose:()=>void;onSave:(file:File,versionId:string,requestId:string)=>Promise<void>;onGenerate:()=>void;confirm:(message:string)=>Promise<boolean>}){
  const versions=contract.versions.filter(v=>v.complete&&(contract.status!=='signed'||v.id===contract.signedVersionId));
  const [versionId,setVersionId]=useState(versions[0]?.id??'');
  const [file,setFile]=useState<File|null>(null);const [url,setUrl]=useState('');const [hash,setHash]=useState('');
  const [checked,setChecked]=useState(false);const [reading,setReading]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const request=useRef({key:'',id:''});const readSequence=useRef(0);
  const hasCurrent=!!contract.currentSignedFileId;
  useEffect(()=>{if(!file){setUrl('');return;}const value=URL.createObjectURL(file);setUrl(value);return()=>URL.revokeObjectURL(value);},[file]);
  useEffect(()=>{if(!file)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[file]);
  useEffect(()=>()=>{++readSequence.current;},[]);
  const close=async()=>{if(busy||reading)return;if(file&&!await confirm('Discard the selected PDF without uploading it?'))return;onClose();};
  const read=async(selected?:File)=>{
    if(!selected)return;const sequence=++readSequence.current;setReading(true);setError('');setFile(null);setHash('');setChecked(false);
    try{
      if(!/\.pdf$/i.test(selected.name)||(selected.type&&selected.type!=='application/pdf'))throw new Error('Choose one complete PDF file.');
      if(selected.size===0||selected.size>MAX_BYTES)throw new Error('Choose a non-empty PDF no larger than 20 MiB.');
      const [head,tail,buffer]=await Promise.all([selected.slice(0,1024).text(),selected.slice(Math.max(0,selected.size-4096)).text(),selected.arrayBuffer()]);
      if(!head.startsWith('%PDF-')||!tail.trimEnd().endsWith('%%EOF'))throw new Error('The file does not appear to be a complete PDF. Export or scan it as PDF and try again.');
      const digest=await crypto.subtle.digest('SHA-256',buffer);
      if(sequence!==readSequence.current)return;
      setHash(Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''));setFile(selected);
    }catch(e){if(sequence===readSequence.current)setError(e instanceof Error?e.message:'The PDF could not be read.');}
    finally{if(sequence===readSequence.current)setReading(false);}
  };
  const submit=async()=>{
    if(!file||!versionId||!checked||busy||reading)return;setBusy(true);setError('');
    const key=JSON.stringify({id:contract.id,expectedVersion:contract.version,versionId,name:file.name,size:file.size,hash});
    if(request.current.key!==key)request.current={key,id:crypto.randomUUID()};
    try{await onSave(file,versionId,request.current.id);}
    catch(e){setError(e instanceof ApiError&&e.code==='version_conflict'?'This contract changed in another window. Close this upload window and reopen Upload signed copy to review the latest version.':e instanceof Error?e.message:'The upload failed. Your selected file is kept; try again.');}
    finally{setBusy(false);}
  };
  return <Modal title={hasCurrent?'Replace signed copy':'Upload signed copy'} onClose={()=>void close()} wide>
    <div className="dialog-body signed-upload-body"><p className="signed-upload-client">{contract.values.recipient.name||'Unnamed contract'}</p>
      {!versions.length?<div className="notice amber"><div><strong>Generate a complete version first</strong><p>Complete the required details and generate a PDF before attaching a signed copy.</p><button className="button secondary" onClick={onGenerate}>Go to document generation</button></div></div>:<>
        <p className="dialog-intro">Upload one PDF containing the complete signed agreement. Review every page before saving. Maximum 20 MiB.</p>
        <label className="field">Corresponding generated version<select aria-label="Corresponding generated version" value={versionId} disabled={busy||reading||contract.status==='signed'} onChange={e=>{setVersionId(e.target.value);setChecked(false);}}>{versions.map(v=><option key={v.id} value={v.id}>Version {v.ordinal} · {time(v.createdAt)}</option>)}</select></label>
        <label className={`signed-upload-picker ${busy||reading?'disabled':''}`}><FileUp size={24}/><span><strong>{reading?'Checking PDF…':file?.name||'Choose final signed PDF'}</strong><small>{file?`${size(file.size)} · Choose another file`:'One complete .pdf · up to 20 MiB'}</small></span><input type="file" aria-label="Choose final signed PDF" accept="application/pdf,.pdf" disabled={busy||reading} onChange={e=>{void read(e.target.files?.[0]);e.target.value='';}}/></label>
        {url&&<><PdfPreview title="Selected signed PDF preview" className="signed-upload-preview" src={url}/><a className="text-button" href={url} target="_blank" rel="noreferrer">Open selected PDF in a new tab</a><label className="signed-upload-check"><input type="checkbox" checked={checked} disabled={busy||reading} onChange={e=>setChecked(e.target.checked)}/><span>I have checked that this is the complete, final signed {contract.documentType.toUpperCase()} for this supplier and generated version.</span></label></>}
        <p className="contract-help">{contract.status==='signed'?'This saves the file only. Existing tracking and reminders stay unchanged.':contract.documentType==='eoi'?'Saving this PDF keeps the EOI as Draft. Confirm signed afterwards; no expiry tracking is created.':'Saving this PDF keeps the NDA as Draft. Confirm signed afterwards to start tracking.'}{hasCurrent?' The previous uploaded copy will remain in the file history.':''}</p>
      </>}
      {error&&<p className="notice error" role="alert">{error}</p>}
    </div>
    <div className="dialog-actions"><button className="button secondary" disabled={busy||reading} onClick={()=>void close()}>Cancel</button><button className="button primary" disabled={!file||!versionId||!checked||busy||reading} onClick={()=>void submit()}><Upload size={16}/>{busy?'Uploading…':hasCurrent?'Save replacement':'Save signed copy'}</button></div>
  </Modal>;
}
