/**
 * 塔罗插画资源清单（**唯一接入点**）
 *
 * ## 三种来源的优先级：CDN > 本地静态 > 图元占位
 *
 *   ① **CDN**（正式环境）：填 `TAROT_ART_CDN` 与 `TAROT_ART_MANIFEST`，
 *      78 张图不进主包，按尺寸请求（?w=360 / 720）；
 *   ② **本地静态**（开发期最省事）：把图包粘进 `src/static/tarot/`，
 *      跑一次 `node scripts/scan-tarot-art.mjs`，脚本生成
 *      `art-manifest.generated.ts`，组件立刻用上真图 —— **不用改名、不用改代码**；
 *   ③ **图元占位**：前两者都没有时使用 `card-art.util.ts` 的组合，
 *      尺寸与真图完全一致，因此切图**没有布局跳动**。
 *
 * ## 为什么"未接入"必须返回 null
 *
 * 组件把返回值写进 `<image src>`。若这里返回一个必然 404 的地址，
 * 每张牌都会白发一次请求并触发 error → 回落图元，反而拖慢首屏。
 * 返回 null 时组件**不发任何请求**，直接渲染图元。
 */

import { GENERATED_ART, GENERATED_ART_COUNT, GENERATED_BACK } from './art-manifest.generated';

/** 插画 CDN 基址（必须是已在小程序后台配置的 https 合法域名；留空=使用本地静态） */
export const TAROT_ART_CDN = '';

/** 卡牌编码 → CDN 相对路径（与后端 `card.id` 一一对应） */
export const TAROT_ART_MANIFEST: Readonly<Record<string, string>> = {
  // 例：'MAJOR-00': 'major/00_fool.webp',
};

/** 牌背的 CDN 相对路径（留空=使用本地或内置纹样） */
export const TAROT_BACK_PATH = '';

/**
 * 取一张牌的插画地址
 *
 * @param cardId 后端编码，如 `MAJOR-00` / `CUPS-SEVEN`
 * @param width  期望宽度（像素），仅 CDN 场景生效
 * @returns 可用地址；三种来源都没有时返回 `null`（调用方走图元占位）
 */
export const artUrlOf = (cardId: string, width = 720): string | null => {
  // ① CDN（正式环境）
  if (TAROT_ART_CDN.length > 0) {
    const path = TAROT_ART_MANIFEST[cardId];

    if (path !== undefined && path.length > 0) {
      return `${TAROT_ART_CDN.replace(/\/$/, '')}/${path}?w=${width}&fm=webp`;
    }
  }

  // ② 本地静态（把图包粘进 src/static/tarot/ 后由扫描脚本生成）
  const local = GENERATED_ART[cardId];

  return local !== undefined && local.length > 0 ? local : null;
};

/** 牌背地址（都没有时返回 null，组件使用内置对称纹样） */
export const backUrlOf = (width = 720): string | null => {
  if (TAROT_ART_CDN.length > 0 && TAROT_BACK_PATH.length > 0) {
    return `${TAROT_ART_CDN.replace(/\/$/, '')}/${TAROT_BACK_PATH}?w=${width}&fm=webp`;
  }

  return GENERATED_BACK.length > 0 ? GENERATED_BACK : null;
};

/** 当前是否已接入真图（供调试与灰度；图元占位时为 false） */
export const hasRealArt = (): boolean => GENERATED_ART_COUNT > 0 || TAROT_ART_MANIFEST['MAJOR-00'] !== undefined;
