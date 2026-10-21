'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const {installChatAssistant}=require('./assistant/chat-assistant');
contextBridge.exposeInMainWorld('larkDesktop',Object.freeze({
    platform:process.platform,
    notify:(title,opt,id)=>ipcRenderer.send('notification',JSON.stringify({title,opt,id})),
    closeNotification:id=>ipcRenderer.send('notification:close',id),
    onNotificationEvent:callback=>{ipcRenderer.on('notification:event',(_event,id,type)=>callback(id,type));}
}));
window.addEventListener('DOMContentLoaded',()=>installChatAssistant({document,ipcRenderer}),{once:true});
