'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {getMode}=require('./reply-modes');
const reasoningEfforts=['','none','minimal','low','medium','high','xhigh','max','ultra'];
const defaults = Object.freeze({contextLimit:10,defaultReplyMode:'professional',jevEndpoint:'https://openrouter.ai/api/alpha/decisions',jevModel:'typesafe/jev-1.13',codexPath:'',codexModel:'',codexReasoningEffort:'',skills:Object.freeze([])});

function failure(code,message) { return Object.assign(new Error(message),{code}); }

function validateSettings(settings) {
    getMode(settings.defaultReplyMode);
    if(!reasoningEfforts.includes(settings.codexReasoningEffort))throw failure('SETTINGS_INVALID','请选择有效的 Codex 思考强度');
    if(!Array.isArray(settings.skills) || settings.skills.length>50 || settings.skills.some(skill=>
        !skill || typeof skill.id!=='string' || !/^[\w-]{1,100}$/.test(skill.id) ||
        typeof skill.name!=='string' || !skill.name.trim() || skill.name.length>100 ||
        typeof skill.path!=='string' || skill.path.length>4096 || /[\r\n\0]/.test(skill.path) || !path.isAbsolute(skill.path) || path.basename(skill.path)!=='SKILL.md') ||
        new Set(settings.skills.map(s=>s.id)).size!==settings.skills.length || new Set(settings.skills.map(s=>s.path)).size!==settings.skills.length)throw failure('SETTINGS_INVALID','Skill 须有唯一名称标识和本地 SKILL.md 绝对路径，最多 50 项');
    settings.skills=settings.skills.map(({id,name,path})=>({id,name:name.trim(),path}));
    if (!Number.isInteger(settings.contextLimit) || settings.contextLimit < 0 || settings.contextLimit > 50) {
        throw failure('SETTINGS_INVALID','前序消息条数须为 0–50 的整数');
    }
    for (const key of ['jevEndpoint','jevModel','codexPath','codexModel']) {
        if (typeof settings[key] !== 'string' || settings[key].length > 2048 || /[\r\n\0]/.test(settings[key])) {
            throw failure('SETTINGS_INVALID','接口、模型和路径格式不正确');
        }
        settings[key] = settings[key].trim();
    }
    let endpoint;
    try { endpoint = new URL(settings.jevEndpoint); } catch { throw failure('SETTINGS_INVALID','请输入完整的 HTTPS Decisions 地址'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || !settings.jevModel) {
        throw failure('SETTINGS_INVALID','请输入不含用户名、密码或片段的 HTTPS 地址及 Jev 模型');
    }
    return settings;
}

function createSettingsStore({configFile,safeStorage}) {
    let pending = Promise.resolve();
    async function read() {
        try {
            const value = JSON.parse(await fs.readFile(configFile,'utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
            return value;
        } catch (error) {
            if (error.code === 'ENOENT') return {};
            throw failure('SETTINGS_INVALID','配置文件无法读取，请检查配置文件');
        }
    }
    function secureAvailable() {
        return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    }
    function publicConfig(config) {
        const assistant = config.assistant || {};
        return {
            startPageLink:config.startPageLink || '',larkOpenLink:config.larkOpenLink || '',showWarterMark:!!config.showWarterMark,
            assistant:{...Object.fromEntries(Object.keys(defaults).map(key=>[key,assistant[key] ?? defaults[key]])),
                hasJevKey:!!assistant.jevKeyEncrypted,revision:assistant.revision || 0}
        };
    }
    return {
        async readPublic() { await pending; return publicConfig(await read()); },
        async readRuntime() {
            await pending;
            const config = await read();
            const {hasJevKey,...settings} = publicConfig(config).assistant;
            validateSettings(settings);
            let jevApiKey = '';
            if (hasJevKey) {
                try {
                    if (!secureAvailable()) throw Error();
                    jevApiKey = safeStorage.decryptString(Buffer.from(config.assistant.jevKeyEncrypted,'base64'));
                } catch { throw failure('KEY_UNAVAILABLE','无法解锁 Jev Key，请检查系统安全存储或重新配置'); }
            }
            return {...settings,jevApiKey};
        },
        save(input) {
            const operation = pending.then(async()=>{
                if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('SETTINGS_INVALID','设置格式不正确');
                const config = await read();
                for (const key of ['startPageLink','larkOpenLink']) {
                    if (key in input) {
                        if (typeof input[key] !== 'string') throw failure('SETTINGS_INVALID','设置格式不正确');
                        config[key] = input[key];
                    }
                }
                if ('showWarterMark' in input) config.showWarterMark = !!input.showWarterMark;
                if (input.assistant) {
                    const change = input.assistant;
                    const previous = config.assistant || {};
                    const settings = validateSettings({...defaults,...Object.fromEntries(Object.keys(defaults).map(key=>[key,change[key] ?? previous[key] ?? defaults[key]]))});
                    if (change.jevApiKey != null && (typeof change.jevApiKey !== 'string' || /[\r\n\0]/.test(change.jevApiKey))) {
                        throw failure('SETTINGS_INVALID','API Key 格式不正确');
                    }
                    const key = change.jevApiKey?.trim();
                    if (key && change.clearJevKey) throw failure('SETTINGS_INVALID','不能同时设置和清除 Key');
                    let encrypted = previous.jevKeyEncrypted || '';
                    if (change.clearJevKey) encrypted = '';
                    if (key) {
                        try {
                            if (!secureAvailable()) throw Error();
                            encrypted = safeStorage.encryptString(key).toString('base64');
                        } catch { throw failure('KEY_UNAVAILABLE','系统安全存储不可用，无法保存 Key'); }
                    }
                    config.assistant = {...settings,jevKeyEncrypted:encrypted,revision:(previous.revision || 0)+1};
                }
                await fs.mkdir(path.dirname(configFile),{recursive:true});
                const temporary = `${configFile}.${randomUUID()}.tmp`;
                try {
                    await fs.writeFile(temporary,JSON.stringify(config,null,2),{mode:0o600});
                    await fs.rename(temporary,configFile);
                } finally { await fs.rm(temporary,{force:true}); }
                return publicConfig(config);
            });
            pending = operation.catch(()=>{});
            return operation;
        }
    };
}

module.exports = {createSettingsStore,validateSettings,defaults,failure};
