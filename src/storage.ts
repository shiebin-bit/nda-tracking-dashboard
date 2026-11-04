import type { Fields, RestoreArchiveSummary, Settings, Snapshot, StateEnvelope } from './core';
import type { RecycleBin } from './recycle-types';

interface ApiErrorPayload {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'request_failed',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Fetcher = typeof fetch;

export class NdaRepository {
  constructor(
    private readonly baseUrl = '/api',
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {}

  private async request(path: string, init?: RequestInit): Promise<Snapshot> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: init?.body
        ? { 'Content-Type': 'application/json', ...init.headers }
        : init?.headers,
    });
    const body = await response.json().catch(() => null) as StateEnvelope | ApiErrorPayload | null;
    if (!response.ok) {
      const payload = body as ApiErrorPayload | null;
      throw new ApiError(
        payload?.error?.message ?? `Request failed with status ${response.status}.`,
        response.status,
        payload?.error?.code,
      );
    }
    if (!body || typeof body !== 'object' || !('revision' in body) || !('snapshot' in body)) {
      throw new ApiError('The server returned an invalid state response.', 502, 'invalid_response');
    }
    const envelope = body as StateEnvelope;
    return { ...envelope.snapshot, revision: envelope.revision };
  }

  async load(): Promise<Snapshot> {
    return this.request('/state');
  }

  async create(fields: Fields): Promise<Snapshot> {
    return this.request('/records', { method: 'POST', body: JSON.stringify({ fields }) });
  }

  async update(id: string, expectedVersion: number, fields: Fields): Promise<Snapshot> {
    return this.request(`/records/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ expectedVersion, fields }),
    });
  }

  async renew(id: string, expectedVersion: number, fields: Fields): Promise<Snapshot> {
    return this.request(`/records/${encodeURIComponent(id)}/renew`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion, fields }),
    });
  }

  async recycle(id: string, expectedVersion: number, requestId: string): Promise<Snapshot> {
    return this.request(`/records/${encodeURIComponent(id)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedVersion, requestId }),
    });
  }

  async restoreRecord(id: string, expectedVersion: number, requestId: string): Promise<Snapshot> {
    return this.request(`/recycle-bin/records/${encodeURIComponent(id)}/restore`, {
      method: 'POST', body: JSON.stringify({ expectedVersion, requestId }),
    });
  }

  async recycleBin(): Promise<RecycleBin> {
    const response = await this.fetcher(`${this.baseUrl}/recycle-bin`, { credentials: 'same-origin' });
    const body = await response.json().catch(() => null) as RecycleBin | ApiErrorPayload | null;
    if (!response.ok) {
      const payload = body as ApiErrorPayload | null;
      throw new ApiError(payload?.error?.message ?? 'The recycle bin could not be loaded.', response.status, payload?.error?.code);
    }
    if (!body || !('records' in body) || !Array.isArray(body.records) || !('contracts' in body) || !Array.isArray(body.contracts)) {
      throw new ApiError('The server returned an invalid recycle bin response.', 502, 'invalid_response');
    }
    return body as RecycleBin;
  }

  async addFollowUp(id: string, expectedVersion: number, text: string, requestId: string): Promise<Snapshot> {
    return this.request(`/records/${encodeURIComponent(id)}/follow-up-notes`, {
      method: 'POST', body: JSON.stringify({ expectedVersion, text, requestId }), signal: AbortSignal.timeout(20000),
    });
  }

  async importRows(rows: Fields[]): Promise<Snapshot> {
    return this.request('/imports', { method: 'POST', body: JSON.stringify({ rows }) });
  }

  async updateSettings(settings: Settings, expectedRevision: string): Promise<Snapshot> {
    return this.request('/settings', {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision, settings }),
    });
  }

  async restore(backup: unknown, expectedRevision: string): Promise<Snapshot> {
    return this.request('/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, snapshot: backup }),
    });
  }

  async restoreArchive(archiveId: string, expectedRevision: string): Promise<Snapshot> {
    return this.request(`/backups/restore/${encodeURIComponent(archiveId)}`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision }),
    });
  }

  async listArchives(): Promise<RestoreArchiveSummary[]> {
    const response = await this.fetcher(`${this.baseUrl}/backups/archives`, { credentials:'same-origin' });
    const body = await response.json().catch(() => null) as {archives?:unknown} | ApiErrorPayload | null;
    if (!response.ok) {
      const payload=body as ApiErrorPayload|null;
      throw new ApiError(payload?.error?.message ?? `Request failed with status ${response.status}.`,response.status,payload?.error?.code);
    }
    if (!body || !('archives' in body) || !Array.isArray(body.archives)) throw new ApiError('The server returned an invalid archive response.',502,'invalid_response');
    return body.archives as RestoreArchiveSummary[];
  }
}
