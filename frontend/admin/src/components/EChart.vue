<script setup lang="ts">
/**
 * ECharts 封装组件（自研，不使用 vue-echarts）
 *
 * 能力：
 *   - 自动 init / setOption / resize / dispose，组件卸载时释放画布与监听（避免内存泄漏）
 *   - 容器尺寸变化自动重绘：优先 ResizeObserver，降级为 window resize 监听
 *   - SSR 与「容器尚未挂载」场景安全：无 window / 无容器时直接返回，不抛异常
 *   - loading 状态托管（showLoading / hideLoading）
 *
 * 说明：整包引入 `echarts`（而非 echarts/core 按需注册），
 * 换取 Phase 0 的接入确定性；构建时已由 vite.config.ts 拆分为独立 chunk（echarts）。
 * 若后续首屏体积成为瓶颈，可在 Phase 7 改为按需注册图表类型与组件。
 */

import * as echarts from 'echarts';
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

/**
 * 图表配置类型：从 echarts 命名空间取（等价于 `import type { EChartsOption } from 'echarts'`），
 * 这样只依赖命名空间成员访问，不受 echarts 根模块导出形式影响。
 */
type EChartsOption = echarts.EChartsOption;

/** ECharts 实例类型：用 ReturnType 推导，避免依赖 echarts 内部类型路径 */
type EChartInstance = ReturnType<typeof echarts.init>;

const props = withDefaults(
  defineProps<{
    /** 图表配置 */
    option: EChartsOption;
    /** 容器宽度（CSS 值） */
    width?: string;
    /** 容器高度（CSS 值）；ECharts 要求容器有确定高度 */
    height?: string;
    /** 是否展示加载动画 */
    loading?: boolean;
    /** 主题名；空字符串表示使用 ECharts 默认主题 */
    theme?: string;
    /** 容器尺寸变化时是否自动重绘 */
    autoResize?: boolean;
  }>(),
  {
    width: '100%',
    height: '320px',
    loading: false,
    theme: '',
    autoResize: true,
  },
);

const containerRef = ref<HTMLDivElement | null>(null);
/** 使用 shallowRef：ECharts 实例是庞大的非响应式对象，深层代理会严重影响性能 */
const instance = shallowRef<EChartInstance | null>(null);
let resizeObserver: ResizeObserver | null = null;

/** 同步加载态 */
const syncLoading = (): void => {
  const chart = instance.value;
  if (!chart) return;
  if (props.loading) {
    chart.showLoading('default', {
      text: '加载中…',
      color: '#409eff',
      textColor: '#909399',
      maskColor: 'rgba(255, 255, 255, 0.6)',
      zlevel: 0,
    });
    return;
  }
  chart.hideLoading();
};

/** 应用最新 option（notMerge = true，避免上一次的系列残留） */
const applyOption = (): void => {
  instance.value?.setOption(props.option, true);
};

/** 重绘：容器尺寸变化时调用 */
const resize = (): void => {
  instance.value?.resize();
};

/** 监听容器尺寸变化 */
const observeSize = (container: HTMLDivElement): void => {
  if (!props.autoResize) return;

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver((): void => {
      resize();
    });
    resizeObserver.observe(container);
    return;
  }

  // 降级：不支持 ResizeObserver 的环境（老浏览器）监听窗口尺寸变化
  if (typeof window !== 'undefined') window.addEventListener('resize', resize);
};

/** 初始化（幂等）：容器存在且已挂载时才创建实例 */
const init = (): void => {
  if (typeof window === 'undefined') return;

  const container = containerRef.value;
  if (!container) return;

  if (!instance.value) {
    instance.value = echarts.init(container, props.theme === '' ? undefined : props.theme, {
      renderer: 'canvas',
    });
  }

  applyOption();
  syncLoading();
  observeSize(container);
};

/** 销毁：释放 ECharts 实例与所有监听 */
const dispose = (): void => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (typeof window !== 'undefined') window.removeEventListener('resize', resize);
  instance.value?.dispose();
  instance.value = null;
};

// option 变化 → 重新渲染（deep 监听，允许调用方就地修改配置对象）
watch(
  () => props.option,
  (): void => {
    applyOption();
  },
  { deep: true },
);

// 加载态变化
watch(
  () => props.loading,
  (): void => {
    syncLoading();
  },
);

// 尺寸 prop 变化 → DOM 更新后重绘
watch(
  () => [props.width, props.height],
  async (): Promise<void> => {
    await nextTick();
    resize();
  },
);

onMounted(init);

// keep-alive 缓存组件被重新激活时（如返回列表页），容器尺寸可能已变化
onActivated((): void => {
  void nextTick(resize);
});

onBeforeUnmount(dispose);

defineExpose({
  /** 手动重绘 */
  resize,
  /** 手动替换配置 */
  setOption: applyOption,
  /** 获取底层 ECharts 实例（Phase 7 需要注册事件或调用 dispatchAction 时使用） */
  getInstance: (): EChartInstance | null => instance.value,
});
</script>

<template>
  <div
    ref="containerRef"
    class="sm-chart"
    role="img"
    aria-label="数据图表"
    :style="{ width: props.width, height: props.height }"
  />
</template>

<style scoped lang="scss">
.sm-chart {
  position: relative;
  min-height: 120px;
  // ECharts 内部使用 canvas 绝对定位，容器必须有确定高度
  overflow: hidden;
}
</style>
