import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from './db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmContractDefaults } from '../src/contract-core';
import { createEmptyFields, type Fields } from '../src/core';
import { PgContractStore, seedContractTemplates } from './contract-store';
import { DocumentWorker } from './document-worker';
import { PgEmailStore } from './email';
import { PgNdaStore } from './store';
import { sqliteTestPool } from './sqlite-test-helper';

describe('recycle bin SQLite integration', () => {
  let pool: Pool;
  let cleanup: () => Promise<void>;
  let ndas: PgNdaStore;
  let contracts: PgContractStore;

  const fields = (recipient: string, overrides: Partial<Fields> = {}): Fields => ({
    ...createEmptyFields(), Recipient: recipient, 'Recipient Reg No': `${recipient}-REG`,
    'Recipient Address': '1 Test Road', Purpose: 'Testing', 'Date of Agreement': '2026-10-23',
    Duration: 1, UOM: 'years', PIC: 'Lee', Status: 'Pending', ...overrides,
  });

  const values = () => {
    const result = createFfmContractDefaults();
    result.recipient.name = 'Recycle Client Sdn. Bhd.';
    result.recipient.registrationNumber = '202601000099';
    result.recipient.address = '1 Recycle Road';
    result.purpose = 'Test recoverable deletion';
    result.agreementDate = '2026-10-23';
    result.pic = 'Lee';
    return result;
  };

  beforeAll(async () => {
    ({pool,cleanup}=await sqliteTestPool('nda-recycle'));
    await seedContractTemplates(pool);
    ndas = new PgNdaStore(pool, async () => undefined);
    contracts = new PgContractStore(pool);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('recycles and restores an NDA with replay-safe history and active-only state', async () => {
    const created = await ndas.create({ fields: fields('NDA lifecycle') });
    const record = created.snapshot.records.find((item) => item.fields.Recipient === 'NDA lifecycle')!;
    const deleteRequest = randomUUID();
    const recycled = await ndas.recycle(record.id, { requestId: deleteRequest, expectedVersion: record.version });
    expect(recycled.snapshot.records.some((item) => item.id === record.id)).toBe(false);
    expect(recycled.snapshot.history.some((event) => event.id === deleteRequest)).toBe(false);
    const bin = await ndas.recycledRecords();
    expect(bin).toEqual(expect.arrayContaining([expect.objectContaining({ id: record.id, version: 2, deletedBy: 'Local user' })]));
    const replay = await ndas.recycle(record.id, { requestId: deleteRequest, expectedVersion: record.version });
    expect(replay.revision).toBe(recycled.revision);
    await expect(ndas.recycle(record.id, { requestId: randomUUID(), expectedVersion: 2 }))
      .rejects.toMatchObject({ status: 409, code: 'record_recycled' });
    await expect(ndas.recycle(record.id, { requestId: deleteRequest, expectedVersion: 2 }))
      .rejects.toMatchObject({ status: 409, code: 'request_id_conflict' });
    await expect(ndas.update(record.id, { expectedVersion: 2, fields: record.fields }))
      .rejects.toMatchObject({ status: 409, code: 'record_recycled' });

    const restoreRequest = randomUUID();
    const restored = await ndas.restoreRecycled(record.id, { requestId: restoreRequest, expectedVersion: 2 });
    expect(restored.snapshot.records.find((item) => item.id === record.id)).toMatchObject({ version: 3 });
    expect(restored.snapshot.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: deleteRequest, type: 'recycled' }),
      expect.objectContaining({ id: restoreRequest, type: 'restored' }),
    ]));
    await expect(ndas.restoreRecycled(record.id, { requestId: randomUUID(), expectedVersion: 3 }))
      .rejects.toMatchObject({ status: 409, code: 'not_in_recycle_bin' });
  });

  it('enforces renewal closure, keeps import dedupe global, and blocks schema-1 restore', async () => {
    const original = await ndas.create({ fields: fields('Renewal parent') });
    const parent = original.snapshot.records.find((item) => item.fields.Recipient === 'Renewal parent')!;
    const renewed = await ndas.renew(parent.id, { expectedVersion: parent.version, fields: fields('Renewal child') });
    const activeParent = renewed.snapshot.records.find((item) => item.id === parent.id)!;
    const child = renewed.snapshot.records.find((item) => item.renewedFromId === parent.id)!;
    await expect(ndas.recycle(parent.id, { requestId: randomUUID(), expectedVersion: activeParent.version }))
      .rejects.toMatchObject({ status: 409, code: 'record_has_active_renewal' });
    await ndas.recycle(child.id, { requestId: randomUUID(), expectedVersion: child.version });
    await ndas.recycle(parent.id, { requestId: randomUUID(), expectedVersion: activeParent.version });
    await expect(ndas.restoreRecycled(child.id, { requestId: randomUUID(), expectedVersion: child.version + 1 }))
      .rejects.toMatchObject({ status: 409, code: 'renewal_parent_recycled' });

    const beforeImport = (await pool.query('SELECT count(*) count FROM nda_record')).rows[0].count;
    await ndas.importRows({ rows: [child.fields] });
    expect((await pool.query('SELECT count(*) count FROM nda_record')).rows[0].count).toBe(beforeImport);
    const state = await ndas.state();
    await expect(ndas.restore({ expectedRevision: state.revision, snapshot: state.snapshot }))
      .rejects.toMatchObject({ status: 409, code: 'recycle_bin_not_empty' });
  });

  it('projects recycled NDA links as historical only and detects a recycled linked draft', async () => {
    const state = await ndas.create({ fields: fields('Linked NDA') });
    const record = state.snapshot.records.find((item) => item.fields.Recipient === 'Linked NDA')!;
    const linked = await contracts.draftForRecord(record.id, { requestId: randomUUID() });
    await ndas.recycle(record.id, { requestId: randomUUID(), expectedVersion: record.version });
    expect((await contracts.getContract(linked.contract.id))).toMatchObject({
      linkedNdaId: null, linkedNdaHistoricalId: record.id,
    });
    await expect(contracts.refreshFromRecord(linked.contract.id, {
      requestId: randomUUID(), expectedVersion: linked.contract.version,
    })).rejects.toMatchObject({ status: 409, code: 'linked_nda_recycled' });
    await ndas.restoreRecycled(record.id, { requestId: randomUUID(), expectedVersion: record.version + 1 });
    expect((await contracts.getContract(linked.contract.id)).linkedNdaId).toBe(record.id);
    await ndas.recycle(record.id, { requestId: randomUUID(), expectedVersion: record.version + 2 });
    await contracts.recycle(linked.contract.id, { requestId: randomUUID(), expectedVersion: linked.contract.version });
    await expect(contracts.draftForRecord(record.id, { requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409, code: 'linked_draft_recycled', details: { contractId: linked.contract.id } });
  });

  it('serializes recycling against an ordinary NDA update', async () => {
    const created = await ndas.create({ fields: fields('Concurrent NDA') });
    const record = created.snapshot.records.find((item) => item.fields.Recipient === 'Concurrent NDA')!;
    const outcomes = await Promise.allSettled([
      ndas.recycle(record.id, { requestId: randomUUID(), expectedVersion: record.version }),
      ndas.update(record.id, { expectedVersion: record.version, fields: { ...record.fields, PIC: 'Changed' } }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const row = (await pool.query('SELECT version,deleted_at,fields FROM nda_record WHERE id=$1', [record.id])).rows[0];
    expect(row.version).toBe(2);
    expect(Boolean(row.deleted_at) || row.fields.PIC === 'Changed').toBe(true);
  });

  it('keeps accepted generation artifacts while rejecting new work on a recycled contract', async () => {
    const created = await contracts.create({ requestId: randomUUID(), values: values() });
    const queued = await contracts.enqueueGeneration(created.contract.id, {
      requestId: randomUUID(), expectedVersion: created.contract.version,
    });
    const retrySource = await contracts.enqueueGeneration(created.contract.id, {
      requestId: randomUUID(), expectedVersion: created.contract.version,
    });
    const recycled = await contracts.recycle(created.contract.id, {
      requestId: randomUUID(), expectedVersion: created.contract.version,
    });
    expect((await contracts.listContracts()).some((item) => item.id === created.contract.id)).toBe(false);
    expect(await contracts.recycledContracts()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.contract.id, version: 2, deletedBy: 'Local user' }),
    ]));
    await expect(contracts.getContract(created.contract.id)).rejects.toMatchObject({ code: 'contract_recycled' });
    await expect(contracts.duplicate(created.contract.id, { requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'contract_recycled' });
    await expect(contracts.enqueueGeneration(created.contract.id, { requestId: randomUUID(), expectedVersion: 2 }))
      .rejects.toMatchObject({ code: 'contract_recycled' });
    await expect(contracts.enqueueBatch({
      requestId: randomUUID(), contracts: [{ id: created.contract.id, expectedVersion: 2 }],
    })).rejects.toMatchObject({ code: 'contract_recycled' });
    await expect(contracts.update(created.contract.id, { expectedVersion: 2, values: values() }))
      .rejects.toMatchObject({ code: 'contract_recycled' });
    await expect(contracts.confirmSigned(created.contract.id, {
      requestId: randomUUID(), expectedVersion: 2, versionId: randomUUID(), agreementDate: '2026-10-23', pic: 'Lee',
    })).rejects.toMatchObject({ code: 'contract_recycled' });
    await pool.query("UPDATE document_job_item SET status='failed' WHERE job_id=$1", [retrySource.job.id]);
    await pool.query("UPDATE document_job SET status='failed' WHERE id=$1", [retrySource.job.id]);
    await expect(contracts.retryJob(retrySource.job.id, { requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'contract_recycled' });

    const converter = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/pdf' });
        response.end(Buffer.from('%PDF-1.4\n%%EOF'));
      });
    });
    await new Promise<void>((resolve) => converter.listen(0, '127.0.0.1', resolve));
    const worker = new DocumentWorker(pool, `http://127.0.0.1:${(converter.address() as AddressInfo).port}`, 10, 10);
    try {
      await worker.start();
      let job = queued.job;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && job.status !== 'complete') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        job = await contracts.getJob(job.id);
      }
      expect(job.status).toBe('complete');
      const artifact = await contracts.artifact(job.items[0].pdfArtifactId!);
      expect(artifact.content.subarray(0, 5).toString()).toBe('%PDF-');
      const artifactCount = (await pool.query('SELECT count(*) count FROM document_artifact WHERE contract_id=$1', [created.contract.id])).rows[0].count;
      const restored = await contracts.restoreRecycled(created.contract.id, {
        requestId: randomUUID(), expectedVersion: recycled.contract.version,
      });
      expect(restored.contract.version).toBe(3);
      expect((await pool.query('SELECT count(*) count FROM document_artifact WHERE contract_id=$1', [created.contract.id])).rows[0].count).toBe(artifactCount);
    } finally {
      await worker.stop();
      await new Promise<void>((resolve) => converter.close(() => resolve()));
    }
  });

  it('excludes recycled NDAs from scheduled reminder candidates', async () => {
    const created = await ndas.create({ fields: fields('Reminder candidate', { 'Date of Agreement': '2026-11-01' }) });
    const record = created.snapshot.records.find((item) => item.fields.Recipient === 'Reminder candidate')!;
    await ndas.recycle(record.id, { requestId: randomUUID(), expectedVersion: record.version });
    const current = await ndas.state();
    await ndas.updateSettings({
      expectedRevision: current.revision,
      settings: {
        ...current.snapshot.settings, recipientEmail: 'recipient@example.com', senderEmail: 'sender@example.com',
        sendTime: '09:00', reminderDays: [374], automaticRemindersEnabled: true,
      },
    });
    const claim = await new PgEmailStore(pool).claimScheduled(new Date('2026-10-23T01:00:00.000Z'));
    expect(claim).toMatchObject({ shouldSend: false, delivery: { status: 'skipped', recordCount: 0 } });
  });
});
