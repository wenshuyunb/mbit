/**
 * 塔罗插画资源清单（**唯一接入点**）
 *
 * ## 这是"真图"与"占位图元"之间唯一的开关
 *
 * 美术规范见 `docs/TAROT_ART_SPEC.md`。插画做好后**只需要在这里填一行地址**，
 * 对应牌立刻从图元占位切换到真实插画 —— 页面组件、抽卡流程、结果页都无需改动。
 *
 * ```ts
 * 'MAJOR-00': `${CDN}/major/00_fool.webp`,
 * ```
 *
 * ## 三条设计约束
 *
 *   ① **未填的牌必须有占位**：不能白屏。占位用 `card-art.util.ts` 的图元组合，
 *      尺寸与真图完全一致，因此切图时**没有布局跳动**；
 *   ② **按需请求尺寸**：`?w=` 参数让 CDN 返回合适的图（列表 360 / 大图 720），
 *      78 张全尺寸图在弱网下是灾难；
 *   ③ **空字符串等同未接入**：不要写 `'TBD'` 之类的占位字符串，
 *      那会让组件把一个必然 404 的地址写进 `image`，反而拖慢首屏。
 */

/**
 * 插画 CDN 基址
 *
 * ⚠ 必须是**已在小程序后台配置的 request/downloadFile 合法域名**（https）。
 * 留空时组件直接使用图元占位，不发起任何网络请求 —— 这也是当前仓库的状态：
 * **尚无任何正式插画**。
 */
export const TAROT_ART_CDN = '';

/** 卡牌编码 → CDN 相对路径（与后端 `card.id` 一一对应） */
export const TAROT_ART_MANIFEST: Readonly<Record<string, string>> = {
  // ------------------------------------------------ 大阿卡纳（22 张）
  // 命名规范：major/{序号两位}_{英文名小写下划线}.webp
  // 'MAJOR-00': 'major/00_fool.webp',
  // 'MAJOR-01': 'major/01_magician.webp',
  // 'MAJOR-02': 'major/02_high_priestess.webp',
  // ... 待插画交付后逐条填
  // ------------------------------------------------ 小阿卡纳（56 张）
  // 命名规范：minor/{花色小写}_{位阶两位}.webp
  // 'CUPS-SEVEN': 'minor/cups_07.webp',
};

/** 牌背（未填时使用组件内置的对称纹样） */
export const TAROT_BACK_PATH = '';

/**
 * 取一张牌的插画地址
 *
 * @param cardId 后端编码，如 `MAJOR-00` / `CUPS-SEVEN`
 * @param width  期望宽度（像素），用于让 CDN 返回合适尺寸
 * @returns 完整 URL；未接入时返回 `null`（调用方据此走图元占位）
 */
export const artUrlOf = (cardId: string, width = 720): string | null => {
  const path = TAROT_ART_MANIFEST[cardId];
  if (path === undefined || path.length === 0 || TAROT_ART_CDN.length === 0) return null;

  return `${TAROT_ART_CDN.replace(/\/$/, '')}/${path}?w=${width}&fm=webp`;
};

/** 牌背地址（未接入时返回 null） */
export const backUrlOf = (width = 720): string | null => {
  if (TAROT_BACK_PATH.length === 0 || TAROT_ART_CDN.length === 0) return null;

  return `${TAROT_ART_CDN.replace(/\/$/, '')}/${TAROT_BACK_PATH}?w=${width}&fm=webp`;
};

/** 当前是否已接入任何真图（供调试与灰度使用） */
export const hasRealArt = (): boolean => TAROT_ART_CDN.length > 0 && Object.keys(TAROT_ART_MANIFEST).length > 0;
