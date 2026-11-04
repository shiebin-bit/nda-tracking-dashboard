import { readFile, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const config: PoolConfig = { connectionString, max: 10, idleTimeoutMillis: 30_000 };
  const pool = new Pool(config);
  pool.on('error', (error) => {
    console.error(JSON.stringify({ level: 'error', event: 'postgres_idle_client_error', message: error.message }));
  });
  return pool;
}

export async function migrate(client: Pool | PoolClient): Promise<void> {
  const acquiredFromPool = 'connect' in client;
  const acquired = acquiredFromPool ? await client.connect() : client;
  try {
    await acquired.query("SELECT pg_advisory_lock(hashtext('nda-tracker-schema-migrations'))");
    await acquired.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = resolve(process.cwd(), 'migrations');
    const files = (await readdir(directory))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
      .sort((left, right) => left.localeCompare(right));
    for (const file of files) {
      const name = basename(file);
      const applied = await acquired.query('SELECT 1 FROM schema_migration WHERE name=$1', [name]);
      if (applied.rowCount) continue;
      const sql = await readFile(resolve(directory, file), 'utf8');
      await acquired.query('BEGIN');
      try {
        await acquired.query(sql);
        await acquired.query('INSERT INTO schema_migration(name) VALUES($1)', [name]);
        await acquired.query('COMMIT');
      } catch (error) {
        await acquired.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await acquired.query("SELECT pg_advisory_unlock(hashtext('nda-tracker-schema-migrations'))").catch(() => undefined);
    if (acquiredFromPool) (acquired as PoolClient).release();
  }
}

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
