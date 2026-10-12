/**
 * 报告重新生成（契约 §3.5.7）的纯逻辑
 *
 * 三件事：
 *   ① 请求枚举与白名单（`tone` / `focus` / `reason`）；
 *   ② 语气与侧重 → **注入 Prompt 的中文短语**（模板里写的是 `内容侧重：{{focus}}`、
 *      `语气偏好：{{tone}}`，直接把枚举值 `CAREER` 塞进去会让模型困惑）；
 *   ③ 新报告的 `cacheKey` 源串 —— 重新生成的**全部意义就是绕过缓存**，
 *      因此必须与旧报告的键不同，且不同次重生成之间也不同。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import { BusinessException } from '../../../common/errors/business.exception';

/** 语气枚举（契约 §3.5.7 请求体） */
export const REGENERATE_TONES = ['WARM', 'NEUTRAL', 'DIRECT'] as const;

export type RegenerateTone = (typeof REGENERATE_TONES)[number];

/** 重新生成原因（契约 §3.5.7 请求体） */
export const REGENERATE_REASONS = ['TONE_CHANGE', 'FOCUS_CHANGE', 'UNSATISFIED', 'QUALITY_ISSUE'] as const;

export type RegenerateReason = (typeof REGENERATE_REASONS)[number];

/**
 * 内容侧重白名单（契约 §3.5.1 的子集，§3.5.7 写「白名单同 3.5.1」）
 *
 * 契约 §3.5.1 的表格里 `CAREER` 被换行截断成 `CAREE\nR`，按请求示例
 * （`{"focus": ["CAREER"]}`）确认为 `CAREER`。
 */
export const REGENERATE_FOCUS_VALUES = ['RELATIONSHIP', 'CAREER', 'EMOTION', 'SELF_GROWTH'] as const;

export type RegenerateFocus = (typeof REGENERATE_FOCUS_VALUES)[number];

/** `focus` 最多 2 个（契约 §3.5.7 约束） */
export const MAX_REGENERATE_FOCUS = 2;

/** `feedback` 长度上限（契约 §3.5.7：0–200 字符） */
export const MAX_REGENERATE_FEEDBACK_LENGTH = 200;

/** 默认语气（契约：`WARM`） */
export const DEFAULT_REGENERATE_TONE: RegenerateTone = 'WARM';

/** 默认原因（契约：`TONE_CHANGE`） */
export const DEFAULT_REGENERATE_REASON: RegenerateReason = 'TONE_CHANGE';

/**
 * 每日重生成上限的兜底值
 *
 * 契约 §3.5.7 规则 2 要求从 `system_config.reportRegenerateDailyLimit` 读取（目录默认值也是 5）。
 * 这个常量只在配置读不到时使用。
 */
export const DEFAULT_REGENERATE_DAILY_LIMIT = 5;

/** 配额窗口（按 UTC 自然日；契约响应示例的 `resetAt` 即次日零点） */
export const REGENERATE_QUOTA_WINDOW = { kind: 'utc-day' } as const;

/** 幂等记录保留时长（秒） */
export const REGENERATE_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** 语气 → 注入 Prompt 的中文短语 */
const TONE_PROMPT_LABELS: Readonly<Record<RegenerateTone, string>> = {
  WARM: '温和、有温度，多给肯定与陪伴感',
  NEUTRAL: '中性、平实，陈述为主，不做情绪铺垫',
  DIRECT: '直接、具体，少铺垫，优先给可执行的结论',
};

/** 侧重 → 注入 Prompt 的中文短语 */
const FOCUS_PROMPT_LABELS: Readonly<Record<RegenerateFocus, string>> = {
  RELATIONSHIP: '关系模式与亲密互动',
  CAREER: '职业发展与工作中的行为模式',
  EMOTION: '情绪体验与内在感受',
  SELF_GROWTH: '自我成长与长期改变',
};

export const describeTone = (tone: RegenerateTone): string => TONE_PROMPT_LABELS[tone];

export const describeFocus = (focus: readonly RegenerateFocus[]): string => {
  if (focus.length === 0) return '均衡覆盖六个板块';

  return focus.map((item) => FOCUS_PROMPT_LABELS[item]).join('、');
};

/** 校验 `focus` 数量与白名单（DTO 层已做枚举校验，这里再拦一次数量越界） */
export const assertFocusWithinLimit = (focus: readonly string[]): void => {
  if (focus.length > MAX_REGENERATE_FOCUS) {
    throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `focus 最多 ${MAX_REGENERATE_FOCUS} 个`, [
      { field: 'focus', issue: 'too_many' },
    ]);
  }
};

/**
 * 新报告的 `cacheKey` 源串
 *
 * 组成：`原 cacheKey | 新版本号 | 语气 | 侧重 | 随机数`
 *
 * · 带上原 cacheKey：让"同一份原报告的多次重生成"共享前缀，便于日后按报告追溯；
 * · 带上版本号与语气/侧重：改变任一参数都应当产出不同内容（否则重生成没有意义）；
 * · **必须带随机数**：`cacheKey` 在 `ai_reports` 上有唯一约束，若只用"原键 + 参数"，
 *   用户连续两次用同样参数重生成会撞唯一键 —— 而"再生成一次"正是最常见的用法。
 *   随机数由调用方生成（`uuidv7()`），保证不同次调用必然不同。
 */
export const regenerationCacheKeySource = (input: {
  originalCacheKey: string;
  version: number;
  tone: RegenerateTone;
  focus: readonly RegenerateFocus[];
  nonce: string;
}): string => [input.originalCacheKey, `v${input.version}`, input.tone, input.focus.join(','), input.nonce].join('|');
