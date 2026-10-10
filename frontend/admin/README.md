# SoulMap AI Web 管理后台（`@soulmap/admin`）

> Phase 0 工程脚手架：Vue 3 + Vite 5 + TypeScript（strict）+ Element Plus + Pinia + Vue Router 4。
> 架构基准：[`docs/PROJECT_ARCHITECTURE.md`](../../docs/PROJECT_ARCHITECTURE.md)（已冻结）、
> 接口契约：[`docs/API_DESIGN.md`](../../docs/API_DESIGN.md)。

---

## 1. 模块职责

管理后台是**运营/内容/财务/分析人员**的操作入口，与小程序端完全隔离：

| 职责          | 说明                                                       | 对应阶段                             |
| ------------- | ---------------------------------------------------------- | ------------------------------------ |
| 数据看板      | 北极星指标、测试完成率、AI 成本与成功率                    | Phase 7（页面骨架已在 Phase 0 提供） |
| 用户管理      | 用户资料查看、封禁/解封、注销申请处理（脱敏展示）          | Phase 1                              |
| 内容管理      | 题库（`test:question:*`）、测试定义、Prompt 模板与版本发布 | Phase 2 / Phase 3                    |
| 报告与订单    | 报告生成记录、失败重试、订单查询、对账与退款（敏感操作）   | Phase 3 / Phase 6                    |
| AI 统计与审计 | 调用量/Token/成本、Provider 成功率、管理员操作审计日志     | Phase 7                              |
| 系统设置      | 系统配置（含 AI 内容免责声明文案）、管理员与角色权限       | Phase 7                              |

**边界（不可越界）**：管理端**不**直接持有任何密钥；
管理端鉴权使用独立 realm 与独立密钥（架构 §9.2 / ADR-012），
用户 token 不能访问 `/api/v1/admin/**`，反之亦然。

---

## 2. 技术栈与版本锁定

依赖版本在 `package.json` 中**精确锁定**（非 `^` 范围），禁止随意升级：

| 分类      | 组件                                                                      | 版本         |
| --------- | ------------------------------------------------------------------------- | ------------ |
| 运行时    | Vue                                                                       | 3.5.43       |
| 路由/状态 | Vue Router 4.6.4 / Pinia 2.3.1                                            | —            |
| UI        | Element Plus 2.14.7 + `@element-plus/icons-vue` 2.3.2                     | —            |
| 图表      | ECharts 5.6.0（自研封装 `components/EChart.vue`，**不使用** vue-echarts） | —            |
| 请求/时间 | axios 1.20.0 / dayjs 1.11.13                                              | —            |
| 构建/测试 | Vite 5.4.21 / Vitest 2.1.9 / vue-tsc 2.2.0 / TypeScript 5.9.3             | jsdom 25.0.1 |

**依赖约束**（Phase 0 决策）：

- 不引入 ESLint 相关依赖 —— 代码规范由仓库根统一管理，子包 `lint` 脚本等价于类型检查（`vue-tsc --noEmit`）。
- 不引入 `unplugin-auto-import` / `unplugin-vue-components` / `pinia-plugin-persistedstate` / `vue-echarts`：
  Element Plus 采用**全量引入**，持久化用自研插件（`src/store/index.ts`），图表用自研封装。

---

## 3. 目录结构

```
frontend/admin/
├── src/
│   ├── api/            # 请求层：client(拦截器) / types(包络与 ApiError) / auth(管理员认证)
│   ├── components/     # 通用组件：EChart / PageHeader / EmptyState
│   ├── constants/      # 错误码子集、角色码、权限点、平台标识
│   ├── layouts/        # 布局：DefaultLayout（侧边栏+顶栏）/ BlankLayout（登录页）
│   ├── router/         # 路由：静态路由 + 动态权限路由 + 导航守卫
│   ├── store/          # Pinia：index(实例+持久化插件) / auth / app
│   ├── styles/         # 设计令牌 variables.scss、reset.scss、全局入口 index.scss
│   ├── types/          # api.d.ts（手写基础类型，后续由 openapi.d.ts 覆盖）
│   ├── utils/          # storage / request-id / format / permission（均为纯函数）
│   ├── views/          # 页面：login / dashboard / error(404) / placeholder
│   ├── App.vue         # 根组件（仅 <router-view />）
│   ├── env.d.ts        # *.vue 与 import.meta.env 类型声明
│   └── main.ts         # 入口：Pinia → Router → Element Plus → 钩子注册 → mount
├── tests/              # Vitest 用例 + setup.ts（jsdom 补丁）
├── index.html
├── vite.config.ts / vitest.config.ts
├── tsconfig.json / tsconfig.node.json
└── .env.development / .env.production / .env.example
```

架构文档 §5.4 中的 `directives/`（`v-permission` 按钮级权限指令）与 `e2e/`（Playwright）
在 Phase 0 **未创建**：前者待 Phase 1 权限点下发后实现（当前权限判定已由 `utils/permission.ts` 提供纯函数），
后者按 §4.2/§5.4 在 Phase 7 引入（`pnpm test:e2e` 目前会以明确提示失败，避免出现「假绿」）。

---

## 4. 快速开始

> 依赖由 **pnpm workspace** 统一安装（`pnpm-workspace.yaml` 的 `frontend/*` 已匹配本包）。

```bash
# 在仓库根执行
pnpm install

# 启动管理后台（http://127.0.0.1:5174）
pnpm --filter @soulmap/admin dev

# 类型检查（等价于 lint）
pnpm --filter @soulmap/admin typecheck

# 单元测试
pnpm --filter @soulmap/admin test          # 单次
pnpm --filter @soulmap/admin test:watch    # 监听

# 生产构建（先类型检查，再打包到 dist/）
pnpm --filter @soulmap/admin build
pnpm --filter @soulmap/admin preview

# 由后端 OpenAPI 生成接口类型（需先导出 openapi.json）
pnpm --filter @soulmap/server openapi:export
pnpm --filter @soulmap/admin api:types
```

**开发期接口联调**：`vite.config.ts` 已配置 `/api` → `http://127.0.0.1:3000` 代理，
因此本地只需启动后端（`pnpm dev:server`）即可，前端不需要配置跨域。

---

## 5. 环境变量

`.env.example` 是唯一权威说明，当前仅两个变量（均**不含密钥**，架构 §16.3）：

| 变量                | 必填 | 说明                                                                                  |
| ------------------- | ---- | ------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | 是   | 接口基础地址，取值 `/api/v1`（开发走 Vite 代理、生产走 Nginx 反代）；缺省时回退默认值 |
| `VITE_APP_TITLE`    | 是   | 站点标题（浏览器标题、登录页品牌区）                                                  |

硬性约束：`VITE_*` 变量会被**打包进前端产物**，禁止存放任何密钥；
新增变量必须同步在 `src/env.d.ts` 中声明类型。

---

## 6. 与后端接口的关系

1. **统一前缀**：后端所有接口前缀 `/api/v1`，管理端接口全部位于 **`/api/v1/admin`**（API_DESIGN §2.1）。
   `api/auth.ts` 中只写相对路径（如 `/admin/auth/login`），由 `client.ts` 的 `baseURL` 拼接。
2. **统一响应包络**：`{ code, message, data, requestId, timestamp, details? }`（架构 §6.2）。
   `api/client.ts` 的响应拦截器会**解包**：`code === 0` 时返回 `data`，否则抛出 `ApiError`；
   非包络响应（文件流、网关兜底页）原样返回。
   > 注意：解包后 `http.get<T>()` 返回的就是业务数据 `T`，不是 `AxiosResponse`。
3. **请求头注入**：每个请求自动携带
   - `Authorization: Bearer <AdminAccessToken>`（内存中的令牌，见第 8 节）
   - `X-Request-Id`（客户端生成，格式与后端 `REQUEST_ID_PATTERN` 一致，用于全链路排障）
   - `X-Platform: admin`（后端据此校验 jwt realm 是否匹配，API_DESIGN §2.2）
4. **登录态失效**：HTTP 401 或认证类错误码（20001/20002/20003/20004/20005/20013）会触发
   未授权处理器 —— 清空内存登录态并跳转 `/login?redirect=...`（处理器由 `router/index.ts` 注册，
   避免 api ↔ router ↔ store 循环依赖）。**403 无权限（20009）不会踢出登录**。
5. **错误码**：`src/constants/error-code.ts` 是后端 `backend/src/common/errors/error-code.ts` 的**子集**，
   用于覆盖后端未返回 `message` 时的展示文案与「是否跳登录」判定。
   ⚠️ `docs/API_DESIGN.md` §2.4.2 的错误码表与后端实现目前**整体错位**，本包以 **backend 实现为准**（详见第 10 节）。
6. **类型来源**：架构 P10/ADR-007 要求「前后端契约由 OpenAPI 单向生成」。
   Phase 0 先用 `src/types/api.d.ts` 手写基础类型，后端 Swagger 产出 `openapi.json` 后
   执行 `api:types` 生成 `src/types/openapi.d.ts` 并逐步替换。

---

## 7. 权限模型（RBAC）

- 权限点命名 `<domain>:<resource>:<action>`（架构 §9.3，清单见 API_DESIGN §2.7.3），
  角色码：`SUPER_ADMIN` / `OPERATOR` / `CONTENT_EDITOR` / `FINANCE` / `ANALYST`。
- 判定函数集中在 `src/utils/permission.ts`（纯函数，无副作用）：
  - `hasRole` / `hasPermission` / `hasAllPermissions` / `hasAccess`
  - `matchesPermission`：支持段级通配（持有 `ai:prompt:*` 可满足 `ai:prompt:publish`）
  - `canAccess`：**界面门禁** —— 权限上下文未初始化时放行（Phase 0/1 后端尚未下发权限点），
    已初始化时严格按角色 + 权限判定。真正的鉴权始终在后端（`AdminAuthGuard` + `RolesGuard`）。
- 路由与菜单位于同一数据源（`router/asyncRoutes.ts`），因此「菜单可见 ⇔ 路由可入」始终一致。
- Phase 0 现状：动态路由由 `router/index.ts` **静态注册**以保证脚手架可浏览；
  Phase 1 改为登录后按权限 `router.addRoute(ROOT_ROUTE_NAME, route)` 注入，登出时移除。

---

## 8. 状态与持久化策略

| Store          | 职责                                                   | 持久化字段                      |
| -------------- | ------------------------------------------------------ | ------------------------------- |
| `useAuthStore` | 令牌（内存）、管理员信息、角色、权限点、登录/登出/刷新 | `admin`、`roles`、`permissions` |
| `useAppStore`  | 侧边栏折叠、主题（明亮/暗色）、面包屑开关              | `sidebarCollapsed`、`theme`     |

- **令牌（accessToken / refreshToken）永不落地**（架构 §9.2：管理员 Token 仅存内存），
  因此 F5 刷新后需要重新登录（Phase 1 可评估是否改用「内存 + 单飞刷新」以外的方案，见第 10 节）。
- 持久化由自研插件实现（`src/store/index.ts` 的 `persistPlugin`）：
  在 `PERSIST_CONFIG` 中集中登记「哪些 store 的哪些字段会写入 localStorage」，
  便于安全审计；存储层（命名空间、JSON、TTL、异常兜底）见 `src/utils/storage.ts`。

---

## 9. 测试

- 框架：Vitest 2.1.9 + jsdom 25.0.1；用例位于 `tests/**/*.spec.ts`，环境补丁见 `tests/setup.ts`。
- 用例文件（5 个，共 40+ 断言）：
  | 文件                             | 覆盖点                                                                                            |
  | -------------------------------- | ------------------------------------------------------------------------------------------------- |
  | `tests/utils/format.spec.ts`     | 金额分→元（0/最小单位/进位/大额/负数/非法输入）、手机号与 openid 脱敏、日期边界与无效输入         |
  | `tests/utils/storage.spec.ts`    | 命名空间隔离、JSON 往返、损坏数据容错、TTL 到期边界、后端异常不抛出                               |
  | `tests/api/client.spec.ts`       | 请求头注入、包络解包、业务错误码抛 `ApiError`、401 跳登录、403 不跳登录、`silent`、网络异常归一化 |
  | `tests/utils/permission.spec.ts` | SUPER_ADMIN 通配、空权限集、未知角色、段级通配、`canAccess` 门禁语义、权限点命名规范              |
  | `tests/utils/request-id.spec.ts` | 与后端一致的白名单格式、`crypto.randomUUID` 优先与降级、唯一性                                    |

---

## 10. 已知事项（Phase 0 待确认）

1. **错误码文档与后端实现错位**：`docs/API_DESIGN.md` §2.4.2（如「管理员账号或密码错误」记为 20013、
   「realm 不匹配」记为 20015）与 `backend/src/common/errors/error-code.ts`（20012 / 20013）不一致。
   本包按**后端实现**取值，建议由架构负责人统一两份文档后再进入 Phase 1。
2. **管理员令牌的存储位置**：架构 §9.2 规定管理员 AccessToken 仅存内存，因此刷新页面需重新登录。
   若希望「刷新保持登录」，需要在架构层确认（例如允许 RefreshToken 存 sessionStorage + 单飞续期）。
3. **admin 接口明细缺失**：`API_DESIGN.md` §3.15（admin 模块）尚未展开，`api/auth.ts` 中的路径按
   §3.15 索引与命名规范拟定，后端落地后需逐一核对。
4. **`openapi-typescript` 未在依赖表中**：`api:types` 脚本依赖该 CLI，但本包 `package.json` 按要求未声明依赖；
   当前会先校验 `openapi.json` 是否存在并给出明确报错。需确认它由根目录统一提供还是补入子包依赖。
5. **Sass 版本与 API**：`sass` 1.105.1 已弃用 Legacy JS API，Vite 5.4 默认仍走 Legacy，
   构建时可能出现 deprecation 警告（不影响产物）；如警告过多可切换 `css.preprocessorOptions.scss.api`。
6. **Element Plus 中文语言包类型**：`element-plus/es/locale/lang/zh-cn` 的类型解析在部分版本存在差异，
   若 `typecheck` 报「找不到声明文件」，可改为 `element-plus/dist/locale/zh-cn.mjs` 并补充模块声明。
7. **部署子路径**：生产 Nginx 将 SPA 挂在 `/admin/*`（架构 §17.1），需要 Vite `base` 与 Nginx `try_files` 配合。
   Phase 0 保持 `base: '/'`，路由已使用 `createWebHistory(import.meta.env.BASE_URL)`，届时只需调整构建配置。
8. **Phase 1 接入清单**：登录接口联调、401 单飞刷新、权限点下发后的动态路由注入、`v-permission` 指令、
   真实业务页面（用户/题库/Prompt/报告/订单/AI 统计/审计/设置）、403 无权限页。
