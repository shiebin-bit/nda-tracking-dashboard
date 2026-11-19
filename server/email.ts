import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from './db.js';
import { dateLabel, derive, getCandidates, todayMY, type NdaRecord, type Settings } from '../src/core.js';
import type { EmailDelivery, EmailStatus, ReminderSummary, ReminderTaskSummary } from '../src/email-types.js';
import type { ServerConfig } from './config.js';
import { normalizeSettings } from './domain.js';
import { badRequest, conflict, notFound } from './errors.js';
import { withTransaction } from './db.js';

const BREVO_BASE_URL = 'https://api.brevo.com/v3';
const FETCH_TIMEOUT_MS = 20_000;
const SENDING_LEASE_MS = 120_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BrevoSendResult =
  | { status: 'submitted'; messageId: string | null }
  | { status: 'failed'; error: string }
  | { status: 'unknown'; error: string };

type DeliveryRow = {
  id: string;
  kind: EmailDelivery['kind'];
  local_date: string | Date;
  status: EmailDelivery['status'];
  recipient_email: string;
  cc_email: string;
  cc_emails: string[];
  sender_email: string;
  subject: string;
  html_content: string;
  record_count: number;
  created_at: string | Date;
  updated_at: string | Date;
  message_id: string | null;
  error: string | null;
  attempts: number;
};

type DeliveryClaim = { delivery: EmailDelivery; shouldSend: boolean };
type SummaryTaskRow = {
  slot: 'today' | 'latest';
  id: string;
  local_date: string;
  status: EmailDelivery['status'];
  record_count: number;
  created_at: string | Date;
  updated_at: string | Date;
  error: string | null;
};
const DELIVERY_COLUMNS = `id,kind,CAST(local_date AS TEXT) AS local_date,status,recipient_email,cc_email,cc_emails,
  sender_email,subject,html_content,record_count,created_at,updated_at,message_id,error,attempts`;

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function localDate(value: string | Date): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function mapDelivery(row: DeliveryRow): EmailDelivery {
  return {
    id: row.id,
    kind: row.kind,
    localDate: localDate(row.local_date),
    status: row.status,
    recipientEmail: row.recipient_email,
    ccEmail: row.cc_email,
    ccEmails: Array.isArray(row.cc_emails) && row.cc_emails.length ? row.cc_emails : row.cc_email ? [row.cc_email] : [],
    senderEmail: row.sender_email,
    subject: row.subject,
    htmlContent: row.html_content,
    recordCount: row.record_count,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    messageId: row.message_id,
    error: row.error,
    attempts: row.attempts,
  };
}

function assertRequestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw badRequest('requestId must be a UUID.');
  }
  return value.toLowerCase();
}

function assertEmail(value: unknown, label: string): string {
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value.trim())) {
    throw badRequest(`${label} must be a valid email address.`);
  }
  return value.trim();
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function brevoError(response: Response, fallback: string, apiKey: string): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message !== 'string' || !body.message.trim()) return fallback;
    const safe = body.message.replaceAll(apiKey, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 500);
    return `${fallback} ${safe}`;
  } catch {
    return fallback;
  }
}

function myTime(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

function addLocalDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function plannedCheckAt(localDay: string, sendTime: string): string {
  return new Date(`${localDay}T${sendTime}:00+08:00`).toISOString();
}

export function reminderTiming(
  enabled: boolean,
  sendTime: string,
  hasTodayResult: boolean,
  now: Date,
): Pick<ReminderSummary, 'today' | 'nextCheckAt' | 'nextCheckState'> {
  const today = todayMY(now);
  if (!enabled) return { today, nextCheckAt: null, nextCheckState: 'paused' };
  if (hasTodayResult) {
    return {
      today,
      nextCheckAt: plannedCheckAt(addLocalDays(today, 1), sendTime),
      nextCheckState: 'scheduled',
    };
  }
  const beforeSavedTime = myTime(now) < sendTime;
  return {
    today,
    nextCheckAt: plannedCheckAt(today, sendTime),
    nextCheckState: beforeSavedTime ? 'scheduled' : 'awaiting_check',
  };
}

export function renderScheduledEmail(
  records: NdaRecord[],
  today: string,
  reminderDays: readonly number[],
): { subject: string; htmlContent: string } {
  const ordered = [...records].sort((left, right) =>
    (derive(left, today, reminderDays).remainingDays ?? 0) - (derive(right, today, reminderDays).remainingDays ?? 0));
  const rows = ordered.map((record) => {
    const result = derive(record, today, reminderDays);
    const phase = result.phase === 'overdue' ? 'Expired' : `${result.remainingDays}-day reminder`;
    return `<tr>${[record.fields.Recipient, result.remainingDays, record.fields.PIC || '—', phase]
      .map((value) => `<td style="padding:14px;border:1px solid #cad4dc">${escapeHtml(value)}</td>`).join('')}</tr>`;
  }).join('');
  const headers = ['Recipient', 'Remaining Days', 'PIC', 'Reminder Phase']
    .map((value) => `<th style="text-align:left;padding:14px;background:#315b80;color:white;border:1px solid #cad4dc">${value}</th>`).join('');
  return {
    subject: `NDA Daily Reminder — ${dateLabel(today)}`,
    htmlContent: `<!doctype html><html><head><meta charset="UTF-8"><title>NDA Daily Reminder</title></head><body style="font-family:Arial,sans-serif;color:#243b49;max-width:1000px;margin:32px auto;padding:24px"><h1>NDA Daily Reminder</h1><p>As of ${escapeHtml(dateLabel(today))} · Malaysia time</p><p>The following Pending NDAs are expired or meet a scheduled reminder milestone. Please review and take the necessary action.</p><table style="border-collapse:collapse;width:100%"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table><p>Negative remaining days indicate an expired NDA.</p></body></html>`,
  };
}

export function renderTestEmail(): { subject: string; htmlContent: string } {
  return {
    subject: '[TEST] NDA reminder email connection',
    htmlContent: '<!doctype html><html><body><h1>NDA reminder email test</h1><p>This synthetic message confirms that the NDA dashboard can submit transactional email through Brevo. It contains no NDA data.</p></body></html>',
  };
}

export class BrevoClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly defaultSenderEmail: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async status(now = new Date()): Promise<EmailStatus> {
    const base: EmailStatus = {
      configured: Boolean(this.apiKey), connected: false, transactionalEnabled: false,
      senders: [], error: null, checkedAt: now.toISOString(),
      defaultSenderEmail: this.defaultSenderEmail ?? null,
    };
    if (!this.apiKey) return { ...base, error: 'Brevo API key is not configured.' };
    try {
      const headers = { accept: 'application/json', 'api-key': this.apiKey };
      const [accountResponse, sendersResponse] = await Promise.all([
        this.fetcher(`${BREVO_BASE_URL}/account`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
        this.fetcher(`${BREVO_BASE_URL}/senders`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      ]);
      if (!accountResponse.ok || !sendersResponse.ok) {
        const rejected = !accountResponse.ok ? accountResponse : sendersResponse;
        return { ...base, error: await brevoError(rejected, 'Brevo rejected the status check.', this.apiKey) };
      }
      const account = await accountResponse.json() as { relay?: { enabled?: unknown } };
      const senderBody = await sendersResponse.json() as {
        senders?: { email?: unknown; name?: unknown; active?: unknown }[];
      };
      const senders = Array.isArray(senderBody.senders) ? senderBody.senders.flatMap((sender) =>
        typeof sender.email === 'string'
          ? [{ email: sender.email, name: typeof sender.name === 'string' ? sender.name : '', active: sender.active === true }]
          : []) : [];
      const activeSenders = senders.filter((sender) => sender.active);
      return {
        ...base,
        connected: true,
        transactionalEnabled: account.relay?.enabled === true,
        senders,
        defaultSenderEmail: this.defaultSenderEmail ?? (activeSenders.length === 1 ? activeSenders[0].email : null),
      };
    } catch {
      return { ...base, error: 'Brevo status is temporarily unavailable.' };
    }
  }

  async send(delivery: EmailDelivery): Promise<BrevoSendResult> {
    if (!this.apiKey) return { status: 'failed', error: 'Brevo API key is not configured.' };
    const payload: Record<string, unknown> = {
      sender: { email: delivery.senderEmail, name: 'NDA Reminder' },
      replyTo: { email: delivery.senderEmail, name: 'NDA Reminder' },
      to: [{ email: delivery.recipientEmail }],
      subject: delivery.subject,
      htmlContent: delivery.htmlContent,
    };
    const ccEmails = delivery.ccEmails ?? (delivery.ccEmail ? [delivery.ccEmail] : []);
    if (ccEmails.length) payload.cc = ccEmails.map((email) => ({ email }));
    try {
      const response = await this.fetcher(`${BREVO_BASE_URL}/smtp/email`, {
        method: 'POST',
        headers: { accept: 'application/json', 'api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          status: 'failed',
          error: await brevoError(response, `Brevo rejected the request (HTTP ${response.status}).`, this.apiKey),
        };
      }
      let messageId: string | null = null;
      try {
        const value = await response.json() as { messageId?: unknown };
        if (typeof value.messageId === 'string') messageId = value.messageId;
      } catch {
        // Response headers prove acceptance even if the optional response body is unavailable.
      }
      return { status: 'submitted', messageId };
    } catch {
      return { status: 'unknown', error: 'Brevo submission outcome is unknown.' };
    }
  }
}

async function deliveryById(client: Pool | PoolClient, id: string, lock = false): Promise<EmailDelivery | null> {
  // Transaction callers already hold the database-wide BEGIN IMMEDIATE writer lock.
  const result = await client.query<DeliveryRow>(`SELECT ${DELIVERY_COLUMNS} FROM email_delivery WHERE id=$1`, [id]);
  return result.rows[0] ? mapDelivery(result.rows[0]) : null;
}

async function records(client: PoolClient): Promise<NdaRecord[]> {
  const result = await client.query(`SELECT CAST(id AS TEXT) id,version,source,created_at,updated_at,CAST(renewed_from_id AS TEXT) renewed_from_id,fields
    FROM nda_record WHERE deleted_at IS NULL ORDER BY position ASC`);
  return result.rows.map((row) => ({
    id: row.id, version: row.version, source: row.source, fields: row.fields,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(row.renewed_from_id ? { renewedFromId: row.renewed_from_id } : {}),
  }));
}

async function currentSettings(client: PoolClient, lock = false): Promise<Settings> {
  const result = await client.query<{ settings: unknown }>('SELECT settings FROM workspace WHERE id=1');
  if (!result.rows[0]) throw new Error('Database workspace is not initialized.');
  return normalizeSettings(result.rows[0].settings, true);
}

async function insertDelivery(client: PoolClient, delivery: EmailDelivery): Promise<void> {
  await client.query(`INSERT INTO email_delivery(
    id,kind,local_date,status,recipient_email,cc_email,cc_emails,sender_email,subject,html_content,
    record_count,created_at,updated_at,message_id,error,attempts
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
    delivery.id, delivery.kind, delivery.localDate, delivery.status, delivery.recipientEmail,
    delivery.ccEmail, delivery.ccEmails ?? (delivery.ccEmail ? [delivery.ccEmail] : []), delivery.senderEmail, delivery.subject, delivery.htmlContent,
    delivery.recordCount, delivery.createdAt, delivery.updatedAt, delivery.messageId,
    delivery.error, delivery.attempts,
  ]);
}

export class PgEmailStore {
  constructor(private readonly pool: Pool) {}

  async recoverStale(now = new Date()): Promise<void> {
    const threshold = new Date(now.getTime() - SENDING_LEASE_MS).toISOString();
    await withTransaction(this.pool, async (client) => {
      const changed = await client.query<{ id: string }>(`UPDATE email_delivery
        SET status='unknown',error='Submission outcome is unknown after an interrupted sending attempt.',updated_at=$1
        WHERE status='sending' AND updated_at <= $2 RETURNING id`, [now.toISOString(), threshold]);
      for (const row of changed.rows) {
        await client.query(`UPDATE email_job SET status='unknown',updated_at=$1
          WHERE delivery_id=$2 AND status='sending'`, [now.toISOString(), row.id]);
      }
    });
  }

  async list(): Promise<EmailDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(`SELECT ${DELIVERY_COLUMNS} FROM email_delivery ORDER BY created_at DESC,id DESC LIMIT 100`);
    return result.rows.map(mapDelivery);
  }

  async find(id: string): Promise<EmailDelivery> {
    const delivery = await deliveryById(this.pool, id);
    if (!delivery) throw notFound('Email delivery was not found.');
    return delivery;
  }

  async settings(): Promise<Settings> {
    const result = await this.pool.query<{ settings: unknown }>('SELECT settings FROM workspace WHERE id=1');
    if (!result.rows[0]) throw new Error('Database workspace is not initialized.');
    return normalizeSettings(result.rows[0].settings, true);
  }

  async summary(now = new Date()): Promise<ReminderSummary> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const settings = await currentSettings(client);
      const today = todayMY(now);
      const result = await client.query<SummaryTaskRow>(`WITH scheduled_tasks AS (
        SELECT COALESCE(d.id,j.id) id,CAST(j.local_date AS TEXT) local_date,
          COALESCE(d.status,j.status) status,COALESCE(d.record_count,0) record_count,
          COALESCE(d.created_at,j.created_at) created_at,
          COALESCE(max(d.updated_at,j.updated_at),d.updated_at,j.updated_at) updated_at,d.error
        FROM email_job j
        LEFT JOIN email_delivery d ON d.id=j.delivery_id AND d.kind='scheduled' AND d.local_date=j.local_date
        UNION ALL
        SELECT d.id,CAST(d.local_date AS TEXT) local_date,d.status,d.record_count,d.created_at,d.updated_at,d.error
        FROM email_delivery d
        WHERE d.kind='scheduled' AND NOT EXISTS (
          SELECT 1 FROM email_job j WHERE j.delivery_id=d.id AND j.local_date=d.local_date
        )
      ), today_task AS (
        SELECT * FROM scheduled_tasks WHERE local_date=$1 ORDER BY created_at DESC,id DESC LIMIT 1
      ), latest_task AS (
        SELECT * FROM scheduled_tasks ORDER BY created_at DESC,id DESC LIMIT 1
      )
      SELECT 'today' slot,* FROM today_task
      UNION ALL
      SELECT 'latest' slot,* FROM latest_task`, [today]);
      await client.query('COMMIT');
      const mapTask = (row: SummaryTaskRow | undefined): ReminderTaskSummary | null => row ? ({
        id: row.id, localDate: row.local_date, status: row.status, recordCount: row.record_count,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), error: row.error,
      }) : null;
      const todayResult = mapTask(result.rows.find((row) => row.slot === 'today'));
      const latestResult = mapTask(result.rows.find((row) => row.slot === 'latest'));
      const enabled = settings.automaticRemindersEnabled === true;
      const timing = reminderTiming(enabled, settings.sendTime, todayResult !== null, now);
      return {
        enabled,
        recipientEmail: settings.recipientEmail,
        ccEmail: settings.ccEmail,
        ccEmails: settings.ccEmails ?? (settings.ccEmail ? [settings.ccEmail] : []),
        sendTime: settings.sendTime,
        timeZone: 'Asia/Kuala_Lumpur',
        serverTime: now.toISOString(),
        ...timing,
        todayResult,
        latestResult,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async existingRequest(requestId: string): Promise<EmailDelivery | null> {
    const result = await this.pool.query<{ delivery_id: string; action: string }>('SELECT delivery_id,action FROM email_request WHERE request_id=$1', [requestId]);
    if (result.rows[0] && result.rows[0].action !== 'test') {
      throw conflict('requestId was already used for another email action.', 'email_request_reused');
    }
    return result.rows[0] ? deliveryById(this.pool, result.rows[0].delivery_id) : null;
  }

  async claimTest(recipientEmail: string, requestId: string, senderEmail: string, now = new Date()): Promise<DeliveryClaim> {
    return withTransaction(this.pool, async (client) => {
      const prior = await client.query<{ delivery_id: string; action: string }>('SELECT delivery_id,action FROM email_request WHERE request_id=$1', [requestId]);
      if (prior.rows[0]) {
        if (prior.rows[0].action !== 'test') throw conflict('requestId was already used for another email action.', 'email_request_reused');
        const delivery = await deliveryById(client, prior.rows[0].delivery_id);
        if (!delivery) throw new Error('Email request references a missing delivery.');
        return { delivery, shouldSend: false };
      }
      const content = renderTestEmail();
      const timestamp = now.toISOString();
      const delivery: EmailDelivery = {
        id: randomUUID(), kind: 'test', localDate: todayMY(now), status: 'sending',
        recipientEmail, ccEmail: '', ccEmails: [], senderEmail, ...content, recordCount: 0,
        createdAt: timestamp, updatedAt: timestamp, messageId: null, error: null, attempts: 1,
      };
      await insertDelivery(client, delivery);
      await client.query("INSERT INTO email_request(request_id,action,delivery_id,created_at) VALUES($1,'test',$2,$3)", [requestId, delivery.id, timestamp]);
      return { delivery, shouldSend: true };
    });
  }

  async claimScheduled(now = new Date()): Promise<DeliveryClaim | null> {
    return withTransaction(this.pool, async (client) => {
      const settings = await currentSettings(client, true);
      if (settings.automaticRemindersEnabled !== true || myTime(now) < settings.sendTime) return null;
      const date = todayMY(now);
      const jobId = randomUUID();
      const timestamp = now.toISOString();
      const inserted = await client.query(`INSERT INTO email_job(id,local_date,status,created_at,updated_at)
        VALUES($1,$2,'sending',$3,$3) ON CONFLICT(local_date) DO NOTHING RETURNING id`, [jobId, date, timestamp]);
      if (!inserted.rowCount) return null;
      const candidates = getCandidates(await records(client), date, settings.reminderDays);
      const sender = settings.senderEmail.trim();
      const content = candidates.length ? renderScheduledEmail(candidates, date, settings.reminderDays) : { subject: '', htmlContent: '' };
      const delivery: EmailDelivery = {
        id: randomUUID(), kind: 'scheduled', localDate: date,
        status: candidates.length ? 'sending' : 'skipped',
        recipientEmail: settings.recipientEmail, ccEmail: settings.ccEmail,
        ccEmails: settings.ccEmails ?? (settings.ccEmail ? [settings.ccEmail] : []), senderEmail: sender,
        ...content, recordCount: candidates.length, createdAt: timestamp, updatedAt: timestamp,
        messageId: null, error: candidates.length ? null : 'No NDA reminders were due.',
        attempts: candidates.length ? 1 : 0,
      };
      await insertDelivery(client, delivery);
      await client.query('UPDATE email_job SET status=$2,delivery_id=$3,updated_at=$4 WHERE id=$1', [jobId, delivery.status, delivery.id, timestamp]);
      return { delivery, shouldSend: candidates.length > 0 };
    });
  }

  async claimRetry(id: string, requestId: string, now = new Date()): Promise<DeliveryClaim> {
    return withTransaction(this.pool, async (client) => {
      const prior = await client.query<{ delivery_id: string }>('SELECT delivery_id FROM email_request WHERE request_id=$1', [requestId]);
      if (prior.rows[0]) {
        if (prior.rows[0].delivery_id !== id) throw conflict('requestId was already used for another email.', 'email_request_reused');
        const delivery = await deliveryById(client, prior.rows[0].delivery_id);
        if (!delivery) throw new Error('Email request references a missing delivery.');
        return { delivery, shouldSend: false };
      }
      const delivery = await deliveryById(client, id, true);
      if (!delivery) throw notFound('Email delivery was not found.');
      if (delivery.status !== 'failed') throw conflict('Only a definitely failed email can be retried.', 'email_not_retryable');
      const timestamp = now.toISOString();
      let replacement = delivery;
      let shouldSend = true;
      if (delivery.kind === 'scheduled') {
        const date = todayMY(now);
        if (delivery.localDate !== date) throw conflict('Scheduled reminders can only be retried on the same local day.', 'email_retry_expired');
        const settings = await currentSettings(client, true);
        if (settings.automaticRemindersEnabled !== true) throw conflict('Automatic reminders are disabled.', 'email_retry_disabled');
        const candidates = getCandidates(await records(client), date, settings.reminderDays);
        const content = candidates.length ? renderScheduledEmail(candidates, date, settings.reminderDays) : { subject: '', htmlContent: '' };
        replacement = {
          ...delivery, status: candidates.length ? 'sending' : 'skipped',
          recipientEmail: settings.recipientEmail, ccEmail: settings.ccEmail,
          ccEmails: settings.ccEmails ?? (settings.ccEmail ? [settings.ccEmail] : []),
          senderEmail: settings.senderEmail, ...content, recordCount: candidates.length,
          updatedAt: timestamp, messageId: null,
          error: candidates.length ? null : 'No NDA reminders were due.',
          attempts: delivery.attempts + (candidates.length ? 1 : 0),
        };
        shouldSend = candidates.length > 0;
      } else {
        replacement = { ...delivery, status: 'sending', updatedAt: timestamp, messageId: null, error: null, attempts: delivery.attempts + 1 };
      }
      await client.query(`UPDATE email_delivery SET status=$2,recipient_email=$3,cc_email=$4,cc_emails=$5,sender_email=$6,
        subject=$7,html_content=$8,record_count=$9,updated_at=$10,message_id=$11,error=$12,attempts=$13 WHERE id=$1`, [
        id, replacement.status, replacement.recipientEmail, replacement.ccEmail,
        replacement.ccEmails ?? (replacement.ccEmail ? [replacement.ccEmail] : []), replacement.senderEmail,
        replacement.subject, replacement.htmlContent, replacement.recordCount, replacement.updatedAt,
        replacement.messageId, replacement.error, replacement.attempts,
      ]);
      if (delivery.kind === 'scheduled') {
        await client.query('UPDATE email_job SET status=$2,updated_at=$3 WHERE delivery_id=$1', [id, replacement.status, timestamp]);
      }
      await client.query("INSERT INTO email_request(request_id,action,delivery_id,created_at) VALUES($1,'retry',$2,$3)", [requestId, id, timestamp]);
      return { delivery: replacement, shouldSend };
    });
  }

  async finalize(id: string, result: BrevoSendResult, now = new Date()): Promise<EmailDelivery> {
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query<DeliveryRow>(`UPDATE email_delivery SET status=$2,message_id=$3,error=$4,updated_at=$5
        WHERE id=$1 AND status='sending' RETURNING ${DELIVERY_COLUMNS}`, [
        id, result.status, result.status === 'submitted' ? result.messageId : null,
        result.status === 'submitted' ? null : result.error, now.toISOString(),
      ]);
      if (!updated.rows[0]) throw conflict('Email delivery is no longer in a sending state.', 'email_state_conflict');
      const delivery = mapDelivery(updated.rows[0]);
      if (delivery.kind === 'scheduled') {
        await client.query('UPDATE email_job SET status=$2,updated_at=$3 WHERE delivery_id=$1', [id, delivery.status, delivery.updatedAt]);
      }
      return delivery;
    });
  }
}

export class EmailService {
  readonly store: PgEmailStore;
  readonly brevo: BrevoClient;

  constructor(pool: Pool, config: Pick<ServerConfig, 'brevoApiKey' | 'defaultSenderEmail'>, fetcher: typeof fetch = fetch) {
    this.store = new PgEmailStore(pool);
    this.brevo = new BrevoClient(config.brevoApiKey, config.defaultSenderEmail, fetcher);
  }

  async status(): Promise<EmailStatus> {
    return this.brevo.status();
  }

  async validateAutomaticSettings(settings: Settings): Promise<void> {
    const recipient = assertEmail(settings.recipientEmail, 'recipientEmail');
    const sender = assertEmail(settings.senderEmail, 'senderEmail');
    if (!recipient || !sender) throw badRequest('Sender and recipient email addresses are required.');
    const status = await this.status();
    if (!status.connected || !status.transactionalEnabled) {
      throw badRequest('Brevo transactional email is not available.', 'email_not_available');
    }
    if (!status.senders.some((entry) => entry.active && entry.email.toLowerCase() === sender.toLowerCase())) {
      throw badRequest('senderEmail must be an active verified Brevo sender.', 'email_sender_not_verified');
    }
  }

  async deliveries(): Promise<EmailDelivery[]> {
    return this.store.list();
  }

  async summary(now = new Date()): Promise<ReminderSummary> {
    return this.store.summary(now);
  }

  private async submit(claim: DeliveryClaim): Promise<EmailDelivery> {
    if (!claim.shouldSend) return claim.delivery;
    const result = await this.brevo.send(claim.delivery);
    return this.store.finalize(claim.delivery.id, result);
  }

  async test(input: unknown): Promise<EmailDelivery> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw badRequest('Request body must be an object.');
    const value = input as Record<string, unknown>;
    const requestId = assertRequestId(value.requestId);
    const prior = await this.store.existingRequest(requestId);
    if (prior) return prior;
    const recipient = assertEmail(value.recipientEmail, 'recipientEmail');
    const status = await this.status();
    if (!status.connected || !status.transactionalEnabled) throw badRequest('Brevo transactional email is not available.', 'email_not_available');
    const normalized = await this.store.settings();
    const preferred = normalized.senderEmail || status.defaultSenderEmail || '';
    const active = status.senders.filter((entry) => entry.active);
    const sender = active.find((entry) => entry.email.toLowerCase() === preferred.toLowerCase())?.email
      ?? (!preferred && active.length === 1 ? active[0].email : undefined);
    if (!sender) throw badRequest('No active verified Brevo sender is available.', 'email_sender_not_verified');
    return this.submit(await this.store.claimTest(recipient, requestId, sender));
  }

  async retry(id: string, input: unknown): Promise<EmailDelivery> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw badRequest('Request body must be an object.');
    const requestId = assertRequestId((input as Record<string, unknown>).requestId);
    return this.submit(await this.store.claimRetry(id, requestId));
  }

  async runScheduled(now = new Date()): Promise<EmailDelivery | null> {
    await this.store.recoverStale(now);
    const claim = await this.store.claimScheduled(now);
    return claim ? this.submit(claim) : null;
  }
}

export class EmailScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(private readonly service: EmailService, private readonly intervalMs = 60_000) {}

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.service.runScheduled(now);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error', event: 'email_scheduler_failed',
        message: error instanceof Error ? error.message : 'Unknown scheduler error',
      }));
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
