import { COLUMNS, dateLabel, derive, todayMY, type NdaRecord } from './core';

export type ExportScope = 'filtered' | 'all';
export interface ExportFilter { label: string; value: string }
export interface AgreementExportOptions {
  scope: ExportScope;
  filters: ExportFilter[];
  exportedAt: Date;
}

export function sortOverviewRecords(records: NdaRecord[], today: string): NdaRecord[] {
  const score = (record: NdaRecord) =>
    (record.fields.Status === 'Resolved' ? 100000 : 0) + (derive(record, today).remainingDays ?? 90000);
  return [...records].sort((left, right) => score(left) - score(right));
}

function excelDate(value: unknown): Date | null {
  const day = typeof value === 'string' ? value.trim() : '';
  return day && dateLabel(day) !== '—' ? new Date(`${day}T00:00:00.000Z`) : null;
}

export async function buildAgreementWorkbook(records: NdaRecord[], options: AgreementExportOptions): Promise<Uint8Array> {
  const excelModule = await import('exceljs');
  const { Workbook } = (excelModule.default ?? excelModule) as typeof import('exceljs');
  const workbook = new Workbook();
  workbook.creator = 'NDA Tracker';
  workbook.created = options.exportedAt;
  const today = todayMY(options.exportedAt);
  const sheet = workbook.addWorksheet('NDA');
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.columns = COLUMNS.map(header => ({
    header,
    key: header,
    width: header === 'No.' ? 9 : header.includes('Address') || header === 'Purpose' ? 40
      : header.includes('Email') ? 32 : header === 'Duration' || header === 'UOM' ? 12
      : ['Date of Agreement', 'Expired on', 'Remaining Days'].includes(header) ? 19 : 27,
  }));
  const header = sheet.getRow(1);
  header.height = 43;
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14745F' } };
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  for (const record of records) {
    const calculated = derive(record, today);
    const row = sheet.addRow(COLUMNS.map(column => {
      if (column === 'Date of Agreement') return excelDate(record.fields[column]);
      if (column === 'Expired on') return excelDate(calculated.expiryDate);
      if (column === 'Remaining Days') return calculated.remainingDays;
      return record.fields[column] ?? null;
    }));
    row.eachCell(cell => {
      cell.font = { name: 'Calibri', size: 11 };
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  }
  for (const column of ['Date of Agreement', 'Expired on']) sheet.getColumn(column).numFmt = 'dd/mm/yyyy';
  for (const column of ['No.', 'Remaining Days']) sheet.getColumn(column).numFmt = '0';
  sheet.getColumn('Duration').numFmt = '0.##';
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: records.length + 1, column: COLUMNS.length } };

  const info = workbook.addWorksheet('Export info');
  info.columns = [{ width: 25 }, { width: 85 }];
  info.mergeCells('A1:B1');
  info.getCell('A1').value = 'NDA Tracker — Export information';
  info.getCell('A1').font = { name: 'Calibri', size: 15, bold: true, color: { argb: 'FF14745F' } };
  info.getRow(1).height = 30;
  const timestamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'medium',
  }).format(options.exportedAt);
  const details: [string, string | number][] = [
    ['Exported at', `${timestamp} MYT (UTC+8)`],
    ['Scope', options.scope === 'all' ? 'All agreements' : 'Current filtered results (all pages)'],
    ['Record count', records.length],
    ['Dates calculated as of', `${dateLabel(today)} — Asia/Kuala_Lumpur`],
    ['Calculated values', 'Expiry dates and remaining days are fixed values as of the export date, not Excel formulas.'],
  ];
  if (options.scope === 'filtered' && options.filters.length) {
    details.push(...options.filters.map(filter => [`Filter — ${filter.label}`, filter.value] as [string, string]));
  } else details.push(['Filters', 'None']);
  details.forEach(values => {
    const row = info.addRow(values);
    row.height = String(values[1]).length > 80 ? 34 : 24;
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(1).font = { name: 'Calibri', size: 11, bold: true };
    row.getCell(2).font = { name: 'Calibri', size: 11 };
  });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export function downloadAgreementWorkbook(bytes: Uint8Array, scope: ExportScope, exportedAt: Date): void {
  const blob = new Blob([Uint8Array.from(bytes).buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `nda-tracking-${scope}-${todayMY(exportedAt)}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
