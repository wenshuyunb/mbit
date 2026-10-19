<script setup lang="ts">
/**
 * 星尘与月光背景
 *
 * ## 克制原则
 *
 * 规格里明确禁止"大量无意义星星、粒子和装饰圆圈"。因此这里：
 *   · 星点**数量固定且很少**（12 颗，两档亮度），位置写死不用随机（避免每次渲染跳动）；
 *   · 只有极缓慢的透明度呼吸（8s 一循环），不做位移、不做闪烁；
 *   · 月光是一层极低透明度的径向渐变，贴在页面顶部，不铺满全屏（铺满会显得脏）。
 *
 * ## 性能
 *
 * 只用 `opacity` 与静态 `background`，不跑 transform 动画、不用 blur/filter ——
 * 常驻动画一旦用 transform 或 filter，低端机上会明显拖慢滚动。
 */

withDefaults(defineProps<{ moonlightTop?: number }>(), { moonlightTop: 0 });

/** 12 颗星：位置/大小/亮度写死，不做随机（避免每帧抖动与布局差异） */
const STARS = [
  { left: 8, top: 6, size: 3, bright: true },
  { left: 22, top: 14, size: 2, bright: false },
  { left: 38, top: 4, size: 2, bright: true },
  { left: 54, top: 11, size: 3, bright: false },
  { left: 66, top: 5, size: 2, bright: true },
  { left: 82, top: 13, size: 2, bright: false },
  { left: 92, top: 7, size: 3, bright: true },
  { left: 14, top: 26, size: 2, bright: false },
  { left: 72, top: 24, size: 2, bright: true },
  { left: 46, top: 20, size: 2, bright: false },
  { left: 88, top: 28, size: 2, bright: false },
  { left: 30, top: 22, size: 3, bright: true },
] as const;
</script>

<template>
  <view class="backdrop">
    <!-- 月光：极低透明度，只在顶部 -->
    <view class="backdrop__moon" :style="{ top: `${moonlightTop}rpx` }" />
    <!-- 星尘 -->
    <view class="backdrop__stars">
      <view
        v-for="(star, index) in STARS"
        :key="index"
        class="backdrop__star"
        :class="star.bright ? 'backdrop__star--bright' : ''"
        :style="{ left: `${star.left}%`, top: `${star.top}%`, width: `${star.size}rpx`, height: `${star.size}rpx` }"
      />
    </view>
  </view>
</template>

<style lang="scss" scoped>
.backdrop {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  overflow: hidden;
  pointer-events: none;

  &__moon {
    position: absolute;
    left: 50%;
    width: 720rpx;
    height: 720rpx;
    margin-left: -360rpx;
    @include arcana-moonlight(0.1);
    border-radius: 50%;
    animation: moon-breathe 8s ease-in-out infinite;
  }

  &__stars {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 60%;
  }

  &__star {
    position: absolute;
    background-color: $arcana-moon;
    border-radius: 50%;
    opacity: 0.25;
    animation: star-breathe 8s ease-in-out infinite;
  }

  &__star--bright {
    opacity: 0.55;
    animation-delay: -3s;
  }
}

@keyframes moon-breathe {
  0%,
  100% {
    opacity: 0.75;
  }

  50% {
    opacity: 1;
  }
}

@keyframes star-breathe {
  0%,
  100% {
    opacity: 0.18;
  }

  50% {
    opacity: 0.5;
  }
}

// 跟随系统"减少动态效果"：把所有装饰性动画关掉，只保留静态氛围
@media (prefers-reduced-motion: reduce) {
  .backdrop__moon,
  .backdrop__star {
    animation: none;
  }
}
</style>
