# AI 情感助手（Phase 5，契约 §3.7）

> 8 个接口：创建会话 / 会话列表 / 会话详情 / 消息历史 / 发送消息 / SSE 流式 / 删除归档 / 配额查询。

## 目录职责

| 文件                           | 职责                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| `chat.controller.ts`           | 8 个路由 + 完整 Swagger；SSE 端点手写 `text/event-stream`               |
| `chat.dto.ts`                  | 请求校验（枚举、范围、逗号分隔多值、布尔查询串）                        |
| `chat.types.ts`                | 契约字面量与共享类型；`mode`/`tone`/`includePersona` 的 `scene` 编解码  |
| `chat-conversation.service.ts` | 创建会话（§3.7.1）、会话详情（§3.7.3）、配额查询（§3.7.8）              |
| `chat-context.service.ts`      | 会话/消息**读取**、删除归档（§3.7.7）、上下文装配取数                   |
| `chat-message.service.ts`      | 发消息主链路（§3.7.5 / §3.7.6）：安全 → 配额 → Prompt → Provider → 落库 |
| `chat-quota.service.ts`        | 配额原子预占/回补、幂等键、并发流名额、userId 维度限流、配置读取        |
| `chat-quota.util.ts`           | 配额**纯逻辑**（优先级、UTC+8 日界、常量、配置解析）                    |
| `chat-safety.service.ts`       | 内容安全（`msgSecCheck`）+ 危机响应载荷组装                             |
| `chat-safety.util.ts`          | 危险内容关键词预筛（纯函数）+ 四类关怀文案组装                          |
| `chat-context.util.ts`         | Token 预算裁剪、定界符中和、上下文装配（纯函数）                        |
| `chat-persona.util.ts`         | 画像行 → 人设文本（纯函数，ADR-005 确定性）                             |
| `chat-prompt.ts`               | 契约键名 → 库内模板键名的候选链解析 + Prompt 变量组装                   |
| `chat-audit.util.ts`           | `ai_usage_logs` 与 `ai_call_audits` 写入（指纹而非正文）                |
| `chat.module.ts`               | 模块装配（被 `AiModule` 导入，`app.module.ts` 无需改动）                |

## 关键不变量（改动时不要破坏）

1. **用户自由文本只经 `wrapUserInput()` 进入 Prompt**，且定界符先被中和
   （`chat-context.util.ts`）。模板作者**不要**自己再拼一层定界符。
2. **危险内容命中 = 不调用模型 + 不扣配额 + 两侧消息都落库**，HTTP 200 且 `code = 50008`。
3. **配额用 Redis Lua 原子预占，失败回补**（`chat-quota.service.ts` 文件头有完整取舍说明）。
4. **审计表只存指纹**，永不存对话正文（用户行使删除权时不留第二份副本）。
5. **归属校验必须同时带 `id` 与 `userId`**（`findFirst({ where: { id, userId } })`）。
6. **`ChatModule` 单向依赖 `AiModule`**，反向依赖会导致 Provider 工厂出现两份实例。

## Prompt 模板变量的契约

运营在后台建 `AI_COMPANION` 模板时，可引用下列占位符（未引用的会被忽略，
渲染器只校验"模板里用到但没给值"）：

| 占位符                             | 内容                                   |
| ---------------------------------- | -------------------------------------- |
| `{{myPersona}}`                    | 我的人格画像（≤400 token，可能被裁剪） |
| `{{partnerPersona}}`               | 对方人格画像（≤400 token）             |
| `{{memorySummary}}`                | 历史滚动摘要（≤800 token）             |
| `{{memoryAndHints}}`               | 历史摘要 + 报告/测试摘要合并块         |
| `{{recentMessages}}`               | 最近 10 轮原始对话                     |
| `{{reportContext}}`                | `contextHints` 命中的报告/测试摘要     |
| `{{userInput}}`                    | **已定界包裹**的用户本轮输入           |
| `{{toneInstruction}}`              | 按 `tone` 生成的语气指令               |
| `{{modeInstruction}}`              | 按 `mode` 生成的附加指令               |
| `{{personaAvailability}}`          | 画像启用/禁用说明                      |
| `{{userName}}` / `{{partnerName}}` | 用户昵称 / 对方昵称                    |

模板键名解析顺序：`AI_COMPANION` → `ai.companion` → `ai_companion`
（`ANALYSIS` 模式：`RELATIONSHIP_REPORT` → `report.relationship`）。
**三种键名都认**，因为契约用大写下划线、现网 seed 用点号小写。

## 依赖的 `system_configs` 键

| 键                              | 用途                           | 是否已在 `system-config.catalog.ts`       |
| ------------------------------- | ------------------------------ | ----------------------------------------- |
| `disclaimer.aiContent`          | AI 内容免责声明                | ✅                                        |
| `disclaimer.aiGeneratedNotice`  | AI 生成标识                    | ✅                                        |
| `disclaimer.crisisNotice`       | 危机提示文案                   | ✅                                        |
| `disclaimer.safetyResources`    | 心理援助热线清单               | ✅                                        |
| `disclaimer.emergencyNotice`    | 紧急处置提示                   | ✅                                        |
| `freeAiQuotaTotal`              | 免费用户 AI 总次数（默认 10）  | ✅                                        |
| `memberAiDailyLimit`            | 会员每日 AI 次数（默认 50）    | ✅                                        |
| `aiMessageMaxLength`            | 消息长度上限（默认 2000）      | ✅                                        |
| `ai.maxConcurrentStreams`       | 单用户并发流上限（默认 3）     | ✅                                        |
| `ai.systemNotice`               | 会话首屏合规提示               | ❌ **需补录**（读不到用契约示例文案兜底） |
| `ai.maxMessagesPerConversation` | 单会话消息上限（契约 200）     | ❌ **需补录**（当前用契约常量）           |
| `ai.maxConversationsPerDay`     | 24h 建会话上限（契约 10）      | ❌ **需补录**（当前用契约常量）           |
| `ai.newUserDailyLimit`          | 新用户 7 天内日上限（契约 30） | ❌ **未实现**（仅静态回显）               |

## 部署注意

- **Nginx**：SSE 端点必须配 `proxy_buffering off` + `proxy_read_timeout 200s`
  （服务端已发 `X-Accel-Buffering: no`）。
- **访问日志脱敏**：`GET …/stream?message=…` 的消息正文会进入网关访问日志，
  需在 Nginx 层对 `message` 查询参数做脱敏（协议决定的取舍，见契约 §3.7.6 方法选择说明）。
- **数据库**：无新增表/列（复用 `ai_conversations` / `ai_messages` / `ai_usage_logs` /
  `ai_call_audits`），因此**无迁移**。
