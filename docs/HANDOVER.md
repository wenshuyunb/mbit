# SoulMap AI — 项目交接文档

> **给接手者的第一份文件。** 读完这一份你就能独立接手，不需要问任何人事。
> 最后更新：本文件随每次交接维护，请在看不懂的地方**直接改本文件**，不要只在对话里说。

---

## 0. 一句话说清这个项目

**SoulMap AI** 是一个商业级 SaaS：微信小程序 + Web 管理后台，做「人格测评（MBTI + 大五）→ AI 深度解读 → 情侣匹配 → AI 情感助手 → 会员付费」的闭环。

- 仓库根：`D:\Projects\mbit`（pnpm workspace 单仓多包）
- 三端：`backend`（NestJS）/ `frontend/miniapp`（uni-app 小程序）/ `frontend/admin`（Vue3 后台）
- **当前阶段目标（用户明确要求）**：**先把后端做完整**，UI 精修放最后

---

## 1. 三十秒上手

### 1.1 必须先知道的机器环境

| 服务       | 地址                    | 说明                                                                          |
| ---------- | ----------------------- | ----------------------------------------------------------------------------- |
| PostgreSQL | `127.0.0.1:5452`        | Docker 容器 `soulmap-postgres`（**不是**默认 5432，原生 PG 服务已停用）       |
| Redis      | `127.0.0.1:6391`        | Docker 容器 `soulmap-redis`（**Redis 7**，BullMQ 要求 ≥5.0）                  |
| 后端 API   | `127.0.0.1:3000`        | Swagger：`http://127.0.0.1:3000/api/v1/docs`                                  |
| 管理后台   | `127.0.0.1:5174`        | Vite（proxy 到 3000）                                                         |
| 小程序 H5  | `http://localhost:5173` | **必须用 localhost**（uni 的 dev server 只绑 IPv6 `::1`，`127.0.0.1` 连不上） |

⚠ **Redis 有过一次大坑**：`docker-compose.yml` 声明的是 `redis:7-alpine`，但 6379 端口上被**原生 Windows Redis 3.2.100** 占着，而 BullMQ 要求 ≥5.0 —— 结果是**本地所有队列静默不可用**（报告生成、匹配算分、各类导出全部跑不起来），并且看板/AI 总览因查询队列状态直接 500。现已让 `soulmap-redis` 映射到 **6391** 并把 `backend/.env` 的 `REDIS_PORT` 指过去。**原生 6379 不要动**，那是别的项目在用。

### 1.2 启停服务

```powershell
# 启动（后端 + 管理后台 + 小程序 H5）
cd D:\Projects\mbit
& .\scripts\start-dev.ps1
```

**停服务（重要，别用错方法）**：

```powershell
# ✅ 正确：只杀占用指定端口的进程
foreach ($p in 3000,5173,5174) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

# ❌ 绝对不要：Get-Process node | Stop-Process -Force
#    本项目运行在 Node 环境下，全量杀 node 会连带杀掉编辑器/宿主进程，
#    导致**正在执行的命令直接中断且无任何输出**。已实际发生过 3 次。
```

### 1.3 初始化数据（幂等，可反复跑）

```powershell
cd D:\Projects\mbit\backend
$env:TS_NODE_COMPILER_OPTIONS = '{"module":"CommonJS"}'
node node_modules/ts-node/dist/bin.js prisma/seed/index.ts
```

> ⚠ `prisma db seed` **什么都不做**（`package.json` 里没有 `prisma.seed` 配置）。必须用上面这条命令。

种子内容：3 个测试定义 / 82 题 / 410 选项 / 6 条关系规则 / 2 个 Prompt 模板 / 1 个匹配权重矩阵 / **3 个会员套餐 + 6 个商品** / 25 个管理端权限点 / 5 个角色 / 1 个初始超管。

**初始超管**：`admin@soulmap.cn` / `S0ulM@p#2026Admin`（`mustChangePassword=true`，生产必须用 `SEED_ADMIN_PASSWORD` 覆盖）。

---

## 2. 五道门禁（每次交付必须全过）

```powershell
cd D:\Projects\mbit\backend
pnpm exec tsc --noEmit -p tsconfig.json      # 1 类型
pnpm exec eslint src --max-warnings 0        # 2 静态检查（0 警告容忍）
pnpm exec jest --runInBand                   # 3 单测（必须 --runInBand）
cd D:\Projects\mbit
pnpm exec prettier --check .                 # 4 格式（全仓）
```

或用本地 CI 镜像脚本（**只覆盖前四道**）：

```powershell
cd D:\Projects\mbit
& .\scripts\verify-all.ps1 -SkipFrontend
```

### 第 5 道门禁：真实启动验证（**前四道全绿也挡不住的最后一类故障**）

```powershell
cd D:\Projects\mbit\backend
pnpm exec nest build
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }   # 只能按端口杀
Start-Process node -ArgumentList 'dist/main.js' -NoNewWindow `
  -RedirectStandardOutput .runlogs\boot.log -RedirectStandardError .runlogs\boot.err
# 轮询直到 200，而不是 sleep 固定秒数
Invoke-WebRequest 'http://127.0.0.1:3000/health/ready' -UseBasicParsing
```

期望返回 `{"status":"ok",...,"checks":{"database":{"status":"up"},"redis":{"status":"up"}}}`。

**为什么必须有这一道**：前四道门禁都**不做真实 bootstrap**，因此完全看不见这类故障：

- **模块循环依赖**：`ai.module.ts` ↔ `chat.module.ts` 缺 `forwardRef` →
  Nest 启动即失败。而 tsc/eslint/jest/prettier **全部通过** ——
  单测直接 `new` 服务、绕过了 DI 容器，编译也不检查运行时依赖图。
  这个缺陷一度让**整个后端起不来**，是"四道全绿"状态下最接近灾难的一次。
- **控制器/服务漏装配进模块**：路由静默不存在（表现为 404），编译无警告。
- **Prisma/Redis 连接配置错**：只有真实启动才连。
- **新增模块忘记 import 进 `app.module.ts`**。

判断标准：**`/health/ready` 真的返回 200**，不是"进程还活着"。
进程活着但 DI 失败会反复重启或直接退出，`/health/ready` 会一直连不上。

### ⚠ 沙箱陷阱（不读会浪费时间）

1. **创建子进程可能被拒绝**：`node.exe` 报 `Access is denied`。此时用工具参数
   `sandbox_permissions: "danger-full-access"` 重试**同一条命令**（附一句理由）。
2. **不要给命令加管道/重定向**：`cmd 2>&1 | Select-String ...` 会**静默返回空输出**，
   让人误判成"通过了"。判断成功要看**是否有真实输出**（例如 jest 的用例计数），
   **不要只看退出码**。
3. **`pnpm exec` 在受限沙箱下可能变成静默 no-op**（无输出、退出码 0）。
   有子代理因此拿到了**假绿**，交付了带编译错误的代码。接手后**必须自己重跑门禁**。
4. **git 需要提权**：会报 `detected dubious ownership`，同样用 `danger-full-access` 重试。
5. **`$LASTEXITCODE` 在管道后不可靠**；`$proc.ExitCode` 在本沙箱读不到。

---

## 3. 当前进度（准确数字）

| 维度                          | 数值                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 契约接口总数                  | **123**（`docs/API_DESIGN.md` 附录 A.13 索引；其中管理端 43）                                                                    |
| 运行时注册路由                | **123**（与契约一致；清点方法见 §3.3）                                                                                           |
| `tsc` / `eslint` / `prettier` | ✅ 全干净（eslint 口径为 `src test scripts prisma --max-warnings 0`）                                                            |
| 后端单测                      | **124 套件 / 2770 用例全过**（2026-10-13 实测，起点是 113/2581）                                                                 |
| 第 5 道门禁（真实启动）       | ✅ `/health/ready` 返回 200，`database: up` + `redis: up`                                                                        |
| 数据库迁移                    | **5 个**（最近新增 `20261013000000_prompt_type_report_variants`）                                                                |
| 种子规模                      | 3 测试定义 / 82 题 / 410 选项 / **5 Prompt 模板** / 10 系统配置 / 6 关系规则 / 1 权重矩阵 / 3 套餐 / 6 商品 / 25 权限点 / 5 角色 |

> 「路由数 > 契约接口数」是正常的：实现里有一些契约索引未单列的必需接口
> （如 `POST /admin/auth/logout`、`POST /admin/auth/password`），
> 也有部分接口的路径与契约不同（见 §6.2，已由 ADR-033 定案）。

### 3.1 已完成

**基础设施**

- 4 个 migration 已在真实 PostgreSQL 上跑通；seed 幂等可重跑
- 双 JWT realm（用户端 `JWT_SECRET` / 管理端 `ADMIN_JWT_SECRET`，配置层强校验两者不同）
- BullMQ 三个队列（`export.data` / `ai.report` / `compatibility.calc`）
- 统一响应包络、全局异常过滤器、请求追踪 ID、限流、Swagger

**用户端（约 60 个接口）**

- `auth` 5：微信登录 / 刷新（RT 旋转 + 复用检测）/ 登出 / 全部登出 / 会话
- `user` 11：资料 / 头像 / 手机号 / 数据导出 / 同意记录 / 注销（7 天冷静期）
- `test` 8：测试定义 / 会话创建（幂等键必填）/ 分批取卷 / 批量答题 / 提交算分 / 历史
- `personality` 5：画像 / 历史版本 / 成长曲线 / MBTI 类型百科
- `ai/report` 4：创建（异步）/ 列表 / 详情（服务端裁剪免费预览）/ 进度
- `relationship` 8：邀请 / 接受 / 列表 / 详情 / 匹配算分 / 匹配报告 / 确认 / 解除
- `membership` 2：会员状态 / 商品列表
- `payment` 2：下单 / 微信回调
- `storage` 3：直传凭证 / 签名 URL / OSS 回调
- **`system` 2**：`GET /system/config`、`/system/disclaimers`（小程序每个页面都依赖，此前整块缺失）

**管理端（42/43 + 2）**

- 基础层：`AdminModule`（认证 + RBAC + 审计）
  - `AdminTokenService`：独立密钥签发 admin realm 令牌（AT 1h / RT 7d），RT 旋转 + 复用检测，会话存 Redis
  - `AdminAuthService`：Argon2id（19MB/t=2/p=1）；**不区分账号不存在与密码错误**且两条路径都跑一次哈希（防枚举 + 防时序侧信道）；**先验密码再判状态**；双维度锁定（账号 + IP）
  - `RolesGuard`（终于消费了 `@Roles`）+ `@RequirePermission`（25 个权限点）+ `ConfirmPasswordGuard`（`@SensitiveOperation()` → `X-Confirm-Password`）
  - `AdminAuditService`：所有写操作与敏感读都写 `admin_audit_logs`
- 业务域 38 个：用户 4 / 题库 7 / 测试定义 2 / Prompt 7 / 订单查询导出 3 / AI 统计 5 / 报告关系 2 / 看板 1 / 系统治理 8
- **活体验证 27/27 通过**（脚本见 `backend/.runlogs/verify-admin-live.cjs`）

### 3.2 新交付四个域的实测结论

四个域**都已接线、已通过真实启动验证与路由清点**（不再是"尚未验证"）：

| 域                     | 接口数 | 文件位置                                                                                                                                                                                             | 状态                                                        |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 支付订单与退款         | 8      | `backend/src/modules/payment/`（`refund.service.ts`、`order-query.service.ts`、`order-lifecycle.processor.ts`、`orders.controller.ts`、`refunds.controller.ts`、`admin-order-refund.controller.ts`） | 下单链路**活体 11/11 通过**；退款链路待验                   |
| AI 情感助手（Phase 5） | 8      | `backend/src/modules/ai/chat/`                                                                                                                                                                       | 路由已注册；**缺 seed 模板，开箱报 50011**（修复中，见 §9） |
| 报告导出与分享         | 5      | `backend/src/modules/ai/report/`（`report-regenerate.*`、`report-share-card.*`、`report-export.service.ts`、`report-render.util.ts`）                                                                | ✅ 渲染已实现并活体验证 15/15（见 §3.17）                   |
| 通知 + 零散            | 7      | `backend/src/modules/notification/`、`relationship/compatibility-report.controller.ts`、`membership/`                                                                                                | 路由已注册                                                  |

**已确认的设备级结论**：

- 管理端活体验证 **27/27 通过**（`verify-admin-live.cjs`）
- 支付下单链路活体验证 **11/11 通过**（`verify-payment.cjs`，含金额取自服务端商品表、订单落库校验）
- 运行时注册路由 **123 条 = 契约 123 条**，其中管理端 45 条
- 微信支付回调 `POST /payment/notify/wechat` **已注册且可用**（返回微信要求的
  `{"code":"FAIL"}` 非 JSON 体，由 `@RawResponse()` 处理）

**仍在进行**：四个新域业务行为的 HTTP 级逐项验证（正在跑），以及 AI 助手 seed 补齐。

### 3.3 已接线 / 未接线

**全部已接线**（有证据，不是推测）：`app.module.ts` 已导入
`SystemModule` + 12 个管理端域模块 + `AdminModule` + **`NotificationModule`**；
`worker.module.ts` 已接线 `AdminOrderJobsModule`、**`PaymentJobsModule`**
（订单超时关单 + 退款对账，不接线会**安静地不运行**）。

**证据**：真实启动成功 + 路由清点 123 条与契约完全一致 —— 若任一域未接线，
其路由必然缺失，清点会立刻暴露。**不需要再去逐个人工核对 module。**

**仍需注意的是 worker**：`app.module.ts` 覆盖 HTTP，但 `export.pdf`、
订单生命周期等**异步 job 只在 `pnpm start:worker` 运行时才执行**。
worker 没跑时这些任务会**停在排队态**，表现为"接口 202 了但任务永远不完成"。

---

### 3.4 已知的未完成项（**刻意留的，不是遗漏**）

| 项                          | 具体表现                                                                                                                                                                                                                                        | 为什么这样留                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ~~**报告渲染缺口**~~        | ~~`report-render.util.ts` 的 `renderReportPdf` / `renderShareCardImage` 抛 `90008`~~ **已于 2026-10-13 实现**（`pdf-lib` + `@napi-rs/canvas` + 自带的 OFL 中文字体，见 §3.17 / ADR-037），小程序码也已改为复用 `WechatService.getMiniAppCode()` | 已完成（唯一遗留：`includeAnswers` 的数据通路未打通，PDF 里会显式印出提示） |
| ~~**AI 助手 seed 缺失**~~   | ~~对话接口报 `50011`（`AI_PROMPT_TEMPLATE_NOT_FOUND`）~~ **已于 2026-10-12 修复**：`ai.companion` 模板 + 10 条 `system_configs` 入种子，`verify-ai-companion.cjs` 全绿（见 §3.5）                                                               | 已完成                                                                      |
| **`payments` 表没有写入方** | 没有任何代码往 `payments` 写行，而 `refunds.payment_id` 是非空外键，退款依赖兜底逻辑                                                                                                                                                            | 正确做法是下单时建 `INIT` 行、回调时置 `SUCCESS`。待验证退款链路后再定      |
| **会员权益矩阵拿不到**      | `ProductView` 没有 `benefits` 字段，契约里的权益对照表无法下发                                                                                                                                                                                  | 已在 ADR-033 里登记为缺口                                                   |
| **对话 SSE 不是真流式**     | `LlmProvider` 只暴露 `complete()`，所以增量是**生成完再切片**的 —— 首字延迟 = 完整生成耗时                                                                                                                                                      | 需要 provider 层支持流式，属接口变更，要先写 ADR                            |
| **管理后台 8 个占位视图**   | 前端页面还在，未接真实接口                                                                                                                                                                                                                      | 属第 4 步                                                                   |

### 3.5 本轮（2026-10-12 接手轮）的交付与实测证据

**五道门禁（本轮实测，均为真实输出，不是"退出码 0"）**

| 门禁       | 命令                                                        | 结果                                                        |
| ---------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| 1 类型     | `pnpm exec tsc --noEmit -p tsconfig.json`                   | 退出码 0                                                    |
| 2 静态     | `pnpm exec eslint src test scripts prisma --max-warnings 0` | 退出码 0                                                    |
| 3 单测     | `pnpm exec jest --runInBand`                                | **113 套件 / 2581 用例全过**                                |
| 4 格式     | `pnpm exec prettier --check .`                              | 全仓通过                                                    |
| 5 真实启动 | `node dist/main.js` + 轮询 `/health/ready`                  | 200，database/redis 均 up（另起 `dist/worker.js` 消费队列） |

**修掉的 4 个缺陷（每个都有实测证据）**

1. **`GET /reports/{id}` 传非法 UUID 返回 500/`90002`**（契约要求 400/`10001`）。
   根因：`ReportIdParamDto` 只有 `@IsString` + `@Length`，非法值一路进到 Prisma，
   由 PostgreSQL 抛 `invalid input syntax for type uuid`，再被全局过滤器翻译成
   "数据服务异常" —— 用户看到"后端挂了"，排障的人看到一条 SQL 报错。
   修法：新增 `backend/src/common/utils/uuid.util.ts` 作为唯一来源
   （收敛本模块两份副本），并补 `report.dto.spec.ts`：用与 `main.ts` **同配置**的
   真实 ValidationPipe 跑，含"两个 DTO 判定必须一致"的防漂移用例。
   ⚠ **不能改用 `@IsUUID()`**：主键是 UUIDv7，而 `class-validator` 的 `isUUID`
   只认 v1–v5，换上去会让**所有请求**都 400。
2. **管理端退款在出款失败时完全不写审计**（实测：全库 `action=REFUND` **0 条**）。
   根因：`writeAdminAudit` 写在 `executeWechatRefund` 之后且无异常保护，
   而渠道未配置就会抛 `70018` —— 恰恰是最需要留痕的场景（出款"结果未知"时
   微信侧可能已经出款成功）。
   修法：把「出款 + 结算后回读 + 写审计」**整段**纳入 try/catch，失败时写一条
   `success=false` + `errorCode` 的审计再原样抛出；回读失败时退回入参对象，
   保证"读不到"不会导致整条不写；出款已返回时只追加 `note`，
   不把一次成功的退款记成失败。
   **实测证据**：修后调 `POST /admin/orders/{id}/refund`（渠道未配置，必然 `70018`）
   → 审计表新增 1 条 `action=REFUND success=false errorCode=70018`，
   且管理端 `GET /admin/audit-logs?targetType=ORDER` 查得到
   （`action=payment:order:refund`、`result=FAILED`）。
   复现脚本：`.runlogs/repro-refund-audit.cjs`、`.runlogs/probe-audit-api.cjs`。
3. **`ai.systemNotice` 运营改不了**：该键此前不在 `system-config.catalog.ts`，
   而目录之外的键由 `SystemConfigService` 按"未知键"**只读**下发 ——
   对话首屏那段合规文案运营无从修改。
   修法：补进目录（AI 分组，`requiresConfirmPassword: true`），并把
   `system-configs.spec.ts` 里"允许该键作为目录外公开键"的**例外断言收紧为
   「一个都不许有」**（例外消失即收紧，今后再塞目录外的公开键会直接失败）。
4. **订阅消息的权威模板 ID 永远读不到**：`notify.template.{scene}` 六个键都不在目录里，
   于是 `resolveAuthoritativeTemplateId` 每次都回落到**客户端上报值**并打 warn ——
   契约 §3.11.3"服务端用 `scene` 映射权威模板、防客户端传错"**从未生效过**。
   修法：六个键补进目录（APP 分组，默认空串、`isPublic: false`）。
   **默认值刻意留空**：模板 ID 是"每套小程序账号一套"的环境值，预置假值会在
   库中出现该行后**覆盖客户端真值**，线上通知全部发不出去。**仍需运维在后台填真值**。
   漂移由新增的 `notification-template-config.spec.ts` 守住（遍历全部场景断言目录有键；
   依赖方向仍是 notification → system 单向，避免双向依赖）。

**种子实测**：`系统配置 : 10`、`Prompt : 3`，幂等重跑数值不变；
库中核对 `promptTemplates=3 / systemConfigs=10`，E2E 残留为 0。

**本轮新发现、需要决策的项（**未擅自改契约**）**

1. **契约 §3.5.1 与实现/数据库/前端**三处都不一致**：契约写
   `MBTI_REPORT | BIG_FIVE_REPORT | GROWTH_REPORT`，而 `DATABASE_DESIGN.md`、
   `schema.prisma`、后端 DTO、小程序 `api/report.ts` **一致使用 `GROWTH_SUMMARY`**
   —— 小程序那份文件里甚至留了注释警告"不要照抄契约的示例枚举"。
   按 ADR-033 立下的判据（实现 + 前端 SDK 是既成事实、契约只有文档在用），
   结论应是**改文档**；但 §3.5.1 的漂移不止枚举：契约要求的
   `profileId` / `profileIds` / `forceRegenerate` / `language` / `tone` / `focus`
   六个请求字段**实现里一个都没有**（实现只接受 `type` + `sessionId`）。
   "补实现"还是"改契约"是产品级取舍，**留给下一轮明确后再动**。
2. **`POST /reports` 声称支持的 `RELATIONSHIP_REPORT` 实际不可达**：Swagger 枚举
   里有它，`report.service.ts` 的 `createRelationshipReport` 也已实现
   （校验关系归属 / `ACTIVE` / 算分报告齐备），缺的只是 `CreateReportDto` 没有
   `relationshipId` 字段 —— 于是这条分支**永远走不到**，调用必返 `400/10001`。
   两种修法（加可选字段让分支可达，或从枚举去掉并明确关系报告只走关系域）都属契约变更。
3. **`ai.maxMessagesPerConversation` / `ai.maxConversationsPerDay` 仍是代码常量**
   （`chat.types.ts` / `chat-quota.util.ts`）。契约只在 `GET /ai/quota` 响应里要求
   这两个数字，**没有要求它们可配置**，而 `chat/README.md` 标着"需补录"。
   **刻意不建这两个配置键**：建了却没人读，等于给运维一个"改了不生效"的开关，
   比不建更糟。要么接上读取点，要么把 README 的说法改成"契约常量"。
4. **退款的两条残留路径**（子代理报告 + 我复核，其中①为读代码结论、未实测）：
   ① 渠道未配置时退款单保持 `PENDING`、订单 `refundedAmount` 已被预留，
   而对账任务 `reconcilePendingRefunds` 在拿不到商户号时（`requireMchId()` 抛非
   `NOT_FOUND` 类异常）只会累加 `stillPending`。即**自愈但滞后**：渠道配好之后
   的下一轮对账才会走 `NOT_FOUND` → 超 30 分钟判定"从未提交" → 释放额度。
   需要确认该窗口内用户侧看到的是"退款处理中"而不是"已退款"。
   ② 成功路径的审计写失败只返回 `auditLogId: null`，且**没有任何告警/指标** ——
   审计链路故障会静默。

> ⚠ 排查用的运维提醒：`Start-Process ... -RedirectStandardOutput .runlogs\boot.log`
> 写出的日志**可能不是覆盖而是追加**（本轮实测：文件里同时存在上一轮的请求日志与
> 本轮的启动行，靠 `pid=` 才能区分）。判断"服务是否本次启动"请看
> `Get-NetTCPConnection -LocalPort 3000` 的 `OwningProcess` 与 `Get-Process` 的
> `StartTime`，**不要看日志时间戳**（应用下发的 HTTP `timestamp` 是准确的，
> 本轮实测 `2026-10-12T09:54:52.743Z` = 本地 17:54:52）。

### 3.6 缺口补齐第一轮（2026-10-13）：契约 §3.5.1 定案 + 大五报告通路

**已交付**

1. **`RELATIONSHIP_REPORT` 从"必然 400"变成真正可达**（ADR-034）。
   根因：`CreateReportDto` 没有 `relationshipId`，服务层 `createRelationshipReport`
   那套完整校验（归属 / `ACTIVE` / 算分报告）**永远走不到**。
   修法：DTO 新增可选 `relationshipId`（UUID 形状校验）+ 控制器透传 + Swagger 修正错误码。
   **活体证据**：带合法形状但不存在的关系 ID → 返回前移到 `404/60000 关系不存在`
   （修复前是 `400/10001`）；缺参仍是 `400/10001`、形状非法仍是 `400/10001`。
   探针：`.runlogs/probe-relationship-report.cjs`。
2. **契约 §3.5.1 按实现校正**（ADR-034）：`type` 枚举改为与 `ai_report_type` 逐字一致
   （`GROWTH_REPORT` 这类简写是**文档错**，前端注释早已警告）；
   删除 6 个无读取方字段（`profileId`/`profileIds`/`forceRegenerate`/`language`/`tone`/`focus`）
   并登记为「未交付能力」；**错误码表也一并校正** —— 原文的 `10010`（限流）与
   `10011`（缺幂等键）实际是 `10007 RATE_LIMITED` 与 `10009 IDEMPOTENCY_KEY_MISSING`。
3. **`BIG_FIVE_REPORT` 的通路补齐**：新增 `report.bigfive` 模板（4 段、首段免费、
   只用大五真实变量、不引用任何 MBTI 变量）。此前该类型必然 `50011`。

⚠ **注意管理端那几处 `GROWTH_REPORT` 不要跟着改**：`admin/report` 与 `admin/ai-stats` 的
`ADMIN_REPORT_TYPES` 是**刻意的对外词汇表**，有显式映射
（`admin-report.util.ts` 的 `RELATIONSHIP_REPORT → COMPATIBILITY_REPORT`），与 `AiReportType` 不同源。

### 3.7 缺陷清单（✅ 表示本轮已修）

1. ✅ **`neuroticism` 的中文标签会把含义说反**（**已修**）。
   `report-context.builder.ts` 的 `BIG_FIVE_LABELS` 原先把 `neuroticism` 标为「情绪稳定性」，
   而引擎存的是**神经质原始分** —— `personality-engine.service.spec.ts` 写得很清楚：
   「反向题选 5 → 情绪稳定性高 → **神经质得分为 0**」，关系规则也用
   `neuroticism >= 90` 判**焦虑型**依恋。于是「情绪稳定性 90（高）」的真实含义是
   **情绪很不稳定**，模型会把最容易焦虑的用户解读成最稳的人（而报告读起来毫无破绽）。
   小程序端 `config/constants.ts` 一直用的是「神经质｜分数越低越稳定」，**前后端原本各说各话**。
   修法：统一为「**神经质**」（`BIG_FIVE_LABELS` 与 `chat-persona.util.ts` 的 `BIG_FIVE_ITEMS`），
   并同步 `report.bigfive` 模板的第 7/9 条；新增断言 `BIG_FIVE_LABELS['neuroticism'] === '神经质'`
   且**不得含「稳定」**，防止将来被改回去。**数值方向没有反转**（关系规则与权重矩阵都按原始分比较）。
2. ✅ **报告标题按 MBTI 变量拼**（**已修**）。原实现判断 `mbtiType === undefined`，而
   `buildReportContext` 保证变量永远存在（缺数据时是占位文案），因此兜底分支从不命中：
   纯大五画像会得到标题 `（本次测评未包含此项） （本次测评未包含此项） 深度解读`；
   做过 MBTI 的用户做大五报告则得到 `INFJ 提倡者 深度解读`。
   修法：新增 `buildPersonalReportTitle`（按 `reportType` 分派 + 按**值**判可用）
   与 `buildRelationshipReportTitle`（关系路径有**同一个坑**：
   `（本次测评未包含此项） × （本次测评未包含此项） 匹配解读（72 分）`）。
   三个新用例都是「修复前必然失败」的，见 `report-generation.service.spec.ts`。
3. ⏳ **`PromptType` 枚举没有 `BIG_FIVE_REPORT`**（`schema.prisma` + init 迁移 + 生成客户端都只有 5 个值：
   `MBTI_REPORT`/`RELATIONSHIP_REPORT`/`AI_COMPANION`/`EMOTION_ANALYSIS`/`SYSTEM_SAFETY`）。
   因此 `report.bigfive` 模板的 `type` 只能暂借 `'MBTI_REPORT'` —— **不影响生成**
   （模板只按 `key` 查找），代价是后台按类型筛选时它混在「MBTI 报告」里。
   彻底修法要动 schema + 迁移 + 后台中文名映射，且 `schema.prisma` 由
   `DATABASE_DESIGN.md` 生成，属独立一轮。
4. ⏳ 两个沿袭自 `report.mbti` 的小瑕疵：`{{conflictStyle}}` 渲染出的是原始枚举码
   （如 `COLLABORATING`，缺中文标签映射）；数据全缺时渲染成「完成率：（本次测评未包含此项）%」。

### 3.8 ✅ `GROWTH_SUMMARY`（成长回顾）已交付（ADR-035）

**该类型现在真正可用**（四种报告类型全部打通）。实现要点：

1. **序列由服务端推导，不采用契约的 `profileIds`**：`ai_reports` 只有单个 `profileId` 外键，
   没有任何列能存下"这次报告用了哪几版"，因此客户端传一组 id 的链路在数据模型上直接断掉。
   改为：锚定画像（`isCurrent = true` 的那一版）**及其之前的最近 12 版**，按版本升序。
   这是**确定性**的（历史画像行不可变、锚定版本号是固定上界），因此同一份报告无论何时重算
   都取到同一序列 —— 满足 ADR-005 的可复现要求，也不需要动数据模型。
   若将来要支持"用户自选几版对比"，那时再加 JSON 列，`profileIds` 才有意义。
2. **新增 `buildGrowthReportContext`**（`src/modules/ai/context/`，纯函数、可 100% 单测）：
   产出 `growthTimeline` / `scoreDeltas` / `changedTraits` / `stableTraits` / `periodText` /
   `latestBigFiveSummary` / `mbtiShifted` / `dataQualityText` 等 11 个变量。
   变化阈值 `CHANGED_TRAIT_DELTA_THRESHOLD = 5`（≈1/3 档位带宽）：低于它属自评量表重测波动，
   **不把噪声讲成成长**。缺维度**跳过而不当 0**（当 0 会造出"从 0 涨到 78"的假增长）。
3. **新增 `report.growth` 模板**（4 段、首段免费），提示词要求：只依据给出的时间线、
   不得编造未提供的版本、不得重新计算分数、变化方向必须中性（大五没有好坏）、
   不做趋势外推、未变化 ≠ 未测量。
4. **创建侧**：不足 2 版直接返回 `400/10001`（"需要至少 2 次测评记录"）——
   一版没有"变化"可言，宁可明确报错也不让模型编造轨迹；
   `cacheKey` 改为**覆盖整个序列**（否则两个不同序列会撞同一个 key，幂等复用变成错误复用）。
   非成长报告的 cacheKey 分段**逐字未动**（改了会让存量报告的缓存全部失效、用户凭空多扣配额）。

**实测**：种子 `Prompt: 5`；`.runlogs/probe-growth-report.cjs` 活体验证 ——
模板生效 ✅、只有 1 版时返回 `400/10001` 且提示明确 ✅、有 2 版时 `202/0` 创建成功、
落库 `type=GROWTH_SUMMARY` / `promptTemplateKey=report.growth` / 锚定在最新一版画像 ✅。

**已知边界（不是缺陷，是取舍）**：版本号可能不连号（`v1/v3/v7` 原样使用）；
`createdAt` 按 UTC 取日期，UTC+8 用户凌晨创建的画像会显示为前一天（组装器刻意不做时区换算，
否则同一份数据在不同机器上会产出不同 Prompt）；逐版的量表编码/作答数**取不到**
（`personality_profiles` 与 `test_sessions` 之间没有能按版本 join 的外键），
逐版传 `null` 并记为字段级缺项，**不编造**。

### 3.9 ✅ 权益矩阵的"PDF 导出"承诺已改为诚实（2026-10-13 处理）

`GET /membership/products` 会下发完整会员权益矩阵（契约 §3.8.1），
内容取自种子 `prisma/seed/data/catalog.ts` 的 `MEMBERSHIP_BENEFITS`。

**原问题**：矩阵里写着「**PDF 导出：不限次**」，而后端 `report-render.util.ts`
恒抛 `90008`（渲染器未接入，见 §3.4）—— 在权益矩阵下发之后，这等于
**卖了一个后端交不出来的权益**（用户为它付费却拿不到，属可投诉的落差）。

**已按"诚实优先"处理（一行数据，随时可回滚）**：

1. **权益文案**：`PDF_EXPORT` 一项改为 `value: '即将开放'` 且去掉 ★ 高亮；
   两处套餐/商品描述里的「…PDF 导出…」也改成「（PDF 导出即将开放）」。
   **实测**：三个会员档位下发的都是「PDF 导出：即将开放」（`.runlogs/probe-membership-benefits.cjs`，6/6）。
2. **功能开关**：配置目录里**本来就有** `FEATURE_PDF_EXPORT` 与 `FEATURE_SHARE_CARD`
   （用途写明是"关闭后入口隐藏"），但默认值一直是 `true`、且**没有任何代码读它们** ——
   这正是"展示一个点了必然失败的入口"的根源。现已把两者默认值改为 **`false`**。
   **实测**：`GET /system/config` 返回 `FEATURE_PDF_EXPORT=false`、
   `FEATURE_SHARE_CARD=false`（`FEATURE_PAYMENT` / `FEATURE_AI_CHAT` 仍为 `true`）。

> ✅ **渲染器已于 2026-10-13 接入，两处已按注释一起改回**（见 §3.17 / ADR-037）：
> ① `system-config.catalog.ts` 的 `FEATURE_PDF_EXPORT` / `FEATURE_SHARE_CARD` 默认值改回 `'true'`；
> ② `catalog.ts` 的 `PDF_EXPORT` 权益改回 `不限次` + `highlight: true`，两处商品描述也改回「（含 PDF 导出）」。
> **实测**：`GET /system/config` 返回两者皆 `true`，会员权益下发「PDF 导出：不限次」
> （`.runlogs/enable-render-flags.cjs` 5/5；该脚本同时负责让 Redis 配置快照失效 ——
> **改库不等于生效**，`SystemConfigService` 有 300s 快照缓存）。

**渲染方案的最终选择与备选否决理由**（当时列出的两条路都评估过）：
选的是**服务端渲染**（用户拍板"需要做"即授权新增依赖）：
`pdf-lib` + `@pdf-lib/fontkit` 画 PDF、`@napi-rs/canvas` 画分享卡，
中文字体用可自由再分发的 **Noto Sans SC（SIL OFL 1.1）** 纳入仓库。
**客户端渲染方案被否决**：它只能解决分享卡，PDF 仍无解，且会让同一套版式在两个端
各实现一份（必然漂移）。完整决策记录见 `docs/PROJECT_ARCHITECTURE.md` 的 **ADR-037**。

### 3.10 小程序码已实现（「扫码邀请」这条路此前是断的）

`relationship_invites.qrCodeUrl` 这一列**只有读、没有写** —— `createInvite` 直接回显库里的
`null`，而契约 §3.6.1 把它列为邀请响应的一部分。也就是说「扫码邀请」从来没生效过。

本轮补上：

- **`WechatService.getMiniAppCode`**（`wxacode.getUnlimited`）。两个关键点：
  ① 该接口**成功时返回图片二进制、失败时返回 JSON，而失败响应的 HTTP 状态码仍是 200**，
  因此必须按 `Content-Type` 分流（照抄 `postJson` 会在成功路径上抛解析错误，
  表现为"二维码永远生成不了"）；
  ② 失败一律返回 `null` 而不是抛错 —— 调用方都是"有更好、没有也能用"的增强能力，
  空响应体尤其不能当成功（会存成一张扫不出来的坏图）。
- **创建邀请时生成并落库**：`scene = 邀请码`、`page = pkgMatch/pages/invite`
  （分包前缀不能少），上传 OSS 后写回 `qrCodeUrl`；任一环节失败都只记日志，**邀请照常成功**。
- `relationship.module.ts` 增加 `WechatModule` + `StorageModule`（二者都不是全局模块）。

⚠ **未能活体验证**：本机未配置微信凭证，真实小程序码要等有凭证的环境验证；
当前行为是"未配置即降级为 null"，邀请主流程不受影响（有 7 个单测覆盖各降级分支）。
**分享卡**里仍有一个返回 `null` 的旧桩，接入时应注入 `WechatService` 并删掉它 ——
不要在那里重写一份微信调用（同一接口两份实现必然漂移）。

### 3.11 📋 契约漂移系统审计（2026-10-13）—— 详见 `docs/CONTRACT_DRIFT_AUDIT.md`

此前只系统核对过 §3.5 一处，就在 §3.5.1 挖出"契约宣称支持、实现必失败"的缺陷。
本轮把 §3.2 / §3.3 / §3.4 / §3.6 / §3.7 / §3.8 / §3.9 / §3.11 / §3.12 共 **9 章 63 个端点**
盘了一遍，产出 **~35 条带证据的差异**。**完整清单与逐条证据见 `docs/CONTRACT_DRIFT_AUDIT.md`。**

**最重要的结论（决定怎么修）**：抽查 5 条"契约说必失败"的高危项，**小程序 SDK 全部站在实现一边**
（`uni.requestPayment(order.payment)`、`http.get<TestDefinition[]>('/tests')`、
`acceptInvite(code)` 发空 body…）。也就是说这些**不是线上故障，而是"照文档新写一个客户端会在
第一个请求上失败"** —— 该按 ADR-033 的判据**改文档**，而不是改实现。

**真正需要改代码的只有两类**（优先级最高，明细见该文档 §1/§2）：

1. **实现内部自相矛盾**：`ORDER_TTL_MINUTES = 15` 而 `/system/config` 与契约都下发/声明 **30 分钟**
   —— 前端告诉用户"还有 30 分钟"，用户在 15–30 分钟窗口支付会撞上已关单，**属能收投诉的缺陷**；
   另有错误码 `50008` 一码两义（危险内容拦截 vs 会话不存在）。
2. **被 DTO 接收却静默失效的字段**（比 400 更危险，客户端以为生效了）：
   其中 `DELETE /relationships/{id}` 的 **`keepHistory=false` 完全被忽略** ——
   **隐私开关静默失效**，用户以为历史报告已隐藏而实际仍可读；`autoGenerateReport=false` 仍会触发算分。

> 建议顺序：① 修内部矛盾（含订单 TTL）→ ② 修静默失效（含隐私开关）→ ③ 按章修订契约（纯文档，可并行）
> → ④ 逐项决策"未交付能力"（游客浏览套餐、`purchaseNotice` 合规文案、`benefitsCompare`）。

### 3.12 🔴 查询串布尔值被静默取反（**全局缺陷，已部分修复**）

**`?flag=false` 与 `?flag=true` 都会变成 `true`。**

根因：全局管道开了 `enableImplicitConversion`，class-transformer **先**按属性的反射类型
做隐式转换（`boolean` 走 `Boolean(value)`），而查询串的值**天生是字符串**
—— `Boolean('false') === true`。更坑的是 `@Transform` 回调拿到的 `value`
**已经是转换后的布尔值**，因此全仓 **7 份** `toBoolean({ value })` 副本
（判 `value === 'false'`）**一次都没生效过**：它们看起来在防这个问题，实际永远走不到字符串分支。

**影响**：每一个查询串布尔筛选都在**静默**给出相反结果 ——
`?hasRefund=false` 只返回有退款的订单、`?includeContent=false` 仍下发正文、
`?includeUsage=false` 仍返回用量，以及**§3.12 上一节刚做的隐私开关**
`?keepHistory=false` 被当成 `true`（等于那个修复在线上从未生效）。不报错、不写日志。

**已修**：

- 唯一实现 `common/utils/query-boolean.util.ts`：从 `obj[key]` 读**原始字符串**
  （`obj` 是未被隐式转换过的原始输入）；无法识别的值原样透出交给 `@IsBoolean()` 拒绝。
- `relationship/dto/relationship.dto.ts`（含给 `keepHistory` **补上 `@Transform`**）
  与 `ai/report/report-engagement.dto.ts`（10 处）已改用共享实现。
- 新增 `query-boolean.util.spec.ts`，其中一组用例**走与 `main.ts` 同配置的真实 ValidationPipe**
  —— 本缺陷恰恰是"函数写对了但接线不对"，只测函数必漏。

**⏳ 仍待收敛（下一轮，判定方法：跑一次真实管道传 `'false'` 看是否得到 `false`）**：
另有 5 份同类副本未改 —— `ai/chat/chat.dto.ts`、`payment/refund.dto.ts`、
`admin/{user,config,prompt,test-definition}/dto/*.ts`；`admin/question/dto/admin-question.dto.ts`
已经收 `{value, obj, key}`，可能部分可用，需逐个验证。

**同类但危害较小**：**请求体**里的字符串布尔同样被隐式转换
（`{"autoGenerateReport":"false"}` → `true`）。JSON 客户端本来会发真布尔，故危害小；
要收紧就给字段加 `@Transform(parseQueryBoolean)`。

### 3.13 ✅ 游客可浏览套餐已实现，并修掉一个连带的鉴权陷阱

契约 §3.8.1 规则 2 明确要求「**游客可浏览套餐**（转化漏斗需要）」，而 `GET /membership/products`
没有 `@Public()`、匿名访问返回 `401` —— 尚未登录的新用户看不到任何价格，
而"先看到价格再决定注册"正是转化漏斗的第一步。

**实现**：该端点标 `@Public()`；未登录时 `membership` 返回**匿名视图**
（`isMember: false`、其余 `null`，字段一个不少，前端无需为游客写第二套分支）。

⚠ **连带发现了一个更危险的陷阱**（差点造成回归）：全局守卫原先是
`if (isPublic) return true` —— **直接跳过策略**，因此公开接口**即使客户端带了合法令牌，
`request.principal` 也永远是空的**。如果只加 `@Public()` 就收工，
**登录会员会被当成游客**（会员页显示未开通），而且 `@OptionalUser` 这个装饰器
在公开接口上**永远用不上"有身份"的那一半**。

**已一并修**：守卫改为「**尝试**鉴权、失败按匿名继续」（公开接口不因令牌问题 401），
并补了 5 条守卫单测锁住"带令牌要解析出身份"。

**活体验证**（`.runlogs/probe-guest-products.cjs`）：先临时授予演示用户一条真实会员权益，
再对照调用 —— 带令牌 → `isMember: true`（expireAt/remainingDays 都有值）、
**同一时刻匿名 → `false`**、受保护接口匿名仍 `401`、其它公开接口仍 `200`。
只有"匿名 false / 带令牌 true"的对比才能证明身份真的被解析出来了
（演示用户本来不是会员时，两条路径长得一样，断言会**假绿**）。

### 3.14 ✅ 付费墙链接指向不存在的路由（已修，含连带的筛选缺口）

`GET /ai/quota` 的 `nextActions.upgradeUrl` / `creditsUrl` 原为
`/api/v1/membership/plans` 与 `/api/v1/products?type=AI_CREDITS` —— 这两个路径
在本项目**一个路由都没有**（ADR-033 已把 `plans`/`products` 合并到 `GET /membership/products`）。
客户端照着跳直接 404，而这条链路正是「额度耗尽 → 拉起付费墙 → 去升级」，
**链接坏掉等于把付费用户挡在门外**，且不报错、不告警。

已改为 `/api/v1/membership/products`（+ `?type=AI_CREDITS`），并提成具名常量；
`chat-paywall-links.spec.ts` 把它们与 `MembershipController` 的**路由元数据绑定**断言 ——
直接比字面量会在路由改名时依然通过，等于摆设。

⚠ **连带缺口**：`?type=` 这个筛选**在实现里根本不存在**（该端点当时没绑定 `@Query()`），
所以链接改对了、用户点"买次数包"仍会看到会员档位混进展厅。已一并实现
（`ListProductsQueryDto`），并按"要么实现、要么明确拒绝"的原则把契约里另外三个
未交付参数（`includeBenefitsCompare` / `platform` / `code`）**从契约移除** ——
该端点现在绑定了 `@Query()`，传它们会返回 `400/10001`（此前是静默忽略）。

**活体实测**：`?type=AI_CREDITS` → 1 件、`?type=MEMBERSHIP` → 3 件、非法值 → `400/10001`、
不传 → 6 件；两个付费墙地址实测均 `200`（此前 404）。

### 3.15 📋 契约逐章修订（ADR-036）—— **已提交，但只做了抽查验证**

按 ADR-036 的收口规则，对 `docs/API_DESIGN.md` 做了一轮**以实现为准**的批量修订
（471 行变动，+202/−269）：请求字段表删掉未交付项、响应示例改成实现真实返回的形状、
枚举对齐 Prisma、各章内联错误码表按 `error-code.ts` 校正，并新增 **17 处**
「未交付能力」登记（写清各自前置工作，而不是只删不说明）。

**已验证的**：

- 结构完整性 —— 小节标题 **89 → 89**、附录 A.13 接口索引 **90 → 90**（无丢章、无丢接口）；
- `prettier --check` 全仓通过；
- 抽查 §3.3.1 `GET /tests`：响应已改成与实现一致的**裸数组** + 真实字段名
  （`code` / `category: 'MBTI'` / `questionCount` / `coverUrl` / `completedInProgress` …）；
- 抽查残留的 `planCode`（§3.2.1 登录响应里的 `membership.planCode`）：小程序确实用这个名字，
  **不是漏改**。

⚠ **未做逐行验证**：这一轮修订由子代理执行、我在其进行中停止了它，因此
**覆盖面广但未经逐条复核**（我抽查了上述几处 + 结构校验）。下一次交接若要依赖某一条契约细节，
请先按 `docs/CONTRACT_DRIFT_AUDIT.md` 的判据（"小程序站在哪边"）就地核对一次。

#### 3.15.1 ✅ 第二轮：独立抽样复核证明"改了但没改对"，已逐条返修（2026-10-13）

上面那句"未经逐条复核"**不是客套 —— 复核之后确实翻车了**。派了一个**只读**的独立代理
按双向证据（文档行号 ↔ 实现行号）抽 19 条，结论 **9 ✅ / 10 ❌**。

**漏改的不是字段表和枚举**（那部分是对的），而是两类"文本块"：

- **示例代码块**（§3.2.6、§3.2.7、§3.3.7、§3.8.1、§3.9.1）：照示例调用直接 `400`，
  或按旧字段名解析恒 `undefined`；
- **内联错误码表**（§2.2、§2.9.1、§3.2.5、§3.2.6）：为**不存在的码**写分支。

最危险的是**"加了 ⚠ 更正注就以为改完了"**：§3.2.6、§3.6.3、§3.8.1 三处的 ⚠ 注与它上方
20 行内的原示例**直接互相矛盾**（注说"不能传 `channel`"，示例偏偏传了）。

**由此新增的验收条件（本轮已落实）**：

> **⚠ 注存在 ⇒ 被注对象必须同步改写。** 不允许"注说 A、正文写 B"。

10 条 ❌ 已全部返修（415 的码 `10007`→`10006`；幂等图的 `10012`/`10013`→`10003`；
`consents` 外层键；`TERMS_OF_SERVICE`；删 `channel`；201→200；`30015`→`30009`；
`includeTrend` 默认 `true`；§3.6.3 删 4 行旧表残留；商品响应 13 字段 + `90009`→`70018`；
`features` 补小写别名）。另按同一原则顺带修了 §3.2.7、§3.3 章内 4 处限流、§3.14.2 三组同类矛盾。
明细见 `docs/CONTRACT_DRIFT_AUDIT.md` §6。

**复核中被证实的两个新问题**（已登记，未修）：

- §2.9.2 清单里的 `POST /orders` **是根本不存在的路由**（真实路径 `POST /payment/orders`）；
- **`30002 CONSENT_REQUIRED` 与 `30009 AGE_RESTRICTED` 全仓只有定义、无任何抛出点** ——
  同意项强制校验与 18 岁闸门**都未真正落地**。

**仍未修**：§2.4 与附录成体系的旧表约 60 处仍含不存在的码（文档 `:614` 自注"本轮未改"），
需单列一轮统一处理。

结构复核（prettier 之后）：标题 **1/8/64/122** 与修订前**逐项相同**，端点索引 **54 → 54**，
代码块围栏 **572 → 572**；`numstat` +297/−372。

### 3.16 ✅ 下单幂等：从"契约承诺"补成"真实行为"（2026-10-13）

契约 §2.9.2 要求 `POST /payment/orders` 必须携带 `X-Idempotency-Key`（缺失 `10009`），
小程序也确实在发这个头 —— 但实现**既不声明 `@IdempotencyKey()`、也没有任何按幂等键去重**，
请求头被静默忽略。危害在资金侧：客户端相信"服务端会拦住重复提交"因而放心重试，
实际每次都新建订单（`orders.idempotencyKey` 写的是服务端随机值，与客户端键无关）。

修法对齐 `refund.util.ts` 既有模式（**不动 schema**）：`@IdempotencyKey()` 必填；
重放**短路在任何业务校验之前**（否则商品恰好下架时重放会拿到 `70001` 而非首次的成功响应）；
命中原样返回首次整份响应；结果整份存 Redis，键空间
`idem:payment:order:{userId}:{sha256(userId:clientKey)[0:32]}`，**TTL = 订单有效期 30 分钟**
（订单过期后同键重放应当建新单）；**Redis 故障一律 fail-open**。

**活体证据**（`.runlogs/probe-order-idempotency.cjs`，真实 HTTP + Redis + PostgreSQL，9/9 通过）：
同键重放 → 同一 `orderNo` `SM202610132149044428`（支付参数也一致）；
换键 → 新单 `SM202610133099502169`；缺键 → `400/10009`；键非法 → `400/10001`；
订单表 `3 → 5`，**净增恰好 2**。

⚠ **诚实边界**：服务端幂等只对"同一个键"生效。小程序 `api/order.ts:97` 在**每次调用时**
现取 `createIdempotencyKey()`（该函数自己的注释却写着"必须生成一次并复用"），
因此**双击下单仍会产生两笔订单 —— 这一半只能在客户端修**（复用同一个键 / 请求中禁用按钮）。
不要把它当成双击的完整解法。

## 4. 下一步做什么（按这个顺序，别跳）

### 第 1 步：收干净新交付的四个域（**2026-10-12 已完成，见 §3.5**）

第 1 步的两件事都已做完并有实测证据：

1. **AI 助手 seed 已补齐**：`ai.companion` 模板 + 10 条 `system_configs` 入种子，
   `verify-ai-companion.cjs` 全部断言通过（渲染、候选键命中、定界符只包一次、
   后台静态检查器的注入防护与边界声明均通过）。**开箱报 `50011` 的缺口已消失。**
2. **四个新域已逐项验完**：`verify-new-domains.cjs`（**注意：这个脚本在本轮被更新过，
   现为 78 项断言 / 6 分桶**）本轮结果 **68 通过 / 2 缺陷 / 8 环境限制**。
   残留的 8 条全部是环境限制（未配 `DEEPSEEK_API_KEY`、未配微信商户证书），
   其中"退款审计"一条经复现证实**是脚本的假阴性**（详见 §3.5 第 2 条）。

**第 1 步的剩余尾巴**（属第 2 步范畴，见 §3.5 的四个未决项）：
`POST /reports` 的契约漂移与 `RELATIONSHIP_REPORT` 不可达需要先定方向再动手。

**方法（继续遵守）**：不要相信任何子代理的"门禁全绿"报告，**自己重跑**（见 §2 的假绿陷阱）。
本轮实测就抓到一次：子代理交付的 `refund.service.spec.ts` 自测通过、prettier 也过，
但 **eslint 有 3 个错误**（只跑了 prettier 没跑 eslint）。
遇到 5xx 先**重试 3 次**再判定（见 §6.3 第 16 条）。

### 第 2 步：补齐真正缺失的接口

按 2026-10 的清点，契约里仍未实现的接口（约 20 个，逐个核对 A.13 索引）：

- **通知 3**：`GET /notifications`、`POST /notifications/read`、`POST /notifications/subscribe`
- **报告 5**：`/reports/{id}/sections`、`/stream`（SSE）、`regenerate`、`export-pdf`、`share-card`
- **AI 助手 8**：`/ai/conversations*`、`/ai/quota`
- **订单退款 8**：`/orders` 列表与详情、`query`/`cancel`/`close`/`refund`、`/refunds`、管理员退款
- **零散 4**：`/compatibility-reports/{id}` 与 `/progress`、`/relationships/invites/{code}`、`/membership/entitlements`

> 上表是**派活时**的清点。接手后请**重新清点**（用 §3.3 的 Swagger 对比法 + `docs/API_DESIGN.md` 附录 A.13），因为这些域可能已完成大半。

### 第 3 步：补两个已确认的模型/链路缺口

1. **`payments` 表全仓库没有任何代码写入** —— 而 `refunds.payment_id` 是**非空外键**，所以不补的话退款根本建不出来。现有兜底（`syncPaymentRow` / `ensurePayment`）只是权宜。**正确做法**：下单时建 `INIT` 支付单、回调时置 `SUCCESS`。
2. **`ProductView` 缺 membership 类商品的 `benefits` 字段** —— 契约的会员权益矩阵拿不到，会员页无法展示完整权益对比。纯增量补充，不破坏现有客户端。

### 第 4 步：管理后台前端接真实接口

`frontend/admin/src/views/` 目前只有 3 个真实视图（登录/看板/404），**8 条路由仍指向 `ModulePlaceholder.vue`**。
管理端 42 个接口已经可用，后台前端是纯接线工作。

### 第 5 步：小程序剩余页面接线

4 个页面仍是占位/骨架：`pages/profile/index`、`pages/test/intro`、`pkgMatch/pages/invite`、`pkgMatch/pages/result`。
（`pages/index` 早已接线；`pkgReport/detail`、`pkgTest/result`、`pkgMember/index`、`report/list` 也已接线。）

### 第 6 步：上线级收尾

- CI 在 GitHub Actions 上**真正跑通**（`.github/workflows/ci.yml` 已写好但从未执行过）
- 监控 / 告警 / 日志聚合
- 合规清单（隐私政策、AI 内容标识、未成年人保护）
- 压测

---

## 5. 项目铁律（违反会被要求返工）

### 5.1 流程规则

1. **先设计再编码**。三份设计文档是**冻结契约**：
   - `docs/PROJECT_ARCHITECTURE.md`（架构 + ADR 表）
   - `docs/DATABASE_DESIGN.md`（46 张表 / 45 个枚举，**是 `schema.prisma` 的事实源**）
   - `docs/API_DESIGN.md`（123 个接口的权威定义）
2. **改冻结项（架构 / 数据模型 / API 契约）必须先写 ADR + 修订文档，再改代码**。
   ADR 追加在 `docs/PROJECT_ARCHITECTURE.md` §20 表格末尾（4 列：ID / 决策 / 理由 / 备选与否决原因）。
   目前已到 **ADR-033**。
3. **每完成一个模块必须测试**，四道门禁全过才算完成。
4. **禁止一次生成大量代码**（单个模块 ≤800 行为宜）。
5. **禁止删除已有稳定代码**。但**可证明错误**的代码应当删除而非标注废弃
   （例：会签出无效签名的函数，保留它等于给后来人留复用入口）。
6. **`error-code.ts` 是错误码的唯一权威**。`docs/ERROR_CODES.md` 由
   `node scripts/generate-error-code-doc.mjs` 生成，CI 会校验一致性 ——
   **改了错误码必须重新生成该文档**，否则门禁必红。
7. **`schema.prisma` 由 `docs/DATABASE_DESIGN.md` 生成**
   （`scripts/extract-prisma-schema.mjs`），另有脚本校验一致性。
   改表结构要同时改文档。

### 5.2 编码约定

- **注释用中文，解释「为什么」而不是「做了什么」**。这是本项目最鲜明的风格，请延续。
- 所有接口必须有**完整 Swagger 装饰器**（`@ApiOperation` 含 summary + 分段 description、
  `@ApiResponse` 覆盖契约里所有错误码）。
- 分页响应统一 `{ items, total, page, pageSize, hasNext }`。
- **NestJS `@Post()` 默认返回 201**。契约要求 200 时**必须显式 `@HttpCode(HttpStatus.OK)`**
  —— 这个坑已踩过多次。
- **金额一律整数分**（ADR-009）。金额只能服务端从表里读，**绝不接受客户端传入**。
- **脱敏是硬要求**：手机号、openid、报告正文、AI 对话原文等敏感字段，对外输出前必须脱敏。
  统一用 `common/utils/mask.util.ts`（**不要再复制一份**，见 §6.3）。
- **AI 输出必须落库**（项目铁律）。写 AI 调用要记用量日志（`ai_usage_logs`），
  成本用 `llm-pricing` 的 `estimateCostCents`。
- **不要新增 npm 依赖**。若某能力缺库（例如 PDF 渲染），
  把渲染那一步抽成**可替换的单点**并如实报告缺口，**不要伪造一个能返回假文件的实现**。

### 5.3 管理端控制器的固定组合

```ts
@ApiTags('后台管理 - XXX')
@ApiBearerAuth('admin-token')
@Public()                                   // 必须！跳过的是【用户端】全局守卫
@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)
@Controller('admin/xxx')
export class AdminXxxController {
  @Get()
  @RequirePermission('domain:resource:read')
  // 敏感写操作额外加 @SensitiveOperation()（要求 X-Confirm-Password 头）
}
```

**为什么必须标 `@Public()`**：`app.module.ts` 把**用户端**的 `JwtAuthGuard` 注册成了
`APP_GUARD`，它按用户 realm 校验令牌 —— 管理员令牌在它手里会被判 realm 不匹配。
所以管理端控制器必须用 `@Public()` 跳过它，再挂管理端的守卫链。

**⚠ 绝不要用 `@AdminPublic()`**（那是给登录/刷新用的匿名标记）。用了接口就**完全公开**。
这个陷阱已专门写过注释与单测，因为一旦搞错就是全站管理接口裸奔。

---

## 6. 踩过的坑（每条都真实发生过，请勿重复）

### 6.1 资金链路

1. **微信支付 v3 请求签名格式错误（发布级阻断，已修）**：
   原实现签的是 `mchid\nnonce_str\ntimestamp\nbody\n` —— 那是**旧版 v2 思路**，
   不符合 v3 规范。v3 要求 **`HTTP方法\nURL\ntimestamp\nnonce_str\nbody\n`**（URL 含 query）。
   用错格式的表现是微信返回 `401 SIGN_ERROR`，而**响应里不会提示"待签名串拼错了"**。
   受影响的是 `createJsapiPrepay`（真实支付路径）→ **修好前线上支付不可能成功**。
   现已删除错误实现，唯一实现是 `buildV3SignaturePayload` / `buildV3AuthorizationHeader`。
   **注意**：`paySign`（小程序拉起支付）与回调验签是**另外两种格式**，三者别搞混。
2. **`TokenService.revokeAllSessions` 原本不拉黑 AccessToken（已修）**：
   只删会话键，已签发的 AT 仍能用满 2 小时。影响用户端「退出全部设备」、
   令牌复用应急响应与封禁。单个会话撤销同样有此问题。
3. **退款必须「先落库 → 再调微信 → 后结算」**：反了会造出最糟的事故
   —— **钱出了款而本地无记录**，查不到、对账也发现不了。
4. **退款失败要区分「明确拒绝」与「结果未知」**：4xx → `FAILED` 并释放额度；
   **超时/5xx/429 → 保持 `PENDING`**（请求可能已被受理，写 FAILED 就是"钱退了却记失败"）。

### 6.2 契约与实现的一致性

5. **文档与实现会系统性漂移，且往往是"整段错位"**：
   曾经整个错误码段 20 与实现不符（文档 20001–20006 实为源码 20000–20005）。已由 **ADR-031** 对齐。
6. **五处路径分歧**（`/orders` vs `/payment/orders` 等）已由 **ADR-033** 定案为**改文档**
   （判据：实现路径已被前端 SDK、活体验证与回归依赖；契约路径只有文档在用；
   且微信回调 URL 属外部依赖，变更会导致回调丢失）。
7. **`GET /membership/products` 合并了契约的 `plans` 与 `products` 两个接口**，
   返回 `{ items, membership }`。代价：缺 `benefits` 字段（见 §4 第 3 步）。
8. **该端点的鉴权标记原写"公开"，实际要求登录**（已修文档）。若不修，
   前端会按公开接口跳过登录态，线上必然 401。

### 6.3 那些"绿着但不生效"的坑（最危险的一类）

9. **`value` 字段只有 `@Transform` 没有校验器** → 被 `whitelist` +
   `forbidNonWhitelisted` 判为非法字段 → **答题保存对所有客户端 400**。
   而 1370 个单测全绿，因为它们直接构造 DTO、**绕过了 ValidationPipe**。
10. **`AnswerItemDto.value` 类问题的一般规律**：全局管道开了
    `whitelist` + `forbidNonWhitelisted`，**任何没有 class-validator 装饰器的属性
    都会被判为"非白名单字段"而整批 400**。加字段时务必同时加校验器。
11. **`exceptionFactory` 只展平一层** → 嵌套 DTO 的字段级错误丢失，
    客户端只看到"请求参数不合法"。已改为递归展平。
12. **导出任务被吞**：BullMQ **按队列消费、不按 job name 过滤**。
    用户端 `data-export.processor` 会把管理端订单导出任务读成 `null` 后 return，
    job 被标记 completed → **导出永不执行**。已给两个处理器都加 job name 白名单。
13. **同一个类里构造函数注入属性与方法同名**（`costs`）会让整个文件 TS2300 编译不过。
14. **同名但重复的实现**：`maskNickname` 曾在三个模块各存一份且口径不一致。
    脱敏是有合规含义的规则，**复制多份必然漂移**。已收敛到 `common/utils/mask.util.ts`，
    其余位置只做再导出。**星号数上限为 3**（产品确认）。
15. **模块循环依赖让整个后端起不来，而四道门禁全绿**（见 §2 第 5 道门禁）。
    `ai.module.ts` ↔ `chat.module.ts` 必须两侧都加 `forwardRef`。
    **教训：任何新增模块后都要做一次真实启动验证。**
16. **瞬时数据库连接失败会伪装成业务故障**：`GET /admin/dashboard/metrics`
    曾返回 `503 code=90002`，日志里是
    `Can't reach database server at 127.0.0.1:5452`，
    而当时两个容器都是 `Up (healthy)`、端口正常监听。
    连打 3 次即全部成功（返回 5782 字节真实数据）。
    **判定规则：看到"连不上数据库/Redis"类的 5xx，先重试 3 次再下结论**，
    否则会把环境抖动误报成代码缺陷、浪费一轮排查。
17. **`endpoint-inventory.cjs` 有一处假报**：它把
    `POST /api/v1/payment/notify/wechat` 列进"契约有、服务未注册"，
    但该路由**确实已注册且可用**（实测返回 HTTP 200 +
    `{"code":"FAIL","message":"处理失败，请重试"}`，这正是微信要求的**非 JSON** 响应体格式，
    由 `@RawResponse()` 负责）。这是脚本的路径归一化 bug，**不是缺接口**。
    用它做覆盖率统计时，看到这 1 条属已知假报。
18. **管理员登录的字段名是 `username` 而不是 `email`**，值才是 `admin@soulmap.cn`。
    传 `{"email": ...}` 会返回 `400/10001`，且 `details` 里会明确写
    `property email should not exist`。写验证脚本时不要想当然。
19. **数据库用户名是 `soulmap` 而不是 `postgres`**（库名也是 `soulmap`）。
    用 `docker exec soulmap-postgres psql -U postgres` 会报 `role "postgres" does not exist`。
    按 `backend/.env` 里的 `DATABASE_URL` 取真实凭据。
20. **在这个 shell 里读中文文件必须显式加 `-Encoding utf8`**。
    本项目文件是 **UTF-8 无 BOM**，而 PowerShell 默认按 ANSI 解码，于是：
    - `Get-Content x.md` 会输出乱码（如 `缁欐帴鎵嬭€呯殑涓€鍙ヨ瘽`）；
    - 更坑的是 **`(Get-Content x.md).Count` 会给出错误的行数**
      （实测同一份 492 行的文档被报成 297 行，足以让人误判"文件被截断"而白查一轮）。
      **判定文件是否损坏，请用字节统计或 `read` 工具，不要信 `Get-Content` 的行数。**
      正确写法：`Get-Content x.md -Encoding utf8`、`Select-String -Encoding utf8`。

### 6.4 前端

15. **刷新令牌会清空用户信息**：`refresh()` 与登录共用持久化逻辑，而
    `/auth/refresh` 响应**不含 `user`` → 每次刷新都把 `userInfo`写成`undefined`
    （昵称变默认、头像消失、会员状态丢失）。**只在令牌过期后才复现**，极难发现。
16. **后端字段是 `avatarUrl` 不是 `avatar`**（写错则头像永远不显示）。
17. **`api/` 层的类型是前端自己写的，TypeScript 校验不了它与后端的一致性**
    —— 这类错误必须靠"对着后端源码逐字段核对"来发现。

---

## 7. 关键文件导航

```
docs/
  PROJECT_ARCHITECTURE.md   # 架构 + §20 ADR 表（ADR-001..033）
  DATABASE_DESIGN.md        # 46 表 / 45 枚举（schema.prisma 的事实源）
  API_DESIGN.md             # 123 个接口的权威定义（附录 A.13 是接口索引）
  ERROR_CODES.md            # 生成物，勿手改

backend/
  prisma/schema.prisma      # 生成物（源自 DATABASE_DESIGN.md）
  prisma/seed/              # 种子（含 data/catalog.ts 商品目录）
  src/common/errors/error-code.ts   # 错误码唯一权威
  src/common/utils/mask.util.ts     # 脱敏唯一实现
  src/config/validation.schema.ts   # 环境变量校验（fail-fast）
  src/modules/admin/        # 管理端（auth 基础层 + 各业务域）
  src/modules/system/       # 用户端系统配置
  .runlogs/                 # 临时脚本与日志（已 gitignore）
    verify-admin-auth.cjs   # 管理端认证验证（14 项）
    verify-admin-live.cjs   # 管理端全部只读接口验证（27 项）
    verify-payment.cjs      # 支付链路验证（11 项）
    endpoint-inventory.cjs  # 契约 vs 运行中 Swagger 的接口差集

frontend/miniapp/           # uni-app 小程序
frontend/admin/             # Vue3 管理后台

scripts/
  verify-all.ps1            # 本地 CI 镜像（9 项检查）
  start-dev.ps1             # 一键起三端
```

---

## 8. 验收脚本怎么用（已有的五个）

```powershell
cd D:\Projects\mbit\backend
# 需要服务已在 3000 运行
node .runlogs\verify-admin-auth.cjs      # 管理端认证链路 14 项
node .runlogs\verify-admin-live.cjs      # 管理端只读接口 + 守卫 27 项
node .runlogs\verify-payment.cjs         # 商品列表 + 下单 + 落库 11 项
node .runlogs\verify-new-domains.cjs     # 支付退款/对话/报告/通知（新增）
node .runlogs\verify-ai-companion.cjs    # AI 对话模板是否就位（新增）
node .runlogs\endpoint-inventory.cjs     # 契约 vs 实际注册路由的差集
```

**写验证脚本时必看的凭据与字段约定**（踩过坑）：

| 项             | 正确写法                                    | 错误写法的后果                                                             |
| -------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| 管理员登录字段 | `{"username":"admin@soulmap.cn", ...}`      | 传 `email` → `400/10001`，`details` 会写 `property email should not exist` |
| 敏感操作       | 带请求头 `X-Confirm-Password: <管理员密码>` | 缺 → `401` + code `20017`（**这是正确行为**）                              |
| 用户端登录     | 照抄 `verify-payment.cjs` 的流程            | 自己猜字段名会撞上 whitelist 校验                                          |

> 这些脚本是**临时工具**（在 gitignore 的 `.runlogs/` 里），但**很有价值**：
> 装配后才暴露的问题（路由未注册、DI 失败、守卫链顺序、真实 SQL 报错）
> 只有它们能发现。**请继续用它们，并随新接口扩展。**
>
> ⚠ 但它们的"全绿"**不能单独作为证据**：输出里必须真有逐项结果，
> 且遇到 5xx 类失败要**重试 3 次**再下结论（见 §6.3 第 16 条）。

---

## 9. 交接时的进行中状态

**工作区状态**：本轮交付**已全部提交**（见下方"最近提交"），接手时 `git status` 应当干净。
`.runlogs/` 下的复现脚本与日志不入库（已 gitignore），但**值得留着用**。

- **门禁状态（本轮实测）**：`tsc` 干净、`eslint src test scripts prisma --max-warnings 0` 干净、
  `nest build` 通过、`jest --runInBand` = **113 个 suite / 2581 个测试全部通过**、
  `prettier --check` 全仓通过。
- **第 5 道门禁（真实启动）已通过**：`/health/ready` 返回 200，
  `database: up` + `redis: up`；`dist/worker.js` 也已实际运行（导出/订单/退款对账等异步任务
  只有它消费，**不启动 worker 时相关 job 会一直停在排队态**）。
- **种子**：`Prompt : 3`（新增 `ai.companion`）、**`系统配置 : 10`**（新增），
  幂等重跑数值稳定。
- **运行时路由数**：注册 **123 条**，与契约 `docs/API_DESIGN.md` A.13 索引的 **123 条一致**；
  其中管理端 **45 条**。
  （注：早期文档里写的"134 条"是静态计数的重复统计口径，**以运行时的 123 为准**。）
- **活体验证**：管理端 27/27 通过；支付链路 11/11 通过；
  四个新域 68/78 通过（2 缺陷 / 8 环境限制，明细见 §3.5）。
- **最近提交**（**本轮 2026-10-13 的所有交付**，自上而下）：
  - `c700599` docs(contract): 按 ADR-036 逐章修订契约（以实现/小程序为准），并登记 17 处未交付能力
  - `ed11ed2` docs(adr): ADR-036 契约漂移的系统性收口
  - `b509761` fix(membership,chat): 付费墙链接指向不存在的路由 + 补上 `?type=` 商品筛选
  - `d841fe3` feat(api): 游客可浏览套餐（契约 §3.8.1）+ 收敛全部查询串布尔解析副本
  - `366b324` / `7136541` 查询串布尔被静默取反：唯一实现 + 全局修复（含 `keepHistory` 隐私开关）
  - `4eb331d` fix(storage): 头像登记 `etag` 改为真实比对、`width`/`height` 改为明确拒绝
  - `789ace4` fix(membership): 权益表不再承诺交不出来的 PDF 导出，并关闭两个渲染开关
  - `f303585` fix(errors): 对话不存在改用 `50022`，解除与危险内容拦截 `50008` 的撞码
  - `7a6ad12` fix(relationship): 接通被静默忽略的两个开关（`keepHistory` / `autoGenerateReport`）
  - `2d27fdf` fix(payment): 订单有效期 15 → 30 分钟（与契约和 `/system/config` 对齐）
  - `a07303f` feat(db): `prompt_type` 补齐 `BIG_FIVE_REPORT` / `GROWTH_SUMMARY`
  - `85c9d57` feat(backend): 交付成长回顾报告（ADR-035）+ 会员权益矩阵 + 下单 INIT 支付单
  - `e8d4712` fix(ai): 修正 `neuroticism` 中文标签说反含义，并让报告标题按类型分派
  - `343a8a9` fix(report): 打通 `RELATIONSHIP_REPORT` 与 `BIG_FIVE_REPORT`（ADR-034）
  - `e1f62ea` fix(backend): 退款审计留痕 + 报告 ID 入参校验 + 配置目录补录

> ✅ **已在 `dc13e2e` 中解决的历史遗留**：微信支付 v3 签名修复、CORS 补
> `X-Confirm-Password`、`worker.module.ts` 接线 `PaymentJobsModule`、
> `relationship/compatibility.service.ts` 的语法错误、`maskNickname` 星号上限 ——
> 这些**都已提交**，不需要再处理。

### ✅ 已解决：AI 助手的 seed 数据（2026-10-12）

`ai.companion` 对话模板与 10 条 `system_configs` 已入种子并实测通过。
当时的约束（**继续适用，改模板前先读**）：

- 模板键名必须是 `ai.companion`（不是 `AI_COMPANION` —— 种子键要匹配
  `/^[a-z]+\.[a-z0-9]+$/`；`chat-prompt.ts` 的候选链已含它）。
- 占位符只能取 `buildPromptVariables()` 真实产出的变量名。
- 改动需同时满足 `prisma/seed/data/prompt-templates.spec.ts` 与
  `system-configs.spec.ts` 的断言（后者会把种子与配置目录逐键比对）。
- **`ai.systemNotice` 的文案有三处副本必须逐字一致**：`chat.types.ts` 的常量、
  配置目录的 `AI_SYSTEM_NOTICE`、种子文件里的同名字符串。

> **尚需运维配置（不是代码缺陷）**：`notify.template.{scene}` 六个键虽已进目录，
> 但库里仍无值 —— 权威模板 ID 必须由运维在管理后台填成**微信后台的真实模板 ID**，
> 在那之前服务端只能采用客户端上报值。详见 §3.5 第 4 条。

---

## 10. 最终目标（Definition of Done）

**后端完整**：`docs/API_DESIGN.md` 的 123 个接口全部实现、**五道门禁**全绿（含真实启动验证）、
活体验证通过。

**可上线**（用户原话："我要的是上线级的成果"）：

1. 三端功能闭环可用：小程序能完成「测评 → 看报告 → 匹配 → AI 助手 → 付费」
2. 管理后台**完整可用**：管理员能登录并完成日常运营（用户/题库/Prompt/订单/退款/配置/角色）
3. CI 在 GitHub Actions 上真正跑通
4. 资金链路可验证：真实微信商户号下能下单、支付、退款、对账
5. 合规齐备：隐私政策、AI 内容标识与免责声明、未成年人保护、数据导出与注销
6. 监控与告警就位

**UI 精修放最后**（用户明确要求）。

---

## 11. 给接手者的一句话

这个项目**代码量已经很大、文档很全，但"文档与实现漂移"是最大的风险来源**。
所以：**改任何东西之前先读对应文档；改完冻结项先写 ADR；每次交付都自己重跑门禁，
不要相信任何人的"全绿"报告（包括子代理，也包括这份文档里的数字——它们都有时间戳）。**

---

## 12. 2026-10-13 接手轮总结（本次会话交付）

**当时的起点**：四道门禁全绿、`/health/ready` 正常，但**四种报告类型里只有一种能用**，
且"文档说支持、实现必失败"的缺陷散落在多处。

### 交付清单（`e1f62ea` → 本次收尾提交）

> 提交数不写死：它每天都在变，写死的数字很快就会变成一份文档里的谎言。
> 需要精确值就自己跑 `git rev-list --count e1f62ea..HEAD`（本次收尾时为 21）。

**① 功能从"宣称可用"变成"真的可用"**

- **四种报告类型全部打通**：`RELATIONSHIP_REPORT`（此前 DTO 少一个字段，服务层那段是死代码）、
  `BIG_FIVE_REPORT`（无模板，必 `50011`）、`GROWTH_SUMMARY`（无模板 + 无多画像取数，ADR-035 完整交付）；
- **`neuroticism` 中文标签把含义说反**（大五报告与 AI 人设都在用）→ 统一为「神经质」；
- **报告标题按类型分派**（此前纯大五画像会得到「（本次测评未包含此项）…深度解读」）；
- **小程序码**（`wxacode.getUnlimited`）——「扫码邀请」这条路此前**从来没生效过**（`qrCodeUrl` 只读不写）；
- **下单即建 `INIT` 支付单**（此前 `payments` 一行不写，退款只能靠事后补建）；
- **会员权益矩阵下发** + **游客可浏览套餐**（契约明确要求，此前匿名 401）。

**② 修掉的"静默失效"（最危险的一类：不报错、只是结果与预期相反）**

- **查询串布尔值全站被取反**（`?flag=false` → `true`，7 份 helper 副本**从未生效过**）——
  受影响的包括隐私开关 `keepHistory`、`?dryRun=false`（会真的写库）、`?hardDelete=false`（会清空正文）；
- **`keepHistory` 隐私开关**与 **`autoGenerateReport`** 此前被中间层丢掉（收下但不生效）；
- **头像 `etag`** 从不参与校验、`width`/`height` 收下即忽略；
- **付费墙链接指向不存在的路由**（`/membership/plans`、`/products`）——转化路径的按钮 404；
- **管理端退款出款失败时审计完全丢失**（实测全库 `REFUND` 审计 0 条）。

**③ 制度性收口**

- **ADR-034 / 035 / 036**：报告类型与参数、成长报告取数、**契约漂移的收口规则**；
- **`docs/CONTRACT_DRIFT_AUDIT.md`**：9 章 63 端点的系统盘点（~35 条带证据差异）+ 判定框架
  （**"小程序站在哪边"决定改文档还是改实现**）；
- 契约按 ADR-036 逐章修订（17 处「未交付能力」登记），并**经独立抽样复核后逐条返修**（见 §3.15.1）。

**④ 本会话收尾轮的追加交付**

- **契约修订经独立抽样复核**：19 条抽样里 **10 条 ❌** —— 漏改的是**示例代码块**与**内联错误码表**，
  还出现"加了 ⚠ 更正注却留着上方矛盾内容"的自相矛盾。10 条已全部返修，
  并新增验收条件「**⚠ 注存在 ⇒ 被注对象必须同步改写**」（§3.15.1）；
- **下单幂等从"契约承诺"补成"真实行为"**：`POST /payment/orders` 此前声明必带
  `X-Idempotency-Key` 却**根本不读**，客户端放心重试会实打实建出第二张订单。
  已补 `@IdempotencyKey()` + Redis 重放（TTL = 订单有效期），**活体验证 9/9 通过**（§3.16）。

### 3.17 ✅ 拿到真实 LLM 密钥后的收尾轮（2026-10-13）：AI 全链路活体跑通 + 渲染缺口实现

用户提供了 DeepSeek 密钥，并拍板「报告 PDF / 分享卡渲染需要做」。本轮把这两件事做完，
并在过程中**发现并修掉一个此前所有测试都测不到的真实缺陷**。

#### ① AI 生成主链路：首次有真实证据（`.runlogs/probe-ai-live.cjs`，14/14 通过）

| 环节     | 实测                                                                                         |
| -------- | -------------------------------------------------------------------------------------------- |
| 报告生成 | `POST /reports` → 202 → 轮询至 `SUCCEEDED`；`provider=DEEPSEEK model=deepseek-flash`         |
| 真实正文 | 3 段共 864 字中文（`overview` 259 / `strengths` 277 / `growth` 272），内容切题且含置信度说明 |
| 真实用量 | `ai_usage_logs`：`tokens=548+507=1055 cost=7分 success=true`，与本次 `reportId` 关联         |
| 付费墙   | 详情接口 `unlocked=1/3`，未解锁段 `content=null` 且给出 `lockedHint`（**这是正确行为**）     |
| AI 助手  | 建会话 201 → 发消息 201；回复 130 字中文，`tokens=840 latency=432ms finish=stop`             |
| 配额     | `GET /ai/quota` 显示 `usedToday=3 dailyLimit=10`，扣减真实生效                               |

⚠ 一个容易误判的点：`GET /reports/{id}` 在**生成中返回 409**（不是 `200 + GENERATING`）。
探针若不把 409 当"进行中"，会在第一次轮询就误报失败。

#### ② 修掉一个真实缺陷：`POST /ai/conversations/{id}/messages` 的**双层响应信封**

活体验证时发现响应是 `data.data.assistantMessage` —— 根因是 `sendMessage` **自己**已经构造了
完整信封（`envelope(...)`），却没标 `@RawResponse()`，于是全局 `TransformInterceptor` **又套了一层**。

后果比字段错位严重得多：危险内容拦截路径要求**顶层 `code = 50008`**，
被重新包成顶层 `code = 0` 之后，前端会把它当**成功响应**处理 ——
契约里「渲染关怀文案与资源卡、禁止弹错误 Toast」这条**安全约定整体失效**，
而它恰恰是自伤高危内容出现时的那条路径。而 380 行的注释还写着"本方法返回带 `@Res()` 的原始响应"，
**代码里根本没有**。

修法：加 `@RawResponse()`（并订正那句与代码不符的注释），新增 `chat.controller.spec.ts`
**行为级**守门测试（不只断言装饰器，而是真的把控制器调起来断言返回值是单层信封、
且拦截路径顶层 `code === 50008`）。活体复验：回复从 0 字变为 **130 字**。

#### ③ 渲染缺口实现（ADR-037）：真实 PDF 与真实分享卡

| 项         | 实测                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF        | 94.3 KB、**2 页 A4**、`%PDF-` 头、可被 `pdf-lib` 第三方解析、内嵌字体 `fontEmbedded=true`、`fontSubsetted=true`（子集 88 KB vs 源字体 8.3 MB） |
| 付费墙     | 未解锁段正文不进 PDF：锁定 94.3 KB < 全解锁 111.4 KB                                                                                           |
| 分享卡     | 真实 **WebP**（VP8X 容器）44.6 KB，750×1334（**从文件头读回**，不信任渲染器自报值）                                                            |
| 降级路径   | 小程序码缺失时「无码」布局仍出图 23.1 KB                                                                                                       |
| HTTP 层    | 导出任务 `stage=ERROR errorCode=80003 文件存储服务未配置` —— **已越过渲染阶段**，仅卡在未配置的 OSS 上传                                       |
| 开关与文案 | `FEATURE_PDF_EXPORT=true` / `FEATURE_SHARE_CARD=true`；会员权益恢复为「PDF 导出：不限次 ★」                                                    |

接入依赖：`pdf-lib` + `@pdf-lib/fontkit` + `@napi-rs/canvas`，中文字体用 **Noto Sans SC（SIL OFL 1.1）**
纳入 `backend/assets/fonts/`（决策与备选方案的否决理由见 **ADR-037**）。

**渲染后有一道硬闸门**：重新解析最终字节，若产物没有内嵌字体就抛 `AI_OUTPUT_INVALID` ——
宁可任务 FAILED 并归还配额，也不交付一份"看起来成功、打开全是方块"的报告。

⚠ 两个过程中踩到并已写进注释的坑（都会让检测**误报**，值得后来者注意）：
① 在 PDF **原始字节**里搜 `/FontFile` 永远搜不到（pdf-lib 把字体字典写进压缩的**对象流**）；
② 在 `save()` **之前**的内存上下文里查同样查不到（字体描述符与内嵌流是 `save()` 期间才生成的）
—— 正确做法是**重新 `PDFDocument.load` 最终字节**再检查。

⚠ 仍未交付：`includeAnswers=true`（逐题作答明细）的数据通路未打通，PDF 中会**显式印出一行提示**
而不是静默忽略该选项。

### ✅ 两项外部阻塞已解除（2026-10-13，用户提供密钥并拍板渲染）

| 原阻塞项                     | 解除方式                                      | 结果                                                                         |
| ---------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| **AI 主链路端到端验证**      | 用户提供 DeepSeek 密钥（写入 `backend/.env`） | **14/14 全通过**，真实模型产出真实中文报告与对话（见 §3.17）                 |
| **报告渲染（PDF / 分享卡）** | 用户拍板"需要做"，即授权新增依赖与字体资产    | **已实现并 15/15 活体验证**；开关已打开、权益文案已恢复（见 §3.17、ADR-037） |

### 建议的下一步（按优先级）

1. **配 OSS 凭证**（`OSS_BUCKET` / `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` 目前为空）：
   渲染本身已验证通过，但**导出与分享卡的产物上传不了**，HTTP 全链路会在上传阶段以
   `80003 文件存储服务未配置` 收尾。这是当前唯一挡住"端到端交付给用户"的部署配置项；
2. **补两个"只有错误码、没有实现"的合规闸门**（`CONTRACT_DRIFT_AUDIT.md` §6）：
   `30002 CONSENT_REQUIRED` 与 `30009 AGE_RESTRICTED` **全仓无抛出点** ——
   同意项强制校验与 18 岁闸门都还没落地；
3. **清 §2.4 与附录的成体系旧表**（约 60 处仍含不存在的码，需统一按段位表口径处理）；
4. **限流维度口径**：文档普遍写"按 userId N 次"，实现是全局按 IP 计数 —— 全文档系统性问题；
5. 之后才是 §4 的第 4/5 步（管理后台与小程序页面接线）与 §10 的 CI / 监控 / 合规。

---

### 3.18 ✅ ADR-038 阶段 1–2 完成（**阶段 3–6 待开工**，2026-10-14）

**用户拍板的定位**：项目有三个**互不干扰**的模块 —— MBTI 人格测试、情感测评、
心理健康测评。三者各出各的用户画像，模块之间不互相产结论。
AI 助手改为「能读取三个模块报告」的管家角色，**需要会员才可使用**。
用户原话：「既然现在明确了，就干脆一次性改好，不要怕删功能」。

#### 阶段 2 的三步（**顺序不能反**，已全部完成）

1. ✅ **把读者搬走**：四处消费方（情侣匹配 ×2、关系报告、AI 人设）改为
   用同一份大五现算，不再读画像列 —— 见 `CONTRACT_DRIFT_AUDIT.md` §10；
2. ✅ **停写 + 去掉只读暴露**：画像创建不再写那四列；
   `GET /personality/me`、`GET /users/me?include=profile`、
   `GET /tests/sessions/{id}/result`、管理端用户详情不再返回该字段
   （契约 `API_DESIGN.md` 与小程序 `api/*.ts` 类型同步）；
3. ✅ **删列**：`DATABASE_DESIGN.md` → `schema.prisma`（**由文档生成**）→ 迁移。

> ⚠ **为什么必须先搬读者再删列**：反过来做，上面四处会在编译期直接爆掉一片，
> 而其中情侣匹配（`REPORT_COMPATIBILITY_DEEP`）是**付费产品**，不能停摆。

#### 阶段 2 的两条硬约束（改动时别踩）

- **语义变化必须记住**：关系风格从「提交时冻结」变成「读取时计算」。
  运营改 `relationship_style_rules` 会**同时改变历史用户**的推导值。这是有意接受的
  （规则表是产品配置而非用户数据），已记入 `CONTRACT_DRIFT_AUDIT.md` §10.2。
- **推导值不是测量值**：阶段 3 的情感模块会用**自己的题目直接测量**依恋与爱的语言，
  那才是真实观测。当前推导只是"用户没做过情感测评"时的兜底，
  文案上不得说成"你测出来是……"。

#### 已完成（阶段 1 + 阶段 2 全部）

| 阶段 | 内容                                                                       | 关键产物                                                                   |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1    | `TestDefinition.module`（`PERSONALITY` / `EMOTION` / `MENTAL_HEALTH`）落库 | 迁移 `20261014000000_add_test_module`                                      |
| 1    | 引擎「输出不变」回归锁（重构前先冻结）                                     | `personality-engine.regression.spec.ts` + 3 快照                           |
| 1    | 按模块分派算分的接缝                                                       | `module-scoring.service.ts`（只登记 `PERSONALITY`）                        |
| 1    | `submit()` 按模块分派 + 假画像护栏                                         | `test.service.ts`                                                          |
| 2a   | 人格报告不再携带情感结论                                                   | commit `f38cb5e`                                                           |
| 2b   | 关系风格改为**读取时按需推导**                                             | `relationship-style-rules.loader.ts`、`deriveRelationshipStyleFromBigFive` |
| 2c   | **停写 + 撤掉只读暴露 + 删列**（7 列 / 3 表）                              | 迁移 `20261015000000_drop_emotion_columns_from_personality`                |

#### 阶段 2c 删掉的 7 列（**用户域一列不剩**）

`personality_profiles` 的 `attachment_style` / `love_languages` / `conflict_style` /
`relationship_style`，以及 `test_results` 与 `personality_snapshots` 各自那一个
`relationship_style`。

顺序是「先搬读者 → 再停写与撤暴露 → 最后删列」，**不能反**：先删列会让四处消费方
（含**付费**的情侣匹配 `REPORT_COMPATIBILITY_DEEP`）在编译期直接爆掉。
详见 `CONTRACT_DRIFT_AUDIT.md` §10–§11。

> ⚠ 后两处 Json 列必须删、不只是清理：新语义下关系风格是**读取时**算的，
> 留着的副本会立刻变成"陈旧的第二真相"（匹配用新规则、快照里是旧规则的结果，
> 静默分叉）。且它们是冗余的 —— 大五五列都在，配合当时的规则表可完整复算，
> ADR-005 的可复现性承诺不受影响。

#### 阶段 2 的两条硬约束（改动时别踩）

- **语义变化必须记住**：关系风格从「提交时冻结」变成「读取时计算」。
  运营改 `relationship_style_rules` 会**同时改变历史用户**的推导值。这是有意接受的
  （规则表是产品配置而非用户数据），已记入 `CONTRACT_DRIFT_AUDIT.md` §10.2。
- **推导值不是测量值**：阶段 3 的情感模块会用**自己的题目直接测量**依恋与爱的语言，
  那才是真实观测。当前推导只是"用户没做过情感测评"时的兜底，
  文案上不得说成"你测出来是……"。

#### 阶段 2 的实测证据（不是"应该没问题"）

- `.runlogs/probe-derive-parity.cjs`：库中 2 份真实画像的
  `attachmentStyle` / `loveLanguages` / `conflictStyle` 与推导结果**逐字段相等**；
  库里**没有**匹配报告（该段本会空跑），改用现有画像合成对照对，
  用「库列」与「推导」各算一次匹配分：`total=87.4`（自比）/ `total=86.6`（互比），
  总分 + 四个子项**两条路径完全一致**；
- `relationship-style-derivation.spec.ts`：以 `PersonalityEngine.compute()` 为唯一权威，
  钉死 `derive(compute().bigFive) === compute().relationshipStyle`（含 `matchedRuleCode`）；
- `.runlogs/probe-emotion-removal.cjs`：**13/13 通过** —— 列在数据库里真的没了、
  四个接口的响应体递归扫描无情感字段、全库扫描用户域五张表一列不剩；
- `.runlogs/e2e-smoke.cjs`：临时用户走完「建会话 → 32 题作答 → **提交算分 200** →
  画像 → 报告/会员/商品」全链路 —— 证明 **DDL 与代码同步**（这一点单测看不出来，
  因为 spec 全量 mock 了 Prisma）；
- 活体（`probe-ai-live.cjs`，真实 DeepSeek）：报告 6 段 / AI 对话 **14/14 通过**；
- `.runlogs/probe-fresh-report.cjs`：**5/5 通过** —— 断言 `isReused=false`
  并拿到全新的 `BIG_FIVE_REPORT`（4 段 / 1720 tokens）。
  **为什么单列这一条**：改动中为跑 `prisma generate` 停掉了 worker 却忘了启回来，
  而 `POST /reports` 是幂等的 → `probe-ai-live.cjs` 复用了旧报告、**照样全绿**。
  「异步 + 幂等」的链路必须断言"**这一次**真的做了工作"，
  不能只断言"最终有个成功结果"。已记入 `CONTRACT_DRIFT_AUDIT.md` §11.7。

#### 本轮顺带修掉的三个真实缺陷

1. **规则数组的别名共享**（`relationship-style.evaluator.ts`）：
   `resolveRelationshipStyle` 此前直接返回规则对象的数组，未命中时返回的
   `{ ...DEFAULT_RELATIONSHIP_STYLE }` 也共享同一个**模块级空数组**。任何消费方
   一次 `push` 就会改脏规则表或此后所有默认风格。已改为返回新建数组并加测试；
2. **人格报告编造依恋风格**（模板 v3 → **v4**）：阶段 2a 摘掉了情感变量，
   但「你的关系模式」这一段没有写作约束 —— 实测模型自己编出
   「结合**安全型依恋**与**协作式冲突风格**来看」，而提示词里根本没有这类数据，
   且该段是**付费段**。修法：给段落声明加可选 `hint`（渲染进提示词），
   写死"只从 MBTI / 大五谈关系表现，严禁给依恋类型 / 爱的语言 / 冲突风格"。
   修复后复测：6 段**全部**无情感模块措辞，该段改为完全从 MBTI 四维展开；
3. **置信度借道情感字段落库**：`test_results.relationship_style` 里被塞进了
   `mbtiConfidence`（`{ ...relationshipStyle, mbtiConfidence }`）。删列后重复提交
   路径改读 `personality_profiles.mbti_confidence` —— 置信度本来就该在那儿。

#### 阶段 2 尚未验证的部分（诚实边界）

- 库里**没有任何 `relationships` 行**，因此
  `POST /relationships/{id}/compatibility` 这条运行期路径**没有被真实跑过**：
  "匹配报告能生成"目前只有**合成对照**（上面的 87.4 / 86.6）与单元测试支撑。
  演示用户与真实微信用户之间**刻意没有**建立关系 ——
  在用户手机上凭空多出一个"伴侣"比留一个未验证项更糟；
- **历史报告没有回填**：`ai_reports` 里 v1/v2/v3 模板产出的报告正文可能含旧的
  情感措辞。要不要动用户已付过费的报告是一次数据迁移决策，不在本轮范围。

#### 后续阶段（阶段 3–6，尚未开工）

- **阶段 3 情感模块**：附件 / 爱的语言 / 冲突处理的**自有题库 + 自有画像表 + evaluator +
  情感报告**；情侣匹配归属此模块；`PromptType.EMOTION_ANALYSIS` 目前是
  **半接线枚举**（有白名单与中文名，无模板、无代码路径），需成对补齐；
- **阶段 4 心理健康模块**：多维度得分 + 文字结论，**只做结论、不给建议、不做心理干预**，
  「本结果仅供参考」由服务端下发（合规敏感，微信审核对诊断类措辞敏感；
  `seed-data.spec.ts` 已有敏感词黑名单可复用/扩展）；
- **阶段 5 AI 助手重设计**：改为能读取三个模块报告的管家（总结、跨模块问答），
  **会员才可使用**；
- **阶段 6 前端**：三个模块各自的入口、结果页与报告页
  （`pages/test/intro.vue:24` 目前把 `MBTI_LITE` 写死）。

当前门禁状态（阶段 2 收尾）：`tsc` 0 错 / `eslint` 0 警告 /
**jest 127 套 2799 例全过** / 小程序 vitest **14 套 189 例全过** /
`prettier` 干净 / `node dist/main.js` 启动正常且 `/health/ready` 返回 200。

#### ⚠ 本轮遇到的一次环境故障（记录一下，别再当成代码问题排查）

改动进行到一半时 **Docker Desktop 的引擎（VM）崩了**：`com.docker.backend.exe`
还在监听 5452/6391，但 `/health/ready` 直接**超时**、`docker ps` 报
`Docker Desktop is unable to start`、`prisma migrate` 报 `P1001 无法连接 127.0.0.1:5452`。
现象很像"数据库挂了/端口被占"，实际是 **WSL 里的 `docker-desktop` 发行版已停止**。

恢复步骤（有效）：`wsl --shutdown` → 停掉 `Docker Desktop` /
`com.docker.backend` / `com.docker.build` / `docker-sandbox` 进程 →
重新启动 `Docker Desktop.exe` → 约 6 秒后引擎就绪，
`soulmap-postgres` 与 `soulmap-redis` 自动拉起且都是 healthy，
后端与 worker 无需重启即自动重连（Prisma 会重连，健康检查随即恢复 200）。
