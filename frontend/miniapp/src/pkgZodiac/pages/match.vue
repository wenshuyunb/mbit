<script setup lang="ts">
/**
 * 星座配对（分包 pkgZodiac）
 *
 * ⚠ 它的措辞边界很关键：这里描述的是**两种星座文化性格的相处特点**，
 * 不判断任何一段具体关系是否合适。因此结果文案里没有"你们应该在一起/不合适"，
 * 只有"沟通方式 / 相处氛围 / 长期节奏"三个维度的相处基调与一句具体建议。
 * 后端接口文档里也写明了这一条（`GET /zodiac/match`）。
 *
 * 默认把"我"预设成账号里的星座（进来就能直接看自己 × 对方），
 * 但两个选择器都可改 —— 用户常常是想看朋友的组合。
 */

import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import {
  getMyZodiac,
  getZodiacMatch,
  listZodiacProfiles,
  type ZodiacMatch,
  type ZodiacProfile,
  type ZodiacSign,
} from '@/api/zodiac';

const profiles = ref<ZodiacProfile[]>([]);
const mine = ref<ZodiacSign | null>(null);
const peer = ref<ZodiacSign | null>(null);
const result = ref<ZodiacMatch | null>(null);
const loading = ref(true);
const matching = ref(false);

/** 选择器的选项（`range-key` 用 name，模板里传对象数组） */
const nameOf = (sign: ZodiacSign | null): string => profiles.value.find((item) => item.sign === sign)?.name ?? '请选择';

const mineIndex = computed(() => profiles.value.findIndex((item) => item.sign === mine.value));
const peerIndex = computed(() => profiles.value.findIndex((item) => item.sign === peer.value));

const starsOf = (stars: number): string => '★'.repeat(Math.max(0, Math.min(5, stars)));

onLoad(async () => {
  try {
    profiles.value = await listZodiacProfiles();

    // 有生日就预设成自己的星座；没有生日也不拦着（这页允许随便选两个星座看）
    try {
      const me = await getMyZodiac();
      mine.value = me.sign;
    } catch {
      /* 未设置生日：留空由用户选 */
    }
  } catch (error) {
    console.error('[zodiac] 配对页加载失败：', error);
  } finally {
    loading.value = false;
  }
});

const onMineChange = (event: { detail: { value: number } }): void => {
  mine.value = profiles.value[Number(event.detail.value)]?.sign ?? null;
};

const onPeerChange = (event: { detail: { value: number } }): void => {
  peer.value = profiles.value[Number(event.detail.value)]?.sign ?? null;
};

const runMatch = async (): Promise<void> => {
  if (mine.value === null || peer.value === null) {
    uni.showToast({ title: '请先选择两个星座', icon: 'none' });
    return;
  }

  matching.value = true;
  try {
    result.value = await getZodiacMatch(mine.value, peer.value);
  } catch (error) {
    console.error('[zodiac] 配对失败：', error);
    uni.showToast({ title: '计算失败，请稍后再试', icon: 'none' });
  } finally {
    matching.value = false;
  }
};
</script>

<template>
  <view class="match page-container">
    <view v-if="loading" class="card match__state">
      <text>加载中…</text>
    </view>

    <template v-else>
      <view class="card match__pickers">
        <view class="match__picker-row">
          <text class="match__picker-label">我</text>
          <picker
            class="match__picker"
            mode="selector"
            :range="profiles"
            range-key="name"
            :value="mineIndex < 0 ? 0 : mineIndex"
            @change="onMineChange"
          >
            <view class="match__picker-value">{{ nameOf(mine) }} ›</view>
          </picker>
        </view>

        <view class="match__picker-row">
          <text class="match__picker-label">对方</text>
          <picker
            class="match__picker"
            mode="selector"
            :range="profiles"
            range-key="name"
            :value="peerIndex < 0 ? 0 : peerIndex"
            @change="onPeerChange"
          >
            <view class="match__picker-value">{{ nameOf(peer) }} ›</view>
          </picker>
        </view>

        <button class="match__button" :disabled="matching" @tap="runMatch">看看相处基调</button>
      </view>

      <template v-if="result">
        <view class="card match__score">
          <text class="match__score-value">{{ result.score }}</text>
          <text class="match__score-label">{{ result.levelLabel }}</text>
          <text class="match__score-pair">{{ result.a.name }} × {{ result.b.name }}</text>
        </view>

        <view class="card match__block">
          <text class="match__block-title">相处基调</text>
          <text class="match__block-text">{{ result.elementNote }}</text>
        </view>

        <view class="card match__block">
          <text class="match__block-title">三个维度</text>
          <view v-for="item in result.dimensions" :key="item.key" class="match__dimension">
            <view class="match__dimension-head">
              <text class="match__dimension-label">{{ item.label }}</text>
              <text class="match__dimension-stars">{{ starsOf(item.stars) }}</text>
            </view>
            <text class="match__dimension-line">{{ item.line }}</text>
          </view>
        </view>

        <view class="card match__advice">
          <text class="match__advice-text">{{ result.advice }}</text>
        </view>

        <view class="card match__disclaimer">
          <text class="match__disclaimer-text">{{ result.disclaimer }}</text>
        </view>
      </template>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.match {
  &__state {
    text-align: center;
  }

  &__picker-row {
    @include flex-between;
    padding: $space-md 0;
    border-bottom: 2rpx solid $color-divider;
  }

  &__picker-label {
    font-size: $font-size-base;
    color: $color-text-secondary;
  }

  &__picker-value {
    font-size: $font-size-base;
    font-weight: $font-weight-medium;
  }

  &__button {
    margin-top: $space-lg;

    @include button-primary;
  }

  &__score {
    margin-top: $space-md;
    text-align: center;
  }

  &__score-value {
    display: block;
    font-size: $font-size-display;
    font-weight: $font-weight-bold;
    color: $color-primary;
  }

  &__score-label {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__score-pair {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__block {
    margin-top: $space-md;
  }

  &__block-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__block-text {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__dimension {
    margin-top: $space-md;
  }

  &__dimension-head {
    @include flex-between;
  }

  &__dimension-label {
    font-size: $font-size-base;
  }

  &__dimension-stars {
    font-size: $font-size-base;
    color: $color-secondary;
  }

  &__dimension-line {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__advice {
    margin-top: $space-md;
    background-color: $color-primary-fade;
    box-shadow: none;
  }

  &__advice-text {
    display: block;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-primary-dark;
  }

  &__disclaimer {
    margin-top: $space-md;
    background-color: transparent;
    border: 2rpx solid $color-border;
  }

  &__disclaimer-text {
    display: block;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }
}
</style>
