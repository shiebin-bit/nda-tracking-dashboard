import { useEffect, useState } from 'react';
import { History, AlertTriangle, RefreshCw } from 'lucide-react';
import type { RestoreArchiveSummary } from './core';
import { Modal } from './components';

interface Props {
  revision: string;
  busy: boolean;
  loadArchives: () => Promise<RestoreArchiveSummary[]>;
  onRestore: (id: string) => Promise<boolean>;
}

const label = (archive: RestoreArchiveSummary) =>
  `${new Date(archive.createdAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short',
  })} MYT · ${archive.records} agreements`;

export function DatabaseRecovery({ revision, busy, loadArchives, onRestore }: Props) {
  const [archives, setArchives] = useState<RestoreArchiveSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    loadArchives().then(items => {
      if (cancelled) return;
      setArchives(items);
      setSelected(current => items.some(item => item.id === current) ? current : '');
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Saved versions could not be loaded.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision, loadArchives, retry]);

  const chosen = archives.find(item => item.id === selected);
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Saved NDA register versions</h2><p>NDA register only. Saved before each JSON backup restore; contracts and files are kept separately.</p></div><History size={20}/></div>
    <div className="settings-body">
      {loading ? <p role="status">Loading saved versions…</p> : error ? <div role="alert"><p className="error-text">{error}</p><button className="text-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14}/>Try again</button></div> : archives.length === 0 ? <p>No saved versions yet. Restoring a backup will first save your current database here.</p> : <>
        <div className="field"><label htmlFor="recovery-version">Version before a previous restore</label><select id="recovery-version" disabled={busy} value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose a saved version</option>{archives.map(archive => <option key={archive.id} value={archive.id}>{label(archive)}</option>)}</select></div>
        <p className="recovery-caption">Recovering replaces the current records, History and reminder settings, and pauses automatic reminders. Email sending records are kept. Your current workspace is saved as another version.</p>
        <button className="button secondary" disabled={busy || !chosen} onClick={() => setConfirm(true)}><History size={16}/>Recover saved version</button>
      </>}
    </div>
    {confirm && chosen && <Modal title="Recover database version" onClose={() => { if (!busy) setConfirm(false); }}>
      <div className="dialog-body"><div className="notice amber"><AlertTriangle size={20}/><span>Recover the version saved on {label(chosen)}?</span></div><p>This replaces the current records, History and reminder settings, and pauses automatic reminders. Email sending records are kept. Unsaved changes will be discarded. Your current workspace is saved as a new version first.</p></div>
      <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button><button className="button primary" disabled={busy} onClick={async () => { if (await onRestore(chosen.id)) setConfirm(false); }}>{busy ? 'Recovering…' : 'Recover version'}</button></div>
    </Modal>}
  </section>;
}
