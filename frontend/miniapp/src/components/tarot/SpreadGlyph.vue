<script setup lang="ts">
/**
 * 牌阵排列图（每个牌阵有**专属构图**，不是同一张缩略图换个数字）
 *
 * 规格要求：「时间之流：三张卡牌横向；二选一：两侧分叉 + 中间指引；
 * 关系之镜：对称/镜像阵列；七日指引：扇形或星轨」。因此这里按 `layout`
 * 分别给出坐标，用最小尺寸的金色小牌摆出**能看出结构**的图形。
 *
 * 为什么不用图片：五种构图各配一张图，改布局就得同步资源；用坐标数据摆位，
 * 一处改动即可，且天然适配任意尺寸（缩略图与抽卡页牌桌共用同一套坐标）。
 */

import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 牌阵布局 */
    layout: 'SINGLE' | 'ROW' | 'COLUMN' | 'CROSS' | 'WEEK';
    /** 张数（用于 WEEK 的 5+2） */
    cardCount: number;
    /** 图形宽度（rpx） */
    widthRpx?: number;
    /** 图形高度（rpx） */
    heightRpx?: number;
    /** 小牌尺寸（rpx） */
    cardRpx?: number;
  }>(),
  { widthRpx: 200, heightRpx: 148, cardRpx: 26 },
);

interface Slot {
  readonly left: number;
  readonly top: number;
  /** 旋转角度：扇形与镜像阵列用得上 */
  readonly rotate?: number;
  /** 是否突出显示（如二选一里的"关键提示"） */
  readonly accent?: boolean;
}

/** 五种布局的坐标（百分比） */
const SLOTS: Readonly<Record<string, readonly Slot[]>> = {
  SINGLE: [{ left: 50, top: 52 }],
  // 时间之流：横向三张，轻微上扬，体现"流向"
  ROW: [
    { left: 22, top: 56 },
    { left: 50, top: 48 },
    { left: 78, top: 56 },
  ],
  // 关系之镜：镜像对称（左右各一 + 中间一张 + 下方一张）
  CROSS: [
    { left: 30, top: 40, rotate: -6 },
    { left: 70, top: 40, rotate: 6 },
    { left: 50, top: 56 },
    { left: 50, top: 82 },
  ],
  // 竖列：三层堆叠
  COLUMN: [
    { left: 50, top: 24 },
    { left: 50, top: 50 },
    { left: 50, top: 76 },
  ],
};

/** 七日指引：五张成弧 + 两张收尾（像一圈星轨的下缘） */
const WEEK_SLOTS: readonly Slot[] = [
  { left: 16, top: 44, rotate: -14 },
  { left: 32, top: 32, rotate: -7 },
  { left: 50, top: 28 },
  { left: 68, top: 32, rotate: 7 },
  { left: 84, top: 44, rotate: 14 },
  { left: 40, top: 74, rotate: -4 },
  { left: 62, top: 74, rotate: 4 },
];

const slots = computed<readonly Slot[]>(() => {
  if (props.layout === 'WEEK') return props.cardCount >= 7 ? WEEK_SLOTS : (SLOTS['ROW'] ?? []);

  return SLOTS[props.layout] ?? SLOTS['SINGLE'] ?? [];
});

const styleOf = (slot: Slot): Record<string, string> => {
  const w = props.widthRpx;
  const h = props.heightRpx;
  const card = props.cardRpx;

  return {
    left: `${Math.round((w * slot.left) / 100)}rpx`,
    top: `${Math.round((h * slot.top) / 100)}rpx`,
    width: `${card}rpx`,
    height: `${Math.round(card * 1.62)}rpx`,
    marginLeft: `-${Math.round(card / 2)}rpx`,
    marginTop: `-${Math.round((card * 1.62) / 2)}rpx`,
    transform: `rotate(${slot.rotate ?? 0}deg)`,
  };
};
</script>

<template>
  <view class="glyph" :style="{ width: `${widthRpx}rpx`, height: `${heightRpx}rpx` }">
    <!-- 细金线描的圆形阵图底纹 -->
    <view class="glyph__ring" />
    <view
      v-for="(slot, index) in slots"
      :key="index"
      class="glyph__card"
      :class="slot.accent ? 'glyph__card--accent' : ''"
      :style="styleOf(slot)"
    />
  </view>
</template>

<style lang="scss" scoped>
.glyph {
  position: relative;
  flex-shrink: 0;

  &__ring {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 84%;
    height: 0;
    padding-bottom: 84%;
    margin-top: -42%;
    margin-left: -42%;
    border: 1rpx solid rgba(201, 171, 115, 0.16);
    border-radius: 50%;
  }

  &__card {
    position: absolute;
    background: linear-gradient(158deg, #2b2440 0%, #171d2c 100%);
    border: 1rpx solid rgba(201, 171, 115, 0.55);
    border-radius: 4rpx;
    box-shadow: 0 3rpx 8rpx rgba(5, 7, 14, 0.45);
  }

  &__card::after {
    position: absolute;
    top: 3rpx;
    right: 3rpx;
    bottom: 3rpx;
    left: 3rpx;
    content: '';
    border: 1rpx solid rgba(201, 171, 115, 0.22);
    border-radius: 2rpx;
  }

  &__card--accent {
    border-color: $arcana-gold;
    box-shadow: 0 0 10rpx rgba(201, 171, 115, 0.35);
  }
}
</style>
