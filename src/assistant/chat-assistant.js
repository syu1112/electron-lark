'use strict';
const {modes}=require('./reply-modes');
const {appendJudgment,appendReplyAssessment}=require('./analysis-view');

function installChatAssistant({document,ipcRenderer}) {
    const records=new Map();
    const pinnedIds=new WeakMap();
    let conversationId='',active=null,scheduled=false;
    function currentConversation() {
        const pinned=document.querySelector('.feed-shortcut-list-inner .feed-item.active');
        if(pinned){
            if(!pinnedIds.has(pinned))pinnedIds.set(pinned,`pinned:${crypto.randomUUID()}`);
            return pinnedIds.get(pinned);
        }
        return document.querySelector('[data-feed-active="true"]')?.closest('[data-feed-id]')?.getAttribute('data-feed-id') || '';
    }
    const stages={preparing:'正在读取助手配置…',choosing:'选择回复模式和 Skill',awaiting_input:'等待你确认后继续…',filtering:'正在筛选相关上下文…',judging:'正在分析消息…',generating:'正在通过 Codex 生成回复…',ranking:'正在排序推荐回复…',cancelled:'已取消'};
    const style=document.createElement('style');
    style.textContent=`.jev-trigger{border:0;background:transparent;color:#3370ff;padding:6px 9px;cursor:pointer;white-space:nowrap;font:inherit}.jev-panel{margin:8px 0 4px;padding:12px;border:1px solid #dce5ff;border-radius:10px;background:#f7f9ff;color:#1f2329;font:13px/1.6 sans-serif;max-width:620px;white-space:normal}.jev-heading{font-weight:600;margin-bottom:5px}.jev-reply{display:block;width:100%;text-align:left;white-space:pre-wrap;border:1px solid #dce1eb;background:white;border-radius:7px;padding:9px 12px;margin-top:7px;color:inherit;font:inherit;cursor:pointer}.jev-action{border:0;background:transparent;color:#3370ff;padding:5px 10px 0 0;cursor:pointer}.jev-detail{color:#646a73}.jev-error{color:#b54708}`;
    style.textContent+=`.jev-panel{--jev-bg:#fff;--jev-card:#f5f6f7;--jev-border:#dee0e3;--jev-text:#1f2329;--jev-muted:#646a73;--jev-accent:#3370ff;--jev-error:#b54708;background:var(--jev-bg);border-color:var(--jev-border);color:var(--jev-text);box-sizing:border-box;width:100%}.jev-reply,.jev-select,.jev-input{background:var(--jev-card);border:1px solid var(--jev-border);color:var(--jev-text);box-sizing:border-box;max-width:100%;border-radius:6px}.jev-select,.jev-input{font:inherit;padding:7px;width:100%;margin:6px 0}.jev-detail{color:var(--jev-muted)}.jev-action{color:var(--jev-accent)}.jev-error{color:var(--jev-error)}.jev-reply:hover{border-color:var(--jev-accent)}.jev-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}.jev-panel label{display:block}.jev-panel button:focus-visible,.jev-select:focus-visible,.jev-input:focus-visible{outline:2px solid var(--jev-accent);outline-offset:2px}@media(prefers-color-scheme:dark){.jev-panel{--jev-bg:#242424;--jev-card:#303030;--jev-border:#434343;--jev-text:#e5e6eb;--jev-muted:#a6a6a6;--jev-accent:#7aa2ff;--jev-error:#ffb86b;color-scheme:dark}.jev-trigger{color:#7aa2ff}}`;
    style.textContent+=`.jev-overview{padding:8px 0}.jev-panel details{margin:8px 0}.jev-panel summary{cursor:pointer}.jev-reply-card{border:1px solid var(--jev-border);border-radius:8px;padding:10px;margin-top:10px;background:var(--jev-card)}.jev-reply-card .jev-reply{border:0;padding:6px 0;margin:0}.jev-reply-meta{font-weight:600;color:var(--jev-accent)}.jev-panel .jev-mode-label{margin-top:6px}.jev-reply-card p{margin:4px 0}.jev-panel p{overflow-wrap:anywhere}`;
    document.head.append(style);
    const quotedText=row=>row.querySelector('.reply-header .referencePreviewTitle__message')?.textContent.trim() || '';
    function message(row) {
        const text=row.querySelector('.message-text .richTextContainer, .richTextContainer');
        if(!text?.textContent.trim())return null;
        const from=row.classList.contains('message-self')?'me':row.classList.contains('message-not-self')?'other':'unknown';
        const senderId=from==='me'?'me':row.getAttribute('data-sender-id') || `unknown:${row.id}`;
        const sender=from==='me'?'我':row.getAttribute('data-sender-name') || '未知发言人';
        return {id:row.id,text:text.innerText || text.textContent,sender,senderId,from};
    }
    function clear() {
        if(active)ipcRenderer.send('assistant:cancel',active);
        ipcRenderer.send('assistant:clear');
        active=null;records.clear();
        document.querySelectorAll('.jev-panel').forEach(e=>e.remove());
    }
    function valid(record) {
        return record.row?.isConnected && currentConversation()===record.conversationId && record.row.id===record.messageId && JSON.stringify(message(record.row))===record.identity && message(record.row)?.text===record.text && quotedText(record.row)===record.quote;
    }
    function button(label,action,className='jev-action') {
        const el=document.createElement('button');el.type='button';el.className=className;el.textContent=label;
        el.addEventListener('click',event=>{if(!event.isTrusted)return;event.preventDefault();event.stopPropagation();action();});
        return el;
    }
    function render(record,progress) {
        if(!valid(record))return;
        record.progress=progress;
        record.panel?.remove();
        if(record.collapsed)return;
        const panel=document.createElement('section');panel.className='jev-panel';panel.setAttribute('aria-live','polite');panel.setAttribute('data-electron-lark-assistant','');
        const heading=document.createElement('div');heading.className='jev-heading';heading.textContent=message(record.row)?.from==='me'?'Jev · 我的表达与建议':'Jev · 意图分析与回复建议';panel.append(heading);
        const status=document.createElement('div');status.textContent=progress.error?.message || stages[progress.stage] || '选择回复，追加到输入框后可继续编辑';status.className=progress.error?'jev-error':'jev-detail';panel.append(status);
        if(progress.skillName || progress.reasoningEffort){const meta=document.createElement('div');meta.className='jev-detail';meta.textContent=[progress.skillName?`Skill：${progress.skillName}`:'',progress.reasoningEffort?`思考强度：${progress.reasoningEffort}`:''].filter(Boolean).join(' · ');panel.append(meta);}
        if(progress.stage==='choosing'){
            const select=document.createElement('select');select.className='jev-select';select.setAttribute('aria-label','本次分析的 Skill');
            for(const skill of [{id:'',name:'不使用 Skill'},...(record.skills || [])]){const option=document.createElement('option');option.value=skill.id;option.textContent=skill.name;select.append(option);}
            select.value=record.skillId || '';select.addEventListener('change',()=>{record.skillId=select.value;});panel.append(select);
            const modeLabel=document.createElement('label');modeLabel.className='jev-mode-label';modeLabel.textContent='回复模式';const modeSelect=document.createElement('select');modeSelect.className='jev-select jev-mode';modeSelect.setAttribute('aria-label','本次回复模式');for(const mode of modes){const option=document.createElement('option');option.value=mode.id;option.textContent=mode.name;modeSelect.append(option);}modeSelect.value=record.modeId || 'professional';modeSelect.addEventListener('change',()=>{record.modeId=modeSelect.value;});modeLabel.append(modeSelect);panel.append(modeLabel);
            panel.append(button('开始分析',()=>{if(valid(record))start(record.row,record.skillId || '',record.modeId);},'jev-action jev-start'));
        }
        if(progress.interaction){
            const interaction=progress.interaction;
            const title=document.createElement('div');title.className='jev-heading';title.textContent=interaction.title;panel.append(title);
            if(interaction.detail){const detail=document.createElement('pre');detail.textContent=interaction.detail;panel.append(detail);}
            const inputs=[];
            for(const field of interaction.fields || []){
                const label=document.createElement('label');label.textContent=field.label;
                const options=field.options || (field.type==='boolean'?[{label:'是',value:'true'},{label:'否',value:'false'}]:null);
                const input=document.createElement(options?'select':field.secret?'input':'textarea');input.className=options?'jev-select':'jev-input';input.setAttribute('aria-label',field.label);
                if(options){const empty=document.createElement('option');empty.value='';empty.textContent='请选择';input.append(empty);for(const option of options){const el=document.createElement('option');el.value=String(option.value);el.textContent=option.label;input.append(el);}}
                else{input.maxLength=32000;if(field.secret)input.type='password';if(field.type==='array')input.placeholder='填写 JSON 数组，例如 ["a", "b"]';}
                label.append(input);panel.append(label);inputs.push({field,input});
            }
            const respond=approved=>{
                if(!valid(record) || record.progress.interaction?.id!==interaction.id)return;
                if(approved && inputs.some(({field,input})=>field.required && !input.value.trim())){status.textContent='请填写必填内容后继续';return;}
                ipcRenderer.send('assistant:respond',{requestId:record.requestId,interactionId:interaction.id,approved,values:Object.fromEntries(inputs.map(({field,input})=>[field.id,input.value]))});
                panel.querySelectorAll('button').forEach(el=>{el.disabled=true;});status.textContent='已提交，正在继续…';
            };
            if(interaction.url)panel.append(button('打开授权页面',()=>{if(valid(record))ipcRenderer.send('assistant:open-interaction-url',{requestId:record.requestId,interactionId:interaction.id});}));
            if(interaction.canApprove!==false)panel.append(button(interaction.kind==='approval'?'允许本次':interaction.kind==='url'?'已完成授权':'提交',()=>respond(true)));
            panel.append(button(interaction.kind==='approval'?'拒绝':'取消请求',()=>respond(false)));
        }
        appendJudgment(document,panel,progress,message(record.row)?.from==='me');
        if(['complete','unranked'].includes(progress.stage)){
            const label=document.createElement('label');label.textContent='回复模式';
            const select=document.createElement('select');select.className='jev-select jev-mode';select.setAttribute('aria-label','切换回复模式');
            for(const mode of modes){const option=document.createElement('option');option.value=mode.id;option.textContent=mode.name;select.append(option);}select.value=record.pendingModeId || progress.modeId || record.modeId;
            select.addEventListener('change',()=>{record.pendingModeId=select.value;});label.append(select);panel.append(label);
            panel.append(button('切换模式',()=>{if(valid(record))start(record.row,record.skillId || '',select.value,record.requestId);},'jev-action jev-switch-mode'));
        }
        for(const [index,reply] of (progress.replies || []).entries()){
            const card=document.createElement('div');card.className='jev-reply-card';appendReplyAssessment(document,card,reply,index);
            const fill=()=>{
                if(!valid(record))return;
                const editor=record.row.closest('.chatContainer')?.querySelector('.lark__editor--simple.lark__editor--chat [contenteditable="true"]');
                if(!editor){status.textContent='未找到当前会话输入框，请先打开可回复的会话';return;}
                editor.focus();const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);
                const selection=document.defaultView.getSelection();selection.removeAllRanges();selection.addRange(range);
                if(!document.execCommand('insertText',false,(editor.innerText.trim()?'\n':'')+reply.text))status.textContent='插入失败，请手动复制该回复';
                else status.textContent='已追加到输入框，确认后再发送';
            };
            card.append(button(reply.text,fill,'jev-reply'));
            card.append(button('复制',async()=>{if(!valid(record))return;try{const copied=await ipcRenderer.invoke('assistant:copy',{requestId:record.requestId,replyId:reply.id});status.textContent=copied?'已复制回复':'分析已过期，请重新分析';}catch{status.textContent='复制失败，请手动复制';}}));
            card.append(button('填入',fill));panel.append(card);
        }
        if(progress.replies?.length){const note=document.createElement('div');note.className='jev-detail';note.textContent='概率仅比较本组候选，不代表对方接受的成功率；不同模式不能直接比较。';panel.append(note);}
        if(['filtering','judging','generating','ranking','awaiting_input'].includes(progress.stage))panel.append(button('取消',()=>{ipcRenderer.send('assistant:cancel',record.requestId);active=null;render(record,{stage:'cancelled'});}));
        if(progress.stage==='unranked')panel.append(button('重试排序',()=>{if(active){status.textContent='请先等待或取消正在进行的分析';return;}active=record.requestId;ipcRenderer.send('assistant:retry-ranking',record.requestId);}));
        if(record.restore && ['error','cancelled'].includes(progress.stage))panel.append(button('返回已有分析',()=>{if(valid(record))start(record.row,record.restore.skillId,record.restore.modeId,record.restore.requestId);},'jev-action jev-restore'));
        if(['error','complete','unranked','cancelled'].includes(progress.stage))panel.append(button('重新调查并分析',()=>open(record.row,true)));
        panel.append(button('收起',()=>{record.collapsed=true;panel.remove();}));
        (record.row.querySelector('.message-right') || record.row).append(panel);record.panel=panel;
    }
    async function open(row,force=false) {
        const cached=[...records.values()].find(record=>record.row===row && valid(record));
        if(cached && !force){cached.collapsed=false;render(cached,cached.progress);return;}
        if(cached){cached.panel?.remove();records.delete(cached.requestId);}
        const target=message(row),id=currentConversation();
        if(!target){start(row);return;}
        const record={requestId:crypto.randomUUID(),conversationId:id,messageId:row.id,text:target.text,quote:quotedText(row),identity:JSON.stringify(message(row)),row};
        records.set(record.requestId,record);render(record,{stage:'preparing'});
        try{
            const config=await ipcRenderer.invoke('assistant:config');
            if(!records.has(record.requestId) || !valid(record))return;
            record.skills=config.skills || [];record.modeId=config.defaultReplyMode || 'professional';render(record,{stage:'choosing'});
        }catch{render(record,{stage:'error',error:{message:'无法读取助手配置，请在功能设置中检查'}});}
    }
    async function start(row,skillId='',modeId='professional',baseRequestId) {
        if(active && records.get(active)?.row===row)return;
        const id=currentConversation(),target=message(row);
        if(!id || !row.id)return;
        const previous=baseRequestId?(records.get(baseRequestId) || [...records.values()].find(r=>r.row===row)):null;
        for(const [key,old] of records)if(old.row===row){old.panel?.remove();records.delete(key);}
        const record={requestId:crypto.randomUUID(),conversationId:id,messageId:row.id,text:target?.text,quote:quotedText(row),identity:JSON.stringify(message(row)),row,skillId,modeId,contextSnapshot:previous?.contextSnapshot,restore:previous?(['complete','unranked'].includes(previous.progress?.stage)?{requestId:previous.requestId,modeId:previous.modeId,skillId:previous.skillId}:previous.restore):null};
        records.set(record.requestId,record);
        if(!target){render(record,{stage:'error',error:{message:'此消息没有可读文本，暂不支持分析'}});return;}
        if(active)ipcRenderer.send('assistant:cancel',active);
        active=record.requestId;
        try{
            const config=await ipcRenderer.invoke('assistant:config');
            if(active!==record.requestId || !valid(record))return;
            const rows=[...row.closest('.chatMessages').querySelectorAll('.js-message-item')];
            const index=rows.indexOf(row);
            const candidates=record.contextSnapshot?.candidates || rows.slice(Math.max(0,index-config.contextLimit),index).map(message).filter(Boolean);
            if(record.quote && !/…|\.{3}/.test(record.quote)){
                const matches=candidates.filter(candidate=>candidate.text.trim()===record.quote);
                if(matches.length===1)target.replyToId=matches[0].id;
            }
            record.configRevision=config.revision;
            render(record,{stage:'filtering'});
            record.contextSnapshot={target:record.contextSnapshot?.target || target,candidates};
            ipcRenderer.send('assistant:start',{requestId:record.requestId,conversationId:id,messageId:target.id,configRevision:config.revision,...record.contextSnapshot,skillId,modeId,baseRequestId});
        }catch{active=null;render(record,{stage:'error',error:{message:'无法读取助手配置，请在功能设置中检查'}});}
        while(records.size>50){const [key,old]=records.entries().next().value;old.panel?.remove();records.delete(key);}
    }
    function scan() {
        scheduled=false;
        const id=currentConversation();
        if(id!==conversationId){clear();conversationId=id;}
        for(const [key,record] of records)if(!valid(record)){
            record.panel?.remove();
            if(active===key){ipcRenderer.send('assistant:cancel',key);active=null;records.delete(key);continue;}
            const replacement=[...document.querySelectorAll('.chatMessages .js-message-item')].find(row=>row.id===record.messageId);
            if(replacement && JSON.stringify(message(replacement))===record.identity && quotedText(replacement)===record.quote){record.row=replacement;render(record,record.progress);}
            else if(replacement)records.delete(key);
            else record.row=null;
        } else if(record.progress && !record.panel?.isConnected)render(record,record.progress);
        for(const toolbar of document.querySelectorAll('.chatMessages .messageAction__toolbar')) {
            const row=toolbar.closest('.js-message-item');
            if(!row?.id || !id)continue;
            let trigger=toolbar.querySelector('.jev-trigger');
            if(!trigger){trigger=button('Jev 分析',()=>open(row),'jev-trigger');trigger.title='分析此消息并推荐回复';toolbar.append(trigger);}
            const label=[...records.values()].some(record=>record.row===row && ['complete','unranked'].includes(record.progress?.stage))?'查看分析':'Jev 分析';
            if(trigger.textContent!==label)trigger.textContent=label;
        }
    }
    const observer=new MutationObserver(changes=>{
        if(changes.every(change=>change.attributeName==='class' && !change.target.matches('.feed-shortcut-list-inner .feed-item')))return;
        if(!scheduled){scheduled=true;queueMicrotask(scan);}
    });
    observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['id','data-feed-id','data-feed-active','data-sender-id','data-sender-name','class']});
    ipcRenderer.on('assistant:progress',(_event,progress)=>{
        const record=records.get(progress.requestId);
        if(!record || progress.conversationId!==record.conversationId || progress.messageId!==record.messageId || progress.configRevision!==record.configRevision)return;
        if(['complete','unranked','error','cancelled'].includes(progress.stage) && active===record.requestId)active=null;
        render(record,progress);
    });
    ipcRenderer.on('assistant:settings-changed',clear);
    document.defaultView.addEventListener('pagehide',()=>{clear();observer.disconnect();},{once:true});
    scan();
}
module.exports={installChatAssistant};
