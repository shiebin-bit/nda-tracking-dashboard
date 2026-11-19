import {cp,mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import PizZip from 'pizzip';

const source=resolve(process.env.NDA_LIBREOFFICE_DIR||'C:/Program Files/LibreOffice');
const target=resolve('work/desktop-vendor/libreoffice');
for(const required of ['program/soffice.com','program/soffice.bin','share/registry/main.xcd','license.txt','NOTICE']){
  if(!(await stat(join(source,required)).catch(()=>null))?.isFile())throw new Error(`LibreOffice distribution is incomplete: ${required}`);
}
await mkdir(target,{recursive:true});await cp(source,target,{recursive:true,force:true});
// Official Microsoft app-local runtime: included so LibreOffice needs no system-wide VC++ installation.
const url='https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx';
const cache=resolve('work/vclibs-x64.appx');let archive;
try{archive=await readFile(cache);}catch{const response=await fetch(url);if(!response.ok)throw new Error('Microsoft runtime download failed.');archive=Buffer.from(await response.arrayBuffer());await writeFile(cache,archive);}
const zip=new PizZip(archive);const dlls=Object.values(zip.files).filter(f=>!f.dir&&/^[a-z0-9_]+\.dll$/i.test(f.name));
if(!dlls.some(f=>f.name.toLowerCase()==='vcruntime140_1.dll')||!dlls.some(f=>f.name.toLowerCase()==='msvcp140.dll'))throw new Error('The Microsoft x64 runtime package is incomplete.');
for(const file of dlls)await writeFile(join(target,'program',file.name),file.asNodeBuffer());
const notices=`NDA Tracker bundled components\n\nLibreOffice: The Document Foundation. Original LICENSE.html, license.txt, NOTICE and CREDITS.fodt are included next to this notice. Source: https://www.libreoffice.org/download/download-libreoffice/ and https://download.documentfoundation.org/libreoffice/src/ . This is an unmodified local conversion distribution, with Microsoft app-local runtime DLLs alongside it.\n\nMicrosoft Visual C++ runtime: ${url}\nRedistribution terms: https://visualstudio.microsoft.com/license-terms/\nRuntime archive SHA-256: ${createHash('sha256').update(archive).digest('hex')}\n\nElectron and Chromium notices are included in the application distribution (LICENSE.electron.txt and LICENSES.chromium.html). Application dependencies retain their original license files. Windows fonts are used from the user's Windows installation and are not redistributed.\n`;
await writeFile(join(target,'NDA-TRACKER-NOTICES.txt'),notices);
await writeFile('work/desktop-vendor/manifest.json',JSON.stringify({preparedAt:new Date().toISOString(),libreOfficeBuild:(await readFile(join(source,'program/version.ini'),'utf8')).match(/^buildid=(.*)$/m)?.[1]?.trim(),microsoftRuntimeUrl:url,microsoftRuntimeSha256:createHash('sha256').update(archive).digest('hex'),appLocalRuntimeFiles:dlls.map(f=>f.name)},null,2));
console.log('Prepared complete LibreOffice distribution, app-local runtime, and notices.');
