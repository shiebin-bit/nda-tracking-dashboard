import { describe, expect, it } from 'vitest';
import { Workbook } from 'exceljs';
import seed from '../tests/fixtures/original-excel-rows.json';
import {
  COLUMNS,
  DEFAULT_REMINDER_DAYS,
  type Fields,
  type NdaRecord,
  createEmptyFields,
  dateLabel,
  derive,
  fingerprint,
  getCandidates,
  normalizeReminderDays,
  todayMY,
  validateFields,
  validateUpdateFields,
} from './core';
import { parseWorkbook } from './importer';

function record(fields: Partial<Fields>, id = 'test'): NdaRecord {
  return {
    id,
    fields: { ...createEmptyFields(), Status: 'Pending', ...fields },
    version: 1,
    source: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('core date and reminder rules', () => {
  it('normalizes reminder milestones without mutating the caller', () => {
    const input = [30, 120, 45];
    expect(normalizeReminderDays(input)).toEqual([120, 45, 30]);
    expect(input).toEqual([30, 120, 45]);
    expect(DEFAULT_REMINDER_DAYS).toEqual([90, 60, 45, 30]);
  });

  it.each([
    null,
    [],
    [0],
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1],
    ['30'],
    [30, 30],
    Array(2),
  ])('rejects invalid reminder milestones %#', (value) => {
    expect(() => normalizeReminderDays(value)).toThrow(/Reminder day|reminder day/);
  });

  it('keeps the source column order and seed facts', () => {
    expect(COLUMNS).toHaveLength(26);
    expect(Object.keys(seed[0])).toEqual(COLUMNS);
    expect(seed.filter((row) => row.Status === 'Pending')).toHaveLength(6);
    expect(seed.filter((row) => row.Status === 'Resolved')).toHaveLength(5);
    expect(seed.filter((row) => row['No.'] === 5)).toHaveLength(2);

    const records = seed.map((fields, index) => record(fields as Fields, String(index)));
    records.forEach((item, index) => {
      item.fields.Status = seed[index].Status;
    });
    const derived = records.map((item) => derive(item, '2026-10-18'));
    expect(
      derived.filter((item, index) => item.phase === 'overdue' && records[index].fields.Status === 'Pending'),
    ).toHaveLength(2);
    expect(derived.filter((item) => item.phase === 'missing')).toHaveLength(1);
    expect(getCandidates(records, '2026-10-18')).toHaveLength(2);
  });

  it.each([
    ['2025-04-01', 90, '90', true],
    ['2025-04-02', 91, 'valid', false],
    ['2025-03-03', 61, '90', false],
    ['2025-03-02', 60, '60', true],
    ['2025-03-01', 59, '60', false],
    ['2025-02-16', 46, '60', false],
    ['2025-02-15', 45, '45', true],
    ['2025-02-14', 44, '45', false],
    ['2025-02-01', 31, '45', false],
    ['2025-01-31', 30, '30', true],
    ['2025-01-30', 29, '30', false],
    ['2025-01-02', 1, '30', false],
    ['2025-01-01', 0, 'today', false],
    ['2024-12-31', -1, 'overdue', true],
  ] as const)(
    'applies display ranges and exact reminder thresholds for agreement %s',
    (agreement, days, phase, eligible) => {
      const result = derive(
        record({ 'Date of Agreement': agreement, Duration: 1, UOM: 'years' }),
        '2026-01-01',
      );
      expect(result.remainingDays).toBe(days);
      expect(result.phase).toBe(phase);
      expect(result.eligible).toBe(eligible);
    },
  );

  it('computes expiry for resolved records but never makes them eligible', () => {
    const result = derive(
      record({ 'Date of Agreement': '2024-12-31', Duration: 1, UOM: 'years', Status: 'Resolved' }),
      '2026-01-01',
    );
    expect(result).toMatchObject({ expiryDate: '2025-12-31', remainingDays: -1, eligible: false });
  });

  it('uses custom exact milestones without changing fixed display phases', () => {
    const day75 = record({ 'Date of Agreement': '2025-03-17', Duration: 1, UOM: 'years' }, '75');
    const day60 = record({ 'Date of Agreement': '2025-03-02', Duration: 1, UOM: 'years' }, '60');
    const custom = [75, 15];
    expect(derive(day75, '2026-01-01', custom)).toMatchObject({
      remainingDays: 75,
      phase: '90',
      eligible: true,
    });
    expect(derive(day60, '2026-01-01', custom)).toMatchObject({
      remainingDays: 60,
      phase: '60',
      eligible: false,
    });
    expect(getCandidates([day60, day75], '2026-01-01', custom).map((item) => item.id)).toEqual([
      '75',
    ]);
    expect(derive(day60, '2026-01-01').eligible).toBe(true);
  });

  it('uses Malaysia calendar days across the UTC midnight boundary', () => {
    expect(todayMY(new Date('2026-10-17T15:59:59.999Z'))).toBe('2026-10-17');
    expect(todayMY(new Date('2026-10-17T16:00:00.000Z'))).toBe('2026-10-18');
  });

  it('uses the legacy 365-day rule through leap years', () => {
    const result = derive(
      record({ 'Date of Agreement': '2024-02-29', Duration: 1, UOM: 'years' }),
      '2025-02-28',
    );
    expect(result).toMatchObject({ expiryDate: '2025-02-28', remainingDays: 0, phase: 'today' });
    expect(dateLabel(result.expiryDate)).toBe('28/02/2025');
  });

  it('accepts a positive finite fractional duration using whole calendar days', () => {
    const result = derive(
      record({ 'Date of Agreement': '2026-01-01', Duration: 0.5, UOM: 'years' }),
      '2026-01-01',
    );
    expect(result).toMatchObject({ expiryDate: '2026-07-02', remainingDays: 182, issue: null });
  });

  it('validates forms strictly while retaining incomplete imported rows', () => {
    const incomplete = createEmptyFields();
    const form = validateFields(incomplete, 'form');
    expect(form.errors).toEqual(
      expect.arrayContaining([
        'Recipient is required.',
        'Date of Agreement is required.',
        'PIC is required.',
        'Duration must be a positive number.',
        'UOM must be years.',
      ]),
    );
    const imported = validateFields(incomplete, 'import');
    expect(imported.errors).toEqual([]);
    expect(imported.warnings).toHaveLength(5);

    const placeholder = record({
      Recipient: 'Vendor',
      'Date of Agreement': '2026-01-01',
      Duration: 1,
      UOM: 'years',
      PIC: 'Sam',
      'Email Recipient': 'Email 1',
    }).fields;
    expect(validateFields(placeholder).errors).toContain(
      'Email Recipient is not a valid email address.',
    );
    placeholder['Email Recipient'] = 'typed-invalid';
    expect(validateFields(placeholder).errors).toContain(
      'Email Recipient is not a valid email address.',
    );
  });

  it('allows unchanged legacy defects on update but rejects newly introduced defects', () => {
    const previous = record({
      Recipient: null,
      'Date of Agreement': null,
      Duration: null,
      UOM: null,
      PIC: null,
      'Email Recipient': 'Email 1',
    }).fields;
    const unrelatedEdit = { ...previous, Purpose: 'Updated purpose' };
    const legacyResult = validateUpdateFields(unrelatedEdit, previous);
    expect(legacyResult.errors).toEqual([]);
    expect(legacyResult.warnings).toEqual(
      expect.arrayContaining([
        'Recipient is required.',
        'Date of Agreement is required.',
        'PIC is required.',
        'Duration must be a positive number.',
        'UOM must be years.',
        'Email Recipient is not a valid email address.',
      ]),
    );

    const valid = record({
      Recipient: 'Vendor',
      'Date of Agreement': '2026-01-01',
      Duration: 1,
      UOM: 'years',
      PIC: 'Sam',
      'Email Recipient': 'sam@example.com',
    }).fields;
    expect(validateUpdateFields({ ...valid, Recipient: null }, valid).errors).toContain(
      'Recipient is required.',
    );
    expect(validateUpdateFields({ ...valid, 'Email Recipient': 'Email 2' }, valid).errors).toContain(
      'Email Recipient is not a valid email address.',
    );
  });

  it('fingerprints normalized source values and ignores computed columns and number', () => {
    const first = record({
      'No.': 1,
      Recipient: '  Supplier   A ',
      'Expired on': '2026-01-01',
      'Remaining Days': 4,
    }).fields;
    const second = { ...first, 'No.': 99, Recipient: 'supplier a', 'Expired on': null, 'Remaining Days': null };
    expect(fingerprint(first)).toBe(fingerprint(second));
  });
});

describe('Excel workbook parsing', () => {
  it('accepts optional computed headers, normalizes dates, and flags duplicates and suspects', async () => {
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet('NDA');
    const headers = COLUMNS.filter((column) => !['No.', 'Expired on', 'Remaining Days'].includes(column));
    worksheet.addRow(headers);
    const base = validImportFields();
    worksheet.addRow(headers.map((header) => base[header]));
    worksheet.addRow(headers.map((header) => (header === 'Purpose' ? 'Different purpose' : base[header])));
    worksheet.addRow(headers.map((header) => (header === 'Date of Agreement' ? '31/02/2026' : base[header])));
    const data = await workbook.xlsx.writeBuffer();
    const existing = record({ ...base, 'Date of Agreement': '2026-01-02' }, 'existing');

    const preview = await parseWorkbook(data as ArrayBuffer, [existing]);
    expect(preview.sheetName).toBe('NDA');
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows[0]).toMatchObject({ index: 2, duplicate: true, suspected: false });
    expect(preview.rows[1]).toMatchObject({ duplicate: false, suspected: true });
    expect(preview.rows[2].errors).toContain(
      'Date of Agreement contains an impossible or unsupported date.',
    );
    expect(preview.rows[0].fields['Date of Agreement']).toBe('2026-01-02');
    expect(preview.rows[0].fields['Expired on']).toBeNull();
  });

  it('uses the workbook 1904 epoch and cached formula values without evaluating formulas', async () => {
    const workbook = new Workbook();
    workbook.properties.date1904 = true;
    const worksheet = workbook.addWorksheet('NDA');
    const headers = COLUMNS.filter((column) => !['No.', 'Expired on', 'Remaining Days'].includes(column));
    worksheet.addRow(headers);
    const values = validImportFields();
    const row = worksheet.addRow(headers.map((header) => values[header]));
    row.getCell(headers.indexOf('Date of Agreement') + 1).value = {
      formula: 'DATE(1904,1,2)',
      result: 1,
    };
    const data = await workbook.xlsx.writeBuffer();

    const preview = await parseWorkbook(data as ArrayBuffer, []);
    expect(preview.rows[0].fields['Date of Agreement']).toBe('1904-01-02');
    expect(preview.rows[0].warnings).toContain(
      'Date of Agreement: Used the formula cached result without evaluating the formula.',
    );
  });
});

function validImportFields(): Fields {
  return {
    ...createEmptyFields(),
    Discloser: 'FFM Berhad',
    'Discloser Reg No': 'D-1',
    'Discloser Address': 'Address',
    Recipient: 'Vendor',
    'Recipient Reg No': 'R-1',
    'Recipient Address': 'Address',
    Purpose: 'Evaluation',
    'Date of Agreement': '02/01/2026',
    Duration: 1,
    UOM: 'years',
    'Name of Discloser': 'Dana',
    'Designation of Discloser': 'Manager',
    'Presence of Discloser Name': 'Witness',
    'Presence of Discloser Designation': 'Lead',
    'Email Discloser': 'dana@example.com',
    'Name of Recipient': 'Ravi',
    'Designation of Recipient': 'Director',
    'Email Recipient': 'ravi@example.com',
    'Presence of Recipient Name': 'Witness Two',
    'Presence of Recipient Designation3': 'Lead',
    PIC: 'Aisha',
    Department: 'Projects',
    Status: 'Pending',
  };
}
