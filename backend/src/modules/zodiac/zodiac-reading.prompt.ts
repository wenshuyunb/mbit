/**
 * 星盘解读的 AI 提示词（**集中在一处，便于审阅与断言**）
 *
 * ## 为什么提示词单独成文件
 *
 * 星盘解读是"模型按用户真实数据写一篇长文"，最容易出问题的地方不是代码而是**口径**：
 * 一不小心就会写出"你今年会发财""建议你别跳槽"这类既不可证、又有决策风险的话。
 * 因此提示词与红线集中在这一个文件里，并由用例断言红线文字不被人删掉。
 *
 * ## 红线（与 `zodiac-content.spec.ts` 同一套）
 *
 *   ① 不做决策引导：不给投资、签约、就医、辞职之类的建议；
 *   ② 不做医疗暗示：状态只谈作息、运动、饮水、用眼，不提疾病与症状；
 *   ③ 不做承诺式预测：不写"必定""一定会""准确率"，只说"更容易""倾向于"；
 *   ④ 不用占卜词汇：算命、风水、转运、消灾、改命；
 *   ⑤ 必须承认这是文化娱乐性质，不作为人生决策依据。
 */

import type { NatalChart } from './zodiac-chart.util';

/** 生成章节的固定骨架（与模板 `buildTemplateReading` 的 key 一一对应） */
export const READING_SECTION_KEYS = ['big-three', 'elements', 'aspects', 'ruler', 'houses', 'apply'] as const;

/** 允许模型输出的最大章节数（防止写成一本书） */
export const READING_MAX_SECTIONS = READING_SECTION_KEYS.length;

/**
 * 系统提示词
 *
 * 刻意写得"笨"一点：给结构、给字数、给红线、给反例。模型最容易忽略的是
 * "不要做什么"，所以红线单独成段。
 */
export const READING_SYSTEM_PROMPT = [
  '你是一位擅长用日常语言解释星盘的写作者。你的读者是完全不懂占星术语的普通人。',
  '',
  '写作要求：',
  '1. 只根据我给你的**盘面事实**来写，不要编造盘上没有的星体、宫位或相位；',
  '2. 每一章都要落到具体的人和具体的生活场景，避免空话（"你很善良"这类不要写）；',
  '3. 用第二人称"你"，语气像朋友聊天，不用术语堆砌；必须用术语时要立刻用一句话解释；',
  `4. 输出 ${READING_MAX_SECTIONS} 个章节，key 依次为：${READING_SECTION_KEYS.join('、')}，每章 120–220 字；`,
  '5. 严格返回 JSON：{"sections":[{"key":"...","title":"...","body":"..."}]}，不要输出任何 JSON 之外的内容。',
  '',
  '必须遵守的红线（违反任何一条即为不合格）：',
  '· 不做决策引导：不许出现投资、买房、签约、辞职、离婚、就医等建议；',
  '· 不做医疗暗示：不许提疾病、症状、诊断；谈到状态只说作息、运动、饮水、用眼；',
  '· 不做承诺式预测：不许写"必定""一定会""准确率""保证"；用"更容易""倾向于""可以试试"；',
  '· 不用占卜词汇：算命、风水、转运、消灾、改命一律不许出现；',
  '· 不评判具体他人的好坏，只描述倾向与相处方式；',
  '· 结尾要给一句提醒：这是文化娱乐性质的参考，不作为人生决策依据。',
].join('\n');

/** 把星盘压成一段结构化事实（给模型看的"证据"，不含任何推测） */
export const buildReadingUserPrompt = (chart: NatalChart): string => {
  const lines: string[] = [];

  const body = (key: string): string => {
    const position = chart.positions.find((item) => item.key === key);

    if (position === undefined) return `${key}：未知`;

    const parts = [`${position.name}：${position.position}`];
    if (position.house !== null) parts.push(`第${position.house}宫`);
    if (position.retrograde) parts.push('逆行');

    return parts.join('，');
  };

  lines.push('【三巨头】');
  lines.push(body('SUN'));
  lines.push(body('MOON'));
  lines.push(
    `上升点：${chart.angles.ascendant === null ? '未知（用户未填出生时间或城市）' : chart.angles.ascendant.position}`,
  );
  lines.push(`天顶：${chart.angles.midheaven === null ? '未知' : chart.angles.midheaven.position}`);

  lines.push('');
  lines.push('【十大行星】');
  for (const position of chart.positions) {
    lines.push(body(position.key));
  }

  lines.push('');
  lines.push('【元素分布】');
  for (const entry of chart.elementDistribution) {
    lines.push(`${entry.label}：${entry.count} 个${entry.signs.length > 0 ? `（${entry.signs.join('、')}）` : ''}`);
  }
  lines.push(`缺失元素：${chart.missingElements.length === 0 ? '无' : chart.missingElements.join('、')}`);

  lines.push('');
  lines.push('【三分类分布】');
  for (const entry of chart.modeDistribution) {
    lines.push(`${entry.label}：${entry.count} 个`);
  }

  lines.push('');
  lines.push('【主要相位（按精确度排序，最多 8 条）】');
  if (chart.aspects.length === 0) {
    lines.push('无主要相位');
  } else {
    for (const aspect of chart.aspects.slice(0, 8)) {
      const from = chart.positions.find((item) => item.key === aspect.from)?.name ?? aspect.from;
      const to = chart.positions.find((item) => item.key === aspect.to)?.name ?? aspect.to;

      lines.push(`${from}${aspect.symbol}${to}：${aspect.name}，偏差 ${aspect.orb.toFixed(2)}°，性质 ${aspect.nature}`);
    }
  }

  lines.push('');
  lines.push('【命主星】');
  lines.push(
    chart.chartRuler === null ? '未知（缺上升点）' : `${chart.chartRuler.planetName}落在${chart.chartRuler.position}`,
  );

  lines.push('');
  lines.push('【宫位】');
  lines.push(
    chart.houses === null
      ? '未知（缺出生时间或城市）'
      : chart.positions
          .filter((position) => position.house !== null)
          .map((position) => `${position.name}在第${position.house}宫`)
          .join('；'),
  );

  if (chart.stelliums.length > 0) {
    lines.push('');
    lines.push('【星群】');
    for (const stellium of chart.stelliums) {
      lines.push(`${stellium.signName}：${stellium.bodies.join('、')}`);
    }
  }

  return lines.join('\n');
};

/**
 * 解析模型返回的章节 JSON
 *
 * 三道兜底，因为模型"没按格式回答"是常态而不是例外：
 *   ① 不是对象 / 没有 sections → 返回 null（调用方回退模板）；
 *   ② 章节缺 key/title/body → 丢掉该章，而不是整篇作废；
 *   ③ 只认白名单里的 key，模型自创的章节直接丢弃（否则前端没法按 key 渲染）。
 */
export const parseReadingSections = (json: unknown): { key: string; title: string; body: string }[] | null => {
  if (typeof json !== 'object' || json === null) return null;

  const raw = (json as Record<string, unknown>)['sections'];
  if (!Array.isArray(raw)) return null;

  const allowed = new Set<string>(READING_SECTION_KEYS);
  const sections: { key: string; title: string; body: string }[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;

    const record = item as Record<string, unknown>;
    const key = typeof record['key'] === 'string' ? record['key'].trim() : '';
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    const body = typeof record['body'] === 'string' ? record['body'].trim() : '';

    if (!allowed.has(key) || title.length === 0 || body.length < 20) continue;
    if (sections.some((existing) => existing.key === key)) continue;

    sections.push({ key, title, body });
  }

  return sections.length > 0 ? sections : null;
};
