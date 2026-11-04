import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {Mail,RefreshCw,Send,ExternalLink,Eye} from 'lucide-react';
import {Badge,Empty,Modal} from './components';
import {todayMY} from './core';
import {emailApi} from './email-api';
import type {EmailDelivery,EmailStatus} from './email-types';

const message=(error:unknown)=>error instanceof Error?error.message:'Email service could not be reached.';
const timeLabel=(value:string)=>new Intl.DateTimeFormat('en-MY',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
const statusLabel:Record<EmailDelivery['status'],string>={sending:'Sending',submitted:'Submitted',failed:'Failed',unknown:'Needs review',skipped:'No reminders due'};
const tone=(status:EmailDelivery['status'])=>status==='submitted'?'teal':status==='failed'?'red':status==='sending'||status==='unknown'?'amber':'gray';
const outcome=(delivery:EmailDelivery)=>delivery.status==='submitted'?'Submitted to Brevo. Check the recipient’s inbox and spam folder.':delivery.status==='unknown'?'The result needs review. Check Brevo logs before sending again.':delivery.error||statusLabel[delivery.status];

export function EmailConnectionPanel({senderEmail,unsaved,busy,onUseSender,onActivity}:{senderEmail:string;unsaved:boolean;busy:boolean;onUseSender:(email:string)=>void;onActivity:()=>void}){
  const [status,setStatus]=useState<EmailStatus|null>(null);
  const [checking,setChecking]=useState(false);const [error,setError]=useState('');
  const [recipient,setRecipient]=useState('');const [sending,setSending]=useState(false);const [result,setResult]=useState('');
  const active=useRef(true);const inFlight=useRef(false);const requestVersion=useRef(0);
  const refresh=useCallback(async()=>{const version=++requestVersion.current;setChecking(true);setError('');try{const next=await emailApi.status();if(active.current&&version===requestVersion.current)setStatus(next);}catch(e){if(active.current&&version===requestVersion.current){setStatus(null);setError(message(e));}}finally{if(active.current&&version===requestVersion.current)setChecking(false);}},[]);
  useEffect(()=>{active.current=true;void refresh();return()=>{active.current=false;requestVersion.current++;};},[refresh]);
  const send=async(event:FormEvent)=>{
    event.preventDefault();if(inFlight.current)return;
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim())){setResult('Enter a valid test recipient email.');return;}
    inFlight.current=true;setSending(true);setResult('');
    try{const delivery=await emailApi.test(recipient.trim(),crypto.randomUUID());if(active.current)setResult(outcome(delivery));onActivity();}
    catch(e){if(active.current)setResult(`${message(e)} Refresh the sending records before trying again.`);onActivity();}
    finally{inFlight.current=false;if(active.current)setSending(false);}
  };
  const defaultSender=status?.defaultSenderEmail||status?.senders.find(sender=>sender.active)?.email;
  return <section className="panel email-connection-panel">
    <div className="panel-heading"><div><h2>Brevo email connection</h2><p>Send reminders to Outlook or any email inbox.</p></div><Mail size={21}/></div>
    <div className="settings-body">
      <div className="email-connection-status"><Badge tone={status?.connected&&status.transactionalEnabled?'teal':'amber'}>{checking?'Checking…':error?'Unavailable':status?.connected&&status.transactionalEnabled?'Connected':status?.configured?'Action needed':'Not configured'}</Badge><button type="button" className="icon-button" aria-label="Check Brevo connection" disabled={checking||sending} onClick={()=>void refresh()}><RefreshCw size={16}/></button></div>
      {(error||status?.error)&&<p role="alert" className="error-text">{error||status?.error}</p>}
      {status?.connected&&!status.transactionalEnabled&&<p className="error-text">Transactional email is not enabled in this Brevo account.</p>}
      {defaultSender&&<div className="email-sender-note"><span>Verified sender</span><strong>{defaultSender}</strong>{senderEmail!==defaultSender&&<button type="button" className="text-button" disabled={busy||sending} onClick={()=>onUseSender(defaultSender)}>Use this sender</button>}</div>}
      <p className="caption">The API key stays on the server. A Gmail sender may appear with a Brevo sender address; replies go to the configured sender email.</p>
      <form className="email-test-form" onSubmit={event=>void send(event)}>
        <h3>Send a test email</h3><p className="caption">A sample message with a [TEST] subject. No NDA records or CC recipients are included.</p>
        <div className="field"><label htmlFor="test-recipient-email">Test recipient email</label><input id="test-recipient-email" type="email" autoComplete="email" value={recipient} onChange={event=>setRecipient(event.target.value)} placeholder="you@outlook.com" required disabled={sending||busy}/></div>
        {unsaved&&<p className="caption">Save your reminder preferences before sending a test.</p>}
        <button className="button secondary" type="submit" disabled={sending||busy||unsaved||checking||!status?.connected||!status.transactionalEnabled}><Send size={16}/>{sending?'Submitting…':'Send test email'}</button>
        {result&&<p className="email-result" role="status">{result}</p>}
      </form>
      <p className="caption">Automatic checks run while this computer and Docker are on. You can close the browser.</p>
      <a className="text-button" href="https://app.brevo.com/transactional/email/logs" target="_blank" rel="noreferrer">Open Brevo email logs<ExternalLink size={14}/></a>
    </div>
  </section>;
}

export function EmailDeliveryHistory({refreshKey}:{refreshKey:number}){
  const [deliveries,setDeliveries]=useState<EmailDelivery[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [result,setResult]=useState('');
  const [selected,setSelected]=useState<EmailDelivery|null>(null);const [retrying,setRetrying]=useState<string|null>(null);
  const active=useRef(true);const requestVersion=useRef(0);const retryInFlight=useRef(false);
  const refresh=useCallback(async()=>{const version=++requestVersion.current;setLoading(true);try{const next=await emailApi.deliveries();if(active.current&&version===requestVersion.current){setDeliveries(next);setError('');}}catch(e){if(active.current&&version===requestVersion.current)setError(message(e));}finally{if(active.current&&version===requestVersion.current)setLoading(false);}},[]);
  useEffect(()=>{active.current=true;void refresh();const interval=window.setInterval(()=>void refresh(),30000);return()=>{active.current=false;requestVersion.current++;clearInterval(interval);};},[refresh,refreshKey]);
  const retry=async(delivery:EmailDelivery)=>{if(retryInFlight.current)return;retryInFlight.current=true;setRetrying(delivery.id);setResult('');try{const next=await emailApi.retry(delivery.id,crypto.randomUUID());if(active.current)setResult(outcome(next));}catch(e){if(active.current)setResult(message(e));}finally{retryInFlight.current=false;if(active.current){setRetrying(null);void refresh();}}};
  return <section id="email-sending-records" tabIndex={-1} aria-label="Email sending records" className="panel email-history-panel">
    <div className="panel-heading"><div><h2>Email sending records</h2><p>Latest 100 entries · timestamps in Malaysia time.</p></div><button type="button" className="text-button" disabled={loading||!!retrying} onClick={()=>void refresh()}><RefreshCw size={15}/>Refresh</button></div>
    <div className="email-history-body">
      <p className="caption">Submitted means Brevo accepted the message. Check Brevo logs or the recipient’s inbox to confirm delivery. Failed daily digests retry with the current saved preferences and records. Entries marked “Needs review” are never retried automatically.</p>
      {error&&<p className="error-text" role="alert">{error} Previously loaded entries may be out of date.</p>}
      {result&&<p role="status" className="email-result">{result}</p>}
      {!deliveries.length?<Empty title={loading?'Loading email records…':'No email sent yet'}>Test messages and daily reminder results will appear here.</Empty>:<div className="table-scroll"><table className="email-history-table"><thead><tr><th>Time / type</th><th>Recipient</th><th>Status</th><th>Actions</th></tr></thead><tbody>{deliveries.map(delivery=><tr key={delivery.id}><td><strong>{timeLabel(delivery.createdAt)}</strong><small>{delivery.kind==='test'?'Test email':'Daily digest'} · {delivery.recordCount} NDA{delivery.recordCount===1?'':'s'}</small></td><td className="email-address-cell">{delivery.recipientEmail||'—'}{delivery.ccEmail&&<small>CC: {delivery.ccEmail}</small>}</td><td><Badge tone={tone(delivery.status)}>{statusLabel[delivery.status]}</Badge></td><td><div className="email-row-actions"><button type="button" className="icon-button" aria-label={`View ${delivery.kind} email ${delivery.id}`} title="View saved email" onClick={()=>setSelected(delivery)}><Eye size={16}/></button>{delivery.status==='failed'&&<button type="button" className="text-button" disabled={!!retrying||(delivery.kind==='scheduled'&&delivery.localDate!==todayMY())} onClick={()=>void retry(delivery)} title={delivery.kind==='scheduled'&&delivery.localDate!==todayMY()?'Only today’s daily digest can be retried.':'Retry this failed email'}>{retrying===delivery.id?'Retrying…':'Retry'}</button>}</div></td></tr>)}</tbody></table></div>}
    </div>
    {selected&&<Modal title="Saved email" wide onClose={()=>setSelected(null)}><div className="dialog-body"><div className="mail-meta"><div><span>Status</span><strong>{statusLabel[selected.status]}</strong></div><div><span>From / Reply-To</span><strong>{selected.senderEmail||'—'}</strong></div><div><span>To</span><strong>{selected.recipientEmail||'—'}</strong></div>{selected.ccEmail&&<div><span>CC</span><strong>{selected.ccEmail}</strong></div>}<div><span>Subject</span><strong>{selected.subject||'—'}</strong></div><div><span>Attempts</span><strong>{selected.attempts}</strong></div>{selected.messageId&&<div><span>Brevo message ID</span><strong>{selected.messageId}</strong></div>}</div>{selected.error&&<p className="notice amber">{selected.error}</p>}{selected.htmlContent?<iframe className="email-snapshot-frame" title="Saved email content" sandbox="" srcDoc={selected.htmlContent} referrerPolicy="no-referrer"/>:<p>No message content was generated for this entry.</p>}</div><div className="dialog-actions"><button type="button" className="button primary" onClick={()=>setSelected(null)}>Done</button></div></Modal>}
  </section>;
}
