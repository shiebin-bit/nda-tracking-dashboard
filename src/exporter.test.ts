import { describe, expect, it } from 'vitest';
import { Workbook, ValueType } from 'exceljs';
import { COLUMNS, createEmptyFields, type Fields, type NdaRecord } from './core';
import { buildAgreementWorkbook, sortOverviewRecords } from './exporter';
import { parseWorkbook } from './importer';

const record = (fields: Partial<Fields>, id = 'record'): NdaRecord => ({
  id, version: 1, source: 'manual', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  fields: { ...createEmptyFields(), 'No.': 5, Recipient: 'Acme', PIC: 'Lee',
    'Date of Agreement': '2025-11-18', Duration: 1, UOM: 'years', Status: 'Pending', ...fields },
});
const exportedAt = new Date('2026-10-19T01:00:00Z');
async function read(records: NdaRecord[]) {
  const bytes = await buildAgreementWorkbook(records, { scope: 'all', filters: [], exportedAt });
  const workbook = new Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  return workbook;
}

describe('Excel agreement export', () => {
  it('keeps all 26 headers, original duplicate numbers and records across pages, with fixed typed calculations', async () => {
    const records = Array.from({ length: 11 }, (_, index) => record({
      Recipient: `Supplier ${index + 1}`, 'No.': index < 2 ? 5 : index + 1,
      'Remaining Days': 999, 'Expired on': '2000-01-01',
    }, `record-${index}`));
    const before = structuredClone(records);
    const workbook = await read(records);
    const sheet = workbook.getWorksheet('NDA')!;
    expect(sheet.getRow(1).values).toEqual([undefined, ...COLUMNS]);
    expect(sheet.rowCount).toBe(12);
    expect(sheet.getCell('A2').value).toBe(5);
    expect(sheet.getCell('A3').value).toBe(5);
    expect(sheet.getCell(2, COLUMNS.indexOf('Duration') + 1).type).toBe(ValueType.Number);
    expect(sheet.getCell(2, COLUMNS.indexOf('Expired on') + 1).value).toEqual(new Date('2026-11-18T00:00:00Z'));
    expect(sheet.getCell(2, COLUMNS.indexOf('Remaining Days') + 1).value).toBe(30);
    expect(sheet.getCell(2, COLUMNS.indexOf('Remaining Days') + 1).type).toBe(ValueType.Number);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
    expect(records).toEqual(before);
  });

  it('exports negative days and Resolved dates, and leaves invalid calculations blank', async () => {
    const workbook = await read([
      record({ 'Date of Agreement': '2025-10-18', Status: 'Resolved' }),
      record({ 'Date of Agreement': null, 'Remaining Days': 800 }),
      record({ 'Date of Agreement': '2026-02-30' }),
      record({ Duration: 0 }),
    ]);
    const sheet = workbook.getWorksheet('NDA')!;
    const remaining = COLUMNS.indexOf('Remaining Days') + 1;
    const expiry = COLUMNS.indexOf('Expired on') + 1;
    expect(sheet.getCell(2, remaining).value).toBe(-1);
    expect(sheet.getCell(2, COLUMNS.indexOf('Status') + 1).value).toBe('Resolved');
    for (const row of [3, 4, 5]) {
      expect(sheet.getCell(row, remaining).value).toBeNull();
      expect(sheet.getCell(row, expiry).value).toBeNull();
    }
    expect(sheet.getCell(4, COLUMNS.indexOf('Date of Agreement') + 1).value).toBeNull();
  });

  it('keeps formula-like text literal and reports the Malaysia export date and filters', async () => {
    const unsafeText = '=HYPERLINK("https://example.com","Open")';
    const bytes = await buildAgreementWorkbook([record({ Recipient: unsafeText, Purpose: '+SUM(1,2)' })], {
      scope: 'filtered', filters: [{ label: 'Search', value: '=Acme' }, { label: 'Status', value: 'Pending' }],
      exportedAt: new Date('2026-10-18T16:30:00Z'),
    });
    const workbook = new Workbook();
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    const recipient = workbook.getWorksheet('NDA')!.getCell(2, COLUMNS.indexOf('Recipient') + 1);
    expect(recipient.type).toBe(ValueType.String);
    expect(recipient.value).toBe(unsafeText);
    const info = workbook.getWorksheet('Export info')!;
    const values = new Map<string, unknown>();
    info.eachRow((row, index) => { if (index > 1) values.set(String(row.getCell(1).value), row.getCell(2).value); });
    expect(values.get('Scope')).toBe('Current filtered results (all pages)');
    expect(values.get('Record count')).toBe(1);
    expect(values.get('Dates calculated as of')).toContain('19/10/2026');
    expect(values.get('Exported at')).toContain('MYT (UTC+8)');
    expect(values.get('Filter — Search')).toBe('=Acme');
  });

  it('remains compatible with the importer and identifies existing agreements as duplicates', async () => {
    const records = [record({})];
    const bytes = await buildAgreementWorkbook(records, { scope: 'all', filters: [], exportedAt });
    const preview = await parseWorkbook(Uint8Array.from(bytes).buffer, records);
    expect(preview.sheetName).toBe('NDA');
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({ duplicate: true, errors: [] });
  });

  it('uses the existing overview ordering without mutating database record order', () => {
    const future = record({}, 'future');
    const expired = record({ 'Date of Agreement': '2025-10-18' }, 'expired');
    const resolved = record({ 'Date of Agreement': '2025-10-18', Status: 'Resolved' }, 'resolved');
    const original = [future, resolved, expired];
    expect(sortOverviewRecords(original, '2026-10-19').map(item => item.id)).toEqual(['expired', 'future', 'resolved']);
    expect(original.map(item => item.id)).toEqual(['future', 'resolved', 'expired']);
  });
});
