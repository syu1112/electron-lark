const { app, BrowserWindow, Menu, shell, clipboard, ClipboardItem, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

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
    catch (error) { failures++; console.error('FAIL', name, error.message); }
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
    require('../src/main.js');
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
        win.webContents.reload();
        await waitFor(() => !win.webContents.isLoading());
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
