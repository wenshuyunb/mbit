/**
 * 牌阵解读：把"位置 + 牌义"组合成一段说得通的整体分析
 *
 * ## 这一层的核心主张
 *
 * 单张牌单看永远说不深：同样一张「塔」，在"过去"里读作"已经发生过的断裂"，
 * 在"二选一"里读作"这个选项会带来突变"。**位置给了牌意义**。
 * 因此这里的做法是：逐个位置回答那个位置的提问，再从整组牌里读出三条横向信息：
 *
 *   ① **大阿卡纳占比**：占比高说明这件事涉及的是底层结构/长期模式，
 *      不是一个技巧问题；占比低说明它更像日常事务，能靠具体动作推动；
 *   ② **花色分布**：权杖=行动、圣杯=情感、宝剑=想法与冲突、星币=现实积累 ——
 *      哪一类最多，说明这件事的重心压在哪；
 *   ③ **逆位占比**：逆位多说明能量受阻或过量，推进得慢是正常的，不必自责。
 *
 * 这三条都是从**真实盘面**算出来的，不是套话；因此不同的人看到的总结真的不一样。
 *
 * ## 合规
 *
 * 通篇只描述倾向与处境，不给"该不该"的结论，不预测具体事件，不承诺结果。
 */

import type { TarotCard, TarotOrientation } from './tarot.types';
import { TAROT_SUIT_LABELS } from './tarot.types';
import type { SpreadPosition } from './tarot-spreads';

/** 抽到的一张（含位置） */
export interface SpreadDrawResult {
  readonly position: SpreadPosition;
  readonly card: TarotCard;
  readonly orientation: TarotOrientation;
  readonly orientationLabel: string;
  /** 这张牌在这个位置上的解读（位置提问 + 牌义） */
  readonly reading: string;
}

/** 整体解读 */
export interface SpreadSummary {
  /** 一句话结论（先给判断，再给依据） */
  readonly headline: string;
  /** 横向结构分析（三条：比重、重心、受阻程度） */
  readonly structure: string;
  /** 逐位置串联成的一段话 */
  readonly narrative: string;
  /** 收尾建议（低成本、可自己决定） */
  readonly advice: string;
  /** 数据可视化用：大阿卡纳占比 / 逆位占比 */
  readonly stats: {
    readonly majorCount: number;
    readonly minorCount: number;
    readonly reversedCount: number;
    readonly total: number;
  };
}

/** 花色分布 → 重心描述 */
const SUIT_FOCUS: Readonly<Record<string, string>> = {
  WANDS: '行动与推进',
  CUPS: '情感与关系',
  SWORDS: '想法与沟通',
  PENTACLES: '现实与积累',
};

const dominantSuitOf = (cards: readonly TarotCard[]): string | null => {
  const tally = new Map<string, number>();

  for (const card of cards) {
    if (card.suit === null) continue;
    tally.set(card.suit, (tally.get(card.suit) ?? 0) + 1);
  }

  const sorted = [...tally.entries()].sort((left, right) => right[1] - left[1]);
  const top = sorted[0];

  // 并列第一时不硬点一个（"两种力量各占一半"本身就是有效信息）
  if (top === undefined) return null;
  if (sorted[1] !== undefined && sorted[1][1] === top[1]) return null;

  return top[0];
};

/** 每个位置的解读：位置提问 + 牌义 */
export const buildPositionReading = (
  position: SpreadPosition,
  card: TarotCard,
  orientation: TarotOrientation,
): string => {
  const meaning = orientation === 'UPRIGHT' ? card.upright : card.reversed;
  const orientationText = orientation === 'UPRIGHT' ? '正位' : '逆位';

  return `【${position.label}】${position.question}这张牌是${card.name}（${orientationText}）。${meaning}`;
};

/**
 * 生成整体解读
 *
 * @param draws  抽到的牌（含位置）
 * @param random 由抽卡种子派生的确定性随机源（保证同一份牌阵永远同一段总结）
 */
export const buildSpreadSummary = (draws: readonly SpreadDrawResult[], random: () => number): SpreadSummary => {
  const cards = draws.map((draw) => draw.card);
  const majorCount = cards.filter((card) => card.arcana === 'MAJOR').length;
  const minorCount = cards.length - majorCount;
  const reversedCount = draws.filter((draw) => draw.orientation === 'REVERSED').length;
  const total = cards.length;

  const majorRatio = total === 0 ? 0 : majorCount / total;
  const reversedRatio = total === 0 ? 0 : reversedCount / total;
  const dominantSuit = dominantSuitOf(cards);
  const focus = dominantSuit === null ? null : (SUIT_FOCUS[dominantSuit] ?? null);
  const reversedHeavy = reversedRatio >= 0.5;

  // ---------------------------------------------------------------- 一句话结论
  const tone =
    majorRatio >= 0.5
      ? '这组牌里大阿卡纳偏多，说明它牵涉的是比较底层的模式，不是临场调整一下就能变的'
      : '这组牌里小阿卡纳偏多，说明它更像日常层面的事，具体的动作能推动它';

  const headline = reversedHeavy
    ? `${tone}；同时逆位占比 ${reversedCount}/${total}，能量明显受阻或过量 —— 慢一点是正常的。`
    : `${tone}；逆位只有 ${reversedCount}/${total}，整体能量是顺畅的。`;

  // ---------------------------------------------------------------- 结构分析（三条）
  const structure = [
    `**牌面构成**：${majorCount} 张大阿卡纳 + ${minorCount} 张小阿卡纳。`,
    focus === null
      ? '**重心分布**：两种花色并重，这件事同时压在两条线上，不要只处理一边。'
      : `**重心分布**：${dominantSuit === null ? '' : TAROT_SUIT_LABELS[dominantSuit as keyof typeof TAROT_SUIT_LABELS].name}最多（${cards.filter((card) => card.suit === dominantSuit).length} 张），这件事的重心在「${focus}」上。`,
    reversedHeavy
      ? '**受阻程度**：逆位偏多，说明眼下不是"使不上劲"，而是"劲用错了地方"——先把节奏调回来，比再加一把劲有用。'
      : '**受阻程度**：逆位不多，说明这组牌提示的路径本身是通的，难点在你要不要开始。',
  ].join('\n\n');

  // ---------------------------------------------------------------- 逐位置串联
  const narrativeLines = draws.map((draw) => {
    const meaning = draw.orientation === 'UPRIGHT' ? draw.card.upright : draw.card.reversed;
    // 把长牌义压成一句话：取第一个句号之前的部分，避免串联时读起来像流水账
    const brief = meaning.split('。')[0] ?? meaning;

    return `${draw.position.label}是${draw.card.name}（${draw.orientationLabel}）：${brief}。`;
  });

  const narrative = `${narrativeLines.join('')}把这几张放在一起看，串起来的是这样一条线：${
    draws[0] === undefined ? '' : draws[0].position.label
  }交代了起点，${draws[draws.length - 1] === undefined ? '后面' : draws[draws.length - 1].position.label}给出了落点。`;

  // ---------------------------------------------------------------- 收尾建议
  const advicePool = reversedHeavy
    ? [
        '今天不用逼自己"想通"。先把这组牌里最让你在意的那一张记下来，隔一两天再回来看，往往会自己浮出答案。',
        '如果卡住，先做一件最小的、今天就能完成的事 —— 逆位偏多的时候，动起来比想清楚更能破局。',
      ]
    : [
        '这组牌的路径是通的，缺的通常只是第一步。挑一件今天就能做完的小事开始。',
        '把牌面里最像你现状的那一张记下来，一周后再对照一次，你会看到自己的变化。',
      ];

  const advice = advicePool[Math.min(advicePool.length - 1, Math.floor(random() * advicePool.length))] ?? advicePool[0];

  return {
    headline,
    structure,
    narrative,
    advice,
    stats: { majorCount, minorCount, reversedCount, total },
  };
};
