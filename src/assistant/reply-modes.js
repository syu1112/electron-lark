'use strict';
const modes=Object.freeze([
    {id:'professional',name:'专业',instructions:'事实清楚、结论明确，适合工作沟通。'},
    {id:'friendly',name:'友善',instructions:'温和承接，表达理解和合作意愿，避免机械客套。'},
    {id:'concise',name:'简短',instructions:'少铺垫，直接表达必要回应，尽量一句话。'},
    {id:'firm',name:'坚定',instructions:'明确立场、责任和边界，不无依据地认错或退让。'},
    {id:'pushback',name:'怼人',instructions:'尖锐反驳，指出对方观点中的矛盾和不合理要求，不默认退让；针对具体观点，不编造指控。'},
    {id:'sarcastic',name:'阴阳怪气',instructions:'表面客气，使用反话、反问或适度夸张表达讽刺和不满，带有克制的挖苦感。让讽刺针对具体观点、行为或不合理要求，避免变成普通幽默或直白争吵；不编造事实。'},
    {id:'humorous',name:'幽默',instructions:'轻松调侃、有自然幽默感，不掩盖必须回答的实际问题。'}
]);
function getMode(id='professional'){
    const mode=modes.find(mode=>mode.id===id);
    if(!mode)throw Object.assign(new Error('请选择有效的回复模式'),{code:'MODE_INVALID'});
    return mode;
}
module.exports={modes,getMode};
