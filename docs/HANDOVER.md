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

## 2. 四道门禁（每次交付必须全过）

```powershell
cd D:\Projects\mbit\backend
pnpm exec tsc --noEmit -p tsconfig.json      # 类型
pnpm exec eslint src --max-warnings 0        # 静态检查（0 警告容忍）
pnpm exec jest --runInBand                   # 单测（必须 --runInBand）
cd D:\Projects\mbit
pnpm exec prettier --check .                 # 格式（全仓）
```

或用本地 CI 镜像脚本：

```powershell
cd D:\Projects\mbit
& .\scripts\verify-all.ps1 -SkipFrontend
```

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

| 维度                       | 数值                                                          |
| -------------------------- | ------------------------------------------------------------- |
| 契约接口总数               | **123**（`docs/API_DESIGN.md` 附录 A.13 索引；其中管理端 43） |
| 已实现路由（源码静态统计） | **134**                                                       |
| `tsc`                      | ✅ 干净                                                       |
| 后端单测                   | 最近一次全量：**78 套件 / 1934 用例全过**（新增域尚未计入）   |

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

### 3.2 交付但**尚未验证**（接手第一件事）

以下三个域由子代理交付，**我尚未亲自复核其门禁与活体行为**：

| 域                     | 接口数 | 文件位置                                                                                                                                                                                             |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 支付订单与退款         | 8      | `backend/src/modules/payment/`（`refund.service.ts`、`order-query.service.ts`、`order-lifecycle.processor.ts`、`orders.controller.ts`、`refunds.controller.ts`、`admin-order-refund.controller.ts`） |
| AI 情感助手（Phase 5） | 8      | `backend/src/modules/ai/chat/`                                                                                                                                                                       |
| 报告导出与分享         | 5      | `backend/src/modules/ai/report/`（`report-regenerate.*`、`report-share-card.*`、`report-export.service.ts`）                                                                                         |
| 通知 + 零散            | 7      | `backend/src/modules/notification/`、`relationship/compatibility-report.controller.ts`、`membership/`                                                                                                |

**其中我知道的确切状态**：

- 支付退款域自测：191 个单测 / 10 套件全绿，但它**无法做活体验证**（没有真实微信商户号），且**签名层曾发现一个发布级缺陷**（见 §6.1）
- 通知域：交付时**无法运行任何门禁**，留下了 1 个语法错误 + 4 个类型错误（**我已修**）
- AI 助手域：最后 3 个类型错误已自行修复，`tsc` 现已干净

### 3.3 已接线 / 未接线

**已接线**（`app.module.ts` / `worker.module.ts`）：

- `SystemModule` + 12 个管理端域模块 + `AdminModule`
- `worker.module.ts`：`AdminOrderJobsModule`、**`PaymentJobsModule`**（订单超时关单 + 退款对账，不接线会**安静地不运行**）

**可能未接线**：AI 助手 / 报告 / 通知三个域的模块。**接手后第一件事就是确认它们的 module 是否已加入 `app.module.ts`，没有就加**（否则路由不注册，但代码和单测都是绿的——这种"绿着但不生效"最难发现）。

判断方法：启动服务后对比 Swagger 路径数

```powershell
(Invoke-WebRequest 'http://127.0.0.1:3000/api/v1/docs-json' -UseBasicParsing).Content |
  ConvertFrom-Json | Select-Object -ExpandProperty paths | Get-Member -MemberType NoteProperty | Measure-Object
```

---

## 4. 下一步做什么（按这个顺序，别跳）

### 第 1 步：把在途的三个域收干净（最高优先）

1. 确认 AI 助手 / 报告 / 通知的 module 已接线到 `app.module.ts`（未接线就加）
2. 重建 + 重启，跑四道门禁，**逐条修到全绿**
3. 用 `backend/.runlogs/verify-admin-live.cjs` 的思路，为这批新接口写一个活体验证脚本并跑通
4. 提交推送

**方法**：不要相信任何子代理的"门禁全绿"报告，**自己重跑**（见 §2 的假绿陷阱）。

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

## 8. 验收脚本怎么用（已有的三个）

```powershell
cd D:\Projects\mbit\backend
# 需要服务已在 3000 运行
node .runlogs\verify-admin-auth.cjs      # 管理端认证链路 14 项
node .runlogs\verify-admin-live.cjs      # 管理端只读接口 + 守卫 27 项
node .runlogs\verify-payment.cjs         # 商品列表 + 下单 + 落库 11 项
node .runlogs\endpoint-inventory.cjs     # 契约 vs 实际注册路由的差集
```

> 这些脚本是**临时工具**（在 gitignore 的 `.runlogs/` 里），但**很有价值**：
> 装配后才暴露的问题（路由未注册、DI 失败、守卫链顺序、真实 SQL 报错）
> 只有它们能发现。**请继续用它们，并随新接口扩展。**

---

## 9. 交接时的进行中状态

- **3 个子代理在跑**：AI 情感助手、报告导出与分享、通知与零散。它们**可能仍在写文件**，
  接手时先确认它们是否已结束（避免与在写文件冲突）。
- `tsc` 当前**干净**；已实现路由 **134 条**。
- 最后三个提交：
  - `f1d2152` docs: ADR-033 五处路径分歧以实现为准 + 契约同步修订
  - `0e69e1d` feat(admin): 管理端 38 个业务接口 + 用户端 system 模块
  - `59c260a` fix(mask): 昵称掩码补上星号数上限（**注意：这条可能尚未提交，见下**）

> ⚠ **未提交的改动**：撰写本文档时，以下改动**可能还在工作区**，接手后请先 `git status` 确认并提交：
>
> - 微信支付 v3 签名修复（`infra/wechat/wechat-pay-sign.util.ts` + `wechat-pay.service.ts` + spec）
> - CORS 补 `X-Confirm-Password`（`main.ts`）
> - `worker.module.ts` 接线 `PaymentJobsModule`
> - 通知域留下的语法/类型错误修复（`relationship/compatibility.service.ts` 等）
> - 本文件

---

## 10. 最终目标（Definition of Done）

**后端完整**：`docs/API_DESIGN.md` 的 123 个接口全部实现、四道门禁全绿、活体验证通过。

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
