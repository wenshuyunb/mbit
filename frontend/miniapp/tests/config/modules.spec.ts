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
    // 后端将来加模块时，前端应优雅降级
    const fallback = modulePresentation('SOMETHING_NEW');

    expect(fallback.entranceTitle).toBe('测评');
    expect(fallback.available).toBe(true);
    // 降级配置**不给报告入口**：未知模块不确定有没有 AI 报告，
    // 给一个点了会报"尚未生成人格画像"的按钮比不给更糟
    expect(fallback.reportType).toBeNull();
    expect(fallback.testCode).toBe('');
  });

  it('null / undefined 同样走降级（后端漏下发 module 时不该崩）', () => {
    expect(modulePresentation(null).introTitle).toBe('测评');
    expect(modulePresentation(undefined).introTitle).toBe('测评');
  });

  it('【关键】人格、情感、心理三个模块的文案两两不同（用户要能分辨）', () => {
    const titles = (['PERSONALITY', 'EMOTION', 'MENTAL_HEALTH'] as const).map(
      (module) => modulePresentation(module).introTitle,
    );

    expect(new Set(titles).size).toBe(3);

    const resultTitles = (['PERSONALITY', 'EMOTION', 'MENTAL_HEALTH'] as const).map(
      (module) => modulePresentation(module).resultTitle,
    );

    expect(new Set(resultTitles).size).toBe(3);
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
      const reportType = modulePresentation(module).reportType;

      // `null` 表示本模块**没有** AI 报告 —— 那不是"漏配"，因此不算错误
      if (reportType !== null) {
        expect(backendReportTypes).toContain(reportType);
      }
    }

    // 情感模块**必须**用 EMOTION_REPORT：写死 MBTI_REPORT 会让做完情感测评的用户
    // 点「生成报告」时收到「尚未生成人格画像」—— 一个与该模块毫不相关的错误
    expect(modulePresentation('EMOTION').reportType).toBe('EMOTION_REPORT');
  });

  it('【关键】心理健康模块没有 AI 报告（这是产品决策，不是漏配）', () => {
    /**
     * 该模块的红线是「不给建议、不做干预」，而一份"AI 深度解读"几乎不可能
     * 只陈述结论而不给建议。它的交付物是**服务端下发的确定性结论文本**。
     *
     * 这条断言的价值：将来有人"顺手"给它配一个报告类型时，
     * 会先在这里被拦住并读到上面这段理由。
     */
    expect(modulePresentation('MENTAL_HEALTH').reportType).toBeNull();
  });

  it('情感模块的介绍文案不写"心理"与"诊断"（定位是亲密关系，不是临床）', () => {
    const emotion = modulePresentation('EMOTION');

    expect(emotion.introTitle).not.toContain('诊断');
    expect(emotion.introDesc).not.toContain('诊断');
    expect(emotion.introDesc).not.toContain('心理疾病');
  });

  it('【关键】心理健康模块的文案不做诊断暗示，且明写"仅供参考"与"不给建议"', () => {
    const mentalHealth = modulePresentation('MENTAL_HEALTH');

    // 不叫"心理健康测评"：那听起来像筛查，而本模块只描述近两周的状态
    expect(mentalHealth.entranceTitle).toBe('心理状态自评');
    expect(mentalHealth.introTitle).not.toContain('诊断');
    expect(mentalHealth.introDesc).not.toContain('诊断');

    // 三条边界都要在文案里说清楚，而不是等用户读完才发现
    expect(mentalHealth.introDesc).toContain('不给建议');
    expect(mentalHealth.introDesc).toContain('仅供参考');
  });
});

describe('每个模块的入口编码', () => {
  it('【关键】可展示的模块都配了 testCode（否则入口点进去是另一个测评）', () => {
    for (const item of availableModules()) {
      expect(item.testCode.length).toBeGreaterThan(0);
    }
  });

  it('三个模块的编码互不相同', () => {
    const codes = availableModules().map((item) => item.testCode);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('编码与后端的 test_definitions.code 一致（写错会在入口处 404）', () => {
    expect(modulePresentation('PERSONALITY').testCode).toBe('MBTI_LITE');
    expect(modulePresentation('EMOTION').testCode).toBe('EMOTION_LITE');
    expect(modulePresentation('MENTAL_HEALTH').testCode).toBe('MENTAL_HEALTH_LITE');
  });
});

describe('availableModules', () => {
  it('三个模块都上线了（人格 + 情感 + 心理状态自评）', () => {
    const keys = availableModules().map((item) => item.key);

    expect(keys).toContain('PERSONALITY');
    expect(keys).toContain('EMOTION');
    expect(keys).toContain('MENTAL_HEALTH');
  });

  it('入口顺序稳定：人格 → 情感 → 心理状态自评（按"想了解什么"排列）', () => {
    expect(availableModules().map((item) => item.key)).toEqual(['PERSONALITY', 'EMOTION', 'MENTAL_HEALTH']);
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
