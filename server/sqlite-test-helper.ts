import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from './db.js';

export async function sqliteTestPool(prefix: string): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const pool = new Pool(join(directory, 'test.sqlite'));
  return {
    pool,
    cleanup: async () => {
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
