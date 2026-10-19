/**
 * 牌阵抽卡：按牌阵规则抽出 N 张**不重复**的牌
 *
 * ## 三条规则（每一条都有具体的理由）
 *
 *   ① **同一牌阵内不重复**：一副牌不会出现两张"愚者"。重复会让"过去"和"未来"
 *      抽到同一张牌，解读立刻失去意义，而且用户一眼就能看出这是假的；
 *   ② **同一天同一用户同一牌阵永远同一组**：种子含 `(用户 + 日期 + 牌阵)`。
 *      刷新不换牌，隔天/换牌阵才换 —— 与"今日之牌"的语义一致；
 *   ③ **不同牌阵抽出的牌互相独立**：种子含牌阵 id，所以"时间之流"和"二选一"
 *      在同一天会是两套完全不同的牌，而不是同一套牌的前三张。
 */

import type { TarotCard, TarotOrientation } from './tarot.types';
import { TAROT_ORIENTATION_LABELS } from './tarot.types';
import type { TarotSpread } from './tarot-spreads';
import {
  buildPositionReading,
  buildSpreadSummary,
  type SpreadDrawResult,
  type SpreadSummary,
} from './tarot-summary.util';

/** 字符串 → 32 位种子（与 draw util 同一套） */
const hashSeed = (text: string): number => {
  let hash = 1779033703 ^ text.length;

  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }

  return hash >>> 0;
};

/** mulberry32 */
const createRandom = (seedText: string): (() => number) => {
  let state = hashSeed(seedText) || 1;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;

    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

/** 一次牌阵的结果 */
export interface SpreadReading {
  readonly spreadId: string;
  readonly spreadName: string;
  readonly date: string;
  readonly draws: readonly SpreadDrawResult[];
  readonly summary: SpreadSummary;
}

/**
 * 按牌阵抽卡并生成解读
 *
 * @param userId 用户 ID（必须参与种子）
 * @param date   日期 `YYYY-MM-DD`
 */
export const drawSpread = (
  deck: readonly TarotCard[],
  spread: TarotSpread,
  userId: string,
  date: string,
): SpreadReading => {
  if (deck.length < spread.cardCount) {
    throw new RangeError(`牌组不足以支持该牌阵：需要 ${spread.cardCount} 张，实际 ${deck.length} 张`);
  }

  const random = createRandom(`tarot-spread:${userId}:${date}:${spread.id}`);

  // 洗牌：对索引做 Fisher–Yates，取前 N 个即"不重复的 N 张"
  const indices = deck.map((_, index) => index);

  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = indices[index];

    indices[index] = indices[swap];
    indices[swap] = current;
  }

  const draws: SpreadDrawResult[] = spread.positions.map((position, order) => {
    const cardIndex = indices[order] ?? 0;
    const card = deck[cardIndex];

    // 逆位概率 1/3（与单张抽卡同一口径）：逆位偏"受阻"，太多会让整组牌显得灰暗
    const orientation: TarotOrientation = random() < 1 / 3 ? 'REVERSED' : 'UPRIGHT';

    return {
      position,
      card,
      orientation,
      orientationLabel: TAROT_ORIENTATION_LABELS[orientation],
      reading: buildPositionReading(position, card, orientation),
    };
  });

  return {
    spreadId: spread.id,
    spreadName: spread.name,
    date,
    draws,
    summary: buildSpreadSummary(draws, random),
  };
};
