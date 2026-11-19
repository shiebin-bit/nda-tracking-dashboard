import type { IncomingMessage } from 'node:http';
import Busboy from 'busboy';
import { AppError, badRequest } from './errors.js';

export interface TemplateUpload {
  content: Buffer;
  originalFileName: string;
  contentType: string;
  fields: Record<string, string>;
}

/** Multipart has a separate bound; JSON APIs keep their existing limit. */
export function parseTemplateUpload(request: IncomingMessage): Promise<TemplateUpload> {
  const fileLimit = 20 * 1024 * 1024;
  const totalLimit = 21 * 1024 * 1024;
  if (Number(request.headers['content-length'] ?? 0) > totalLimit) {
    return Promise.reject(new AppError(413, 'payload_too_large', 'A template may not exceed 20 MiB.'));
  }
  return new Promise((resolve, reject) => {
    let done = false;
    let count = 0;
    let total = 0;
    let tooLarge = false;
    let originalFileName = '';
    let contentType = '';
    const chunks: Buffer[] = [];
    const fields: Record<string, string> = Object.create(null);
    const fail = (error: unknown) => { if (!done) { done = true; reject(error); } };
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({ headers: request.headers, limits: {
        files: 1, fileSize: fileLimit + 1, fields: 8, fieldSize: 65_536, fieldNameSize: 60, parts: 10,
      } });
    } catch {
      fail(new AppError(415, 'unsupported_media_type', 'Upload a DOCX or PDF using multipart/form-data.'));
      return;
    }
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > totalLimit) {
        fail(new AppError(413, 'payload_too_large', 'The template upload is too large.'));
        request.unpipe(parser);
        request.resume();
        parser.destroy();
      }
    };
    request.on('data', onData);
    request.once('aborted', () => fail(badRequest('Template upload interrupted.', 'upload_aborted')));
    request.once('error', fail);
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated || !['requestId', 'key', 'name', 'documentType', 'familyId', 'expectedVersion'].includes(name)
          || Object.hasOwn(fields, name)) {
        fail(badRequest('The template form fields are invalid.', 'invalid_template_upload'));
      } else fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      count++;
      if (name !== 'file' || count !== 1) {
        stream.resume();
        fail(badRequest('Exactly one template file is required.', 'invalid_template_upload'));
        return;
      }
      originalFileName = info.filename ?? '';
      contentType = info.mimeType;
      stream.on('limit', () => { tooLarge = true; });
      stream.on('data', (chunk: Buffer) => { if (!done) chunks.push(Buffer.from(chunk)); });
      stream.on('error', fail);
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) {
      parser.once(event, () => fail(badRequest('The template upload has too many parts.', 'invalid_template_upload')));
    }
    parser.once('error', () => fail(badRequest('Malformed template upload.', 'invalid_template_upload')));
    parser.once('close', () => {
      request.off('data', onData);
      if (done) return;
      if (tooLarge || chunks.reduce((size,chunk)=>size+chunk.length,0)>fileLimit) return fail(new AppError(413, 'payload_too_large', 'A template may not exceed 20 MiB.'));
      if (count !== 1 || !chunks.length) return fail(badRequest('Choose one DOCX or PDF template.', 'invalid_template_upload'));
      done = true;
      resolve({ content: Buffer.concat(chunks), originalFileName, contentType, fields });
    });
    request.pipe(parser);
  });
}
