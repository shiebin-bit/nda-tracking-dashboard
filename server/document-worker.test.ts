import { readFile } from 'node:fs/promises';
import PizZip from 'pizzip';
import { describe, expect, it, vi } from 'vitest';
import { createFfmContractDefaults, templateData } from '../src/contract-core';
import { convertContractToPdf, renderContractDocx } from './document-worker';
import { portableTemplateFileName, validateContractTemplatePackage } from './contract-store';

describe('contract DOCX rendering', () => {
  it('normalizes template filenames from Windows or Linux metadata', () => {
    expect(portableTemplateFileName('E:\\nda-tracking-dashboard\\templates\\ffm-nda-v1.docx')).toBe('ffm-nda-v1.docx');
    expect(portableTemplateFileName('/app/templates/ffm-nda-v1.docx')).toBe('ffm-nda-v1.docx');
  });

  it('asks LibreOffice conversion to skip automatically inserted blank pages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const form = init?.body as FormData;
      expect(form.get('skipEmptyPages')).toBe('true');
      expect(form.get('files')).toBeInstanceOf(Blob);
      return new Response(Buffer.from('%PDF-1.4\n%%EOF'), { status: 200 });
    });
    try {
      await expect(convertContractToPdf('http://converter:3000', Buffer.from('docx'), 'test.docx'))
        .resolves.toEqual(Buffer.from('%PDF-1.4\n%%EOF'));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('passes the checked-in package fidelity preflight against its golden map', async () => {
    const [template, rawMap] = await Promise.all([
      readFile('templates/ffm-nda-v1.docx'),
      readFile('templates/template-map.json', 'utf8'),
    ]);
    expect(() => validateContractTemplatePackage(template, JSON.parse(rawMap))).not.toThrow();
  });

  it('rejects a fixed-clause edit even when tags and document structure still match', async () => {
    const [template, rawMap] = await Promise.all([
      readFile('templates/ffm-nda-v1.docx'),
      readFile('templates/template-map.json', 'utf8'),
    ]);
    const zip = new PizZip(template);
    const document = zip.file('word/document.xml')!.asText();
    expect(document).toContain('Non-Disclosure');
    zip.file('word/document.xml', document.replace('Non-Disclosure', 'Altered-Clause'));
    const changed = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
    expect(() => validateContractTemplatePackage(changed, JSON.parse(rawMap)))
      .toThrow(/package hash does not match metadata: word\/document\.xml/);
  });
  it('renders every known flat tag from the frozen template and preserves legitimate user names', async () => {
    const template = await readFile('templates/ffm-nda-v1.docx');
    const values = createFfmContractDefaults();
    values.recipient.name = 'Her Yi & Sons Sdn. Bhd.';
    values.recipient.registrationNumber = '202601000001';
    values.recipient.address = '1 Example Road, Kuala Lumpur';
    values.purpose = 'Technical evaluation';
    values.agreementDate = '2026-10-22';
    const output = renderContractDocx(template, values);
    expect(output.length).toBeGreaterThan(10_000);
    const zip = new PizZip(output);
    const xml = Object.values(zip.files)
      .filter((file) => !file.dir && file.name.endsWith('.xml'))
      .map((file) => file.asText())
      .join('\n');
    for (const tag of Object.keys(templateData(values))) {
      expect(xml).not.toContain(`{${tag}}`);
      expect(xml).not.toContain(`{{${tag}}}`);
    }
    expect(xml).toContain('Her Yi');
    expect(xml).toContain('22 October 2026');
    expect(xml).toContain('Three (3) years');
  });
});
