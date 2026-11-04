import { describe, expect, it, vi } from 'vitest';
import { createEmptyFields, type NdaRecord } from '../src/core';
import type { EmailDelivery } from '../src/email-types';
import { BrevoClient, EmailScheduler, reminderTiming, renderScheduledEmail, renderTestEmail } from './email';

const delivery: EmailDelivery = {
  id: 'delivery-1', kind: 'test', localDate: '2026-10-19', status: 'sending',
  recipientEmail: 'recipient@example.com', ccEmail: '', senderEmail: 'sender@example.com',
  subject: 'Subject', htmlContent: '<p>Body</p>', recordCount: 0,
  createdAt: '2026-10-19T01:00:00.000Z', updatedAt: '2026-10-19T01:00:00.000Z',
  messageId: null, error: null, attempts: 1,
};

describe('Brevo transport', () => {
  it('treats every 2xx response as submitted even when the optional body is invalid', async () => {
    const fetcher = vi.fn(async () => new Response('not-json', { status: 202 })) as unknown as typeof fetch;
    const result = await new BrevoClient('test-key', undefined, fetcher).send(delivery);
    expect(result).toEqual({ status: 'submitted', messageId: null });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('distinguishes definite HTTP rejection from an ambiguous transport failure', async () => {
    const rejected = vi.fn(async () => Response.json(
      { message: 'unrecognised IP address; credential test-key is invalid' }, { status: 400 },
    )) as unknown as typeof fetch;
    await expect(new BrevoClient('test-key', undefined, rejected).send(delivery)).resolves.toEqual({
      status: 'failed',
      error: 'Brevo rejected the request (HTTP 400). unrecognised IP address; credential [redacted] is invalid',
    });
    const ambiguous = vi.fn(async () => { throw new Error('timeout with sensitive detail'); }) as unknown as typeof fetch;
    await expect(new BrevoClient('test-key', undefined, ambiguous).send(delivery)).resolves.toEqual({
      status: 'unknown', error: 'Brevo submission outcome is unknown.',
    });
  });

  it('reports relay state and derives a default only when exactly one active sender exists', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/account')
      ? Response.json({ relay: { enabled: true } })
      : Response.json({ senders: [{ email: 'verified@example.com', name: 'Verified', active: true }] })) as unknown as typeof fetch;
    const status = await new BrevoClient('test-key', undefined, fetcher).status(new Date('2026-10-19T01:00:00Z'));
    expect(status).toMatchObject({ configured: true, connected: true, transactionalEnabled: true, defaultSenderEmail: 'verified@example.com' });
    expect(status.senders).toEqual([{ email: 'verified@example.com', name: 'Verified', active: true }]);
  });
});

describe('email rendering and scheduling', () => {
  it('computes paused, scheduled, and awaiting states at MYT boundaries', () => {
    expect(reminderTiming(false, '09:00', false, new Date('2026-10-19T00:59:00Z'))).toEqual({
      today: '2026-10-19', nextCheckAt: null, nextCheckState: 'paused',
    });
    expect(reminderTiming(true, '09:00', false, new Date('2026-10-19T00:59:00Z'))).toEqual({
      today: '2026-10-19', nextCheckAt: '2026-10-19T01:00:00.000Z', nextCheckState: 'scheduled',
    });
    expect(reminderTiming(true, '09:00', false, new Date('2026-10-19T01:00:00Z'))).toEqual({
      today: '2026-10-19', nextCheckAt: '2026-10-19T01:00:00.000Z', nextCheckState: 'awaiting_check',
    });
    expect(reminderTiming(true, '09:00', true, new Date('2026-10-19T01:01:00Z'))).toEqual({
      today: '2026-10-19', nextCheckAt: '2026-10-20T01:00:00.000Z', nextCheckState: 'scheduled',
    });
    expect(reminderTiming(true, '09:00', false, new Date('2026-10-18T16:30:00Z'))).toEqual({
      today: '2026-10-19', nextCheckAt: '2026-10-19T01:00:00.000Z', nextCheckState: 'scheduled',
    });
  });

  it('renders the selected candidate snapshot safely and keeps test content synthetic', () => {
    const fields = {
      ...createEmptyFields(), 'No.': 7, Recipient: '<Acme>', PIC: 'Lee & Co',
      'Date of Agreement': '2025-11-18', Duration: 1, UOM: 'years', Status: 'Pending',
    };
    const record: NdaRecord = {
      id: 'record-1', fields, version: 1, source: 'manual',
      createdAt: '2025-11-18T00:00:00Z', updatedAt: '2025-11-18T00:00:00Z',
    };
    const rendered = renderScheduledEmail([record], '2026-10-19', [30]);
    expect(rendered.subject).toBe('NDA Daily Reminder — 19/10/2026');
    expect(rendered.htmlContent).toContain('&lt;Acme&gt;');
    expect(rendered.htmlContent).toContain('Lee &amp; Co');
    expect(rendered.htmlContent).toContain('30-day reminder');
    expect(rendered.htmlContent).toContain('background:#315b80');
    expect(renderTestEmail().htmlContent).toContain('contains no NDA data');
  });

  it('does not overlap scheduler ticks and waits for an active tick when stopping', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const runScheduled = vi.fn(async () => pending);
    const scheduler = new EmailScheduler({ runScheduled } as never, 60_000);
    const first = scheduler.tick(new Date('2026-10-19T01:00:00Z'));
    await scheduler.tick(new Date('2026-10-19T01:01:00Z'));
    expect(runScheduled).toHaveBeenCalledOnce();
    const stopping = scheduler.stop();
    finish();
    await Promise.all([first, stopping]);
  });
});
