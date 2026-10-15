import { ConfigValueType } from '@prisma/client';

/**
 * `system_configs` 种子数据（AI 情感助手链路依赖的运行时配置）
 *
 * ## 为什么必须有这份种子数据
 *
 * `system_configs` 此前**一行都没有**（已核查：全仓只有 `admin/config` 与
 * `admin/admin-user` 的写入路径）。运行时所有读取都是"读不到就用代码里的兜底值"
 * （见 `chat-quota.service.ts` 的 `readPositiveNumber` / `readStringConfig`），
 * 因此功能不会崩，但会产生两个真实后果：
 *
 *   ① **运营改不了**：兜底值写在代码里，改一句话要走发版流程，
 *      而契约 §3.7.1 明确要求会话首屏提示 `systemNotice` 由服务端下发、运营可改；
 *   ② **后台看不到**：管理端「系统配置」列表按 `system_configs` 的行组装，
 *      库里没有这一行时，后台看到的是目录默认值，运维无从确认线上到底用的什么值。
 *
 * ## 值从哪来：与 `system-config.catalog.ts` 的目录默认值保持一致
 *
 * `SystemConfigService.loadFromSources` 的优先级是
 * **环境变量锁定项 > `system_configs` 行 > 环境变量基线 > 目录静态默认值**。
 * 也就是说，本文件写入的行会**取代**环境变量基线成为真值 —— 因此这里的取值必须
 * 是"目录里的默认值"，而不是把某台机器的 `.env` 数字抄进种子数据：
 * 把环境相关值固化进种子会让"同一份代码 + 不同环境"的配置口径漂移，
 * 而漂移在配额类配置上会直接变成用户侧的可感知差异。
 *
 * `system-configs.spec.ts` 会把本文件与目录逐键比对（分组/类型/是否公开），
 * 目录改了而这里没跟上时会直接测试失败。
 *
 * ## `isPublic` 的判据
 *
 * `isPublic` 决定该键能否出现在面向**未登录/普通用户**的公开接口
 * （契约 §3.12 `GET /system/config`、`GET /system/disclaimers`）里。
 * 因此判据是"这条配置本身是不是要给用户看的"，而不是"它属于哪个模块"：
 *   · 本文件收录的键**全部是用户可见的文案与用户自己的额度口径**
 *     （首屏合规提示、免责声明、危机资源、用户可用次数、单条消息长度上限），
 *     所以都是 `true`；
 *   · 真正的运营内部配置（例如 `security.adminIpWhitelist`：后台来源 IP 白名单，
 *     与 `admin-user.service.ts` 落在 `system_configs` 的 `admin.ipWhitelist.{adminId}`）
 *     **不收录**，也不设 `true` —— 让攻击面清单出现在公开配置里没有任何收益。
 *
 * ⚠ 本文件**只新增/更新自己的键**，不触碰会员套餐、商品、管理员 RBAC 等其它种子数据。
 */

/** 系统配置种子（字段与 Prisma `SystemConfig` 一一对应，`value` 一律是字符串） */
export interface SeedSystemConfig {
  /** 配置键（`system_configs.key`，唯一约束所在） */
  key: string;
  /** 真值（与其 `valueType` 匹配的字符串形态，JSON 用紧凑序列化） */
  value: string;
  valueType: ConfigValueType;
  /** 分组（契约 §3.14.9.1 group 枚举的字符串值，与 `CONFIG_GROUP_NAMES` 的键一致） */
  group: string;
  description: string;
  /** 是否可下发到公开接口（契约 §3.12） */
  isPublic: boolean;
  /** 是否允许后台热改（默认 true；环境变量锁定的键才应设为 false） */
  isEditable: boolean;
}

/**
 * AI 助手会话首屏合规提示（**本文件新增的键**）
 *
 * 读取点：`chat-context.service.ts` 的 `systemNotice()` →
 * `quota.readStringConfig('ai.systemNotice', DEFAULT_SYSTEM_NOTICE)`
 * （会话创建响应字段 `systemNotice`，契约 §3.7.1 要求由服务端下发、前端不得硬编码）。
 *
 * 取值与 `chat.types.ts` 的 `DEFAULT_SYSTEM_NOTICE` **逐字一致**：库里的值会取代兜底值，
 * 两者若不同，就会出现"代码注释说的兜底文案"与"用户实际看到的首屏提示"不一致 ——
 * 而这段文案是合规文本（必须包含"不能提供心理诊断或医疗建议"与转介建议）。
 *
 * 该键**已补录**进 `system-config.catalog.ts`（AI 分组），因此后台不只能看到、
 * 还能改（改动要求 `X-Confirm-Password`）。补录是必要的：目录之外的键
 * `SystemConfigService` 一律按"未知键"只读下发，运营改不了这段合规文案。
 */
const AI_SYSTEM_NOTICE =
  '我是 SoulMap 的 AI 情感助手。我可以陪你梳理情绪、理解关系，但我不能提供心理诊断或医疗建议。如果你正经历严重的心理困扰，请寻求专业帮助。';

/** AI 内容声明（与目录 `DISCLAIMER_AI_CONTENT` 一致） */
const DISCLAIMER_AI_CONTENT =
  'AI 内容由模型生成，仅供自我探索参考，不构成心理诊断或医疗建议。如有持续困扰，建议寻求专业心理服务。';

/** AI 生成标识（生成式 AI 内容监管要求，与目录一致） */
const DISCLAIMER_AI_GENERATED_NOTICE = '本内容由人工智能生成。';

/** 危机提示（危险内容拦截后必须与转介资源一同展示，与目录一致） */
const DISCLAIMER_CRISIS_NOTICE =
  '如果你正经历严重的心理困扰或有伤害自己的念头，请立即联系上方的专业热线，或告知身边可信任的人。SoulMap 无法提供危机干预。';

/** 紧急处置提示（与目录一致） */
const DISCLAIMER_EMERGENCY_NOTICE = '如有紧急危险，请拨打 120 或前往最近的急诊。';

/**
 * 危机干预资源（与目录 `SAFETY_RESOURCES` 一致）
 *
 * 保留 `region` 字段：`chat-quota.util.ts` 的 `parseSafetyResources` 只取
 * `name` / `phone` / `available` 三个字段，多出的字段不会破坏解析，
 * 而目录里的这份数据本来就带 `region`（两者不一致会让 `/system/disclaimers`
 * 与 AI 对话两条链路下发同样的热线时字段数不同）。
 */
const DISCLAIMER_SAFETY_RESOURCES = [
  { name: '全国心理援助热线', phone: '12356', available: '24 小时', region: '全国' },
  { name: '北京心理危机研究与干预中心', phone: '010-82951332', available: '24 小时', region: '北京' },
  { name: '希望 24 热线', phone: '400-161-9995', available: '24 小时', region: '全国' },
];

/**
 * 收录范围：**AI 情感助手链路真实读取的每一个键**
 *
 * 逐条对着读取点列（不照抄"目录里看起来相关的键"）：
 *   · `ai.systemNotice`                       → `chat-context.service.ts` `systemNotice()`
 *   · `freeAiQuotaTotal`                      → `chat-quota.service.ts` `loadLimits()`
 *   · `memberAiDailyLimit`                    → 同上
 *   · `aiMessageMaxLength`                    → 同上（单条消息字符上限）
 *   · `ai.maxConcurrentStreams`               → `chat-conversation.service.ts` `readLimit(...)`
 *   · `disclaimer.aiContent`                  → `chat-message.service.ts` 回复内联声明
 *   · `disclaimer.aiGeneratedNotice`          → 同上（回复的"由 AI 生成"标识）
 *   · `disclaimer.crisisNotice`               → `chat-safety.service.ts` 危机关怀文案
 *   · `disclaimer.emergencyNotice`            → 同上
 *   · `disclaimer.safetyResources`            → `chat-quota.service.ts` `loadSafetyResources()`
 *
 * **不收录**代码里的**常量**（不是配置）：单会话消息数上限 200
 * （`MAX_MESSAGES_PER_CONVERSATION`）、24 小时建会话数上限
 * （`chat-conversation.service.ts` 的 `MAX_CONVERSATIONS_PER_DAY_LIMIT`，
 * 该文件已明确注释"system_configs 里没有这个键，因此固定用契约值"）。
 * 造两个没人读的键比不造更糟：运维改了却不生效。
 */
export const SYSTEM_CONFIGS: SeedSystemConfig[] = [
  {
    key: 'ai.systemNotice',
    value: AI_SYSTEM_NOTICE,
    // 纯文案 → STRING（不要用 JSON：`readStringConfig` 读的是 `rawValue`，
    // 存成 JSON 会把引号一起发给用户）
    valueType: ConfigValueType.STRING,
    group: 'AI',
    description: 'AI 助手会话首屏合规提示（会话创建响应 systemNotice）；改动需二次确认',
    // 用户直接看到这段文案（响应字段），且它正是"前端不得硬编码"的合规提示 → 公开
    isPublic: true,
    // 该键已在配置目录中（AI 分组），因此后台确实可改；
    // 与目录定义的一致性由 `system-configs.spec.ts` 逐字校验
    isEditable: true,
  },
  {
    key: 'freeAiQuotaTotal',
    value: '10',
    // 数值型：`readPositiveNumber` 会对 `rawValue` 做 Number()，字符串 '10' 正确解析
    valueType: ConfigValueType.NUMBER,
    group: 'LIMIT',
    description: '免费用户累计可用的 AI 对话次数（AI 助手配额判定）',
    // 用户需要知道"我还剩几次"，前端配额卡直接展示 → 公开
    isPublic: true,
    isEditable: true,
  },
  {
    key: 'memberAiDailyLimit',
    value: '50',
    valueType: ConfigValueType.NUMBER,
    group: 'LIMIT',
    description: '会员每日 AI 对话上限（架构 10.5；会员配额卡展示）',
    isPublic: true,
    isEditable: true,
  },
  {
    key: 'aiMessageMaxLength',
    value: '2000',
    valueType: ConfigValueType.NUMBER,
    group: 'LIMIT',
    description: '单条 AI 对话消息的字符上限（服务端校验与前端输入框共用）',
    // 上限值会下发给前端做输入框前置校验（`featuresExplain.FEATURE_AI_CHAT.maxMessageLength`）→ 公开
    isPublic: true,
    isEditable: true,
  },
  {
    /**
     * AI 助手是否为会员专属（ADR-038 阶段 5）
     *
     * 用户明确要求「AI 助手……需要加入会员才可以使用」。做成**配置**而不是硬编码：
     * 这个开关直接决定免费用户能否使用助手，属于运营策略 ——
     * 试运行期想放开、或想回滚，都只改一个值而不必发版。
     *
     * ⚠ 读取点在 `chat-quota.service.ts` 的 `readBoolean()`，**兜底值也是 true**：
     * 配置读不到时若兜底成 false，这个付费门槛会静默失效（用户不花钱就用上会员功能，
     * 且没有任何告警）。宁可读不到时保守地要求会员。
     */
    key: 'ai.assistantMembersOnly',
    value: 'true',
    valueType: ConfigValueType.BOOLEAN,
    group: 'AI',
    description: 'AI 助手是否仅限会员使用（true = 免费用户不可用，走会员引导）',
    // 前端需要据此决定展示"会员引导"还是"剩余次数" → 公开
    isPublic: true,
    isEditable: true,
  },
  {
    key: 'ai.maxConcurrentStreams',
    value: '3',
    valueType: ConfigValueType.NUMBER,
    group: 'AI',
    description: '单用户同时进行的流式对话数，防止刷爆上游额度',
    // ⚠ 这个键语义上偏"防滥用内部策略"，但目录里就是 `isPublic: true`，
    // 且 DB 行会**覆盖**目录的 isPublic（`row?.isPublic ?? definition.isPublic`）——
    // 这里若擅自改成 false，等于顺手改掉 /system/config 的对外字段构成。
    // 保持与目录一致，把"该不该公开"作为一个独立议题留给配置目录去决定。
    isPublic: true,
    isEditable: true,
  },
  {
    key: 'disclaimer.aiContent',
    value: DISCLAIMER_AI_CONTENT,
    valueType: ConfigValueType.STRING,
    group: 'DISCLAIMER',
    description: '所有 AI 生成内容处必须展示的声明（每条 AI 回复内联下发）',
    // 合规文案（架构 1.2 硬约束），必须能被用户端读到 → 公开
    isPublic: true,
    isEditable: true,
  },
  {
    key: 'disclaimer.aiGeneratedNotice',
    value: DISCLAIMER_AI_GENERATED_NOTICE,
    valueType: ConfigValueType.STRING,
    group: 'DISCLAIMER',
    description: 'AI 内容的显式标识（生成式 AI 内容监管要求）',
    isPublic: true,
    isEditable: true,
  },
  {
    key: 'disclaimer.crisisNotice',
    value: DISCLAIMER_CRISIS_NOTICE,
    valueType: ConfigValueType.STRING,
    group: 'DISCLAIMER',
    description: '危险内容拦截与危机资源旁必须展示的文案',
    // 危机场景的转介文案，读不到会让用户拿到一段没有出路的回复 → 必须公开且不得私有化
    isPublic: true,
    isEditable: true,
  },
  {
    key: 'disclaimer.emergencyNotice',
    value: DISCLAIMER_EMERGENCY_NOTICE,
    valueType: ConfigValueType.STRING,
    group: 'DISCLAIMER',
    description: '危机资源块末尾的紧急处置提示',
    isPublic: true,
    isEditable: true,
  },
  {
    key: 'disclaimer.safetyResources',
    value: JSON.stringify(DISCLAIMER_SAFETY_RESOURCES),
    // 数组 → JSON（`loadSafetyResources` 优先用 `entry.value`，它是按 valueType 解析后的结果；
    // 若标成 STRING，解析出来是一整条字符串，`parseSafetyResources` 只能退回手工解析 rawValue）
    valueType: ConfigValueType.JSON,
    group: 'DISCLAIMER',
    description: '心理援助热线清单，与 AI 对话的危险内容拦截同源',
    isPublic: true,
    isEditable: true,
  },
];
