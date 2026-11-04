import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { MAX_SIGNED_PDF_BYTES, parseSignedFileUpload, validateSignedPdf } from './signed-file-upload';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

function multipart(parts: { name: string; value?: string; fileName?: string; contentType?: string; content?: Buffer }[]) {
  const boundary = '----nda-signed-file-test';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`));
    if (part.fileName !== undefined) chunks.push(Buffer.from(`; filename="${part.fileName}"`));
    chunks.push(Buffer.from('\r\n'));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(part.content ?? Buffer.from(part.value ?? ''));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

function requestFor(body: Buffer, boundary: string): IncomingMessage {
  const stream = new PassThrough() as PassThrough & { headers: Record<string, string> };
  stream.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
  queueMicrotask(() => stream.end(body));
  return stream as unknown as IncomingMessage;
}

describe('signed PDF upload boundary', () => {
  it('accepts exactly one bounded PDF and computes canonical metadata', async () => {
    const form = multipart([
      { name: 'requestId', value: '123e4567-e89b-42d3-a456-426614174000' },
      { name: 'expectedVersion', value: '2' },
      { name: 'versionId', value: '223e4567-e89b-42d3-a456-426614174000' },
      { name: 'file', fileName: 'signed.pdf', contentType: 'application/pdf', content: pdf },
    ]);
    const parsed = await parseSignedFileUpload(requestFor(form.body, form.boundary));
    expect(parsed).toMatchObject({ expectedVersion: 2, originalFileName: 'signed.pdf', sizeBytes: pdf.length });
    expect(parsed.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.compare(parsed.content, pdf)).toBe(0);
  });

  it('rejects multiple files, duplicate fields, and interrupted requests', async () => {
    const multiple = multipart([
      { name: 'requestId', value: '123e4567-e89b-42d3-a456-426614174000' },
      { name: 'expectedVersion', value: '1' },
      { name: 'versionId', value: '223e4567-e89b-42d3-a456-426614174000' },
      { name: 'file', fileName: 'one.pdf', contentType: 'application/pdf', content: pdf },
      { name: 'file', fileName: 'two.pdf', contentType: 'application/pdf', content: pdf },
    ]);
    await expect(parseSignedFileUpload(requestFor(multiple.body, multiple.boundary)))
      .rejects.toMatchObject({ status: 400, code: 'invalid_signed_file_upload' });

    const interrupted = new PassThrough() as PassThrough & { headers: Record<string, string> };
    interrupted.headers = { 'content-type': 'multipart/form-data; boundary=interrupted' };
    const pending = parseSignedFileUpload(interrupted as unknown as IncomingMessage);
    interrupted.emit('aborted');
    await expect(pending).rejects.toMatchObject({ status: 400, code: 'upload_aborted' });
  });

  it('rejects extension, MIME, header, EOF, and size violations', () => {
    expect(() => validateSignedPdf('signed.txt', 'application/pdf', pdf)).toThrowError(expect.objectContaining({ code: 'invalid_signed_file' }));
    expect(() => validateSignedPdf('signed.pdf', 'text/plain', pdf)).toThrowError(expect.objectContaining({ code: 'invalid_signed_file' }));
    expect(() => validateSignedPdf('signed.pdf', 'application/pdf', Buffer.from('not a pdf %%EOF')))
      .toThrowError(expect.objectContaining({ code: 'invalid_signed_file' }));
    expect(() => validateSignedPdf('signed.pdf', 'application/pdf', Buffer.from('%PDF-1.4 missing eof')))
      .toThrowError(expect.objectContaining({ code: 'invalid_signed_file' }));
    const oversized = Buffer.alloc(MAX_SIGNED_PDF_BYTES + 1);
    oversized.write('%PDF-'); oversized.write('%%EOF', oversized.length - 5);
    expect(() => validateSignedPdf('signed.pdf', 'application/pdf', oversized))
      .toThrowError(expect.objectContaining({ status: 413, code: 'payload_too_large' }));
  });

  it('accepts exactly 20 MiB and rejects the next byte through the real multipart parser', async () => {
    const makePdf = (size: number) => {
      const content = Buffer.alloc(size, 0x20);
      content.write('%PDF-', 0, 'ascii');
      content.write('%%EOF', content.length - 5, 'ascii');
      return content;
    };
    const formFor = (content: Buffer) => multipart([
      { name: 'requestId', value: '123e4567-e89b-42d3-a456-426614174000' },
      { name: 'expectedVersion', value: '1' },
      { name: 'versionId', value: '223e4567-e89b-42d3-a456-426614174000' },
      { name: 'file', fileName: 'signed.pdf', contentType: 'application/pdf', content },
    ]);
    const exact = formFor(makePdf(MAX_SIGNED_PDF_BYTES));
    await expect(parseSignedFileUpload(requestFor(exact.body, exact.boundary)))
      .resolves.toMatchObject({ sizeBytes: MAX_SIGNED_PDF_BYTES });
    const oversized = formFor(makePdf(MAX_SIGNED_PDF_BYTES + 1));
    await expect(parseSignedFileUpload(requestFor(oversized.body, oversized.boundary)))
      .rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
  }, 15_000);
});
