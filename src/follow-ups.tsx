import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageSquare, Plus } from 'lucide-react';
import type { HistoryEvent } from './core';

export const FOLLOW_UP_TYPE = 'follow-up-added';
export const FOLLOW_UP_FIELD = 'Follow-up note';

export function followUpText(event: HistoryEvent): string | null {
  if (event.type !== FOLLOW_UP_TYPE || !event.ndaId || event.actor !== 'Local user' || event.summary !== 'Added follow-up note.' || event.changes.length !== 1) return null;
  const change = event.changes[0];
  const value = change.after;
  return change.field === FOLLOW_UP_FIELD && change.before === null && typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 2000 && !value.includes('\0') ? value : null;
}

export function FollowUpNotes({ history, busy, onAdd, onDraftChange }: {
  history: HistoryEvent[];
  busy: boolean;
  onAdd: (text: string, requestId: string) => Promise<boolean>;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(5);
  const pending = useRef(false);
  const request = useRef<{ text: string; id: string } | null>(null);
  const notes = [...history].reverse().filter(event => followUpText(event) !== null);
  const dirty = draft.length > 0;
  useEffect(() => { onDraftChange(dirty); }, [dirty, onDraftChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (pending.current || busy || !text || text.length > 2000) return;
    pending.current = true;
    setSaving(true);
    setError('');
    if (request.current?.text !== text) request.current = { text, id: crypto.randomUUID() };
    try {
      if (await onAdd(text, request.current.id)) {
        setDraft('');
        request.current = null;
      } else setError('The note could not be saved. Your text is kept; you can try again.');
    } catch {
      setError('The note could not be saved. Your text is kept; you can try again.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return <section className="detail-section follow-up-section" aria-labelledby="follow-up-title">
    <div className="follow-up-heading"><h3 id="follow-up-title"><MessageSquare size={17}/>Follow-up notes</h3><span className="count-label">{notes.length} note{notes.length === 1 ? '' : 's'}</span></div>
    <p className="caption">Keep a dated record of contacts, decisions and progress. Notes are also saved in History.</p>
    <form className="follow-up-form" onSubmit={event => void submit(event)}>
      <label htmlFor="follow-up-note">Add a follow-up note</label>
      <textarea id="follow-up-note" rows={3} maxLength={2000} value={draft} disabled={busy || saving} placeholder="For example: Contacted the supplier; waiting for the renewed NDA." aria-describedby={`follow-up-help${error ? ' follow-up-error' : ''}`} onChange={event => { setDraft(event.target.value); setError(''); }}/>
      <div className="follow-up-form-footer"><span id="follow-up-help">{draft.length}/2000 characters · {dirty ? 'Unsaved note' : 'Saved notes stay in the activity history.'}</span><button type="submit" className="button primary" disabled={busy || saving || !draft.trim()}><Plus size={16}/>{saving ? 'Saving note…' : 'Save note'}</button></div>
      {error && <p id="follow-up-error" role="alert" className="error-text">{error}</p>}
    </form>
    {notes.length === 0 ? <p className="follow-up-empty">No follow-up notes yet.</p> : <div className="follow-up-list">{notes.slice(0, limit).map(note => <article key={note.id} className="follow-up-note"><p>{followUpText(note)}</p><small>{new Date(note.timestamp).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' })} MYT · {note.actor}</small></article>)}</div>}
    {notes.length > limit && <button type="button" className="text-button" onClick={() => setLimit(value => value + 10)}>Show more notes ({notes.length - limit})</button>}
  </section>;
}
