/**
 * 配额纯逻辑单测（契约 §3.7.1 规则 4、§3.7.5 规则 4、§3.7.8 规则 1/3/6）
 *
 * 核心主张：
 *   · **优先级**：会员每日额度 → 次数包 → 免费总额度，`limitedBy` 准确标识来源
 *   · **UTC+8 日界**：`resetAt` 与 `resetInSeconds` 必须自洽（不能按 UTC 零点算，
 *     否则北京时间 20:00 的用户会看到"4 小时后重置"但实际上那时额度没回来）
 *   · **配置解析容错**：`safetyResources` 是 `Json` 列，脏数据不能把整块资源卡打掉
 */

import {
  DEFAULT_HEARTBEAT_MS,
  MAX_CONCURRENT_STREAMS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS,
  nextQuotaResetAt,
  parseSafetyResources,
  resolveQuota,
  secondsUntilReset,
  shanghaiDateKey,
  shanghaiIsoDate,
  toQuotaSummary,
  type DailyQuotaInput,
} from './chat-quota.util';
import { MAX_MESSAGES_PER_CONVERSATION } from './chat.types';

const NOW = new Date('2026-02-14T16:00:00.000Z'); // 北京时间 2026-02-15 00:00

const input = (overrides: Partial<DailyQuotaInput> = {}): DailyQuotaInput => ({
  isMember: false,
  memberDailyLimit: 50,
  usedToday: 0,
  creditBalance: 0,
  freeQuotaTotal: 10,
  freeQuotaUsed: 0,
  fallbackDailyLimit: 50,
  now: NOW,
  ...overrides,
});

describe('UTC+8 日界与重置时刻', () => {
  it('日期键按 UTC+8 计算（UTC 16:00 已是北京时间次日）', () => {
    expect(shanghaiDateKey(new Date('2026-02-14T15:59:59.000Z'))).toBe('20260214');
    expect(shanghaiDateKey(new Date('2026-02-14T16:00:00.000Z'))).toBe('20260215');
    expect(shanghaiIsoDate(new Date('2026-02-14T16:00:00.000Z'))).toBe('2026-02-15');
  });

  it('resetAt 是"UTC+8 次日零点"对应的 UTC 时刻', () => {
    expect(nextQuotaResetAt(new Date('2026-02-14T16:00:00.000Z')).toISOString()).toBe('2026-02-15T16:00:00.000Z');
    expect(nextQuotaResetAt(new Date('2026-02-14T10:00:00.000Z')).toISOString()).toBe('2026-02-14T16:00:00.000Z');
  });

  it('resetInSeconds 与 resetAt 自洽（相差不超过 1 秒）', () => {
    const now = new Date('2026-02-14T10:00:00.000Z');

    expect(secondsUntilReset(now)).toBe(6 * 60 * 60);
    expect(secondsUntilReset(now)).toBe(Math.round((nextQuotaResetAt(now).getTime() - now.getTime()) / 1000));
  });
});

describe('resolveQuota — 配额优先级', () => {
  it('会员：日额度优先，remainingToday = 日额度 − 已用', () => {
    const quota = resolveQuota(input({ isMember: true, usedToday: 3, memberDailyLimit: 50, creditBalance: 30 }));

    expect(quota.hasQuota).toBe(true);
    expect(quota.limitedBy).toBe('DAILY_LIMIT');
    expect(quota.dailyLimit).toBe(50);
    expect(quota.usedToday).toBe(3);
    expect(quota.remainingToday).toBe(47);
    expect(quota.creditBalance).toBe(30);
  });

  it('会员日额度用尽 → 落到次数包（不能因为会员身份就直接拒绝）', () => {
    const quota = resolveQuota(input({ isMember: true, usedToday: 50, memberDailyLimit: 50, creditBalance: 5 }));

    expect(quota.hasQuota).toBe(true);
    expect(quota.limitedBy).toBe('CREDITS');
    expect(quota.remainingToday).toBe(0);
    expect(quota.creditBalance).toBe(5);
  });

  it('免费用户：走总剩余额度，remainingToday 即总剩余', () => {
    const quota = resolveQuota(input({ freeQuotaTotal: 10, freeQuotaUsed: 4 }));

    expect(quota.hasQuota).toBe(true);
    expect(quota.limitedBy).toBe('FREE_QUOTA');
    expect(quota.remainingToday).toBe(6);
    expect(quota.dailyLimit).toBe(10);
    expect(quota.usedToday).toBe(4);
  });

  it('免费用户总额度用尽且有次数包 → 优先用次数包', () => {
    const quota = resolveQuota(input({ freeQuotaTotal: 10, freeQuotaUsed: 10, creditBalance: 3 }));

    expect(quota.hasQuota).toBe(true);
    expect(quota.limitedBy).toBe('CREDITS');
  });

  it('全部耗尽 → hasQuota = false 且 limitedBy 指向最贴近用户的来源', () => {
    const nonMember = resolveQuota(input({ freeQuotaTotal: 10, freeQuotaUsed: 10, creditBalance: 0 }));
    expect(nonMember.hasQuota).toBe(false);
    expect(nonMember.limitedBy).toBe('FREE_QUOTA');
    expect(nonMember.freeQuota.exhausted).toBe(true);

    const member = resolveQuota(input({ isMember: true, usedToday: 50, memberDailyLimit: 50, creditBalance: 0 }));
    expect(member.hasQuota).toBe(false);
    expect(member.limitedBy).toBe('DAILY_LIMIT');
  });

  it('会员日额度配置为 0 时视为"不限额"（不返回 MAX_SAFE_INTEGER 这类会吓到前端的数）', () => {
    const quota = resolveQuota(input({ isMember: true, memberDailyLimit: 0, fallbackDailyLimit: 0, usedToday: 12 }));

    expect(quota.hasQuota).toBe(true);
    expect(quota.limitedBy).toBe('DAILY_LIMIT');
    expect(quota.dailyLimit).toBe(0);
    expect(quota.remainingToday).toBe(0);
  });

  it('会员额度读不到时回落到 MembershipPlan.dailyAiQuota', () => {
    const quota = resolveQuota(input({ isMember: true, memberDailyLimit: 0, fallbackDailyLimit: 50, usedToday: 2 }));

    expect(quota.dailyLimit).toBe(50);
    expect(quota.remainingToday).toBe(48);
  });

  it('免费用户看到的是总剩余，因此不返回"每日"语义的 dailyLimit = 50', () => {
    const quota = resolveQuota(input({ freeQuotaTotal: 10, freeQuotaUsed: 0 }));

    expect(quota.dailyLimit).toBe(10);
  });
});

describe('toQuotaSummary', () => {
  it('plan 反映当前靠什么支撑额度', () => {
    const member = resolveQuota(input({ isMember: true, usedToday: 1 }));
    const credits = resolveQuota(input({ creditBalance: 5, freeQuotaUsed: 10, freeQuotaTotal: 10 }));

    expect(toQuotaSummary(member, true).plan).toBe('MEMBERSHIP_ACTIVE');
    expect(toQuotaSummary(credits, false).plan).toBe('AI_CREDITS');
    expect(toQuotaSummary(credits, false).resetAt).toBe('2026-02-15T16:00:00.000Z');
  });
});

describe('parseSafetyResources', () => {
  it('解析合法清单', () => {
    const parsed = parseSafetyResources([{ name: '热线', phone: '12356', available: '24 小时' }]);

    expect(parsed).toEqual([{ name: '热线', phone: '12356', available: '24 小时' }]);
  });

  it('丢弃非法项而不是整体失败（一条脏数据不该让资源卡消失）', () => {
    const parsed = parseSafetyResources([
      { name: '热线', phone: '12356' },
      'garbage',
      { name: '', phone: '123' },
      { name: '无电话', phone: 42 },
      null,
    ]);

    expect(parsed).toHaveLength(1);
    // `available` 缺失时给默认值，避免前端渲染出 "undefined"
    expect(parsed[0]?.available).toBe('24 小时');
  });

  it('非数组输入返回空数组', () => {
    expect(parseSafetyResources(null)).toEqual([]);
    expect(parseSafetyResources({})).toEqual([]);
  });
});

describe('契约静态限额常量', () => {
  it('与契约 §3.7 逐条一致', () => {
    expect(RATE_LIMIT_MAX_REQUESTS).toBe(10);
    expect(RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(MAX_CONCURRENT_STREAMS).toBe(3);
    expect(MAX_MESSAGES_PER_CONVERSATION).toBe(200);
    expect(DEFAULT_HEARTBEAT_MS).toBe(15_000);
  });
});
