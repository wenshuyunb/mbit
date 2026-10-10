<script setup lang="ts">
/**
 * 空白布局
 *
 * 用途：登录页等不展示侧边栏/顶栏的页面。
 * 采用「整屏居中 + 卡片内容由子页面自带」的方式，便于后续新增忘记密码、首次改密等页面复用。
 */
</script>

<template>
  <div class="blank-layout">
    <div class="blank-layout__inner">
      <router-view />
    </div>

    <footer class="blank-layout__footer">SoulMap AI 管理后台 · 仅限授权管理员使用，所有操作均记录审计日志</footer>
  </div>
</template>

<style scoped lang="scss">
.blank-layout {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: $spacing-lg;
  background: linear-gradient(160deg, $color-primary-bg 0%, var(--sm-bg-page) 55%);

  &__inner {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    max-width: 420px;
  }

  &__footer {
    margin-top: $spacing-lg;
    font-size: $font-size-xs;
    color: var(--sm-text-secondary);
    text-align: center;
  }
}
</style>
