/**
 * SystemConfigService — `system_configs` 的统一读取/组装/缓存
 *
 * ## 为什么「后台写」与「前台读」必须共用这一个服务
 *
 * 契约 §3.14.9.2 明确要求「更新后主动失效相关缓存」，§3.12 又要求首屏配置接口
 * 抗住高并发（限流 240 次/60s）。如果后台写库后前台还在用旧缓存，表现是
 * 「运营改了免责声明，线上三天没变」——这类问题几乎无法从日志里发现。
 * 因此缓存的**唯一持有者**是本服务：管理员改动配置后调用同一个 `invalidate()`，
 * 前台的读路径与后台的写路径从此不可能各持一份缓存。
 *
 * ## 缓存形态
 *
 * 缓存的是「解析后的配置快照」（键 + 原始字符串 + 元信息），而不是最终响应体 ——
 * 因为同一个快照要服务三种不同形态的响应（公开精简配置、完整免责声明、后台分组列表），
 * 缓存响应体会导致其中两种永远拿不到新值。
 *
 * 缓存三原则：
 *   1. Redis 不可用时**降级直查数据库**而不是报错（配置是首屏依赖，不能因缓存故障白屏）；
 *   2. TTL 300s 与响应头 `Cache-Control: private, max-age=300` 保持一致；
 *   3. 写路径主动失效，不依赖 TTL 自然过期。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigValueType } from '@prisma/client';

import type { AppConfig } from '../../config/config.type';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import {
  CONFIG_DEFINITION_MAP,
  CONFIG_DEFINITIONS,
  CONFIG_GROUP_NAMES,
  POLICY_TYPES,
  POLICY_VERSION_PREFIX,
  type ConfigDefinition,
  type ConfigGroup,
  type ConfigImpactScope,
} from './system-config.catalog';
import {
  buildConfigVersion,
  buildDisclaimerVersion,
  compareSemver,
  formatPrice,
  parseConfigValue,
} from './system-config.util';

/** 缓存 TTL（秒），与响应头 max-age 一致 */
export const SYSTEM_CONFIG_CACHE_TTL_SECONDS = 300;

/** 解析后的单条配置 */
export interface ResolvedConfigEntry {
  key: string;
  group: string;
  groupName: string;
  label: string;
  valueType: ConfigValueType;
  /** 按 valueType 解析后的值 */
  value: unknown;
  /** 归一化后的字符串（写库/内容哈希用） */
  rawValue: string;
  description: string;
  /** 环境变量锁定项在后台只读（契约 §3.14.9.1 规则 1） */
  isEditable: boolean;
  requiresConfirmPassword: boolean;
  envOverride: string | null;
  impactScope: ConfigImpactScope;
  isPublic: boolean;
  min: number | null;
  max: number | null;
  updatedAt: string | null;
  updatedByAdminId: string | null;
  /** 是否属于目录中的已知键；未知键（人工插入的内部配置）在后台只读 */
  isKnown: boolean;
}

/** 配置快照（缓存单位） */
export interface ConfigSnapshot {
  version: string;
  generatedAt: string;
  entries: ResolvedConfigEntry[];
}

/** 公开配置查询（契约 §3.12.1 Query） */
export interface PublicConfigQuery {
  clientVersion?: string;
  platform?: 'MINIAPP' | 'ADMIN';
  keys?: string;
}

/** 免责声明查询（契约 §3.12.2 Query） */
export interface DisclaimerQuery {
  scene?: 'ALL' | 'AI_CHAT' | 'REPORT' | 'TEST' | 'COMPATIBILITY' | 'SHARE';
  language?: 'zh-CN' | 'en-US';
}

/** 免责声明条目元信息（契约 §3.12.2 items 的固定结构，只有 content 来自配置） */
interface DisclaimerItemMeta {
  configKey: string;
  title: string;
  position: 'HEADER' | 'INLINE' | 'FOOTER';
  required: boolean;
  style: 'MUTED' | 'BADGE' | 'NORMAL' | 'ALERT';
}

const DISCLAIMER_ITEM_META: Readonly<Record<string, DisclaimerItemMeta>> = {
  AI_CONTENT_DISCLAIMER: {
    configKey: 'disclaimer.aiContent',
    title: '内容声明',
    position: 'FOOTER',
    required: true,
    style: 'MUTED',
  },
  ASSESSMENT_DISCLAIMER: {
    configKey: 'disclaimer.personality',
    title: '测评声明',
    position: 'FOOTER',
    required: true,
    style: 'MUTED',
  },
  COMPATIBILITY_DISCLAIMER: {
    configKey: 'disclaimer.compatibility',
    title: '匹配结果声明',
    position: 'FOOTER',
    required: true,
    style: 'MUTED',
  },
  AI_GENERATED_NOTICE: {
    configKey: 'disclaimer.aiGeneratedNotice',
    title: 'AI 生成标识',
    position: 'HEADER',
    required: true,
    style: 'BADGE',
  },
  CONFIDENCE_NOTICE: {
    configKey: 'disclaimer.confidenceNotice',
    title: '置信度说明',
    position: 'INLINE',
    required: false,
    style: 'NORMAL',
  },
  CRISIS_NOTICE: {
    configKey: 'disclaimer.crisisNotice',
    title: '危机提示',
    position: 'FOOTER',
    required: true,
    style: 'ALERT',
  },
};

/**
 * 场景 → 需要哪些文案
 *
 * 刻意用「场景取并集」而不是「每个场景一组独立文案」：文案是合规资产，
 * 一处改动要能同时作用于所有相关页面，否则会出现报告页与对话页口径不一致。
 */
const SCENE_ITEMS: Readonly<Record<NonNullable<DisclaimerQuery['scene']>, readonly string[]>> = {
  ALL: Object.keys(DISCLAIMER_ITEM_META),
  AI_CHAT: ['AI_CONTENT_DISCLAIMER', 'AI_GENERATED_NOTICE', 'CRISIS_NOTICE'],
  REPORT: ['AI_CONTENT_DISCLAIMER', 'ASSESSMENT_DISCLAIMER', 'AI_GENERATED_NOTICE', 'CONFIDENCE_NOTICE'],
  TEST: ['ASSESSMENT_DISCLAIMER', 'AI_GENERATED_NOTICE'],
  COMPATIBILITY: ['COMPATIBILITY_DISCLAIMER', 'ASSESSMENT_DISCLAIMER'],
  SHARE: ['AI_GENERATED_NOTICE', 'ASSESSMENT_DISCLAIMER'],
};

/** 需要完整免责声明的场景（其余场景不返回危机资源，减少响应体） */
const SCENES_WITH_CRISIS_RESOURCES: readonly NonNullable<DisclaimerQuery['scene']>[] = ['ALL', 'AI_CHAT'];

@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  // ==========================================================================
  // 快照：读缓存 → 查库 → 回填
  // ==========================================================================

  /**
   * 取配置快照（带缓存）
   *
   * @param force `true` 时跳过缓存（后台写操作后立即回读，保证响应里的
   *              `configVersion` 与实际落库内容一致）
   */
  async getSnapshot(force = false): Promise<ConfigSnapshot> {
    if (!force) {
      const cached = await this.readCache();
      if (cached) return cached;
    }

    const snapshot = await this.loadFromSources();

    await this.writeCache(snapshot);

    return snapshot;
  }

  /** 全部配置项 */
  async getEntries(force = false): Promise<ResolvedConfigEntry[]> {
    return (await this.getSnapshot(force)).entries;
  }

  /** 按键取单条（不存在返回 undefined） */
  async getEntry(key: string): Promise<ResolvedConfigEntry | undefined> {
    const entries = await this.getEntries();
    return entries.find((entry) => entry.key === key);
  }

  /** 当前配置版本号（内容哈希） */
  async getConfigVersion(): Promise<string> {
    return (await this.getSnapshot()).version;
  }

  /**
   * 失效配置缓存
   *
   * 同时清理「按版本号命名的快照键」：既然版本号是内容哈希，旧版本键不会再次被写入，
   * 不清掉就会在 Redis 里永久残留（每次改配置留一份，长期占用内存）。
   *
   * @returns 实际失效的缓存键（回填到契约 §3.14.9.2 的 `cacheInvalidation.invalidatedKeys`）
   */
  async invalidate(reason: string): Promise<string[]> {
    const baseKey = this.cacheKey();
    const versionPattern = `${baseKey}:*`;

    try {
      await this.redis.del(baseKey);
      await this.redis.delByPattern(versionPattern);
      this.logger.log(`系统配置缓存已失效: ${baseKey} reason=${reason}`);
      return [baseKey];
    } catch (error) {
      // 缓存失效失败必须留痕：否则表现为「后台改了配置、线上还是旧值」，且没有任何错误
      this.logger.error(`系统配置缓存失效失败（配置已落库，将依赖 TTL 自然过期）: ${(error as Error).message}`);
      return [];
    }
  }

  // ==========================================================================
  // 用户端 §3.12.1 / §3.12.2
  // ==========================================================================

  /**
   * `GET /system/config` 的响应体（契约 §3.12.1）
   *
   * 除契约字段外，还**额外**返回小程序 `src/store/app.ts` 期望的扁平别名
   *（`features.payment` / `disclaimers.reportFooter` / `support` / `version` 等）：
   * 前端已在上线路上消费这些字段，而契约给的是 `FEATURE_PAYMENT` / `pricing.*` 形态，
   * 两者目前不一致（见交付报告「契约矛盾」一节）。以「契约字段为准、别名只增不改」
   * 的方式同时满足两边，等前端切到契约字段后可安全删除别名。
   */
  async getPublicConfig(query: PublicConfigQuery, now: Date = new Date()): Promise<Record<string, unknown>> {
    const snapshot = await this.getSnapshot();
    const entries = snapshot.entries;
    const map = toEntryMap(entries);
    const allow = this.buildKeyWhitelist(query.keys, 100);

    const appName = this.readString(map, 'app.name', 'SoulMap AI');
    const minClientVersion = this.readString(map, 'app.minClientVersion', '1.2.0');
    const clientVersion = query.clientVersion ?? null;

    /**
     * 契约 §3.12.1 规则 8 要求「低于 minClientVersion 时其他业务接口返回 90013」——
     * 那属于全局请求管道的职责（本次未实现，已在报告中标注）；本接口能做的、
     * 也是前端真正需要的，是直接把强更信号告诉它，避免客户端还要自己比版本。
     */
    const belowMinVersion =
      clientVersion !== null && minClientVersion.length > 0 && compareSemver(clientVersion, minClientVersion) < 0;

    const features = this.buildFeatures(map, allow);

    /**
     * 别名单独从配置取值，而不是复用被 `keys` 白名单裁剪后的 `features`
     * 后果示例：调用方传 `keys=reportFreePreviewRatio` 时 `features.FEATURE_PAYMENT` 会被裁掉，
     * 若别名从裁剪结果推导，`features.payment` 会变成 `false` —— 前端据此隐藏支付入口，
     * 「按需拉取」就变成了「按需关闭功能」。因此别名永远读未被裁剪的真值。
     */
    const paymentEnabled = this.readBoolean(map, 'FEATURE_PAYMENT', false);
    const coupleMatchEnabled = this.readBoolean(map, 'FEATURE_COUPLE_MATCH', false);
    const aiChatEnabled = this.readBoolean(map, 'FEATURE_AI_CHAT', false);

    const pricing: Record<string, unknown> = {
      currency: this.readString(map, 'pricing.currency', 'CNY'),
      currencySymbol: '¥',
      amountUnit: 'CENT',
      amountUnitNote: '接口返回的金额单位为「分」，展示时需除以 100',
      reportFreePreviewRatio: this.readNumber(map, 'reportFreePreviewRatio', 0.2),
      membershipPlans: await this.loadMembershipPlans(),
      products: await this.loadProducts(),
    };

    const share = query.platform === 'ADMIN' ? null : this.buildShare(map);

    return {
      configVersion: snapshot.version,
      generatedAt: snapshot.generatedAt,
      // 契约 §3.12.1 示例给 3600（前端本地缓存 TTL），而响应头是 max-age=300（服务端缓存 TTL），
      // 两者语义不同：前者指导客户端本地缓存，后者指导中间层缓存，故都按契约原样给出。
      cacheTtlSeconds: 3600,
      app: {
        name: appName,
        slogan: this.readString(map, 'app.slogan', ''),
        // 契约示例回显的是本次请求的客户端版本
        version: clientVersion,
        minClientVersion,
        forceUpdate: this.readBoolean(map, 'app.forceUpdate', false) || belowMinVersion,
        updateUrl: this.readString(map, 'app.updateUrl', '') || null,
        updateNote: this.readString(map, 'app.updateNote', '') || null,
        supportContact: this.readJson(map, 'app.supportContact', null),
        icpNumber: this.readString(map, 'app.icpNumber', ''),
      },
      features: {
        ...features,
        // 小程序 store 的直接消费字段（别名，见方法注释）：永远反映真值，不受 keys 白名单影响
        payment: paymentEnabled,
        coupleMatch: coupleMatchEnabled,
        aiChat: aiChatEnabled,
      },
      featuresExplain: this.buildFeaturesExplain(map),
      disclaimers: this.buildDisclaimers(map),
      pricing,
      ...(share === null ? {} : { share }),
      assets: this.buildAssets(map),
      policies: this.buildPolicies(map),
      limits: this.buildLimits(map, allow),
      // 小程序 store 的别名：免费预览比例与配置版本
      reportFreePreviewRatio: pricing.reportFreePreviewRatio,
      support: {
        wechatId: this.readString(map, 'app.support.wechatId', '') || null,
        email: this.readString(map, 'app.support.email', '') || null,
      },
      version: snapshot.version,
      serverTime: now.toISOString(),
    };
  }

  /** `GET /system/disclaimers` 的响应体（契约 §3.12.2） */
  async getDisclaimers(query: DisclaimerQuery, now: Date = new Date()): Promise<Record<string, unknown>> {
    const snapshot = await this.getSnapshot();
    const map = toEntryMap(snapshot.entries);

    const scene = query.scene ?? 'ALL';
    const itemKeys = SCENE_ITEMS[scene];

    const items = itemKeys.map((itemKey) => {
      const meta = DISCLAIMER_ITEM_META[itemKey];
      return {
        key: itemKey,
        title: meta.title,
        content: this.readString(map, meta.configKey, ''),
        position: meta.position,
        required: meta.required,
        style: meta.style,
      };
    });

    /**
     * 多语言：`system_configs` 没有语言维度，目前只有中文文案。请求 `en-US` 时
     * **不伪装**成英文（那会让后端与前端都以为已有多语言能力），而是原样返回中文并
     * 在 `language` 中如实标注为 `zh-CN`，由前端决定是否提示。
     */
    const language = query.language === 'en-US' ? 'zh-CN' : (query.language ?? 'zh-CN');

    const disclaimerEntries = Object.values(DISCLAIMER_ITEM_META)
      .map((meta) => {
        const entry = map.get(meta.configKey);
        return entry ? { key: entry.key, rawValue: entry.rawValue } : null;
      })
      .filter((entry): entry is { key: string; rawValue: string } => entry !== null);

    return {
      scene,
      language,
      version: buildDisclaimerVersion(disclaimerEntries, now),
      items,
      crisisResources: SCENES_WITH_CRISIS_RESOURCES.includes(scene)
        ? {
            title: '需要专业帮助时',
            content: this.readString(map, 'disclaimer.crisisNotice', ''),
            items: this.readJson<unknown[]>(map, 'disclaimer.safetyResources', []),
            emergencyNotice: this.readString(map, 'disclaimer.emergencyNotice', ''),
          }
        : null,
      policyVersions: this.buildPolicyVersions(map),
      generatedAt: snapshot.generatedAt,
    };
  }

  // ==========================================================================
  // 响应组装（内部）
  // ==========================================================================

  private buildFeatures(
    map: ReadonlyMap<string, ResolvedConfigEntry>,
    allow: (key: string) => boolean,
  ): Record<string, unknown> {
    const keys = [
      'FEATURE_PAYMENT',
      'FEATURE_COUPLE_MATCH',
      'FEATURE_AI_CHAT',
      'FEATURE_PDF_EXPORT',
      'FEATURE_SHARE_CARD',
      'FEATURE_GROWTH_CURVE',
      'FEATURE_VOICE_INPUT',
    ];

    const features: Record<string, unknown> = {};
    for (const key of keys) {
      if (!allow(key)) continue;
      features[key] = this.readBoolean(map, key, false);
    }

    features.maintenanceMode = this.readBoolean(map, 'maintenanceMode', false);
    features.maintenanceNotice = this.readString(map, 'maintenanceNotice', '') || null;

    return features;
  }

  private buildFeaturesExplain(map: ReadonlyMap<string, ResolvedConfigEntry>): Record<string, unknown> {
    return {
      FEATURE_COUPLE_MATCH: {
        enabled: this.readBoolean(map, 'FEATURE_COUPLE_MATCH', false),
        minAge: this.readNumber(map, 'security.coupleMatchMinAge', 18),
        requiresAgeVerification: true,
      },
      FEATURE_AI_CHAT: {
        enabled: this.readBoolean(map, 'FEATURE_AI_CHAT', false),
        freeQuotaTotal: this.readNumber(map, 'freeAiQuotaTotal', 10),
        memberDailyLimit: this.readNumber(map, 'memberAiDailyLimit', 50),
        maxMessageLength: this.readNumber(map, 'aiMessageMaxLength', 2000),
        maxConcurrentStreams: this.readNumber(map, 'ai.maxConcurrentStreams', 3),
      },
      FEATURE_PAYMENT: {
        enabled: this.readBoolean(map, 'FEATURE_PAYMENT', false),
        payMethod: this.readString(map, 'payment.payMethod', 'WECHAT_JSAPI'),
        orderExpireMinutes: this.readNumber(map, 'payment.orderExpireMinutes', 30),
        autoRenew: this.readBoolean(map, 'payment.autoRenew', false),
      },
    };
  }

  private buildDisclaimers(map: ReadonlyMap<string, ResolvedConfigEntry>): Record<string, unknown> {
    return {
      aiContent: this.readString(map, 'disclaimer.aiContent', ''),
      assessment: this.readString(map, 'disclaimer.personality', ''),
      compatibility: this.readString(map, 'disclaimer.compatibility', ''),
      aiGeneratedNotice: this.readString(map, 'disclaimer.aiGeneratedNotice', ''),
      confidenceNotice: this.readString(map, 'disclaimer.confidenceNotice', ''),
      safetyResources: this.readJson<unknown[]>(map, 'disclaimer.safetyResources', []),
      crisisNotice: this.readString(map, 'disclaimer.crisisNotice', ''),
      /**
       * 星座运势的娱乐性质声明（2026-10-16 新增）
       *
       * 放在这里而不是写死在前端：星座内容天然带"预测"色彩，这句话是**合规文案**，
       * 必须能独立迭代（口径收紧时改配置即可，不必发版），也与其它免责声明同一处下发。
       */
      zodiac: this.readString(map, 'disclaimer.zodiac', ''),
      /**
       * 塔罗牌的娱乐性质声明（2026-10-19 新增，ADR-042）
       *
       * 与星座声明分开配置：塔罗的措辞要额外强调"牌面代表的是象征而非事实" ——
       * 星座谈的是"倾向"，塔罗更容易被用户读成"预言"，两者的合规口径不完全一样。
       */
      tarot: this.readString(map, 'disclaimer.tarot', ''),
      // 小程序 store 的直接消费字段（别名）：报告页脚声明
      reportFooter: this.readString(map, 'disclaimer.personality', ''),
    };
  }

  private buildShare(map: ReadonlyMap<string, ResolvedConfigEntry>): Record<string, unknown> {
    const templates = this.readJson<Record<string, { title?: string; text?: string; imageUrl?: string }>>(
      map,
      'share.templates',
      {},
    );
    const defaultScene = this.readString(map, 'share.defaultScene', 'DEFAULT');
    const fallback = templates[defaultScene] ?? templates.DEFAULT ?? {};

    return {
      templates,
      defaultScene,
      // 小程序 store 的直接消费字段（别名）：扁平化的默认分享信息
      title: fallback.title ?? '',
      path: this.readString(map, 'share.path', '/pages/index/index'),
      imageUrl: this.readString(map, 'share.imageUrl', '') || fallback.imageUrl || null,
    };
  }

  private buildAssets(map: ReadonlyMap<string, ResolvedConfigEntry>): Record<string, unknown> {
    return {
      // CDN 域名来自部署配置（`OSS_CDN_DOMAIN`），不是运行时可变项，故不进 system_configs
      cdnDomain: this.configService.get('oss.cdnDomain', { infer: true }),
      staticDomain: this.readString(map, 'assets.staticDomain', ''),
      defaultAvatarUrl: this.readString(map, 'avatar.default', '') || null,
      logos: this.readJson<Record<string, string>>(map, 'assets.logos', {}),
      emptyStates: this.readJson<Record<string, string>>(map, 'assets.emptyStates', {}),
    };
  }

  private buildPolicies(map: ReadonlyMap<string, ResolvedConfigEntry>): Record<string, unknown> {
    return {
      currentVersions: this.buildPolicyVersions(map),
      /**
       * 契约 §3.12.1 规则 6 说 `requiresReconsent` 只在登录用户维度才有意义
       *（个性化状态走 `GET /users/me/consents`）。本接口是 `@Public()` 路由，
       * 用户端全局 JwtAuthGuard 已被跳过，此处**拿不到**登录态，因此恒返回空数组，
       * 如实表达「本接口不下发个性化重新同意状态」，而不是猜一个值。
       */
      requiresReconsent: [],
      policyUrls: this.readJson<Record<string, string>>(map, 'compliance.policyUrls', {}),
    };
  }

  private buildPolicyVersions(map: ReadonlyMap<string, ResolvedConfigEntry>): Record<string, string> {
    const versions: Record<string, string> = {};
    for (const type of POLICY_TYPES) {
      const entry = map.get(`${POLICY_VERSION_PREFIX}${type}`);
      if (entry && typeof entry.value === 'string') {
        versions[type] = entry.value;
      }
    }
    return versions;
  }

  private buildLimits(
    map: ReadonlyMap<string, ResolvedConfigEntry>,
    allow: (key: string) => boolean,
  ): Record<string, unknown> {
    const limits: Record<string, unknown> = {
      uploadMaxBytes: this.readJson<Record<string, number>>(map, 'uploadMaxBytes', {}),
      nicknameMaxLength: this.readNumber(map, 'nicknameMaxLength', 20),
      statusMessageMaxLength: this.readNumber(map, 'statusMessageMaxLength', 30),
      aiMessageMaxLength: this.readNumber(map, 'aiMessageMaxLength', 2000),
      pageSizeMax: this.readNumber(map, 'pageSizeMax', 100),
    };

    if (allow('freeAiQuotaTotal')) limits.freeAiQuotaTotal = this.readNumber(map, 'freeAiQuotaTotal', 10);
    if (allow('memberAiDailyLimit')) limits.memberAiDailyLimit = this.readNumber(map, 'memberAiDailyLimit', 50);
    if (allow('reportRegenerateDailyLimit')) {
      limits.reportRegenerateDailyLimit = this.readNumber(map, 'reportRegenerateDailyLimit', 5);
    }

    return limits;
  }

  /**
   * `keys` 白名单 → 判定函数
   *
   * 只裁剪「配置项字段」，**不裁剪分区骨架**，也**永不裁剪免责声明**：
   *   · 裁剪骨架会让前端遇到两种响应形状，是线上崩页面的常见来源；
   *   · 免责声明是合规硬约束（架构 1.2），任何调用方式下都必须下发。
   */
  private buildKeyWhitelist(keys: string | undefined, max: number): (key: string) => boolean {
    if (!keys || keys.trim().length === 0) return () => true;

    const parsed = [
      ...new Set(
        keys
          .split(',')
          .map((key) => key.trim())
          .filter((key) => key.length > 0),
      ),
    ];

    if (parsed.length > max) {
      throw new ConfigRequestError(`keys 最多 ${max} 个`);
    }

    const allowSet = new Set(parsed);
    return (key: string) => allowSet.has(key);
  }

  private async loadMembershipPlans(): Promise<unknown[]> {
    try {
      const plans = await this.prisma.membershipPlan.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { priceAmount: 'asc' }],
        select: { code: true, name: true, priceAmount: true, durationDays: true, isRecommended: true, currency: true },
      });

      return plans.map((plan) => ({
        planCode: plan.code,
        name: plan.name,
        priceAmount: plan.priceAmount,
        priceDisplay: formatPrice(plan.priceAmount, currencySymbolOf(plan.currency)),
        durationDays: plan.durationDays,
        isRecommended: plan.isRecommended,
      }));
    } catch (error) {
      // 价格读不到时返回空数组而不是让首屏 500：套餐页会展示「暂不可购买」，
      // 下单仍以服务端为准（架构 13.2），不会因为展示层故障造成错误扣款
      this.logger.warn(`读取会员套餐失败，本次不下发套餐价格: ${(error as Error).message}`);
      return [];
    }
  }

  private async loadProducts(): Promise<unknown[]> {
    try {
      const products = await this.prisma.product.findMany({
        where: { status: 'ON_SALE', deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { priceAmount: 'asc' }],
        select: { code: true, name: true, type: true, priceAmount: true, currency: true },
      });

      return products.map((product) => ({
        productCode: product.code,
        name: product.name,
        type: product.type,
        priceAmount: product.priceAmount,
        priceDisplay: formatPrice(product.priceAmount, currencySymbolOf(product.currency)),
      }));
    } catch (error) {
      this.logger.warn(`读取商品列表失败，本次不下发商品价格: ${(error as Error).message}`);
      return [];
    }
  }

  // ==========================================================================
  // 数据来源与缓存（内部）
  // ==========================================================================

  /**
   * 组装快照：目录提供语义，数据库提供真值，环境变量提供最终锁定项
   *
   * 优先级（从高到低）：
   *   1. 环境变量锁定项（`envOverride` 非空）—— 「配置即环境变量」，后台不能覆盖；
   *   2. `system_configs` 中的行 —— 后台热改的运行时策略；
   *   3. 环境变量基线（`baselinePath`）—— 库里还没有这一行时的默认值；
   *   4. 目录里的静态默认值 —— 保证首屏永不缺字段。
   */
  private async loadFromSources(): Promise<ConfigSnapshot> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { deletedAt: null },
      select: {
        key: true,
        value: true,
        valueType: true,
        group: true,
        description: true,
        isPublic: true,
        isEditable: true,
        updatedAt: true,
        updatedByAdminId: true,
      },
    });

    const rowMap = new Map(rows.map((row) => [row.key, row]));
    const entries: ResolvedConfigEntry[] = [];

    for (const definition of CONFIG_DEFINITIONS) {
      const row = rowMap.get(definition.key);
      const envLocked = definition.envOverride !== undefined;
      const baseline = definition.baselinePath ? this.readBaseline(definition.baselinePath) : null;

      const rawValue = definition.envLockedPath
        ? (this.readBaseline(definition.envLockedPath, definition.defaultValue) ?? definition.defaultValue)
        : (row?.value ?? baseline ?? definition.defaultValue);

      entries.push({
        key: definition.key,
        group: definition.group,
        groupName: CONFIG_GROUP_NAMES[definition.group],
        label: definition.label,
        valueType: definition.valueType,
        value: parseConfigValue(rawValue, definition.valueType),
        rawValue,
        description: definition.description,
        // 环境变量锁定项与 DB 显式标为不可编辑的项，后台都只读
        isEditable: envLocked ? false : (row?.isEditable ?? true),
        requiresConfirmPassword: definition.requiresConfirmPassword,
        envOverride: definition.envOverride ?? null,
        impactScope: definition.impactScope,
        isPublic: row?.isPublic ?? definition.isPublic,
        min: definition.min ?? null,
        max: definition.max ?? null,
        updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
        updatedByAdminId: row?.updatedByAdminId ?? null,
        isKnown: true,
      });
    }

    // 库中存在的「目录之外」的键：可能是历史键或本版本尚未纳入治理的键。
    // 一律以只读方式下发 —— 后台看不到它的语义与取值范围，允许修改等于给运维一个
    // 无约束的写入口，而这些键往往被其它模块按固定格式解析。
    for (const row of rows) {
      if (CONFIG_DEFINITION_MAP.has(row.key)) continue;

      entries.push({
        key: row.key,
        group: row.group,
        groupName: CONFIG_GROUP_NAMES[row.group as ConfigGroup] ?? row.group,
        label: row.key,
        valueType: row.valueType,
        value: parseConfigValue(row.value, row.valueType),
        rawValue: row.value,
        description: row.description ?? '未纳入配置目录的历史键，后台只读',
        isEditable: false,
        requiresConfirmPassword: false,
        envOverride: null,
        impactScope: 'GLOBAL',
        isPublic: row.isPublic,
        min: null,
        max: null,
        updatedAt: row.updatedAt.toISOString(),
        updatedByAdminId: row.updatedByAdminId,
        isKnown: false,
      });
    }

    const now = new Date();

    return {
      version: buildConfigVersion(entries, now),
      generatedAt: now.toISOString(),
      entries,
    };
  }

  /** 读环境变量基线（经 ConfigService，业务代码不直接触碰 process.env） */
  private readBaseline(
    path: NonNullable<ConfigDefinition['baselinePath']>,
    fallback: string | null = null,
  ): string | null {
    // 显式标注 unknown：baselinePath 目前只指向布尔/数字配置，若按 infer 推断，
    // 下面的字符串分支会被判成 never（后续新增字符串型基线时反而报错）
    const value: unknown = this.configService.get(path, { infer: true });

    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.length > 0) return value;

    return fallback;
  }

  private cacheKey(): string {
    return this.redis.key('system', 'config');
  }

  private async readCache(): Promise<ConfigSnapshot | null> {
    try {
      return await this.redis.getJson<ConfigSnapshot>(this.cacheKey());
    } catch (error) {
      this.logger.warn(`读取系统配置缓存失败，回退直查数据库: ${(error as Error).message}`);
      return null;
    }
  }

  private async writeCache(snapshot: ConfigSnapshot): Promise<void> {
    try {
      await this.redis.setJson(this.cacheKey(), snapshot, SYSTEM_CONFIG_CACHE_TTL_SECONDS);
    } catch (error) {
      // 缓存写失败不影响本次响应（本来就是直查数据库得到的），只留痕
      this.logger.warn(`写入系统配置缓存失败: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- 取值工具

  private readString(map: ReadonlyMap<string, ResolvedConfigEntry>, key: string, fallback: string): string {
    const value = map.get(key)?.value;
    return typeof value === 'string' ? value : fallback;
  }

  private readNumber(map: ReadonlyMap<string, ResolvedConfigEntry>, key: string, fallback: number): number {
    const value = map.get(key)?.value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    // 库里被人工写成非数字时，按数字字符串再试一次，仍失败则用兜底值
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }

    return fallback;
  }

  private readBoolean(map: ReadonlyMap<string, ResolvedConfigEntry>, key: string, fallback: boolean): boolean {
    const value = map.get(key)?.value;
    return typeof value === 'boolean' ? value : fallback;
  }

  private readJson<T>(map: ReadonlyMap<string, ResolvedConfigEntry>, key: string, fallback: T): T {
    const value = map.get(key)?.value;
    return value !== null && typeof value === 'object' ? (value as T) : fallback;
  }
}

/** 请求参数不合法（仅用于 `keys` 数量上限这类本地校验，由调用方转成 BusinessException） */
export class ConfigRequestError extends Error {}

/** 条目数组 → 按键索引 */
const toEntryMap = (entries: ResolvedConfigEntry[]): Map<string, ResolvedConfigEntry> =>
  new Map(entries.map((entry) => [entry.key, entry]));

/** 币种符号：目前只面向人民币，其它币种回退为币种代码本身 */
const currencySymbolOf = (currency: string): string => (currency === 'CNY' ? '¥' : `${currency} `);
