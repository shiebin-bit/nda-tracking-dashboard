import {
  COLUMNS,
  DEFAULT_REMINDER_DAYS,
  type Fields,
  type HistoryEvent,
  type NdaRecord,
  type Settings,
  type Snapshot,
  createEmptyFields,
  isValidIsoDate,
  normalizeReminderDays,
  normalizeStatus,
  validateFields,
  validateUpdateFields,
} from '../src/core.js';
import { badRequest } from './errors.js';

export const DEFAULT_SETTINGS: Settings = {
  recipientEmail: '',
  ccEmail: '',
  senderEmail: '',
  sendTime: '09:00',
  timeZone: 'Asia/Kuala_Lumpur',
  reminderDays: [...DEFAULT_REMINDER_DAYS],
  automaticRemindersEnabled: false,
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertFieldsShape(value: unknown, requireEveryColumn = false): asserts value is Fields {
  if (!isPlainObject(value)) throw badRequest('Fields must be an object.');
  for (const key of Object.keys(value)) {
    if (!COLUMNS.includes(key)) throw badRequest(`Unknown NDA field: ${key}.`);
    const fieldValue = value[key];
    if (fieldValue !== null && typeof fieldValue !== 'string' && typeof fieldValue !== 'number') {
      throw badRequest(`${key} must be text, a number, or null.`);
    }
    if (typeof fieldValue === 'number' && !Number.isFinite(fieldValue)) {
      throw badRequest(`${key} must be a finite number.`);
    }
  }
  if (requireEveryColumn) {
    for (const column of COLUMNS) {
      if (!Object.prototype.hasOwnProperty.call(value, column)) {
        throw badRequest(`Restored record is missing ${column}.`);
      }
    }
  }
}

export function canonicalFields(input: Fields, base: Fields = createEmptyFields()): Fields {
  assertFieldsShape(input);
  const fields: Fields = { ...base };
  for (const column of COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(input, column)) fields[column] = input[column];
  }
  fields['Expired on'] = null;
  fields['Remaining Days'] = null;
  const status = normalizeStatus(fields.Status);
  if (status) fields.Status = status;
  return fields;
}

export function validateNewFields(fields: Fields, mode: 'form' | 'import'): void {
  const result = validateFields(fields, mode);
  if (result.errors.length) throw badRequest(result.errors.join(' '), 'validation_failed');
}

export function validateUpdatedFields(fields: Fields, previous: Fields): void {
  const result = validateUpdateFields(fields, previous);
  if (result.errors.length) throw badRequest(result.errors.join(' '), 'validation_failed');
}

export function normalizeSettings(value: unknown, allowLegacyMissing = false): Settings {
  if (!isPlainObject(value)) throw badRequest('Settings must be an object.');
  for (const key of ['recipientEmail', 'ccEmail', 'senderEmail', 'sendTime', 'timeZone']) {
    if (typeof value[key] !== 'string') throw badRequest(`Setting ${key} must be text.`);
  }
  if (value.timeZone !== 'Asia/Kuala_Lumpur') throw badRequest('Unsupported time zone.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.sendTime as string)) {
    throw badRequest('Send time must use HH:mm in 24-hour time.');
  }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const key of ['recipientEmail', 'ccEmail', 'senderEmail'] as const) {
    const email = (value[key] as string).trim();
    if (email && !emailPattern.test(email)) throw badRequest(`${key} must be a valid email address.`);
  }
  const hasReminderDays = Object.prototype.hasOwnProperty.call(value, 'reminderDays');
  if (!hasReminderDays && !allowLegacyMissing) throw badRequest('Setting reminderDays is required.');
  let reminderDays: number[];
  try {
    reminderDays = hasReminderDays
      ? normalizeReminderDays(value.reminderDays)
      : [...DEFAULT_REMINDER_DAYS];
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Reminder days are invalid.');
  }
  const automaticRemindersEnabled = value.automaticRemindersEnabled ?? false;
  if (typeof automaticRemindersEnabled !== 'boolean') {
    throw badRequest('Setting automaticRemindersEnabled must be true or false.');
  }
  return {
    recipientEmail: (value.recipientEmail as string).trim(),
    ccEmail: (value.ccEmail as string).trim(),
    senderEmail: (value.senderEmail as string).trim(),
    sendTime: value.sendTime as string,
    timeZone: 'Asia/Kuala_Lumpur',
    reminderDays,
    automaticRemindersEnabled,
  };
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw badRequest(`${label} must be a valid timestamp.`);
  }
}

function normalizeRecord(value: unknown, ids: Set<string>): NdaRecord {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !value.id.trim()) {
    throw badRequest('Every restored record must have an ID.');
  }
  if (ids.has(value.id)) throw badRequest(`Duplicate record ID: ${value.id}.`);
  ids.add(value.id);
  if (!Number.isInteger(value.version) || (value.version as number) < 1) {
    throw badRequest(`Record ${value.id} has an invalid version.`);
  }
  if (!['seed', 'manual', 'excel', 'renewal'].includes(String(value.source))) {
    throw badRequest(`Record ${value.id} has an invalid source.`);
  }
  if (value.renewedFromId !== undefined && typeof value.renewedFromId !== 'string') {
    throw badRequest(`Record ${value.id} has an invalid renewal link.`);
  }
  assertTimestamp(value.createdAt, 'Record createdAt');
  assertTimestamp(value.updatedAt, 'Record updatedAt');
  assertFieldsShape(value.fields, true);
  for (const field of ['No.', 'Duration', 'Remaining Days']) {
    const fieldValue = value.fields[field];
    if (fieldValue !== null && typeof fieldValue !== 'number') {
      throw badRequest(`${field} must be numeric or null.`);
    }
  }
  for (const field of ['Date of Agreement', 'Expired on']) {
    const fieldValue = value.fields[field];
    if (fieldValue !== null && !isValidIsoDate(fieldValue)) {
      throw badRequest(`${field} must be a valid ISO date or null.`);
    }
  }
  const status = normalizeStatus(value.fields.Status);
  if (!status || (value.fields.Status !== 'Pending' && value.fields.Status !== 'Resolved')) {
    throw badRequest(`Record ${value.id} has an invalid status.`);
  }
  return {
    id: value.id,
    fields: structuredClone(value.fields),
    version: value.version as number,
    source: value.source as NdaRecord['source'],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.renewedFromId ? { renewedFromId: value.renewedFromId } : {}),
  };
}

function normalizeHistory(value: unknown): HistoryEvent[] {
  if (!Array.isArray(value)) throw badRequest('History must be an array.');
  const ids = new Set<string>();
  return value.map((item): HistoryEvent => {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id.trim()) {
      throw badRequest('Every history event must have an ID.');
    }
    if (ids.has(item.id)) throw badRequest(`Duplicate history ID: ${item.id}.`);
    ids.add(item.id);
    if (item.ndaId !== undefined && typeof item.ndaId !== 'string') {
      throw badRequest('History NDA IDs must be text.');
    }
    for (const key of ['type', 'actor', 'summary']) {
      if (typeof item[key] !== 'string') throw badRequest(`History ${key} must be text.`);
    }
    assertTimestamp(item.timestamp, 'History timestamp');
    if (!Array.isArray(item.changes)) throw badRequest('History changes must be an array.');
    const changes = item.changes.map((change) => {
      if (!isPlainObject(change) || typeof change.field !== 'string') {
        throw badRequest('Every history change must name a field.');
      }
      if (!Object.prototype.hasOwnProperty.call(change, 'before') || !Object.prototype.hasOwnProperty.call(change, 'after')) {
        throw badRequest('Every history change must include before and after values.');
      }
      return { field: change.field, before: structuredClone(change.before), after: structuredClone(change.after) };
    });
    const event = {
      id: item.id,
      ...(item.ndaId ? { ndaId: item.ndaId } : {}),
      type: item.type as string,
      timestamp: item.timestamp,
      actor: item.actor as string,
      summary: item.summary as string,
      changes,
    };
    if (event.type === 'follow-up-added') {
      const change = event.changes[0];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.id)
        || !event.ndaId || event.actor !== 'Local user' || event.summary !== 'Added follow-up note.'
        || event.changes.length !== 1 || change?.field !== 'Follow-up note' || change.before !== null
        || typeof change?.after !== 'string' || change.after.includes('\0')
        || change.after.trim() !== change.after || change.after.length < 1 || change.after.length > 2_000) {
        throw badRequest(`History event ${event.id} is not a valid follow-up note.`);
      }
    }
    return event;
  });
}

export function normalizeSnapshot(value: unknown): Snapshot {
  if (!isPlainObject(value) || value.schemaVersion !== 1) {
    throw badRequest('Backup schemaVersion must be 1.');
  }
  if (!Array.isArray(value.records)) throw badRequest('Backup records must be an array.');
  const ids = new Set<string>();
  const records = value.records.map((record) => normalizeRecord(record, ids));
  const history = normalizeHistory(value.history);
  for (const record of records) {
    if (record.renewedFromId && !ids.has(record.renewedFromId)) {
      throw badRequest(`Record ${record.id} links to a missing renewed-from record.`);
    }
  }
  for (const event of history) {
    if (event.ndaId && !ids.has(event.ndaId)) {
      throw badRequest(`History event ${event.id} links to a missing NDA record.`);
    }
  }
  const settings = normalizeSettings(value.settings, true);
  assertTimestamp(value.initializedAt, 'initializedAt');
  return {
    schemaVersion: 1,
    records,
    history,
    settings,
    initializedAt: value.initializedAt,
  };
}

export function changesBetween(before: Fields | null, after: Fields | null): HistoryEvent['changes'] {
  return COLUMNS.flatMap((field) => {
    const oldValue = before?.[field] ?? null;
    const newValue = after?.[field] ?? null;
    return Object.is(oldValue, newValue) ? [] : [{ field, before: oldValue, after: newValue }];
  });
}

export function settingsChanges(before: Settings, after: Settings): HistoryEvent['changes'] {
  return (Object.keys(after) as (keyof Settings)[]).flatMap((field) => {
    const previous = before[field];
    const next = after[field];
    const equal = Array.isArray(previous) && Array.isArray(next)
      ? previous.length === next.length && previous.every((item, index) => item === next[index])
      : previous === next;
    return equal ? [] : [{ field, before: structuredClone(previous), after: structuredClone(next) }];
  });
}

export function nextNumber(records: NdaRecord[]): number {
  return records.reduce((maximum, record) => {
    const value = record.fields['No.'];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(maximum, value) : maximum;
  }, 0) + 1;
}

export function assertExpectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw badRequest('expectedVersion must be a positive safe integer.');
  }
  return value as number;
}

export function assertRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw badRequest('expectedRevision must be a non-negative integer string.');
  }
  if (BigInt(value) > 9_223_372_036_854_775_807n) {
    throw badRequest('expectedRevision exceeds the supported range.');
  }
  return value;
}
