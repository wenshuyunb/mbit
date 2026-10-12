/**
 * SSE 流纯逻辑测试（契约 §3.5.6）
 *
 * 断言的是**协议形状**：事件名、字段、帧格式、阶段推导、心跳与超时常量。
 * 连接生命周期（断连、名额释放）在 `report-stream.service.spec.ts` 与控制器测试里。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import type { SectionVisibility } from './report-visibility';
import {
  REPORT_JOB_MAX_ATTEMPTS,
  REPORT_STAGE_LABELS,
  REPORT_STAGES,
  SSE_HEARTBEAT_FRAME,
  STAGE_PROGRESS,
  STREAM_DEFAULT_HEARTBEAT_MS,
  STREAM_MAX_CONNECTIONS_PER_USER,
  STREAM_MAX_DURATION_MS,
  buildDoneEvent,
  buildErrorEvent,
  buildProgressEvent,
  buildSectionEvent,
  buildStageEvent,
  buildStartEvent,
  buildUsageEvent,
  computeDurationMs,
  deriveStageFromStatus,
  estimateRemainingSeconds,
  estimateSecondsFromHistory,
  failureInfoOf,
  formatSseFrame,
  isTerminalStatus,
  previewTextOf,
  type ReportGenerationSnapshot,
  type StreamEventBase,
} from './report-stream.util';

const BASE: StreamEventBase = {
  requestId: 'req_1',
  seq: 3,
  ts: '2026-02-14T14:00:04.000Z',
  reportId: 'report-1',
};

const snapshotOf = (overrides: Partial<ReportGenerationSnapshot> = {}): ReportGenerationSnapshot => ({
  reportId: 'report-1',
  status: 'GENERATING',
  stage: 'CALLING_MODEL',
  progress: 18,
  generatedWordCount: 0,
  targetWordCount: 0,
  generatedSectionCount: 0,
  targetSectionCount: 6,
  currentSectionKey: null,
  provider: 'DEEPSEEK',
  model: 'deepseek-chat',
  attempt: 1,
  elapsedSeconds: 4,
  estimatedRemainingSeconds: 31,
  startedAt: '2026-02-14T14:00:00.000Z',
  finishedAt: null,
  usage: null,
  failureCode: null,
  ...overrides,
});

describe('阶段枚举与推导', () => {
  it('阶段与中文标签逐字对齐契约（含 DONE / ERROR）', () => {
    expect([...REPORT_STAGES]).toEqual([
      'QUEUED',
      'BUILDING_CONTEXT',
      'RENDERING_PROMPT',
      'CALLING_MODEL',
      'GENERATING_SECTIONS',
      'SAFETY_CHECK',
      'PERSISTING',
      'DONE',
      'ERROR',
    ]);
    expect(REPORT_STAGE_LABELS.QUEUED).toBe('任务排队中');
    expect(REPORT_STAGE_LABELS.GENERATING_SECTIONS).toBe('正在生成报告内容');
    expect(REPORT_STAGE_LABELS.DONE).toBe('报告已生成');
  });

  it('阶段权重单调不减（否则会出现"进度倒退"的界面）', () => {
    const inFlight = REPORT_STAGES.filter((stage) => stage !== 'ERROR');

    for (let index = 1; index < inFlight.length; index += 1) {
      const previous = STAGE_PROGRESS[inFlight[index - 1] as keyof typeof STAGE_PROGRESS];
      const current = STAGE_PROGRESS[inFlight[index] as keyof typeof STAGE_PROGRESS];

      expect(current).toBeGreaterThanOrEqual(previous);
    }
  });

  it('按 status + progress 推导阶段', () => {
    expect(deriveStageFromStatus('QUEUED', 0)).toBe('QUEUED');
    expect(deriveStageFromStatus('GENERATING', 10)).toBe('BUILDING_CONTEXT');
    expect(deriveStageFromStatus('GENERATING', 18)).toBe('CALLING_MODEL');
    expect(deriveStageFromStatus('GENERATING', 50)).toBe('GENERATING_SECTIONS');
    expect(deriveStageFromStatus('GENERATING', 96)).toBe('PERSISTING');
    expect(deriveStageFromStatus('SUCCEEDED', 100)).toBe('DONE');
    expect(deriveStageFromStatus('FAILED', 100)).toBe('ERROR');
    expect(deriveStageFromStatus('CANCELLED', 100)).toBe('ERROR');
  });

  it('越界或异常进度不会推导出越界阶段', () => {
    expect(deriveStageFromStatus('GENERATING', -5)).toBe('QUEUED');
    expect(deriveStageFromStatus('GENERATING', 999)).toBe('PERSISTING');
    expect(deriveStageFromStatus('GENERATING', Number.NaN)).toBe('QUEUED');
  });

  it('终态判定只认 SUCCEEDED / FAILED / CANCELLED', () => {
    expect(isTerminalStatus('SUCCEEDED')).toBe(true);
    expect(isTerminalStatus('FAILED')).toBe(true);
    expect(isTerminalStatus('GENERATING')).toBe(false);
    expect(isTerminalStatus('QUEUED')).toBe(false);
  });
});

describe('SSE 帧格式（契约给出的是原始字节流）', () => {
  it('事件帧为 `event:` + `data:` + 空行', () => {
    expect(formatSseFrame('stage', { a: 1 })).toBe('event: stage\ndata: {"a":1}\n\n');
  });

  it('心跳是注释行 `: ping`（而不是事件）', () => {
    expect(SSE_HEARTBEAT_FRAME).toBe(': ping\n\n');
  });

  it('心跳与超时常量符合契约（默认 15s、范围 5–30s、单连接 10 分钟、并发 3）', () => {
    expect(STREAM_DEFAULT_HEARTBEAT_MS).toBe(15_000);
    expect(STREAM_MAX_DURATION_MS).toBe(600_000);
    expect(STREAM_MAX_CONNECTIONS_PER_USER).toBe(3);
  });
});

describe('事件载荷', () => {
  it('start 事件带目标规模与预计耗时', () => {
    const event = buildStartEvent(BASE, snapshotOf({ status: 'QUEUED', stage: 'QUEUED', progress: 0 }), 35);

    expect(event).toMatchObject({
      requestId: 'req_1',
      seq: 3,
      ts: '2026-02-14T14:00:04.000Z',
      reportId: 'report-1',
      status: 'QUEUED',
      stage: 'QUEUED',
      stageLabel: '任务排队中',
      progress: 0,
      targetSectionCount: 6,
      targetWordCount: 0,
      provider: 'DEEPSEEK',
      model: 'deepseek-chat',
      estimatedSeconds: 35,
    });
  });

  it('stage 事件带 elapsedSeconds 与 estimatedRemainingSeconds', () => {
    const event = buildStageEvent(BASE, snapshotOf());

    expect(event).toMatchObject({
      stage: 'CALLING_MODEL',
      stageLabel: '正在调用 AI 模型',
      progress: 18,
      elapsedSeconds: 4,
      estimatedRemainingSeconds: 31,
    });
  });

  it('progress 事件带字数与段落进度', () => {
    const event = buildProgressEvent(
      BASE,
      snapshotOf({ generatedWordCount: 1480, targetWordCount: 3284, generatedSectionCount: 2 }),
    );

    expect(event).toMatchObject({
      progress: 18,
      generatedWordCount: 1480,
      targetWordCount: 3284,
      generatedSectionCount: 2,
      targetSectionCount: 6,
      currentSectionKey: null,
    });
  });

  it('section 事件：无预览时**不带 previewText 字段**（而不是给 null）', () => {
    const event = buildSectionEvent(BASE, {
      sectionKey: 'CORE_PORTRAIT',
      order: 1,
      title: '你的核心画像',
      isFreePreview: true,
      wordCount: 1180,
      previewText: null,
    });

    expect(event).toMatchObject({ sectionKey: 'CORE_PORTRAIT', order: 1, isFreePreview: true, wordCount: 1180 });
    expect(Object.prototype.hasOwnProperty.call(event, 'previewText')).toBe(false);
  });

  it('section 事件：带预览时只含预览片段', () => {
    const event = buildSectionEvent(BASE, {
      sectionKey: 'CORE_PORTRAIT',
      order: 1,
      title: '你的核心画像',
      isFreePreview: true,
      wordCount: 1180,
      previewText: '你是一个安静而坚定的人。',
    });

    expect(event['previewText']).toBe('你是一个安静而坚定的人。');
  });

  it('usage 事件仅在成功时存在，且 cacheHit 如实为 false', () => {
    expect(buildUsageEvent(BASE, snapshotOf())).toBeNull();

    const usage = buildUsageEvent(
      BASE,
      snapshotOf({
        status: 'SUCCEEDED',
        usage: { promptTokens: 2480, completionTokens: 3640, totalTokens: 6120, estimatedCostCents: 12 },
      }),
    );

    expect(usage).toMatchObject({
      promptTokens: 2480,
      completionTokens: 3640,
      totalTokens: 6120,
      estimatedCostCents: 12,
      attempt: 1,
      cacheHit: false,
    });
  });

  it('done 事件带 durationMs / 解锁状态 / 详情地址', () => {
    const done = buildDoneEvent(
      BASE,
      snapshotOf({
        status: 'SUCCEEDED',
        stage: 'DONE',
        progress: 100,
        finishedAt: '2026-02-14T14:00:52.000Z',
      }),
      { wordCount: 3284, sectionCount: 6, isUnlocked: false, freePreviewRatio: 0.2 },
    );

    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      stage: 'DONE',
      progress: 100,
      durationMs: 52_000,
      wordCount: 3284,
      sectionCount: 6,
      isUnlocked: false,
      freePreviewRatio: 0.2,
      detailUrl: '/api/v1/reports/report-1',
    });
  });

  it('error 事件带 code / canRetry / attempt / maxAttempts，且不改写上游错误码', () => {
    const event = buildErrorEvent(BASE, {
      code: ErrorCode.AI_PROVIDER_TIMEOUT,
      message: 'AI 服务响应超时，请稍后重试',
      canRetry: true,
      attempt: 2,
    });

    expect(event).toMatchObject({
      code: ErrorCode.AI_PROVIDER_TIMEOUT,
      canRetry: true,
      attempt: 2,
      maxAttempts: REPORT_JOB_MAX_ATTEMPTS,
    });
  });
});

describe('失败码映射（契约码 → 本项目码）', () => {
  it('超时 / 不可用可重试，安全拦截不可重试', () => {
    expect(failureInfoOf(ErrorCode.AI_PROVIDER_TIMEOUT).canRetry).toBe(true);
    expect(failureInfoOf(ErrorCode.AI_PROVIDER_UNAVAILABLE).canRetry).toBe(true);
    expect(failureInfoOf(ErrorCode.AI_CONTENT_BLOCKED).canRetry).toBe(false);
    expect(failureInfoOf(ErrorCode.AI_SAFETY_INTERVENTION).canRetry).toBe(false);
  });

  it('没有错误码时回退到"报告生成失败"，且仍可走 regenerate', () => {
    const info = failureInfoOf(null);

    expect(info.code).toBe(ErrorCode.AI_REPORT_GENERATION_FAILED);
    expect(info.canRetry).toBe(true);
    // 不泄露上游细节
    expect(info.message).not.toContain('provider');
  });
});

describe('预估与派生', () => {
  it('预计剩余时间按已完成比例线性外推，两端不除零', () => {
    expect(estimateRemainingSeconds(24, 45)).toBe(29);
    expect(estimateRemainingSeconds(10, 0)).toBe(10);
    expect(estimateRemainingSeconds(52, 100)).toBe(0);
  });

  it('预计总耗时用历史均值；无历史时用兜底值', () => {
    expect(estimateSecondsFromHistory([40_000, 60_000])).toBe(50);
    expect(estimateSecondsFromHistory([])).toBe(40);
    expect(estimateSecondsFromHistory([0, -1, Number.NaN])).toBe(40);
  });

  it('耗时计算对缺失/非法时间返回 0（避免 NaN 被序列化成 null）', () => {
    expect(computeDurationMs('2026-02-14T14:00:00.000Z', '2026-02-14T14:00:52.000Z')).toBe(52_000);
    expect(computeDurationMs(null, '2026-02-14T14:00:52.000Z')).toBe(0);
    expect(computeDurationMs('not-a-date', '2026-02-14T14:00:52.000Z')).toBe(0);
  });
});

describe('previewTextOf（流中只推免费预览片段）', () => {
  const visibilityOf = (overrides: Partial<SectionVisibility> = {}): SectionVisibility => ({
    sectionKey: 'CORE_PORTRAIT',
    title: '你的核心画像',
    order: 1,
    isFreePreview: true,
    isUnlocked: true,
    content: '正文',
    lockedHint: null,
    contentLength: 2,
    ...overrides,
  });

  it('未解锁（content 为 null）时不产生任何预览文本', () => {
    expect(previewTextOf(visibilityOf({ isUnlocked: false, content: null }))).toBeNull();
  });

  it('超过长度上限时按字符截断并加省略号（中文不按字节切）', () => {
    const long = '甲'.repeat(130);
    const preview = previewTextOf(visibilityOf({ content: long }), 120);

    expect(preview).toHaveLength(121);
    expect(preview?.endsWith('…')).toBe(true);
  });

  it('空白正文返回 null（避免推一个空片段让前端显示空白块）', () => {
    expect(previewTextOf(visibilityOf({ content: '   \n  ' }))).toBeNull();
  });
});
