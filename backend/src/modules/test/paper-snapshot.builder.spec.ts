/**
 * 试卷快照构造器测试
 *
 * 重点验证两类「不可逆」的设计承诺：
 *   · **固化**：快照写入后题目内容/顺序/选项顺序都不得再变（题库改动不影响历史会话）
 *   · **乱序策略**：仅 `BINARY` 且非反向题才打乱选项 —— 打乱李克特量表会破坏「程度递进」语义
 */

import {
  buildPaperSnapshot,
  DEFAULT_PAGE_SIZE,
  shouldShuffleOptions,
  shuffle,
  SNAPSHOT_VERSION,
} from './paper-snapshot.builder';
import type { SnapshotSourceQuestion } from './test.types';

// ============================================================================
// 夹具
// ============================================================================

const likertQuestion = (id: string): SnapshotSourceQuestion => ({
  id,
  code: `Q_${id}`,
  content: `题目内容 ${id}`,
  scenarioPrompt: null,
  type: 'LIKERT5',
  dimension: 'EI',
  reverseScored: false,
  weight: 1,
  tags: ['测试'],
  // 量表题不带选项分值（空对象），算分走"用户所选值"这条老路
  options: [1, 2, 3, 4, 5].map((value) => ({
    label: `选项${value}`,
    value,
    isActive: true,
    scoreMap: {},
    feedback: null,
  })),
});

const binaryQuestion = (id: string, reverseScored = false): SnapshotSourceQuestion => ({
  id,
  code: `Q_${id}`,
  content: `二选一 ${id}`,
  scenarioPrompt: null,
  type: 'BINARY',
  dimension: 'SN',
  reverseScored,
  weight: 1,
  tags: ['测试'],
  options: [
    { label: '选项A', value: 0, isActive: true, scoreMap: {}, feedback: null },
    { label: '选项B', value: 1, isActive: true, scoreMap: {}, feedback: null },
  ],
});

/** 沉浸式场景题夹具（ADR-039）：选项带维度分与即时反馈 */
const scenarioQuestion = (id: string): SnapshotSourceQuestion => ({
  id,
  code: `SC_${id}`,
  content: `你加班到很晚，她发消息说「算了，你忙吧」。`,
  scenarioPrompt: '这时候你会怎么做？',
  type: 'FORCED_CHOICE',
  dimension: 'ATTACH_ANXIETY',
  reverseScored: false,
  weight: 1,
  tags: ['场景', '回避'],
  options: [
    {
      label: '立刻打电话过去解释',
      value: 1,
      isActive: true,
      scoreMap: { ATTACH_ANXIETY: 3, CONFLICT_COLLABORATING: 2 },
      feedback: '她多半会先松一口气。',
    },
    {
      label: '先睡，明天再说',
      value: 2,
      isActive: true,
      scoreMap: { ATTACH_AVOIDANCE: 3, CONFLICT_AVOIDING: 2 },
      feedback: '事情可能会留到明天，也可能就过去了。',
    },
  ],
});

/** 确定性随机源：固定序列，保证测试可复现 */
const seededRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    // 线性同余，仅为测试提供可复现的伪随机序列
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
};

// ============================================================================
// shuffle
// ============================================================================

describe('shuffle', () => {
  it('返回新数组，不修改入参', () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];

    shuffle(input, seededRandom(1));

    expect(input).toEqual(snapshot);
  });

  it('保留全部元素（不丢不重）', () => {
    const input = Array.from({ length: 50 }, (_, index) => index);
    const result = shuffle(input, seededRandom(42));

    expect(result).toHaveLength(input.length);
    expect([...result].sort((a, b) => a - b)).toEqual(input);
  });

  it('相同随机序列产生相同顺序（可复现）', () => {
    const input = Array.from({ length: 20 }, (_, index) => index);

    const first = shuffle(input, seededRandom(7));
    const second = shuffle(input, seededRandom(7));

    expect(second).toEqual(first);
  });

  it('空数组与单元素数组不出错', () => {
    expect(shuffle([], seededRandom(1))).toEqual([]);
    expect(shuffle([9], seededRandom(1))).toEqual([9]);
  });
});

// ============================================================================
// shouldShuffleOptions
// ============================================================================

describe('shouldShuffleOptions', () => {
  it('仅 BINARY 且非反向题才打乱选项', () => {
    expect(shouldShuffleOptions(binaryQuestion('b1', false))).toBe(true);
    expect(shouldShuffleOptions(binaryQuestion('b2', true))).toBe(false);
  });

  it('李克特量表不打乱选项（否则破坏程度递进语义）', () => {
    expect(shouldShuffleOptions(likertQuestion('l1'))).toBe(false);
  });

  it('迫选题与排序题不打乱选项', () => {
    const forced: SnapshotSourceQuestion = { ...likertQuestion('f1'), type: 'FORCED_CHOICE' };
    const rank: SnapshotSourceQuestion = { ...likertQuestion('r1'), type: 'RANK' };

    expect(shouldShuffleOptions(forced)).toBe(false);
    expect(shouldShuffleOptions(rank)).toBe(false);
  });
});

// ============================================================================
// buildPaperSnapshot
// ============================================================================

describe('buildPaperSnapshot', () => {
  const questions = [likertQuestion('q1'), likertQuestion('q2'), likertQuestion('q3'), likertQuestion('q4')];

  it('快照格式版本与分批参数符合契约', () => {
    const snapshot = buildPaperSnapshot(questions, { random: seededRandom(1) });

    expect(snapshot.snapshotVersion).toBe(SNAPSHOT_VERSION);
    expect(snapshot.questionsPerPage).toBe(DEFAULT_PAGE_SIZE);
    expect(snapshot.shuffled).toBe(true);
  });

  it('题目数量与来源一致，order 从 0 连续递增', () => {
    const snapshot = buildPaperSnapshot(questions, { random: seededRandom(1) });

    expect(snapshot.questions).toHaveLength(4);
    expect(snapshot.questions.map((question) => question.order)).toEqual([0, 1, 2, 3]);
  });

  it('包含算分所需的全部字段（questionId / dimension / reverseScored / weight）', () => {
    const withReverse: SnapshotSourceQuestion = { ...likertQuestion('qr'), reverseScored: true, weight: 2 };
    const snapshot = buildPaperSnapshot([withReverse], { random: seededRandom(1) });
    const question = snapshot.questions[0];

    expect(question?.questionId).toBe('qr');
    expect(question?.dimension).toBe('EI');
    expect(question?.reverseScored).toBe(true);
    expect(question?.weight).toBe(2);
    expect(question?.code).toBe('Q_qr');
    expect(question?.tags).toEqual(['测试']);
  });

  it('【固化】快照内容与源题目解耦：之后修改源对象不影响已生成的快照', () => {
    const source = likertQuestion('q1');
    const snapshot = buildPaperSnapshot([source], { random: seededRandom(1) });

    source.content = '被修改的题干';
    source.options[0].label = '被修改的选项';

    expect(snapshot.questions[0]?.content).toBe('题目内容 q1');
    expect(snapshot.questions[0]?.options[0]?.label).toBe('选项1');
  });

  it('过滤掉已停用的选项', () => {
    const withInactive: SnapshotSourceQuestion = {
      ...likertQuestion('q1'),
      options: [
        { label: '生效', value: 1, isActive: true, scoreMap: {}, feedback: null },
        { label: '停用', value: 2, isActive: false, scoreMap: {}, feedback: null },
      ],
    };

    const snapshot = buildPaperSnapshot([withInactive], { random: seededRandom(1) });

    expect(snapshot.questions[0]?.options).toEqual([{ label: '生效', value: 1, scoreMap: {}, feedback: null }]);
  });

  describe('乱序控制', () => {
    it('shuffled = false 时保持原顺序', () => {
      const snapshot = buildPaperSnapshot(questions, { random: seededRandom(1), shuffled: false });

      expect(snapshot.shuffled).toBe(false);
      expect(snapshot.questions.map((question) => question.questionId)).toEqual(['q1', 'q2', 'q3', 'q4']);
    });

    it('shuffled = true 时题目顺序被改变（用受控随机源验证确实发生乱序）', () => {
      // 随机源恒为 0 ⇒ Fisher–Yates 每次都与下标 0 交换，结果确定且必然不同于原顺序。
      // 刻意不用「某个种子」断言「顺序不同」—— 洗牌本来就可能合法地产生与原顺序相同的排列，
      // 那样的断言会随实现细节变化而随机失败。
      const snapshot = buildPaperSnapshot(questions, { random: () => 0 });
      const ids = snapshot.questions.map((question) => question.questionId);

      expect([...ids].sort()).toEqual(['q1', 'q2', 'q3', 'q4']);
      expect(ids).not.toEqual(['q1', 'q2', 'q3', 'q4']);
    });

    it('optionShuffled 标记反映「是否存在需要乱序的题」', () => {
      const onlyLikert = buildPaperSnapshot([likertQuestion('l1')], { random: seededRandom(1) });
      const withBinary = buildPaperSnapshot([likertQuestion('l1'), binaryQuestion('b1')], {
        random: seededRandom(1),
      });

      expect(onlyLikert.optionShuffled).toBe(false);
      expect(withBinary.optionShuffled).toBe(true);
    });

    it('BINARY 题的选项被打乱（受控随机源下必然交换）', () => {
      const snapshot = buildPaperSnapshot([binaryQuestion('b1')], { random: () => 0 });
      const values = snapshot.questions[0]?.options.map((option) => option.value) ?? [];

      expect([...values].sort()).toEqual([0, 1]);
      expect(values).toEqual([1, 0]);
    });

    it('反向 BINARY 题不打乱选项', () => {
      const snapshot = buildPaperSnapshot([binaryQuestion('b1', true)], { random: () => 0 });

      expect(snapshot.questions[0]?.options.map((option) => option.value)).toEqual([0, 1]);
    });

    it('李克特量表选项始终保持 1→5 递进', () => {
      const snapshot = buildPaperSnapshot([likertQuestion('l1')], { random: () => 0 });

      expect(snapshot.questions[0]?.options.map((option) => option.value)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it('量表说明随快照下发（前端渲染刻度用）', () => {
    const snapshot = buildPaperSnapshot(questions, { random: seededRandom(1) });

    expect(snapshot.answerScale.type).toBe('LIKERT5');
    expect(snapshot.answerScale.values).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.answerScale.labels).toHaveLength(5);
    expect(snapshot.answerScale.labels[0]).toBe('非常不同意');
    expect(snapshot.answerScale.labels[4]).toBe('非常同意');
  });

  it('空题目列表不抛异常', () => {
    const snapshot = buildPaperSnapshot([], { random: seededRandom(1) });

    expect(snapshot.questions).toEqual([]);
    expect(snapshot.optionShuffled).toBe(false);
  });

  it('【可复现】相同随机源生成完全一致的快照', () => {
    const first = buildPaperSnapshot(questions, { random: seededRandom(11) });
    const second = buildPaperSnapshot(questions, { random: seededRandom(11) });

    expect(second).toEqual(first);
  });

  // ==========================================================================
  // ADR-039：场景题（沉浸式）的字段必须随快照固化
  // ==========================================================================

  describe('场景题字段（ADR-039）', () => {
    it('【关键】选项的 scoreMap 被固化进快照 —— 它是场景题的算分依据', () => {
      const snapshot = buildPaperSnapshot([scenarioQuestion('s1')], { random: seededRandom(1) });
      const option = snapshot.questions[0]?.options[0];

      expect(option?.scoreMap).toEqual({ ATTACH_ANXIETY: 3, CONFLICT_COLLABORATING: 2 });
    });

    it('选项的即时反馈被固化（前端选中后立刻展示）', () => {
      const snapshot = buildPaperSnapshot([scenarioQuestion('s1')], { random: seededRandom(1) });

      expect(snapshot.questions[0]?.options[0]?.feedback).toBe('她多半会先松一口气。');
    });

    it('情境叙述与提问句分开存放（合成一句就没法排版成两段，沉浸感消失）', () => {
      const snapshot = buildPaperSnapshot([scenarioQuestion('s1')], { random: seededRandom(1) });

      expect(snapshot.questions[0]?.content).toContain('算了，你忙吧');
      expect(snapshot.questions[0]?.scenarioPrompt).toBe('这时候你会怎么做？');
    });

    it('量表题的 scenarioPrompt 为 null（题干本身即陈述句）', () => {
      const snapshot = buildPaperSnapshot([likertQuestion('l1')], { random: seededRandom(1) });

      expect(snapshot.questions[0]?.scenarioPrompt).toBeNull();
    });

    it('【关键】FORCED_CHOICE 的选项**不打乱** —— 防止"选 A 得到 B 的分"', () => {
      const snapshot = buildPaperSnapshot([scenarioQuestion('s1')], { random: () => 0 });
      const values = snapshot.questions[0]?.options.map((option) => option.value);

      expect(values).toEqual([1, 2]);
      expect(snapshot.optionShuffled).toBe(false);
    });

    it('停用的选项被丢弃时，分值不会"串位"（乱序只作用于保留后的选项）', () => {
      const question = scenarioQuestion('s1');
      const withInactive: SnapshotSourceQuestion = {
        ...question,
        options: [...question.options, { label: '停用项', value: 3, isActive: false, scoreMap: {}, feedback: null }],
      };

      const snapshot = buildPaperSnapshot([withInactive], { random: seededRandom(1) });

      expect(snapshot.questions[0]?.options).toHaveLength(2);
      expect(snapshot.questions[0]?.options[0]?.scoreMap).toEqual({ ATTACH_ANXIETY: 3, CONFLICT_COLLABORATING: 2 });
    });

    it('快照版本已升到 ps-v2（旧 ps-v1 会话仍按旧语义解析）', () => {
      const snapshot = buildPaperSnapshot([scenarioQuestion('s1')], { random: seededRandom(1) });

      expect(snapshot.snapshotVersion).toBe('ps-v2');
      expect(SNAPSHOT_VERSION).toBe('ps-v2');
    });
  });
});
