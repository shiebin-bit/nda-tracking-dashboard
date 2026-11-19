const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('ndaDesktop',Object.freeze({
  status:()=>ipcRenderer.invoke('desktop:status'),
  saveMail:input=>ipcRenderer.invoke('desktop:mail',input),
  setOpenAtLogin:enabled=>ipcRenderer.invoke('desktop:startup',enabled),
  backup:()=>ipcRenderer.invoke('desktop:backup'),
  restore:()=>ipcRenderer.invoke('desktop:restore'),
  openDataFolder:()=>ipcRenderer.invoke('desktop:folder'),
}));
