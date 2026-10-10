<script setup lang="ts">
/**
 * 五维雷达图（Canvas 2D 自绘）
 *
 * 为什么不用 ECharts（架构决策，见 PROJECT_ARCHITECTURE.md ADR-019）：
 *   微信小程序主包上限 2MB，而 ECharts 完整包约 1MB；本项目小程序端只需要
 *   雷达图与折线图两种简单图表，为此引入 ECharts + canvas 适配层（ec-canvas）
 *   性价比过低。因此小程序端采用 Canvas 2D 自绘（零依赖、完全可控、体积可忽略），
 *   ECharts 仅用于 Web 管理后台（复杂的多维统计图表）。
 *
 * 实现要点：
 *   · 使用 type="2d" 的新版 Canvas 接口（性能优于旧版 context 接口）
 *   · 按 devicePixelRatio 缩放，避免高分屏模糊
 *   · 组件销毁与数据变化时正确重绘，避免重复叠加
 */

import { getCurrentInstance, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface RadarDimension {
  key: string;
  label: string;
  /** 0-100 */
  value: number;
}

interface Props {
  dimensions: RadarDimension[];
  /** 画布尺寸（rpx） */
  size?: number;
  /** 主色（默认品牌色） */
  color?: string;
  /** 对比组（如伴侣的画像），用于双人匹配图 */
  compareDimensions?: RadarDimension[];
  /** 对比组颜色 */
  compareColor?: string;
}

const props = withDefaults(defineProps<Props>(), {
  size: 560,
  color: '#5B4BE0',
  compareDimensions: undefined,
  compareColor: '#FF7A59',
});

const instance = getCurrentInstance();
const canvasId = `radar-${Math.random().toString(36).slice(2, 9)}`;
/** Canvas 与容器均按 px 计算，需把 rpx 转 px */
const canvasSizePx = ref(0);

/** rpx → px（小程序 750rpx 对应屏幕宽度） */
const rpxToPx = (rpx: number): number => {
  try {
    const info = uni.getWindowInfo();
    return (rpx * info.windowWidth) / 750;
  } catch {
    return rpx / 2;
  }
};

/** 把 0-100 的分数映射到半径比例 */
const normalize = (value: number): number => Math.max(0, Math.min(100, value)) / 100;

/** 绘制单个数据多边形 */
const drawPolygon = (
  ctx: CanvasRenderingContext2D,
  center: number,
  radius: number,
  count: number,
  values: number[],
  options: { fill: string; stroke: string; lineWidth: number },
): void => {
  ctx.beginPath();
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    const value = values[index] ?? 0;
    const distance = radius * normalize(value);
    const x = center + distance * Math.cos(angle);
    const y = center + distance * Math.sin(angle);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fillStyle = options.fill;
  ctx.fill();
  ctx.strokeStyle = options.stroke;
  ctx.lineWidth = options.lineWidth;
  ctx.stroke();
};

/** 主绘制逻辑 */
const draw = (): void => {
  const query = uni.createSelectorQuery().in(instance);

  // 注意：@dcloudio/types 把 fields 的回调声明为必填，因此结果在 fields 回调里接收，
  // 再调用 exec() 触发查询。（运行时回调与 exec 回调都会收到结果，这里只用前者，避免重复绘制）
  query.select(`#${canvasId}`).fields({ node: true, size: true }, (result) => {
    const list = Array.isArray(result) ? result : [result];
    const first = list[0] as { node?: { getContext: (type: string) => CanvasRenderingContext2D } } | undefined;
    const canvas = first?.node;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const size = canvasSizePx.value;
    const center = size / 2;
    const radius = size / 2 - 40;
    const count = props.dimensions.length;

    if (count < 3) return;

    // 高分屏适配：先按 dpr 放大画布，再缩放绘图上下文
    let dpr = 1;
    try {
      dpr = uni.getWindowInfo().pixelRatio ?? 1;
    } catch {
      dpr = 1;
    }
    // @ts-expect-error 小程序 Canvas 节点具有 width/height 属性，标准 DOM 类型未声明
    canvas.width = size * dpr;
    // @ts-expect-error 同上
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    // ---------------- 背景网格（4 层同心多边形） ----------------
    for (let level = 4; level >= 1; level -= 1) {
      const levelRadius = (radius * level) / 4;
      ctx.beginPath();
      for (let index = 0; index < count; index += 1) {
        const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
        const x = center + levelRadius * Math.cos(angle);
        const y = center + levelRadius * Math.sin(angle);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = level === 4 ? '#D9D9E3' : '#EBEBF2';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ---------------- 轴线与维度标签 ----------------
    ctx.font = '12px sans-serif';
    for (let index = 0; index < count; index += 1) {
      const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
      const x = center + radius * Math.cos(angle);
      const y = center + radius * Math.sin(angle);

      ctx.beginPath();
      ctx.moveTo(center, center);
      ctx.lineTo(x, y);
      ctx.strokeStyle = '#EBEBF2';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 标签位置：按象限调整对齐方式，避免文字压线
      const labelX = center + (radius + 20) * Math.cos(angle);
      const labelY = center + (radius + 20) * Math.sin(angle);
      ctx.fillStyle = '#4A4A5C';
      ctx.textAlign = Math.abs(Math.cos(angle)) < 0.2 ? 'center' : Math.cos(angle) > 0 ? 'left' : 'right';
      ctx.textBaseline = Math.abs(Math.sin(angle)) < 0.2 ? 'middle' : Math.sin(angle) > 0 ? 'top' : 'bottom';
      ctx.fillText(props.dimensions[index]?.label ?? '', labelX, labelY);
    }

    // ---------------- 对比组（先画，避免遮挡主数据） ----------------
    if (props.compareDimensions && props.compareDimensions.length === count) {
      const compareValues = props.compareDimensions.map((item) => item.value);
      drawPolygon(ctx, center, radius, count, compareValues, {
        fill: 'rgba(255, 122, 89, 0.14)',
        stroke: props.compareColor,
        lineWidth: 2,
      });

      for (let index = 0; index < count; index += 1) {
        const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
        const distance = radius * normalize(compareValues[index] ?? 0);
        ctx.beginPath();
        ctx.arc(center + distance * Math.cos(angle), center + distance * Math.sin(angle), 3, 0, Math.PI * 2);
        ctx.fillStyle = props.compareColor;
        ctx.fill();
      }
    }

    // ---------------- 主数据 ----------------
    const values = props.dimensions.map((item) => item.value);
    drawPolygon(ctx, center, radius, count, values, {
      fill: 'rgba(91, 75, 224, 0.16)',
      stroke: props.color,
      lineWidth: 2,
    });

    for (let index = 0; index < count; index += 1) {
      const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
      const distance = radius * normalize(values[index] ?? 0);
      ctx.beginPath();
      ctx.arc(center + distance * Math.cos(angle), center + distance * Math.sin(angle), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = props.color;
      ctx.fill();
    }
  });

  // exec() 才会真正发起查询
  query.exec();
};

onMounted(() => {
  canvasSizePx.value = rpxToPx(props.size);
  void nextTick(draw);
});

// 数据变化后重绘（例如匹配页加载完对方画像）
watch(
  () => [props.dimensions, props.compareDimensions],
  () => {
    void nextTick(draw);
  },
  { deep: true },
);

// 组件销毁前无需特殊处理（Canvas 随节点回收），此处保留钩子以便后续埋点
onBeforeUnmount(() => {
  // no-op
});
</script>

<template>
  <view class="radar" :style="{ width: `${props.size}rpx`, height: `${props.size}rpx` }">
    <canvas :id="canvasId" type="2d" class="radar__canvas" />
  </view>
</template>

<style lang="scss" scoped>
.radar {
  margin: 0 auto;

  &__canvas {
    width: 100%;
    height: 100%;
  }
}
</style>
