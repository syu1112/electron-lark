'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopSettings',{
    read:()=>ipcRenderer.invoke('settings:read'),
    pickSkill:()=>ipcRenderer.invoke('settings:pick-skill'),
    save:config=>ipcRenderer.invoke('settings:save',config),
    openProject:releases=>ipcRenderer.send('settings:open-project',Boolean(releases))
});
