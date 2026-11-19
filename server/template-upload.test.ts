import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseTemplateUpload } from './template-upload.js';

function multipart(parts: string[]): IncomingMessage {
  const raw = parts.map(part => `--template-boundary\r\n${part}\r\n`).join('') + '--template-boundary--\r\n';
  const request = Readable.from([Buffer.from(raw)]) as IncomingMessage;
  request.headers = { 'content-type': 'multipart/form-data; boundary=template-boundary' };
  return request;
}
const file = 'Content-Disposition: form-data; name="file"; filename="example.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-example';
describe('template multipart boundaries', () => {
  it('separates binary file bytes from metadata', async () => {
    const result = await parseTemplateUpload(multipart(['Content-Disposition: form-data; name="documentType"\r\n\r\neoi', file]));
    expect(result.content.toString()).toBe('%PDF-example');
    expect(result.originalFileName).toBe('example.pdf');
    expect(result.fields.documentType).toBe('eoi');
  });
  it('rejects duplicate fields instead of accepting ambiguous metadata', async () => {
    const part = 'Content-Disposition: form-data; name="name"\r\n\r\nExample';
    await expect(parseTemplateUpload(multipart([part, part, file]))).rejects.toMatchObject({ status: 400 });
  });
  it('rejects additional files', async () => {
    await expect(parseTemplateUpload(multipart([file, file]))).rejects.toMatchObject({ status: 400 });
  });
  it('rejects declared oversized upload before buffering', async () => {
    const request = multipart([file]);
    request.headers['content-length'] = String(22 * 1024 * 1024);
    await expect(parseTemplateUpload(request)).rejects.toMatchObject({ status: 413 });
  });
  it('rejects unexpected form fields', async () => {
    await expect(parseTemplateUpload(multipart(['Content-Disposition: form-data; name="__proto__"\r\n\r\nunsafe', file]))).rejects.toMatchObject({ status: 400 });
  });
  it('accepts the exact 20 MiB boundary and rejects an extra byte', async () => {
    const prefix='Content-Disposition: form-data; name="file"; filename="example.pdf"\r\nContent-Type: application/pdf\r\n\r\n';
    const exact='x'.repeat(20*1024*1024);
    expect((await parseTemplateUpload(multipart([prefix+exact]))).content.length).toBe(20*1024*1024);
    await expect(parseTemplateUpload(multipart([prefix+exact+'x']))).rejects.toMatchObject({status:413});
  });
});
