'use strict';

// 全局变量定义
const path = require('path')
const { app } = require('electron')

class Configuration{
    constructor() {
        this.path = require('path')
        this.configFile = path.join(app.getPath('userData'), 'config.json');
        this.updateCheckFile = path.join(app.getPath('userData'), 'updateCheck.json');
        this.rootDir =  path.join(__dirname, "../");
        this.iconDir =  path.join(this.rootDir, "icon/")
        this.icon128 = path.join(this.iconDir, "/128.png");
        this.dock32 = path.join(this.iconDir, '/dock/32.png')
        this.dock32Empty = path.join(this.iconDir, '/dock/32empty.png')
        this.macTray = path.join(this.iconDir, 'dock/trayTemplate.png')
        this.macTrayEmpty = path.join(this.iconDir, 'dock/trayEmptyTemplate.png')
    }
}

module.exports = new Configuration()