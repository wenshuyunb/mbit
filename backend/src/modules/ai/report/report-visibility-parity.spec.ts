/**
 * 【关键】详情接口与分段接口的裁剪一致性（契约 §3.5.4 规则 1）
 *
 * 这是本模块最不能出错的地方：两个接口都下发报告正文，若其中一个的可见性判定
 * 与另一个不同，后果是**付费内容被免费读取**（"详情锁了、分段没锁"）。
 *
 * 因此这里不满足于"各自测各自的"，而是把两个接口的响应放在一起比对：
 *   ① 同一段落在两个接口里的 `content` 必须**逐字相同**（含同为 null）；
 *   ② 未解锁时响应体的 JSON 里**不得出现付费正文的任何片段**（抓包视角的断言）；
 *   ③ 解锁后（整份 / 单段）两个接口同步开放同一段。
 *
 * 断言 ② 是刻意写成"序列化后全文搜索"的：只要有人新增一个字段把正文带上，
 * 无论字段名叫什么，这条断言都会红。
 */

import type { Queue } from 'bullmq';

import { ErrorCode } from '../../../common/errors/error-code';
import type { CryptoService } from '../../../infra/crypto/crypto.service';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { PromptService } from '../prompt/prompt.service';
import { ReportSectionsService } from './report-sections.service';
import { ReportService } from './report.service';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const REPORT_ID = '0195f3a2-b24e-7a86-abf1-7dae4b5c6f45';

const FREE_TEXT = '你是安静而坚定的人。这是免费段落的正文。';
const PAID_TEXT_A = '付费段落A：你对他人的情绪有近乎本能的敏感，这是只有解锁后才能读到的一句话。';
const PAID_TEXT_B = '付费段落B：把不安说出口，而不是自己消化掉。';

const SECTIONS = [
  {
    id: 'section-1',
    sectionKey: 'CORE_PORTRAIT',
    title: '你的核心画像',
    content: FREE_TEXT,
    order: 1,
    isFreePreview: true,
  },
  {
    id: 'section-2',
    sectionKey: 'DIMENSION_ANALYSIS',
    title: '四维倾向深度解析',
    content: PAID_TEXT_A,
    order: 2,
    isFreePreview: false,
  },
  {
    id: 'section-3',
    sectionKey: 'ACTION_PLAN',
    title: '30 天行动清单',
    content: PAID_TEXT_B,
    order: 3,
    isFreePreview: false,
  },
];

const TOTAL_LENGTH = SECTIONS.reduce((sum, section) => sum + section.content.length, 0);
const FREE_LENGTH = FREE_TEXT.length;

const createPrisma = (): {
  aiReport: { findFirst: jest.Mock };
  reportSection: { findMany: jest.Mock };
} => ({
  aiReport: {
    findFirst: jest.fn().mockResolvedValue({
      id: REPORT_ID,
      type: 'MBTI_REPORT',
      status: 'SUCCEEDED',
      title: 'INFJ 提倡者 深度解读',
      summary: '引言',
      sectionCount: SECTIONS.length,
      contentLength: TOTAL_LENGTH,
      freePreviewLength: FREE_LENGTH,
      provider: 'DEEPSEEK',
      model: 'deepseek-chat',
      createdAt: new Date('2026-02-14T14:00:00.000Z'),
      generationFinishedAt: new Date('2026-02-14T14:00:52.000Z'),
      profile: { mbtiType: 'INFJ', engineVersion: 'pe-v1.0.0' },
    }),
  },
  reportSection: { findMany: jest.fn().mockResolvedValue(SECTIONS) },
});

interface Harness {
  detail: (unlock: { allUnlocked: boolean; unlockedSectionKeys: ReadonlySet<string> }) => Promise<{
    sections: readonly { sectionKey: string; content: string | null }[];
  }>;
  sections: (input: {
    allUnlocked: boolean;
    unlockedSectionKeys?: ReadonlySet<string>;
    includeContent?: boolean;
    sectionKey?: string;
  }) => Promise<{
    items: readonly { sectionKey: string; content?: string | null; locked: boolean; isTruncated: boolean }[];
    lockedCount: number;
    unlockedCount: number;
  }>;
}

const createHarness = (): Harness => {
  const build = (): { reportService: ReportService; sectionsService: ReportSectionsService } => {
    const prisma = createPrisma();
    const crypto = { sha256: (value: string): string => `hash(${value})` } as unknown as CryptoService;
    const prompts = { getTemplateMeta: jest.fn() } as unknown as PromptService;
    const queue = { add: jest.fn() } as unknown as Queue;

    return {
      reportService: new ReportService(prisma as unknown as PrismaService, crypto, prompts, queue),
      sectionsService: new ReportSectionsService(prisma as unknown as PrismaService),
    };
  };

  return {
    detail: async (unlock) => {
      const { reportService } = build();

      return reportService.getDetail(USER_ID, REPORT_ID, unlock);
    },
    sections: async (input) => {
      const { sectionsService } = build();
      const unlockedSectionKeys = input.unlockedSectionKeys ?? new Set<string>();

      return sectionsService.getSections({
        userId: USER_ID,
        reportId: REPORT_ID,
        unlock: { allUnlocked: input.allUnlocked, unlockedSectionKeys },
        includeContent: input.includeContent ?? true,
        ...(input.sectionKey !== undefined ? { sectionKey: input.sectionKey } : {}),
      });
    },
  };
};

describe('报告裁剪一致性（详情 vs 分段，契约 §3.5.4 规则 1）', () => {
  it('【关键】未解锁时两个接口对每一段的 content 判定完全一致，且响应体中不含付费正文', async () => {
    const harness = createHarness();
    const unlock = { allUnlocked: false, unlockedSectionKeys: new Set<string>() };

    const detail = await harness.detail(unlock);
    const sections = await harness.sections({ allUnlocked: false });

    expect(sections.items).toHaveLength(3);
    for (const [index, item] of sections.items.entries()) {
      const detailSection = detail.sections[index];
      expect(detailSection).toBeDefined();
      expect(item.sectionKey).toBe(detailSection?.sectionKey);
      // 逐字相同：要么都给了全文，要么都给了 null
      expect(item.content).toBe(detailSection?.content ?? null);
    }

    // 未解锁：免费段可读、付费段为 null
    expect(sections.items[0]?.content).toBe(FREE_TEXT);
    expect(sections.items[1]?.content).toBeNull();
    expect(sections.items[2]?.content).toBeNull();

    // 抓包视角：序列化后的响应里不得出现任何付费正文片段
    const payload = JSON.stringify(sections);
    expect(payload).not.toContain(PAID_TEXT_A);
    expect(payload).not.toContain(PAID_TEXT_B);
    expect(payload).not.toContain('只有解锁后才能读到');

    // 元数据仍下发（只暴露体量，不算泄露）
    expect(sections.items[1]?.locked).toBe(true);
    expect(sections.items[1]?.isTruncated).toBe(true);
    expect(sections.lockedCount).toBe(2);
    expect(unlock.allUnlocked).toBe(false);
  });

  it('单段解锁后两个接口同步开放同一段，且只开放该段', async () => {
    const harness = createHarness();
    const unlock = { allUnlocked: false, unlockedSectionKeys: new Set(['DIMENSION_ANALYSIS']) };

    const detail = await harness.detail(unlock);
    const sections = await harness.sections({
      allUnlocked: false,
      unlockedSectionKeys: new Set(['DIMENSION_ANALYSIS']),
    });

    expect(sections.items[1]?.content).toBe(PAID_TEXT_A);
    expect(detail.sections[1]?.content).toBe(PAID_TEXT_A);
    // 未解锁的另一段仍为 null（"解锁一段"不等于"解锁整份"）
    expect(sections.items[2]?.content).toBeNull();
    expect(detail.sections[2]?.content).toBeNull();

    expect(sections.lockedCount).toBe(1);
    expect(sections.unlockedCount).toBe(1);
  });

  it('整份解锁（会员）后两处都返回全文，且 lockedCount 归零', async () => {
    const harness = createHarness();
    const unlock = { allUnlocked: true, unlockedSectionKeys: new Set<string>() };

    const detail = await harness.detail(unlock);
    const sections = await harness.sections({ allUnlocked: true });

    expect(sections.items.map((item) => item.content)).toEqual([FREE_TEXT, PAID_TEXT_A, PAID_TEXT_B]);
    expect(detail.sections.map((section) => section.content)).toEqual([FREE_TEXT, PAID_TEXT_A, PAID_TEXT_B]);
    expect(sections.lockedCount).toBe(0);
    // 免费段不计入 unlockedCount（口径见 `countSections` 注释）
    expect(sections.unlockedCount).toBe(2);
    expect(sections.items.every((item) => !item.isTruncated)).toBe(true);
  });

  it('includeContent=false 时目录里根本没有 content 字段（而不是 null）', async () => {
    const harness = createHarness();
    const sections = await harness.sections({ allUnlocked: false, includeContent: false });

    for (const item of sections.items) {
      expect(Object.prototype.hasOwnProperty.call(item, 'content')).toBe(false);
    }
  });

  it('单段请求：items 只含该段，但计数仍是全报告口径（契约规则 4）', async () => {
    const harness = createHarness();
    const sections = await harness.sections({ allUnlocked: false, sectionKey: 'ACTION_PLAN' });

    expect(sections.items).toHaveLength(1);
    expect(sections.items[0]?.sectionKey).toBe('ACTION_PLAN');
    expect(sections.lockedCount).toBe(2);
    expect(sections.unlockedCount).toBe(0);
  });

  it('报告不存在或不属于当前用户时返回 50016（不区分二者）', async () => {
    const prisma = createPrisma();
    prisma.aiReport.findFirst.mockResolvedValue(null);
    const service = new ReportSectionsService(prisma as unknown as PrismaService);

    await expect(
      service.getSections({
        userId: USER_ID,
        reportId: REPORT_ID,
        unlock: { allUnlocked: false, unlockedSectionKeys: new Set() },
        includeContent: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.AI_REPORT_NOT_FOUND });
  });

  it('报告仍在生成中返回 50017；无分段数据也返回 50017（契约错误表）', async () => {
    const generating = createPrisma();
    generating.aiReport.findFirst.mockResolvedValue({
      id: REPORT_ID,
      status: 'GENERATING',
      contentLength: 0,
      freePreviewLength: 0,
    });
    const service = new ReportSectionsService(generating as unknown as PrismaService);

    await expect(
      service.getSections({
        userId: USER_ID,
        reportId: REPORT_ID,
        unlock: { allUnlocked: false, unlockedSectionKeys: new Set() },
        includeContent: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.AI_REPORT_GENERATING });

    const empty = createPrisma();
    empty.reportSection.findMany.mockResolvedValue([]);
    const emptyService = new ReportSectionsService(empty as unknown as PrismaService);

    await expect(
      emptyService.getSections({
        userId: USER_ID,
        reportId: REPORT_ID,
        unlock: { allUnlocked: true, unlockedSectionKeys: new Set() },
        includeContent: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.AI_REPORT_GENERATING });
  });
});
