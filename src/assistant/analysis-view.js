'use strict';
const {labels}=require('./jev-client');
const titles={intent:'可能意图',communication_risk:'沟通风险',other_needs:'对方需求',best_action:'建议动作',literal_meaning:'字面表达',substantive_reply:'实质回复条件',tension_resolved:'紧张是否解除',needed_info:'缺失信息'};
const percent=p=>`${Math.round(p*100)}%`;
function judgmentValue(item,key){
    if(item.type==='score')return `${item.value.toFixed(1)}/${item.max}`;
    if(item.type==='noul'){
        const options={literal_meaning:['有潜台词迹象','偏字面表达'],substantive_reply:['宜先核实或澄清','可提供实质内容'],tension_resolved:['仍可能有紧张','无明显未解紧张']};
        return item.value>.35 && item.value<.65?'判断不明确':options[key]?.[item.value>=.65?1:0] || percent(item.value);
    }
    return item.label || labels[item.value] || item.value;
}
function appendJudgment(document,panel,progress,outgoing){
    if(!progress.judgment)return;
    const create=(tag,text,cls)=>{const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;};
    const title=key=>outgoing && key==='other_needs'?'这条表达希望获得':titles[key];
    const overview=create('div','', 'jev-overview');
    for(const key of ['intent','communication_risk','other_needs','best_action']){
        const item=progress.judgment[key];if(!item)continue;
        overview.append(create('div',`${title(key)}：${judgmentValue(item,key)}${item.confidence!=null?` · 判断把握度 ${percent(item.confidence)}`:''}${item.confidence<.5?' · 依据不足，谨慎解读':''}`));
    }
    panel.append(overview);
    const details=document.createElement('details');details.className='jev-judgment-details';details.append(create('summary','完整判断与概率分布'));
    for(const [key,item] of Object.entries(progress.judgment)){
        details.append(create('div',`${title(key) || key}：${judgmentValue(item,key)}${item.confidence!=null?` · 判断把握度 ${percent(item.confidence)}`:''}`));
        if(item.probabilities)details.append(create('div',Object.entries(item.probabilities).sort((a,b)=>b[1]-a[1]).map(([value,p])=>`${labels[value] || value} ${percent(p)}`).join(' · '),'jev-detail'));
        else if(item.type==='noul')details.append(create('div',`该判断为“是”的概率 ${percent(item.value)}`,'jev-detail'));
    }
    details.append(create('p','意图是基于当前上下文的推测。把握度反映分布是否集中；实质回复条件不表示发送时机。','jev-detail'));
    panel.append(details);
    if(progress.evidence?.length){const evidence=document.createElement('details');evidence.append(create('summary','Skill 调查摘要与来源'));for(const item of progress.evidence)evidence.append(create('p',`${item.fact}\n来源：${item.source}`));panel.append(evidence);}
}
function appendReplyAssessment(document,card,reply,index){
    const meta=document.createElement('div');meta.className='jev-reply-meta';
    meta.textContent=`#${index+1} · ${reply.probability==null?'尚未评估':`本组推荐概率 ${percent(reply.probability)}`}`;card.append(meta);
    if(reply.assessment){
        const {facts,mode,risk}=reply.assessment;
        const detail=document.createElement('div');detail.className='jev-detail';
        detail.textContent=`事实依据：${judgmentValue(facts)} · 模式贴合 ${mode.value.toFixed(1)}/${mode.max} · 升级风险 ${risk.value.toFixed(1)}/${risk.max}`;
        if(facts.value==='unsupported' || facts.value==='unclear')detail.textContent+=' · 使用前需核实';
        if([facts,mode,risk].some(item=>item.confidence<.5))detail.textContent+=' · 评估把握度偏低';
        card.append(detail);
    }
}
module.exports={appendJudgment,appendReplyAssessment};
