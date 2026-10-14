/**
 * 管理端「关系与报告核查」纯逻辑（无 I/O、可单测）
 *
 * ## 与 `ai-stats` 模块的关系
 *
 * `ai-stats` 的 `/admin/ai/reports` 与本站的 `/admin/reports` **数据同源、视图不同**
 * （契约 §3.14.8.2 明确说明）：前者偏 AI 成本与效率，后者偏内容治理。
 * 两者的类型/状态映射规则必须一致，因此映射常量在此**再声明一份并附一致性说明** ——
 * 刻意不做跨目录 import：`report` 目录不应依赖 `ai-stats` 目录的内部实现
 * （否则「AI 统计模块被删除」会让内容治理接口编译失败）。
 */

/** 契约报告类型 → 库内 `AiReportType` */
export const TYPE_TO_DB: Readonly<Record<string, string>> = {
  MBTI_REPORT: 'MBTI_REPORT',
  BIG_FIVE_REPORT: 'BIG_FIVE_REPORT',
  GROWTH_REPORT: 'GROWTH_SUMMARY',
  COMPATIBILITY_REPORT: 'RELATIONSHIP_REPORT',
  // ADR-038 阶段 3。⚠ 与 `admin/ai-stats/admin-ai-report.service.ts` 里的同名映射
  // 必须逐字一致（加上两处白名单，共四处），漏改不会有任何报错
  EMOTION_REPORT: 'EMOTION_REPORT',
};

/** 库内类型 → 契约类型 */
export const DB_TO_TYPE: Readonly<Record<string, string>> = {
  MBTI_REPORT: 'MBTI_REPORT',
  BIG_FIVE_REPORT: 'BIG_FIVE_REPORT',
  GROWTH_SUMMARY: 'GROWTH_REPORT',
  RELATIONSHIP_REPORT: 'COMPATIBILITY_REPORT',
  EMOTION_REPORT: 'EMOTION_REPORT',
};

/** 契约状态 → 库内 `AiReportStatus`（`PARTIAL` 以条件表达，不是独立成员） */
export const STATUS_TO_DB: Readonly<Record<string, string>> = {
  PENDING: 'QUEUED',
  GENERATING: 'GENERATING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PARTIAL: 'FAILED',
};

/** 解锁判定用的权益状态（`CONSUMED` 仍视为已解锁） */
export const UNLOCKED_ENTITLEMENT_STATUSES = ['ACTIVE', 'CONSUMED'] as const;

/** 「已完成测试」的会话状态（用于 K 值分母与漏斗口径） */
export const COMPLETED_SESSION_STATUSES = ['SUBMITTED', 'SCORED', 'REPORT_READY'] as const;

/**
 * 昵称掩码：**统一由公共脱敏工具提供**（`common/utils/mask.util.ts`），此处仅再导出
 *
 * 该实现原先在本模块、`order`、`ai-stats` 各存一份（口径还不一致）。
 * 脱敏是有合规含义的规则，复制多份必然漂移，故收敛到单一实现。
 */
export { maskNickname } from '../../../common/utils/mask.util';

/**
 * 匹配分数等级
 *
 * ⚠ 契约 §3.14.8.1 的 `scoreLevel`（示例 `GOOD` = 78 分）**没有给出分档阈值**。
 * 这里按「70–84 GOOD」等常见五档实现，属于**基于示例的推断**，已列入交付简报；
 * 若产品侧另有分档表，只需改这一个函数。
 */
export const scoreLevelOf = (score: number | null): string | null => {
  if (score === null) return null;
  if (score >= 90) return 'EXCELLENT';
  if (score >= 70) return 'GOOD';
  if (score >= 55) return 'FAIR';
  if (score >= 40) return 'POOR';
  return 'VERY_POOR';
};

/** 关系角色（契约 §3.14.8.1 的 `userA.role` / `userB.role`） */
export const relationshipRoleOf = (
  userAId: string,
  inviterId: string | null,
): { userA: 'INVITER' | 'INVITEE'; userB: 'INVITER' | 'INVITEE' } => {
  // 没有邀请记录时（历史数据或后台直建）默认 A 为 INVITER：
  // 契约要求该字段非空，而「未知」比「猜错的 A/B」更难排查
  if (inviterId === null) return { userA: 'INVITER', userB: 'INVITEE' };
  return userAId === inviterId ? { userA: 'INVITER', userB: 'INVITEE' } : { userA: 'INVITEE', userB: 'INVITER' };
};

/** 关系存续天数（从 `activatedAt` 起算；未激活或已解除返回 0） */
export const daysTogetherOf = (activatedAt: Date | null, status: string, now: Date): number => {
  if (activatedAt === null) return 0;
  if (status !== 'ACTIVE') return 0;
  return Math.max(0, Math.floor((now.getTime() - activatedAt.getTime()) / 86_400_000));
};

/** 异常关系标记（`relationships` 表没有风控标记列，这里做读时推导） */
export const ABNORMAL_REASONS = {
  REPEATED_PAIR_BUILD: '同一对用户存在多次建立/解除记录，疑似刷邀请奖励',
  MISSING_SCORE: '已有匹配报告但缺少综合分，数据不完整',
} as const;
export type AbnormalReason = keyof typeof ABNORMAL_REASONS;

/** 异常判定输入 */
export interface RelationshipAbnormalInput {
  readonly pairBuildCount: number;
  readonly hasReport: boolean;
  readonly overallScore: number | null;
}

/**
 * 推导异常标记
 *
 * ⚠ 契约 §3.14.8.1 规则 3 说明 `isAbnormal`「来自风控任务」，但
 * `relationships` 表**没有**对应列（schema 不可改）。这里退化为两条可读时判定的规则，
 * 真正的风控结论（邀请码异常高频使用、刷奖励行为）无法在读取时算出。
 */
export const deriveAbnormalReasons = (input: RelationshipAbnormalInput): AbnormalReason[] => {
  const reasons: AbnormalReason[] = [];

  if (input.pairBuildCount > 1) reasons.push('REPEATED_PAIR_BUILD');
  if (input.hasReport && input.overallScore === null) reasons.push('MISSING_SCORE');

  return reasons;
};

/** 内容审核状态推导（契约 §3.14.8.2 的 `reviewStatus`） */
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'FLAGGED' | 'REMOVED';

/**
 * 推导内容审核状态
 *
 * ⚠⚠ 契约 §3.14.8.2 规则 1/4 描述的审核流转（`PENDING → APPROVED / FLAGGED / REMOVED`）
 * 依赖 `POST /admin/reports/{id}/review` 流程与持久化字段，但：
 *   · 当前 schema **没有** `review_status` / `review_note` 列，也没有单独的审核表
 *   · 该审核写接口不在本任务范围内
 * 因此只能从既有字段做**部分**推导：`deletedAt != null` → `REMOVED`，
 * 其余一律 `PENDING`。`APPROVED` / `FLAGGED` 无法表达，按 `reviewStatus` 过滤这两个值
 * 会返回空集 —— 这是数据模型缺口，不是实现遗漏（已列入交付简报）。
 */
export const reviewStatusOf = (deletedAt: Date | null, safetyFlagged: boolean): ReviewStatus => {
  if (deletedAt !== null) return 'REMOVED';
  // 安全标记只作为「待处理」线索：契约把 FLAGGED 定义为「标记待处理（含用户举报）」，
  // 而用户举报没有落库，仅有安全拦截记录不足以构成人工标记
  void safetyFlagged;
  return 'PENDING';
};

/**
 * 邀请裂变系数 K 的达标目标值（架构 §1.4 北极星副指标：**K ≥ 0.8**）
 *
 * 定义放在纯逻辑层而不是 DTO 层：它和 `viralCoefficientOf` 是同一个口径的两半
 * （算 K 与判 K 是否达标），契约 §3.14.8.1 的 `kTarget` / `isKOnTarget`
 * 都直接引用它。DTO 只承载入参校验，不该成为业务阈值的唯一定义处。
 */
export const VIRAL_COEFFICIENT_TARGET = 0.8;

/**
 * 邀请裂变系数 K
 *
 * 口径统一为架构 §1.4 的定义：**被接受的有效邀请数 ÷ 完成测试用户数**
 * （而非「每个邀请者发出的邀请数」）。同一个 K 在 `/admin/relationships` 与
 * `/admin/dashboard/metrics` 两处出现，若口径不同会让运营无法对账。
 */
export const viralCoefficientOf = (acceptedInvites: number, completedTestUsers: number): number => {
  if (completedTestUsers <= 0) return 0;
  return roundTo(acceptedInvites / completedTestUsers, 4);
};

/** 四舍五入到指定小数位 */
export const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 比率（分母 ≤ 0 返回 0 —— 而不是 NaN，NaN 会被序列化成 null） */
export const safeRatio = (numerator: number, denominator: number, digits = 4): number => {
  if (denominator <= 0) return 0;
  return roundTo(numerator / denominator, digits);
};

/** int8（Prisma 的 BigInt）→ number，防止 BigInt 进入响应体导致 JSON 序列化抛错 */
export const toSafeNumber = (value: bigint | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(value);
};
