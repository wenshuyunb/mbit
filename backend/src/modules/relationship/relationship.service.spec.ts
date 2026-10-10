/**
 * 关系服务测试（契约 §3.6）
 *
 * 三项最重要的主张：
 *   · **邀请码碰撞要重试而不是报错** —— 32^8 空间里碰撞是正常概率事件
 *   · **自邀要给出准确提示** —— 它是用户误操作，不是"邀请失效"
 *   · **pairKey 唯一约束是并发下的可靠闸门** —— 应用层"先查再插"必然漏判
 */

import { ErrorCode } from '../../common/errors/error-code';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import { buildPairKey } from './relationship.util';
import { RelationshipService, type CreateInviteInput } from './relationship.service';

const INVITER = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const INVITEE = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';
const INVITE_ID = 'invite-1';
const CODE = 'K7M2XQ9V';

const createInput = (overrides: Partial<CreateInviteInput> = {}): CreateInviteInput => ({
  userId: INVITER,
  relationType: 'COUPLE',
  ...overrides,
});

const inviteRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: INVITE_ID,
  inviterId: INVITER,
  inviteeId: null,
  relationType: 'COUPLE',
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  relationshipId: null,
  ...overrides,
});

interface Harness {
  service: RelationshipService;
  prisma: {
    relationshipInvite: { count: jest.Mock; create: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    relationship: { create: jest.Mock; findUnique: jest.Mock };
    personalityProfile: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  redis: { key: jest.Mock; set: jest.Mock };
  tx: {
    relationship: { create: jest.Mock };
    relationshipInvite: { update: jest.Mock };
  };
}

const createHarness = (): Harness => {
  const tx = {
    relationship: {
      create: jest.fn().mockResolvedValue({ id: 'rel-1', status: 'PENDING_A_CONFIRM', type: 'COUPLE' }),
    },
    relationshipInvite: { update: jest.fn().mockResolvedValue({ id: INVITE_ID }) },
  };

  const prisma = {
    relationshipInvite: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({
        id: INVITE_ID,
        code: CODE,
        relationType: 'COUPLE',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        qrCodeUrl: null,
      }),
      findFirst: jest.fn().mockResolvedValue(inviteRow()),
      update: jest.fn().mockResolvedValue({ id: INVITE_ID }),
    },
    relationship: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({
        id: 'rel-1',
        status: 'PENDING_A_CONFIRM',
        type: 'COUPLE',
        userAId: INVITEE,
        userBId: INVITER,
      }),
    },
    personalityProfile: { findFirst: jest.fn().mockResolvedValue({ id: 'profile-peer' }) },
    $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
  };

  const redis = {
    key: jest.fn((...parts: string[]) => parts.join(':')),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const service = new RelationshipService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    // 匹配算分不在本文件的测试范围内（见 compatibility 相关用例）：
    // 这里只提供一个不会真正入队的桩
    {
      requestCompatibility: jest.fn().mockResolvedValue({ reportId: 'report-1', queue: 'compatibility.calc' }),
    } as never,
  );

  return { service, prisma, redis, tx };
};

/** 构造 Prisma 唯一约束错误 */
const uniqueError = (): Error => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

describe('RelationshipService.createInvite', () => {
  it('创建邀请并把码写入 DB 与 Redis', async () => {
    const harness = createHarness();

    const view = await harness.service.createInvite(createInput());

    expect(view.inviteId).toBe(INVITE_ID);
    expect(view.code).toHaveLength(8);
    expect(view.status).toBe('PENDING');
    expect(harness.prisma.relationshipInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ inviterId: INVITER, relationType: 'COUPLE', maxUses: 1 }),
      }),
    );
    // 【关键】Redis 键里的码必须与落库的码一致 —— 否则扫码时按码查缓存会查不到，
    // 缓存层静默失效（表现为每次扫码都回落到 DB 查询，性能问题难以归因）
    const createdCode = (harness.prisma.relationshipInvite.create.mock.calls[0][0] as { data: { code: string } }).data
      .code;

    expect(createdCode).toHaveLength(8);
    expect(harness.redis.set).toHaveBeenCalledWith(expect.stringContaining(createdCode), INVITE_ID, expect.any(Number));
  });

  it('有效期设为 7 天', async () => {
    const harness = createHarness();

    await harness.service.createInvite(createInput());

    const data = harness.prisma.relationshipInvite.create.mock.calls[0][0] as {
      data: { expiresAt: Date };
    };
    const days = (data.data.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });

  it('message 超长时截断到 256（列长度限制）', async () => {
    const harness = createHarness();

    await harness.service.createInvite(createInput({ message: 'x'.repeat(400) }));

    const data = harness.prisma.relationshipInvite.create.mock.calls[0][0] as {
      data: { message: string };
    };
    expect(data.data.message).toHaveLength(256);
  });

  it('【关键】Redis 写失败不影响创建成功（缓存只是加速层）', async () => {
    const harness = createHarness();
    harness.redis.set.mockRejectedValue(new Error('redis down'));

    await expect(harness.service.createInvite(createInput())).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  it('未使用邀请数达到上限时返回 429', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.count.mockResolvedValue(5);

    await expect(harness.service.createInvite(createInput())).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_LIMIT,
    });
    expect(harness.prisma.relationshipInvite.create).not.toHaveBeenCalled();
  });

  it('【关键】邀请码碰撞时重试生成，而不是直接报错', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.create.mockRejectedValueOnce(uniqueError()).mockResolvedValueOnce({
      id: INVITE_ID,
      code: CODE,
      relationType: 'COUPLE',
      status: 'PENDING',
      expiresAt: new Date(),
      qrCodeUrl: null,
    });

    await expect(harness.service.createInvite(createInput())).resolves.toMatchObject({
      inviteId: INVITE_ID,
    });
    expect(harness.prisma.relationshipInvite.create).toHaveBeenCalledTimes(2);
  });

  it('连续碰撞到上限时抛内部错误（码空间异常需暴露）', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.create.mockRejectedValue(uniqueError());

    await expect(harness.service.createInvite(createInput())).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
    expect(harness.prisma.relationshipInvite.create).toHaveBeenCalledTimes(5);
  });

  it('非唯一约束错误原样抛出（不掩盖真实故障）', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.create.mockRejectedValue(
      Object.assign(new Error('connection lost'), { code: 'P1001' }),
    );

    await expect(harness.service.createInvite(createInput())).rejects.toMatchObject({
      code: 'P1001',
    });
  });
});

describe('RelationshipService.acceptInvite', () => {
  it('接受成功后建立 PENDING_A_CONFIRM 关系并标记邀请已用', async () => {
    const harness = createHarness();

    const view = await harness.service.acceptInvite(INVITEE, CODE);

    expect(view).toMatchObject({
      relationshipId: 'rel-1',
      status: 'PENDING_A_CONFIRM',
      relationType: 'COUPLE',
      peerUserId: INVITER,
      awaitingPeerConfirm: true,
    });
    expect(harness.tx.relationshipInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACCEPTED', inviteeId: INVITEE }),
      }),
    );
  });

  it('【关键】pairKey 与顺序无关（A 邀请 B / B 邀请 A 得到同一个键）', async () => {
    const harness = createHarness();

    await harness.service.acceptInvite(INVITEE, CODE);

    const data = harness.tx.relationship.create.mock.calls[0][0] as { data: { pairKey: string } };
    expect(data.data.pairKey).toBe(buildPairKey(INVITER, INVITEE));
    // 与传入顺序无关
    expect(data.data.pairKey).toBe(buildPairKey(INVITEE, INVITER));
  });

  it('码的小写与连字符写法都能接受', async () => {
    const harness = createHarness();

    await harness.service.acceptInvite(INVITEE, 'k7m2-xq9v');

    expect(harness.prisma.relationshipInvite.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ code: CODE }) }),
    );
  });

  it('码格式非法时抛邀请不存在（不泄露格式规则）', async () => {
    const harness = createHarness();

    await expect(harness.service.acceptInvite(INVITEE, 'SHORT')).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_NOT_FOUND,
    });
  });

  it('邀请不存在时抛 60003', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.findFirst.mockResolvedValue(null);

    await expect(harness.service.acceptInvite(INVITEE, CODE)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_NOT_FOUND,
    });
  });

  it('【关键】自邀给出准确提示（属误操作，不是"邀请失效"）', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.findFirst.mockResolvedValue(inviteRow({ inviterId: INVITEE }));

    try {
      await harness.service.acceptInvite(INVITEE, CODE);
      throw new Error('期望抛出错误');
    } catch (error) {
      const exception = error as { code: number; userMessage: string };
      expect(exception.code).toBe(ErrorCode.RELATIONSHIP_INVITE_SELF);
      expect(exception.userMessage).toContain('自己');
    }
    expect(harness.tx.relationship.create).not.toHaveBeenCalled();
  });

  it('邀请已撤销时抛 60004（与过期共用同一提示）', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.findFirst.mockResolvedValue(inviteRow({ status: 'REVOKED' }));

    await expect(harness.service.acceptInvite(INVITEE, CODE)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_EXPIRED,
    });
  });

  it('邀请已过期时抛 60004', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.findFirst.mockResolvedValue(
      inviteRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(harness.service.acceptInvite(INVITEE, CODE)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_EXPIRED,
    });
  });

  it('【关键】重复接受同一邀请时幂等返回既有关系（而非报错）', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.findFirst.mockResolvedValue(
      inviteRow({ status: 'ACCEPTED', relationshipId: 'rel-1' }),
    );

    const view = await harness.service.acceptInvite(INVITEE, CODE);

    expect(view.relationshipId).toBe('rel-1');
    expect(harness.tx.relationship.create).not.toHaveBeenCalled();
  });

  it('邀请已接受但关系记录已消失时抛"已被使用"', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.findFirst.mockResolvedValue(
      inviteRow({ status: 'ACCEPTED', relationshipId: 'rel-1' }),
    );
    harness.prisma.relationship.findUnique.mockResolvedValue(null);

    await expect(harness.service.acceptInvite(INVITEE, CODE)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_INVITE_USED,
    });
  });

  it('【关键】对方无画像时抛 60009（没有画像就无法算分）', async () => {
    const harness = createHarness();
    harness.prisma.personalityProfile.findFirst.mockResolvedValue(null);

    await expect(harness.service.acceptInvite(INVITEE, CODE)).rejects.toMatchObject({
      code: ErrorCode.COMPATIBILITY_PEER_NOT_READY,
    });
    expect(harness.tx.relationship.create).not.toHaveBeenCalled();
  });

  it('【关键】pairKey 唯一冲突归一为"关系已存在"（并发下的可靠闸门）', async () => {
    const harness = createHarness();
    harness.tx.relationship.create.mockRejectedValue(uniqueError());

    await expect(harness.service.acceptInvite(INVITEE, CODE)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_ALREADY_EXISTS,
    });
  });

  it('事务保证：建关系与标记邀请在同一事务内', async () => {
    const harness = createHarness();

    await harness.service.acceptInvite(INVITEE, CODE);

    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.tx.relationship.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.relationshipInvite.update).toHaveBeenCalledTimes(1);
  });
});
