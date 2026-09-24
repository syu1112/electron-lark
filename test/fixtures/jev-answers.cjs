module.exports=questions=>Object.fromEntries(Object.entries(questions).map(([key,q])=>{
    if(q.type==='noul')return [key,{type:'noul',noul:key.startsWith('context_')?.1:.7}];
    if(q.type==='score')return [key,{type:'score',score:2,confidence:.8,probabilities:{2:1}}];
    if(key==='best_reply')return [key,{type:'choice',choice:'reply_c',confidence:.8,probabilities:{reply_a:.1,reply_b:.2,reply_c:.7}}];
    const choice={intent:'request_action',needed_info:'facts',best_action:'check_facts',other_needs:'action'}[key] || 'supported';
    return [key,{type:'choice',choice,confidence:.8,probabilities:{[choice]:1}}];
}));
