import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from './db';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractValuesToTracking, createFfmContractDefaults } from '../src/contract-core';
import { createEmptyFields } from '../src/core';
import { PgContractStore, seedContractTemplates } from './contract-store';
import { PgNdaStore } from './store';
import { DocumentWorker } from './document-worker';
import { sqliteTestPool } from './sqlite-test-helper';

describe('contract SQLite store integration', () => {
  let pool: Pool;
  let cleanup: () => Promise<void>;
  let contracts: PgContractStore;
  let ndas: PgNdaStore;

  const completeValues = () => {
    const values = createFfmContractDefaults();
    values.recipient.name = 'Client Sdn. Bhd.';
    values.recipient.registrationNumber = '202601000001';
    values.recipient.address = '1 Client Road, Kuala Lumpur';
    values.purpose = 'Evaluate confidential materials';
    values.agreementDate = '2026-10-22';
    values.pic = 'Lee';
    values.department = 'Legal';
    return values;
  };

  const signedPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const attachSigned = (contractId: string, expectedVersion: number, versionId: string) => contracts.uploadSignedFile(contractId, {
    requestId: randomUUID(), expectedVersion, versionId,
    originalFileName: 'signed-agreement.pdf', contentType: 'application/pdf', content: signedPdf,
  });

  const within = async <T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> => Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Concurrent operation timed out.')), milliseconds)),
  ]);

  beforeAll(async () => {
    ({pool,cleanup}=await sqliteTestPool('nda-contract'));
    await seedContractTemplates(pool);
    contracts = new PgContractStore(pool);
    ndas = new PgNdaStore(pool);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('provides editable NDA and EOI templates without resetting saved edits on restart', async () => {
    const drafts = await pool.query('SELECT d.*,f.document_type FROM template_draft d JOIN template_family f ON f.id=d.family_id');
    expect(drafts.rows.map(row => row.document_type).sort()).toEqual(['eoi','nda']);
    for (const draft of drafts.rows) expect(draft.editor_snapshot.fields.length).toBeGreaterThan(0);
    const draft = drafts.rows[0];
    await pool.query('UPDATE template_draft SET name=$2,version=version+1 WHERE id=$1',[draft.id,'Saved working copy']);
    await seedContractTemplates(pool);
    const saved = (await pool.query('SELECT name,version FROM template_draft WHERE id=$1',[draft.id])).rows[0];
    expect(saved).toEqual({name:'Saved working copy',version:2});
    expect(Number((await pool.query('SELECT count(*) count FROM template_draft')).rows[0].count)).toBe(2);
  });

  it('keeps request replay idempotent, detects reuse, and enforces optimistic versions', async () => {
    await expect(contracts.listTemplates()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'ffm-nda-v1', name: 'FFM NDA · Disclosing party', active: true }),
    ]));
    const requestId = randomUUID();
    const input = { requestId, values: completeValues() };
    const first = await contracts.create(input);
    const replay = await contracts.create(input);
    expect(replay).toEqual(first);
    expect(await contracts.listContracts()).toHaveLength(1);
    await expect(contracts.create({ requestId, values: createFfmContractDefaults() }))
      .rejects.toMatchObject({ status: 409, code: 'request_id_conflict' });
    await expect(contracts.update(first.contract.id, { expectedVersion: 2, values: first.contract.values }))
      .rejects.toMatchObject({ status: 409, code: 'version_conflict' });
  });

  it('projects only the latest generated version metadata in the contracts list', async () => {
    const noGeneration = await contracts.create({ requestId: randomUUID(), values: completeValues() });
    const staleGeneration = await contracts.create({ requestId: randomUUID(), values: completeValues() });
    const currentGeneration = await contracts.create({ requestId: randomUUID(), values: completeValues() });
    const template = (await pool.query('SELECT * FROM contract_template WHERE active=true LIMIT 1')).rows[0];

    const addVersion = async (contractId: string, ordinal: number, values: unknown, complete: boolean) => {
      const versionId = randomUUID();
      const docxId = randomUUID();
      const pdfId = complete ? randomUUID() : null;
      await pool.query(
        `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
         VALUES($1,$2,'docx',$3,'application/octet-stream',$4,$5,now())`,
        [docxId, contractId, `version-${ordinal}.docx`, Buffer.from('docx'), randomUUID()],
      );
      if (pdfId) {
        await pool.query(
          `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
           VALUES($1,$2,'pdf',$3,'application/pdf',$4,$5,now())`,
          [pdfId, contractId, `version-${ordinal}.pdf`, Buffer.from('%PDF-test'), randomUUID()],
        );
      }
      await pool.query(
        `INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
         template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
        [versionId, contractId, ordinal, template.id, template.template_key, template.template_version,
          template.checksum, template.content, JSON.stringify(values), docxId, pdfId],
      );
      return versionId;
    };

    await addVersion(staleGeneration.contract.id, 1, staleGeneration.contract.values, true);
    const staleValues = structuredClone(staleGeneration.contract.values);
    staleValues.purpose = 'Superseded draft values';
    const latestStaleVersionId = await addVersion(staleGeneration.contract.id, 2, staleValues, false);
    const currentVersionId = await addVersion(currentGeneration.contract.id, 1, currentGeneration.contract.values, true);

    const addVersionJob = async (versionId: string, createdAt: string, itemId: string) => {
      const jobId = randomUUID();
      await pool.query(
        `INSERT INTO document_job(id,status,created_at,updated_at) VALUES($1,'partial',$2,$2)`,
        [jobId, createdAt],
      );
      await pool.query(
        `INSERT INTO document_job_item(id,job_id,contract_id,status,attempts,values_snapshot,template_id,
         template_key,template_version,template_checksum,template_file_name,template_bytes,version_id,created_at,updated_at)
         VALUES($1,$2,$3,'partial',3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [itemId, jobId, staleGeneration.contract.id, JSON.stringify(staleValues), template.id,
          template.template_key, template.template_version, template.checksum, template.file_name,
          template.content, versionId, createdAt],
      );
      return jobId;
    };
    const itemPrefix = randomUUID();
    await addVersionJob(latestStaleVersionId, '2026-10-20T00:00:00.000Z', `${itemPrefix}-z-old`);
    await addVersionJob(latestStaleVersionId, '2026-10-21T00:00:00.000Z', `${itemPrefix}-a`);
    const latestStaleJobId = await addVersionJob(
      latestStaleVersionId, '2026-10-21T00:00:00.000Z', `${itemPrefix}-z`,
    );

    const listed = await contracts.listContracts();
    expect(listed.find((item) => item.id === noGeneration.contract.id)?.latestGeneration).toBeNull();
    expect(listed.find((item) => item.id === staleGeneration.contract.id)?.latestGeneration).toEqual({
      id: latestStaleVersionId, jobId: latestStaleJobId, ordinal: 2, complete: false, matchesDraft: false,
    });
    expect(listed.find((item) => item.id === currentGeneration.contract.id)?.latestGeneration).toEqual({
      id: currentVersionId, jobId: null, ordinal: 1, complete: true, matchesDraft: true,
    });
    const supplierId=randomUUID();
    await pool.query(`INSERT INTO supplier(id,supplier_code,company_name,created_at,updated_at) VALUES($1,'STALE-QA','Changed classification',now(),now())`,[supplierId]);
    await contracts.update(currentGeneration.contract.id,{expectedVersion:currentGeneration.contract.version,values:currentGeneration.contract.values,supplierId});
    expect((await contracts.listContracts()).find(item=>item.id===currentGeneration.contract.id)?.latestGeneration?.matchesDraft).toBe(false);
  });

  it('lists every active document job in addition to the latest 20 completed jobs', async () => {
    const draft = await contracts.create({ requestId: randomUUID(), values: completeValues() });
    const active = await contracts.enqueueGeneration(draft.contract.id, {
      requestId: randomUUID(), expectedVersion: draft.contract.version,
    });
    await pool.query(
      `UPDATE document_job SET created_at='2000-01-01T00:00:00.000Z',updated_at='2000-01-01T00:00:00.000Z'
       WHERE id=$1`, [active.job.id],
    );
    const completedIds: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const id = randomUUID();
      completedIds.push(id);
      const createdAt = new Date(Date.UTC(2100, 0, 1, 0, 0, index)).toISOString();
      await pool.query(
        `INSERT INTO document_job(id,status,created_at,updated_at) VALUES($1,'complete',$2,$2)`,
        [id, createdAt],
      );
    }
    try {
      const listed = await contracts.listJobs();
      expect(listed.map((job) => job.id)).toEqual([
        ...completedIds.slice(-20).reverse(),
        active.job.id,
      ]);
    } finally {
      await pool.query(`UPDATE document_job_item SET status='failed' WHERE job_id=$1`, [active.job.id]);
      await pool.query(`UPDATE document_job SET status='failed' WHERE id=$1`, [active.job.id]);
    }
  });

  it('creates one linked draft and refreshes only mapped legacy fields', async () => {
    const fields = {
      ...createEmptyFields(), Recipient: 'Tracked Client', 'Recipient Reg No': 'T-1',
      'Recipient Address': 'Tracked address', Purpose: 'Tracked purpose',
      'Date of Agreement': '2026-01-01', Duration: 2, UOM: 'years', PIC: 'Tan', Status: 'Pending',
    };
    const state = await ndas.create({ fields });
    const record = state.snapshot.records.find((item) => item.fields.Recipient === 'Tracked Client')!;
    const first = await contracts.draftForRecord(record.id, { requestId: randomUUID() });
    const second = await contracts.draftForRecord(record.id, { requestId: randomUUID() });
    expect(second.contract.id).toBe(first.contract.id);
    const changed = structuredClone(first.contract.values);
    changed.recipient.contact.name = 'Contract-only contact';
    const updated = await contracts.update(first.contract.id, { expectedVersion: 1, values: changed });
    const refreshed = await contracts.refreshFromRecord(first.contract.id, {
      requestId: randomUUID(), expectedVersion: updated.contract.version,
    });
    expect(refreshed.contract.values.recipient.contact.name).toBe('Contract-only contact');
    expect(refreshed.contract.values.recipient.name).toBe('Tracked Client');
  });

  it('freezes generation inputs and confirms a complete version atomically into tracking', async () => {
    const created = await contracts.create({ requestId: randomUUID(), values: completeValues() });
    const queued = await contracts.enqueueGeneration(created.contract.id, {
      requestId: randomUUID(), expectedVersion: created.contract.version,
    });
    expect(queued.job).toMatchObject({ status: 'queued', itemCount: 1 });
    const frozen = await pool.query('SELECT * FROM document_job_item WHERE job_id=$1', [queued.job.id]);
    expect(frozen.rows[0].values_snapshot.purpose).toBe('Evaluate confidential materials');
    expect(Buffer.compare(frozen.rows[0].template_bytes, await readFile('templates/ffm-nda-v1.docx'))).toBe(0);

    const item = frozen.rows[0];
    const docxId = randomUUID(); const pdfId = randomUUID(); const versionId = randomUUID();
    await pool.query(
      `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
       VALUES($1,$3,'docx','test.docx','application/octet-stream',$4,'docx',now()),
             ($2,$3,'pdf','test.pdf','application/pdf',$5,'pdf',now())`,
      [docxId, pdfId, created.contract.id, Buffer.from('docx'), Buffer.from('%PDF-test')],
    );
    await pool.query(
      `INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
       template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
       VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
      [versionId, created.contract.id, item.template_id, item.template_key, item.template_version,
        item.template_checksum, item.template_bytes, JSON.stringify(item.values_snapshot), docxId, pdfId],
    );
    await pool.query(
      `UPDATE document_job_item SET status='complete',version_id=$2,docx_artifact_id=$3,pdf_artifact_id=$4 WHERE id=$1`,
      [item.id, versionId, docxId, pdfId],
    );
    await pool.query(`UPDATE document_job SET status='complete' WHERE id=$1`, [queued.job.id]);
    const upload = await attachSigned(created.contract.id, created.contract.version, versionId);
    const requestId = randomUUID();
    const command = { requestId, expectedVersion: upload.contract.version, versionId,
      signedFileId: upload.signedFile.id, agreementDate: '2026-10-22', pic: 'Lee' };
    const confirmed = await contracts.confirmSigned(created.contract.id, command);
    const replay = await contracts.confirmSigned(created.contract.id, command);
    expect(replay).toEqual(confirmed);
    expect(confirmed.contract.status).toBe('signed');
    const state = await ndas.state();
    const record = state.snapshot.records.find((candidate) => candidate.id === confirmed.recordId)!;
    expect(record.fields).toMatchObject({ Recipient: 'Client Sdn. Bhd.', Status: 'Pending', PIC: 'Lee' });
    expect(state.snapshot.history.filter((event) => event.ndaId === record.id)).toHaveLength(1);
  });

  it('generates and signs a PDF-only EOI without creating an NDA tracking record', async () => {
    const supplierId=randomUUID(); const projectId=randomUUID(); const familyId=randomUUID(); const templateId=randomUUID();
    await pool.query(`INSERT INTO supplier(id,supplier_code,company_name,registration_number,address,contact_name,contact_designation,contact_address,contact_email,version,created_at,updated_at)
      VALUES($1,'SUP-EOI','EOI Supplier','','','','','','',1,now(),now())`,[supplierId]);
    await pool.query(`INSERT INTO project(id,project_code,name,description,status,version,created_at,updated_at)
      VALUES($1,'PRJ-EOI','Project Cedar','Feed evaluation','active',1,now(),now())`,[projectId]);
    const pdf=await PDFDocument.create();pdf.addPage([300,200]);const pdfBytes=Buffer.from(await pdf.save({useObjectStreams:false}));
    const fields=[{key:'project_name',label:'Project name',type:'text',required:true,source:'project_name'}];
    const snapshot={format:'pdf',fields,placements:[],pages:[{page:1,width:300,height:200,rotation:0}],warnings:[]};
    await pool.query(`INSERT INTO template_family(id,family_key,name,document_type,template_format,active,published_template_id,created_at,updated_at)
      VALUES($1,'test-eoi-pdf','Test EOI PDF','eoi','pdf',true,NULL,now(),now())`,[familyId]);
    await pool.query(`INSERT INTO contract_template(id,template_key,template_version,name,file_name,mime_type,content,checksum,tags,active,family_id,document_type,template_format,field_schema,editor_snapshot)
      VALUES($1,'test-eoi-pdf','1','Test EOI PDF','test-eoi.pdf','application/pdf',$2,$3,$4,1,$5,'eoi','pdf',$6,$7)`,
      [templateId,pdfBytes,randomUUID(),JSON.stringify(['project_name']),familyId,JSON.stringify(fields),JSON.stringify(snapshot)]);
    await pool.query('UPDATE template_family SET published_template_id=$2 WHERE id=$1',[familyId,templateId]);
    const before=await pool.query('SELECT CAST(revision AS TEXT) revision,(SELECT count(*) FROM nda_record) nda_count FROM workspace WHERE id=1');
    const nda=await contracts.create({requestId:randomUUID(),documentType:'nda',supplierId,projectId,values:completeValues()});
    expect((await contracts.listContracts()).find((item)=>item.id===nda.contract.id)?.signedEoiMissing).toBe(true);
    const created=await contracts.create({requestId:randomUUID(),documentType:'eoi',supplierId,projectId,templateFamilyId:familyId,values:createFfmContractDefaults()});
    const queued=await contracts.enqueueGeneration(created.contract.id,{requestId:randomUUID(),expectedVersion:created.contract.version,templateId});
    const worker=new DocumentWorker(pool,'http://converter.invalid',10,10);await worker.start();
    let job=queued.job;
    try {
      for(let i=0;i<100&&job.status!=='complete';i+=1){await new Promise((resolve)=>setTimeout(resolve,20));job=await contracts.getJob(job.id);}
    } finally { await worker.stop(); }
    expect(job.status).toBe('complete');
    expect(job.items[0].docxArtifactId).toBeNull();
    expect(job.items[0].pdfArtifactId).toBeTruthy();
    const details=await contracts.getContract(created.contract.id);const version=details.versions[0];
    expect(version).toMatchObject({templateFormat:'pdf',docxArtifactId:null,complete:true,supplierId,projectId,templateFamilyId:familyId});
    const uploaded=await attachSigned(created.contract.id,created.contract.version,version.id);
    const confirmed=await contracts.confirmSigned(created.contract.id,{requestId:randomUUID(),expectedVersion:uploaded.contract.version,versionId:version.id,signedFileId:uploaded.signedFile.id});
    expect(confirmed.recordId).toBeNull();expect(confirmed.contract.status).toBe('signed');
    const after=await pool.query('SELECT CAST(revision AS TEXT) revision,(SELECT count(*) FROM nda_record) nda_count FROM workspace WHERE id=1');
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect((await contracts.listContracts()).find((item)=>item.id===nda.contract.id)?.signedEoiMissing).toBe(false);
  });

  it('runs persisted work sequentially through DOCX rendering and PDF conversion', async () => {
    const converter = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/pdf' });
        response.end(Buffer.from('%PDF-1.4\n%%EOF'));
      });
    });
    await new Promise<void>((resolve) => converter.listen(0, '127.0.0.1', resolve));
    const port = (converter.address() as AddressInfo).port;
    const worker = new DocumentWorker(pool, `http://127.0.0.1:${port}`, 10, 10);
    try {
      const created = await contracts.create({ requestId: randomUUID(), values: completeValues() });
      const queued = await contracts.enqueueGeneration(created.contract.id, {
        requestId: randomUUID(), expectedVersion: created.contract.version,
      });
      await worker.start();
      let job = queued.job;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && job.status !== 'complete') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        job = await contracts.getJob(job.id);
      }
      expect(job).toMatchObject({ status: 'complete', completedCount: 1, partialCount: 0, failedCount: 0 });
      expect(job.items[0]).toMatchObject({ status: 'complete', attempts: 1 });
      const details = await contracts.getContract(created.contract.id);
      expect(details.versions).toHaveLength(1);
      expect(details.versions[0]).toMatchObject({ complete: true, values: { purpose: 'Evaluate confidential materials' } });
      expect((await contracts.artifact(job.items[0].pdfArtifactId!)).content.subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      await worker.stop();
      await new Promise<void>((resolve) => converter.close(() => resolve()));
    }
  });

  it('keeps DOCX after three transient PDF failures and retries the same frozen data', async () => {
    let calls = 0;
    const converter = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        calls += 1;
        if (calls <= 3) {
          response.writeHead(503); response.end('temporary'); return;
        }
        response.writeHead(200, { 'Content-Type': 'application/pdf' });
        response.end(Buffer.from('%PDF-1.4\n%%EOF'));
      });
    });
    await new Promise<void>((resolve) => converter.listen(0, '127.0.0.1', resolve));
    const port = (converter.address() as AddressInfo).port;
    const worker = new DocumentWorker(pool, `http://127.0.0.1:${port}`, 10, 10);
    try {
      const created = await contracts.create({ requestId: randomUUID(), values: completeValues() });
      const queued = await contracts.enqueueGeneration(created.contract.id, {
        requestId: randomUUID(), expectedVersion: created.contract.version,
      });
      await worker.start();
      let failed = queued.job;
      const firstDeadline = Date.now() + 5_000;
      while (Date.now() < firstDeadline && failed.status !== 'partial') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        failed = await contracts.getJob(failed.id);
      }
      expect(failed).toMatchObject({ status: 'partial', partialCount: 1 });
      expect(failed.items[0]).toMatchObject({ status: 'partial', attempts: 3, pdfArtifactId: null });
      expect(failed.items[0].docxArtifactId).toBeTruthy();

      const retried = await contracts.retryJob(failed.id, { requestId: randomUUID() });
      const snapshots = await pool.query(
        `SELECT values_snapshot,template_checksum,template_bytes FROM document_job_item
         WHERE id=$1 OR id=$2 ORDER BY id`, [failed.items[0].id, retried.job.items[0].id],
      );
      expect(snapshots.rows[0].values_snapshot).toEqual(snapshots.rows[1].values_snapshot);
      expect(snapshots.rows[0].template_checksum).toBe(snapshots.rows[1].template_checksum);
      expect(Buffer.compare(snapshots.rows[0].template_bytes, snapshots.rows[1].template_bytes)).toBe(0);
      let completed = retried.job;
      const retryDeadline = Date.now() + 5_000;
      while (Date.now() < retryDeadline && completed.status !== 'complete') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        completed = await contracts.getJob(completed.id);
      }
      expect(completed).toMatchObject({ status: 'complete', completedCount: 1 });
      expect(completed.items[0]).toMatchObject({ attempts: 1, docxArtifactId: failed.items[0].docxArtifactId });
    } finally {
      await worker.stop();
      await new Promise<void>((resolve) => converter.close(() => resolve()));
    }
  });

  it('persists retry backoff and recovers an expired worker lease after restart', async () => {
    let succeed = false;
    const converter = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        if (!succeed) { response.writeHead(503); response.end('temporary'); return; }
        response.writeHead(200, { 'Content-Type': 'application/pdf' });
        response.end(Buffer.from('%PDF-1.4\n%%EOF'));
      });
    });
    await new Promise<void>((resolve) => converter.listen(0, '127.0.0.1', resolve));
    const port = (converter.address() as AddressInfo).port;
    const created = await contracts.create({ requestId: randomUUID(), values: completeValues() });
    const queued = await contracts.enqueueGeneration(created.contract.id, {
      requestId: randomUUID(), expectedVersion: created.contract.version,
    });
    const firstWorker = new DocumentWorker(pool, `http://127.0.0.1:${port}`, 10, 1_000);
    try {
      await firstWorker.start();
      let item = (await contracts.getJob(queued.job.id)).items[0];
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !(item.status === 'queued' && item.attempts === 1)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        item = (await contracts.getJob(queued.job.id)).items[0];
      }
      expect(item).toMatchObject({ status: 'queued', attempts: 1 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await contracts.getJob(queued.job.id)).items[0].attempts).toBe(1);
    } finally {
      await firstWorker.stop();
    }
    await pool.query(
      `UPDATE document_job SET status='running',lease_owner='expired',lease_until=$2 WHERE id=$1`,
      [queued.job.id,new Date(Date.now()-1_000).toISOString()],
    );
    await pool.query(
      `UPDATE document_job_item SET status='running',next_attempt_at=now() WHERE job_id=$1`, [queued.job.id],
    );
    succeed = true;
    const restarted = new DocumentWorker(pool, `http://127.0.0.1:${port}`, 10, 10);
    try {
      await restarted.start();
      let job = await contracts.getJob(queued.job.id);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && job.status !== 'complete') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        job = await contracts.getJob(job.id);
      }
      expect(job).toMatchObject({ status: 'complete', completedCount: 1 });
      expect(job.items[0].attempts).toBe(2);
    } finally {
      await restarted.stop();
      await new Promise<void>((resolve) => converter.close(() => resolve()));
    }
  });

  it('aggregates expired final attempts into failed or partial parent jobs', async () => {
    const failedContract = await contracts.create({ requestId: randomUUID(), values: completeValues() });
    const partialContract = await contracts.create({ requestId: randomUUID(), values: completeValues() });
    const failedJob = await contracts.enqueueGeneration(failedContract.contract.id, {
      requestId: randomUUID(), expectedVersion: failedContract.contract.version,
    });
    const partialJob = await contracts.enqueueGeneration(partialContract.contract.id, {
      requestId: randomUUID(), expectedVersion: partialContract.contract.version,
    });
    const partialItem = partialJob.job.items[0];
    const docxId = randomUUID();
    await pool.query(
      `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
       VALUES($1,$2,'docx','recovered.docx','application/octet-stream',$3,$4,now())`,
      [docxId, partialContract.contract.id, Buffer.from('docx'), randomUUID()],
    );
    await pool.query(
      `UPDATE document_job_item SET status='running',attempts=3 WHERE job_id=$1`, [failedJob.job.id],
    );
    await pool.query(
      `UPDATE document_job_item SET status='running',attempts=3,docx_artifact_id=$2 WHERE job_id=$1`,
      [partialJob.job.id, docxId],
    );
    await pool.query(
      `UPDATE document_job SET status='running',lease_owner='expired',lease_until=$3
       WHERE id=$1 OR id=$2`, [failedJob.job.id, partialJob.job.id,new Date(Date.now()-1_000).toISOString()],
    );
    const worker = new DocumentWorker(pool, 'http://127.0.0.1:1', 10, 10);
    try {
      await worker.start();
      await expect(contracts.getJob(failedJob.job.id)).resolves.toMatchObject({
        status: 'failed', failedCount: 1, items: [expect.objectContaining({ status: 'failed', attempts: 3 })],
      });
      await expect(contracts.getJob(partialJob.job.id)).resolves.toMatchObject({
        status: 'partial', partialCount: 1,
        items: [expect.objectContaining({ status: 'partial', attempts: 3, docxArtifactId: partialItem.docxArtifactId ?? docxId })],
      });
    } finally {
      await worker.stop();
    }
  });

  it('rejects confirmation when a linked tracking record changed after generation', async () => {
    const values = completeValues();
    const initial = await ndas.create({
      fields: { ...createEmptyFields(), ...contractValuesToTracking(values), Status: 'Pending' },
    });
    const record = initial.snapshot.records.find((candidate) => candidate.fields.Recipient === values.recipient.name)!;
    const draft = await contracts.draftForRecord(record.id, { requestId: randomUUID() });
    await ndas.update(record.id, {
      expectedVersion: record.version,
      fields: { ...record.fields, Recipient: 'Changed after generation' },
    });
    const template = (await pool.query('SELECT * FROM contract_template WHERE active=true LIMIT 1')).rows[0];
    const docxId = randomUUID(); const pdfId = randomUUID(); const versionId = randomUUID();
    await pool.query(
      `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
       VALUES($1,$3,'docx','mismatch.docx','application/octet-stream',$4,'docx-mismatch',now()),
             ($2,$3,'pdf','mismatch.pdf','application/pdf',$5,'pdf-mismatch',now())`,
      [docxId, pdfId, draft.contract.id, Buffer.from('docx'), Buffer.from('%PDF-test')],
    );
    await pool.query(
      `INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
       template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
       VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
      [versionId, draft.contract.id, template.id, template.template_key, template.template_version,
        template.checksum, template.content, JSON.stringify(draft.contract.values), docxId, pdfId],
    );
    const upload = await attachSigned(draft.contract.id, draft.contract.version, versionId);
    await expect(contracts.confirmSigned(draft.contract.id, {
      requestId: randomUUID(), expectedVersion: upload.contract.version, versionId, signedFileId: upload.signedFile.id,
      agreementDate: values.agreementDate, pic: values.pic,
    })).rejects.toMatchObject({
      status: 409,
      code: 'tracking_mismatch',
      details: { fields: expect.arrayContaining([expect.objectContaining({ field: 'Recipient' })]) },
    });
    expect((await contracts.getContract(draft.contract.id)).status).toBe('draft');
  });

  it('uses one workspace-first lock order across restore, refresh, lookup, confirmation and tracking updates', async () => {
    const values = completeValues();
    const initial = await ndas.create({
      fields: { ...createEmptyFields(), ...contractValuesToTracking(values), Status: 'Pending' },
    });
    const record = initial.snapshot.records.find((candidate) => candidate.fields.Recipient === values.recipient.name)!;
    const draft = await contracts.draftForRecord(record.id, { requestId: randomUUID() });
    const beforeRestore = await ndas.state();
    const [refreshed] = await within(Promise.all([
      contracts.refreshFromRecord(draft.contract.id, { requestId: randomUUID(), expectedVersion: draft.contract.version }),
      ndas.restore({ expectedRevision: beforeRestore.revision, snapshot: beforeRestore.snapshot }),
    ]));
    const current = refreshed.contract.version === 2 ? refreshed.contract : (await contracts.getContract(draft.contract.id));
    const template = (await pool.query('SELECT * FROM contract_template WHERE active=true LIMIT 1')).rows[0];
    const docxId = randomUUID(); const pdfId = randomUUID(); const versionId = randomUUID();
    await pool.query(
      `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
       VALUES($1,$3,'docx','locks.docx','application/octet-stream',$4,$6,now()),
             ($2,$3,'pdf','locks.pdf','application/pdf',$5,$7,now())`,
      [docxId, pdfId, draft.contract.id, Buffer.from('docx'), Buffer.from('%PDF-test'), randomUUID(), randomUUID()],
    );
    await pool.query(
      `INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
       template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
       VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
      [versionId, draft.contract.id, template.id, template.template_key, template.template_version,
        template.checksum, template.content, JSON.stringify(current.values), docxId, pdfId],
    );
    const firstUpload = await attachSigned(draft.contract.id, current.version, versionId);
    await within(Promise.all([
      contracts.draftForRecord(record.id, { requestId: randomUUID() }),
      contracts.confirmSigned(draft.contract.id, {
        requestId: randomUUID(), expectedVersion: firstUpload.contract.version, versionId, signedFileId: firstUpload.signedFile.id,
        agreementDate: values.agreementDate, pic: values.pic,
      }),
    ]));

    const secondState = await ndas.create({
      fields: { ...createEmptyFields(), ...contractValuesToTracking(values), Recipient: 'Second client', Status: 'Pending' },
    });
    const secondRecord = secondState.snapshot.records.find((candidate) => candidate.fields.Recipient === 'Second client')!;
    const secondDraft = await contracts.draftForRecord(secondRecord.id, { requestId: randomUUID() });
    const secondDocx = randomUUID(); const secondPdf = randomUUID(); const secondVersion = randomUUID();
    await pool.query(
      `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
       VALUES($1,$3,'docx','second.docx','application/octet-stream',$4,$6,now()),
             ($2,$3,'pdf','second.pdf','application/pdf',$5,$7,now())`,
      [secondDocx, secondPdf, secondDraft.contract.id, Buffer.from('docx'), Buffer.from('%PDF-test'), randomUUID(), randomUUID()],
    );
    await pool.query(
      `INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
       template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
       VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
      [secondVersion, secondDraft.contract.id, template.id, template.template_key, template.template_version,
        template.checksum, template.content, JSON.stringify(secondDraft.contract.values), secondDocx, secondPdf],
    );
    const secondUpload = await attachSigned(secondDraft.contract.id, secondDraft.contract.version, secondVersion);
    const outcomes = await within(Promise.allSettled([
      contracts.confirmSigned(secondDraft.contract.id, {
        requestId: randomUUID(), expectedVersion: secondUpload.contract.version, versionId: secondVersion,
        signedFileId: secondUpload.signedFile.id,
        agreementDate: values.agreementDate, pic: values.pic,
      }),
      ndas.update(secondRecord.id, {
        expectedVersion: secondRecord.version,
        fields: { ...secondRecord.fields, Department: 'Changed concurrently' },
      }),
    ]));
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
  });
});
