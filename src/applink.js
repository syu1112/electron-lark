'use strict';

const defaultApps = {
    cli_a4f419c5067d9013: {title: '沙滩说', origin: 'https://edu.sandstalk.com'},
    cli_a4e6cb1e333a500e: {title: '运维工单', origin: 'https://ylops-h5.jtexpress.com.cn', windowId: 'ylops'}
};

function parseWebAppLink(input) {
    let url;
    try { url = new URL(input); } catch { return null; }
    if (url.origin === 'https://cloud.italent.cn' && url.pathname.startsWith('/mrest/PerformanceCloud/')) {
        if (url.username || url.password) throw new Error('应用链接不能包含用户名或密码');
        return {appId: 'italent', title: '绩效管理', targetUrl: url.href};
    }
    if (url.origin === 'https://ylops-h5.jtexpress.com.cn') {
        if (url.username || url.password) throw new Error('应用链接不能包含用户名或密码');
        return {appId: 'ylops', title: '运维工单', targetUrl: url.href};
    }
    if (url.origin !== 'https://applink.feishu.cn' || url.pathname !== '/client/web_app/open') return null;
    const appId = url.searchParams.get('appId');
    if (appId === 'cli_a4d0b2c8b8f9900c') {
        if (url.username || url.password || ['appId', 'path', 'return_url', 'tenant_id', 'app_id', 'appaccount_id'].some(key => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)) || url.searchParams.getAll('from').length > 1 ||
            url.searchParams.get('path') !== 'sso/page/feishu_v2/authorize') {
            throw new Error('应用链接参数不完整或重复');
        }
        let target;
        try { target = new URL(url.searchParams.get('return_url')); }
        catch { throw new Error('应用链接目标地址无效'); }
        if (target.origin !== 'https://cloud.italent.cn' || !target.pathname.startsWith('/mrest/PerformanceCloud/') || target.username || target.password) {
            throw new Error('应用链接目标不属于已配置的绩效应用');
        }
        const entry = new URL('https://openapi.italent.cn/sso/page/feishu_v2/authorize');
        entry.search = new URLSearchParams({
            type: '31', return_url_type: 'pageCode',
            tenant_id: url.searchParams.get('tenant_id'), app_id: url.searchParams.get('app_id'),
            appaccount_id: url.searchParams.get('appaccount_id'), return_url: target.href,
            from: url.searchParams.get('from') || 'p2p_card_button'
        });
        return {appId: 'italent', title: '绩效管理', targetUrl: entry.href};
    }
    if (!Object.hasOwn(defaultApps, appId)) return null;
    if (url.username || url.password || url.searchParams.getAll('appId').length !== 1 || url.searchParams.getAll('lk_target_url').length !== 1) {
        throw new Error('应用链接参数不完整或重复');
    }
    const application = defaultApps[appId];
    let target;
    try { target = new URL(url.searchParams.get('lk_target_url')); }
    catch { throw new Error('应用链接目标地址无效'); }
    if (target.protocol !== 'https:' || target.username || target.password || target.origin !== application?.origin) {
        throw new Error('应用链接目标不属于已配置的应用');
    }
    return {appId: application.windowId || appId, title: typeof application.title === 'string' ? application.title : '企业应用', targetUrl: target.href};
}

module.exports = {parseWebAppLink};
