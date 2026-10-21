'use strict';

function createWebAppFixture(cookies) {
    const appRequests = [];
    const state = {delayValidation: 0, rejectSandSession: false};
    return {requests: appRequests, state, handle(request) {
        const url = new URL(request.url);
        appRequests.push(url.origin + url.pathname);
        if (url.origin === 'https://openapi.italent.cn' && url.pathname === '/sso/page/feishu_v2/authorize') {
            if (!url.searchParams.has('code')) {
                const oauth=new URL('https://open.feishu.cn/open-apis/authen/v1/index');
                oauth.search=new URLSearchParams({app_id:'cli_a4d0b2c8b8f9900c',redirect_uri:url.href});
                const delay=state.delayPerformanceEntry||0;state.delayPerformanceEntry=0;
                return new Promise(resolve=>setTimeout(()=>resolve(new Response('',{status:302,headers:{Location:oauth.href}})),delay));
            }
            const handoff=new URL('https://oapi.italent.cn/SSO/AuthCenter');
            handoff.search=new URLSearchParams({id_token:'synthetic-fresh-'+url.searchParams.get('code'),return_url:url.searchParams.get('return_url')});
            return new Response(`<div id="loadingdiv">授权中</div><div id="errordiv" style="display:none"></div><script>
                window.openUrl=${JSON.stringify(handoff.href)};
                function Main(){var url='/Appconnect_Authorize/IsFirstOpen?randomKey=synthetic-fresh&timeStamp=123&_=' + new Date().getTime();}
                if (${JSON.stringify(state.forgePerformanceHandoff||null)}) {
                    const genuine=new URL(window.openUrl),NativeURL=window.URL;
                    window.openUrl=${JSON.stringify(state.forgePerformanceHandoff||null)};
                    window.URL=function(value,base){
                        if(value===window.openUrl) return {origin:genuine.origin,pathname:genuine.pathname,username:'',password:'',href:value,searchParams:genuine.searchParams};
                        return new NativeURL(value,base);
                    };
                }
            </script>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
        }
        if (url.origin === 'https://openapi.italent.cn' && url.pathname === '/Appconnect_FeishuSSO/_GetFeiShuSignature') {
            return new Response(JSON.stringify({Success:!state.rejectPerformanceSignature}),{headers:{'Content-Type':'application/json'}});
        }
        if (url.origin === 'https://openapi.italent.cn' && url.pathname === '/Appconnect_Authorize/IsFirstOpen') {
            const delay=state.delayPerformanceFirstOpen||0;state.delayPerformanceFirstOpen=0;
            const success=!state.rejectPerformanceFirstOpen;
            return new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify({Success:success}),{headers:{'Content-Type':'application/json'}})),delay));
        }
        if (url.origin === 'https://oapi.italent.cn' && url.pathname === '/SSO/AuthCenter') {
            (state.completedPerformanceTargets ||= []).push(url.searchParams.get('return_url'));
            if(url.searchParams.get('id_token')!=='synthetic-fresh-synthetic-authorized') return new Response('Unauthorized',{status:401});
            return new Response(`<script>
                document.cookie='italent-session=synthetic-valid; Domain=italent.cn; Path=/; Secure; SameSite=Lax';
                location.replace(${JSON.stringify(url.searchParams.get('return_url'))});
            </script>`,{headers:{'Content-Type':'text/html'}});
        }
        if (url.origin === 'https://cloud.italent.cn') {
            // Custom protocol requests omit Cookie headers; consult the browser's real cookie jar.
            return cookies.get({url:request.url,name:'italent-session'}).then(values => {
                if (!values.some(cookie=>cookie.value==='synthetic-valid')) {
                    return new Response(JSON.stringify({code:417,message:'用户未登录或签名认证失败！请登录 italent 之后再访问.'}), {
                        headers:{'Content-Type':'application/json; charset=utf-8'}
                    });
                }
                return new Response('<title>绩效详情测试</title><p id="performance">绩效详情</p>', {headers:{'Content-Type':'text/html; charset=utf-8'}});
            });
        }
        if (url.origin === 'https://www.italent.cn' && url.pathname === '/Login') {
            return new Response(`<title>北森登录测试</title><button id="login">模拟完成网页登录</button><script>
                document.querySelector('#login').onclick=()=>{
                    document.cookie='italent-session=synthetic-valid; Domain=italent.cn; Path=/; Secure; SameSite=Lax';
                    location.href=new URL(location.href).searchParams.get('ReturnUrl');
                };
            </script>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
        }
        if (url.origin === 'https://ylops-h5.jtexpress.com.cn') {
            return new Response(`<div id="app"></div><script src="https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.42.js"></script><script>
                window.fixtureTicketId=location.hash.split('/')[1];
                const state = {token:localStorage.getItem('ops-session')};
                const store = {state:{userStore:state}, async dispatch(action,payload) {
                    if(action === 'userStore/fsCodeLogin') {
                        const r=await fetch('https://devops-api.jtexpress.com.cn/api/user/fs_login/',{method:'POST',body:JSON.stringify(payload)});
                        if(!r.ok) throw Error('invalid code');
                        state.token=(await r.json()).access;localStorage.setItem('ops-session',state.token);
                    } else if(action === 'userStore/getInfo') {
                        let r=await fetch('https://devops-api.jtexpress.com.cn/api/users/check_admin/',{headers:{Authorization:state.token}});
                        if(r.status===401) {
                            const refresh=await fetch('https://devops-api.jtexpress.com.cn/api/user/refresh/',{method:'POST',body:state.token});
                            if(!refresh.ok) throw Error('expired session');
                            state.token=(await refresh.json()).access;localStorage.setItem('ops-session',state.token);
                            r=await fetch('https://devops-api.jtexpress.com.cn/api/users/check_admin/',{headers:{Authorization:state.token}});
                        }
                        if(!r.ok) throw Error('invalid session');
                        return r.json();
                    }
                }};
                document.querySelector('#app').__vue_app__={config:{globalProperties:{$store:store}}};
                h5sdk.config({appId:'cli_a4e6cb1e333a500e'});
                window.requestLogin = () => new Promise(resolve => tt.requestAuthCode({
                    appId:'cli_a4e6cb1e333a500e',
                    success(result) {
                        store.dispatch('userStore/fsCodeLogin',{user_code:result.code})
                            .then(()=>{window.authResult=result;resolve(result);});
                    },
                    fail(error) {window.authResult=error; resolve(error);}
                }));
                h5sdk.ready(() => {window.adapterReady=true; requestLogin();});
            </script>`, {headers: {'Content-Type': 'text/html'}});
        }
        if (url.origin === 'https://devops-api.jtexpress.com.cn') {
            const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};
            if(request.method==='OPTIONS') return new Response(null,{status:204,headers});
            if(url.pathname.endsWith('/fs_login/')) return request.text().then(body=>{
                const ok=JSON.parse(body).user_code==='synthetic-user-authorized-code';
                return new Response(JSON.stringify({access:ok?'synthetic-valid':null}),{status:ok?200:401,headers});
            });
            if(url.pathname.endsWith('/check_admin/')) return new Response(JSON.stringify({id:1}),{
                status:request.headers.get('Authorization')==='synthetic-valid'?200:401,headers
            });
            if(url.pathname.endsWith('/refresh/')) return request.text().then(body=>new Response(JSON.stringify({access:'synthetic-valid'}),{
                status:body==='synthetic-expired'?200:401,headers
            }));
        }
        if (url.origin === 'https://lf-scm-cn.feishucdn.com') {
            return new Response('if(navigator.userAgent.includes("Lark")) window.h5sdk={config(){},ready(callback){window.nativeReadyCallback=callback;}};', {
                headers: {'Content-Type': 'application/javascript'}
            });
        }
        if (url.origin === 'https://open.feishu.cn' && url.pathname.endsWith('/authorize')) {
            return new Response('<title>用户授权测试</title>', {headers: {'Content-Type': 'text/html'}});
        }
        if (url.origin === 'https://edu.sandstalk.com' && url.pathname === '/live-redirect') {
            return new Response(JSON.stringify({redirectUrl: 'https://video.example.test/player?id=' + url.searchParams.get('id')}), {
                headers: {'Content-Type': 'application/json'}
            });
        }
        if (url.origin === 'https://edu.sandstalk.com' && url.pathname === '/assets/index.fixture.js') {
            return new Response(`export function b(){return {get getAccessToken(){return localStorage.getItem('business-session')},setUserInfoFromServer(){}}}
                export async function j(){const r=await fetch('/sands-user/api/v1/user/current-info',{headers:{Authorization:localStorage.getItem('business-session')}});if(!r.ok)throw Error('expired');return r.json()}
                export const r={replace(route){location.replace('/#'+route)}};
                export async function bd(query){const r=await fetch('/live-redirect?'+query);return (await r.json()).redirectUrl};`,{headers:{'Content-Type':'application/javascript'}});
        }
        if (url.origin === 'https://edu.sandstalk.com' && url.pathname === '/sands-user/api/v1/user/current-info') {
            const delay=state.delayValidation; state.delayValidation=0;
            return new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify({id:1}),{status:request.headers.get('Authorization')==='synthetic'&&!state.rejectSandSession?200:401})),delay));
        }
        if (url.origin === 'https://edu.sandstalk.com') {
            return new Response(`<script type="module" src="/assets/index.fixture.js"></script><script type="module">
                function route(){
                const params = new URLSearchParams(location.hash.split('?')[1]);
                const id = params.get('jumpModuleId') || params.get('id');
                if(location.hash.startsWith('#/Transit')) {
                    if (!params.has('code')) {
                        location.href = 'https://open.feishu.cn/open-apis/authen/v1/index?app_id=cli_a4f419c5067d9013&id=' + id;
                    } else {
                        localStorage.setItem('business-session', 'synthetic');
                        location.replace('/#/live/auth?id='+id);
                    }
                } else if(location.hash.startsWith('#/live/auth')) {
                    if(document.body.clientWidth<765) location.replace('/web/#/login?shareType=1&id='+id+'&type=0');
                    else fetch('/live-redirect?id=' + id).then(r => r.json()).then(r => location.replace(r.redirectUrl));
                }
                }
                addEventListener('hashchange',route);route();
            </script>`, {headers: {'Content-Type': 'text/html'}});
        }
        if (url.origin === 'https://open.feishu.cn' && url.pathname === '/open-apis/authen/v1/index') {
            if(url.searchParams.get('app_id')==='cli_a4d0b2c8b8f9900c') {
                const callback=new URL(url.searchParams.get('redirect_uri'));
                callback.searchParams.set('code','synthetic-authorized');
                return new Response('',{status:302,headers:{Location:callback.href}});
            }
            state.rejectSandSession=false;
            return new Response('', {status: 302, headers: {
                Location: 'https://edu.sandstalk.com/#/Transit?code=synthetic&jumpModuleId=' + url.searchParams.get('id')
            }});
        }
        if (url.origin === 'https://open.feishu.cn' && url.pathname === '/popup') {
            return new Response('<script>opener.postMessage("oauth-popup-ready", "https://video.example.test")</script>', {
                headers: {'Content-Type': 'text/html'}
            });
        }
        if (url.origin === 'https://video.example.test') {
            return new Response('<title>直播测试</title><h1 id="live">直播测试</h1>', {headers: {'Content-Type': 'text/html'}});
        }
        return new Response('Unexpected fixture request', {status: 404});
    }};
}
module.exports = {createWebAppFixture};
