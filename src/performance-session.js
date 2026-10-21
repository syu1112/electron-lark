'use strict';

// Runs inside the official callback page; fresh credentials are never cached or logged.
async function completePerformanceHandoff(requested) {
    if (location.origin !== 'https://openapi.italent.cn' || location.pathname !== '/sso/page/feishu_v2/authorize' ||
        typeof window.openUrl !== 'string') return;
    const current = location.href;
    try {
        const entry = new URL(requested);
        const callback = new URL(current);
        if (entry.origin !== location.origin || entry.pathname !== location.pathname) return;
        for (const key of ['tenant_id', 'app_id', 'appaccount_id', 'return_url']) {
            if (!entry.searchParams.get(key) || callback.searchParams.getAll(key).length !== 1 ||
                callback.searchParams.get(key) !== entry.searchParams.get(key)) return;
        }
        if (typeof window.Main !== 'function') throw new Error('unsupported callback');
        const handoff = new URL(window.openUrl);
        const target = new URL(handoff.searchParams.get('return_url'));
        if (handoff.origin !== 'https://oapi.italent.cn' || handoff.pathname !== '/SSO/AuthCenter' ||
            handoff.username || handoff.password || handoff.searchParams.getAll('id_token').length !== 1 ||
            !handoff.searchParams.get('id_token') || handoff.searchParams.getAll('return_url').length !== 1 ||
            target.origin !== 'https://cloud.italent.cn' || !target.pathname.startsWith('/mrest/PerformanceCloud/') ||
            target.username || target.password || target.href !== entry.searchParams.get('return_url')) throw new Error('invalid handoff');
        // Preserve the callback page's fresh first-open check without executing extracted code.
        const match = Function.prototype.toString.call(window.Main).match(/var\s+url\s*=\s*(['"])(\/Appconnect_Authorize\/IsFirstOpen\?[^'"\r\n]+)\1\s*\+\s*new Date\(\)\.getTime\(\)/);
        if (!match) throw new Error('unsupported callback');
        const check = new URL(match[2], location.origin);
        if (check.origin !== location.origin || check.pathname !== '/Appconnect_Authorize/IsFirstOpen' ||
            !['randomKey', 'timeStamp', '_'].every(key => check.searchParams.getAll(key).length === 1) ||
            !check.searchParams.get('randomKey') || !check.searchParams.get('timeStamp')) throw new Error('invalid check');
        check.searchParams.set('_', String(Date.now()));
        const body = new URLSearchParams({
            tenant_id: entry.searchParams.get('tenant_id'), app_id: entry.searchParams.get('app_id'),
            appaccount_id: entry.searchParams.get('appaccount_id'), url: current.split('#')[0]
        });
        const signature = await fetch('/Appconnect_FeishuSSO/_GetFeiShuSignature', {
            method: 'POST', credentials: 'same-origin', redirect: 'error', body
        });
        if (!signature.ok || (await signature.json()).Success !== true) throw new Error('authorization failed');
        if (location.href !== current) return;
        const first = await fetch(check.href, {credentials: 'same-origin', redirect: 'error'});
        if (!first.ok || (await first.json()).Success !== true) throw new Error('authorization failed');
        if (location.href === current && window.openUrl === handoff.href) return handoff.href;
    } catch {
        const loading = document.getElementById('loadingdiv');
        const error = document.getElementById('errordiv');
        if (location.href !== current) return;
        if (loading) loading.style.display = 'none';
        if (error) {
            error.textContent = '北森免登校验未通过，请重新点击绩效卡片或联系应用管理员。';
            error.style.display = 'block';
        }
        return 'failed';
    }
}

module.exports = {completePerformanceHandoff};
