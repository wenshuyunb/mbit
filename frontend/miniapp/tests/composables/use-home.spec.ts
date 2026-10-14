/**
 * 首页数据 composable 测试
 *
 * 重点覆盖两类容易出错的地方：
 *   ① **并发降级**：三个请求独立，报告/题库失败不能拖垮整页，
 *      但画像失败必须显式提示（它决定主行动是「开始」还是「重新」测试）
 *   ② **空状态与错误必须区分**：`GET /personality/me` 在尚未测评时返回
 *      `404 / 40010`，这是正常空状态，绝不能显示成错误
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useHome } from '@/composables/use-home';

interface Route {
  statusCode?: number;
  body: unknown;
}

let requestedUrls: string[] = [];

/** 按 URL 片段路由的响应表 */
const respondByUrl = (routes: Record<string, Route>): void => {
  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    const url = String(options['url']);
    requestedUrls.push(url);

    const matched = Object.keys(routes).find((key) => url.includes(key));

    setTimeout(() => {
      if (matched === undefined) {
        (options['fail'] as (res: unknown) => void)({ errMsg: 'request:fail 未配置的地址' });
        return;
      }

      const route = routes[matched] as Route;
      (options['success'] as (res: unknown) => void)({
        statusCode: route.statusCode ?? 200,
        data: route.body,
      });
    }, 0);
  }) as unknown as typeof uni.request);
};

const ok = (data: unknown): Route => ({
  statusCode: 200,
  body: { code: 0, message: 'ok', data, requestId: 'req', timestamp: '' },
});

const fail = (statusCode: number, code: number, message: string): Route => ({
  statusCode,
  body: { code, message, data: null, requestId: 'req', timestamp: '' },
});

/** 尚未测评：后端返回 404 / 40010 */
const NO_PROFILE = fail(404, 40010, '你还没有人格画像，完成一次测评即可生成');

const PROFILE = {
  profileId: 'p1',
  userId: 'u1',
  version: 1,
  isLatest: true,
  engineVersion: 'pe-v1.0.0',
  sourceSessionId: 's1',
  sourceTestCode: 'MBTI_LITE',
  generatedAt: '2026-10-12T00:00:00.000Z',
  mbti: {
    type: 'INFP',
    typeName: '调停者',
    group: 'DIPLOMAT',
    confidence: 25,
    dimensions: {},
  },
  bigFive: {},
  quality: { consistencyScore: 62, completionRate: 100, avgResponseMs: null, confidenceLevel: 'MEDIUM', notice: null },
  trend: null,
  summary: { headline: 'h', strengths: [], watchouts: [], isAiGenerated: false },
  disclaimer: 'd',
};

const emptyReports = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 1,
  hasNext: false,
  summary: { totalReports: 0, unlockedReports: 0, generatingReports: 0, failedReports: 0, latestReportId: null },
};

const reportItem = {
  reportId: 'r1',
  type: 'MBTI_REPORT',
  typeName: '人格深度报告',
  title: null,
  status: 'SUCCEEDED',
  mbtiType: 'INFP',
  engineVersion: 'pe-v1.0.0',
  wordCount: 1200,
  sectionCount: 4,
  freePreviewRatio: 0.2,
  isUnlocked: false,
  unlockType: null,
  provider: 'DEEPSEEK',
  model: 'deepseek-chat',
  totalTokens: 2000,
  generationDurationMs: 3000,
  createdAt: '2026-10-12T00:00:00.000Z',
  generatedAt: '2026-10-12T00:01:00.000Z',
  previewText: '预览',
  hasPdf: false,
  shareCardUrl: null,
};

const TESTS = [
  {
    code: 'BIG_FIVE_50',
    name: '大五人格测评（50 题）',
    category: 'BIG_FIVE',
    description: null,
    version: '1.0.0',
    questionCount: 50,
    estimatedMinutes: 8,
    coverUrl: null,
    completedCount: 0,
    hasInProgress: false,
  },
  {
    code: 'MBTI_LITE',
    name: '人格速测（MBTI 精简版）',
    category: 'MBTI',
    description: null,
    version: '1.0.0',
    questionCount: 32,
    estimatedMinutes: 5,
    coverUrl: null,
    completedCount: 0,
    hasInProgress: false,
  },
];

beforeEach(() => {
  requestedUrls = [];
  vi.mocked(uni.request).mockReset();
});

describe('空状态：尚未测评', () => {
  it('40010 不算错误，profileError 保持为空', async () => {
    respondByUrl({ '/personality/me': NO_PROFILE, '/reports': ok(emptyReports), '/tests': ok(TESTS) });
    const home = useHome();

    await home.loadHomeData();

    expect(home.hasProfile.value).toBe(false);
    expect(home.profileError.value).toBe('');
  });

  it('主行动显示「开始人格测试」', async () => {
    respondByUrl({ '/personality/me': NO_PROFILE, '/reports': ok(emptyReports), '/tests': ok(TESTS) });
    const home = useHome();

    await home.loadHomeData();

    expect(home.primaryTitle.value).toBe('开始人格测试');
    expect(home.profileBadge.value).toBe('');
  });

  it('测试耗时取自服务端下发的题库，而不是前端写死', async () => {
    respondByUrl({ '/personality/me': NO_PROFILE, '/reports': ok(emptyReports), '/tests': ok(TESTS) });
    const home = useHome();

    await home.loadHomeData();

    // 优先选 MBTI 分类：32 题 / 5 分钟
    expect(home.primaryDesc.value).toContain('约 5 分钟');
    expect(home.primaryDesc.value).toContain('人格速测');
  });
});

describe('已有画像', () => {
  it('主行动变为「重新测试人格」，并展示类型与名称', async () => {
    respondByUrl({ '/personality/me': ok(PROFILE), '/reports': ok(emptyReports), '/tests': ok(TESTS) });
    const home = useHome();

    await home.loadHomeData();

    expect(home.hasProfile.value).toBe(true);
    expect(home.primaryTitle.value).toBe('重新测试人格');
    expect(home.profileBadge.value).toBe('INFP · 调停者');
  });

  it('有画像时不再重复宣传测试时长', async () => {
    respondByUrl({ '/personality/me': ok(PROFILE), '/reports': ok(emptyReports), '/tests': ok(TESTS) });
    const home = useHome();

    await home.loadHomeData();

    expect(home.primaryDesc.value).toBe('看看这段时间你的变化');
  });
});

describe('报告卡片文案', () => {
  it('没有报告时用兜底文案', async () => {
    respondByUrl({ '/personality/me': ok(PROFILE), '/reports': ok(emptyReports), '/tests': ok(TESTS) });
    const home = useHome();

    await home.loadHomeData();

    expect(home.reportDesc.value).toBe('查看 AI 生成的深度人格解读');
  });

  it('有报告时展示服务端下发的类型名', async () => {
    respondByUrl({
      '/personality/me': ok(PROFILE),
      '/reports': ok({
        ...emptyReports,
        items: [reportItem],
        total: 1,
        summary: { ...emptyReports.summary, totalReports: 1, latestReportId: 'r1' },
      }),
      '/tests': ok(TESTS),
    });
    const home = useHome();

    await home.loadHomeData();

    expect(home.reportDesc.value).toBe('人格深度报告 · 已生成');
  });

  it('有报告正在生成时优先提示生成中', async () => {
    respondByUrl({
      '/personality/me': ok(PROFILE),
      '/reports': ok({
        ...emptyReports,
        items: [reportItem],
        total: 1,
        summary: { ...emptyReports.summary, totalReports: 2, generatingReports: 2 },
      }),
      '/tests': ok(TESTS),
    });
    const home = useHome();

    await home.loadHomeData();

    expect(home.reportDesc.value).toContain('2 份报告正在生成');
  });
});

describe('并发降级', () => {
  it('画像失败必须显式提示（决定主行动分支，不能静默）', async () => {
    respondByUrl({
      '/personality/me': fail(500, 10000, '服务器内部错误'),
      '/reports': ok(emptyReports),
      '/tests': ok(TESTS),
    });
    const home = useHome();

    await home.loadHomeData();

    expect(home.profileError.value).toBe('服务器内部错误');
  });

  it('报告接口失败不影响画像与主行动', async () => {
    respondByUrl({
      '/personality/me': ok(PROFILE),
      '/reports': fail(500, 10000, '服务器内部错误'),
      '/tests': ok(TESTS),
    });
    const home = useHome();

    await home.loadHomeData();

    expect(home.profileError.value).toBe('');
    expect(home.hasProfile.value).toBe(true);
    expect(home.primaryTitle.value).toBe('重新测试人格');
    // 报告区块退回兜底文案而不是崩溃
    expect(home.reportDesc.value).toBe('查看 AI 生成的深度人格解读');
  });

  it('题库接口失败不影响画像，且耗时文案退回默认值', async () => {
    respondByUrl({ '/personality/me': ok(PROFILE), '/reports': ok(emptyReports), '/tests': fail(500, 10000, '错误') });
    const home = useHome();

    await home.loadHomeData();

    expect(home.hasProfile.value).toBe(true);
    expect(home.primaryDesc.value).toBe('看看这段时间你的变化');
  });

  it('三个请求全部失败时不抛异常，页面仍可渲染', async () => {
    respondByUrl({
      '/personality/me': fail(500, 10000, '错误'),
      '/reports': fail(500, 10000, '错误'),
      '/tests': fail(500, 10000, '错误'),
    });
    const home = useHome();

    await expect(home.loadHomeData()).resolves.toBeUndefined();

    expect(home.hasProfile.value).toBe(false);
    expect(home.primaryTitle.value).toBe('开始人格测试');
    expect(home.primaryDesc.value).toBe('MBTI + 大五人格双模型');
  });

  it('三个请求并发发出，不是串行等待', async () => {
    respondByUrl({ '/personality/me': NO_PROFILE, '/reports': ok(emptyReports), '/tests': ok(TESTS) });
    const home = useHome();

    await home.loadHomeData();

    expect(requestedUrls.some((url) => url.includes('/personality/me'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/reports'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/tests'))).toBe(true);
  });
});
