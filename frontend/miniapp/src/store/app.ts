/**
 * 应用级状态
 *
 * 职责：
 *   · 系统配置（功能开关、免责声明、分享文案、套餐价格）——由后端下发，前端不硬编码
 *   · 胶囊按钮/状态栏尺寸（自定义导航栏需要）
 *   · 前后台切换时间（用于判断是否需要刷新数据）
 *
 * 缓存策略：系统配置本地缓存 1 小时；启动时若缓存有效则先用缓存、
 *           再后台静默更新，保证首屏不被网络阻塞。
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { http } from '@/api/request';
import { FALLBACK_DISCLAIMER, DEFAULT_SHARE, STORAGE_KEYS } from '@/config/constants';
import { storage } from '@/utils/storage';

/** 系统配置结构（与服务端 GET /system/config 契约一致） */
export interface SystemConfig {
  /** 功能开关 */
  features: {
    coupleMatch: boolean;
    payment: boolean;
    aiChat: boolean;
  };
  /** 合规免责声明（所有 AI 内容展示处必须引用此文案） */
  disclaimers: {
    aiContent: string;
    reportFooter: string;
  };
  /** 分享文案 */
  share: {
    title: string;
    path: string;
    imageUrl: string | null;
  };
  /** 免费预览比例（0-1），由后端权威下发 */
  reportFreePreviewRatio: number;
  /** 客服联系方式 */
  support: {
    wechatId: string | null;
    email: string | null;
  };
  /** 配置版本，便于后端灰度与排查 */
  version: string;
}

/** 缓存有效期：1 小时 */
const CONFIG_CACHE_TTL_MS = 60 * 60 * 1000;

/** 服务端不可用时的兜底配置：保证页面不白屏，但不作为业务真相 */
const FALLBACK_CONFIG: SystemConfig = {
  features: { coupleMatch: true, payment: true, aiChat: true },
  disclaimers: { aiContent: FALLBACK_DISCLAIMER, reportFooter: FALLBACK_DISCLAIMER },
  share: { title: DEFAULT_SHARE.title, path: DEFAULT_SHARE.path, imageUrl: null },
  reportFreePreviewRatio: 0.2,
  support: { wechatId: null, email: null },
  version: 'fallback',
};

export const useAppStore = defineStore('app', () => {
  // -------------------------------------------------------------------- state
  const systemConfig = ref<SystemConfig>(storage.get<SystemConfig>(STORAGE_KEYS.systemConfig) ?? FALLBACK_CONFIG);
  /** 配置是否来自服务端（false 表示当前用的是本地兜底，页面可据此提示） */
  const configLoaded = ref<boolean>(storage.has(STORAGE_KEYS.systemConfig));
  /** 胶囊按钮信息与状态栏高度（自定义导航栏布局用） */
  const statusBarHeight = ref<number>(20);
  const menuButtonRect = ref<{ top: number; height: number; width: number; right: number } | null>(null);
  /** 上次进入后台的时间戳（用于判断回前台是否需要刷新） */
  const backgroundAt = ref<number>(0);

  // -------------------------------------------------------------------- getter
  const disclaimer = computed(() => systemConfig.value.disclaimers.aiContent || FALLBACK_DISCLAIMER);
  const shareInfo = computed(() => systemConfig.value.share);
  const features = computed(() => systemConfig.value.features);

  // -------------------------------------------------------------------- action

  /** 初始化胶囊与状态栏尺寸（自定义导航栏必用） */
  const initSystemMetrics = (): void => {
    try {
      const windowInfo = uni.getWindowInfo();
      statusBarHeight.value = windowInfo.statusBarHeight ?? 20;
    } catch {
      statusBarHeight.value = 20;
    }

    try {
      // getMenuButtonBoundingClientRect 在小程序端可用；H5 预览时会抛错，已捕获
      const rect = uni.getMenuButtonBoundingClientRect();
      menuButtonRect.value = { top: rect.top, height: rect.height, width: rect.width, right: rect.right };
    } catch {
      menuButtonRect.value = null;
    }
  };

  /**
   * 加载系统配置
   * 有有效缓存时先返回，再后台更新（stale-while-revalidate）
   */
  const loadSystemConfig = async (options: { force?: boolean } = {}): Promise<void> => {
    const cachedTtl = storage.ttl(STORAGE_KEYS.systemConfig);
    const cacheValid = cachedTtl !== null && cachedTtl > CONFIG_CACHE_TTL_MS ? false : cachedTtl !== null;

    if (options.force !== true && cacheValid && configLoaded.value) {
      // 缓存仍有效：异步刷新，不阻塞调用方
      void refreshSystemConfig();
      return;
    }

    await refreshSystemConfig();
  };

  const refreshSystemConfig = async (): Promise<void> => {
    try {
      const config = await http.get<SystemConfig>('/system/config', undefined, {
        needAuth: false,
        showError: false,
      });

      // 防御：后端契约变更时避免把空对象写进状态导致页面崩溃
      if (config && typeof config === 'object' && config.disclaimers) {
        systemConfig.value = config;
        configLoaded.value = true;
        storage.set(STORAGE_KEYS.systemConfig, config, CONFIG_CACHE_TTL_MS);
      }
    } catch (error) {
      console.warn('[app] 系统配置拉取失败，使用本地兜底配置：', error);
    }
  };

  /** onShow 时记录回前台时间 */
  const markForeground = (): void => {
    backgroundAt.value = Date.now();
  };

  /** 判断是否需要刷新数据（默认超过 5 分钟） */
  const shouldRefresh = (thresholdMs = 5 * 60 * 1000): boolean =>
    backgroundAt.value > 0 && Date.now() - backgroundAt.value > thresholdMs;

  return {
    // state
    systemConfig,
    configLoaded,
    statusBarHeight,
    menuButtonRect,
    // getter
    disclaimer,
    shareInfo,
    features,
    // action
    initSystemMetrics,
    loadSystemConfig,
    refreshSystemConfig,
    markForeground,
    shouldRefresh,
  };
});
