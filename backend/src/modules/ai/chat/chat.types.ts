/**
 * AI 情感助手 — 类型与常量（契约 §3.7）
 *
 * 本文件只放**契约字面量**与共享类型，不含任何 I/O，因此可以被 DTO、纯函数、
 * Service 与测试同时引用而不引入循环依赖。
 *
 * ## 为什么 mode/tone/includePersona 要挤进 `ai_conversations.scene`
 *
 * schema 里没有这三个字段（见 `chat.types.ts` 末尾的 SCHEMA GAP 说明）。
 * `schema.prisma` 属共享文件、禁止修改，因此复用既有的 `scene VARCHAR(32)`：
 * 它是"这个会话是什么场景"的语义位，与 mode/tone 的语义最接近。
 * 编码形态 `MODE|TONE|0/1` 最长 23 字符（PRACTICE|NEUTRAL|1），不会溢出，
 * 且**只能通过本文件的两个函数**编解码 —— 编码与解码必须成对演进，
 * 否则会出现"写进去读不出来"的脏数据。
 */

/** 会话模式（契约 §3.7.1） */
export const CONVERSATION_MODES = ['COMPANION', 'ANALYSIS', 'PRACTICE'] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];

/** 回复语气（契约 §3.7.1） */
export const CONVERSATION_TONES = ['WARM', 'NEUTRAL', 'DIRECT'] as const;
export type ConversationTone = (typeof CONVERSATION_TONES)[number];

/** 消息角色（与 Prisma `AiMessageRole` 一致） */
export const MESSAGE_ROLES = ['USER', 'ASSISTANT', 'SYSTEM'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** 会话状态（与 Prisma `AiConversationStatus` 一致） */
export const CONVERSATION_STATUSES = ['ACTIVE', 'ARCHIVED', 'DELETED'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** 会话列表排序字段白名单（契约 §3.7.2 `sortBy`） */
export const CONVERSATION_SORT_FIELDS = ['lastMessageAt', 'createdAt'] as const;
export type ConversationSortField = (typeof CONVERSATION_SORT_FIELDS)[number];

/** 排序方向（契约 §3.7.2 `order`） */
export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** 删除模式（契约 §3.7.7 `mode`） */
export const DELETE_MODES = ['DELETE', 'ARCHIVE'] as const;
export type DeleteMode = (typeof DELETE_MODES)[number];

/** 会话模式中文名（契约响应字段 `modeName`） */
export const MODE_NAMES: Readonly<Record<ConversationMode, string>> = {
  COMPANION: '情感陪伴',
  ANALYSIS: '关系分析',
  PRACTICE: '沟通练习',
};

/**
 * `mode` → Prompt 模板键（契约 §3.7.1 业务规则 4）
 *
 * 契约原文：`COMPANION → AI_COMPANION`、`ANALYSIS → RELATIONSHIP_REPORT`（复用
 * 分析型模板）、`PRACTICE → AI_COMPANION`（附加练习指令）。
 *
 * ⚠ **契约键名与库内实际键名不一致**：`prompt_templates.key` 在现网（prisma seed）
 * 只有 `report.mbti` / `report.relationship` 两个，没有任何 `AI_COMPANION`。
 * 这里返回的是**契约键名**（它会出现在响应字段 `promptKey` 里，属于对外契约），
 * 而"契约键名 → 库内键名"的查找在 `chat-prompt.ts` 的 `resolvePromptTemplateKey`
 * 中按候选链完成，并显式报缺失而不是静默回落。
 */
export const PROMPT_KEY_BY_MODE: Readonly<Record<ConversationMode, string>> = {
  COMPANION: 'AI_COMPANION',
  ANALYSIS: 'RELATIONSHIP_REPORT',
  PRACTICE: 'AI_COMPANION',
};

/** 会话模式默认值（契约 §3.7.1） */
export const DEFAULT_MODE: ConversationMode = 'COMPANION';

/** 会话语气默认值（契约 §3.7.1） */
export const DEFAULT_TONE: ConversationTone = 'WARM';

/** 是否注入人格画像默认值（契约 §3.7.1） */
export const DEFAULT_INCLUDE_PERSONA = true;

/** 会话标题长度上限（契约 §3.7.1 `title`：0–30 字符） */
export const MAX_TITLE_LENGTH = 30;

/** 单条用户消息长度上限（契约 §3.7.3 / §3.7.5：1–2000 字符） */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * `contextHints` 允许的取值（契约 §3.7.5 + ADR-038 阶段 5）
 *
 * `ALL_MODULES` 是**管家角色**的入口：把三个模块（人格 / 情感 / 心理状态）的
 * 当前结果各取一小段摘要注入上下文，让助手能"总结你测过的所有东西"并回答
 * 跨模块的问题（例如"我是不是在关系里更容易紧张"要同时用到情感与心理两块数据）。
 *
 * ⚠ 它注入的是**画像与结论**，不是三份报告的全文：
 *   · 心理状态模块**根本没有 AI 报告**（产品红线是不给建议），
 *     它的结论就是 `mental_health_profiles.conclusion` —— 只读报告会漏掉整个模块；
 *   · 报告全文动辄两三千字，三份一起塞进提示词会把对话上下文挤爆，
 *     而管家要的是"知道结论"，不是"复述报告"。
 */
export const CONTEXT_HINTS = ['RECENT_REPORT', 'RECENT_TEST', 'RELATIONSHIP_REPORT', 'ALL_MODULES'] as const;
export type ContextHint = (typeof CONTEXT_HINTS)[number];

/** `contextHints` 最多允许个数（契约 §3.7.5：最多 3 个；ADR-038 阶段 5 因新增 `ALL_MODULES` 提到 4） */
export const MAX_CONTEXT_HINTS = 4;

/** 会话消息数上限（契约 §3.7.5 错误码 `50018`：200 条） */
export const MAX_MESSAGES_PER_CONVERSATION = 200;

/** 会话标题自动生成的截取长度（契约 §3.7.1：取首条消息前 20 字） */
export const AUTO_TITLE_LENGTH = 20;

/** 列表项 `lastMessage.preview` 截取长度（契约 §3.7.2 业务规则 2：60 字） */
export const MESSAGE_PREVIEW_LENGTH = 60;

/**
 * 服务端下发的会话首屏合规提示（契约 §3.7.1 响应字段 `systemNotice`）
 *
 * 契约把这段文案当作**服务端返回值**（前端不得硬编码），并给了逐字示例。
 * 优先读 `system_configs` 的 `ai.systemNotice`（运营可改）；该键**已在**
 * `system-config.catalog.ts` 的 AI 分组中登记，并随种子灌入，因此实际情况是
 * "读到库里的值"，本常量只在库中无该行时兜底。
 *
 * ⚠ 三处文本必须逐字一致（本常量 / 配置目录的 `AI_SYSTEM_NOTICE` / 种子的同名字符串）：
 * 库里一旦有该行就会**取代**兜底值，不一致会出现"代码读的"与"用户看到的"两套文案，
 * 而这段是合规文本。种子侧有一致性单测守着目录与库值，改一处须同步另两处。
 */
export const DEFAULT_SYSTEM_NOTICE =
  '我是 SoulMap 的 AI 情感助手。我可以陪你梳理情绪、理解关系，但我不能提供心理诊断或医疗建议。如果你正经历严重的心理困扰，请寻求专业帮助。';

/** `system_configs` 键：会话首屏合规提示 */
export const CONFIG_KEY_SYSTEM_NOTICE = 'ai.systemNotice';

/** `system_configs` 键：AI 内容免责声明（已有键，见 system-config.catalog.ts） */
export const CONFIG_KEY_DISCLAIMER_AI_CONTENT = 'disclaimer.aiContent';

/** `system_configs` 键：AI 生成标识（已有键） */
export const CONFIG_KEY_AI_GENERATED_NOTICE = 'disclaimer.aiGeneratedNotice';

/** `system_configs` 键：危机提示文案（已有键） */
export const CONFIG_KEY_CRISIS_NOTICE = 'disclaimer.crisisNotice';

/** `system_configs` 键：危机干预资源清单（已有键） */
export const CONFIG_KEY_SAFETY_RESOURCES = 'disclaimer.safetyResources';

/** `system_configs` 键：紧急处置提示（已有键） */
export const CONFIG_KEY_EMERGENCY_NOTICE = 'disclaimer.emergencyNotice';

/** `system_configs` 键：免费用户 AI 总次数（已有键，默认 10） */
export const CONFIG_KEY_FREE_AI_QUOTA = 'freeAiQuotaTotal';

/** `system_configs` 键：会员每日 AI 次数（已有键，默认 50） */
export const CONFIG_KEY_MEMBER_AI_DAILY_LIMIT = 'memberAiDailyLimit';

/** `system_configs` 键：AI 消息长度上限（已有键，默认 2000） */
export const CONFIG_KEY_AI_MESSAGE_MAX_LENGTH = 'aiMessageMaxLength';

/** `system_configs` 键：单用户并发流上限（已有键，默认 3） */
export const CONFIG_KEY_MAX_CONCURRENT_STREAMS = 'ai.maxConcurrentStreams';

/** 免责声明兜底文案（读不到 `system_configs` 时使用，与契约示例逐字一致） */
export const FALLBACK_DISCLAIMER = 'AI 内容由模型生成，仅供自我探索参考，不构成心理诊断或医疗建议。';

/** AI 生成标识兜底文案（与 `disclaimer.aiGeneratedNotice` 的 catalog 默认值一致） */
export const FALLBACK_AI_GENERATED_NOTICE = '本内容由人工智能生成。';

/**
 * 危机提示兜底文案
 *
 * 与 `system-config.catalog.ts` 的 `DISCLAIMER_CRISIS_NOTICE` 默认值保持一致。
 * 内容安全相关文案**必须有兜底**：读不到配置时若降级为"无提示"，
 * 危机场景下用户会拿到一条没有转介资源的回复 —— 这是不可接受的失败模式。
 */
export const FALLBACK_CRISIS_NOTICE =
  '如果你正经历严重的心理困扰或有伤害自己的念头，请立即联系专业热线，或告知身边可信任的人。';

/** 紧急处置提示兜底文案 */
export const FALLBACK_EMERGENCY_NOTICE = '如有紧急危险，请拨打 120 或前往最近的急诊。';

/** 危机干预资源兜底清单（与 `disclaimer.safetyResources` 的 catalog 默认值一致） */
export const FALLBACK_SAFETY_RESOURCES: readonly SafetyResource[] = [
  { name: '全国心理援助热线', phone: '12356', available: '24 小时' },
  { name: '北京心理危机研究与干预中心', phone: '010-82951332', available: '24 小时' },
  { name: '希望 24 热线', phone: '400-161-9995', available: '24 小时' },
];

/** 求助资源条目（契约 §3.7.5 响应字段 `resources[]`） */
export interface SafetyResource {
  readonly name: string;
  readonly phone: string;
  readonly available: string;
}

/**
 * 会话场景编码（`ai_conversations.scene`）
 *
 * 用 `|` 分隔而不是 JSON：JSON 形态（`{"mode":"COMPANION",...}`）会超出 32 字符，
 * 且需要 try/catch 解析 —— 而这里只有三个定长枚举值。
 */
export const encodeScene = (mode: ConversationMode, tone: ConversationTone, includePersona: boolean): string =>
  `${mode}|${tone}|${includePersona ? '1' : '0'}`;

/** 会话场景解码（缺失/脏数据一律回落默认值，绝不抛错打断读取） */
export const decodeScene = (
  scene: string | null,
): { mode: ConversationMode; tone: ConversationTone; includePersona: boolean } => {
  const fallback = { mode: DEFAULT_MODE, tone: DEFAULT_TONE, includePersona: DEFAULT_INCLUDE_PERSONA };
  if (scene === null) return fallback;

  const [rawMode, rawTone, rawPersona] = scene.split('|');

  return {
    mode: isConversationMode(rawMode) ? rawMode : DEFAULT_MODE,
    tone: isConversationTone(rawTone) ? rawTone : DEFAULT_TONE,
    // 只有显式写了 `0` 才算关闭：老数据（如 `MBTI_REPORT` 这类历史 scene）走默认
    includePersona: rawPersona === undefined ? DEFAULT_INCLUDE_PERSONA : rawPersona !== '0',
  };
};

/** 枚举收窄（供 DTO 与解码共用，避免两处各写一份 `includes` 断言） */
export const isConversationMode = (value: unknown): value is ConversationMode =>
  typeof value === 'string' && (CONVERSATION_MODES as readonly string[]).includes(value);

/** 枚举收窄 */
export const isConversationTone = (value: unknown): value is ConversationTone =>
  typeof value === 'string' && (CONVERSATION_TONES as readonly string[]).includes(value);

/** 枚举收窄 */
export const isMessageRole = (value: unknown): value is MessageRole =>
  typeof value === 'string' && (MESSAGE_ROLES as readonly string[]).includes(value);

/** 枚举收窄 */
export const isConversationStatus = (value: unknown): value is ConversationStatus =>
  typeof value === 'string' && (CONVERSATION_STATUSES as readonly string[]).includes(value);

/** 枚举收窄 */
export const isContextHint = (value: unknown): value is ContextHint =>
  typeof value === 'string' && (CONTEXT_HINTS as readonly string[]).includes(value);

/** 模式中文名（未知值原样返回，不猜） */
export const modeNameOf = (mode: string): string => MODE_NAMES[mode as ConversationMode] ?? mode;
