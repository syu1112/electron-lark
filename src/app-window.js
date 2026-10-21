'use strict';

const {WebContentsView, dialog, ipcMain, screen} = require('electron');
const {parseWebAppLink} = require('./applink');
const {randomUUID} = require('node:crypto');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {installOpsAuth} = require('./ops-auth');
const {reuseSandstalkSession} = require('./sandstalk-session');
const {completePerformanceHandoff} = require('./performance-session');

function createAppWindows(ownerWindow, chatView) {
    const apps = new Map();
    const views = new Set();
    const channel = `app-panel:${randomUUID()}`;
    const headerURL = pathToFileURL(path.join(__dirname, 'app-panel.html')).href;
    const webPreferences = {
        session: ownerWindow.webContents.session,
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        additionalArguments: []
    };
    const header = new WebContentsView({webPreferences: {
        ...webPreferences, preload: path.join(__dirname, 'app-panel-preload.js'),
        additionalArguments: [`--app-panel-channel=${channel}`]
    }});
    let active;
    let disposed = false;
    ownerWindow.contentView.addChildView(chatView);
    ownerWindow.contentView.addChildView(header);
    header.setVisible(false);
    header.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    header.webContents.on('will-navigate', event => event.preventDefault());
    header.webContents.loadURL(headerURL);

    function layout() {
        if (disposed || ownerWindow.isDestroyed()) return;
        const [width, height] = ownerWindow.getContentSize();
        const panelWidth = active ? Math.min(640, Math.round(width * 0.38)) : 0;
        const chatWidth = width - panelWidth;
        chatView.setBounds({x: 0, y: 0, width: chatWidth, height});
        header.setVisible(!!active);
        header.setBounds({x: chatWidth, y: 0, width: panelWidth, height: 44});
        for (const entry of apps.values()) {
            const top = entry.children.at(-1) || entry.view;
            for (const view of [entry.view, ...entry.children]) {
                view.setVisible(entry === active && view === top);
                view.setBounds({x: chatWidth, y: 44, width: panelWidth, height: Math.max(0, height - 44)});
            }
        }
        header.webContents.send(channel, {
            apps: [...apps.values()].map(entry => ({id: entry.appId, title: entry.title})),
            active: active?.appId, back: !!active?.children.length
        });
    }
    function select(entry) {
        active = entry;
        if (ownerWindow.getContentSize()[0] < 1150) {
            const area = screen.getDisplayMatching(ownerWindow.getBounds()).workArea;
            ownerWindow.setSize(Math.min(1520, area.width), ownerWindow.getSize()[1]);
        }
        layout();
        if (ownerWindow.isMinimized()) ownerWindow.restore();
        ownerWindow.show();
        (entry.children.at(-1) || entry.view).webContents.focus();
    }
    function closeView(view) {
        const contents = view.webContents;
        if (contents && !contents.isDestroyed()) contents.close({waitForBeforeUnload: false});
    }
    function configure(view, entry) {
        views.add(view);
        const contents = view.webContents;
        contents.setUserAgent(ownerWindow.webContents.getUserAgent());
        contents.once('destroyed', () => {
            views.delete(view);
            if (disposed) return;
            ownerWindow.contentView.removeChildView(view);
            entry.children = entry.children.filter(child => child !== view);
            if (view === entry.view) {
                for (const child of [...entry.children]) closeView(child);
                apps.delete(entry.appId);
                if (active === entry) active = undefined;
            }
            layout();
        });
        const guard = (event, url) => {
            if (!url.startsWith('https://') && url !== 'about:blank') event.preventDefault();
        };
        contents.on('will-navigate', guard);
        contents.on('will-redirect', guard);
        contents.setWindowOpenHandler(details => {
            if (handleLink(details.url)) return {action: 'deny'};
            if (!details.url.startsWith('https://') && details.url !== 'about:blank') return {action: 'deny'};
            return {
                action: 'allow', overrideBrowserWindowOptions: {webPreferences: {...webPreferences}},
                createWindow: options => {
                    const child = createChild(entry, {webContents: options.webContents, webPreferences});
                    if (details.disposition === 'background-tab') child.webContents.loadURL(details.url).catch(() => {});
                    return child.webContents;
                }
            };
        });
    }
    function createChild(entry, options = {webPreferences}) {
        const view = new WebContentsView({...options, webPreferences: {...webPreferences}});
        entry.children.push(view);
        ownerWindow.contentView.addChildView(view);
        configure(view, entry);
        select(entry);
        return view;
    }
    function closeAll() {
        active = undefined;
        for (const view of [...views]) closeView(view);
        apps.clear();
        layout();
    }
    ownerWindow.once('closed', () => {
        disposed = true;
        closeAll();
        header.webContents.close();
        ipcMain.removeHandler(channel);
    });
    ownerWindow.webContents.on('did-navigate', closeAll);
    ownerWindow.on('resize', layout);
    header.webContents.on('did-finish-load', layout);
    ipcMain.handle(channel, (event, action, id) => {
        if (event.sender !== header.webContents || event.senderFrame !== header.webContents.mainFrame ||
            event.senderFrame.url !== headerURL) return;
        if (action === 'select' && apps.has(id)) select(apps.get(id));
        if (!active) return;
        if (action === 'back' && active.children.length) closeView(active.children.at(-1));
        if (action === 'reload') (active.children.at(-1) || active.view).webContents.reload();
        if (action === 'close') {
            for (const child of [...active.children]) closeView(child);
            active = undefined;
            layout();
            ownerWindow.webContents.focus();
        }
    });

    function handleLink(url) {
        let application;
        try { application = parseWebAppLink(url); }
        catch (error) {
            dialog.showMessageBox(ownerWindow, {type: 'error', message: '无法打开企业应用', detail: error.message});
            return true;
        }
        if (!application) return false;
        const {appId, title, targetUrl} = application;
        let entry = apps.get(appId);
        if (!entry) {
            const authChannel = appId === 'ylops' ? `ops-auth:${randomUUID()}` : null;
            const view = new WebContentsView({webPreferences: authChannel ? {
                ...webPreferences, preload: path.join(__dirname, 'ops-preload.js'),
                additionalArguments: [`--ops-auth-channel=${authChannel}`]
            } : webPreferences});
            entry = {appId, title, view, targetUrl: null, children: []};
            apps.set(appId, entry);
            ownerWindow.contentView.addChildView(view);
            configure(view, entry);
            if (appId === 'ylops') {
                const contents = view.webContents;
                contents.on('did-navigate-in-page', (_event, value, isMainFrame) => {
                    if (isMainFrame && entry.ticketReloadUrl === value && entry.targetUrl === value) {
                        entry.ticketReloadUrl = null;
                        contents.reload();
                    }
                });
            }
            if (appId === 'italent') {
                const contents = view.webContents;
                contents.on('did-finish-load', () => {
                    const requested = entry.targetUrl;
                    const current = new URL(contents.getURL());
                    if (current.origin === 'https://openapi.italent.cn' && current.pathname === '/sso/page/feishu_v2/authorize') {
                        const callback = contents.getURL();
                        contents.executeJavaScript(`(${completePerformanceHandoff.toString()})(${JSON.stringify(requested)})`).then(result => {
                            if (!contents.isDestroyed() && entry.targetUrl === requested && contents.getURL() === callback) {
                                entry.ssoFailed = result === 'failed';
                                if (typeof result === 'string' && result !== 'failed') {
                                    let destination;
                                    try {
                                        destination = new URL(result);
                                        const business = new URL(destination.searchParams.get('return_url'));
                                        if (destination.origin !== 'https://oapi.italent.cn' || destination.pathname !== '/SSO/AuthCenter' ||
                                            destination.username || destination.password || destination.searchParams.getAll('id_token').length !== 1 ||
                                            !destination.searchParams.get('id_token') || destination.searchParams.getAll('return_url').length !== 1 ||
                                            business.origin !== 'https://cloud.italent.cn' || !business.pathname.startsWith('/mrest/PerformanceCloud/') ||
                                            business.username || business.password || business.href !== new URL(requested).searchParams.get('return_url')) {
                                            entry.ssoFailed = true;
                                            return;
                                        }
                                    } catch {entry.ssoFailed = true; return;}
                                    contents.loadURL(destination.href).catch(() => {});
                                }
                            }
                        }).catch(() => {});
                        return;
                    }
                    if (!requested || contents.getURL() !== requested || current.origin !== 'https://cloud.italent.cn') return;
                    contents.executeJavaScript(`(() => {
                        try { return JSON.parse(document.body.innerText).code === 417; }
                        catch { return false; }
                    })()`).then(needsLogin => {
                        if (contents.isDestroyed() || entry.targetUrl !== requested || contents.getURL() !== requested) return;
                        if (!needsLogin) {entry.loginTarget = null; return;}
                        if (entry.loginTarget === requested) return;
                        entry.loginTarget = requested;
                        const login = new URL('https://www.italent.cn/Login');
                        login.searchParams.set('ReturnUrl', requested);
                        contents.loadURL(login.href).catch(() => {});
                    }).catch(() => {});
                });
            }
            if (appId === 'cli_a4f419c5067d9013') {
                const contents = view.webContents;
                let checking;
                const reuseSession = (event, value) => {
                    const destination = new URL(value);
                    const oauth = destination.origin === 'https://open.feishu.cn' &&
                        destination.pathname === '/open-apis/authen/v1/index' &&
                        destination.searchParams.get('app_id') === appId;
                    const mobile = destination.origin === 'https://edu.sandstalk.com' &&
                        destination.pathname === '/web/' && destination.hash.startsWith('#/login?shareType=1&');
                    if ((!oauth && !mobile) || new URL(contents.getURL()).origin !== 'https://edu.sandstalk.com') return;
                    event.preventDefault();
                    const requested = entry.targetUrl;
                    if (checking?.requested === requested) return;
                    const check = {requested};
                    checking = check;
                    contents.executeJavaScript(`(${reuseSandstalkSession.toString()})(${JSON.stringify(requested)},${JSON.stringify(mobile ? value : null)})`)
                        .catch(() => false).then(destination => {
                            if (checking !== check || contents.isDestroyed() || entry.targetUrl !== requested) return;
                            checking = undefined;
                            contents.loadURL(destination || value).catch(() => {});
                        });
                };
                contents.on('will-navigate', reuseSession);
                contents.on('will-redirect', reuseSession);
            }
            if (authChannel) installOpsAuth(view.webContents, authChannel, () => createChild(entry), () => {
                if (active === entry) {active = undefined; layout();}
            });
            view.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
                if (!isMainFrame || code === -3) return;
                entry.targetUrl = null;
                dialog.showMessageBox(ownerWindow, {
                    type: 'error', message: `${title}页面加载失败`,
                    detail: '请检查网络连接，然后重新点击消息中的应用链接重试。'
                });
            });
        }
        if (entry.targetUrl !== targetUrl || entry.ssoFailed) {
            entry.ssoFailed = false;
            for (const child of [...entry.children]) closeView(child);
            entry.ticketReloadUrl = appId === 'ylops' && entry.view.webContents.getURL().split('#')[0] === targetUrl.split('#')[0] ? targetUrl : null;
            entry.targetUrl = targetUrl;
            entry.view.webContents.loadURL(targetUrl).catch(() => {});
        }
        select(entry);
        return true;
    }
    layout();
    return {handleLink};
}

module.exports = {createAppWindows};
