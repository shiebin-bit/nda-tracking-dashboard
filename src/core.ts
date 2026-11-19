export type Fields = Record<string, string | number | null>;

export interface NdaRecord {
  id: string;
  /** Stable website display ID. Optional only for old JSON backups and test fixtures. */
  reference?: string;
  fields: Fields;
  version: number;
  source: 'seed' | 'manual' | 'excel' | 'renewal';
  createdAt: string;
  updatedAt: string;
  renewedFromId?: string;
  supplierId?: string | null;
  supplierCode?: string | null;
}

export interface HistoryEvent {
  id: string;
  ndaId?: string;
  type: string;
  timestamp: string;
  actor: string;
  summary: string;
  changes: { field: string; before: unknown; after: unknown }[];
}

export interface Settings {
  recipientEmail: string;
  /** @deprecated Use ccEmails. Kept for register-backup and client compatibility. */
  ccEmail: string;
  ccEmails?: string[];
  senderEmail: string;
  sendTime: string;
  timeZone: 'Asia/Kuala_Lumpur';
  reminderDays: number[];
  automaticRemindersEnabled?: boolean;
}

export interface Snapshot {
  schemaVersion: 1;
  records: NdaRecord[];
  history: HistoryEvent[];
  settings: Settings;
  initializedAt: string;
  revision?: string;
}

export interface StateEnvelope {
  revision: string;
  snapshot: Snapshot;
  archiveId?: string;
}

export interface RestoreArchiveSummary {
  id: string;
  createdAt: string;
  records: number;
  history: number;
}

export const COLUMNS: string[] = [
  'No.',
  'Discloser',
  'Discloser Reg No',
  'Discloser Address',
  'Recipient',
  'Recipient Reg No',
  'Recipient Address',
  'Purpose',
  'Date of Agreement',
  'Duration',
  'UOM',
  'Expired on',
  'Remaining Days',
  'Name of Discloser',
  'Designation of Discloser',
  'Presence of Discloser Name',
  'Presence of Discloser Designation',
  'Email Discloser',
  'Name of Recipient',
  'Designation of Recipient',
  'Email Recipient',
  'Presence of Recipient Name',
  'Presence of Recipient Designation3',
  'PIC',
  'Department',
  'Status',
];

export const DEFAULT_REMINDER_DAYS = [90, 60, 45, 30] as const;

export function normalizeReminderDays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Reminder days must be a non-empty array.');
  }
  const normalized = Array.from(value, (day) => {
    if (!Number.isSafeInteger(day) || day <= 0) {
      throw new Error('Each reminder day must be a positive safe integer.');
    }
    return day as number;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Reminder days must not contain duplicates.');
  }
  return normalized.sort((a, b) => b - a);
}

const FINGERPRINT_COLUMNS = COLUMNS.filter(
  (column) => !['No.', 'Expired on', 'Remaining Days'].includes(column),
);
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createEmptyFields(): Fields {
  return Object.fromEntries(COLUMNS.map((column) => [column, null]));
}

function parseIsoDay(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp;
}

function isoFromUtcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function todayMY(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function dateLabel(value: string | null): string {
  const timestamp = parseIsoDay(value);
  if (timestamp === null) return '—';
  const [year, month, day] = value!.split('-');
  return `${day}/${month}/${year}`;
}

export function derive(
  record: NdaRecord,
  todayISO: string,
  reminderDays: readonly number[] = DEFAULT_REMINDER_DAYS,
): {
  expiryDate: string | null;
  remainingDays: number | null;
  phase: 'overdue' | 'today' | '30' | '45' | '60' | '90' | 'valid' | 'missing';
  eligible: boolean;
  issue: string | null;
} {
  const agreementTimestamp = parseIsoDay(record.fields['Date of Agreement']);
  const duration = record.fields.Duration;
  const unit = record.fields.UOM;
  const todayTimestamp = parseIsoDay(todayISO);

  let issue: string | null = null;
  if (agreementTimestamp === null) issue = 'Date of Agreement is missing or invalid.';
  else if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    issue = 'Duration must be a positive number.';
  } else if (typeof unit !== 'string' || unit.trim().toLowerCase() !== 'years') {
    issue = 'UOM must be years.';
  } else if (todayTimestamp === null) issue = 'Today must be a valid ISO date.';

  if (issue || agreementTimestamp === null || todayTimestamp === null || typeof duration !== 'number') {
    return { expiryDate: null, remainingDays: null, phase: 'missing', eligible: false, issue };
  }

  const durationDays = Math.trunc(duration * 365);
  const expiryTimestamp = agreementTimestamp + durationDays * DAY_MS;
  if (!Number.isFinite(expiryTimestamp) || !Number.isFinite(new Date(expiryTimestamp).getTime())) {
    return {
      expiryDate: null,
      remainingDays: null,
      phase: 'missing',
      eligible: false,
      issue: 'Duration produces an invalid expiry date.',
    };
  }

  const remainingDays = Math.round((expiryTimestamp - todayTimestamp) / DAY_MS);
  const phase =
    remainingDays < 0
      ? 'overdue'
      : remainingDays === 0
        ? 'today'
        : remainingDays <= 30
          ? '30'
          : remainingDays <= 45
            ? '45'
            : remainingDays <= 60
              ? '60'
              : remainingDays <= 90
                ? '90'
                : 'valid';
  const pending = normalizedText(record.fields.Status) === 'pending';
  const eligible = pending && (remainingDays < 0 || reminderDays.includes(remainingDays));
  return {
    expiryDate: isoFromUtcDay(expiryTimestamp),
    remainingDays,
    phase,
    eligible,
    issue: null,
  };
}

export function getCandidates(
  records: NdaRecord[],
  todayISO: string,
  reminderDays: readonly number[] = DEFAULT_REMINDER_DAYS,
): NdaRecord[] {
  return records.filter((record) => derive(record, todayISO, reminderDays).eligible);
}

function valuePresent(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
}

function emailIssues(fields: Fields, mode: 'form' | 'import', errors: string[], warnings: string[]): void {
  for (const field of ['Email Discloser', 'Email Recipient']) {
    const raw = fields[field];
    if (!valuePresent(raw)) continue;
    const value = String(raw).trim();
    if (EMAIL_PATTERN.test(value)) continue;
    const message = `${field} is not a valid email address.`;
    if (mode === 'import') warnings.push(message);
    else errors.push(message);
  }
}

export function validateFields(
  fields: Fields,
  mode: 'form' | 'import' = 'form',
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requireOrWarn = (field: string, formRequired = true): void => {
    if (valuePresent(fields[field])) return;
    const message = `${field} is required.`;
    if (mode === 'form' && formRequired) errors.push(message);
    else warnings.push(message);
  };

  requireOrWarn('Recipient');
  requireOrWarn('Date of Agreement');
  requireOrWarn('PIC');

  const agreement = fields['Date of Agreement'];
  if (valuePresent(agreement) && parseIsoDay(agreement) === null) {
    errors.push('Date of Agreement must be a valid ISO date.');
  }

  const duration = fields.Duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    const message = 'Duration must be a positive number.';
    if (mode === 'import' && !valuePresent(duration)) warnings.push(message);
    else errors.push(message);
  }

  const unit = fields.UOM;
  if (typeof unit !== 'string' || unit.trim().toLowerCase() !== 'years') {
    const message = 'UOM must be years.';
    if (mode === 'import' && !valuePresent(unit)) warnings.push(message);
    else errors.push(message);
  }

  const status = fields.Status;
  if (valuePresent(status)) {
    const normalizedStatus = normalizedText(status);
    if (!['pending', 'resolved'].includes(normalizedStatus)) {
      errors.push('Status must be Pending or Resolved.');
    }
  }

  emailIssues(fields, mode, errors, warnings);
  return { errors, warnings };
}

const UPDATE_ERROR_FIELDS = new Map<string, string>([
  ['Recipient is required.', 'Recipient'],
  ['Date of Agreement is required.', 'Date of Agreement'],
  ['Date of Agreement must be a valid ISO date.', 'Date of Agreement'],
  ['PIC is required.', 'PIC'],
  ['Duration must be a positive number.', 'Duration'],
  ['UOM must be years.', 'UOM'],
  ['Email Discloser is not a valid email address.', 'Email Discloser'],
  ['Email Recipient is not a valid email address.', 'Email Recipient'],
]);

export function validateUpdateFields(
  fields: Fields,
  previous: Fields,
): { errors: string[]; warnings: string[] } {
  const strict = validateFields(fields, 'form');
  const errors: string[] = [];
  const warnings = [...strict.warnings];
  for (const error of strict.errors) {
    const field = UPDATE_ERROR_FIELDS.get(error);
    if (field && Object.is(fields[field], previous[field])) warnings.push(error);
    else errors.push(error);
  }
  return { errors, warnings };
}

function normalizedText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizedValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'invalid-number';
  return normalizedText(value);
}

export function fingerprint(fields: Fields): string {
  return JSON.stringify(FINGERPRINT_COLUMNS.map((column) => normalizedValue(fields[column])));
}

export function isValidIsoDate(value: unknown): value is string {
  return parseIsoDay(value) !== null;
}

export function normalizeStatus(value: unknown): 'Pending' | 'Resolved' | null {
  const normalized = normalizedText(value);
  if (!normalized) return 'Pending';
  if (normalized === 'pending') return 'Pending';
  if (normalized === 'resolved') return 'Resolved';
  return null;
}
