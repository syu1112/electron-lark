const { app, BrowserWindow, Menu, shell, clipboard, ClipboardItem, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {EventEmitter} = require('node:events');
const Module = require('node:module');
const nativeNotifications = [];
class TestNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options=options; nativeNotifications.push(this); }
    show() { this.emit('show'); }
    close() { this.closed=true; this.emit('close'); }
}

app.commandLine.appendSwitch('use-mock-keychain');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-lark-test-'));
app.setPath('userData', profile);
const opened = [];
const originalOpenExternal = shell.openExternal;
shell.openExternal = async url => { opened.push(url); };
const originalPopup = Menu.prototype.popup;
let contextMenu;
Menu.prototype.popup = function () { contextMenu = this; };
let savedClipboard;
let failures = 0;
const timeout = setTimeout(() => { console.error('FAIL integration timeout'); app.exit(1); }, 30000);
process.on('uncaughtException', error => { console.error('FAIL', error.stack); app.exit(1); });
process.on('unhandledRejection', error => { console.error('FAIL', error.stack); app.exit(1); });

async function waitFor(check) {
    for (let i = 0; i < 100; i++) {
        const result = await check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for application behavior');
}

async function check(name, body) {
    try { await body(); console.log('PASS', name); }
    catch (error) { failures++; console.error('FAIL', name, error.stack); }
}

const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fs.readFileSync(path.join(__dirname, 'chat-fixture.html')));
});
server.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
        startPageLink: base, larkOpenLink: `${base}/inside`, showWarterMark: true
    }));
    fs.writeFileSync(path.join(profile, 'updateCheck.json'), JSON.stringify({lastCheckUpdateTimeStamp: Math.floor(Date.now() / 1000)}));
    const originalLoad=Module._load;
    const testElectron=Object.create(require('electron'));
    Object.defineProperty(testElectron,'Notification',{value:TestNotification});
    Module._load=function(request,parent,...args) {
        if(request==='electron'&&parent?.filename===path.join(__dirname,'../src/main.js')) return testElectron;
        return originalLoad.call(this,request,parent,...args);
    };
    try {require('../src/main.js');} finally {Module._load=originalLoad;}
    await app.whenReady();
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0]);
    await waitFor(() => !win.webContents.isLoading());

    await check('browser identification matches the runtime and Mac platform', async () => {
        const ua = await win.webContents.executeJavaScript('navigator.userAgent');
        assert(ua.includes(`Chrome/${process.versions.chrome}`), ua);
        assert(ua.includes('Macintosh'), ua);
        assert(!ua.includes('Electron/'), ua);
    });
    await check('unlisted links open externally without an application popup', async () => {
        await win.webContents.executeJavaScript(`window.open('${base}/outside'); void 0;`);
        await waitFor(() => opened.includes(`${base}/outside`));
        assert.equal(BrowserWindow.getAllWindows().length, 1);
    });
    await check('configured internal links open in an application window', async () => {
        await win.webContents.executeJavaScript(`window.open('${base}/inside'); void 0;`);
        const child = await waitFor(() => BrowserWindow.getAllWindows().find(w => w !== win && w.webContents.getURL() === `${base}/inside`));
        assert(!opened.includes(`${base}/inside`));
        const ua = await child.webContents.executeJavaScript('navigator.userAgent');
        assert(ua.includes(`Chrome/${process.versions.chrome}`));
        child.destroy();
    });
    const embedded = match => win.contentView.children.find(view => view.webContents && match(view.webContents.getURL()));
    let appWindow;
    let opsWindow;
    let authWindow;
    const appLink = 'https://applink.feishu.cn/client/web_app/open?appId=cli_a4f419c5067d9013&mode=appCenter&lk_target_url=https%3A%2F%2Fedu.sandstalk.com%2F%23%2FTransit%3FappId%3Dcli_a4f419c5067d9013%26state%3Dfeishu_jump%26jumpModuleId%3D980372545410711612%26jumpType%3D700&from=p2p_card_button';
    const fixture = require('./fixtures/web-app-sites.cjs').createWebAppFixture(win.webContents.session.cookies);
    const appRequests = fixture.requests;
    win.webContents.session.protocol.handle('https', fixture.handle);
    await check('card AppLink completes OAuth and live redirect without replacing the chat', async () => {
        await win.webContents.session.cookies.set({url: 'https://video.example.test', name: 'shared-session', value: 'synthetic', secure: true});
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(appLink)}); void 0;`);
        appWindow = await waitFor(() => embedded(url => url === 'https://video.example.test/player?id=980372545410711612'));
        assert.equal(win.webContents.getURL(), base + '/');
        assert.equal(BrowserWindow.getAllWindows().length, 1, 'business pages must share the main window');
        const chat = win.contentView.children.find(view => view.webContents === win.webContents);
        assert(chat, 'chat must remain a separately laid out view');
        const chatBounds = chat.getBounds(), appBounds = appWindow.getBounds();
        assert(chatBounds.width >= 650);
        assert(appBounds.width >= 360);
        assert.equal(appBounds.x, chatBounds.width);
        assert.equal(chatBounds.width + appBounds.width, win.getContentSize()[0]);
        assert(!opened.includes(appLink));
        assert(appRequests.includes('https://open.feishu.cn/open-apis/authen/v1/index'));
        assert(appRequests.includes('https://edu.sandstalk.com/live-redirect'));
        const page = await appWindow.webContents.executeJavaScript('({id:new URL(location.href).searchParams.get("id"),cookie:document.cookie,node:typeof require,bridge:typeof larkDesktop})');
        assert.equal(page.id, '980372545410711612');
        assert(page.cookie.includes('shared-session=synthetic'));
        assert.equal(page.node, 'undefined');
        assert.equal(page.bridge, 'undefined');
    });
    await check('reopening the same card focuses the existing app without restarting OAuth', async () => {
        assert(appWindow);
        await appWindow.webContents.executeJavaScript('window.preservedPlayback = true');
        const requestCount = appRequests.length;
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(appLink)}); void 0;`);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(BrowserWindow.getAllWindows().length, 1);
        assert.equal(await appWindow.webContents.executeJavaScript('window.preservedPlayback'), true);
        assert.equal(appRequests.length, requestCount);
    });
    await check('same-frame card navigation reuses the app window and keeps the exact new ID', async () => {
        assert(appWindow);
        const authorizations=appRequests.filter(v=>v.endsWith('/authen/v1/index')).length;
        const nextLink = appLink.replace('980372545410711612', '980372545410711613');
        await win.webContents.executeJavaScript(`location.href = ${JSON.stringify(nextLink)}; void 0;`);
        await waitFor(() => appWindow.webContents.getURL() === 'https://video.example.test/player?id=980372545410711613');
        assert.equal(win.webContents.getURL(), base + '/');
        assert.equal(BrowserWindow.getAllWindows().length, 1);
        assert.equal(appRequests.filter(v=>v.endsWith('/authen/v1/index')).length,authorizations,'an existing business session should avoid repeated OAuth');
        assert(appRequests.includes('https://edu.sandstalk.com/sands-user/api/v1/user/current-info'));
    });
    await check('slow session validation cannot swallow or overwrite a newer Sandstalk card', async () => {
        fixture.state.delayValidation=400;
        const before=appRequests.filter(v=>v.endsWith('/current-info')).length;
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(appLink.replace('980372545410711612','980372545410711614'))});void 0;`);
        await waitFor(()=>appRequests.filter(v=>v.endsWith('/current-info')).length>before);
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(appLink.replace('980372545410711612','980372545410711615'))});void 0;`);
        await waitFor(()=>appWindow.webContents.getURL()==='https://video.example.test/player?id=980372545410711615');
        await new Promise(resolve=>setTimeout(resolve,500));
        assert.equal(appWindow.webContents.getURL(),'https://video.example.test/player?id=980372545410711615');
    });
    await check('a rejected Sandstalk business session falls back to normal OAuth', async () => {
        fixture.state.rejectSandSession=true;
        const count=appRequests.filter(v=>v.endsWith('/authen/v1/index')).length;
        const next=appLink.replace('980372545410711612','980372545410711616');
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(next)});void 0;`);
        await waitFor(()=>appRequests.filter(v=>v.endsWith('/authen/v1/index')).length>count);
        await waitFor(()=>appWindow.webContents.getURL()==='https://video.example.test/player?id=980372545410711616');
    });
    await check('OAuth popups retain opener communication and have no desktop bridge', async () => {
        assert(appWindow);
        await appWindow.webContents.executeJavaScript('window.addEventListener("message", e => window.popupMessage=e.data); window.open("https://open.feishu.cn/popup"); void 0;');
        await waitFor(() => appWindow.webContents.executeJavaScript('window.popupMessage === "oauth-popup-ready"'));
        const popup = embedded(url => url === 'https://open.feishu.cn/popup');
        assert(popup);
        assert.equal(await popup.webContents.executeJavaScript('typeof require + ":" + typeof larkDesktop'), 'undefined:undefined');
        const popupContents=popup.webContents;
        await popupContents.executeJavaScript('window.close();void 0;').catch(()=>{});
        await waitFor(()=>popupContents.isDestroyed());
    });
    await check('business pages cannot navigate to local files or launch native protocols', async () => {
        assert(appWindow);
        const externalCount = opened.length;
        await appWindow.webContents.executeJavaScript('location.href = "file:///etc/passwd"; void 0;');
        await appWindow.webContents.executeJavaScript('window.open("electron-lark-test://blocked"); void 0;');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(appWindow.webContents.getURL(), 'https://video.example.test/player?id=980372545410711616');
        assert.equal(opened.length, externalCount);
        assert.equal(BrowserWindow.getAllWindows().length, 1);
    });
    await check('operations link starts browser OAuth and preserves the requested work order', async () => {
        const url = 'https://ylops-h5.jtexpress.com.cn/?lang=zh-CN&open_in_browser=true#/131824/fs-workflow-detail';
        const card = new URL('https://applink.feishu.cn/client/web_app/open');
        card.search = new URLSearchParams({appId:'cli_a4e6cb1e333a500e',mode:'appCenter',lk_target_url:url,from:'p2p_card_button'});
        const externalCount = opened.length;
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(card.href)}); void 0;`);
        opsWindow = await waitFor(() => embedded(value => value === url));
        await waitFor(() => opsWindow.webContents.executeJavaScript('window.adapterReady === true'));
        authWindow = await waitFor(() => embedded(url => url.startsWith('https://open.feishu.cn/open-apis/authen/v1/authorize?')));
        const authUrl = new URL(authWindow.webContents.getURL());
        assert.equal(authUrl.searchParams.get('app_id'), 'cli_a4e6cb1e333a500e');
        assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://ylops.jtexpress.com.cn/#/auth-redirect');
        assert(authUrl.searchParams.get('state').length >= 32);
        assert.equal(await authWindow.webContents.executeJavaScript('typeof electronOpsAuth + ":" + typeof require'), 'undefined:undefined');
        const callback = new URL(authUrl.searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({code:'synthetic-user-authorized-code',state:authUrl.searchParams.get('state')});
        await authWindow.webContents.executeJavaScript(`location.href=${JSON.stringify(callback.href)}; void 0;`);
        await waitFor(() => opsWindow.webContents.executeJavaScript('window.authResult?.code === "synthetic-user-authorized-code"'));
        assert((!authWindow.webContents || authWindow.webContents.isDestroyed()));
        assert.equal(opsWindow.webContents.getURL(), url);
        assert.equal(win.webContents.getURL(), base + '/');
        assert.equal(opened.length, externalCount, 'the card must not be dispatched to the system browser or native app');
        const windowCount = BrowserWindow.getAllWindows().length;
        const requestCount = appRequests.length;
        await opsWindow.webContents.executeJavaScript('window.preservedTicket=true');
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(url)}); void 0;`);
        await new Promise(resolve => setTimeout(resolve,100));
        assert.equal(BrowserWindow.getAllWindows().length, windowCount);
        assert.equal(appRequests.length, requestCount);
        assert.equal(await opsWindow.webContents.executeJavaScript('window.preservedTicket'),true);
    });
    await check('operations reload reuses a server-validated business session without exchanging a cached code', async () => {
        const authorizations=appRequests.filter(v=>v.endsWith('/authorize')).length;
        const exchanges=appRequests.filter(v=>v.endsWith('/fs_login/')).length;
        opsWindow.webContents.reload();
        await waitFor(()=>opsWindow.webContents.executeJavaScript('window.authResult?.sessionReused === true'));
        assert.equal(appRequests.filter(v=>v.endsWith('/authorize')).length,authorizations);
        assert.equal(appRequests.filter(v=>v.endsWith('/fs_login/')).length,exchanges);
        assert(appRequests.some(v=>v.endsWith('/check_admin/')));
        assert.equal(await opsWindow.webContents.executeJavaScript('window.authResult.code'),undefined);
    });
    await check('an expired access token is refreshed by the business app before asking for OAuth again', async () => {
        const authorizations=appRequests.filter(v=>v.endsWith('/authorize')).length;
        await opsWindow.webContents.executeJavaScript('localStorage.setItem("ops-session","synthetic-expired")');
        opsWindow.webContents.reload();
        await waitFor(()=>opsWindow.webContents.executeJavaScript('window.authResult?.sessionReused === true'));
        assert(appRequests.some(v=>v.endsWith('/refresh/')));
        assert.equal(appRequests.filter(v=>v.endsWith('/authorize')).length,authorizations);
    });
    await check('closing the right pane restores chat width and reopening preserves the loaded detail', async () => {
        const header=embedded(url=>url.endsWith('/app-panel.html'));
        assert(header);
        await opsWindow.webContents.executeJavaScript('window.detailPreserved=true');
        await header.webContents.executeJavaScript('document.querySelector("#close").click();void 0;');
        await waitFor(()=>!opsWindow.getVisible());
        const chat=win.contentView.children.find(v=>v.webContents===win.webContents);
        assert.equal(chat.getBounds().width,win.getContentSize()[0]);
        await win.webContents.executeJavaScript('window.open("https://ylops-h5.jtexpress.com.cn/?lang=zh-CN&open_in_browser=true#/131824/fs-workflow-detail");void 0;');
        await waitFor(()=>opsWindow.getVisible());
        assert.equal(await opsWindow.webContents.executeJavaScript('window.detailPreserved'),true);
        const before=win.getContentSize()[0];
        win.setSize(before-100,win.getSize()[1]);
        await waitFor(()=>chat.getBounds().width+opsWindow.getBounds().width===win.getContentSize()[0]);
        assert.equal(opsWindow.getBounds().x,chat.getBounds().width);
        assert.equal(BrowserWindow.getAllWindows().length,1);
    });
    await check('operations OAuth rejects a mismatched state and reports user cancellation', async () => {
        assert(opsWindow);
        assert.equal(await opsWindow.webContents.executeJavaScript('window.adapterReady'), true);
        await opsWindow.webContents.executeJavaScript('store.state.userStore.token=null;localStorage.removeItem("ops-session");window.authResult=null; requestLogin(); void 0;');
        authWindow = await waitFor(() => embedded(url => url.includes('/authen/v1/authorize?')));
        await authWindow.webContents.executeJavaScript('location.href="https://ylops.jtexpress.com.cn/?code=synthetic&state=wrong#/auth-redirect"; void 0;');
        await waitFor(() => opsWindow.webContents.executeJavaScript('typeof window.authResult?.errMsg === "string"'));
        assert.equal(await opsWindow.webContents.executeJavaScript('window.authResult.code'), undefined);
        await opsWindow.webContents.executeJavaScript('store.state.userStore.token=null;localStorage.removeItem("ops-session");window.authResult=null; requestLogin(); void 0;');
        authWindow = await waitFor(() => embedded(url => url.includes('/authen/v1/authorize?')));
        authWindow.webContents.close();
        await waitFor(() => opsWindow.webContents.executeJavaScript('typeof window.authResult?.errMsg === "string"'));
        assert.equal(await opsWindow.webContents.executeJavaScript('window.authResult.code'), undefined);
    });
    await check('an unrelated window cannot request operations authorization over IPC', async () => {
        assert(opsWindow);
        const channel = [...ipcMain._invokeHandlers.keys()].find(value => value.startsWith('ops-auth:'));
        assert(channel);
        const preload = path.join(profile, 'untrusted-auth-preload.cjs');
        fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
            contextBridge.exposeInMainWorld('authAttempt',ipcRenderer.invoke(${JSON.stringify(channel)}));`);
        const untrusted = new BrowserWindow({show:false,webPreferences:{
            session:win.webContents.session,preload,sandbox:true,contextIsolation:true,nodeIntegration:false
        }});
        try {
            await untrusted.loadURL('https://video.example.test/untrusted');
            const result = await untrusted.webContents.executeJavaScript('authAttempt');
            assert.equal(result.code, undefined);
            assert(result.errMsg.includes('无权'));
            assert(!embedded(url => url.includes('/authen/v1/authorize?')));
        } finally {untrusted.destroy();}
    });
    await check('switching ticket hashes remounts the detail while keeping a valid business session', async () => {
        const authorizations=appRequests.filter(v=>v.endsWith('/authorize')).length;
        const exchanges=appRequests.filter(v=>v.endsWith('/fs_login/')).length;
        await opsWindow.webContents.executeJavaScript('store.state.userStore.token="synthetic-valid";localStorage.setItem("ops-session","synthetic-valid");window.oldTicketMarker=true;void 0;');
        const next='https://ylops-h5.jtexpress.com.cn/?lang=zh-CN&open_in_browser=true#/131825/fs-workflow-detail';
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(next)});void 0;`);
        await waitFor(()=>opsWindow.webContents.getURL()===next&&!opsWindow.webContents.isLoading());
        assert.equal(await opsWindow.webContents.executeJavaScript('window.fixtureTicketId'),'131825');
        assert.equal(await opsWindow.webContents.executeJavaScript('typeof window.oldTicketMarker'),'undefined');
        await waitFor(()=>opsWindow.webContents.executeJavaScript('window.authResult?.sessionReused===true'));
        assert.equal(appRequests.filter(v=>v.endsWith('/authorize')).length,authorizations);
        assert.equal(appRequests.filter(v=>v.endsWith('/fs_login/')).length,exchanges);
        const last=next.replace('131825','131826');
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(last)});void 0;`);
        await waitFor(()=>opsWindow.webContents.getURL()===last&&!opsWindow.webContents.isLoading());
        assert.equal(await opsWindow.webContents.executeJavaScript('window.fixtureTicketId'),'131826');
        assert.equal(BrowserWindow.getAllWindows().length,1);
    });
    await check('performance card completes official SSO in the right pane and returns to the current detail', async () => {
        const target='https://cloud.italent.cn/mrest/PerformanceCloud/PerformanceCloud/100000/PerformanceURL/RoutingV1?key=synthetic-card-key';
        const card=new URL('https://applink.feishu.cn/client/web_app/open');
        card.search=new URLSearchParams({appId:'cli_a4d0b2c8b8f9900c',path:'sso/page/feishu_v2/authorize',tenant_id:'synthetic-tenant',app_id:'100',appaccount_id:'synthetic-account',return_url:target});
        const externalCount=opened.length;
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(card.href)});void 0;`);
        const performance=await waitFor(()=>embedded(url=>url===target));
        await waitFor(()=>!performance.webContents.isLoading());
        assert(appRequests.includes('https://openapi.italent.cn/sso/page/feishu_v2/authorize'));
        assert(appRequests.includes('https://openapi.italent.cn/Appconnect_FeishuSSO/_GetFeiShuSignature'));
        assert(appRequests.includes('https://openapi.italent.cn/Appconnect_Authorize/IsFirstOpen'));
        assert(appRequests.includes('https://oapi.italent.cn/SSO/AuthCenter'));
        assert(!appRequests.includes('https://www.italent.cn/Login'));
        assert.equal(performance.getBounds().x,win.contentView.children.find(v=>v.webContents===win.webContents).getBounds().width);
        assert.equal(await performance.webContents.executeJavaScript('typeof require+":"+typeof larkDesktop+":"+typeof electronOpsAuth'),'undefined:undefined:undefined');
        await waitFor(()=>performance.webContents.getURL()===target&&!performance.webContents.isLoading());
        assert.equal(await performance.webContents.executeJavaScript('document.title'),'绩效详情测试');
        await performance.webContents.executeJavaScript('window.preservedPerformance=true');
        const requestCount=appRequests.length;
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(card.href)});void 0;`);
        await new Promise(resolve=>setTimeout(resolve,100));
        assert.equal(appRequests.length,requestCount);
        assert.equal(await performance.webContents.executeJavaScript('window.preservedPerformance'),true);
        const logins=appRequests.filter(v=>v==='https://www.italent.cn/Login').length;
        const next=target.replace('synthetic-card-key','synthetic-next-key');
        await win.webContents.executeJavaScript(`location.href=${JSON.stringify(next)};void 0;`);
        await waitFor(()=>performance.webContents.getURL()===next&&!performance.webContents.isLoading());
        assert.equal(await performance.webContents.executeJavaScript('document.title'),'绩效详情测试');
        assert.equal(appRequests.filter(v=>v==='https://www.italent.cn/Login').length,logins);
        assert.equal(opened.length,externalCount);
        assert.equal(BrowserWindow.getAllWindows().length,1);
        assert.equal(win.webContents.getURL(),base+'/');
    });
    for (const gate of ['rejectPerformanceSignature','rejectPerformanceFirstOpen']) {
        await check('performance SSO respects server denial: '+gate, async () => {
            fixture.state[gate]=true;
            const before=appRequests.filter(url=>url==='https://oapi.italent.cn/SSO/AuthCenter').length;
            const card=new URL('https://applink.feishu.cn/client/web_app/open');
            card.search=new URLSearchParams({appId:'cli_a4d0b2c8b8f9900c',path:'sso/page/feishu_v2/authorize',tenant_id:'synthetic-tenant',app_id:'100',appaccount_id:'synthetic-account',return_url:'https://cloud.italent.cn/mrest/PerformanceCloud/detail?key=synthetic-'+gate});
            await win.webContents.executeJavaScript(`window.open(${JSON.stringify(card.href)});void 0;`);
            const view=await waitFor(()=>embedded(url=>url.startsWith('https://openapi.italent.cn/')&&url.includes('code=')));
            await waitFor(()=>view.webContents.executeJavaScript('document.querySelector("#errordiv")?.style.display==="block"'));
            assert.equal(appRequests.filter(url=>url==='https://oapi.italent.cn/SSO/AuthCenter').length,before);
            fixture.state[gate]=false;
            await new Promise(resolve=>setTimeout(resolve,50));
            await win.webContents.executeJavaScript(`window.open(${JSON.stringify(card.href)});void 0;`);
            const target=card.searchParams.get('return_url');
            await waitFor(()=>view.webContents.getURL()===target&&!view.webContents.isLoading());
            assert.equal(await view.webContents.executeJavaScript('document.title'),'绩效详情测试');
        });
    }
    await check('a slow performance callback cannot replace a newer card that has not committed yet', async () => {
        const card=new URL('https://applink.feishu.cn/client/web_app/open');
        const target='https://cloud.italent.cn/mrest/PerformanceCloud/detail?key=synthetic-slow';
        card.search=new URLSearchParams({appId:'cli_a4d0b2c8b8f9900c',path:'sso/page/feishu_v2/authorize',tenant_id:'synthetic-tenant',app_id:'100',appaccount_id:'synthetic-account',return_url:target});
        const before=appRequests.filter(url=>url.endsWith('/IsFirstOpen')).length;
        fixture.state.delayPerformanceFirstOpen=200;
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(card.href)});void 0;`);
        await waitFor(()=>appRequests.filter(url=>url.endsWith('/IsFirstOpen')).length>before);
        fixture.state.delayPerformanceEntry=400;
        const next=target.replace('synthetic-slow','synthetic-latest');
        card.searchParams.set('return_url',next);
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(card.href)});void 0;`);
        const view=await waitFor(()=>embedded(url=>url===next));
        await waitFor(()=>!view.webContents.isLoading());
        assert.equal(await view.webContents.executeJavaScript('document.title'),'绩效详情测试');
        assert(!fixture.state.completedPerformanceTargets.includes(target));
    });
    await check('performance handoff cannot make the main process load a forged local URL', async () => {
        const {pathToFileURL}=require('node:url');
        const sentinel=path.join(profile,'synthetic-navigation-sentinel.html');
        fs.writeFileSync(sentinel,'<title>synthetic sentinel</title>');
        fixture.state.forgePerformanceHandoff=pathToFileURL(sentinel).href;
        const card=new URL('https://applink.feishu.cn/client/web_app/open');
        card.search=new URLSearchParams({appId:'cli_a4d0b2c8b8f9900c',path:'sso/page/feishu_v2/authorize',tenant_id:'synthetic-tenant',app_id:'100',appaccount_id:'synthetic-account',return_url:'https://cloud.italent.cn/mrest/PerformanceCloud/detail?key=synthetic-poison'});
        const count=appRequests.filter(url=>url.endsWith('/IsFirstOpen')).length;
        await win.webContents.executeJavaScript(`window.open(${JSON.stringify(card.href)});void 0;`);
        const view=await waitFor(()=>embedded(url=>url.startsWith('https://openapi.italent.cn/')&&url.includes('code=')));
        await waitFor(()=>appRequests.filter(url=>url.endsWith('/IsFirstOpen')).length>count);
        await new Promise(resolve=>setTimeout(resolve,100));
        assert.equal(new URL(view.webContents.getURL()).origin,'https://openapi.italent.cn');
        assert.equal(BrowserWindow.getAllWindows().length,1);
        fixture.state.forgePerformanceHandoff=null;
    });
    await check('right-click image address copies using the current clipboard API', async () => {
        savedClipboard = await Promise.all((await clipboard.read()).map(async item =>
            new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))
        ));
        win.webContents.emit('context-menu', {}, {
            x: 0, y: 0, linkURL: '', linkText: '', srcURL: `${base}/image.png`, mediaType: 'image',
            hasImageContents: true, selectionText: '', titleText: '', altText: '', isEditable: false,
            misspelledWord: '', dictionarySuggestions: [], inputFieldType: 'none',
            spellcheckEnabled: false, frame: null, menuSourceType: 'mouse',
            editFlags: {canCut: false, canCopy: false, canPaste: false, canSelectAll: false},
            mediaFlags: {canSave: true}
        });
        const item = contextMenu.items.find(item => item.id === 'copyImageAddress');
        assert(item);
        await item.click(item);
        await waitFor(async () => (await clipboard.readText()) === `${base}/image.png`);
        await clipboard.write(savedClipboard);
        savedClipboard = undefined;
    });
    await check('notification bridge survives a page reload', async () => {
        if (opsWindow && !(!opsWindow.webContents || opsWindow.webContents.isDestroyed())) {
            await opsWindow.webContents.executeJavaScript('store.state.userStore.token=null;requestLogin(); void 0;');
            authWindow = await waitFor(() => embedded(url => url.includes('/authen/v1/authorize?')));
        }
        win.webContents.reload();
        await waitFor(() => !win.webContents.isLoading());
        if (appWindow) assert((!appWindow.webContents || appWindow.webContents.isDestroyed()), 'chat navigation ends the old application window lifecycle');
        if (opsWindow) assert((!opsWindow.webContents || opsWindow.webContents.isDestroyed()));
        if (authWindow) assert((!authWindow.webContents || authWindow.webContents.isDestroyed()), 'pending OAuth closes with the work order window');
        await waitFor(() => win.webContents.executeJavaScript("window.Notification.name === 'newNotification'"));
        const listeners = ipcMain.rawListeners('notification');
        ipcMain.removeAllListeners('notification');
        let payload;
        ipcMain.once('notification', (event, message) => { payload = JSON.parse(message); });
        try {
            await win.webContents.executeJavaScript("new Notification('Local upgrade test', {body: 'test', channelId: 'test'}); void 0;");
            await waitFor(() => payload);
            assert.equal(payload.title, 'Local upgrade test');
            assert.equal(payload.opt.channelId, 'test');
        } finally {
            ipcMain.removeAllListeners('notification');
            for (const listener of listeners) ipcMain.on('notification', listener);
        }
    });
    await check('native notification clicks restore the app and invoke the original message callback', async () => {
        const count=nativeNotifications.length;
        await win.webContents.executeJavaScript(`
            window.notificationRoute=null;
            const notice=new Notification('Same title',{body:'Same text',data:{chat:'virtual-chat',message:'message-1'}});
            notice.onclick=function(event){window.notificationRoute={chat:this.data.chat,message:this.data.message,target:event.target===notice};};
            notice.addEventListener('click',()=>{window.notificationListenerFired=true;});
            void 0;
        `);
        const native=await waitFor(()=>nativeNotifications[count]);
        win.minimize();win.hide();
        native.emit('click');
        await waitFor(()=>win.isVisible()&&!win.isMinimized());
        await waitFor(()=>win.webContents.executeJavaScript('window.notificationRoute?.message==="message-1"'));
        assert.deepEqual(await win.webContents.executeJavaScript('window.notificationRoute'),{chat:'virtual-chat',message:'message-1',target:true});
        assert.equal(await win.webContents.executeJavaScript('window.notificationListenerFired'),true);
        win.webContents.reload();
        await waitFor(()=>!win.webContents.isLoading());
        await waitFor(()=>win.webContents.executeJavaScript('window.Notification.name==="newNotification"'));
        await win.webContents.executeJavaScript(`
            window.notificationRoute=null;
            const notice=new Notification('Same title',{body:'Same text',data:{chat:'another-chat',message:'message-2'}});
            notice.onclick=function(){window.notificationRoute=this.data;};void 0;
        `);
        const current=await waitFor(()=>nativeNotifications[count+1]);
        assert.equal(native.closed,true,'old native notifications must close when their callback document reloads');
        win.hide();
        native.emit('click');
        await new Promise(resolve=>setTimeout(resolve,50));
        assert.equal(win.isVisible(),false,'stale notifications must not wake the application');
        assert.equal(await win.webContents.executeJavaScript('window.notificationRoute'),null);
        current.emit('click');
        await waitFor(()=>win.webContents.executeJavaScript('window.notificationRoute?.message==="message-2"'));
        assert.equal(BrowserWindow.getAllWindows().length,1);
    });
    async function enter(modifiers = []) {
        win.webContents.focus();
        await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => resolve()))');
        win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Enter', modifiers});
        win.webContents.sendInputEvent({type: 'char', keyCode: '\r', modifiers});
        win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Enter', modifiers});
        await win.webContents.executeJavaScript('void 0');
    }
    await check('plain Enter inserts a newline instead of sending', async () => {
        win.show(); win.focus();
        app.focus({steal:true});
        await win.webContents.executeJavaScript('resetChat()');
        await enter();
        await waitFor(()=>win.webContents.executeJavaScript('chatResult().newlines > 0 || chatResult().sent.length > 0'));
        const result = await win.webContents.executeJavaScript('chatResult()');
        assert.equal(result.sent.length, 0);
        assert.equal(result.newlines, 1, JSON.stringify(result));
    });
    await check('Command Enter sends once without inserting a newline', async () => {
        await win.webContents.executeJavaScript('resetChat()');
        await enter(['meta']);
        const result = await win.webContents.executeJavaScript('chatResult()');
        assert.deepEqual(result.sent, ['draft']);
        assert.equal(result.newlines, 0);
    });
    await check('Shift Enter continues to insert a newline', async () => {
        await win.webContents.executeJavaScript('resetChat()');
        await enter(['shift']);
        const result = await win.webContents.executeJavaScript('chatResult()');
        assert.equal(result.sent.length, 0);
        assert.equal(result.newlines, 1, JSON.stringify(result));
    });
    await check('composition and repeated Command Enter cannot send', async () => {
        const result = await win.webContents.executeJavaScript(`
            resetChat();
            editor.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
            editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', keyCode:229, metaKey:true, isComposing:true, bubbles:true, cancelable:true}));
            editor.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true}));
            editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', keyCode:13, metaKey:true, repeat:true, bubbles:true, cancelable:true}));
            chatResult();
        `);
        assert.equal(result.sent.length, 0);
        assert.equal(result.newlines, 0);
    });
    await check('unrelated editable fields keep their original Enter behavior', async () => {
        await win.webContents.executeJavaScript('resetChat(); document.querySelector("#other").focus();');
        await enter();
        assert.equal(await win.webContents.executeJavaScript('otherEnterShift'), false);
    });
    await check('settings save and reload from the user data directory', async () => {
        const item = Menu.getApplicationMenu().items.find(i => i.label === '设置').submenu.items.find(i => i.label === '功能设置');
        item.click();
        let settings = await waitFor(() => BrowserWindow.getAllWindows().find(w => w !== win));
        await waitFor(() => !settings.webContents.isLoading());
        await waitFor(() => settings.webContents.executeJavaScript(`pageData.startPageLink === '${base}'`));
        assert.equal(await settings.webContents.executeJavaScript('typeof require'),'undefined');
        await settings.webContents.executeJavaScript('pageData.showWarterMark = false; saveConfig();');
        await waitFor(() => {
            try { return JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).showWarterMark === false; }
            catch { return false; }
        });
        await new Promise(resolve=>{settings.once('closed',resolve);settings.close();});
        item.click();
        settings = await waitFor(() => BrowserWindow.getAllWindows().find(w => w !== win));
        await waitFor(() => !settings.webContents.isLoading());
        await waitFor(() => settings.webContents.executeJavaScript(`pageData.startPageLink === '${base}'`));
        assert.equal(await settings.webContents.executeJavaScript('pageData.showWarterMark'), false);
        await settings.webContents.executeJavaScript(`showPage('jev-set');pageData.assistant.skills=[{id:'synthetic',name:'合成技能',path:${JSON.stringify(path.resolve(__dirname,'fixtures/synthetic-skill/SKILL.md'))}}]`);
        await waitFor(()=>settings.webContents.executeJavaScript('!!document.querySelector("#codex-effort")'));
        await settings.webContents.executeJavaScript('document.querySelector("#codex-effort").value="high";document.querySelector("#codex-effort").dispatchEvent(new Event("change"));document.querySelector("#reply-mode").value="firm";document.querySelector("#reply-mode").dispatchEvent(new Event("change"));saveConfig();');
        await waitFor(()=>JSON.parse(fs.readFileSync(path.join(profile,'config.json'))).assistant?.codexReasoningEffort==='high');
        assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'config.json'))).assistant.skills[0].id,'synthetic');
        assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'config.json'))).assistant.defaultReplyMode,'firm');
        assert.equal(await settings.webContents.executeJavaScript('!!document.querySelector("#codex-effort option[value=none]")'),true);
        settings.close();
    });
    await check('another window cannot use the private settings IPC',async()=>{
        const outsider=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,preload:path.resolve(__dirname,'../src/windows/settings-preload.js')}});
        await outsider.loadURL(base);
        assert.equal(await outsider.webContents.executeJavaScript('desktopSettings.read().then(()=>false,()=>true)'),true);
        assert.equal(await outsider.webContents.executeJavaScript('desktopSettings.save({showWarterMark:true}).then(()=>false,()=>true)'),true);
        assert.equal(await outsider.webContents.executeJavaScript('desktopSettings.pickSkill().then(()=>false,()=>true)'),true);
        assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'config.json'))).showWarterMark,false);
        outsider.destroy();
        assert.equal(await win.webContents.executeJavaScript('typeof require'), 'undefined');
        assert.equal(await win.webContents.executeJavaScript('typeof desktopSettings'), 'undefined');
    });
    await check('Dock activation restores the main window', async () => {
        win.hide(); app.emit('activate'); assert(win.isVisible());
    });
    await check('quit bypasses close-to-tray', async () => {
        app.emit('before-quit');
        let prevented = false;
        win.emit('close', {preventDefault() { prevented = true; }});
        assert.equal(prevented, false);
    });
    if (savedClipboard) await clipboard.write(savedClipboard);
    shell.openExternal = originalOpenExternal;
    Menu.prototype.popup = originalPopup;
    server.close();
    clearTimeout(timeout);
    console.log(`RESULT ${failures} failures; Electron ${process.versions.electron}; Chromium ${process.versions.chrome}`);
    app.exit(failures ? 1 : 0);
});
