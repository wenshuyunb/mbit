/**
 * 关系与匹配接口层测试
 *
 * 首要目的：锁死「**请求成功但参数被静默丢弃**」这一类最难排查的缺陷。
 *
 * `removeRelationship` 此前把 `{ reason, keepHistory }` 当作 DELETE 的请求体发送，
 * 而后端用 `@Query()` 读取 —— 两个字段在 DTO 里都是可选，因此不会报错，
 * 服务端只是收不到原因，接口照常返回 200。这类缺陷在联调时几乎无法察觉。
 *
 * 成因在请求层：`buildUrl` 只对 GET 把 data 拼到 URL（`request.ts`），
 * 非 GET 的 data 一律走请求体 —— 所以凡是非 GET 却要查询参数，必须自己拼串。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCompatibility,
  removeRelationship,
  requestCompatibility,
  type CompatibilityReport,
} from '@/api/relationship';

interface CapturedRequest {
  url: string;
  method: string;
  data?: unknown;
}

let captured: CapturedRequest[] = [];

const respondWith = (data: unknown): void => {
  vi.mocked(uni.request).mockImplementation(((options: Record<string, unknown>) => {
    captured.push({
      url: String(options['url']),
      method: String(options['method'] ?? 'GET'),
      data: options['data'],
    });
    setTimeout(() => {
      (options['success'] as (res: unknown) => void)({
        statusCode: 200,
        data: { code: 0, message: 'ok', data, requestId: 'req_test', timestamp: '' },
      });
    }, 0);
  }) as unknown as typeof uni.request);
};

beforeEach(() => {
  captured = [];
  vi.mocked(uni.request).mockReset();
});

// ------------------------------------------------------------------ 解除关系

describe('removeRelationship：参数必须走 URL 查询串', () => {
  it('reason 出现在 URL 上（回归：此前放在请求体里被静默丢弃）', async () => {
    respondWith({ status: 'REMOVED' });

    await removeRelationship('rel-1', { reason: 'MISTAKE' });

    expect(captured[0]?.url).toContain('reason=MISTAKE');
    expect(captured[0]?.method).toBe('DELETE');
  });

  it('不再把查询参数当请求体发送', async () => {
    respondWith({ status: 'REMOVED' });

    await removeRelationship('rel-1', { reason: 'PRIVACY', keepHistory: true });

    // 关键断言：body 必须是空的，参数只能在 URL 上
    expect(captured[0]?.data).toBeUndefined();
  });

  it('同时透传 keepHistory（后端当前接受但未使用，前端照传以备接上）', async () => {
    respondWith({ status: 'REMOVED' });

    await removeRelationship('rel-1', { reason: 'OTHER', keepHistory: false });

    expect(captured[0]?.url).toContain('keepHistory=false');
  });

  it('不传参数时不产生多余的问号', async () => {
    respondWith({ status: 'REMOVED' });

    await removeRelationship('rel-1');

    expect(captured[0]?.url).toMatch(/\/relationships\/rel-1$/);
  });

  it('未提供的可选参数不会以 undefined 形式出现在查询串里', async () => {
    respondWith({ status: 'REMOVED' });

    await removeRelationship('rel-1', { reason: 'MISTAKE' });

    expect(captured[0]?.url).not.toContain('undefined');
    expect(captured[0]?.url).not.toContain('keepHistory');
  });
});

// ------------------------------------------------------------------ 匹配报告

describe('匹配报告接口', () => {
  it('requestCompatibility 以 POST 命中触发端点', async () => {
    respondWith({
      reportId: 'r1',
      status: 'QUEUED',
      queue: 'compatibility.calc',
      isReused: false,
      estimatedSeconds: 3,
    });

    const result = await requestCompatibility('rel-1');

    expect(captured[0]?.url).toContain('/relationships/rel-1/compatibility');
    expect(captured[0]?.method).toBe('POST');
    expect(result.isReused).toBe(false);
    expect(result.queue).toBe('compatibility.calc');
  });

  it('getCompatibility 尚未生成时返回 null（正常状态，不是错误）', async () => {
    respondWith(null);

    await expect(getCompatibility('rel-1')).resolves.toBeNull();
  });

  it('getCompatibility 返回的报告区分「0 分」与「未算出」', async () => {
    const report: CompatibilityReport = {
      reportId: 'r1',
      relationshipId: 'rel-1',
      status: 'SUCCEEDED',
      totalScore: 0,
      mbtiScore: null,
      bigFiveScore: 82.5,
      attachmentScore: null,
      communicationScore: 70,
      scoreLevel: 'CHALLENGING',
      scoreLabel: '需要磨合',
      scoreBreakdown: null,
      engineVersion: 'ce-v1.0.0',
      weightsVersion: 'cw-v1',
      computedAt: '2026-10-12T02:24:46.728Z',
      createdAt: '2026-10-12T02:24:46.000Z',
      aiInterpretation: { available: false, aiReportId: null },
    };
    respondWith(report);

    const result = await getCompatibility('rel-1');

    // 0 分是真实分数
    expect(result?.totalScore).toBe(0);
    // null 是「该维度没算」，绝不能渲染成 0 分
    expect(result?.mbtiScore).toBeNull();
    expect(result?.aiInterpretation.available).toBe(false);
    expect(captured[0]?.method).toBe('GET');
  });

  it('匹配报告的失败文案由后端下发（前端不透出上游错误）', async () => {
    respondWith({
      reportId: 'r1',
      relationshipId: 'rel-1',
      status: 'FAILED',
      totalScore: null,
      mbtiScore: null,
      bigFiveScore: null,
      attachmentScore: null,
      communicationScore: null,
      scoreLevel: null,
      scoreLabel: null,
      scoreBreakdown: null,
      engineVersion: 'ce-v1.0.0',
      weightsVersion: 'cw-v1',
      computedAt: null,
      createdAt: '2026-10-12T02:24:46.000Z',
      failureReason: '匹配报告生成失败，请稍后重试',
      aiInterpretation: { available: false, aiReportId: null },
    });

    const result = await getCompatibility('rel-1');

    expect(result?.status).toBe('FAILED');
    expect(result?.failureReason).toBe('匹配报告生成失败，请稍后重试');
  });
});
