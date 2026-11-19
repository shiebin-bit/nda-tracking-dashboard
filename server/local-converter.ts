import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

let tail:Promise<unknown>=Promise.resolve();
let active:ReturnType<typeof spawn>|null=null;
let stopped=false;
const MAX_PDF_BYTES=20*1024*1024;
export class LocalConversionError extends Error{
  constructor(message:string,readonly transient:boolean){super(message);}
}
function converterEnvironment():NodeJS.ProcessEnv{
  const env:NodeJS.ProcessEnv={};
  for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key];
  return env;
}
function killConversion(child:ReturnType<typeof spawn>):void{
  if(process.platform==='win32'&&child.pid){
    const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',env:converterEnvironment()});
    killer.on('error',()=>child.kill());
  }else child.kill('SIGKILL');
}
export async function stopLocalConverter():Promise<void>{stopped=true;if(active)killConversion(active);await tail;}

async function runOffice(executable:string,args:string[]):Promise<void>{
  await new Promise<void>((done,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:converterEnvironment()});
    active=child;
    let timedOut=false;
    let grace:NodeJS.Timeout|undefined;
    const timer=setTimeout(()=>{
      timedOut=true;
      killConversion(child);
      grace=setTimeout(()=>{killConversion(child);reject(new Error('The PDF converter did not close after its timeout. Restart NDA Tracker before retrying.'));},10_000);
    },120_000);
    child.stdout?.resume();child.stderr?.resume();
    child.once('error',()=>{clearTimeout(timer);reject(new LocalConversionError('The bundled PDF converter could not start. Reinstall NDA Tracker.',false));});
    child.once('close',code=>{
      clearTimeout(timer);
      if(grace)clearTimeout(grace);
      if(active===child)active=null;
      if(timedOut)reject(new Error('PDF conversion timed out. The Word file is kept; retry generation.'));
      else if(code!==0)reject(new LocalConversionError('The local PDF converter could not convert this document.',false));
      else done();
    });
  });
}

async function convert(docx:Buffer):Promise<Buffer>{
  const executable=process.env.NDA_LIBREOFFICE_PATH?.trim();
  if(!executable||!(await stat(executable).catch(()=>null))?.isFile())throw new LocalConversionError('The local PDF converter is missing. Reinstall NDA Tracker.',false);
  const root=resolve(process.env.NDA_TEMP_DIR||tmpdir());
  await mkdir(root,{recursive:true});
  const directory=await mkdtemp(join(root,'nda-pdf-'));
  try{
    const profile=join(directory,'profile');
    await mkdir(join(profile,'user'),{recursive:true});
    await writeFile(join(profile,'user','registrymodifications.xcu'),'<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>');
    const input=join(directory,'input.docx');const output=join(directory,'output');
    await mkdir(output);await writeFile(input,docx,{flag:'wx'});
    await runOffice(executable,[`-env:UserInstallation=${pathToFileURL(profile).href}`,'--headless','--norestore','--nodefault','--nolockcheck','--convert-to','pdf:writer_pdf_Export:{"IsSkipEmptyPages":{"type":"boolean","value":"true"}}','--outdir',output,input]);
    const path=join(output,'input.pdf');const details=await stat(path).catch(()=>null);
    if(!details?.isFile()||details.size<5||details.size>MAX_PDF_BYTES)throw new LocalConversionError('PDF conversion returned no valid file or exceeded 20 MiB.',false);
    const pdf=await readFile(path);
    if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new LocalConversionError('PDF conversion returned an invalid PDF.',false);
    return pdf;
  }finally{
    // directory is the exact task-owned mkdtemp result under root.
    if(active&&active.exitCode===null)active.once('close',()=>{void rm(directory,{recursive:true,force:true}).catch(()=>undefined);});
    else await rm(directory,{recursive:true,force:true}).catch(()=>undefined);
  }
}

/** Serialize preview and generation conversions; never use the user's Office profile. */
export function convertLocally(docx:Buffer):Promise<Buffer>{
  const next=tail.then(()=>{if(stopped)throw new Error('PDF conversion paused while the application closes.');if(active&&active.exitCode===null)throw new Error('The previous PDF converter is still closing. Restart NDA Tracker.');return convert(docx);});tail=next.catch(()=>undefined);return next;
}
