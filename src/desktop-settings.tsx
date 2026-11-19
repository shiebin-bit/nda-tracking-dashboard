import {useEffect,useState} from 'react';
import {Monitor,FolderOpen,Download,Upload,KeyRound} from 'lucide-react';
import {Badge} from './components';
import {desktop,type DesktopStatus} from './desktop';

export function DesktopSettings(){
  const [status,setStatus]=useState<DesktopStatus|null>(null);const [key,setKey]=useState('');const [sender,setSender]=useState('');const [clear,setClear]=useState(false);const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [error,setError]=useState('');
  useEffect(()=>{if(!desktop)return;let active=true;void desktop.status().then(s=>{if(active){setStatus(s);setSender(s.senderEmail);}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  const bridge=desktop;if(!bridge)return null;
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setMessage('');try{await action();}catch(e){setError(e instanceof Error?e.message:'The operation could not be completed.');}finally{setBusy(false);}};
  return <section id="desktop-workspace" className="panel settings-panel"><div className="panel-heading"><div><h2>Desktop workspace</h2><p>This computer has its own database and files.</p></div><Monitor size={21}/></div><div className="settings-body">
    {error&&<p role="alert" className="error-text">{error}</p>}{message&&<p role="status">{message}</p>}
    {!status?<p>Loading desktop preferences…</p>:<>
      <div className="email-connection-status"><Badge tone={status.backgroundRunning?'teal':'amber'}>{status.backgroundRunning?'Background service running':'Background service stopped'}</Badge><small>Version {status.version}</small></div>
      <label className="automatic-reminders-toggle"><input type="checkbox" disabled={busy} checked={status.openAtLogin} onChange={e=>{const enabled=e.target.checked;void run(async()=>{setStatus(await bridge.setOpenAtLogin(enabled));setMessage(enabled?'NDA Tracker will start in the tray when you sign in to Windows.':'Windows startup is disabled. Open NDA Tracker to run reminders.');});}}/><span><strong>Start with Windows</strong><small>Closing the window keeps reminders running in the tray. Quit from the tray to stop. This computer must be on and connected to the internet to send email.</small></span></label>
      <p className="caption">PDF conversion: {status.converterAvailable?'Included and available':'Converter missing — reinstall the complete package'}.</p>
      <h3><KeyRound size={16}/> Your Brevo connection</h3><p className="caption">{status.mailConfigured?'A protected API key is saved. Leave the key blank to keep it.':'Add your own Brevo API key and a verified sender. Saving this connection pauses automatic reminders. Review reminder preferences and enable them again when ready.'} The key is protected by your Windows account and is excluded from database backups.</p>
      <form onSubmit={e=>{e.preventDefault();void run(async()=>{await bridge.saveMail({apiKey:key,senderEmail:sender,clearKey:clear});setKey('');setClear(false);});}}>
        <div className="field-grid"><label className="field">Brevo API key<input type="password" autoComplete="new-password" value={key} disabled={busy||clear} onChange={e=>setKey(e.target.value)} placeholder={status.mailConfigured?'Leave blank to keep the saved key':'Paste your API key'}/></label><label className="field">Default verified sender email<input type="email" autoComplete="email" value={sender} disabled={busy} onChange={e=>setSender(e.target.value)} placeholder="sender@company.com"/></label></div>
        {status.mailConfigured&&<label className="automatic-reminders-toggle"><input type="checkbox" checked={clear} disabled={busy} onChange={e=>setClear(e.target.checked)}/><span>Remove the saved API key</span></label>}
        <p className="caption">Save any unsaved form changes first. Saving this connection restarts the local workspace and pauses automatic reminders. The sender in Reminder preferences takes priority over this default.</p><button className="button secondary" disabled={busy} type="submit">{busy?'Working…':'Save email connection'}</button>
      </form>
      <h3>Complete workspace backup</h3><p className="caption">Includes suppliers, templates, agreements, contracts, signed files, History and email records. Restoring pauses automatic reminders. Your Windows-protected email key stays on this computer.</p>
      <div className="backup-actions"><button className="button secondary" disabled={busy} onClick={()=>void run(async()=>{const result=await bridge.backup();if(!result.canceled)setMessage(`Complete backup saved: ${result.fileName}`);})}><Download size={16}/>Save complete backup</button><button className="button secondary" disabled={busy} onClick={()=>void run(async()=>{await bridge.restore();})}><Upload size={16}/>Restore complete backup</button><button className="button secondary" disabled={busy} onClick={()=>void run(async()=>{await bridge.openDataFolder();})}><FolderOpen size={16}/>Open data folder</button></div>
      <p className="caption desktop-data-path">{status.dataDirectory}</p><p className="caption">Application updates keep this folder. Keep a backup on another drive for protection against computer failure.</p>
    </>}
  </div></section>;
}
