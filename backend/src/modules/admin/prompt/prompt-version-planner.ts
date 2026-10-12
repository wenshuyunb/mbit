/**
 * Prompt 版本状态与流量权重规划（纯函数，可 100% 单测）
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.5.5 / §3.14.5.6（发布与回滚）
 *
 * 为什么单独抽出来：这部分决定「**同一模板同一时刻谁是生效版本**」，
 * 一旦算错，线上线下会长期不一致（后台显示已发布、线上仍走旧版本），
 * 而它本身只依赖整数运算，完全可以用单测钉死边界。
 */

/** 版本状态（与 Prisma `PromptVersionStatus` 对齐） */
export type PromptVersionStatusValue = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

/** AB 测试的权重合计必须为 100 */
export const TOTAL_TRAFFIC_WEIGHT = 100;

/**
 * 版本状态文案（契约 §3.14.5.3 `statusLabel`）
 *
 * `ACTIVE` 且权重不足 100 时说明该版本正在与其他版本分流量 —— 这是运营最需要一眼看到的信息，
 * 因此文案里带上权重。
 */
export const buildVersionStatusLabel = (status: PromptVersionStatusValue, trafficWeight: number): string => {
  switch (status) {
    case 'DRAFT':
      return '草稿';
    case 'ARCHIVED':
      return '已归档';
    case 'ACTIVE':
      return trafficWeight >= TOTAL_TRAFFIC_WEIGHT ? '生效中' : `AB 测试中（${trafficWeight}% 流量）`;
  }
};

/** 参与分配的版本（`trafficWeight` 为当前权重） */
export interface WeightedCandidate {
  versionId: string;
  trafficWeight: number;
}

/**
 * 把剩余的流量按现有权重比例分摊给其他版本
 *
 * 两个必须处理的退化情形：
 *   · 其他版本权重全为 0（新建版本默认 0，是常见中间态）→ **等分**，而不是都留 0：
 *     全 0 会让运行期的加权选择退化成等权随机，与后台显示的分配完全不一致
 *   · 分摊后出现小数 → 用**最大余数法**补齐，保证整数权重之和**恰好**等于 `remaining`
 *     （差 1 就会让「后台显示 100%，线上实际不到 100%」）
 */
export const redistributeTrafficWeights = (
  candidates: readonly WeightedCandidate[],
  remaining: number,
): Map<string, number> => {
  const result = new Map<string, number>();

  if (candidates.length === 0) return result;

  const clampedRemaining = Math.max(0, Math.min(TOTAL_TRAFFIC_WEIGHT, Math.trunc(remaining)));
  const weights = candidates.map((candidate) => Math.max(0, candidate.trafficWeight));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  if (total <= 0) {
    // 等分：余数同样按「靠前优先」补齐，保证总和精确
    const base = Math.floor(clampedRemaining / candidates.length);
    let leftover = clampedRemaining - base * candidates.length;

    for (const candidate of candidates) {
      const extra = leftover > 0 ? 1 : 0;
      leftover -= extra;
      result.set(candidate.versionId, base + extra);
    }

    return result;
  }

  const exact = weights.map((weight) => (clampedRemaining * weight) / total);
  const floors = exact.map((value) => Math.floor(value));
  let assigned = floors.reduce((sum, value) => sum + value, 0);

  /** 余数从大到小分配；余数相同时权重大的先取（结果与查询返回顺序无关） */
  const order = exact
    .map((value, index) => ({ index, fraction: value - floors[index], weight: weights[index] }))
    .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.index - b.index);

  const shares = [...floors];
  let cursor = 0;
  while (assigned < clampedRemaining && cursor < order.length) {
    shares[order[cursor].index] += 1;
    assigned += 1;
    cursor += 1;
  }

  candidates.forEach((candidate, index) => result.set(candidate.versionId, shares[index]));

  return result;
};

/**
 * 发布后的版本状态规划（`FULL` 模式）
 *
 * 契约业务规则 3：完全切换时新版本权重 100，其他 `ACTIVE` 版本归档 ——
 * **保证同一时刻只有一个生效版本**。`archiveOtherActive=false` 的语义是
 * 「保留其他版本但不再分流量」，因此权重置 0 而状态不动（保留其发布历史）。
 */
export const planFullPublish = (input: {
  targetVersionId: string;
  otherActiveVersionIds: readonly string[];
  archiveOtherActive: boolean;
}): {
  activate: { versionId: string; trafficWeight: number };
  others: { versionId: string; trafficWeight: number; archived: boolean }[];
} => ({
  activate: { versionId: input.targetVersionId, trafficWeight: TOTAL_TRAFFIC_WEIGHT },
  others: input.otherActiveVersionIds.map((versionId) => ({
    versionId,
    trafficWeight: 0,
    archived: input.archiveOtherActive,
  })),
});

/**
 * 发布后的版本状态规划（`AB_TEST` 模式）
 *
 * 目标版本拿 `trafficWeight`，其余 `ACTIVE` 版本按比例分摊 `100 - trafficWeight`。
 * 调用方必须保证 `others` 非空：只有一个候选时权重合计无法等于 100，
 * 届时「AB 测试」实质等同于 `FULL`，应让调用方改用 `FULL` 而不是悄悄降级。
 */
export const planAbTestPublish = (input: {
  targetVersionId: string;
  trafficWeight: number;
  others: readonly WeightedCandidate[];
}): {
  activate: { versionId: string; trafficWeight: number };
  others: { versionId: string; trafficWeight: number }[];
} => {
  const targetWeight = Math.max(0, Math.min(TOTAL_TRAFFIC_WEIGHT, Math.trunc(input.trafficWeight)));
  const shares = redistributeTrafficWeights(input.others, TOTAL_TRAFFIC_WEIGHT - targetWeight);

  return {
    activate: { versionId: input.targetVersionId, trafficWeight: targetWeight },
    others: input.others.map((candidate) => ({
      versionId: candidate.versionId,
      trafficWeight: shares.get(candidate.versionId) ?? 0,
    })),
  };
};

/** 灰度回滚保留给「被回滚版本」的对照流量（契约 §3.14.5.6 业务规则 2） */
export const CANARY_TRAFFIC_WEIGHT = 10;
