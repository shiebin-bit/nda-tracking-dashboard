import type {Pool} from './db.js';
import {badRequest, conflict} from './errors.js';
import {
  parseDocumentNamingSettings,
  type DocumentNamingSettings,
  type DocumentSettingsResponse,
} from '../src/document-settings.js';

function mapSettings(row: Record<string, unknown> | undefined): DocumentSettingsResponse {
  if (!row) throw new Error('Document settings are not initialized.');
  let raw = row.filename_fields;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); }
    catch { throw new Error('Stored document naming settings are invalid.'); }
  }
  try {
    return {
      revision: Number(row.revision),
      settings: parseDocumentNamingSettings({filenameFields: raw}),
    };
  } catch {
    throw new Error('Stored document naming settings are invalid.');
  }
}

export class DocumentSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<DocumentSettingsResponse> {
    const result = await this.pool.query('SELECT revision,filename_fields FROM document_settings WHERE id=1');
    return mapSettings(result.rows[0]);
  }

  async update(expectedRevision: number, settings: DocumentNamingSettings): Promise<DocumentSettingsResponse> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw badRequest('expectedRevision must be a non-negative integer.');
    }
    let normalized: DocumentNamingSettings;
    try { normalized = parseDocumentNamingSettings(settings); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Document naming settings are invalid.'); }
    const result = await this.pool.query(
      `UPDATE document_settings SET revision=revision+1,filename_fields=$2
       WHERE id=1 AND revision=$1 RETURNING revision,filename_fields`,
      [expectedRevision, normalized.filenameFields],
    );
    if (!result.rows[0]) {
      throw conflict('Document naming settings changed in another window. Reload and try again.', 'revision_conflict');
    }
    return mapSettings(result.rows[0]);
  }
}
