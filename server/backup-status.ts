import { basename, join, resolve } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { BackupStatus } from '../src/backup-types.js';

export const BACKUP_STATUS_FILE = 'status.json';
export const BACKUP_STATUS_STALE_MS = 180_000;
export const AUTOMATIC_BACKUP_PATTERN = /^nda-auto-\d{4}-\d{2}-\d{2}-\d{8}T\d{6}Z\.(?:dump|sqlite)$/;
const MAX_STATUS_BYTES = 65_536;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function textOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 500 && !value.includes('\0'));
}

function base(now: Date): BackupStatus {
  return {
    enabled: true,
    schedule: { localTime: '02:00', timeZone: 'Asia/Kuala_Lumpur', retainSuccessful: 14 },
    state: 'unavailable', lastAttempt: null, lastSuccess: null, nextAttemptAt: null,
    successfulBackupCount: 0, statusUpdatedAt: null, observedAt: now.toISOString(),
  };
}

function normalize(value: unknown, now: Date): BackupStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!['never','running','succeeded','failed'].includes(String(item.state))) return null;
  if (!Number.isSafeInteger(item.successfulBackupCount) || (item.successfulBackupCount as number) < 0) return null;
  if (item.statusUpdatedAt !== null && !iso(item.statusUpdatedAt)) return null;
  if (item.nextAttemptAt !== null && !iso(item.nextAttemptAt)) return null;
  let lastAttempt: BackupStatus['lastAttempt'] = null;
  if (item.lastAttempt !== null) {
    if (!item.lastAttempt || typeof item.lastAttempt !== 'object' || Array.isArray(item.lastAttempt)) return null;
    const attempt = item.lastAttempt as Record<string, unknown>;
    if (!DATE_PATTERN.test(String(attempt.slotDate)) || !['running','succeeded','failed'].includes(String(attempt.status))
      || !iso(attempt.startedAt) || (attempt.completedAt !== null && !iso(attempt.completedAt))
      || !textOrNull(attempt.error) || !textOrNull(attempt.warning)) return null;
    lastAttempt = {
      slotDate: String(attempt.slotDate), status: attempt.status as 'running'|'succeeded'|'failed',
      startedAt: attempt.startedAt, completedAt: attempt.completedAt as string|null,
      error: attempt.error, warning: attempt.warning,
    };
  }
  let lastSuccess: BackupStatus['lastSuccess'] = null;
  if (item.lastSuccess !== null) {
    if (!item.lastSuccess || typeof item.lastSuccess !== 'object' || Array.isArray(item.lastSuccess)) return null;
    const success = item.lastSuccess as Record<string, unknown>;
    const fileName = String(success.fileName);
    if (!DATE_PATTERN.test(String(success.slotDate)) || !iso(success.completedAt)
      || basename(fileName) !== fileName || !AUTOMATIC_BACKUP_PATTERN.test(fileName)
      || !Number.isSafeInteger(success.sizeBytes) || (success.sizeBytes as number) < 1
      || typeof success.sha256 !== 'string' || !SHA_PATTERN.test(success.sha256)) return null;
    lastSuccess = {
      slotDate: String(success.slotDate), completedAt: success.completedAt, fileName,
      sizeBytes: success.sizeBytes as number, sha256: success.sha256,
    };
  }
  const result: BackupStatus = {
    enabled: true,
    schedule: { localTime: '02:00', timeZone: 'Asia/Kuala_Lumpur', retainSuccessful: 14 },
    state: item.state as 'never'|'running'|'succeeded'|'failed',
    lastAttempt, lastSuccess,
    nextAttemptAt: item.nextAttemptAt as string|null,
    successfulBackupCount: item.successfulBackupCount as number,
    statusUpdatedAt: item.statusUpdatedAt as string|null,
    observedAt: now.toISOString(),
  };
  if (!result.statusUpdatedAt || now.getTime() - Date.parse(result.statusUpdatedAt) > BACKUP_STATUS_STALE_MS) {
    result.state = 'unavailable';
  }
  return result;
}

export async function readBackupStatus(directory: string, now = new Date()): Promise<BackupStatus> {
  const fallback = base(now);
  const path = resolve(directory, BACKUP_STATUS_FILE);
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_STATUS_BYTES) return fallback;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const normalized = normalize(parsed, now);
    if (!normalized) return fallback;

    let finalized: string[];
    try {
      finalized = (await readdir(directory)).filter((name) => basename(name) === name && AUTOMATIC_BACKUP_PATTERN.test(name));
    } catch {
      return { ...normalized, state: 'unavailable' };
    }
    normalized.successfulBackupCount = finalized.length;
    if (normalized.lastSuccess) {
      try {
        if (!finalized.includes(normalized.lastSuccess.fileName)) return { ...normalized, state: 'unavailable' };
        const archive = await stat(join(directory, normalized.lastSuccess.fileName));
        if (!archive.isFile() || archive.size !== normalized.lastSuccess.sizeBytes) {
          return { ...normalized, state: 'unavailable' };
        }
      } catch {
        return { ...normalized, state: 'unavailable' };
      }
    } else if (normalized.state === 'succeeded') {
      return { ...normalized, state: 'unavailable' };
    }
    return normalized;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return fallback;
    try {
      const entries = await readdir(directory);
      if (entries.length === 0) return { ...fallback, state: 'never' };
      return fallback;
    } catch {
      return fallback;
    }
  }
}
