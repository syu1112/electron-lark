const test=require('node:test');
const assert=require('node:assert/strict');
const {createJevClient}=require('../../src/assistant/jev-client');
const makeAnswers=require('../fixtures/jev-answers.cjs');
const config={jevEndpoint:'https://example.test/decisions',jevApiKey:'fake-key',jevModel:'typesafe/jev-1.13'};
const target={id:'target',sender:'me',text:'就按那个时间',replyToId:'quoted'};
const candidates=['unrelated','uncertain','quoted'].map(id=>({id,sender:'other',text:id}));
test('batch relevance preserves uncertain and quoted messages but removes unrelated',async()=>{
  let request;
  const client=createJevClient({fetchImpl:async(url,options)=>{request={url,...options};return {ok:true,json:async()=>({answers:{context_0:{type:'noul',noul:0.35},context_1:{type:'noul',noul:0.5},context_2:{type:'noul',noul:0.01}}})};}});
  assert.deepEqual((await client.filterContext(config,{target,candidates},{})).map(m=>m.id),['uncertain','quoted']);
  assert.equal(request.redirect,'error');
  assert.equal(Object.keys(JSON.parse(request.body).questions).length,3);
  assert.equal(JSON.parse(request.body).state.target.id,'target');
});
test('missing relevance answer fails rather than returning complete context',async()=>{
  const client=createJevClient({fetchImpl:async()=>({ok:true,json:async()=>({answers:{}})})});
  await assert.rejects(client.filterContext(config,{target,candidates},{}),{code:'INVALID_RESPONSE'});
  assert.deepEqual(await client.filterContext(config,{target,candidates:[]},{}),[]);
});
test('ranking binds probabilities to the original reply IDs independent of object order',async()=>{
  const client=createJevClient({fetchImpl:async(u,o)=>({ok:true,json:async()=>({answers:{...makeAnswers(JSON.parse(o.body).questions),best_reply:{type:'choice',choice:'reply_c',confidence:0.8,probabilities:{reply_c:0.6,reply_a:0.3,reply_b:0.1}}}})})});
  const result=await client.rank(config,{target,messages:[],judgment:{},replies:['甲','乙','丙']},{});
  assert.deepEqual(result.map(r=>r.text),['丙','甲','乙']);
  assert.deepEqual(result.map(r=>r.probability),[0.6,0.3,0.1]);
});
test('full judgments retain independent confidence, option distribution and score semantics',async()=>{
  const answers={intent:{type:'choice',choice:'request_action',confidence:.38,probabilities:{request_action:.65,unclear:.35}},communication_risk:{type:'score',score:2.4,confidence:.6,probabilities:{'2':.6,'3':.4}},needed_info:{type:'choice',choice:'facts',confidence:.8,probabilities:{facts:1}},best_action:{type:'choice',choice:'check_facts',confidence:.8,probabilities:{check_facts:1}},other_needs:{type:'choice',choice:'action',confidence:.7,probabilities:{action:1}},literal_meaning:{type:'noul',noul:.25},substantive_reply:{type:'noul',noul:.3},tension_resolved:{type:'noul',noul:.2}};
  const client=createJevClient({fetchImpl:async()=>({ok:true,json:async()=>({answers})})});
  const result=await client.judge(config,{target,messages:[]},{});
  assert.equal(result.intent.probabilities.request_action,.65);assert.equal(result.intent.confidence,.38);
  assert.equal(result.communication_risk.value,2.4);assert.equal(result.substantive_reply.value,.3);
  answers.communication_risk.score=10;await assert.rejects(client.judge(config,{target,messages:[]},{}),{code:'INVALID_RESPONSE'});
});
test('ranking passes mode and evidence and binds per-candidate assessments',async()=>{
  let sent;const answers={best_reply:{type:'choice',choice:'reply_b',confidence:.5,probabilities:{reply_a:.2,reply_b:.7,reply_c:.1}}};
  for(const id of ['reply_a','reply_b','reply_c']){answers[id+'_facts']={type:'choice',choice:id==='reply_b'?'supported':'unsupported',confidence:.8,probabilities:{[id==='reply_b'?'supported':'unsupported']:1}};answers[id+'_mode']={type:'score',score:3,confidence:.8,probabilities:{3:1}};answers[id+'_risk']={type:'score',score:2,confidence:.8,probabilities:{2:1}};}
  const client=createJevClient({fetchImpl:async(u,o)=>{sent=JSON.parse(o.body);return {ok:true,json:async()=>({answers})};}});
  const result=await client.rank(config,{target,messages:[],judgment:{},replies:['甲','乙','丙'],modeId:'pushback',evidence:[{fact:'合成事实',source:'合成来源'}]},{});
  assert.equal(sent.state.reply_mode.id,'pushback');assert.equal(sent.state.evidence[0].fact,'合成事实');
  assert.equal(result[0].text,'乙');assert.equal(result[0].assessment.facts.value,'supported');assert.equal(result[1].assessment.facts.value,'unsupported');
  delete answers.reply_c_risk;await assert.rejects(client.rank(config,{target,messages:[],replies:['甲','乙','丙']},{}),{code:'INVALID_RESPONSE'});
});
test('fixed workplace choices are validated, including missing fields',async()=>{
  let payload;
  const values={intent:'request_action',needed_info:'facts',best_action:'check_facts'};
  const client=createJevClient({fetchImpl:async(url,options)=>{
    payload=JSON.parse(options.body);
    return {ok:true,json:async()=>({answers:{...makeAnswers(payload.questions),...Object.fromEntries(Object.entries(values).map(([key,choice])=>[key,{type:'choice',choice,confidence:0.8,probabilities:{[choice]:1}}]))}})};
  }});
  const result=await client.judge(config,{target,messages:[]},{});
  assert.equal(result.best_action.value,'check_facts');
  assert(payload.questions.intent.criteria.request_action);
  values.intent='invented';
  await assert.rejects(client.judge(config,{target,messages:[]},{}),{code:'INVALID_RESPONSE'});
});
test('HTTP errors are classified and do not expose service response secrets',async()=>{
  for(const [status,code] of [[401,'AUTH'],[403,'AUTH'],[402,'QUOTA'],[429,'QUOTA'],[500,'HTTP']]) {
    const client=createJevClient({fetchImpl:async()=>({ok:false,status,text:async()=> 'fake-key private-content'})});
    await assert.rejects(client.filterContext(config,{target,candidates},{}),e=>e.code===code && !e.message.includes('fake-key'));
  }
});
test('invalid ranking probabilities and cancelled calls fail explicitly',async()=>{
  const client=createJevClient({fetchImpl:async()=>({ok:true,json:async()=>({answers:{best_reply:{type:'choice',choice:'reply_a',probabilities:{reply_a:1}}}})})});
  await assert.rejects(client.rank(config,{target,messages:[],replies:['a','b','c']},{}),{code:'INVALID_RESPONSE'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(client.filterContext(config,{target,candidates},{signal:controller.signal}),{code:'CANCELLED'});
});
