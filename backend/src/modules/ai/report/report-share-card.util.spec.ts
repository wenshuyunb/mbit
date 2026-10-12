/**
 * 分享卡纯逻辑测试（契约 §3.5.9）
 *
 * 三件事可在此穷举：
 *   · 复制/缓存键的构成（参数变了就必须换键）；
 *   · 分享文案的插值与兜底（不硬编码、不留 `{{}}` 残渣）；
 *   · 昵称脱敏（`showNickname=false` 时渲染实现拿到的已是脱敏文案）。
 */

import {
  SHARE_CARD_HOURLY_LIMIT,
  SHARE_CARD_SCENES,
  SHARE_CARD_TEMPLATES,
  SHARE_CARD_VALID_DAYS,
  buildQrCodeScene,
  buildShareCardObjectKey,
  buildThumbUrl,
  interpolateShareTemplate,
  maskDisplayName,
  resolveShareTemplate,
  shareCardFingerprint,
  shareVariablesOf,
} from './report-share-card.util';

describe('分享卡：枚举、对象键与缩略图', () => {
  it('枚举与契约一致；每小时上限 10 次、有效期 30 天', () => {
    expect([...SHARE_CARD_TEMPLATES]).toEqual(['TYPE_CARD', 'RADAR_CARD', 'QUOTE_CARD']);
    expect([...SHARE_CARD_SCENES]).toEqual(['REPORT', 'TEST_RESULT', 'RELATIONSHIP']);
    expect(SHARE_CARD_HOURLY_LIMIT).toBe(10);
    expect(SHARE_CARD_VALID_DAYS).toBe(30);
  });

  it('对象键落在 share-card 前缀下（否则归属校验会失败）', () => {
    const key = buildShareCardObjectKey('user-1', 'report-1', 'RADAR_CARD', 'abcd1234');

    expect(key).toBe('share-card/user-1/report-1-radar_card-abcd1234.webp');
    expect(key.startsWith('share-card/')).toBe(true);
  });

  it('缩略图追加 x-oss-process 裁剪参数（已有查询参数时用 &）', () => {
    expect(buildThumbUrl('https://cdn.example.com/a.webp')).toBe(
      'https://cdn.example.com/a.webp?x-oss-process=image/resize,w_240/format,webp',
    );
    expect(buildThumbUrl('https://cdn.example.com/a.webp?version=2')).toContain('&x-oss-process=');
  });

  it('小程序码 scene 为 report_{前 8 位}（与契约示例逐字一致）', () => {
    expect(buildQrCodeScene('0195f3a2-b24e-7a86-abf1-7dae4b5c6f45')).toBe('report_0195f3a2');
  });
});

describe('分享卡：文案与脱敏', () => {
  it('模板插值填变量并清理空括号等残渣', () => {
    const text = interpolateShareTemplate('我的 MBTI 是 {{mbtiType}}（{{typeName}}）——{{tagline}}。来测测你的？', {
      mbtiType: 'INFJ',
    });

    expect(text).toBe('我的 MBTI 是 INFJ。来测测你的？');
  });

  it('未知变量不会留下 {{}} 占位符', () => {
    const text = interpolateShareTemplate('你好 {{unknown}} 世界', {});

    expect(text).not.toContain('{{');
    expect(text).toContain('你好');
  });

  it('分享文案来自配置模板；场景缺失时回落到 DEFAULT', () => {
    const templates = {
      DEFAULT: { title: '默认标题', text: '默认文案' },
      REPORT: { title: '我的人格深度报告', text: '我的 MBTI 是 {{mbtiType}}。' },
    };

    expect(resolveShareTemplate(templates, 'REPORT', { mbtiType: 'INFJ' })).toEqual({
      title: '我的人格深度报告',
      text: '我的 MBTI 是 INFJ。',
    });
    // `RELATIONSHIP` 在配置目录里没有模板 → 回落（不返回空标题）
    expect(resolveShareTemplate(templates, 'RELATIONSHIP', {}).title).toBe('默认标题');
    // 完全没有配置时用内置保底文案
    expect(resolveShareTemplate({}, 'REPORT', {}).title.length).toBeGreaterThan(0);
    expect(resolveShareTemplate({}, 'REPORT', {}).text.length).toBeGreaterThan(0);
  });

  it('从 MBTI 类型档案取中文名与标语（与报告生成同一份数据）', () => {
    const variables = shareVariablesOf('INFJ', '小明');

    expect(variables.typeName).toBe('提倡者');
    expect(variables.tagline?.length).toBeGreaterThan(4);
    expect(variables.nickname).toBe('小明');
    // 未知类型不产生假数据
    expect(shareVariablesOf('XXXX', null).typeName).toBeUndefined();
  });

  it('昵称脱敏为「一位 INFJ」，无类型时为「一位朋友」', () => {
    expect(maskDisplayName('小明', 'INFJ')).toBe('小明');
    expect(maskDisplayName(null, 'INFJ')).toBe('一位 INFJ');
    expect(maskDisplayName('   ', null)).toBe('一位朋友');
  });
});

describe('分享卡：缓存指纹', () => {
  it('任一影响画面的参数变化都会换指纹（避免复用出参数不符的旧图）', () => {
    const base = {
      reportId: 'report-1',
      template: 'TYPE_CARD' as const,
      quoteSectionKey: null,
      showQrCode: true,
      showNickname: true,
      scene: 'REPORT' as const,
    };

    const fingerprints = new Set([
      shareCardFingerprint(base),
      shareCardFingerprint({ ...base, template: 'RADAR_CARD' }),
      shareCardFingerprint({ ...base, showQrCode: false }),
      shareCardFingerprint({ ...base, showNickname: false }),
      shareCardFingerprint({ ...base, scene: 'TEST_RESULT' }),
      shareCardFingerprint({ ...base, quoteSectionKey: 'CORE_PORTRAIT' }),
    ]);

    expect(fingerprints.size).toBe(6);
  });
});
