import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { templateData } from '../src/contract-core.js';
import type { ContractValues } from '../src/contract-types.js';
import { withTransaction } from './db.js';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_TYPE = 'application/pdf';
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const LEASE_MS = 5 * 60_000;

class ConversionError extends Error {
  constructor(message: string, readonly transient: boolean) { super(message); }
}

function checksum(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeName(value: string): string {
  const cleaned = value.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 120) || 'contract';
}

export function renderContractDocx(template: Buffer, values: ContractValues): Buffer {
  const zip = new PizZip(template);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });
  const data = templateData(values);
  doc.render(data);
  const output = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
  if (output.length > MAX_ARTIFACT_BYTES) throw new ConversionError('Generated DOCX exceeds 20 MiB.', false);
  const rendered = new PizZip(output);
  const residue = Object.values(rendered.files)
    .filter((file) => !file.dir && file.name.endsWith('.xml'))
    .some((file) => {
      const xml = file.asText();
      return Object.keys(data).some((tag) => xml.includes(`{${tag}}`) || xml.includes(`{{${tag}}}`));
    });
  if (residue) throw new ConversionError('Generated DOCX still contains a known template tag.', false);
  return output;
}

export async function convertContractToPdf(baseUrl: string, docx: Buffer, fileName: string): Promise<Buffer> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(docx)], { type: DOCX_TYPE }), fileName);
  form.append('skipEmptyPages', 'true');
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new ConversionError('Document converter is temporarily unavailable.', true);
  }
  if (!response.ok) {
    throw new ConversionError(
      response.status >= 500 || response.status === 408 || response.status === 429
        ? 'Document converter returned a temporary error.'
        : 'Document converter rejected the DOCX.',
      response.status >= 500 || response.status === 408 || response.status === 429,
    );
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length || content.length > MAX_ARTIFACT_BYTES) {
    throw new ConversionError(content.length ? 'Generated PDF exceeds 20 MiB.' : 'Document converter returned an empty PDF.', false);
  }
  if (!content.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new ConversionError('Document converter returned an invalid PDF.', false);
  }
  return content;
}

async function nextOrdinal(client: PoolClient, contractId: string): Promise<number> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`contract-version:${contractId}`]);
  const result = await client.query(
    'SELECT COALESCE(max(ordinal),0)::integer + 1 ordinal FROM contract_version WHERE contract_id=$1',
    [contractId],
  );
  return result.rows[0].ordinal;
}

async function assertJobCapacity(client: PoolClient, jobId: string, additionalBytes: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`document-job-capacity:${jobId}`]);
  const result = await client.query(
    `SELECT COALESCE(sum(octet_length(a.content)),0)::text total
     FROM document_artifact a
     WHERE a.id IN (
       SELECT docx_artifact_id FROM document_job_item WHERE job_id=$1 AND docx_artifact_id IS NOT NULL
       UNION
       SELECT pdf_artifact_id FROM document_job_item WHERE job_id=$1 AND pdf_artifact_id IS NOT NULL
     )`, [jobId],
  );
  if (Number(result.rows[0].total) + additionalBytes > 250 * 1024 * 1024) {
    throw new ConversionError('Document batch exceeds 250 MiB.', false);
  }
}

async function aggregateJobStatus(client: PoolClient, jobId: string): Promise<void> {
  await client.query(
    `UPDATE document_job SET status=summary.status,lease_owner=NULL,lease_until=NULL,updated_at=now()
     FROM (
       SELECT job_id,CASE
         WHEN count(*) FILTER (WHERE status='queued' OR status='running') > 0 THEN 'queued'
         WHEN count(*) FILTER (WHERE status='complete') = count(*) THEN 'complete'
         WHEN count(*) FILTER (WHERE status='failed') = count(*) THEN 'failed'
         ELSE 'partial' END status
       FROM document_job_item WHERE job_id=$1 GROUP BY job_id
     ) summary WHERE document_job.id=summary.job_id`, [jobId],
  );
}

export class DocumentWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly owner = randomUUID();

  constructor(
    private readonly pool: Pool,
    private readonly converterUrl: string,
    private readonly pollMs = 1_000,
    private readonly backoffBaseMs = 5_000,
  ) {}

  async start(): Promise<void> {
    await this.recoverExpired();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  wake(): void { void this.tick(); }

  private async recoverExpired(): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const expired = await client.query(
        `SELECT id FROM document_job WHERE status='running' AND (lease_until IS NULL OR lease_until < now()) FOR UPDATE`,
      );
      for (const row of expired.rows) {
        await client.query(
          `UPDATE document_job_item SET status=CASE WHEN attempts>=3 THEN
             CASE WHEN docx_artifact_id IS NULL THEN 'failed' ELSE 'partial' END ELSE 'queued' END,
             next_attempt_at=now(),
             error_code=CASE WHEN attempts>=3 THEN 'worker_interrupted' ELSE NULL END,
             error_message=CASE WHEN attempts>=3 THEN 'Generation was interrupted before completion.' ELSE NULL END,
             updated_at=now()
           WHERE job_id=$1 AND status='running'`, [row.id],
        );
        await aggregateJobStatus(client, row.id);
      }
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobId = await this.claimJob();
      if (jobId) await this.processJob(jobId);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'document_worker_failed',
        message: error instanceof Error ? error.message : 'Unknown worker error',
      }));
    } finally {
      this.running = false;
    }
  }

  private async claimJob(): Promise<string | null> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT id FROM document_job
         WHERE (status='queued' AND EXISTS (
           SELECT 1 FROM document_job_item i WHERE i.job_id=document_job.id AND i.status='queued' AND i.next_attempt_at<=now()
         )) OR (status='running' AND lease_until < now())
         ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!result.rows[0]) return null;
      const jobId = result.rows[0].id;
      await client.query(
        `UPDATE document_job SET status='running',lease_owner=$2,lease_until=now()+($3 * interval '1 millisecond'),updated_at=now()
         WHERE id=$1`, [jobId, this.owner, LEASE_MS],
      );
      await client.query(
        `UPDATE document_job_item SET status=CASE WHEN attempts>=3 THEN
           CASE WHEN docx_artifact_id IS NULL THEN 'failed' ELSE 'partial' END ELSE 'queued' END,
           updated_at=now() WHERE job_id=$1 AND status='running'`, [jobId],
      );
      return jobId;
    });
  }

  private async processJob(jobId: string): Promise<void> {
    while (true) {
      const item = await withTransaction(this.pool, async (client) => {
        const result = await client.query(
          `SELECT * FROM document_job_item WHERE job_id=$1 AND status='queued'
           AND next_attempt_at<=now()
           ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [jobId],
        );
        if (!result.rows[0]) return null;
        const row = result.rows[0];
        await client.query(
          `UPDATE document_job_item SET status='running',attempts=attempts+1,error_code=NULL,error_message=NULL,updated_at=now()
           WHERE id=$1`, [row.id],
        );
        await client.query(
          `UPDATE document_job SET lease_until=now()+($3 * interval '1 millisecond'),updated_at=now()
           WHERE id=$1 AND lease_owner=$2`, [jobId, this.owner, LEASE_MS],
        );
        return { ...row, attempts: row.attempts + 1 };
      });
      if (!item) break;
      await this.processItem(item);
    }
    await this.finishJob(jobId);
  }

  private async processItem(item: Record<string, any>): Promise<void> {
    let docx: Buffer;
    let docxArtifactId: string | null = item.docx_artifact_id;
    try {
      if (docxArtifactId) {
        const existing = await this.pool.query('SELECT content FROM document_artifact WHERE id=$1', [docxArtifactId]);
        if (!existing.rows[0]) throw new ConversionError('Stored DOCX artifact is unavailable.', false);
        docx = existing.rows[0].content;
      } else {
        docx = renderContractDocx(item.template_bytes, item.values_snapshot as ContractValues);
        docxArtifactId = randomUUID();
        const fileName = `${safeName(item.contract_id)}.docx`;
        await withTransaction(this.pool, async (client) => {
          await assertJobCapacity(client, item.job_id, docx.length);
          await client.query(
            `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
             VALUES($1,$2,'docx',$3,$4,$5,$6,now())`,
            [docxArtifactId, item.contract_id, fileName, DOCX_TYPE, docx, checksum(docx)],
          );
          await client.query(
            `UPDATE document_job_item SET docx_artifact_id=$2,updated_at=now() WHERE id=$1`,
            [item.id, docxArtifactId],
          );
        });
      }
      const pdf = await convertContractToPdf(this.converterUrl, docx, `${safeName(item.contract_id)}.docx`);
      await this.completeItem(item, docxArtifactId, pdf);
    } catch (error) {
      const failure = error instanceof ConversionError ? error : new ConversionError('Document generation failed.', false);
      if (failure.transient && item.attempts < 3) {
        const delayMs = Math.min(60_000, this.backoffBaseMs * (2 ** (item.attempts - 1)));
        await this.pool.query(
          `UPDATE document_job_item SET status='queued',next_attempt_at=now()+($3 * interval '1 millisecond'),
            error_code='converter_temporary',error_message=$2,updated_at=now() WHERE id=$1`,
          [item.id, failure.message, delayMs],
        );
      } else if (docxArtifactId) {
        await this.partialItem(item, docxArtifactId, failure);
      } else {
        await this.pool.query(
          `UPDATE document_job_item SET status='failed',error_code=$2,error_message=$3,updated_at=now() WHERE id=$1`,
          [item.id, failure.transient ? 'converter_unavailable' : 'generation_failed', failure.message],
        );
      }
    }
  }

  private async completeItem(item: Record<string, any>, docxArtifactId: string, pdf: Buffer): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await assertJobCapacity(client, item.job_id, pdf.length);
      const ordinal = await nextOrdinal(client, item.contract_id);
      const versionId = randomUUID(); const pdfArtifactId = randomUUID();
      await client.query(
        `INSERT INTO document_artifact(id,contract_id,kind,file_name,content_type,content,checksum,created_at)
         VALUES($1,$2,'pdf',$3,$4,$5,$6,now())`,
        [pdfArtifactId, item.contract_id, `${safeName(item.contract_id)}-v${ordinal}.pdf`, PDF_TYPE, pdf, checksum(pdf)],
      );
      await client.query(
        `INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
          template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,now())`,
        [versionId, item.contract_id, ordinal, item.template_id, item.template_key, item.template_version,
          item.template_checksum, item.template_bytes, JSON.stringify(item.values_snapshot), docxArtifactId, pdfArtifactId],
      );
      await client.query(
        `UPDATE document_job_item SET status='complete',version_id=$2,pdf_artifact_id=$3,error_code=NULL,error_message=NULL,updated_at=now()
         WHERE id=$1`, [item.id, versionId, pdfArtifactId],
      );
      await client.query(
        `INSERT INTO contract_activity(id,contract_id,type,actor,details,created_at)
         VALUES($1,$2,'generation-complete','System',$3::jsonb,now())`,
        [randomUUID(), item.contract_id, JSON.stringify({ jobId: item.job_id, versionId })],
      );
    });
  }

  private async partialItem(item: Record<string, any>, docxArtifactId: string, failure: ConversionError): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const ordinal = await nextOrdinal(client, item.contract_id);
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO contract_version(id,contract_id,ordinal,template_id,template_key,template_version,template_checksum,
          template_bytes,values_snapshot,docx_artifact_id,pdf_artifact_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,NULL,now())`,
        [versionId, item.contract_id, ordinal, item.template_id, item.template_key, item.template_version,
          item.template_checksum, item.template_bytes, JSON.stringify(item.values_snapshot), docxArtifactId],
      );
      await client.query(
        `UPDATE document_job_item SET status='partial',version_id=$2,error_code=$3,error_message=$4,updated_at=now()
         WHERE id=$1`,
        [item.id, versionId, failure.transient ? 'converter_unavailable' : 'pdf_generation_failed', failure.message],
      );
      await client.query(
        `INSERT INTO contract_activity(id,contract_id,type,actor,details,created_at)
         VALUES($1,$2,'generation-partial','System',$3::jsonb,now())`,
        [randomUUID(), item.contract_id, JSON.stringify({ jobId: item.job_id, versionId })],
      );
    });
  }

  private async finishJob(jobId: string): Promise<void> {
    await withTransaction(this.pool, (client) => aggregateJobStatus(client, jobId));
  }
}
