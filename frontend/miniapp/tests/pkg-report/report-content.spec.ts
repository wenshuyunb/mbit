/**
 * 报告正文版式解析测试
 *
 * ## 这批用例锁的是一个**用户直接说出口的**缺陷
 *
 * 用户的实测反馈：「点开一看，哇，全是字，我是用户我看都不想看，累不累啊，
 * 最好是图文并茂，一针见血，显得有亲和力，而不是字多就行」。
 *
 * 所以这里盯住的不是"函数返回了什么"，而是**页面上会不会重新变成一堵墙**：
 *   · 每段能不能拿到一句"一针见血"的首句；
 *   · 「五条建议」能不能拆成 5 张卡（模型把序号加粗也必须认）；
 *   · 「两周行动」能不能拆成两块；
 *   · **解析不出来时绝对不能丢内容** —— 版式失败只允许降级，不允许删字。
 */

import { describe, expect, it } from 'vitest';

import { buildSectionLayout, firstSentence } from '@/pkgReport/report-content';

/** 真实报告里的首段（2026-10-15 实测生成的那份情感报告，逐字摘录） */
const CORE_PORTRAIT = [
  '你是焦虑型依恋。你最怕的是对方忽然安静下来——消息回得慢了、语气淡了一点、见面时话少了几句，你心里就会开始不安，觉得是不是自己哪里做错了、是不是关系要出问题。你最想要的是一个明确的、看得见的回应：对方主动靠近你、把你放在眼前、让你知道"我在，我没走"。',
  '',
  '你的两条轴也说明了这一点。焦虑轴 52、回避轴 0，意味着你在关系里几乎不会往后退，所有的力气都用在"靠近"这一个方向上。',
  '',
  '还有一点值得你自己知道：你的作答一致性是 100，完成率也是 100%。这说明你对自己的感受是清楚的。',
].join('\n');

/** 建议段：模型实际输出的写法（序号加粗 + 三件事写在同一段里） */
const SUGGESTIONS = [
  '1. 想确认关系的时候，把"你是不是不高兴了"换成"我想抱一下"。具体做什么：下次你感到不安、想发消息试探时，先停十秒，然后发一句直接的靠近请求。为什么有效：你的焦虑轴 52 加上身体接触 63，说明你要的本来就是在场感。怎么算做到了：一周里有三次你把试探句换成了请求句。',
  '',
  '2. 争执当下，先说出你的需要，再谈事情本身。具体做什么：下次吵架，第一句话不要讲道理。为什么有效：你是协作型 100，只要确认了"我们是一边的"，你就有能力一起解决问题。怎么算做到了：一次争执里你能在五分钟内说出这句话。',
  '',
  '3. 你想退开、想一个人待着的时候，明确告诉对方"我需要半小时，不是不要你"。具体做什么：感到情绪要上来时，说一句"我去走一圈，半小时后回来找你"。为什么有效：你回避轴 0，本来就不擅长退开。怎么算做到了：做到一次"说清楚再走、按时回来"。',
  '',
  '4. 把"接受礼物 6、服务的行动 5"这件事直接讲给对方听。具体做什么：找个平静的时候，跟对方说清楚你要的是什么。为什么有效：很多伴侣是用做事来表达爱的。怎么算做到了：你完整说过一次。',
  '',
  '5. 给自己定一条边界：不追问超过两次。具体做什么：同一件事，你最多问两遍"你怎么了"。为什么有效：你的循环是"越问越退"。怎么算做到了：一周里有两三次你在第二遍之后真的停住了。',
].join('\n');

/** 行动段：两周安排 + 合规收束句 */
const ACTION_PLAN = [
  '第一周，做三件小事。第一天到第三天，只练一件事：每次想发试探消息时，改成一句直接的靠近请求。第四天，找一次平静的时机，把第 4 条建议那段话说给对方听。',
  '',
  '第二周，再推进三件。第八天到第十天，练争执里的第一句话。第十一天，练一次"说清楚再走"。第十二天到第十四天，把前两周做过的事挑一件固定成习惯。',
  '',
  '坚持两周后，你大概会看到两个变化：一是你发出去的消息里，"请求"变多了、"试探"变少了。',
  '',
  '本结果基于你本次的自我报告，反映的是你此刻在亲密关系中的倾向，会随情境与对象变化；它不构成心理诊断，也不构成对任何一段关系的评判。',
].join('\n');

describe('firstSentence', () => {
  it('取到第一个句末标点为止（首句就是"一针见血"那一句）', () => {
    expect(firstSentence('你是焦虑型依恋。你最怕的是对方忽然安静下来。')).toBe('你是焦虑型依恋。');
  });

  it('感叹号与问号同样算句末', () => {
    expect(firstSentence('先别急着下结论！这句话才是重点。')).toBe('先别急着下结论！');
    expect(firstSentence('你知道最要紧的是什么吗？')).toBe('你知道最要紧的是什么吗？');
  });

  it('首句过长时在逗号处断开并加省略号（不切在半句中间）', () => {
    const long = `${'这是一句很长的开头，'.repeat(12)}结束。`;
    const lead = firstSentence(long);

    expect(lead.length).toBeLessThanOrEqual(91);
    expect(lead.endsWith('…')).toBe(true);
    expect(long.startsWith(lead.slice(0, -1))).toBe(true);
  });

  it('没有句末标点时整句返回（短文本）', () => {
    expect(firstSentence('没有句号的一句话')).toBe('没有句号的一句话');
  });

  it('空文本返回空串（未解锁段落不会崩）', () => {
    expect(firstSentence('   ')).toBe('');
  });
});

describe('buildSectionLayout', () => {
  it('普通段落：首句独立、其余段落按空行切开', () => {
    const layout = buildSectionLayout('CORE_PORTRAIT', CORE_PORTRAIT);

    expect(layout.lead).toBe('你是焦虑型依恋。');
    expect(layout.paragraphs).toHaveLength(3);
    expect(layout.cards).toHaveLength(0);
    expect(layout.weeks).toHaveLength(0);
  });

  it('【关键】首句之后的内容一个字都不能丢（首句只是被"提"出来，不是被删掉）', () => {
    const layout = buildSectionLayout('CORE_PORTRAIT', CORE_PORTRAIT);
    const rebuilt = [layout.lead, ...layout.paragraphs].join('');

    // 去掉空白后逐字比对：版式解析不得改写或丢弃正文
    expect(rebuilt.replace(/\s/g, '')).toBe(CORE_PORTRAIT.replace(/\s/g, ''));
  });

  it('【关键】「五条建议」拆成 5 张卡（序号被加粗也要认出来）', () => {
    const layout = buildSectionLayout('GROWTH_SUGGESTIONS', SUGGESTIONS);

    expect(layout.cards).toHaveLength(5);
    expect(layout.cards.map((card) => card.index)).toEqual([1, 2, 3, 4, 5]);
    expect(layout.cards[0]?.title).toContain('我想抱一下');
    // 卡片自带正文（"具体做什么 / 为什么有效 / 怎么算做到了"都在里面）
    expect(layout.cards[0]?.body).toContain('为什么有效');
    // 拆成卡片后，段落数组清空，避免同一段内容被渲染两遍
    expect(layout.paragraphs).toHaveLength(0);
  });

  it('序号写成 `1、` 或 `1)` 同样能拆（模型的三种常见写法）', () => {
    const layout = buildSectionLayout(
      'GROWTH_SUGGESTIONS',
      ['1、第一条建议的具体做法。', '2) 第二条建议的具体做法。'].join('\n'),
    );

    expect(layout.cards.map((card) => card.index)).toEqual([1, 2]);
  });

  it('【关键】拆成卡片后正文一个字都不少（版式失败只允许降级，不允许丢字）', () => {
    const layout = buildSectionLayout('GROWTH_SUGGESTIONS', SUGGESTIONS);

    // 卡片正文按顺序拼回来，应当覆盖原文（只少了行首序号与空白）
    const rebuilt = layout.cards
      .map((card) => card.body)
      .join('')
      .replace(/\s/g, '');
    const expected = SUGGESTIONS.replace(/^\s*(?:\*\*)?\s*[1-9]\s*[.、)]\s*(?:\*\*)?\s*/gm, '').replace(/\s/g, '');

    expect(rebuilt).toBe(expected);
    // 标题是正文的前缀（拆分只是"把第一句提出来"，不是复制或改写）
    for (const card of layout.cards) {
      expect(card.body.startsWith(card.title.replace(/…$/, ''))).toBe(true);
    }
  });

  it('【关键】不编号时不硬拆，退回普通段落（版式失败只允许降级，不允许丢字）', () => {
    const plain = '第一条建议是先停下来。第二条建议是把需要说出来。';
    const layout = buildSectionLayout('GROWTH_SUGGESTIONS', plain);
    const rebuilt = [layout.lead, ...layout.paragraphs].join('');

    expect(layout.cards).toHaveLength(0);
    expect(rebuilt.replace(/\s/g, '')).toBe(plain);
  });

  it('只有一个编号项时也不拆（"五条建议"的版式前提是至少两条）', () => {
    const layout = buildSectionLayout('GROWTH_SUGGESTIONS', '1. 只有一条。剩下的没编号。');

    expect(layout.cards).toHaveLength(0);
  });

  it('【关键】「两周行动」按周拆成两块，合规收束句留在段落里', () => {
    const layout = buildSectionLayout('ACTION_PLAN', ACTION_PLAN);

    expect(layout.weeks.map((week) => week.label)).toEqual(['第一周', '第二周']);
    expect(layout.weeks[0]?.text).toContain('第一天到第三天');
    // 收束句不属于任何一周，必须仍然出现在页面上
    expect(layout.paragraphs.some((text) => text.includes('不构成心理诊断'))).toBe(true);
  });

  it('「第 1 周」这种写法也能认，并归一成「第一周」（版式不该因为写法不同就退化）', () => {
    const layout = buildSectionLayout(
      'ACTION_PLAN',
      [
        '第 1 周先做一件事：把想发试探消息的时刻改成一句直接的请求，看看对方的反应有什么不同。',
        '',
        '第 2 周再做一件：把上一条固定成习惯，同时给自己留一天完全不检查对方消息的日子。',
      ].join('\n'),
    );

    expect(layout.weeks.map((week) => week.label)).toEqual(['第一周', '第二周']);
  });

  it('非建议/行动段不做特殊解析（段落键决定版式）', () => {
    expect(buildSectionLayout('DIMENSION_ANALYSIS', SUGGESTIONS).cards).toHaveLength(0);
    expect(buildSectionLayout('DIMENSION_ANALYSIS', ACTION_PLAN).weeks).toHaveLength(0);
  });

  it('模型只换行不空行时也能切段（整篇是一段的话，折叠就等于没折叠）', () => {
    const singleNewlines = [
      '第一句结论在这里，先把它说清楚，让人一眼看懂这一段想表达什么。',
      '第二段内容同样足够长，长到可以说这是一个独立段落而不是列表里的一行文字。',
      '第三段内容也一样长，用来验证按单换行切分的兜底逻辑确实生效了没有。',
    ].join('\n');
    const layout = buildSectionLayout('CORE_PORTRAIT', singleNewlines);

    expect(layout.paragraphs).toHaveLength(2);
  });

  it('空正文（未解锁段落）返回空结构，不抛错', () => {
    const layout = buildSectionLayout('CORE_PORTRAIT', '');

    expect(layout).toMatchObject({ lead: '', paragraphs: [], cards: [], weeks: [], charCount: 0 });
  });
});
