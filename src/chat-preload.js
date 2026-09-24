'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const {installChatAssistant}=require('./assistant/chat-assistant');
contextBridge.exposeInMainWorld('larkDesktop',Object.freeze({
    platform:process.platform,
    notify:(title,opt)=>ipcRenderer.send('notification',JSON.stringify({title,opt}))
}));
window.addEventListener('DOMContentLoaded',()=>installChatAssistant({document,ipcRenderer}),{once:true});
