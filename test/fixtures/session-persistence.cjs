'use strict';
const {app, BrowserWindow, WebContentsView} = require('electron');
const assert = require('node:assert/strict');
const {createWebAppFixture} = require('./web-app-sites.cjs');
const {createAppWindows} = require('../../src/app-window');
const [profile, phase] = process.argv.slice(2);
app.setPath('userData', profile);
app.commandLine.appendSwitch('use-mock-keychain');
app.on('window-all-closed',()=>{});
const timer = setTimeout(() => {console.error('Persistence test timeout');app.exit(1);}, 20000);
async function waitFor(check) {
    for (let i=0;i<200;i++) {
        const result=await check();
        if(result) return result;
        await new Promise(resolve=>setTimeout(resolve,30));
    }
    throw Error('Persistence behavior timed out');
}
app.whenReady().then(async()=>{
    const chat = new WebContentsView();
    const win = new BrowserWindow({show:false,width:1500,webContents:chat.webContents});
    await win.loadURL('about:blank');
    const fixture = createWebAppFixture(chat.webContents.session.cookies);
    chat.webContents.session.protocol.handle('https', fixture.handle);
    if(phase==='seed') {
        const seed = new WebContentsView({webPreferences:{session:chat.webContents.session}});
        await seed.webContents.loadURL('https://ylops-h5.jtexpress.com.cn/');
        await seed.webContents.executeJavaScript('localStorage.setItem("ops-session","synthetic-valid")');
        await seed.webContents.loadURL('https://edu.sandstalk.com/#/cache-fixture');
        await seed.webContents.executeJavaScript('localStorage.setItem("business-session","synthetic")');
        await chat.webContents.session.cookies.set({url:'https://ylops-h5.jtexpress.com.cn',name:'business-cookie',value:'synthetic',secure:true,expirationDate:Date.now()/1000+3600});
        await chat.webContents.session.cookies.set({url:'https://cloud.italent.cn',domain:'.italent.cn',path:'/',name:'italent-session',value:'synthetic-valid',secure:true,expirationDate:Date.now()/1000+3600});
        chat.webContents.session.flushStorageData();
        await chat.webContents.session.cookies.flushStore();
        seed.webContents.close();
    } else {
        const panel=createAppWindows(win,chat);
        panel.handleLink('https://ylops-h5.jtexpress.com.cn/?lang=zh-CN#/131824/fs-workflow-detail');
        const ops=await waitFor(()=>win.contentView.children.find(v=>v.webContents && v.webContents.getURL().startsWith('https://ylops-h5.jtexpress.com.cn')));
        await waitFor(()=>ops.webContents.executeJavaScript('window.authResult?.sessionReused===true'));
        assert.equal((await chat.webContents.session.cookies.get({name:'business-cookie'})).length,1);
        panel.handleLink('https://applink.feishu.cn/client/web_app/open?appId=cli_a4f419c5067d9013&lk_target_url='+encodeURIComponent('https://edu.sandstalk.com/#/Transit?appId=cli_a4f419c5067d9013&state=feishu_jump&jumpModuleId=980372545410711612&jumpType=700'));
        await waitFor(()=>win.contentView.children.some(v=>v.webContents?.getURL()==='https://video.example.test/player?id=980372545410711612'));
        assert(!fixture.requests.some(url=>url.includes('https://open.feishu.cn/')),'valid persisted sessions should not restart OAuth');
        const performanceTarget='https://cloud.italent.cn/mrest/PerformanceCloud/PerformanceCloud/100000/PerformanceURL/RoutingV1?key=synthetic-persisted-card';
        panel.handleLink(performanceTarget);
        const performance=await waitFor(()=>win.contentView.children.find(v=>v.webContents?.getURL()===performanceTarget));
        await waitFor(()=>!performance.webContents.isLoading());
        assert.equal(await performance.webContents.executeJavaScript('document.title'),'绩效详情测试');
        assert(!fixture.requests.includes('https://www.italent.cn/Login'),'a valid persisted performance cookie should open the detail directly');
        assert.equal(BrowserWindow.getAllWindows().length,1);
        // Closing the host must release embedded pages and pending IPC handlers.
        const children=win.contentView.children.map(view=>view.webContents).filter(wc=>wc&&wc!==chat.webContents);
        win.destroy();
        await waitFor(()=>children.every(wc=>wc.isDestroyed()));
    }
    clearTimeout(timer);
    console.log('PASS persistence phase '+phase);
    app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1);});
