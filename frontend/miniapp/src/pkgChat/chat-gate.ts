/**
 * AI 管家的会员门槛判定（ADR-038 阶段 5）
 *
 * ## 为什么抽成纯函数
 *
 * 这三种"不能聊"的原因，用户看到的出路**完全不同**：
 *
 * | 场景 | `assistantMembersOnly` | `nextActions.canChat` | 该展示的出路 |
 * | --- | --- | --- | --- |
 * | 免费用户，门槛开着 | `true` | `false` | 开通会员 |
 * | 门槛已关，免费额度用完 | `false` | `false` | 买次数包 / 明天再来 |
 * | 会员，额度充足 | 任意 | `true` | 正常输入 |
 *
 * 把它们混成一句"次数用完了"，免费用户会去等明天（等不来），
 * 会员会以为要再买一次（已经买过了）。判定写在 SFC 的 `computed` 里没法单测，
 * 因此抽到这里，页面只负责渲染。
 *
 * ## 未加载完时**不拦**
 *
 * `quota === null` 一律返回"没被拦"。宁可先让输入框可用（服务端仍会兜底拦），
 * 也不要让老会员每次进页面都闪一下付费墙 —— 那是最容易被投诉的假故障。
 */

import type { AiQuota } from '@/api/chat';

/** 会员门槛是否拦住了当前用户（拦住 → 展示会员引导） */
export const isGateBlocked = (quota: AiQuota | null): boolean => {
  if (!quota) return false;
  return quota.assistantMembersOnly === true && quota.nextActions.canChat === false;
};

/** 是否因额度耗尽而不能聊（门槛未拦，纯粹没次数了） */
export const isQuotaExhausted = (quota: AiQuota | null): boolean => {
  if (!quota || isGateBlocked(quota)) return false;
  return quota.nextActions.canChat === false;
};

/** 当前是否可发消息 */
export const canChatNow = (quota: AiQuota | null): boolean => {
  if (!quota) return true;
  return quota.nextActions.canChat !== false;
};

/** 顶部配额条文案 */
export const quotaTextOf = (quota: AiQuota | null): string => {
  if (isGateBlocked(quota)) return '会员专属功能';
  if (!quota) return '正在读取使用情况…';
  if (quota.nextActions.canChat === false) return '可用次数已用完';

  // `limitedBy === 'NONE'` 表示确实不构成限制（会员不限额或额度充足）
  if (quota.quota.limitedBy === 'NONE') return '对话次数不限';

  return `今日剩余 ${quota.quota.remainingToday} 次对话`;
};
