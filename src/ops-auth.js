'use strict';

const {ipcMain} = require('electron');
const {randomBytes} = require('node:crypto');

function installOpsAuth(contents, channel, createAuthView, closePanel) {
    let pending;
    let cancel;
    ipcMain.handle(channel, (event, action) => {
        if (event.sender !== contents || event.senderFrame !== contents.mainFrame ||
            new URL(event.senderFrame.url).origin !== 'https://ylops-h5.jtexpress.com.cn') {
            return {errMsg: 'requestAuthCode:fail 页面无权请求授权'};
        }
        if (action === 'close') {cancel?.(); closePanel(); return;}
        if (pending) return pending;
        pending = new Promise(resolve => {
            const state = randomBytes(32).toString('hex');
            const popup = createAuthView();
            const authContents = popup.webContents;
            let finished = false;
            const finish = result => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                contents.removeListener('did-start-navigation', onNavigation);
                authContents.removeListener('destroyed', onClosed);
                if (!authContents.isDestroyed()) authContents.close({waitForBeforeUnload: false});
                pending = undefined;
                cancel = undefined;
                resolve(result);
            };
            const onClosed = () => finish({errMsg: 'requestAuthCode:fail 用户取消授权'});
            const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
                if (isMainFrame && !isInPlace) finish({errMsg: 'requestAuthCode:fail 页面已离开'});
            };
            const onAuthNavigation = (event, value) => {
                const url = new URL(value);
                if (url.origin === 'https://ylops.jtexpress.com.cn' && url.pathname === '/' &&
                    url.hash.split('?')[0] === '#/auth-redirect') {
                    event.preventDefault?.();
                    const params = new URLSearchParams(url.search || url.hash.slice(url.hash.indexOf('?') + 1));
                    if (params.getAll('state').length !== 1 || params.get('state') !== state ||
                        params.has('error') || params.getAll('code').length !== 1 || !params.get('code')) {
                        finish({errMsg: 'requestAuthCode:fail 授权未通过，请重试'});
                    } else {
                        finish({code: params.get('code')});
                    }
                } else if (url.protocol !== 'https:' && value !== 'about:blank') {
                    event.preventDefault?.();
                }
            };
            const timer = setTimeout(() => finish({errMsg: 'requestAuthCode:fail 授权超时，请重试'}), 180000);
            cancel = () => finish({errMsg: 'requestAuthCode:fail 工单窗口已关闭'});
            authContents.once('destroyed', onClosed);
            contents.on('did-start-navigation', onNavigation);
            authContents.on('will-navigate', onAuthNavigation);
            authContents.on('will-redirect', onAuthNavigation);
            authContents.on('did-navigate', onAuthNavigation);
            authContents.on('did-navigate-in-page', onAuthNavigation);
            authContents.setWindowOpenHandler(() => ({action: 'deny'}));
            const authorize = new URL('https://open.feishu.cn/open-apis/authen/v1/authorize');
            authorize.search = new URLSearchParams({
                app_id: 'cli_a4e6cb1e333a500e',
                redirect_uri: 'https://ylops.jtexpress.com.cn/#/auth-redirect',
                state
            });
            authContents.loadURL(authorize.href).catch(() => {
                if (!authContents.isDestroyed()) finish({errMsg: 'requestAuthCode:fail 授权页面加载失败'});
            });
        });
        return pending;
    });
    contents.once('destroyed', () => {
        cancel?.();
        ipcMain.removeHandler(channel);
    });
}

module.exports = {installOpsAuth};
