<script setup lang="ts">
/**
 * 根组件
 *
 * 仅作为路由出口：布局（侧边栏 / 顶栏 / 空白布局）由路由指向的 Layout 组件承担，
 * 这样登录页与主布局可以并存而互不影响。
 */
</script>

<template>
  <router-view />
</template>
