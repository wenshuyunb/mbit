<script setup lang="ts">
/**
 * 报告正文的**段落卡**（一针见血 + 想细读再展开）
 *
 * ## 它解决什么
 *
 * 改造前，每一段都是「标题 + 一整段正文」直接铺开：实测那份情感报告 6 段 3706 字，
 * 「五条建议」一段就有 968 字。用户的原话是「哇，全是字，我是用户我看都不想看，
 * 累不累啊，最好是图文并茂，一针见血」。
 *
 * 这个组件把每段重新排成三件事：
 *
 *   ① **首句放大**（模板要求每段首句直接给结论，因此这句话就是该段的答案）；
 *   ② **其余内容默认折叠**，点「展开全文」再看 —— 想看细节的人一个字都不少，
 *      不想看的人不会被压住；
 *   ③ 「五条建议」拆成 5 张编号卡、「两周行动」拆成两块 —— 这两段本来就有结构，
 *      铺成散文最浪费。
 *
 * ## 为什么折叠而不是删减
 *
 * 报告是用户花了额度生成的**交付物**，字数本身是价值（上一轮用户刚抱怨过"信息也不多"）。
 * 因此这里只改**阅读路径**：默认给结论，深读给全文。
 */

import { computed, ref } from 'vue';

import type { ReportSection } from '@/api/report';
import { buildSectionLayout } from '@/pkgReport/report-content';

const props = defineProps<{
  section: ReportSection;
  /** 段落序号（从 1 开始，用于左侧徽章） */
  index: number;
}>();

const layout = computed(() => buildSectionLayout(props.section.sectionKey, props.section.content ?? ''));

const expanded = ref(false);

/**
 * 「建议」段的正文是不是三件事都写全了
 *
 * 模板要求每条建议写清"做什么 + 为什么有效 + 怎么算做到"。这里只做**展示层**的
 * 轻量提示（把三件事各自换成一个小标签），不做校验 —— 模型偶尔少写一项时，
 * 卡片照样渲染，只是标签少一个。
 */
const LABELS = ['具体做什么', '为什么有效', '怎么算做到了'] as const;

/** 把一条建议切成「做法 / 原因 / 自检」三段（切不出来就整块显示） */
const splitAdvice = (body: string): Array<{ label: string; text: string }> => {
  const positions = LABELS.map((label) => ({ label, at: body.indexOf(label) })).filter((item) => item.at >= 0);

  if (positions.length === 0) return [{ label: '', text: body }];

  const parts: Array<{ label: string; text: string }> = [];

  // 序号后面的第一句是"标题"，不属于任何标签
  const firstAt = positions[0]?.at ?? 0;
  const head = body.slice(0, firstAt).trim();
  if (head.length > 0) parts.push({ label: '', text: head });

  positions.forEach((item, index) => {
    const next = positions[index + 1];
    const end = next === undefined ? body.length : next.at;
    // 去掉"具体做什么："这个前缀本身，避免标签出现两遍
    const raw = body.slice(item.at + item.label.length, end).replace(/^[:：]\s*/, '');

    parts.push({ label: item.label, text: raw.trim() });
  });

  return parts.filter((part) => part.text.length > 0);
};

const hasBody = computed(() => layout.value.paragraphs.length > 0);

/**
 * 是否显示"首句放大"
 *
 * ⚠ 建议段与行动段**不显示**：那两段的版式是卡片/分周块，而它们的首句
 * 恰好就是第一张卡片的标题（"1. 想确认关系的时候……"）或第一周的开头
 * （"第一周，做三件小事。"）—— 再放大一次就是同一句话说两遍，
 * 页面反而更累。这是纯展示取舍，`layout.lead` 本身照常返回（供别处复用）。
 */
const showLead = computed(
  () => layout.value.lead.length > 0 && layout.value.cards.length === 0 && layout.value.weeks.length === 0,
);
</script>

<template>
  <view class="section card">
    <!-- 段首：序号徽章 + 标题 -->
    <view class="section__head">
      <text class="section__index">{{ index }}</text>
      <text class="section__title">{{ section.title }}</text>
    </view>

    <!-- 未解锁：服务端不下发正文（只给引导与字数，不做假模糊） -->
    <view v-if="!section.content" class="section__locked">
      <text class="section__locked-text">{{ section.lockedHint ?? '解锁后可查看本段内容' }}</text>
      <text class="section__locked-count">约 {{ section.contentLength }} 字</text>
    </view>

    <template v-else>
      <!-- ① 一针见血：首句放大（建议段/行动段有自己的卡片版式，不重复说一遍） -->
      <text v-if="showLead" class="section__lead">{{ layout.lead }}</text>

      <!-- ② 建议段：编号卡（每条建议一张，三件事各带小标签） -->
      <view v-if="layout.cards.length > 0" class="section__cards">
        <view v-for="card in layout.cards" :key="card.index" class="section__advice">
          <view class="section__advice-head">
            <text class="section__advice-index">{{ card.index }}</text>
            <text class="section__advice-title">{{ card.title }}</text>
          </view>
          <view v-for="(part, partIndex) in splitAdvice(card.body)" :key="partIndex" class="section__advice-part">
            <text v-if="part.label" class="section__advice-label">{{ part.label }}</text>
            <text class="section__advice-text">{{ part.text }}</text>
          </view>
        </view>
      </view>

      <!-- ③ 行动段：两周两块 -->
      <view v-else-if="layout.weeks.length > 0" class="section__weeks">
        <view v-for="week in layout.weeks" :key="week.label" class="section__week">
          <text class="section__week-label">{{ week.label }}</text>
          <text class="section__week-text">{{ week.text }}</text>
        </view>
      </view>

      <!-- ④ 其余段落：默认折叠，展开后逐段显示 -->
      <view v-if="hasBody" class="section__body">
        <view
          v-for="(paragraph, paragraphIndex) in layout.paragraphs"
          :key="paragraphIndex"
          class="section__paragraph-wrap"
        >
          <text class="section__paragraph" :class="{ 'is-clamped': !expanded && paragraphIndex > 0 }">
            {{ paragraph }}
          </text>
        </view>

        <text v-if="!expanded" class="section__more" @tap="expanded = true">
          展开全文（还有 {{ layout.paragraphs.length }} 段 · 共 {{ layout.charCount }} 字）
        </text>
        <text v-else class="section__more" @tap="expanded = false">收起</text>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.section {
  margin-bottom: $space-md;

  &__head {
    @include flex-center(row);
    justify-content: flex-start;
  }

  &__index {
    @include flex-center;
    flex-shrink: 0;
    width: 40rpx;
    height: 40rpx;
    margin-right: $space-sm;
    font-size: $font-size-xs;
    font-weight: $font-weight-bold;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;
  }

  &__title {
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  /* 一针见血：这一段最该被看见的一句话 */
  &__lead {
    display: block;
    padding-left: $space-md;
    margin-top: $space-md;
    font-size: $font-size-md;
    font-weight: $font-weight-medium;
    line-height: $line-height-base;
    color: $color-text-primary;
    border-left: 6rpx solid $color-secondary;
  }

  &__body {
    margin-top: $space-md;
  }

  &__paragraph-wrap {
    margin-bottom: $space-sm;
  }

  &__paragraph {
    display: block;
    font-size: $font-size-base;
    line-height: $line-height-loose;
    color: $color-text-regular;

    /* 折叠态：只留第一段，其余收到 2 行 —— 想读全文的人点一下就有 */
    &.is-clamped {
      @include text-ellipsis-multi(2);
    }
  }

  &__more {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-primary;
  }

  /* ---------------------------------------------------------- 建议卡 */
  &__cards {
    margin-top: $space-md;
  }

  &__advice {
    padding: $space-md;
    margin-bottom: $space-sm;
    background-color: $color-bg-hover;
    border-radius: $radius-md;
  }

  &__advice-head {
    @include flex-center(row);
    justify-content: flex-start;
  }

  &__advice-index {
    @include flex-center;
    flex-shrink: 0;
    width: 36rpx;
    height: 36rpx;
    margin-right: $space-sm;
    font-size: $font-size-xs;
    font-weight: $font-weight-bold;
    color: $color-text-inverse;
    background-color: $color-secondary;
    border-radius: $radius-round;
  }

  &__advice-title {
    flex: 1;
    font-size: $font-size-base;
    font-weight: $font-weight-medium;
    line-height: $line-height-base;
  }

  &__advice-part {
    margin-top: $space-sm;
  }

  &__advice-label {
    display: inline-block;
    padding: 0 $space-xs;
    margin-bottom: $space-xxs;
    font-size: $font-size-xs;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-xs;
  }

  &__advice-text {
    display: block;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  /* ---------------------------------------------------------- 两周行动 */
  &__weeks {
    margin-top: $space-md;
  }

  &__week {
    padding: $space-md;
    margin-bottom: $space-sm;
    background-color: $color-bg-hover;
    border-radius: $radius-md;
  }

  &__week-label {
    display: block;
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    color: $color-primary;
  }

  &__week-text {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  /* ---------------------------------------------------------- 未解锁 */
  &__locked {
    padding: $space-md;
    margin-top: $space-md;
    text-align: center;
    background-color: $color-bg-hover;
    border-radius: $radius-md;
  }

  &__locked-text {
    display: block;
    font-size: $font-size-sm;
    color: $color-secondary;
  }

  &__locked-count {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }
}
</style>
