/**
 * 「关系与报告核查」纯逻辑单测
 *
 * 重点断言映射与口径 —— 本站与 `/admin/ai/reports` 数据同源，映射一旦分叉，
 * 两个接口对同一份报告会给出不同的类型/状态，运营排查时无法对账。
 */

import {
  ABNORMAL_REASONS,
  COMPLETED_SESSION_STATUSES,
  DB_TO_TYPE,
  STATUS_TO_DB,
  TYPE_TO_DB,
  daysTogetherOf,
  deriveAbnormalReasons,
  maskNickname,
  relationshipRoleOf,
  reviewStatusOf,
  roundTo,
  safeRatio,
  scoreLevelOf,
  toSafeNumber,
  viralCoefficientOf,
  VIRAL_COEFFICIENT_TARGET,
} from './admin-report.util';

describe('类型与状态映射', () => {
  it('契约类型 → 库内枚举（GROWTH_REPORT 与 COMPATIBILITY_REPORT 是重命名映射）', () => {
    expect(TYPE_TO_DB['MBTI_REPORT']).toBe('MBTI_REPORT');
    expect(TYPE_TO_DB['GROWTH_REPORT']).toBe('GROWTH_SUMMARY');
    expect(TYPE_TO_DB['COMPATIBILITY_REPORT']).toBe('RELATIONSHIP_REPORT');
  });

  it('库内枚举 → 契约类型（反向一致）', () => {
    expect(DB_TO_TYPE['GROWTH_SUMMARY']).toBe('GROWTH_REPORT');
    expect(DB_TO_TYPE['RELATIONSHIP_REPORT']).toBe('COMPATIBILITY_REPORT');
  });

  it('契约状态 PENDING → 库内 QUEUED；PARTIAL 落到 FAILED 由条件补齐', () => {
    expect(STATUS_TO_DB['PENDING']).toBe('QUEUED');
    expect(STATUS_TO_DB['PARTIAL']).toBe('FAILED');
    expect(STATUS_TO_DB['CANCELLED']).toBe('CANCELLED');
  });

  it('「已完成测试」的会话状态口径固定（K 值分母与漏斗依赖它）', () => {
    expect([...COMPLETED_SESSION_STATUSES]).toEqual(['SUBMITTED', 'SCORED', 'REPORT_READY']);
  });
});

describe('scoreLevelOf', () => {
  it('契约示例：78 分 → GOOD', () => {
    expect(scoreLevelOf(78)).toBe('GOOD');
  });

  it('分档边界（阈值属基于示例的推断，已列入交付简报）', () => {
    expect(scoreLevelOf(95)).toBe('EXCELLENT');
    expect(scoreLevelOf(70)).toBe('GOOD');
    expect(scoreLevelOf(69)).toBe('FAIR');
    expect(scoreLevelOf(39)).toBe('VERY_POOR');
  });

  it('无分数返回 null（不猜一个中间值）', () => {
    expect(scoreLevelOf(null)).toBeNull();
  });
});

describe('relationshipRoleOf', () => {
  it('邀请人是 A → A 为 INVITER', () => {
    expect(relationshipRoleOf('user-a', 'user-a')).toEqual({ userA: 'INVITER', userB: 'INVITEE' });
  });

  it('邀请人是 B → B 为 INVITER（A/B 顺序不代表邀请方向）', () => {
    expect(relationshipRoleOf('user-a', 'user-b')).toEqual({ userA: 'INVITEE', userB: 'INVITER' });
  });

  it('没有邀请记录时默认 A 为 INVITER（契约要求该字段非空）', () => {
    expect(relationshipRoleOf('user-a', null)).toEqual({ userA: 'INVITER', userB: 'INVITEE' });
  });
});

describe('daysTogetherOf', () => {
  const now = new Date('2026-02-20T00:00:00.000Z');

  it('从 activatedAt 起算（向下取整）', () => {
    expect(daysTogetherOf(new Date('2026-02-14T00:00:00.000Z'), 'ACTIVE', now)).toBe(6);
  });

  it('未激活或已解除返回 0（「在一起 0 天」比一个无意义的累计天数更诚实）', () => {
    expect(daysTogetherOf(null, 'ACTIVE', now)).toBe(0);
    expect(daysTogetherOf(new Date('2026-02-14T00:00:00.000Z'), 'REMOVED', now)).toBe(0);
  });
});

describe('deriveAbnormalReasons', () => {
  it('正常关系无标记', () => {
    expect(deriveAbnormalReasons({ pairBuildCount: 1, hasReport: true, overallScore: 78 })).toEqual([]);
  });

  it('同一对用户多次建立/解除 → 疑似刷邀请奖励', () => {
    const reasons = deriveAbnormalReasons({ pairBuildCount: 3, hasReport: true, overallScore: 78 });
    expect(reasons).toEqual(['REPEATED_PAIR_BUILD']);
    expect(ABNORMAL_REASONS.REPEATED_PAIR_BUILD).toContain('刷邀请');
  });

  it('有报告但缺综合分 → 数据不完整', () => {
    expect(deriveAbnormalReasons({ pairBuildCount: 1, hasReport: true, overallScore: null })).toEqual([
      'MISSING_SCORE',
    ]);
  });

  it('没有报告时不因缺分数而标记（本来就没有分数）', () => {
    expect(deriveAbnormalReasons({ pairBuildCount: 1, hasReport: false, overallScore: null })).toEqual([]);
  });
});

describe('reviewStatusOf', () => {
  it('已下架（deletedAt 非空）→ REMOVED', () => {
    expect(reviewStatusOf(new Date('2026-02-14T00:00:00.000Z'), false)).toBe('REMOVED');
  });

  it('其余一律 PENDING —— APPROVED / FLAGGED 无持久化字段可依据（缺口已列入简报）', () => {
    expect(reviewStatusOf(null, false)).toBe('PENDING');
    expect(reviewStatusOf(null, true)).toBe('PENDING');
  });
});

describe('viralCoefficientOf（架构 1.4 口径）', () => {
  it('被接受邀请数 ÷ 完成测试用户数（与看板口径一致）', () => {
    expect(viralCoefficientOf(4826, 5745)).toBe(0.84);
  });

  it('完成测试用户为 0 时返回 0（不做除零）', () => {
    expect(viralCoefficientOf(100, 0)).toBe(0);
  });

  it('达标判断阈值 0.8', () => {
    expect(VIRAL_COEFFICIENT_TARGET).toBe(0.8);
  });
});

describe('通用数值与脱敏', () => {
  it('maskNickname 保留首字符', () => {
    expect(maskNickname('小满')).toBe('小*');
    expect(maskNickname('')).toBeNull();
  });

  it('safeRatio 分母为 0 → 0', () => {
    expect(safeRatio(1, 0)).toBe(0);
  });

  it('toSafeNumber 处理 BigInt', () => {
    expect(toSafeNumber(100n)).toBe(100);
    expect(toSafeNumber(null)).toBe(0);
  });

  it('roundTo 保留一位小数（匹配分数均值示例 71.4）', () => {
    expect(roundTo(71.428, 1)).toBe(71.4);
  });
});
