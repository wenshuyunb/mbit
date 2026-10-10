<script setup lang="ts">
/**
 * 邀请页（分包 pkgMatch）
 *
 * 流程（架构文档 §12.1）：选择关系类型 → 生成邀请码与小程序码 → 分享给 TA →
 * TA 完成测试并接受 → 关系建立 → 触发匹配报告生成
 *
 * Phase 0 状态：页面结构与状态完整；Phase 4 接入 relationshipApi。
 */

import { computed, ref } from 'vue';
import { onLoad, onShareAppMessage } from '@dcloudio/uni-app';

import EmptyState from '@/components/EmptyState.vue';
import { RELATION_TYPES, type RelationType } from '@/config/constants';
import { formatRelativeTime } from '@/utils/format';

const relationType = ref<RelationType>('COUPLE');
const inviteCode = ref('');
const qrCodeUrl = ref('');
const creating = ref(false);

/** 已建立的关系列表（Phase 4 接入真实数据） */
const relationships = ref<
  Array<{
    id: string;
    relationType: RelationType;
    status: string;
    peerName: string;
    peerMbti: string | null;
    createdAt: string;
  }>
>([]);

const selectedType = computed(() => RELATION_TYPES.find((item) => item.value === relationType.value));

/** 扫码进入时携带的 scene（被邀请方视角） */
const sceneCode = ref('');

onLoad((query) => {
  const scene = query?.['scene'];
  if (typeof scene === 'string' && scene.length > 0) {
    sceneCode.value = decodeURIComponent(scene);
    // Phase 4：acceptInvite(sceneCode)
  }
});

/** 生成邀请（含小程序码） */
const createInvite = async (): Promise<void> => {
  if (creating.value) return;
  creating.value = true;

  try {
    // Phase 4：const invite = await relationshipApi.createInvite(relationType.value)
    uni.showToast({ title: '邀请生成将在 Phase 4 接入', icon: 'none' });
  } finally {
    creating.value = false;
  }
};

/** 保存小程序码到相册 */
const saveQrCode = (): void => {
  if (!qrCodeUrl.value) return;
  uni.downloadFile({
    url: qrCodeUrl.value,
    success: (res) => {
      uni.saveImageToPhotosAlbum({
        filePath: res.tempFilePath,
        success: () => uni.showToast({ title: '已保存到相册', icon: 'success' }),
        fail: () => uni.showToast({ title: '保存失败，请检查相册权限', icon: 'none' }),
      });
    },
    fail: () => uni.showToast({ title: '图片下载失败', icon: 'none' }),
  });
};

const goResult = (id: string): void => {
  uni.navigateTo({ url: `/pkgMatch/pages/result?relationshipId=${id}` });
};

onShareAppMessage(() => ({
  title: `我想和你一起做个人格匹配测试（${selectedType.value?.label ?? ''}）`,
  path: `/pkgMatch/pages/invite?scene=${inviteCode.value}`,
}));
</script>

<template>
  <view class="invite page-container">
    <!-- 关系类型选择 -->
    <view class="card invite__types">
      <text class="invite__section-title">选择关系类型</text>
      <view class="invite__type-list">
        <view
          v-for="item in RELATION_TYPES"
          :key="item.value"
          :class="['invite__type', { 'is-active': relationType === item.value }]"
          @tap="relationType = item.value"
        >
          <text class="invite__type-label">{{ item.label }}</text>
          <text class="invite__type-desc">{{ item.description }}</text>
        </view>
      </view>
    </view>

    <!-- 生成邀请 -->
    <view class="card invite__create">
      <text class="invite__section-title">邀请 TA 一起测试</text>
      <text class="invite__hint"> 对方扫码完成人格测试后，系统会基于你们双方的人格画像生成专属的关系匹配报告。 </text>

      <template v-if="qrCodeUrl">
        <image class="invite__qr" :src="qrCodeUrl" mode="aspectFit" />
        <view class="invite__qr-actions">
          <button class="invite__qr-button" open-type="share">分享给 TA</button>
          <button class="invite__qr-button invite__qr-button--ghost" @tap="saveQrCode">保存图片</button>
        </view>
      </template>

      <button v-else class="invite__create-button" :disabled="creating" @tap="createInvite">
        {{ creating ? '正在生成邀请…' : '生成专属邀请码' }}
      </button>
    </view>

    <!-- 已有的关系 -->
    <view class="invite__relationships">
      <text class="invite__section-title">我的关系</text>

      <view v-if="relationships.length > 0">
        <view v-for="item in relationships" :key="item.id" class="card invite__relationship" @tap="goResult(item.id)">
          <view class="invite__relationship-info">
            <text class="invite__relationship-name">{{ item.peerName }}</text>
            <text class="invite__relationship-meta">
              {{ item.peerMbti ?? '待测试' }} · {{ formatRelativeTime(item.createdAt) }}
            </text>
          </view>
          <text class="invite__relationship-status">{{ item.status === 'ACTIVE' ? '查看报告' : '待确认' }}</text>
        </view>
      </view>

      <EmptyState v-else icon="💞" title="还没有关系记录" description="生成邀请码分享给 TA，一起看看你们的相处模式" />
    </view>
  </view>
</template>

<style lang="scss" scoped>
.invite {
  &__section-title {
    display: block;
    margin-bottom: $space-md;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__types {
    margin-bottom: $space-md;
  }

  &__type-list {
    display: flex;
    gap: $space-sm;
  }

  &__type {
    flex: 1;
    padding: $space-md $space-sm;
    text-align: center;
    border: 2rpx solid $color-border;
    border-radius: $radius-md;

    &.is-active {
      background-color: $color-primary-fade;
      border-color: $color-primary;
    }
  }

  &__type-label {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-semibold;
  }

  &__type-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__create {
    margin-bottom: $space-md;
  }

  &__hint {
    display: block;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__create-button {
    margin-top: $space-md;

    @include button-primary;
  }

  &__qr {
    width: 420rpx;
    height: 420rpx;
    margin: $space-md auto 0;
  }

  &__qr-actions {
    display: flex;
    gap: $space-sm;
    margin-top: $space-md;
  }

  &__qr-button {
    flex: 1;
    height: 80rpx;
    font-size: $font-size-base;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;

    &--ghost {
      color: $color-primary;
      background-color: $color-primary-fade;
    }
  }

  &__relationship {
    @include flex-between;
    margin-bottom: $space-sm;

    &:active {
      background-color: $color-bg-hover;
    }
  }

  &__relationship-name {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-semibold;
  }

  &__relationship-meta {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__relationship-status {
    font-size: $font-size-sm;
    color: $color-primary;
  }
}
</style>
