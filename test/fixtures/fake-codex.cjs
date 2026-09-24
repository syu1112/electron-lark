const fs=require('node:fs');
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
  if(input.includes('TEST_AUTH')) {process.stderr.write('authentication required private secret');process.exit(1);}
  if(input.includes('TEST_EXIT')) process.exit(2);
  if(input.includes('TEST_WAIT')) {setInterval(()=>{},1000);return;}
  const index=process.argv.indexOf('--output-last-message');
  const result=input.includes('TEST_BAD') ? {replies:['重复','重复','']} : {replies:['收到，我先核实具体情况。','我确认后再回复你。','还需要补充哪些信息？']};
  result.evidence=input.includes('TEST_EVIDENCE_BAD')?[{fact:'无来源',source:''}]:input.includes('TEST_EVIDENCE')?[{fact:'合成事实',source:'合成查询'}]:[];
  if(input.includes('TEST_EVIDENCE')){const data=JSON.parse(input.split('CHAT_DATA_JSON:\n')[1]);if(data.reply_mode?.id!=='pushback' && !input.includes('TEST_EVIDENCE_BAD'))process.exit(2);}
  fs.writeFileSync(process.argv[index+1],JSON.stringify(result));
});
