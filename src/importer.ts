import {
  COLUMNS,
  type Fields,
  type NdaRecord,
  createEmptyFields,
  fingerprint,
  validateFields,
} from './core.js';

export interface ImportPreviewRow {
  index: number;
  fields: Fields;
  errors: string[];
  warnings: string[];
  duplicate: boolean;
  suspected: boolean;
}

// Shared cell decoding; contract imports use their own headers and validation.
export { readField as readExcelField, unwrapCellValue as unwrapExcelCell };

const OPTIONAL_HEADERS = new Set(['No.', 'Expired on', 'Remaining Days']);
const DATE_FIELDS = new Set(['Date of Agreement', 'Expired on']);
const NUMBER_FIELDS = new Set(['No.', 'Duration', 'Remaining Days']);

function normalizedHeader(value: unknown): string {
  return String(value ?? '').replace(/^\uFEFF/, '').trim();
}

function normalizedIdentity(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function suspectedKey(fields: Fields): string | null {
  const parts = [
    fields['Discloser Reg No'],
    fields['Recipient Reg No'],
    fields['Date of Agreement'],
  ].map(normalizedIdentity);
  return parts.every(Boolean) ? JSON.stringify(parts) : null;
}

function isValidDay(year: number, month: number, day: number): boolean {
  const value = new Date(Date.UTC(year, month - 1, day));
  return (
    value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day
  );
}

function formatDay(year: number, month: number, day: number): string | null {
  if (!isValidDay(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function serialDate(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const wholeDays = Math.floor(serial);
  if (!date1904 && wholeDays === 60) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const adjustedDays = date1904 ? wholeDays : wholeDays > 60 ? wholeDays - 1 : wholeDays;
  const timestamp = base + adjustedDays * 86_400_000;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) return null;
  return date.toISOString().slice(0, 10);
}

function dateFromValue(value: unknown, date1904: boolean): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return formatDay(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') return serialDate(value, date1904);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return formatDay(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) return formatDay(Number(match[3]), Number(match[2]), Number(match[1]));
  return null;
}

type CellRead = { value: unknown; warning?: string; error?: string };

function unwrapCellValue(value: unknown): CellRead {
  if (value === null || value === undefined || value === '') return { value: null };
  if (typeof value !== 'object' || value instanceof Date) return { value };
  const object = value as Record<string, unknown>;
  if ('formula' in object || 'sharedFormula' in object) {
    if (!Object.prototype.hasOwnProperty.call(object, 'result') || object.result === undefined) {
      return { value: null, warning: 'Formula has no cached result and was not evaluated.' };
    }
    const cached = unwrapCellValue(object.result);
    return {
      ...cached,
      warning: cached.warning ?? 'Used the formula cached result without evaluating the formula.',
    };
  }
  if (Array.isArray(object.richText)) {
    const text = object.richText
      .map((part) => (typeof part === 'object' && part && 'text' in part ? String(part.text) : ''))
      .join('');
    return { value: text };
  }
  if (typeof object.text === 'string') return { value: object.text };
  if ('error' in object) return { value: null, error: `Excel cell error: ${String(object.error)}.` };
  return { value: null, error: 'Unsupported Excel cell value.' };
}

function readField(
  raw: unknown,
  field: string,
  date1904: boolean,
): { value: string | number | null; warning?: string; error?: string } {
  const unwrapped = unwrapCellValue(raw);
  if (unwrapped.error) return { value: null, error: unwrapped.error };
  if (unwrapped.value === null) return { value: null, warning: unwrapped.warning };

  if (DATE_FIELDS.has(field)) {
    const date = dateFromValue(unwrapped.value, date1904);
    if (!date) return { value: null, error: `${field} contains an impossible or unsupported date.` };
    return { value: date, warning: unwrapped.warning };
  }

  if (NUMBER_FIELDS.has(field)) {
    if (typeof unwrapped.value === 'number') {
      if (!Number.isFinite(unwrapped.value)) return { value: null, error: `${field} is not finite.` };
      return { value: unwrapped.value, warning: unwrapped.warning };
    }
    if (typeof unwrapped.value === 'string' && unwrapped.value.trim() !== '') {
      const parsed = Number(unwrapped.value.trim());
      if (Number.isFinite(parsed)) return { value: parsed, warning: unwrapped.warning };
    }
    return { value: String(unwrapped.value).trim(), warning: unwrapped.warning };
  }

  if (typeof unwrapped.value === 'number') {
    return { value: unwrapped.value, warning: unwrapped.warning };
  }
  return { value: String(unwrapped.value).trim(), warning: unwrapped.warning };
}

function rowHasData(row: { cellCount: number; getCell(index: number): { value: unknown } }): boolean {
  for (let index = 1; index <= row.cellCount; index += 1) {
    const value = unwrapCellValue(row.getCell(index).value).value;
    if (value !== null && String(value).trim() !== '') return true;
  }
  return false;
}

export async function parseWorkbook(
  file: ArrayBuffer,
  existing: NdaRecord[],
): Promise<{ rows: ImportPreviewRow[]; sheetName: string }> {
  const excelModule = await import('exceljs');
  const { Workbook } = (excelModule.default ?? excelModule) as typeof import('exceljs');
  const workbook = new Workbook();
  await workbook.xlsx.load(file as Parameters<typeof workbook.xlsx.load>[0]);

  const namedSheet = workbook.getWorksheet('NDA');
  const worksheet =
    namedSheet ??
    workbook.worksheets.find((candidate) => {
      for (let index = 1; index <= candidate.rowCount; index += 1) {
        if (rowHasData(candidate.getRow(index))) return true;
      }
      return false;
    });
  if (!worksheet) throw new Error('The workbook does not contain a non-empty worksheet.');

  let headerRowIndex = 0;
  for (let index = 1; index <= worksheet.rowCount; index += 1) {
    if (rowHasData(worksheet.getRow(index))) {
      headerRowIndex = index;
      break;
    }
  }
  if (!headerRowIndex) throw new Error(`Worksheet ${worksheet.name} is empty.`);

  const headerRow = worksheet.getRow(headerRowIndex);
  const columnByHeader = new Map<string, number>();
  const headerProblems: string[] = [];
  for (let index = 1; index <= headerRow.cellCount; index += 1) {
    const raw = unwrapCellValue(headerRow.getCell(index).value).value;
    const header = normalizedHeader(raw);
    if (!header) continue;
    if (!COLUMNS.includes(header)) {
      headerProblems.push(`Unknown header "${header}".`);
      continue;
    }
    if (columnByHeader.has(header)) {
      headerProblems.push(`Duplicate header "${header}".`);
      continue;
    }
    columnByHeader.set(header, index);
  }
  const missing = COLUMNS.filter((column) => !OPTIONAL_HEADERS.has(column) && !columnByHeader.has(column));
  if (missing.length) headerProblems.push(`Missing required headers: ${missing.join(', ')}.`);
  if (headerProblems.length) throw new Error(headerProblems.join(' '));

  const knownFingerprints = new Set(existing.map((record) => fingerprint(record.fields)));
  const knownSuspects = new Set(existing.map((record) => suspectedKey(record.fields)).filter(Boolean));
  const rows: ImportPreviewRow[] = [];
  const date1904 = Boolean(workbook.properties.date1904);

  for (let rowIndex = headerRowIndex + 1; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    const sourceRow = worksheet.getRow(rowIndex);
    if (!rowHasData(sourceRow)) continue;
    const fields = createEmptyFields();
    const cellErrors: string[] = [];
    const cellWarnings: string[] = [];
    for (const column of COLUMNS) {
      const sheetColumn = columnByHeader.get(column);
      if (!sheetColumn) continue;
      const result = readField(sourceRow.getCell(sheetColumn).value, column, date1904);
      fields[column] = result.value;
      if (result.error) cellErrors.push(result.error);
      if (result.warning) cellWarnings.push(`${column}: ${result.warning}`);
    }

    // Spreadsheet calculations are advisory only; the app always derives these values.
    fields['Expired on'] = null;
    fields['Remaining Days'] = null;
    const validation = validateFields(fields, 'import');
    const rowFingerprint = fingerprint(fields);
    const duplicate = knownFingerprints.has(rowFingerprint);
    const suspectKey = suspectedKey(fields);
    const suspected = !duplicate && suspectKey !== null && knownSuspects.has(suspectKey);
    rows.push({
      index: rowIndex,
      fields,
      errors: [...cellErrors, ...validation.errors],
      warnings: [...cellWarnings, ...validation.warnings],
      duplicate,
      suspected,
    });
    knownFingerprints.add(rowFingerprint);
    if (suspectKey) knownSuspects.add(suspectKey);
  }

  return { rows, sheetName: worksheet.name };
}
