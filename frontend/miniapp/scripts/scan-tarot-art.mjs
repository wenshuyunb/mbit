/**
 * 扫描 `src/static/tarot/` 下的插画，生成卡牌资源清单
 *
 * ## 为什么需要这个脚本
 *
 * 小程序**不能在运行时枚举目录**（没有 `fs`，也没有 `readdir`），
 * 因此"把图片粘进去就能用"必须有一步**构建期扫描**：把文件名映射成卡牌编码，
 * 生成一个静态的 `art-manifest.generated.ts`，组件按编码取地址。
 *
 * ## 识别策略（宽松优先）
 *
 * 图片包通常不是按我们的编码命名的，所以这里按**优先级**依次尝试，
 * 任意一条命中即可，尽量做到"不用改名"：
 *
 *   1. 卡背关键字 → 牌背
 *   2. 小阿卡纳：花色 + 位阶（中英文均可）
 *   3. 大阿卡纳：中文名 / 英文名 / 罗马数字 / 序号 0–21
 *
 * 认不出来的文件会**单独列出来**，方便改名重跑（绝不静默丢弃）。
 *
 * 用法：`node scripts/scan-tarot-art.mjs`
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ART_DIR = join(ROOT, 'src', 'static', 'tarot');
const TARGET = join(ROOT, 'src', 'components', 'tarot', 'art-manifest.generated.ts');

/** 支持的图片格式 */
const EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.avif']);

/** 大阿卡纳：中文名 / 英文名（多种写法）/ 序号 */
const MAJOR_CARDS = [
  { index: 0, roman: '0', zh: '愚者', en: ['fool'] },
  { index: 1, roman: 'I', zh: '魔术师', en: ['magician', 'magus'] },
  { index: 2, roman: 'II', zh: '女祭司', en: ['highpriestess', 'priestess', 'papess'] },
  { index: 3, roman: 'III', zh: '女皇', en: ['empress'] },
  { index: 4, roman: 'IV', zh: '皇帝', en: ['emperor'] },
  { index: 5, roman: 'V', zh: '教皇', en: ['hierophant', 'pope'] },
  { index: 6, roman: 'VI', zh: '恋人', en: ['lovers', 'lover'] },
  { index: 7, roman: 'VII', zh: '战车', en: ['chariot'] },
  { index: 8, roman: 'VIII', zh: '力量', en: ['strength', 'fortitude', 'force'] },
  { index: 9, roman: 'IX', zh: '隐者', en: ['hermit'] },
  { index: 10, roman: 'X', zh: '命运之轮', en: ['wheeloffortune', 'wheel', 'fortune'] },
  { index: 11, roman: 'XI', zh: '正义', en: ['justice'] },
  { index: 12, roman: 'XII', zh: '倒吊人', en: ['hangedman', 'hanged'] },
  { index: 13, roman: 'XIII', zh: '死神', en: ['death'] },
  { index: 14, roman: 'XIV', zh: '节制', en: ['temperance'] },
  { index: 15, roman: 'XV', zh: '恶魔', en: ['devil'] },
  { index: 16, roman: 'XVI', zh: '塔', en: ['tower'] },
  { index: 17, roman: 'XVII', zh: '星星', en: ['star', 'stars'] },
  { index: 18, roman: 'XVIII', zh: '月亮', en: ['moon'] },
  { index: 19, roman: 'XIX', zh: '太阳', en: ['sun'] },
  { index: 20, roman: 'XX', zh: '审判', en: ['judgement', 'judgment'] },
  { index: 21, roman: 'XXI', zh: '世界', en: ['world'] },
];

/** 小阿卡纳：花色 */
const SUITS = [
  { code: 'WANDS', en: ['wands', 'wand'], zh: '权杖' },
  { code: 'CUPS', en: ['cups', 'cup'], zh: '圣杯' },
  { code: 'SWORDS', en: ['swords', 'sword'], zh: '宝剑' },
  { code: 'PENTACLES', en: ['pentacles', 'pentacle', 'coins', 'coin'], zh: '星币' },
];

/** 小阿卡纳：位阶 */
const RANKS = [
  { code: 'ACE', en: ['ace'], zh: '一', num: 1 },
  { code: 'TWO', en: ['two'], zh: '二', num: 2 },
  { code: 'THREE', en: ['three'], zh: '三', num: 3 },
  { code: 'FOUR', en: ['four'], zh: '四', num: 4 },
  { code: 'FIVE', en: ['five'], zh: '五', num: 5 },
  { code: 'SIX', en: ['six'], zh: '六', num: 6 },
  { code: 'SEVEN', en: ['seven'], zh: '七', num: 7 },
  { code: 'EIGHT', en: ['eight'], zh: '八', num: 8 },
  { code: 'NINE', en: ['nine'], zh: '九', num: 9 },
  { code: 'TEN', en: ['ten'], zh: '十', num: 10 },
  { code: 'PAGE', en: ['page'], zh: '侍从', num: null },
  { code: 'KNIGHT', en: ['knight'], zh: '骑士', num: null },
  { code: 'QUEEN', en: ['queen'], zh: '王后', num: null },
  { code: 'KING', en: ['king'], zh: '国王', num: null },
];

/** 递归收集图片文件 */
const collect = (dir) => {
  if (!existsSync(dir)) return [];

  const out = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);

    if (stat.isDirectory()) {
      out.push(...collect(full));
      continue;
    }

    if (EXTS.has(extname(entry).toLowerCase())) out.push({ full, size: stat.size });
  }

  return out;
};

/** 归一化文件名：小写、去扩展名、去分隔符，只留字母数字与中文 */
const normalize = (file) =>
  file
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[\s_\-.]/g, '');

/** 从归一化文件名里识别卡背 */
const matchBack = (key) => /back|backside|背面|牌背/.test(key);

/** 识别大阿卡纳 */
const matchMajor = (key, rawKey) => {
  // ① 中文名（含在文件名里即可，如「01愚者」「愚者-大阿卡纳」）
  for (const card of MAJOR_CARDS) {
    if (key.includes(card.zh)) return card.index;
  }

  // ② 英文名
  for (const card of MAJOR_CARDS) {
    for (const alias of card.en) {
      if (key.includes(alias)) return card.index;
    }
  }

  // ③ 罗马数字（要求前后有分隔，避免把 "iv" 误判进 "five"）
  const parts = rawKey.split(/[\s_\-.]+/).filter(Boolean);
  for (const part of parts) {
    const card = MAJOR_CARDS.find((item) => item.roman.toLowerCase() === part.toLowerCase());
    if (card !== undefined) return card.index;
  }

  // ④ 纯序号 0–21（要求是独立的数字段）
  for (const part of parts) {
    if (!/^\d{1,2}$/.test(part)) continue;

    const value = Number(part);
    if (value >= 0 && value <= 21) return value;
  }

  return null;
};

/** 识别小阿卡纳 */
const matchMinor = (key, rawKey) => {
  const suit = SUITS.find((item) => key.includes(item.zh) || item.en.some((alias) => key.includes(alias)));
  if (suit === undefined) return null;

  const rank = RANKS.find((item) => key.includes(item.zh) || item.en.some((alias) => key.includes(alias)));
  if (rank !== undefined) return `${suit.code}-${rank.code}`;

  // 花色 + 阿拉伯数字（如 cups07 / cups_7）
  const parts = rawKey.split(/[\s_\-.]+/).filter(Boolean);
  for (const part of parts) {
    if (!/^\d{1,2}$/.test(part)) continue;

    const value = Number(part);
    const byNum = RANKS.find((item) => item.num === value);
    if (byNum !== undefined) return `${suit.code}-${byNum.code}`;
  }

  return null;
};

const main = () => {
  const files = collect(ART_DIR);

  if (files.length === 0) {
    writeFileSync(
      TARGET,
      `/**
 * 卡牌资源清单（**自动生成，勿手改**）
 *
 * 生成命令：\`node scripts/scan-tarot-art.mjs\`
 * 当前状态：\`src/static/tarot/\` 为空 —— 组件会使用图元占位。
 */
export const GENERATED_ART: Readonly<Record<string, string>> = {};

/** 卡背（本地） */
export const GENERATED_BACK = '';

/** 本次扫描到的图片数量 */
export const GENERATED_ART_COUNT = 0;
`,
      'utf8',
    );

    console.log(`\n${ART_DIR} 里还没有图片。`);
    console.log('把图包粘进去后重新运行本脚本即可。\n');

    return;
  }

  /** 卡牌编码 → 相对 `src/` 的静态路径 */
  const manifest = {};
  let back = '';
  const unmatched = [];
  const duplicates = [];
  let totalBytes = 0;

  for (const file of files) {
    const relPath = relative(join(ROOT, 'src'), file.full).split('\\').join('/');
    const publicPath = `/${relPath}`;
    const rawKey = file.full.split(/[\\/]/).pop() ?? '';
    const key = normalize(rawKey);

    if (matchBack(key)) {
      if (back === '') {
        back = publicPath;
        totalBytes += file.size;
      } else {
        duplicates.push(`${relPath}（卡背已由 ${back} 占用）`);
      }
      continue;
    }

    const cardId =
      matchMinor(key, key) ??
      (matchMajor(key, rawKey) !== null ? `MAJOR-${String(matchMajor(key, rawKey)).padStart(2, '0')}` : null);

    if (cardId === null) {
      unmatched.push(relPath);
      continue;
    }

    if (manifest[cardId] !== undefined) {
      duplicates.push(`${relPath}（${cardId} 已由 ${manifest[cardId]} 占用）`);
      continue;
    }

    manifest[cardId] = publicPath;
    totalBytes += file.size;
  }

  const entries = Object.keys(manifest)
    .sort()
    .map((cardId) => `  '${cardId}': '${manifest[cardId]}',`)
    .join('\n');

  writeFileSync(
    TARGET,
    `/**
 * 卡牌资源清单（**自动生成，勿手改**）
 *
 * 生成命令：\`node scripts/scan-tarot-art.mjs\`
 * 图片来源：\`src/static/tarot/\`（把图包粘到那里后重新运行）
 *
 * ⚠ 这些是**本地静态资源**，会打进小程序包。78 张图不要长期留在包里 ——
 *   正式环境请按 \`docs/TAROT_ART_SPEC.md\` §10 切到 CDN（改 \`TAROT_ART_CDN\` 即可）。
 */
export const GENERATED_ART: Readonly<Record<string, string>> = {
${entries}
};

/** 卡背（本地） */
export const GENERATED_BACK = ${back === '' ? "''" : `'${back}'`};

/** 本次扫描到的图片数量 */
export const GENERATED_ART_COUNT = ${Object.keys(manifest).length + (back === '' ? 0 : 1)};
`,
    'utf8',
  );

  // ---------------------------------------------------------------- 报告
  const ALL_IDS = [
    ...MAJOR_CARDS.map((card) => `MAJOR-${String(card.index).padStart(2, '0')}`),
    ...SUITS.flatMap((suit) => RANKS.map((rank) => `${suit.code}-${rank.code}`)),
  ];
  const missing = ALL_IDS.filter((id) => manifest[id] === undefined);
  const totalMb = (totalBytes / 1024 / 1024).toFixed(2);

  console.log(`\n已生成 ${relative(ROOT, TARGET)}`);
  console.log(`  识别成功：${Object.keys(manifest).length} / 78 张${back === '' ? '，卡背缺失' : '，卡背已就位'}`);
  console.log(`  总体积：${totalMb} MB`);

  if (missing.length > 0) {
    console.log(`\n  还缺 ${missing.length} 张：`);
    console.log(`    ${missing.join('、')}`);
  }

  if (unmatched.length > 0) {
    console.log(`\n  无法识别（请改名后重跑）：`);
    for (const file of unmatched) console.log(`    ${file}`);
  }

  if (duplicates.length > 0) {
    console.log(`\n  重复（已跳过后出现的）：`);
    for (const file of duplicates) console.log(`    ${file}`);
  }

  if (totalBytes > 2 * 1024 * 1024) {
    console.log(`\n  ⚠ 超过 2 MB：小程序主包有体积限制，正式环境请切 CDN（见 TAROT_ART_CDN）。`);
  }

  console.log('');

  // 校验：生成的文件必须能被 prettier 接受（避免格式门禁失败）
  const generated = readFileSync(TARGET, 'utf8');
  if (generated.includes('\t')) console.log('  ⚠ 生成内容含 Tab，请检查命名');
};

main();
