const {app,BrowserWindow,Menu,Tray,nativeImage,ipcMain,dialog,shell,safeStorage,session,powerMonitor}=require('electron');
const {spawn}=require('node:child_process');
const {randomBytes,randomUUID}=require('node:crypto');
const fs=require('node:fs/promises');
const {existsSync,createWriteStream}=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {DatabaseSync,backup}=require('node:sqlite');

app.setName('NDA Tracker');
app.setPath('userData',process.env.NDA_DESKTOP_DATA_DIR?path.resolve(process.env.NDA_DESKTOP_DATA_DIR):path.join(process.env.LOCALAPPDATA||app.getPath('appData'),'NDA Tracker'));
const dataRoot=app.getPath('userData');
const appRoot=path.resolve(__dirname,'..');
const database=path.join(dataRoot,'nda-tracker.sqlite');
const settingsPath=path.join(dataRoot,'desktop-settings.json');
const backupDirectory=path.join(dataRoot,'backups');
const converter=app.isPackaged?path.join(process.resourcesPath,'libreoffice','program','soffice.com'):process.env.NDA_LIBREOFFICE_PATH||'C:\\Program Files\\LibreOffice\\program\\soffice.com';
let win,tray,backend,origin='',token='',quitting=false,restarting=false,settings={};
let log;let pending=new Map();let shuttingDown;let operationRunning=false;

async function readSettings(){try{const value=JSON.parse(await fs.readFile(settingsPath,'utf8'));return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch(error){if(error.code==='ENOENT')return {};throw new Error('Desktop settings could not be read. Restore desktop-settings.json from a safe copy.');}}
async function saveSettings(value){const temp=`${settingsPath}.${randomUUID()}.tmp`;await fs.writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temp,settingsPath);settings=value;}
function apiKey(){if(!settings.encryptedApiKey)return '';if(!safeStorage.isEncryptionAvailable())throw new Error('Windows credential protection is unavailable. Email stays disabled.');return safeStorage.decryptString(Buffer.from(settings.encryptedApiKey,'base64'));}
function safeLog(value){log?.write(`${new Date().toISOString()} ${value}\n`);}
async function startBackend(){
  token=randomBytes(32).toString('hex');
  let key='';try{key=apiKey();}catch(error){safeLog('Saved email credential could not be decrypted; re-enter it in Settings.');}
  // Never inherit the developer's database, email key, or network binding into a user's workspace.
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1',NDA_DESKTOP:'1',NDA_DESKTOP_TOKEN:token,NDA_SQLITE_PATH:database,PORT:'0',PUBLIC_DIR:path.join(appRoot,'dist','public'),NDA_CONVERTER_URL:'local',NDA_LIBREOFFICE_PATH:converter,NDA_DOCUMENT_FONT_PATH:path.join(process.env.WINDIR||'C:\\Windows','Fonts','times.ttf'),NDA_BACKUP_DIR:backupDirectory,NDA_TEMP_DIR:path.join(dataRoot,'temp'),BREVO_API_KEY:key,BREVO_SENDER_EMAIL:settings.senderEmail||''};
  delete env.DATABASE_URL;delete env.NDA_DB_PASSWORD;delete env.NDA_ALLOWED_HOSTS;
  const child=spawn(process.execPath,[path.join(appRoot,'dist','server','server','index.js')],{cwd:appRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});backend=child;
  let ready=false;
  child.once('exit',()=>{
    if(backend===child)backend=null;
    for(const [id,entry] of pending){clearTimeout(entry.timer);entry.reject(new Error('The background service stopped.'));pending.delete(id);}
    if(ready&&!quitting&&!restarting){dialog.showErrorBox('NDA Tracker stopped','The background service stopped unexpectedly. Your saved data is kept. Restart NDA Tracker.');app.quit();}
  });
  child.stdout.on('data',bytes=>log?.write(bytes));child.stderr.on('data',bytes=>log?.write(bytes));
  child.on('message',message=>{
    if(message?.type==='result'){const entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error)):entry.resolve(message.result);}}
  });
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.once('exit',()=>reject(new Error('The local workspace did not start within 90 seconds.')));child.kill();},90_000);
    const fail=()=>{clearTimeout(timer);reject(new Error('The local workspace could not start. See the desktop log in your data folder.'));};
    child.once('error',fail);child.once('exit',fail);
    const onReady=message=>{if(message?.type!=='ready')return;clearTimeout(timer);child.removeListener('error',fail);child.removeListener('exit',fail);child.removeListener('message',onReady);origin=`http://127.0.0.1:${message.port}`;ready=true;resolve();};child.on('message',onReady);
  });
  await session.defaultSession.cookies.set({url:origin,name:'nda-desktop-session',value:token,httpOnly:true,sameSite:'strict',path:'/'});
}
function backendRequest(type,extra={}){if(!backend?.connected)return Promise.reject(new Error('The background service is unavailable.'));const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('The operation timed out. Check the data folder before retrying.'));},120_000);pending.set(id,{resolve,reject,timer});backend.send({id,type,...extra});});}
async function stopBackend(){
  const child=backend;if(!child)return;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>child.kill(),27_000);const timeout=setTimeout(()=>reject(new Error('The background service is still closing. The active database has not been replaced.')),35_000);child.once('exit',()=>{clearTimeout(timer);clearTimeout(timeout);resolve();});if(child.connected)child.send({type:'shutdown'});else child.kill();});
}
function showWindow(){
  if(win){win.show();win.focus();return;}
  win=new BrowserWindow({title:'NDA Tracker',icon:path.join(__dirname,'nda-tracker.ico'),width:1440,height:960,minWidth:390,minHeight:620,show:false,backgroundColor:'#f6f7f3',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({url})=>{
    try{const parsed=new URL(url);if(parsed.origin===origin)return {action:'allow',overrideBrowserWindowOptions:{webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}};if(parsed.protocol==='https:'&&['app.brevo.com','help.brevo.com'].includes(parsed.hostname))shell.openExternal(url);}catch{}
    return {action:'deny'};
  });
  win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
  win.on('close',event=>{if(!quitting){event.preventDefault();win.hide();if(!settings.explainedBackground){tray.displayBalloon({title:'NDA Tracker is still running',content:'Reminders continue in the system tray. Use Quit NDA Tracker to stop.'});void saveSettings({...settings,explainedBackground:true});}}});
  win.on('closed',()=>{win=null;});win.once('ready-to-show',()=>win.show());void win.loadURL(origin);
}
function trusted(event){if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||new URL(event.senderFrame.url).origin!==origin)throw new Error('Untrusted desktop request.');}
function desktopStatus(){return {version:app.getVersion(),dataDirectory:dataRoot,mailConfigured:!!settings.encryptedApiKey,senderEmail:settings.senderEmail||'',openAtLogin:app.getLoginItemSettings({path:process.execPath,args:['--background']}).openAtLogin,converterAvailable:existsSync(converter),backgroundRunning:!!backend};}
async function requireSavedForms(){if(await win.webContents.executeJavaScript('document.documentElement.dataset.ndaDirty === "true"'))throw new Error('Save or discard your unsaved changes before changing the connection or restoring a backup.');}
function reloadSoon(){setTimeout(()=>{if(win&&!win.isDestroyed())void win.loadURL(origin);},150);}
function pauseReminders(file){const db=new DatabaseSync(file);try{db.exec('PRAGMA trusted_schema=OFF');db.prepare("UPDATE workspace SET settings=json_set(settings,'$.automaticRemindersEnabled',json('false')) WHERE id=1").run();}finally{db.close();}}
async function snapshot(source,destination){const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,destination);}finally{db.close();}}
async function manualBackup(){const chosen=await dialog.showSaveDialog(win,{title:'Save complete NDA Tracker backup',defaultPath:path.join(app.getPath('documents'),`NDA-Tracker-${new Date().toISOString().slice(0,10)}.sqlite`),filters:[{name:'NDA Tracker database',extensions:['sqlite']}]});if(chosen.canceled||!chosen.filePath)return {canceled:true};if(path.resolve(chosen.filePath)===database)throw new Error('Choose a backup location outside the active database file.');await backendRequest('backup',{path:chosen.filePath});return {canceled:false,fileName:path.basename(chosen.filePath)};}
async function restoreBackup(){
  await requireSavedForms();
  const chosen=await dialog.showOpenDialog(win,{title:'Restore complete NDA Tracker backup',properties:['openFile'],filters:[{name:'NDA Tracker database',extensions:['sqlite']}]});
  if(chosen.canceled||!chosen.filePaths[0])return {canceled:true};
  const source=path.resolve(chosen.filePaths[0]);if(source===database)throw new Error('Choose a saved backup, not the active database.');
  const {verifySqliteBackup}=await import(pathToFileURL(path.join(appRoot,'dist','server','server','sqlite-backup.js')).href);await verifySqliteBackup(source);
  const answer=await dialog.showMessageBox(win,{type:'warning',title:'Restore complete workspace?',message:'Replace this computer’s workspace with the selected backup?',detail:'Agreements, documents, files and history will be restored. A safety backup is saved first. Automatic reminders will be paused. Your email connection stays on this computer.',buttons:['Cancel','Restore workspace'],defaultId:0,cancelId:0,noLink:true});
  if(answer.response!==1)return {canceled:true};
  const staged=path.join(dataRoot,`restore-${randomUUID()}.sqlite`);
  try{await snapshot(source,staged);await verifySqliteBackup(staged);pauseReminders(staged);}
  catch(error){for(const suffix of ['','-wal','-shm'])await fs.rm(`${staged}${suffix}`,{force:true}).catch(()=>{});throw error;}
  const safety=path.join(backupDirectory,`before-restore-${Date.now()}.sqlite`);
  restarting=true;win.setEnabled(false);let replaced=false;let stopped=false;
  try{
    await stopBackend();stopped=true;await snapshot(database,safety);await verifySqliteBackup(safety);
    await fs.rm(`${database}-wal`,{force:true});await fs.rm(`${database}-shm`,{force:true});await fs.rename(staged,database);
    replaced=true;await startBackend();reloadSoon();return {canceled:false,restored:true};
  }catch(error){
    if(stopped){
      if(backend)await stopBackend();
      if(replaced){await fs.rm(`${database}-wal`,{force:true});await fs.rm(`${database}-shm`,{force:true});await fs.copyFile(safety,database);pauseReminders(database);}
      await startBackend();reloadSoon();
    }
    throw new Error('Restore was not completed. The previous workspace was kept; automatic reminders may be paused.');
  }finally{restarting=false;win.setEnabled(true);await fs.rm(staged,{force:true}).catch(()=>{});}
}
function registerIpc(){
  const handlers={status:()=>desktopStatus(),folder:()=>shell.openPath(dataRoot),backup:manualBackup,restore:restoreBackup,
    startup:async enabled=>{if(typeof enabled!=='boolean')throw new Error('Choose a valid startup preference.');app.setLoginItemSettings({openAtLogin:enabled,path:process.execPath,args:['--background']});return desktopStatus();},
    mail:async input=>{
      await requireSavedForms();
      if(!input||typeof input!=='object'||typeof input.senderEmail!=='string'||input.senderEmail.length>500)throw new Error('Enter a valid sender email.');
      const senderEmail=input.senderEmail.trim();if(senderEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail))throw new Error('Enter a valid sender email.');
      const next={...settings,senderEmail};
      if(input.clearKey===true)delete next.encryptedApiKey;
      else if(typeof input.apiKey==='string'&&input.apiKey.trim()){
        if(input.apiKey.trim().length<20||input.apiKey.length>4096)throw new Error('Enter a valid Brevo API key.');
        if(!safeStorage.isEncryptionAvailable())throw new Error('Windows credential protection is unavailable; the key was not saved.');
        next.encryptedApiKey=safeStorage.encryptString(input.apiKey.trim()).toString('base64');
      }
      const previous={...settings};restarting=true;win.setEnabled(false);let stopped=false;
      try{await stopBackend();stopped=true;pauseReminders(database);await saveSettings(next);await startBackend();reloadSoon();}
      catch(error){if(stopped){if(backend)await stopBackend();await saveSettings(previous);await startBackend();reloadSoon();}throw new Error('The new connection could not be applied. The previous connection was kept; automatic reminders are paused.');}
      finally{restarting=false;win.setEnabled(true);}return desktopStatus();
    }};
  for(const [name,handler] of Object.entries(handlers))ipcMain.handle(`desktop:${name}`,async(event,input)=>{trusted(event);const exclusive=['mail','backup','restore'].includes(name);if(exclusive&&operationRunning)throw new Error('Another desktop operation is still running.');if(exclusive)operationRunning=true;try{return await handler(input);}finally{if(exclusive)operationRunning=false;}});
}
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(origin)showWindow();});app.on('window-all-closed',()=>{});app.on('activate',()=>{if(origin)showWindow();});
  app.on('before-quit',event=>{if(shuttingDown)return;event.preventDefault();quitting=true;shuttingDown=(async()=>{try{await stopBackend();}catch{safeLog('The background service did not close normally. It will recover pending tasks at the next start.');}finally{tray?.destroy();log?.end();app.exit();}})();});
  app.whenReady().then(async()=>{
    await fs.mkdir(dataRoot,{recursive:true});await fs.mkdir(backupDirectory,{recursive:true});settings=await readSettings();
    const logPath=path.join(dataRoot,'desktop.log');const details=await fs.stat(logPath).catch(()=>null);if(details?.size>2*1024*1024)await fs.rename(logPath,`${logPath}.previous`).catch(()=>undefined);log=createWriteStream(logPath,{flags:'a'});
    tray=new Tray(nativeImage.createFromPath(path.join(appRoot,'public','ffm-logo.png')).resize({width:18,height:18}));tray.setToolTip('NDA Tracker · Background reminders');tray.on('double-click',()=>showWindow());
    tray.setContextMenu(Menu.buildFromTemplate([{label:'Open NDA Tracker',click:()=>showWindow()},{label:'Open data folder',click:()=>shell.openPath(dataRoot)},{type:'separator'},{label:'Quit NDA Tracker',click:()=>app.quit()}]));
    registerIpc();await startBackend();powerMonitor.on('resume',()=>backend?.send({type:'wake'}));
    if(!process.argv.includes('--background'))showWindow();
  }).catch(error=>{dialog.showErrorBox('NDA Tracker could not start',error.message);app.quit();});
}
