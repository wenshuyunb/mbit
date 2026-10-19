/**
 * 塔罗牌阵（形式）定义
 *
 * ## 为什么要有"牌阵"这一层
 *
 * 塔罗的玩法本来就是「牌阵 × 牌义」：同样一张「塔」，在"过去/现在/未来"里读作
 * "已经发生过的断裂"，在"二选一"里读作"这个选项会带来突变"。单张牌单看永远说不深，
 * 位置才是让它有意义的东西。
 *
 * 因此这一层定义五种**规则明确**的牌阵，每种给出：
 *   · 张数与每个位置的名称 + 该位置的**提问方式**（这是解读的骨架）；
 *   · 适用场景（帮用户选对形式，而不是随便点一个）；
 *   · 布局提示（前端据此摆牌，不需要为每个牌阵单独写页面）。
 *
 * ## 挑选标准
 *
 * 只保留**规则清晰、普通人能一次看完**的牌阵：
 *   · 单张、三张（时间之流 / 二选一）、四张（关系）、七张（一周）；
 *   · 凯尔特十字（十张）虽然最经典，但一次摆十张会把小程序页面撑爆、
 *     解读也会长到没人读 —— 因此**不做**，宁可少一个也不要做一个读不完的。
 */

/** 一个位置（牌位） */
export interface SpreadPosition {
  readonly key: string;
  /** 位置名（如「过去」） */
  readonly label: string;
  /** 这个位置在问什么（解读时逐位置回答） */
  readonly question: string;
}

/** 一个牌阵 */
export interface TarotSpread {
  readonly id: string;
  readonly name: string;
  /** 一句话副标题（选择页上显示） */
  readonly tagline: string;
  /** 简介：这个牌阵适合什么场景、怎么读（选择页展开） */
  readonly intro: string;
  /** 张数 */
  readonly cardCount: number;
  /** 布局：`ROW` 单行 / `COLUMN` 竖列 / `CROSS` 交错 / `WEEK` 一周 */
  readonly layout: 'SINGLE' | 'ROW' | 'COLUMN' | 'CROSS' | 'WEEK';
  readonly positions: readonly SpreadPosition[];
}

/** 五种牌阵 */
export const TAROT_SPREADS: readonly TarotSpread[] = [
  {
    id: 'DAILY',
    name: '今日指引',
    tagline: '一张牌，看清今天把注意力放在哪里',
    intro:
      '最轻的一种玩法：只抽一张，回答"今天这件事该怎么看"。它不适合问具体结果，适合在出门前给自己定个调子 —— 今天更该主动还是收着、更该推进还是先放着。',
    cardCount: 1,
    layout: 'SINGLE',
    positions: [{ key: 'TODAY', label: '今天的指引', question: '今天最值得把注意力放在哪里？' }],
  },
  {
    id: 'THREE_TIME',
    name: '时间之流',
    tagline: '过去 / 现在 / 未来，看清一件事的走向',
    intro:
      '最经典的三张牌阵。它不预测"结果"，而是把一件事拆成三段：什么已经影响了它、现在处在什么位置、按现在的走法会往哪里去。适合一件已经发生、你想理清脉络的事。',
    cardCount: 3,
    layout: 'ROW',
    positions: [
      { key: 'PAST', label: '过去', question: '这件事是从什么基础上长出来的？' },
      { key: 'PRESENT', label: '现在', question: '你现在真正面对的是什么？' },
      { key: 'FUTURE', label: '走向', question: '按现在的走法，它会往哪里去？' },
    ],
  },
  {
    id: 'CHOICE',
    name: '二选一',
    tagline: '两个选项各自的代价与收获',
    intro:
      '当你卡在两个选项之间时用这个。它不替你选，而是把两个选项各自的"会发生什么"摆出来，再给一张关键提示 —— 通常看完你会发现自己其实早就倾向其中一边，只是需要有人把代价说清楚。',
    cardCount: 3,
    layout: 'ROW',
    positions: [
      { key: 'OPTION_A', label: '选项 A', question: '走这条路，你会得到什么、付出什么？' },
      { key: 'OPTION_B', label: '选项 B', question: '走那条路，你会得到什么、付出什么？' },
      { key: 'KEY', label: '关键提示', question: '做这个决定时，最该留意的是什么？' },
    ],
  },
  {
    id: 'RELATIONSHIP',
    name: '关系之镜',
    tagline: '你这边的、对方那边的、以及中间那段',
    intro:
      '用来理解一段具体关系的结构。它不判断"合不合适"，而是分别看两边各自的状态和关系本身的走向 —— 很多关系的卡点不在于谁对谁错，而在于两边处在完全不同的节奏上。',
    cardCount: 4,
    layout: 'CROSS',
    positions: [
      { key: 'SELF', label: '你这边的状态', question: '你在这段关系里真正的位置是什么？' },
      { key: 'OTHER', label: '对方那边的状态', question: '对方此刻可能处在什么状态？' },
      { key: 'BETWEEN', label: '关系本身', question: '你们之间当下是什么质地？' },
      { key: 'ADJUST', label: '可调整的地方', question: '哪一处松一松，关系会不一样？' },
    ],
  },
  {
    id: 'WEEK',
    name: '七日指引',
    tagline: '周一到周日，这一周怎么排',
    intro:
      '一次看完整周。它不给"哪天会怎样"的预测，而是给出一周的节奏提示：哪几天适合推进、哪几天适合缓一缓。适合在周日或周一早上做一次，给这一周先排个轻重。',
    cardCount: 7,
    layout: 'WEEK',
    positions: [
      { key: 'MON', label: '周一', question: '这一周以什么状态开场？' },
      { key: 'TUE', label: '周二', question: '精力该往哪里放？' },
      { key: 'WED', label: '周三', question: '一周的转折点在哪儿？' },
      { key: 'THU', label: '周四', question: '有什么需要处理的？' },
      { key: 'FRI', label: '周五', question: '这一周的收口该怎么做？' },
      { key: 'SAT', label: '周六', question: '该给自己补点什么？' },
      { key: 'SUN', label: '周日', question: '这一周留下了什么？' },
    ],
  },
];

/** 按 id 找牌阵（找不到返回 null，由调用方给 400 而不是猜一个默认牌阵） */
export const findSpread = (id: string): TarotSpread | null => TAROT_SPREADS.find((spread) => spread.id === id) ?? null;
