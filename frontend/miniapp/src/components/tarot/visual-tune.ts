/**
 * 卡牌视觉参数（**唯一调参入口**）
 *
 * ## 为什么单独抽一个文件
 *
 * 插画还没到位时，所有效果都是"给图元占位调"的；真图进来后必须按**实际画面**
 * 重新配平：暗角多重、金框多细、牌名衬底多深。这些值散落在组件样式里就没法快速试。
 *
 * 因此把它们集中到这里：**改这一个文件即可整体调节观感**，不用翻组件。
 *
 * ## 有真图 / 无真图 两套配平
 *
 * 有插画时，装饰必须**退让**：金框变细、内框去掉、暗角加深（把画"按"进深色底），
 * 牌名加一层由透明到深的衬底（否则压在浅色画面上会看不清）。
 * 没有插画时才需要那些图元与更强的框线去撑住视觉。
 */

/** 有真图时的配平 */
export const ART_PRESENT = {
  /** 外框金线透明度（真图时更细，避免压住画面） */
  frameAlpha: 0.34,
  /** 是否显示内层细框（真图时关闭，内框会切掉画面边缘） */
  showInnerFrame: false,
  /** 暗角强度：把插画四边压进夜色，减少"贴图感" */
  vignetteAlpha: 0.55,
  /** 牌名衬底（自上而下渐深，保证文字在任何画面上都可读） */
  nameScrimAlpha: 0.82,
  /** 揭示时的起始缩放（大于 1 → 向内收，像对上焦） */
  revealScaleFrom: 1.045,
} as const;

/** 无真图（图元占位）时的配平 */
export const ART_ABSENT = {
  frameAlpha: 0.42,
  showInnerFrame: true,
  vignetteAlpha: 0.18,
  nameScrimAlpha: 0.2,
  revealScaleFrom: 1,
} as const;

/** 揭示光晕（翻开瞬间从牌心扩散一次） */
export const REVEAL_GLOW = {
  /** 峰值透明度 */
  peakAlpha: 0.5,
  /** 扩散动画时长（ms），与 $arcana-dur-reveal 对齐 */
  durationMs: 560,
} as const;
