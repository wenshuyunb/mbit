/**
 * 匹配报告纯逻辑（无 I/O、可 100% 单测）
 *
 * 契约 §3.6.8 / §3.6.9；架构 §12.2 的「算分确定性 + AI 只做解读」（ADR-005）。
 */

/**
 * `cacheKey` 的最大长度（`compatibility_reports.cache_key` 是 `VarChar(128)`）
 *
 * ⚠ 必须在**写入前**校验而不是写完让数据库报错：超长会抛 Prisma 底层错误 → 500，
 * 而这类错误只在特定版本号组合下才出现（例如权重版本恰好很长），
 * 上线后很难复现。
 */
export const MAX_CACHE_KEY_LENGTH = 128;

/**
 * 组成 `cacheKey` 的输入
 *
 * 五个因素**缺一不可**，任一变化都必须产生新报告：
 *   · 双方画像（`profileAId` / `profileBId`）—— 换了人当然不同
 *   · 双方画像版本（`profileAVersion` / `profileBVersion`）—— 同一人重测后画像会变
 *   · 权重矩阵版本（`weightsVersion`）—— 后台调权重后旧结果不再适用
 *   · 算分引擎版本（`engineVersion`）—— 算法升级后旧结果不可比
 *
 * 少了画像版本会出现最隐蔽的一类错误：用户重测后仍拿到旧报告，
 * 且因为 `cacheKey` 命中而**永远不会重新计算**。
 */
export interface CompatibilityCacheKeyInput {
  readonly engineVersion: string;
  readonly weightsVersion: string;
  readonly profileAId: string;
  readonly profileAVersion: number;
  readonly profileBId: string;
  readonly profileBVersion: number;
}

/**
 * 生成 `cacheKey`
 *
 * 顺序由**关系行自身的 A/B 顺序**决定，而不是按 UUID 排序：
 * 契约 §3.6.3 明确「A 恒为邀请方、B 恒为接受方（不按 pairKey 排序）」，
 * 算分时也按这个顺序传入。若这里改成排序，`cacheKey` 与算分输入的顺序就会
 * 不一致 —— 同一份缓存键可能对应两次方向相反的算分。
 */
export const buildCompatibilityCacheKey = (input: CompatibilityCacheKeyInput): string => {
  const key = [
    `c${input.engineVersion}`,
    `w${input.weightsVersion}`,
    `${input.profileAId}v${input.profileAVersion}`,
    `${input.profileBId}v${input.profileBVersion}`,
  ].join(':');

  // 抛错而不是截断：截断会让"不同输入"碰撞到同一个键，返回**错误的报告**。
  // 这比直接失败恶劣得多 —— 用户会看到一份不属于自己的匹配结果。
  if (key.length > MAX_CACHE_KEY_LENGTH) {
    throw new Error(
      `匹配报告 cacheKey 长度 ${key.length} 超出上限 ${MAX_CACHE_KEY_LENGTH}，` +
        '请缩短版本号格式（禁止截断：截断会让不同输入碰撞到同一份报告）',
    );
  }

  return key;
};

/** 不能触发算分的原因（与契约 §3.6.4 的枚举一致） */
export type CompatibilityBlockedReason =
  'RELATIONSHIP_NOT_ACTIVE' | 'PARTNER_NO_PROFILE' | 'MY_NO_PROFILE' | 'RELATIONSHIP_NOT_FOUND' | 'ALREADY_GENERATING';

/**
 * 判断能否触发算分
 *
 * 顺序有意义：先判关系状态，再判自己的画像，最后判对方 —— 「我还没测」是
 * 用户自己能立刻解决的问题，应该优先提示；先报「对方没测」会让用户去催对方，
 * 而实际上问题在自己这边。
 */
export const resolveCompatibilityBlocker = (params: {
  status: string;
  iHaveProfile: boolean;
  partnerHasProfile: boolean;
  isGenerating: boolean;
}): CompatibilityBlockedReason | null => {
  if (params.status !== 'ACTIVE') return 'RELATIONSHIP_NOT_ACTIVE';
  if (!params.iHaveProfile) return 'MY_NO_PROFILE';
  if (!params.partnerHasProfile) return 'PARTNER_NO_PROFILE';
  if (params.isGenerating) return 'ALREADY_GENERATING';

  return null;
};

/** 「进行中」的匹配报告状态（用于判断是否已在生成） */
export const ACTIVE_COMPATIBILITY_STATUSES = ['QUEUED', 'COMPUTING', 'GENERATING'] as const;

export const isCompatibilityInProgress = (status: string): boolean =>
  (ACTIVE_COMPATIBILITY_STATUSES as readonly string[]).includes(status);
