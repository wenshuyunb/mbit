/**
 * 今日抽卡的确定性逻辑
 *
 * ## 为什么"今日抽卡"必须是确定性的
 *
 * 用户对"今日"这件事的预期很明确：**今天抽到的就是这张，刷新不该变**。
 * 如果每次进来都随机，那它就不是"今日之牌"，而是一个刷新按钮。
 *
 * 因此种子由 `(用户 + 日期)` 决定：
 *   · 同一个用户同一天 → 永远是同一张牌、同一个朝向；
 *   · 换一天 → 换一张（用户隔天来看有新鲜感）；
 *   · 不同用户同一天 → 各自的牌不同（不然所有人晒出来是同一张，体验很差）。
 *
 * ⚠ 种子必须含 `userId`。只用日期的话，同一天所有用户会抽到同一张牌 ——
 * 这在小范围测试时看不出来，上线后会被用户一眼识破。
 */

import type { TarotCard, TarotDraw, TarotOrientation } from './tarot.types';
import { TAROT_ORIENTATION_LABELS } from './tarot.types';

/** 字符串 → 32 位种子（与星座模块同一套 xmur3 变体，保证跨模块行为一致） */
const hashSeed = (text: string): number => {
  let hash = 1779033703 ^ text.length;

  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }

  return hash >>> 0;
};

/** mulberry32：小而稳定的确定性伪随机源 */
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

/**
 * 当日提示
 *
 * 把牌义落成"今天可以试的一件事"。刻意都是**低成本、可自己决定**的小动作，
 * 不出现任何"该不该"的结论（合规红线 ①）。
 */
const ADVICE_BY_ARCANA: Readonly<Record<string, readonly [string, string]>> = {
  MAJOR: ['今天适合挑一件一直想做但没开始的小事，只做开头五分钟。', '今天可以先把自己手上的资源列一遍，再决定下一步。'],
  MINOR: ['今天适合把一件具体的小事做完，而不是同时开三个头。', '今天可以少解释一句，先把事情推进一格。'],
};

/**
 * 抽今日牌
 *
 * @param userId 用户 ID（必须参与种子，否则所有人抽到同一张）
 * @param date   日期 `YYYY-MM-DD`
 */
export const drawDailyCard = (deck: readonly TarotCard[], userId: string, date: string): TarotDraw => {
  const random = createRandom(`tarot:${userId}:${date}`);

  const index = Math.floor(random() * deck.length);
  const card = deck[Math.min(deck.length - 1, Math.max(0, index))] ?? deck[0];

  if (card === undefined) {
    throw new RangeError('塔罗牌组为空');
  }

  // 逆位概率刻意做成 1/3 而不是 1/2：逆位文案是"受阻"，出现太频繁会让每日解读显得灰暗
  const orientation: TarotOrientation = random() < 1 / 3 ? 'REVERSED' : 'UPRIGHT';

  const advicePool = ADVICE_BY_ARCANA[card.arcana] ?? ADVICE_BY_ARCANA['MINOR'];
  const advice = advicePool[Math.floor(random() * advicePool.length)] ?? advicePool[0];

  return {
    card,
    orientation,
    orientationLabel: TAROT_ORIENTATION_LABELS[orientation],
    date,
    advice,
  };
};
