'use strict';

const {contextBridge, ipcRenderer} = require('electron');

if (location.origin === 'https://ylops-h5.jtexpress.com.cn' && process.isMainFrame) {
    const channel = process.argv.find(value => value.startsWith('--ops-auth-channel=')).slice('--ops-auth-channel='.length);
    contextBridge.exposeInMainWorld('electronOpsAuth', () => ipcRenderer.invoke(channel));
    contextBridge.exposeInMainWorld('electronOpsClose', () => ipcRenderer.invoke(channel, 'close'));
    contextBridge.executeInMainWorld({func: () => {
        function install() {
            window.h5sdk ??= {};
            // This browser adapter only supplies OAuth and window controls; it does not validate native SDK signatures.
            window.h5sdk.config = config => {
                if (config.appId !== 'cli_a4e6cb1e333a500e') throw new Error('工单应用配置不匹配');
            };
            window.h5sdk.ready = callback => queueMicrotask(callback);
            window.tt = {
                async requestAuthCode(options) {
                    if (options.appId !== 'cli_a4e6cb1e333a500e') {
                        options.fail?.({errMsg: 'requestAuthCode:fail 应用不匹配'});
                        return;
                    }
                    const store = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$store;
                    if (store?.state.userStore.token) {
                        let valid = false;
                        try {await store.dispatch('userStore/getInfo'); valid = true;} catch {}
                        if (valid) {
                            const dispatch = store.dispatch;
                            const result = {sessionReused: true};
                            // The H5 callback always exchanges a code. Its existing validated session needs no exchange.
                            store.dispatch = function (action, payload, ...rest) {
                                if (action === 'userStore/fsCodeLogin' && !payload?.user_code) return Promise.resolve();
                                return dispatch.call(this, action, payload, ...rest);
                            };
                            try {options.success?.(result);} finally {store.dispatch = dispatch;}
                            options.complete?.(result);
                            return;
                        }
                    }
                    window.electronOpsAuth().then(result => {
                        if (result.code) options.success?.(result);
                        else options.fail?.(result);
                        options.complete?.(result);
                    }).catch(() => {
                        const error = {errMsg: 'requestAuthCode:fail 无法完成授权，请重试'};
                        options.fail?.(error);
                        options.complete?.(error);
                    });
                },
                // The host provides navigation and close controls for the embedded detail pane.
                setNavigationBar() {},
                onLeftNavigationBarClick() {},
                closeWindow() {window.electronOpsClose();}
            };
        }
        document.addEventListener('load', event => {
            if (event.target.tagName === 'SCRIPT' &&
                event.target.src === 'https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.42.js') install();
        }, true);
        install();
    }});
}
