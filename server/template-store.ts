import { randomUUID } from 'node:crypto';
import type { Pool } from './db.js';
import type {
  ContractTemplate,
  ContractValues,
  DocumentType,
  TemplateDraft,
  TemplateEditorSnapshot,
  TemplateFamily,
  TemplateFormat,
} from '../src/contract-types.js';
import { normalizeContractValues, normalizeCustomValues } from '../src/contract-core.js';
import { withTransaction } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { convertContractToPdf, renderContractDocx } from './document-worker.js';
import {
  MAX_TEMPLATE_BYTES,
  TEMPLATE_CONTENT_TYPES,
  applyDocxEditor,
  inspectDocxTemplate,
  inspectPdfTemplate,
  normalizeFieldSchema,
  normalizePdfPlacements,
  renderPdfTemplate,
  resolveTemplateFields,
  sourceChecksum,
} from './template-render.js';

type JsonObject = Record<string, unknown>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Request body must be an object.');
  return value as JsonObject;
}

function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function documentType(value: unknown): DocumentType { if (value !== 'nda' && value !== 'eoi') throw badRequest('documentType must be nda or eoi.'); return value; }
function safeKey(value: unknown): string {
  const key = typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(key)) throw badRequest('Template key must contain letters, numbers, and hyphens.');
  return key;
}
function title(value: unknown): string { const text = typeof value === 'string' ? value.normalize('NFC').trim() : ''; if (!text || text.length > 160) throw badRequest('Template name is required and must not exceed 160 characters.'); return text; }
function requestId(value: unknown): string { if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw badRequest('requestId must be a UUID.'); return value.toLowerCase(); }
function versionNumber(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw badRequest('expectedVersion must be a positive integer.'); return Number(value); }
function publishedVersion(value: unknown): string { const text = typeof value === 'string' ? value.trim() : ''; if (!/^[0-9][a-zA-Z0-9._-]{0,31}$/.test(text)) throw badRequest('Published version is invalid.'); return text; }

function mapFamily(row: Record<string, any>): TemplateFamily {
  return { id: row.id, key: row.family_key, name: row.name, documentType: row.document_type, format: row.template_format, active: Boolean(row.active), publishedTemplateId: row.published_template_id ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapDraft(row: Record<string, any>): TemplateDraft {
  return { id: row.id, familyId: row.family_id, version: row.version, name: row.name, fileName: row.file_name, format: row.template_format, documentType: row.document_type, editorSnapshot: row.editor_snapshot, checksum: row.source_checksum, sourceSizeBytes: Number(row.source_size_bytes ?? row.source_content?.length ?? 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapTemplate(row: Record<string, any>): ContractTemplate {
  return { id: row.id, key: row.template_key, version: row.template_version, name: row.name, fileName: row.file_name, checksum: row.checksum, active: Boolean(row.active), familyId: row.family_id ?? null, documentType: row.document_type ?? 'nda', format: row.template_format ?? 'docx', fieldSchema: row.field_schema ?? [], editorSnapshot: row.editor_snapshot ?? null, createdAt: iso(row.created_at) };
}

function normalizeSnapshot(value: unknown, current: TemplateEditorSnapshot): TemplateEditorSnapshot {
  const input = object(value); const fields = normalizeFieldSchema(input.fields ?? current.fields);
  if (current.format === 'pdf') return { format: 'pdf', fields, placements: normalizePdfPlacements(input.placements ?? current.placements ?? [], fields), pages: current.pages ?? [], warnings: current.warnings ?? [] };
  const allowed = new Map((current.regions ?? []).map((region) => [region.id, region]));
  if (!Array.isArray(input.regions)) throw badRequest('Word template regions must be an array.', 'invalid_template_fields');
  const regions = input.regions.map((entry) => {
    const raw = object(entry); const id = String(raw.id ?? ''); const original = allowed.get(id);
    if (!original) throw badRequest(`Unknown Word region ${id}.`, 'invalid_template_fields');
    const text = String(raw.text ?? '').normalize('NFC');
    if (text.length > 50_000) throw badRequest(`Word region ${id} is too long.`, 'invalid_template_fields');
    if (original.readOnly && text !== original.text) throw conflict(`Word region ${id} is protected.`, 'template_region_read_only');
    return { ...original, text };
  });
  if (regions.length !== allowed.size) throw badRequest('Every Word region must be retained.', 'invalid_template_fields');
  return { format: 'docx', fields, regions, warnings: current.warnings ?? [] };
}

export interface TemplateImportInput {
  requestId?: string;
  key: string;
  name: string;
  documentType: DocumentType;
  fileName: string;
  contentType: string;
  content: Buffer;
}

export class PgTemplateStore {
  constructor(private readonly pool: Pool, private readonly converterUrl = process.env.NDA_CONVERTER_URL ?? 'http://converter:3000') {}

  async listFamilies(): Promise<TemplateFamily[]> {
    const result = await this.pool.query('SELECT * FROM template_family ORDER BY active DESC,name,id');
    return result.rows.map(mapFamily);
  }

  async listDrafts(): Promise<TemplateDraft[]> {
    const result = await this.pool.query(`SELECT d.*,f.document_type,f.template_format,length(d.source_content) source_size_bytes
      FROM template_draft d JOIN template_family f ON f.id=d.family_id ORDER BY d.updated_at DESC,d.id`);
    return result.rows.map(mapDraft);
  }

  async importTemplate(raw: TemplateImportInput): Promise<{ family: TemplateFamily; draft: TemplateDraft }> {
    if (!Buffer.isBuffer(raw.content) || !raw.content.length || raw.content.length > MAX_TEMPLATE_BYTES) throw badRequest('A template file up to 20 MiB is required.', 'invalid_template');
    const key = safeKey(raw.key); const name = title(raw.name); const type = documentType(raw.documentType);
    const fileName = String(raw.fileName ?? '').replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
    const lower = fileName.toLowerCase();
    const format: TemplateFormat = lower.endsWith('.docx') && !lower.endsWith('.docm') ? 'docx' : lower.endsWith('.pdf') ? 'pdf' : (() => { throw badRequest('Only .docx and .pdf templates are supported.', 'invalid_template'); })();
    if (format === 'docx' && raw.contentType && ![TEMPLATE_CONTENT_TYPES.docx,'application/octet-stream','application/zip'].includes(raw.contentType)) throw badRequest('The uploaded Word content type is invalid.', 'invalid_template');
    if (format === 'pdf' && raw.contentType && ![TEMPLATE_CONTENT_TYPES.pdf,'application/octet-stream'].includes(raw.contentType)) throw badRequest('The uploaded PDF content type is invalid.', 'invalid_template');
    const snapshot = format === 'docx' ? inspectDocxTemplate(raw.content) : await inspectPdfTemplate(raw.content);
    const digest = sourceChecksum(raw.content); const rid = raw.requestId ? requestId(raw.requestId) : null;
    const payloadHash = sourceChecksum(Buffer.concat([raw.content, Buffer.from(JSON.stringify({key,name,type,format,fileName}))]));
    try { return await withTransaction(this.pool, async (client) => {
      if (rid) {
        // BEGIN IMMEDIATE serializes request-id claims for this local database.
        const previous = await client.query(`SELECT action,payload_hash,response_body FROM contract_request WHERE request_id=$1`, [rid]);
        if (previous.rows[0]) {
          if (previous.rows[0].action !== 'template.import' || previous.rows[0].payload_hash !== payloadHash) throw conflict('requestId was already used for another request.', 'request_id_conflict');
          const ids = previous.rows[0].response_body as { familyId: string; draftId: string };
          const result = await client.query(`SELECT d.*,f.document_type,f.template_format,length(d.source_content) source_size_bytes,
            f.family_key,f.name family_name,f.active,f.published_template_id,f.created_at family_created_at,f.updated_at family_updated_at
            FROM template_draft d JOIN template_family f ON f.id=d.family_id WHERE d.id=$1 AND f.id=$2`, [ids.draftId, ids.familyId]);
          if (!result.rows[0]) throw conflict('The earlier template import is unavailable.', 'request_id_conflict');
          const row = result.rows[0];
          return { family: mapFamily({ id: row.family_id, family_key: row.family_key, name: row.family_name, document_type: row.document_type, template_format: row.template_format, active: row.active, published_template_id: row.published_template_id, created_at: row.family_created_at, updated_at: row.family_updated_at }), draft: mapDraft(row) };
        }
      }
      if ((await client.query('SELECT 1 FROM template_family WHERE lower(family_key)=lower($1)', [key])).rows[0]) throw conflict('A template family with this key already exists.', 'template_key_conflict');
      const familyId = randomUUID(); const draftId = randomUUID();
      const familyResult = await client.query(`INSERT INTO template_family(id,family_key,name,document_type,template_format,active,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,1,now(),now()) RETURNING *`, [familyId,key,name,type,format]);
      const draftResult = await client.query(`INSERT INTO template_draft(id,family_id,version,name,file_name,source_content,source_checksum,editor_snapshot,created_at,updated_at)
        VALUES($1,$2,1,$3,$4,$5,$6,$7,now(),now()) RETURNING *,length(source_content) source_size_bytes`,
      [draftId,familyId,name,fileName,raw.content,digest,JSON.stringify(snapshot)]);
      if (rid) await client.query(`INSERT INTO contract_request(request_id,action,payload_hash,response_status,response_body,created_at)
        VALUES($1,'template.import',$2,201,$3,now())`, [rid,payloadHash,JSON.stringify({familyId,draftId})]);
      return { family: mapFamily(familyResult.rows[0]), draft: mapDraft({...draftResult.rows[0],document_type:type,template_format:format}) };
    }); } catch(error:any) {
      if(error?.code==='23505' || String(error?.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('A template family with this key already exists.','template_key_conflict');
      throw error;
    }
  }

  async updateDraft(id: string, raw: unknown): Promise<{ draft: TemplateDraft }> {
    const input = object(raw); const expected = versionNumber(input.expectedVersion);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(`SELECT d.*,f.document_type,f.template_format,length(d.source_content) source_size_bytes
        FROM template_draft d JOIN template_family f ON f.id=d.family_id WHERE d.id=$1`, [id]);
      const row = result.rows[0]; if (!row) throw notFound('Template draft was not found.');
      if (row.version !== expected) throw conflict('This template draft changed in another session.', 'version_conflict');
      const snapshot = normalizeSnapshot(input.editorSnapshot, row.editor_snapshot);
      const updated = await client.query(`UPDATE template_draft SET version=version+1,name=$2,editor_snapshot=$3,preview_version=NULL,preview_checksum=NULL,updated_at=now() WHERE id=$1
        RETURNING *,length(source_content) source_size_bytes`, [id,title(input.name ?? row.name),JSON.stringify(snapshot)]);
      return { draft: mapDraft({...updated.rows[0],document_type:row.document_type,template_format:row.template_format}) };
    });
  }

  async previewDraft(id: string, raw: unknown): Promise<{ content: Buffer; contentType: 'application/pdf'; fileName: string }> {
    const input = object(raw);
    const result = await this.pool.query(`SELECT d.*,f.document_type,f.template_format FROM template_draft d JOIN template_family f ON f.id=d.family_id WHERE d.id=$1`, [id]);
    const row = result.rows[0]; if (!row) throw notFound('Template draft was not found.');
    const values = normalizeContractValues(input.values ?? {}); const custom = normalizeCustomValues(input.customValues);
    if (!input.values) {
      values.discloser.name ||= 'FFM BERHAD'; values.recipient.name ||= 'Example Supplier';
      values.purpose ||= 'Example project evaluation'; values.duration ??= 3;
    }
    for (const field of row.editor_snapshot.fields ?? []) {
      const key = field.source ?? field.key;
      if (!custom[key]) custom[key] = field.type === 'date' ? new Date().toISOString().slice(0,10)
        : field.type === 'number' ? '123' : `Sample ${field.label}`;
    }
    const resolved = resolveTemplateFields(values, custom, row.editor_snapshot.fields ?? []);
    let content: Buffer;
    if (row.template_format === 'pdf') content = await renderPdfTemplate(row.source_content, row.editor_snapshot, resolved);
    else {
      const template = applyDocxEditor(row.source_content, row.editor_snapshot);
      const docx = renderContractDocx(template, values, {...custom,...resolved});
      content = await convertContractToPdf(this.converterUrl, docx, `${row.id}.docx`);
    }
    const marked=await this.pool.query('UPDATE template_draft SET preview_version=version,preview_checksum=$2 WHERE id=$1 AND version=$3', [id,sourceChecksum(content),row.version]);
    if(marked.rowCount!==1) throw conflict('The template changed while its preview was being generated. Preview it again.','stale_preview');
    return { content, contentType: 'application/pdf', fileName: `${row.name.replace(/[^a-z0-9.-]+/gi,'-') || 'template'}-preview.pdf` };
  }

  async sourceDraft(id: string): Promise<{ content: Buffer; contentType: string; fileName: string; format: TemplateFormat }> {
    const result = await this.pool.query(`SELECT d.source_content,d.file_name,f.template_format FROM template_draft d JOIN template_family f ON f.id=d.family_id WHERE d.id=$1`, [id]);
    const row=result.rows[0]; if(!row) throw notFound('Template draft was not found.');
    return {content:row.source_content,contentType:TEMPLATE_CONTENT_TYPES[row.template_format as TemplateFormat],fileName:row.file_name,format:row.template_format};
  }

  async publishDraft(id: string, raw: unknown): Promise<{ template: ContractTemplate }> {
    const input = object(raw); const rid = requestId(input.requestId); const expected = versionNumber(input.expectedVersion); const version = publishedVersion(input.version);
    const requestHash=sourceChecksum(Buffer.from(JSON.stringify({id,expected,version,name:input.name??null})));
    return withTransaction(this.pool, async (client) => {
      // BEGIN IMMEDIATE serializes request-id claims for this local database.
      const earlier = await client.query(`SELECT action,payload_hash,response_body FROM contract_request WHERE request_id=$1`, [rid]);
      if (earlier.rows[0]) {
        if(earlier.rows[0].action!==`template.publish:${id}` || earlier.rows[0].payload_hash!==requestHash) throw conflict('requestId was already used for another request.','request_id_conflict');
        const templateId = (earlier.rows[0].response_body as {templateId:string}).templateId;
        const template = await client.query('SELECT * FROM contract_template WHERE id=$1',[templateId]);
        if (!template.rows[0]) throw conflict('The earlier published template is unavailable.','request_id_conflict');
        return {template:mapTemplate(template.rows[0])};
      }
      const result = await client.query(`SELECT d.*,f.family_key,f.document_type,f.template_format FROM template_draft d JOIN template_family f ON f.id=d.family_id WHERE d.id=$1`,[id]);
      const row=result.rows[0]; if(!row) throw notFound('Template draft was not found.');
      if(row.version!==expected) throw conflict('This template draft changed in another session.','version_conflict');
      if(row.preview_version!==row.version || !row.preview_checksum) throw conflict('Preview this template draft before publishing it.','template_preview_required');
      const publishedContent:Buffer=row.template_format==='docx'?applyDocxEditor(row.source_content,row.editor_snapshot):row.source_content;
      if(row.template_format==='docx') {
        const detected=new Set(inspectDocxTemplate(publishedContent).fields.map((field)=>field.key));
        const declared=new Set<string>(((row.editor_snapshot.fields??[]) as {key:string}[]).map((field)=>field.key));
        for(const key of detected) if(!declared.has(key)) throw badRequest(`Template field ${key} is not defined.`,'invalid_template_fields');
        for(const key of declared) if(!detected.has(key)) throw badRequest(`Defined template field ${key} is not used in the Word document.`,'invalid_template_fields');
      }
      const digest=sourceChecksum(publishedContent); const templateId=randomUUID(); const name=title(input.name??row.name);
      if((await client.query('SELECT 1 FROM contract_template WHERE template_key=$1 AND template_version=$2',[row.family_key,version])).rows[0]) throw conflict('This template version already exists.','template_version_conflict');
      await client.query('UPDATE contract_template SET active=0 WHERE family_id=$1',[row.family_id]);
      const inserted=await client.query(`INSERT INTO contract_template(id,template_key,template_version,name,file_name,mime_type,content,checksum,tags,active,family_id,document_type,template_format,field_schema,editor_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14) RETURNING *`,
      [templateId,row.family_key,version,name,row.file_name,TEMPLATE_CONTENT_TYPES[row.template_format as TemplateFormat],publishedContent,digest,JSON.stringify((row.editor_snapshot.fields??[]).map((f:{key:string})=>f.key)),row.family_id,row.document_type,row.template_format,JSON.stringify(row.editor_snapshot.fields??[]),JSON.stringify(row.editor_snapshot)]);
      await client.query('UPDATE template_family SET name=$2,published_template_id=$3,updated_at=now() WHERE id=$1',[row.family_id,name,templateId]);
      await client.query(`INSERT INTO contract_request(request_id,action,payload_hash,response_status,response_body,created_at) VALUES($1,$2,$3,201,$4,now())`,[rid,`template.publish:${id}`,requestHash,JSON.stringify({templateId})]);
      return {template:mapTemplate(inserted.rows[0])};
    });
  }
}
