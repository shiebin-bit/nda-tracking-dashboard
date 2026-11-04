import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { IncomingMessage } from 'node:http';
import Busboy from 'busboy';
import { AppError, badRequest } from './errors.js';

export const MAX_SIGNED_PDF_BYTES = 20 * 1024 * 1024;
const MAX_MULTIPART_BYTES = 21 * 1024 * 1024;

export interface SignedFileUpload {
  requestId: string;
  expectedVersion: number;
  versionId: string;
  originalFileName: string;
  contentType: 'application/pdf';
  sizeBytes: number;
  checksum: string;
  content: Buffer;
}

function safeOriginalName(value: string): string {
  const original = basename(value.replace(/\\/g, '/')).normalize('NFKC').trim();
  if (!original || /[\u0000-\u001f\u007f]/.test(original)) {
    throw badRequest('The PDF file name is invalid.', 'invalid_signed_file');
  }
  const normalized = original.replace(/[^a-zA-Z0-9._() -]+/g, '-').replace(/\s+/g, ' ').slice(0, 255).trim();
  if (!normalized) throw badRequest('The PDF file name is invalid.', 'invalid_signed_file');
  return normalized;
}

export function validateSignedPdf(
  originalFileName: string,
  contentType: string,
  content: Buffer,
): Omit<SignedFileUpload, 'requestId' | 'expectedVersion' | 'versionId'> {
  const name = safeOriginalName(originalFileName);
  if (!/\.pdf$/i.test(name) || contentType.toLowerCase() !== 'application/pdf') {
    throw badRequest('The signed file must be a PDF.', 'invalid_signed_file');
  }
  if (content.length < 9 || content.length > MAX_SIGNED_PDF_BYTES) {
    if (content.length > MAX_SIGNED_PDF_BYTES) {
      throw new AppError(413, 'payload_too_large', 'The signed PDF may not exceed 20 MiB.');
    }
    throw badRequest('The signed PDF is malformed.', 'invalid_signed_file');
  }
  if (content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw badRequest('The signed PDF header is invalid.', 'invalid_signed_file');
  }
  const tail = content.subarray(Math.max(0, content.length - 1024)).toString('latin1').trimEnd();
  if (!tail.endsWith('%%EOF')) throw badRequest('The signed PDF end marker is missing.', 'invalid_signed_file');
  return {
    originalFileName: name,
    contentType: 'application/pdf',
    sizeBytes: content.length,
    checksum: createHash('sha256').update(content).digest('hex'),
    content,
  };
}

export function parseSignedFileUpload(request: IncomingMessage): Promise<SignedFileUpload> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_MULTIPART_BYTES) {
    return Promise.reject(new AppError(413, 'payload_too_large', 'The signed PDF upload is too large.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    let fileCount = 0;
    let fileName = '';
    let mimeType = '';
    let fileTooLarge = false;
    const chunks: Buffer[] = [];
    const fields = new Map<string, string>();
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: { fileSize: MAX_SIGNED_PDF_BYTES + 1, files: 1, fields: 3, parts: 5, fieldNameSize: 50, fieldSize: 200 },
      });
    } catch {
      reject(new AppError(415, 'unsupported_media_type', 'Content-Type must be multipart/form-data with a boundary.'));
      return;
    }
    const onRequestData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_MULTIPART_BYTES) {
        request.unpipe(parser);
        parser.destroy();
        finishError(new AppError(413, 'payload_too_large', 'The signed PDF upload is too large.'));
      }
    };
    request.on('data', onRequestData);
    request.once('aborted', () => finishError(badRequest('The signed PDF upload was interrupted.', 'upload_aborted')));
    request.once('error', finishError);
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated || !['requestId', 'expectedVersion', 'versionId'].includes(name) || fields.has(name)) {
        finishError(badRequest('The signed PDF form fields are invalid.', 'invalid_signed_file_upload'));
        return;
      }
      fields.set(name, value);
    });
    parser.on('file', (name, stream, info) => {
      fileCount += 1;
      if (name !== 'file' || fileCount !== 1) {
        stream.resume();
        finishError(badRequest('Exactly one PDF file is required.', 'invalid_signed_file_upload'));
        return;
      }
      fileName = info.filename ?? '';
      mimeType = info.mimeType;
      stream.on('limit', () => { fileTooLarge = true; });
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on('error', finishError);
    });
    parser.once('filesLimit', () => finishError(badRequest('Exactly one PDF file is required.', 'invalid_signed_file_upload')));
    parser.once('fieldsLimit', () => finishError(badRequest('The signed PDF form has too many fields.', 'invalid_signed_file_upload')));
    parser.once('partsLimit', () => finishError(badRequest('The signed PDF form has too many parts.', 'invalid_signed_file_upload')));
    parser.once('error', () => finishError(badRequest('The signed PDF form is malformed.', 'invalid_signed_file_upload')));
    parser.once('close', () => {
      request.off('data', onRequestData);
      if (settled) return;
      if (fileTooLarge) {
        finishError(new AppError(413, 'payload_too_large', 'The signed PDF may not exceed 20 MiB.'));
        return;
      }
      if (fileCount !== 1 || fields.size !== 3) {
        finishError(badRequest('A PDF, requestId, expectedVersion, and versionId are required.', 'invalid_signed_file_upload'));
        return;
      }
      const expected = Number(fields.get('expectedVersion'));
      if (!Number.isSafeInteger(expected) || expected < 1) {
        finishError(badRequest('expectedVersion must be a positive safe integer.'));
        return;
      }
      try {
        const file = validateSignedPdf(fileName, mimeType, Buffer.concat(chunks));
        settled = true;
        resolve({
          requestId: fields.get('requestId')!, expectedVersion: expected, versionId: fields.get('versionId')!, ...file,
        });
      } catch (error) {
        finishError(error);
      }
    });
    request.pipe(parser);
  });
}
