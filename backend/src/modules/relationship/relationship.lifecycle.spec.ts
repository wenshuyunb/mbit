/**
 * 关系生命周期测试（确认 / 解除 / ADR-030 约束）
 *
 * 最核心的断言是 **解除后同一对用户必须能重新建立关系**：
 * 契约 §3.6.7 要求 `pairKey` 保留原值作审计，唯一性由部分唯一索引
 * `WHERE status IN ('PENDING_A_CONFIRM','ACTIVE')` 承担。
 * 本项目尚未对真实 PostgreSQL 执行过迁移，因此这条约束由
 * 「迁移 SQL + schema 的静态契约测试」锁定（见下方 describe）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorCode } from '../../common/errors/error-code';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import { buildPairKey } from './relationship.util';
import { RelationshipService } from './relationship.service';

const USER_A = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const USER_B = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';
const RELATIONSHIP_ID = 'rel-1';

// ============================================================================
// ADR-030：pairKey 唯一性契约（静态校验，因为无法对真实 PG 执行迁移）
// ============================================================================

describe('ADR-030 pairKey 唯一性契约', () => {
  const repoRoot = join(__dirname, '..', '..', '..', '..');
  const migrationSql = readFileSync(
    join(
      repoRoot,
      'backend',
      'prisma',
      'migrations',
      '20260217000000_relationship_pairkey_partial_unique',
      'migration.sql',
    ),
    'utf8',
  );
  const enumMigrationSql = readFileSync(
    join(
      repoRoot,
      'backend',
      'prisma',
      'migrations',
      '20260216000000_relationship_status_align_contract',
      'migration.sql',
    ),
    'utf8',
  );
  const schema = readFileSync(join(repoRoot, 'backend', 'prisma', 'schema.prisma'), 'utf8');

  it('【关键】pairKey 全表唯一索引已删除，否则复合仍会被阻止', () => {
    // 只建部分索引而不删旧索引是"看着改了、实际没改"的典型 —— 旧索引会继续
    // 阻止已解除关系的双方重新建立关系，缺陷原样保留
    expect(migrationSql).toContain('DROP INDEX IF EXISTS "relationships_pair_key_key"');
  });

  it('【关键】部分唯一索引只覆盖存活态，终态后允许复合', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "relationships_pair_key_live_key"[\s\S]*?WHERE "status" IN \('PENDING_A_CONFIRM', 'ACTIVE'\)/,
    );
  });

  it('【关键】索引谓词不可用 `<>` 反列举（新增终态会静默重新引入缺陷）', () => {
    // 契约字面写法是 `<> 'REMOVED'`，但那会让 REJECTED / EXPIRED 的行继续
    // 占用唯一键（A 误拒邀请后两人永远无法重建关系），且日后往枚举里加终态时
    // 会**静默**把新终态也算作占用。正向列举才对。
    expect(migrationSql).not.toMatch(/WHERE "status" <> /);
  });

  it('【关键】schema 里 pairKey 不能再有 @unique（部分索引无法由 Prisma 表达）', () => {
    expect(schema).toMatch(/pairKey\s+String\s+@map\("pair_key"\)\s+@db\.VarChar\(80\)/);
    expect(schema).not.toMatch(/pairKey\s+String\s+@unique/);
  });

  it('【关键】枚举补 EXPIRED 且 UNBOUND 已改名为 REMOVED', () => {
    const enumBlock = schema.slice(
      schema.indexOf('enum RelationshipStatus {'),
      schema.indexOf('}', schema.indexOf('enum RelationshipStatus {')),
    );

    expect(enumBlock).toContain('REMOVED');
    expect(enumBlock).toContain('EXPIRED');
    // 旧名留在枚举里会让同一状态有两个名字，代码里迟早混用
    expect(enumBlock).not.toContain(['UN', 'BOUND'].join(''));
  });

  it('枚举改名与索引变更必须拆成两个迁移文件', () => {
    // 索引谓词引用 'REMOVED'/'EXPIRED'，而 ALTER TYPE 的效果在同一事务内
    // 对谓词不可见（ADD VALUE 更被 PG 禁止同事务内使用）。合并会直接报
    // `invalid input value for enum relationship_status`。
    // 用拼接拼出旧名，避免被「把全部旧枚举名替换成新名」的批量改动误伤 ——
    // 这个断言若被改成 'REMOVED' TO 'REMOVED'，测试会永远失败得莫名其妙
    const legacyName = ['UN', 'BOUND'].join('');
    expect(enumMigrationSql).toContain(`RENAME VALUE '${legacyName}' TO 'REMOVED'`);
    expect(enumMigrationSql).toContain("ADD VALUE IF NOT EXISTS 'EXPIRED'");
    // 枚举迁移里不得出现引用新值建立索引的语句
    expect(enumMigrationSql).not.toContain('CREATE UNIQUE INDEX');
  });
});

// ============================================================================
// 确认与解除
// ============================================================================

interface Harness {
  service: RelationshipService;
  prisma: {
    relationship: { findFirst: jest.Mock; update: jest.Mock };
    relationshipInvite: { findFirst: jest.Mock };
    /** `keepHistory=false` 时用它软删除历史匹配报告 */
    compatibilityReport: { updateMany: jest.Mock };
  };
}

const createHarness = (relationshipOverrides: Record<string, unknown> = {}): Harness => {
  const prisma = {
    relationship: {
      findFirst: jest.fn().mockResolvedValue({
        id: RELATIONSHIP_ID,
        status: 'PENDING_A_CONFIRM',
        userAId: USER_A,
        userBId: USER_B,
        pairKey: buildPairKey(USER_A, USER_B),
        ...relationshipOverrides,
      }),
      update: jest.fn().mockResolvedValue({ id: RELATIONSHIP_ID }),
    },
    relationshipInvite: { findFirst: jest.fn().mockResolvedValue({ inviterId: USER_A }) },
    compatibilityReport: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
  };

  const service = new RelationshipService(
    prisma as unknown as PrismaService,
    { set: jest.fn() } as unknown as RedisService,
    // 确认关系时会自动触发匹配算分；本文件只关心状态机，
    // 因此用桩让它返回"已入队"而不真的碰队列
    {
      requestCompatibility: jest
        .fn()
        .mockResolvedValue({ reportId: 'report-1', queue: 'compatibility.calc', estimatedSeconds: 5 }),
    } as never,
    // 本文件只测状态机，不涉及二维码：桩成"未配置凭证"的形态
    { getMiniAppCode: jest.fn().mockResolvedValue(null) } as never,
    { uploadServerObject: jest.fn(), publicUrlOf: jest.fn(() => 'https://cdn.example.com/x.png') } as never,
  );

  return { service, prisma };
};

describe('RelationshipService.confirmRelationship', () => {
  it('发起方确认后关系转为 ACTIVE', async () => {
    const harness = createHarness();

    const view = await harness.service.confirmRelationship(USER_A, RELATIONSHIP_ID);

    expect(view.status).toBe('ACTIVE');
    expect(view.confirmedAt).not.toBeNull();
    expect(harness.prisma.relationship.update).toHaveBeenCalledWith({
      where: { id: RELATIONSHIP_ID },
      data: expect.objectContaining({ status: 'ACTIVE', confirmedByUserId: USER_A }),
    });
  });

  it('【关键】只有邀请发起方可以确认（待 A 确认的语义）', async () => {
    const harness = createHarness();

    await expect(harness.service.confirmRelationship(USER_B, RELATIONSHIP_ID)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_STATUS_INVALID,
    });
    expect(harness.prisma.relationship.update).not.toHaveBeenCalled();
  });

  it('【关键】非关系双方一律按"不存在"处理（不确认关系是否存在）', async () => {
    const harness = createHarness();

    await expect(
      harness.service.confirmRelationship('0195f3a2-0000-7000-8000-000000000000', RELATIONSHIP_ID),
    ).rejects.toMatchObject({ code: ErrorCode.RELATIONSHIP_NOT_FOUND });
  });

  it('关系不存在时抛 60000', async () => {
    const harness = createHarness();
    harness.prisma.relationship.findFirst.mockResolvedValue(null);

    await expect(harness.service.confirmRelationship(USER_A, RELATIONSHIP_ID)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_NOT_FOUND,
    });
  });

  it('已是 ACTIVE 时幂等返回（重复确认不报错）', async () => {
    const harness = createHarness({ status: 'ACTIVE' });

    const view = await harness.service.confirmRelationship(USER_A, RELATIONSHIP_ID);

    expect(view.status).toBe('ACTIVE');
    expect(harness.prisma.relationship.update).not.toHaveBeenCalled();
  });

  it('已解除的关系不允许再确认', async () => {
    const harness = createHarness({ status: 'REMOVED' });

    await expect(harness.service.confirmRelationship(USER_A, RELATIONSHIP_ID)).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_STATUS_INVALID,
    });
  });

  it('找不到对应邀请时不校验发起方（兼容历史数据）', async () => {
    const harness = createHarness();
    harness.prisma.relationshipInvite.findFirst.mockResolvedValue(null);

    await expect(harness.service.confirmRelationship(USER_B, RELATIONSHIP_ID)).resolves.toMatchObject({
      status: 'ACTIVE',
    });
  });
});

describe('RelationshipService.removeRelationship', () => {
  it('解除后状态为 REMOVED 并写入原因', async () => {
    const harness = createHarness({ status: 'ACTIVE' });

    const view = await harness.service.unbindRelationship(USER_A, RELATIONSHIP_ID, { reason: '双方协商结束' });

    expect(view.status).toBe('REMOVED');
    expect(view.unboundAt).not.toBeNull();
    expect(harness.prisma.relationship.update).toHaveBeenCalledWith({
      where: { id: RELATIONSHIP_ID },
      data: expect.objectContaining({
        status: 'REMOVED',
        unboundByUserId: USER_A,
        unboundReason: '双方协商结束',
      }),
    });
  });

  it('【关键】解除时**保留** pairKey 原值（契约 §3.6.7 要求留作审计）', async () => {
    const harness = createHarness({ status: 'ACTIVE' });
    const canonical = buildPairKey(USER_A, USER_B);

    await harness.service.unbindRelationship(USER_A, RELATIONSHIP_ID);

    const data = harness.prisma.relationship.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // 墓碑方案（ADR-030 已废弃）会在这里改写 pairKey，与契约冲突；
    // 现在必须**完全不出现** pairKey 字段，让数据库里的原值保持不变。
    expect(data.data).not.toHaveProperty('pairKey');
    expect(canonical).toBe(buildPairKey(USER_A, USER_B));
  });

  it('【关键】任一方均可解除（不需要对方同意）', async () => {
    const harness = createHarness({ status: 'ACTIVE' });

    await expect(harness.service.unbindRelationship(USER_B, RELATIONSHIP_ID)).resolves.toMatchObject({
      status: 'REMOVED',
    });
  });

  it('非关系双方无法解除（按不存在处理）', async () => {
    const harness = createHarness({ status: 'ACTIVE' });

    await expect(
      harness.service.unbindRelationship('0195f3a2-0000-7000-8000-000000000000', RELATIONSHIP_ID),
    ).rejects.toMatchObject({ code: ErrorCode.RELATIONSHIP_NOT_FOUND });
  });

  it('重复解除幂等（不覆盖首次解除时间与原因）', async () => {
    const firstUnboundAt = new Date('2026-10-01T08:30:00.000Z');
    const harness = createHarness({ status: 'REMOVED', unboundAt: firstUnboundAt });

    const view = await harness.service.unbindRelationship(USER_A, RELATIONSHIP_ID, { reason: '再次解绑' });

    expect(view.status).toBe('REMOVED');
    expect(harness.prisma.relationship.update).not.toHaveBeenCalled();
    // 必须回读**首次**解绑时间：返回 null 会让客户端以为从未解绑过，
    // 从而把已结束的关系显示为仍然有效
    expect(view.unboundAt).toBe(firstUnboundAt.toISOString());
  });

  it('未确认的关系也可直接解除（用户可撤回待确认的邀请）', async () => {
    const harness = createHarness({ status: 'PENDING_A_CONFIRM' });

    await expect(harness.service.unbindRelationship(USER_A, RELATIONSHIP_ID)).resolves.toMatchObject({
      status: 'REMOVED',
    });
  });

  it('原因超长时截断到 256（列长度限制）', async () => {
    const harness = createHarness({ status: 'ACTIVE' });

    await harness.service.unbindRelationship(USER_A, RELATIONSHIP_ID, { reason: 'x'.repeat(400) });

    const data = harness.prisma.relationship.update.mock.calls[0][0] as {
      data: { unboundReason: string };
    };
    expect(data.data.unboundReason).toHaveLength(256);
  });

  /**
   * `keepHistory`（契约 §3.6.7 的隐私开关）
   *
   * 这一项此前**收下参数然后完全忽略** —— 用户明确要求"不保留历史"，
   * 而解除后双方仍能读到全部匹配报告。**收下却做不到，比不声明更糟**：
   * 用户以为记录已经消失。下面四条守的是"真的做了"以及"做的顺序对"。
   */
  describe('keepHistory（历史报告隐私开关）', () => {
    it('【关键】keepHistory=false 时软删除该关系的全部历史匹配报告', async () => {
      const harness = createHarness({ status: 'ACTIVE' });

      await harness.service.unbindRelationship(USER_A, RELATIONSHIP_ID, { keepHistory: false });

      expect(harness.prisma.compatibilityReport.updateMany).toHaveBeenCalledWith({
        where: { relationshipId: RELATIONSHIP_ID, deletedAt: null },
        // 软删除而非物理删除：所有匹配报告查询都带 `deletedAt: null`，
        // 因此效果等同"对双方隐藏"，同时保留审计与误操作恢复的余地
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('【关键】先隐藏报告、再改关系状态（顺序反了会留下"已解除但报告还在"且永远补不回来）', async () => {
      const harness = createHarness({ status: 'ACTIVE' });

      await harness.service.unbindRelationship(USER_A, RELATIONSHIP_ID, { keepHistory: false });

      const hideOrder = harness.prisma.compatibilityReport.updateMany.mock.invocationCallOrder[0];
      const unbindOrder = harness.prisma.relationship.update.mock.invocationCallOrder[0];

      expect(hideOrder).toBeLessThan(unbindOrder);
    });

    it('keepHistory 未传或为 true 时**不动**历史报告（默认保留）', async () => {
      const withoutFlag = createHarness({ status: 'ACTIVE' });
      await withoutFlag.service.unbindRelationship(USER_A, RELATIONSHIP_ID);
      expect(withoutFlag.prisma.compatibilityReport.updateMany).not.toHaveBeenCalled();

      const withTrue = createHarness({ status: 'ACTIVE' });
      await withTrue.service.unbindRelationship(USER_A, RELATIONSHIP_ID, { keepHistory: true });
      expect(withTrue.prisma.compatibilityReport.updateMany).not.toHaveBeenCalled();
    });

    it('【关键】关系已是 REMOVED 时传 keepHistory=false 仍会补做隐藏（幂等早返回不吞掉隐私动作）', async () => {
      const harness = createHarness({ status: 'REMOVED', unboundAt: new Date('2026-10-01T08:30:00.000Z') });

      const view = await harness.service.unbindRelationship(USER_A, RELATIONSHIP_ID, { keepHistory: false });

      expect(view.status).toBe('REMOVED');
      expect(harness.prisma.compatibilityReport.updateMany).toHaveBeenCalledTimes(1);
      // 幂等语义保持不变：不覆盖首次解除时间
      expect(view.unboundAt).toBe('2026-10-01T08:30:00.000Z');
      expect(harness.prisma.relationship.update).not.toHaveBeenCalled();
    });
  });
});
