export const DOCUMENT_FILENAME_FIELDS = ['type', 'supplier', 'project', 'date'] as const;

export type DocumentFilenameField = typeof DOCUMENT_FILENAME_FIELDS[number];

export interface DocumentNamingSettings {
  filenameFields: DocumentFilenameField[];
}

export interface DocumentSettingsResponse {
  revision: number;
  settings: DocumentNamingSettings;
}

export interface UpdateDocumentSettingsRequest {
  expectedRevision: number;
  settings: DocumentNamingSettings;
}

export const DEFAULT_DOCUMENT_NAMING_SETTINGS: DocumentNamingSettings = {
  filenameFields: [...DOCUMENT_FILENAME_FIELDS],
};

export interface DocumentFilenameParts {
  type: string;
  supplier: string;
  project: string;
  date: string;
  reference: string;
  ordinal: number;
  extension: 'pdf' | 'docx';
}

const FIELD_SET = new Set<string>(DOCUMENT_FILENAME_FIELDS);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_WINDOWS_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;
const encoder = new TextEncoder();

function truncateUtf8(value: string, maximumBytes: number): string {
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const width = encoder.encode(character).byteLength;
    if (bytes + width > maximumBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

/** Sanitize one filename component while retaining useful Unicode text. */
export function sanitizeDocumentFilenamePart(value: string, maximumBytes = 72): string {
  let safe = value.normalize('NFC')
    .replace(INVALID_WINDOWS_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  safe = truncateUtf8(safe, maximumBytes).replace(/[. ]+$/g, '');
  return safe || 'Untitled';
}

export function parseDocumentNamingSettings(value: unknown): DocumentNamingSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Document naming settings must be an object.');
  }
  const fields = (value as {filenameFields?: unknown}).filenameFields;
  if (!Array.isArray(fields)) throw new Error('filenameFields must be an array.');
  const seen = new Set<string>();
  for (const field of fields) {
    if (typeof field !== 'string' || !FIELD_SET.has(field)) {
      throw new Error('filenameFields contains an unsupported field.');
    }
    if (seen.has(field)) throw new Error('filenameFields must not contain duplicates.');
    seen.add(field);
  }
  return {filenameFields: [...fields] as DocumentFilenameField[]};
}

/**
 * Optional fields are ordered by the user's settings. The immutable document
 * reference and generation ordinal always form the suffix.
 */
export function formatDocumentFilename(parts: DocumentFilenameParts, fields: DocumentFilenameField[]): string {
  const values: Record<DocumentFilenameField, string> = {
    type: parts.type.toLocaleUpperCase('en'),
    supplier: parts.supplier,
    project: parts.project,
    date: parts.date,
  };
  const prefix = fields
    .map((field) => values[field]?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => sanitizeDocumentFilenamePart(value));
  const suffix = `${sanitizeDocumentFilenamePart(parts.reference, 80)}_v${Math.max(1, Math.trunc(parts.ordinal))}.${parts.extension}`;
  const separator = '_';
  const suffixBytes = encoder.encode(suffix).byteLength;
  const availablePrefixBytes = Math.max(0, 240 - suffixBytes - (prefix.length ? encoder.encode(separator).byteLength : 0));
  let safePrefix = truncateUtf8(prefix.join(separator), availablePrefixBytes).replace(/[. ]+$/g, '');
  if (safePrefix && WINDOWS_RESERVED.test(safePrefix)) safePrefix = `_${safePrefix}`;
  return safePrefix ? `${safePrefix}${separator}${suffix}` : suffix;
}
