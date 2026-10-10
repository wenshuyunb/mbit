# SoulMap AI 微信小程序（`@soulmap/miniapp`）

基于 **uni-app + Vue3 + TypeScript** 的微信小程序端。所属项目的总体架构见
[`docs/PROJECT_ARCHITECTURE.md`](../../docs/PROJECT_ARCHITECTURE.md)，接口契约见
[`docs/API_DESIGN.md`](../../docs/API_DESIGN.md)。

---

## 1. 环境要求

| 项             | 要求          | 说明                                                           |
| -------------- | ------------- | -------------------------------------------------------------- |
| Node.js        | **≥ 22.12.0** | `@dcloudio/vite-plugin-uni` 的 engines 要求；本机 Node 24 亦可 |
| pnpm           | ≥ 9           | 仓库统一使用 pnpm workspace                                    |
| 微信开发者工具 | 最新稳定版    | 需开启「不校验合法域名」以便本地联调                           |

> **⚠ 后端与小程序对 Node 版本要求不同**：后端 Docker 镜像锁定 Node 20 LTS，
> 而小程序构建工具链要求 Node ≥ 22.12。二者互不影响（后端在容器内运行），
> CI 中分别使用对应版本。

---

## 2. 版本锁定说明（重要，勿随意升级）

| 包                | 锁定版本                       | 原因                                                                        |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `vite`            | **5.2.8**                      | `@dcloudio/vite-plugin-uni` 的 peerDependency 精确锁定该版本                |
| `vue`             | **3.4.21**                     | 必须与 uni-app 内置的 `@vue/compiler-sfc` 版本一致，否则 SFC 编译结果不确定 |
| `@dcloudio/*`     | `3.0.0-alpha-5030120260930001` | uni-app 的 Vue3 线版本（对应 registry 的 `vue3` dist-tag）                  |
| `@dcloudio/types` | 3.4.31                         | `@dcloudio/uni-app` 声明的 peer 版本                                        |
| `pinia`           | 2.3.1                          | 需兼容 vue 3.4（pinia 3+/4+ 的 peer 要求 vue ≥ 3.5）                        |
| `vitest`          | 2.1.9                          | 需兼容 vite 5                                                               |
| `echarts`         | 5.6.0                          | 仅管理后台使用；小程序端图表为 Canvas 2D 自绘（见 §7）                      |

升级 uni-app 时，必须同步核对 `vite` / `vue` / `vite-plugin-uni` 三个版本的一致性。

---

## 3. 快速开始

```bash
# 1. 仓库根目录安装依赖
pnpm install

# 2. 复制 Vant Weapp 原生组件（首次或升级 @vant/weapp 后执行）
pnpm --filter @soulmap/miniapp copy:vant

# 3. 启动微信小程序开发构建（产物在 dist/dev/mp-weixin）
pnpm --filter @soulmap/miniapp dev:mp-weixin

# 4. 用微信开发者工具「导入项目」，目录选择 dist/dev/mp-weixin
```

其他命令：

```bash
pnpm --filter @soulmap/miniapp build:mp-weixin   # 生产构建（dist/build/mp-weixin）
pnpm --filter @soulmap/miniapp typecheck         # vue-tsc 类型检查
pnpm --filter @soulmap/miniapp test              # Vitest 单元测试
pnpm --filter @soulmap/miniapp dev:h5            # H5 预览（仅用于快速调样式）
```

---

## 4. 上手前必须配置的三处

1. **`src/manifest.json`** → `mp-weixin.appid`：填入真实小程序 AppID。
2. **`src/config/env.ts`** → `BASE_URL_MAP`：把 `trial` / `release` 的域名换成自己的
   备案 HTTPS 域名，并在微信公众平台配置为 `request` / `uploadFile` / `downloadFile` 合法域名。
3. **微信公众平台**
   - 填写《小程序用户隐私保护指引》，与 `src/pkgWebview/pages/privacy.vue` 保持一致；
   - 配置订阅消息模板 ID，写入后端环境变量（不进小程序包）；
   - 上线前以「体验版」验证 `trial` 环境。

---

## 5. 目录结构

```
src/
├── pages/                  # 主包页面（tabBar 页面必须在主包）
│   ├── index/              # 首页
│   ├── report/list.vue     # 我的报告（tabBar）
│   ├── profile/index.vue   # 我的（tabBar）
│   └── test/intro.vue      # 测试介绍
├── pkgTest/                # 分包：答题、结果
├── pkgReport/              # 分包：报告详情
├── pkgMatch/               # 分包：邀请、匹配报告
├── pkgChat/                # 分包：AI 情感助手
├── pkgMember/              # 分包：会员中心
├── pkgWebview/             # 分包：用户协议、隐私政策
├── components/             # 业务组件（安全声明、空状态、雷达图）
├── api/                    # 接口层：request 封装 + 按域拆分的接口函数
├── store/                  # Pinia：auth / app / test
├── utils/                  # storage / format / toast / request-id
├── config/                 # env（多环境域名）、constants（展示常量）
├── styles/                 # tokens.scss（设计令牌）+ global.scss
├── types/                  # 类型声明（含 openapi 生成物占位）
├── App.vue                 # 根组件（启动流程）
├── main.ts                 # createApp 工厂
├── pages.json              # 路由 + 分包 + tabBar
└── manifest.json           # 小程序配置
```

### 分包策略（微信主包上限 2MB）

主包只保留 **首页 / 报告列表 / 我的 / 测试介绍** 四个页面，
其余全部进分包，并配置 `preloadRule` 在合适时机预下载，兼顾启动速度与体积。

---

## 6. 关键基础设施说明

### 6.1 请求层（`src/api/request.ts`）

**为什么不直接用 axios（架构决策 ADR-006）**：小程序没有 XHR，axios 需要额外 adapter
且体积偏大。因此自研本模块，对外提供与 axios 一致的语义：

- 自动注入 `Authorization` / `X-Request-Id` / `X-Platform` / `X-Client-Version`；
- 统一解包后端响应包络 `{ code, message, data, requestId, timestamp }`；
- **401 自动续期（single-flight）**：并发的多个 401 只触发一次 refresh，其余排队等待，
  避免刷新风暴；
- 幂等 GET 的网络错误自动重试 1 次；**写请求绝不自动重试**（防止重复下单/重复提交）；
- 所有失败归一为 `ApiError`，页面可按错误码分支（如 `isPaymentRequired` / `isMembershipRequired`）；
- `cancelKey` 支持后发请求取消先发请求（搜索联想、快速切页）。

`request.ts` **不 import 任何 store**，而是暴露 `registerRequestHooks()` 由 `store/auth.ts`
反向注册回调，从根本上消除 `api ←→ store` 的循环依赖。

### 6.2 断点续答（`src/store/test.ts`）

答案在每次作答时同步写入本地草稿（`sm_test_draft_{definitionCode}`），
并每 2 秒节流批量同步到服务端（`PUT /tests/sessions/{id}/answers`，
服务端按 `UNIQUE(sessionId, questionId)` upsert，天然幂等）。
小程序被杀死或切后台后再进入，可从中断处继续。

### 6.3 系统配置下发（`src/store/app.ts`）

功能开关、免责声明文案、分享文案、免费预览比例全部由 `GET /system/config` 下发，
采用 **stale-while-revalidate**：有有效缓存（1 小时）时立即返回并后台刷新，
保证首屏不被网络阻塞。服务端不可用时使用本地兜底配置，页面不白屏。

### 6.4 合规（不可绕过）

- 所有展示 AI 内容的页面必须渲染 `SafetyDisclaimer` 组件，文案由后端下发；
- 服务端对危险内容（自伤/他伤/医疗）做预筛并返回固定关怀文案，前端**原样展示，不得改写**；
- 报告免费预览由服务端裁剪段落（`isFreePreview`），绝不做「前端遮挡全文」的实现；
- 用户头像昵称使用微信新版能力（`open-type="chooseAvatar"` / `input type="nickname"`），
  不使用已废弃的 `wx.getUserProfile`。

---

## 7. 图表实现（ADR-019）

小程序端**不引入 ECharts**：主包上限 2MB，而 ECharts 完整包约 1MB，为雷达图一种图表
引入 ECharts + `ec-canvas` 适配层性价比过低。

因此 `src/components/RadarChart.vue` 采用 **Canvas 2D（`type="2d"`）自绘**：
零依赖、体积可忽略、支持双人对比（匹配报告中的「我 vs TA」）、
按 `devicePixelRatio` 缩放避免高分屏模糊。

ECharts 仅用于 Web 管理后台的多维统计图表。

---

## 8. 测试

```bash
pnpm --filter @soulmap/miniapp test
```

Phase 0 覆盖：

| 测试文件                         | 覆盖点                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `tests/utils/format.spec.ts`     | 金额分→元精度、时间格式化与相对时间边界、手机号与 ID 脱敏                        |
| `tests/utils/storage.spec.ts`    | JSON 往返、TTL 过期清理、脏数据恢复、配额满降级到内存                            |
| `tests/utils/request-id.spec.ts` | 生成的 ID 必须通过服务端格式校验（`^[A-Za-z0-9_-]{8,64}$`）、回退分支            |
| `tests/api/request.spec.ts`      | 请求头注入、包络解包、错误归一、401 单飞刷新、GET 重试 vs 写请求不重试、分页容错 |
| `tests/config/env.spec.ts`       | 环境判定、生产域名必须 HTTPS、常量契约                                           |

---

## 9. 常见问题

**Q：微信开发者工具里接口 404 / 域名校验失败？**
A：开发环境基址是 `http://127.0.0.1:3000/api/v1`，需在开发者工具「详情 → 本地设置」
勾选「不校验合法域名」。正式环境必须 HTTPS 且已在公众平台配置白名单。

**Q：`van-*` 组件不生效？**
A：先执行 `pnpm --filter @soulmap/miniapp copy:vant`，并确认 `pages.json` 中的
`easycom.custom` 规则存在。

**Q：构建报 vite / vue 版本相关错误？**
A：见 §2，切勿单独升级 `vite` 或 `vue`。

**Q：主包体积超 2MB？**
A：检查是否把大图片放进了 `src/static`。图片应上传 OSS 经 CDN 加载；
`copy:vant` 只保留实际用到的组件目录。
