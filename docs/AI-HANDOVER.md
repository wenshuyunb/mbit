# SoulMap AI · 交接文档（接手第一份读这个）

> **这份文档写给"刚接手这个项目的你"——不管是人还是 AI。**
> 目标：读完这一份就能开工，不需要先啃 1.5 MB 的设计文档。
> 深水区（契约细节、数据库逐字段、ADR 全文）在 §11 的文档地图里，按需再查。
>
> 文档基准：Git 提交 `2e4d967`，2026-10-19/20。**所有数字都是对仓库实测的**，
> §10 给了复核这些数字的命令——**不要凭信任接手，凭命令接手**。

---

## 0. 30 秒摘要

**这是什么**：一个微信小程序 + 管理后台 + 服务端三件套的**情感成长产品**。
用户做测评（人格 / 情感 / 心理）→ 拿到 AI 生成的深度报告 → 付费解锁完整报告与会员 →
再由 AI 管家陪聊。另有两个轻内容模块：星座运势/星盘、塔罗牌。

**它现在是什么状态**：后端功能齐、测试厚、能真实启动；小程序主流程可用；
**管理后台的前端页面基本还是占位**；支付代码齐但密钥为空；**占卜类内容的小程序类目未确认 → 上线阻塞**。

**三个数字记住**：`3,378` 个后端测试全绿、`142` 个接口方法、`49` 张数据表。

**你要做的头三件事**：

```powershell
pnpm install          # 装依赖（离线包已自带依赖仓库）
pnpm infra:up         # 起 Postgres + Redis
# 然后看 §5 完成 .env、建表、灌数据、起服务
```

---

## 1. 这个项目做什么

### 1.1 用户旅程

```
游客打开小程序
  └─ 首页（今日分数 / 模块入口）
       ├─ 人格测评（MBTI + 大五）→ 报告（免费预览一部分）→ 付费解锁全文（会员/单次）
       ├─ 情感测评（24 幕沉浸式场景题，按性别出题）→ 情感报告
       ├─ 心理测评（场景题，带安全兜底话术）→ 心理报告
       ├─ 星座：运势（日/周/月/年）、星盘与上升星座、星盘解读、今日分数
       ├─ 塔罗：5 种牌阵抽卡 + 组合解读（含合规免责）
       └─ AI 管家（会员能力，读前面三个模块的结论做个性化陪聊）
  └─ 我的：资料、报告列表、会员、协议
```

### 1.2 商业模式

免费测评 → 付费深度报告 → 会员（AI 服务额度）。金额一律**整数分**，只从服务端读，不接受客户端传。

### 1.3 三条产品红线（**代码里是硬约束，不是文案**）

1. **不做决策指导**：不出现"该不该辞职/买房/离婚"这类结论；只描述倾向与可选做法。
2. **不做医疗承诺**：心理测评给的是**自我觉察**，不是诊断；带危机话术兜底与转介提示。
3. **逆位/低分不等于坏**：塔罗逆位写作"受阻 / 内化 / 过量"，禁用"凶/不吉"；测评低分只描述状态。
   合规声明由后端下发（`disclaimer.*` 走 `system_configs`），前端不硬编码。

**上线阻塞提醒**：占卜/命理类内容在国内小程序需要特定类目，目前**类目未确认**。
这不影响开发，但影响上架——不要以为"功能做完就能上线"。

---

## 2. 技术栈（精确版本，来自 `package.json`）

| 层       | 技术           | 版本                                       | 说明                                                  |
| -------- | -------------- | ------------------------------------------ | ----------------------------------------------------- |
| 服务端   | NestJS         | `^10.4.15`                                 | 模块化 + DI，全局管道/守卫/拦截器                     |
|          | Prisma         | `^6.2.1`                                   | 49 model / 49 enum / 16 迁移                          |
|          | PostgreSQL     | 16 (alpine)                                | 本机端口 **5452**                                     |
|          | Redis + BullMQ | `ioredis ^5.4.2` / `bullmq ^5.34.10`       | 端口 **6391**，异步任务                               |
|          | 校验           | `joi ^17.13.3` + `class-validator ^0.14.1` | Joi 校验环境变量，class-validator 校验 DTO            |
|          | 日志           | `nestjs-pino ^4.2.1`                       | 结构化 JSON                                           |
| 小程序   | uni-app        | `3.0.0-alpha-5030120260930001`             | **Vue 3 + TS + SCSS**，编译到 mp-weixin               |
|          | Vue            | `3.4.21`                                   |                                                       |
|          | Pinia          | `2.3.1`                                    |                                                       |
|          | Vite / Vitest  | `5.2.8` / `2.1.9`                          |                                                       |
| 管理后台 | Vue            | `3.5.43`                                   | Vite `5.4.21`、Element Plus `2.14.7`、ECharts `5.6.0` |
| 工具链   | Node / pnpm    | **v24.15.0** / **10.33.2**                 | CI 用 Node 20(后端) / 22(前端)；`.nvmrc` 是 20.19.0   |

> ⚠ **Node 版本坑**：uni-app 工具链要求 **≥ 22.12**，但仓库 `.nvmrc` 写的是 20.19.0（面向后端）。
> 用 nvm 时只做小程序/后台必须切到 ≥22.12。

---

## 3. 仓库结构（monorepo，pnpm workspace）

```
mbit/
├─ backend/                     服务端（NestJS）
│  ├─ src/
│  │  ├─ main.ts               HTTP 入口：helmet → CORS → ValidationPipe → 前缀 → Swagger
│  │  ├─ worker.ts             worker 进程入口（异步任务；不跑它任务会静默停住）
│  │  ├─ app.module.ts         HTTP 侧的模块装配 + 全局守卫/过滤器/拦截器
│  │  ├─ worker.module.ts      worker 侧的装配
│  │  ├─ config/               环境变量 Joi 校验（缺关键项进程直接退出）+ 配置映射
│  │  ├─ common/               错误码、异常、过滤器、拦截器、中间件、引擎、脱敏、UUID
│  │  ├─ infra/                prisma / redis / queue / crypto / oss / wechat
│  │  └─ modules/             16 个业务域（见 §7.1）
│  ├─ prisma/
│  │  ├─ schema.prisma         由 docs/DATABASE_DESIGN.md 生成 + 脚本校验一致性
│  │  ├─ migrations/           16 个迁移（只增不改）
│  │  └─ seed/                 种子数据（系统配置、题库、套餐、Prompt、合规声明…22 个文件）
│  └─ assets/fonts/            OFL 中文字体（PDF/分享卡渲染用）
├─ frontend/
│  ├─ miniapp/                 小程序（uni-app）→ 22 个页面、7 个分包
│  │  ├─ src/pages.json        页面与分包注册（改页面必改这里）
│  │  ├─ src/api/request.ts    自研请求层（拦截器 + 401 单飞续期 + 重登重放）
│  │  ├─ src/styles/           tokens.scss（全局浅色）+ arcana-theme.scss（塔罗深色）
│  │  └─ dist/build/mp-weixin  已编译产物（可直接导入开发者工具）
│  └─ admin/                   管理后台（Vue3 + Element Plus）
├─ docs/                       设计与交接文档（见 §11）
├─ scripts/                    verify-all.ps1 等校验脚本
├─ deploy/nginx/               Nginx 配置（反向代理 + 静态 SPA）
├─ docker-compose.yml          postgres / redis / adminer / redis-commander / server / worker
└─ .env.example                75 项环境变量模板（真实 .env 不入库）
```

---

## 4. 架构

### 4.1 后端分层

| 层       | 目录                    | 职责                                                               | 纪律                                                |
| -------- | ----------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| 入口层   | `main.ts` / `worker.ts` | 装配、安全头、CORS、全局管道、优雅关闭                             | 启动失败即退出，**禁止带病启动**                    |
| 配置层   | `config/`               | Joi 校验所有环境变量 → 强类型 `AppConfig`                          | 缺失关键项直接抛错；生产禁止 `CHANGE_ME` 这类占位值 |
| 公共层   | `common/`               | 错误码、`BusinessException`、全局过滤器/拦截器、评分引擎、脱敏工具 | **错误码唯一权威是 `error-code.ts`**                |
| 基础设施 | `infra/`                | Prisma / Redis / BullMQ / 加密 / OSS / 微信（含支付签名）          | 只做技术能力，不含业务                              |
| 业务域   | `modules/`              | 16 个域，每域自带 controller/service/dto/util/spec                 | 域间通过 service 调用，不跨域直接查别人的表         |

### 4.2 一次请求经过什么

```
HTTP → helmet → CORS → X-Request-Id 中间件 → JwtAuthGuard（全局，可 @Public 跳过）
     → RolesGuard → ThrottlerGuard → ValidationPipe(whitelist+forbidNonWhitelisted)
     → Controller → Service → Prisma/Redis/队列
     → TransformInterceptor 包成 { code, message, data, requestId, timestamp }
     → AllExceptionsFilter 统一错误形状（业务错误 → 错误码 + 明细）
```

**响应包络是契约**：`code = 0` 表示成功；前端 `api/request.ts` 只解 `data`，失败抛 `ApiError`。

### 4.3 双 Realm 鉴权（最容易踩死的地方）

- 用户端令牌 `realm=user`，管理端令牌 `realm=admin`，两套密钥（`JWT_SECRET` / `ADMIN_JWT_SECRET` 必须不同）。
- `app.module.ts` 把**用户端** `JwtAuthGuard` 注册成全局 `APP_GUARD`。
- 因此**管理端控制器必须标 `@Public()`**（跳过用户端守卫），再挂 `@UseGuards(AdminAuthGuard, RolesGuard, ConfirmPasswordGuard)`。
- 🔴 **绝不要用 `@AdminPublic()`** —— 那是给管理端登录/刷新用的匿名标记，用错 = 管理接口完全裸奔。
  这个陷阱有专门注释与单测。

### 4.4 数据层

- `docs/DATABASE_DESIGN.md` 是**事实源**，`schema.prisma` 由 `scripts/extract-prisma-schema.mjs` 生成，
  另有脚本校验两者一致 —— **改表必须同时改文档**。
- 迁移只增不改，共 16 个；金额整数分；软删除/状态机遵循设计文档。
- 文档写 "46 张表 / 45 枚举"，schema 现为 **49 model / 49 enum**（后续 ADR 增补了星座解读缓存等）——
  **以 `schema.prisma` 为准**，文档数字滞后。

### 4.5 异步任务（BullMQ + 独立 worker 进程）

- HTTP 侧的 `app.module.ts` **不覆盖**异步 job —— 订单超时关单、退款对账、AI 报告生成、
  PDF/分享卡导出都在 `worker.module.ts`。
- **worker 不跑的表现很隐蔽**：接口返回 202，但任务永远停在排队态。
  排查"任务永远不完成"先看 `start:worker` 有没有起。

### 4.6 AI 调用链路

```
业务 Service → LlmProvider（工厂，按 AI_DEFAULT_PROVIDER 选 deepseek|openai|qwen）
             → openai-compatible HTTP（可换 baseURL）
             → 结果落库（ai_usage_logs 记用量/成本，llm-pricing.estimateCostCents）
             → 报告分段解析（report-section.parser）→ 渲染（PDF / 分享卡，pdf-lib + @napi-rs/canvas + OFL 中文字体）
```

关键约束：**AI 输出必须落库**；星盘解读按 `chartHash` 缓存，同一份盘不重复烧钱；
`AI_DAILY_COST_BUDGET_CENTS` / 熔断器 / 重试都在配置里。

**已知缺口**：`LlmProvider` 只暴露 `complete()`，**对话 SSE 不是真流式**（生成完再切片，首字延迟 = 完整生成耗时）。

### 4.7 小程序架构

- **主包只放 4 页**（首页 / 报告列表 / 我的 / 测试介绍），重页面全部进分包：
  `pkgTest` `pkgReport` `pkgMatch` `pkgChat` `pkgMember` `pkgZodiac`(9 页) `pkgWebview`。
  改动分包要在 `pages.json` 注册，否则 `navigateTo` **静默失败**（有单测守着）。
- **请求层**：`api/request.ts` 自研（ADR-006）—— 注入令牌 / 解包 / 401 单飞续期 /
  续期失败静默重登重放 / GET 幂等重试 / 取消 / loading 引用计数。
- **导航**：一律用 `utils/safe-navigate.ts`（锁 + 失败 toast + 日志）。
  起因：`uni.navigateTo` 不带回调会返回 Promise，失败被吞成"未处理的 Promise 拒绝"。
- **两套配色**：全局 `tokens.scss`（浅色产品化）+ `arcana-theme.scss`（塔罗深色沉浸）。
  **不要把塔罗深色混进全局**，反之亦然。

### 4.8 管理后台架构（现状）

Vue3 + Element Plus + ECharts，路由表 `router/asyncRoutes.ts`。
**后端 38 条管理接口已可用，前端落地页只有 dashboard / login / error 三个真实页面**，
另有 **8 条业务路由**全部渲染 `ModulePlaceholder`（"模块建设中"）：
用户管理、题库管理、Prompt 管理、报告管理、订单管理、AI 统计、审计日志、系统设置。
这是最大的一块未完成工作（路由表与权限点已写好，只差页面）。

---

## 5. 前置环境（新电脑要装什么）

### 5.1 必须安装

| 软件           | 版本                             | 备注                        |
| -------------- | -------------------------------- | --------------------------- |
| Node.js        | **≥22.12**（实测 v24.15.0 全绿） | uni-app 工具链要求          |
| pnpm           | **10.33.2**（≥9 均可）           | `npm i -g pnpm@10.33.2`     |
| Docker Desktop | 任意近期版本                     | 跑 Postgres 16 + Redis 7    |
| 微信开发者工具 | 最新稳定版                       | AppID：`wxa5ab8f08bc05ecc1` |

### 5.2 端口

| 服务                      | 地址                                                         | 来源                   |
| ------------------------- | ------------------------------------------------------------ | ---------------------- |
| API                       | `http://127.0.0.1:3000/api/v1`（前缀）                       | `PORT`                 |
| 健康检查                  | `/health/live` `/health/ready` `/health/version`（不带前缀） |                        |
| Swagger                   | `http://127.0.0.1:3000/api/v1/docs`                          | `SWAGGER_ENABLED=true` |
| PostgreSQL                | `127.0.0.1:5452`（容器默认 5432）                            | `POSTGRES_PORT`        |
| Redis                     | `127.0.0.1:6391`（容器默认 6379）                            | `REDIS_PORT`           |
| Adminer / Redis Commander | `:8080` / `:8081`                                            |                        |
| 管理后台 dev              | `http://127.0.0.1:5174`                                      | vite.config 固定       |

### 5.3 环境变量（`.env.example` 共 75 项，开发环境只有 2 项必填）

```powershell
copy .env.example .env
copy .env.example backend\.env        # 后端优先读 backend/.env
```

**必填（不填进程直接退出，见 `config/validation.schema.ts`）**：

| 变量               | 要求                                      |
| ------------------ | ----------------------------------------- |
| `JWT_SECRET`       | ≥ 32 字符                                 |
| `ADMIN_JWT_SECRET` | ≥ 32 字符，**且应当与 `JWT_SECRET` 不同** |

> ⚠ 代码目前**只强制校验长度**；"必须不同"只写在错误文案里，**没有真正比较两者** ——
> 也就是说设成一样也能启动，但用户令牌与管理令牌就共用了同一把签名密钥（等于越权风险）。
> 这属于**已知小缺口**，修它要动校验逻辑并补单测。

```powershell
node -e "const c=require('crypto');console.log('JWT_SECRET='+c.randomBytes(32).toString('hex'));console.log('ADMIN_JWT_SECRET='+c.randomBytes(32).toString('hex'))"
```

**按需填（不填只影响对应功能）**：`DEEPSEEK_API_KEY`（AI 全线）、`WECHAT_APPID/SECRET`（真实登录）、
`CRYPTO_KEY`/`CRYPTO_IV_SALT`（字段加密）、`OSS_*`（上传）、`WECHAT_PAY_*`（支付）。
生产环境（`NODE_ENV=production`）**强制**要求微信/OSS/支付密钥，且禁止占位值。

### 5.4 初始化顺序（照这个顺序，别跳）

```powershell
pnpm install            # 依赖
pnpm infra:up           # postgres + redis
pnpm db:generate        # Prisma Client（第一次必须）
pnpm db:deploy          # 应用 16 个迁移（恢复环境用它，不是 db:migrate）
pnpm db:seed            # 系统配置/题库/套餐/Prompt/塔罗牌阵/合规声明（幂等）
pnpm dev:server         # 起 API
# 另开一个窗口：
pnpm build:server; pnpm --filter @soulmap/server start:worker   # 异步任务
```

**验收**：`Invoke-WebRequest http://127.0.0.1:3000/health/ready` 返回 200，
且 body 里 `database` 与 `redis` 都是 `up`。

更多排障见 `docs/QUICKSTART.md`。

---

## 6. 命令速查

### 6.1 五道门禁（每次交付必须全过）

```powershell
cd D:\Projects\mbit\backend
pnpm exec tsc --noEmit              # 1 类型
pnpm exec eslint src --max-warnings 0   # 2 静态检查（0 警告容忍）
pnpm exec jest --runInBand          # 3 后端单测
cd D:\Projects\mbit
pnpm exec prettier --check .        # 4 全仓格式
# 5 真实启动 → /health/ready 必须 200
```

前端两道（改小程序/后台时必须补）：

```powershell
cd frontend\miniapp; pnpm exec vue-tsc --noEmit; pnpm exec vitest run; pnpm build:mp-weixin
cd frontend\admin;   pnpm exec vue-tsc --noEmit; pnpm exec vitest run
```

### 6.2 其它常用

| 命令                                                  | 作用                                  |
| ----------------------------------------------------- | ------------------------------------- |
| `pnpm dev:server` / `dev:miniapp` / `dev:admin`       | 三端开发模式                          |
| `pnpm build:server` / `build:miniapp` / `build:admin` | 三端构建                              |
| `pnpm db:studio`                                      | Prisma Studio 看数据                  |
| `pnpm db:reset`                                       | **清库重建**（会删数据卷）            |
| `pnpm format` / `pnpm typecheck` / `pnpm lint`        | 格式化 / 全仓类型 / 全仓 lint         |
| `pnpm api:types`                                      | 由后端 OpenAPI 生成前端类型           |
| `node scripts/generate-error-code-doc.mjs`            | **改错误码后必须跑**（CI 校验一致性） |
| `.runlogs\probe-*.cjs`                                | 端到端探针（自建临时用户、结束删除）  |

---

## 7. 当前进度（这一节是交接的核心）

### 7.1 已完成的域（16 个后端模块）

| 域              | 规模（非测试行数）    | 做了什么                                                                                                                                                                                                             |
| --------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`         | 24,974 行 / 14 控制器 | 后台接口全家桶：用户、订单、退款、报告、Prompt、题库、RBAC、审计日志、AI 成本、看板                                                                                                                                  |
| `ai`            | 15,095 行             | 报告生成（分段+进度+重生成）、渲染（PDF/分享卡）、导出、AI 管家对话、用量与成本、Provider 工厂                                                                                                                       |
| `zodiac`        | 7,573 行              | 星座运势（日/周/月/年）、**自研天文算法**星盘+上升星座、星盘 AI 解读（缓存+三种解锁）、今日分数、**3,167 条**中国城市表（355 地级 + 2,812 县级，覆盖 31 个省级行政区；港澳台与海外手工维护），前端是省/市/县三列转盘 |
| `payment`       | 4,947 行              | 下单（幂等）/ 支付回调 / 退款 / 订单超时关单（worker）/ 微信支付 V3 签名                                                                                                                                             |
| `relationship`  | 3,968 行              | 情侣合盘：邀请、配对、合盘报告、小程序码邀请                                                                                                                                                                         |
| `personality`   | 2,720 行              | MBTI + 大五评分引擎、维度画像、报告视图                                                                                                                                                                              |
| `user`          | 2,790 行              | 资料、性别/生日、手机号、注销（宽限期）、数据导出                                                                                                                                                                    |
| `test`          | 2,737 行              | 通用答题链路：试卷快照、答案校验、模块评分、提交幂等                                                                                                                                                                 |
| `system`        | 1,951 行              | 系统配置目录（含各模块免责声明）、协议正文 URL                                                                                                                                                                       |
| `storage`       | 1,443 行              | OSS 直传签名、回调验签（原始 body）、文件策略                                                                                                                                                                        |
| `notification`  | 1,329 行              | 微信订阅消息模板与发送                                                                                                                                                                                               |
| `auth`          | 1,264 行              | 微信静默登录、令牌签发/刷新（单飞、复用检测）                                                                                                                                                                        |
| `mental-health` | 1,059 行              | 心理测评引擎 + 报告 + 危机兜底                                                                                                                                                                                       |
| `membership`    | 1,036 行              | 套餐、权益矩阵、会员状态                                                                                                                                                                                             |
| `tarot`         | 986 行                | 78 张牌（22 大牌 + 56 小牌）、5 种牌阵、今日单张、组合解读、确定性种子                                                                                                                                               |
| `emotion`       | 933 行                | 情感测评（ADR-039：24 幕沉浸式场景题 + 按性别出题）                                                                                                                                                                  |

**小程序（22 页）**：首页、报告列表/详情、我的、测试介绍/答题/结果、情侣邀请/结果、
AI 管家、会员、星座 9 页（运势/星盘/解读/分数/今日分数/匹配/星座）、协议/隐私。

**管理后台**：后端 38 条接口可用；前端只有 3 个真实页面（见 §7.3）。

### 7.2 规模与质量（实测，非估算）

| 指标         | 数值                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端 TS 文件 | 459（其中 138 个 `.spec.ts`）                                                                                                                                   |
| 后端源码行数 | 117,313 行                                                                                                                                                      |
| 后端测试     | **3,378 通过 / 144 套件**，3 个快照                                                                                                                             |
| 小程序测试   | **315 通过 / 23 文件**                                                                                                                                          |
| 管理后台测试 | **63 通过 / 5 文件**                                                                                                                                            |
| 接口         | **142 个方法级路由 / 125 条路径**（其中 38 条管理端）                                                                                                           |
| 数据模型     | 49 model / 49 enum / 16 迁移                                                                                                                                    |
| 文档         | 9 份，合计约 2.2 MB                                                                                                                                             |
| ADR          | 架构文档记录到 **ADR-039**；ADR-040（星盘/上升）、ADR-041（星盘解读）分别记在 `CONTRACT_DRIFT_AUDIT.md` §30 与 `DATABASE_DESIGN.md`；塔罗为内容模块，无独立 ADR |

### 7.3 未完成项（逐条对代码复核过，别照抄旧表）

| 项                                  | 现状                                                                                                                                               | 影响                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 🔴 **管理后台前端页面**             | `views/` 只有 dashboard / login / error + `ModulePlaceholder`；**8 条业务路由**（用户/题库/Prompt/报告/订单/AI 统计/审计日志/系统设置）全是占位    | 后台**不能用**，虽然接口齐                           |
| 🔴 **`memberships` 表无支付写入方** | 支付履约只写 `entitlements`（`payment.service.ts` 内 `tx.entitlement.create`），**没有** `membership.create/upsert`。仅管理端授权与退款会 `update` | 买完会员：付费墙侧是会员，「我的」页/AI 套餐名侧不是 |
| **对话 SSE 不是真流式**             | `LlmProvider` 只有 `complete()`，增量是生成完再切片                                                                                                | 首字延迟 = 完整生成耗时                              |
| **支付未接通**                      | 代码齐、`FEATURE_PAYMENT=true`，但 `WECHAT_PAY_*` 为空                                                                                             | 不能真实下单                                         |
| **OSS 未配置**                      | 上传链路齐，密钥空                                                                                                                                 | 头像/图片上传不可用                                  |
| **PDF `includeAnswers`**            | 渲染已实现，答案数据通路未打通（PDF 里会显式印提示）                                                                                               | 报告 PDF 少了答题明细                                |
| **契约错误码覆盖**                  | 约 60 个错误码只在契约里、代码未用                                                                                                                 | 契约与实现仍有差集                                   |
| **e2e / 后台前端测试**              | 后端单测厚，但无真 e2e；后台前端 0 占位页测试                                                                                                      | 回归靠单测                                           |

### 7.4 上线阻塞（外部依赖，不是代码问题）

1. **小程序类目未确认**（占卜/心理类内容）→ 卡上架。
2. 微信支付 `mchid` / 序列号 / APIv3 密钥为空。
3. OSS AccessKey 为空。
4. 退款回调地址未配置。
5. 待轮换的密钥：DeepSeek Key、微信 AppSecret。

### 7.5 最近一轮（塔罗）的已知遗留

塔罗三页已重构完成（设计系统 + 真插画投放管线 + 牌阵布局），但**有一个已定位未修的体验缺陷**：

> **抽卡页的 `loading` 状态与逐张翻牌动画耦合**：`loading` 直到翻牌循环结束才关闭，
> 七日牌阵要 360 + 6×220 = **1,680 ms** 期间页面只显示"正在洗牌…"，而且牌会一次性全出、
> 逐张动画根本没被看见。另外抽卡页先请求牌阵列表、再请求抽卡，两次往返可合并成一次
> （`/tarot/spreads/:id/draw` 的响应补个 `layout` 字段即可）。
> 后端不是瓶颈（实测 `/tarot/spreads` 2 ms、`/tarot/spreads/WEEK/draw` 7 ms）。

---

## 8. 铁律与踩坑（违反会被要求返工）

### 8.1 流程规则

1. **先设计再编码**：改冻结项（架构 / 数据模型 / API 契约）**先写 ADR + 修订文档，再改代码**。
2. 每个模块完成必须过门禁，**四道全绿也不算完**，必须真实启动一次（§6.1 第 5 道）。
3. 单模块 ≤ 800 行为宜，不要一次生成一大坨。
4. **不要新增 npm 依赖**；能力缺库就把那一步抽成可替换单点并**如实报告缺口**，
   **禁止伪造一个能返回假文件的实现**。
5. `error-code.ts` 是错误码唯一权威，改了必须重新生成 `docs/ERROR_CODES.md`。
6. `schema.prisma` 由设计文档生成，改表要同时改文档。
7. **可证明错误的代码要删除**，不是标注弃用。

### 8.2 编码约定

- **注释写中文，解释"为什么"，不写"做了什么"** —— 这是本项目最鲜明的风格。
- 所有接口必须有完整 Swagger 装饰器（summary + 分段 description + 契约里的错误码）。
- 分页统一 `{ items, total, page, pageSize, hasNext }`。
- **NestJS `@Post()` 默认返回 201**，契约要 200 必须显式 `@HttpCode(HttpStatus.OK)`。
- 金额整数分，只从服务端读。
- 敏感字段（手机号 / openid / 报告正文 / 对话原文）对外必须脱敏，统一用 `common/utils/mask.util.ts`。
- AI 输出必须落库并记用量成本。

### 8.3 踩过的坑（高价值节选）

| 坑                        | 表现                                                 | 根因                                                          |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| 模块循环依赖              | **整个后端起不来**，但 tsc/eslint/jest/prettier 全绿 | 单测直接 `new` 服务，绕过 DI 容器 → 只有真实 bootstrap 才暴露 |
| 管理端接口裸奔            | 接口完全公开                                         | 误用 `@AdminPublic()` 而不是 `@Public()`                      |
| 路由静默不存在            | 404，编译无警告                                      | 控制器没装配进 module                                         |
| 异步任务永远不完成        | 接口 202，任务停排队                                 | `worker` 进程没起                                             |
| 查询串布尔被静默取反      | `?x=false` 被当成 true                               | 自研 query parser，已修一部分                                 |
| 星盘上升点是下降点        | 方位提前 180°                                        | 自研天文算法里 atan2 两个分量同时取反                         |
| 城市名解析与坐标不一致    | 同一人两次排盘上升差 12°                             | 城市表存的是标准时区，漏了 1986–1991 中国夏令时               |
| 答题页静默漏答            | 少答也能提交                                         | 自动跳题逻辑吞掉了未作答状态                                  |
| `uni.navigateTo` 失败被吞 | "未处理的 Promise 拒绝"                              | 不带回调时返回 Promise，失败无人 catch                        |
| 时间炸弹测试              | 某天突然全红                                         | 用例里硬编码了会过期的日期                                    |

---

## 9. 常见任务怎么入手（给 AI 的行动指南）

| 任务                            | 步骤                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **加一个接口**                  | DTO（class-validator）→ service → controller（Swagger 装饰器齐）→ 装配进 module → 写 spec → 跑门禁 → 若动契约先改 `docs/API_DESIGN.md`          |
| **加一个测评模块**              | 参考 `emotion`：`engine/`（纯函数 + spec）→ `*.service.ts` → `dto/` → 题库进 `prisma/seed/data/` → `test-definitions` 注册 → 小程序进 `pkgTest` |
| **改数据库**                    | 先改 `docs/DATABASE_DESIGN.md` → `node scripts/extract-prisma-schema.mjs` → `pnpm db:migrate`（新迁移）→ 若要兼容逐步上线则手写迁移             |
| **加一个小程序页面**            | 建 `src/pkgXxx/pages/*.vue` → **在 `src/pages.json` 注册** → 用 `safeNavigate` 跳转 → 跑 `vue-tsc` + `vitest` + `build:mp-weixin`               |
| **排查"接口 200 但页面没数据"** | 看包络 `code`；看小程序 `api/request.ts` 的解包；看分包是否注册；看是否 401 被静默重放                                                          |
| **排查"全是 401"**              | 先确认 `JWT_SECRET` 一致；再确认公开接口有没有 `@Public()`；小程序冷启动有静默登录竞态                                                          |
| **排查"任务卡住"**              | `start:worker` 是否在跑；Redis 是否通                                                                                                           |
| **想快速确认环境没坏**          | 跑 `backend/.runlogs/probe-*.cjs`（会自建临时用户并删除）                                                                                       |

**工作方式建议**：每一步交付都给出"已验证 / 未验证"的边界。
编译、类型、测试、产物配置属于可验证；**视觉效果与真机行为属于未验证**，不要替用户下结论。

---

## 10. 如何复核本文档的数字

```powershell
# 测试规模
cd backend; pnpm exec jest --runInBand | Select-String 'Tests:|Test Suites:'
cd ..\frontend\miniapp; pnpm exec vitest run | Select-String 'Tests '
cd ..\admin; pnpm exec vitest run | Select-String 'Tests '

# 接口数量（需服务已启动）
(Invoke-WebRequest http://127.0.0.1:3000/api/v1/docs-json -UseBasicParsing).Content |
  ConvertFrom-Json | Select-Object -ExpandProperty paths | Get-Member -MemberType NoteProperty |
  Measure-Object

# 数据模型
Select-String -Path backend\prisma\schema.prisma -Pattern '^model ' | Measure-Object

# 模块清单
Get-ChildItem backend\src\modules -Directory | Select-Object -ExpandProperty Name
```

**如果数字对不上，以命令输出为准，并顺手更新本文档。**

---

## 11. 文档地图（深水区，按需查）

| 文档                           | 体量     | 什么时候看                                                     |
| ------------------------------ | -------- | -------------------------------------------------------------- |
| `docs/PROJECT_ARCHITECTURE.md` | 169 KB   | 技术选型理由、模块边界、**ADR 表（ADR-001~039）**、目录设计    |
| `docs/DATABASE_DESIGN.md`      | 536 KB   | 表结构、字段、索引、状态机 —— **schema 的事实源**              |
| `docs/API_DESIGN.md`           | 1,054 KB | 125 条接口的权威契约（参数、错误码、幂等要求）                 |
| `docs/ERROR_CODES.md`          | 14 KB    | 错误码全集（由源码生成，勿手改）                               |
| `docs/HANDOVER.md`             | 158 KB   | **逐轮开发日志 + 缺陷清单 + 踩坑实录**，遇到"为什么这么做"来查 |
| `docs/CONTRACT_DRIFT_AUDIT.md` | 203 KB   | 契约与实现的漂移审计（含 §30 星盘天文缺陷复盘）                |
| `docs/QUICKSTART.md`           | 9 KB     | 环境搭建与排障（本文件 §5 的详版）                             |
| `docs/TAROT_ART_SPEC.md`       | 19 KB    | 塔罗插画规范（尺寸、风格、命名、投放）                         |

> 读的顺序建议：**本文件 → QUICKSTART → PROJECT_ARCHITECTURE 的目录与 ADR 表 → 动手**。
> `HANDOVER.md` 当字典用，不要从头读（158 KB 里大半是历史轮次）。

---

## 12. 建议的下一步（按优先级）

1. **修抽卡页体验缺陷**（§7.5）：`loading` 与翻牌解耦 + 合并两个请求。工作量小、收益直接。
2. **管理后台前端开工**（最大价值缺口）：接口全齐，把 17 条占位路由逐个接上真实页面。
3. **`memberships` 写入方补齐**：支付履约同时写 `entitlements` 与 `memberships`，
   需要先决策历史会员怎么补。**这属于数据模型行为变更，先写 ADR。**
4. **真实流式**：`LlmProvider` 加 `stream()`，AI 管家首字延迟立降。属接口变更，先写 ADR。
5. **上线准备**：小程序类目、支付密钥、OSS、域名与 HTTPS、监控告警。
6. **补 e2e**：现在只有单测，关键链路（下单→履约→解锁）没有端到端保护。

---

## 13. 接手第一天 checklist

- [ ] 装 Node ≥22.12 / pnpm 10.33.2 / Docker
- [ ] `pnpm install` → `pnpm infra:up`
- [ ] 写 `.env` 与 `backend/.env`，填两个 JWT 密钥
- [ ] `pnpm db:generate && pnpm db:deploy && pnpm db:seed`
- [ ] `pnpm dev:server`，`/health/ready` 返回 200 且 database/redis 都 up
- [ ] 跑五道门禁，确认与本文 §7.2 的数字一致（3,378 / 315 / 63）
- [ ] 起 `worker`（否则异步任务会静默卡住）
- [ ] 微信开发者工具导入 `frontend/miniapp/dist/build/mp-weixin`，勾"不校验合法域名"
- [ ] 打开 Swagger 看接口，随手试一个公开接口
- [ ] 读 `docs/HANDOVER.md` 的 §5（铁律）与 §6（踩坑）
- [ ] 挑一个 §12 的任务开工，**动契约前先写 ADR**
