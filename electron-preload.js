const {contextBridge,ipcRenderer,webUtils}=require('electron');

contextBridge.exposeInMainWorld('fastGpuWindow',{
  pickDirectory:()=>ipcRenderer.invoke('dialog:pick-directory'),
  pickFiles:()=>ipcRenderer.invoke('dialog:pick-files'),
  pickStorageFiles:()=>ipcRenderer.invoke('dialog:pick-storage-files'),
  pickStorageFolder:()=>ipcRenderer.invoke('dialog:pick-storage-folder'),
  pickStartupScript:()=>ipcRenderer.invoke('dialog:pick-startup-script'),
  getPathForFile:file=>webUtils.getPathForFile(file),
  minimize:()=>ipcRenderer.invoke('window:minimize'),
  toggleMaximize:()=>ipcRenderer.invoke('window:toggle-maximize'),
  close:()=>ipcRenderer.invoke('window:close'),
  conflictChoice:()=>ipcRenderer.invoke('conflict:choice'),
  isMaximized:()=>ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange:callback=>{
    const listener=(_event,maximized)=>callback(Boolean(maximized));
    ipcRenderer.on('window:maximized-change',listener);
    return()=>ipcRenderer.removeListener('window:maximized-change',listener);
  },
});
