/**
 * 塔罗牌面艺术：**矢量图元组合**，不是 emoji、也不是单个几何图形
 *
 * ## 为什么走这条路（而不是图片或 SVG）
 *
 *   · **图片**：78 张高质量牌面 = 数 MB，小程序包体积承受不了；而且我没有
 *     可商用授权的成套塔罗插画，拿别人的商业牌面是侵权行为；
 *   · **SVG 字符串**：小程序里 `<image src="data:image/svg+xml,...">` 的支持不稳（不同基础库版本差异大），
 *     一旦不渲染就是空白牌面 —— 这是最差的结果；
 *   · **DOM 图元组合**（本方案）：用 `view` + 边框/圆角/旋转/渐变画同心圆、月牙、射线、
 *     三角、竖柱、星点。**在所有基础库版本上都能渲染**，体积几乎为零，
 *     且每张牌可以用不同图元组合出**可辨认的意象**。
 *
 * ## 这套图元能表达什么
 *
 * 古典塔罗的图面本身就是高度符号化的：月亮=月牙、太阳=圆盘+射线、命运之轮=轮辐、
 * 正义=天平、塔=高塔+闪电、死神=镰刀、世界=环形花冠。这些都能用几十个基础形状组合出来，
 * 比"一个 emoji"或"一个三角形"完成度高一到两个量级。
 *
 * ## 坐标约定
 *
 * 所有位置以**图元盒的百分比**表示，`50/50` 为中心；渲染器负责换算成 `left/top`。
 * 尺寸也按百分比，这样同一套构图在卡牌缩略图与大图上自动缩放。
 */

/** 图元 */
export type EmblemShape =
  | { kind: 'ring'; size: number; width?: number; color?: string; opacity?: number; x?: number; y?: number }
  | { kind: 'disc'; size: number; color?: string; opacity?: number; x?: number; y?: number }
  | { kind: 'crescent'; size: number; x?: number; y?: number; opacity?: number }
  | { kind: 'rays'; count: number; length: number; width?: number; opacity?: number; color?: string }
  | {
      kind: 'bar';
      length: number;
      width?: number;
      angle?: number;
      x?: number;
      y?: number;
      opacity?: number;
      color?: string;
    }
  | {
      kind: 'triangle';
      width: number;
      height: number;
      rotate?: number;
      x?: number;
      y?: number;
      opacity?: number;
      color?: string;
    }
  | { kind: 'stars'; items: ReadonlyArray<{ x: number; y: number; size: number; opacity?: number }> }
  | { kind: 'arc'; size: number; rotate?: number; opacity?: number; color?: string; x?: number; y?: number };

/** 一张牌的构图 */
export interface CardArt {
  readonly shapes: readonly EmblemShape[];
}

/** 金 / 月白两色，按需覆盖 */
const GOLD = '#c9ab73';
const MOON = '#f2ebdd';

/** 便捷构造：一圈星点（用于"星星"牌、世界牌的边角） */
const cornerStars = (size: number, count = 4): EmblemShape => {
  const positions = [
    { x: 22, y: 22 },
    { x: 78, y: 22 },
    { x: 22, y: 78 },
    { x: 78, y: 78 },
  ];

  return { kind: 'stars', items: positions.slice(0, count).map((pos) => ({ ...pos, size, opacity: 0.85 })) };
};

/**
 * 22 张大阿卡纳的构图
 *
 * 每张牌的图元组合对应一个**可辨认的古典意象**，写在注释里便于以后调整：
 * 调整时只要保证"意象仍在"，不必拘泥于具体数值。
 */
export const MAJOR_ART: Readonly<Record<string, CardArt>> = {
  // 愚者：一轮新月 + 崖边横线 + 三颗星（出发前的一步）
  'MAJOR-00': {
    shapes: [
      { kind: 'crescent', size: 46, x: 46, y: 42 },
      { kind: 'bar', length: 68, width: 2, angle: -12, y: 74, opacity: 0.7 },
      {
        kind: 'stars',
        items: [
          { x: 70, y: 30, size: 8 },
          { x: 78, y: 44, size: 6 },
          { x: 64, y: 20, size: 5 },
        ],
      },
    ],
  },
  // 魔术师：无限符号（两个相扣的环）+ 四元素点（杖/杯/剑/币）
  'MAJOR-01': {
    shapes: [
      { kind: 'ring', size: 40, x: 38, y: 40, width: 3 },
      { kind: 'ring', size: 40, x: 62, y: 40, width: 3 },
      { kind: 'bar', length: 56, width: 2, y: 66, opacity: 0.5 },
      { kind: 'disc', size: 8, x: 26, y: 74 },
      { kind: 'disc', size: 8, x: 42, y: 74 },
      { kind: 'disc', size: 8, x: 58, y: 74 },
      { kind: 'disc', size: 8, x: 74, y: 74 },
    ],
  },
  // 女祭司：月牙 + 两根柱子（圣殿之门）
  'MAJOR-02': {
    shapes: [
      { kind: 'bar', length: 62, width: 5, angle: 0, x: 28, y: 52, opacity: 0.55 },
      { kind: 'bar', length: 62, width: 5, angle: 0, x: 72, y: 52, opacity: 0.55 },
      { kind: 'crescent', size: 40, x: 50, y: 38 },
      { kind: 'ring', size: 24, x: 50, y: 38, width: 2, opacity: 0.5 },
    ],
  },
  // 女皇：圆盘（丰饶）+ 上方十二星冠 + 下方麦穗弧
  'MAJOR-03': {
    shapes: [
      { kind: 'disc', size: 34, x: 50, y: 48, opacity: 0.9 },
      {
        kind: 'stars',
        items: [
          { x: 30, y: 24, size: 6 },
          { x: 42, y: 18, size: 7 },
          { x: 58, y: 18, size: 7 },
          { x: 70, y: 24, size: 6 },
        ],
      },
      { kind: 'arc', size: 62, rotate: 180, opacity: 0.55 },
    ],
  },
  // 皇帝：三角宝座 + 两根立柱
  'MAJOR-04': {
    shapes: [
      { kind: 'triangle', width: 52, height: 40, y: 44, color: GOLD, opacity: 0.85 },
      { kind: 'bar', length: 40, width: 4, x: 26, y: 56, opacity: 0.6 },
      { kind: 'bar', length: 40, width: 4, x: 74, y: 56, opacity: 0.6 },
      { kind: 'bar', length: 64, width: 2, y: 78, opacity: 0.4 },
    ],
  },
  // 教皇：三根柱（三重权杖）+ 钥匙环
  'MAJOR-05': {
    shapes: [
      { kind: 'bar', length: 54, width: 4, x: 34, y: 52, opacity: 0.55 },
      { kind: 'bar', length: 62, width: 4, x: 50, y: 50, opacity: 0.75 },
      { kind: 'bar', length: 54, width: 4, x: 66, y: 52, opacity: 0.55 },
      { kind: 'ring', size: 22, x: 50, y: 30, width: 3 },
      { kind: 'bar', length: 26, width: 3, x: 50, y: 30, angle: 90, opacity: 0.6 },
    ],
  },
  // 恋人：两个相扣的环 + 中间贯穿的射线（结合）
  'MAJOR-06': {
    shapes: [
      { kind: 'ring', size: 34, x: 36, y: 50, width: 3 },
      { kind: 'ring', size: 34, x: 64, y: 50, width: 3 },
      { kind: 'rays', count: 6, length: 26, width: 1, opacity: 0.45 },
      { kind: 'disc', size: 6, x: 50, y: 50, color: MOON },
    ],
  },
  // 战车：两个相向三角（双兽）+ 中央轴
  'MAJOR-07': {
    shapes: [
      { kind: 'triangle', width: 34, height: 26, rotate: 90, x: 28, y: 46, opacity: 0.8 },
      { kind: 'triangle', width: 34, height: 26, rotate: -90, x: 72, y: 46, opacity: 0.8 },
      { kind: 'bar', length: 56, width: 3, x: 50, y: 46 },
      { kind: 'arc', size: 54, rotate: 0, y: 56, opacity: 0.6 },
    ],
  },
  // 力量：环抱圆盘（驯服）+ 无限符号
  'MAJOR-08': {
    shapes: [
      { kind: 'ring', size: 52, x: 50, y: 46, width: 4 },
      { kind: 'ring', size: 30, x: 50, y: 46, width: 2, opacity: 0.55 },
      { kind: 'ring', size: 16, x: 44, y: 78, width: 2, opacity: 0.5 },
      { kind: 'ring', size: 16, x: 56, y: 78, width: 2, opacity: 0.5 },
    ],
  },
  // 隐者：提灯（小圆盘 + 放射）+ 手杖竖线
  'MAJOR-09': {
    shapes: [
      { kind: 'disc', size: 22, x: 44, y: 40 },
      {
        kind: 'rays',
        count: 8,
        length: 20,
        width: 1,
        opacity: 0.5,
      },
      { kind: 'bar', length: 58, width: 3, x: 60, y: 56, opacity: 0.7 },
      {
        kind: 'stars',
        items: [
          { x: 30, y: 76, size: 6 },
          { x: 70, y: 26, size: 6 },
        ],
      },
    ],
  },
  // 命运之轮：轮圈 + 八根轮辐 + 中心盘
  'MAJOR-10': {
    shapes: [
      { kind: 'ring', size: 66, width: 4 },
      { kind: 'rays', count: 8, length: 40, width: 2, opacity: 0.6 },
      { kind: 'disc', size: 18, color: GOLD },
      { kind: 'ring', size: 40, width: 1.5, opacity: 0.45 },
    ],
  },
  // 正义：天平（横梁 + 两托盘 + 中柱）
  'MAJOR-11': {
    shapes: [
      { kind: 'bar', length: 62, width: 3, y: 34 },
      { kind: 'bar', length: 52, width: 3, x: 50, y: 52, angle: 90 },
      { kind: 'triangle', width: 26, height: 16, rotate: 180, x: 26, y: 48, opacity: 0.8 },
      { kind: 'triangle', width: 26, height: 16, rotate: 180, x: 74, y: 48, opacity: 0.8 },
      { kind: 'bar', length: 30, width: 3, y: 70, opacity: 0.5 },
    ],
  },
  // 倒吊人：倒三角 + 悬挂竖线
  'MAJOR-12': {
    shapes: [
      { kind: 'bar', length: 40, width: 3, y: 24 },
      { kind: 'bar', length: 26, width: 2, y: 40, opacity: 0.6 },
      { kind: 'triangle', width: 44, height: 34, rotate: 180, y: 58, opacity: 0.85 },
      { kind: 'ring', size: 14, x: 50, y: 58, width: 2, opacity: 0.5 },
    ],
  },
  // 死神：交叉镰刀 + 一轮残月
  'MAJOR-13': {
    shapes: [
      { kind: 'bar', length: 64, width: 3, angle: 38, opacity: 0.8 },
      { kind: 'bar', length: 64, width: 2, angle: -38, opacity: 0.5 },
      { kind: 'arc', size: 46, rotate: 200, opacity: 0.75 },
      { kind: 'crescent', size: 26, x: 72, y: 74 },
    ],
  },
  // 节制：两个相对的月牙（在两只杯之间倒水）
  'MAJOR-14': {
    shapes: [
      { kind: 'arc', size: 40, rotate: 90, x: 34, y: 42, opacity: 0.75 },
      { kind: 'arc', size: 40, rotate: -90, x: 66, y: 58, opacity: 0.75 },
      { kind: 'bar', length: 34, width: 2, angle: 42, opacity: 0.5 },
      { kind: 'disc', size: 8, x: 50, y: 50, color: MOON },
    ],
  },
  // 恶魔：倒三角 + 双角 + 松开的锁链（两节的环）
  'MAJOR-15': {
    shapes: [
      { kind: 'triangle', width: 50, height: 40, rotate: 180, y: 42, opacity: 0.75 },
      { kind: 'bar', length: 22, width: 3, x: 34, y: 24, angle: 28, opacity: 0.7 },
      { kind: 'bar', length: 22, width: 3, x: 66, y: 24, angle: -28, opacity: 0.7 },
      { kind: 'ring', size: 18, x: 44, y: 74, width: 2.5, opacity: 0.65 },
      { kind: 'ring', size: 18, x: 58, y: 74, width: 2.5, opacity: 0.65 },
    ],
  },
  // 塔：塔身（两个竖条 + 横条）+ 闪电（折线用三根斜线拼）
  'MAJOR-16': {
    shapes: [
      { kind: 'triangle', width: 40, height: 34, y: 56, opacity: 0.85 },
      { kind: 'bar', length: 30, width: 4, x: 50, y: 74, angle: 90, opacity: 0.8 },
      { kind: 'bar', length: 26, width: 3, x: 42, y: 26, angle: 62 },
      { kind: 'bar', length: 22, width: 3, x: 54, y: 34, angle: -50 },
      { kind: 'bar', length: 18, width: 2, x: 62, y: 20, angle: 40, opacity: 0.7 },
    ],
  },
  // 星星：一大七小（最经典的牌面构图）
  'MAJOR-17': {
    shapes: [
      { kind: 'stars', items: [{ x: 50, y: 44, size: 26 }] },
      {
        kind: 'stars',
        items: [
          { x: 26, y: 24, size: 9 },
          { x: 74, y: 24, size: 9 },
          { x: 20, y: 50, size: 8 },
          { x: 80, y: 50, size: 8 },
          { x: 32, y: 70, size: 7 },
          { x: 68, y: 70, size: 7 },
          { x: 50, y: 76, size: 6 },
        ],
      },
      { kind: 'arc', size: 58, rotate: 180, y: 60, opacity: 0.4 },
    ],
  },
  // 月亮：月牙 + 两座塔（小三角）+ 一串小路点
  'MAJOR-18': {
    shapes: [
      { kind: 'crescent', size: 44, x: 50, y: 38 },
      { kind: 'triangle', width: 16, height: 22, x: 26, y: 62, opacity: 0.6 },
      { kind: 'triangle', width: 16, height: 22, x: 74, y: 62, opacity: 0.6 },
      {
        kind: 'stars',
        items: [
          { x: 44, y: 72, size: 5, opacity: 0.6 },
          { x: 52, y: 80, size: 5, opacity: 0.5 },
          { x: 60, y: 88, size: 4, opacity: 0.4 },
        ],
      },
    ],
  },
  // 太阳：圆盘 + 十六道射线 + 内环
  'MAJOR-19': {
    shapes: [
      { kind: 'disc', size: 34, opacity: 1 },
      { kind: 'rays', count: 16, length: 34, width: 2, opacity: 0.7 },
      { kind: 'ring', size: 44, width: 1.5, opacity: 0.5 },
    ],
  },
  // 审判：号角（横条 + 喇叭口三角）+ 三个小人（三个小盘）
  'MAJOR-20': {
    shapes: [
      { kind: 'bar', length: 52, width: 4, angle: -22, y: 32, opacity: 0.85 },
      { kind: 'triangle', width: 24, height: 18, rotate: 90, x: 76, y: 26, opacity: 0.8 },
      { kind: 'disc', size: 10, x: 36, y: 66 },
      { kind: 'disc', size: 10, x: 50, y: 72 },
      { kind: 'disc', size: 10, x: 64, y: 66 },
    ],
  },
  // 世界：环形花冠 + 四角星 + 中心
  'MAJOR-21': {
    shapes: [
      { kind: 'ring', size: 62, width: 4 },
      { kind: 'ring', size: 46, width: 1.5, opacity: 0.5 },
      cornerStars(8),
      { kind: 'disc', size: 12, color: MOON, opacity: 0.9 },
    ],
  },
};

/** 小阿卡纳的花色图元（权杖=柱、圣杯=杯、宝剑=刃、星币=环+星） */
const SUIT_SHAPES: Readonly<Record<string, (rank: number) => EmblemShape[]>> = {
  // 权杖：一根竖杖 + 上下两颗芽点
  WANDS: (rank) => [
    { kind: 'bar', length: 54, width: 5, y: 48 },
    { kind: 'disc', size: 9, y: 22 },
    { kind: 'disc', size: 7, y: 74, opacity: 0.8 },
    { kind: 'arc', size: 44, rotate: 200, y: 46, opacity: 0.35 + rank * 0.03 },
  ],
  // 圣杯：杯身弧 + 杯脚
  CUPS: (rank) => [
    { kind: 'arc', size: 50, rotate: 180, y: 42, opacity: 0.9 },
    { kind: 'bar', length: 22, width: 3, x: 50, y: 62, angle: 90, opacity: 0.8 },
    { kind: 'bar', length: 26, width: 3, y: 72, opacity: 0.7 },
    ...(rank >= 4 ? [{ kind: 'disc' as const, size: 8, x: 50, y: 74, color: MOON }] : []),
  ],
  // 宝剑：刃（竖线）+ 护手（横线）+ 剑尖（小三角）
  SWORDS: (rank) => [
    { kind: 'bar', length: 56, width: 4, angle: 90, y: 46 },
    { kind: 'bar', length: 26, width: 3, y: 62 },
    { kind: 'triangle', width: 14, height: 14, y: 20, opacity: 0.9 },
    ...(rank >= 8 ? [{ kind: 'ring' as const, size: 20, y: 46, width: 1.5, opacity: 0.45 }] : []),
  ],
  // 星币：外环 + 中心五芒（用两个交错三角近似）
  PENTACLES: (rank) => [
    { kind: 'ring', size: 52, width: 4 },
    { kind: 'triangle', width: 28, height: 22, y: 46, opacity: 0.85 },
    { kind: 'triangle', width: 28, height: 22, rotate: 180, y: 54, opacity: 0.85 },
    ...(rank >= 8 ? [{ kind: 'ring' as const, size: 66, width: 1.5, opacity: 0.4 }] : []),
  ],
};

/** 位阶的星点数量（Ace=1 … 10=10；宫廷牌用 3 个实心盘代替点数） */
const RANK_DOTS: Readonly<Record<string, number>> = {
  ACE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
  NINE: 9,
  TEN: 10,
  PAGE: 0,
  KNIGHT: 0,
  QUEEN: 0,
  KING: 0,
};

/** 宫廷牌：用三个实心盘表示"人物"，并加一个冠形三角 */
const COURT_SHAPES: EmblemShape[] = [
  { kind: 'triangle', width: 26, height: 16, y: 30, opacity: 0.85 },
  { kind: 'disc', size: 9, x: 40, y: 56, opacity: 0.85 },
  { kind: 'disc', size: 9, x: 50, y: 60, opacity: 0.85 },
  { kind: 'disc', size: 9, x: 60, y: 56, opacity: 0.85 },
];

/**
 * 取一张牌的构图
 *
 * 大阿卡纳取专属构图；小阿卡纳 = 花色图元 + 位阶点数（按环形排布），
 * 这样 56 张小牌既统一又能区分（"权杖三"与"权杖七"点数不同）。
 */
export const artOf = (card: { id: string; arcana: string; suit?: string | null; rank?: string | null }): CardArt => {
  const major = MAJOR_ART[card.id];
  if (major !== undefined) return major;

  const suit = card.suit ?? 'WANDS';
  const rankKey = card.rank ?? 'ACE';
  const rank = Math.max(1, RANK_DOTS[rankKey] ?? 1);
  const isCourt = (RANK_DOTS[rankKey] ?? 0) === 0;

  const suitShapes = (SUIT_SHAPES[suit] ?? SUIT_SHAPES['WANDS']!)(rank);

  if (isCourt) {
    return { shapes: [...suitShapes.map((shape) => ({ ...shape, opacity: 0.5 })), ...COURT_SHAPES] };
  }

  // Ace–10：在花色图元下方按环形摆点数（最多 10 个，分两圈）
  const dots: { x: number; y: number; size: number; opacity?: number }[] = [];
  const count = rank;

  for (let index = 0; index < count; index += 1) {
    const isInner = count > 5 && index >= 5;
    const ringIndex = isInner ? index - 5 : index;
    const ringTotal = isInner ? count - 5 : Math.min(count, 5);
    const radius = isInner ? 16 : 30;
    const angle = (Math.PI * 2 * ringIndex) / Math.max(1, ringTotal) - Math.PI / 2;

    dots.push({
      x: 50 + Math.cos(angle) * radius,
      y: 78 + Math.sin(angle) * radius * 0.55,
      size: isInner ? 5 : 6,
      opacity: 0.85,
    });
  }

  return { shapes: [...suitShapes, { kind: 'stars', items: dots }] };
};
