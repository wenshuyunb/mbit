/**
 * 重新生成纯逻辑测试（契约 §3.5.7）
 *
 * 断言的重点是"注入 Prompt 的短语是中文可读的"与"cacheKey 源串能区分每一次请求"：
 * 前者决定模型能否理解语气/侧重，后者决定"再生成一次"会不会撞唯一约束。
 */

import { ErrorCode } from '../../../common/errors/error-code';
import {
  DEFAULT_REGENERATE_DAILY_LIMIT,
  DEFAULT_REGENERATE_REASON,
  DEFAULT_REGENERATE_TONE,
  MAX_REGENERATE_FEEDBACK_LENGTH,
  MAX_REGENERATE_FOCUS,
  REGENERATE_FOCUS_VALUES,
  REGENERATE_REASONS,
  REGENERATE_TONES,
  assertFocusWithinLimit,
  describeFocus,
  describeTone,
  regenerationCacheKeySource,
} from './report-regenerate.util';

describe('重新生成：枚举与默认值（契约 §3.5.7）', () => {
  it('枚举与契约逐字一致', () => {
    expect([...REGENERATE_TONES]).toEqual(['WARM', 'NEUTRAL', 'DIRECT']);
    expect([...REGENERATE_REASONS]).toEqual(['TONE_CHANGE', 'FOCUS_CHANGE', 'UNSATISFIED', 'QUALITY_ISSUE']);
    expect([...REGENERATE_FOCUS_VALUES]).toEqual(['RELATIONSHIP', 'CAREER', 'EMOTION', 'SELF_GROWTH']);
    expect(DEFAULT_REGENERATE_TONE).toBe('WARM');
    expect(DEFAULT_REGENERATE_REASON).toBe('TONE_CHANGE');
    expect(MAX_REGENERATE_FOCUS).toBe(2);
    expect(MAX_REGENERATE_FEEDBACK_LENGTH).toBe(200);
    expect(DEFAULT_REGENERATE_DAILY_LIMIT).toBe(5);
  });

  it('focus 超过 2 个时抛 10001', () => {
    // 用捕获而非 `toThrow(expect.objectContaining(…))`：后者要求构造 Error 实例，
    // 会把"断言错误码"变成类型体操
    const capture = (fn: () => void): unknown => {
      try {
        fn();
        return null;
      } catch (error) {
        return error;
      }
    };

    expect(capture(() => assertFocusWithinLimit(['CAREER', 'EMOTION', 'SELF_GROWTH']))).toMatchObject({
      code: ErrorCode.PARAM_INVALID,
    });
    expect(capture(() => assertFocusWithinLimit(['CAREER', 'EMOTION']))).toBeNull();
  });
});

describe('重新生成：注入 Prompt 的中文短语', () => {
  it('语气映射为可理解的写作要求（而不是枚举值）', () => {
    expect(describeTone('WARM')).toContain('温和');
    expect(describeTone('DIRECT')).toContain('直接');
    expect(describeTone('NEUTRAL')).toContain('中性');
    expect(describeTone('DIRECT')).not.toBe('DIRECT');
  });

  it('侧重重映射为领域短语；未指定时表示均衡覆盖', () => {
    expect(describeFocus(['CAREER'])).toContain('职业');
    expect(describeFocus(['RELATIONSHIP', 'SELF_GROWTH'])).toContain('、');
    expect(describeFocus([])).toContain('均衡');
  });
});

describe('重新生成：cacheKey 源串', () => {
  const base = {
    originalCacheKey: 'original',
    version: 1,
    tone: 'WARM' as const,
    focus: ['CAREER'] as const,
    nonce: 'nonce-1',
  };

  it('包含版本、语气、侧重与随机数（任意一项变化都会产生不同的键）', () => {
    const source = regenerationCacheKeySource(base);

    expect(source).toContain('original');
    expect(source).toContain('v1');
    expect(source).toContain('WARM');
    expect(source).toContain('CAREER');
    expect(source).toContain('nonce-1');
    expect(regenerationCacheKeySource({ ...base, nonce: 'nonce-2' })).not.toBe(source);
    expect(regenerationCacheKeySource({ ...base, version: 2 })).not.toBe(source);
    expect(regenerationCacheKeySource({ ...base, tone: 'DIRECT' })).not.toBe(source);
  });
});
