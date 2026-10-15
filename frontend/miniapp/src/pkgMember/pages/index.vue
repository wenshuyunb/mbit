<script setup lang="ts">
/**
 * 会员中心（分包 pkgMember）
 *
 * 关键设计（架构文档 §13）：
 *   · 价格与套餐完全由服务端下发（`GET /membership/products`），前端不硬编码
 *   · 支付成功 ≠ 权益到账：`uni.requestPayment` 成功只代表**扣款成功**，
 *     权益由微信异步回调触发发放，必须以服务端状态为准
 *   · 下单必须携带幂等键（由 `createOrder` 内部生成）
 *
 * ## 为什么商品与会员状态来自同一个请求
 *
 * 后端 `GET /membership/products` 同时返回 `items` 与 `membership`，正是为了让会员页
 * 不出现「价格已渲染但会员状态还在转圈」的中间态。因此本页不再读 `authStore` 里的
 * 会员字段 —— 那份数据来自登录时的快照，支付后不会自动更新。
 */

import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { createOrder, type PaymentParams } from '@/api/order';
import { getMyMembership, listProducts, type MembershipStatus, type Product } from '@/api/membership';
import { ApiError } from '@/api/types';
import { useAuthStore } from '@/store/auth';
import { formatPrice } from '@/utils/format';

const authStore = useAuthStore();

const products = ref<Product[]>([]);
const membership = ref<MembershipStatus | null>(null);
const selectedProductId = ref('');
const paying = ref(false);
const loading = ref(false);
/** 加载失败时的文案；非空表示需要展示重试入口 */
const loadError = ref('');

const selectedProduct = computed(
  () => products.value.find((item) => item.productId === selectedProductId.value) ?? null,
);

/** 权益说明：优先用服务端下发的运营标签，为空时才退回本地兜底文案 */
const FALLBACK_BENEFITS = [
  'AI 管家不限次对话（可读三个模块）',
  '深度报告不限次重新生成',
  '报告 PDF 导出与保存',
  '历史人格数据与成长曲线',
  '关系档案不限数量',
];

const benefitList = computed(() => {
  const tags = selectedProduct.value?.tags ?? [];
  return tags.length > 0 ? tags : FALLBACK_BENEFITS;
});

const membershipStatusText = computed(() => {
  const status = membership.value;

  if (!status?.isMember) return '尚未开通会员';
  // remainingDays 为 0 表示「已到期」，与「未开通」是两种不同的含义
  if (status.remainingDays === 0) return '会员已到期';
  return status.expireAt ? `会员有效至 ${status.expireAt.slice(0, 10)}` : '会员生效中';
});

onShow(() => {
  void loadProducts();
});

const loadProducts = async (): Promise<void> => {
  loading.value = true;
  loadError.value = '';

  try {
    const data = await listProducts();
    products.value = [...data.items];
    membership.value = data.membership;

    if (products.value.length > 0 && selectedProductId.value === '') {
      const recommended = products.value.find((item) => item.isRecommended) ?? products.value[0];
      selectedProductId.value = recommended?.productId ?? '';
    }
  } catch (error) {
    loadError.value = error instanceof ApiError ? error.message : '套餐加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 调起微信支付；用户主动取消与真实失败要区分对待 */
const requestPayment = (params: PaymentParams): Promise<void> =>
  new Promise((resolve, reject) => {
    uni.requestPayment({
      provider: 'wxpay',
      timeStamp: params.timeStamp,
      nonceStr: params.nonceStr,
      package: params.package,
      signType: params.signType,
      paySign: params.paySign,
      success: () => resolve(),
      fail: (error: unknown) => reject(error),
    } as unknown as UniApp.RequestPaymentOptions);
  });

/** 用户主动取消支付：`requestPayment` 的 fail 里 errMsg 含 `cancel` */
const isUserCancel = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && String((error as { errMsg?: string }).errMsg ?? '').includes('cancel');

/** 确认权益是否到账的轮询间隔（微信回调是异步的，立刻查多半还是旧状态） */
const CONFIRM_DELAYS_MS = [1000, 2000, 3000, 4000, 5000];

/**
 * 支付成功后的状态确认
 *
 * 后端目前**没有订单查询接口**，无法直接问「这笔订单发放成功了吗」，
 * 只能轮询业务状态（会员状态）来确认。这也意味着无法区分「回调还没到」
 * 与「扣款了但发放失败」—— 因此超时后**不能谎报失败**，只能如实告知
 * 「确认中」并引导联系客服。
 */
const confirmAfterPayment = async (): Promise<void> => {
  for (const delay of CONFIRM_DELAYS_MS) {
    await sleep(delay);

    try {
      const status = await getMyMembership();
      if (status.isMember) {
        membership.value = status;
        uni.showToast({ title: '开通成功', icon: 'success' });
        return;
      }
    } catch {
      // 单次查询失败不中断轮询：网络抖动不应让用户以为支付失败
    }
  }

  uni.showModal({
    title: '支付结果确认中',
    content: '若已扣款，会员权益会在几分钟内到账。如长时间未到账，请通过「我的 - 联系客服」反馈。',
    showCancel: false,
  });
};

const purchase = async (): Promise<void> => {
  if (!selectedProduct.value || paying.value) return;

  if (!authStore.isLoggedIn) {
    uni.showToast({ title: '请先登录', icon: 'none' });
    return;
  }

  paying.value = true;

  try {
    const order = await createOrder({ productId: selectedProduct.value.productId });

    // 预支付失败时 payment 为 null —— 必须先判空，否则会抛 TypeError
    if (order.payment === null) {
      uni.showModal({
        title: '暂时无法支付',
        content: order.paymentUnavailableReason ?? '支付服务暂时不可用，请稍后重试',
        showCancel: false,
      });
      return;
    }

    await requestPayment(order.payment);
    await confirmAfterPayment();
  } catch (error) {
    if (isUserCancel(error)) return;

    uni.showToast({
      title: error instanceof ApiError ? error.message : '支付失败，请稍后重试',
      icon: 'none',
    });
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
      <view v-for="benefit in benefitList" :key="benefit" class="member__benefit">
        <text class="member__benefit-check">✓</text>
        <text class="member__benefit-text">{{ benefit }}</text>
      </view>
    </view>

    <!-- 套餐选择 -->
    <view class="member__plans">
      <text class="member__section-title member__section-title--outside">选择套餐</text>

      <view v-if="products.length > 0" class="member__plan-list">
        <view
          v-for="plan in products"
          :key="plan.productId"
          :class="['member__plan card', { 'is-active': selectedProductId === plan.productId }]"
          @tap="selectedProductId = plan.productId"
        >
          <view v-if="plan.isRecommended" class="member__plan-badge">推荐</view>
          <text class="member__plan-name">{{ plan.name }}</text>
          <view class="member__plan-price">
            <text class="member__plan-current">{{ formatPrice(plan.priceAmount) }}</text>
            <text v-if="plan.originalAmount" class="member__plan-original">
              {{ formatPrice(plan.originalAmount) }}
            </text>
          </view>
          <text class="member__plan-desc">{{ plan.description ?? '' }}</text>
        </view>
      </view>

      <view v-else class="card member__empty">
        <text v-if="loading">套餐加载中…</text>
        <template v-else-if="loadError">
          <text>{{ loadError }}</text>
          <text class="member__retry" @tap="loadProducts">点击重试</text>
        </template>
        <text v-else>暂无可用套餐，请稍后再试</text>
      </view>
    </view>

    <!-- 底部购买 -->
    <view class="member__footer">
      <view class="member__footer-price">
        <text class="member__footer-label">应付</text>
        <text class="member__footer-amount">
          {{ selectedProduct ? formatPrice(selectedProduct.priceAmount) : '—' }}
        </text>
      </view>
      <button class="member__pay" :disabled="!selectedProduct || paying" @tap="purchase">
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

  &__retry {
    display: block;
    margin-top: $space-sm;
    color: $color-primary;
    font-weight: $font-weight-semibold;
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
