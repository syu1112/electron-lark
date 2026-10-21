'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const channel = process.argv.find(value => value.startsWith('--app-panel-channel=')).slice('--app-panel-channel='.length);
contextBridge.exposeInMainWorld('appPanel', {
    action: (action, id) => ipcRenderer.invoke(channel, action, id),
    onUpdate: callback => ipcRenderer.on(channel, (_event, state) => callback(state))
});
