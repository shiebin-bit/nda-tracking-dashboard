import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BackupStatus } from '../src/backup-types.js';
import { AUTOMATIC_BACKUP_PATTERN, BACKUP_STATUS_FILE, readBackupStatus } from './backup-status.js';

const RETAIN_SUCCESSFUL = 14;
const RETRY_MS = 15 * 60_000;
const HEARTBEAT_MS = 30_000;
const LOCK_STALE_MS = 120_000;
export const REQUIRED_TABLES = [
  'workspace','nda_record','history_event','restore_archive','email_job','email_delivery','email_request','schema_migration',
  'supplier','project','template_family','template_draft',
  'contract','contract_template','contract_version','contract_activity','contract_request',
  'document_job','document_job_item','document_artifact','contract_signed_file',
];
const OWN_PARTIAL_PATTERN = /^\.nda-auto-\d{4}-\d{2}-\d{2}-\d{8}T\d{6}Z\.dump\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial$/;

export interface BackupWorkerConfig { directory: string; heartbeatMs?: number }
export interface ProcessResult { code: number; stdout: string }
export type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>;

function myParts(now: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` };
}

function addDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function slotTime(date: string): string {
  return new Date(`${date}T02:00:00+08:00`).toISOString();
}

export function backupPlan(status: BackupStatus, now: Date): { due: boolean; slotDate: string; nextAttemptAt: string } {
  const current = myParts(now);
  if (status.lastSuccess?.slotDate === current.date) {
    return { due: false, slotDate: addDay(current.date), nextAttemptAt: slotTime(addDay(current.date)) };
  }
  if (status.lastAttempt?.status === 'failed' && status.lastAttempt.completedAt) {
    const retryAt = new Date(Date.parse(status.lastAttempt.completedAt) + RETRY_MS);
    if (retryAt.getTime() > now.getTime()) {
      return { due: false, slotDate: current.date, nextAttemptAt: retryAt.toISOString() };
    }
  }
  if (!status.lastSuccess) return { due: true, slotDate: current.date, nextAttemptAt: now.toISOString() };
  if (current.time >= '02:00') return { due: true, slotDate: current.date, nextAttemptAt: now.toISOString() };
  return { due: false, slotDate: current.date, nextAttemptAt: slotTime(current.date) };
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function atomicStatus(directory: string, status: BackupStatus): Promise<void> {
  const temporary = join(directory, `.status-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(status)}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  await chmod(temporary, 0o644).catch(() => undefined);
  await rename(temporary, join(directory, BACKUP_STATUS_FILE));
}

async function automaticDumps(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter((name) => basename(name) === name && AUTOMATIC_BACKUP_PATTERN.test(name)).sort().reverse();
}

async function verifyArchive(path: string, runner: ProcessRunner): Promise<void> {
  const listed = await runner('pg_restore', ['--list', path]);
  if (listed.code !== 0 || REQUIRED_TABLES.some(table => !new RegExp(`TABLE DATA public ${table}\\b`).test(listed.stdout))) throw new Error('verify');
}

// A finalized file may exist even when the process died before committing status.json.
// Revalidate it before recovering the daily slot; never infer success from a partial.
export async function recoverFinalizedBackups(config: BackupWorkerConfig, previous: BackupStatus, runner: ProcessRunner = runProcess, now = new Date(), forceVerification = false): Promise<BackupStatus> {
  const directory = resolve(config.directory);
  const names = await automaticDumps(directory);
  if (!forceVerification && previous.lastSuccess && names[0] === previous.lastSuccess.fileName && previous.state !== 'unavailable') return previous;
  for (const name of names) {
    try {
      const path = join(directory, name);
      const details = await stat(path);
      if (!details.isFile() || details.size < 1) continue;
      await verifyArchive(path, runner);
      const digest = await sha256(path);
      const slotDate = name.slice(9, 19);
      if (name === previous.lastSuccess?.fileName && (digest !== previous.lastSuccess.sha256 || details.size !== previous.lastSuccess.sizeBytes)) continue;
      // Preserve a later failed attempt and its retry delay if only the heartbeat was stale.
      if (name === previous.lastSuccess?.fileName && digest === previous.lastSuccess.sha256 && details.size === previous.lastSuccess.sizeBytes) {
        return {...statusBase(previous, now), state:previous.lastAttempt?.status ?? 'succeeded', successfulBackupCount:names.length};
      }
      const completedAt = details.mtime.toISOString();
      return {
        ...statusBase(previous, now), state:'succeeded',
        lastAttempt:{slotDate,status:'succeeded',startedAt:completedAt,completedAt,error:null,warning:null},
        lastSuccess:{slotDate,completedAt,fileName:name,sizeBytes:details.size,sha256:digest},
        nextAttemptAt:slotTime(addDay(slotDate)),successfulBackupCount:names.length,
      };
    } catch { /* A damaged file cannot claim a completed daily slot. Try the preceding archive. */ }
  }
  const failed = previous.lastAttempt?.status === 'failed';
  return {...statusBase(previous, now),state:failed?'failed':'never',lastSuccess:null,lastAttempt:failed?previous.lastAttempt:null,successfulBackupCount:0};
}

// Called only while holding the exclusive worker lock. Never remove manuals or finalized files.
export async function cleanupInterruptedPartials(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (basename(name) === name && OWN_PARTIAL_PATTERN.test(name)) await rm(join(directory,name));
  }
}

async function retain(directory: string): Promise<{ count: number; warning: string | null }> {
  const names = await automaticDumps(directory);
  let warning: string | null = null;
  for (const name of names.slice(RETAIN_SUCCESSFUL)) {
    try { await rm(join(directory, name)); }
    catch { warning = 'Backup succeeded, but retention cleanup could not remove every older automatic backup.'; }
  }
  return { count: (await automaticDumps(directory)).length, warning };
}

function statusBase(previous: BackupStatus, now: Date): BackupStatus {
  return {
    enabled: true, schedule: { localTime: '02:00', timeZone: 'Asia/Kuala_Lumpur', retainSuccessful: 14 },
    state: previous.state === 'unavailable' ? (previous.lastSuccess ? 'succeeded' : 'never') : previous.state,
    lastAttempt: previous.lastAttempt, lastSuccess: previous.lastSuccess,
    nextAttemptAt: previous.nextAttemptAt, successfulBackupCount: previous.successfulBackupCount,
    statusUpdatedAt: now.toISOString(), observedAt: now.toISOString(),
  };
}

export async function runBackupAttempt(
  config: BackupWorkerConfig,
  previous: BackupStatus,
  slotDate: string,
  runner: ProcessRunner = runProcess,
  clock: () => Date = () => new Date(),
): Promise<BackupStatus> {
  const directory = resolve(config.directory);
  await mkdir(directory, { recursive: true });
  const started = clock();
  const finalName = `nda-auto-${slotDate}-${stamp(started)}.dump`;
  const finalPath = join(directory, finalName);
  const partialPath = join(directory, `.${finalName}.${randomUUID()}.partial`);
  let stage: 'dump'|'verify'|'store' = 'dump';
  const running: BackupStatus = {
    ...statusBase(previous, started), state: 'running',
    lastAttempt: { slotDate, status: 'running', startedAt: started.toISOString(), completedAt: null, error: null, warning: null },
    nextAttemptAt: null,
  };
  await atomicStatus(directory, running);
  let heartbeatWrites = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatWrites = heartbeatWrites.then(() => atomicStatus(directory, {...running,statusUpdatedAt:clock().toISOString()})).catch(() => undefined);
  }, config.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  const stopHeartbeat = async () => { clearInterval(heartbeat); await heartbeatWrites; };
  try {
    await writeFile(partialPath,'',{mode:0o600,flag:'wx'});
    const dumped = await runner('pg_dump', ['--format=custom', '--no-password', `--file=${partialPath}`]);
    if (dumped.code !== 0) throw new Error('dump');
    stage = 'verify';
    const details = await stat(partialPath);
    if (!details.isFile() || details.size < 1) throw new Error('verify');
    await verifyArchive(partialPath, runner);
    const digest = await sha256(partialPath);
    stage = 'store';
    await chmod(partialPath, 0o600);
    await rename(partialPath, finalPath);
    await stopHeartbeat();
    const completed = clock();
    let cleanup: { count: number; warning: string | null };
    try { cleanup = await retain(directory); }
    catch {
      cleanup = {
        count: Math.max(1, previous.successfulBackupCount + 1),
        warning: 'Backup succeeded, but retention cleanup could not inspect every older automatic backup.',
      };
    }
    const succeeded: BackupStatus = {
      ...statusBase(previous, completed), state: 'succeeded',
      lastAttempt: { slotDate, status: 'succeeded', startedAt: started.toISOString(), completedAt: completed.toISOString(), error: null, warning: cleanup.warning },
      lastSuccess: { slotDate, completedAt: completed.toISOString(), fileName: finalName, sizeBytes: details.size, sha256: digest },
      nextAttemptAt: slotTime(addDay(slotDate)), successfulBackupCount: cleanup.count,
    };
    await atomicStatus(directory, succeeded);
    return succeeded;
  } catch {
    await stopHeartbeat();
    await rm(partialPath, { force: true }).catch(() => undefined);
    const completed = clock();
    const message = stage === 'dump' ? 'Database export failed.' : stage === 'verify' ? 'Backup verification failed.' : 'Backup storage operation failed.';
    const failed: BackupStatus = {
      ...statusBase(previous, completed), state: 'failed',
      lastAttempt: { slotDate, status: 'failed', startedAt: started.toISOString(), completedAt: completed.toISOString(), error: message, warning: null },
      nextAttemptAt: new Date(completed.getTime() + RETRY_MS).toISOString(),
    };
    await atomicStatus(directory, failed);
    return failed;
  }
}

export function runProcess(command: string, args: string[], timeoutMs = command === 'pg_dump' ? 600_000 : 120_000): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { env: process.env, shell: false, windowsHide:true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
      forceKill.unref();
    }, timeoutMs);
    timeout.unref();
    const finish = (code:number, stdout:string) => {clearTimeout(timeout);if(forceKill)clearTimeout(forceKill);resolveResult({code:timedOut?-1:code,stdout});};
    const stdout: Buffer[] = []; let size = 0;
    child.stdout.on('data', (chunk: Buffer) => { if (size < 2_000_000) { stdout.push(chunk); size += chunk.length; } });
    child.stderr.resume();
    child.on('error', () => finish(-1,''));
    child.on('close', (code) => finish(code ?? -1,Buffer.concat(stdout).toString('utf8', 0, 2_000_000)));
  });
}

async function lock(directory: string): Promise<() => Promise<void>> {
  const lockPath = join(directory, '.worker-lock');
  await mkdir(directory, { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath);
      const heartbeat = async () => writeFile(join(lockPath, 'heartbeat'), new Date().toISOString(), { mode: 0o600 });
      await heartbeat();
      const timer = setInterval(() => void heartbeat().catch(() => undefined), HEARTBEAT_MS); timer.unref();
      return async () => { clearInterval(timer); await rm(lockPath, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const heartbeat = new Date((await readFile(join(lockPath, 'heartbeat'), 'utf8')).trim());
        const age = Number.isFinite(heartbeat.getTime()) ? Date.now() - heartbeat.getTime() : Date.now() - (await stat(lockPath)).mtimeMs;
        if (age > LOCK_STALE_MS) {
          const stalePath = `${lockPath}.stale-${randomUUID()}`;
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch {
        try {
          const details = await stat(lockPath);
          if (Date.now() - details.mtimeMs > LOCK_STALE_MS) {
            const stalePath = `${lockPath}.stale-${randomUUID()}`;
            await rename(lockPath, stalePath);
            await rm(stalePath, { recursive: true, force: true });
            continue;
          }
        } catch { /* Another process may be creating or recovering the lock. */ }
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, HEARTBEAT_MS));
    }
  }
}

async function main(): Promise<void> {
  const directory = resolve(process.env.NDA_BACKUP_DIR || '/backups');
  const release = await lock(directory);
  let stopped = false;
  let wake = () => {};
  const stop = () => { stopped = true; wake(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await cleanupInterruptedPartials(directory);
    let firstPass = true;
    while (!stopped) {
      let status = await readBackupStatus(directory);
      const now = new Date();
      status = await recoverFinalizedBackups({directory},status,runProcess,now,firstPass);
      firstPass = false;
      const plan = backupPlan(status, now);
      if (plan.due) status = await runBackupAttempt({ directory }, status, plan.slotDate);
      else {
        status = { ...statusBase(status, now), nextAttemptAt: plan.nextAttemptAt };
        await atomicStatus(directory, status);
      }
      if (!stopped) await new Promise<void>((resolveSleep) => {
        const timer = setTimeout(resolveSleep, HEARTBEAT_MS);
        wake = () => { clearTimeout(timer); resolveSleep(); };
      });
    }
  } finally {
    await release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exitCode = 1);
}
