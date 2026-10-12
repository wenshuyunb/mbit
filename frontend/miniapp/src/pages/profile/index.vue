<script setup lang="ts">
/**
 * 我的（主包，tabBar 页面）
 *
 * 承载：用户资料、会员入口、隐私与合规入口、账号注销入口
 *
 * Phase 0 状态：结构完整；头像昵称使用微信新版授权能力
 *               （button open-type="chooseAvatar" / input type="nickname"），
 *               Phase 1 接入上传 OSS 与 PATCH /users/me。
 */

import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { useAppStore } from '@/store/app';
import { useAuthStore } from '@/store/auth';
import { confirm } from '@/utils/toast';

const authStore = useAuthStore();
const appStore = useAppStore();

/** 昵称编辑态 */
const editingNickname = ref(false);
const nicknameDraft = ref('');
/** 头像本地临时路径（chooseAvatar 返回） */
const avatarTempPath = ref('');

const membershipText = computed(() => {
  if (!authStore.userInfo) return '未登录';
  return authStore.isMember ? '会员生效中' : '未开通会员';
});

const membershipExpireText = computed(() => {
  const expiresAt = authStore.userInfo?.membership.expiresAt;
  if (!expiresAt) return '';
  return `有效期至 ${expiresAt.slice(0, 10)}`;
});

const menuGroups = computed(() => [
  {
    title: '我的服务',
    items: [
      { key: 'member', label: '会员中心', desc: membershipText.value, url: '/pkgMember/pages/index' },
      { key: 'reports', label: '我的报告', desc: '查看历史报告', url: '/pages/report/list' },
      { key: 'relationships', label: '我的关系', desc: '情侣 / 朋友匹配记录', url: '/pkgMatch/pages/invite' },
    ],
  },
  {
    title: '隐私与合规',
    items: [
      { key: 'agreement', label: '用户协议', desc: '', url: '/pkgWebview/pages/agreement' },
      { key: 'privacy', label: '隐私政策', desc: '', url: '/pkgWebview/pages/privacy' },
      { key: 'export', label: '导出我的数据', desc: '获取个人数据副本', url: '' },
      { key: 'deletion', label: '注销账号', desc: '删除账号与个人数据', url: '' },
    ],
  },
]);

const goTo = (url: string): void => {
  if (!url) return;
  uni.navigateTo({ url });
};

/** 选择头像（微信新版能力，无需 getUserProfile） */
const onChooseAvatar = (event: { detail: { avatarUrl: string } }): void => {
  avatarTempPath.value = event.detail.avatarUrl;
  // Phase 1：上传到 OSS（storage/upload-ticket）→ PATCH /users/me { avatarKey }
  uni.showToast({ title: '头像上传将在 Phase 1 接入', icon: 'none' });
};

const startEditNickname = (): void => {
  nicknameDraft.value = authStore.userInfo?.nickname ?? '';
  editingNickname.value = true;
};

const saveNickname = (): void => {
  const value = nicknameDraft.value.trim();
  if (value.length === 0) {
    uni.showToast({ title: '昵称不能为空', icon: 'none' });
    return;
  }
  // Phase 1：PATCH /users/me { nickname }
  authStore.patchUserInfo({ nickname: value });
  editingNickname.value = false;
  uni.showToast({ title: '已保存', icon: 'success' });
};

/** 账号注销（需二次确认，服务端有冷静期） */
const requestDeletion = async (): Promise<void> => {
  const ok = await confirm({
    title: '注销账号',
    content: '注销后你的测试记录、人格画像与 AI 对话将被删除，且不可恢复。确定继续吗？',
    confirmText: '继续注销',
    confirmColor: '#EF4444',
  });
  if (!ok) return;
  // Phase 1：POST /users/me/deletion（含冷静期）
  uni.showToast({ title: '注销流程将在 Phase 1 接入', icon: 'none' });
};

const requestExport = (): void => {
  // Phase 1：POST /users/me/export → 轮询任务 → 返回 OSS 签名下载链接
  uni.showToast({ title: '数据导出将在 Phase 1 接入', icon: 'none' });
};

const handleLogout = async (): Promise<void> => {
  const ok = await confirm({ content: '确定要退出登录吗？' });
  if (!ok) return;
  await authStore.logout();
  uni.showToast({ title: '已退出登录', icon: 'none' });
};

const onMenuTap = (key: string, url: string): void => {
  if (key === 'deletion') {
    void requestDeletion();
    return;
  }
  if (key === 'export') {
    requestExport();
    return;
  }
  goTo(url);
};

onShow(() => {
  if (authStore.isLoggedIn) {
    void authStore.fetchUserInfo().catch(() => undefined);
  }
});
</script>

<template>
  <view class="profile">
    <!-- 用户卡片 -->
    <view class="profile__card card">
      <button class="profile__avatar-button" open-type="chooseAvatar" @chooseavatar="onChooseAvatar">
        <image
          v-if="authStore.userInfo?.avatarUrl || avatarTempPath"
          class="profile__avatar"
          :src="avatarTempPath || authStore.userInfo?.avatarUrl || ''"
          mode="aspectFill"
        />
        <view v-else class="profile__avatar profile__avatar--placeholder">
          <text>{{ authStore.displayName.slice(0, 1) }}</text>
        </view>
      </button>

      <view class="profile__info">
        <view v-if="!editingNickname" class="profile__name-row" @tap="startEditNickname">
          <text class="profile__name">{{ authStore.displayName }}</text>
          <text class="profile__edit">编辑</text>
        </view>
        <view v-else class="profile__name-edit">
          <input
            v-model="nicknameDraft"
            class="profile__name-input"
            type="nickname"
            placeholder="请输入昵称"
            maxlength="20"
          />
          <text class="profile__name-save" @tap="saveNickname">保存</text>
        </view>

        <text class="profile__membership">{{ membershipText }} {{ membershipExpireText }}</text>
      </view>
    </view>

    <!-- 菜单分组 -->
    <view v-for="group in menuGroups" :key="group.title" class="profile__group">
      <text class="profile__group-title">{{ group.title }}</text>
      <view class="profile__group-body card">
        <view
          v-for="(item, index) in group.items"
          :key="item.key"
          :class="['profile__menu-item', { 'is-danger': item.key === 'deletion' }]"
          @tap="onMenuTap(item.key, item.url)"
        >
          <view class="profile__menu-text">
            <text class="profile__menu-label">{{ item.label }}</text>
            <text v-if="item.desc" class="profile__menu-desc">{{ item.desc }}</text>
          </view>
          <text class="profile__menu-arrow">›</text>
          <view v-if="index < group.items.length - 1" class="profile__menu-divider" />
        </view>
      </view>
    </view>

    <button v-if="authStore.isLoggedIn" class="profile__logout" @tap="handleLogout">退出登录</button>

    <text class="profile__version">版本 1.0.0 · {{ appStore.systemConfig.version }}</text>
  </view>
</template>

<style lang="scss" scoped>
.profile {
  min-height: 100vh;
  padding: $space-lg $space-lg $space-xxl;

  &__card {
    display: flex;
    align-items: center;
    gap: $space-md;
  }

  &__avatar-button {
    width: 128rpx;
    height: 128rpx;
    overflow: hidden;
    border-radius: $radius-round;
  }

  &__avatar {
    width: 128rpx;
    height: 128rpx;
    border-radius: $radius-round;

    &--placeholder {
      @include flex-center;
      font-size: $font-size-xl;
      font-weight: $font-weight-bold;
      color: $color-text-inverse;
      background: linear-gradient(135deg, $color-primary-light, $color-primary);
    }
  }

  &__info {
    flex: 1;
  }

  &__name-row {
    display: flex;
    align-items: center;
    gap: $space-xs;
  }

  &__name {
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
  }

  &__edit {
    font-size: $font-size-xs;
    color: $color-primary;
  }

  &__name-edit {
    display: flex;
    align-items: center;
    gap: $space-sm;
  }

  &__name-input {
    flex: 1;
    padding: $space-xs $space-sm;
    font-size: $font-size-base;
    background-color: $color-bg-hover;
    border-radius: $radius-sm;
  }

  &__name-save {
    font-size: $font-size-sm;
    color: $color-primary;
  }

  &__membership {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__group {
    margin-top: $space-lg;
  }

  &__group-title {
    display: block;
    margin-bottom: $space-sm;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__group-body {
    padding: 0 $space-lg;
  }

  &__menu-item {
    position: relative;
    @include flex-between;
    padding: $space-md 0;

    &:active {
      background-color: $color-bg-hover;
    }

    &.is-danger .profile__menu-label {
      color: $color-danger;
    }
  }

  &__menu-text {
    flex: 1;
  }

  &__menu-label {
    font-size: $font-size-base;
  }

  &__menu-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__menu-arrow {
    font-size: $font-size-lg;
    color: $color-text-placeholder;
  }

  &__menu-divider {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 1rpx;
    background-color: $color-divider;
  }

  &__logout {
    margin-top: $space-xl;
    font-size: $font-size-base;
    color: $color-text-secondary;
  }

  &__version {
    display: block;
    margin-top: $space-lg;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
    text-align: center;
  }
}
</style>
