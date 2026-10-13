/**
 * 分享卡服务测试（契约 §3.5.9）
 *
 * 最重要的是**防付费内容外泄**：`QUOTE_CARD` 的金句只允许来自免费预览段，
 * 且拒绝必须发生在"扣配额 / 渲染"之前 —— 否则一次被拒的请求也会消耗用户的额度。
 *
 * 渲染器被部分替换：验证链路成功时给一次模拟产物；
 * 需要验证"渲染失败也要归还配额"时，让渲染 mock 抛一个真实的渲染错误。
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { CryptoService } from '../../../infra/crypto/crypto.service';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import type { EntitlementService } from '../../membership/entitlement.service';
import type { StorageService } from '../../storage/storage.service';
import type { SystemConfigService } from '../../system/system-config.service';
import type { WechatService } from '../../../infra/wechat/wechat.service';
import type { ReportQuotaService } from './report-quota.service';
import { ReportShareCardService } from './report-share-card.service';
import type * as renderModule from './report-render.util';
import { renderShareCardImage } from './report-render.util';

jest.mock('./report-render.util', () => {
  const actual = jest.requireActual<typeof renderModule>('./report-render.util');

  return {
    ...actual,
    renderShareCardImage: jest.fn(actual.renderShareCardImage),
  };
});

const renderMock = renderShareCardImage as jest.MockedFunction<typeof renderShareCardImage>;

const USER_ID = 'user-1';
const REPORT_ID = '0195f3a2-b24e-7a86-abf1-7dae4b5c6f45';
const FREE_TEXT = '你是安静而坚定的人，这是免费段落的正文。';
const PAID_TEXT = '付费段落正文：只有解锁后才能读到的内容。';

interface Harness {
  service: ReportShareCardService;
  prisma: {
    aiReport: { findFirst: jest.Mock };
    reportSection: { findMany: jest.Mock };
    user: { findUnique: jest.Mock };
    outboxEvent: { create: jest.Mock };
  };
  redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock; key: jest.Mock; getJson: jest.Mock; setJson: jest.Mock };
  quota: { consumeWindowQuota: jest.Mock; refundWindowQuota: jest.Mock };
  storage: { uploadServerObject: jest.Mock; makeServerObjectPublic: jest.Mock; publicUrlOf: jest.Mock };
  wechat: { getMiniAppCode: jest.Mock };
}

const createHarness = (options: { unlocked?: boolean; existingCard?: unknown } = {}): Harness => {
  const prisma = {
    aiReport: {
      findFirst: jest.fn().mockResolvedValue({
        status: 'SUCCEEDED',
        profile: {
          mbtiType: 'INFJ',
          eiPercent: 34.5,
          snPercent: 68.2,
          tfPercent: 61.4,
          jpPercent: 72.8,
          openness: 82.5,
          conscientiousness: 71,
          extraversion: 34.5,
          agreeableness: 88,
          neuroticism: 56.5,
        },
      }),
    },
    reportSection: {
      findMany: jest.fn().mockResolvedValue([
        { sectionKey: 'CORE_PORTRAIT', title: '核心画像', content: FREE_TEXT, order: 1, isFreePreview: true },
        { sectionKey: 'ACTION_PLAN', title: '行动清单', content: PAID_TEXT, order: 2, isFreePreview: false },
      ]),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ nickname: '小明' }) },
    outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'outbox-1' }) },
  };

  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    key: jest.fn((...parts: (string | number)[]) => parts.join(':')),
    getJson: jest.fn().mockResolvedValue(options.existingCard ?? null),
    setJson: jest.fn().mockResolvedValue(undefined),
  };

  const quota = {
    consumeWindowQuota: jest.fn().mockResolvedValue({
      used: 1,
      limit: 10,
      remaining: 9,
      resetAt: '2026-02-14T15:00:00.000Z',
    }),
    refundWindowQuota: jest.fn().mockResolvedValue(undefined),
  };

  const storage = {
    uploadServerObject: jest.fn().mockResolvedValue({ etag: 'etag-1', sizeBytes: 268400 }),
    makeServerObjectPublic: jest.fn().mockResolvedValue(true),
    publicUrlOf: jest.fn().mockReturnValue(`https://cdn.example.com/share-card/${USER_ID}/${REPORT_ID}.webp`),
  };

  const entitlements = {
    resolveReportUnlock: jest.fn().mockResolvedValue({
      allUnlocked: options.unlocked ?? false,
      unlockedSectionKeys: new Set<string>(),
      source: 'NONE',
    }),
  };

  const systemConfigs = {
    getEntry: jest.fn().mockImplementation((key: string): Promise<{ value: unknown }> => {
      if (key === 'share.templates') {
        return Promise.resolve({
          value: {
            DEFAULT: { title: '默认标题', text: '默认文案' },
            REPORT: {
              title: '我的人格深度报告',
              text: '我的 MBTI 是 {{mbtiType}}（{{typeName}}）——{{tagline}}。来测测你的？',
            },
          },
        });
      }

      return Promise.resolve({ value: '/pages/index/index' });
    }),
  };

  /**
   * 微信侧：小程序码改为**复用 `WechatService.getMiniAppCode()`**（原先 util 里那份桩已删除）。
   * 默认返回一个假的 PNG 字节 = "微信返回了图"，需要降级分支的用例再单独覆盖为 `null`。
   */
  const wechat = { getMiniAppCode: jest.fn().mockResolvedValue(Buffer.from('mock-qr')) };

  return {
    service: new ReportShareCardService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      { sha256: (value: string) => `sha256:${value.slice(0, 40)}` } as unknown as CryptoService,
      storage as unknown as StorageService,
      entitlements as unknown as EntitlementService,
      quota as unknown as ReportQuotaService,
      systemConfigs as unknown as SystemConfigService,
      wechat as unknown as WechatService,
    ),
    prisma,
    redis,
    quota,
    storage,
    wechat,
  };
};

const request = (
  overrides: Record<string, unknown> = {},
): Parameters<ReportShareCardService['generateShareCard']>[0] => ({
  userId: USER_ID,
  reportId: REPORT_ID,
  idempotencyKey: 'idem-key-12345678',
  ...overrides,
});

const renderedArtifact = {
  body: Buffer.from('mock-webp'),
  contentType: 'image/webp',
  sizeBytes: 268400,
  width: 750,
  height: 1334,
  pageCount: null,
  // 图片是光栅化的，没有字体概念
  fontEmbedded: null,
  fontSubsetted: null,
};

describe('ReportShareCardService.generateShareCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('【关键】QUOTE_CARD 指向付费段落 → 10001，且发生在扣配额与渲染之前', async () => {
    const harness = createHarness({ unlocked: false });

    await expect(
      harness.service.generateShareCard(request({ template: 'QUOTE_CARD', quoteSectionKey: 'ACTION_PLAN' })),
    ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });

    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
    expect(harness.storage.uploadServerObject).not.toHaveBeenCalled();
  });

  it('【关键】QUOTE_CARD 指向免费段落 → 金句只取免费正文', async () => {
    const harness = createHarness({ unlocked: false });
    renderMock.mockResolvedValueOnce(renderedArtifact);

    const view = await harness.service.generateShareCard(
      request({ template: 'QUOTE_CARD', quoteSectionKey: 'CORE_PORTRAIT' }),
    );

    const input = renderMock.mock.calls[0]?.[0];
    expect(input?.quote).toBe(FREE_TEXT);
    // 传给渲染器的素材里不得出现付费正文
    expect(JSON.stringify(input)).not.toContain(PAID_TEXT);
    expect(view.shareCardId).toBeDefined();
  });

  it('QUOTE_CARD 缺 quoteSectionKey → 10001（契约错误 10002）', async () => {
    const harness = createHarness();

    await expect(harness.service.generateShareCard(request({ template: 'QUOTE_CARD' }))).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID,
    });
    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
  });

  it('解锁后付费段落可用于金句（会员场景）', async () => {
    const harness = createHarness({ unlocked: true });
    renderMock.mockResolvedValueOnce(renderedArtifact);

    await harness.service.generateShareCard(request({ template: 'QUOTE_CARD', quoteSectionKey: 'ACTION_PLAN' }));

    expect(renderMock.mock.calls[0]?.[0].quote).toBe(PAID_TEXT);
  });

  it('生成成功：返回 750×1334 卡片、缩略图带 x-oss-process、分享文案来自配置模板', async () => {
    const harness = createHarness();
    renderMock.mockResolvedValueOnce(renderedArtifact);

    const view = await harness.service.generateShareCard(request());

    expect(view).toMatchObject({
      reportId: REPORT_ID,
      template: 'TYPE_CARD',
      width: 750,
      height: 1334,
      sizeBytes: 268400,
      showQrCode: true,
      qrCodeScene: 'report_0195f3a2',
      scene: 'REPORT',
      shareTitle: '我的人格深度报告',
    });
    // 文案来自 system_configs 的模板并完成插值（不硬编码）
    expect(view.shareText).toContain('INFJ');
    expect(view.shareText).toContain('提倡者');
    expect(view.thumbUrl).toContain('x-oss-process=image/resize,w_240/format,webp');
    // 分享图需要被小程序直接引用 → 置为公开可读
    expect(harness.storage.makeServerObjectPublic).toHaveBeenCalledTimes(1);
    expect(harness.redis.setJson).toHaveBeenCalled();
  });

  it('showNickname=false 时渲染素材里是脱敏文案（渲染实现不可能拿到真实昵称）', async () => {
    const harness = createHarness();
    renderMock.mockResolvedValueOnce(renderedArtifact);

    await harness.service.generateShareCard(request({ showNickname: false }));

    expect(renderMock.mock.calls[0]?.[0].displayName).toBe('一位 INFJ');
    expect(JSON.stringify(renderMock.mock.calls[0]?.[0])).not.toContain('小明');
  });

  it('命中缓存时不渲染、不扣配额（同参数复用 30 天）', async () => {
    const cached = {
      shareCardId: 'card-cached',
      reportId: REPORT_ID,
      userId: USER_ID,
      template: 'TYPE_CARD',
      fingerprint: 'fp',
      scene: 'REPORT',
      showQrCode: true,
      showNickname: true,
      quoteSectionKey: null,
      objectKey: 'share-card/x.webp',
      imageUrl: 'https://cdn.example.com/x.webp',
      thumbUrl: 'https://cdn.example.com/x.webp?x-oss-process=image/resize,w_240',
      width: 750,
      height: 1334,
      sizeBytes: 100,
      qrCodeScene: 'report_0195f3a2',
      shareText: '文案',
      shareTitle: '标题',
      renderDurationMs: 5,
      createdAt: '2026-02-14T14:30:00.000Z',
      expiresAt: '2026-03-16T14:30:00.000Z',
      warnings: [],
    };

    const harness = createHarness({ existingCard: cached });
    harness.redis.get.mockResolvedValue('card-cached');

    const view = await harness.service.generateShareCard(request());

    expect(view.shareCardId).toBe('card-cached');
    expect(renderMock).not.toHaveBeenCalled();
    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
  });

  it('forceRefresh=true 时忽略缓存重新渲染', async () => {
    const harness = createHarness({ existingCard: { shareCardId: 'card-cached' } });
    harness.redis.get.mockResolvedValue('card-cached');
    renderMock.mockResolvedValueOnce(renderedArtifact);

    await harness.service.generateShareCard(request({ forceRefresh: true }));

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(harness.quota.consumeWindowQuota).toHaveBeenCalledTimes(1);
  });

  it('【关键】渲染失败 → 归还配额、不上传任何产物（绝不返回占位图）', async () => {
    const harness = createHarness();
    // 真实渲染失败的最典型原因是"部署缺字体"（90008）。这里模拟它：
    // 关键不变量是**失败必须归还配额且不产生任何上传**，而不是"渲染器永远失败"。
    renderMock.mockRejectedValueOnce(new BusinessException(ErrorCode.CONFIG_MISSING, '报告字体缺失'));

    await expect(harness.service.generateShareCard(request())).rejects.toMatchObject({
      code: ErrorCode.CONFIG_MISSING,
    });

    expect(harness.storage.uploadServerObject).not.toHaveBeenCalled();
    expect(harness.quota.refundWindowQuota).toHaveBeenCalledTimes(1);
  });

  it('小程序码生成失败时降级：不阻断、showQrCode 置 false、附 warnings、写 outbox 重试', async () => {
    const harness = createHarness();
    harness.wechat.getMiniAppCode.mockResolvedValueOnce(null);
    renderMock.mockResolvedValueOnce(renderedArtifact);

    const view = await harness.service.generateShareCard(request({ showQrCode: true }));

    expect(view.showQrCode).toBe(false);
    expect(view.warnings?.[0]).toContain('小程序码');
    expect(harness.prisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'share.qrcode.retry',
        aggregateId: REPORT_ID,
        idempotencyKey: expect.stringContaining('share.qrcode.retry:'),
      }),
    });
    // 渲染实现拿到的是"无码"布局
    expect(renderMock.mock.calls[0]?.[0].qrCodeImage).toBeNull();
  });

  it('报告不存在或不属于当前用户 → 404（50016）', async () => {
    const harness = createHarness();
    harness.prisma.aiReport.findFirst.mockResolvedValue(null);

    await expect(harness.service.generateShareCard(request())).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_NOT_FOUND,
    });
  });

  it('报告未生成完成 → 409（50017 / 50018）', async () => {
    const generating = createHarness();
    generating.prisma.aiReport.findFirst.mockResolvedValue({ status: 'GENERATING', profile: null });

    await expect(generating.service.generateShareCard(request())).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_GENERATING,
    });

    const failed = createHarness();
    failed.prisma.aiReport.findFirst.mockResolvedValue({ status: 'FAILED', profile: null });

    await expect(failed.service.generateShareCard(request())).rejects.toMatchObject({
      code: ErrorCode.AI_REPORT_GENERATION_FAILED,
    });
  });

  it('幂等重放：同一 X-Idempotency-Key 返回同一张卡片', async () => {
    const cached = {
      shareCardId: 'card-replayed',
      reportId: REPORT_ID,
      userId: USER_ID,
      template: 'TYPE_CARD',
      fingerprint: 'fp',
      scene: 'REPORT',
      showQrCode: true,
      showNickname: true,
      quoteSectionKey: null,
      objectKey: 'share-card/x.webp',
      imageUrl: 'https://cdn.example.com/x.webp',
      thumbUrl: 'https://cdn.example.com/x.webp',
      width: 750,
      height: 1334,
      sizeBytes: 100,
      qrCodeScene: 'report_0195f3a2',
      shareText: '文案',
      shareTitle: '标题',
      renderDurationMs: 5,
      createdAt: '2026-02-14T14:30:00.000Z',
      expiresAt: '2026-03-16T14:30:00.000Z',
      warnings: [],
    };

    const harness = createHarness();
    harness.redis.get.mockResolvedValue('card-replayed');
    harness.redis.getJson.mockResolvedValue(cached);

    const view = await harness.service.generateShareCard(request());

    expect(view.shareCardId).toBe('card-replayed');
    expect(harness.quota.consumeWindowQuota).not.toHaveBeenCalled();
  });
});
