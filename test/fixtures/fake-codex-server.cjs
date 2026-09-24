const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let turnParams,approved=false,registered=false,root;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const msg=JSON.parse(line);
  if(msg.method==='initialize')send({id:msg.id,result:{userAgent:'test'}});
  if(msg.method==='thread/start')send({id:msg.id,result:{thread:{id:'thread-test'}}});
  if(msg.method==='skills/extraRoots/set'){registered=Array.isArray(msg.params.extraRoots) && msg.params.extraRoots.length===1;root=msg.params.extraRoots[0];send({id:msg.id,result:{}});}
  if(msg.method==='skills/list')send({id:msg.id,result:{data:[{cwd:msg.params.cwds[0],skills:[{name:'synthetic-skill',path:require('node:path').join(root,'SKILL.md'),enabled:!process.env.JEV_TEST_DISABLED_SKILL}],errors:[]}]}});
  if(msg.method==='turn/start'){
    turnParams=msg.params;send({id:msg.id,result:{turn:{id:'turn-test'}}});
    const approval=()=>send({id:'approval-test',method:'item/commandExecution/requestApproval',params:{threadId:'thread-test',turnId:'turn-test',itemId:'command-test',command:'echo synthetic-skill',reason:'synthetic approval',availableDecisions:['accept','decline']}});
    if(process.env.JEV_TEST_CHILD_PID_FILE){
      const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>{require('node:fs').writeFileSync(process.env.JEV_TEST_CHILD_PID_FILE,String(child.pid));approval();});
    }else approval();
  }
  if(msg.id==='approval-test' && msg.result){
    approved=msg.result.decision==='accept';
    const skill=registered && turnParams.input.find(item=>item.type==='skill');
    send({method:'item/completed',params:{threadId:'thread-test',turnId:'turn-test',item:{id:'reply',type:'agentMessage',phase:'final_answer',text:JSON.stringify({evidence:[{fact:'合成技能已经执行',source:'echo synthetic-skill'}],replies:[approved?'已批准执行技能':'已拒绝执行技能',skill?skill.name:'没有使用技能',turnParams.effort||'默认思考']})}}});
    send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed',items:[]}}});
  }
});
