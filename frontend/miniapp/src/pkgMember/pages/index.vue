<script setup lang="ts">
/**
 * 会员中心（分包 pkgMember）
 *
 * 关键设计（架构文档 §13）：
 *   · 价格与套餐完全由服务端下发（GET /membership/plans），前端不硬编码
 *   · 支付成功 ≠ 权益到账，必须以服务端订单状态 / 权益查询为准
 *   · 下单必须携带幂等键；支付返回后调用查单接口做补偿对账
 *
 * Phase 0 状态：页面骨架、套餐卡片、权益说明就绪；Phase 6 接入支付全链路。
 */

import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { useAuthStore } from '@/store/auth';
import { formatPrice } from '@/utils/format';
import type { MembershipPlan } from '@/api/membership';

const authStore = useAuthStore();

const plans = ref<MembershipPlan[]>([]);
const selectedCode = ref('');
const paying = ref(false);
const loading = ref(false);

const selectedPlan = computed(() => plans.value.find((plan) => plan.code === selectedCode.value) ?? null);

const membershipStatusText = computed(() => {
  if (authStore.isMember) {
    const expiresAt = authStore.userInfo?.membership.expiresAt;
    return expiresAt ? `会员有效至 ${expiresAt.slice(0, 10)}` : '会员生效中';
  }
  return '尚未开通会员';
});

/** 统一的会员权益说明（正式环境应由套餐 benefits 字段下发） */
const commonBenefits = [
  'AI 情感助手不限次对话',
  '深度报告不限次重新生成',
  '报告 PDF 导出与保存',
  '历史人格数据与成长曲线',
  '关系档案不限数量',
];

onShow(() => {
  void loadPlans();
});

const loadPlans = async (): Promise<void> => {
  loading.value = true;
  try {
    // Phase 6：const list = await membershipApi.listPlans()
    const list: MembershipPlan[] = [];
    plans.value = list;
    if (list.length > 0 && selectedCode.value === '') {
      const recommended = list.find((plan) => plan.recommended) ?? list[0];
      selectedCode.value = recommended?.code ?? '';
    }
  } finally {
    loading.value = false;
  }
};

/**
 * 购买套餐
 * 完整流程（Phase 6）：
 *   ① orderApi.createOrder({ productCode, idempotencyKey }) → 拿到 wx.requestPayment 参数
 *   ② uni.requestPayment(...)
 *   ③ orderApi.queryOrder(orderId) 主动查单（补偿微信回调延迟/丢失）
 *   ④ 以服务端 order.fulfilled 为准刷新会员状态
 */
const purchase = async (): Promise<void> => {
  if (!selectedPlan.value || paying.value) return;

  if (!authStore.isLoggedIn) {
    uni.showToast({ title: '请先登录', icon: 'none' });
    return;
  }

  paying.value = true;
  try {
    uni.showToast({ title: '支付功能将在 Phase 6 接入', icon: 'none' });
  } finally {
    paying.value = false;
  }
};
</script>

<template>
  <view class="member page-container">
    <!-- 当前状态 -->
    <view class="member__status card">
      <text class="member__status-title">{{ membershipStatusText }}</text>
      <text class="member__status-desc">解锁全部 AI 能力，让成长有迹可循</text>
    </view>

    <!-- 权益说明 -->
    <view class="card member__benefits">
      <text class="member__section-title">会员权益</text>
      <view v-for="benefit in commonBenefits" :key="benefit" class="member__benefit">
        <text class="member__benefit-check">✓</text>
        <text class="member__benefit-text">{{ benefit }}</text>
      </view>
    </view>

    <!-- 套餐选择 -->
    <view class="member__plans">
      <text class="member__section-title member__section-title--outside">选择套餐</text>

      <view v-if="plans.length > 0" class="member__plan-list">
        <view
          v-for="plan in plans"
          :key="plan.code"
          :class="['member__plan card', { 'is-active': selectedCode === plan.code }]"
          @tap="selectedCode = plan.code"
        >
          <view v-if="plan.recommended" class="member__plan-badge">推荐</view>
          <text class="member__plan-name">{{ plan.name }}</text>
          <view class="member__plan-price">
            <text class="member__plan-current">{{ formatPrice(plan.priceAmount) }}</text>
            <text v-if="plan.originalAmount" class="member__plan-original">
              {{ formatPrice(plan.originalAmount) }}
            </text>
          </view>
          <text class="member__plan-desc">{{ plan.description }}</text>
        </view>
      </view>

      <view v-else class="card member__empty">
        <text>{{ loading ? '套餐加载中…' : '暂无可用套餐，请稍后再试' }}</text>
      </view>
    </view>

    <!-- 底部购买 -->
    <view class="member__footer">
      <view class="member__footer-price">
        <text class="member__footer-label">应付</text>
        <text class="member__footer-amount">
          {{ selectedPlan ? formatPrice(selectedPlan.priceAmount) : '—' }}
        </text>
      </view>
      <button class="member__pay" :disabled="!selectedPlan || paying" @tap="purchase">
        {{ paying ? '支付中…' : authStore.isMember ? '续费' : '立即开通' }}
      </button>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.member {
  padding-bottom: 220rpx;

  &__status {
    margin-bottom: $space-md;
    background: linear-gradient(135deg, $color-primary-light 0%, $color-primary 100%);
  }

  &__status-title {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
    color: $color-text-inverse;
  }

  &__status-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-sm;
    color: rgba(255, 255, 255, 0.85);
  }

  &__benefits {
    margin-bottom: $space-md;
  }

  &__section-title {
    display: block;
    margin-bottom: $space-md;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;

    &--outside {
      margin-bottom: $space-sm;
    }
  }

  &__benefit {
    display: flex;
    gap: $space-sm;
    margin-bottom: $space-sm;
  }

  &__benefit-check {
    color: $color-success;
  }

  &__benefit-text {
    flex: 1;
    font-size: $font-size-sm;
    color: $color-text-regular;
  }

  &__plan-list {
    display: flex;
    gap: $space-sm;
  }

  &__plan {
    position: relative;
    flex: 1;
    text-align: center;
    border: 2rpx solid $color-border;

    &.is-active {
      background-color: $color-primary-fade;
      border-color: $color-primary;
    }
  }

  &__plan-badge {
    position: absolute;
    top: -2rpx;
    right: -2rpx;
    padding: 4rpx 12rpx;
    font-size: $font-size-xs;
    color: $color-text-inverse;
    background-color: $color-secondary;
    border-radius: 0 $radius-lg 0 $radius-lg;
  }

  &__plan-name {
    display: block;
    font-size: $font-size-base;
    font-weight: $font-weight-semibold;
  }

  &__plan-price {
    margin-top: $space-sm;
  }

  &__plan-current {
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    color: $color-primary;
  }

  &__plan-original {
    margin-left: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
    text-decoration: line-through;
  }

  &__plan-desc {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__empty {
    font-size: $font-size-sm;
    color: $color-text-secondary;
    text-align: center;
  }

  &__footer {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: $space-md;
    padding: $space-md $space-lg;

    @include safe-area-padding-bottom($space-md);

    background-color: $color-bg-card;
    box-shadow: 0 -4rpx 20rpx rgba(31, 31, 46, 0.06);
  }

  &__footer-price {
    flex: 1;
  }

  &__footer-label {
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__footer-amount {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
    color: $color-secondary;
  }

  &__pay {
    flex: 1;

    @include button-primary;
  }
}
</style>
