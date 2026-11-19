export interface DesktopStatus{version:string;dataDirectory:string;mailConfigured:boolean;senderEmail:string;openAtLogin:boolean;converterAvailable:boolean;backgroundRunning:boolean}
export interface DesktopBridge{
  status():Promise<DesktopStatus>;
  saveMail(input:{apiKey:string;senderEmail:string;clearKey:boolean}):Promise<DesktopStatus>;
  setOpenAtLogin(enabled:boolean):Promise<DesktopStatus>;
  backup():Promise<{canceled:boolean;fileName?:string}>;
  restore():Promise<{canceled:boolean;restored?:boolean}>;
  openDataFolder():Promise<unknown>;
}
declare global{interface Window{ndaDesktop?:DesktopBridge}}
export const desktop=typeof window!=='undefined'?window.ndaDesktop:undefined;
