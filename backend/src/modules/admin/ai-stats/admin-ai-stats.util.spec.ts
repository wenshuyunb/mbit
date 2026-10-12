/**
 * AI 统计纯逻辑单测
 *
 * 最重要的断言是**时区口径**：契约示例的 `7D` 起点是 `2026-02-08T00:00:00.000Z`
 * （UTC 零点），而项目 `TZ = Asia/Shanghai`。口径一旦漂移，
 * 看板、成本统计与导出会互相对不上账，且极难排查 —— 因此把它钉在单测里。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import {
  aiTaskName,
  describeErrorCode,
  formatCents,
  formatCount,
  formatPercent,
  maskNickname,
  previousPeriod,
  resolveCallLogRange,
  resolveOverviewRange,
  resolveRequiredRange,
  roundTo,
  safeRatio,
  toDateKey,
  toLengthBucket,
  toProviderEnum,
  toProviderName,
  toSafeNumber,
  trendDirection,
} from './admin-ai-stats.util';

const NOW = new Date('2026-02-14T21:20:00.000Z');

describe('resolveOverviewRange（UTC 口径）', () => {
  it('7D 起点 = UTC 今天零点 − 6 天（与契约示例逐字一致）', () => {
    const range = resolveOverviewRange('7D', undefined, undefined, NOW);

    expect(range.rangeStart.toISOString()).toBe('2026-02-08T00:00:00.000Z');
    expect(range.rangeEnd.toISOString()).toBe(NOW.toISOString());
    expect(range.key).toBe('7D');
  });

  it('TODAY 起点是 UTC 当天零点', () => {
    const range = resolveOverviewRange('TODAY', undefined, undefined, NOW);
    expect(range.rangeStart.toISOString()).toBe('2026-02-14T00:00:00.000Z');
  });

  it('30D 起点 = UTC 今天零点 − 29 天', () => {
    const range = resolveOverviewRange('30D', undefined, undefined, NOW);
    expect(range.rangeStart.toISOString()).toBe('2026-01-16T00:00:00.000Z');
  });

  it('CUSTOM 必须同时给起止时间', () => {
    expect(() => resolveOverviewRange('CUSTOM', '2026-02-01T00:00:00.000Z', undefined, NOW)).toThrow();
  });

  it('CUSTOM 超过 366 天被拒绝（契约 §3.14.7.1 的 10016 → 本项目 10001）', () => {
    expect(() => resolveOverviewRange('CUSTOM', '2025-01-01T00:00:00.000Z', '2026-02-14T00:00:00.000Z', NOW)).toThrow();
  });

  it('起止倒置被拒绝', () => {
    expect(() => resolveOverviewRange('CUSTOM', '2026-02-14T00:00:00.000Z', '2026-02-01T00:00:00.000Z', NOW)).toThrow();
  });
});

describe('resolveRequiredRange / resolveCallLogRange', () => {
  it('缺时间范围直接拒绝', () => {
    expect(() => resolveRequiredRange(undefined, '2026-02-14T00:00:00.000Z')).toThrow();
  });

  it('调用日志范围上限 31 天（审计日志量大，保护数据库）', () => {
    expect(() => resolveCallLogRange('2026-01-01T00:00:00.000Z', '2026-02-14T00:00:00.000Z')).toThrow();

    const ok = resolveCallLogRange('2026-02-01T00:00:00.000Z', '2026-02-14T00:00:00.000Z');
    expect(ok.rangeStart.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('previousPeriod', () => {
  it('返回紧邻的等长周期（终点即当前周期起点）', () => {
    const current = resolveOverviewRange('TODAY', undefined, undefined, NOW);
    const previous = previousPeriod(current);

    expect(previous.rangeEnd.toISOString()).toBe(current.rangeStart.toISOString());
    const length = current.rangeEnd.getTime() - current.rangeStart.getTime();
    expect(previous.rangeStart.getTime()).toBe(current.rangeStart.getTime() - length);
  });
});

describe('toDateKey', () => {
  it('按 UTC 输出 yyyy-MM-dd（@db.Date 列与 raw 查询参数都用它）', () => {
    // 北京时间 2026-02-15 07:00 = UTC 2026-02-14 23:00 → 日期桶是 02-14
    expect(toDateKey(new Date('2026-02-14T23:00:00.000Z'))).toBe('2026-02-14');
  });
});

describe('toSafeNumber', () => {
  it('BigInt → number（BigInt 进入响应体会让 JSON.stringify 抛错）', () => {
    expect(toSafeNumber(123n)).toBe(123);
    expect(toSafeNumber(null)).toBe(0);
    expect(toSafeNumber(undefined)).toBe(0);
    expect(toSafeNumber(42)).toBe(42);
  });

  it('超出安全整数的 bigint 夹到 MAX_SAFE_INTEGER（宁可失真也不抛错）', () => {
    expect(toSafeNumber(BigInt('99999999999999999999'))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('safeRatio / roundTo', () => {
  it('分母为 0 返回 0 而不是 NaN（NaN 会被序列化成 null，前端拿到的不是数字）', () => {
    expect(safeRatio(5, 0)).toBe(0);
    expect(safeRatio(0, 0)).toBe(0);
  });

  it('保留 4 位小数（契约示例 successRate 0.9953）', () => {
    expect(safeRatio(24742, 24860)).toBe(0.9953);
  });

  it('roundTo 四舍五入（刻意避开 1.005 这类二进制浮点边界）', () => {
    expect(roundTo(1.2345, 2)).toBe(1.23);
    expect(roundTo(1.2356, 2)).toBe(1.24);
  });
});

describe('formatCents', () => {
  it('整数分 → ¥x,xxx.xx（契约 costDisplay ¥741.80 / ¥1,584.00）', () => {
    expect(formatCents(74180)).toBe('¥741.80');
    expect(formatCents(158_400)).toBe('¥1,584.00');
    expect(formatCents(0)).toBe('¥0.00');
  });

  it('负数保留符号（退款冲正场景）', () => {
    expect(formatCents(-1234)).toBe('-¥12.34');
  });
});

describe('formatPercent / formatCount / trendDirection', () => {
  it('百分比两位小数', () => {
    expect(formatPercent(0.0621)).toBe('6.21%');
  });

  it('千分位', () => {
    expect(formatCount(1860)).toBe('1,860');
  });

  it('变化方向', () => {
    expect(trendDirection(0.1)).toBe('UP');
    expect(trendDirection(-0.1)).toBe('DOWN');
    expect(trendDirection(0)).toBe('FLAT');
  });
});

describe('maskNickname', () => {
  it('保留首字符（契约示例 小满 → 小*、阿泽 → 阿*）', () => {
    expect(maskNickname('小满')).toBe('小*');
    expect(maskNickname('阿泽')).toBe('阿*');
    expect(maskNickname(null)).toBeNull();
  });
});

describe('toLengthBucket（契约 §3.14.7.4 示例）', () => {
  it('0 → ZERO；4280 → TOKEN_4K_8K；2480 → TOKEN_1K_4K', () => {
    expect(toLengthBucket(0)).toBe('ZERO');
    expect(toLengthBucket(null)).toBe('ZERO');
    expect(toLengthBucket(2480)).toBe('TOKEN_1K_4K');
    expect(toLengthBucket(4280)).toBe('TOKEN_4K_8K');
    expect(toLengthBucket(20_000)).toBe('TOKEN_16K_PLUS');
  });
});

describe('provider 名称与任务名', () => {
  it('库内大写枚举 ↔ 契约小写名', () => {
    expect(toProviderName('DEEPSEEK')).toBe('deepseek');
    expect(toProviderEnum('deepseek')).toBe('DEEPSEEK');
  });

  it('任务中文名；未知任务回落原值（便于发现新增任务未登记）', () => {
    expect(aiTaskName('MBTI_REPORT')).toBe('MBTI 深度报告');
    expect(aiTaskName('NEW_TASK')).toBe('NEW_TASK');
  });
});

describe('describeErrorCode', () => {
  it('按本项目错误码表翻译（而不是套用契约示例的码值体系）', () => {
    expect(describeErrorCode(ErrorCode.AI_PROVIDER_UNAVAILABLE)).toBe('AI 服务暂时不可用，请稍后重试');
  });

  it('未登记的错误码回落到通用文案，绝不返回空串', () => {
    expect(describeErrorCode(999_999).length).toBeGreaterThan(0);
  });
});
