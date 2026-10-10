<script setup lang="ts">
/**
 * 管理员登录页
 *
 * 流程：
 *   1. 表单校验（账号/密码规则与后端 DTO 校验保持一致）；
 *   2. 调用 auth store 的 login（内部走 api/auth.ts → POST /api/v1/admin/auth/login）；
 *   3. 成功后回跳 `?redirect=` 指定的页面（仅接受站内相对路径，防止开放重定向），否则进入数据看板；
 *   4. 失败时展示页内错误提示（请求带 silent，避免与全局 ElMessage 重复提示）。
 *
 * Phase 1 待完善：登录失败次数锁定（错误码 20011）的倒计时展示、图形验证码（如后端启用）。
 */

import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Lock, User } from '@element-plus/icons-vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { ApiError } from '@/api/types';
import { HOME_PATH, LOGIN_PATH, REDIRECT_QUERY_KEY } from '@/router/routes';
import { useAuthStore } from '@/store/auth';

/** 登录表单 */
interface LoginForm {
  username: string;
  password: string;
}

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const formRef = ref<FormInstance>();
const form = reactive<LoginForm>({ username: '', password: '' });
/** 页内错误提示 */
const errorMessage = ref('');
/** 提交中（同时驱动按钮 loading 与输入框禁用） */
const submitting = ref(false);

/** 校验规则（与后端 DTO 规则对齐：账号 3–32 位，密码 8–64 位） */
const rules: FormRules = {
  username: [
    { required: true, message: '请输入管理员账号', trigger: 'blur' },
    { min: 3, max: 32, message: '账号长度为 3–32 个字符', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 8, max: 64, message: '密码长度为 8–64 个字符', trigger: 'blur' },
  ],
};

/** 解析登录后的回跳地址：仅允许站内相对路径 */
const resolveRedirect = (): string => {
  const raw: unknown = route.query[REDIRECT_QUERY_KEY];
  const target = typeof raw === 'string' ? raw : '';
  const isSafePath = target.startsWith('/') && !target.startsWith('//') && target !== LOGIN_PATH;
  return isSafePath ? target : HOME_PATH;
};

/** 提交登录 */
const handleSubmit = async (): Promise<void> => {
  const instance = formRef.value;
  if (!instance || submitting.value) return;

  errorMessage.value = '';

  const valid = await instance.validate().catch((): boolean => false);
  if (!valid) return;

  submitting.value = true;
  try {
    await authStore.login({ username: form.username, password: form.password });
    ElMessage.success('登录成功');
    await router.replace(resolveRedirect());
  } catch (error) {
    errorMessage.value = error instanceof ApiError ? error.message : '登录失败，请稍后重试';
  } finally {
    submitting.value = false;
  }
};
</script>

<template>
  <el-card class="login" shadow="never">
    <div class="login__brand">
      <span class="login__brand-mark">SM</span>
      <div>
        <h1 class="login__title">SoulMap AI 管理后台</h1>
        <p class="login__subtitle">请使用管理员账号登录，所有操作均记录审计日志</p>
      </div>
    </div>

    <el-alert
      v-if="errorMessage !== ''"
      class="login__error"
      type="error"
      :title="errorMessage"
      :closable="false"
      show-icon
    />

    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      :disabled="submitting"
      @submit.prevent="handleSubmit"
    >
      <el-form-item label="管理员账号" prop="username">
        <el-input
          v-model="form.username"
          placeholder="请输入账号"
          autocomplete="username"
          clearable
          :prefix-icon="User"
          @keyup.enter="handleSubmit"
        />
      </el-form-item>

      <el-form-item label="登录密码" prop="password">
        <el-input
          v-model="form.password"
          type="password"
          placeholder="请输入密码"
          autocomplete="current-password"
          show-password
          :prefix-icon="Lock"
          @keyup.enter="handleSubmit"
        />
      </el-form-item>

      <el-form-item>
        <el-button class="login__submit" type="primary" :loading="submitting" @click="handleSubmit">
          {{ submitting ? '登录中…' : '登 录' }}
        </el-button>
      </el-form-item>
    </el-form>

    <p class="login__tip">连续 5 次输入错误将锁定账号 15 分钟；如忘记密码请联系超级管理员重置。</p>
  </el-card>
</template>

<style scoped lang="scss">
.login {
  width: 100%;
  border-radius: $radius-lg;
  box-shadow: $shadow-md;

  &__brand {
    display: flex;
    gap: $spacing-sm;
    align-items: center;
    margin-bottom: $spacing-lg;
  }

  &__brand-mark {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    font-size: $font-size-base;
    font-weight: 700;
    color: #fff;
    background-color: $color-primary;
    border-radius: $radius-md;
  }

  &__title {
    font-size: $font-size-title;
    font-weight: 600;
    line-height: 1.3;
    color: var(--sm-text-primary);
  }

  &__subtitle {
    margin-top: $spacing-xs;
    font-size: $font-size-xs;
    line-height: 1.5;
    color: var(--sm-text-secondary);
  }

  &__error {
    margin-bottom: $spacing-md;
  }

  &__submit {
    width: 100%;
  }

  &__tip {
    margin-top: $spacing-sm;
    font-size: $font-size-xs;
    line-height: 1.6;
    color: var(--sm-text-secondary);
  }
}
</style>
