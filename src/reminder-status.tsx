import { useEffect, useState } from 'react';
import { ArrowUpRight, Mail, RefreshCw } from 'lucide-react';
import { Badge } from './components';
import { emailApi } from './email-api';
import type { ReminderSummary, ReminderTaskSummary } from './email-types';

const labels: Record<ReminderTaskSummary['status'], string> = {
  sending: 'Sending', submitted: 'Submitted', failed: 'Failed', unknown: 'Needs review', skipped: 'No reminders due',
};
const tone = (status: ReminderTaskSummary['status']) =>
  status === 'submitted' ? 'teal' : status === 'failed' ? 'red' : status === 'sending' || status === 'unknown' ? 'amber' : 'gray';
const timeLabel = (value: string) => `${new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value))} MYT`;

export function ReminderStatus({ settingsKey, candidateCount, reminderDays, onPreview, onViewRecords }: {
  settingsKey: string; candidateCount: number; reminderDays: number[];
  onPreview: () => void; onViewRecords: () => void;
}) {
  const [summary, setSummary] = useState<ReminderSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await emailApi.summary(controller.signal);
        if (!cancelled) { setSummary(next); setError(''); }
      } catch (reason) {
        if (!cancelled) {
          setSummary(null);
          setError(reason instanceof Error ? reason.message : 'Reminder status could not be loaded.');
        }
      } finally {
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
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [settingsKey, retry]);

  const result = summary?.todayResult ?? summary?.latestResult;
  const cc=summary?.ccEmails?.length?summary.ccEmails:summary?.ccEmail?[summary.ccEmail]:[];
  return <section className="panel reminder-status-panel" aria-labelledby="reminder-status-title">
    <div className="panel-heading"><div className="reminder-status-title"><span className="reminder-icon"><Mail size={20}/></span><div><h2 id="reminder-status-title">Reminder status</h2><p>Daily checks · Malaysia time (UTC+8)</p></div></div>{summary && !loading && <Badge tone={summary.enabled ? 'teal' : 'gray'}>{summary.enabled ? 'Automatic reminders on' : 'Paused'}</Badge>}</div>
    {loading ? <p className="reminder-status-message" role="status">Loading reminder status…</p> : error ? <div className="reminder-status-message" role="alert"><strong>Status temporarily unavailable</strong><p>{error}</p><button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14}/>Try again</button></div> : summary && <div className="reminder-status-grid">
      <div><span className="reminder-status-label">Reminder recipient</span><strong className="reminder-recipient">{summary.recipientEmail || 'Not configured'}</strong>{cc.length>0&&<small>CC: {cc.join(', ')}</small>}<small>Daily check: {summary.sendTime} MYT</small></div>
      <div><span className="reminder-status-label">Next planned check</span><strong>{summary.nextCheckState === 'paused' ? 'Paused' : summary.nextCheckState === 'awaiting_check' ? 'Waiting for backend check' : summary.nextCheckAt ? timeLabel(summary.nextCheckAt) : 'Not scheduled'}</strong><small>{summary.nextCheckState === 'paused' ? 'Enable automatic reminders in Settings.' : summary.nextCheckState === 'awaiting_check' ? `Scheduled for ${summary.sendTime} today. Checks run every minute while the server is on.` : 'Keep this computer and NDA Tracker running.'}</small></div>
      <div><span className="reminder-status-label">{summary.todayResult ? 'Today’s daily task' : 'Latest daily task'}</span>{result ? <><Badge tone={tone(result.status)}>{labels[result.status]}</Badge><small>{result.recordCount} NDA{result.recordCount === 1 ? '' : 's'} · {timeLabel(result.updatedAt)}</small><small>{result.status === 'submitted' ? 'Accepted by Brevo; inbox delivery is separate.' : result.status === 'skipped' ? 'No email was sent.' : result.error || 'The daily digest is being submitted.'}</small></> : <><strong>No daily tasks yet</strong><small>Test emails are shown in Settings only.</small></>}</div>
    </div>}
    <div className="reminder-status-footer"><div><strong>{candidateCount} agreement{candidateCount === 1 ? '' : 's'} meet today’s reminder rules</strong><p>{reminderDays.join(', ')} days before expiry · daily after expiry · Pending only</p></div><div className="reminder-status-actions"><button type="button" className="text-button" onClick={onPreview}>Preview email<ArrowUpRight size={15}/></button><button type="button" className="text-button" onClick={onViewRecords}>Email sending records<ArrowUpRight size={15}/></button></div></div>
  </section>;
}
