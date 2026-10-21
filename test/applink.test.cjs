'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {parseWebAppLink} = require('../src/applink');

const link = 'https://applink.feishu.cn/client/web_app/open?appId=cli_a4f419c5067d9013&mode=appCenter&lk_target_url=https%3A%2F%2Fedu.sandstalk.com%2F%23%2FTransit%3FappId%3Dcli_a4f419c5067d9013%26state%3Dfeishu_jump%26jumpModuleId%3D980372545410711612%26jumpType%3D700%26customerJumpLink%3Dnull%26timeStamp%3D1792487676153&from=p2p_card_button';

test('opens the registered app with its full hash route and exact business ID', () => {
    assert.deepEqual(parseWebAppLink(link), {
        appId: 'cli_a4f419c5067d9013',
        title: '沙滩说',
        targetUrl: 'https://edu.sandstalk.com/#/Transit?appId=cli_a4f419c5067d9013&state=feishu_jump&jumpModuleId=980372545410711612&jumpType=700&customerJumpLink=null&timeStamp=1792487676153'
    });
});

test('decodes only the outer URL parameter and retains inner percent escapes', () => {
    const url = new URL(link);
    url.searchParams.set('lk_target_url', 'https://edu.sandstalk.com/#/Transit?next=%2Fcourse%3Fid%3D1&literal=%252F');
    assert.equal(parseWebAppLink(url.href).targetUrl, 'https://edu.sandstalk.com/#/Transit?next=%2Fcourse%3Fid%3D1&literal=%252F');
});

test('leaves unrelated links and unregistered apps to the existing link handler', () => {
    for (const url of [
        'https://example.com/',
        link.replace('applink.feishu.cn/', 'applink.feishu.cn.example.com/'),
        link.replace('/client/web_app/open?', '/client/mini_program/open?'),
        link.replace('appId=cli_a4f419c5067d9013&', 'appId=cli_other&'),
        'not a URL'
    ]) assert.equal(parseWebAppLink(url), null);
});

test('rejects a registered app link pointing to an untrusted or local target', () => {
    for (const target of [
        'https://edu.sandstalk.com.example.com/',
        'https://evil.example/?next=https://edu.sandstalk.com',
        'http://edu.sandstalk.com/',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'https://user:password@edu.sandstalk.com/',
        'invalid'
    ]) {
        const url = new URL(link);
        url.searchParams.set('lk_target_url', target);
        assert.throws(() => parseWebAppLink(url.href), /应用链接/);
    }
});

test('rejects missing and ambiguous target parameters', () => {
    const missing = new URL(link);
    missing.searchParams.delete('lk_target_url');
    assert.throws(() => parseWebAppLink(missing.href), /应用链接/);
    const duplicate = new URL(link);
    duplicate.searchParams.append('lk_target_url', 'https://evil.example/');
    assert.throws(() => parseWebAppLink(duplicate.href), /应用链接/);
});

test('opens operations tickets directly and preserves the ticket route and query', () => {
    assert.deepEqual(parseWebAppLink('https://ylops-h5.jtexpress.com.cn/?lang=zh-CN&open_in_browser=true#/131824/fs-workflow-detail'), {
        appId: 'ylops', title: '运维工单', targetUrl: 'https://ylops-h5.jtexpress.com.cn/?lang=zh-CN&open_in_browser=true#/131824/fs-workflow-detail'
    });
    assert.equal(parseWebAppLink('https://ylops-h5.jtexpress.com.cn.example.com/#/131824/fs-workflow-detail'), null);
    assert.throws(() => parseWebAppLink('https://user:password@ylops-h5.jtexpress.com.cn/#/131824/fs-workflow-detail'), /应用链接/);
});

test('opens the operations card AppLink in the same application as the direct ticket URL', () => {
    const target = 'https://ylops-h5.jtexpress.com.cn/?lang=zh-CN&open_in_browser=true#/131824/fs-workflow-detail';
    const card = new URL('https://applink.feishu.cn/client/web_app/open');
    card.search = new URLSearchParams({appId:'cli_a4e6cb1e333a500e',mode:'appCenter',lk_target_url:target,from:'p2p_card_button'});
    assert.deepEqual(parseWebAppLink(card.href), {
        appId:'ylops',title:'运维工单',targetUrl:target
    });
    assert.deepEqual(parseWebAppLink(card.href), parseWebAppLink(target));
});

test('rejects an operations card with a foreign target or duplicate app identity', () => {
    const card = new URL('https://applink.feishu.cn/client/web_app/open?appId=cli_a4e6cb1e333a500e');
    for (const target of [
        'https://ylops-h5.jtexpress.com.cn.example.com/',
        'https://edu.sandstalk.com/',
        'http://ylops-h5.jtexpress.com.cn/',
        'https://user:password@ylops-h5.jtexpress.com.cn/',
        'file:///etc/passwd'
    ]) {
        card.searchParams.set('lk_target_url',target);
        assert.throws(() => parseWebAppLink(card.href), /应用链接/);
    }
    card.searchParams.set('lk_target_url','https://ylops-h5.jtexpress.com.cn/#/131824/fs-workflow-detail');
    card.searchParams.append('appId','cli_a4f419c5067d9013');
    assert.throws(() => parseWebAppLink(card.href), /应用链接/);
});

const performanceTarget = 'https://cloud.italent.cn/mrest/PerformanceCloud/PerformanceCloud/100000/PerformanceURL/RoutingV1?key=synthetic-card-key';
function performanceCard(target = performanceTarget) {
    const card = new URL('https://applink.feishu.cn/client/web_app/open');
    card.search = new URLSearchParams({appId:'cli_a4d0b2c8b8f9900c',path:'sso/page/feishu_v2/authorize',tenant_id:'synthetic-tenant',app_id:'100',appaccount_id:'synthetic-account',return_url:target});
    return card;
}

test('opens the registered performance SSO entry with the current card parameters and business return target', () => {
    const target = performanceTarget + '&next=%2Fgoal%3Fid%3D9007199254740993#review';
    const parsed=parseWebAppLink(performanceCard(target).href);
    assert.equal(parsed.appId,'italent');
    assert.equal(parsed.title,'绩效管理');
    const entry=new URL(parsed.targetUrl);
    assert.equal(entry.origin,'https://openapi.italent.cn');
    assert.equal(entry.pathname,'/sso/page/feishu_v2/authorize');
    assert.deepEqual(Object.fromEntries(entry.searchParams),{type:'31',return_url_type:'pageCode',tenant_id:'synthetic-tenant',app_id:'100',appaccount_id:'synthetic-account',return_url:target,from:'p2p_card_button'});
    assert.deepEqual(parseWebAppLink(performanceTarget),{appId:'italent',title:'绩效管理',targetUrl:performanceTarget});
    assert.equal(parseWebAppLink('https://applink.feishu.cn/client/message/link/open?token=synthetic-locator'),null);
});

test('rejects ambiguous performance cards and targets outside the observed performance service', () => {
    for (const target of [
        'https://cloud.italent.cn.example.com/mrest/PerformanceCloud/',
        'http://cloud.italent.cn/mrest/PerformanceCloud/',
        'https://user:password@cloud.italent.cn/mrest/PerformanceCloud/',
        'https://cloud.italent.cn/another-app',
        'file:///etc/passwd'
    ]) assert.throws(()=>parseWebAppLink(performanceCard(target).href),/应用链接/);
    for (const key of ['appId','path','return_url','tenant_id','app_id','appaccount_id']) {
        const card = performanceCard();
        card.searchParams.append(key,card.searchParams.get(key));
        assert.throws(()=>parseWebAppLink(card.href),/应用链接/);
    }
    const missing = performanceCard();
    missing.searchParams.delete('return_url');
    assert.throws(()=>parseWebAppLink(missing.href),/应用链接/);
    const otherPath = performanceCard();
    otherPath.searchParams.set('path','other/application');
    assert.throws(()=>parseWebAppLink(otherPath.href),/应用链接/);
});
