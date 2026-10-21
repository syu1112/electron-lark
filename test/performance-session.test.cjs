const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {completePerformanceHandoff} = require('../src/performance-session');
const target='https://cloud.italent.cn/mrest/PerformanceCloud/PerformanceCloud/100000/PerformanceURL/RoutingV1?key=synthetic-current';
const entry=new URL('https://openapi.italent.cn/sso/page/feishu_v2/authorize');
entry.search=new URLSearchParams({tenant_id:'synthetic-tenant',app_id:'100',appaccount_id:'synthetic-account',return_url:target});
function fixture(options={}) {
    const location={href:entry.href+'&code=synthetic-fresh',origin:entry.origin,pathname:entry.pathname,replace(value){this.destination=value;}};
    const handoff=new URL('https://oapi.italent.cn/SSO/AuthCenter');
    handoff.search=new URLSearchParams({id_token:'synthetic-fresh-token',return_url:options.foreign?'https://example.test/':target});
    const requests=[];
    const context=vm.createContext({URL,URLSearchParams,Date,location,window:{openUrl:handoff.href,Main:function Main(){var url='/Appconnect_Authorize/IsFirstOpen?randomKey=synthetic-fresh&timeStamp=123&_=' + new Date().getTime();}},
        document:{getElementById(){return null;}},fetch:async(url,init)=>{
            requests.push({url:new URL(url,entry.origin),init});
            if(options.stale) location.href+='&changed=1';
            return {ok:!options.httpFailure,json:async()=>({Success:url.includes('Signature')?!options.signatureDenied:!options.firstDenied})};
        }});
    return {location,requests,run:()=>vm.runInContext(`(${completePerformanceHandoff.toString()})(${JSON.stringify(entry.href)})`,context)};
}
test('performance handoff preserves both server gates and uses only the fresh in-page token',async()=>{
    const f=fixture();const destination=await f.run();
    assert.equal(new URL(destination).origin,'https://oapi.italent.cn');
    assert.equal(new URL(destination).searchParams.get('return_url'),target);
    assert.equal(f.requests.length,2);
    assert.equal(f.requests[0].url.pathname,'/Appconnect_FeishuSSO/_GetFeiShuSignature');
    assert.equal(f.requests[0].init.method,'POST');
    assert.equal(f.requests[0].init.credentials,'same-origin');
    assert.equal(f.requests[1].url.pathname,'/Appconnect_Authorize/IsFirstOpen');
    assert.equal(f.requests[1].url.searchParams.get('randomKey'),'synthetic-fresh');
});
for(const options of [{signatureDenied:true},{firstDenied:true},{httpFailure:true},{foreign:true},{stale:true}]) {
    test('performance handoff stays closed for '+JSON.stringify(options),async()=>{
        const f=fixture(options);const result=await f.run();assert(!result || result==='failed');assert.equal(f.location.destination,undefined);
        if(options.signatureDenied||options.httpFailure) assert.equal(f.requests.length,1);
        if(options.foreign) assert.equal(f.requests.length,0);
    });
}
