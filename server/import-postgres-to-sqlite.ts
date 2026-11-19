import pg from 'pg';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPool, type Pool, type PoolClient, withTransaction } from './db.js';
import { verifySqliteBackup } from './sqlite-backup.js';

const TABLES = [
  'supplier', 'project', 'nda_record', 'history_event', 'restore_archive',
  'email_delivery', 'email_request', 'email_job',
  'template_family', 'contract_template', 'template_draft',
  'contract', 'contract_activity', 'document_job', 'document_job_item',
  'document_artifact', 'contract_version', 'contract_signed_file', 'contract_request',
] as const;

type SourceClient = pg.PoolClient;

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

async function destinationColumns(client: PoolClient, table: string): Promise<string[]> {
  const result = await client.query<{ name: string }>(`PRAGMA table_info(${identifier(table)})`);
  return result.rows.map((row) => row.name);
}

async function sourceColumns(client: SourceClient, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`, [table],
  );
  return result.rows.map((row) => row.column_name);
}

function normalizedValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) return JSON.stringify(value);
  return value;
}

function pausedSettings(value: unknown): string {
  const settings = typeof value === 'string' ? JSON.parse(value) : value;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Source workspace settings are invalid.');
  return JSON.stringify({ ...settings, automaticRemindersEnabled: false });
}

async function assertEmptyDestination(client: PoolClient): Promise<void> {
  for (const table of TABLES) {
    const count = await client.query<{ count: number }>(`SELECT count(*) count FROM ${identifier(table)}`);
    if (Number(count.rows[0].count) !== 0) throw new Error(`SQLite destination is not empty (${table}).`);
  }
}

async function copyTable(source: SourceClient, destination: PoolClient, table: string): Promise<number> {
  const [sourceNames, destinationNames] = await Promise.all([
    sourceColumns(source, table), destinationColumns(destination, table),
  ]);
  if (!sourceNames.length) return 0;
  const destinationSet = new Set(destinationNames);
  const columns = sourceNames.filter((name) => destinationSet.has(name));
  const missing = sourceNames.filter((name) => !destinationSet.has(name));
  if (missing.length) throw new Error(`SQLite schema is missing ${table} columns: ${missing.join(', ')}.`);
  const result = await source.query(`SELECT * FROM ${identifier(table)}`);
  if (!result.rows.length) return 0;
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(',');
  const insert = `INSERT INTO ${identifier(table)}(${columns.map(identifier).join(',')}) VALUES(${placeholders})`;
  for (const row of result.rows) {
    await destination.query(insert, columns.map((name) => normalizedValue(row[name])));
  }
  // Read every column back inside the transaction, including the binary files.
  // Type affinity changes integer/boolean representations, but not their values.
  const info=await destination.query<{name:string;type:string}>(`PRAGMA table_info(${identifier(table)})`);
  const types=new Map(info.rows.map(row=>[row.name,row.type]));
  const canonical=(value:unknown,type:string):string=>{
    if(value===null||value===undefined)return 'null';
    if(Buffer.isBuffer(value)||value instanceof Uint8Array)return `blob:${createHash('sha256').update(value).digest('hex')}`;
    if(value instanceof Date)return value.toISOString();
    if(type==='INTEGER')return String(Number(value));
    const sorted=(item:any):any=>Array.isArray(item)?item.map(sorted):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,sorted(item[key])])):item;
    if(typeof value==='object')return JSON.stringify(sorted(value));
    if(typeof value==='string'&&/^[\[{]/.test(value)){try{return JSON.stringify(sorted(JSON.parse(value)));}catch{/* Plain text remains plain text. */}}
    return String(value);
  };
  const saved=(await destination.query<Record<string,unknown>>(`SELECT * FROM ${identifier(table)}`)).rows;
  const fingerprint=(row:Record<string,unknown>)=>JSON.stringify(columns.map(name=>[name,canonical(row[name],types.get(name)??'')]));
  const expected=result.rows.map(fingerprint).sort();const actual=saved.map(fingerprint).sort();
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error(`Imported ${table} values did not match the source snapshot.`);
  return result.rows.length;
}

async function tableDigest(client: Pick<PoolClient, 'query'>, table: string): Promise<string> {
  const result = await client.query<Record<string, unknown>>(`SELECT * FROM ${identifier(table)} ORDER BY rowid`);
  const hash = createHash('sha256');
  for (const row of result.rows) {
    for (const key of Object.keys(row).sort()) {
      const value = row[key];
      hash.update(key).update('\0');
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) hash.update(value);
      else hash.update(typeof value === 'string' ? value : JSON.stringify(value));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

export interface PostgresImportReport {
  importedAt: string;
  counts: Record<string, number>;
  destinationDigests: Record<string, string>;
  remindersPaused: true;
}

/** Imports a read-only PostgreSQL snapshot into a newly initialized SQLite file. */
export async function importPostgresToSqlite(destination: Pool, connectionString: string): Promise<PostgresImportReport> {
  if (!connectionString.trim()) throw new Error('A PostgreSQL connection string is required.');
  const sourcePool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis:10_000 });
  const source = await sourcePool.connect().catch(async error=>{await sourcePool.end();throw error;});
  try {
    await source.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const counts: Record<string, number> = {};
    await withTransaction(destination, async (client) => {
      await client.query('PRAGMA defer_foreign_keys=ON');
      await assertEmptyDestination(client);
      const workspace = await source.query('SELECT * FROM workspace WHERE id=1');
      if (!workspace.rows[0]) throw new Error('Source PostgreSQL workspace is not initialized.');
      const row = workspace.rows[0];
      await client.query(
        `UPDATE workspace SET revision=$1,settings=$2,initialized_at=$3,next_number=$4 WHERE id=1`,
        [row.revision, pausedSettings(row.settings), normalizedValue(row.initialized_at), row.next_number],
      );
      for (const table of TABLES) counts[table] = await copyTable(source, client, table);
      await client.query(`UPDATE reference_counter SET next_value=COALESCE((
        SELECT max(CAST(substr(reference_code,5) AS INTEGER))+1 FROM nda_record WHERE reference_code GLOB 'AGR-[0-9]*'
      ),1) WHERE kind='agreement'`);
      await client.query(`UPDATE reference_counter SET next_value=COALESCE((
        SELECT max(CAST(substr(reference_code,5) AS INTEGER))+1 FROM contract WHERE reference_code GLOB 'DOC-[0-9]*'
      ),1) WHERE kind='document'`);
      for(const [kind,sequence] of [['agreement','nda_record_reference_seq'],['document','contract_reference_seq']]){
        const state=await source.query(`SELECT last_value,is_called FROM ${identifier(sequence)}`);
        const next=Number(state.rows[0].last_value)+(state.rows[0].is_called?1:0);
        if(!Number.isSafeInteger(next))throw new Error('The display reference counter exceeds the supported range.');
        await client.query('UPDATE reference_counter SET next_value=max(next_value,$1) WHERE kind=$2',[next,kind]);
      }
      if((await client.query('PRAGMA foreign_key_check')).rows.length)throw new Error('Imported data has broken document references.');
    });
    await source.query('COMMIT');
    const destinationDigests: Record<string, string> = {};
    for (const table of TABLES) destinationDigests[table] = await tableDigest(destination, table);
    return { importedAt: new Date().toISOString(), counts, destinationDigests, remindersPaused: true };
  } catch (error) {
    await source.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    source.release();
    await sourcePool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.includes('--help')){
    console.log('Read-only PostgreSQL → new SQLite workspace\nSet NDA_IMPORT_DATABASE_URL and NDA_SQLITE_PATH, then run:\nnode dist/server/server/import-postgres-to-sqlite.js\nThe target must not exist. Reminders are paused. Keep your PostgreSQL backup.');
    process.exit(0);
  }
  const connectionString = process.env.NDA_IMPORT_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  if(!connectionString||!process.env.NDA_SQLITE_PATH)throw new Error('NDA_IMPORT_DATABASE_URL and NDA_SQLITE_PATH are required.');
  const target=resolve(process.env.NDA_SQLITE_PATH);
  const lock=await open(target,'wx');await lock.close();
  const staged=`${target}.${randomUUID()}.importing`;
  const destination = createPool(staged);
  let complete=false;
  try {
    const report=await importPostgresToSqlite(destination,connectionString);
    await destination.backupTo(target);await verifySqliteBackup(target);complete=true;
    console.log(JSON.stringify(report,null,2));
  } finally {
    await destination.end();
    for(const suffix of ['','-wal','-shm'])await rm(`${staged}${suffix}`,{force:true});
    if(!complete)await rm(target,{force:true});
  }
}
