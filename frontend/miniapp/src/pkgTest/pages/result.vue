<script setup lang="ts">
/**
 * 测试结果页（分包 pkgTest）
 *
 * 展示：MBTI 四字母 + 四维倾向条 + Big Five 雷达图 + 置信度提示 + 生成报告入口
 *
 * 数据来源：`GET /tests/sessions/{id}/result`（服务端在提交时已同步算分并落库）。
 * 页面只依赖 URL 中的 `sessionId`，不接收其他数据 —— 避免出现「URL 里的类型」
 * 与「服务端落库的类型」不一致。
 */

import { computed, ref } from 'vue';
import { onLoad, onShareAppMessage } from '@dcloudio/uni-app';

import RadarChart from '@/components/RadarChart.vue';
import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import {
  getSessionResult,
  type EmotionSessionResult,
  type MentalHealthSessionResult,
  type PersonalitySessionResult,
  type TestSessionResult,
} from '@/api/test';
import { createReport, getReportProgress, progressStageLabel, type ReportStatus } from '@/api/report';
import { ApiError } from '@/api/types';
import { BIG_FIVE_DIMENSIONS, MBTI_DIMENSIONS } from '@/config/constants';
import {
  ATTACHMENT_STYLE_LABELS,
  CONFLICT_STYLE_LABELS,
  CONFLICT_STYLE_ORDER,
  LOVE_LANGUAGE_LABELS,
  LOVE_LANGUAGE_ORDER,
  modulePresentation,
} from '@/config/modules';
import { useAppStore } from '@/store/app';
import { goBack, goToPage } from '@/utils/navigate';

const appStore = useAppStore();

const sessionId = ref('');
const result = ref<TestSessionResult | null>(null);
const loading = ref(true);
const loadFailed = ref(false);
/** 报告生成进度（0–100）与状态，由轮询驱动 */
const reportProgress = ref(0);
const reportStatus = ref<ReportStatus | undefined>(undefined);
const generating = ref(false);
/** 本次生成出来的报告 id（失败/超时后仍可进详情页查看状态） */
const reportId = ref<string | null>(null);
/** 生成失败或超时的提示；成功与重新开始时清空 */
const generateError = ref<string | null>(null);

/**
 * 当前结果的模块（ADR-038）
 *
 * 页面是**三个模块共用**的：人格渲染四维 + 大五，情感渲染依恋 + 爱的语言 + 冲突，
 * 心理健康渲染六维 + 文字结论。
 * 靠 `module` 判别而不是靠"字段在不在"猜 —— 猜错的表现是页面出现一堆 `undefined`。
 */
const moduleKey = computed(() => result.value?.module ?? 'PERSONALITY');
const presentation = computed(() => modulePresentation(moduleKey.value));
const isEmotion = computed(() => result.value?.module === 'EMOTION');
const isMentalHealth = computed(() => result.value?.module === 'MENTAL_HEALTH');

/**
 * 本模块是否有 AI 报告
 *
 * 心理健康模块**没有**（产品决策：它的红线是不给建议，而 AI 解读几乎必然滑向建议；
 * 见 `config/modules.ts` 里 `reportType: null` 的说明）。
 * 因此"生成深度报告"这条动线在这个模块里**整条不渲染** ——
 * 而不是渲染出来再报错。
 */
const hasReport = computed(() => presentation.value.reportType !== null);

/** 人格结果（收窄后的便捷访问；非人格结果时为 null） */
const personality = computed<PersonalitySessionResult | null>(() =>
  result.value?.module === 'PERSONALITY' ? result.value : null,
);

/** 情感结果（收窄后的便捷访问；非情感结果时为 null） */
const emotion = computed<EmotionSessionResult | null>(() => (result.value?.module === 'EMOTION' ? result.value : null));

/**
 * 情感结论（服务端确定性生成，见 `EmotionConclusion` 的说明）
 *
 * 旧数据（本次改动之前生成的会话结果）里没有这个字段，因此按可选处理：
 * 拿不到就不渲染结论区，而不是把页面搞崩。
 */
const emotionConclusion = computed(() => emotion.value?.result.conclusion ?? null);

/** 心理健康结果（收窄后的便捷访问；非本模块时为 null） */
const mentalHealth = computed<MentalHealthSessionResult | null>(() =>
  result.value?.module === 'MENTAL_HEALTH' ? result.value : null,
);

/** 心理健康六维（按服务端给的固定顺序；不再前端排序） */
const mentalHealthDimensions = computed(() => mentalHealth.value?.result.dimensions ?? []);

const summary = computed(() => personality.value?.result ?? null);
const mbtiType = computed(() => summary.value?.mbtiType ?? null);
const mbtiLetters = computed(() => (mbtiType.value ?? '????').split(''));

/** 四维倾向（0–100，≥ 50 偏向正极字母），用于绘制双向条 */
const dimensionBars = computed(() =>
  MBTI_DIMENSIONS.map((dimension) => {
    // 服务端返回 { percent, pole, leftLabel, rightLabel }，percent ≥ 50 即偏向正极
    const percent = summary.value?.dimensions?.[dimension.key]?.percent ?? 50;
    return {
      key: dimension.key,
      label: dimension.label,
      positive: dimension.positive,
      negative: dimension.negative,
      positiveLabel: dimension.positiveLabel,
      negativeLabel: dimension.negativeLabel,
      percent,
      positiveWidth: percent,
      negativeWidth: 100 - percent,
    };
  }),
);

/** Big Five 雷达图数据 */
const radarDimensions = computed(() =>
  BIG_FIVE_DIMENSIONS.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    value: summary.value?.bigFive?.[dimension.key] ?? 0,
  })),
);

// ---------------------------------------------------------------------------
// 情感结果（ADR-038 阶段 3）
// ---------------------------------------------------------------------------

/**
 * 依恋类型中文名 + 两条轴
 *
 * ⚠ 结果页**必须把两条轴一起展示**：四种依恋类型是焦虑轴与回避轴**求交**得出的
 * 象限结果，只给一个"焦虑型"无法回答"凭什么"、也看不出"离分界线多近"。
 * 这正是用户说的「不要过于简陋」。
 */
const attachmentView = computed(() => {
  const attachment = emotion.value?.result.attachment;
  if (attachment === undefined) return null;

  const label = ATTACHMENT_STYLE_LABELS[attachment.style] ?? attachment.style;

  return {
    label,
    anxiety: Math.round(attachment.anxiety),
    avoidance: Math.round(attachment.avoidance),
    thresholds: attachment.thresholds,
  };
});

/**
 * 爱的语言五项，按**固定顺序**排列（不按分数排序）
 *
 * 固定顺序让同一份结果每次渲染的行序一致，用户来回切换页面不会看到顺序跳动；
 * "哪一项主导"由 `isPrimary` 高亮体现，不靠位置。
 */
const loveLanguageRows = computed(() => {
  const scores = emotion.value?.result.loveLanguage.scores;
  if (scores === undefined) return [];

  const primary = new Set(emotion.value?.result.loveLanguage.primary ?? []);

  return LOVE_LANGUAGE_ORDER.map((code) => ({
    code,
    label: LOVE_LANGUAGE_LABELS[code] ?? code,
    score: Math.round(scores[code] ?? 0),
    isPrimary: primary.has(code),
  }));
});

/** 冲突风格五种，主导项高亮 */
const conflictRows = computed(() => {
  const conflict = emotion.value?.result.conflict;
  if (conflict === undefined) return [];

  return CONFLICT_STYLE_ORDER.map((code) => ({
    code,
    label: CONFLICT_STYLE_LABELS[code] ?? code,
    score: Math.round(conflict.scores[code] ?? 0),
    isPrimary: conflict.style === code,
  }));
});

const conflictStyleLabel = computed(() => {
  const style = emotion.value?.result.conflict.style;
  if (style === undefined) return null;

  return CONFLICT_STYLE_LABELS[style] ?? style;
});

/**
 * 结果提示文案
 *
 * 优先使用服务端下发的 `quality.notice`（阈值由后端统一控制），
 * 避免前后端各写一套判断标准而出现文案矛盾。
 */
const qualityNotice = computed(() => result.value?.result.quality.notice ?? null);

/**
 * 心理状态的解读层（每维人话 / 重点项 / 三条建议 / 求助指引 / 复测引导）
 *
 * 服务端由**确定性规则**生成（不是 AI 写的）：同一份作答任何时候都得到同一份内容。
 * 老结果（后端上线这个字段之前生成的）拿不到它 → 页面按"只有分数与结论"降级渲染，
 * 而不是渲染一片空白。
 */
const mentalHealthReport = computed(() =>
  result.value?.module === 'MENTAL_HEALTH' ? (result.value.result.report ?? null) : null,
);

/**
 * 拨打心理援助热线
 *
 * 号码由服务端下发（`report.support.hotline.number`），前端**不硬编码** ——
 * 号码是政策性的，写死在前端意味着改号要发版。
 * 拨号失败（部分机型/开发者工具不支持）时退化为"把号码展示出来让用户自己拨"，
 * 不能什么都不做。
 */
const callHotline = (): void => {
  const number = mentalHealthReport.value?.support.hotline.number;
  if (!number) return;

  uni.makePhoneCall({
    phoneNumber: number,
    fail: () => {
      uni.showModal({
        title: '心理援助热线',
        content: `可以直接拨打 ${number}（${mentalHealthReport.value?.support.hotline.name ?? ''}）`,
        showCancel: false,
        confirmText: '知道了',
      });
    },
  });
};

onLoad(async (query) => {
  const id = query?.['sessionId'];
  if (typeof id === 'string') {
    sessionId.value = id;
  }

  if (!sessionId.value) {
    loading.value = false;
    loadFailed.value = true;
    return;
  }

  try {
    result.value = await getSessionResult(sessionId.value);
  } catch (error) {
    // 失败原因可能是会话未提交/已过期（409）或网络问题，此处统一展示可重试的提示
    console.error('[result] 拉取算分结果失败：', error);
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
});

onShareAppMessage(() => {
  const title =
    result.value?.module === 'EMOTION' && attachmentView.value !== null
      ? `${presentation.value.shareTitlePrefix}${attachmentView.value.label}，你也来测测看`
      : mbtiType.value
        ? `${presentation.value.shareTitlePrefix} ${mbtiType.value}，你也来测测看`
        : '做一个 8 分钟的测评，认识真实的自己';

  return { title, path: '/pages/index/index' };
});

// ============================================================================
// 生成报告：真实链路（建任务 → 轮询进度 → 进入报告详情）
// ============================================================================

/**
 * 轮询间隔与总超时
 *
 * 后端是**异步任务**：`POST /reports` 返回 202 与 reportId，由 worker 生成。
 * 因此必须轮询；但也不能无限等 —— worker 未启动或网络异常时要有兜底，
 * 让用户至少能进详情页看到真实状态，而不是卡在一个转不动的按钮上。
 */
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 120_000;

/** 生成中的按钮文案：失败时直接显示原因，成功/进行中显示阶段 + 百分比 */
const generatingText = computed(() => {
  if (generateError.value !== null) return generateError.value;

  return `${progressStageLabel(reportStatus.value, reportProgress.value)} ${reportProgress.value}%`;
});

const openReportDetail = (id: string): void => {
  goToPage(`/pkgReport/pages/detail?id=${id}`);
};

/** 轮询直到终态；返回是否成功 */
const waitForReport = async (id: string): Promise<boolean> => {
  const deadline = Date.now() + POLL_MAX_MS;

  while (Date.now() < deadline) {
    const progress = await getReportProgress(id);
    reportProgress.value = progress.progress;
    reportStatus.value = progress.status;

    if (progress.status === 'SUCCEEDED') return true;

    if (progress.status === 'FAILED' || progress.status === 'CANCELLED') {
      generateError.value = progress.errorMessage ?? '报告生成失败，可稍后重试';

      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  generateError.value = '生成时间较长，已转入后台继续，可稍后在详情页查看';

  return false;
};

/**
 * 生成深度报告
 *
 * 注意**不传 `sessionId`**：后端 `CreateReportDto` 只接受 `type` / `relationshipId`，
 * 全局管道开着 `forbidNonWhitelisted`，多传一个字段会直接 `400/10001`。
 * 报告取的是**当前画像**（由最近一次已算分的测评产生），不需要会话 id。
 *
 * ⚠ 报告类型**按模块取**（`presentation.reportType`）：情感测评要 `EMOTION_REPORT`，
 * 它读的是情感画像。写死 `MBTI_REPORT` 的话，做完情感测评点「生成报告」
 * 会以 `40010 尚未生成人格画像` 收场 —— 一个与该模块毫不相关的错误。
 */
const generateReport = async (): Promise<void> => {
  if (generating.value) return;

  /**
   * 本模块没有 AI 报告 → 直接返回
   *
   * 这条守卫是**防御性**的（按钮在模板里已经不会渲染），但值得留着：
   * 一旦将来有人在别的入口调到这里（比如从报告列表页统一给一个"生成报告"按钮），
   * 没有这道判断就会拿 `null` 去请求，得到一个与用户处境毫不相关的错误。
   */
  const reportType = presentation.value.reportType;

  if (reportType === null) {
    uni.showToast({ title: '本次测评直接给出结论，无需生成报告', icon: 'none' });

    return;
  }

  generating.value = true;
  reportProgress.value = 0;
  reportStatus.value = 'QUEUED';
  generateError.value = null;

  try {
    const created = await createReport({ type: reportType });
    reportId.value = created.reportId;

    const finished = await waitForReport(created.reportId);

    if (finished) {
      uni.showToast({ title: '报告已生成', icon: 'success' });
    }

    // 成功与"超时但有报告 id"都进详情页：那里能看到实时状态与完整正文
    openReportDetail(created.reportId);
  } catch (error) {
    // 没有对应模块的画像时后端会明确报错（人格 `40010` / 情感 `40014`），
    // 直接把服务端文案给用户看 —— 它已经写清了"该先做什么"
    generateError.value = error instanceof ApiError ? error.message : '网络异常，请稍后重试';
  } finally {
    generating.value = false;
  }
};

// ============================================================================
// 页面动作
// ============================================================================

/** 本页是自定义导航栏（`navigationStyle: custom`），没有原生返回按钮，需自己处理 */
const onBack = (): void => goBack();

const goReportList = (): void => goToPage('/pages/report/list');
const goChat = (): void => goToPage('/pkgChat/pages/index');
const goHome = (): void => goToPage('/pages/index/index');

/**
 * 重测**本模块**（回该模块自己的介绍页）
 *
 * 编码从 `presentation.testCode` 取而不是写死：三个模块各有自己的题库编码，
 * 写死的话新增模块时这里会静默把人带回人格测评。
 */
const goRetake = (): void => {
  const entry = presentation.value;
  const url = entry.testCode.length > 0 ? `/pages/test/intro?code=${entry.testCode}` : '/pages/test/intro';

  goToPage(url);
};

/** 已有报告时，「下一步」里把按钮换成"查看报告详情" */
const goMyReportDetail = (): void => {
  if (reportId.value !== null) {
    openReportDetail(reportId.value);

    return;
  }

  goReportList();
};
</script>

<template>
  <view class="result">
    <!--
      自定义导航栏（pages.json 里本页是 navigationStyle: custom）
      —— 系统不会给返回按钮，必须自己画；顶部内边距还要加上状态栏高度，
      否则内容会顶到刘海/状态栏上。

      ⚠ `+ 8`（2026-10-16 加）：只加状态栏高度时，标题正好贴在状态栏下沿，
      视觉上像被上端"顶住"了。再加 8px 留出呼吸空间 —— 与答题页同一口径。
      用户反馈的原话是「评测报告的 UI 请整体往下移动，已经被手机的上端遮挡了」。
    -->
    <view class="result__navbar" :style="{ paddingTop: `${appStore.statusBarHeight + 8}px` }">
      <view class="result__navbar-back" @tap="onBack">
        <text class="result__navbar-back-icon">‹</text>
      </view>
      <text class="result__navbar-title">{{ presentation.resultTitle }}</text>
      <view class="result__navbar-back result__navbar-back--placeholder" />
    </view>

    <!-- 加载中 -->
    <view v-if="loading" class="card result__state">
      <text>正在获取测评结果…</text>
    </view>

    <!-- 加载失败 -->
    <view v-else-if="loadFailed" class="card result__state">
      <text class="result__state-title">未能获取测评结果</text>
      <text class="result__state-desc">测评可能尚未提交或已过期，请返回重新开始测评</text>
      <button class="result__state-action" @tap="goReportList">查看我的报告</button>
      <button class="result__state-action result__state-action--ghost" @tap="goRetake">重新测一次</button>
    </view>

    <template v-else>
      <!--
        主体分两条支路（ADR-038）：人格结果渲染四维 + 大五，
        情感结果渲染依恋双轴 + 爱的语言 + 冲突风格。两者**不共用任何展示组件** ——
        它们描述的本来就不是一回事，混排会让用户以为情感测评也测了性格。
      -->
      <template v-if="isEmotion">
        <!-- 依恋：类型 + 两条轴 -->
        <view class="result__hero">
          <text class="result__label">你在亲密关系里的依恋风格</text>
          <text class="result__emotion-style">{{ attachmentView?.label ?? '待生成' }}</text>
          <text class="result__summary">依恋类型由两条倾向求交得出，会随情境与对象变化 · 仅供自我探索参考</text>
        </view>

        <!--
          ★ 结论区（ADR-039 补）：这一屏是用户"做完题最先看到的"，必须直接给结论

          原先这一页只有标签与分数，实测用户的原话是「看完不知道想表达什么，
          也没有告诉我我属于什么、需要什么、建议是什么」。
          结论由**服务端按固定规则算出**（不是 AI 生成、不消耗额度、不必等报告），
          深度解读仍由用户主动生成的报告承担。
        -->
        <template v-if="emotionConclusion">
          <view class="card result__section result__verdict">
            <text class="result__verdict-headline">{{ emotionConclusion.headline }}</text>
            <text class="result__verdict-text">{{ emotionConclusion.portrait }}</text>
          </view>

          <view class="card result__section result__need">
            <text class="result__section-title">你在关系里最需要什么</text>
            <text class="result__verdict-text">{{ emotionConclusion.needs }}</text>
          </view>

          <view class="card result__section">
            <text class="result__section-title">你的优势</text>
            <view v-for="(item, index) in emotionConclusion.strengths" :key="index" class="result__bullet">
              <text class="result__bullet-dot">·</text>
              <text class="result__bullet-text">{{ item }}</text>
            </view>
          </view>

          <view class="card result__section result__advice">
            <text class="result__section-title">可以立刻开始做的三件事</text>
            <view v-for="(item, index) in emotionConclusion.suggestions" :key="index" class="result__advice-item">
              <text class="result__advice-index">{{ index + 1 }}</text>
              <text class="result__advice-text">{{ item }}</text>
            </view>
            <text class="result__advice-note">{{ emotionConclusion.note }}</text>
          </view>
        </template>

        <view v-if="qualityNotice" class="result__notice card">
          <text class="result__notice-text">{{ qualityNotice }}</text>
        </view>

        <!-- 两条轴：只给类型标签无法解释"为什么是焦虑型" -->
        <view v-if="attachmentView" class="card result__section">
          <text class="result__section-title">两条依恋倾向</text>
          <view class="result__axis">
            <view class="result__axis-head">
              <text class="result__axis-label">焦虑倾向</text>
              <text class="result__axis-value">{{ attachmentView.anxiety }}</text>
            </view>
            <view class="result__axis-track">
              <view class="result__axis-fill" :style="{ width: `${attachmentView.anxiety}%` }" />
            </view>
            <text class="result__axis-hint">越高表示越容易担心对方是不是同样在意自己</text>
          </view>
          <view class="result__axis">
            <view class="result__axis-head">
              <text class="result__axis-label">回避倾向</text>
              <text class="result__axis-value">{{ attachmentView.avoidance }}</text>
            </view>
            <view class="result__axis-track">
              <view class="result__axis-fill" :style="{ width: `${attachmentView.avoidance}%` }" />
            </view>
            <text class="result__axis-hint">越高表示越习惯自己扛、不太愿意把脆弱说出口</text>
          </view>
        </view>

        <!-- 爱的语言：完整五项，主导项高亮 -->
        <view class="card result__section">
          <text class="result__section-title">你最在意的被爱方式</text>
          <view v-for="row in loveLanguageRows" :key="row.code" class="result__score-row">
            <text class="result__score-label" :class="{ 'is-primary': row.isPrimary }">
              {{ row.label }}{{ row.isPrimary ? ' · 主导' : '' }}
            </text>
            <view class="result__score-track">
              <view
                class="result__score-fill"
                :class="{ 'is-primary': row.isPrimary }"
                :style="{ width: `${row.score}%` }"
              />
            </view>
            <text class="result__score-value">{{ row.score }}</text>
          </view>
          <text class="result__section-hint">
            分数接近的几项同样重要；最靠后的那项不是"不在乎"，而是不如前几项能让你确定被爱。
          </text>
        </view>

        <!-- 冲突风格：完整五种，主导项高亮 -->
        <view class="card result__section">
          <text class="result__section-title"> 有分歧时，你偏向「{{ conflictStyleLabel ?? '待生成' }}」 </text>
          <view v-for="row in conflictRows" :key="row.code" class="result__score-row">
            <text class="result__score-label" :class="{ 'is-primary': row.isPrimary }">
              {{ row.label }}{{ row.isPrimary ? ' · 主导' : '' }}
            </text>
            <view class="result__score-track">
              <view
                class="result__score-fill"
                :class="{ 'is-primary': row.isPrimary }"
                :style="{ width: `${row.score}%` }"
              />
            </view>
            <text class="result__score-value">{{ row.score }}</text>
          </view>
        </view>
      </template>

      <!--
        心理健康支路（ADR-038 阶段 4）
        它的交付物是**一段文字结论**，因此版式与另两条支路不同：
        结论排在六维之前 —— 用户最先要读到的是"这段话"，分数是它的依据。
      -->
      <template v-else-if="isMentalHealth">
        <view class="result__hero">
          <text class="result__label">你近期的状态</text>
          <text class="result__emotion-style">{{ mentalHealth?.result.overallLabel ?? '待生成' }}</text>
          <text class="result__summary">基于你本次的自我报告 · 仅供参考，不构成心理诊断</text>
        </view>

        <view v-if="qualityNotice" class="result__notice card">
          <text class="result__notice-text">{{ qualityNotice }}</text>
        </view>

        <!--
          文字结论 + 去污名化的一句（本模块的核心交付物，由**服务端**规则生成）

          用户的实测反馈是「看不出个所以然来」—— 只给分数与档位是"有数字没有含义"。
          这里先给结论，再紧跟一句"这很常见、不是你的性格问题"：
          自评结果最容易造出的副作用是"我是不是有问题"，市面上的产品几乎都会在同一屏里
          放一句这样的话。
        -->
        <view v-if="mentalHealth?.result.conclusion" class="card result__section">
          <text class="result__section-title">给你的结论</text>
          <text class="result__conclusion">{{ mentalHealth.result.conclusion }}</text>
          <text v-if="mentalHealthReport?.endorsement" class="result__endorsement">
            {{ mentalHealthReport.endorsement }}
          </text>
        </view>

        <!--
          最值得留意的 1–2 项：**大卡片**
          六条分数平铺时用户读完记不住任何一条；这里先把重点单独抬出来。
        -->
        <view v-if="(mentalHealthReport?.highlights ?? []).length > 0" class="result__highlights">
          <text class="result__highlights-title">最值得留意的是</text>
          <view v-for="item in mentalHealthReport?.highlights ?? []" :key="item.key" class="card result__highlight">
            <view class="result__highlight-head">
              <text class="result__highlight-name">{{ item.label }}</text>
              <text class="result__highlight-band">{{ item.bandLabel }} · {{ item.score }}</text>
            </view>
            <text class="result__highlight-meaning">{{ item.meaning }}</text>
            <text class="result__highlight-common">{{ item.commonExperience }}</text>
          </view>
        </view>

        <!--
          三条当天就能做的小事（**建议必须具体**）
          每条写清三件事：做什么 / 为什么有用 / 什么时候做 —— 只写"多休息"等于没写。
        -->
        <view v-if="(mentalHealthReport?.suggestions ?? []).length > 0" class="card result__section">
          <text class="result__section-title">这周可以试试的三件事</text>
          <view v-for="(item, index) in mentalHealthReport?.suggestions ?? []" :key="index" class="result__advice-item">
            <text class="result__advice-index">{{ index + 1 }}</text>
            <view class="result__advice-body">
              <text class="result__advice-action">{{ item.action }}</text>
              <text class="result__advice-why">{{ item.reason }}</text>
              <view class="result__advice-meta">
                <text class="result__advice-when">什么时候做：{{ item.when }}</text>
                <text class="result__advice-from">针对：{{ item.dimensionLabel }}</text>
              </view>
            </view>
          </view>
        </view>

        <!--
          什么时候找人聊聊（**三档都给**，含官方热线）
          这是"建设性"里最重要的一条：自评的意义不只是让人知道自己怎么了，
          还要知道什么时候该找专业帮助、去哪里找。热线号码由服务端下发，前端不硬编码。
        -->
        <view v-if="mentalHealthReport?.support" class="card result__section result__support">
          <text class="result__section-title">{{ mentalHealthReport.support.title }}</text>
          <text class="result__support-text">{{ mentalHealthReport.support.text }}</text>
          <view class="result__hotline" @tap="callHotline">
            <view class="result__hotline-body">
              <text class="result__hotline-name">{{ mentalHealthReport.support.hotline.name }}</text>
              <text class="result__hotline-note">{{ mentalHealthReport.support.hotline.note }}</text>
            </view>
            <text class="result__hotline-number">{{ mentalHealthReport.support.hotline.number }}</text>
          </view>
        </view>

        <!-- 六个维度：完整得分 + 每维一句人话 -->
        <view class="card result__section">
          <text class="result__section-title">六个维度的得分</text>
          <view v-for="item in mentalHealthDimensions" :key="item.key" class="result__score-row">
            <text class="result__score-label" :class="{ 'is-primary': item.isHighlighted }">
              {{ item.label }}{{ item.isHighlighted ? ' · 值得留意' : '' }}
            </text>
            <view class="result__score-track">
              <view
                class="result__score-fill"
                :class="{ 'is-primary': item.isHighlighted }"
                :style="{ width: `${item.score}%` }"
              />
            </view>
            <text class="result__score-value">{{ item.score }}</text>
          </view>
          <text class="result__section-hint"> 分数越高表示这一项越值得留意。六项一起看，比单看某一项更有意义。 </text>

          <!-- 每维一句人话：分数有了，含义也要有 -->
          <view class="result__reading-list">
            <view v-for="item in mentalHealthReport?.readings ?? []" :key="item.key" class="result__reading">
              <text class="result__reading-title">{{ item.label }}</text>
              <text class="result__reading-text">{{ item.meaning }}</text>
            </view>
          </view>
        </view>

        <!-- 复测引导：单次分数只是快照，趋势才有意义 -->
        <view v-if="mentalHealthReport?.retestHint" class="card result__section result__retest">
          <text class="result__retest-text">{{ mentalHealthReport.retestHint }}</text>
        </view>

        <!-- 免责声明：由服务端下发，前端只负责展示 -->
        <view v-if="mentalHealth?.result.disclaimer" class="card result__section result__disclaimer">
          <text class="result__disclaimer-text">{{ mentalHealth.result.disclaimer }}</text>
        </view>
      </template>

      <template v-else>
        <view class="result__hero">
          <text class="result__label">你的人格类型</text>
          <view class="result__letters">
            <text v-for="(letter, index) in mbtiLetters" :key="index" class="result__letter">{{ letter }}</text>
          </view>
          <text class="result__summary">
            {{ mbtiType ?? '待生成' }} · 结果置信度 {{ (summary?.confidence ?? 0).toFixed(0) }}% · 仅供自我探索参考
          </text>
        </view>

        <!-- 结果提示（阈值由服务端统一控制） -->
        <view v-if="qualityNotice" class="result__notice card">
          <text class="result__notice-text">{{ qualityNotice }}</text>
        </view>

        <!-- 四维倾向 -->
        <view class="card result__section">
          <text class="result__section-title">四个维度的倾向</text>
          <view v-for="bar in dimensionBars" :key="bar.key" class="result__dimension">
            <view class="result__dimension-head">
              <text class="result__dimension-label">{{ bar.label }}</text>
              <text class="result__dimension-value">{{ bar.percent.toFixed(0) }}%</text>
            </view>
            <view class="result__dimension-bar">
              <view class="result__dimension-left" :style="{ width: `${bar.negativeWidth}%` }">
                <text class="result__dimension-side">{{ bar.negative }}</text>
              </view>
              <view class="result__dimension-right" :style="{ width: `${bar.positiveWidth}%` }">
                <text class="result__dimension-side">{{ bar.positive }}</text>
              </view>
            </view>
            <view class="result__dimension-legend">
              <text>{{ bar.negativeLabel }}</text>
              <text>{{ bar.positiveLabel }}</text>
            </view>
          </view>
        </view>

        <!-- Big Five 雷达图 -->
        <view class="card result__section">
          <text class="result__section-title">大五人格特质</text>
          <RadarChart :dimensions="radarDimensions" :size="560" />
          <view class="result__bigfive-list">
            <view v-for="item in radarDimensions" :key="item.key" class="result__bigfive-item">
              <text class="result__bigfive-label">{{ item.label }}</text>
              <text class="result__bigfive-value">{{ item.value.toFixed(0) }}</text>
            </view>
          </view>
        </view>
      </template>

      <SafetyDisclaimer variant="reportFooter" display="block" />

      <!-- 失败/超时提示：把原因说清楚，并给出可执行的下一步，而不是只让按钮转圈 -->
      <view v-if="generateError" class="card result__error">
        <text class="result__error-text">{{ generateError }}</text>
        <button class="result__error-action" @tap="goMyReportDetail">查看报告详情</button>
      </view>

      <!--
        「接下来可以做什么」——
        拿到结果页之后用户往往不知道下一步干嘛，这里把三条最自然的动线摆出来，
        而不是只留一个孤零零的按钮。
      -->
      <view class="card result__section">
        <text class="result__section-title">接下来可以做什么</text>

        <!--
          「生成深度报告」只在**有 AI 报告**的模块里出现（`hasReport`）。
          心理健康模块整条不渲染：它的交付物就是上面那段服务端下发的结论，
          再让模型解读一遍必然滑向建议 —— 而那正是该模块的红线。
        -->
        <view v-if="hasReport" class="result__next-item" @tap="generateReport">
          <text class="result__next-icon">📄</text>
          <view class="result__next-body">
            <text class="result__next-title">生成深度报告</text>
            <text class="result__next-desc">AI 逐段解读你的画像、关系模式与成长建议</text>
          </view>
          <text class="result__next-arrow">›</text>
        </view>

        <view class="result__next-item" @tap="goChat">
          <text class="result__next-icon">💬</text>
          <view class="result__next-body">
            <text class="result__next-title">和 AI 管家聊聊（会员）</text>
            <text class="result__next-desc">带着你三个模块的测评结果，一起把结论梳理清楚</text>
          </view>
          <text class="result__next-arrow">›</text>
        </view>

        <view class="result__next-item" @tap="goRetake">
          <text class="result__next-icon">🔁</text>
          <view class="result__next-body">
            <text class="result__next-title">过段时间再测一次</text>
            <text class="result__next-desc">画像会随状态变化，多次测评能看出趋势</text>
          </view>
          <text class="result__next-arrow">›</text>
        </view>

        <view class="result__next-item" @tap="goHome">
          <text class="result__next-icon">🏠</text>
          <view class="result__next-body">
            <text class="result__next-title">回到首页</text>
            <text class="result__next-desc">看看还有哪些测评与内容</text>
          </view>
          <text class="result__next-arrow">›</text>
        </view>
      </view>

      <!-- 底部行动（固定） -->
      <view class="result__footer">
        <button class="result__button-ghost" @tap="goReportList">我的报告</button>
        <!--
          有报告的模块给「生成深度报告」，没有的（心理健康）给「再测一次」——
          底部按钮的位置不能空着，但也不能放一个点了报错的按钮
        -->
        <button v-if="hasReport" class="result__button" :disabled="generating" @tap="generateReport">
          {{ generating ? generatingText : '生成深度报告' }}
        </button>
        <button v-else class="result__button" @tap="goRetake">过段时间再测一次</button>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.result {
  min-height: 100vh;
  padding: $space-lg $space-lg 200rpx;
  background: linear-gradient(180deg, $color-primary-fade 0%, $color-bg-page 400rpx);

  &__hero {
    padding: $space-xl 0;
    text-align: center;
  }

  /** 情感与心理健康两条支路的"大字结论"共用一种排版（都是"一句话结论"型结果） */
  &__emotion-style {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-xxl;
    font-weight: $font-weight-bold;
    color: $color-primary;
  }

  /** 心理健康的文字结论（服务端下发，整段展示） */
  &__conclusion {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-base;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  // ------------------------------------------------- 心理状态：解读层（2026-10-16）
  /**
   * 去污名化的一句
   *
   * 自评结果最容易造出的副作用是"我是不是有问题"。这句话的位置有讲究：
   * 必须紧跟在结论之后（用户刚读完"你有几项比较突出"的那一刻），
   * 而不是藏在页面底部 —— 藏起来就等于没写。
   */
  &__endorsement {
    display: block;
    padding: $space-md;
    margin-top: $space-md;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
    background-color: $color-primary-fade;
    border-radius: $radius-md;
  }

  &__highlights {
    margin-bottom: $space-md;
  }

  &__highlights-title {
    display: block;
    margin-bottom: $space-sm;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  /** 重点项大卡片：六条分数平铺时用户记不住任何一条，先把重点抬出来 */
  &__highlight {
    margin-bottom: $space-sm;
    border-left: 8rpx solid $color-secondary;
  }

  &__highlight-head {
    @include flex-between;
  }

  &__highlight-name {
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__highlight-band {
    font-size: $font-size-sm;
    color: $color-secondary;
  }

  &__highlight-meaning {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__highlight-common {
    display: block;
    padding-left: $space-md;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
    border-left: 4rpx solid $color-border-strong;
  }

  /** 建议卡：做什么（加粗）+ 为什么 + 什么时候做 */
  &__advice-item {
    display: flex;
    align-items: flex-start;
    margin-top: $space-md;
  }

  &__advice-body {
    flex: 1;
  }

  &__advice-action {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-medium;
    line-height: $line-height-base;
    color: $color-text-primary;
  }

  &__advice-why {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__advice-meta {
    display: flex;
    flex-wrap: wrap;
    margin-top: $space-xs;
  }

  &__advice-when,
  &__advice-from {
    padding: 2rpx $space-xs;
    margin-right: $space-xs;
    font-size: $font-size-xs;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-xs;
  }

  &__advice-from {
    color: $color-text-secondary;
    background-color: $color-bg-hover;
  }

  /** 求助卡：整个块在视觉上要和"建议"区分开（它的分量更重） */
  &__support {
    border: 2rpx solid $color-secondary-fade;
    background-color: $color-secondary-fade;
  }

  &__support-text {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__hotline {
    @include flex-between;
    padding: $space-md;
    margin-top: $space-md;
    background-color: $color-bg-card;
    border-radius: $radius-md;
  }

  &__hotline-body {
    flex: 1;
    margin-right: $space-sm;
  }

  &__hotline-name {
    display: block;
    font-size: $font-size-sm;
    font-weight: $font-weight-medium;
  }

  &__hotline-note {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__hotline-number {
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    color: $color-secondary;
  }

  /** 每维一句人话（分数有了，含义也要有） */
  &__reading-list {
    padding-top: $space-md;
    margin-top: $space-md;
    border-top: 2rpx solid $color-divider;
  }

  &__reading {
    margin-bottom: $space-md;
  }

  &__reading-title {
    display: block;
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
  }

  &__reading-text {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  /** 复测引导：单次分数只是快照 */
  &__retest {
    background-color: transparent;
    border: 2rpx dashed $color-border-strong;
    box-shadow: none;
  }

  &__retest-text {
    display: block;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  /** 免责声明：弱化但不隐藏（合规文案必须可读） */
  &__disclaimer {
    background-color: transparent;
    border: 2rpx solid $color-border;
  }

  &__disclaimer-text {
    display: block;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__label {
    display: block;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__letters {
    @include flex-center;
    gap: $space-sm;
    margin-top: $space-md;
  }

  &__letter {
    @include flex-center;
    width: 104rpx;
    height: 128rpx;
    font-size: 64rpx;
    font-weight: $font-weight-bold;
    color: $color-text-inverse;
    background: linear-gradient(160deg, $color-primary-light, $color-primary);
    border-radius: $radius-lg;
    box-shadow: $shadow-primary;
  }

  &__summary {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__notice {
    margin-bottom: $space-md;
    background-color: rgba(245, 158, 11, 0.08);
  }

  &__notice-text {
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: #92400e;
  }

  &__section {
    margin-bottom: $space-md;
  }

  &__section-title {
    display: block;
    margin-bottom: $space-md;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  /**
   * 结论区（ADR-039 补）
   *
   * 与下面的"分数区"刻意做出**层级差别**：结论卡片更大、更靠前、字号更高 ——
   * 用户先读到"你是什么样、需要什么"，再看分数是怎么来的。
   * 反过来（先一堆分数）正是这次被用户指出"不知道想表达什么"的原因。
   */
  &__verdict {
    background: linear-gradient(135deg, $color-primary-fade 0%, $color-bg-card 70%);
    border: 2rpx solid rgba(91, 75, 224, 0.18);
  }

  &__verdict-headline {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    line-height: $line-height-base;
    color: $color-text-primary;
  }

  &__verdict-text {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-base;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__need {
    background-color: $color-primary-fade;
  }

  &__bullet {
    display: flex;
    align-items: flex-start;
    margin-bottom: $space-xs;
  }

  &__bullet-dot {
    margin-right: $space-xs;
    font-size: $font-size-base;
    color: $color-primary;
  }

  &__bullet-text {
    flex: 1;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__advice-item {
    display: flex;
    align-items: flex-start;
    margin-bottom: $space-md;
  }

  &__advice-index {
    @include flex-center;
    flex-shrink: 0;
    width: 40rpx;
    height: 40rpx;
    margin-right: $space-sm;
    font-size: $font-size-xs;
    font-weight: $font-weight-semibold;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: 50%;
  }

  &__advice-text {
    flex: 1;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__advice-note {
    display: block;
    margin-top: $space-md;
    padding-top: $space-sm;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-placeholder;
    border-top: 1rpx solid $color-divider;
  }

  &__dimension {
    margin-bottom: $space-lg;
  }

  &__dimension-head {
    @include flex-between;
    margin-bottom: $space-xs;
  }

  &__dimension-label {
    font-size: $font-size-sm;
    color: $color-text-regular;
  }

  &__dimension-value {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    color: $color-primary;
  }

  &__dimension-bar {
    display: flex;
    overflow: hidden;
    height: 28rpx;
    border-radius: $radius-round;
  }

  &__dimension-left {
    @include flex-center;
    justify-content: flex-start;
    padding-left: $space-xs;
    background-color: $color-border;
    transition: width 0.3s ease;
  }

  &__dimension-right {
    @include flex-center;
    justify-content: flex-end;
    padding-right: $space-xs;
    background: linear-gradient(90deg, $color-primary-light, $color-primary);
    transition: width 0.3s ease;
  }

  &__dimension-side {
    font-size: $font-size-xs;
    font-weight: $font-weight-semibold;
    color: $color-text-inverse;
  }

  &__dimension-legend {
    @include flex-between;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__bigfive-list {
    margin-top: $space-md;
  }

  &__bigfive-item {
    @include flex-between;
    padding: $space-xs 0;
    border-bottom: 1rpx solid $color-divider;
  }

  &__bigfive-label {
    font-size: $font-size-sm;
    color: $color-text-regular;
  }

  &__bigfive-value {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    color: $color-primary;
  }

  &__footer {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    gap: $space-sm;
    padding: $space-md $space-lg;

    @include safe-area-padding-bottom($space-md);

    background-color: $color-bg-card;
    box-shadow: 0 -4rpx 20rpx rgba(31, 31, 46, 0.06);
  }

  &__button-ghost {
    flex: 1;
    height: 88rpx;
    font-size: $font-size-base;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  &__button {
    flex: 2;

    @include button-primary;
  }

  // ---------------------------------------------------------------- 自定义导航栏
  /**
   * 本页 `navigationStyle: custom`，系统不提供导航栏与返回按钮。
   * 顶部内边距由模板按 `statusBarHeight` 动态设置，这里只负责高度与排版。
   */
  &__navbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: $navbar-height;
    margin: -$space-lg -$space-lg 0;
    padding-right: $space-lg;
    padding-left: $space-lg;
  }

  &__navbar-back {
    @include flex-center;

    width: 64rpx;
    height: 64rpx;
  }

  // 占位：让标题在视觉上居中（左右各一个等宽元素）
  &__navbar-back--placeholder {
    opacity: 0;
  }

  &__navbar-back-icon {
    font-size: 48rpx;
    line-height: 1;
    color: $color-text-primary;
  }

  &__navbar-title {
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
    color: $color-text-primary;
  }

  // ---------------------------------------------------------------- 生成失败提示
  &__error {
    margin-bottom: $space-md;
    background-color: rgba(239, 68, 68, 0.06);
  }

  &__error-text {
    display: block;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: #b91c1c;
  }

  &__error-action {
    height: 64rpx;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  // ---------------------------------------------------------------- 下一步动向
  &__next-item {
    display: flex;
    align-items: center;
    gap: $space-md;
    padding: $space-md 0;
    border-bottom: 1rpx solid $color-divider;

    &:last-child {
      border-bottom: none;
    }
  }

  &__next-icon {
    font-size: 40rpx;
  }

  &__next-body {
    flex: 1;
  }

  &__next-title {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-semibold;
    color: $color-text-primary;
  }

  &__next-desc {
    display: block;
    margin-top: 4rpx;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__next-arrow {
    font-size: 40rpx;
    color: $color-text-placeholder;
  }

  // ---------------------------------------------------------------- 空态补充按钮
  &__state-action--ghost {
    margin-top: $space-sm;
    color: $color-text-secondary;
    background-color: $color-bg-page;
  }
}
</style>
