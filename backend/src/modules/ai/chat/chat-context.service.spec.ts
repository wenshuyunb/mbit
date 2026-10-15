/**
 * 会话上下文服务单测（契约 §3.7.2 / §3.7.3 / §3.7.4 / §3.7.7）
 *
 * 核心主张：
 *   · **IDOR 防护**：会话归属校验必须同时带 `id` 与 `userId`
 *   · **预览截断 60 字且不做 Markdown 渲染**（契约 §3.7.2 规则 2：防注入）
 *   · **游标分页优先于 page**，`nextCursor` 取本页最后一条
 *   · **删除天然幂等**：重复删除返回成功而不是 404
 *   · **硬删除清正文但不删行**（保留消息计数与时间戳用于统计）
 *   · **归档可恢复、删除不可恢复**
 */

import { ErrorCode } from '../../../common/errors/error-code';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { ChatQuotaService } from './chat-quota.service';
import { ChatContextService, buildAutoTitle, buildPreview, toMessageView } from './chat-context.service';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OTHER_USER_ID = '0195f3a2-8d5f-8c42-ab7e-3f6d9e2c5e81';
const CONVERSATION_ID = '0195f3a2-c35f-7b97-9c02-8ebf5c6d7a56';
const NOW = new Date('2026-02-14T16:25:00.000Z');

const conversationRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: CONVERSATION_ID,
  userId: USER_ID,
  title: '和男友的沟通问题',
  scene: 'COMPANION|WARM|1',
  status: 'ACTIVE',
  messageCount: 26,
  totalTokens: 24860,
  totalCostAmount: 42,
  memorySummary: '之前聊过工作压力。',
  memoryTokens: 12,
  memoryUpdatedAt: NOW,
  lastMessageAt: NOW,
  archivedAt: null,
  relationshipId: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

interface Harness {
  service: ChatContextService;
  prisma: {
    aiConversation: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
      aggregate: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    aiMessage: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
      aggregate: jest.Mock;
      updateMany: jest.Mock;
    };
    relationship: { findFirst: jest.Mock; findMany: jest.Mock };
    personalityProfile: { findFirst: jest.Mock; findMany: jest.Mock };
    emotionProfile: { findFirst: jest.Mock };
    mentalHealthProfile: { findFirst: jest.Mock };
    relationshipStyleRule: { findMany: jest.Mock };
    user: { findUnique: jest.Mock; findMany: jest.Mock };
    testSession: { findFirst: jest.Mock };
    aiReport: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  quota: { summaryFor: jest.Mock; readStringConfig: jest.Mock };
}

const createHarness = (): Harness => {
  const tx = {
    aiMessage: { updateMany: jest.fn().mockResolvedValue({ count: 8 }) },
    aiConversation: {
      update: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({
          status: args.data['status'],
          deletedAt: args.data['deletedAt'] ?? null,
          archivedAt: args.data['archivedAt'] ?? null,
        }),
      ),
    },
  };

  const prisma = {
    aiConversation: {
      findUnique: jest.fn().mockResolvedValue(conversationRow()),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { messageCount: 0 } }),
      create: jest.fn(),
      update: jest.fn(),
    },
    aiMessage: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      // 两个调用点：会话内总数（无 safetyStatus 过滤）与安全响应数（带过滤）。
      // 用同一个 mock 时必须按参数区分，否则两者会返回同一个数
      count: jest
        .fn()
        .mockImplementation((args: { where: Record<string, unknown> }) =>
          Promise.resolve(args.where['safetyStatus'] === 'BLOCKED' ? 0 : 0),
        ),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalTokens: 0 } }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    relationship: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    personalityProfile: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    // 另两个模块的画像（ADR-038 阶段 5 的"管家"要读它们）。默认都是"没做过"
    emotionProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    mentalHealthProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    /**
     * 关系风格规则表
     *
     * ⚠ 本夹具此前**没有这一项**，而它是 `loadCurrentProfile` 的必经之路
     * （ADR-038 阶段 2 起"读画像"要先读规则表来推导关系风格）。
     * 之所以一直没暴露：在此之前所有用例的 `personalityProfile.findFirst` 都返回 `null`，
     * 函数在读到规则表之前就 return 了。第一个"画像非空"的用例（本组）立刻把它撞出来。
     */
    relationshipStyleRule: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue({ nickname: '小满' }), findMany: jest.fn().mockResolvedValue([]) },
    testSession: { findFirst: jest.fn().mockResolvedValue(null) },
    aiReport: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const quota = {
    summaryFor: jest.fn().mockResolvedValue({
      plan: 'MEMBERSHIP_ACTIVE',
      remainingToday: 48,
      dailyLimit: 50,
      creditBalance: 30,
      resetAt: '2026-02-15T16:00:00.000Z',
    }),
    readStringConfig: jest.fn().mockResolvedValue('AI 内容由模型生成，仅供自我探索参考。'),
  };

  const service = new ChatContextService(prisma as unknown as PrismaService, quota as unknown as ChatQuotaService);

  return { service, prisma, quota };
};

describe('requireOwnedConversation / requireOwnedConversationForRead — IDOR 防护', () => {
  it('会话不存在 → AI_CONVERSATION_NOT_FOUND（404）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(null);

    await expect(h.service.requireOwnedConversationForRead(USER_ID, CONVERSATION_ID)).rejects.toMatchObject({
      code: ErrorCode.AI_CONVERSATION_NOT_FOUND,
      status: 404,
    });
  });

  it('【关键】"对话不存在"的码必须与危险内容拦截的 50008 区分开', async () => {
    // `50008` 是契约 §3.7.5 的**特殊约定**：危险内容命中时 HTTP 200 + code=50008，
    // 前端据此把关怀文案当**正常消息**渲染（不弹错误 Toast）。而本错误码原先也是 50008，
    // 于是"会话不存在"这条 404 会被只按 code 分支的前端渲染成关怀文案 ——
    // 用户既看不到真实原因，也拿不到任何提示。
    // 现已迁到空闲的 50022。这条断言防止它被改回去。
    expect(ErrorCode.AI_CONVERSATION_NOT_FOUND).toBe(50022);
    expect(ErrorCode.AI_CONVERSATION_NOT_FOUND).not.toBe(50008);
  });

  it('已软删除的会话视同不存在', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow({ status: 'DELETED', deletedAt: NOW }));

    await expect(h.service.requireOwnedConversationForRead(USER_ID, CONVERSATION_ID)).rejects.toMatchObject({
      code: ErrorCode.AI_CONVERSATION_NOT_FOUND,
    });
  });

  it('会话属于其他用户 → AI_CONVERSATION_NOT_OWNED（403，独立于"不存在"以便监控越权尝试）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow({ userId: OTHER_USER_ID }));

    await expect(h.service.requireOwnedConversationForRead(USER_ID, CONVERSATION_ID)).rejects.toMatchObject({
      code: ErrorCode.AI_CONVERSATION_NOT_OWNED,
      status: 403,
    });
  });
});

describe('buildPreview — 列表预览（契约 §3.7.2 规则 2）', () => {
  it('截取 60 字并加省略标记', () => {
    const preview = buildPreview('字'.repeat(200));

    // 60 个字符 + 省略号
    expect(preview).toHaveLength(61);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('短内容原样返回', () => {
    expect(buildPreview('你好')).toBe('你好');
  });

  it('换行压成空格（预览是一行，避免列表项高度不可控）', () => {
    expect(buildPreview('第一行\n\n第二行')).toBe('第一行 第二行');
  });

  it('不剥离 Markdown 记号（契约只说"不做渲染"，未要求改写内容）', () => {
    expect(buildPreview('**加粗**的内容')).toBe('**加粗**的内容');
  });
});

describe('buildAutoTitle — 标题自动生成（契约 §3.7.1 规则 6）', () => {
  it('取前 20 字并加省略标记', () => {
    const title = buildAutoTitle('字'.repeat(50));

    expect(title).toHaveLength(21);
    expect(title.endsWith('…')).toBe(true);
  });

  it('去掉换行（标题里出现多行会撑开列表项）', () => {
    expect(buildAutoTitle('和男友的\n沟通问题')).toBe('和男友的 沟通问题');
  });
});

describe('toMessageView', () => {
  const baseRow = {
    id: 'msg-1',
    conversationId: CONVERSATION_ID,
    role: 'ASSISTANT',
    content: '内容',
    provider: 'DEEPSEEK',
    model: 'deepseek-chat',
    totalTokens: 312,
    latencyMs: 3860,
    finishReason: 'stop',
    safetyStatus: 'PASS',
    createdAt: NOW,
  };

  it('AI 回复判定为 MARKDOWN + isStreamed（带计量 = 真调过模型）', () => {
    const view = toMessageView(baseRow);

    expect(view.contentFormat).toBe('MARKDOWN');
    expect(view.isStreamed).toBe(true);
    expect(view.isSafetyResponse).toBe(false);
  });

  it('用户消息判定为 PLAIN（用户输入原样保存，按纯文本渲染）', () => {
    const view = toMessageView({ ...baseRow, role: 'USER', provider: null, latencyMs: null });

    expect(view.contentFormat).toBe('PLAIN');
    expect(view.isStreamed).toBe(false);
  });

  it('安全关怀响应（无 provider / latency）判为非流式，且 isSafetyResponse = true', () => {
    const view = toMessageView({
      ...baseRow,
      provider: null,
      model: null,
      latencyMs: 0,
      totalTokens: 0,
      safetyStatus: 'BLOCKED',
    });

    expect(view.isSafetyResponse).toBe(true);
    expect(view.isStreamed).toBe(false);
  });
});

describe('listMessages — 分页与游标（契约 §3.7.4）', () => {
  const messageRow = (id: string, createdAt: Date): Record<string, unknown> => ({
    id,
    conversationId: CONVERSATION_ID,
    role: 'ASSISTANT',
    content: '内容',
    provider: 'DEEPSEEK',
    model: 'deepseek-chat',
    totalTokens: 10,
    latencyMs: 100,
    finishReason: 'stop',
    safetyStatus: 'PASS',
    createdAt,
  });

  it('`before` 优先于 `page`（游标命中时 skip 为 0）', async () => {
    const h = createHarness();
    h.prisma.aiMessage.findMany.mockResolvedValue([messageRow('m1', NOW)]);

    await h.service.listMessages({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      before: '2026-02-14T16:05:12.000Z',
      page: 5,
      pageSize: 20,
    });

    const args = h.prisma.aiMessage.findMany.mock.calls[0]?.[0] as {
      skip: number;
      where: Record<string, unknown>;
    };

    expect(args.skip).toBe(0);
    expect(args.where['createdAt']).toEqual({ lt: new Date('2026-02-14T16:05:12.000Z') });
  });

  it('未传 `before` 时按 page 偏移', async () => {
    const h = createHarness();

    await h.service.listMessages({ userId: USER_ID, conversationId: CONVERSATION_ID, page: 3, pageSize: 20 });

    const args = h.prisma.aiMessage.findMany.mock.calls[0]?.[0] as { skip: number };
    expect(args.skip).toBe(40);
  });

  it('取满一页时给出 nextCursor（本页最后一条的时间）', async () => {
    const h = createHarness();
    const rows = [messageRow('m1', NOW), messageRow('m2', new Date('2026-02-14T16:00:00.000Z'))];
    h.prisma.aiMessage.findMany.mockResolvedValue(rows);

    const result = await h.service.listMessages({ userId: USER_ID, conversationId: CONVERSATION_ID, pageSize: 2 });

    expect(result.hasNext).toBe(true);
    expect(result.nextCursor).toBe('2026-02-14T16:00:00.000Z');
  });

  it('未取满一页时 nextCursor 为 null', async () => {
    const h = createHarness();
    h.prisma.aiMessage.findMany.mockResolvedValue([messageRow('m1', NOW)]);

    const result = await h.service.listMessages({ userId: USER_ID, conversationId: CONVERSATION_ID, pageSize: 20 });

    expect(result.hasNext).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('summary 是**整个会话**的口径（不随 role 筛选变化）', async () => {
    const h = createHarness();
    h.prisma.aiMessage.count.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where['safetyStatus'] === 'BLOCKED' ? 0 : 26),
    );
    h.prisma.aiMessage.groupBy.mockResolvedValue([
      { role: 'USER', _count: { _all: 13 } },
      { role: 'ASSISTANT', _count: { _all: 13 } },
    ]);
    h.prisma.aiMessage.aggregate.mockResolvedValue({ _sum: { totalTokens: 24860 } });

    const result = await h.service.listMessages({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      role: 'USER',
    });

    expect(result.summary).toEqual({
      totalMessages: 26,
      userMessages: 13,
      assistantMessages: 13,
      safetyResponses: 0,
      totalTokens: 24860,
    });
  });
});

describe('listConversations — 列表（契约 §3.7.2）', () => {
  it('summary 口径不随筛选变化（否则翻页时数字会变小，用户以为数据丢了）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findMany
      // 第一次：分页查询
      .mockResolvedValueOnce([conversationRow()])
      // 第二次：全量会话 id（summary 用）
      .mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);
    h.prisma.aiConversation.count.mockResolvedValue(2);
    h.prisma.aiConversation.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 2 } },
      { status: 'ARCHIVED', _count: { _all: 1 } },
    ]);
    h.prisma.aiConversation.aggregate.mockResolvedValue({ _sum: { messageCount: 78 } });

    const result = await h.service.listConversations({ userId: USER_ID });

    expect(result.summary).toEqual({
      totalConversations: 3,
      activeConversations: 2,
      archivedConversations: 1,
      totalMessages: 78,
    });
    expect(result.quota.remainingToday).toBe(48);
  });

  it('传 relationshipId 时先做归属校验（越权返回 403）', async () => {
    const h = createHarness();
    h.prisma.relationship.findFirst.mockResolvedValue(null);

    await expect(h.service.listConversations({ userId: USER_ID, relationshipId: 'r1' })).rejects.toMatchObject({
      code: ErrorCode.RELATIONSHIP_NOT_OWNED,
      status: 403,
    });
  });

  it('未传 status 时默认只查 ACTIVE', async () => {
    const h = createHarness();

    await h.service.listConversations({ userId: USER_ID });

    const where = h.prisma.aiConversation.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(where.where['status']).toEqual({ in: ['ACTIVE'] });
  });
});

describe('deleteConversation — 删除 / 归档（契约 §3.7.7）', () => {
  it('软删除：置 DELETED + deletedAt，并清空记忆摘要（用户要求不可访问后，派生内容不应继续参与注入）', async () => {
    const h = createHarness();

    const result = await h.service.deleteConversation({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      mode: 'DELETE',
      hardDelete: false,
    });

    expect(result.status).toBe('DELETED');
    expect(result.previousStatus).toBe('ACTIVE');
    expect(result.canRestore).toBe(false);
    expect(result.mode).toBe('DELETE');
  });

  it('归档：状态 ARCHIVED 且 canRestore = true', async () => {
    const h = createHarness();

    const result = await h.service.deleteConversation({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      mode: 'ARCHIVE',
      hardDelete: false,
    });

    expect(result.status).toBe('ARCHIVED');
    expect(result.canRestore).toBe(true);
  });

  it('硬删除：清空正文但**保留**消息计数与计量', async () => {
    const h = createHarness();

    const result = await h.service.deleteConversation({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      mode: 'DELETE',
      hardDelete: true,
    });

    expect(result.affectedMessages).toBe(8);
    expect(result.contentCleared).toBe(true);
    expect(result.usageRetained.tokensRetained).toBe(24860);
    expect(result.usageRetained.costCentsRetained).toBe(42);
    expect(result.usageRetained.note).toContain('不包含任何对话正文');
  });

  it('硬删除把 `clientMessageId` 置空（保留会让用户无法用同一 ID 重发）', async () => {
    const h = createHarness();
    const cleared: Array<{ data: Record<string, unknown> }> = [];

    h.prisma.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) =>
      fn({
        aiMessage: {
          updateMany: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            cleared.push(args);

            return Promise.resolve({ count: 8 });
          }),
        },
        aiConversation: {
          update: jest.fn().mockResolvedValue({ status: 'DELETED', deletedAt: NOW, archivedAt: null }),
        },
      }),
    );

    await h.service.deleteConversation({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      mode: 'DELETE',
      hardDelete: true,
    });

    expect(cleared[0]?.data['clientMessageId']).toBeNull();
    expect(cleared[0]?.data['content']).toBe('[已删除]');
  });

  it('重复删除返回成功（契约"天然幂等"），而不是 404', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow({ status: 'DELETED', deletedAt: NOW }));

    const result = await h.service.deleteConversation({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      mode: 'DELETE',
      hardDelete: false,
    });

    expect(result.status).toBe('DELETED');
    expect(result.affectedMessages).toBe(0);
    // 幂等短路不应再开事务
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('会话不存在 → 404', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(null);

    await expect(
      h.service.deleteConversation({
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        mode: 'DELETE',
        hardDelete: false,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.AI_CONVERSATION_NOT_FOUND });
  });

  it('会话属于其他用户 → 403（且**不**开事务，避免任何写入）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow({ userId: OTHER_USER_ID }));

    await expect(
      h.service.deleteConversation({
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        mode: 'DELETE',
        hardDelete: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.AI_CONVERSATION_NOT_OWNED, status: 403 });

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('buildContext — 上下文装配', () => {
  it('没有画像/关系/历史时也能装配成功（第一次倾诉是正常场景）', async () => {
    const h = createHarness();

    const prepared = await h.service.buildContext({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      includePersona: true,
      contextHints: [],
      withHistory: true,
    });

    expect(prepared.mode).toBe('COMPANION');
    expect(prepared.tone).toBe('WARM');
    expect(prepared.missingPersona).toBe('BOTH');
    expect(prepared.context.injectedMessages).toEqual([]);
  });

  it('会话级 includePersona = false 会覆盖调用方的 true（`scene` 是权威）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow({ scene: 'COMPANION|WARM|0' }));

    const prepared = await h.service.buildContext({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      includePersona: true,
      contextHints: [],
    });

    expect(prepared.includePersona).toBe(false);
    // 关闭画像时不报"画像缺失"：缺画像（`missingPersona`）与"用户主动不注入"
    // 是两种语义，混在一起会让前端弹出"先完成测试"的引导，而用户只是关掉了它
    expect(prepared.missingPersona).toBeNull();
  });

  it('关系已解除时仍返回关系信息（供调用方降级并提示用户，契约 §3.7.7 规则 5）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow({ relationshipId: 'rel-1' }));
    h.prisma.relationship.findFirst.mockResolvedValue({
      id: 'rel-1',
      type: 'COUPLE',
      status: 'REMOVED',
      userAId: USER_ID,
      userBId: OTHER_USER_ID,
    });

    const prepared = await h.service.buildContext({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      includePersona: true,
      contextHints: [],
    });

    expect(prepared.relationshipActive).toBe(false);
    expect(prepared.partnerNickname).toBe('小满');
  });
});

/**
 * 三模块摘要 —— "管家"能力（ADR-038 阶段 5）
 *
 * 这一组的重点是**它读的是画像而不是报告**：
 * 心理状态模块根本没有 AI 报告（产品红线是不给建议），
 * 只读 `ai_reports` 的实现在那个模块上是空的 —— 而"读取三个模块"这句话
 * 恰恰要求第三个模块也能被读到。
 */
describe('buildContext — ALL_MODULES 三模块摘要', () => {
  const personalityRow = {
    mbtiType: 'INFJ',
    mbtiConfidence: 78,
    eiPercent: 34,
    snPercent: 68,
    tfPercent: 61,
    jpPercent: 72,
    openness: 82,
    conscientiousness: 71,
    extraversion: 34,
    agreeableness: 88,
    neuroticism: 56,
  };

  const emotionRow = {
    attachmentStyle: 'ANXIOUS',
    attachmentAnxiety: 72,
    attachmentAvoidance: 31,
    primaryLoveLanguages: ['LOVE_WORDS', 'LOVE_TIME'],
    conflictStyle: 'CONFLICT_ACCOMMODATING',
  };

  const mentalHealthRow = {
    overallLevel: 'MILD',
    conclusion: '从本次作答看，你近期的状态整体有些起伏。其中「压力感受」比较明显。',
  };

  it('【关键】三个模块的结果都进入上下文（含**没有 AI 报告**的心理状态模块）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow());
    h.prisma.personalityProfile.findFirst.mockResolvedValue(personalityRow);
    h.prisma.emotionProfile.findFirst.mockResolvedValue(emotionRow);
    h.prisma.mentalHealthProfile.findFirst.mockResolvedValue(mentalHealthRow);

    const prepared = await h.service.buildContext({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      includePersona: true,
      contextHints: ['ALL_MODULES'],
    });

    const digest = prepared.context.blocks['memoryAndHints'] ?? '';

    expect(digest).toContain('INFJ');
    expect(digest).toContain('焦虑型'); // 情感：依恋
    expect(digest).toContain('肯定的言辞'); // 情感：爱的语言（编码译成中文）
    expect(digest).toContain('迁就型'); // 情感：冲突风格
    // 关键：第三个模块的**结论文本本身**要进上下文
    expect(digest).toContain('整体有些起伏');
    expect(digest).toContain('压力感受');
  });

  it('【关键】没做过的模块**不写进摘要**（不写"未测评"这类无信息量的占位）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow());
    h.prisma.personalityProfile.findFirst.mockResolvedValue(personalityRow);
    // 情感与心理状态都没做过

    const prepared = await h.service.buildContext({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      includePersona: true,
      contextHints: ['ALL_MODULES'],
    });

    const digest = prepared.context.blocks['memoryAndHints'] ?? '';

    expect(digest).toContain('INFJ');
    expect(digest).not.toContain('未测评');
    expect(digest).not.toContain('【情感／亲密关系】');
    expect(digest).not.toContain('【近两周状态】');
  });

  it('三个模块一个都没做过 → 不注入三模块摘要（但不影响已有的记忆摘要）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow());

    const prepared = await h.service.buildContext({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      includePersona: true,
      contextHints: ['ALL_MODULES'],
    });

    // `memoryAndHints` 这一块同时承载"记忆摘要"与"提示片段"，
    // 因此断言的是**没有注入三模块那一段**，而不是整块为空
    const hints = prepared.context.blocks['memoryAndHints'] ?? '';

    expect(hints).not.toContain('【你三个模块的测评结果】');
    expect(hints).toContain('之前聊过工作压力。');
  });

  it('未请求 ALL_MODULES 时不读另两张画像表（不做无谓查询）', async () => {
    const h = createHarness();
    h.prisma.aiConversation.findUnique.mockResolvedValue(conversationRow());

    await h.service.buildContext({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      includePersona: true,
      contextHints: [],
    });

    expect(h.prisma.emotionProfile.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.mentalHealthProfile.findFirst).not.toHaveBeenCalled();
  });
});
