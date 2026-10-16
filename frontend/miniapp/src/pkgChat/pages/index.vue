<script setup lang="ts">
/**
 * AI 管家（分包 pkgChat）
 *
 * ## ADR-038 阶段 5：从"情感助手"改成**管家**
 *
 * 三处变化，缺一处这个角色就不成立：
 *
 *   1. **读得到三个模块**：发消息固定带 `contextHints: ['ALL_MODULES']`，
 *      服务端据此注入人格 / 情感 / 心理状态三个模块的画像摘要。
 *      用户不需要（也不应该）每轮手动选"这次读哪个模块"。
 *   2. **会员专属**：门槛由服务端配置 `ai.assistantMembersOnly` 控制，
 *      前端读 `/ai/quota` 的 `assistantMembersOnly` + `nextActions.canChat` 决定UI。
 *      被拦住时展示**会员引导**而不是"剩余 0 次"——后者会让人以为再等等就能用。
 *   3. **拦住是服务端的事**：前端按钮禁用只是体验优化，真正的判定在建会话与发消息
 *      两处（返回 `70016`）。因此这里必须处理 `70016`，不能只靠按钮置灰。
 *
 * ## 合规
 *
 *   危险内容（自伤/他伤/医疗诊断）由服务端预筛并返回固定关怀文案，
 *   前端**原样展示、不得改写**（`isSafetyResponse` 标记），并保留免责声明组件。
 *
 * ## 流式
 *
 *   当前走非流式 `POST /messages`（`sendMessage`）。SSE 走
 *   `POST /ai/conversations/{id}/stream`，小程序端需 `enableChunked: true`
 *   + `onChunkReceived` 解析 `start` / `delta` / `usage` / `done` / `error` 事件，
 *   尚未接入。
 */

import { computed, nextTick, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import SafetyDisclaimer from '@/components/SafetyDisclaimer.vue';
import {
  createConversation,
  getQuota,
  listMessages,
  sendMessage,
  type AiQuota,
  type ChatMessage,
  type MessageRole,
} from '@/api/chat';
import { ApiError, ERROR_CODES } from '@/api/types';
import { canChatNow, isGateBlocked, isQuotaExhausted, quotaTextOf } from '@/pkgChat/chat-gate';
import { useAuthStore } from '@/store/auth';

const authStore = useAuthStore();

/** 视图层消息（乐观插入的本地消息没有服务端 ID 与用量字段） */
interface DisplayMessage {
  messageId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  model?: string | null;
  latencyMs?: number | null;
  /** 服务端安全兜底文案（原样展示，加标记） */
  isSafetyResponse?: boolean;
  /** 本地乐观消息，等待服务端确认 */
  pending?: boolean;
}

const conversationId = ref('');
const messages = ref<DisplayMessage[]>([]);
const draft = ref('');
const sending = ref(false);
const loading = ref(false);
/** 加载失败的文案；非空时展示重试入口 */
const loadError = ref('');
const quota = ref<AiQuota | null>(null);
const scrollIntoView = ref('');

/** 快捷提问（降低首次使用门槛，"总结我测过的"放在第一位——它就是管家的核心能力） */
const quickQuestions = [
  '帮我总结一下我在三个模块的测评结果',
  '我最近的状态和我的性格有什么关系？',
  '我在亲密关系里的模式和我的依恋类型有关吗？',
];

/**
 * 会员门槛与配额的判定都走 `@/pkgChat/chat-gate` 的纯函数
 *
 * 页面只做渲染：判定逻辑放在 SFC 的 `computed` 里没法单测，
 * 而"该展示会员引导还是次数用完"正是本阶段最容易写错的一处。
 */
const gateBlocked = computed(() => isGateBlocked(quota.value));
const quotaExhausted = computed(() => isQuotaExhausted(quota.value));
const quotaText = computed(() => quotaTextOf(quota.value));

const canSend = computed(() => draft.value.trim().length > 0 && !sending.value && canChatNow(quota.value));

onLoad((query) => {
  const id = query?.['conversationId'];
  if (typeof id === 'string' && id.length > 0) {
    conversationId.value = id;
  }

  void bootstrap();
});

/**
 * 初始化：读配额 → （没被拦住才）准备会话与历史
 *
 * 被拦住时**不建会话**：先建再拦会在服务端留下一堆空会话，
 * 且用户会被"明明打不开却提示创建成功"这种中间态搞糊涂。
 */
const bootstrap = async (): Promise<void> => {
  if (!authStore.isLoggedIn) {
    loadError.value = '登录后即可使用 AI 管家';
    return;
  }

  loading.value = true;
  loadError.value = '';

  try {
    await loadQuota();

    if (gateBlocked.value) return;

    await ensureConversation();
    await loadHistory();
  } catch (error) {
    loadError.value = error instanceof ApiError ? error.message : '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
};

const loadQuota = async (): Promise<void> => {
  try {
    quota.value = await getQuota();
  } catch (error) {
    // 配额读不到不该把整个页面卡死：输入区照常可用，服务端仍会做真实判定
    console.warn('[chat] 读取配额失败：', error);
  }
};

const ensureConversation = async (): Promise<void> => {
  if (conversationId.value) return;

  const created = await createConversation({ title: 'AI 管家', mode: 'COMPANION' });
  conversationId.value = created.conversationId;
};

/** 历史消息按时间正序展示（接口是从新到旧分页返回的） */
const loadHistory = async (): Promise<void> => {
  if (!conversationId.value) return;

  const page = await listMessages(conversationId.value, { page: 1, pageSize: 50 });
  messages.value = page.items.map(toDisplayMessage).slice().reverse();
  await nextTick();
  scrollToBottom();
};

const toDisplayMessage = (message: ChatMessage): DisplayMessage => ({
  messageId: message.messageId,
  role: message.role,
  content: message.content,
  createdAt: message.createdAt,
  model: message.model,
  latencyMs: message.latencyMs,
  isSafetyResponse: message.isSafetyResponse,
});

const scrollToBottom = (): void => {
  if (messages.value.length === 0) return;
  const last = messages.value[messages.value.length - 1];
  if (last) scrollIntoView.value = `msg-${last.messageId}`;
};

/**
 * 气泡下方的模型与耗时
 *
 * 小程序模板里的表达式能力有限（`<template>` 块在 `<text>` 内不可靠），
 * 因此拼串放在脚本里，模板只做一次插值。
 */
const metaTextOf = (message: DisplayMessage): string => {
  const model = message.model ?? '';
  if (!message.latencyMs) return model;
  return `${model} · ${(message.latencyMs / 1000).toFixed(1)}s`;
};

/** 跳转会员页（模板中不能直接引用全局 uni，需走组件方法） */
const goMember = (): void => {
  uni.navigateTo({ url: '/pkgMember/pages/index' });
};

/** 会员门槛被服务端拦下时统一处理 */
const handleGateBlocked = (): void => {
  void loadQuota();
  uni.showModal({
    title: '需要开通会员',
    content: 'AI 管家是会员专属功能，开通后可以读你的三个测评结果并帮你梳理总结。',
    confirmText: '去开通',
    cancelText: '再想想',
    success: (res) => {
      if (res.confirm) goMember();
    },
  });
};

const send = async (content?: string): Promise<void> => {
  const text = (content ?? draft.value).trim();
  if (text.length === 0 || sending.value) return;

  if (!authStore.isLoggedIn) {
    uni.showToast({ title: '请先登录', icon: 'none' });
    return;
  }

  if (gateBlocked.value) {
    handleGateBlocked();
    return;
  }

  sending.value = true;
  draft.value = '';

  // 乐观插入用户消息（服务端返回后以真实消息替换）
  const optimisticId = `local-${Date.now()}`;
  messages.value.push({
    messageId: optimisticId,
    role: 'USER',
    content: text,
    createdAt: new Date().toISOString(),
    pending: true,
  });
  await nextTick();
  scrollToBottom();

  try {
    await ensureConversation();

    /**
     * 幂等键在这里生成一次，且**重试要复用**：换新 key 的重试会在服务端变成
     * 一条新消息，既多扣一次额度，用户还会看到两条不同的回复。
     */
    const turn = await sendMessage(conversationId.value, text);

    messages.value = messages.value.map((message) =>
      message.messageId === optimisticId ? toDisplayMessage(turn.userMessage) : message,
    );
    messages.value.push(toDisplayMessage(turn.assistantMessage));

    if (turn.quota) {
      await loadQuota();
    }

    await nextTick();
    scrollToBottom();
  } catch (error) {
    // 发送失败要把乐观消息撤掉，否则用户以为已经发出去了
    messages.value = messages.value.filter((message) => message.messageId !== optimisticId);

    if (error instanceof ApiError && error.code === ERROR_CODES.ENTITLEMENT_REQUIRED) {
      handleGateBlocked();
      return;
    }

    if (error instanceof ApiError && error.code === ERROR_CODES.AI_QUOTA_EXCEEDED) {
      uni.showToast({ title: '可用次数已用完，开通会员可继续', icon: 'none' });
      await loadQuota();
      return;
    }

    uni.showToast({ title: error instanceof ApiError ? error.message : '发送失败，请稍后重试', icon: 'none' });
  } finally {
    sending.value = false;
  }
};
</script>

<template>
  <view class="chat">
    <!-- 顶部配额条 -->
    <view class="chat__quota">
      <text class="chat__quota-text">{{ quotaText }}</text>
      <text v-if="!quota?.plan?.isActive" class="chat__quota-link" @tap="goMember">升级会员</text>
      <text v-else class="chat__quota-link" @tap="goMember">会员中心</text>
    </view>

    <!-- 消息流 -->
    <scroll-view class="chat__body" scroll-y :scroll-into-view="scrollIntoView" scroll-with-animation>
      <view v-if="loadError" class="chat__error">
        <text class="chat__error-text">{{ loadError }}</text>
        <text class="chat__error-retry" @tap="bootstrap">重新加载</text>
      </view>

      <view v-else-if="loading && messages.length === 0" class="chat__welcome">
        <text class="chat__welcome-desc">正在准备你的管家…</text>
      </view>

      <view v-else-if="messages.length === 0" class="chat__welcome">
        <text class="chat__welcome-title">我是你的 AI 管家</text>
        <text class="chat__welcome-desc">
          我可以读你三个测评（人格 / 情感 /
          心理状态）的结果，帮你把它们串起来看，也能陪你把当下的困扰聊清楚。这里没有评判，只有陪伴。
        </text>

        <view class="chat__quick">
          <view v-for="question in quickQuestions" :key="question" class="chat__quick-item" @tap="send(question)">
            <text>{{ question }}</text>
          </view>
        </view>
      </view>

      <view v-for="message in messages" :id="`msg-${message.messageId}`" :key="message.messageId" class="chat__message">
        <view :class="['chat__bubble', message.role === 'USER' ? 'is-user' : 'is-assistant']">
          <text class="chat__bubble-text">{{ message.content }}</text>
        </view>
        <text v-if="message.isSafetyResponse" class="chat__bubble-flag">安全提示（原文展示，未改写）</text>
        <text v-else-if="message.model" class="chat__bubble-meta">{{ metaTextOf(message) }}</text>
      </view>

      <view v-if="sending" class="chat__typing">
        <text>正在输入…</text>
      </view>

      <view class="chat__disclaimer-wrap">
        <SafetyDisclaimer />
      </view>
    </scroll-view>

    <!-- 输入区 -->
    <view class="chat__footer">
      <!-- 会员门槛：展示会员引导，而不是"剩余 0 次" -->
      <view v-if="gateBlocked" class="chat__gate">
        <text class="chat__gate-title">AI 管家是会员专属功能</text>
        <text class="chat__gate-desc">
          开通会员后，管家可以读你三个测评（人格 / 情感 / 心理状态）的结果，帮你总结和梳理。
        </text>
        <button class="chat__gate-btn" @tap="goMember">开通会员</button>
      </view>

      <view v-else-if="quotaExhausted" class="chat__exhausted">
        <text>可用次数已用完，开通会员可继续</text>
        <text class="chat__exhausted-link" @tap="goMember">去开通</text>
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
  /**
   * ⚠ 必须裁掉溢出（与 pages.json 的 `disableScroll: true` 配套）
   *
   * 本页页面级滚动是**关闭**的（输入框固定在底部、消息列表自己滚）。
   * 一旦有内容把容器撑出视口，页面既滚不动、又看不到下半截 ——
   * 用户看到的就是"界面卡死了"。裁掉之后溢出只可能发生在 scroll-view 内部。
   */
  overflow: hidden;
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

  /**
   * 消息列表（竖向 `scroll-view`）
   *
   * ## ⚠ `min-height: 0` + `height: 0` 是"聊天页不能滚动"的修复（2026-10-16）
   *
   * 用户的反馈是「AI 能回答，但对话框没有办法拖动，就像卡死了一样」。
   * 根因是这段 CSS，不是交互逻辑：
   *
   *   · `scroll-view` 竖滚**必须有确定的高度**（微信官方要求给固定 height）；
   *   · 只写 `flex: 1` 时，flex 项的自动最小尺寸是**内容高度**（`min-height: auto`），
   *     于是消息一多，这个盒子就长到跟内容一样高 —— 它内部**没有可滚的区域**；
   *   · 而页面又是 `disableScroll: true`（不能滚）→ **两边都滚不动**，
   *     手指怎么拉都不动，表现就是"卡死"。
   *
   * `min-height: 0` 允许它缩到比内容更小，`height: 0` 让高度完全由 flex 分配决定，
   * 两者一起用是微信基础库里最稳的写法（只写其中一个在部分机型上仍会被内容撑开）。
   *
   * 单测 `tests/pkg-chat/chat-scroll.spec.ts` 会把这两条声明钉住 ——
   * 这类缺陷类型检查、单测、构建**全都发现不了**，只能靠结构断言防回归。
   */
  &__body {
    flex: 1;
    height: 0;
    min-height: 0;
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

  &__error {
    padding: $space-xl $space-md;
  }

  &__error-text {
    display: block;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__error-retry {
    display: inline-block;
    margin-top: $space-md;
    font-size: $font-size-sm;
    color: $color-primary;
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

  &__bubble-flag {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    color: $color-secondary;
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

  &__gate {
    padding: $space-sm 0;
  }

  &__gate-title {
    display: block;
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    text-align: center;
  }

  &__gate-desc {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-secondary;
    text-align: center;
  }

  &__gate-btn {
    height: 76rpx;
    margin-top: $space-sm;
    font-size: $font-size-base;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;
  }

  &__exhausted {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: $space-sm;
    padding: $space-sm 0;
    font-size: $font-size-sm;
    color: $color-secondary;
    text-align: center;
  }

  &__exhausted-link {
    color: $color-primary;
  }
}
</style>
