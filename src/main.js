'use strict';

const appConf = require("./configuration")

const electron = require('electron')
const fs = require('fs')
const path = require('path');
const {pathToFileURL}=require('url');
const {createSettingsStore}=require('./assistant/settings-store');
const {createJevClient}=require('./assistant/jev-client');
const {generateReplies}=require('./assistant/codex-replies');
const {createAnalysisService}=require('./assistant/analysis-service');
const {readSkill}=require('./assistant/skills');
const {randomUUID}=require('node:crypto');
const settingsStore=createSettingsStore({configFile:appConf.configFile,safeStorage:electron.safeStorage});
const analysisService=createAnalysisService({settingsStore,jevClient:createJevClient(),generateReplies});
const updateChecker = require('./updateChecker')

const shell = electron.shell;
const app = electron.app;
const ipcMain = electron.ipcMain;
const BrowserWindow = electron.BrowserWindow;
const Notification = electron.Notification;
const Menu = electron.Menu;

const rightClickContextMenu = require('electron-context-menu').default;

rightClickContextMenu({
    showInspectElement: false,
    showCopyImage: true,
    showCopyImageAddress: true,
    showSaveImageAs: true,
    labels: {
        copy: '复制',
        copyImage: '复制图片',
        copyImageAddress: '复制图片地址',
        saveImageAs: '图片另存为',
    },
});

if (process.mas) app.setName('飞书Feishu');
// fixup High CPU Usage issue
// see https://github.com/electron/electron/issues/11908
app.disableHardwareAcceleration();

// 是否处于焦点，检点监听
let onFocus = false;
app.on('browser-window-blur', function () {
    onFocus = false;
})
app.on('browser-window-focus', function () {
    onFocus = true;
})

let newAppTray = null;
const isMac = process.platform === 'darwin';
const dock32Icon = electron.nativeImage.createFromPath(isMac ? appConf.macTray : appConf.dock32)
const dock32EmptyIcon = electron.nativeImage.createFromPath(isMac ? appConf.macTrayEmpty : appConf.dock32Empty)
if (isMac) {
    dock32Icon.setTemplateImage(true);
    dock32EmptyIcon.setTemplateImage(true);
}

// // 菜单 Template 
// const appMenu = require("./windows/app_menu")

const globalShortcut = electron.globalShortcut;

let mainWindow
let settingsWindow=null;
let configuredOrigin='';
const settingsURL=pathToFileURL(path.join(__dirname,'windows/views/settings.html')).href;
let isQuitting = false;

app.on('before-quit', () => {
    isQuitting = true;
});
let webContents

function createWindow(configJson) {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 770,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, 'chat-preload.js')
        },
        icon: appConf.icon128
    })

    // mainWindow.loadFile('index.html')
    // 改为使用loadURL加载飞书地址
    let loadUrl = "https://feishu.cn/messenger/";
    if (configJson.startPageLink !== undefined
        && configJson.startPageLink != null
        && configJson.startPageLink.trim() != "") {
        loadUrl = configJson.startPageLink
    }
    configuredOrigin=new URL(loadUrl).origin;
    mainWindow.loadURL(loadUrl, { userAgent: app.userAgentFallback })
    webContents = mainWindow.webContents
    const ownerId=webContents.id;
    webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)analysisService.cancelOwner(ownerId);});
    webContents.on('destroyed',()=>analysisService.cancelOwner(ownerId));
    mainWindow.on('closed', function () {
        mainWindow = null
    })

    mainWindow.on('close', (event) => {
        if (isQuitting) return;
        mainWindow.hide();
        mainWindow.setSkipTaskbar(true);
        event.preventDefault();
    });

    let showWarterMark = false;
    if(configJson.showWarterMark !== undefined
        && configJson.showWarterMark != null) {
        showWarterMark = configJson.showWarterMark;
    }

    // 窗口加载完成后运行
    // 关于图标的闪烁，方法是每1.5s做一个轮询，查看是否有未读消息提醒，如果有的话就闪烁
    // 侧边栏 class 为 larkc-badge-count circle navbarMenu-badge larkc-badge-normal
    let unreadTimer;
    webContents.on('destroyed',()=>clearInterval(unreadTimer));
    webContents.on("did-finish-load", function() {
        clearInterval(unreadTimer);
        unreadTimer=setInterval(() => {
            if(mainWindow == null || !mainWindow.isVisible()){
                return
            }
            webContents.executeJavaScript(`document.getElementsByClassName('larkc-badge-count circle larkc-badge-normal').length`)
                .then(function(result){
                    if(parseInt(result) > 0) {
                        startBlingIcon();
                    } else {
                        stopBlingIcon();
                    }
                })
            if(!showWarterMark) {
                webContents.executeJavaScript(`if(document.getElementsByClassName('lark-water-mark-main').length > 0) document.getElementsByClassName('lark-water-mark-main')[0].remove()`)
            }
        }, 1500);
        
        // 注入 js，hack html5 的 Notification 接口，并将通知内容转发到 main.js 里
        webContents.executeJavaScript(`
            let oldNotification = window.Notification;
            let newNotification = function(title, opt){
                if(window.larkDesktop) {
                    try {
                        window.larkDesktop.notify(title,opt);
                    } catch (e) {
                        return new oldNotification(title,opt);
                    }
                } else {
                    return new oldNotification(title,opt);
                }
            }
            newNotification.requestPermission = oldNotification.requestPermission.bind(oldNotification);
            Object.defineProperty(newNotification, 'permission', {
                get: () => {
                    return oldNotification.permission;
                }
            });
            window.Notification = newNotification;
            void 0;`);
        webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'chat-shortcuts.js'),'utf8'));

            // 在页面加载完成之后，检查新版本信息
            updateChecker.checkInAppStart();
    })

    // 定义在 electron 内部打开的 url，除此之外的 url 都跳转浏览器打开，使用 indexOf >= 0 来判断
    let electronUrl = [
    ]
    if (configJson.larkOpenLink !== undefined && configJson.larkOpenLink !== null){
        electronUrl = ("" + configJson.larkOpenLink).split("\n")
    }

    webContents.setWindowOpenHandler(({ url }) => {
        const openInElectron = electronUrl.some(link => link.trim() !== "" && url.includes(link));
        if (openInElectron) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 1200,
                    height: 600,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true
                    }
                }
            };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // 打开开发者模式
    // mainWindow.toggleDevTools()
}

let blingCount = 0;
let blingTimer = null;
let bling = false;
function startBlingIcon() {
    // 部分修复ubuntu18.04 下面锁屏之后 dock 图标一直不显示的问题
    // 每次 start bling 之前重新设置一遍
    // 保证哪怕因为锁屏而 dock 图标消失之后，收到新消息也可以闪烁
    // appTray.appTray.destroy()
    // appTray.init(electron, app, mainWindow)

    // 如果是焦点的话，就不闪烁
    if (onFocus && mainWindow.isVisible()) {
        stopBlingIcon()
        return
    }
    if (blingTimer != null) {
        return
    }
    bling = true;
    blingTimer = setInterval(function () {
        blingCount++;
        if (blingCount % 2 == 0) {
            newAppTray.setImage(dock32EmptyIcon)
        } else {
            newAppTray.setImage(dock32Icon)
        }
        // 避免 count 无限增大
        if(blingCount == 1000) blingCount = 0
    }, 500);
}

function stopBlingIcon() {
    if(bling) {
        if (blingTimer != null) {
            clearInterval(blingTimer)
            blingTimer = null;
        }
        newAppTray.setImage(dock32Icon)
        bling = false;
    }
}


// 修复 Application Menu上图标不显示
if (process.env.XDG_CURRENT_DESKTOP == 'ubuntu:GNOME') {
    process.env.XDG_CURRENT_DESKTOP = 'Unity';
}

const trayMenuTemplate = [
    {
        label: '显示主界面',
        click: function(){
            if(mainWindow != null){
                mainWindow.show()
            }
        }
    },
    {
        label: '退出',
        click: function(){
            console.log("从 tray 退出")
            app.quit();
        }
    }
];
const contextMenu = electron.Menu.buildFromTemplate(trayMenuTemplate)

function appTrayInit(){
    newAppTray = new electron.Tray(dock32Icon);
    newAppTray.setToolTip('Feishu');
    newAppTray.setContextMenu(contextMenu);
    newAppTray.on('click',function () {
        stopBlingIcon();
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
        mainWindow.isVisible() ? mainWindow.setSkipTaskbar(false) : mainWindow.setSkipTaskbar(true);
    })
    newAppTray.on('double-click', function() {
        if(mainWindow != null && !mainWindow.isVisible()){
            mainWindow.show()
        }
    })
}

function getConfigJson(callback){
    fs.readFile(appConf.configFile,'utf-8',function(err,data){
        if(err){
            console.error("load config error, may be have no config file~");
            callback({})
        }
        else{
            try {callback(JSON.parse(data));} catch {callback({});}
        }
    });
}

// ------------------------ 程序菜单 --------------------------------
/**
 * 注册键盘快捷键
 * 其中：label: '切换开发者工具',这个可以在发布时注释掉
 */
let menuTemplate = [
    {
        label: '操作',
        submenu: [
            {
                label: '浏览器打开',
                click: function (item, focusedWindow) {
                    console.log("open in browser:" + focusedWindow.webContents.getURL());
                    require('electron').shell.openExternal(focusedWindow.webContents.getURL())
                }
            },
            {
                label: '最小化',
                // accelerator: 'CmdOrCtrl+M',
                role: 'minimize'
            }, 
            // {
            //     label: '关闭窗口',
            //     accelerator: 'CmdOrCtrl+W',
            //     role: 'close'
            // }, 
            {
                label: '退出程序',
                click: function (item, focusedWindow) {
                    app.quit();
                    // openSettingsWindows();
                }
            }, 
        ]
    },
    {
        label: '设置',
        role: 'window',
        submenu: [
            {
                label: '功能设置',
                click: function (item, focusedWindow) {
                    openSettingsWindows();
                }
            }, 
            {
                label: '切换开发者工具',
                accelerator: (function () {
                    if (process.platform === 'darwin') {
                        return 'Alt+Command+I'
                    } else {
                        return 'Ctrl+Shift+I'
                    }
                })(),
                click: function (item, focusedWindow) {
                    if (focusedWindow) {
                        focusedWindow.toggleDevTools()
                    }
                }
            }, 
            {
                type: 'separator'
            }
        ]
    },
    {
        label: '帮助',
        role: 'help',
        submenu: [
            {
                label: '检查新版本',
                click: function () {
                    updateChecker.check(true);
                }
            },
            {
                label: 'Github',
                click: function () {
                    require('electron').shell.openExternal('https://github.com/Ericwyn/electron-lark')
                }
            }
        ]
    },
]


/**
 * 打开设置窗口
 */
function openSettingsWindows(){
    if(settingsWindow == null) {
        settingsWindow = new BrowserWindow({
            width: 700,
            height: 650,
            frame: false,
            // height: 200,
            resizable: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload:path.join(__dirname,'windows/settings-preload.js')
            },
        });

        // console.log(settingsWindow)
        // settingsWindow.loadUrl('file://' + __dirname + '/app/settings.html');
        settingsWindow.loadURL(settingsURL);
        settingsWindow.on('closed',()=>{settingsWindow=null;});
        settingsWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        settingsWindow.webContents.on('will-navigate',event=>event.preventDefault());
        // settingsWindow.toggleDevTools();
    } else {settingsWindow.show();settingsWindow.focus();}
}

if (process.platform === 'darwin') {
    menuTemplate.unshift({ role: 'appMenu' });
    menuTemplate.splice(2, 0, { role: 'editMenu' });
}

function trustedChat(event) {
    if(!mainWindow || event.sender!==mainWindow.webContents || event.senderFrame!==event.sender.mainFrame)return false;
    try {return new URL(event.senderFrame.url).origin===configuredOrigin;}catch{return false;}
}
function trustedSettings(event) {return settingsWindow && event.sender===settingsWindow.webContents && event.senderFrame===event.sender.mainFrame && event.senderFrame.url===settingsURL;}
ipcMain.handle('settings:read',async event=>{if(!trustedSettings(event))throw Error('访问被拒绝');return {...await settingsStore.readPublic(),version:app.getVersion()};});
ipcMain.handle('settings:pick-skill',async event=>{
    if(!trustedSettings(event))throw Error('访问被拒绝');
    const selected=await electron.dialog.showOpenDialog(settingsWindow,{title:'选择本地 SKILL.md',properties:['openFile'],filters:[{name:'Skill Markdown',extensions:['md']}]});
    if(selected.canceled)return null;
    const skill=await readSkill({id:randomUUID(),path:selected.filePaths[0]});
    return {id:skill.id,name:skill.name,path:skill.path};
});
ipcMain.handle('settings:save',async(event,input)=>{
    if(!trustedSettings(event))throw Error('访问被拒绝');
    const result=await settingsStore.save(input);
    if(mainWindow){analysisService.cancelOwner(mainWindow.webContents.id);mainWindow.webContents.send('assistant:settings-changed');}
    return result;
});
ipcMain.on('settings:open-project',(event,releases)=>{if(trustedSettings(event))shell.openExternal('https://github.com/Ericwyn/electron-lark'+(releases?'/releases':''));});
ipcMain.handle('assistant:config',async event=>{if(!trustedChat(event))throw Error('访问被拒绝');const {assistant}=await settingsStore.readPublic();return {contextLimit:assistant.contextLimit,revision:assistant.revision,defaultReplyMode:assistant.defaultReplyMode,skills:assistant.skills.map(({id,name})=>({id,name}))};});
function sendProgress(event,progress){if(trustedChat(event))event.sender.send('assistant:progress',progress);}
ipcMain.on('assistant:start',(event,input)=>{if(trustedChat(event))analysisService.start(event.sender.id,input,progress=>sendProgress(event,progress));});
ipcMain.on('assistant:cancel',(event,id)=>{if(trustedChat(event))analysisService.cancel(event.sender.id,id);});
ipcMain.handle('assistant:copy',(event,input)=>{if(!trustedChat(event))throw Error('访问被拒绝');const text=analysisService.replyText(event.sender.id,input);if(text==null)return false;electron.clipboard.writeText(text);return true;});
ipcMain.on('assistant:clear',event=>{if(trustedChat(event))analysisService.cancelOwner(event.sender.id);});
ipcMain.on('assistant:respond',(event,input)=>{if(trustedChat(event))analysisService.respond(event.sender.id,input);});
ipcMain.on('assistant:open-interaction-url',(event,input)=>{
    if(!trustedChat(event))return;
    const url=analysisService.interactionUrl(event.sender.id,input);
    if(url && new URL(url).protocol==='https:')shell.openExternal(url);
});
ipcMain.on('assistant:retry-ranking',(event,id)=>{if(trustedChat(event))analysisService.retryRanking(event.sender.id,id,progress=>sendProgress(event,progress)).catch(()=>{});});

// ------------------------ App ------------------------------------
app.on('ready', function () {
    app.userAgentFallback = app.userAgentFallback
        .replace(` ${app.getName()}/${app.getVersion()}`, '')
        .replace(/ Electron\/\S+/g, '');
    
    // 系统菜单
    const menu = Menu.buildFromTemplate(menuTemplate)
    // 设置菜单部分
    Menu.setApplicationMenu(menu) 
    
    // 系统托盘设置
    // 托盘图标
    appTrayInit()

    // globalShortcut.register('alt+shift+q', () => {
    //     console.log("托盘销毁情况")
    //     console.log(newAppTray.isDestroyed())
    // })

    globalShortcut.register('alt+shift+m', () => {
        mainWindow.show()
    })

    // app on 了之后先进行 ajax 请求配置详情，成功之后再 createWindows
    getConfigJson(function (json){
        createWindow(json);
    })

})

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (mainWindow == null) {
        getConfigJson(createWindow);
    } else {
        mainWindow.show();
        mainWindow.setSkipTaskbar(false);
    }
})

// 接受从载入页面发送过来的通知消息
ipcMain.on("notification", (event, msg) => {
    // console.log("收到消息")
    // console.log(event)
    // console.log(msg)
    if(!trustedChat(event))return;
    let args;
    try{args=JSON.parse(msg);}catch{return;}
    if(typeof args?.title!=='string' || !args.opt || typeof args.opt.body!=='string')return;
    // let title = args.title;
    // let opt = args.opt;
    // console.log(args.title, args.opt);
    // title 是对话框名称，opt 是聊天的具体内容，想看格式的话可以去掉上面那行注释
    showLarkNotify(args.title, args.opt, args.opt.channelId)
    event.returnValue = 'pong'
})

function showLarkNotify(title, opt, channelId){
    if(Notification.isSupported()) {
        let electronNotification = new Notification({
            title: title,
            subtitle : title,
            body : opt.body,
            icon: electron.nativeImage.createFromPath(appConf.dock32),
        });
        electronNotification.addListener('click', function(){
            if(mainWindow != null) mainWindow.show();
            // 通过注入 js 打开具体的对话聊天框
            // 参考 https://github.com/Ericwyn/electron-lark/commit/f8c4781fab5c6cd704aa2bba4be0d4d0cedcaab1#commitcomment-51571446
            if(webContents != null) {
                try{webContents.executeJavaScript(`
                    var doms = document.getElementsByTagName("div");
                    for(let i =0;i<doms.length;i++){
                        if(doms[i].getAttribute("data-feed-id") == ${JSON.stringify(String(channelId))}) {
                            doms[i].click();
                            break;
                        }
                    }
                `)}catch(e){
                    console.log(e);
                }
            }
        })
        electronNotification.show();
    }
}
