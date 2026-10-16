<script setup lang="ts">
/**
 * 十二星座档案（分包 pkgZodiac）
 *
 * ⚠ 这里的文案是**文化常识**，不是预测：日期区间、元素、守护星、性格倾向、
 * 优势与需要留意的地方。页面上不放"运势"字样 —— 想看运势请回上一页。
 *
 * 交互取舍：列表 + 点开看详情（同一页内的展开，不跳第三个页面）。
 * 十二个星座的档案内容不短，做成十二个页面既没必要，也会让返回键变得很绕。
 */

import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { listZodiacProfiles, type ZodiacProfile } from '@/api/zodiac';

const profiles = ref<ZodiacProfile[]>([]);
const loading = ref(true);
const loadError = ref('');
/** 展开的星座（一次只展开一个：同时展开两份档案会让人找不到自己在读哪一份） */
const expanded = ref<string | null>(null);

/** 按元素分组展示（火/土/风/水是星座最经典的分组方式） */
const grouped = computed(() => {
  const order = ['FIRE', 'EARTH', 'AIR', 'WATER'] as const;

  return order
    .map((element) => ({
      element,
      label: profiles.value.find((item) => item.element === element)?.elementLabel ?? element,
      description: profiles.value.find((item) => item.element === element)?.elementDescription ?? '',
      items: profiles.value.filter((item) => item.element === element),
    }))
    .filter((group) => group.items.length > 0);
});

onLoad(async () => {
  try {
    profiles.value = await listZodiacProfiles();
  } catch (error) {
    console.error('[zodiac] 星座档案加载失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
});

const toggle = (sign: string): void => {
  expanded.value = expanded.value === sign ? null : sign;
};
</script>

<template>
  <view class="signs page-container">
    <view v-if="loading" class="card signs__state">
      <text>加载中…</text>
    </view>

    <view v-else-if="loadError" class="card signs__state">
      <text>{{ loadError }}</text>
    </view>

    <template v-else>
      <view class="signs__intro">
        <text class="signs__intro-title">十二星座档案</text>
        <text class="signs__intro-desc">
          十二星座来自四大元素的划分，代表四种不同的行事风格。这里写的是各星座常见的性格倾向与相处特点。
        </text>
      </view>

      <view v-for="group in grouped" :key="group.element" class="signs__group">
        <view class="signs__group-head">
          <text class="signs__group-title">{{ group.label }}</text>
          <text class="signs__group-desc">{{ group.description }}</text>
        </view>

        <view v-for="item in group.items" :key="item.sign" class="card signs__item" @tap="toggle(item.sign)">
          <view class="signs__item-head">
            <view class="signs__item-name">
              <text class="signs__item-cn">{{ item.name }}</text>
              <text class="signs__item-en">{{ item.englishName }}</text>
            </view>
            <text class="signs__item-range">{{ item.dateRange }}</text>
          </view>

          <view class="signs__traits">
            <text v-for="trait in item.traits" :key="trait" class="signs__trait">{{ trait }}</text>
          </view>

          <template v-if="expanded === item.sign">
            <text class="signs__field-title">性格倾向</text>
            <text class="signs__field-text">{{ item.personality }}</text>

            <text class="signs__field-title">在关系里</text>
            <text class="signs__field-text">{{ item.love }}</text>

            <text class="signs__field-title">做事方式</text>
            <text class="signs__field-text">{{ item.career }}</text>

            <text class="signs__field-title">和朋友相处</text>
            <text class="signs__field-text">{{ item.friendship }}</text>

            <text class="signs__field-title">擅长的地方</text>
            <view v-for="row in item.strengths" :key="row" class="signs__bullet">
              <text class="signs__bullet-dot">·</text>
              <text class="signs__bullet-text">{{ row }}</text>
            </view>

            <text class="signs__field-title">需要留意的地方</text>
            <view v-for="row in item.watchouts" :key="row" class="signs__bullet">
              <text class="signs__bullet-dot">·</text>
              <text class="signs__bullet-text">{{ row }}</text>
            </view>

            <text class="signs__meta">守护星：{{ item.ruler }} · {{ item.elementLabel }}</text>
            <text class="signs__collapse" @tap.stop="toggle(item.sign)">收起</text>
          </template>

          <text v-else class="signs__expand">展开看完整档案 ›</text>
        </view>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.signs {
  &__state {
    text-align: center;
  }

  &__intro {
    padding: $space-lg 0;
  }

  &__intro-title {
    display: block;
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
  }

  &__intro-desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__group {
    margin-bottom: $space-lg;
  }

  &__group-head {
    margin-bottom: $space-sm;
  }

  &__group-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__group-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__item {
    margin-bottom: $space-sm;
  }

  &__item-head {
    @include flex-between;
  }

  &__item-name {
    @include flex-center(row);
    justify-content: flex-start;
  }

  &__item-cn {
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__item-en {
    margin-left: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__item-range {
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__traits {
    display: flex;
    flex-wrap: wrap;
    margin-top: $space-sm;
  }

  &__trait {
    padding: 2rpx $space-sm;
    margin: 0 $space-xs $space-xs 0;
    font-size: $font-size-xs;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  &__field-title {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
  }

  &__field-text {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__bullet {
    display: flex;
    align-items: flex-start;
    margin-top: $space-xs;
  }

  &__bullet-dot {
    margin-right: $space-xs;
    color: $color-primary;
  }

  &__bullet-text {
    flex: 1;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-regular;
  }

  &__meta {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__expand,
  &__collapse {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-xs;
    color: $color-primary;
  }
}
</style>
