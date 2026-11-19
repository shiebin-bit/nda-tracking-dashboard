import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { postgresImportTypes } from './import-postgres-to-sqlite.js';

afterEach(() => vi.unstubAllEnvs());

describe('PostgreSQL import calendar dates', () => {
  it.each(['Asia/Kuala_Lumpur', 'UTC', 'America/Los_Angeles'])(
    'keeps a daily reminder key unchanged in %s', (timeZone) => {
      vi.stubEnv('TZ', timeZone);
      const parseDate = postgresImportTypes.getTypeParser(1082, 'text');
      expect(parseDate('2026-11-19')).toBe('2026-11-19');
      expect(parseDate('2026-01-01')).toBe('2026-01-01');
    },
  );

  it('preserves timestamp instants and does not replace the global DATE parser', () => {
    const instant = postgresImportTypes.getTypeParser(1184, 'text')('2026-11-19 09:00:00+08');
    expect(instant.toISOString()).toBe('2026-11-19T01:00:00.000Z');
    expect(pg.types.getTypeParser(1082, 'text')('2026-11-19')).toBeInstanceOf(Date);
  });
});
