import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyFields, derive, type Fields } from '../src/core';
import { migrate } from './db';
import { PgEmailStore } from './email';
import { PgNdaStore } from './store';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('incremental PostgreSQL migration adoption', () => {
  const schema = `test_email_migration_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const initial = await readFile(resolve(process.cwd(), 'migrations/001_initial.sql'), 'utf8');
    await pool.query(initial);
    await pool.query("UPDATE workspace SET revision=2,settings=settings-'automaticRemindersEnabled' WHERE id=1");
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('adopts 001, applies 002, and preserves workspace state without a revision bump', async () => {
    await Promise.all([migrate(pool), migrate(pool)]);
    const state = await pool.query(`SELECT revision::text,settings FROM workspace WHERE id=1`);
    expect(state.rows[0]).toMatchObject({ revision: '2', settings: { automaticRemindersEnabled: false } });
    const applied = await pool.query('SELECT name FROM schema_migration ORDER BY name');
    expect(applied.rows.map((row) => row.name)).toEqual([
      '001_initial.sql', '002_email_delivery.sql', '003_contracts.sql', '004_recycle_bin.sql', '005_signed_files.sql',
    ]);
    await expect(pool.query('SELECT count(*)::integer count FROM email_delivery')).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});

suite('PostgreSQL email delivery state machine', () => {
  const schema = `test_email_delivery_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let admin: Pool;
  let pool: Pool;
  let nda: PgNdaStore;
  let email: PgEmailStore;
  const now = new Date('2026-10-19T01:00:00.000Z');
  const valid = (overrides: Partial<Fields> = {}): Fields => ({
    ...createEmptyFields(), Recipient: 'Due agreement', 'Date of Agreement': '2025-11-18',
    Duration: 1, UOM: 'years', PIC: 'Lee', Status: 'Pending', ...overrides,
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await migrate(pool);
    nda = new PgNdaStore(pool, async () => undefined);
    email = new PgEmailStore(pool);
    const created = await nda.create({ fields: valid() });
    expect(derive(created.snapshot.records[0], '2026-10-19', [30]).remainingDays).toBe(30);
    await nda.updateSettings({
      expectedRevision: created.revision,
      settings: {
        ...created.snapshot.settings,
        recipientEmail: 'first@example.com', ccEmail: 'copy@example.com', senderEmail: 'sender@example.com',
        sendTime: '09:00', reminderDays: [30], automaticRemindersEnabled: true,
      },
    });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('allows only one cross-process daily claim and regenerates a failed retry from current settings', async () => {
    const firstStore = new PgEmailStore(pool);
    const secondStore = new PgEmailStore(pool);
    const claims = await Promise.all([firstStore.claimScheduled(now), secondStore.claimScheduled(now)]);
    const claim = claims.find((value) => value !== null)!;
    expect(claim.delivery).toMatchObject({ status: 'sending', recipientEmail: 'first@example.com', recordCount: 1, attempts: 1 });
    expect(claims.filter(Boolean)).toHaveLength(1);

    const failed = await email.finalize(claim.delivery.id, { status: 'failed', error: 'Brevo rejected the request (HTTP 400).' }, now);
    expect(failed.status).toBe('failed');
    const state = await nda.state();
    await nda.updateSettings({
      expectedRevision: state.revision,
      settings: { ...state.snapshot.settings, recipientEmail: 'changed@example.com' },
    });
    const retried = await email.claimRetry(claim.delivery.id, randomUUID(), new Date('2026-10-19T02:00:00.000Z'));
    expect(retried).toMatchObject({ shouldSend: true, delivery: { status: 'sending', recipientEmail: 'changed@example.com', recordCount: 1, attempts: 2 } });
    const submitted = await email.finalize(retried.delivery.id, { status: 'submitted', messageId: '<provider-id>' }, new Date('2026-10-19T02:00:01.000Z'));
    expect(submitted).toMatchObject({ status: 'submitted', messageId: '<provider-id>', error: null });
    await expect(email.claimScheduled(new Date('2026-10-19T03:00:00.000Z'))).resolves.toBeNull();
    await expect(email.claimRetry(submitted.id, randomUUID(), new Date('2026-10-19T03:00:00.000Z'))).rejects.toMatchObject({ code: 'email_not_retryable' });
  });

  it('deduplicates concurrent test request IDs and turns stale sending leases into terminal unknown', async () => {
    const requestId = randomUUID();
    const [left, right] = await Promise.all([
      email.claimTest('test@example.com', requestId, 'sender@example.com', now),
      email.claimTest('test@example.com', requestId, 'sender@example.com', now),
    ]);
    expect([left.shouldSend, right.shouldSend].sort()).toEqual([false, true]);
    expect(left.delivery.id).toBe(right.delivery.id);
    await pool.query("UPDATE email_delivery SET updated_at=$2 WHERE id=$1", [left.delivery.id, new Date(now.getTime() - 180_000).toISOString()]);
    await email.recoverStale(now);
    const recovered = await email.find(left.delivery.id);
    expect(recovered.status).toBe('unknown');
    await expect(email.claimRetry(recovered.id, randomUUID(), now)).rejects.toMatchObject({ code: 'email_not_retryable' });
  });

  it('keeps the mail ledger across restore, forces automation off, and records a no-candidate day as skipped', async () => {
    const before = await nda.state();
    const deliveryCount = (await email.list()).length;
    const restored = await nda.restore({ expectedRevision: before.revision, snapshot: before.snapshot });
    expect(restored.snapshot.settings.automaticRemindersEnabled).toBe(false);
    expect(await email.list()).toHaveLength(deliveryCount);

    const enabled = await nda.updateSettings({
      expectedRevision: restored.revision,
      settings: { ...restored.snapshot.settings, automaticRemindersEnabled: true },
    });
    expect(enabled.snapshot.settings.automaticRemindersEnabled).toBe(true);
    const skipped = await email.claimScheduled(new Date('2026-10-20T01:00:00.000Z'));
    expect(skipped).toMatchObject({ shouldSend: false, delivery: { status: 'skipped', recordCount: 0, attempts: 0 } });
    await expect(email.claimScheduled(new Date('2026-10-20T02:00:00.000Z'))).resolves.toBeNull();
  });
});

suite('PostgreSQL scheduler timing and expired-day contract', () => {
  const schema = `test_email_schedule_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let admin: Pool;
  let pool: Pool;
  let email: PgEmailStore;

  const row = (recipient: string, overrides: Partial<Fields> = {}): Fields => ({
    ...createEmptyFields(), Recipient: recipient, 'Date of Agreement': '2024-01-01',
    Duration: 1, UOM: 'years', PIC: 'Lee', Status: 'Pending', ...overrides,
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await migrate(pool);
    const nda = new PgNdaStore(pool, async () => undefined);
    const imported = await nda.importRows({ rows: [
      row('Expired pending'),
      row('Expired resolved', { Status: 'Resolved' }),
      row('Missing agreement date', { 'Date of Agreement': null }),
    ] });
    await nda.updateSettings({
      expectedRevision: imported.revision,
      settings: {
        ...imported.snapshot.settings,
        recipientEmail: 'digest@example.com', senderEmail: 'sender@example.com',
        sendTime: '09:00', reminderDays: [30], automaticRemindersEnabled: true,
      },
    });
    email = new PgEmailStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('claims only the current day after the saved time and includes expired Pending records on consecutive days', async () => {
    await expect(email.claimScheduled(new Date('2026-10-19T00:59:00.000Z'))).resolves.toBeNull();
    await expect(pool.query('SELECT count(*)::integer count FROM email_job')).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const catchup = await email.claimScheduled(new Date('2026-10-19T01:05:00.000Z'));
    expect(catchup).toMatchObject({
      shouldSend: true,
      delivery: { localDate: '2026-10-19', status: 'sending', recordCount: 1 },
    });
    expect(catchup!.delivery.htmlContent).toContain('Expired pending');
    expect(catchup!.delivery.htmlContent).not.toContain('Expired resolved');
    expect(catchup!.delivery.htmlContent).not.toContain('Missing agreement date');
    await email.finalize(catchup!.delivery.id, { status: 'submitted', messageId: '<day-one>' }, new Date('2026-10-19T01:05:01.000Z'));

    const nextDay = await email.claimScheduled(new Date('2026-10-20T01:00:00.000Z'));
    expect(nextDay).toMatchObject({
      shouldSend: true,
      delivery: { localDate: '2026-10-20', status: 'sending', recordCount: 1 },
    });
    expect(nextDay!.delivery.htmlContent).toContain('Expired pending');
    await email.finalize(nextDay!.delivery.id, { status: 'submitted', messageId: '<day-two>' }, new Date('2026-10-20T01:00:01.000Z'));

    const jobs = await pool.query<{ local_date: string }>('SELECT local_date::text FROM email_job ORDER BY local_date');
    expect(jobs.rows.map((job) => job.local_date)).toEqual(['2026-10-19', '2026-10-20']);
  });
});

suite('PostgreSQL read-only reminder summary', () => {
  const schema = `test_email_summary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let admin: Pool;
  let pool: Pool;
  let email: PgEmailStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await migrate(pool);
    await pool.query(`UPDATE workspace SET settings=jsonb_build_object(
      'recipientEmail','digest@example.com','ccEmail','copy@example.com','senderEmail','sender@example.com',
      'sendTime','09:00','timeZone','Asia/Kuala_Lumpur','reminderDays',jsonb_build_array(30),
      'automaticRemindersEnabled',true
    ) WHERE id=1`);
    await pool.query(`INSERT INTO email_delivery(
      id,kind,local_date,status,recipient_email,cc_email,sender_email,subject,html_content,
      record_count,created_at,updated_at,message_id,error,attempts
    ) SELECT 'test-'||n,'test','2026-10-19','submitted','test@example.com','','sender@example.com',
      'test','<p>test</p>',0,'2026-10-19T03:00:00Z'::timestamptz+n*interval '1 minute',
      '2026-10-19T03:00:00Z'::timestamptz+n*interval '1 minute',NULL,NULL,1
      FROM generate_series(1,105) n`);
    await pool.query(`INSERT INTO email_delivery(
      id,kind,local_date,status,recipient_email,cc_email,sender_email,subject,html_content,
      record_count,created_at,updated_at,message_id,error,attempts
    ) VALUES('scheduled-old','scheduled','2026-10-18','submitted','digest@example.com','copy@example.com',
      'sender@example.com','digest','<p>digest</p>',4,'2026-10-18T01:00:00Z','2026-10-18T01:00:01Z','<old>',NULL,1)`);
    await pool.query(`INSERT INTO email_job(id,local_date,status,delivery_id,created_at,updated_at)
      VALUES('job-old','2026-10-18','submitted','scheduled-old','2026-10-18T01:00:00Z','2026-10-18T01:00:01Z')`);
    email = new PgEmailStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('excludes tests and finds the latest scheduled result beyond the 100-row delivery list cap', async () => {
    const summary = await email.summary(new Date('2026-10-19T02:00:00.000Z'));
    expect(summary).toMatchObject({
      enabled: true,
      recipientEmail: 'digest@example.com',
      ccEmail: 'copy@example.com',
      sendTime: '09:00',
      timeZone: 'Asia/Kuala_Lumpur',
      serverTime: '2026-10-19T02:00:00.000Z',
      today: '2026-10-19',
      nextCheckAt: '2026-10-19T01:00:00.000Z',
      nextCheckState: 'awaiting_check',
      todayResult: null,
      latestResult: { id: 'scheduled-old', localDate: '2026-10-18', status: 'submitted', recordCount: 4 },
    });
  });

  it('returns each persisted today status and schedules tomorrow after any result', async () => {
    await pool.query(`INSERT INTO email_delivery(
      id,kind,local_date,status,recipient_email,cc_email,sender_email,subject,html_content,
      record_count,created_at,updated_at,message_id,error,attempts
    ) VALUES('scheduled-today','scheduled','2026-10-19','skipped','digest@example.com','copy@example.com',
      'sender@example.com','','',0,'2026-10-19T01:00:00Z','2026-10-19T01:00:01Z',NULL,'No reminders were due.',0)`);
    await pool.query(`INSERT INTO email_job(id,local_date,status,delivery_id,created_at,updated_at)
      VALUES('job-today','2026-10-19','skipped','scheduled-today','2026-10-19T01:00:00Z','2026-10-19T01:00:01Z')`);
    for (const status of ['skipped', 'failed', 'unknown'] as const) {
      const error = status === 'skipped' ? 'No reminders were due.' : `${status} detail`;
      await pool.query(`UPDATE email_delivery SET status=$1,error=$2,record_count=$3,updated_at=updated_at+interval '1 second' WHERE id='scheduled-today'`, [status, error, status === 'skipped' ? 0 : 2]);
      await pool.query(`UPDATE email_job SET status=$1,updated_at=updated_at+interval '1 second' WHERE id='job-today'`, [status]);
      const summary = await email.summary(new Date('2026-10-19T02:00:00.000Z'));
      expect(summary.nextCheckState).toBe('scheduled');
      expect(summary.nextCheckAt).toBe('2026-10-20T01:00:00.000Z');
      expect(summary.todayResult).toMatchObject({ id: 'scheduled-today', status, recordCount: status === 'skipped' ? 0 : 2, error });
      expect(summary.latestResult?.id).toBe('scheduled-today');
    }
  });

  it('represents a job with a missing delivery consistently without including test deliveries', async () => {
    await pool.query(`INSERT INTO email_job(id,local_date,status,delivery_id,created_at,updated_at)
      VALUES('job-without-delivery','2026-10-20','sending','missing-delivery','2026-10-20T01:00:00Z','2026-10-20T01:00:00Z')`);
    const summary = await email.summary(new Date('2026-10-20T02:00:00.000Z'));
    expect(summary.todayResult).toEqual({
      id: 'job-without-delivery', localDate: '2026-10-20', status: 'sending', recordCount: 0,
      createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:00:00.000Z', error: null,
    });
    expect(summary.latestResult).toEqual(summary.todayResult);
    expect(summary.nextCheckAt).toBe('2026-10-21T01:00:00.000Z');
  });
});
