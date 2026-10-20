# 快速启动（QUICKSTART）

从零把项目跑起来的最短路径。适用于**新机器**或**重装系统后恢复环境**。

打包版本信息：Git 提交 `635c61f`，打包时间 2026-10-19。

---

## 一、前置软件

| 软件           | 版本                                 | 安装                                                 |
| -------------- | ------------------------------------ | ---------------------------------------------------- |
| Node.js        | **≥ 22.12**（本机实测 **v24.15.0**） | uni-app 工具链要求 ≥ 22.12；后端单独要求 20 LTS 即可 |
| pnpm           | **10.33.2**（≥ 9 均可）              | `npm i -g pnpm@10.33.2`                              |
| Docker Desktop | 任意近期版本                         | 用来起 Postgres 与 Redis                             |
| 微信开发者工具 | 最新稳定版                           | 小程序调试                                           |

> **Node 版本矩阵（容易踩的一条）**：CI 里后端跑 Node 20、前端跑 Node 22
> （`.github/workflows/ci.yml`），而仓库根的 `.nvmrc` 写的是 `20.19.0`（面向后端）。
> 用 nvm 时，**只做小程序/管理后台要切到 ≥ 22.12**，否则 uni-app 构建会直接报错；
> 用 Node 24（本机现状）可同时满足两端。

---

## 二、拉代码

```powershell
git clone git@github.com:wenshuyunb/mbit.git D:\Projects\mbit
cd D:\Projects\mbit
```

> 若本机 SSH 配置里给 GitHub 起了别名（例如 `github-mbit`），远端地址可能显示为
> `git@github-mbit:wenshuyunb/mbit.git`，两者等价。

**如果用完整离线包（zip）恢复**：包顶层文件夹已命名为 `mbit`，请解压到 `D:\Projects\`，
得到 `D:\Projects\mbit`。这样 `.npmrc` 里的 `store-dir=D:/Projects/mbit/.pnpm-store`
（绝对路径）才与新位置一致；放到别处则需改那一行。

---

## 三、装依赖

```powershell
pnpm install
```

- **离线包**：自带 `.pnpm-store`，**无需联网**。
  实测（打包时验证过）：`pnpm install --offline --frozen-lockfile`
  → `resolved 1615, reused 1600, downloaded 0`，耗时约 2 分 40 秒。
- **纯 clone**：联网安装；若新机器是 macOS / Linux，原生二进制会自动重新下载。

---

## 四、起数据库与缓存

```powershell
pnpm infra:up
```

启动 `soulmap-postgres`（postgres:16-alpine）与 `soulmap-redis`（redis:7-alpine）。

端口由 `POSTGRES_PORT` / `REDIS_PORT` 决定，docker compose 会读取根目录 `.env`。
`.env.example` 用的是默认 `5432` 与 `6379`。
**如果本机 5432 已被占用**，就把 `.env` 里的 `POSTGRES_PORT` 和 `DATABASE_URL` 里的端口
**一起**改（例如 5452），两处必须一致。

---

## 五、配置环境变量

```powershell
copy .env.example .env
copy .env.example backend\.env
```

### 开发环境只有两项必填

不填进程会**直接启动失败**（这是刻意设计，见 `backend/src/config/validation.schema.ts`）：

| 变量               | 要求                                      |
| ------------------ | ----------------------------------------- |
| `JWT_SECRET`       | **≥ 32 字符**                             |
| `ADMIN_JWT_SECRET` | **≥ 32 字符，且必须与 `JWT_SECRET` 不同** |

生成两个随机密钥：

```powershell
node -e "const c=require('crypto');console.log('JWT_SECRET='+c.randomBytes(32).toString('hex'));console.log('ADMIN_JWT_SECRET='+c.randomBytes(32).toString('hex'))"
```

### 其余变量按需填写

| 变量                             | 不填的后果                                |
| -------------------------------- | ----------------------------------------- |
| `DEEPSEEK_API_KEY`               | AI 解读 / 星盘解读 / 报告生成不可用       |
| `WECHAT_APPID` / `WECHAT_SECRET` | 小程序无法真实登录（本地调试可先用 mock） |
| `CRYPTO_KEY` / `CRYPTO_IV_SALT`  | 敏感字段加密不可用，仅生产环境强制要求    |
| `OSS_*`                          | 图片上传不可用                            |
| `WECHAT_PAY_*`                   | 支付未接入（当前项目也未做支付）          |

> 生产环境（`NODE_ENV=production`）会**强制**要求微信、OSS、支付密钥，
> 且禁止使用 `CHANGE_ME` / `dev_only` 这类占位值。

---

## 六、建表 + 灌种子数据

```powershell
pnpm db:generate     # 生成 Prisma Client（第一次必须执行）
pnpm db:deploy       # 应用已有迁移建表（当前 16 个）
pnpm db:seed         # 灌入系统配置、测评题库/方案、会员套餐、塔罗牌阵与合规声明
```

> 改了 `schema.prisma` 要新写迁移时用 `pnpm db:migrate`（= `prisma migrate dev`）；
> **恢复已有环境请用 `db:deploy`**，它只应用已提交的迁移，不会要求交互式输入迁移名。
> 想清空重来用 `pnpm db:reset`（**会删库**）。

---

## 七、起服务端

```powershell
pnpm dev:server
```

或生产方式：

```powershell
pnpm build:server
node backend\dist\main.js
```

**验收**：浏览器打开 <http://127.0.0.1:3000/health/ready>，返回 200 即正常。

AI 报告 / 异步任务需要**另外起一个进程**（它跑的是 `dist/worker.js`，需先 build）：

```powershell
pnpm build:server
pnpm --filter @soulmap/server start:worker
```

---

## 八、小程序

### A. 直接用编译好的产物（最快）

微信开发者工具 → 导入项目 → 目录选：

```
D:\Projects\mbit\frontend\miniapp\dist\build\mp-weixin
```

AppID：`wxa5ab8f08bc05ecc1`

本地联调要在「详情 → 本地设置」勾选 **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**，
否则请求 `127.0.0.1` 会被拦。

### B. 从源码编译

```powershell
pnpm dev:miniapp
```

产物在 `frontend/miniapp/dist/dev/mp-weixin`（**dev 与 build 是两个目录**，别导入错）。

> ⚠ `dev:mp-weixin` 与 `build:mp-weixin` **不要同时运行**，两者会互相覆盖产物。

---

## 九、管理后台（可选）

```powershell
pnpm dev:admin
```

默认 <http://127.0.0.1:5174>（`vite.config.ts` 里固定了 `host: 127.0.0.1`、`port: 5174`）。

---

## 十、端口一览

| 服务                        | 地址                                      | 来源                   |
| --------------------------- | ----------------------------------------- | ---------------------- |
| API                         | <http://127.0.0.1:3000>（前缀 `/api/v1`） | `.env` 的 `PORT`       |
| 健康检查                    | <http://127.0.0.1:3000/health/ready>      |                        |
| PostgreSQL                  | `127.0.0.1:5432`（本项目开发机用 5452）   | `POSTGRES_PORT`        |
| Redis                       | `127.0.0.1:6379`（本项目开发机用 6391）   | `REDIS_PORT`           |
| Adminer（数据库网页客户端） | <http://127.0.0.1:8080>                   | `ADMINER_PORT`         |
| Redis Commander             | <http://127.0.0.1:8081>                   | `REDIS_COMMANDER_PORT` |
| 管理后台（开发）            | <http://127.0.0.1:5174>                   | Vite                   |

---

## 十一、常见问题

| 现象                                                     | 原因与处理                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm install` 报找不到 store / ENOENT                   | 项目不在 `D:\Projects\mbit`，或 `.npmrc` 的 `store-dir` 与本地 store 对不上              |
| 服务启动即退出，日志提示 `JWT_SECRET 长度必须 ≥ 32 字符` | 补 `JWT_SECRET` / `ADMIN_JWT_SECRET`，且两者不能相同                                     |
| 连不上数据库                                             | `pnpm infra:up` 是否成功；`DATABASE_URL` 端口与 `POSTGRES_PORT` 是否一致                 |
| 小程序请求全部 401                                       | 后端没起；或没勾「不校验合法域名」；首次启动会自动静默登录，等两秒再操作                 |
| 小程序白屏                                               | 导入的是 `dist/dev` 但从未编译过；重新 `pnpm dev:miniapp`，或改用 `dist/build/mp-weixin` |
| 想重置数据库                                             | `pnpm infra:reset`（**会删数据卷**），再跑第六步                                         |
| 代码质量门禁                                             | `pnpm typecheck` / `pnpm lint` / `pnpm format:check`                                     |

---

## 十二、环境自检（可选，需后端已启动）

`backend/.runlogs/` 下有端到端探针，逐项打印 ✅ / ❌：

```powershell
node backend\.runlogs\probe-tarot.cjs
node backend\.runlogs\probe-zodiac-chart.cjs
node backend\.runlogs\probe-tarot-perf.cjs
```

> 探针会在数据库里**创建临时用户并在结束时删除**，不污染业务数据。
> 这些脚本不入库（见 `.gitignore` 的 `.runlogs/`），换机器后需要重新生成或忽略。
