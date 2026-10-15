<script setup lang="ts">
/**
 * 报告详情页的**画像数据卡**（条形图）
 *
 * ## 它解决什么
 *
 * 用户的实测反馈：「点开一看，哇，全是字，我是用户我看都不想看，累不累啊，
 * 最好是图文并茂，一针见血」。
 *
 * 报告正文里其实写满了数字（"焦虑轴 52、回避轴 0""身体的接触 63、精心的时刻 62"
 * "服务的行动 5"），但全埋在段落里。这个组件把同一批数字画成条形图，
 * 放在正文之前：**一眼看到自己是哪一种、两条轴各在哪儿、最在意什么。**
 *
 * ## 两条表达原则
 *
 * ① **不给数字配"好/坏"的评价**：条只表示"你在这条轴上的位置"，
 *    不写"偏高要注意"这类判断 —— 心理测量里没有客观的好坏方向
 *    （参见 `config/constants.ts` 里神经质那条"分数越低越稳定"的中性说明）。
 * ② **标识符与中文名分离**：编码（`LOVE_TOUCH`）来自服务端，
 *    中文名一律取自 `config/modules.ts` 的标签表 —— 服务端不发标签，
 *    两处各存一份迟早会分叉。
 */

import { computed } from 'vue';

import type { ReportProfileSnapshot } from '@/api/report';
import { BIG_FIVE_DIMENSIONS, MBTI_DIMENSIONS } from '@/config/constants';
import {
  ATTACHMENT_STYLE_LABELS,
  CONFLICT_STYLE_LABELS,
  CONFLICT_STYLE_ORDER,
  LOVE_LANGUAGE_LABELS,
  LOVE_LANGUAGE_ORDER,
} from '@/config/modules';

const props = defineProps<{
  /** 生成这份报告时用的画像数值；无画像（关系/成长报告）时为 `null` */
  snapshot: ReportProfileSnapshot | null;
}>();

/** 百分比取整后夹在 0–100：脏数据不许把条画到框外面 */
const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) return 0;

  return Math.min(100, Math.max(0, Math.round(value)));
};

// ------------------------------------------------------------------ 情感：依恋双轴

const attachment = computed(() => {
  if (props.snapshot?.kind !== 'EMOTION') return null;

  return {
    label: ATTACHMENT_STYLE_LABELS[props.snapshot.attachmentStyle] ?? props.snapshot.attachmentStyle,
    anxiety: clampPercent(props.snapshot.attachmentAnxiety),
    avoidance: clampPercent(props.snapshot.attachmentAvoidance),
    thresholdAnxiety: clampPercent(props.snapshot.thresholds.anxiety),
    thresholdAvoidance: clampPercent(props.snapshot.thresholds.avoidance),
  };
});

// ------------------------------------------------------------------ 情感：爱的语言

/**
 * 五项爱的语言（固定顺序，不按分数排序）
 *
 * 固定顺序让同一份画像每次渲染的行序一致；"哪一项主导"由高亮体现，不靠位置 ——
 * 顺序跳动会让用户以为数据变了（结果页也是这个口径）。
 */
const loveLanguages = computed(() => {
  if (props.snapshot?.kind !== 'EMOTION') return [];

  const scores = props.snapshot.loveLanguageScores;
  const primary = new Set(props.snapshot.primaryLoveLanguages);

  return LOVE_LANGUAGE_ORDER.map((code) => ({
    code,
    label: LOVE_LANGUAGE_LABELS[code] ?? code,
    score: clampPercent(scores[code] ?? 0),
    isPrimary: primary.has(code),
  }));
});

/** 分数最低的一项：用户最该知道"这一项替代不了你要的那个确认" */
const lowestLoveLanguage = computed(() => {
  const rows = loveLanguages.value;
  if (rows.length === 0) return null;

  return rows.reduce((lowest, row) => (row.score < lowest.score ? row : lowest), rows[0]);
});

// ------------------------------------------------------------------ 情感：冲突风格

const conflict = computed(() => {
  if (props.snapshot?.kind !== 'EMOTION') return null;

  const scores = props.snapshot.conflictScores;
  const style = props.snapshot.conflictStyle;

  return {
    label: CONFLICT_STYLE_LABELS[style] ?? style,
    rows: CONFLICT_STYLE_ORDER.map((code) => ({
      code,
      label: CONFLICT_STYLE_LABELS[code] ?? code,
      score: clampPercent(scores[code] ?? 0),
      isPrimary: style === code,
    })),
  };
});

// ------------------------------------------------------------------ 人格：四维与大五

/** MBTI 四维：双向条（左极 / 右极都要画出来，"偏向哪边"才看得出来） */
const mbtiDimensions = computed(() => {
  if (props.snapshot?.kind !== 'PERSONALITY') return [];

  return MBTI_DIMENSIONS.map((dimension) => {
    const percent = clampPercent(
      props.snapshot?.kind === 'PERSONALITY' ? (props.snapshot.dimensions[dimension.key] ?? 50) : 50,
    );

    return {
      key: dimension.key,
      label: dimension.label,
      positiveLetter: dimension.positive,
      negativeLetter: dimension.negative,
      positiveLabel: dimension.positiveLabel,
      negativeLabel: dimension.negativeLabel,
      /** ≥ 50 偏向正极字母（E / S / T / J） */
      percent,
      activeLetter: percent >= 50 ? dimension.positive : dimension.negative,
      activeLabel: percent >= 50 ? dimension.positiveLabel : dimension.negativeLabel,
      /** 偏向正极时条从中间往右画，偏向负极时往左画 */
      leftWidth: percent >= 50 ? 100 - percent : percent,
      rightWidth: percent >= 50 ? percent : 100 - percent,
      isPositive: percent >= 50,
    };
  });
});

const bigFive = computed(() => {
  if (props.snapshot?.kind !== 'PERSONALITY') return [];

  return BIG_FIVE_DIMENSIONS.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    description: dimension.description,
    score: clampPercent(props.snapshot?.kind === 'PERSONALITY' ? (props.snapshot.bigFive[dimension.key] ?? 0) : 0),
  }));
});

const isEmotion = computed(() => props.snapshot?.kind === 'EMOTION');
const isPersonality = computed(() => props.snapshot?.kind === 'PERSONALITY');
</script>

<template>
  <view v-if="isEmotion && attachment" class="chart">
    <!-- 依恋：类型 + 两条轴（带判定中线） -->
    <view class="card chart__block">
      <text class="chart__title">你在亲密关系里的依恋风格</text>
      <view class="chart__badge">
        <text class="chart__badge-text">{{ attachment.label }}</text>
      </view>

      <view class="chart__axis">
        <view class="chart__axis-head">
          <text class="chart__axis-label">焦虑倾向</text>
          <text class="chart__axis-value">{{ attachment.anxiety }}</text>
        </view>
        <view class="chart__track">
          <view class="chart__fill" :style="{ width: `${attachment.anxiety}%` }" />
          <view class="chart__marker" :style="{ left: `${attachment.thresholdAnxiety}%` }" />
        </view>
        <text class="chart__axis-hint">越高越容易担心对方是不是同样在意自己</text>
      </view>

      <view class="chart__axis">
        <view class="chart__axis-head">
          <text class="chart__axis-label">回避倾向</text>
          <text class="chart__axis-value">{{ attachment.avoidance }}</text>
        </view>
        <view class="chart__track">
          <view class="chart__fill chart__fill--secondary" :style="{ width: `${attachment.avoidance}%` }" />
          <view class="chart__marker" :style="{ left: `${attachment.thresholdAvoidance}%` }" />
        </view>
        <text class="chart__axis-hint">越高越习惯自己扛、不太愿意把脆弱说出口</text>
      </view>

      <text class="chart__footnote">竖线是判定中线，两侧求交得出你的依恋类型</text>
    </view>

    <!-- 爱的语言：五项全画，主导项高亮 -->
    <view class="card chart__block">
      <text class="chart__title">你最在意的被爱方式</text>
      <view v-for="row in loveLanguages" :key="row.code" class="chart__row">
        <text
          class="chart__row-label"
          :class="{ 'is-primary': row.isPrimary, 'is-lowest': lowestLoveLanguage?.code === row.code && !row.isPrimary }"
        >
          {{ row.label }}{{ row.isPrimary ? ' · 主导' : '' }}
        </text>
        <view class="chart__track chart__track--slim">
          <view
            class="chart__fill"
            :class="{ 'chart__fill--primary': row.isPrimary, 'chart__fill--muted': !row.isPrimary }"
            :style="{ width: `${row.score}%` }"
          />
        </view>
        <text class="chart__row-value">{{ row.score }}</text>
      </view>
      <text v-if="lowestLoveLanguage" class="chart__footnote">
        「{{ lowestLoveLanguage.label }}」{{ lowestLoveLanguage.score }} 分不是"不在乎"，而是它替代不了你要的那个确认。
      </text>
    </view>

    <!-- 冲突风格：主导项 + 完整分布 -->
    <view v-if="conflict" class="card chart__block">
      <text class="chart__title">有分歧时，你偏向「{{ conflict.label }}」</text>
      <view v-for="row in conflict.rows" :key="row.code" class="chart__row">
        <text class="chart__row-label" :class="{ 'is-primary': row.isPrimary }">
          {{ row.label }}{{ row.isPrimary ? ' · 主导' : '' }}
        </text>
        <view class="chart__track chart__track--slim">
          <view
            class="chart__fill"
            :class="{ 'chart__fill--primary': row.isPrimary, 'chart__fill--muted': !row.isPrimary }"
            :style="{ width: `${row.score}%` }"
          />
        </view>
        <text class="chart__row-value">{{ row.score }}</text>
      </view>
    </view>
  </view>

  <view v-else-if="isPersonality" class="chart">
    <!-- MBTI 四维：双向条 -->
    <view class="card chart__block">
      <text class="chart__title">四个维度上的你</text>
      <view v-for="row in mbtiDimensions" :key="row.key" class="chart__dimension">
        <view class="chart__dimension-head">
          <text class="chart__dimension-side" :class="{ 'is-active': !row.isPositive }">
            {{ row.negativeLetter }} {{ row.negativeLabel }}
          </text>
          <text class="chart__dimension-label">{{ row.label }}</text>
          <text class="chart__dimension-side" :class="{ 'is-active': row.isPositive }">
            {{ row.positiveLabel }} {{ row.positiveLetter }}
          </text>
        </view>
        <view class="chart__split">
          <view class="chart__split-half chart__split-half--left">
            <view class="chart__split-fill chart__split-fill--left" :style="{ width: `${row.leftWidth}%` }" />
          </view>
          <view class="chart__split-half chart__split-half--right">
            <view class="chart__split-fill chart__split-fill--right" :style="{ width: `${row.rightWidth}%` }" />
          </view>
        </view>
      </view>
    </view>

    <!-- 大五 -->
    <view class="card chart__block">
      <text class="chart__title">五个特质上的你</text>
      <view v-for="row in bigFive" :key="row.key" class="chart__row">
        <text class="chart__row-label">{{ row.label }}</text>
        <view class="chart__track chart__track--slim">
          <view class="chart__fill chart__fill--muted" :style="{ width: `${row.score}%` }" />
        </view>
        <text class="chart__row-value">{{ row.score }}</text>
      </view>
      <text class="chart__footnote">分数是位置，不是评价；心理测量里没有"越高越好"这回事。</text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.chart {
  &__block {
    margin-bottom: $space-md;
  }

  &__title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  /* 类型徽章：整页最想被一眼看到的那个词 */
  &__badge {
    display: inline-block;
    padding: $space-xs $space-md;
    margin-top: $space-sm;
    background: linear-gradient(135deg, $color-primary-light 0%, $color-primary 100%);
    border-radius: $radius-round;
    box-shadow: $shadow-primary;
  }

  &__badge-text {
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    color: $color-text-inverse;
  }

  &__axis {
    margin-top: $space-lg;
  }

  &__axis-head {
    @include flex-between;
  }

  &__axis-label {
    font-size: $font-size-base;
    color: $color-text-regular;
  }

  &__axis-value {
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    color: $color-primary;
  }

  &__axis-hint {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__track {
    position: relative;
    overflow: hidden;
    height: 24rpx;
    margin-top: $space-sm;
    background-color: $color-bg-hover;
    border-radius: $radius-round;

    &--slim {
      height: 16rpx;
      margin-top: 0;
    }
  }

  &__fill {
    height: 100%;
    background: linear-gradient(90deg, $color-primary-light, $color-primary);
    border-radius: $radius-round;
    transition: width 0.4s ease;

    &--secondary {
      background: linear-gradient(90deg, $color-secondary-light, $color-secondary);
    }

    &--primary {
      background: linear-gradient(90deg, $color-secondary-light, $color-secondary);
    }

    &--muted {
      background: $color-border-strong;
    }
  }

  /* 阈值中线：让"52 分算高还是低"有参照 */
  &__marker {
    position: absolute;
    top: 0;
    width: 4rpx;
    height: 100%;
    background-color: $color-text-secondary;
    opacity: 0.5;
  }

  &__row {
    @include flex-center(row);
    margin-top: $space-md;
  }

  &__row-label {
    width: 220rpx;
    font-size: $font-size-sm;
    color: $color-text-regular;

    &.is-primary {
      font-weight: $font-weight-semibold;
      color: $color-secondary;
    }

    &.is-lowest {
      color: $color-text-placeholder;
    }
  }

  &__row-value {
    width: 60rpx;
    font-size: $font-size-sm;
    color: $color-text-secondary;
    text-align: right;
  }

  &__row .chart__track {
    flex: 1;
    margin-right: $space-sm;
  }

  &__footnote {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-placeholder;
  }

  /* ---------------------------------------------------------- 四维双向条 */
  &__dimension {
    margin-top: $space-lg;
  }

  &__dimension-head {
    @include flex-between;
  }

  &__dimension-label {
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__dimension-side {
    font-size: $font-size-sm;
    color: $color-text-placeholder;

    &.is-active {
      font-weight: $font-weight-semibold;
      color: $color-primary;
    }
  }

  &__split {
    display: flex;
    height: 16rpx;
    margin-top: $space-xs;
    background-color: $color-bg-hover;
    border-radius: $radius-round;
  }

  &__split-half {
    display: flex;
    width: 50%;

    &--left {
      justify-content: flex-end;
    }

    &--right {
      justify-content: flex-start;
    }
  }

  &__split-fill {
    height: 100%;

    &--left {
      background: linear-gradient(270deg, $color-primary-light, $color-primary);
      border-radius: $radius-round 0 0 $radius-round;
    }

    &--right {
      background: linear-gradient(90deg, $color-primary-light, $color-primary);
      border-radius: 0 $radius-round $radius-round 0;
    }
  }
}
</style>
