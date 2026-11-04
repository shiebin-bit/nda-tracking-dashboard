import { describe, expect, it } from 'vitest';
import type { HistoryEvent } from './core';
import { followUpText } from './follow-ups';

const note: HistoryEvent = {
  id: 'a-note', ndaId: 'an-nda', type: 'follow-up-added', timestamp: '2026-10-20T00:30:00Z',
  actor: 'Local user', summary: 'Added follow-up note.',
  changes: [{ field: 'Follow-up note', before: null, after: 'Contacted supplier.\nWaiting for renewal.' }],
};

describe('follow-up History rendering boundary', () => {
  it('extracts a canonical note without altering multiline or formula-like text', () => {
    expect(followUpText(note)).toBe('Contacted supplier.\nWaiting for renewal.');
    expect(followUpText({ ...note, changes: [{ field: 'Follow-up note', before: null, after: '=HYPERLINK("https://example.test") <script>test</script>' }] })).toBe('=HYPERLINK("https://example.test") <script>test</script>');
  });

  it('ignores unrelated activity and malformed restored note events', () => {
    for (const invalid of [
      { ...note, type: 'updated' }, { ...note, ndaId: undefined }, { ...note, actor: 'unknown' },
      { ...note, summary: 'Other event' }, { ...note, changes: [] }, { ...note, changes: [...note.changes, ...note.changes] },
      { ...note, changes: [{ field: 'Other', before: null, after: 'Text' }] },
      { ...note, changes: [{ field: 'Follow-up note', before: 'Old', after: 'Text' }] },
    ]) expect(followUpText(invalid)).toBeNull();
    for (const after of ['', ' padded ', 'x'.repeat(2001), 'has\0null', 42, { html: 'not text' }]) {
      expect(followUpText({ ...note, changes: [{ field: 'Follow-up note', before: null, after }] })).toBeNull();
    }
  });
});
