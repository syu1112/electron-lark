const test=require('node:test');
const assert=require('node:assert/strict');
const {createAnalysisService}=require('../../src/assistant/analysis-service');
const snapshot=(id='r1')=>({requestId:id,conversationId:'chat',messageId:'target',configRevision:1,target:{id:'target',sender:'me',text:'请处理'},candidates:[{id:'m1',sender:'other',text:'相关'},{id:'m2',sender:'other',text:'无关'}]});
function setup(overrides={}) {
  const config={revision:1,contextLimit:10,jevApiKey:'fake-key'};
  const phases=[],inputs=[];let generated=0;
  const jevClient={filterContext:async(c,s)=>s.candidates.slice(0,1),judge:async(c,input)=>{inputs.push(input);return {intent:{value:'request_action',confidence:0.8}};},rank:async(c,input)=>{inputs.push(input);return input.replies.map((text,i)=>({id:['reply_a','reply_b','reply_c'][i],text,probability:[0.6,0.3,0.1][i]}));},...overrides};
  const service=createAnalysisService({settingsStore:{readRuntime:async()=>({...config})},jevClient,generateReplies:async(c,input)=>{generated++;inputs.push(input);return ['回复一','回复二','回复三'];}});
  return {service,config,phases,inputs,jevClient,get generated(){return generated;},onProgress:e=>phases.push(e)};
}
test('pipeline sends only filtered context to every subsequent stage',async()=>{
  const s=setup();await s.service.start(1,snapshot(),s.onProgress);
  assert.deepEqual(s.phases.map(p=>p.stage),['filtering','judging','generating','ranking','complete']);
  assert(s.inputs.every(input=>input.messages.length===1 && input.messages[0].id==='m1'));
});
test('filter failure prevents generation and missing key prevents any external stage',async()=>{
  const s=setup({filterContext:async()=>{throw Object.assign(Error('safe'),{code:'INVALID_RESPONSE'});}});
  await s.service.start(1,snapshot(),s.onProgress);
  assert.equal(s.generated,0);assert.equal(s.phases.at(-1).stage,'error');
  s.config.jevApiKey='';s.phases.length=0;
  await s.service.start(1,snapshot('r2'),s.onProgress);
  assert.deepEqual(s.phases.map(p=>p.stage),['error']);
});
test('ranking retry reuses suggestions without regenerating and rejects changed config',async()=>{
  let fail=true;
  const s=setup({rank:async(c,input)=>{if(fail)throw Object.assign(Error('fail'),{code:'HTTP'});return input.replies.map(text=>({text,probability:1/3}));}});
  await s.service.start(1,snapshot(),s.onProgress);
  assert.equal(s.phases.at(-1).stage,'unranked');
  assert.equal(s.phases.at(-1).replies.length,3);
  fail=false;await s.service.retryRanking(1,'r1',s.onProgress);
  assert.equal(s.phases.at(-1).stage,'complete');assert.equal(s.generated,1);
  s.config.revision=2;await s.service.retryRanking(1,'r1',s.onProgress);
  assert.equal(s.phases.at(-1).error.code,'STALE_REQUEST');
});
test('new request cancels old work and suppresses its delayed completion',async()=>{
  let release;
  const s=setup({filterContext:async(c,input)=>{if(input.requestId==='old') await new Promise(r=>release=r);return [];}});
  const old=s.service.start(1,snapshot('old'),s.onProgress);
  while(!release)await new Promise(r=>setImmediate(r));
  await s.service.start(1,snapshot('new'),s.onProgress);release();await old;
  assert(!s.phases.some(e=>e.requestId==='old' && e.stage==='complete'));
  assert.equal(s.generated,1);
});
test('duplicate requests, invalid snapshots and stale settings cannot start new work',async()=>{
  const s=setup();await Promise.all([s.service.start(1,snapshot(),s.onProgress),s.service.start(1,snapshot(),s.onProgress)]);
  assert.equal(s.generated,1);
  await s.service.start(1,{...snapshot('r2'),configRevision:0},s.onProgress);
  assert.equal(s.phases.at(-1).error.code,'STALE_REQUEST');
  await s.service.start(1,{...snapshot('r3'),candidates:[snapshot().target]},s.onProgress);
  assert.equal(s.generated,1);assert.equal(s.phases.at(-1).stage,'error');
});
test('cancellation while retry settings load prevents another ranking request',async()=>{
  let reads=0,release,ranks=0;
  const config={revision:1,contextLimit:10,jevApiKey:'fake'};
  const service=createAnalysisService({settingsStore:{readRuntime:()=>++reads===1?Promise.resolve(config):new Promise(r=>release=()=>r(config))},jevClient:{filterContext:async()=>[],judge:async()=>({}),rank:async()=>{ranks++;throw Error();}},generateReplies:async()=>['a','b','c']});
  await service.start(1,snapshot(),()=>{});
  const retry=service.retryRanking(1,'r1',()=>{});
  service.cancel(1,'r1');release();await retry;
  assert.equal(ranks,1);
});
test('unconfigured skill IDs fail before any model is called',async()=>{
  const s=setup();await s.service.start(1,{...snapshot(),skillId:'unconfigured'},s.onProgress);
  assert.equal(s.generated,0);assert.equal(s.phases.at(-1).error.code,'SKILL_INVALID');
});
test('mode switching reuses analysis and evidence without rerunning Skill, and caches each mode',async()=>{
  let filters=0,judges=0,ranks=0;const calls=[],phases=[];
  const config={revision:1,contextLimit:10,jevApiKey:'fake',defaultReplyMode:'friendly'};
  const service=createAnalysisService({settingsStore:{readRuntime:async()=>({...config})},jevClient:{filterContext:async(c,s)=>{filters++;return s.candidates.slice(0,1);},judge:async()=>{judges++;return {};},rank:async(c,i)=>{ranks++;assert.equal(i.evidence[0].fact,'调查事实');return i.replies.map(text=>({text,probability:1/3}));}},generateReplies:async(c,i,o)=>{calls.push({i,o});o.onEvidence?.([{fact:'调查事实',source:'合成查询'}]);return ['甲','乙','丙'];}});
  await service.start(1,snapshot(),p=>phases.push(p));
  assert.equal(service.replyText(1,{requestId:'r1',replyId:'reply_a'}),'甲');
  assert.equal(service.replyText(2,{requestId:'r1',replyId:'reply_a'}),null);
  await service.start(1,{...snapshot('r2'),baseRequestId:'r1',modeId:'pushback'},p=>phases.push(p));
  assert.equal(filters,1);assert.equal(judges,1);assert.equal(calls.length,2);
  assert.equal(calls[1].o.skill,undefined);assert.equal(calls[1].i.rewrite,true);assert.equal(calls[1].i.evidence[0].fact,'调查事实');
  assert.equal(phases.at(-1).modeId,'pushback');
  await service.start(1,{...snapshot('r3'),baseRequestId:'r2',modeId:'friendly'},p=>phases.push(p));
  assert.equal(calls.length,2);assert.equal(ranks,2);assert.equal(phases.at(-1).cached,true);
  await service.start(2,{...snapshot('r4'),baseRequestId:'r1',modeId:'firm'},p=>phases.push(p));
  assert.equal(phases.at(-1).error.code,'STALE_REQUEST');assert.equal(calls.length,2);
  config.revision=2;await service.start(1,{...snapshot('r5'),configRevision:2,baseRequestId:'r1',modeId:'firm'},p=>phases.push(p));
  assert.equal(phases.at(-1).error.code,'STALE_REQUEST');
});
test('unknown reply modes fail before external work',async()=>{
  const s=setup();await s.service.start(1,{...snapshot(),modeId:'invalid'},s.onProgress);
  assert.equal(s.generated,0);assert.equal(s.phases.at(-1).error.code,'MODE_INVALID');
});
test('switching back uses the successfully retried ranking rather than an older failed variant',async()=>{
  let fail=true;
  const s=setup({rank:async(c,i)=>{if(fail && i.modeId==='professional')throw Error('ranking');return i.replies.map(text=>({text,probability:1/3}));}});
  await s.service.start(1,snapshot(),s.onProgress);
  await s.service.start(1,{...snapshot('r2'),baseRequestId:'r1',modeId:'friendly'},s.onProgress);
  await s.service.start(1,{...snapshot('r3'),baseRequestId:'r2',modeId:'professional'},s.onProgress);
  fail=false;await s.service.retryRanking(1,'r3',s.onProgress);
  await s.service.start(1,{...snapshot('r4'),baseRequestId:'r3',modeId:'friendly'},s.onProgress);
  await s.service.start(1,{...snapshot('r5'),baseRequestId:'r4',modeId:'professional'},s.onProgress);
  assert.equal(s.phases.at(-1).stage,'complete');assert.equal(s.generated,2);
});
test('interactive skill responses are bound to owner and request and cleared on conversation exit',async t=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-skill-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'SKILL.md');await fs.writeFile(file,'---\nname: synthetic-skill\ndescription: synthetic\n---\nUse synthetic instructions.');
  const phases=[];let answer;
  const service=createAnalysisService({settingsStore:{readRuntime:async()=>({revision:1,contextLimit:10,jevApiKey:'fake',skills:[{id:'skill',name:'合成技能',path:file}]})},jevClient:{filterContext:async()=>[],judge:async()=>({}),rank:async(c,i)=>i.replies},generateReplies:async(c,i,options)=>{assert.equal(options.skill.invocationName,'synthetic-skill');answer=await options.onInteraction({kind:'approval',title:'合成授权',detail:'echo synthetic',canApprove:true});return ['a','b','c'];}});
  const running=service.start(1,{...snapshot(),skillId:'skill'},p=>phases.push(p));
  while(!phases.some(p=>p.interaction))await new Promise(r=>setImmediate(r));
  const interaction=phases.at(-1).interaction;
  service.respond(2,{requestId:'r1',interactionId:interaction.id,approved:true});
  assert.equal(answer,undefined);
  service.respond(1,{requestId:'wrong',interactionId:interaction.id,approved:true});
  assert.equal(answer,undefined);
  service.respond(1,{requestId:'r1',interactionId:interaction.id,approved:false});await running;
  assert.equal(answer.approved,false);assert.equal(phases.at(-1).skillName,'合成技能');
  const next=service.start(1,{...snapshot('r2'),skillId:'skill'},p=>phases.push(p));
  while(!phases.some(p=>p.requestId==='r2' && p.interaction))await new Promise(r=>setImmediate(r));
  service.cancelOwner(1);await next;
  assert(!phases.some(p=>p.requestId==='r2' && p.stage==='complete'));
});
