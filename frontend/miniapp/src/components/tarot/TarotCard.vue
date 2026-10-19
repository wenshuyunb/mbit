<script setup lang="ts">
/**
 * 塔罗牌（正反面 + 翻牌动效 + 图元艺术）
 *
 * ## 翻牌为什么用"两段式"而不是 `backface-visibility`
 *
 * 标准 CSS 翻牌依赖 `backface-visibility: hidden`。这个属性在部分安卓机型的
 * XWeb 内核与旧基础库上**不生效**，一旦不生效就会两张面同时可见 —— 牌面糊成一团，
 * 比没有动画更糟。
 *
 * 因此这里用**分段旋转**：0° → 90°（正面朝侧，此时换面）→ 180°。
 * 到 90° 时牌面几乎不可见，物理上也正是"薄薄一张纸立起来"的那一刻，
 * 视觉上完全成立，而且**不依赖任何冷门 CSS 属性**。
 *
 * ## 图元艺术
 *
 * 牌面不用 emoji、也不用图片：用 `card-art.util.ts` 里的图元组合（圆环、月牙、
 * 射线、柱、星点、三角）逐张拼出可辨认的古典意象。所有尺寸按 `sizeRpx` 换算，
 * 因此同一套构图在缩略图与全屏大牌上表现一致。
 */

import { computed, ref, watch } from 'vue';

import { artOf, type EmblemShape } from './card-art.util';
import { artUrlOf, backUrlOf } from './art-manifest';
import { ART_ABSENT, ART_PRESENT } from './visual-tune';

const props = withDefaults(
  defineProps<{
    /** 牌数据（来自接口） */
    card: {
      id: string;
      name: string;
      arcana: 'MAJOR' | 'MINOR';
      numeral: string | null;
      suit: 'WANDS' | 'CUPS' | 'SWORDS' | 'PENTACLES' | null;
      rank: string | null;
    };
    /** 朝向 */
    orientation?: 'UPRIGHT' | 'REVERSED';
    /** 牌宽（rpx）：高度按 1:1.64 自动换算 */
    sizeRpx?: number;
    /** 是否已翻开 */
    flipped?: boolean;
    /** 是否显示牌名（缩略图里可以不显示） */
    showName?: boolean;
  }>(),
  { orientation: 'UPRIGHT', sizeRpx: 300, flipped: false, showName: true },
);

/** 牌面比例：塔罗牌约 1 : 1.64 */
const CARD_RATIO = 1.64;

/**
 * 真实插画的两级状态
 *
 * `artFailed` 一旦置位就**本会话内不再重试**：弱网下反复请求只会让牌面一直空白，
 * 不如稳定地退回图元占位（尺寸完全一致，不会有布局跳动）。
 */
const artLoaded = ref(false);
const artFailed = ref(false);

/** 插画地址：未接入美术资源时为 null（组件走图元占位） */
const imageUrl = computed<string | null>(() => {
  if (artFailed.value) return null;

  // 缩略图请求小尺寸，大牌请求大尺寸（78 张全尺寸图在弱网下是灾难）
  return artUrlOf(props.card.id, props.sizeRpx >= 260 ? 720 : 360);
});

const backImageUrl = computed<string | null>(() => {
  if (artFailed.value) return null;

  return backUrlOf(props.sizeRpx >= 260 ? 720 : 360);
});

/** 当前这张牌是否有真图（决定装饰退让程度） */
const hasArt = computed<boolean>(() => imageUrl.value !== null);
const tune = computed(() => (hasArt.value ? ART_PRESENT : ART_ABSENT));

/** 外框透明度与牌名衬底，随有无真图切换 */
const faceStyle = computed<Record<string, string>>(() => ({
  borderColor: `rgba(201, 171, 115, ${tune.value.frameAlpha})`,
}));

const scrimStyle = computed<Record<string, string>>(() => ({
  background: `linear-gradient(180deg, rgba(9, 12, 20, 0) 0%, rgba(9, 12, 20, ${tune.value.nameScrimAlpha}) 100%)`,
}));

const onArtLoad = (): void => {
  artLoaded.value = true;
};

const onArtError = (): void => {
  artFailed.value = true;
  artLoaded.value = false;
};

const width = computed(() => props.sizeRpx);
const height = computed(() => Math.round(props.sizeRpx * CARD_RATIO));
const emblemSize = computed(() => Math.round(props.sizeRpx * 0.86));

const isReversed = computed(() => props.orientation === 'REVERSED');

/**
 * 翻牌状态机：`back` → `side`（90°，此时换面）→ `front`
 *
 * 组件自己驱动这半段，父组件只管 `flipped` 变 true。
 * 时长与主题令牌一致（$arcana-dur-flip = 820ms，这里取一半各 410ms）。
 */
const phase = ref<'back' | 'side' | 'front'>(props.flipped ? 'front' : 'back');

watch(
  () => props.flipped,
  (flipped) => {
    if (!flipped) {
      phase.value = 'back';

      return;
    }

    // 90° 之前仍是牌背，过了 90° 才换成正面
    phase.value = 'side';
    setTimeout(() => {
      phase.value = 'front';
    }, 410);
  },
  { immediate: true },
);

/** 旋转角度：背 0° / 侧 90° / 正 180° */
const flipDeg = computed<number>(() => (phase.value === 'back' ? 0 : phase.value === 'side' ? 90 : 180));

/** 牌面底色的遮罩色（画月牙时用来"挖掉"一半圆） */
const faceBg = computed(() => (props.card.arcana === 'MAJOR' ? '#182038' : '#1b2734'));

const art = computed(() => artOf(props.card));

/** 把一个图元换算成内联样式 */
const styleOf = (shape: EmblemShape, index: number): Record<string, string> => {
  const box = emblemSize.value;
  const pct = (value: number): string => `${Math.round((box * value) / 100)}rpx`;
  const at = (owner: { x?: number; y?: number }): Record<string, string> => ({
    left: pct(owner.x ?? 50),
    top: pct(owner.y ?? 50),
  });

  switch (shape.kind) {
    case 'ring': {
      const size = pct(shape.size);

      return {
        ...at(shape),
        width: size,
        height: size,
        marginLeft: `-${pct(shape.size / 2)}`,
        marginTop: `-${pct(shape.size / 2)}`,
        border: `${Math.max(1, Math.round((shape.width ?? 3) * (props.sizeRpx / 300) * 2))}rpx solid ${shape.color ?? '#c9ab73'}`,
        borderRadius: '50%',
        opacity: String(shape.opacity ?? 0.9),
      };
    }

    case 'disc': {
      const size = pct(shape.size);

      return {
        ...at(shape),
        width: size,
        height: size,
        marginLeft: `-${pct(shape.size / 2)}`,
        marginTop: `-${pct(shape.size / 2)}`,
        backgroundColor: shape.color ?? '#c9ab73',
        borderRadius: '50%',
        opacity: String(shape.opacity ?? 0.95),
      };
    }

    case 'crescent': {
      // 月牙 = 大圆 减去 一个偏移的同心圆（用牌底色遮住），不依赖 mask
      const size = pct(shape.size);

      return {
        ...at(shape),
        width: size,
        height: size,
        marginLeft: `-${pct(shape.size / 2)}`,
        marginTop: `-${pct(shape.size / 2)}`,
        backgroundColor: '#f2ebdd',
        borderRadius: '50%',
        opacity: String(shape.opacity ?? 0.92),
      };
    }

    case 'rays': {
      // N 根射线：用一条竖线绕中心旋转，射线朝外
      const angle = (360 / shape.count) * index;

      return {
        left: '50%',
        top: '50%',
        width: `${Math.max(1, Math.round((shape.width ?? 2) * (props.sizeRpx / 300) * 2))}rpx`,
        height: pct(shape.length),
        marginLeft: `-${Math.round(((shape.width ?? 2) * (props.sizeRpx / 300)) / 1)}rpx`,
        marginTop: `-${pct(shape.length / 2)}`,
        backgroundColor: shape.color ?? '#c9ab73',
        opacity: String(shape.opacity ?? 0.6),
        transform: `rotate(${angle}deg)`,
        transformOrigin: 'center center',
      };
    }

    case 'bar': {
      return {
        ...at(shape),
        width: `${Math.max(1, Math.round((shape.width ?? 3) * (props.sizeRpx / 300) * 2))}rpx`,
        height: pct(shape.length),
        marginLeft: `-${Math.round((shape.width ?? 3) * (props.sizeRpx / 300))}rpx`,
        marginTop: `-${pct(shape.length / 2)}`,
        backgroundColor: shape.color ?? '#c9ab73',
        opacity: String(shape.opacity ?? 0.85),
        transform: `rotate(${shape.angle ?? 0}deg)`,
        borderRadius: '2rpx',
      };
    }

    case 'triangle': {
      // 用边框三角（所有基础库都支持），尺寸按 rpx 精确换算
      const half = Math.round((box * shape.width) / 100 / 2);
      const tall = Math.round((box * shape.height) / 100);
      const color = shape.color ?? '#c9ab73';

      return {
        ...at(shape),
        width: '0',
        height: '0',
        marginLeft: `-${half}rpx`,
        marginTop: `-${Math.round(tall / 2)}rpx`,
        borderLeft: `${half}rpx solid transparent`,
        borderRight: `${half}rpx solid transparent`,
        borderBottom: `${tall}rpx solid ${color}`,
        opacity: String(shape.opacity ?? 0.85),
        transform: `rotate(${shape.rotate ?? 0}deg)`,
      };
    }

    case 'arc': {
      // 半环：只留上半边框
      const size = pct(shape.size);

      return {
        ...at(shape),
        width: size,
        height: size,
        marginLeft: `-${pct(shape.size / 2)}`,
        marginTop: `-${pct(shape.size / 2)}`,
        border: `${Math.max(2, Math.round((props.sizeRpx / 300) * 3))}rpx solid transparent`,
        borderTopColor: shape.color ?? '#c9ab73',
        borderRadius: '50%',
        opacity: String(shape.opacity ?? 0.7),
        transform: `rotate(${shape.rotate ?? 0}deg)`,
      };
    }

    default:
      return {};
  }
};

/** 星点单独处理（一个图元里含多个点） */
const starDots = computed(() =>
  art.value.shapes
    .filter((shape): shape is Extract<EmblemShape, { kind: 'stars' }> => shape.kind === 'stars')
    .flatMap((shape, groupIndex) =>
      shape.items.map((item, dotIndex) => {
        const box = emblemSize.value;
        const size = Math.max(3, Math.round((box * item.size) / 100));

        return {
          key: `${groupIndex}-${dotIndex}`,
          style: {
            left: `${Math.round((box * item.x) / 100)}rpx`,
            top: `${Math.round((box * item.y) / 100)}rpx`,
            width: `${size}rpx`,
            height: `${size}rpx`,
            marginLeft: `-${Math.round(size / 2)}rpx`,
            marginTop: `-${Math.round(size / 2)}rpx`,
            opacity: String(item.opacity ?? 0.9),
          } as Record<string, string>,
        };
      }),
    ),
);

/** 非星点图元（星点统一在上面渲染） */
const shapeViews = computed(() =>
  art.value.shapes
    .map((shape, index) => ({ shape, index }))
    .filter(({ shape }) => shape.kind !== 'stars')
    .map(({ shape, index }) => ({ key: `shape-${index}`, style: styleOf(shape, index) })),
);

const crescentMaskStyle = computed(() => {
  const crescent = art.value.shapes.find((shape) => shape.kind === 'crescent');
  if (crescent === undefined || crescent.kind !== 'crescent') return null;

  const box = emblemSize.value;
  const size = Math.round((box * crescent.size) / 100);
  const offset = Math.round(size * 0.26);

  return {
    left: `${Math.round((box * (crescent.x ?? 50)) / 100) + offset}rpx`,
    top: `${Math.round((box * (crescent.y ?? 50)) / 100)}rpx`,
    width: `${size}rpx`,
    height: `${size}rpx`,
    marginLeft: `-${Math.round(size / 2)}rpx`,
    marginTop: `-${Math.round(size / 2)}rpx`,
    backgroundColor: faceBg.value,
  } as Record<string, string>;
});
</script>

<template>
  <view
    class="tcard"
    :class="{ 'tcard--reversed': isReversed && phase === 'front' }"
    :style="{ width: `${width}rpx`, height: `${height}rpx` }"
  >
    <view class="tcard__flipper" :style="{ transform: `rotateY(${flipDeg}deg)` }">
      <!-- 牌背 -->
      <view v-if="phase !== 'front'" class="tcard__back">
        <!-- 真·牌背插画（未接入时走下面的对称纹样） -->
        <image
          v-if="backImageUrl"
          class="tcard__art tcard__art--back"
          :src="backImageUrl"
          mode="aspectFill"
          :style="{ opacity: artLoaded ? 1 : 0 }"
          @load="onArtLoad"
          @error="onArtError"
        />
        <view class="tcard__back-frame">
          <view class="tcard__back-orb">
            <text class="tcard__back-glyph">✦</text>
          </view>
          <text class="tcard__back-caption">ARCANA</text>
        </view>
      </view>

      <!-- 牌面 -->
      <view v-else class="tcard__face">
        <!-- 真·塔罗插画：填了美术资源就用它，未填/加载失败回退到图元占位 -->
        <image
          v-if="imageUrl"
          class="tcard__art"
          :src="imageUrl"
          mode="aspectFill"
          :style="{ opacity: artLoaded ? 1 : 0 }"
          @load="onArtLoad"
          @error="onArtError"
        />

        <!-- 暗角：把插画四边压进夜色，减少"贴图感"（图元占位时很淡） -->
        <view class="tcard__vignette" :style="{ opacity: String(tune.vignetteAlpha) }" />

        <view
          class="tcard__face-frame"
          :class="tune.showInnerFrame ? '' : 'tcard__face-frame--flush'"
          :style="faceStyle"
        >
          <text class="tcard__numeral">{{ card.numeral ?? '·' }}</text>

          <!-- 图元占位：仅在无真图时渲染（有真图时它是多余的图层，白耗性能） -->
          <view
            v-if="imageUrl === null"
            class="tcard__emblem"
            :style="{ width: `${emblemSize}rpx`, height: `${emblemSize}rpx` }"
          >
            <view v-for="shape in shapeViews" :key="shape.key" class="tcard__shape" :style="shape.style" />
            <view v-if="crescentMaskStyle" class="tcard__shape" :style="crescentMaskStyle" />
            <view v-for="dot in starDots" :key="dot.key" class="tcard__shape tcard__dot" :style="dot.style" />
          </view>
          <view v-else class="tcard__emblem-placeholder" />

          <view class="tcard__foot" :style="hasArt ? scrimStyle : {}">
            <view class="tcard__rule" />
            <text v-if="showName" class="tcard__name">{{ card.name }}</text>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.tcard {
  position: relative;
  perspective: 1200rpx;

  // 真·插画层：铺满整张牌（含边框区域），加载完成后淡入，避免闪烁
  &__art {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    width: 100%;
    height: 100%;
    border-radius: 12rpx;
    transition: opacity 200ms $arcana-ease;
  }

  &__art--back {
    border-radius: 12rpx;
  }

  // 有真图时的占位块：只负责撑开布局，视觉上完全透明
  &__emblem-placeholder {
    width: 86%;
    height: 62%;
  }

  &__flipper {
    width: 100%;
    height: 100%;
    transition: transform $arcana-dur-flip $arcana-ease;
    transform-style: preserve-3d;
  }

  // 逆位：整张牌倒转（真实抽牌结果，不是只改文字标签）
  &--reversed &__flipper {
    transform: rotateY(180deg) rotate(180deg) !important;
  }

  // ---------------------------------------------------------------- 牌背
  &__back {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 5rpx;
    background:
      repeating-linear-gradient(45deg, rgba(201, 171, 115, 0.1) 0 2rpx, transparent 2rpx 16rpx),
      repeating-linear-gradient(-45deg, rgba(201, 171, 115, 0.1) 0 2rpx, transparent 2rpx 16rpx),
      linear-gradient(162deg, #1a2135 0%, #2b2440 52%, #171d2c 100%);
    border: 1rpx solid $arcana-gold-soft;
    border-radius: 12rpx;
    box-shadow:
      inset 0 0 24rpx rgba(8, 10, 20, 0.6),
      0 8rpx 24rpx rgba(5, 7, 14, 0.5);
  }

  &__back-frame {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    border: 1rpx solid $arcana-gold-faint;
    border-radius: 9rpx;
  }

  &__back-orb {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40%;
    height: 0;
    padding-bottom: 40%;
    @include arcana-moonlight(0.12);
    border: 1rpx solid $arcana-gold-soft;
    border-radius: 50%;
  }

  &__back-glyph {
    position: absolute;
    font-size: 22rpx;
    color: $arcana-gold;
    opacity: 0.85;
  }

  &__back-caption {
    margin-top: 6%;
    font-size: 14rpx;
    letter-spacing: 4rpx;
    color: rgba(201, 171, 115, 0.55);
  }

  // ---------------------------------------------------------------- 牌面
  &__face {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 5rpx;
    background: linear-gradient(168deg, #141a2b 0%, #202a3f 46%, #141a2b 100%);
    border: 1rpx solid $arcana-gold-soft;
    border-radius: 12rpx;
    box-shadow:
      inset 0 0 20rpx rgba(6, 8, 16, 0.6),
      0 10rpx 26rpx rgba(5, 7, 14, 0.55);
  }

  &__face-frame {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 3% 2%;
    border: 1rpx solid rgba(201, 171, 115, 0.22);
    border-radius: 9rpx;
  }

  &__numeral {
    font-family: $arcana-font-serif;
    font-size: 20rpx;
    letter-spacing: 3rpx;
    color: rgba(201, 171, 115, 0.85);
  }

  // 暗角：四次径向叠加成本很低，只画一次；不影响文字层（z-index 低于 frame 内容）
  &__vignette {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background: radial-gradient(ellipse at 50% 42%, rgba(9, 12, 20, 0) 42%, rgba(9, 12, 20, 0.85) 100%);
    border-radius: 12rpx;
  }

  // 有真图时内框改为"不占位"：只保留一层极淡的描边，不切画面
  &__face-frame--flush {
    padding: 3% 1.5%;
    border-color: rgba(201, 171, 115, 0.14);
  }

  &__emblem {
    position: relative;
  }

  &__shape {
    position: absolute;
  }

  &__dot {
    background-color: $arcana-moon;
    border-radius: 50%;
    transform: rotate(45deg);
  }

  &__foot {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
  }

  &__rule {
    width: 46%;
    height: 1rpx;
    margin-bottom: 4rpx;
    @include arcana-rule;
  }

  &__name {
    font-family: $arcana-font-serif;
    font-size: 22rpx;
    letter-spacing: 2rpx;
    color: $arcana-moon;
  }
}
</style>
