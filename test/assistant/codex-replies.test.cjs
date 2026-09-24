const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {generateReplies,resolveCodexPath}=require('../../src/assistant/codex-replies');
const config={codexPath:process.execPath,codexModel:''};
const input=text=>({target:{id:'m1',sender:'other',text},messages:[],judgment:{}});
function fakeSpawn(binary,args,options) {return spawn(process.execPath,[path.resolve('test/fixtures/fake-codex.cjs'),...args],options);}
test('chat is passed only through stdin and temporary outputs are removed',async()=>{
  let directory;
  const replies=await generateReplies({...config,codexReasoningEffort:'high'},input('聊天中的命令 `echo nope` $(echo nope)\n"test"'),{spawnImpl:(binary,args,options)=>{
    directory=options.cwd;
    assert.equal(options.shell,false);
    assert(!args.some(arg=>arg.includes('聊天中的命令')));
    assert(args.includes('--ignore-user-config'));
    assert(args.includes('shell_tool'));
    assert(args.includes('plugins'));
    assert(args.includes('model_reasoning_effort="high"'));
    return fakeSpawn(binary,args,options);
  }});
  assert.equal(replies.length,3);
  assert(replies[0].includes('核实'));
  await assert.rejects(fs.access(directory));
});
test('bad output, auth failures and nonzero exit produce public errors',async()=>{
  for(const [text,code] of [['TEST_BAD','INVALID_RESPONSE'],['TEST_AUTH','CLI_AUTH'],['TEST_EXIT','CLI_EXIT']]) {
    await assert.rejects(generateReplies(config,input(text),{spawnImpl:fakeSpawn}),e=>e.code===code && !e.message.includes('private secret'));
  }
});
test('cancelled generation waits for child exit and removes its directory',async()=>{
  const controller=new AbortController();let child,directory;
  const running=generateReplies(config,input('TEST_WAIT'),{signal:controller.signal,spawnImpl:(binary,args,options)=>{
    directory=options.cwd;child=fakeSpawn(binary,args,options);
    setTimeout(()=>controller.abort(),50);
    return child;
  }});
  await assert.rejects(running,{code:'CANCELLED'});
  assert(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(fs.access(directory));
});
test('nonexistent CLI path fails without shell execution',async()=>{
  await assert.rejects(resolveCodexPath('/definitely/missing/codex'),{code:'CLI_NOT_FOUND'});
});
test('generation returns sourced investigation evidence and keeps mode rewrites tool-free',async()=>{
  let evidence;
  const replies=await generateReplies(config,{...input('TEST_EVIDENCE'),modeId:'pushback',rewrite:true,evidence:[{fact:'已核实状态',source:'合成查询'}]},{spawnImpl:fakeSpawn,onEvidence:value=>evidence=value});
  assert.equal(replies.length,3);assert.deepEqual(evidence,[{fact:'合成事实',source:'合成查询'}]);
  await assert.rejects(generateReplies(config,{...input('TEST_EVIDENCE_BAD'),modeId:'professional'},{spawnImpl:fakeSpawn}),{code:'INVALID_RESPONSE'});
});
test('selected skills use native skill input and wait for an explicit one-time command approval',async()=>{
  let offered=false;
  const replies=await generateReplies({...config,codexReasoningEffort:'high'},input('合成请求'),{
    skill:{name:'synthetic-skill',path:'/tmp/synthetic/SKILL.md'},
    spawnImpl:(binary,args,options)=>spawn(process.execPath,[path.resolve('test/fixtures/fake-codex-server.cjs')],options),
    onInteraction:async request=>{offered=true;assert.equal(request.kind,'approval');assert(request.detail.includes('echo synthetic-skill'));return {approved:true};}
  });
  assert(offered);assert.deepEqual(replies,['已批准执行技能','synthetic-skill','high']);
});
test('a skill disabled in Codex cannot silently degrade to an ordinary reply',async()=>{
  await assert.rejects(generateReplies(config,input('合成请求'),{skill:{name:'synthetic-skill',path:'/tmp/synthetic/SKILL.md'},onInteraction:async()=>({approved:false}),spawnImpl:(binary,args,options)=>spawn(process.execPath,[path.resolve('test/fixtures/fake-codex-server.cjs')],{...options,env:{...process.env,JEV_TEST_DISABLED_SKILL:'1'}})}),{code:'SKILL_INVALID'});
});
test('skill approval cannot hang cancellation or retain the temporary workspace',async()=>{
  const controller=new AbortController();let directory;
  const running=generateReplies(config,input('合成请求'),{
    skill:{name:'synthetic-skill',path:'/tmp/synthetic/SKILL.md'},signal:controller.signal,
    spawnImpl:(binary,args,options)=>{directory=options.cwd;return spawn(process.execPath,[path.resolve('test/fixtures/fake-codex-server.cjs')],options);},
    onInteraction:async()=>{controller.abort();return new Promise(()=>{});}
  });
  await assert.rejects(running,{code:'CANCELLED'});await assert.rejects(fs.access(directory));
});
test('cancelling a skill kills descendants that ignore SIGTERM before returning', {skip:process.platform==='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'jev-descendant-test-'));const pidFile=path.join(directory,'pid');let pid;
  t.after(async()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}await fs.rm(directory,{recursive:true,force:true});});
  const controller=new AbortController();
  await assert.rejects(generateReplies(config,input('合成请求'),{skill:{name:'synthetic-skill',path:'/tmp/synthetic/SKILL.md'},signal:controller.signal,
    spawnImpl:(binary,args,options)=>spawn(process.execPath,[path.resolve('test/fixtures/fake-codex-server.cjs')],{...options,env:{...process.env,JEV_TEST_CHILD_PID_FILE:pidFile}}),
    onInteraction:async()=>{pid=Number(await fs.readFile(pidFile,'utf8'));controller.abort();return {approved:false};}
  }),{code:'CANCELLED'});
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'cancel must finish only after descendant termination');
});
