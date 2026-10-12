/**
 * 人格画像接口层测试
 *
 * 这组测试的首要目的是**锁死一次真实的契约错位**：
 * `api/personality.ts` 原先按「想象中的契约」编写，与后端实际响应严重不符
 * （`id` vs `profileId`、`mbti` 误写成字符串而实际是对象、`dimensions` 误写成
 * 扁平数字而实际每维是对象、`summary` 误写成字符串、`confidence` 层级错位、
 * `getSnapshots` 误当成数组）。这类错误 TypeScript **完全无法发现** ——
 * 因为校验的是前端自己写的 interface，而它是自洽的。
 *
 * 因此这里用「后端真实响应样本」做断言：样本取自本机实际运行的服务端
 * `GET /personality/me`、`GET /personality/me/snapshots` 的真实返回结构。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATTACHMENT_LABELS,
  BIG_FIVE_DIMENSIONS,
  BIG_FIVE_LABELS,
  MBTI_DIMENSIONS,
  getMbtiTypeInfo,
  getMyProfile,
  getProfileHistory,
  getSnapshots,
  type PersonalityProfile,
} from '@/api/personality';
import { ApiError } from '@/api/types';

// ------------------------------------------------------------------ uni mock

interface CapturedRequest {
  url: string;
  method: string;
  data?: unknown;
}

let captured: CapturedRequest[] = [];

/** 让下一次请求返回指定响应 */
const respondWith = (statusCode: number, body: unknown): void => {
  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    captured.push({
      url: String(options['url']),
      method: String(options['method'] ?? 'GET'),
      data: options['data'],
    });
    setTimeout(() => {
      (options['success'] as (res: unknown) => void)({ statusCode, data: body });
    }, 0);
  }) as unknown as typeof uni.request);
};

/** 让下一次请求以网络错误失败 */
const failWithNetworkError = (errMsg = 'request:fail timeout'): void => {
  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    captured.push({ url: String(options['url']), method: String(options['method'] ?? 'GET') });
    setTimeout(() => {
      (options['fail'] as (res: unknown) => void)({ errMsg });
    }, 0);
  }) as unknown as typeof uni.request);
};

const envelope = (data: unknown) => ({ code: 0, message: 'ok', data, requestId: 'req_test', timestamp: '' });
const errorEnvelope = (code: number, message: string) => ({
  code,
  message,
  data: null,
  requestId: 'req_test',
  timestamp: '',
});

/**
 * 后端 `GET /personality/me` 的**真实**响应样本
 * （字段名与层级逐字取自实际运行的服务端，勿凭想象修改）
 */
const REAL_PROFILE: PersonalityProfile = {
  profileId: '01a12ded-4497-7690-ae65-59f6e482696b',
  userId: '01a12ded-43a4-7b73-8f02-bea1d7534ddc',
  version: 1,
  isLatest: true,
  engineVersion: 'pe-v1.0.0',
  sourceSessionId: '01a12ded-4400-7553-85e8-3e037d118a9d',
  sourceTestCode: 'MBTI_LITE',
  generatedAt: '2026-10-12T02:24:46.728Z',
  mbti: {
    type: 'INFP',
    typeName: '调停者',
    group: 'DIPLOMAT',
    confidence: 25,
    dimensions: {
      EI: { percent: 37.5, pole: 'I', oppositePercent: 62.5, oppositePole: 'E', strength: 'SLIGHT' },
      SN: { percent: 60, pole: 'N', oppositePercent: 40, oppositePole: 'S', strength: 'MODERATE' },
    },
  },
  bigFive: { openness: 72.5, conscientiousness: 48, extraversion: 35.5, agreeableness: 66, neuroticism: 55 },
  relationshipStyle: { attachment: 'ANXIOUS', loveLanguage: ['肯定的言辞'], conflictStyle: null },
  quality: {
    consistencyScore: 62,
    completionRate: 100,
    avgResponseMs: 1840,
    confidenceLevel: 'MEDIUM',
    notice: null,
  },
  trend: null,
  summary: {
    headline: '温柔而坚定的理想主义者',
    strengths: ['共情力强', '富有创造力', '重视意义'],
    watchouts: ['回避冲突', '易内耗', '决策偏慢'],
    isAiGenerated: false,
  },
  disclaimer: '本结果基于自评量表，仅供自我探索参考，不构成心理诊断。',
};

beforeEach(() => {
  captured = [];
  vi.mocked(uni.request).mockReset();
  vi.mocked(uni.showToast).mockReset();
});

// ------------------------------------------------------- 空状态与错误的区分

describe('getMyProfile：空状态与错误的区分', () => {
  it('尚无画像时返回 null（40010 是空状态，不是错误）', async () => {
    respondWith(404, errorEnvelope(40010, '你还没有人格画像，完成一次测评即可生成'));

    await expect(getMyProfile()).resolves.toBeNull();
  });

  it('尚无画像时不弹出错误 toast（空状态不应打扰用户）', async () => {
    respondWith(404, errorEnvelope(40010, '你还没有人格画像，完成一次测评即可生成'));

    await getMyProfile();

    expect(uni.showToast).not.toHaveBeenCalled();
  });

  it('服务端错误必须原样抛出，绝不能伪装成「没有画像」', async () => {
    respondWith(500, errorEnvelope(10000, '服务器内部错误'));

    await expect(getMyProfile()).rejects.toBeInstanceOf(ApiError);
  });

  it('登录态失效必须原样抛出（否则页面会误判为「未测评」并引导错误流程）', async () => {
    respondWith(401, errorEnvelope(20000, '登录已失效'));

    await expect(getMyProfile()).rejects.toMatchObject({ code: 20000 });
  });

  it('网络故障必须原样抛出', async () => {
    failWithNetworkError();

    await expect(getMyProfile()).rejects.toBeInstanceOf(ApiError);
  });

  it('指定历史版本时透传 version 参数', async () => {
    respondWith(200, envelope(REAL_PROFILE));

    await getMyProfile({ version: 3 });

    // GET 的查询参数由请求层的 buildUrl 拼接到 URL 上，而不是放在 data 里
    expect(captured[0]?.url).toContain('/personality/me?version=3');
  });
});

// --------------------------------------------------------- 响应结构的形状

describe('响应结构：与后端实际字段对齐（契约错位回归）', () => {
  it('画像的主键是 profileId（不是 id），且各字段原样透传', async () => {
    respondWith(200, envelope(REAL_PROFILE));

    const profile = await getMyProfile();

    expect(profile?.profileId).toBe('01a12ded-4497-7690-ae65-59f6e482696b');
    expect(profile).not.toHaveProperty('id');
    expect(profile?.generatedAt).toBe('2026-10-12T02:24:46.728Z');
  });

  it('mbti 是对象：类型名与置信度都在其中（而不是顶层字符串/数字）', async () => {
    respondWith(200, envelope(REAL_PROFILE));

    const profile = await getMyProfile();

    expect(profile?.mbti.type).toBe('INFP');
    expect(profile?.mbti.typeName).toBe('调停者');
    expect(profile?.mbti.group).toBe('DIPLOMAT');
    expect(profile?.mbti.confidence).toBe(25);
  });

  it('dimensions 的每个值是对象（含对立极与强度档位），不是扁平数字', async () => {
    respondWith(200, envelope(REAL_PROFILE));

    const profile = await getMyProfile();
    const ei = profile?.mbti.dimensions['EI'];

    expect(ei).toMatchObject({
      percent: 37.5,
      pole: 'I',
      oppositePercent: 62.5,
      oppositePole: 'E',
      strength: 'SLIGHT',
    });
    expect(typeof ei).toBe('object');
  });

  it('summary 是对象（headline/strengths/watchouts），不是字符串', async () => {
    respondWith(200, envelope(REAL_PROFILE));

    const profile = await getMyProfile();

    expect(profile?.summary.headline).toBe('温柔而坚定的理想主义者');
    expect(profile?.summary.strengths).toHaveLength(3);
    expect(profile?.summary.isAiGenerated).toBe(false);
  });

  it('置信度档位在 quality.confidenceLevel，关系风格不再有 attachmentLabel', async () => {
    respondWith(200, envelope(REAL_PROFILE));

    const profile = await getMyProfile();

    expect(profile?.quality.confidenceLevel).toBe('MEDIUM');
    expect(profile?.relationshipStyle.attachment).toBe('ANXIOUS');
    expect(profile?.relationshipStyle).not.toHaveProperty('attachmentLabel');
  });

  it('conflictStyle 允许为 null（规则未命中时后端不编造文案）', async () => {
    respondWith(200, envelope(REAL_PROFILE));

    const profile = await getMyProfile();

    expect(profile?.relationshipStyle.conflictStyle).toBeNull();
  });

  it('disclaimer 由服务端下发，用于合规展示', async () => {
    respondWith(200, envelope(REAL_PROFILE));

    const profile = await getMyProfile();

    expect(profile?.disclaimer).toContain('不构成心理诊断');
  });
});

// --------------------------------------------------------------- 其余接口

describe('其余画像接口的路径与结构', () => {
  it('getProfileHistory 命中 /personality/me/history 并返回分页结构', async () => {
    respondWith(
      200,
      envelope({
        items: [
          {
            profileId: 'p1',
            version: 2,
            isLatest: true,
            engineVersion: 'pe-v1.0.0',
            mbtiType: 'INFP',
            mbtiTypeName: '调停者',
            confidence: 25,
            generatedAt: '2026-10-12T02:24:46.728Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
        hasNext: false,
      }),
    );

    const history = await getProfileHistory({ page: 1, pageSize: 20 });

    expect(captured[0]?.url).toContain('/personality/me/history');
    expect(history.items[0]?.mbtiTypeName).toBe('调停者');
    expect(history.hasNext).toBe(false);
  });

  it('getSnapshots 返回对象（含 points 与可用维度），而不是数组', async () => {
    respondWith(
      200,
      envelope({
        metric: 'BIG_FIVE',
        granularity: 'WEEK',
        range: '90D',
        rangeStart: '2026-07-14',
        rangeEnd: '2026-10-12',
        availableDimensions: ['openness', 'extraversion'],
        points: [
          {
            date: '2026-10-05',
            timestamp: '2026-10-05T00:00:00.000Z',
            profileVersion: 1,
            sessionId: 's1',
            testCode: 'MBTI_LITE',
            values: { openness: 72.5, extraversion: 35.5 },
            mbtiType: 'INFP',
            confidence: 25,
            sampleCount: 2,
          },
        ],
      }),
    );

    const snapshots = await getSnapshots({ metric: 'BIG_FIVE', range: '90D', granularity: 'WEEK' });

    expect(Array.isArray(snapshots)).toBe(false);
    expect(snapshots.points).toHaveLength(1);
    expect(snapshots.points[0]?.sampleCount).toBe(2);
    expect(snapshots.availableDimensions).toContain('openness');
    expect(captured[0]?.url).toContain('/personality/me/snapshots');
  });

  it('getMbtiTypeInfo 命中公开的类型百科路径', async () => {
    respondWith(
      200,
      envelope({
        type: 'INFJ',
        typeName: '提倡者',
        typeNameEn: 'Advocate',
        group: 'DIPLOMAT',
        groupName: '外交家',
        groupColor: '#8B7FD4',
        tagline: '安静而有影响力的理想主义者',
        description: '描述',
        dimensionProfile: [],
        strengths: [],
        blindSpots: [],
        relationshipTips: [],
        summary: { headline: 'h', strengths: [], watchouts: [] },
      }),
    );

    const info = await getMbtiTypeInfo('INFJ');

    expect(captured[0]?.url).toContain('/personality/types/INFJ');
    expect(info.typeNameEn).toBe('Advocate');
  });
});

// ------------------------------------------------------------------ 常量表

describe('展示用常量表', () => {
  it('大五维度键与后端一致，且每个键都有中文名', () => {
    expect([...BIG_FIVE_DIMENSIONS]).toEqual([
      'openness',
      'conscientiousness',
      'extraversion',
      'agreeableness',
      'neuroticism',
    ]);

    for (const key of BIG_FIVE_DIMENSIONS) {
      expect(BIG_FIVE_LABELS[key]).toBeTruthy();
    }
  });

  it('MBTI 维度顺序固定为 EI / SN / TF / JP', () => {
    expect([...MBTI_DIMENSIONS]).toEqual(['EI', 'SN', 'TF', 'JP']);
  });

  it('四种依恋类型都有中文名', () => {
    expect(Object.keys(ATTACHMENT_LABELS).sort()).toEqual(['ANXIOUS', 'AVOIDANT', 'FEARFUL', 'SECURE']);
  });
});
