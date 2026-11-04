import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import PizZip from 'pizzip';
import {
  contractValuesFromTracking,
  contractValuesToTracking,
  createFfmContractDefaults,
  normalizeContractValues,
  templateData,
  validateContractValues,
} from '../src/contract-core.js';
import { createEmptyFields, fingerprint, type Fields } from '../src/core.js';
import type {
  Contract,
  ContractActivity,
  ContractDetails,
  ContractListItem,
  ContractTemplate,
  ContractValues,
  ContractVersion,
  DocumentArtifact,
  DocumentJob,
  DocumentJobItem,
  ImportPreflightRow,
  SignedFileSummary,
} from '../src/contract-types.js';
import type { RecycledContract } from '../src/recycle-types.js';
import { withTransaction } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { renderContractDocx } from './document-worker.js';
import { validateSignedPdf } from './signed-file-upload.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH_SIZE = 100;
const MAX_BATCH_BYTES = 250 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw badRequest('requestId must be a UUID.');
  return value.toLowerCase();
}

function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw badRequest('expectedVersion must be a positive safe integer.');
  }
  return value as number;
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function portableTemplateFileName(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return basename(normalized);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function sentinelValues(): ContractValues {
  const values = normalizeContractValues({});
  const fillParty = (party: ContractValues['discloser'], prefix: string) => {
    party.name = `${prefix}NAME`;
    party.registrationNumber = `${prefix}REGISTRATION`;
    party.address = `${prefix}ADDRESS`;
    party.contact = { name: `${prefix}CONTACTNAME`, designation: `${prefix}CONTACTDESIGNATION`, address: `${prefix}CONTACTADDRESS`, email: `${prefix.toLowerCase()}@example.test` };
    party.signatory = { name: `${prefix}SIGNATORYNAME`, designation: `${prefix}SIGNATORYDESIGNATION` };
    party.witness = { name: `${prefix}WITNESSNAME`, designation: `${prefix}WITNESSDESIGNATION` };
  };
  fillParty(values.discloser, 'DISCLOSER');
  fillParty(values.recipient, 'RECIPIENT');
  values.purpose = 'PURPOSESENTINEL';
  values.agreementDate = '2099-12-31';
  values.duration = 7.25;
  return values;
}

export function validateContractTemplatePackage(content: Buffer, metadata: JsonObject): void {
  const zip = new PizZip(content);
  const packageHashes = isObject(metadata.output_package_sha256_by_part)
    ? metadata.output_package_sha256_by_part : {};
  const actualParts = Object.values(zip.files).filter((file) => !file.dir).map((file) => file.name).sort();
  const expectedParts = Object.keys(packageHashes).sort();
  if (stable(actualParts) !== stable(expectedParts)) {
    throw new Error('Contract template ZIP parts do not match the approved package.');
  }
  for (const part of expectedParts) {
    const expected = packageHashes[part];
    const file = zip.file(part);
    const actual = file ? createHash('sha256').update(file.asNodeBuffer()).digest('hex') : '';
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
      throw new Error(`Contract template package hash does not match metadata: ${part}.`);
    }
  }
  const xmlParts = Object.values(zip.files).filter((file) => !file.dir && file.name.endsWith('.xml'));
  const allXml = xmlParts.map((file) => file.asText()).join('\n');
  const mainXml = zip.file('word/document.xml')?.asText();
  if (!mainXml) throw new Error('Contract template is missing word/document.xml.');
  const relationships = Object.values(zip.files)
    .filter((file) => !file.dir && file.name.endsWith('.rels'))
    .map((file) => file.asText()).join('\n');
  if (/TargetMode\s*=\s*["']External["']/i.test(relationships)) {
    throw new Error('Contract template must not contain external relationships.');
  }
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const counts = isObject(metadata.tag_counts) ? metadata.tag_counts : {};
  for (const tag of tags) {
    const expected = counts[tag];
    if (!Number.isSafeInteger(expected) || (expected as number) < 1 || occurrences(allXml, `{${tag}}`) !== expected) {
      throw new Error(`Contract template tag count does not match metadata: ${tag}.`);
    }
  }
  const structure = isObject(metadata.output_structure) ? metadata.output_structure : {};
  const exactCounts: [string, RegExp, unknown][] = [
    ['sections', /<w:sectPr\b/g, structure.sections],
    ['tables', /<w:tbl\b/g, structure.tables],
    ['bookmark_count', /<w:bookmarkStart\b/g, structure.bookmark_count],
    ['instrText_count', /<w:instrText\b/g, structure.instrText_count],
    ['fldChar_count', /<w:fldChar\b/g, structure.fldChar_count],
  ];
  for (const [label, pattern, expected] of exactCounts) {
    const actual = mainXml.match(pattern)?.length ?? 0;
    if (!Number.isSafeInteger(expected) || actual !== expected) {
      throw new Error(`Contract template structure does not match metadata: ${label} expected ${String(expected)}, found ${actual}.`);
    }
  }
  if (!/<w:pgNumType\b[^>]*w:start=["']1["']/.test(allXml)
    || !/<w:instrText\b[^>]*>[^<]*\bREF\b/i.test(allXml)
    || !/<w:instrText\b[^>]*>[^<]*\bPAGE\b/i.test(allXml)) {
    throw new Error('Contract template must preserve page numbering and REF/PAGE fields.');
  }
  renderContractDocx(content, normalizeContractValues({}));
  const sentinel = sentinelValues();
  const rendered = new PizZip(renderContractDocx(content, sentinel));
  const renderedXml = Object.values(rendered.files)
    .filter((file) => !file.dir && file.name.endsWith('.xml'))
    .map((file) => file.asText()).join('\n');
  for (const value of Object.values(templateData(sentinel)).filter(Boolean)) {
    if (!renderedXml.includes(value)) throw new Error(`Contract template sentinel was not rendered: ${value}.`);
  }
}

function mapContract(row: Record<string, any>): Contract {
  const linkedNdaId = Object.prototype.hasOwnProperty.call(row, 'linked_nda_active_id')
    ? row.linked_nda_active_id ?? null : row.linked_nda_id ?? null;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    values: normalizeContractValues(row.values),
    linkedNdaId,
    linkedNdaHistoricalId: row.linked_nda_historical_id ?? null,
    signedVersionId: row.signed_version_id ?? null,
    currentSignedFileId: row.current_signed_file_id ?? null,
    signedFileCount: Number(row.signed_file_count ?? 0),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    signedAt: iso(row.signed_at),
  };
}

function mapContractListItem(row: Record<string, any>): ContractListItem {
  return {
    ...mapContract(row),
    latestGeneration: row.latest_generation_id ? {
      id: row.latest_generation_id,
      jobId: row.latest_generation_job_id ?? null,
      ordinal: row.latest_generation_ordinal,
      complete: row.latest_generation_complete,
      matchesDraft: row.latest_generation_matches_draft,
    } : null,
  };
}

function mapSignedFile(row: Record<string, any>): SignedFileSummary {
  return {
    id: row.id,
    contractId: row.contract_id,
    ordinal: row.ordinal,
    sourceVersionId: row.source_version_id,
    originalFileName: row.original_file_name,
    contentType: 'application/pdf',
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    uploadedBy: row.uploaded_by,
    uploadedAt: iso(row.uploaded_at)!,
  };
}

function mapTemplate(row: Record<string, any>): ContractTemplate {
  return {
    id: row.id,
    key: row.template_key,
    version: row.template_version,
    name: row.name,
    fileName: row.file_name,
    checksum: row.checksum,
    active: row.active,
    createdAt: iso(row.created_at)!,
  };
}

function mapVersion(row: Record<string, any>): ContractVersion {
  return {
    id: row.id,
    contractId: row.contract_id,
    ordinal: row.ordinal,
    templateId: row.template_id,
    templateKey: row.template_key,
    templateVersion: row.template_version,
    templateChecksum: row.template_checksum,
    values: normalizeContractValues(row.values_snapshot),
    docxArtifactId: row.docx_artifact_id,
    pdfArtifactId: row.pdf_artifact_id ?? null,
    complete: Boolean(row.pdf_artifact_id),
    createdAt: iso(row.created_at)!,
  };
}

function mapActivity(row: Record<string, any>): ContractActivity {
  return {
    id: row.id,
    contractId: row.contract_id,
    type: row.type,
    actor: row.actor,
    details: row.details,
    createdAt: iso(row.created_at)!,
  };
}

function mapJobItem(row: Record<string, any>): DocumentJobItem {
  return {
    id: row.id,
    contractId: row.contract_id,
    status: row.status,
    attempts: row.attempts,
    versionId: row.version_id ?? null,
    docxArtifactId: row.docx_artifact_id ?? null,
    pdfArtifactId: row.pdf_artifact_id ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
  };
}

async function addActivity(
  client: PoolClient,
  contractId: string,
  type: string,
  details: JsonObject = {},
): Promise<void> {
  await client.query(
    `INSERT INTO contract_activity(id,contract_id,type,actor,details,created_at)
     VALUES($1,$2,$3,'Local user',$4::jsonb,now())`,
    [randomUUID(), contractId, type, JSON.stringify(details)],
  );
}

async function idempotent<T>(
  client: PoolClient,
  id: string,
  action: string,
  payload: unknown,
  work: () => Promise<T>,
): Promise<T> {
  const payloadHash = hash(payload);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
  const existing = await client.query(
    'SELECT action,payload_hash,response_body FROM contract_request WHERE request_id=$1',
    [id],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.action !== action || row.payload_hash !== payloadHash) {
      throw conflict('requestId was already used for another request.', 'request_id_conflict');
    }
    return row.response_body as T;
  }
  const result = await work();
  await client.query(
    `INSERT INTO contract_request(request_id,action,payload_hash,response_status,response_body,created_at)
     VALUES($1,$2,$3,200,$4::jsonb,now())`,
    [id, action, payloadHash, JSON.stringify(result)],
  );
  return result;
}

async function lockedContract(client: PoolClient, id: string, allowRecycled = false): Promise<Record<string, any>> {
  const result = await client.query(`SELECT c.*,n.id linked_nda_active_id,n.deleted_at linked_nda_deleted_at,
      (SELECT count(*)::integer FROM contract_signed_file sf WHERE sf.contract_id=c.id) signed_file_count
    FROM contract c LEFT JOIN nda_record n ON n.id=c.linked_nda_id AND n.deleted_at IS NULL
    WHERE c.id=$1 FOR UPDATE OF c`, [id]);
  if (!result.rows[0]) throw notFound('Contract was not found.');
  if (result.rows[0].deleted_at && !allowRecycled) {
    throw conflict('This contract is in the Recycle Bin.', 'contract_recycled');
  }
  return result.rows[0];
}

function checkVersion(row: Record<string, any>, version: number): void {
  if (row.version !== version) {
    throw conflict('This contract was changed by another session. Reload and try again.', 'version_conflict');
  }
}

function ensureDraft(row: Record<string, any>): void {
  if (row.status !== 'draft') throw conflict('Signed contracts cannot be changed.', 'contract_signed');
}

async function insertContract(
  client: PoolClient,
  values: ContractValues,
  linkedNdaId: string | null = null,
): Promise<Contract> {
  const id = randomUUID();
  const result = await client.query(
    `INSERT INTO contract(id,version,status,values,linked_nda_id,linked_nda_historical_id,created_at,updated_at)
     VALUES($1,1,'draft',$2::jsonb,$3,$3,now(),now()) RETURNING *`,
    [id, JSON.stringify(values), linkedNdaId],
  );
  await addActivity(client, id, 'created', linkedNdaId ? { linkedNdaId } : {});
  return mapContract(result.rows[0]);
}

async function activeTemplate(client: PoolClient, templateId: unknown): Promise<Record<string, any>> {
  const result = typeof templateId === 'string' && templateId
    ? await client.query('SELECT * FROM contract_template WHERE id=$1 AND active=true', [templateId])
    : await client.query('SELECT * FROM contract_template WHERE active=true ORDER BY created_at DESC,id DESC LIMIT 1');
  if (!result.rows[0]) throw badRequest('No active contract template is available.', 'template_unavailable');
  return result.rows[0];
}

async function enqueue(
  client: PoolClient,
  entries: { row: Record<string, any>; values: ContractValues }[],
  template: Record<string, any>,
): Promise<string> {
  const jobId = randomUUID();
  await client.query(
    `INSERT INTO document_job(id,status,created_at,updated_at) VALUES($1,'queued',now(),now())`,
    [jobId],
  );
  for (const entry of entries) {
    await client.query(
      `INSERT INTO document_job_item(
        id,job_id,contract_id,status,attempts,values_snapshot,template_id,template_key,template_version,
        template_checksum,template_file_name,template_bytes,created_at,updated_at)
       VALUES($1,$2,$3,'queued',0,$4::jsonb,$5,$6,$7,$8,$9,$10,now(),now())`,
      [randomUUID(), jobId, entry.row.id, JSON.stringify(entry.values), template.id, template.template_key,
        template.template_version, template.checksum, template.file_name, template.content],
    );
    await addActivity(client, entry.row.id, 'generation-queued', { jobId });
  }
  return jobId;
}

function normalizedCompare(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'invalid';
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function seedContractTemplates(pool: Pool, directory = 'templates'): Promise<void> {
  const mapPath = resolve(directory, 'template-map.json');
  let raw: string;
  try { raw = await readFile(mapPath, 'utf8'); } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  const definitions = Array.isArray(parsed) ? parsed : isObject(parsed) && Array.isArray(parsed.templates) ? parsed.templates : [parsed];
  for (const item of definitions) {
    if (!isObject(item)) throw new Error('Each contract template definition must be an object.');
    const key = String(item.key ?? item.templateKey ?? item.template ?? '').trim();
    const version = String(item.version ?? (key.match(/(?:^|-)v([0-9][a-zA-Z0-9.-]*)$/)?.[1] ?? '1')).trim();
    const fileName = portableTemplateFileName(String(item.fileName ?? item.file ?? item.output ?? '').trim());
    const defaultName = key === 'ffm-nda-v1'
      ? 'FFM NDA · Disclosing party'
      : key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
    const name = String(item.name ?? defaultName).trim();
    const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    if (!key || !version || !fileName || !name) throw new Error('Template key, version, name, and fileName are required.');
    const expectedTags = Object.keys(templateData(createFfmContractDefaults())).sort();
    const actualTags = [...new Set(tags)].sort();
    if (stable(actualTags) !== stable(expectedTags)) {
      throw new Error(`Template ${key} must declare exactly the approved contract tags.`);
    }
    const content = await readFile(resolve(directory, fileName));
    validateContractTemplatePackage(content, item);
    const checksum = createHash('sha256').update(content).digest('hex');
    await withTransaction(pool, async (client) => {
      const existing = await client.query(
        'SELECT id,checksum FROM contract_template WHERE template_key=$1 AND template_version=$2 FOR UPDATE',
        [key, version],
      );
      if (existing.rows[0] && existing.rows[0].checksum !== checksum) {
        throw new Error(`Template ${key} ${version} already exists with different bytes.`);
      }
      await client.query('UPDATE contract_template SET active=false WHERE template_key=$1', [key]);
      if (existing.rows[0]) {
        await client.query('UPDATE contract_template SET active=true WHERE id=$1', [existing.rows[0].id]);
      } else {
        await client.query(
          `INSERT INTO contract_template(id,template_key,template_version,name,file_name,content,checksum,tags,active)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)`,
          [randomUUID(), key, version, name, fileName, content, checksum, JSON.stringify(tags)],
        );
      }
    });
  }
}

export class PgContractStore {
  constructor(private readonly pool: Pool) {}

  async listTemplates(): Promise<ContractTemplate[]> {
    const result = await this.pool.query('SELECT * FROM contract_template ORDER BY active DESC,created_at DESC,id DESC');
    return result.rows.map(mapTemplate);
  }

  async listContracts(): Promise<ContractListItem[]> {
    const result = await this.pool.query(`SELECT c.*,n.id linked_nda_active_id,n.deleted_at linked_nda_deleted_at,
      (SELECT count(*)::integer FROM contract_signed_file sf WHERE sf.contract_id=c.id) signed_file_count,
      latest_generation.id latest_generation_id,latest_generation.ordinal latest_generation_ordinal,
      latest_generation.job_id latest_generation_job_id,
      latest_generation.complete latest_generation_complete,
      latest_generation.matches_draft latest_generation_matches_draft
      FROM contract c LEFT JOIN nda_record n ON n.id=c.linked_nda_id AND n.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT cv.id,cv.ordinal,(cv.pdf_artifact_id IS NOT NULL) complete,
          (cv.values_snapshot = c.values) matches_draft,
          (SELECT item.job_id FROM document_job_item item WHERE item.version_id=cv.id
           ORDER BY item.created_at DESC,item.id DESC LIMIT 1) job_id
        FROM contract_version cv WHERE cv.contract_id=c.id
        ORDER BY cv.ordinal DESC LIMIT 1
      ) latest_generation ON true
      WHERE c.deleted_at IS NULL ORDER BY c.updated_at DESC,c.id DESC`);
    return result.rows.map(mapContractListItem);
  }

  async recycledContracts(): Promise<RecycledContract[]> {
    const result = await this.pool.query(`SELECT c.*,n.id linked_nda_active_id,n.deleted_at linked_nda_deleted_at,
      (SELECT count(*)::integer FROM contract_signed_file sf WHERE sf.contract_id=c.id) signed_file_count
      FROM contract c LEFT JOIN nda_record n ON n.id=c.linked_nda_id AND n.deleted_at IS NULL
      WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC,c.id`);
    return result.rows.map((row) => ({
      ...mapContract(row), deletedAt: iso(row.deleted_at)!, deletedBy: row.deleted_by,
    }));
  }

  async getContract(id: string): Promise<ContractDetails> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const contractResult = await client.query(`SELECT c.*,n.id linked_nda_active_id,n.deleted_at linked_nda_deleted_at,
        (SELECT count(*)::integer FROM contract_signed_file sf WHERE sf.contract_id=c.id) signed_file_count
        FROM contract c LEFT JOIN nda_record n ON n.id=c.linked_nda_id AND n.deleted_at IS NULL WHERE c.id=$1`, [id]);
      if (!contractResult.rows[0]) throw notFound('Contract was not found.');
      if (contractResult.rows[0].deleted_at) throw conflict('This contract is in the Recycle Bin.', 'contract_recycled');
      const versionsResult = await client.query(
        'SELECT * FROM contract_version WHERE contract_id=$1 ORDER BY ordinal DESC', [id],
      );
      const signedFilesResult = await client.query(`SELECT id,contract_id,ordinal,source_version_id,
        original_file_name,content_type,size_bytes,checksum,uploaded_by,uploaded_at
        FROM contract_signed_file WHERE contract_id=$1 ORDER BY ordinal DESC`, [id]);
      const activityResult = await client.query(
        'SELECT * FROM contract_activity WHERE contract_id=$1 ORDER BY created_at DESC,id DESC', [id],
      );
      const result = {
        ...mapContract(contractResult.rows[0]),
        versions: versionsResult.rows.map(mapVersion),
        signedFiles: signedFilesResult.rows.map(mapSignedFile),
        activity: activityResult.rows.map(mapActivity),
      };
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async create(input: unknown): Promise<{ contract: Contract }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId);
    const validation = validateContractValues(input.values ?? createFfmContractDefaults(), 'draft');
    if (validation.errors.length) throw badRequest(validation.errors.map((issue) => issue.message).join(' '), 'validation_failed');
    return withTransaction(this.pool, (client) => idempotent(client, rid, 'contract.create', input, async () => ({
      contract: await insertContract(client, validation.values),
    })));
  }

  async recycle(id: string, input: unknown): Promise<{ contract: RecycledContract }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId); const version = expectedVersion(input.expectedVersion);
    return withTransaction(this.pool, (client) => idempotent(client, rid, `contract.delete:${id}`, input, async () => {
      const row = await lockedContract(client, id); checkVersion(row, version);
      const result = await client.query(`UPDATE contract SET version=version+1,updated_at=now(),
        deleted_at=now(),deleted_by='Local user' WHERE id=$1 RETURNING *`, [id]);
      await addActivity(client, id, 'recycled');
      const recycled = { ...row, ...result.rows[0] };
      return { contract: { ...mapContract(recycled), deletedAt: iso(recycled.deleted_at)!, deletedBy: recycled.deleted_by } };
    }));
  }

  async restoreRecycled(id: string, input: unknown): Promise<{ contract: Contract }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId); const version = expectedVersion(input.expectedVersion);
    return withTransaction(this.pool, (client) => idempotent(client, rid, `contract.restore:${id}`, input, async () => {
      const row = await lockedContract(client, id, true);
      if (!row.deleted_at) throw conflict('This contract is not in the Recycle Bin.', 'not_in_recycle_bin');
      checkVersion(row, version);
      const result = await client.query(`UPDATE contract SET version=version+1,updated_at=now(),
        deleted_at=NULL,deleted_by=NULL WHERE id=$1 RETURNING *`, [id]);
      await addActivity(client, id, 'restored');
      return { contract: mapContract({ ...row, ...result.rows[0] }) };
    }));
  }

  async update(id: string, input: unknown): Promise<{ contract: Contract }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const version = expectedVersion(input.expectedVersion);
    const validation = validateContractValues(input.values, 'draft');
    if (validation.errors.length) throw badRequest(validation.errors.map((issue) => issue.message).join(' '), 'validation_failed');
    return withTransaction(this.pool, async (client) => {
      const row = await lockedContract(client, id); checkVersion(row, version); ensureDraft(row);
      if (stable(normalizeContractValues(row.values)) === stable(validation.values)) return { contract: mapContract(row) };
      const result = await client.query(
        `UPDATE contract SET version=version+1,values=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, JSON.stringify(validation.values)],
      );
      await addActivity(client, id, 'updated');
      return { contract: mapContract({ ...row, ...result.rows[0] }) };
    });
  }

  async duplicate(id: string, input: unknown): Promise<{ contract: Contract }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId);
    return withTransaction(this.pool, (client) => idempotent(client, rid, `contract.duplicate:${id}`, input, async () => {
      const source = await lockedContract(client, id);
      return { contract: await insertContract(client, normalizeContractValues(source.values)) };
    }));
  }

  async refreshFromRecord(id: string, input: unknown): Promise<{ contract: Contract }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId); const version = expectedVersion(input.expectedVersion);
    return withTransaction(this.pool, (client) => idempotent(client, rid, `contract.refresh:${id}`, input, async () => {
      await client.query('SELECT id FROM workspace WHERE id=1 FOR UPDATE');
      const row = await lockedContract(client, id); checkVersion(row, version); ensureDraft(row);
      if (!row.linked_nda_id) throw conflict('The linked NDA is unavailable.', 'linked_nda_unavailable');
      const nda = await client.query('SELECT fields,deleted_at FROM nda_record WHERE id=$1 FOR UPDATE', [row.linked_nda_id]);
      if (!nda.rows[0]) throw conflict('The linked NDA is unavailable.', 'linked_nda_unavailable');
      if (nda.rows[0].deleted_at) throw conflict('The linked NDA is in the Recycle Bin.', 'linked_nda_recycled');
      const values = contractValuesFromTracking(nda.rows[0].fields, normalizeContractValues(row.values));
      const result = await client.query(
        `UPDATE contract SET version=version+1,values=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, JSON.stringify(values)],
      );
      await addActivity(client, id, 'refreshed-from-record', { linkedNdaId: row.linked_nda_id });
      return { contract: mapContract({ ...row, ...result.rows[0] }) };
    }));
  }

  async draftForRecord(ndaId: string, input: unknown): Promise<{ contract: Contract }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId);
    return withTransaction(this.pool, (client) => idempotent(client, rid, `record.contract-draft:${ndaId}`, input, async () => {
      await client.query('SELECT id FROM workspace WHERE id=1 FOR UPDATE');
      const existing = await client.query(
        `SELECT * FROM contract WHERE linked_nda_historical_id=$1 AND status='draft' FOR UPDATE`, [ndaId],
      );
      if (existing.rows[0]?.deleted_at) {
        const error = conflict('The linked draft is in the Recycle Bin.', 'linked_draft_recycled');
        error.details = { contractId: existing.rows[0].id };
        throw error;
      }
      const nda = await client.query('SELECT id,fields,deleted_at FROM nda_record WHERE id=$1 FOR UPDATE', [ndaId]);
      if (!nda.rows[0]) throw notFound('NDA record was not found.');
      if (nda.rows[0].deleted_at) throw conflict('This NDA record is in the Recycle Bin.', 'record_recycled');
      if (existing.rows[0]) return { contract: mapContract(existing.rows[0]) };
      return { contract: await insertContract(client, contractValuesFromTracking(nda.rows[0].fields), ndaId) };
    }));
  }

  preflight(input: unknown): { rows: ImportPreflightRow[] } {
    if (!isObject(input) || !Array.isArray(input.rows)) throw badRequest('rows must be an array.');
    if (input.rows.length > 1_000) throw badRequest('An import may contain at most 1000 rows.');
    const rows = input.rows.map((item, index): ImportPreflightRow => {
      const wrapper = isObject(item) ? item : {};
      const rowNumber = Number.isSafeInteger(wrapper.rowNumber) && (wrapper.rowNumber as number) > 0
        ? wrapper.rowNumber as number : index + 1;
      const draft = validateContractValues(wrapper.values ?? item, 'draft');
      const exportCheck = validateContractValues(draft.values, 'export');
      return {
        rowNumber,
        values: draft.errors.length ? null : draft.values,
        errors: draft.errors,
        warnings: exportCheck.errors.filter((issue) => !draft.errors.some((error) => error.field === issue.field)),
      };
    });
    return { rows };
  }

  async importRows(input: unknown): Promise<{ contracts: Contract[] }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId);
    const checked = this.preflight(input);
    const errors = checked.rows.flatMap((row) => row.errors.map((issue) => `Row ${row.rowNumber}: ${issue.message}`));
    if (errors.length) throw badRequest(errors.join(' '), 'validation_failed');
    return withTransaction(this.pool, (client) => idempotent(client, rid, 'contract.import', input, async () => {
      const contracts: Contract[] = [];
      for (const row of checked.rows) contracts.push(await insertContract(client, row.values!));
      return { contracts };
    }));
  }

  async enqueueGeneration(id: string, input: unknown): Promise<{ job: DocumentJob }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId); const version = expectedVersion(input.expectedVersion);
    const result = await withTransaction(this.pool, (client) => idempotent(client, rid, `contract.generate:${id}`, input, async () => {
      const row = await lockedContract(client, id); checkVersion(row, version); ensureDraft(row);
      const validation = validateContractValues(row.values, 'export');
      if (validation.errors.length) throw badRequest(validation.errors.map((issue) => `${issue.field}: ${issue.message}`).join(' '), 'validation_failed');
      const template = await activeTemplate(client, input.templateId);
      return { jobId: await enqueue(client, [{ row, values: validation.values }], template) };
    }));
    return { job: await this.getJob(result.jobId) };
  }

  async enqueueBatch(input: unknown): Promise<{ job: DocumentJob }> {
    if (!isObject(input) || !Array.isArray(input.contracts)) throw badRequest('contracts must be an array.');
    const rid = requestId(input.requestId);
    if (input.contracts.length < 1 || input.contracts.length > MAX_BATCH_SIZE) {
      throw badRequest(`A document batch must contain 1 to ${MAX_BATCH_SIZE} contracts.`);
    }
    const requested = input.contracts.map((item) => {
      if (!isObject(item) || typeof item.id !== 'string' || !item.id) throw badRequest('Every batch contract must include an id.');
      return { id: item.id, expectedVersion: expectedVersion(item.expectedVersion) };
    });
    if (new Set(requested.map((item) => item.id)).size !== requested.length) throw badRequest('Batch contract IDs must be unique.');
    const result = await withTransaction(this.pool, (client) => idempotent(client, rid, 'document.batch', input, async () => {
      const template = await activeTemplate(client, input.templateId);
      if (Number(template.content.length) * requested.length > MAX_BATCH_BYTES) {
        throw badRequest('The batch exceeds the 250 MiB frozen-template limit.', 'batch_too_large');
      }
      const entries: { row: Record<string, any>; values: ContractValues }[] = [];
      for (const requestedContract of requested) {
        const row = await lockedContract(client, requestedContract.id);
        checkVersion(row, requestedContract.expectedVersion); ensureDraft(row);
        const validation = validateContractValues(row.values, 'export');
        if (validation.errors.length) {
          throw badRequest(`Contract ${row.id}: ${validation.errors.map((issue) => issue.message).join(' ')}`, 'validation_failed');
        }
        entries.push({ row, values: validation.values });
      }
      return { jobId: await enqueue(client, entries, template) };
    }));
    return { job: await this.getJob(result.jobId) };
  }

  async listJobs(): Promise<DocumentJob[]> {
    const result = await this.pool.query(`SELECT id FROM (
      SELECT id,created_at FROM document_job WHERE status IN ('queued','running')
      UNION ALL
      SELECT id,created_at FROM (
        SELECT id,created_at FROM document_job WHERE status NOT IN ('queued','running')
        ORDER BY created_at DESC,id DESC LIMIT 20
      ) recent
    ) visible_jobs ORDER BY created_at DESC,id DESC`);
    return Promise.all(result.rows.map((row) => this.getJob(row.id)));
  }

  async getJob(id: string): Promise<DocumentJob> {
    const [jobResult, itemResult] = await Promise.all([
      this.pool.query('SELECT * FROM document_job WHERE id=$1', [id]),
      this.pool.query('SELECT * FROM document_job_item WHERE job_id=$1 ORDER BY created_at,id', [id]),
    ]);
    const row = jobResult.rows[0];
    if (!row) throw notFound('Document job was not found.');
    const items = itemResult.rows.map(mapJobItem);
    return {
      id: row.id,
      status: row.status,
      itemCount: items.length,
      completedCount: items.filter((item) => item.status === 'complete').length,
      partialCount: items.filter((item) => item.status === 'partial').length,
      failedCount: items.filter((item) => item.status === 'failed').length,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
      items,
    };
  }

  async retryJob(id: string, input: unknown): Promise<{ job: DocumentJob }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId);
    const result = await withTransaction(this.pool, (client) => idempotent(client, rid, `document.retry:${id}`, input, async () => {
      const sourceJob = await client.query('SELECT id FROM document_job WHERE id=$1 FOR UPDATE', [id]);
      if (!sourceJob.rows[0]) throw notFound('Document job was not found.');
      const sourceItems = await client.query(
        `SELECT * FROM document_job_item WHERE job_id=$1 AND status IN ('partial','failed') ORDER BY created_at,id`, [id],
      );
      if (!sourceItems.rows.length) throw conflict('This job has no failed or partial items to retry.', 'nothing_to_retry');
      const contractIds = [...new Set(sourceItems.rows.map((item) => item.contract_id as string))].sort();
      for (const contractId of contractIds) await lockedContract(client, contractId);
      const jobId = randomUUID();
      await client.query(`INSERT INTO document_job(id,status,created_at,updated_at) VALUES($1,'queued',now(),now())`, [jobId]);
      for (const item of sourceItems.rows) {
        await client.query(
          `INSERT INTO document_job_item(
            id,job_id,contract_id,status,attempts,values_snapshot,template_id,template_key,template_version,
            template_checksum,template_file_name,template_bytes,docx_artifact_id,created_at,updated_at)
           VALUES($1,$2,$3,'queued',0,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,now(),now())`,
          [randomUUID(), jobId, item.contract_id, JSON.stringify(item.values_snapshot), item.template_id,
            item.template_key, item.template_version, item.template_checksum, item.template_file_name,
            item.template_bytes, item.docx_artifact_id],
        );
        await addActivity(client, item.contract_id, 'generation-retried', { sourceJobId: id, jobId });
      }
      return { jobId };
    }));
    return { job: await this.getJob(result.jobId) };
  }

  async artifact(id: string): Promise<DocumentArtifact & { content: Buffer }> {
    const result = await this.pool.query(
      `SELECT a.*,v.id version_id FROM document_artifact a
       LEFT JOIN contract_version v ON v.docx_artifact_id=a.id OR v.pdf_artifact_id=a.id
       WHERE a.id=$1 LIMIT 1`, [id],
    );
    const row = result.rows[0];
    if (!row) throw notFound('Document artifact was not found.');
    return {
      id: row.id,
      contractId: row.contract_id,
      versionId: row.version_id ?? null,
      kind: row.kind,
      fileName: row.file_name,
      contentType: row.content_type,
      sizeBytes: row.content.length,
      checksum: row.checksum,
      createdAt: iso(row.created_at)!,
      content: row.content,
    };
  }

  async archivePlan(jobId: string): Promise<{
    job: DocumentJob;
    entries: { artifactId: string; fileName: string; sizeBytes: number }[];
    manifest: Buffer;
  }> {
    const job = await this.getJob(jobId);
    const successes = job.items.filter((item) => item.status === 'complete' || item.status === 'partial');
    const requested = successes.flatMap((item) => [item.docxArtifactId, item.pdfArtifactId]
      .filter((id): id is string => Boolean(id))
      .map((artifactId) => ({ artifactId, contractId: item.contractId })));
    const metadata = requested.length
      ? await this.pool.query(
        `SELECT id,file_name,octet_length(content)::integer size_bytes FROM document_artifact WHERE id=ANY($1::text[])`,
        [requested.map((entry) => entry.artifactId)],
      )
      : { rows: [] as Record<string, any>[] };
    const byId = new Map(metadata.rows.map((row) => [row.id, row]));
    const entries = requested.map(({ artifactId, contractId }) => {
      const artifact = byId.get(artifactId);
      if (!artifact) throw notFound('A document artifact in this job is unavailable.');
      return { artifactId, fileName: `${contractId}/${artifact.file_name}`, sizeBytes: artifact.size_bytes as number };
    });
    const manifest = Buffer.from(JSON.stringify({ job, generatedAt: new Date().toISOString() }, null, 2));
    const total = manifest.length + entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (total > MAX_BATCH_BYTES) throw badRequest('The archive exceeds 250 MiB.', 'archive_too_large');
    return { job, entries, manifest };
  }

  async uploadSignedFile(id: string, input: unknown): Promise<{ contract: Contract; signedFile: SignedFileSummary }> {
    if (!isObject(input)) throw badRequest('Signed file upload is invalid.');
    const rid = requestId(input.requestId);
    const version = expectedVersion(input.expectedVersion);
    if (typeof input.versionId !== 'string' || !UUID_PATTERN.test(input.versionId)) {
      throw badRequest('versionId must identify a generated version.');
    }
    if (typeof input.originalFileName !== 'string' || typeof input.contentType !== 'string' || !Buffer.isBuffer(input.content)) {
      throw badRequest('A signed PDF file is required.', 'invalid_signed_file_upload');
    }
    const file = validateSignedPdf(input.originalFileName, input.contentType, input.content);
    const descriptor = {
      requestId: rid, expectedVersion: version, versionId: input.versionId,
      originalFileName: file.originalFileName, contentType: file.contentType,
      sizeBytes: file.sizeBytes, checksum: file.checksum,
    };
    return withTransaction(this.pool, (client) => idempotent(
      client, rid, `contract.signed-file.upload:${id}`, descriptor, async () => {
        const row = await lockedContract(client, id);
        checkVersion(row, version);
        if (row.status === 'signed' && row.signed_version_id !== input.versionId) {
          throw conflict('A signed contract can only attach a copy from its confirmed generated version.', 'signed_file_version_mismatch');
        }
        const source = await client.query(
          `SELECT id FROM contract_version WHERE id=$1 AND contract_id=$2 AND pdf_artifact_id IS NOT NULL FOR UPDATE`,
          [input.versionId, id],
        );
        if (!source.rows[0]) {
          throw conflict('The signed PDF must be based on a complete generated version of this contract.', 'signed_file_version_mismatch');
        }
        const next = await client.query(
          'SELECT COALESCE(max(ordinal),0)::integer+1 ordinal FROM contract_signed_file WHERE contract_id=$1', [id],
        );
        const signedFileId = randomUUID();
        const inserted = await client.query(
          `INSERT INTO contract_signed_file(
            id,contract_id,ordinal,source_version_id,original_file_name,content_type,size_bytes,checksum,content,
            uploaded_by,uploaded_at)
           VALUES($1,$2,$3,$4,$5,'application/pdf',$6,$7,$8,'Local user',now()) RETURNING *`,
          [signedFileId, id, next.rows[0].ordinal, input.versionId, file.originalFileName,
            file.sizeBytes, file.checksum, file.content],
        );
        const updated = await client.query(
          `UPDATE contract SET version=version+1,current_signed_file_id=$2,updated_at=now()
           WHERE id=$1 RETURNING *`, [id, signedFileId],
        );
        await addActivity(client, id, 'signed-file-uploaded', {
          signedFileId, sourceVersionId: input.versionId, ordinal: next.rows[0].ordinal,
          originalFileName: file.originalFileName, sizeBytes: file.sizeBytes, checksum: file.checksum,
        });
        return {
          contract: mapContract({ ...row, ...updated.rows[0], signed_file_count: Number(row.signed_file_count) + 1 }),
          signedFile: mapSignedFile(inserted.rows[0]),
        };
      },
    ));
  }

  async signedFile(id: string): Promise<SignedFileSummary & { content: Buffer }> {
    const result = await this.pool.query('SELECT * FROM contract_signed_file WHERE id=$1', [id]);
    if (!result.rows[0]) throw notFound('Signed PDF was not found.');
    return { ...mapSignedFile(result.rows[0]), content: result.rows[0].content };
  }

  async confirmSigned(id: string, input: unknown): Promise<{ contract: Contract; recordId: string; revision: string }> {
    if (!isObject(input)) throw badRequest('Request body must be an object.');
    const rid = requestId(input.requestId); const version = expectedVersion(input.expectedVersion);
    if (typeof input.versionId !== 'string' || !input.versionId) throw badRequest('versionId is required.');
    return withTransaction(this.pool, (client) => idempotent(client, rid, `contract.confirm:${id}`, input, async () => {
      const workspace = await client.query('SELECT revision::text,next_number::text FROM workspace WHERE id=1 FOR UPDATE');
      if (!workspace.rows[0]) throw new Error('Database workspace is not initialized.');
      const row = await lockedContract(client, id); checkVersion(row, version); ensureDraft(row);
      if (typeof input.signedFileId !== 'string' || !input.signedFileId) {
        throw conflict('Upload the final signed PDF before confirming.', 'signed_file_required');
      }
      if (row.current_signed_file_id !== input.signedFileId) {
        throw conflict('Select the current signed PDF for this contract.', 'signed_file_mismatch');
      }
      const signedFile = await client.query(
        'SELECT source_version_id FROM contract_signed_file WHERE id=$1 AND contract_id=$2', [input.signedFileId, id],
      );
      if (!signedFile.rows[0]) throw conflict('The signed PDF does not belong to this contract.', 'signed_file_mismatch');
      if (signedFile.rows[0].source_version_id !== input.versionId) {
        throw conflict('The signed PDF was uploaded from a different generated version.', 'signed_file_version_mismatch');
      }
      const generated = await client.query(
        `SELECT * FROM contract_version WHERE id=$1 AND contract_id=$2`, [input.versionId, id],
      );
      if (!generated.rows[0] || !generated.rows[0].pdf_artifact_id) {
        throw badRequest('A complete generated version must be selected.', 'incomplete_version');
      }
      const values = normalizeContractValues(generated.rows[0].values_snapshot);
      const manualDate = typeof input.agreementDate === 'string' ? input.agreementDate.trim() : '';
      const manualPic = typeof input.pic === 'string' ? input.pic.trim() : '';
      if (!values.agreementDate && manualDate) values.agreementDate = manualDate;
      if (!values.pic && manualPic) values.pic = manualPic;
      const validation = validateContractValues(values, 'export');
      if (validation.errors.length || !values.agreementDate || !values.pic) {
        throw badRequest('A valid agreement date and PIC are required to confirm signing.', 'confirmation_incomplete');
      }
      const mapped = contractValuesToTracking(values);
      let recordId: string;
      let revision: string;
      if (row.linked_nda_id) {
        const record = await client.query('SELECT id,fields,deleted_at FROM nda_record WHERE id=$1 FOR UPDATE', [row.linked_nda_id]);
        if (!record.rows[0]) throw conflict('The linked NDA is unavailable.', 'linked_nda_unavailable');
        if (record.rows[0].deleted_at) throw conflict('The linked NDA is in the Recycle Bin.', 'linked_nda_recycled');
        const differences = Object.entries(mapped).flatMap(([field, expected]) => {
          const actual = record.rows[0].fields[field];
          return normalizedCompare(actual) === normalizedCompare(expected) ? [] : [{ field, expected, actual }];
        });
        if (differences.length) {
          const error = conflict('The linked NDA no longer matches this generated contract.', 'tracking_mismatch');
          error.details = { fields: differences };
          throw error;
        }
        recordId = record.rows[0].id;
        revision = workspace.rows[0].revision;
      } else {
        recordId = randomUUID();
        const fields: Fields = { ...createEmptyFields(), ...mapped, 'No.': Number(workspace.rows[0].next_number), Status: 'Pending' };
        const positions = await client.query(`SELECT
          COALESCE((SELECT max(position) FROM nda_record),0)::text record,
          COALESCE((SELECT max(position) FROM history_event),0)::text history`);
        await client.query(
          `INSERT INTO nda_record(id,position,version,source,created_at,updated_at,fields,fingerprint)
           VALUES($1,$2,1,'manual',now(),now(),$3::jsonb,$4)`,
          [recordId, Number(positions.rows[0].record) + 1, JSON.stringify(fields), fingerprint(fields)],
        );
        await client.query(
          `INSERT INTO history_event(id,position,nda_id,type,timestamp,actor,summary,changes)
           VALUES($1,$2,$3,'created',now(),'Local user','Created NDA record from signed contract.',$4::jsonb)`,
          [randomUUID(), Number(positions.rows[0].history) + 1, recordId,
            JSON.stringify(Object.entries(fields).filter(([, value]) => value !== null).map(([field, after]) => ({ field, before: null, after })))],
        );
        const bumped = await client.query(
          `UPDATE workspace SET revision=revision+1,next_number=next_number+1 WHERE id=1 RETURNING revision::text`,
        );
        revision = bumped.rows[0].revision;
      }
      const updated = await client.query(
        `UPDATE contract SET version=version+1,status='signed',values=$2::jsonb,linked_nda_id=$3,
          linked_nda_historical_id=COALESCE(linked_nda_historical_id,$3),signed_version_id=$4,signed_at=now(),updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, JSON.stringify(values), recordId, input.versionId],
      );
      await addActivity(client, id, 'signed-confirmed', { versionId: input.versionId, recordId });
      return { contract: mapContract({ ...row, ...updated.rows[0] }), recordId, revision };
    }));
  }
}
