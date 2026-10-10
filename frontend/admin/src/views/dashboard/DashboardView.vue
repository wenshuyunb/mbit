<script setup lang="ts">
/**
 * 数据看板（Phase 0 骨架）
 *
 * 指标口径见架构 §1.4（北极星：付费转化率）。
 * Phase 0 不接入数据：指标值统一展示占位符，趋势图使用**空数据**配置，
 * 页面上的数值一律标注「占位」，避免被误读为真实业务数据。
 *
 * 数据来源接口（Phase 7 接入，管理端接口统一定义在 API_DESIGN §3.15）：
 *   - GET /api/v1/admin/dashboard/metrics —— 北极星与副指标（权限点 dashboard:metrics:read）
 *   - GET /api/v1/admin/ai/stats          —— AI 调用量与成本（权限点 ai:stats:read）
 *   - GET /api/v1/admin/orders/stats      —— 订单与营收（权限点 payment:order:read）
 */

import * as echarts from 'echarts';
import EChart from '@/components/EChart.vue';
import PageHeader from '@/components/PageHeader.vue';

/** 图表配置类型：从 echarts 命名空间取，避免依赖根模块的具名导出形式 */
type EChartsOption = echarts.EChartsOption;

/** 指标卡定义 */
interface MetricCard {
  /** 指标键（与后端返回字段对应） */
  key: string;
  /** 指标名 */
  label: string;
  /** 单位 */
  unit: string;
  /** 目标值说明（架构 §1.4 的指标目标） */
  target: string;
  /** 指标口径说明 */
  description: string;
  /** 数据来源接口 */
  source: string;
}

/** 指标卡清单（值均为占位符，Phase 7 替换为接口返回值） */
const metrics: readonly MetricCard[] = [
  {
    key: 'paidConversionRate',
    label: '付费转化率',
    unit: '%',
    target: '目标 ≥ 5%',
    description: '完成测试 → 产生付费订单的转化率（北极星指标）',
    source: 'GET /api/v1/admin/dashboard/metrics',
  },
  {
    key: 'testCompletionRate',
    label: '测试完成率',
    unit: '%',
    target: '目标 ≥ 65%',
    description: '开始测试 → 30 秒内提交全部答案的比例',
    source: 'GET /api/v1/admin/dashboard/metrics',
  },
  {
    key: 'reportSuccessRate',
    label: 'AI 报告成功率',
    unit: '%',
    target: '目标 ≥ 99%',
    description: '一次调用成功 / 总请求（含重试）',
    source: 'GET /api/v1/admin/ai/stats',
  },
  {
    key: 'aiDailyCost',
    label: 'AI 单日成本',
    unit: '元',
    target: '预算告警阈值 80%',
    description: '当日全部 LLM 调用成本（服务端以「分」计量，前端转换为元展示）',
    source: 'GET /api/v1/admin/ai/stats',
  },
];

/**
 * 趋势图配置（占位）
 * x 轴与 series 均为空数组：ECharts 会渲染空白坐标系，Phase 7 用接口数据填充。
 */
const trendOption: EChartsOption = {
  tooltip: { trigger: 'axis' },
  grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
  xAxis: { type: 'category', boundaryGap: false, data: [] },
  yAxis: { type: 'value', name: '金额（元）', splitLine: { lineStyle: { type: 'dashed' } } },
  series: [
    {
      name: 'AI 成本',
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: [],
      areaStyle: { opacity: 0.15 },
    },
  ],
};
</script>

<template>
  <div class="sm-page dashboard">
    <PageHeader title="数据看板" description="核心业务指标概览；数值与图表将在 Phase 7 接入管理端统计接口。">
      <template #actions>
        <el-tag type="warning" effect="plain">Phase 0 骨架 · 数据为占位</el-tag>
      </template>
    </PageHeader>

    <!-- 指标卡 -->
    <section class="dashboard__metrics">
      <el-card v-for="item in metrics" :key="item.key" class="dashboard__metric" shadow="never">
        <div class="dashboard__metric-head">
          <span class="dashboard__metric-label">{{ item.label }}</span>
          <el-tooltip :content="item.description" placement="top">
            <el-tag size="small" type="info" effect="plain">{{ item.target }}</el-tag>
          </el-tooltip>
        </div>

        <div class="dashboard__metric-value">
          <span class="dashboard__metric-placeholder">--</span>
          <span class="dashboard__metric-unit">{{ item.unit }}</span>
        </div>

        <p class="dashboard__metric-source sm-text-secondary">
          数据来源：<span class="sm-mono">{{ item.source }}</span>
        </p>
      </el-card>
    </section>

    <!-- 趋势图（空数据占位） -->
    <el-card shadow="never">
      <template #header>
        <div class="dashboard__chart-header">
          <span>近 30 日 AI 成本趋势</span>
          <span class="sm-text-secondary">占位图表：Phase 7 由 GET /api/v1/admin/ai/stats 返回数据填充</span>
        </div>
      </template>

      <EChart :option="trendOption" height="300px" />
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.dashboard {
  &__metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: $spacing-md;
  }

  &__metric {
    border-radius: var(--sm-radius-card);
  }

  &__metric-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: $spacing-sm;
  }

  &__metric-label {
    font-size: $font-size-base;
    color: var(--sm-text-secondary);
  }

  &__metric-value {
    display: flex;
    align-items: baseline;
    gap: $spacing-xs;
    margin: $spacing-sm 0 $spacing-xs;
  }

  &__metric-placeholder {
    font-size: 28px;
    font-weight: 600;
    line-height: 1.2;
    color: var(--sm-text-primary);
  }

  &__metric-unit {
    font-size: $font-size-base;
    color: var(--sm-text-secondary);
  }

  &__metric-source {
    margin: 0;
    font-size: $font-size-xs;
    line-height: 1.6;
  }

  &__chart-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: $spacing-sm;
    font-size: $font-size-base;
    font-weight: 600;
  }
}
</style>
