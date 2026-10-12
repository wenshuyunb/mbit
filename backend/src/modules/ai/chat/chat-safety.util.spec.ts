/**
 * 危险内容预筛单测（契约 §3.7.5 业务规则 1，架构 §10.5）
 *
 * 核心主张：
 *   · 契约示例里的原话（"我觉得活着没什么意思了。"）**必须**命中 `SELF_HARM`
 *   · 常见口语/比喻（"自杀式加班"）与第三人称转述（"他不想活了"）**不能**误报
 *   · 命中类别决定后续文案，因此"哪一类"必须稳定可预测
 */

import { RISK_CATEGORIES, blockedReasonOf, buildSafetyResponseContent, screenRiskContent } from './chat-safety.util';

describe('screenRiskContent — 必须命中', () => {
  it('契约 §3.7.5 的示例原话命中 SELF_HARM', () => {
    const result = screenRiskContent('我觉得活着没什么意思了。');

    expect(result.matched).toBe(true);
    expect(result.category).toBe('SELF_HARM');
  });

  it.each([['我想自杀'], ['最近总是想着结束生命'], ['我不想活了'], ['我想一了百了'], ['我打算割腕']])(
    '自伤信号：%s',
    (text) => {
      expect(screenRiskContent(text)).toEqual({ matched: true, category: 'SELF_HARM' });
    },
  );

  it.each([['我想杀了他'], ['我准备弄死他'], ['我想捅死他']])('他伤信号：%s', (text) => {
    expect(screenRiskContent(text)).toEqual({ matched: true, category: 'HARM_TO_OTHER' });
  });

  it.each([['帮我诊断一下我是不是抑郁症'], ['我是不是得了焦虑症']])('诊断诉求：%s', (text) => {
    expect(screenRiskContent(text)).toEqual({ matched: true, category: 'MEDICAL_DIAGNOSIS' });
  });

  it.each([['我该吃什么药'], ['推荐点安眠药'], ['服药剂量要不要加量']])('用药诉求：%s', (text) => {
    expect(screenRiskContent(text)).toEqual({ matched: true, category: 'MEDICATION' });
  });

  it('返回的类别一定在契约枚举内（文案组装按它分支）', () => {
    const result = screenRiskContent('我不想活了');
    expect(RISK_CATEGORIES).toContain(result.category);
  });
});

describe('screenRiskContent — 必须不命中（避免把正常表达拦成危机）', () => {
  it.each([
    ['今天又是自杀式加班，累死了'],
    ['我才不想活成他那样'],
    ['他不想活了，我该怎么劝他'],
    ['她说她想自杀，我很担心'],
    ['这个方案简直是自杀'],
    ['我最近工作压力有点大，睡不好'],
  ])('不误报：%s', (text) => {
    expect(screenRiskContent(text)).toEqual({ matched: false, category: null });
  });

  it('空串与纯空白不命中', () => {
    expect(screenRiskContent('')).toEqual({ matched: false, category: null });
    expect(screenRiskContent('   \n  ')).toEqual({ matched: false, category: null });
  });
});

describe('blockedReasonOf', () => {
  it('命中时给出契约常量 SAFETY_KEYWORD_MATCH，未命中为 null', () => {
    expect(blockedReasonOf({ matched: true, category: 'SELF_HARM' })).toBe('SAFETY_KEYWORD_MATCH');
    expect(blockedReasonOf({ matched: false, category: null })).toBeNull();
  });
});

describe('buildSafetyResponseContent', () => {
  const resources = [
    { name: '全国心理援助热线', phone: '12356', available: '24 小时' },
    { name: '希望 24 热线', phone: '400-161-9995', available: '24 小时' },
  ];

  it('自伤文案包含真实热线号码与危机提示（不能只说"请联系专业机构"）', () => {
    const content = buildSafetyResponseContent({
      category: 'SELF_HARM',
      resources,
      crisisNotice: '请立即联系专业热线。',
      emergencyNotice: '如有紧急危险，请拨打 120。',
    });

    expect(content).toContain('12356');
    expect(content).toContain('400-161-9995');
    expect(content).toContain('请立即联系专业热线。');
    expect(content).toContain('如有紧急危险，请拨打 120。');
  });

  it('热线清单为空时给出兜底行动指令（不能留空）', () => {
    const content = buildSafetyResponseContent({
      category: 'SELF_HARM',
      resources: [],
      crisisNotice: 'crisis',
      emergencyNotice: 'emergency',
    });

    expect(content).toContain('120');
    expect(content).not.toContain('· ：');
  });

  it('四个类别各自产出不同文案（不能共用一段自伤文案）', () => {
    const build = (category: 'SELF_HARM' | 'HARM_TO_OTHER' | 'MEDICAL_DIAGNOSIS' | 'MEDICATION'): string =>
      buildSafetyResponseContent({ category, resources, crisisNotice: 'c', emergencyNotice: 'e' });

    const texts = [build('SELF_HARM'), build('HARM_TO_OTHER'), build('MEDICAL_DIAGNOSIS'), build('MEDICATION')];

    expect(new Set(texts).size).toBe(4);
    expect(build('HARM_TO_OTHER')).toContain('110');
    expect(build('MEDICAL_DIAGNOSIS')).toContain('诊断');
    expect(build('MEDICATION')).toContain('加量');
  });
});
