# Jev Chat Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 electron-lark 消息悬浮工具栏手动触发 Jev 分析，筛选可配置范围的上下文，经本地 Codex CLI 生成三条回复，再由 Jev 排序并显示在原气泡下。

**Architecture:** Electron 主进程管理配置、凭证、模型请求和 CLI 生命周期；隔离 preload 负责消息定位、真实点击和面板，不向飞书网页暴露模型调用接口。Jev 客户端与 Codex CLI 适配器使用明确数据契约，由单个分析流程串联，所有结果按会话、消息和请求标识绑定。

**Tech Stack:** 现有 Electron 44.4.3、CommonJS、Vue/MDUI 设置页；Node 内置 fetch、child_process、node:test、assert；Electron safeStorage。初版不增加运行时依赖或 Web 框架。

**Spec:** [已确认设计](../specs/2026-09-23-jev-chat-assistant-design.md)。执行者先读该文档，再执行本计划。

## Global Constraints

- 前序消息条数：整数 0–50，默认 10；0 表示只分析所选消息。所选消息不计入 N。
- 只由点击按钮触发；新消息、鼠标悬停和切换会话不会调用模型。
- 前序范围按原消息位置计算，非文本项不向更早位置补足名额；不主动加载更早历史。
- Noul ≤0.35 为明确无关并剔除；≥0.65 为相关；中间区间视为不确定并保留。目标及范围内被直接引用的消息保留。
- 筛选失败显示重试，不静默使用未筛选的完整上下文。
- Jev 单次请求超时 30 秒，Codex 生成超时 120 秒。
- Codex 复用现有认证，不提供回复 LLM 的 OpenAI 兼容 API 地址或 Key 设置。
- Key 使用 Electron safeStorage 加密保存；安全存储不可用时提示无法保存 Key，不退化为明文持久化。
- 候选插入已有草稿末尾；不触发 Enter、发送按钮或消息发送 API。
- 只新增功能需要的代码和回归适配；保留用户现有 `.gitignore` 改动，不将其加入任务提交。
- 测试使用合成消息和模拟接口。没有额外授权时不将真实飞书聊天用于外部联调，不发送测试消息给他人。

## Review Focus

1. 虚拟列表把原 DOM 节点复用给另一条消息：按钮、面板和迟到结果都必须重新校验身份。由任务 6 的 DOM 集成测试覆盖。
2. 配置变化与旧分析并发：每次请求冻结配置，旧 Key/模型对应的结果不能覆盖新请求。由任务 4、5 覆盖。
3. 点击目标处于历史中段：只使用它之前 N 条，图片占名额，后来的消息和助手文字不能进入上下文。由任务 6 覆盖。
4. 聊天中包含 shell 片段、提示注入或 HTML：它只能作为数据，不能执行命令、渲染可执行 HTML 或触发自动发送。由任务 3、5、6 覆盖。
5. CLI 超时、取消或排序失败：不留下悬挂进程；已生成候选在排序失败时仍可用，重试排序不重新生成。由任务 3、4 覆盖。

## 文件与接口地图

| 文件 | 职责 |
| --- | --- |
| `src/assistant/settings-store.js` | AI 设置验证、普通配置合并、Key 加解密和脱敏状态。 |
| `src/assistant/jev-client.js` | Jev HTTP 请求、相关性筛选、固定工作沟通题和排序。 |
| `src/assistant/codex-replies.js` | CLI 路径解析、受控参数、stdin、结果读取和进程清理。 |
| `src/assistant/replies.schema.json` | 三条回复的结构化输出 schema，随 `src/**/*` 打包。 |
| `src/assistant/analysis-service.js` | 阶段编排、配置快照、重复请求、取消及仅排序重试。 |
| `src/assistant/chat-dom.js` | 真实飞书 DOM 适配、上下文提取和编辑器填入。 |
| `src/assistant/chat-assistant.js`、`chat-assistant.css` | 悬浮按钮、面板与页面生命周期。 |
| `src/chat-preload.js`、`src/settings-preload.js` | 分别提供隔离页面逻辑、受限本地设置 API。 |
| `src/main.js`、`src/configuration.js` | 创建模块实例、配置路径、IPC 与窗口接线。 |
| `src/chat-shortcuts.js`、`src/windows/views/settings.html` | 保留快捷键与原设置，新增 Jev 页并移除直接 fs/require。 |
| `test/assistant/*.test.cjs` | 主进程模块的 Node 测试。 |
| `test/assistant-ui.cjs`、`test/assistant-fixture.html` | Electron 隔离、可信点击、DOM 生命周期和设置集成。 |
| `test/fixtures/fake-codex.cjs` | 合成 CLI 响应、退出、延迟和取消场景。 |
| `test/upgrade.cjs`、`test/chat-fixture.html`、`package.json`、`README.md` | 现有回归兼容、测试命令与使用说明。 |

跨模块契约固定如下；对象仅包含 JSON 可序列化数据：

```js
// Message: { id, sender, text, replyToId?, from? }; id/sender/text 均为字符串。
// from 可为 'me'|'other'|'unknown'；缺省 unknown，不用左右位置猜测身份。
// Snapshot: { requestId, conversationId, messageId, configRevision,
//             target: Message, candidates: Message[] }
// Settings: { contextLimit, jevEndpoint, jevModel, codexPath, codexModel }
// PublicSettings: Settings + { hasJevKey, revision }
// RuntimeConfig: Settings + { jevApiKey, revision }
// Judgment: { intent, communication_risk, needed_info, best_action }
// 每个 Judgment 值为 { value: string, confidence: number }。
// Reply: { id: 'reply_a'|'reply_b'|'reply_c', text: string, probability: number|null }
// Progress: { requestId, conversationId, messageId, configRevision,
//             stage: 'filtering'|'judging'|'generating'|'ranking'|'complete'|
//                    'unranked'|'cancelled'|'error', judgment?, replies?,
//             error?: { code, stage, message } }
```

统一错误 code 使用 `SETTINGS_INVALID`、`KEY_UNAVAILABLE`、`AUTH`、`QUOTA`、`HTTP`、`TIMEOUT`、`CANCELLED`、`INVALID_RESPONSE`、`CLI_NOT_FOUND`、`CLI_AUTH`、`CLI_EXIT`、`STALE_REQUEST`、`UNSUPPORTED_MESSAGE`。message 使用应用固定中文文案；原始服务 body 和 CLI stderr 不直接发给页面或写日志。

任务依赖：1 → 2/3 → 4 → 5 → 6 → 7。任务 2、3 可独立开发；任务 5、6 修改相同窗口接入时应顺序进行。

### Task 1: 配置存取和加密 Key

**Files:** Create `src/assistant/settings-store.js`, `test/assistant/settings-store.test.cjs`；Modify `src/configuration.js`。

**Interfaces:**
- `createSettingsStore({configFile, safeStorage})` 返回 `{readPublic(), readRuntime(), save(input)}`，方法返回 Promise。
- `save(input)` 接受现有三个普通设置及 `assistant`；assistant 内额外 `jevApiKey` 空值表示保留，`clearJevKey: true` 表示清除，两者非空同时提交则报错。
- `readPublic()` 返回 `{startPageLink,larkOpenLink,showWarterMark,assistant: PublicSettings}`；`readRuntime()` 返回 RuntimeConfig。
- 每次成功保存助手设置递增 revision；未知原配置字段保留，不向 public 返回密文。

- [ ] **Step 1: 写配置边界及保留 Key 的失败测试。** 测试用临时目录和假 safeStorage，不触碰真实 Keychain。

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createSettingsStore} = require('../../src/assistant/settings-store');
test('保存范围并在空 Key 输入时保留凭证', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-settings-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const store = createSettingsStore({configFile:path.join(dir,'config.json'), safeStorage:{
    isEncryptionAvailable:() => true,
    encryptString:text => Buffer.from(text.split('').reverse().join('')),
    decryptString:buffer => buffer.toString().split('').reverse().join('')
  }});
  await store.save({assistant:{contextLimit:0, jevApiKey:'test-only-key'}});
  await store.save({assistant:{contextLimit:50, jevApiKey:''}});
  assert.equal((await store.readRuntime()).jevApiKey, 'test-only-key');
  assert.equal((await store.readPublic()).assistant.contextLimit, 50);
  assert(!JSON.stringify(await store.readPublic()).includes('test-only-key'));
  for (const contextLimit of [-1, 51, 1.5, NaN]) {
    await assert.rejects(store.save({assistant:{contextLimit}}), {code:'SETTINGS_INVALID'});
  }
});
```

- [ ] **Step 2: 运行失败测试。** `node --test test/assistant/settings-store.test.cjs`；预期缺少模块而失败，记录该失败。
- [ ] **Step 3: 实现默认值、合并和保存。** 默认值：10、官方完整 endpoint、`typesafe/jev-1.13`、空 CLI 路径和模型。用 `Number.isInteger` 验证范围；URL 仅 HTTPS 且 username/password 为空。先验证并加密，再通过同目录临时文件 + rename 原子写入，避免失败时损坏原配置。读配置不打印内容。

```js
const endpoint = new URL(settings.jevEndpoint);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
  throw Object.assign(new Error('请输入不含用户名或密码的 HTTPS 地址'), {code:'SETTINGS_INVALID'});
}
const encrypted = safeStorage.encryptString(input.assistant.jevApiKey).toString('base64');
// 持久化字段 assistant.jevKeyEncrypted；仅 readRuntime 解密，public 只返回 hasJevKey。
```

- [ ] **Step 4: 补充并运行安全存储不可用、清除 Key、非法 endpoint、原设置/未知字段保留、失败保存 revision 不变测试。** 每个用例构造假存储或临时 config，断言明确 code 和持久化结果；Linux safeStorage backend 为 basic_text 时同样按安全存储不可用处理。测试全部通过后再交给下游。
- [ ] **Step 5: 检查本任务 diff。** 仅包含配置模块、路径和测试；若执行环境允许任务提交，提交 `feat: add encrypted Jev assistant settings`，不要包含用户的 `.gitignore`。

### Task 2: Jev 筛选、判断与排序

**Files:** Create `src/assistant/jev-client.js`, `test/assistant/jev-client.test.cjs`。

**Interfaces:**
- `createJevClient({fetchImpl = globalThis.fetch})` 返回 `{filterContext, judge, rank}`。
- `filterContext(config, snapshot, {signal}) → Promise<Message[]>` 返回筛后的前序项，目标单独保留。
- `judge(config, {target,messages}, {signal}) → Promise<Judgment>`。
- `rank(config, {target,messages,judgment,replies}, {signal}) → Promise<Reply[]>`；replies 输入三个字符串。

- [ ] **Step 1: 写一次批量筛选及阈值测试。** 通过 fetchImpl 返回固定响应，并断言未跟随重定向、请求中的候选位置准确。

```js
test('剔除明确无关项并保留不确定项与直接引用', async () => {
  let request;
  const client = createJevClient({fetchImpl:async (url, options) => {
    request = {url, ...options};
    return {ok:true, status:200, json:async () => ({answers:{
      context_0:{type:'noul',noul:0.35},
      context_1:{type:'noul',noul:0.5},
      context_2:{type:'noul',noul:0.01}
    }})};
  }});
  const config = {jevEndpoint:'https://example.test/decisions',jevApiKey:'test-key',jevModel:'typesafe/jev-1.13'};
  const target = {id:'target',sender:'me',text:'就按那个时间',replyToId:'quoted'};
  const candidates = ['unrelated','uncertain','quoted'].map(id => ({id,sender:'other',text:id}));
  const kept = await client.filterContext(config,{target,candidates},{signal:new AbortController().signal});
  assert.deepEqual(kept.map(message => message.id), ['uncertain','quoted']);
  assert.equal(request.redirect, 'error');
  assert.equal(Object.keys(JSON.parse(request.body).questions).length, 3);
});
```

测试文件顶部引入 `node:test`、`node:assert/strict` 和 `createJevClient`，不使用真实网络。
- [ ] **Step 2: 运行 `node --test test/assistant/jev-client.test.cjs` 并记录失败。**
- [ ] **Step 3: 实现批量 Noul 请求。** 每条 candidates 对应 `context_i`；instructions 显式引用 `state.messages[i]` 和 `state.target`。空候选直接返回空数组，不请求。输入消息保持时间顺序。

```js
questions[`context_${index}`] = {
  type:'noul',
  instructions:`Is messages[${index}] necessary to understand or reply to target?`,
  criteria:{
    true:'The same issue, direct quotation, question-answer link, referential continuation, or necessary factual constraint.',
    false:'An independent topic or notification that is not needed to understand or reply to target.'
  }
};
// POST body: {model:config.jevModel,state:{target,messages:snapshot.candidates},questions}
// fetch options: method:'POST', redirect:'error', headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'}
// signal 合并调用方取消与 AbortSignal.timeout(30000)。
```

- [ ] **Step 4: 实现四个主分析 Choice。** 完整采用设计中的 key、选项和中文含义；criteria 写明英文语义。解析 `answers[key].choice`，检查属于问题枚举，confidence 必须是有限 0–1。返回 `{value:choice,confidence}`；任一必需项缺失或非法则 `INVALID_RESPONSE`。
- [ ] **Step 5: 实现三候选排序并补充响应校验测试。** criteria 固定 `reply_a/b/c` 映射输入位置；按 probabilities 对每条候选绑定后稳定降序，不依赖 JSON 属性顺序。缺项、非有限值、越界值或总和偏离 1 超过 0.01 时失败。测试用 `{reply_c:0.6,reply_a:0.3,reply_b:0.1}` 断言顺序为 c/a/b，文本绑定准确。
- [ ] **Step 6: 验证错误和取消。** 401/403→AUTH、402/429→QUOTA、其他非 2xx→HTTP，30 秒超时→TIMEOUT，调用方取消→CANCELLED。不把服务 body 拼入公开错误，不自动重试。缺失任意 context answer 时断言整次 filterContext 拒绝，不能返回原数组。
- [ ] **Step 7: 全部测试通过并审阅本任务 diff。** 可用时提交 `feat: add Jev context filtering and reply ranking`。

### Task 3: 本地 Codex 回复生成

**Files:** Create `src/assistant/codex-replies.js`, `src/assistant/replies.schema.json`, `test/assistant/codex-replies.test.cjs`, `test/fixtures/fake-codex.cjs`。

**Interfaces:**
- `resolveCodexPath(configuredPath) → Promise<string>`：先验证显式路径；为空时查 PATH 和已核实的 `/Applications/ChatGPT.app/Contents/Resources/codex`。失败返回 CLI_NOT_FOUND。
- `generateReplies(config, {target,messages,judgment}, {signal, spawnImpl = spawn}) → Promise<string[]>`。
- `spawnImpl` 与 Node spawn 签名相同，仅供主进程内部测试注入，不是设置项或 IPC 参数。

- [ ] **Step 1: 写结构化输出 schema 和假 CLI。** schema 内容如下；假 CLI 仅读取 stdin，在遇到合成文本 `TEST_EXIT` 时退出 2、`TEST_WAIT` 时等待终止，否则向 `--output-last-message` 指定的文件写下列回复 JSON。假 CLI 不运行 stdin 的任何内容。

```json
{"type":"object","properties":{"replies":{"type":"array","minItems":3,"maxItems":3,"items":{"type":"string","minLength":1}}},"required":["replies"],"additionalProperties":false}
```

```js
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input.includes('TEST_EXIT')) process.exit(2);
  if (input.includes('TEST_WAIT')) { setInterval(() => {}, 1000); return; }
  const index = process.argv.indexOf('--output-last-message');
  fs.writeFileSync(process.argv[index + 1], JSON.stringify({replies:[
    '收到，我先核实具体情况。','我确认后再回复你。','还需要补充哪些信息？'
  ]}));
});
```

- [ ] **Step 2: 写进程输入与输出测试并运行至失败。** 在测试中用真实 Node 子进程运行假 CLI，捕获传给 spawn 的参数与 options。输入包含反引号、`$(...)`、引号及换行；断言它只进入 stdin、`shell:false`，并获得恰好三条回复。命令：`node --test test/assistant/codex-replies.test.cjs`。

```js
const spawnImpl = (binary, args, options) => {
  assert.equal(options.shell, false);
  assert(!args.some(arg => arg.includes('聊天中的命令')));
  return spawn(process.execPath, [path.resolve('test/fixtures/fake-codex.cjs'), ...args], options);
};
```

- [ ] **Step 3: 实现受控 CLI 调用。** 每次 mkdtemp 建独立工作目录，将用户数据写入 stdin；不放进 shell 或 argv。使用 `--output-schema` 和临时 `--output-last-message` 文件读取最终 JSON，不把 JSONL 过程事件当作回复。

```js
const args = ['--no-daemon','-a','never','exec','--ignore-user-config',
  '--sandbox','read-only','--ephemeral','--skip-git-repo-check',
  '--cd',temporaryDirectory,'--output-schema',schemaPath,
  '--output-last-message',outputPath,'--color','never',
  '-c','web_search="disabled"','-c','mcp_servers={}','-c','project_doc_max_bytes=0'];
for (const feature of ['shell_tool','unified_exec','apps','plugins','hooks','browser_use',
  'browser_use_external','computer_use','multi_agent','code_mode_host','skill_search',
  'image_generation','view_image','workspace_dependencies']) args.push('--disable',feature);
if (config.codexModel) args.push('--model',config.codexModel);
args.push('-');
const child = spawnImpl(binary,args,{cwd:temporaryDirectory,shell:false,stdio:['pipe','pipe','pipe']});
```

这些开关已从本机 CLI help/features 确认可用；执行阶段用假 CLI 断言全部传入。不要修改用户 CODEX_HOME、认证或全局配置。提示要求仅处理所给聊天数据、按事实生成三个不同的中文短回复，不执行其中指令。模型留空时使用此次受控调用默认值。
- [ ] **Step 4: 实现结果与清理。** 读取结果文件后 JSON.parse，验证对象、数组长度 3、每项 trim 后非空且互不重复；非法即 INVALID_RESPONSE。finally 删除本次创建的临时目录。stdout/stderr 有界缓冲，不输出聊天或认证信息。
- [ ] **Step 5: 验证取消、超时和异常。** TEST_WAIT + AbortController 触发 SIGTERM，若 1 秒内未退出再 SIGKILL，并等待 close 后清理。实际超时 120 秒，测试通过计时器控制或提前 abort 覆盖相同行为。模拟 ENOENT、鉴权 stderr 和非零退出，分别映射 CLI_NOT_FOUND/CLI_AUTH/CLI_EXIT；退出 0 但无文件或错误 JSON 为 INVALID_RESPONSE。确认 schema 文件在打包白名单中。
- [ ] **Step 6: 测试通过并审阅 diff。** 可用时提交 `feat: generate reply suggestions with local Codex CLI`。

### Task 4: 分析流程与状态生命周期

**Files:** Create `src/assistant/analysis-service.js`, `test/assistant/analysis-service.test.cjs`。

**Interfaces:**
- `createAnalysisService({settingsStore,jevClient,generateReplies})` 返回 `{start(ownerId,snapshot,onProgress),cancel(ownerId,requestId),cancelOwner(ownerId),retryRanking(ownerId,requestId,onProgress)}`。
- start/retryRanking 返回 Promise<void>；结果通过 Progress 回调。ownerId 由主进程 webContents.id 提供，不由网页提交。
- 每个 owner 同时只有一个活动分析；新分析取消旧分析。同 requestId 重复 start 不重复请求。
- 每个 owner 保留最近 50 条完成或 unranked 记录；cancelOwner 清理该窗口所有记录和请求。

- [ ] **Step 1: 编写阶段顺序和不外泄无关上下文测试。** 使用假的 settingsStore、jevClient 和 generateReplies。filterContext 固定只返回 m1；judge、generateReplies、rank 各自断言输入没有 m2；最后断言进度顺序准确。

```js
const stages = [];
const seen = [];
const config = {revision:1,contextLimit:10,jevApiKey:'test'};
const judgment = {intent:{value:'request_action',confidence:0.8}};
const messages = [{id:'m1',sender:'other',text:'相关事项'}];
const service = createAnalysisService({settingsStore:{readRuntime:async()=>config},
  jevClient:{filterContext:async()=>messages,
    judge:async(c,input)=>{seen.push(input.messages);return judgment;},
    rank:async(c,input)=>{seen.push(input.messages);return input.replies.map((text,i)=>({id:['reply_a','reply_b','reply_c'][i],text,probability:[0.6,0.3,0.1][i]}));}},
  generateReplies:async(c,input)=>{seen.push(input.messages);return ['回复一','回复二','回复三'];}});
await service.start(1,{requestId:'r1',conversationId:'c1',messageId:'target',configRevision:1,
  target:{id:'target',sender:'me',text:'请处理'},candidates:[...messages,{id:'m2',sender:'other',text:'无关'}]},
  event=>stages.push(event.stage));
assert.deepEqual(stages,['filtering','judging','generating','ranking','complete']);
assert(seen.every(items=>items.length===1 && items[0].id==='m1'));
```

- [ ] **Step 2: 运行 `node --test test/assistant/analysis-service.test.cjs`，确认失败后实现编排。** 在首个 await 前登记 requestId 和 AbortController，冻结配置与 snapshot；等待每阶段结束后检查 signal 和活动 requestId，再推进。
- [ ] **Step 3: 实现输入和配置校验。** 核对目标 ID、非空文本、唯一候选 ID、目标不出现在 candidates、候选数不超过冻结 contextLimit、configRevision 与当前 revision 一致。不接受输入中自带 Key、endpoint 或 CLI 参数。配置已变返回 STALE_REQUEST，preload 刷新公开设置后允许用户重试。
- [ ] **Step 4: 覆盖关键失败。** filterContext 抛错时 judge、generateReplies、rank 均未调用；生成失败不调用 rank。rank 失败时发送 unranked，保留三条 probability:null 的候选。retryRanking 仅重用该记录冻结的筛后上下文和候选调用 rank，不能再次生成；配置 revision 改变则拒绝旧记录重排，要求重新分析。
- [ ] **Step 5: 覆盖并发及取消。** 用手动可 resolve 的 Promise 延迟旧请求，启动新请求后完成旧请求，断言旧结果不会发送 complete。cancel、cancelOwner 和窗口关闭必须传递 abort；缓存超过 50 时删除最早完成记录，不能删除仍活动的任务。
- [ ] **Step 6: 全部模块测试通过并审阅 diff。** 可用时提交 `feat: orchestrate cancellable Jev reply analysis`。

### Task 5: Electron 隔离、受限 IPC 与设置页

**Files:** Create `src/chat-preload.js`, `src/settings-preload.js`, `test/assistant-ui.cjs`, `test/assistant-fixture.html`；Modify `src/main.js`, `src/chat-shortcuts.js`, `src/windows/views/settings.html`, `test/upgrade.cjs`, `package.json`。

**Interfaces:**
- 主进程 IPC：`assistant:public-settings`、`assistant:start`、`assistant:cancel`、`assistant:retry-ranking`、`assistant:progress`；设置专用 `settings:read`、`settings:save`、`settings:open-external`。
- 主窗口不通过 contextBridge 暴露 assistant:start；只有隔离 preload 内的真实点击处理器可调用它。
- `settings-preload.js` 暴露 `window.desktopSettings = {read,save,openExternal}`；不暴露 fs、通用 invoke 或 Key 读取方法。
- 配置保存后向主窗口发送脱敏的 `assistant:settings-changed`，preload 更新 contextLimit/revision，正在执行的快照不改写；取消仍活动的旧请求、清理旧面板并提示设置已更新，用户再次点击时使用新配置。

- [ ] **Step 1: 先写 Electron 隔离与来源检查失败测试。** test/assistant-ui.cjs 使用临时 userData，加载本地合成页面，临时文件和窗口在 finally 中清理。断言主世界 `typeof require === 'undefined'`、`typeof window.assistant === 'undefined'`；错误窗口和子 frame 调用设置 IPC 被拒绝。
- [ ] **Step 2: 运行 `node_modules/.bin/electron test/assistant-ui.cjs` 确认失败。** 受限环境若 Electron SIGABRT，使用已验证的沙箱外运行方式，不改产品安全设置来迁就测试。
- [ ] **Step 3: 接入 main 和 preloads。** 主窗口 nodeIntegration:false、contextIsolation:true，preload 使用本地受信模块；初版为支持 CommonJS preload 模块显式使用 sandbox:false，网页仍无 Node 能力。设置窗口使用独立的仅 require('electron') 的 preload 和默认 renderer sandbox，将原函数内 settingsWindow 改为受主进程管理的单实例引用，重复打开时聚焦。主进程仅接受对应 webContents 的主 frame，主窗口来源必须匹配配置启动页的精确 origin，设置来源必须等于本地 settings.html。

```js
function isMainWindowSender(event) {
  return event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    new URL(event.senderFrame.url).origin === allowedMainOrigin;
}
// ownerId 永远取 event.sender.id；导航离开可信 origin、关闭和销毁都 cancelOwner。
```

该函数在所有助手请求处理器中复用；配置存取只在设置窗口 IPC 中授权。拒绝无法解析的 URL。分析阶段不接受来自 renderer 的运行参数。
- [ ] **Step 4: 迁移通知与快捷键。** 保留只处理通知的桥接 `window.larkDesktop.notify` 及只读平台标记；通知构造替换仍运行在页面主世界。chat-shortcuts.js 改读只读平台标记，保持原始 trusted keyboard event 的处理位置，不把原始事件改写迁到隔离世界。移除 `get-config-path` 和完整配置日志。
- [ ] **Step 5: 实现设置页。** Vue 数据包含独立 assistant 表单和 Key 输入；类型 number 的 contextLimit 设 min=0/max=50/step=1，但主进程仍验证。CLI 路径、可选模型、endpoint、Jev 模型、Key 保存/保留/清除按设计执行。用原 MDUI 风格显示成功/失败，保存失败保持输入可修改；数据去向说明放在 Jev 页。

```js
const saved = await window.desktopSettings.save({
  startPageLink:pageData.startPageLink,larkOpenLink:pageData.larkOpenLink,
  showWarterMark:pageData.showWarterMark,
  assistant:{...pageData.assistant,jevApiKey:pageData.jevApiKeyInput,clearJevKey:pageData.clearJevKey}
});
pageData.assistant = saved.assistant;
pageData.jevApiKeyInput = '';
pageData.clearJevKey = false;
```

- [ ] **Step 6: 运行设置和现有回归。** 验证保存0/50/非法值、重开窗口、留空Key保留、清除、旧三项设置。回归通知 reload、外链、托盘和快捷键，保留原断言含义。此前 Enter 换行有一项基线失败；如果仍失败，按 systematic-debugging 查真实键盘事件链，不能删除或降低断言掩盖失败。
- [ ] **Step 7: 注册 `test:assistant:unit` 为 `node --test test/assistant/*.test.cjs`，`test:assistant:ui` 为 `electron test/assistant-ui.cjs`。** 原 `npm test` 改为依次执行原 upgrade、助手 unit、助手 UI，任何失败都返回非零。测试通过后审阅 diff，可用时提交 `feat: wire isolated assistant IPC and settings`。

### Task 6: 飞书消息适配与气泡面板

**Files:** Create `src/assistant/chat-dom.js`, `src/assistant/chat-assistant.js`, `src/assistant/chat-assistant.css`；Modify `src/chat-preload.js`, `test/assistant-ui.cjs`, `test/assistant-fixture.html`。

**Interfaces:**
- `createChatDomAdapter(document)` 返回 `{getConversationId(),getMessageRows(),getMessage(row),getActionToolbar(row),getPanelHost(row),appendDraft(conversationId,text)}`。
- getMessageRows 只返回当前会话按时间排列的消息元素；getMessage 返回 Message 或 null，sender 使用页面真实标识，不靠左右位置猜测。
- `captureContext(adapter,row,{contextLimit,revision}) → Snapshot`；requestId 用 crypto.randomUUID，configRevision 取 revision。
- `installChatAssistant({document,adapter,readPublicSettings,start,cancel,retryRanking,onProgress,onSettingsChanged}) → dispose`；start/cancel 等由隔离 preload 封闭注入，不挂到 window。

- [ ] **Step 1: 只读核实真实 DOM 接入点。** 用当前 Electron Lark 开发工具检查消息行 ID、会话 ID、正文、工具栏是否在独立 portal、消息引用及编辑器容器。只记录标签名、class/属性名和关联规则；不保存真实聊天文本或凭证。将观察到的结构用合成文本写入 assistant-fixture.html。若浮窗通过 portal 呈现，必须证明 active message 与 portal 的关联，不能按最后 hover 时间或位置猜测。
- [ ] **Step 2: 写上下文提取测试并先运行失败。** 合成列表依次为 m0文本、m1图片、m2文本、target文本、future文本；N=2 必须只取 m1/m2，不补m0，不取future，target单独保留。N=0候选为空；目标缺失或无可读文本抛 UNSUPPORTED_MESSAGE。候选中图片的 text 为空，筛选前不发送空正文项，也不向前补数。

```js
const snapshot = captureContext(adapter,targetRow,{contextLimit:2,revision:3});
assert.equal(snapshot.messageId,'target');
assert.equal(snapshot.configRevision,3);
assert.deepEqual(snapshot.candidates.map(message=>message.id),['m2']);
assert(!JSON.stringify(snapshot).includes('future'));
```

- [ ] **Step 3: 实现真实 DOM 适配。** 将已观察到的选择器集中在 chat-dom.js，只在当前会话根节点内查询。正文提取排除工具栏、发送状态、时间分隔和 `[data-electron-lark-assistant]` 子树。发送人是否为自己只能依据已核实的页面身份标记；无法确定时 from=unknown，提示中不臆测用户的既有立场。引用使用可核实 ID；无 ID 时只在候选中做唯一且完整的引用文本匹配，重复或截断引用不做强制保留。不能确定会话/消息身份时不插入可点击分析入口。
- [ ] **Step 4: 实现按钮和分阶段面板。** 监听相关容器 MutationObserver 并合并同一帧更新；每个真实工具栏最多一个按钮。面板插在 getPanelHost 返回的消息内容下方，带助手专用标记；使用 textContent 渲染模型文本，CSS 命名使用 `elark-assistant-` 前缀并支持窄窗口、长文本换行。取消、关闭、重试及排序重试使用各自明确按钮。

```js
button.addEventListener('click', async event => {
  if (!event.isTrusted) return;
  event.preventDefault();
  event.stopPropagation();
  const settings = await readPublicSettings();
  const snapshot = captureContext(adapter,row,settings.assistant);
  start(snapshot);
});
// progress 处理必须同时匹配当前 conversationId、messageId、requestId、configRevision，
// 并重新读取 row 的消息 ID 与正文，不能只检查旧元素 isConnected。
```

- [ ] **Step 5: 用真实输入事件验证触发边界。** Electron 测试用 webContents.sendInputEvent 对 fixture 中观察得到的按钮坐标点击；单纯 page dispatchEvent 不应启动。启动、hover、添加新消息、切会话、重挂DOM和脚本模拟点击时请求计数均为0；真实点击一次后计数为1，重复点击进行中的同一请求不增加计数。
- [ ] **Step 6: 验证节点复用与迟到结果。** 真实点击 m1 后，将同一 row 改成 m2 再回送 m1 complete；断言 m2 没有 m1 面板。切换会话、编辑目标正文、卸载/重新加载行也进行等价测试。缓存只按消息身份恢复，并限制最多50条；正文或配置变化后旧结果失效。
- [ ] **Step 7: 实现草稿填入并验证。** 在同会话可编辑内容末尾建立 selection，用浏览器编辑命令插入纯文本以触发编辑器正常输入流程，不直接替换整个 innerHTML。不存在输入框、已切会话或编辑器不可编辑时提示，不尝试点击发送。测试草稿`已有内容`加候选后仍保留原文；包含`<img onerror=...>`的候选只显示文字，sent数组始终为空。
- [ ] **Step 8: 通过 fixture 的全部 UI 用例并审阅实际 DOM 选择器。** 可用时提交 `feat: show Jev suggestions beneath Lark messages`。

### Task 7: 整体验证、真实界面检查与交付

**Files:** Modify `README.md`, `test/assistant-ui.cjs`；必要时仅修复以上任务暴露的问题。

**Interfaces:** Consumes 所有模块、已确认设计及实际网页适配证据；Produces 可运行源码、验证结果和使用说明。

- [ ] **Step 1: 增加整条模拟链路用例。** 使用假 Jev fetch 与假 CLI，真实点击目标后观察 filtering→judging→generating→ranking→complete；校验后续请求只含筛后消息，三候选准确排序，点候选后草稿更新但发送次数0。另跑取消、筛选失败、CLI退出、排序失败/仅重排和配置变更。
- [ ] **Step 2: 运行全部验证。** `npm test` 必须记录总结果；不得只跑新增测试后声称全部通过。若失败按具体证据定位修复，保留此前基线差异说明；修复后只重跑受影响部分和最后一次完整回归。
- [ ] **Step 3: 验证打包内容。** 检查现有 `build.files: src/**/*` 覆盖 schema、preloads、CSS；使用 Electron Builder 的目录构建检查新模块加载，不安装或替换用户正在运行的应用。若现有 pack:mac 脚本依赖的 install-electron 不可用，直接使用已安装 electron-builder 的目录构建能力，并如实记录。
- [ ] **Step 4: 检查实际飞书界面。** 确认按钮位于用户截图第一处、面板位于第二处，测试长气泡、窄窗口和滚动重挂载；未配置 Key 时真实点击只能显示配置提示，不调用外部模型。真实 DOM 外观可用合成的本地演示结果检查，不使用真实聊天做未经授权的付费调用。记录实际检查过的页面与限制，不能把 fixture 截图称作线上验证。
- [ ] **Step 5: 更新 README。** 写明功能入口、0–50上下文范围、相关性筛选、OpenRouter设置、本地Codex登录/路径/可选模型、数据去向、点击候选填入而手动发送，以及常见配置/认证错误。保持现有功能说明。
- [ ] **Step 6: 按 verification-before-completion 复查最终 diff 和测试证据。** 再由独立审阅者检查状态串位、密钥边界和 CLI 生命周期；修复阻断项。不要自动发布、推送或打开 PR。最终交付说明实际完成项、测试结果和真实API尚未联调的边界。

## 计划自审与执行建议

设计验收1→任务5/6；2→任务1/6；3/4→任务2/4/7；5→任务6；6→任务3/4/7；7→任务6/7；8→任务1/3/5/6；9→任务5/7；10→任务6/7。新增条数配置、筛选失败不回退、CLI替代API以及手动发送均有具体任务和验证。

建议在当前任务由主代理顺序执行，共享窗口接线和 DOM 状态由同一个实现者维护；独立子代理可核对协议和在最后审阅整项改动。也可选择逐任务子代理实现与逐任务独立审阅，但需要更多上下文切换。用户审阅本计划并选择执行方式后才开始产品代码修改。
