import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import { AppError, badRequest, notFound } from './errors.js';
import type { ServerConfig } from './config.js';
import { PgNdaStore } from './store.js';
import { EmailService } from './email.js';
import { readBackupStatus } from './backup-status.js';
import { PgContractStore } from './contract-store.js';
import { ZipFile } from 'yazl';
import { parseSignedFileUpload } from './signed-file-upload.js';
import { PgSupplierStore } from './supplier-store.js';
import { PgTemplateStore } from './template-store.js';
import { parseTemplateUpload } from './template-upload.js';
import type { DocumentType } from '../src/contract-types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function safeDownloadName(value: string): string {
  return value.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 160) || 'document';
}

function binary(
  response: ServerResponse,
  status: number,
  content: Buffer,
  contentType: string,
  fileName: string,
  disposition: 'inline' | 'attachment',
): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': content.length,
    'Content-Disposition': `${disposition}; filename="${safeDownloadName(fileName)}"`,
    'Cache-Control': 'private, no-store',
  });
  response.end(content);
}

async function streamArchive(response: ServerResponse, store: PgContractStore, jobId: string): Promise<void> {
  const plan = await store.archivePlan(jobId);
  const archive = new ZipFile();
  response.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${safeDownloadName(`contract-job-${jobId}.zip`)}"`,
    'Cache-Control': 'private, no-store',
  });
  const done = new Promise<void>((resolve, reject) => {
    response.on('finish', resolve);
    response.on('error', reject);
    archive.outputStream.on('error', reject);
  });
  archive.outputStream.pipe(response);
  for (const entry of plan.entries) {
    const source = Readable.from((async function* () {
      yield (await store.artifact(entry.artifactId)).content;
    })());
    archive.addReadStream(source, entry.fileName, { size: entry.sizeBytes });
  }
  archive.addBuffer(plan.manifest, 'manifest.json');
  archive.end();
  await done;
}

async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new AppError(413, 'payload_too_large', 'Request body is too large.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new AppError(413, 'payload_too_large', 'Request body is too large.');
    chunks.push(bytes);
  }
  if (!size) throw badRequest('A JSON request body is required.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw badRequest('Request body must be valid JSON.'); }
}

function guard(request: IncomingMessage, config: ServerConfig): void {
  const host = request.headers.host?.toLowerCase();
  if (!host || !config.allowedHosts.has(host)) throw new AppError(421, 'invalid_host', 'Host is not allowed.');
  const origin = request.headers.origin;
  if (origin) {
    let originHost = '';
    try { const parsed = new URL(origin); originHost = parsed.host.toLowerCase(); }
    catch { throw new AppError(403, 'invalid_origin', 'Origin is not allowed.'); }
    if (originHost !== host) throw new AppError(403, 'invalid_origin', 'Origin is not allowed.');
  }
}

function requireJson(request: IncomingMessage): void {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new AppError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
}

async function serveFile(pathname: string, config: ServerConfig, response: ServerResponse): Promise<void> {
  const root = resolve(config.publicDir);
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw badRequest('Invalid URL path.'); }
  const relative = decoded.replace(/^\/+/, '');
  let target = resolve(root, relative || 'index.html');
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw notFound('File not found.');
  let details = await stat(target).catch(() => null);
  if (!details?.isFile()) {
    target = resolve(root, 'index.html'); details = await stat(target).catch(() => null);
  }
  if (!details?.isFile()) throw notFound('Application assets are unavailable.');
  response.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(target).pipe(response);
}

export function createHandler(pool: Pool, config: ServerConfig, email = new EmailService(pool, config)) {
  const store = new PgNdaStore(pool, (settings) => email.validateAutomaticSettings(settings));
  const contracts = new PgContractStore(pool);
  const suppliers = new PgSupplierStore(pool);
  const templates = new PgTemplateStore(pool,config.converterUrl);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const started = Date.now();
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'");
    try {
      guard(request, config);
      const url = new URL(request.url ?? '/', 'http://local.invalid');
      const method = request.method ?? 'GET';
      if (url.pathname === '/health/live' && method === 'GET') return json(response, 200, { status: 'ok' });
      if (url.pathname === '/health/ready' && method === 'GET') {
        await pool.query('SELECT 1'); return json(response, 200, { status: 'ready' });
      }
      if (url.pathname.startsWith('/api/')) {
        const signedFileUpload = /^\/api\/contracts\/([^/]+)\/signed-files$/.exec(url.pathname);
        const templateUpload = url.pathname === '/api/contract-templates/import' && method === 'POST';
        if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
          && !(signedFileUpload && method === 'POST') && !templateUpload) requireJson(request);
        let result: unknown;
        let status = 200;
        if (url.pathname === '/api/state' && method === 'GET') result = await store.state();
        else if (url.pathname === '/api/suppliers' && method === 'GET') result = { suppliers: await suppliers.listSuppliers() };
        else if (url.pathname === '/api/suppliers' && method === 'POST') {
          result = { supplier: await suppliers.createSupplier(await body(request,config.bodyLimitBytes)) }; status = 201;
        }
        else if (url.pathname === '/api/projects' && method === 'GET') result = { projects: await suppliers.listProjects() };
        else if (url.pathname === '/api/projects' && method === 'POST') {
          result = { project: await suppliers.createProject(await body(request,config.bodyLimitBytes)) }; status = 201;
        }
        else if (url.pathname === '/api/recycle-bin' && method === 'GET') {
          const [records, recycledContracts] = await Promise.all([store.recycledRecords(), contracts.recycledContracts()]);
          result = { records, contracts: recycledContracts };
        }
        else if (url.pathname === '/api/email/status' && method === 'GET') result = await email.status();
        else if (url.pathname === '/api/email/deliveries' && method === 'GET') result = {deliveries:await email.deliveries()};
        else if (url.pathname === '/api/email/summary' && method === 'GET') result = await email.summary();
        else if (url.pathname === '/api/email/test' && method === 'POST') result = {delivery:await email.test(await body(request,config.bodyLimitBytes))};
        else if (url.pathname === '/api/backups/archives' && method === 'GET') result = {archives:await store.listArchives()};
        else if (url.pathname === '/api/backups/automatic/status' && method === 'GET') result = await readBackupStatus(config.backupStatusDir ?? 'backups/automatic');
        else if (url.pathname === '/api/records' && method === 'POST') result = await store.create(await body(request,config.bodyLimitBytes));
        else if (url.pathname === '/api/imports' && method === 'POST') result = await store.importRows(await body(request,config.bodyLimitBytes));
        else if (url.pathname === '/api/settings' && method === 'PUT') result = await store.updateSettings(await body(request,config.bodyLimitBytes));
        else if (url.pathname === '/api/backups/restore' && method === 'POST') result = await store.restore(await body(request,config.bodyLimitBytes));
        else if (url.pathname === '/api/contract-templates' && method === 'GET') result = {templates:await contracts.listTemplates()};
        else if (url.pathname === '/api/contract-templates/families' && method === 'GET') result = {families:await templates.listFamilies()};
        else if (url.pathname === '/api/contract-template-drafts' && method === 'GET') result = {drafts:await templates.listDrafts()};
        else if (templateUpload) {
          const upload = await parseTemplateUpload(request);
          result = await templates.importTemplate({
            content:upload.content,fileName:upload.originalFileName,contentType:upload.contentType,
            requestId:upload.fields.requestId,key:upload.fields.key,name:upload.fields.name,
            documentType:upload.fields.documentType as DocumentType,
          });
          status=201;
        }
        else if (url.pathname === '/api/contracts' && method === 'GET') result = {contracts:await contracts.listContracts()};
        else if (url.pathname === '/api/contracts' && method === 'POST') result = await contracts.create(await body(request,config.bodyLimitBytes));
        else if (url.pathname === '/api/contracts/imports/preflight' && method === 'POST') result = contracts.preflight(await body(request,config.bodyLimitBytes));
        else if (url.pathname === '/api/contracts/imports' && method === 'POST') result = await contracts.importRows(await body(request,config.bodyLimitBytes));
        else if (url.pathname === '/api/document-jobs' && method === 'GET') result = {jobs:await contracts.listJobs()};
        else if (url.pathname === '/api/document-jobs/batch' && method === 'POST') {
          result = await contracts.enqueueBatch(await body(request,config.bodyLimitBytes)); status = 202;
        }
        else {
          const supplier = /^\/api\/suppliers\/([^/]+)$/.exec(url.pathname);
          const supplierAssignments = /^\/api\/suppliers\/([^/]+)\/assignments$/.exec(url.pathname);
          const project = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
          const recordSupplier = /^\/api\/records\/([^/]+)\/supplier$/.exec(url.pathname);
          const templateDraft = /^\/api\/contract-template-drafts\/([^/]+)$/.exec(url.pathname);
          const templatePreview = /^\/api\/contract-template-drafts\/([^/]+)\/preview$/.exec(url.pathname);
          const templatePublish = /^\/api\/contract-template-drafts\/([^/]+)\/publish$/.exec(url.pathname);
          const templateSource = /^\/api\/contract-template-drafts\/([^/]+)\/source$/.exec(url.pathname);
          const renew = /^\/api\/records\/([^/]+)\/renew$/.exec(url.pathname);
          const followUp = /^\/api\/records\/([^/]+)\/follow-up-notes$/.exec(url.pathname);
          const update = /^\/api\/records\/([^/]+)$/.exec(url.pathname);
          const archive = /^\/api\/backups\/restore\/([^/]+)$/.exec(url.pathname);
          const emailRetry = /^\/api\/email\/deliveries\/([^/]+)\/retry$/.exec(url.pathname);
          const recordDraft = /^\/api\/records\/([^/]+)\/contract-draft$/.exec(url.pathname);
          const restoreRecord = /^\/api\/recycle-bin\/records\/([^/]+)\/restore$/.exec(url.pathname);
          const restoreContract = /^\/api\/recycle-bin\/contracts\/([^/]+)\/restore$/.exec(url.pathname);
          const contract = /^\/api\/contracts\/([^/]+)$/.exec(url.pathname);
          const duplicateContract = /^\/api\/contracts\/([^/]+)\/duplicate$/.exec(url.pathname);
          const refreshContract = /^\/api\/contracts\/([^/]+)\/refresh-from-record$/.exec(url.pathname);
          const generateContract = /^\/api\/contracts\/([^/]+)\/generations$/.exec(url.pathname);
          const confirmContract = /^\/api\/contracts\/([^/]+)\/confirm-signed$/.exec(url.pathname);
          const documentJob = /^\/api\/document-jobs\/([^/]+)$/.exec(url.pathname);
          const retryJob = /^\/api\/document-jobs\/([^/]+)\/retry$/.exec(url.pathname);
          const jobArchive = /^\/api\/document-jobs\/([^/]+)\/archive$/.exec(url.pathname);
          const artifactContent = /^\/api\/document-artifacts\/([^/]+)\/content$/.exec(url.pathname);
          const signedFileContent = /^\/api\/contract-signed-files\/([^/]+)\/content$/.exec(url.pathname);
          if (supplier && method === 'GET') result = { supplier: await suppliers.supplier(decodeURIComponent(supplier[1])) };
          else if (supplier && method === 'PATCH') result = { supplier: await suppliers.updateSupplier(decodeURIComponent(supplier[1]),await body(request,config.bodyLimitBytes)) };
          else if (supplierAssignments && method === 'POST') result = await suppliers.assignItems(decodeURIComponent(supplierAssignments[1]),await body(request,config.bodyLimitBytes));
          else if (project && method === 'PATCH') result = { project: await suppliers.updateProject(decodeURIComponent(project[1]),await body(request,config.bodyLimitBytes)) };
          else if (recordSupplier && method === 'PATCH') result = await store.linkSupplier(decodeURIComponent(recordSupplier[1]),await body(request,config.bodyLimitBytes));
          else if (templateDraft && method === 'PATCH') result = await templates.updateDraft(decodeURIComponent(templateDraft[1]),await body(request,config.bodyLimitBytes));
          else if (templatePublish && method === 'POST') {
            result=await templates.publishDraft(decodeURIComponent(templatePublish[1]),await body(request,config.bodyLimitBytes)); status=201;
          }
          else if (templatePreview && method === 'POST') {
            const preview=await templates.previewDraft(decodeURIComponent(templatePreview[1]),await body(request,config.bodyLimitBytes));
            response.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'");
            return binary(response,200,preview.content,preview.contentType,preview.fileName,'inline');
          }
          else if (templateSource && method === 'GET') {
            const source=await templates.sourceDraft(decodeURIComponent(templateSource[1]));
            response.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'");
            return binary(response,200,source.content,source.contentType,source.fileName,url.searchParams.get('download')==='1'?'attachment':'inline');
          }
          else if (renew && method === 'POST') result = await store.renew(decodeURIComponent(renew[1]),await body(request,config.bodyLimitBytes));
          else if (restoreRecord && method === 'POST') result = await store.restoreRecycled(decodeURIComponent(restoreRecord[1]),await body(request,config.bodyLimitBytes));
          else if (restoreContract && method === 'POST') result = await contracts.restoreRecycled(decodeURIComponent(restoreContract[1]),await body(request,config.bodyLimitBytes));
          else if (followUp && method === 'POST') result = await store.addFollowUpNote(decodeURIComponent(followUp[1]),await body(request,config.bodyLimitBytes));
          else if (update && method === 'PUT') result = await store.update(decodeURIComponent(update[1]),await body(request,config.bodyLimitBytes));
          else if (update && method === 'DELETE') result = await store.recycle(decodeURIComponent(update[1]),await body(request,config.bodyLimitBytes));
          else if (archive && method === 'POST') result = await store.restoreArchive(decodeURIComponent(archive[1]),await body(request,config.bodyLimitBytes));
          else if (emailRetry && method === 'POST') result = {delivery:await email.retry(decodeURIComponent(emailRetry[1]),await body(request,config.bodyLimitBytes))};
          else if (recordDraft && method === 'POST') result = await contracts.draftForRecord(decodeURIComponent(recordDraft[1]),await body(request,config.bodyLimitBytes));
          else if (duplicateContract && method === 'POST') result = await contracts.duplicate(decodeURIComponent(duplicateContract[1]),await body(request,config.bodyLimitBytes));
          else if (refreshContract && method === 'POST') result = await contracts.refreshFromRecord(decodeURIComponent(refreshContract[1]),await body(request,config.bodyLimitBytes));
          else if (generateContract && method === 'POST') {
            result = await contracts.enqueueGeneration(decodeURIComponent(generateContract[1]),await body(request,config.bodyLimitBytes)); status = 202;
          }
          else if (signedFileUpload && method === 'POST') {
            result = await contracts.uploadSignedFile(decodeURIComponent(signedFileUpload[1]),await parseSignedFileUpload(request));
          }
          else if (confirmContract && method === 'POST') result = await contracts.confirmSigned(decodeURIComponent(confirmContract[1]),await body(request,config.bodyLimitBytes));
          else if (retryJob && method === 'POST') {
            result = await contracts.retryJob(decodeURIComponent(retryJob[1]),await body(request,config.bodyLimitBytes)); status = 202;
          }
          else if (jobArchive && method === 'GET') {
            return streamArchive(response,contracts,decodeURIComponent(jobArchive[1]));
          }
          else if (artifactContent && method === 'GET') {
            const artifact = await contracts.artifact(decodeURIComponent(artifactContent[1]));
            if (artifact.kind === 'pdf') response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
            const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
            return binary(response,200,artifact.content,artifact.contentType,artifact.fileName,disposition);
          }
          else if (signedFileContent && method === 'GET') {
            const signedFile = await contracts.signedFile(decodeURIComponent(signedFileContent[1]));
            response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
            const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
            return binary(response,200,signedFile.content,signedFile.contentType,signedFile.originalFileName,disposition);
          }
          else if (documentJob && method === 'GET') result = {job:await contracts.getJob(decodeURIComponent(documentJob[1]))};
          else if (contract && method === 'GET') result = {contract:await contracts.getContract(decodeURIComponent(contract[1]))};
          else if (contract && method === 'PATCH') result = await contracts.update(decodeURIComponent(contract[1]),await body(request,config.bodyLimitBytes));
          else if (contract && method === 'DELETE') result = await contracts.recycle(decodeURIComponent(contract[1]),await body(request,config.bodyLimitBytes));
          else throw notFound('API route was not found.');
        }
        return json(response, status, result);
      }
      if (!['GET','HEAD'].includes(method)) throw notFound('Route was not found.');
      if (method === 'HEAD') { response.writeHead(200); response.end(); return; }
      await serveFile(url.pathname,config,response);
    } catch (error) {
      const known = error instanceof AppError;
      const status = known ? error.status : 500;
      if (!known) console.error(JSON.stringify({ level:'error',event:'request_failed',method:request.method,path:request.url,message:error instanceof Error?error.message:'Unknown error' }));
      if (!response.headersSent) json(response,status,{ error:{ code:known?error.code:'internal_error', message:known?error.message:'The server could not complete the request.', ...(known && error.details !== undefined ? {details:error.details} : {}) } });
      else response.destroy();
    } finally {
      console.log(JSON.stringify({ level:'info',event:'request',method:request.method,path:request.url,status:response.statusCode,durationMs:Date.now()-started }));
    }
  };
}
