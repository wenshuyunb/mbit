/**
 * 模块展示配置测试（ADR-038）
 *
 * 这个文件本身没有"算法"，但它是**三件容易静默出错的事**的唯一来源：
 *   ① `reportType` 必须与后端 `REPORT_TYPES` 逐字一致 —— 写错会在 DTO 层被拒
 *      （`10001 type 取值不合法`），而那个报错与"模块配错了"毫无关联，排查成本很高；
 *   ② 未知模块必须**降级**而不是抛错 —— 后端新增模块时前端不该整页白屏；
 *   ③ 未上线的模块不能出现在入口列表里（`available: false` 要真的生效）。
 */

import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_STYLE_LABELS,
  CONFLICT_STYLE_LABELS,
  CONFLICT_STYLE_ORDER,
  LOVE_LANGUAGE_LABELS,
  LOVE_LANGUAGE_ORDER,
  availableModules,
  modulePresentation,
} from '@/config/modules';

describe('modulePresentation', () => {
  it('已知模块返回自己的配置', () => {
    expect(modulePresentation('PERSONALITY').entranceTitle).toBe('人格测试');
    expect(modulePresentation('EMOTION').entranceTitle).toBe('情感测评');
  });

  it('【关键】未知模块降级为中性配置，而不是抛错', () => {
    // 后端将来加模块（阶段 4 的心理健康）时，前端应优雅降级
    const fallback = modulePresentation('SOMETHING_NEW');

    expect(fallback.entranceTitle).toBe('测评');
    expect(fallback.reportType).toBe('MBTI_REPORT');
    expect(fallback.available).toBe(true);
  });

  it('null / undefined 同样走降级（后端漏下发 module 时不该崩）', () => {
    expect(modulePresentation(null).introTitle).toBe('测评');
    expect(modulePresentation(undefined).introTitle).toBe('测评');
  });

  it('【关键】人格与情感的文案必须不同（否则用户分不清自己在做哪个模块）', () => {
    const personality = modulePresentation('PERSONALITY');
    const emotion = modulePresentation('EMOTION');

    expect(personality.introTitle).not.toBe(emotion.introTitle);
    expect(personality.introDesc).not.toBe(emotion.introDesc);
    expect(personality.resultTitle).not.toBe(emotion.resultTitle);
  });

  it('【关键】报告类型与后端 REPORT_TYPES 逐字一致', () => {
    // 后端 `report.dto.ts` 的合法取值：写错会在 DTO 层被拒，报错文案与"模块配错"无关
    const backendReportTypes = [
      'MBTI_REPORT',
      'BIG_FIVE_REPORT',
      'RELATIONSHIP_REPORT',
      'GROWTH_SUMMARY',
      'EMOTION_REPORT',
    ];

    for (const module of ['PERSONALITY', 'EMOTION', 'MENTAL_HEALTH'] as const) {
      expect(backendReportTypes).toContain(modulePresentation(module).reportType);
    }

    // 情感模块**必须**用 EMOTION_REPORT：写死 MBTI_REPORT 会让做完情感测评的用户
    // 点「生成报告」时收到「尚未生成人格画像」—— 一个与该模块毫不相关的错误
    expect(modulePresentation('EMOTION').reportType).toBe('EMOTION_REPORT');
  });

  it('情感模块的介绍文案不写"心理"与"诊断"（定位是亲密关系，不是临床）', () => {
    const emotion = modulePresentation('EMOTION');

    expect(emotion.introTitle).not.toContain('诊断');
    expect(emotion.introDesc).not.toContain('诊断');
    expect(emotion.introDesc).not.toContain('心理疾病');
  });
});

describe('availableModules', () => {
  it('已上线的模块都在（人格 + 情感）', () => {
    const keys = availableModules().map((item) => item.key);

    expect(keys).toContain('PERSONALITY');
    expect(keys).toContain('EMOTION');
  });

  it('【关键】未上线的模块不出现在入口列表里', () => {
    // 心理健康模块阶段 4 才落地，现在渲染一个点进去报错的入口是更糟的选择
    expect(availableModules().map((item) => item.key)).not.toContain('MENTAL_HEALTH');
  });

  it('每个可展示的模块都有完整的入口文案与图标', () => {
    for (const item of availableModules()) {
      expect(item.entranceTitle.length).toBeGreaterThan(0);
      expect(item.entranceDesc.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('情感维度标签', () => {
  it('五种爱的语言都有中文名', () => {
    for (const code of LOVE_LANGUAGE_ORDER) {
      expect(LOVE_LANGUAGE_LABELS[code]).toBeTruthy();
    }
    expect(LOVE_LANGUAGE_ORDER).toHaveLength(5);
  });

  it('五种冲突风格都有中文名', () => {
    for (const code of CONFLICT_STYLE_ORDER) {
      expect(CONFLICT_STYLE_LABELS[code]).toBeTruthy();
    }
    expect(CONFLICT_STYLE_ORDER).toHaveLength(5);
  });

  it('四种依恋类型都有中文名', () => {
    expect(Object.keys(ATTACHMENT_STYLE_LABELS).sort()).toEqual(['ANXIOUS', 'AVOIDANT', 'FEARFUL', 'SECURE']);
  });

  it('【关键】标签表用的编码与后端计分维度逐字一致', () => {
    // 后端 `emotion-engine.types.ts` 的 LOVE_LANGUAGE_DIMENSIONS / CONFLICT_STYLE_DIMENSIONS
    expect([...LOVE_LANGUAGE_ORDER]).toEqual(['LOVE_WORDS', 'LOVE_TIME', 'LOVE_GIFTS', 'LOVE_SERVICE', 'LOVE_TOUCH']);
    expect([...CONFLICT_STYLE_ORDER]).toEqual([
      'CONFLICT_COLLABORATING',
      'CONFLICT_COMPROMISING',
      'CONFLICT_ACCOMMODATING',
      'CONFLICT_AVOIDING',
      'CONFLICT_COMPETING',
    ]);
  });

  it('爱的语言标签表**不含**旧规则表的编码（两套编码不可混用）', () => {
    // `relationship_style_rules` 用的是 WORDS_OF_AFFIRMATION / QUALITY_TIME 等，
    // 混进来会让"测出来的爱的语言"与"规则推导出来的"看起来是同一件事
    expect(LOVE_LANGUAGE_LABELS).not.toHaveProperty('WORDS_OF_AFFIRMATION');
    expect(LOVE_LANGUAGE_LABELS).not.toHaveProperty('QUALITY_TIME');
  });
});
