'use strict';
const {failure} = require('./settings-store');
const {randomUUID}=require('node:crypto');
const {readSkill}=require('./skills');
const {getMode}=require('./reply-modes');

function createAnalysisService({settingsStore,jevClient,generateReplies}) {
    const owners = new Map();
    function owner(id) {
        if (!owners.has(id)) owners.set(id,{active:null,records:new Map()});
        return owners.get(id);
    }
    function cancel(ownerId,requestId) {
        const state = owners.get(ownerId);
        if (state?.active?.snapshot.requestId === requestId) {
            const record = state.active;
            record.controller.abort();state.active = null;
            record.emit('cancelled');
            state.records.delete(requestId);
        }
    }
    function validate(snapshot,config) {
        getMode(snapshot.modeId || config.defaultReplyMode || 'professional');
        if(snapshot.skillId!=null && snapshot.skillId!=='' && !config.skills?.some(skill=>skill.id===snapshot.skillId))throw failure('SKILL_INVALID','所选 Skill 未配置，请重新选择');
        if (snapshot.configRevision !== config.revision) throw failure('STALE_REQUEST','设置已更新，请重新分析');
        if (typeof snapshot.requestId !== 'string' || !snapshot.requestId || snapshot.requestId.length>100 ||
            typeof snapshot.conversationId !== 'string' || !snapshot.conversationId || snapshot.conversationId.length>500 ||
            snapshot.target?.id !== snapshot.messageId || !Array.isArray(snapshot.candidates) || snapshot.candidates.length>config.contextLimit) {
            throw failure('UNSUPPORTED_MESSAGE','无法确定消息及其上下文');
        }
        const messages = [...snapshot.candidates,snapshot.target];
        if (new Set(messages.map(m=>m?.id)).size !== messages.length || messages.some(m=>
            typeof m?.id !== 'string' || !m.id || typeof m.sender !== 'string' || typeof m.text !== 'string' || !m.text.trim())) {
            throw failure('UNSUPPORTED_MESSAGE','消息缺少可读文本或标识');
        }
        if (messages.reduce((sum,m)=>sum+m.text.length,0)>60000) throw failure('UNSUPPORTED_MESSAGE','上下文过长，请减少前序消息条数');
        if (!config.jevApiKey) throw failure('AUTH','请先在「功能设置 → Jev 助手」配置 Jev Key');
    }
    function messageCopy(message) {
        return {id:message.id,sender:message.sender,text:message.text,...(typeof message.senderId==='string'?{senderId:message.senderId}:{}),
            ...(typeof message.replyToId === 'string' ? {replyToId:message.replyToId} : {}),
            from:['me','other'].includes(message.from) ? message.from : 'unknown'};
    }
    async function runRanking(state,record) {
        record.emit('ranking',{judgment:record.judgment});
        try {
            const replies = await jevClient.rank(record.config,{target:record.snapshot.target,messages:record.messages,judgment:record.judgment,replies:record.replies,modeId:record.modeId,evidence:record.evidence},{signal:record.controller.signal});
            if (state.active !== record || record.controller.signal.aborted) return;
            record.rankedReplies=replies;record.emit('complete',{judgment:record.judgment,replies});
        } catch (error) {
            if (state.active !== record || record.controller.signal.aborted) return;
            record.emit('unranked',{judgment:record.judgment,
                replies:record.replies.map((text,index)=>({id:['reply_a','reply_b','reply_c'][index],text,probability:null})),
                error:{code:error.code || 'HTTP',stage:'ranking',message:'回复已生成，但 Jev 排序失败，可重试排序'}});
        }
    }
    return {
        async start(ownerId,input,onProgress) {
            const state = owner(ownerId);
            if (state.records.has(input?.requestId)) return;
            if (state.active) cancel(ownerId,state.active.snapshot.requestId);
            const snapshot = {requestId:input?.requestId,conversationId:input?.conversationId,messageId:input?.messageId,configRevision:input?.configRevision};
            const record = {snapshot,controller:new AbortController(),stage:'filtering'};
            record.emit = (stage,extra={})=>{
                record.stage=stage;
                onProgress({...snapshot,stage,...extra});
            };
            state.active=record;state.records.set(snapshot.requestId,record);
            try {
                record.config = await settingsStore.readRuntime();
                if (state.active !== record || record.controller.signal.aborted) return;
                validate(input,record.config);
                record.modeId=getMode(input.modeId || record.config.defaultReplyMode || 'professional').id;
                snapshot.target=messageCopy(input.target);snapshot.candidates=input.candidates.map(messageCopy);snapshot.skillId=input.skillId || '';
                const base=input.baseRequestId?state.records.get(input.baseRequestId):null;
                if(input.baseRequestId && (!base || !['complete','unranked'].includes(base.stage) || base.config.revision!==record.config.revision || base.snapshot.conversationId!==snapshot.conversationId || base.snapshot.skillId!==snapshot.skillId || JSON.stringify(base.snapshot.target)!==JSON.stringify(snapshot.target) || JSON.stringify(base.snapshot.candidates)!==JSON.stringify(snapshot.candidates)))throw failure('STALE_REQUEST','原分析已过期或消息有变化，请重新分析');
                if(base){record.messages=base.messages;record.judgment=base.judgment;record.evidence=base.evidence;record.skill=base.skill;}
                else{
                    const selectedSkill=record.config.skills?.find(skill=>skill.id===input.skillId);
                    if(selectedSkill)record.skill=await readSkill(selectedSkill);
                }
                if(state.active!==record || record.controller.signal.aborted)return;
                record.analysisId=base?.analysisId || snapshot.requestId;
                record.evidence=record.evidence || [];
                record.metadata={analysisId:record.analysisId,modeId:record.modeId,skillName:record.skill?.name || '',model:record.config.codexModel || '',reasoningEffort:record.config.codexReasoningEffort || ''};
                record.emit=(stage,extra={})=>{record.stage=stage;onProgress({requestId:snapshot.requestId,conversationId:snapshot.conversationId,messageId:snapshot.messageId,configRevision:snapshot.configRevision,...record.metadata,evidence:record.evidence,stage,...extra});};
                const cached=base && [...state.records.values()].reverse().find(r=>r!==record && r.analysisId===record.analysisId && r.modeId===record.modeId && ['complete','unranked'].includes(r.stage));
                if(cached){
                    record.replies=cached.replies;record.rankedReplies=cached.rankedReplies;
                    record.emit(cached.stage,{cached:true,judgment:record.judgment,replies:cached.rankedReplies || cached.replies.map((text,i)=>({id:['reply_a','reply_b','reply_c'][i],text,probability:null})),...(cached.stage==='unranked'?{error:{code:'HTTP',stage:'ranking',message:'回复已生成，但 Jev 排序失败，可重试排序'}}:{})});return;
                }
                if(!base){
                    record.emit('filtering');
                    record.messages=await jevClient.filterContext(record.config,snapshot,{signal:record.controller.signal});
                    if(state.active!==record || record.controller.signal.aborted)return;
                    record.emit('judging');
                    record.judgment=await jevClient.judge(record.config,{target:snapshot.target,messages:record.messages},{signal:record.controller.signal});
                    if(state.active!==record || record.controller.signal.aborted)return;
                }
                record.emit('generating',{judgment:record.judgment});
                record.replies = await generateReplies(record.config,{target:snapshot.target,messages:record.messages,judgment:record.judgment,modeId:record.modeId,evidence:record.evidence,rewrite:!!base},{signal:record.controller.signal,skill:base?undefined:record.skill,onEvidence:evidence=>{if(!base)record.evidence=evidence;},onInteraction:description=>new Promise((resolve,reject)=>{
                    if(state.active!==record || record.controller.signal.aborted){reject(failure('CANCELLED','已取消'));return;}
                    const id=randomUUID();
                    const abort=()=>{record.interaction=null;reject(failure('CANCELLED','已取消'));};
                    record.controller.signal.addEventListener('abort',abort,{once:true});
                    record.interaction={id,description,resolve:answer=>{record.controller.signal.removeEventListener('abort',abort);record.interaction=null;record.emit('generating',{judgment:record.judgment});resolve(answer);}};
                    record.emit('awaiting_input',{judgment:record.judgment,interaction:{...description,id}});
                })});
                if (state.active !== record || record.controller.signal.aborted) return;
                await runRanking(state,record);
            } catch (error) {
                if (state.active === record && !record.controller.signal.aborted) {
                    record.emit('error',{error:{code:error.code || 'HTTP',stage:record.stage,message:error.code ? error.message : '分析失败，请重试'}});
                    state.records.delete(snapshot.requestId);
                }
            } finally {
                if (state.active === record) state.active=null;
                while (state.records.size>50) state.records.delete(state.records.keys().next().value);
            }
        },
        cancel,
        replyText(ownerId,input){
            const record=owners.get(ownerId)?.records.get(input?.requestId);
            const index=['reply_a','reply_b','reply_c'].indexOf(input?.replyId);
            return record && ['complete','unranked'].includes(record.stage) && index>=0?record.replies[index]:null;
        },
        respond(ownerId,input) {
            const record=owners.get(ownerId)?.active;
            if(!record || record.snapshot.requestId!==input?.requestId || record.interaction?.id!==input?.interactionId || record.controller.signal.aborted || typeof input.approved!=='boolean')return;
            const values=input.values || {};
            if(!values || typeof values!=='object' || Array.isArray(values) || Object.values(values).some(value=>typeof value!=='string' || value.length>32000))return;
            record.interaction.resolve({approved:input.approved,values});
        },
        interactionUrl(ownerId,input) {
            const record=owners.get(ownerId)?.active;
            return record?.snapshot.requestId===input?.requestId && record.interaction?.id===input?.interactionId?record.interaction.description.url:null;
        },
        cancelOwner(ownerId) {
            const state=owners.get(ownerId);
            if (state?.active) cancel(ownerId,state.active.snapshot.requestId);
            owners.delete(ownerId);
        },
        async retryRanking(ownerId,requestId,onProgress) {
            const state=owners.get(ownerId),record=state?.records.get(requestId);
            if (!record?.replies || state.active) return;
            state.active=record;record.controller=new AbortController();
            const {snapshot}=record;
            record.emit=(stage,extra={})=>{record.stage=stage;onProgress({requestId,conversationId:snapshot.conversationId,messageId:snapshot.messageId,configRevision:snapshot.configRevision,...record.metadata,evidence:record.evidence,stage,...extra});};
            try {
                const config=await settingsStore.readRuntime();
                if(owners.get(ownerId)!==state || state.active!==record || record.controller.signal.aborted)return;
                if(config.revision!==record.config.revision)throw failure('STALE_REQUEST','设置已更新，请重新分析');
                await runRanking(state,record);
            } catch(error) {
                if(state.active===record && !record.controller.signal.aborted)record.emit('error',{error:{code:error.code || 'SETTINGS_INVALID',stage:'ranking',message:error.code?error.message:'无法读取配置，请重新分析'}});
            } finally {if(state.active===record)state.active=null;}
        }
    };
}
module.exports={createAnalysisService};
