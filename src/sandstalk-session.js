'use strict';

// Runs only in Sandstalk's page context, using its own store and API client.
async function reuseSandstalkSession(target, mobileRedirect) {
    if (location.origin !== 'https://edu.sandstalk.com') return false;
    const url = new URL(target);
    const [page, query] = url.hash.slice(1).split('?');
    const params = new URLSearchParams(query);
    if (url.origin !== location.origin || page !== '/Transit' || params.has('code') ||
        params.get('state') !== 'feishu_jump') return false;
    const id = params.get('jumpModuleId');
    if (!id || !/^\d+$/.test(id)) return false;
    const routes = {
        '700': `/live/auth?id=${id}`,
        '1501': `/teachingManagement_overview/${id}/overview`,
        '201': `/resource/courseDetails?id=${id}&fileType=0&channel=0`,
        '202': `/resource/courseDetails?id=${id}&fileType=1&channel=0`
    };
    const route = Object.hasOwn(routes, params.get('jumpType')) && routes[params.get('jumpType')];
    if (!route) return false;
    const mobile = mobileRedirect && new URL(mobileRedirect);
    if (mobile && (mobile.origin !== location.origin || mobile.pathname !== '/web/' ||
        !mobile.hash.startsWith('#/login?') || new URLSearchParams(mobile.hash.split('?')[1]).get('id') !== id)) return false;
    const script = [...document.scripts].find(script => script.type === 'module' &&
        new URL(script.src || 'about:blank').origin === location.origin &&
        /\/index\.[\w-]+\.js$/.test(new URL(script.src).pathname));
    if (!script) return false;
    let timer;
    try {
        const {b: useUserStore, j: fetchUserInfo, bd: fetchLiveAuth} = await import(script.src);
        if (typeof useUserStore !== 'function' || typeof fetchUserInfo !== 'function') return false;
        const store = useUserStore();
        if (!store.getAccessToken) return false;
        const user = await Promise.race([
            fetchUserInfo(),
            new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('会话检查超时')), 10000);})
        ]);
        if (!user) return false;
        if (!mobile) return new URL(`/#${route}`, location.origin).href;
        if (params.get('jumpType') !== '700' || typeof fetchLiveAuth !== 'function') return false;
        const type = new URLSearchParams(mobile.hash.split('?')[1]).get('type') || '0';
        const destination = new URL(await fetchLiveAuth(new URLSearchParams({id, type}).toString()));
        if (destination.protocol !== 'https:' || destination.username || destination.password) return false;
        return destination.href;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {reuseSandstalkSession};
