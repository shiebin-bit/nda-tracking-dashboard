import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from './app';
import { PgNdaStore } from './store';
import { PgContractStore } from './contract-store';

describe('HTTP boundary guards',()=>{
  let server:ReturnType<typeof createServer>; let port:number;
  const pool={query:vi.fn(async()=>({rows:[{one:1}]})),connect:vi.fn()} as unknown as Pool;
  const summary={enabled:false,recipientEmail:'',ccEmail:'',sendTime:'09:00',timeZone:'Asia/Kuala_Lumpur',serverTime:'2026-10-19T01:00:00.000Z',today:'2026-10-19',nextCheckAt:null,nextCheckState:'paused',todayResult:null,latestResult:null} as const;
  const email={summary:vi.fn(async()=>summary)};
  const allowedHosts=new Set<string>();
  beforeEach(async()=>{
    allowedHosts.clear(); email.summary.mockClear(); server=createServer(createHandler(pool,{port:3000,publicDir:'missing',allowedHosts,bodyLimitBytes:128,backupStatusDir:'server/__missing_backup_status__'},email as never));
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)); port=(server.address() as AddressInfo).port; allowedHosts.add(`127.0.0.1:${port}`);
  });
  afterEach(async()=>new Promise<void>(resolve=>server.close(()=>resolve())));

  async function call(path:string,options:{method?:string;headers?:Record<string,string>;body?:string}={}){
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:options.method,headers:options.headers,body:options.body});
    return {status:response.status,body:await response.json()};
  }

  it('rejects unapproved Host headers',async()=>{
    const result=await new Promise<{status:number;body:unknown}>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path:'/health/live',headers:{Host:'evil.local'}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end();});
    expect(result).toMatchObject({status:421,body:{error:{code:'invalid_host'}}});
  });
  it('rejects cross-origin requests',async()=>{
    const result=await call('/health/live',{headers:{Origin:'http://evil.local'}});
    expect(result).toMatchObject({status:403,body:{error:{code:'invalid_origin'}}});
  });
  it('requires JSON content type before command dispatch',async()=>{
    const result=await call('/api/records',{method:'POST',body:'{}'});
    expect(result).toMatchObject({status:415,body:{error:{code:'unsupported_media_type'}}});
    const deletion=await call('/api/records/record-1',{method:'DELETE',body:'{}'});
    expect(deletion).toMatchObject({status:415,body:{error:{code:'unsupported_media_type'}}});
    expect((pool as unknown as {connect:ReturnType<typeof vi.fn>}).connect).not.toHaveBeenCalled();
  });
  it('rejects invalid command body shapes without touching the database',async()=>{
    const result=await call('/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:'[]'});
    expect(result).toMatchObject({status:400,body:{error:{code:'invalid_request'}}});
    expect((pool as unknown as {connect:ReturnType<typeof vi.fn>}).connect).not.toHaveBeenCalled();
  });
  it('serves liveness without a database query',async()=>{
    const result=await call('/health/live'); expect(result).toEqual({status:200,body:{status:'ok'}});
  });
  it('returns the read-only reminder summary directly',async()=>{
    const result=await call('/api/email/summary');
    expect(result).toEqual({status:200,body:summary});
    expect(email.summary).toHaveBeenCalledOnce();
  });
  it('returns sanitized automatic backup status without touching the database',async()=>{
    const result=await call('/api/backups/automatic/status');
    expect(result).toMatchObject({status:200,body:{enabled:true,state:'unavailable',schedule:{localTime:'02:00',timeZone:'Asia/Kuala_Lumpur',retainSuccessful:14}}});
  });
  it('routes follow-up note commands through the guarded JSON boundary',async()=>{
    const resultBody={revision:'2',snapshot:{schemaVersion:1,records:[],history:[],settings:{recipientEmail:'',ccEmail:'',senderEmail:'',sendTime:'09:00',timeZone:'Asia/Kuala_Lumpur',reminderDays:[90,60,45,30],automaticRemindersEnabled:false},initializedAt:'2026-10-20T00:00:00.000Z'}};
    const command=vi.spyOn(PgNdaStore.prototype,'addFollowUpNote').mockResolvedValue(resultBody as never);
    try{
      const payload={requestId:'123e4567-e89b-42d3-a456-426614174000',expectedVersion:1,text:'Called recipient.'};
      const result=await call('/api/records/record-1/follow-up-notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      expect(result).toEqual({status:200,body:resultBody});
      expect(command).toHaveBeenCalledWith('record-1',payload);
    }finally{command.mockRestore();}
  });
  it('accepts signed PDFs only on the multipart route and serves stored bytes with narrow headers',async()=>{
    const uploaded={contract:{id:'contract-1'},signedFile:{id:'signed-1'}};
    const upload=vi.spyOn(PgContractStore.prototype,'uploadSignedFile').mockResolvedValue(uploaded as never);
    const stored=Buffer.from('%PDF-1.4\n%%EOF');
    const content=vi.spyOn(PgContractStore.prototype,'signedFile').mockResolvedValue({
      id:'signed-1',contractId:'contract-1',ordinal:1,sourceVersionId:'version-1',originalFileName:'final signed.pdf',
      contentType:'application/pdf',sizeBytes:stored.length,checksum:'a'.repeat(64),uploadedBy:'Local user',
      uploadedAt:'2026-10-23T00:00:00.000Z',content:stored,
    });
    try{
      const boundary='----app-signed-test';
      const multipart=[
        `--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n123e4567-e89b-42d3-a456-426614174000\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n1\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="versionId"\r\n\r\n223e4567-e89b-42d3-a456-426614174000\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="final.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n%%EOF\r\n`,
        `--${boundary}--\r\n`,
      ].join('');
      const result=await call('/api/contracts/contract-1/signed-files',{
        method:'POST',headers:{'Content-Type':`multipart/form-data; boundary=${boundary}`},body:multipart,
      });
      expect(result).toEqual({status:200,body:uploaded});
      expect(upload).toHaveBeenCalledWith('contract-1',expect.objectContaining({
        requestId:'123e4567-e89b-42d3-a456-426614174000',expectedVersion:1,
        versionId:'223e4567-e89b-42d3-a456-426614174000',originalFileName:'final.pdf',
      }));
      const response=await fetch(`http://127.0.0.1:${port}/api/contract-signed-files/signed-1/content`);
      expect(response.status).toBe(200);
      expect(Buffer.compare(Buffer.from(await response.arrayBuffer()),stored)).toBe(0);
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'self'");
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('content-disposition')).toContain('inline; filename="final-signed.pdf"');
    }finally{upload.mockRestore();content.mockRestore();}
  });
});
