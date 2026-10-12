/**
 * 邀请详情纯逻辑（契约 §3.6.2，无 I/O、可 100% 单测）
 *
 * 契约 §3.6.2 的响应里有一半是**预判**：`canAccept` 与 `blockedReason` 要让前端在
 * 用户点「接受」之前就知道会发生什么。这类判断一旦与 `acceptInvite` 的真实校验
 * 不一致，界面就会出现「按钮可点、点了报错」或「按钮灰着，其实能接受」。
 *
 * 因此判断逻辑集中在这里（纯函数、可单测），而不是散在 Service 的 if 里。
 * 每种 `blockedReason` 与 `acceptInvite` 的对应关系见 `resolveInviteAcceptability`
 * 的注释 —— **哪些是真校验、哪些只是提示**必须写清楚，否则后来者会以为
 * 「`canAccept=true` 就等于一定能接受成功」。
 */

import { MAX_ACTIVE_RELATIONSHIPS } from './relationship-view.util';

/**
 * 不能接受的原因（契约 §3.6.2 规则 2 的枚举）
 *
 * 与契约表逐项对齐，取值一个不差 —— 前端按这些字符串决定展示哪个引导按钮。
 */
export const INVITE_BLOCKED_REASONS = [
  'SELF_INVITE',
  'NO_PROFILE',
  'ALREADY_RELATED',
  'TYPE_MISMATCH',
  'AGE_RESTRICTED',
  'RELATIONSHIP_LIMIT',
] as const;

export type InviteBlockedReason = (typeof INVITE_BLOCKED_REASONS)[number];

/** `blockedReason` 的中文说明（前端可直接展示，也可自行渲染） */
const BLOCKED_REASON_LABELS: Readonly<Record<InviteBlockedReason, string>> = {
  SELF_INVITE: '这是你自己发起的邀请',
  NO_PROFILE: '请先完成人格测评，才能接受邀请',
  ALREADY_RELATED: '你们已经建立了关系，无需重复接受',
  TYPE_MISMATCH: '你已有一段同类关系，请先解除后再接受',
  AGE_RESTRICTED: '该关系类型暂不面向未满 18 周岁用户开放',
  RELATIONSHIP_LIMIT: '你的关系数量已达上限，请先解除部分关系',
};

export const blockedReasonLabel = (reason: InviteBlockedReason): string => BLOCKED_REASON_LABELS[reason];

/** 判定输入 */
export interface InviteAcceptabilityInput {
  /** 邀请是否由当前用户发起 */
  readonly isInviter: boolean;
  /** 当前用户是否已有画像 */
  readonly iHaveProfile: boolean;
  /** 我与邀请人之间是否已存在**未进入终态**的关系 */
  readonly hasExistingRelationship: boolean;
  /**
   * 我已拥有的、与本次邀请**同类型**的未终结关系数（不含与邀请人的那条）
   *
   * `COUPLE` 是单例（一个人同时只能有一段伴侣关系），`FRIEND` / `FAMILY` 可多段。
   */
  readonly sameTypeRelationshipCount: number;
  /** 本次邀请的关系类型 */
  readonly relationType: string;
  /** 我已生效（`ACTIVE`）的关系数 */
  readonly activeRelationshipCount: number;
}

/** 判定结果 */
export interface InviteAcceptability {
  readonly canAccept: boolean;
  readonly blockedReason: InviteBlockedReason | null;
  /** 不可接受时的中文原因（`canAccept` 为 true 时为 `null`） */
  readonly blockedReasonLabel: string | null;
}

/**
 * 判定「能否接受」
 *
 * 判定顺序按**用户可自行解决的先后**排列：自己的误操作（自邀）→ 自己能立刻补
 * 的动作（完成测评）→ 关系现状冲突 → 数量上限。先报「关系已达上限」而真正的问题
 * 是「你还没做测评」，用户会去删除一堆关系却依然接受不了。
 *
 * ## 与 `acceptInvite` 的对应关系（诚实清单，不是猜测）
 *
 * | blockedReason        | `acceptInvite` 是否强制 | 说明                                                 |
 * | -------------------- | ----------------------- | ---------------------------------------------------- |
 * | `SELF_INVITE`        | ✅ 是                   | 抛 `60006`                                           |
 * | `ALREADY_RELATED`    | ✅ 是                   | `pairKey` 唯一约束，抛 `60002`                       |
 * | `NO_PROFILE`         | ⚠️ 部分                 | `acceptInvite` 只校验**邀请人**有画像；本字段说的是 |
 * |                      |                         | 「我没有画像」，因此它是**引导性提示**               |
 * | `TYPE_MISMATCH`      | ❌ 否                   | `acceptInvite` 未做同类型互斥校验（见交付报告）      |
 * | `RELATIONSHIP_LIMIT` | ❌ 否                   | `acceptInvite` 未做数量上限校验                      |
 * | `AGE_RESTRICTED`     | ❌ 否                   | 本项目未实现年龄闸门，**本函数不会返回该值**         |
 *
 * 「❌ 否」的三项刻意只作为**提示**：它们不阻止接受，但能让前端提前引导。
 * 反过来若在这里判定为不可接受、而 `acceptInvite` 仍然放行，就制造了
 * 「界面说不行、接口说行」的矛盾 —— 那比不提示更糟。补齐需要同时改
 * `acceptInvite`（属关系状态机变更，须先补 ADR），不在本次范围内。
 */
export const resolveInviteAcceptability = (input: InviteAcceptabilityInput): InviteAcceptability => {
  const blocked = (reason: InviteBlockedReason): InviteAcceptability => ({
    canAccept: false,
    blockedReason: reason,
    blockedReasonLabel: blockedReasonLabel(reason),
  });

  if (input.isInviter) return blocked('SELF_INVITE');
  if (!input.iHaveProfile) return blocked('NO_PROFILE');
  if (input.hasExistingRelationship) return blocked('ALREADY_RELATED');

  // 只有伴侣关系是单例：同时持有两段 `COUPLE` 在语义上自相矛盾
  if (input.relationType === 'COUPLE' && input.sameTypeRelationshipCount > 0) return blocked('TYPE_MISMATCH');

  if (input.activeRelationshipCount >= MAX_ACTIVE_RELATIONSHIPS) return blocked('RELATIONSHIP_LIMIT');

  return { canAccept: true, blockedReason: null, blockedReasonLabel: null };
};

// ============================================================================
// 引导流程（契约 §3.6.2 的 flow.steps）
// ============================================================================

/** 流程步骤枚举（契约 §3.6.2） */
export const INVITE_FLOW_STEPS = ['VIEW_INVITE', 'COMPLETE_TEST', 'ACCEPT', 'CONFIRM', 'MATCH_REPORT'] as const;

export type InviteFlowStep = (typeof INVITE_FLOW_STEPS)[number];

/** 步骤状态 */
export type InviteFlowStepStatus = 'DONE' | 'CURRENT' | 'PENDING';

const STEP_LABELS: Readonly<Record<InviteFlowStep, string>> = {
  VIEW_INVITE: '查看邀请',
  COMPLETE_TEST: '完成人格测试',
  ACCEPT: '接受邀请',
  CONFIRM: '对方确认',
  MATCH_REPORT: '生成匹配报告',
};

export interface InviteFlowStepView {
  readonly step: InviteFlowStep;
  readonly label: string;
  readonly status: InviteFlowStepStatus;
}

/**
 * 组装引导流程
 *
 * `VIEW_INVITE` 恒为 `DONE`（能拿到这个响应就说明已经看到了）；
 * 后续步骤依据「我有没有画像」「现在能不能接受」推进。
 * 已进入 `CONFIRM` 及之后时不回头把前面的步骤从 `DONE` 改回 `CURRENT` ——
 * 流程条只在前进方向上变化，倒退会让用户以为进度丢了。
 */
export const buildInviteFlow = (params: {
  readonly hasProfile: boolean;
  readonly canAccept: boolean;
  readonly isAccepted: boolean;
  readonly isActive: boolean;
}): readonly InviteFlowStepView[] => {
  const step = (name: InviteFlowStep, status: InviteFlowStepStatus): InviteFlowStepView => ({
    step: name,
    label: STEP_LABELS[name],
    status,
  });

  const completeTest: InviteFlowStepStatus = params.hasProfile ? 'DONE' : 'CURRENT';

  // 还没做测评时，「接受」不是当前步骤，但仍标 `PENDING` 而不是跳过
  const accept: InviteFlowStepStatus = !params.hasProfile
    ? 'PENDING'
    : params.isAccepted
      ? 'DONE'
      : params.canAccept
        ? 'CURRENT'
        : 'PENDING';

  const confirm: InviteFlowStepStatus = params.isActive ? 'DONE' : params.isAccepted ? 'CURRENT' : 'PENDING';
  const matchReport: InviteFlowStepStatus = params.isActive ? 'CURRENT' : 'PENDING';

  return [
    step('VIEW_INVITE', 'DONE'),
    step('COMPLETE_TEST', completeTest),
    step('ACCEPT', accept),
    step('CONFIRM', confirm),
    step('MATCH_REPORT', matchReport),
  ];
};

// ============================================================================
// 剩余有效期
// ============================================================================

/** 剩余有效秒数：已过期为 0，**不返回负数**（前端会直接显示这个数字） */
export const inviteRemainingSeconds = (expiresAt: Date, now: Date): number =>
  Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
