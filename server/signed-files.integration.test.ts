import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool, PoolClient } from './db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFfmContractDefaults } from '../src/contract-core';
import { PgContractStore, seedContractTemplates } from './contract-store';
import { PgNdaStore } from './store';
import { createHandler } from './app';
import { sqliteTestPool } from './sqlite-test-helper';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

describe('signed PDF SQLite integration', () => {
  let pool: Pool;
  let cleanup: () => Promise<void>;
  let contracts: PgContractStore;
  let ndas: PgNdaStore;

  const values = () => {
    const result = createFfmContractDefaults();
    result.recipient.name = 'Signed File Client';
    result.recipient.registrationNumber = '202601000333';
    result.recipient.address = '3 Signature Road';
    result.purpose = 'Test signed file preservation';
    result.agreementDate = '2026-10-23';
    result.pic = 'Lee';
    return result;
  };

  const addVersion = async (contractId: string, ordinal: number, snapshot = values(), complete = true) => {
    const template = (await pool.query('SELECT * FROM contract_template WHERE active=true LIMIT 1')).rows[0];
    const docxId = randomUUID(); const pdfId = complete ? randomUUID() : null; const versionId = randomUUID();
    await pool.query(
      `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
       VALUES($1,$2,'docx','generated.docx','application/octet-stream',$3,$4,now())`,
      [docxId, contractId, Buffer.from('docx'), randomUUID()],
    );
    if (pdfId) await pool.query(
      `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
       VALUES($1,$2,'pdf','generated.pdf','application/pdf',$3,$4,now())`,
      [pdfId, contractId, pdf, randomUUID()],
    );
    await pool.query(
      `INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
       template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
      [versionId, contractId, ordinal, template.id, template.template_key, template.template_version,
        template.checksum, template.content, JSON.stringify(snapshot), docxId, pdfId],
    );
    return versionId;
  };

  const upload = (contractId: string, expectedVersion: number, versionId: string, requestId = randomUUID(), name = 'final-signed.pdf') =>
    contracts.uploadSignedFile(contractId, {
      requestId, expectedVersion, versionId, originalFileName: name, contentType: 'application/pdf', content: pdf,
    });

  beforeAll(async () => {
    ({pool,cleanup}=await sqliteTestPool('nda-signed'));
    await seedContractTemplates(pool);
    contracts = new PgContractStore(pool);
    ndas = new PgNdaStore(pool);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('appends exact bytes, advances the current pointer, and preserves idempotency', async () => {
    const created = await contracts.create({ requestId: randomUUID(), values: values() });
    const versionId = await addVersion(created.contract.id, 1);
    const before = await ndas.state();
    const requestId = randomUUID();
    const first = await upload(created.contract.id, 1, versionId, requestId);
    expect(first.contract).toMatchObject({ version: 2, currentSignedFileId: first.signedFile.id, signedFileCount: 1 });
    expect(first.signedFile).toMatchObject({ ordinal: 1, sourceVersionId: versionId, sizeBytes: pdf.length, uploadedBy: 'Local user' });
    expect(Buffer.compare((await contracts.signedFile(first.signedFile.id)).content, pdf)).toBe(0);
    expect(await upload(created.contract.id, 1, versionId, requestId)).toEqual(first);
    await expect(upload(created.contract.id, 1, versionId, requestId, 'changed.pdf'))
      .rejects.toMatchObject({ status: 409, code: 'request_id_conflict' });
    const afterFirst = await ndas.state();
    expect(afterFirst.revision).toBe(before.revision);
    expect(afterFirst.snapshot.records).toHaveLength(before.snapshot.records.length);

    const replacement = await upload(created.contract.id, 2, versionId);
    expect(replacement.contract).toMatchObject({ version: 3, currentSignedFileId: replacement.signedFile.id, signedFileCount: 2 });
    expect(replacement.signedFile.ordinal).toBe(2);
    const observedQueries: string[] = [];
    const originalConnect = pool.connect.bind(pool);
    const connectSpy = vi.spyOn(pool, 'connect').mockImplementation(async () => {
      const client = await originalConnect();
      const query = client.query.bind(client);
      return {
        query: ((text: unknown, ...parameters: unknown[]) => {
          observedQueries.push(String(text));
          return query(text as never, ...parameters as never[]);
        }) as PoolClient['query'],
        release: () => client.release(),
      } as PoolClient;
    });
    const details = await contracts.getContract(created.contract.id).finally(() => connectSpy.mockRestore());
    expect(details.signedFiles.map((item) => item.id)).toEqual([replacement.signedFile.id, first.signedFile.id]);
    expect(details.activity.filter((item) => item.type === 'signed-file-uploaded')).toHaveLength(2);
    const metadataQuery = observedQueries.find((query) => query.includes('FROM contract_signed_file WHERE'))!;
    expect(metadataQuery).toBeTruthy();
    expect(metadataQuery).not.toMatch(/\bcontent\s*(?:,|\s+FROM)/i);
    expect(details.signedFiles.every((item) => !Object.prototype.hasOwnProperty.call(item, 'content'))).toBe(true);
    const generated = await pool.query(`SELECT a.content FROM contract_version v
      JOIN document_artifact a ON a.id=v.pdf_artifact_id WHERE v.id=$1`, [versionId]);
    expect(Buffer.compare(generated.rows[0].content, pdf)).toBe(0);
    await expect(pool.query('UPDATE contract_signed_file SET original_file_name=$2 WHERE id=$1', [first.signedFile.id, 'mutated.pdf']))
      .rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR' });
    await expect(pool.query('DELETE FROM contract_signed_file WHERE id=$1', [first.signedFile.id]))
      .rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR' });
    const recycled = await contracts.recycle(created.contract.id, { requestId: randomUUID(), expectedVersion: 3 });
    expect(recycled.contract.currentSignedFileId).toBe(replacement.signedFile.id);
    const restored = await contracts.restoreRecycled(created.contract.id, {
      requestId: randomUUID(), expectedVersion: recycled.contract.version,
    });
    expect(restored.contract).toMatchObject({ currentSignedFileId: replacement.signedFile.id, signedFileCount: 2 });
    expect(Buffer.compare((await contracts.signedFile(first.signedFile.id)).content, pdf)).toBe(0);
  });

  it('requires the current file from the selected version before confirmation', async () => {
    const created = await contracts.create({ requestId: randomUUID(), values: values() });
    const firstVersion = await addVersion(created.contract.id, 1);
    const secondVersion = await addVersion(created.contract.id, 2);
    await expect(contracts.confirmSigned(created.contract.id, {
      requestId: randomUUID(), expectedVersion: 1, versionId: firstVersion,
      agreementDate: '2026-10-23', pic: 'Lee',
    })).rejects.toMatchObject({ code: 'signed_file_required' });
    const first = await upload(created.contract.id, 1, firstVersion);
    await expect(contracts.confirmSigned(created.contract.id, {
      requestId: randomUUID(), expectedVersion: 2, versionId: secondVersion, signedFileId: first.signedFile.id,
      agreementDate: '2026-10-23', pic: 'Lee',
    })).rejects.toMatchObject({ code: 'signed_file_version_mismatch' });
    const second = await upload(created.contract.id, 2, secondVersion);
    await expect(contracts.confirmSigned(created.contract.id, {
      requestId: randomUUID(), expectedVersion: 3, versionId: secondVersion, signedFileId: first.signedFile.id,
      agreementDate: '2026-10-23', pic: 'Lee',
    })).rejects.toMatchObject({ code: 'signed_file_mismatch' });
    const confirmed = await contracts.confirmSigned(created.contract.id, {
      requestId: randomUUID(), expectedVersion: 3, versionId: secondVersion, signedFileId: second.signedFile.id,
      agreementDate: '2026-10-23', pic: 'Lee',
    });
    expect(confirmed.contract).toMatchObject({ status: 'signed', currentSignedFileId: second.signedFile.id, signedFileCount: 2 });

    const beforeReplacement = await ndas.state();
    const replacement = await upload(created.contract.id, confirmed.contract.version, secondVersion);
    expect(replacement.contract).toMatchObject({ status: 'signed', signedFileCount: 3 });
    expect((await ndas.state()).revision).toBe(beforeReplacement.revision);
    await expect(upload(created.contract.id, replacement.contract.version, firstVersion))
      .rejects.toMatchObject({ code: 'signed_file_version_mismatch' });
  });

  it('rejects incomplete and foreign generated versions and serializes upload against recycle', async () => {
    const left = await contracts.create({ requestId: randomUUID(), values: values() });
    const right = await contracts.create({ requestId: randomUUID(), values: values() });
    const incomplete = await addVersion(left.contract.id, 1, values(), false);
    const foreign = await addVersion(right.contract.id, 1);
    await expect(upload(left.contract.id, 1, incomplete)).rejects.toMatchObject({ code: 'signed_file_version_mismatch' });
    await expect(upload(left.contract.id, 1, foreign)).rejects.toMatchObject({ code: 'signed_file_version_mismatch' });
    const complete = await addVersion(left.contract.id, 2);
    const outcomes = await Promise.allSettled([
      upload(left.contract.id, 1, complete),
      contracts.recycle(left.contract.id, { requestId: randomUUID(), expectedVersion: 1 }),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const row = (await pool.query('SELECT version,deleted_at,current_signed_file_id FROM contract WHERE id=$1', [left.contract.id])).rows[0];
    expect(row.version).toBe(2);
    expect(Boolean(row.deleted_at) || Boolean(row.current_signed_file_id)).toBe(true);

    const confirming = await contracts.create({ requestId: randomUUID(), values: values() });
    const confirmingVersion = await addVersion(confirming.contract.id, 1);
    const current = await upload(confirming.contract.id, 1, confirmingVersion);
    const confirmRace = await Promise.allSettled([
      upload(confirming.contract.id, current.contract.version, confirmingVersion),
      contracts.confirmSigned(confirming.contract.id, {
        requestId: randomUUID(), expectedVersion: current.contract.version, versionId: confirmingVersion,
        signedFileId: current.signedFile.id, agreementDate: '2026-10-23', pic: 'Lee',
      }),
    ]);
    expect(confirmRace.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect((await pool.query('SELECT version FROM contract WHERE id=$1', [confirming.contract.id])).rows[0].version).toBe(3);
  });

  it('attaches a file to a legacy signed contract without recreating tracking state', async () => {
    const created = await contracts.create({ requestId: randomUUID(), values: values() });
    const versionId = await addVersion(created.contract.id, 1);
    await pool.query(`UPDATE contract SET status='signed',signed_version_id=$2,signed_at=now() WHERE id=$1`,
      [created.contract.id, versionId]);
    const before = await ndas.state();
    const attached = await upload(created.contract.id, created.contract.version, versionId);
    expect(attached.contract).toMatchObject({ status: 'signed', currentSignedFileId: attached.signedFile.id, signedFileCount: 1 });
    const after = await ndas.state();
    expect(after.revision).toBe(before.revision);
    expect(after.snapshot.records).toEqual(before.snapshot.records);
    expect(after.snapshot.history).toEqual(before.snapshot.history);
  });

  it('does not create a signed-file row when a multipart upload is aborted', async () => {
    const created = await contracts.create({ requestId: randomUUID(), values: values() });
    const versionId = await addVersion(created.contract.id, 1);
    const allowedHosts = new Set<string>();
    const server = createServer(createHandler(pool, {
      port: 0, publicDir: 'missing', allowedHosts, bodyLimitBytes: 128, backupStatusDir: 'missing',
    }, {} as never));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    allowedHosts.add(`127.0.0.1:${port}`);
    try {
      await new Promise<void>((resolve) => {
        const boundary = '----aborted-signed-upload';
        const client = request({
          host: '127.0.0.1', port, method: 'POST', path: `/api/contracts/${created.contract.id}/signed-files`,
          headers: { Host: `127.0.0.1:${port}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        });
        client.on('error', () => undefined);
        client.on('close', () => resolve());
        client.write(`--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${randomUUID()}\r\n`);
        client.write(`--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n1\r\n`);
        client.write(`--${boundary}\r\nContent-Disposition: form-data; name="versionId"\r\n\r\n${versionId}\r\n`);
        client.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="signed.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n`);
        setTimeout(() => client.destroy(), 20);
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await pool.query('SELECT count(*) count FROM contract_signed_file WHERE contract_id=$1', [created.contract.id])).rows[0].count).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns a self-consistent detail snapshot during concurrent signed-file uploads', async () => {
    const created = await contracts.create({ requestId: randomUUID(), values: values() });
    const versionId = await addVersion(created.contract.id, 1);
    let expectedVersion = created.contract.version;
    for (let index = 0; index < 6; index += 1) {
      const [details, uploaded] = await Promise.all([
        contracts.getContract(created.contract.id),
        upload(created.contract.id, expectedVersion, versionId),
      ]);
      expect(details.signedFileCount).toBe(details.signedFiles.length);
      if (details.currentSignedFileId) {
        expect(details.signedFiles.some((item) => item.id === details.currentSignedFileId)).toBe(true);
      }
      expectedVersion = uploaded.contract.version;
    }
  });
});
