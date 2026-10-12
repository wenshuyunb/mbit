/**
 * 首页数据 composable
 *
 * 把首页的数据获取与派生文案从 SFC 里抽出来，原因与 `use-report-detail` 一致：
 * SFC 内部的 computed 无法直接单测（测试配置明确不做渲染测试），
 * 而这些「分支文案 + 并发降级」恰好是最容易出错、也最值得锁死的部分。
 *
 * ## 并发策略
 *
 * 三个请求彼此独立，用 `Promise.allSettled` 而非 `Promise.all`：
 * 报告或题库失败时首页仍应可用，只有**画像**失败必须显式提示 ——
 * 它是「开始测试 / 重新测试」这条主行动的分支依据，误判会让用户点进错误的流程。
 */

import { computed, ref } from 'vue';

import { getMyProfile, type PersonalityProfile } from '@/api/personality';
import { listReports, type ReportListSummary, type ReportSummary } from '@/api/report';
import { listTests, type TestDefinition } from '@/api/test';
import { ApiError } from '@/api/types';

/** 报告生成中的提示：只关心数量 */
const GENERATING_PREFIX = '份报告正在生成';

export const useHome = () => {
  const profile = ref<PersonalityProfile | null>(null);
  const latestReport = ref<ReportSummary | null>(null);
  const reportSummary = ref<ReportListSummary | null>(null);
  const testDefinition = ref<TestDefinition | null>(null);
  /** 画像加载失败时的文案（网络/服务端错误；「没有画像」不算失败） */
  const profileError = ref('');

  const hasProfile = computed(() => profile.value !== null);

  /** 画像结论：首页只展示类型与名称，细节在画像/报告页 */
  const profileBadge = computed(() => {
    const mbti = profile.value?.mbti;
    return mbti ? `${mbti.type} · ${mbti.typeName}` : '';
  });

  /** 主行动卡片按钮文案 */
  const primaryTitle = computed(() => (hasProfile.value ? '重新测试人格' : '开始人格测试'));

  /** 测试耗时由服务端下发，避免前端写死后与题库不一致 */
  const primaryDesc = computed(() => {
    const definition = testDefinition.value;

    if (hasProfile.value) return '看看这段时间你的变化';
    if (definition) return `${definition.name} · 约 ${definition.estimatedMinutes} 分钟`;
    return 'MBTI + 大五人格双模型';
  });

  /** 报告入口描述：生成中优先，其次最新一条，最后兜底文案 */
  const reportDesc = computed(() => {
    const generating = reportSummary.value?.generatingReports ?? 0;
    if (generating > 0) return `${generating} ${GENERATING_PREFIX}…`;

    const report = latestReport.value;
    if (!report) return '查看 AI 生成的深度人格解读';

    // typeName 由服务端下发，前端不再维护类型中文名映射表
    return `${report.typeName} · ${report.status === 'SUCCEEDED' ? '已生成' : report.status}`;
  });

  const loadHomeData = async (): Promise<void> => {
    profileError.value = '';

    const [profileResult, reportResult, testsResult] = await Promise.allSettled([
      getMyProfile(),
      listReports({ page: 1, pageSize: 1 }),
      listTests(),
    ]);

    if (profileResult.status === 'fulfilled') {
      // null 是「尚未测评」的正常空状态，不是错误
      profile.value = profileResult.value;
    } else {
      const error: unknown = profileResult.reason;
      profileError.value = error instanceof ApiError ? error.message : '画像加载失败，请下拉刷新重试';
    }

    if (reportResult.status === 'fulfilled') {
      latestReport.value = reportResult.value.items[0] ?? null;
      reportSummary.value = reportResult.value.summary;
    }

    if (testsResult.status === 'fulfilled') {
      // 首页主行动指向人格速测：优先取 MBTI 分类，其次取第一个
      const tests = testsResult.value;
      testDefinition.value = tests.find((item) => item.category === 'MBTI') ?? tests[0] ?? null;
    }
  };

  return {
    // state
    profile,
    latestReport,
    reportSummary,
    testDefinition,
    profileError,
    // getter
    hasProfile,
    profileBadge,
    primaryTitle,
    primaryDesc,
    reportDesc,
    // action
    loadHomeData,
  };
};
