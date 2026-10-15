/**
 * AI 管家会员门槛判定测试（ADR-038 阶段 5）
 *
 * 这里锁的是**三种"不能聊"必须走三条不同的出路**：
 * 把"会员专属"渲染成"剩余 0 次"，免费用户会去等明天（等不来）；
 * 把"次数用完"渲染成"会员专属"，已付费的会员会以为要再买一次。
 * 两者的区别只体现在 `assistantMembersOnly` 这一个字段上，
 * 而它来自服务端配置（`ai.assistantMembersOnly`），随时可能被关掉。
 */

import { describe, expect, it } from 'vitest';

import { canChatNow, isGateBlocked, isQuotaExhausted, quotaTextOf } from '@/pkgChat/chat-gate';
import type { AiQuota } from '@/api/chat';

const buildQuota = (overrides: {
  assistantMembersOnly?: boolean;
  canChat?: boolean;
  limitedBy?: string;
  remainingToday?: number;
  isMember?: boolean;
}): AiQuota => {
  const {
    assistantMembersOnly = true,
    canChat = false,
    limitedBy = 'FREE_QUOTA',
    remainingToday = 0,
    isMember = false,
  } = overrides;

  return {
    plan: {
      type: isMember ? 'MEMBERSHIP_ACTIVE' : 'FREE',
      planCode: isMember ? 'MEMBER_MONTHLY' : null,
      planName: isMember ? '月度会员' : null,
      isActive: isMember,
      expiresAt: null,
      remainingDays: null,
      benefits: {
        aiDailyLimit: 0,
        unlimitedReports: false,
        reportRegenerateDailyLimit: 0,
        pdfExportUnlimited: false,
        compatibilityReportIncluded: false,
      },
    },
    quota: {
      hasQuota: canChat,
      limitedBy,
      remainingToday,
      dailyLimit: 0,
      usedToday: 0,
      resetAt: '',
      creditBalance: 0,
      freeQuota: { totalLimit: 0, used: 0, remaining: 0, exhausted: false },
    },
    exhausted: !canChat,
    nextActions: { canChat, upgradeUrl: '', creditsUrl: '', reason: canChat ? null : 'MEMBERSHIP_REQUIRED' },
    assistantMembersOnly,
  };
};

describe('isGateBlocked：会员门槛判定', () => {
  it('门槛开着 + 免费用户 → 被拦（走会员引导）', () => {
    expect(isGateBlocked(buildQuota({ assistantMembersOnly: true, canChat: false }))).toBe(true);
  });

  it('门槛关掉 + 免费用户没次数 → 不算被门槛拦（走次数用完）', () => {
    expect(isGateBlocked(buildQuota({ assistantMembersOnly: false, canChat: false }))).toBe(false);
  });

  it('会员额度充足 → 没被拦', () => {
    expect(
      isGateBlocked(
        buildQuota({ assistantMembersOnly: true, canChat: true, isMember: true, limitedBy: 'DAILY_LIMIT' }),
      ),
    ).toBe(false);
  });

  it('配额未加载完（null）不拦 —— 否则老会员每次进页面闪一下付费墙', () => {
    expect(isGateBlocked(null)).toBe(false);
    expect(canChatNow(null)).toBe(true);
  });
});

describe('isQuotaExhausted：与会员门槛互斥', () => {
  it('被门槛拦住时不算"次数用完"（否则文案会指错路）', () => {
    expect(isQuotaExhausted(buildQuota({ assistantMembersOnly: true, canChat: false }))).toBe(false);
  });

  it('门槛关掉且没次数时才是"次数用完"', () => {
    expect(isQuotaExhausted(buildQuota({ assistantMembersOnly: false, canChat: false }))).toBe(true);
  });

  it('有额度时都不是', () => {
    const available = buildQuota({ assistantMembersOnly: false, canChat: true, remainingToday: 3 });
    expect(isQuotaExhausted(available)).toBe(false);
    expect(isGateBlocked(available)).toBe(false);
    expect(canChatNow(available)).toBe(true);
  });
});

describe('quotaTextOf：顶部配额条文案', () => {
  it('被门槛拦住时写"会员专属功能"，绝不写"剩余 0 次"', () => {
    const text = quotaTextOf(buildQuota({ assistantMembersOnly: true, canChat: false }));

    expect(text).toBe('会员专属功能');
    expect(text).not.toContain('剩余');
  });

  it('门槛关掉且次数用完时写"可用次数已用完"', () => {
    expect(quotaTextOf(buildQuota({ assistantMembersOnly: false, canChat: false }))).toBe('可用次数已用完');
  });

  it('limitedBy = NONE 表示确实不构成限制，写"不限"而不是"剩余 0 次"', () => {
    expect(
      quotaTextOf(buildQuota({ assistantMembersOnly: false, canChat: true, limitedBy: 'NONE', isMember: true })),
    ).toBe('对话次数不限');
  });

  it('有额度时展示剩余次数', () => {
    expect(
      quotaTextOf(
        buildQuota({
          assistantMembersOnly: false,
          canChat: true,
          limitedBy: 'DAILY_LIMIT',
          remainingToday: 7,
          isMember: true,
        }),
      ),
    ).toBe('今日剩余 7 次对话');
  });

  it('未加载完时给出"正在读取"，不是空字符串', () => {
    expect(quotaTextOf(null)).toBe('正在读取使用情况…');
  });
});
