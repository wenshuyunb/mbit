/**
 * 邀请详情测试（契约 §3.6.2）
 *
 * 三组最重要的主张：
 *   · **不泄露敏感信息**：响应里的 `inviter` 只有公开字段（契约规则 1），
 *     手机号密文 / openid / 大五分数既不在 DTO 里、也不在查询里
 *   · **自邀仍返回 200**（契约错误码表：`60004` 只在接受时拒绝）
 *   · **已被我自己接受的邀请返回 200 + 关系 ID**；被他人接受返回 409 且
 *     不透露接受者是谁 —— 否则这个接口就成了"凭邀请码查他人关系"的入口
 */

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ErrorCode } from '../../common/errors/error-code';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import {
  buildInviteFlow,
  inviteRemainingSeconds,
  resolveInviteAcceptability,
  type InviteAcceptabilityInput,
} from './invite-view.util';
import { RelationshipController } from './relationship.controller';
import { RelationshipService } from './relationship.service';
import type { CompatibilityService } from './compatibility.service';

const ME = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';
const INVITER = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const CODE = 'K7M2XQ9V';
const INVITE_ID = '0195f3a2-cb20-7d86-9e97-5a6b7c8d9e0a';
const RELATIONSHIP_ID = '0195f3a2-d46a-7ca8-8d13-9fca6d7e8b67';

// ============================================================================
// 纯逻辑：可接受性
// ============================================================================

const acceptabilityInput = (overrides: Partial<InviteAcceptabilityInput> = {}): InviteAcceptabilityInput => ({
  isInviter: false,
  iHaveProfile: true,
  hasExistingRelationship: false,
  sameTypeRelationshipCount: 0,
  relationType: 'COUPLE',
  activeRelationshipCount: 0,
  ...overrides,
});

describe('resolveInviteAcceptability（契约 §3.6.2 规则 2）', () => {
  it('一切正常时 canAccept = true', () => {
    expect(resolveInviteAcceptability(acceptabilityInput())).toEqual({
      canAccept: true,
      blockedReason: null,
      blockedReasonLabel: null,
    });
  });

  it('判定顺序：自邀 → 无画像 → 已有关系 → 类型冲突 → 数量上限', () => {
    // 同时满足多个条件时，先报用户自己最该先处理的那个
    expect(
      resolveInviteAcceptability(
        acceptabilityInput({
          isInviter: true,
          iHaveProfile: false,
          hasExistingRelationship: true,
          activeRelationshipCount: 99,
        }),
      ).blockedReason,
    ).toBe('SELF_INVITE');

    expect(
      resolveInviteAcceptability(
        acceptabilityInput({ iHaveProfile: false, hasExistingRelationship: true, activeRelationshipCount: 99 }),
      ).blockedReason,
    ).toBe('NO_PROFILE');

    expect(
      resolveInviteAcceptability(acceptabilityInput({ hasExistingRelationship: true, activeRelationshipCount: 99 }))
        .blockedReason,
    ).toBe('ALREADY_RELATED');
  });

  it('COUPLE 是单例：已有一段伴侣关系时 TYPE_MISMATCH', () => {
    expect(resolveInviteAcceptability(acceptabilityInput({ sameTypeRelationshipCount: 1 })).blockedReason).toBe(
      'TYPE_MISMATCH',
    );
  });

  it('FRIEND / FAMILY 可多段：不因同类型而冲突', () => {
    for (const relationType of ['FRIEND', 'FAMILY']) {
      expect(resolveInviteAcceptability(acceptabilityInput({ relationType, sameTypeRelationshipCount: 3 }))).toEqual(
        expect.objectContaining({ canAccept: true }),
      );
    }
  });

  it('关系数达到上限（20）时 RELATIONSHIP_LIMIT', () => {
    expect(resolveInviteAcceptability(acceptabilityInput({ activeRelationshipCount: 20 })).blockedReason).toBe(
      'RELATIONSHIP_LIMIT',
    );
    expect(resolveInviteAcceptability(acceptabilityInput({ activeRelationshipCount: 19 })).canAccept).toBe(true);
  });

  it('不可接受时给出中文原因，可接受时为 null', () => {
    const blocked = resolveInviteAcceptability(acceptabilityInput({ isInviter: true }));

    expect(blocked.blockedReasonLabel).toBe('这是你自己发起的邀请');
    expect(resolveInviteAcceptability(acceptabilityInput()).blockedReasonLabel).toBeNull();
  });

  it('【关键】不会返回 AGE_RESTRICTED（本项目未实现年龄闸门，见 util 注释）', () => {
    // 该值在契约枚举里存在，但本项目没有可用的判定依据；
    // 若这里"猜"一个年龄限制，会出现「引导页说不行、accept 接口却放行」的矛盾
    const allReasons = new Set(
      [
        acceptabilityInput({ isInviter: true }),
        acceptabilityInput({ iHaveProfile: false }),
        acceptabilityInput({ hasExistingRelationship: true }),
        acceptabilityInput({ sameTypeRelationshipCount: 1 }),
        acceptabilityInput({ activeRelationshipCount: 20 }),
      ].map((input) => resolveInviteAcceptability(input).blockedReason),
    );

    expect(allReasons.has('AGE_RESTRICTED')).toBe(false);
  });
});

describe('buildInviteFlow（契约 §3.6.2 的 flow.steps）', () => {
  it('五个步骤、中文标签与契约一致', () => {
    const steps = buildInviteFlow({ hasProfile: true, canAccept: true, isAccepted: false, isActive: false });

    expect(steps.map((step) => step.step)).toEqual([
      'VIEW_INVITE',
      'COMPLETE_TEST',
      'ACCEPT',
      'CONFIRM',
      'MATCH_REPORT',
    ]);
    expect(steps[0]).toEqual({ step: 'VIEW_INVITE', label: '查看邀请', status: 'DONE' });
  });

  it('未完成测评时「完成人格测试」是当前步骤，「接受」尚未开始', () => {
    const steps = buildInviteFlow({ hasProfile: false, canAccept: false, isAccepted: false, isActive: false });

    expect(steps[1]?.status).toBe('CURRENT');
    expect(steps[2]?.status).toBe('PENDING');
  });

  it('可以接受时「接受邀请」是当前步骤', () => {
    const steps = buildInviteFlow({ hasProfile: true, canAccept: true, isAccepted: false, isActive: false });

    expect(steps[2]?.status).toBe('CURRENT');
    expect(steps[3]?.status).toBe('PENDING');
  });

  it('已接受待确认 / 已生效时流程前进且不倒退', () => {
    const accepted = buildInviteFlow({ hasProfile: true, canAccept: false, isAccepted: true, isActive: false });

    expect(accepted[1]?.status).toBe('DONE');
    expect(accepted[2]?.status).toBe('DONE');
    expect(accepted[3]?.status).toBe('CURRENT');

    const active = buildInviteFlow({ hasProfile: true, canAccept: false, isAccepted: true, isActive: true });

    expect(active[3]?.status).toBe('DONE');
    expect(active[4]?.status).toBe('CURRENT');
  });
});

describe('inviteRemainingSeconds', () => {
  it('未过期为正数，已过期为 0（不返回负数）', () => {
    const now = new Date('2026-02-14T14:36:40.000Z');

    expect(inviteRemainingSeconds(new Date('2026-02-21T14:35:00.000Z'), now)).toBe(604700);
    expect(inviteRemainingSeconds(new Date('2026-02-01T00:00:00.000Z'), now)).toBe(0);
  });
});

// ============================================================================
// 服务：getInviteDetail
// ============================================================================

interface Harness {
  service: RelationshipService;
  prisma: {
    relationshipInvite: { findFirst: jest.Mock };
    relationship: { findFirst: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
    user: { findUnique: jest.Mock };
    personalityProfile: { findFirst: jest.Mock };
    testDefinition: { findFirst: jest.Mock };
  };
}

const inviteRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: INVITE_ID,
  code: CODE,
  inviterId: INVITER,
  inviteeId: null,
  relationType: 'COUPLE',
  status: 'PENDING',
  message: '一起做个人格测试吧，很好奇我们合不合拍',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  relationshipId: null,
  createdAt: new Date('2026-02-14T14:35:00.000Z'),
  ...overrides,
});

const createHarness = (invite: Record<string, unknown> = inviteRow()): Harness => {
  const prisma = {
    relationshipInvite: { findFirst: jest.fn().mockResolvedValue(invite) },
    relationship: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ id: RELATIONSHIP_ID, status: 'PENDING_A_CONFIRM' }),
      count: jest.fn().mockResolvedValue(0),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: INVITER,
        nickname: '小满',
        avatarUrl: 'https://cdn.example.com/a.webp',
      }),
    },
    personalityProfile: {
      findFirst: jest.fn().mockResolvedValue({ mbtiType: 'INTJ', version: 2 }),
    },
    testDefinition: { findFirst: jest.fn().mockResolvedValue({ code: 'MBTI_LITE' }) },
  };

  const service = new RelationshipService(
    prisma as unknown as PrismaService,
    { key: jest.fn(), set: jest.fn() } as unknown as RedisService,
    { requestCompatibility: jest.fn() } as unknown as CompatibilityService,
  );

  return { service, prisma };
};

describe('RelationshipService.getInviteDetail', () => {
  it('【关键】只返回邀请人的公开资料（不含手机号 / openid / 画像明细）', async () => {
    const harness = createHarness();

    const view = await harness.service.getInviteDetail(ME, CODE);

    // 字段集合本身就是断言：多一个字段就说明有人往 select 或 DTO 里加了东西
    expect(Object.keys(view.inviter).sort()).toEqual(
      ['avatarUrl', 'mbtiType', 'nickname', 'profileVersion', 'typeName', 'userId'].sort(),
    );
    expect(view.inviter).toEqual({
      userId: INVITER,
      nickname: '小满',
      avatarUrl: 'https://cdn.example.com/a.webp',
      mbtiType: 'INTJ',
      // `INTJ` 是种子数据里的人格类型，中文名应能查到
      typeName: expect.any(String),
      profileVersion: 2,
    });
    const serialized = JSON.stringify(view);
    for (const forbidden of ['phone', 'openid', 'openId', 'sessionKey', 'unionid', 'bigFive', 'neuroticism']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('查询用户时只 select 公开字段（从源头杜绝泄露）', async () => {
    const harness = createHarness();

    await harness.service.getInviteDetail(ME, CODE);

    expect(harness.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: INVITER },
      select: { id: true, nickname: true, avatarUrl: true },
    });
  });

  it('小写 / 带分隔符的邀请码同样能被解析（大小写不敏感）', async () => {
    const harness = createHarness();

    await harness.service.getInviteDetail(ME, 'k7m2-xq9v');

    expect(harness.prisma.relationshipInvite.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: CODE, deletedAt: null } }),
    );
  });

  it('邀请不存在 → 404（RELATIONSHIP_INVITE_NOT_FOUND）', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.findFirst.mockResolvedValue(null);

    await expect(harness.service.getInviteDetail(ME, CODE)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_NOT_FOUND,
      status: 404,
    });
  });

  it('邀请码格式非法（长度不对）同样按"不存在"处理（避免区分格式以对抗枚举）', async () => {
    const harness = createHarness();

    await expect(harness.service.getInviteDetail(ME, 'ABC')).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_NOT_FOUND,
    });
  });

  it('邀请已过期 → 410', async () => {
    const harness = createHarness(inviteRow({ expiresAt: new Date('2026-02-01T00:00:00.000Z') }));

    await expect(harness.service.getInviteDetail(ME, CODE)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_EXPIRED,
      status: 410,
    });
  });

  it('邀请已被撤销 → 410', async () => {
    const harness = createHarness(inviteRow({ status: 'REVOKED' }));

    await expect(harness.service.getInviteDetail(ME, CODE)).rejects.toMatchObject({ status: 410 });
  });

  it('【关键】自邀仍返回 200，只在 canAccept / blockedReason 上体现', async () => {
    const harness = createHarness(inviteRow({ inviterId: ME }));

    const view = await harness.service.getInviteDetail(ME, CODE);

    expect(view.canAccept).toBe(false);
    expect(view.blockedReason).toBe('SELF_INVITE');
    expect(view.myStatus.isInviter).toBe(true);
  });

  it('已有关系 → ALREADY_RELATED，并回读既有关系 ID', async () => {
    const harness = createHarness();
    harness.prisma.relationship.findFirst.mockResolvedValue({ id: RELATIONSHIP_ID, status: 'ACTIVE' });

    const view = await harness.service.getInviteDetail(ME, CODE);

    expect(view.blockedReason).toBe('ALREADY_RELATED');
    expect(view.myStatus.existingRelationshipId).toBe(RELATIONSHIP_ID);
    expect(view.myStatus.existingRelationshipStatus).toBe('ACTIVE');
  });

  it('我没有画像 → NO_PROFILE（hasProfile = false）', async () => {
    const harness = createHarness();
    // 第一次是邀请人画像，第二次是我的画像
    harness.prisma.personalityProfile.findFirst
      .mockResolvedValueOnce({ mbtiType: 'INTJ', version: 2 })
      .mockResolvedValueOnce(null);

    const view = await harness.service.getInviteDetail(ME, CODE);

    expect(view.blockedReason).toBe('NO_PROFILE');
    expect(view.myStatus.hasProfile).toBe(false);
  });

  it('正常可接受：canAccept = true，且带上建议测评编码与免责声明', async () => {
    const harness = createHarness();

    const view = await harness.service.getInviteDetail(ME, CODE);

    expect(view.canAccept).toBe(true);
    expect(view.blockedReason).toBeNull();
    expect(view.inviteCode).toBe(CODE);
    expect(view.relationTypeName).toBe('伴侣关系');
    expect(view.suggestedTestCode).toBe('MBTI_LITE');
    expect(view.message).toContain('一起做');
    expect(view.disclaimer.length).toBeGreaterThan(0);
    expect(view.remainingSeconds).toBeGreaterThan(0);
  });

  it('建议测评在库里查不到时返回 null（不硬编码一个可能 404 的编码）', async () => {
    const harness = createHarness();
    harness.prisma.testDefinition.findFirst.mockResolvedValue(null);

    const view = await harness.service.getInviteDetail(ME, CODE);

    expect(view.suggestedTestCode).toBeNull();
  });

  it('inviteeName 恒为 null（数据模型没有该列，不编占位文案）', async () => {
    const harness = createHarness();

    await expect(harness.service.getInviteDetail(ME, CODE)).resolves.toMatchObject({ inviteeName: null });
  });

  it('【关键】已被我自己接受 → 200 并附 acceptedRelationshipId', async () => {
    const harness = createHarness(inviteRow({ status: 'ACCEPTED', inviteeId: ME, relationshipId: RELATIONSHIP_ID }));

    const view = await harness.service.getInviteDetail(ME, CODE);

    expect(view.acceptedRelationshipId).toBe(RELATIONSHIP_ID);
    expect(view.status).toBe('ACCEPTED');
    expect(view.canAccept).toBe(false);
    expect(view.myStatus.existingRelationshipId).toBe(RELATIONSHIP_ID);
  });

  it('【关键】已被他人接受 → 409，且不透露接受者', async () => {
    const harness = createHarness(
      inviteRow({ status: 'ACCEPTED', inviteeId: 'someone-else', relationshipId: RELATIONSHIP_ID }),
    );

    await expect(harness.service.getInviteDetail(ME, CODE)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_USED,
      status: 409,
    });
  });

  it('标记为已接受但关系已不存在 → 409（不返回一个指向空关系的 ID）', async () => {
    const harness = createHarness(inviteRow({ status: 'ACCEPTED', inviteeId: ME, relationshipId: RELATIONSHIP_ID }));
    harness.prisma.relationship.findUnique.mockResolvedValue(null);

    await expect(harness.service.getInviteDetail(ME, CODE)).rejects.toMatchObject({ status: 409 });
  });

  it('已接受且关系 ACTIVE 时，流程推进到「生成匹配报告」', async () => {
    const harness = createHarness(inviteRow({ status: 'ACCEPTED', inviteeId: ME, relationshipId: RELATIONSHIP_ID }));
    harness.prisma.relationship.findUnique.mockResolvedValue({ id: RELATIONSHIP_ID, status: 'ACTIVE' });

    const view = await harness.service.getInviteDetail(ME, CODE);
    const steps = view.flow.steps;

    expect(steps[3]?.status).toBe('DONE');
    expect(steps[4]?.status).toBe('CURRENT');
  });
});

// ============================================================================
// 路由契约
// ============================================================================

describe('GET /relationships/invites/{code} 路由契约（契约 §3.6.2）', () => {
  it('路径与 HTTP 方法', () => {
    expect(Reflect.getMetadata(PATH_METADATA, RelationshipController.prototype.getInviteDetail)).toBe('invites/:code');
    expect(Reflect.getMetadata(METHOD_METADATA, RelationshipController.prototype.getInviteDetail)).toBe(
      RequestMethod.GET,
    );
  });

  it('【关键】必须鉴权（契约标 🔑 需登录，避免游客探测邀请码）', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, RelationshipController.prototype.getInviteDetail)).toBeUndefined();
  });

  it('显式限流 30 次/60s（契约 §3.6.2 的防枚举要求）', () => {
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}global`, RelationshipController.prototype.getInviteDetail)).toBe(30);
  });

  it('把 userId 与 path 参数交给 Service', async () => {
    const getInviteDetail = jest.fn().mockResolvedValue({});
    const controller = new RelationshipController(
      { getInviteDetail } as unknown as RelationshipService,
      {} as unknown as CompatibilityService,
    );

    await controller.getInviteDetail(ME, { code: CODE });

    expect(getInviteDetail).toHaveBeenCalledWith(ME, CODE);
  });
});

describe('INVITER 常量', () => {
  it('邀请人与当前用户不同（避免用例互相污染）', () => {
    expect(INVITER).not.toBe(ME);
  });
});
