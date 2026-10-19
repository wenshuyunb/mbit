<script setup lang="ts">
/**
 * 星盘解读（分包 pkgZodiac）
 *
 * ## 这一页解决什么
 *
 * 星盘本身是一张"给懂行的人看"的图：上升天蝎、月亮狮子、火星刑土星 ——
 * 大部分用户看完不知道这些意味着什么。本页把它翻成一篇**人话版**解读：
 * 三巨头、元素与三分类、相位、命主星、十二宫、怎么用。
 *
 * ## 三条产品规则（都来自用户明确要求）
 *
 *   ① **首段免费**：`preview` 永远可见，用户先判断"值不值得看完整"；
 *   ② **完整章节付费或邀请解锁**：未解锁时后端 `sections` 为 `null`（根本没返回），
 *      本页只显示"完整解读共几章、多少字"，不做打码；
 *   ③ **邀请解锁只限当天**：由后端用权益的 `expireAt = 当日 24:00` 表达，
 *      本页只负责把"什么时候失效"如实显示出来。
 *
 * ## 一个刻意的交互取舍
 *
 * "用 AI 重新写"是**显式按钮**而不是进页面自动跑：解读一辈子只生成一次，
 * 但自动生成会让每个只是点进来看看的用户都消耗一次模型调用（包括不看的人）。
 * 代价是点了要等 10–30 秒，因此按钮上有明确的进行中文案。
 */

import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh, onShareAppMessage } from '@dcloudio/uni-app';

import { generateZodiacReading, getZodiacReading, type ReadingSection, type ZodiacReading } from '@/api/zodiac';
import { ApiError, ERROR_CODES } from '@/api/types';

const loading = ref(true);
const loadError = ref('');
/** 未设置出生日期（`30019`）：解读依赖星盘，星盘依赖生日 */
const needsBirthday = ref(false);
const reading = ref<ZodiacReading | null>(null);
const generating = ref(false);

const unlocked = computed(() => reading.value?.access.unlocked === true);
const sections = computed<ReadingSection[]>(() => reading.value?.sections ?? []);

/** 邀请解锁的当天失效时间（只有 INVITE 来源才有） */
const inviteExpireText = computed<string>(() => {
  const access = reading.value?.access;
  if (access === undefined || access.source !== 'INVITE' || access.expireAt === null) return '';

  const expire = new Date(access.expireAt);
  const hour = `${expire.getHours()}`.padStart(2, '0');
  const minute = `${expire.getMinutes()}`.padStart(2, '0');

  return `今天 ${hour}:${minute} 前有效`;
});

onLoad(() => {
  void bootstrap();
});

onPullDownRefresh(async () => {
  await bootstrap();
  uni.stopPullDownRefresh();
});

/** 分享出去的路径带 invitedBy，被邀请的人注册后才算有效（发放逻辑在后端） */
onShareAppMessage(() => ({
  title: '我把自己的星盘解读分享给你，看完你会更懂我',
  path: '/pkgZodiac/pages/reading',
}));

const bootstrap = async (): Promise<void> => {
  loading.value = true;
  loadError.value = '';

  try {
    reading.value = await getZodiacReading();
    needsBirthday.value = false;
  } catch (error) {
    if (error instanceof ApiError && error.code === ERROR_CODES.ZODIAC_BIRTHDAY_REQUIRED) {
      needsBirthday.value = true;
      return;
    }

    console.error('[zodiac] 解读加载失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
};

/**
 * 用 AI 重写
 *
 * ⚠ 后端在 AI 不可用 / 超时 / 格式不合格时**回退为已有内容**并返回 200，
 * 因此这里没有"失败分支"，只需要看 `source` 有没有真的变成 `AI`。
 */
const regenerate = async (): Promise<void> => {
  if (generating.value) return;

  generating.value = true;
  uni.showLoading({ title: '正在重新解读…', mask: true });

  try {
    const next = await generateZodiacReading();
    reading.value = next;

    uni.showToast({
      title: next.source === 'AI' ? '已用 AI 重写' : '暂无更多细节，先看这一版',
      icon: 'none',
    });
  } catch (error) {
    console.error('[zodiac] AI 重写失败：', error);
    uni.showToast({ title: '稍后再试一次', icon: 'none' });
  } finally {
    uni.hideLoading();
    generating.value = false;
  }
};

const goChart = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/chart' });
};

const goMembership = (): void => {
  uni.navigateTo({ url: '/pkgMember/pages/index' });
};

/** 单次购买：支付商户号还没配，如实告知而不是给一个点了没反应的按钮 */
const buyOnce = (): void => {
  uni.showModal({
    title: '单次解锁',
    content: '支付通道还在配置中（微信支付商户号未就绪）。这期间可以先开通会员，或用邀请解锁。',
    showCancel: false,
  });
};
</script>

<template>
  <view class="reading page-container">
    <view v-if="loading" class="card reading__state">
      <text>正在把你的星盘翻成人话…</text>
    </view>

    <view v-else-if="loadError" class="card reading__state">
      <text class="reading__state-title">{{ loadError }}</text>
      <button class="reading__state-action" @tap="bootstrap">重新加载</button>
    </view>

    <view v-else-if="needsBirthday" class="card reading__state">
      <text class="reading__state-title">解读需要你的星盘</text>
      <text class="reading__state-desc"
        >星盘需要出生日期（以及出生时间与城市才能算上升星座）。先去补齐，回来就能看到解读。</text
      >
      <button class="reading__state-action" @tap="goChart">去补齐出生信息</button>
    </view>

    <template v-else-if="reading">
      <!-- 首段：永远免费 -->
      <view class="reading__hero">
        <text class="reading__hero-label">先给你一段</text>
        <text class="reading__hero-text">{{ reading.preview }}</text>
        <text class="reading__hero-meta">
          完整解读共 {{ reading.totalSections }} 章、约 {{ reading.totalChars }} 字 ·
          {{ reading.source === 'AI' ? 'AI 生成' : '系统生成' }}
        </text>
      </view>

      <!-- 已解锁：完整章节 -->
      <template v-if="unlocked">
        <view v-if="inviteExpireText !== ''" class="card reading__invite">
          <text class="reading__invite-text">邀请解锁的完整解读 {{ inviteExpireText }}，到期后会重新上锁。</text>
        </view>

        <view v-for="section in sections" :key="section.key" class="card reading__section">
          <text class="reading__section-title">{{ section.title }}</text>
          <text class="reading__section-body">{{ section.body }}</text>
        </view>

        <view class="card reading__tools">
          <text class="reading__tools-title"
            >这一版是{{ reading.source === 'AI' ? ' AI 生成' : '系统按盘面组装' }}的</text
          >
          <text class="reading__tools-desc">
            想要更细、更贴你个人情况的文字，可以让 AI 重写一遍（会结合你盘上的星座、宫位与相位）。
          </text>
          <button class="reading__tools-button" :disabled="generating" @tap="regenerate">
            {{ generating ? '正在重写…' : '用 AI 重新写一遍' }}
          </button>
        </view>
      </template>

      <!-- 未解锁：解锁引导（列清楚能拿到什么，不做打码） -->
      <view v-else class="card reading__locked">
        <text class="reading__locked-title">完整解读还有 {{ reading.totalSections }} 章</text>
        <text class="reading__locked-desc">{{ reading.access.hint }}</text>

        <view class="reading__locked-item">
          <text class="reading__locked-check">✓</text>
          <text class="reading__locked-text">三巨头：太阳 / 月亮 / 上升分别代表你的哪一面</text>
        </view>
        <view class="reading__locked-item">
          <text class="reading__locked-check">✓</text>
          <text class="reading__locked-text">元素与三分类：你处理事情的默认方式、哪一块要刻意补</text>
        </view>
        <view class="reading__locked-item">
          <text class="reading__locked-check">✓</text>
          <text class="reading__locked-text">相位：你的强项与反复内耗的地方</text>
        </view>
        <view class="reading__locked-item">
          <text class="reading__locked-check">✓</text>
          <text class="reading__locked-text">命主星与十二宫：人生反复回到的那件事</text>
        </view>

        <view class="reading__actions">
          <button class="reading__action reading__action--primary" @tap="goMembership">开通会员，看全部</button>
          <button class="reading__action" @tap="buyOnce">单次解锁这份解读</button>
          <button class="reading__action reading__share" open-type="share">
            分享给好友，邀请新用户解锁（当天有效）
          </button>
        </view>

        <text class="reading__locked-note">
          邀请解锁的规则：只有「从未注册过」的新用户通过你的分享进来并完成注册才算数，已注册的老用户不计；
          解锁后当天有效（到 24:00），同一好友只计一次。
        </text>
      </view>

      <!-- 合规声明：服务端下发，原样展示 -->
      <view class="card reading__disclaimer">
        <text class="reading__disclaimer-text">{{ reading.disclaimer }}</text>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.reading {
  &__state {
    text-align: center;
  }

  &__state-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__state-desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__state-action {
    margin-top: $space-md;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;
  }

  &__hero {
    padding: $space-lg $space-md;
    background: linear-gradient(160deg, $color-primary-dark, $color-primary);
    border-radius: $radius-lg;
  }

  &__hero-label {
    display: block;
    color: $color-text-inverse;
    font-size: $font-size-xs;
    opacity: 0.85;
  }

  &__hero-text {
    display: block;
    margin-top: $space-sm;
    color: $color-text-inverse;
    font-size: $font-size-md;
    line-height: $line-height-loose;
  }

  &__hero-meta {
    display: block;
    margin-top: $space-md;
    color: $color-text-inverse;
    font-size: $font-size-xs;
    opacity: 0.8;
  }

  &__section {
    margin-top: $space-md;
  }

  &__section-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__section-body {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__invite {
    margin-top: $space-md;
    border-left: 6rpx solid $color-warning;
  }

  &__invite-text {
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__tools {
    margin-top: $space-md;
  }

  &__tools-title {
    display: block;
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
  }

  &__tools-desc {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__tools-button {
    margin-top: $space-md;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-round;
  }

  &__locked {
    margin-top: $space-md;
    border-left: 6rpx solid $color-primary;
  }

  &__locked-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__locked-desc {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__locked-item {
    display: flex;
    align-items: flex-start;
    margin-top: $space-xs;
  }

  &__locked-check {
    margin-right: $space-xs;
    color: $color-primary;
  }

  &__locked-text {
    flex: 1;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-regular;
  }

  &__actions {
    margin-top: $space-md;
  }

  &__action {
    margin-top: $space-sm;
    font-size: $font-size-sm;
    border-radius: $radius-round;
  }

  &__action--primary {
    color: $color-text-inverse;
    background-color: $color-primary;
  }

  &__share {
    color: $color-primary;
    background-color: $color-primary-fade;
  }

  &__locked-note {
    display: block;
    margin-top: $space-md;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-placeholder;
  }

  &__disclaimer {
    margin-top: $space-md;
  }

  &__disclaimer-text {
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-placeholder;
  }
}
</style>
