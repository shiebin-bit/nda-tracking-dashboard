import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupStatus } from '../src/backup-types';
import { BACKUP_STATUS_FILE, readBackupStatus } from './backup-status';

const roots:string[]=[];
async function directory(){const path=await mkdtemp(join(tmpdir(),'nda-status-'));roots.push(path);return path;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})))});

function valid(now:string):BackupStatus{return {
  enabled:true,schedule:{localTime:'02:00',timeZone:'Asia/Kuala_Lumpur',retainSuccessful:14},state:'succeeded',
  lastAttempt:{slotDate:'2026-10-20',status:'succeeded',startedAt:'2026-10-19T18:00:00.000Z',completedAt:'2026-10-19T18:00:02.000Z',error:null,warning:null},
  lastSuccess:{slotDate:'2026-10-20',completedAt:'2026-10-19T18:00:02.000Z',fileName:'nda-auto-2026-10-20-20261019T180000Z.dump',sizeBytes:42,sha256:'a'.repeat(64)},
  nextAttemptAt:'2026-10-20T18:00:00.000Z',successfulBackupCount:1,statusUpdatedAt:now,observedAt:now,
};}

describe('automatic backup status reader',()=>{
  it('reports never for a readable empty directory',async()=>{
    const root=await directory();
    await expect(readBackupStatus(root,new Date('2026-10-20T00:00:00Z'))).resolves.toMatchObject({state:'never',lastAttempt:null,lastSuccess:null,observedAt:'2026-10-20T00:00:00.000Z'});
  });
  it('returns a fresh bounded status and hides stale green state',async()=>{
    const root=await directory(); const now='2026-10-20T00:00:00.000Z';
    await writeFile(join(root,BACKUP_STATUS_FILE),JSON.stringify(valid(now)));
    await writeFile(join(root,valid(now).lastSuccess!.fileName),Buffer.alloc(42));
    await expect(readBackupStatus(root,new Date(now))).resolves.toMatchObject({state:'succeeded',successfulBackupCount:1});
    await expect(readBackupStatus(root,new Date('2026-10-20T00:03:01.000Z'))).resolves.toMatchObject({state:'unavailable',lastSuccess:{fileName:'nda-auto-2026-10-20-20261019T180000Z.dump'}});
  });
  it('does not report a good backup when its file is missing or has changed size',async()=>{
    const root=await directory(); const now='2026-10-20T00:00:00.000Z';
    await writeFile(join(root,BACKUP_STATUS_FILE),JSON.stringify(valid(now)));
    await expect(readBackupStatus(root,new Date(now))).resolves.toMatchObject({state:'unavailable',successfulBackupCount:0});
    await writeFile(join(root,valid(now).lastSuccess!.fileName),'truncated');
    await expect(readBackupStatus(root,new Date(now))).resolves.toMatchObject({state:'unavailable'});
  });
  it('reports unavailable for malformed metadata or a path-bearing filename',async()=>{
    const root=await directory();
    await writeFile(join(root,BACKUP_STATUS_FILE),'{bad json');
    await expect(readBackupStatus(root)).resolves.toMatchObject({state:'unavailable'});
    const status=valid(new Date().toISOString()); status.lastSuccess!.fileName='../manual.dump';
    await writeFile(join(root,BACKUP_STATUS_FILE),JSON.stringify(status));
    await expect(readBackupStatus(root)).resolves.toMatchObject({state:'unavailable',lastSuccess:null});
  });
});
