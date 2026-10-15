/**
 * 报告生成编排测试
 *
 * 三条最重要、也最容易被写漏的断言：
 *   · **已成功的报告不再调用模型**（幂等 = 不为同一份内容付两次费）
 *   · **重新生成会清空旧分段**（否则上一版残留内容会混进新报告）
 *   · **失败也写用量日志**（失败调用同样消耗 token，漏记会让成本看板系统性低估）
 */

import { ErrorCode } from '../../../common/errors/error-code';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { LlmProviderFactory } from '../provider/llm-provider.factory';
import type { LlmCompletionResult } from '../provider/llm-provider.types';
import type { PromptService } from '../prompt/prompt.service';
import { ReportGenerationService } from './report-generation.service';

const REPORT_ID = 'report-1';
const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const PROFILE_ID = 'profile-1';

/** 报告正文：3 段，模板声明前 1 段免费 */
const REPORT_TEXT = [
  '这份报告基于你的测评结果生成。',
  '',
  '## 整体印象',
  '你倾向于先在内部构建模型。',
  '',
  '## 核心优势',
  '长期布局是你最突出的能力。',
  '',
  '## 成长建议',
  '可以刻意练习先表达感受。',
].join('\n');

const OUTPUT_SCHEMA = {
  sections: [
    { key: 'overview', title: '整体印象', freePreview: true },
    { key: 'strengths', title: '核心优势' },
    { key: 'growth', title: '成长建议' },
  ],
};

const completion = (content = REPORT_TEXT): LlmCompletionResult => ({
  provider: 'DEEPSEEK',
  model: 'deepseek-chat',
  content,
  json: null,
  usage: { promptTokens: 800, completionTokens: 1200, totalTokens: 2000 },
  latencyMs: 3200,
  finishReason: 'stop',
  providerRequestId: 'req-1',
});

const profile = (): Record<string, unknown> => ({
  id: PROFILE_ID,
  version: 3,
  engineVersion: '1.0.0',
  mbtiType: 'INFJ',
  mbtiConfidence: 82,
  eiPercent: 72,
  snPercent: 68,
  tfPercent: 61,
  jpPercent: 78,
  openness: 84,
  conscientiousness: 67,
  extraversion: 32,
  agreeableness: 72,
  neuroticism: 49,
  attachmentStyle: 'ATTACH_SECURE',
  loveLanguages: ['WORDS_OF_AFFIRMATION'],
  conflictStyle: null,
  consistencyScore: 88,
  completionRate: 100,
  avgResponseMs: 12_000,
});

interface Harness {
  service: ReportGenerationService;
  prisma: {
    aiReport: { findUnique: jest.Mock; update: jest.Mock };
    personalityProfile: { findFirst: jest.Mock; findMany: jest.Mock };
    testSession: { findFirst: jest.Mock };
    /** 读用户性别（ADR-039 的性别语境） */
    user: { findFirst: jest.Mock };
    reportSection: { deleteMany: jest.Mock; createMany: jest.Mock };
    aiUsageLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  prompts: { getPrompt: jest.Mock };
  providers: { resolveAvailable: jest.Mock };
  complete: jest.Mock;
  /** 事务替身（成功路径的报告更新发生在事务内） */
  tx: { aiReport: { update: jest.Mock }; compatibilityReport: { findFirst: jest.Mock; update: jest.Mock } };
}

const createHarness = (): Harness => {
  const complete = jest.fn().mockResolvedValue(completion());

  const tx = {
    reportSection: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    aiReport: { update: jest.fn().mockResolvedValue({ id: REPORT_ID }) },
    // 个人报告不会用到 `compatibilityReport`；关系报告用它把分段回写到
    // `advantages` / `conflicts` / `suggestions`。默认返回"没有关联的匹配报告"，
    // 关系报告的用例再各自覆盖
    compatibilityReport: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: 'compat-1' }),
    },
  };

  const prisma = {
    aiReport: {
      findUnique: jest.fn().mockResolvedValue({
        id: REPORT_ID,
        userId: USER_ID,
        type: 'MBTI_REPORT',
        status: 'QUEUED',
        profileId: PROFILE_ID,
        sessionId: null,
        promptTemplateKey: 'report.mbti',
        promptVersionId: 'ver-1',
      }),
      update: jest.fn().mockResolvedValue({ id: REPORT_ID }),
    },
    personalityProfile: {
      findFirst: jest.fn().mockResolvedValue(profile()),
      // 成长回顾报告用：默认给两版（够用），各用例按需覆盖
      findMany: jest.fn().mockResolvedValue([profile()]),
    },
    testSession: {
      findFirst: jest.fn().mockResolvedValue({
        definitionCode: 'MBTI_LITE',
        answeredCount: 32,
        questionCount: 32,
      }),
    },
    /**
     * 报告生成要读用户性别，用于注入 `{{genderContext}}`（ADR-039）
     *
     * 默认"未提供性别" → 报告走中性措辞（与真实行为一致：缺省即中性）。
     */
    user: { findFirst: jest.fn().mockResolvedValue({ gender: 'UNKNOWN' }) },
    reportSection: tx.reportSection,
    aiUsageLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
    $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
  };

  const prompts = {
    getPrompt: jest.fn().mockResolvedValue({
      templateKey: 'report.mbti',
      versionId: 'ver-1',
      version: 1,
      system: '你是分析师',
      user: '类型 INFJ',
      usedVariables: ['mbtiType'],
      provider: 'DEEPSEEK',
      model: 'deepseek-chat',
      temperature: 0.6,
      maxTokens: 2048,
      outputSchema: OUTPUT_SCHEMA,
    }),
  };

  const providers = {
    resolveAvailable: jest.fn().mockReturnValue({ name: 'DEEPSEEK', complete }),
  };

  const service = new ReportGenerationService(
    prisma as unknown as PrismaService,
    prompts as unknown as PromptService,
    providers as unknown as LlmProviderFactory,
  );

  return { service, prisma, prompts, providers, complete, tx };
};

/**
 * 取报告最近一次被写入的数据
 *
 * 成功路径的更新发生在**事务内**（tx 替身），失败路径用的是 prisma 替身 ——
 * 因此按「事务是否发生过」选择来源，避免读到事务前的 GENERATING 状态。
 */
const lastReportUpdate = (harness: Harness): Record<string, unknown> => {
  const source =
    harness.tx.aiReport.update.mock.calls.length > 0 ? harness.tx.aiReport.update : harness.prisma.aiReport.update;

  const calls = source.mock.calls;
  return (calls[calls.length - 1][0] as { data: Record<string, unknown> }).data;
};

describe('ReportGenerationService.runGeneration', () => {
  describe('成功路径', () => {
    it('调用 Provider 并按模板声明落库分段', async () => {
      const harness = createHarness();

      const result = await harness.service.runGeneration(REPORT_ID);

      expect(result).toEqual({ reportId: REPORT_ID, isReused: false });
      expect(harness.complete).toHaveBeenCalledTimes(1);

      const created = harness.prisma.reportSection.createMany.mock.calls[0][0] as {
        data: Array<Record<string, unknown>>;
      };
      expect(created.data).toHaveLength(3);
      expect(created.data.map((item) => item.sectionKey)).toEqual(['overview', 'strengths', 'growth']);
      // 免费标记来自模板声明
      expect(created.data[0].isFreePreview).toBe(true);
      expect(created.data[1].isFreePreview).toBe(false);
    });

    it('写入正文、长度、分段数与用量统计', async () => {
      const harness = createHarness();

      await harness.service.runGeneration(REPORT_ID);

      const data = lastReportUpdate(harness);
      expect(data.status).toBe('SUCCEEDED');
      expect(data.content).toBe(REPORT_TEXT);
      expect(data.sectionCount).toBe(3);
      expect(data.totalTokens).toBe(2000);
      expect(data.promptTokens).toBe(800);
      expect(data.completionTokens).toBe(1200);
      // 免费预览长度只算免费段
      expect(data.freePreviewLength).toBeGreaterThan(0);
      expect(Number(data.freePreviewLength)).toBeLessThan(Number(data.contentLength));
    });

    it('按价格表估算成本（2026 分/1K 输入、0.2 分/1K 输出 → 800*0.1 + 1200*0.2 向上取整）', async () => {
      const harness = createHarness();

      await harness.service.runGeneration(REPORT_ID);

      // 0.08 + 0.24 = 0.32 分 → 向上取整 1 分
      expect(lastReportUpdate(harness).costAmount).toBe(1);
    });

    it('标题由类型与类型名组成（便于列表页辨识）', async () => {
      const harness = createHarness();

      await harness.service.runGeneration(REPORT_ID);

      expect(lastReportUpdate(harness).title).toBe('INFJ 提倡者 深度解读');
    });

    /**
     * 标题必须**按报告类型**分派
     *
     * 原实现只看 `mbtiType` / `mbtiTypeName` 两个变量是否为 `undefined`，
     * 而 `buildReportContext` 保证变量永远存在（缺数据时填占位文案），
     * 于是兜底分支从不命中：纯大五画像会得到
     * 「（本次测评未包含此项） （本次测评未包含此项） 深度解读」。
     */
    describe('【关键】标题按类型分派，不把 MBTI 拼进其它类型', () => {
      /** 复用默认行只改差异字段，避免每个用例手抄一遍所有列 */
      const overrideReportRow = async (harness: Harness, overrides: Record<string, unknown>): Promise<void> => {
        const base = (await harness.prisma.aiReport.findUnique()) as Record<string, unknown>;
        harness.prisma.aiReport.findUnique.mockResolvedValue({ ...base, ...overrides });
      };

      const overrideProfile = async (harness: Harness, overrides: Record<string, unknown>): Promise<void> => {
        const base = (await harness.prisma.personalityProfile.findFirst()) as Record<string, unknown>;
        harness.prisma.personalityProfile.findFirst.mockResolvedValue({ ...base, ...overrides });
      };

      it('大五报告即使用户做过 MBTI，标题也不写 MBTI 类型（否则标题与正文不符）', async () => {
        const harness = createHarness();
        await overrideReportRow(harness, { type: 'BIG_FIVE_REPORT', promptTemplateKey: 'report.bigfive' });

        await harness.service.runGeneration(REPORT_ID);

        expect(lastReportUpdate(harness).title).toBe('大五人格报告');
      });

      it('大五报告在画像没有 MBTI 时，标题不出现「（本次测评未包含此项）」', async () => {
        const harness = createHarness();
        await overrideReportRow(harness, { type: 'BIG_FIVE_REPORT', promptTemplateKey: 'report.bigfive' });
        await overrideProfile(harness, { mbtiType: null });

        await harness.service.runGeneration(REPORT_ID);

        const title = String(lastReportUpdate(harness).title);
        expect(title).toBe('大五人格报告');
        expect(title).not.toContain('本次测评未包含此项');
      });

      it('MBTI 报告在画像没有 MBTI 类型时回落到类型中文名（而不是占位文案拼出来的标题）', async () => {
        const harness = createHarness();
        await overrideProfile(harness, { mbtiType: null });

        await harness.service.runGeneration(REPORT_ID);

        const title = String(lastReportUpdate(harness).title);
        expect(title).toBe('人格深度报告');
        expect(title).not.toContain('本次测评未包含此项');
      });
    });

    /**
     * 成长回顾报告走**版本序列**路径
     *
     * 它与个人报告的关键差别就是"读几版画像"：`ai_reports` 存不下版本列表，
     * 因此序列由锚定画像的版本号**确定性推导**（锚定版本及其之前的最近 N 版）。
     * 这里既断言取数条件，也断言**真的把跨版本变量喂给了模型** ——
     * 成长报告的价值全在对比，只用最新一版等于换个标题的个人报告。
     */
    describe('成长回顾报告（GROWTH_SUMMARY）', () => {
      /** 三版画像：开放性 62 → 70 → 78，类型在第 3 版发生变化 */
      const versions = [
        { ...profile(), id: 'profile-v1', version: 1, createdAt: new Date('2026-01-05T02:00:00.000Z'), openness: 62 },
        { ...profile(), id: 'profile-v2', version: 2, createdAt: new Date('2026-03-18T02:00:00.000Z'), openness: 70 },
        { ...profile(), id: PROFILE_ID, version: 3, createdAt: new Date('2026-06-20T02:00:00.000Z'), openness: 78 },
      ];

      const setUp = async (harness: Harness): Promise<void> => {
        const base = (await harness.prisma.aiReport.findUnique()) as Record<string, unknown>;
        harness.prisma.aiReport.findUnique.mockResolvedValue({
          ...base,
          type: 'GROWTH_SUMMARY',
          promptTemplateKey: 'report.growth',
        });
        // 锚定画像 = 最新一版（实现只取它的 version 作为序列上界）
        harness.prisma.personalityProfile.findFirst.mockResolvedValue({ id: PROFILE_ID, version: 3 });
        // 序列查询按版本**降序**返回（与实现的 orderBy 一致），实现再反转成升序
        harness.prisma.personalityProfile.findMany.mockResolvedValue([...versions].reverse());
      };

      it('【关键】按"锚定版本及之前"取序列（降序取最近 12 版，再由实现反转成升序）', async () => {
        const harness = createHarness();
        await setUp(harness);

        await harness.service.runGeneration(REPORT_ID);

        expect(harness.prisma.personalityProfile.findMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, deletedAt: null, version: { lte: 3 } },
          orderBy: { version: 'desc' },
          take: 12,
          // `createdAt` 是成长报告排时间线必需的字段，漏了它只能写"未知日期"
          select: expect.objectContaining({ id: true, version: true, createdAt: true }),
        });
      });

      it('【关键】喂给模型的是跨版本变量（只用最新一版就等于换了标题的个人报告）', async () => {
        const harness = createHarness();
        await setUp(harness);

        await harness.service.runGeneration(REPORT_ID);

        const variables = harness.prompts.getPrompt.mock.calls[0]?.[1] as Record<string, string>;

        expect(variables['profileCount']).toBe('3');
        // v1 的 62 到 v3 的 78
        expect(variables['growthTimeline']).toContain('v1');
        expect(variables['scoreDeltas']).toContain('+16');
      });

      it('标题带上版本数（列表页一眼看出这份报告基于几次测评）', async () => {
        const harness = createHarness();
        await setUp(harness);

        await harness.service.runGeneration(REPORT_ID);

        expect(lastReportUpdate(harness).title).toBe('成长回顾报告（近 3 次测评）');
      });

      it('锚定画像不存在时明确报错（不静默退回"用户的某一份画像"）', async () => {
        const harness = createHarness();
        await setUp(harness);
        harness.prisma.personalityProfile.findFirst.mockResolvedValue(null);

        await expect(harness.service.runGeneration(REPORT_ID)).rejects.toMatchObject({
          code: ErrorCode.PERSONALITY_PROFILE_NOT_FOUND,
        });
      });
    });

    it('引言作为摘要下发', async () => {
      const harness = createHarness();

      await harness.service.runGeneration(REPORT_ID);

      expect(lastReportUpdate(harness).summary).toBe('这份报告基于你的测评结果生成。');
    });

    it('写入成功的用量日志', async () => {
      const harness = createHarness();

      await harness.service.runGeneration(REPORT_ID);

      expect(harness.prisma.aiUsageLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: USER_ID,
            reportId: REPORT_ID,
            taskType: 'MBTI_REPORT',
            provider: 'DEEPSEEK',
            model: 'deepseek-chat',
            totalTokens: 2000,
            success: true,
          }),
        }),
      );
    });
  });

  describe('幂等', () => {
    it('【关键】报告已成功时直接复用，不再调用模型（不为同一内容付两次费）', async () => {
      const harness = createHarness();
      harness.prisma.aiReport.findUnique.mockResolvedValue({
        id: REPORT_ID,
        userId: USER_ID,
        type: 'MBTI_REPORT',
        status: 'SUCCEEDED',
        profileId: PROFILE_ID,
        sessionId: null,
        promptTemplateKey: 'report.mbti',
        promptVersionId: 'ver-1',
      });

      const result = await harness.service.runGeneration(REPORT_ID);

      expect(result.isReused).toBe(true);
      expect(harness.complete).not.toHaveBeenCalled();
      expect(harness.prisma.aiUsageLog.create).not.toHaveBeenCalled();
    });

    it('报告不存在时抛 50016', async () => {
      const harness = createHarness();
      harness.prisma.aiReport.findUnique.mockResolvedValue(null);

      await expect(harness.service.runGeneration(REPORT_ID)).rejects.toMatchObject({
        code: ErrorCode.AI_REPORT_NOT_FOUND,
      });
    });

    it('报告未关联画像时抛 40010', async () => {
      const harness = createHarness();
      harness.prisma.aiReport.findUnique.mockResolvedValue({
        id: REPORT_ID,
        userId: USER_ID,
        type: 'MBTI_REPORT',
        status: 'QUEUED',
        profileId: null,
        sessionId: null,
        promptTemplateKey: 'report.mbti',
        promptVersionId: null,
      });

      await expect(harness.service.runGeneration(REPORT_ID)).rejects.toMatchObject({
        code: ErrorCode.PERSONALITY_PROFILE_NOT_FOUND,
      });
    });
  });

  describe('重新生成', () => {
    it('【关键】先清空旧分段再写入，避免上一版残留内容混入', async () => {
      const harness = createHarness();

      await harness.service.runGeneration(REPORT_ID);

      expect(harness.prisma.reportSection.deleteMany).toHaveBeenCalledWith({
        where: { reportId: REPORT_ID },
      });
      // 删除必须发生在写入之前
      const deleteOrder = harness.prisma.reportSection.deleteMany.mock.invocationCallOrder[0];
      const createOrder = harness.prisma.reportSection.createMany.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(createOrder);
    });
  });

  describe('失败语义', () => {
    it('Provider 抛错时报告标记 FAILED 并带上错误码', async () => {
      const harness = createHarness();
      harness.complete.mockRejectedValue(
        Object.assign(new Error('限流'), { code: ErrorCode.AI_PROVIDER_RATE_LIMITED }),
      );

      await expect(harness.service.runGeneration(REPORT_ID)).rejects.toThrow();

      const data = lastReportUpdate(harness);
      expect(data.status).toBe('FAILED');
      expect(data.errorCode).toBe(String(ErrorCode.AI_PROVIDER_RATE_LIMITED));
      expect(data.errorMessage).toContain('限流');
    });

    it('【关键】模型返回空内容时判为失败（不落库空报告）', async () => {
      const harness = createHarness();
      harness.complete.mockResolvedValue(completion('   '));

      await expect(harness.service.runGeneration(REPORT_ID)).rejects.toMatchObject({
        code: ErrorCode.AI_OUTPUT_INVALID,
      });
      expect(lastReportUpdate(harness).status).toBe('FAILED');
      expect(harness.prisma.reportSection.createMany).not.toHaveBeenCalled();
    });

    it('【关键】模型输出全是空段落时同样判为失败', async () => {
      const harness = createHarness();
      harness.complete.mockResolvedValue(completion('## 一\n\n## 二\n\n'));

      await expect(harness.service.runGeneration(REPORT_ID)).rejects.toMatchObject({
        code: ErrorCode.AI_OUTPUT_INVALID,
      });
      expect(harness.prisma.reportSection.createMany).not.toHaveBeenCalled();
    });

    it('【关键】失败但已产生 token 消耗时仍写用量日志（success=false）', async () => {
      const harness = createHarness();
      // 先返回有效内容让 completion 被赋值，随后在落库阶段失败
      harness.complete.mockResolvedValue(completion());
      harness.prisma.$transaction.mockRejectedValue(new Error('db down'));

      await expect(harness.service.runGeneration(REPORT_ID)).rejects.toThrow('db down');

      expect(harness.prisma.aiUsageLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ success: false }) }),
      );
    });

    it('调用未成功返回时无 token 数据，不写用量日志（无消耗可记）', async () => {
      const harness = createHarness();
      harness.complete.mockRejectedValue(new Error('connection refused'));

      await expect(harness.service.runGeneration(REPORT_ID)).rejects.toThrow();

      expect(harness.prisma.aiUsageLog.create).not.toHaveBeenCalled();
    });

    it('【关键】记账失败不影响已成功的报告（报告已落库，日志可事后补）', async () => {
      const harness = createHarness();
      harness.prisma.aiUsageLog.create.mockRejectedValue(new Error('db down'));

      await expect(harness.service.runGeneration(REPORT_ID)).resolves.toEqual({
        reportId: REPORT_ID,
        isReused: false,
      });
    });

    it('画像不存在时抛 40010', async () => {
      const harness = createHarness();
      harness.prisma.personalityProfile.findFirst.mockResolvedValue(null);

      await expect(harness.service.runGeneration(REPORT_ID)).rejects.toMatchObject({
        code: ErrorCode.PERSONALITY_PROFILE_NOT_FOUND,
      });
    });
  });

  describe('Provider 选择', () => {
    it('模板声明了 provider 时按声明解析（合规要求指定厂商时不被替换）', async () => {
      const harness = createHarness();

      await harness.service.runGeneration(REPORT_ID);

      expect(harness.providers.resolveAvailable).toHaveBeenCalledWith('DEEPSEEK');
    });

    it('模板未声明 provider 时交给工厂按配置选择', async () => {
      const harness = createHarness();
      harness.prompts.getPrompt.mockResolvedValue({
        templateKey: 'report.mbti',
        versionId: 'ver-1',
        version: 1,
        system: 's',
        user: 'u',
        usedVariables: [],
        provider: null,
        model: null,
        temperature: null,
        maxTokens: null,
        outputSchema: OUTPUT_SCHEMA,
      });

      await harness.service.runGeneration(REPORT_ID);

      expect(harness.providers.resolveAvailable).toHaveBeenCalledWith(undefined);
    });
  });
});
