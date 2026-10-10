<script setup lang="ts">
/**
 * AI 情感助手（分包 pkgChat）
 *
 * 关键设计（架构文档 §10.4、§10.5）：
 *   · 上下文注入：用户人格画像 + 对象人格画像 + 历史对话摘要 + 最近 10 轮原文
 *   · 必须使用 SSE 流式输出（逐字体验），小程序端用 enableChunked + onChunkReceived
 *   · 合规：危险内容由服务端预筛并返回固定关怀文案，前端原样展示、不得改写
 *   · 每条消息（含 token 与耗时）都会入库，前端展示模型来源便于追溯
 *
 * Phase 0 状态：会话与消息结构、输入区、配额提示就绪；Phase 5 接入流式接口。
 */

import { computed, nextTick, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import { useAuthStore } from '@/store/auth';
import type { ChatMessage } from '@/api/chat';

const authStore = useAuthStore();

const conversationId = ref('');
const messages = ref<ChatMessage[]>([]);
const draft = ref('');
const sending = ref(false);
/** 是否正在流式接收 */
const streaming = ref(false);
/** 剩余可用次数（Phase 5 由 /ai/quota 提供） */
const remaining = ref<number | null>(null);
const scrollIntoView = ref('');

/** 快捷提问（降低首次使用门槛） */
const quickQuestions = [
  '今天和对象吵架了，我该怎么开口？',
  '我总是忍不住想很多，怎么缓解？',
  '怎么判断我们是不是合适？',
];

const canSend = computed(() => draft.value.trim().length > 0 && !sending.value);
const quotaExhausted = computed(() => remaining.value !== null && remaining.value <= 0);

onLoad((query) => {
  const id = query?.['conversationId'];
  if (typeof id === 'string') {
    conversationId.value = id;
  }
  // Phase 5：无会话则 createConversation()，有则 listMessages() 加载历史
});

const scrollToBottom = (): void => {
  if (messages.value.length === 0) return;
  const last = messages.value[messages.value.length - 1];
  if (last) scrollIntoView.value = `msg-${last.id}`;
};

/** 跳转会员页（模板中不能直接引用全局 uni，需走组件方法） */
const goMember = (): void => {
  uni.navigateTo({ url: '/pkgMember/pages/index' });
};

const send = async (content?: string): Promise<void> => {
  const text = (content ?? draft.value).trim();
  if (text.length === 0 || sending.value) return;

  if (!authStore.isLoggedIn) {
    uni.showToast({ title: '请先登录', icon: 'none' });
    return;
  }

  sending.value = true;
  draft.value = '';

  // 乐观插入用户消息（服务端返回后以真实 ID 替换）
  const optimisticId = `local-${Date.now()}`;
  messages.value.push({
    id: optimisticId,
    role: 'USER',
    content: text,
    createdAt: new Date().toISOString(),
  });
  await nextTick();
  scrollToBottom();

  try {
    // Phase 5：建立流式会话
    //   const task = uni.request({ url: `${baseUrl}/ai/conversations/${id}/stream?...`, enableChunked: true })
    //   task.onChunkReceived((res) => { 解析 SSE 事件：start / delta / usage / done / error })
    streaming.value = true;
    uni.showToast({ title: 'AI 对话将在 Phase 5 接入', icon: 'none' });
  } catch (error) {
    console.error('[chat] 发送失败：', error);
  } finally {
    sending.value = false;
    streaming.value = false;
  }
};
</script>

<template>
  <view class="chat">
    <!-- 顶部配额条 -->
    <view class="chat__quota">
      <text class="chat__quota-text">
        {{ remaining === null ? '次数不限' : `剩余 ${remaining} 次对话` }}
      </text>
      <text class="chat__quota-link" @tap="goMember">升级会员</text>
    </view>

    <!-- 消息流 -->
    <scroll-view class="chat__body" scroll-y :scroll-into-view="scrollIntoView" scroll-with-animation>
      <view v-if="messages.length === 0" class="chat__welcome">
        <text class="chat__welcome-title">你好，我是你的情感成长助手</text>
        <text class="chat__welcome-desc">
          我会结合你的人格画像来回应，帮你看清情绪背后发生了什么。这里没有评判，只有陪伴。
        </text>

        <view class="chat__quick">
          <view v-for="question in quickQuestions" :key="question" class="chat__quick-item" @tap="send(question)">
            <text>{{ question }}</text>
          </view>
        </view>
      </view>

      <view v-for="message in messages" :id="`msg-${message.id}`" :key="message.id" class="chat__message">
        <view :class="['chat__bubble', message.role === 'USER' ? 'is-user' : 'is-assistant']">
          <text class="chat__bubble-text">{{ message.content }}</text>
        </view>
        <text v-if="message.meta" class="chat__bubble-meta">
          {{ message.meta.model }} · {{ (message.meta.latencyMs / 1000).toFixed(1) }}s
        </text>
      </view>

      <view v-if="streaming" class="chat__typing">
        <text>正在输入…</text>
      </view>

      <view class="chat__disclaimer-wrap">
        <SafetyDisclaimer />
      </view>
    </scroll-view>

    <!-- 输入区 -->
    <view class="chat__footer">
      <view v-if="quotaExhausted" class="chat__exhausted">
        <text>今日对话次数已用完，升级会员可继续</text>
      </view>

      <view v-else class="chat__input-row">
        <input
          v-model="draft"
          class="chat__input"
          placeholder="说说今天发生了什么…"
          confirm-type="send"
          :disabled="sending"
          @confirm="() => send()"
        />
        <button :class="['chat__send', { 'is-disabled': !canSend }]" :disabled="!canSend" @tap="() => send()">
          发送
        </button>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: $color-bg-page;

  &__quota {
    @include flex-between;
    padding: $space-sm $space-lg;
    background-color: $color-bg-card;
  }

  &__quota-text {
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__quota-link {
    font-size: $font-size-xs;
    color: $color-primary;
  }

  &__body {
    flex: 1;
    padding: $space-lg;
  }

  &__welcome {
    padding: $space-xl $space-md;
  }

  &__welcome-title {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
  }

  &__welcome-desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__quick {
    margin-top: $space-lg;
  }

  &__quick-item {
    padding: $space-sm $space-md;
    margin-bottom: $space-sm;
    font-size: $font-size-sm;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-md;
  }

  &__message {
    margin-bottom: $space-md;
  }

  &__bubble {
    max-width: 78%;
    padding: $space-sm $space-md;
    border-radius: $radius-md;

    &.is-user {
      margin-left: auto;
      background-color: $color-primary;

      .chat__bubble-text {
        color: $color-text-inverse;
      }
    }

    &.is-assistant {
      background-color: $color-bg-card;
    }
  }

  &__bubble-text {
    font-size: $font-size-base;
    line-height: $line-height-loose;
    white-space: pre-wrap;
  }

  &__bubble-meta {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__typing {
    padding: $space-sm 0;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__disclaimer-wrap {
    padding: $space-md 0;
  }

  &__footer {
    padding: $space-sm $space-lg;

    @include safe-area-padding-bottom($space-sm);

    background-color: $color-bg-card;
    border-top: 1rpx solid $color-divider;
  }

  &__input-row {
    display: flex;
    align-items: center;
    gap: $space-sm;
  }

  &__input {
    flex: 1;
    height: 76rpx;
    padding: 0 $space-md;
    font-size: $font-size-base;
    background-color: $color-bg-hover;
    border-radius: $radius-round;
  }

  &__send {
    width: 140rpx;
    height: 76rpx;
    font-size: $font-size-base;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;

    &.is-disabled {
      opacity: 0.4;
    }
  }

  &__exhausted {
    padding: $space-sm 0;
    font-size: $font-size-sm;
    color: $color-secondary;
    text-align: center;
  }
}
</style>
