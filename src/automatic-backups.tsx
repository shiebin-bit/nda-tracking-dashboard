import { useEffect, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { Badge } from './components';
import type { BackupStatus } from './backup-types';

const timeLabel = (value: string) => `${new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value))} MYT`;
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const labels: Record<BackupStatus['state'], string> = {
  never: 'Waiting for first backup', running: 'Backing up', succeeded: 'Backup saved', failed: 'Backup failed', unavailable: 'Status unavailable',
};

export function AutomaticBackups() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let active: AbortController | null = null;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const controller = new AbortController();
      active = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/api/backups/automatic/status', { credentials: 'same-origin', signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body) throw new Error(body?.error?.message || 'Automatic backup status could not be loaded.');
        if (!cancelled) { setStatus(body as BackupStatus); setError(''); }
      } catch (reason) {
        if (!cancelled) setError(controller.signal.aborted ? 'The backup status request timed out. Try again.' : reason instanceof Error ? reason.message : 'Automatic backup status could not be loaded.');
      } finally {
        window.clearTimeout(timeout);
        active = null;
        pending = false;
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30000);
    const focus = () => void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; active?.abort(); window.clearInterval(interval); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible); };
  }, [retry]);

  const warning = status?.lastAttempt?.warning;
  const tone = error || status?.state === 'failed' || status?.state === 'unavailable' ? 'red' : status?.state === 'succeeded' && !warning ? 'teal' : 'amber';
  return <section className="panel settings-panel automatic-backup-panel" aria-labelledby="automatic-backup-title">
    <div className="panel-heading"><div><h2 id="automatic-backup-title">Automatic database backups</h2><p>Full database copies saved on this computer.</p></div><Database size={20}/></div>
    <div className="settings-body">
      <p className="automatic-backup-intro">Includes agreements, contracts, generated files, the recycle bin, History, settings and email sending records.</p>
      {loading && <p role="status">Loading backup status…</p>}
      {error && <div role="alert"><p className="error-text">{error}{status ? ' Last known backup information is shown below.' : ''}</p>{!status && <button type="button" className="text-button" disabled={loading} onClick={() => setRetry(value => value + 1)}><RefreshCw size={14}/>Try again</button>}</div>}
      {status && <>
        <div className="automatic-backup-state"><Badge tone={tone}>{error ? 'Status unavailable' : labels[status.state]}</Badge><button type="button" className="text-button" disabled={loading} onClick={() => setRetry(value => value + 1)}><RefreshCw size={14}/>Refresh status</button></div>
        {status.state === 'unavailable' && <p role="alert" className="error-text backup-status-warning">The backup worker status cannot be verified. Keep NDA Tracker running and check the local backup service.</p>}
        {status.state === 'failed' && <p role="alert" className="error-text backup-status-warning">{status.lastAttempt?.error || 'The latest backup attempt failed. Earlier successful backups are kept.'}</p>}
        {warning && <p role="status" className="backup-status-warning">{warning}</p>}
        <dl className="automatic-backup-details">
          <div><dt>Daily schedule</dt><dd>{status.schedule.localTime} MYT · keep the latest {status.schedule.retainSuccessful} successful backups</dd></div>
          <div><dt>Last successful backup</dt><dd>{status.lastSuccess ? timeLabel(status.lastSuccess.completedAt) : 'No successful backup yet'}</dd></div>
          {status.lastSuccess && <div><dt>Backup file</dt><dd><span className="backup-file-name">{status.lastSuccess.fileName}</span><small>{sizeLabel(status.lastSuccess.sizeBytes)} · {status.successfulBackupCount} saved backup{status.successfulBackupCount === 1 ? '' : 's'}</small></dd></div>}
          {status.nextAttemptAt && <div><dt>Next backup attempt</dt><dd>{timeLabel(status.nextAttemptAt)}</dd></div>}
          {status.state === 'running' && status.lastAttempt && <div><dt>Current attempt started</dt><dd>{timeLabel(status.lastAttempt.startedAt)}</dd></div>}
        </dl>
      </>}
      <p className="automatic-backup-caption">Files are in your workspace’s <strong>backups</strong> folder. Keep this computer and NDA Tracker running. The first backup starts automatically; a missed daily backup runs when the service starts again.</p>
      <p className="automatic-backup-caption">Use the JSON backup below for recovery inside the website. Use Complete workspace backup in the desktop settings to save or restore all documents and email records.</p>
    </div>
  </section>;
}
