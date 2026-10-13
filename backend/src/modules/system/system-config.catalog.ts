/**
 * 系统配置目录（`system_configs` 的「已知键」清单）
 *
 * ## 为什么需要一份代码里的目录
 *
 * `system_configs` 是通用的 KV 表，本身没有任何「这个键是什么、可取什么值」的信息。
 * 但契约同时要求三件事，只有目录才能同时满足：
 *   1. §3.14.9.1 管理端要返回 `label` / `valueType` / `min` / `max` / `impactScope` /
 *      `requiresConfirmPassword` / `envOverride` —— 这些元信息数据库里没有列；
 *   2. §3.14.9.2 更新时要按 `valueType` 校验类型与区间，且要能对「库里还没有这一行」的
 *      键判断「键不存在（90010）」还是「值不合法」；
 *   3. §3.12 用户端要在**库中无配置**时仍能启动（首屏不能因为运维忘了插一行配置就白屏），
 *      因此每个键必须有一个可用的兜底默认值。
 *
 * ## 与散落在各模块的兜底读取是什么关系
 *
 * `personality.service.ts`（`disclaimer.personality`）、`user.service.ts`
 *（`avatar.default` / `policy.version.*`）已经在做「配置优先、缺失兜底」，本目录
 * **沿用同一套键名**并把它们纳入治理：即那些模块仍直接读库，而管理端从此能在后台
 * 看到并修改同一行数据，两边口径不会漂移。
 *
 * ## envOverride 的语义（契约 §3.14.9.1 规则 1）
 *
 * `envOverride` 非空的键表示「配置即环境变量（架构 P5）」：运行时真值由环境变量决定，
 * 后台只读（`isEditable: false`），要改必须走部署。本案只有三个功能开关属于这一类
 *（与 `config/validation.schema.ts` 中的 `FEATURE_*` 一致）。
 *
 * 其余运行时策略值（配额、比例、文案）虽然也有环境变量作为**基线默认值**，但契约
 * §3.14.9.2 的示例明确要求 `reportFreePreviewRatio` 可在后台热改，因此它们的环境变量
 * 只是「数据库无该行时的默认值」，后台可覆盖 —— 这条边界是刻意的，见 `configPath` 字段。
 */

import { ConfigValueType } from '@prisma/client';

/** 配置分组（契约 §3.14.9.1 group 枚举） */
export const CONFIG_GROUPS = [
  'APP',
  'FEATURE_FLAG',
  'DISCLAIMER',
  'PRICING',
  'SHARE',
  'LIMIT',
  'AI',
  'SECURITY',
  'COMPLIANCE',
] as const;

export type ConfigGroup = (typeof CONFIG_GROUPS)[number];

export const CONFIG_GROUP_NAMES: Readonly<Record<ConfigGroup, string>> = {
  APP: '应用信息',
  FEATURE_FLAG: '功能开关',
  DISCLAIMER: '合规文案',
  PRICING: '价格策略',
  SHARE: '分享文案',
  LIMIT: '限额与限流',
  AI: 'AI 参数',
  SECURITY: '安全策略',
  COMPLIANCE: '合规设置',
};

/** 影响范围（契约 §3.14.9.1 impactScope） */
export type ConfigImpactScope = 'GLOBAL' | 'MEMBERSHIP' | 'USER';

/**
 * `AppConfig` 中可作为配置默认值的路径
 *
 * 之所以不直接读 `process.env`：ESLint 明令业务代码禁止访问 `process.env`
 *（必须经 ConfigService），而这个字段恰好就是「经 ConfigService 取到的那份基线值」。
 */
export type ConfigBaselinePath =
  | 'features.payment'
  | 'features.coupleMatch'
  | 'features.aiChat'
  | 'quota.freeAiMessages'
  | 'quota.memberDailyAiMessages'
  | 'quota.reportFreePreviewRatio'
  | 'quota.orderExpireMinutes';

/** 单个已知配置键的定义 */
export interface ConfigDefinition {
  key: string;
  group: ConfigGroup;
  /** 后台展示名（契约 label） */
  label: string;
  valueType: ConfigValueType;
  /** 兜底默认值；与数据库一样以**字符串**保存，读取时按 valueType 反解析 */
  defaultValue: string;
  description: string;
  /** 数值型配置的合法区间（契约 min/max） */
  min?: number;
  max?: number;
  /** 影响资金、合规、全局开关时为 true（契约 §3.14.9.1 规则 2） */
  requiresConfirmPassword: boolean;
  impactScope: ConfigImpactScope;
  /**
   * 环境变量名：非空即表示「该键由环境变量锁定、后台只读」，
   * 同时该名字会作为 `envOverride` 原样返回给后台（契约 §3.14.9.1 示例）
   */
  envOverride?: string;
  /** 环境变量作为强制真值时的取值路径（仅 envOverride 非空时使用） */
  envLockedPath?: ConfigBaselinePath;
  /** 环境变量作为兜底默认值时的取值路径（后台可覆盖） */
  baselinePath?: ConfigBaselinePath;
  /** 是否可出现在公开接口（§3.12）中 */
  isPublic: boolean;
}

/** JSON 默认值统一用紧凑序列化，避免同一语义两种字符串形态导致内容哈希抖动 */
const json = (value: unknown): string => JSON.stringify(value);

/** 免责声明兜底文案（与 `frontend/miniapp` 的 `FALLBACK_DISCLAIMER` 语义一致，真值仍以服务端为准） */
const DISCLAIMER_AI_CONTENT =
  'AI 内容由模型生成，仅供自我探索参考，不构成心理诊断或医疗建议。如有持续困扰，建议寻求专业心理服务。';
const DISCLAIMER_ASSESSMENT =
  '本测评参考 MBTI 与 Big Five 理论框架，结果仅供自我探索参考，不构成心理诊断、医疗建议或临床评估。';
const DISCLAIMER_COMPATIBILITY = '匹配结果基于人格测评框架计算，仅供关系自我探索参考，不构成情感诊断或专业咨询建议。';
const DISCLAIMER_AI_GENERATED_NOTICE = '本内容由人工智能生成。';
const DISCLAIMER_CONFIDENCE_NOTICE =
  '人格特质在成年后相对稳定，单次测评结果可能受当下状态影响。报告中标注了本次作答的置信度，可作为参考。';
const DISCLAIMER_CRISIS_NOTICE =
  '如果你正经历严重的心理困扰或有伤害自己的念头，请立即联系上方的专业热线，或告知身边可信任的人。SoulMap 无法提供危机干预。';
/**
 * AI 助手会话首屏提示（合规文案，契约 §3.7.1 响应字段 `systemNotice`）
 *
 * 必须与 `modules/ai/chat/chat.types.ts` 的 `DEFAULT_SYSTEM_NOTICE` 逐字一致：
 * 库里一旦有 `ai.systemNotice` 这一行，它就**取代**代码兜底值成为真值，
 * 两者不同会出现「注释里的兜底文案」与「用户实际看到的提示」不一致 ——
 * 而这段文字是合规文本（必须含"不能提供心理诊断或医疗建议"与转介建议）。
 */
const AI_SYSTEM_NOTICE =
  '我是 SoulMap 的 AI 情感助手。我可以陪你梳理情绪、理解关系，但我不能提供心理诊断或医疗建议。如果你正经历严重的心理困扰，请寻求专业帮助。';

/** 危机干预资源（合规要求，随 `disclaimer.safetyResources` 下发） */
const SAFETY_RESOURCES = [
  { name: '全国心理援助热线', phone: '12356', available: '24 小时', region: '全国' },
  { name: '北京心理危机研究与干预中心', phone: '010-82951332', available: '24 小时', region: '北京' },
  { name: '希望 24 热线', phone: '400-161-9995', available: '24 小时', region: '全国' },
];

/** 分享文案模板占位符由前端替换（契约 §3.12.1 `share.templates`） */
const SHARE_TEMPLATES = {
  DEFAULT: {
    title: 'SoulMap AI — 认识自己，理解关系',
    text: '我在用 SoulMap 探索自己的人格，你也来试试？',
    imageUrl: '',
  },
  TEST_RESULT: {
    title: '我的 MBTI 是 {{mbtiType}}',
    text: '我的 MBTI 是 {{mbtiType}}（{{typeName}}）——{{tagline}}。来测测你的？',
    imageUrl: '',
  },
  REPORT: {
    title: '我的人格深度报告',
    text: '我的 MBTI 是 {{mbtiType}}——{{tagline}}。来测测你的？',
    imageUrl: '',
  },
  INVITE: {
    title: '{{inviterName}}邀请你一起做人格测试',
    text: '{{inviterName}}邀请你一起做人格测试，看看我们有多合拍～',
    imageUrl: '',
  },
};

/** 全部已知配置键 */
export const CONFIG_DEFINITIONS: readonly ConfigDefinition[] = [
  // ------------------------------------------------------------------ 应用信息
  {
    key: 'app.name',
    group: 'APP',
    label: '应用名称',
    valueType: ConfigValueType.STRING,
    defaultValue: 'SoulMap AI',
    description: '小程序与后台展示的产品名',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'app.slogan',
    group: 'APP',
    label: '应用标语',
    valueType: ConfigValueType.STRING,
    defaultValue: '认识自己，理解关系',
    description: '启动页与分享卡片的副标题',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'app.minClientVersion',
    group: 'APP',
    label: '最低客户端版本',
    valueType: ConfigValueType.STRING,
    defaultValue: '1.2.0',
    description: '低于该版本的小程序需强制更新（契约 §3.12.1 规则 8）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'app.forceUpdate',
    group: 'APP',
    label: '强制更新开关',
    valueType: ConfigValueType.BOOLEAN,
    defaultValue: 'false',
    description: '开启后所有客户端都会收到强更提示',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'app.updateUrl',
    group: 'APP',
    label: '更新说明链接',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '强更弹窗中「查看详情」的地址，留空表示不展示',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'app.updateNote',
    group: 'APP',
    label: '更新说明文案',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '强更弹窗中的说明文案',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'app.icpNumber',
    group: 'APP',
    label: 'ICP 备案号',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '页脚展示的备案号（合规要求）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'app.supportContact',
    group: 'APP',
    label: '客服入口',
    valueType: ConfigValueType.JSON,
    defaultValue: json({
      type: 'WECHAT_CUSTOMER_SERVICE',
      label: '联系客服',
      value: '点击右下角「客服」按钮',
    }),
    description: '客服入口的类型与文案，前端按 type 决定跳转方式',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'app.support.wechatId',
    group: 'APP',
    label: '客服微信号',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '小程序 `support.wechatId` 字段的来源；留空表示不展示',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'app.support.email',
    group: 'APP',
    label: '客服邮箱',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '小程序 `support.email` 字段的来源；留空表示不展示',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },

  // ------------------------------------------- 订阅消息的权威模板 ID（APP 组）
  //
  // 为什么必须进目录：`notification.service.ts` 的 `resolveAuthoritativeTemplateId`
  // 按 `notify.template.{scene}` 读**库中该键**（`getEntry` 能返回目录之外的键）。
  // 键不在目录里时，后台既列不出来也管不了，实际效果是**永远读不到权威值** ——
  // 于是服务端只能采用客户端上报的 `templateId`，任何人伪造一个模板 ID 就能把
  // 用户授权的额度"存"到一个永远不会被发送的场景上。服务端每次都记 `warn` 日志，
  // 但那只是"事后可见"，运营没有任何办法把它改成对的。
  //
  // 为什么默认值是空串：这些是**微信后台配置的模板 ID**，属于"每套小程序账号一套"
  // 的环境相关值。若在目录里预置一个假的 `TMPL_xxx`，库中一旦出现该行就会**覆盖**
  // 用户/客户端送来的真值，线上通知会全部发不出去。空串 → `readConfiguredTemplateId`
  // 判为"未配置"→ 维持现状（回落客户端值），直到运营把真值填进来。
  //
  // 为什么不按 `SUBSCRIPTION_SCENES` 生成而是逐条写死：那需要让 `system` 模块反向
  // 依赖 `notification` 模块，而 notification 本来就依赖 system（读配置），
  // 双向依赖正是交接文档 §6.3 第 15 条记录过的"整个后端起不来"那类故障。
  // 漂移风险改由 `notification` 侧的一致性单测守住（遍历所有场景断言目录里有键）。
  {
    key: 'notify.template.REPORT_READY',
    group: 'APP',
    label: '订阅消息模板 ID — 报告生成完成',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '场景 REPORT_READY 的权威模板 ID（微信后台配置）；留空时服务端只能采用客户端上报值',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: false,
  },
  {
    key: 'notify.template.RELATIONSHIP_INVITE',
    group: 'APP',
    label: '订阅消息模板 ID — 收到关系邀请',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '场景 RELATIONSHIP_INVITE 的权威模板 ID；留空时服务端只能采用客户端上报值',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: false,
  },
  {
    key: 'notify.template.RELATIONSHIP_CONFIRMED',
    group: 'APP',
    label: '订阅消息模板 ID — 关系已确认',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '场景 RELATIONSHIP_CONFIRMED 的权威模板 ID；留空时服务端只能采用客户端上报值',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: false,
  },
  {
    key: 'notify.template.MEMBERSHIP_EXPIRING',
    group: 'APP',
    label: '订阅消息模板 ID — 会员即将到期',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '场景 MEMBERSHIP_EXPIRING 的权威模板 ID；留空时服务端只能采用客户端上报值',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: false,
  },
  {
    key: 'notify.template.DELETION_REMINDER',
    group: 'APP',
    label: '订阅消息模板 ID — 注销冷静期提醒',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '场景 DELETION_REMINDER 的权威模板 ID；留空时服务端只能采用客户端上报值',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: false,
  },
  {
    key: 'notify.template.PAYMENT_RESULT',
    group: 'APP',
    label: '订阅消息模板 ID — 支付结果通知',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '场景 PAYMENT_RESULT 的权威模板 ID；留空时服务端只能采用客户端上报值',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: false,
  },

  // ---------------------------------------------------------------- 功能开关
  {
    key: 'FEATURE_PAYMENT',
    group: 'FEATURE_FLAG',
    label: '支付功能',
    valueType: ConfigValueType.BOOLEAN,
    defaultValue: 'true',
    description: '关闭后所有下单接口返回 70018，前端隐藏支付入口',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    envOverride: 'FEATURE_PAYMENT',
    envLockedPath: 'features.payment',
    isPublic: true,
  },
  {
    key: 'FEATURE_COUPLE_MATCH',
    group: 'FEATURE_FLAG',
    label: '恋爱匹配功能',
    valueType: ConfigValueType.BOOLEAN,
    defaultValue: 'true',
    description: '关闭后 COUPLE 类型邀请与匹配报告接口返回 60012',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    envOverride: 'FEATURE_COUPLE_MATCH',
    envLockedPath: 'features.coupleMatch',
    isPublic: true,
  },
  {
    key: 'FEATURE_AI_CHAT',
    group: 'FEATURE_FLAG',
    label: 'AI 情感助手',
    valueType: ConfigValueType.BOOLEAN,
    defaultValue: 'true',
    description: '关闭后 AI 对话接口返回 50021，前端隐藏对话入口',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    envOverride: 'FEATURE_AI_CHAT',
    envLockedPath: 'features.aiChat',
    isPublic: true,
  },
  {
    key: 'FEATURE_PDF_EXPORT',
    group: 'FEATURE_FLAG',
    label: 'PDF 导出',
    valueType: ConfigValueType.BOOLEAN,
    /**
     * 默认 **true**：渲染器已于 2026-10-13 接入
     * （`report-render.util.ts` 用 `pdf-lib` + 仓库自带的 OFL 中文字体产出真实 PDF）。
     *
     * 历史：接入前这里默认 `false`，因为"关闭后入口隐藏"正是该开关的意义 ——
     * 让客户端展示一个点了必然失败的入口比没有入口更糟。
     *
     * ⚠ 与会员权益文案联动：`prisma/seed/data/catalog.ts` 的 `MEMBERSHIP_BENEFITS`
     * 里「PDF 导出」已同步恢复为 `不限次`。两者必须同时改，否则会出现
     * "权益表承诺了、开关却是关的"这种自相矛盾。
     */
    defaultValue: 'true',
    description: '关闭后报告导出入口隐藏（服务端仍以权益为准）',
    requiresConfirmPassword: false,
    impactScope: 'MEMBERSHIP',
    isPublic: true,
  },
  {
    key: 'FEATURE_SHARE_CARD',
    group: 'FEATURE_FLAG',
    label: '分享卡片',
    valueType: ConfigValueType.BOOLEAN,
    /**
     * 默认 **true**：`renderShareCardImage` 已于 2026-10-13 用 `@napi-rs/canvas`
     * 接入，产出 750×1334 的分享图（WebP，编码不可用时降级 PNG）。
     */
    defaultValue: 'true',
    description: '关闭后前端隐藏分享按钮，避免出现无落地的入口',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'FEATURE_GROWTH_CURVE',
    group: 'FEATURE_FLAG',
    label: '成长曲线',
    valueType: ConfigValueType.BOOLEAN,
    defaultValue: 'true',
    description: '关闭后人格趋势图不下发（数据仍保留）',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'FEATURE_VOICE_INPUT',
    group: 'FEATURE_FLAG',
    label: '语音输入',
    valueType: ConfigValueType.BOOLEAN,
    defaultValue: 'false',
    description: '默认关闭；开启后前端展示语音输入按钮',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'maintenanceMode',
    group: 'FEATURE_FLAG',
    label: '全局维护模式',
    valueType: ConfigValueType.BOOLEAN,
    defaultValue: 'false',
    description: '开启后写接口返回 90007，前端展示维护公告（配置本身仍可读）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'maintenanceNotice',
    group: 'FEATURE_FLAG',
    label: '维护公告文案',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '维护模式开启时展示的公告，留空则前端用默认文案',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },

  // ---------------------------------------------------------------- 合规文案
  {
    key: 'disclaimer.aiContent',
    group: 'DISCLAIMER',
    label: 'AI 内容声明',
    valueType: ConfigValueType.STRING,
    defaultValue: DISCLAIMER_AI_CONTENT,
    description: '所有 AI 生成内容处必须展示的声明（架构 1.2 合规硬约束）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'disclaimer.personality',
    group: 'DISCLAIMER',
    label: '测评声明',
    valueType: ConfigValueType.STRING,
    defaultValue: DISCLAIMER_ASSESSMENT,
    description: '测评结果页声明；`personality` 模块直接读本键，改这里即同时生效',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'disclaimer.compatibility',
    group: 'DISCLAIMER',
    label: '匹配结果声明',
    valueType: ConfigValueType.STRING,
    defaultValue: DISCLAIMER_COMPATIBILITY,
    description: '情侣/关系匹配报告页声明',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'disclaimer.aiGeneratedNotice',
    group: 'DISCLAIMER',
    label: 'AI 生成标识',
    valueType: ConfigValueType.STRING,
    defaultValue: DISCLAIMER_AI_GENERATED_NOTICE,
    description: 'AI 内容的显式标识（生成式 AI 内容监管要求）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'disclaimer.confidenceNotice',
    group: 'DISCLAIMER',
    label: '置信度说明',
    valueType: ConfigValueType.STRING,
    defaultValue: DISCLAIMER_CONFIDENCE_NOTICE,
    description: '报告内联的置信度解释文案',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'disclaimer.crisisNotice',
    group: 'DISCLAIMER',
    label: '危机提示文案',
    valueType: ConfigValueType.STRING,
    defaultValue: DISCLAIMER_CRISIS_NOTICE,
    description: '危险内容拦截与危机资源旁必须展示的文案',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'disclaimer.safetyResources',
    group: 'DISCLAIMER',
    label: '危机干预资源',
    valueType: ConfigValueType.JSON,
    defaultValue: json(SAFETY_RESOURCES),
    description: '心理援助热线清单，与 AI 对话的危险内容拦截同源',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'disclaimer.emergencyNotice',
    group: 'DISCLAIMER',
    label: '紧急情况提示',
    valueType: ConfigValueType.STRING,
    defaultValue: '如有紧急危险，请拨打 120 或前往最近的急诊。',
    description: '危机资源块末尾的紧急处置提示',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },

  // ---------------------------------------------------------------- 价格策略
  {
    key: 'pricing.currency',
    group: 'PRICING',
    label: '结算币种',
    valueType: ConfigValueType.STRING,
    defaultValue: 'CNY',
    description: 'ISO 4217 币种代码',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'payment.payMethod',
    group: 'LIMIT',
    label: '支付方式',
    valueType: ConfigValueType.STRING,
    defaultValue: 'WECHAT_JSAPI',
    description: '当前仅支持微信 JSAPI；该值随 `featuresExplain.FEATURE_PAYMENT` 下发',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'payment.orderExpireMinutes',
    group: 'LIMIT',
    label: '订单过期时长（分钟）',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '30',
    min: 5,
    max: 1440,
    description: '未支付订单自动关单时长；与 `quota.orderExpireMinutes` 环境基线一致',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    baselinePath: 'quota.orderExpireMinutes',
    isPublic: true,
  },
  {
    key: 'payment.autoRenew',
    group: 'LIMIT',
    label: '自动续费开关',
    valueType: ConfigValueType.BOOLEAN,
    defaultValue: 'false',
    description: '会员到期自动续费；未接入签约能力前必须保持关闭',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },

  // ---------------------------------------------------------------- 分享文案
  {
    key: 'share.templates',
    group: 'SHARE',
    label: '分享文案模板',
    valueType: ConfigValueType.JSON,
    defaultValue: json(SHARE_TEMPLATES),
    description: '按场景的分享标题/文案/图片，`{{}}` 占位符由前端替换',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'share.defaultScene',
    group: 'SHARE',
    label: '默认分享场景',
    valueType: ConfigValueType.STRING,
    defaultValue: 'DEFAULT',
    description: '未指定场景时使用的模板键',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'share.path',
    group: 'SHARE',
    label: '分享落地页路径',
    valueType: ConfigValueType.STRING,
    defaultValue: '/pages/index/index',
    description: '小程序分享卡片的落地路径（与前端 `DEFAULT_SHARE.path` 一致）',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'share.imageUrl',
    group: 'SHARE',
    label: '默认分享图',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '默认分享卡片图片地址，留空表示由各场景模板决定',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },

  // ------------------------------------------------------------ 限额与限流
  {
    key: 'reportFreePreviewRatio',
    group: 'LIMIT',
    label: '报告免费预览比例',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '0.2',
    min: 0,
    max: 1,
    description: '服务端裁剪免费预览的内容占比（架构 2 要点 4）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    baselinePath: 'quota.reportFreePreviewRatio',
    isPublic: true,
  },
  {
    key: 'freeAiQuotaTotal',
    group: 'LIMIT',
    label: '免费用户 AI 总次数',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '10',
    min: 0,
    max: 100,
    description: '免费用户累计可用的 AI 对话次数',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    baselinePath: 'quota.freeAiMessages',
    isPublic: true,
  },
  {
    key: 'memberAiDailyLimit',
    group: 'LIMIT',
    label: '会员每日 AI 次数',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '50',
    min: 1,
    max: 500,
    description: '会员每日 AI 对话上限（架构 10.5）',
    requiresConfirmPassword: false,
    impactScope: 'MEMBERSHIP',
    baselinePath: 'quota.memberDailyAiMessages',
    isPublic: true,
  },
  {
    key: 'reportRegenerateDailyLimit',
    group: 'LIMIT',
    label: '报告每日重生成上限',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '5',
    min: 0,
    max: 50,
    description: '会员每日可重新生成报告的次数',
    requiresConfirmPassword: false,
    impactScope: 'MEMBERSHIP',
    isPublic: true,
  },
  {
    key: 'uploadMaxBytes',
    group: 'LIMIT',
    label: '上传大小上限（字节）',
    valueType: ConfigValueType.JSON,
    defaultValue: json({ AVATAR: 2097152, FEEDBACK_IMAGE: 5242880, REPORT_PDF: 20971520 }),
    description: '按上传场景的大小上限；改动会影响客户端前置校验',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'nicknameMaxLength',
    group: 'LIMIT',
    label: '昵称最大长度',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '20',
    min: 1,
    max: 64,
    description: '昵称长度上限（服务端校验与前端输入框共用）',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'statusMessageMaxLength',
    group: 'LIMIT',
    label: '状态签名最大长度',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '30',
    min: 0,
    max: 128,
    description: '个性签名长度上限',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'aiMessageMaxLength',
    group: 'LIMIT',
    label: 'AI 消息最大长度',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '2000',
    min: 100,
    max: 8000,
    description: '单条 AI 对话消息的字符上限',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'pageSizeMax',
    group: 'LIMIT',
    label: '分页最大条数',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '100',
    min: 1,
    max: 100,
    description: '列表接口 pageSize 上限；与 `PaginationQueryDto` 的 @Max(100) 必须保持一致',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },

  // ------------------------------------------------------------------ AI 参数
  {
    key: 'ai.maxConcurrentStreams',
    group: 'AI',
    label: 'AI 并发流上限',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '3',
    min: 1,
    max: 10,
    description: '单用户同时进行的流式对话数，防止刷爆上游额度',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'ai.systemNotice',
    group: 'AI',
    label: 'AI 助手会话首屏提示',
    valueType: ConfigValueType.STRING,
    defaultValue: AI_SYSTEM_NOTICE,
    description:
      '会话创建响应 `systemNotice` 的来源（合规提示，契约 §3.7.1 要求由服务端下发、前端不得硬编码）；' +
      '文案必须包含「不能提供心理诊断或医疗建议」与转介建议，因此改动需二次确认',
    // 与 `disclaimer.*` 同类：合规文案被改错会直接影响合规性，故要求 X-Confirm-Password
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },

  // ---------------------------------------------------------------- 安全策略
  {
    key: 'security.adminIpWhitelist',
    group: 'SECURITY',
    label: '后台 IP 白名单',
    valueType: ConfigValueType.JSON,
    defaultValue: '[]',
    description: '管理后台允许的来源 IP/CIDR；为空表示不限制（对应错误码 20020）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: false,
  },
  {
    key: 'security.coupleMatchMinAge',
    group: 'SECURITY',
    label: '恋爱匹配最小年龄',
    valueType: ConfigValueType.NUMBER,
    defaultValue: '18',
    min: 18,
    max: 30,
    description: '低于该年龄不可使用情侣匹配（合规要求，只能上调不能下调到 18 以下）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },

  // ---------------------------------------------------------------- 合规设置
  {
    key: 'avatar.default',
    group: 'COMPLIANCE',
    label: '默认头像地址',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '`user` 模块直接读本键做新用户默认头像；留空则用前端内置占位图',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'assets.staticDomain',
    group: 'COMPLIANCE',
    label: '静态资源域名',
    valueType: ConfigValueType.STRING,
    defaultValue: '',
    description: '非 CDN 类静态资源域名（头像占位图、空状态图等）',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'assets.logos',
    group: 'COMPLIANCE',
    label: '品牌 Logo 地址',
    valueType: ConfigValueType.JSON,
    defaultValue: json({ primary: '', mono: '' }),
    description: '主色与单色 Logo 的资源地址',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'assets.emptyStates',
    group: 'COMPLIANCE',
    label: '空状态插画地址',
    valueType: ConfigValueType.JSON,
    defaultValue: json({ noReport: '', noRelationship: '', noChat: '' }),
    description: '各列表空状态插画地址',
    requiresConfirmPassword: false,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'compliance.policyUrls',
    group: 'COMPLIANCE',
    label: '协议页面地址',
    valueType: ConfigValueType.JSON,
    defaultValue: json({
      PRIVACY_POLICY: '',
      USER_AGREEMENT: '',
      AGE_DECLARATION: '',
      AI_CONTENT_NOTICE: '',
      MARKETING: '',
    }),
    description: '各协议在官网的落地页地址（版本号见 `policy.version.*`）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'policy.version.PRIVACY_POLICY',
    group: 'COMPLIANCE',
    label: '隐私政策版本',
    valueType: ConfigValueType.STRING,
    defaultValue: '2.1.0',
    description: '`user` 模块按 `policy.version.*` 校验同意书版本（30017）',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'policy.version.USER_AGREEMENT',
    group: 'COMPLIANCE',
    label: '用户协议版本',
    valueType: ConfigValueType.STRING,
    defaultValue: '1.8.0',
    description: '用户协议当前版本',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'policy.version.AGE_DECLARATION',
    group: 'COMPLIANCE',
    label: '年龄声明版本',
    valueType: ConfigValueType.STRING,
    defaultValue: '1.0.0',
    description: '年龄声明当前版本',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'policy.version.AI_CONTENT_NOTICE',
    group: 'COMPLIANCE',
    label: 'AI 内容告知版本',
    valueType: ConfigValueType.STRING,
    defaultValue: '1.2.0',
    description: '生成式 AI 内容告知书当前版本',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
  {
    key: 'policy.version.MARKETING',
    group: 'COMPLIANCE',
    label: '营销信息授权版本',
    valueType: ConfigValueType.STRING,
    defaultValue: '1.0.0',
    description: '营销信息推送授权书当前版本',
    requiresConfirmPassword: true,
    impactScope: 'GLOBAL',
    isPublic: true,
  },
];

/** 键 → 定义 */
export const CONFIG_DEFINITION_MAP: ReadonlyMap<string, ConfigDefinition> = new Map(
  CONFIG_DEFINITIONS.map((definition) => [definition.key, definition]),
);

/** 协议类型（`policy.version.*` 的后缀） */
export const POLICY_TYPES = [
  'PRIVACY_POLICY',
  'USER_AGREEMENT',
  'AGE_DECLARATION',
  'AI_CONTENT_NOTICE',
  'MARKETING',
] as const;

/** `policy.version` 前缀（与 `user.service.ts` 的读取口径一致） */
export const POLICY_VERSION_PREFIX = 'policy.version.';

/** 管理端 `group` 查询参数的合法值（含 `ALL`） */
export const CONFIG_GROUP_FILTERS = [...CONFIG_GROUPS, 'ALL'] as const;
export type ConfigGroupFilter = (typeof CONFIG_GROUP_FILTERS)[number];

/** 判断分组名是否合法 */
export const isConfigGroup = (value: string): value is ConfigGroup =>
  (CONFIG_GROUPS as readonly string[]).includes(value);
