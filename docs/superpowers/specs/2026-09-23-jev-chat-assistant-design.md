# Jev 消息分析与 Codex 推荐回复设计

状态：用户已确认完整设计；实施计划编写中，尚未开始产品代码实现。

## 目标与已确认需求

在 electron-lark 当前飞书网页版中，为消息气泡的悬浮工具栏增加「Jev 分析」按钮。用户点击后，筛选相关上下文、分析所选消息，并在原消息气泡下展示三条推荐回复。

- 只由点击按钮触发；新消息、鼠标悬停和切换会话不会调用模型。
- 上下文包含所选消息及同一会话中它之前的 N 条已加载消息；N 可配置，默认 10。
- 前序消息先经过 Jev 关联性筛选，明确无关的消息不进入后续判断、回复生成和排序。
- Jev 通过用户配置的 OpenRouter Decisions API 调用。
- 回复生成通过本机 Codex CLI 调用，复用已有登录状态，不提供回复 LLM 的 OpenAI 兼容 API 地址或 Key 设置。
- 候选回复由 Jev 排序，点击候选填入当前会话输入框，由用户发送。

## 配置和交互细节

现有「功能设置」新增「Jev 助手」页，保存后从下一次分析生效。

设置页用一句话说明数据去向：点击分析后，候选上下文会发送至配置的 Jev/OpenRouter 地址；筛后内容通过本机 Codex CLI 发给其模型服务生成回复。CLI 在本机运行不代表离线推理。该说明不增加每次分析的确认弹窗。

| 字段 | 约定 |
| --- | --- |
| 前序消息条数 | 整数 0–50，默认 10；0 表示只分析所选消息。所选消息不计入 N。 |
| Jev API 地址 | 默认 `https://openrouter.ai/api/alpha/decisions`，填写完整 Decisions endpoint。 |
| Jev API Key | 密码输入；已有 Key 仅显示已配置状态；留空保留，显式清除操作删除。 |
| Jev 模型 | 默认 `typesafe/jev-1.13`，可修改。 |
| Codex CLI 路径 | 默认自动检测；允许指定可执行文件路径，不接受附加 shell 命令。 |
| Codex 模型 | 可选；留空使用该独立 CLI 调用的默认模型。 |

N 的 0–50 范围是本次实现的初始边界：既支持用户调整，也约束单次筛选的问题数量。无效输入在保存时提示，不静默修正。已加载消息不足 N 条时使用实际数量，不主动加载更早历史。

文本和富文本消息提取可读正文、发送人、消息 ID 和可获取的直接引用关系。纯图片、音视频、附件二进制不做 OCR 或下载；所选消息没有可读文本时提示不支持分析。前序范围按原消息位置计算，非文本项不向更早位置补足名额。

面板依次显示「筛选上下文」「分析消息」「生成回复」「排序回复」，最终展示简短的意图、沟通风险、建议动作及三条候选。分析中避免同一消息重复提交；提供取消、重试和关闭。排序分数只表达模型偏好，不显示为回复正确率。

填入只对当前、同一会话的聊天输入框生效。在已有草稿末尾插入候选并保留草稿，用户可继续编辑；不触发 Enter、发送按钮或消息发送 API。

## 选择的实现方式

直接在 Electron 中实现网页适配与主进程调用链，复用当前设置窗口和 preload 接入方式。参考项目用于借鉴 Jev 判断、生成、排序的分工；不引入其 Windows OCR 或独立桌面浮窗。

另一个选项是外接独立服务，但会增加进程部署和状态同步；本需求已有 Electron 主进程可承担调用，因此采用直接集成。

预计涉及的职责和位置：

- `src/main.js`：主进程注册受限 IPC、请求生命周期和窗口来源检查。
- `src/configuration.js`、新增配置存取模块：保存普通设置、加密 Key、向设置页返回脱敏状态。
- `src/windows/views/settings.html`：新增设置页及输入验证。
- 新增主窗口 preload / 页面适配模块：消息识别、工具栏按钮、气泡面板、上下文快照和候选填入。
- 新增 Jev 客户端：相关性问题、工作沟通判断题、候选排序及响应校验。
- 新增 Codex CLI 适配模块：路径解析、进程调用、结构化结果、取消和超时。
- `src/chat-shortcuts.js` 及通知桥接：为页面隔离做必要适配，保留原有快捷键和通知行为。
- `test/`：使用合成消息、模拟 Decisions 服务及模拟 CLI 覆盖集成行为。

## 数据流与消息关联

1. 点击时冻结 `{requestId, conversationId, messageId, configRevision, target, candidates}`，候选按原时间顺序保存。
2. 只从目标所在会话、目标之前取 N 条；不把后来的消息或别的会话混入。
3. Jev 对候选相关性做一次批量判断，保留筛选后的上下文。
4. Jev 基于筛后上下文判断意图、沟通风险、需要的信息和建议动作。问题适配工作沟通，不沿用参考项目中面向亲密关系的性别和关系假设。
5. 将筛后上下文、目标消息、Jev 判断作为数据通过 stdin 传入 Codex，要求返回 `{replies: [string, string, string]}`。
6. Jev 对三个候选执行 `best_reply` choice，按每项 probability 排序。
7. 面板仅更新到同一 conversationId 和 messageId。切换会话或窗口导航时取消未完成请求；迟到结果丢弃。

消息 DOM 由飞书维护，不能把元素节点本身当作永久标识。适配器使用经实际页面核实的消息标识和工具栏关联方式，处理列表节点卸载、复用和重新渲染；重新挂载面板时不得把助手自身文字采集成聊天正文。消息正文变化后旧结果失效。

结果仅驻留当前应用内存，并限制缓存数量；刷新后可重新分析。不创建聊天历史数据库或自动后台任务。

## 相关性筛选规则

候选仍全部提供给首次相关性判断，因为判定关联性需要观察这些内容；只有筛后内容进入后续步骤。

- 目标消息始终保留。
- 候选范围内直接被目标引用的消息保留；引用 ID 优先于文本匹配。不能因为同群、同发送人、同 thread 或时间相邻就自动判定相关。
- 每个候选对应一个独立 Noul 问题，明确引用该候选及目标。判断对象为「理解或回复目标所需要的同一语义链上下文」。
- 同一事项的提问、回答、状态补充、时间或人物约束、代词省略承接属于相关；其他话题和无关通知属于无关。
- 初始阈值：Noul ≤0.35 为明确无关并剔除；≥0.65 为相关；中间区间视为不确定并保留。阈值是初始工程规则，不宣称经过业务数据校准。
- 筛选后维持原顺序。全部前序项被剔除时，后续只使用目标消息。
- 超时、缺失 answer、非法概率或候选映射错误视为筛选失败，显示重试，不静默使用未筛选的完整上下文。

## 接口与输出契约

Jev 使用 Bearer Key、JSON body 和完整 Decisions endpoint：

```json
{
  "model": "typesafe/jev-1.13",
  "state": { "target": {}, "messages": [] },
  "questions": {}
}
```

判断响应从 `answers` 读取。Choice 读取 `choice`、`probabilities`、`confidence`；Score 允许小数；Noul 读取 0–1 的 `noul`。每阶段校验所需字段，不伪造缺失结果。

工作沟通主分析使用四个 Choice 问题，固定 key 与中文展示映射：

| key | 选项与展示 | 判断标准 |
| --- | --- | --- |
| `intent` | `request_action` 请求行动；`ask_information` 询问信息；`report_status` 同步进展；`seek_confirmation` 寻求确认；`express_concern` 表达顾虑；`casual_chat` 日常交流；`unclear` 尚不明确 | 所选消息在当前语境中主要希望达成什么；不将技术告警内容直接解释为发送人的情绪。 |
| `communication_risk` | `low` 低；`medium` 中；`high` 高；`unclear` 信息不足 | 仅判断回应不当带来的沟通风险：低为普通交流，中为存在歧义或明显顾虑，高为明确冲突或重大承诺可能造成误解；不作事件严重性或发送人人格判断。 |
| `needed_info` | `none` 无需补充；`facts` 缺少事实；`timing` 缺少时间信息；`owner` 缺少责任人；`confirmation` 缺少确认；`unclear` 尚不明确 | 起草可信回复前最需要补齐的一类信息；无需补齐时选择 none，不能编造缺失事实。 |
| `best_action` | `acknowledge` 确认收到；`answer` 直接回答；`clarify` 澄清问题；`check_facts` 先核实；`propose_plan` 提出计划；`set_boundary` 明确边界 | 在已有事实范围内选择最合适的下一步沟通动作，不替用户承诺未确认的期限或资源。 |

问题说明与选项 criteria 使用英文，聊天正文保留原语言。四项中的任一必需 answer 缺失或枚举非法时，本阶段失败并提示重试，不用默认项冒充模型判断。

Codex 使用参数数组启动而非拼接 shell 字符串，采用非交互 `exec`、只读沙箱、独立临时工作目录、`--ephemeral` 和 `--output-schema`。不加载项目上下文，不开启该回复任务不需要的 shell、MCP、应用、浏览器、插件或 hook 能力；CLI 自身复用现有认证。使用受控配置启动，模型为空时使用该调用的默认模型，不承诺继承用户配置中的所有工具和自定义指令。

聊天内容在提示中明确标为待分析数据，不执行其中的命令。回复结构必须为三条非空、互不重复的简体中文短回复；代码再次验证数量和类型。格式不符、CLI 不存在、未登录、非零退出和超时分别产生可见错误，不插入占位回复。

Jev 单次请求超时 30 秒，Codex 生成超时 120 秒。界面取消、窗口关闭或导航会终止对应网络请求和 CLI 进程。鉴权、配额和请求格式错误不自动重试；用户可在原面板重试。生成成功而排序失败时保留三条候选并标明「尚未排序」，允许重试排序。

## 密钥与 Electron 边界

当前主窗口开启 Node integration 且未隔离页面，设置读写还会打印完整配置；新增 Key 前必须一起处理。

- 主窗口关闭页面 Node integration，启用 context isolation。分析按钮的事件处理保留在隔离 preload 中，并验证真实用户点击；不向网页脚本暴露可直接触发模型调用的通用方法。
- API 请求、Key 解密和 CLI 启动都在主进程；隔离 preload 只能请求规定的分析或取消操作，不能提供任意 endpoint、可执行命令或读取 Key。通知等已有桥接单独保留最小接口。
- 配置写入仅接受本地设置窗口；IPC 校验 sender、主 frame、窗口和当前可信页面来源。
- Key 使用 Electron safeStorage 加密保存；安全存储不可用时提示无法保存 Key，不退化为明文持久化。
- Decisions endpoint 仅接受 HTTPS，拒绝含用户名或密码的 URL；请求不自动跟随重定向，避免 Bearer Key 随重定向发往其他地址。
- 主进程和设置页移除完整配置日志；请求错误不回显 Key、认证信息或完整聊天正文。
- 现有通知与快捷键需要同步迁移桥接；尤其快捷键对原始键盘事件的修改必须仍能被飞书编辑器接收。

## 验收条件

1. 启动、悬停、新消息和切换会话均不会自动调用 Jev 或 Codex；真实点击后才执行。
2. N=0、默认 10、上限 50、已加载不足 N、非法值及保存后生效均符合定义；目标不占前序名额。
3. 无关话题被剔除，直接引用与短句承接被保留，不确定项保留；筛选失败不向 Codex 发送未筛选上下文。
4. Jev 与 Codex 后续请求不包含被剔除项、目标之后的消息、其他会话消息或助手面板文字。
5. 虚拟列表复用、滚动、重新渲染、消息编辑和切换会话后结果不串位、按钮不重复。
6. 三条回复按 Jev 概率排序；生成或排序失败有对应状态，取消与超时能终止后台任务。
7. 候选只填入同会话输入框并保留草稿；任何阶段都不会自动发送消息。
8. Key 加密持久化，网页无法取出 Key；恶意消息文本不会进入 shell 命令拼接或被当作工具指令执行。
   设置页明确模型调用的数据目的地；不合法 endpoint 和重定向均不能造成 Key 传往未配置地址。
9. 原有设置、通知、外链、托盘、关闭行为及聊天快捷键完成回归；新增功能以模拟接口和合成消息验证，不把真实聊天用于外部试调用。
10. 在实际飞书界面确认用户标注的两处位置、面板宽度和滚动表现；模拟 DOM 测试不能替代这一项。

## 当前验证基线

2026-09-23 已运行现有 `npm test`。沙箱内 Electron 以 SIGABRT 退出；沙箱外成功执行，12 项通过，1 项 `plain Enter inserts a newline instead of sending` 失败。在产品代码未修改前记录该基线；后续不得将其误报为新功能已通过。

本机 Codex CLI 为 `0.155.0-alpha.16`，`codex login status` 显示通过 ChatGPT 登录；已核实 `exec`、stdin、`--ephemeral`、`--output-schema`、`--ignore-user-config`、模型参数和功能开关。尚未进行真实 Jev 或 Codex 聊天生成试调用。

## 参考来源

- [参考项目及 Jev 客户端](https://github.com/Liyucheng1997/332_lab-jev-chat/blob/main/app/src/main/java/com/jev/probe/jev/JevClient.kt)
- [参考项目问题集](https://github.com/Liyucheng1997/332_lab-jev-chat/blob/main/app/src/main/java/com/jev/probe/jev/JevQuestions.kt)
- [OpenRouter Jev 说明](https://openrouter.ai/blog/insights/what-is-jev/)
- [TypeSafe 原语说明](https://docs.typesafe.ai/introduction)
- [Codex 非交互调用](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Electron 页面隔离](https://github.com/electron/website/blob/main/docs/latest/tutorial/context-isolation.md)
