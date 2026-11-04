import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupStatus } from '../src/backup-types';
import { AUTOMATIC_BACKUP_PATTERN, BACKUP_STATUS_FILE, readBackupStatus } from './backup-status';
import { REQUIRED_TABLES, backupPlan, cleanupInterruptedPartials, recoverFinalizedBackups, runBackupAttempt, runProcess, type ProcessRunner } from './backup-worker';

const roots:string[]=[];
async function directory(){const path=await mkdtemp(join(tmpdir(),'nda-worker-'));roots.push(path);return path;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})))});
function empty(now='2026-10-19T10:00:00.000Z'):BackupStatus{return {enabled:true,schedule:{localTime:'02:00',timeZone:'Asia/Kuala_Lumpur',retainSuccessful:14},state:'never',lastAttempt:null,lastSuccess:null,nextAttemptAt:null,successfulBackupCount:0,statusUpdatedAt:now,observedAt:now};}
const completeToc=REQUIRED_TABLES.map(table=>`TABLE DATA public ${table}`).join('\n');

describe('automatic backup worker',()=>{
  it('requires every persisted table including signed PDF copies',()=>{
    expect(REQUIRED_TABLES).toHaveLength(17);
    expect(REQUIRED_TABLES).toContain('contract_signed_file');
  });
  it('plans immediate first verification, 15-minute failure retry, and daily MYT slots',()=>{
    const first=empty();
    expect(backupPlan(first,new Date('2026-10-19T10:00:00Z'))).toMatchObject({due:true,slotDate:'2026-10-19'});
    const failed={...first,state:'failed' as const,lastAttempt:{slotDate:'2026-10-19',status:'failed' as const,startedAt:'2026-10-19T10:00:00Z',completedAt:'2026-10-19T10:01:00Z',error:'Database export failed.',warning:null}};
    expect(backupPlan(failed,new Date('2026-10-19T10:10:00Z'))).toEqual({due:false,slotDate:'2026-10-19',nextAttemptAt:'2026-10-19T10:16:00.000Z'});
    const succeeded={...first,state:'succeeded' as const,lastSuccess:{slotDate:'2026-10-19',completedAt:'2026-10-19T10:00:00Z',fileName:'nda-auto-2026-10-19-20261019T100000Z.dump',sizeBytes:2,sha256:'a'.repeat(64)}};
    expect(backupPlan(succeeded,new Date('2026-10-19T12:00:00Z'))).toEqual({due:false,slotDate:'2026-10-20',nextAttemptAt:'2026-10-19T18:00:00.000Z'});
  });

  it('verifies, hashes, atomically finalizes, and retains only 14 strict automatic dumps',async()=>{
    const root=await directory();
    for(let day=1;day<=15;day++)await writeFile(join(root,`nda-auto-2026-09-${String(day).padStart(2,'0')}-202609${String(day).padStart(2,'0')}T000000Z.dump`),'old');
    await writeFile(join(root,'manual-backup.dump'),'manual');
    await writeFile(join(root,'.nda-auto-hidden.partial'),'partial');
    const runner:ProcessRunner=async(command,args)=>{
      if(command==='pg_dump'){
        const path=args.find(arg=>arg.startsWith('--file='))!.slice(7); await writeFile(path,'verified dump'); return {code:0,stdout:''};
      }
      return {code:0,stdout:completeToc};
    };
    const times=[new Date('2026-10-19T18:00:00Z'),new Date('2026-10-19T18:00:02Z')];
    const status=await runBackupAttempt({directory:root},empty(),'2026-10-20',runner,()=>times.shift()!);
    expect(status).toMatchObject({state:'succeeded',successfulBackupCount:14,lastAttempt:{status:'succeeded',warning:null},lastSuccess:{slotDate:'2026-10-20',sizeBytes:13}});
    expect(status.lastSuccess?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const names=await readdir(root);
    expect(names.filter(name=>AUTOMATIC_BACKUP_PATTERN.test(name))).toHaveLength(14);
    expect(names).toContain('manual-backup.dump'); expect(names).toContain('.nda-auto-hidden.partial');
    const stored=JSON.parse(await readFile(join(root,BACKUP_STATUS_FILE),'utf8')) as BackupStatus;
    expect(stored.lastSuccess?.fileName).toBe(status.lastSuccess?.fileName);
  });

  it('keeps the prior good backup and stores only a generic error when export fails',async()=>{
    const root=await directory(); const previous=empty();
    previous.state='succeeded'; previous.lastSuccess={slotDate:'2026-10-19',completedAt:'2026-10-19T18:00:00Z',fileName:'nda-auto-2026-10-19-20261019T180000Z.dump',sizeBytes:4,sha256:'b'.repeat(64)};
    await writeFile(join(root,previous.lastSuccess.fileName),'good');
    const runner:ProcessRunner=async()=>({code:1,stdout:'raw secret stderr should never persist'});
    const times=[new Date('2026-10-20T18:00:00Z'),new Date('2026-10-20T18:00:01Z')];
    const status=await runBackupAttempt({directory:root},previous,'2026-10-21',runner,()=>times.shift()!);
    expect(status).toMatchObject({state:'failed',lastSuccess:previous.lastSuccess,lastAttempt:{status:'failed',error:'Database export failed.'},nextAttemptAt:'2026-10-20T18:15:01.000Z'});
    expect(await readFile(join(root,previous.lastSuccess.fileName),'utf8')).toBe('good');
    expect(await readFile(join(root,BACKUP_STATUS_FILE),'utf8')).not.toContain('raw secret');
    expect((await readdir(root)).some(name=>name.endsWith('.partial'))).toBe(false);
  });

  it('rejects a non-restorable or incomplete table-of-contents and removes the partial',async()=>{
    const root=await directory();
    const runner:ProcessRunner=async(command,args)=>{
      if(command==='pg_dump'){
        const path=args.find(arg=>arg.startsWith('--file='))!.slice(7); await writeFile(path,'incomplete'); return {code:0,stdout:''};
      }
      return {code:0,stdout:'TABLE DATA public workspace\n'};
    };
    const times=[new Date('2026-10-20T18:00:00Z'),new Date('2026-10-20T18:00:01Z')];
    const status=await runBackupAttempt({directory:root},empty(),'2026-10-21',runner,()=>times.shift()!);
    expect(status).toMatchObject({state:'failed',lastAttempt:{error:'Backup verification failed.'}});
    expect((await readdir(root)).some(name=>name.endsWith('.partial')||AUTOMATIC_BACKUP_PATTERN.test(name))).toBe(false);
  });

  it('rejects an archive that omits any contracts module table',async()=>{
    const root=await directory();
    const runner:ProcessRunner=async(command,args)=>{
      if(command==='pg_dump'){
        const path=args.find(arg=>arg.startsWith('--file='))!.slice(7); await writeFile(path,'incomplete contracts dump'); return {code:0,stdout:''};
      }
      return {code:0,stdout:REQUIRED_TABLES.filter(table=>table!=='contract_signed_file').map(table=>`TABLE DATA public ${table}`).join('\n')};
    };
    const times=[new Date('2026-10-20T18:00:00Z'),new Date('2026-10-20T18:00:01Z')];
    const status=await runBackupAttempt({directory:root},empty(),'2026-10-21',runner,()=>times.shift()!);
    expect(status).toMatchObject({state:'failed',lastAttempt:{error:'Backup verification failed.'}});
    expect((await readdir(root)).some(name=>name.endsWith('.partial')||AUTOMATIC_BACKUP_PATTERN.test(name))).toBe(false);
  });

  it('recovers a finalized archive after metadata loss and prevents a second same-day dump',async()=>{
    const root=await directory();
    const name='nda-auto-2026-10-20-20261020T000000Z.dump';
    await writeFile(join(root,name),'verified archive');
    await writeFile(join(root,'.nda-auto-interrupted.partial'),'unfinished');
    const runner:ProcessRunner=async()=>({code:0,stdout:completeToc});
    const now=new Date('2026-10-20T01:00:00Z');
    const recovered=await recoverFinalizedBackups({directory:root},{...empty(),state:'unavailable'},runner,now);
    expect(recovered).toMatchObject({state:'succeeded',successfulBackupCount:1,lastSuccess:{fileName:name,slotDate:'2026-10-20'}});
    expect(backupPlan(recovered,now)).toMatchObject({due:false,slotDate:'2026-10-21'});
    await writeFile(join(root,name),'modified archive with valid TOC');
    const modified=await recoverFinalizedBackups({directory:root},recovered,runner,now,true);
    expect(modified.lastSuccess).toBeNull();
    const damaged=await recoverFinalizedBackups({directory:root},{...empty(),state:'unavailable'},async()=>({code:1,stdout:''}),now);
    expect(damaged.lastSuccess).toBeNull();
    expect(backupPlan(damaged,now).due).toBe(true);
  });

  it('preserves the initial failure retry delay through empty-folder recovery and stale metadata',async()=>{
    const root=await directory();
    const failed:BackupStatus={...empty(),state:'failed',lastAttempt:{slotDate:'2026-10-20',status:'failed',startedAt:'2026-10-20T00:00:00Z',completedAt:'2026-10-20T00:00:01Z',error:'Database export failed.',warning:null}};
    for(const [state,at] of [['failed','2026-10-20T00:00:31Z'],['unavailable','2026-10-20T00:04:00Z']] as const){
      const now=new Date(at);
      const recovered=await recoverFinalizedBackups({directory:root},{...failed,state},undefined,now);
      expect(backupPlan(recovered,now)).toMatchObject({due:false,nextAttemptAt:'2026-10-20T00:15:01.000Z'});
    }
  });

  it('cleans only strict interrupted worker partials while leaving finalized and unrelated files',async()=>{
    const root=await directory();
    const partial='.nda-auto-2026-10-20-20261020T000000Z.dump.12345678-1234-1234-1234-123456789abc.partial';
    for(const name of [partial,'manual.dump','.other.partial','nda-auto-2026-10-20-20261020T000000Z.dump'])await writeFile(join(root,name),'keep except partial');
    await cleanupInterruptedPartials(root);
    expect(await readdir(root)).toEqual(expect.arrayContaining(['manual.dump','.other.partial','nda-auto-2026-10-20-20261020T000000Z.dump']));
    expect(await readdir(root)).not.toContain(partial);
  });

  it('keeps running metadata fresh during a slow dump and drains heartbeat writes before success',async()=>{
    const root=await directory();
    let current=new Date('2026-10-20T00:00:00Z');
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const runner:ProcessRunner=async(command,args)=>{
      if(command==='pg_dump'){
        await writeFile(args.find(arg=>arg.startsWith('--file='))!.slice(7),'good');
        await gate; return {code:0,stdout:''};
      }
      return {code:0,stdout:completeToc};
    };
    const result=runBackupAttempt({directory:root,heartbeatMs:10},empty(),'2026-10-20',runner,()=>current);
    try {
      await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(root,BACKUP_STATUS_FILE),'utf8')).state).toBe('running'));
      current=new Date('2026-10-20T00:04:00Z');
      await vi.waitFor(async()=>expect(await readBackupStatus(root,current)).toMatchObject({state:'running',statusUpdatedAt:current.toISOString()}));
    } finally { release(); }
    expect((await result).state).toBe('succeeded');
    await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(root,BACKUP_STATUS_FILE),'utf8')).state).toBe('succeeded'));
  });

  it('terminates an unresponsive export process within its time limit',async()=>{
    const result=await runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],30);
    expect(result.code).toBe(-1);
  });
});
