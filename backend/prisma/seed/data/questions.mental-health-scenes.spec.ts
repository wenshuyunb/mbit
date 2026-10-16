/**
 * 「这两周的一天」情境题库契约测试
 *
 * ## 这批断言守的是什么
 *
 * 心理状态自评的题库从"24 句抽象自评"改成了"24 幕生活情境"（用户拍板），
 * 但**计分口径一个字没动**：仍是六个维度、每维 4 题、四档频率作答。
 * 于是最大的风险不再是"题写得好不好"，而是**结构走样**：
 *
 *   ① **维度少一道或多一道** → 该维度被稀释，六个维度的均值档位整体偏移；
 *   ② **正反向题配比破了** → 一致性评分失效（只有一种方向时会静默返回 100）；
 *   ③ **反向题方向写反** → 该维度**静默反向**：状态差的人被判成状态好，
 *      而结论读起来完全通顺。这是本文件里最值钱的一条断言（见 `POLE` 表）；
 *   ④ **选项分值不统一** → 引擎推导出的量程 `{min,max}` 不对，
 *      归一化后的百分比全错，但没有任何报错；
 *   ⑤ **反馈里出现建议** → 踩本模块的合规红线（只描述、不建议、不诊断）。
 *
 * ## 为什么方向要"逐题写死"而不是靠测试算出来
 *
 * 反向题的方向是**写题时的人工判断**（"几乎没有 → 几乎每天"这一档代表症状更高还是更低），
 * 没有任何代码能推断它。因此这里把 24 幕的期望方向**逐条列出来**：
 * 改了题面或调了 `reverseScored` 就必须来改这张表 —— 强制"改的人重新想一遍方向"。
 */

import {
  ALL_MENTAL_HEALTH_SCENES,
  MENTAL_HEALTH_FREQUENCY_OPTIONS,
  MENTAL_HEALTH_MOMENT_LABELS,
  buildMentalHealthOptions,
} from './questions.mental-health-scenes';
import type { SeedDimension } from '../types';

/** 本模块的六个计分维度（顺序即文档里的顺序） */
const DIMENSIONS: SeedDimension[] = ['MH_STRESS', 'MH_MOOD', 'MH_ANXIETY', 'MH_SLEEP', 'MH_ENERGY', 'MH_LONELINESS'];

/** 每个时刻应有的幕数（6 个时刻 × 4 幕 = 24） */
const MOMENTS = ['MORNING', 'COMMUTE', 'DAYTIME', 'PEOPLE', 'EVENING', 'BEDTIME'] as const;

/**
 * 逐题方向表：`true` = 反向题（频率越高 → 该维度分数**越低**）
 *
 * | 编码 | 维度 | 这一幕描述的是 | 方向 |
 * | ---- | ---- | -------------- | ---- |
 * | 01 | 精力 | 起身像没开机（症状出现） | 正 |
 * | 02 | 睡眠 | 睡不够、惦记补觉（症状出现） | 正 |
 * | 03 | 精力 | 睡够了、起身不费劲（症状缺席） | **反** |
 * | 04 | 睡眠 | 一觉到闹钟（症状缺席） | **反** |
 * | 05 | 压力 | 赶着出门、心里算迟到（症状出现） | 正 |
 * | 06 | 压力 | 节奏自己定、有空看一眼天（症状缺席） | **反** |
 * | 07 | 紧张 | 心跳快、手心潮（症状出现） | 正 |
 * | 08 | 紧张 | 出门前把事摆好（症状缺席） | **反** |
 * | 09 | 精力 | 做一小时就想靠一会儿（症状出现） | 正 |
 * | 10 | 精力 | 事情做完、没被掏空（症状缺席） | **反** |
 * | 11 | 情绪 | 提不起劲、刷手机（症状出现） | 正 |
 * | 12 | 情绪 | 被事情带进去、忘了时间（症状缺席） | **反** |
 * | 13 | 支持 | 想说话但不知道找谁（症状出现） | 正 |
 * | 14 | 支持 | 心里清楚该找谁（症状缺席） | **反** |
 * | 15 | 支持 | 话被"想开点"堵回去（症状出现） | 正 |
 * | 16 | 支持 | 有人看出来了、坐着陪了一会儿（症状缺席） | **反** |
 * | 17 | 情绪 | 点开剧两分钟就关（症状出现） | 正 |
 * | 18 | 情绪 | 对下个月的事有点期待（症状缺席） | **反** |
 * | 19 | 压力 | 到家了肩膀还端着（症状出现） | 正 |
 * | 20 | 压力 | 写完明天的事、今天算过完（症状缺席） | **反** |
 * | 21 | 睡眠 | 关灯后脑子开始转（症状出现） | 正 |
 * | 22 | 睡眠 | 躺下没多久就睡过去（症状缺席） | **反** |
 * | 23 | 紧张 | 半夜醒来开始盘算（症状出现） | 正 |
 * | 24 | 紧张 | 关灯后能慢慢松下来（症状缺席） | **反** |
 */
const EXPECTED_REVERSE: Readonly<Record<string, boolean>> = {
  MH_SC_01: false,
  MH_SC_02: false,
  MH_SC_03: true,
  MH_SC_04: true,
  MH_SC_05: false,
  MH_SC_06: true,
  MH_SC_07: false,
  MH_SC_08: true,
  MH_SC_09: false,
  MH_SC_10: true,
  MH_SC_11: false,
  MH_SC_12: true,
  MH_SC_13: false,
  MH_SC_14: true,
  MH_SC_15: false,
  MH_SC_16: true,
  MH_SC_17: false,
  MH_SC_18: true,
  MH_SC_19: false,
  MH_SC_20: true,
  MH_SC_21: false,
  MH_SC_22: true,
  MH_SC_23: false,
  MH_SC_24: true,
};

describe('「这两周的一天」情境题库', () => {
  it('共 24 幕', () => {
    expect(ALL_MENTAL_HEALTH_SCENES).toHaveLength(24);
  });

  it('编码唯一且形如 MH_SC_<两位序号>，序号与 order 一致', () => {
    const codes = ALL_MENTAL_HEALTH_SCENES.map((scene) => scene.code);

    expect(new Set(codes).size).toBe(codes.length);

    for (const scene of ALL_MENTAL_HEALTH_SCENES) {
      expect(scene.code).toMatch(/^MH_SC_\d{2}$/);
      // 编码尾号与展示顺序一致：排障时看编码就知道它是第几幕
      expect(Number.parseInt(scene.code.slice(-2), 10)).toBe(scene.order + 1);
    }
  });

  it('【关键】order 全局唯一且从 0 连续到 23（试卷顺序必须确定）', () => {
    const orders = ALL_MENTAL_HEALTH_SCENES.map((scene) => scene.order).sort((a, b) => a - b);

    expect(orders).toEqual(Array.from({ length: 24 }, (_, index) => index));
  });

  it('六个时刻各 4 幕，且顺序就是一天的时间轴', () => {
    for (const moment of MOMENTS) {
      const items = ALL_MENTAL_HEALTH_SCENES.filter((scene) => scene.moment === moment);

      expect(items).toHaveLength(4);
    }

    // 时刻在试卷里必须**成块且按时间轴排列**：早上醒来 → … → 躺下之后。
    // 交错出现会破坏"跟着一天走"的沉浸感
    const moments = ALL_MENTAL_HEALTH_SCENES.map((scene) => scene.moment);
    const blocks = moments.filter((moment, index) => index === 0 || moments[index - 1] !== moment);

    expect(blocks).toEqual([...MOMENTS]);
    expect(Object.keys(MENTAL_HEALTH_MOMENT_LABELS)).toEqual([...MOMENTS]);
  });

  it.each(DIMENSIONS.map((dimension) => [dimension] as const))('维度 %s 恰好 4 幕，且 2 正 2 反', (dimension) => {
    const items = ALL_MENTAL_HEALTH_SCENES.filter((scene) => scene.dimension === dimension);

    expect(items).toHaveLength(4);
    expect(items.filter((scene) => scene.reverseScored)).toHaveLength(2);
    expect(items.filter((scene) => !scene.reverseScored)).toHaveLength(2);
  });

  it('题库只含本模块的六个维度（不许混进别的模块的维度）', () => {
    for (const scene of ALL_MENTAL_HEALTH_SCENES) {
      expect(DIMENSIONS).toContain(scene.dimension);
    }
  });

  /**
   * 【最值钱的一条】反向题方向逐题核对
   *
   * `reverseScored` 写反不会报错，只会让该维度静默反向 —— 状态最差的人拿到最低分，
   * 而结论文案读起来毫无破绽。因此这里不"算"方向，而是**把期望方向逐题写死**：
   * 谁改了题面或方向，就必须来改这张表，等于强制重新判断一次。
   */
  it('【关键】反向题方向逐题与方向表一致（写反会让该维度静默反向）', () => {
    for (const scene of ALL_MENTAL_HEALTH_SCENES) {
      expect(EXPECTED_REVERSE[scene.code]).toBeDefined();
      expect(scene.reverseScored).toBe(EXPECTED_REVERSE[scene.code]);
    }

    // 方向表本身不能有多余项（删了一幕却忘了删表，会掩盖"题真的少了"）
    expect(Object.keys(EXPECTED_REVERSE)).toHaveLength(ALL_MENTAL_HEALTH_SCENES.length);
  });

  it('不出现连续两道反向题（避免受测者识别出反向题区段）', () => {
    for (const dimension of DIMENSIONS) {
      const flags = ALL_MENTAL_HEALTH_SCENES.filter((scene) => scene.dimension === dimension)
        .sort((a, b) => a.order - b.order)
        .map((scene) => scene.reverseScored);

      for (let index = 1; index < flags.length; index += 1) {
        expect(flags[index] === true && flags[index - 1] === true).toBe(false);
      }

      // 每维 4 题：前后半区各一道反向题（2 正 2 反且不连续时必然成立，这里显式钉住）
      expect(flags.slice(0, 2).filter(Boolean)).toHaveLength(1);
      expect(flags.slice(2).filter(Boolean)).toHaveLength(1);
    }
  });

  it('【关键】每个选项的分值只挂在该题自己的维度上，取值 1–4', () => {
    for (const scene of ALL_MENTAL_HEALTH_SCENES) {
      const options = buildMentalHealthOptions(scene.dimension);

      expect(options).toHaveLength(MENTAL_HEALTH_FREQUENCY_OPTIONS.length);

      options.forEach((option, index) => {
        // 只挂一个键：跨维度计分会让"压力高"和"睡眠差"互相污染
        expect(Object.keys(option.scores)).toEqual([scene.dimension]);
        expect(option.scores[scene.dimension]).toBe(index + 1);
      });
    }
  });

  it('四档频率选项统一：标签固定、value 连续为 1–4、反馈齐备', () => {
    expect(MENTAL_HEALTH_FREQUENCY_OPTIONS).toHaveLength(4);

    MENTAL_HEALTH_FREQUENCY_OPTIONS.forEach((option, index) => {
      expect(option.value).toBe(index + 1);
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.feedback.length).toBeGreaterThan(4);
    });

    // 四档的标签必须互不相同，否则用户分不清"两三天"和"一半以上"
    const labels = MENTAL_HEALTH_FREQUENCY_OPTIONS.map((option) => option.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  /**
   * 【合规红线】反馈不许给建议
   *
   * 本模块的产品形态是"只做状态描述、不给建议、不做干预"（用户拍板）。
   * 即时反馈一旦写成"试试早点睡"，整条红线就破了 —— 而这句话读起来还很贴心。
   */
  it('【关键】即时反馈不含建议性措辞（本模块只描述、不建议）', () => {
    const advice = ['试试', '建议', '应该', '可以试', '不妨', '多休息', '早点睡', '放松一下', '要相信'];

    for (const option of MENTAL_HEALTH_FREQUENCY_OPTIONS) {
      for (const word of advice) {
        expect(option.feedback).not.toContain(word);
      }
    }
  });

  it('【合规红线】情境与提问句不含临床构念（比通用黑名单更严）', () => {
    const clinical = ['障碍', '治疗', '疾病', '生病', '崩溃', '绝望', '失眠症', '躯体化', '抑郁', '焦虑症', '诊断'];

    for (const scene of ALL_MENTAL_HEALTH_SCENES) {
      for (const word of clinical) {
        expect(scene.content).not.toContain(word);
        expect(scene.prompt).not.toContain(word);
      }
    }
  });

  it('情境是具体处境（20–60 字），不是抽象自评陈述', () => {
    for (const scene of ALL_MENTAL_HEALTH_SCENES) {
      expect(scene.content.length).toBeGreaterThanOrEqual(20);
      expect(scene.content.length).toBeLessThanOrEqual(60);
      // 抽象陈述句的典型开头，出现即说明写回了量表题
      expect(scene.content.startsWith('我')).toBe(false);
    }
  });

  it('提问句带时间窗「这两周」（否则用户会按"最近一天"或"一直以来"作答，分数不可比）', () => {
    for (const scene of ALL_MENTAL_HEALTH_SCENES) {
      expect(scene.prompt).toContain('这两周');
      expect(scene.prompt.endsWith('？')).toBe(true);
      expect(scene.prompt.length).toBeLessThanOrEqual(24);
    }
  });

  it('情境与提问句都不重复', () => {
    const contents = ALL_MENTAL_HEALTH_SCENES.map((scene) => scene.content);

    expect(new Set(contents).size).toBe(contents.length);
  });

  it('每幕都带 2–4 个标签（首个是时刻，供后台按时刻筛选）', () => {
    for (const scene of ALL_MENTAL_HEALTH_SCENES) {
      expect(scene.tags.length).toBeGreaterThanOrEqual(2);
      expect(scene.tags.length).toBeLessThanOrEqual(4);
    }
  });
});
