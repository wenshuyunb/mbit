/**
 * 用户服务
 *
 * 契约来源：docs/API_DESIGN.md §3.2
 *
 * 合规要点（架构 §9.4 用户数据权利）：
 *   · 手机号只返回脱敏值，绝不返回明文
 *   · 生日只返回年龄段，不返回精确年龄（隐私最小化）
 *   · 注销需三重二次确认（确认文本 + 两项 acknowledge）
 *   · 冷静期内允许查询/撤销注销，但禁止修改资料与发起新业务
 *   · 注销到期由 cron 执行匿名化（本模块负责申请与撤销，不执行匿名化本身）
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { calculateAge, maskPhone, normalizePhoneDigits, toAgeRange } from '../../common/utils/mask.util';
import { isUniqueConstraintError } from '../../common/utils/prisma-error.util';
import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { decryptWechatEncryptedData } from '../../infra/wechat/wechat-crypto.util';
import { WechatService } from '../../infra/wechat/wechat.service';
import { StorageService } from '../storage/storage.service';
import { extractObjectKeyFromUrl } from '../storage/storage.util';
import {
  DELETION_CONFIRM_TEXT,
  type BindPhoneDto,
  type CancelDeletionDto,
  type ConsentTypeValue,
  type IncludeBlock,
  type RequestDeletionDto,
  type SubmitConsentDto,
  type UpdateAvatarDto,
  type UpdateProfileDto,
} from './dto/user.dto';

// ============================================================================
// 响应类型
// ============================================================================

/** 画像摘要（include=profile） */
export interface ProfileBlock {
  profileId: string;
  mbtiType: string;
  engineVersion: string;
  version: number;
  confidence: number;
  bigFive: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
  };
  relationshipStyle: {
    attachment: string;
    loveLanguage: string[];
    conflictStyle: string | null;
  };
  generatedAt: string;
}

/** 会员摘要（include=membership） */
export interface MembershipBlock {
  isActive: boolean;
  planCode: string | null;
  planName: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
  remainingDays: number | null;
}

/** AI 配额摘要（include=aiQuota） */
export interface AiQuotaBlock {
  remaining: number;
  dailyLimit: number;
  usedToday: number;
  resetAt: string;
  creditBalance: number;
}

/** 使用统计（include=stats） */
export interface StatsBlock {
  testSessionCount: number;
  reportCount: number;
  relationshipCount: number;
  aiMessageCount: number;
}

/** 同意记录条目（契约 §3.2.5） */
export interface ConsentEntry {
  type: ConsentTypeValue;
  /** 用户已同意的版本；从未同意为 null */
  version: string | null;
  /** 服务端当前版本 */
  currentVersion: string;
  /** 已同意的版本是否等于当前版本 */
  isLatest: boolean;
  agreed: boolean;
  agreedAt: string | null;
  revokedAt: string | null;
  /** 协议正文地址（未配置 legalBaseUrl 时为 null） */
  url: string | null;
}

/** 同意记录聚合视图 */
export interface ConsentsView {
  consents: ConsentEntry[];
  /** 是否存在必同意项未按当前版本同意（前端必须弹窗重新确认） */
  requiresReconsent: boolean;
  /** 待重新同意的类型清单 */
  pendingTypes: ConsentTypeValue[];
  checkedAt: string;
}

/** GET /users/me 响应 */
export interface MeView {
  id: string;
  nickname: string | null;
  avatarUrl: string | null;
  gender: string;
  birthday: string | null;
  ageRange: string | null;
  phoneBound: boolean;
  phoneMasked: string | null;
  status: string;
  ageVerified: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  profile?: ProfileBlock;
  membership?: MembershipBlock;
  aiQuota?: AiQuotaBlock;
  stats?: StatsBlock;
  consents?: ConsentsView;
}

/** PATCH /users/me 响应 */
export interface ProfileUpdatedView {
  id: string;
  nickname: string | null;
  avatarUrl: string | null;
  gender: string;
  birthday: string | null;
  ageRange: string | null;
  version: number;
  updatedAt: string;
}

/** 注销状态（GET/DELETE /users/me/deletion、POST 响应共用） */
export interface DeletionStatusView {
  hasRequest: boolean;
  requestId: string | null;
  status: string | null;
  reason: string | null;
  requestedAt: string | null;
  scheduledAt: string | null;
  remainingDays: number | null;
  canCancel: boolean;
  cancelDeadline: string | null;
  completedAt: string | null;
  retainedDataNotice: string;
}

/** 注销申请响应（POST 201 额外返回清单与提示） */
export interface DeletionRequestView extends DeletionStatusView {
  willBeDeleted: string[];
  willBeRetained: string[];
  notice: string;
}

/** POST /users/me/phone 响应（契约 §3.2.4） */
export interface PhoneBoundView {
  phoneBound: boolean;
  phoneMasked: string;
  countryCode: string;
  boundAt: string;
  /** 本次是否为「换绑」（此前已绑定过其他号码） */
  isReplaced: boolean;
}

/** POST /users/me/avatar 响应（契约 §3.2.3） */
export interface AvatarUpdatedView {
  /** 对外访问地址；使用系统默认头像且未配置默认图时为 null */
  avatarUrl: string | null;
  avatarThumbUrl: string | null;
  /** 以 OSS HEAD 结果为准的实际字节数；默认头像时为 null */
  size: number | null;
  /** 由魔数检测出的真实 MIME 类型；默认头像时为 null */
  mimeType: string | null;
  updatedAt: string;
}

// ============================================================================
// 常量
// ============================================================================

/** 法定留存说明文案（合规文案统一在此维护，避免多处不一致） */
const RETAINED_DATA_NOTICE = '订单与支付记录将依据法律法规要求保留 3 年，其余个人数据将被删除或匿名化处理。';

/** 手机号换绑次数的 Redis 计数器前缀 */
const PHONE_REBIND_COUNTER_PREFIX = 'phone:rebind';

/** 换绑计数窗口（秒）：契约 §3.2.4 规则 3「7 天内最多换绑 3 次」 */
const PHONE_REBIND_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/** 换绑次数上限 */
const PHONE_REBIND_MAX_ATTEMPTS = 3;

/** 中国大陆手机号形态（11 位、1 开头、第二位 3–9） */
const CHINA_MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/** system_configs 中的默认头像键（契约 §3.2.3 规则 5） */
const DEFAULT_AVATAR_CONFIG_KEY = 'avatar.default';

/**
 * 旧头像延迟清理天数（契约 §3.2.3 规则 3）
 *
 * 不立即删除：CDN 与客户端仍持有旧图缓存，立刻删会造成一段时间内图片 404 闪烁。
 */
const AVATAR_CLEANUP_DELAY_DAYS = 7;

/** 头像缩略图处理参数（架构 §7.4：图片统一走 `?x-oss-process` 实时裁剪） */
const AVATAR_THUMB_PROCESS = 'image/resize,w_120/format,webp';

const WILL_BE_DELETED = [
  '昵称、头像、性别、生日',
  '人格画像与测试答案明细',
  'AI 对话原文（保留匿名化的用量统计）',
  '分享记录与关系档案中的个人侧数据',
];

const WILL_BE_RETAINED = ['订单与支付记录（法定留存 3 年）', '退款与对账凭证（法定留存 3 年）'];

/** 注销申请的幂等键 Redis 前缀 */
const DELETION_IDEMPOTENCY_PREFIX = 'idem:deletion';

/** 幂等记录保留时长（秒）—— 覆盖冷静期内重复提交的场景 */
const DELETION_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 协议版本兜底值
 *
 * 正常应由 `system_configs` 下发（后台可改），此处兜底保证「库中无配置」时
 * 服务仍可用（否则协议同意功能会因缺配置而完全不可用）。
 */
const FALLBACK_POLICY_VERSIONS: Record<ConsentTypeValue, string> = {
  PRIVACY_POLICY: '2026-02-14',
  TERMS_OF_SERVICE: '2026-02-14',
  AGE_DECLARATION: '2026-02-14',
  AI_CONTENT_NOTICE: '2026-02-14',
  MARKETING: '2026-02-14',
};

/** system_configs 中的协议版本键 */
const POLICY_VERSION_CONFIG_KEY = 'policy.version';

/** 注销原因的存储分隔符：`CODE|detail` */
const REASON_DETAIL_SEPARATOR = '|';

/**
 * 全部同意类型（顺序即前端展示顺序，与契约 §3.2.5 规则 1 一致）
 *
 * ⚠ 契约文档写作 `USER_AGREEMENT`，而 Prisma 枚举为 `TERMS_OF_SERVICE`，
 *   以 schema 为准（见 API_DESIGN §2.4.0 枚举对齐说明）。
 */
const ALL_CONSENT_TYPES: readonly ConsentTypeValue[] = [
  'PRIVACY_POLICY',
  'TERMS_OF_SERVICE',
  'AGE_DECLARATION',
  'AI_CONTENT_NOTICE',
  'MARKETING',
];

/**
 * 必同意项
 *
 * 前三项为使用产品的前置条件；`AI_CONTENT_NOTICE` 与 `MARKETING` 不阻断使用：
 *   · AI 内容提示属于「告知」而非「授权」，展示即可
 *   · 营销授权必须是可选项（合规要求）
 */
const REQUIRED_CONSENT_TYPES: readonly ConsentTypeValue[] = ['PRIVACY_POLICY', 'TERMS_OF_SERVICE', 'AGE_DECLARATION'];

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  private readonly graceDays: number;
  private readonly freeAiMessages: number;
  private readonly memberDailyAiMessages: number;
  /** 协议正文基址（未配置时协议 url 返回 null，前端隐藏「查看原文」入口） */
  private readonly legalBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly wechat: WechatService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.graceDays = configService.get('quota.accountDeletionGraceDays', { infer: true });
    this.freeAiMessages = configService.get('quota.freeAiMessages', { infer: true });
    this.memberDailyAiMessages = configService.get('quota.memberDailyAiMessages', { infer: true });
    this.legalBaseUrl = configService.get('app.legalBaseUrl', { infer: true }).replace(/\/+$/, '');
  }

  // ==========================================================================
  // GET /users/me
  // ==========================================================================

  /**
   * 获取当前用户聚合资料
   *
   * 契约规则 3：`include` 未指定的块**不返回 key**（而非返回 null），
   * 因此这里用条件赋值构造对象，而不是先给默认值再置空。
   */
  async getMe(userId: string, include: IncludeBlock[] = []): Promise<MeView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        avatarUrl: true,
        gender: true,
        birthday: true,
        phoneEnc: true,
        phoneHash: true,
        status: true,
        ageVerified: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        anonymizedAt: true,
      },
    });

    // 契约错误码 30001：用户记录不存在（已被匿名化清理）
    if (!user || user.deletedAt !== null || user.anonymizedAt !== null) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    const view: MeView = {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      gender: user.gender,
      birthday: user.birthday ? user.birthday.toISOString().slice(0, 10) : null,
      ageRange: toAgeRange(user.birthday),
      phoneBound: user.phoneHash !== null,
      // 契约规则 1：只返回脱敏手机号。phoneEnc 解密后立即脱敏，明文不出本方法作用域
      phoneMasked: maskPhone(this.crypto.tryDecrypt(user.phoneEnc)),
      status: user.status,
      ageVerified: user.ageVerified,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      version: user.version,
    };

    // -------------------------------------------------- include 块并行加载
    const tasks: Array<Promise<void>> = [];

    if (include.includes('profile')) {
      tasks.push(
        this.loadProfile(userId).then((block) => {
          if (block) view.profile = block;
        }),
      );
    }

    if (include.includes('membership')) {
      tasks.push(
        this.loadMembership(userId).then((block) => {
          view.membership = block;
        }),
      );
    }

    if (include.includes('aiQuota')) {
      tasks.push(
        this.loadAiQuota(userId).then((block) => {
          view.aiQuota = block;
        }),
      );
    }

    if (include.includes('stats')) {
      tasks.push(
        this.loadStats(userId).then((block) => {
          view.stats = block;
        }),
      );
    }

    if (include.includes('consents')) {
      tasks.push(
        this.listConsents(userId).then((list) => {
          view.consents = list;
        }),
      );
    }

    await Promise.all(tasks);

    return view;
  }

  // ==========================================================================
  // PATCH /users/me
  // ==========================================================================

  /**
   * 更新用户资料（PATCH 语义：只改传入字段）
   *
   * 契约规则：
   *   1. 昵称保存前必过 `msgSecCheck`，命中违规不入库、不覆盖旧值
   *   2. 生日变更可能使 ageVerified 置 false（不做破坏性回滚）
   *   4. 乐观锁：传 expectedVersion 则强校验，不传则最后写入者胜
   */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<ProfileUpdatedView> {
    await this.assertNotInDeletionGrace(userId, ErrorCode.PROFILE_EDIT_LOCKED);

    // ---------------------------------------------------------------- 昵称校验
    if (dto.nickname !== undefined && dto.nickname !== null) {
      if (dto.nickname.trim() === '') {
        throw BusinessException.badRequest(ErrorCode.NICKNAME_INVALID);
      }

      const account = await this.prisma.wechatAccount.findFirst({
        where: { userId, deletedAt: null },
        select: { openid: true },
      });

      const secCheck = await this.wechat.msgSecCheck(dto.nickname, account?.openid);

      if (!secCheck.pass) {
        this.logger.warn(
          `昵称未通过内容安全检测 userId=${userId} suggest=${secCheck.suggest} label=${secCheck.label ?? 'n/a'}`,
        );
        throw BusinessException.badRequest(ErrorCode.CONTENT_BLOCKED);
      }

      // fail-open 时记录审计（契约 §3.2.2 错误码 90008 的要求）
      if (!secCheck.checked) {
        this.logger.warn(`昵称内容安全检测未执行（fail-open 放行）userId=${userId}`);
      }
    }

    // ---------------------------------------------------------- 组装更新数据
    const data: Record<string, unknown> = { version: { increment: 1 } };

    if (dto.nickname !== undefined) data['nickname'] = dto.nickname;
    if (dto.gender !== undefined) data['gender'] = dto.gender === null ? 'UNKNOWN' : dto.gender;

    if (dto.birthday !== undefined) {
      if (dto.birthday === null) {
        data['birthday'] = null;
      } else {
        const birthday = this.parseBirthday(dto.birthday);
        data['birthday'] = birthday;

        // 规则 2：生日显示 < 18 岁 → ageVerified 置 false（已有关系保留，仅禁止新建）
        const age = calculateAge(birthday);
        if (age !== null && age < 18) {
          data['ageVerified'] = false;
          this.logger.log(`用户提交的生日显示未满 18 岁，已置 ageVerified=false userId=${userId}`);
        }
      }
    }

    // ---------------------------------------------------------------- 乐观锁
    const where: { id: string; version?: number } = { id: userId };
    if (dto.expectedVersion !== undefined) {
      where.version = dto.expectedVersion;
    }

    const updated = await this.prisma.user.updateMany({
      where,
      data,
    });

    if (updated.count === 0) {
      // 区分「版本冲突」与「用户不存在」：先确认用户是否还在
      const exists = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!exists) {
        throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
      }
      throw BusinessException.conflict(ErrorCode.VERSION_OUTDATED);
    }

    const fresh = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        avatarUrl: true,
        gender: true,
        birthday: true,
        version: true,
        updatedAt: true,
      },
    });

    if (!fresh) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    return {
      id: fresh.id,
      nickname: fresh.nickname,
      avatarUrl: fresh.avatarUrl,
      gender: fresh.gender,
      birthday: fresh.birthday ? fresh.birthday.toISOString().slice(0, 10) : null,
      ageRange: toAgeRange(fresh.birthday),
      version: fresh.version,
      updatedAt: fresh.updatedAt.toISOString(),
    };
  }

  // ==========================================================================
  // 手机号绑定
  // ==========================================================================

  /**
   * 绑定或换绑手机号（契约 §3.2.4）
   *
   * 安全要点：
   *   · **明文零落库**：号码只在内存中存在，落库的是 AES-256-GCM 密文（`phoneEnc`）
   *     与加盐摘要（`phoneHash`）；本方法全程不把号码写入日志
   *   · **加盐哈希**：`phoneHash` 必须走 `sha256Salted`。手机号空间仅 10^9 量级，
   *     无盐摘要可被离线枚举，等于明文（见 `CryptoService` 说明）
   *   · **失败不留痕**：取号/解密失败时不写任何字段，`phoneBound` 保持原值
   *
   * 步骤顺序是刻意的：冷静期 → 用户存在 → 取号 → 查重 → 限流 → 落库。
   * 限流放在「取号之后」而非之前，是因为真正的成本点是写库与换绑，
   * 而取号本身已受微信侧配额约束；把限流提前会误伤「点了授权但号码非法」的正常用户。
   */
  async bindPhone(userId: string, dto: BindPhoneDto): Promise<PhoneBoundView> {
    const hasCode = typeof dto.code === 'string' && dto.code.length > 0;
    const hasEncryptedData = typeof dto.encryptedData === 'string' && dto.encryptedData.length > 0;

    // 跨字段约束（DTO 只保证单字段自身合法）
    if (!hasCode && !hasEncryptedData) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'code 与 encryptedData 至少提供一个');
    }
    if (!hasCode && !(typeof dto.iv === 'string' && dto.iv.length > 0)) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '使用 encryptedData 时必须同时提供 iv');
    }

    // 服务端前置条件：盐值未配置时无法安全计算 `phoneHash`（见 CryptoService）。
    // 必须放在**任何外部调用之前**——否则每个请求都会先白耗一次微信接口配额，
    // 再在算哈希时失败。配置问题应当立即暴露，而不是伪装成「微信不可用」。
    if (!this.crypto.saltedHashAvailable) {
      throw new BusinessException(ErrorCode.CONFIG_MISSING, '服务端未配置手机号哈希盐值，暂时无法完成该操作');
    }

    // 冷静期内禁止绑定：账号数据即将被删除，此时绑定只会留下待清理的敏感字段
    await this.assertNotInDeletionGrace(userId, ErrorCode.PROFILE_EDIT_LOCKED);

    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phoneHash: true },
    });
    if (current === null) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    const resolved = await this.resolvePhoneNumber(userId, dto, hasCode);

    // 加盐摘要：盐未配置时在此抛 CONFIG_MISSING —— 宁可不绑定，也不写弱哈希
    const phoneHash = this.crypto.sha256Salted(resolved.purePhoneNumber);
    const phoneMasked = maskPhone(resolved.purePhoneNumber) ?? '';

    // 幂等：重复绑定同一号码直接返回成功，且**不消耗**换绑次数
    if (current.phoneHash !== null && this.crypto.safeEqual(current.phoneHash, phoneHash)) {
      const existing = await this.prisma.userPhoneHistory.findFirst({
        where: { userId, phoneHash, replacedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      return {
        phoneBound: true,
        phoneMasked,
        countryCode: resolved.countryCode,
        boundAt: (existing?.createdAt ?? new Date()).toISOString(),
        isReplaced: false,
      };
    }

    // 号码归属查重：换绑到他人已绑定的号码必须拒绝。
    // 唯一索引同样会拦住，但提前查一次能返回准确的业务错误码而非数据库异常。
    const owner = await this.prisma.user.findUnique({
      where: { phoneHash },
      select: { id: true },
    });
    if (owner !== null && owner.id !== userId) {
      throw BusinessException.conflict(ErrorCode.PHONE_ALREADY_BOUND);
    }

    const isReplaced = current.phoneHash !== null;

    // 换绑限流：仅真正的换绑计数，首次绑定不占用额度（契约 §3.2.4 规则 3）
    if (isReplaced) {
      const counterKey = this.redis.key(PHONE_REBIND_COUNTER_PREFIX, userId);
      const attempts = await this.redis.incrWithTtl(counterKey, PHONE_REBIND_WINDOW_SECONDS);

      if (attempts > PHONE_REBIND_MAX_ATTEMPTS) {
        throw BusinessException.tooManyRequests(
          ErrorCode.RATE_LIMITED,
          `7 天内最多换绑 ${PHONE_REBIND_MAX_ATTEMPTS} 次，请稍后再试`,
        );
      }
    }

    const now = new Date();
    const phoneEnc = this.crypto.encrypt(resolved.purePhoneNumber);

    try {
      await this.prisma.$transaction(async (tx) => {
        if (isReplaced) {
          // 旧的「当前号码」行标记替换时刻；历史行保留（合规审计要求）
          await tx.userPhoneHistory.updateMany({
            where: { userId, replacedAt: null },
            data: { replacedAt: now },
          });
        }

        await tx.userPhoneHistory.create({
          data: {
            userId,
            phoneHash,
            phoneMasked,
            countryCode: resolved.countryCode,
            source: dto.source ?? 'BUTTON',
          },
        });

        await tx.user.update({
          where: { id: userId },
          data: { phoneEnc, phoneHash },
        });
      });
    } catch (error) {
      // 并发抢绑同一号码时唯一索引会报 P2002 → 归一为业务错误码
      if (isUniqueConstraintError(error)) {
        throw BusinessException.conflict(ErrorCode.PHONE_ALREADY_BOUND);
      }
      throw error;
    }

    this.logger.log(
      `手机号绑定成功 userId=${userId} isReplaced=${isReplaced} source=${dto.source ?? 'BUTTON'} masked=${phoneMasked}`,
    );

    return {
      phoneBound: true,
      phoneMasked,
      countryCode: resolved.countryCode,
      boundAt: now.toISOString(),
      isReplaced,
    };
  }

  /**
   * 取得手机号明文并归一化（契约 §3.2.4 的两条路径）
   *
   * 返回值**绝不写日志**：调用方拿到后立即加密与哈希，明文随即离开作用域。
   */
  private async resolvePhoneNumber(
    userId: string,
    dto: BindPhoneDto,
    hasCode: boolean,
  ): Promise<{ purePhoneNumber: string; countryCode: string }> {
    // ---- 推荐路径：动态令牌由微信服务端直接换取号码 ----
    if (hasCode) {
      const result = await this.wechat.getPhoneNumber(dto.code as string);
      return this.normalizeResolvedPhone(result.purePhoneNumber, result.countryCode);
    }

    // ---- 兼容路径：用 session_key 解密旧版 encryptedData ----
    const account = await this.prisma.wechatAccount.findUnique({
      where: { userId },
      select: { sessionKeyEnc: true },
    });

    const sessionKey = this.crypto.tryDecrypt(account?.sessionKeyEnc ?? null);
    if (sessionKey === null) {
      // session_key 缺失或无法解密：需用户重新进入小程序换取新的会话密钥
      throw new BusinessException(ErrorCode.WECHAT_SESSION_EXPIRED, '登录授权已过期，请重新进入小程序后再试');
    }

    let payload: Record<string, unknown>;
    try {
      payload = decryptWechatEncryptedData({
        encryptedData: dto.encryptedData as string,
        iv: dto.iv as string,
        sessionKey,
      });
    } catch {
      // 不区分「密钥错 / 密文坏 / 明文非法」—— 统一为解密失败，不给出可探测的信号
      throw new BusinessException(ErrorCode.PHONE_DECRYPT_FAILED);
    }

    const pure = payload['purePhoneNumber'];
    const full = payload['phoneNumber'];
    const country = payload['countryCode'];

    const rawNumber =
      typeof pure === 'string' && pure.length > 0 ? pure : typeof full === 'string' && full.length > 0 ? full : null;

    if (rawNumber === null) {
      throw new BusinessException(ErrorCode.PHONE_DECRYPT_FAILED, '解密结果中缺少手机号');
    }

    return this.normalizeResolvedPhone(rawNumber, typeof country === 'string' ? country : '86');
  }

  /**
   * 归一化并校验号码形态
   *
   * 目前只支持中国大陆号码：形态不符时**拒绝落库**，
   * 而不是把可疑值写进带唯一索引的敏感列（脏数据一旦进了唯一索引很难清理）。
   */
  private normalizeResolvedPhone(
    rawNumber: string,
    rawCountryCode: string,
  ): { purePhoneNumber: string; countryCode: string } {
    const digits = normalizePhoneDigits(rawNumber) ?? '';

    if (!CHINA_MOBILE_PATTERN.test(digits)) {
      throw new BusinessException(ErrorCode.PHONE_DECRYPT_FAILED, '暂不支持该手机号（目前仅支持中国大陆号码）');
    }

    const countryDigits = rawCountryCode.replace(/\D/g, '');

    return {
      purePhoneNumber: digits,
      countryCode: countryDigits.length > 0 ? countryDigits : '86',
    };
  }

  // ==========================================================================
  // 头像
  // ==========================================================================

  /**
   * 上传头像（契约 §3.2.3）
   *
   * 本接口**不接收文件二进制**：客户端先申请票据直传 OSS，再用本接口登记。
   * 因此这里做的是「归属 + 内容 + 大小」三重把关，而不是接收文件。
   *
   * 关键取舍：
   *   · **内容校验不可省**：OSS 回调可能因网络失败未到达（例如尚未配置
   *     `callbackUrl`），而本接口是用户直接触发的，必须能独立保证
   *     「被采用的文件确实是合法图片」。校验由 `StorageService` 统一实现。
   *   · **大小以 OSS HEAD 为准**：前端声明的 `size` 只用于提前拒绝，
   *     可信度低于服务端自查（契约 §3.2.3 字段说明明确要求）。
   *   · **旧头像延迟清理**：更新成功后安排 7 天后删除，给 CDN 留缓存窗口。
   */
  async updateAvatar(userId: string, dto: UpdateAvatarDto): Promise<AvatarUpdatedView> {
    // 冷静期内禁止修改资料（与 updateProfile 同一约束）
    await this.assertNotInDeletionGrace(userId, ErrorCode.PROFILE_EDIT_LOCKED);

    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, avatarUrl: true },
    });
    if (current === null) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    const now = new Date();

    // ---- 分支一：改用系统默认头像（不触碰 OSS，契约 §3.2.3 规则 5） ----
    if (dto.isDefault === true) {
      const defaultUrl = await this.readDefaultAvatarUrl();
      if (defaultUrl === null) {
        // 不静默写入 null 之外的假地址：未配置默认图是运营配置缺失，应显式暴露
        throw new BusinessException(ErrorCode.AVATAR_INVALID, '系统默认头像未配置');
      }

      await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: defaultUrl } });

      return {
        avatarUrl: defaultUrl,
        avatarThumbUrl: defaultUrl,
        size: null,
        mimeType: null,
        updatedAt: now.toISOString(),
      };
    }

    // ---- 分支二：登记已直传的对象 ----
    if (typeof dto.objectKey !== 'string' || dto.objectKey.length === 0) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'objectKey 与 isDefault 至少提供一个');
    }

    const registered = await this.storage.registerUploadedObject({
      objectKey: dto.objectKey,
      userId,
      scene: 'AVATAR',
      ...(typeof dto.size === 'number' ? { declaredSize: dto.size } : {}),
    });

    // 旧头像安排延迟清理：仅当它确属本系统对象时才精确清理
    const previousObjectKey = extractObjectKeyFromUrl(current.avatarUrl);
    if (previousObjectKey !== null && previousObjectKey !== registered.objectKey) {
      await this.storage.scheduleObjectCleanup(previousObjectKey, AVATAR_CLEANUP_DELAY_DAYS);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: registered.publicUrl },
    });

    this.logger.log(
      `头像更新成功 userId=${userId} size=${registered.sizeBytes} mime=${registered.mimeType} replaced=${previousObjectKey !== null}`,
    );

    return {
      avatarUrl: registered.publicUrl,
      avatarThumbUrl: `${registered.publicUrl}?x-oss-process=${AVATAR_THUMB_PROCESS}`,
      size: registered.sizeBytes,
      mimeType: registered.mimeType,
      updatedAt: now.toISOString(),
    };
  }

  /**
   * 读取系统默认头像地址
   *
   * 与免责声明（`disclaimer.personality`）同一模式：配置优先、读取失败不阻断，
   * 未配置时返回 `null` 由调用方决定如何提示（此处是显式报错而非静默降级）。
   */
  private async readDefaultAvatarUrl(): Promise<string | null> {
    try {
      const row = await this.prisma.systemConfig.findUnique({
        where: { key: DEFAULT_AVATAR_CONFIG_KEY },
        select: { value: true },
      });

      const value = row?.value?.trim() ?? '';
      return value.length > 0 ? value : null;
    } catch (error) {
      this.logger.warn(`读取默认头像配置失败: ${(error as Error).message}`);
      return null;
    }
  }

  // ==========================================================================
  // 同意记录
  // ==========================================================================

  /**
   * 查询同意记录聚合视图（契约 §3.2.5）
   *
   * 契约规则 1：返回**固定 5 类**同意项，即使某类从未同意也要出现（`agreed: false`），
   * 否则前端无法渲染「未同意」状态，也无法提示重新同意。
   *
   * 契约规则 2：`requiresReconsent` 驱动前端强制弹窗；服务端在关键写接口也会校验
   * （Phase 3/5/6 接入 `POST /orders`、`/reports`、`/ai/conversations` 时实现）。
   */
  async listConsents(userId: string): Promise<ConsentsView> {
    const [records, currentVersions] = await Promise.all([
      this.prisma.userConsent.findMany({
        where: { userId },
        select: {
          type: true,
          policyVersion: true,
          agreed: true,
          agreedAt: true,
          revokedAt: true,
        },
        orderBy: { agreedAt: 'desc' },
      }),
      this.getCurrentPolicyVersions(),
    ]);

    // 每个类型只取「最新一条」记录：按 agreedAt 倒序后首次出现即为最新
    const latestByType = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      if (!latestByType.has(record.type)) {
        latestByType.set(record.type, record);
      }
    }

    const consents: ConsentEntry[] = ALL_CONSENT_TYPES.map((type) => {
      const record = latestByType.get(type);
      const currentVersion = currentVersions[type];
      const agreed = record?.agreed === true && record.revokedAt === null;

      return {
        type,
        version: record ? record.policyVersion : null,
        currentVersion,
        isLatest: record ? record.policyVersion === currentVersion : false,
        agreed,
        agreedAt: record ? record.agreedAt.toISOString() : null,
        revokedAt: record?.revokedAt ? record.revokedAt.toISOString() : null,
        url: this.buildLegalUrl(type, currentVersion),
      };
    });

    // 必同意项中「未同意」或「同意的不是当前版本」的 → 需要重新同意
    const pendingTypes = consents
      .filter((entry) => REQUIRED_CONSENT_TYPES.includes(entry.type))
      .filter((entry) => !entry.agreed || !entry.isLatest)
      .map((entry) => entry.type);

    return {
      consents,
      requiresReconsent: pendingTypes.length > 0,
      pendingTypes,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * 提交或撤回同意
   *
   * 版本校验（契约错误码 30017 的语义）：客户端提交的版本必须是服务端**当前**版本，
   * 否则说明用户读到的是旧协议，必须重新阅读。
   * 例外：撤回同意（agreed=false）不校验版本 —— 用户有权随时撤回，不应因版本变化被阻断。
   */
  async submitConsent(
    userId: string,
    dto: SubmitConsentDto,
    context: { ip?: string; userAgent?: string; channel?: string } = {},
  ): Promise<ConsentEntry> {
    const currentVersions = await this.getCurrentPolicyVersions();
    const currentVersion = currentVersions[dto.type];

    if (dto.agreed && currentVersion !== dto.policyVersion) {
      throw BusinessException.conflict(ErrorCode.CONSENT_VERSION_STALE, undefined, [
        { field: 'policyVersion', issue: `当前协议版本为 ${currentVersion}，请重新阅读后再确认` },
      ]);
    }

    const now = new Date();

    // 契约规则 4：同意记录不可删除，只能追加新版本记录（合规审计要求）。
    // 因此这里按 (userId, type, policyVersion) upsert —— 同版本重复提交只更新时间，不产生重复行。
    const record = await this.prisma.userConsent.upsert({
      where: {
        userId_type_policyVersion: {
          userId,
          type: dto.type,
          policyVersion: dto.policyVersion,
        },
      },
      create: {
        userId,
        type: dto.type,
        policyVersion: dto.policyVersion,
        agreed: dto.agreed,
        agreedAt: now,
        ...(dto.agreed ? {} : { revokedAt: now }),
        channel: context.channel ?? 'miniapp',
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      update: {
        agreed: dto.agreed,
        agreedAt: now,
        revokedAt: dto.agreed ? null : now,
      },
      select: {
        type: true,
        policyVersion: true,
        agreed: true,
        agreedAt: true,
        revokedAt: true,
      },
    });

    const agreed = record.agreed && record.revokedAt === null;

    return {
      type: record.type,
      version: record.policyVersion,
      currentVersion,
      isLatest: record.policyVersion === currentVersion,
      agreed,
      agreedAt: record.agreedAt.toISOString(),
      revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
      url: this.buildLegalUrl(dto.type, currentVersion),
    };
  }

  /** 读取服务端当前协议版本（system_configs 优先，缺失时用兜底值） */
  async getCurrentPolicyVersions(): Promise<Record<ConsentTypeValue, string>> {
    const result = { ...FALLBACK_POLICY_VERSIONS };

    try {
      const rows = await this.prisma.systemConfig.findMany({
        where: {
          key: { startsWith: `${POLICY_VERSION_CONFIG_KEY}.` },
          deletedAt: null,
        },
        select: { key: true, value: true },
      });

      for (const row of rows) {
        // 形如 `policy.version.PRIVACY_POLICY`
        const type = row.key.slice(POLICY_VERSION_CONFIG_KEY.length + 1) as ConsentTypeValue;
        if (row.value.trim() !== '' && type in result) {
          result[type] = row.value.trim();
        }
      }
    } catch (error) {
      // 配置读取失败不应阻断同意流程（兜底版本仍可用）
      this.logger.warn(`读取协议版本配置失败，使用兜底值: ${(error as Error).message}`);
    }

    return result;
  }

  // ==========================================================================
  // 账号注销
  // ==========================================================================

  /** 查询注销状态（冷静期内该接口仍可访问，以便用户撤销） */
  async getDeletionStatus(userId: string): Promise<DeletionStatusView> {
    const request = await this.prisma.userDeletionRequest.findFirst({
      where: { userId, status: { in: ['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED'] } },
      orderBy: { requestedAt: 'desc' },
      select: {
        id: true,
        status: true,
        reason: true,
        requestedAt: true,
        scheduledAt: true,
        processedAt: true,
        cancelledAt: true,
      },
    });

    if (!request) {
      return this.emptyDeletionStatus();
    }

    const now = Date.now();
    const scheduledAt = request.scheduledAt.getTime();
    const isPending = request.status === 'PENDING';

    return {
      hasRequest: isPending,
      requestId: request.id,
      status: request.status,
      reason: request.reason ? this.splitReason(request.reason).code : null,
      requestedAt: request.requestedAt.toISOString(),
      scheduledAt: request.scheduledAt.toISOString(),
      // 契约规则 3：向上取整，不足一天按 1 天显示
      remainingDays: isPending ? Math.max(0, Math.ceil((scheduledAt - now) / 86_400_000)) : null,
      canCancel: isPending && scheduledAt > now,
      cancelDeadline: isPending ? request.scheduledAt.toISOString() : null,
      completedAt: request.processedAt ? request.processedAt.toISOString() : null,
      retainedDataNotice: RETAINED_DATA_NOTICE,
    };
  }

  /**
   * 提交注销申请
   *
   * 契约规则：
   *   1. 三重二次确认已在 DTO 层校验（confirmText 精确匹配 + 两项 acknowledge 为 true）
   *   2. 存在进行中的退款 → 拒绝；存在 PENDING_PAY 订单 → 静默关单后继续
   *   5. 幂等：同一幂等键重复提交返回首次结果，不产生第二条申请
   */
  async requestDeletion(
    userId: string,
    dto: RequestDeletionDto,
    context: { idempotencyKey?: string; ip?: string } = {},
  ): Promise<DeletionRequestView> {
    // 二次确认（DTO 已校验，这里再断言一次，避免绕过 DTO 的内部调用产生违规数据）
    if (
      dto.confirmText !== DELETION_CONFIRM_TEXT ||
      dto.acknowledgeRetention !== true ||
      dto.acknowledgeIrreversible !== true
    ) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '注销确认信息不完整');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, anonymizedAt: true, deletedAt: true },
    });

    if (!user || user.deletedAt !== null) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    // 已匿名化完成 → 无法再次申请
    if (user.anonymizedAt !== null) {
      throw BusinessException.conflict(ErrorCode.DELETION_ALREADY_COMPLETED);
    }

    // 已存在 PENDING 申请 → 幂等返回既有申请（而非报错，避免用户重复点击产生错误体验）
    const existing = await this.prisma.userDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
      select: { id: true },
    });

    if (existing) {
      this.logger.log(`用户已有待处理的注销申请，返回既有申请 userId=${userId}`);
      const status = await this.getDeletionStatus(userId);
      return {
        ...status,
        willBeDeleted: WILL_BE_DELETED,
        willBeRetained: WILL_BE_RETAINED,
        notice: this.deletionNotice(),
      };
    }

    // ------------------------------------------------------- 幂等键（契约规则 5）
    // 键值按 (userId, 幂等键哈希) 隔离，避免不同用户的相同幂等键互相影响；
    // TTL 覆盖整个冷静期，保证冷静期内重复提交都能命中同一条记录。
    const idempotencyRedisKey = context.idempotencyKey
      ? this.redis.key(DELETION_IDEMPOTENCY_PREFIX, userId, this.crypto.sha256(context.idempotencyKey).slice(0, 32))
      : null;

    if (idempotencyRedisKey) {
      const previousRequestId = await this.redis.get(idempotencyRedisKey);

      if (previousRequestId) {
        const previous = await this.prisma.userDeletionRequest.findUnique({
          where: { id: previousRequestId },
          select: { id: true, status: true },
        });

        // 首次请求仍有效（任何状态）→ 直接返回其结果，不创建新申请
        if (previous) {
          this.logger.log(`注销申请幂等命中 userId=${userId} requestId=${previous.id}`);
          const status = await this.getDeletionStatus(userId);
          return {
            ...status,
            requestId: previous.id,
            willBeDeleted: WILL_BE_DELETED,
            willBeRetained: WILL_BE_RETAINED,
            notice: this.deletionNotice(),
          };
        }
      }
    }

    // ---------------------------------------------------------------- 前置校验
    const [pendingRefunds, pendingOrders] = await Promise.all([
      // RefundStatus 枚举为 PENDING | SUCCESS | FAILED | CLOSED（无 PROCESSING）
      this.prisma.refund.count({ where: { userId, status: { in: ['PENDING'] } } }),
      this.prisma.order.count({ where: { userId, status: 'PENDING_PAY' } }),
    ]);

    if (pendingRefunds > 0) {
      // 退款在途时注销会导致钱款无处可退
      throw BusinessException.conflict(ErrorCode.ORDER_IN_PROGRESS, '存在处理中的退款，请等待退款完成后再注销');
    }

    if (pendingOrders > 0) {
      // 规则 2：静默关单后继续（不阻断用户）
      const closed = await this.prisma.order.updateMany({
        where: { userId, status: 'PENDING_PAY' },
        data: { status: 'CLOSED', closedAt: new Date(), cancelReason: 'ACCOUNT_DELETION' },
      });
      this.logger.log(`注销前自动关闭未支付订单 userId=${userId} count=${closed.count}`);
    }

    // ------------------------------------------------------------------ 建单
    const now = new Date();
    const scheduledAt = new Date(now.getTime() + this.graceDays * 86_400_000);

    const request = await this.prisma.userDeletionRequest.create({
      data: {
        userId,
        status: 'PENDING',
        // schema 中只有单个 reason 字段（VarChar 512），补充说明以 `CODE|detail` 形式拼接存储
        reason: this.joinReason(dto.reason, dto.reasonDetail),
        requestedAt: now,
        scheduledAt,
        retentionNote: RETAINED_DATA_NOTICE,
        ip: context.ip ?? null,
      },
      select: { id: true, status: true, reason: true, requestedAt: true, scheduledAt: true },
    });

    // 幂等键落 Redis：同一键重复调用时返回首次结果（TTL 覆盖整个冷静期）
    if (idempotencyRedisKey) {
      await this.redis.set(idempotencyRedisKey, request.id, DELETION_IDEMPOTENCY_TTL_SECONDS);
    }

    this.logger.log(`用户提交注销申请 userId=${userId} scheduledAt=${scheduledAt.toISOString()}`);

    const status = await this.getDeletionStatus(userId);

    return {
      ...status,
      requestId: request.id,
      willBeDeleted: WILL_BE_DELETED,
      willBeRetained: WILL_BE_RETAINED,
      notice: this.deletionNotice(),
    };
  }

  /**
   * 撤销注销申请（冷静期内）
   *
   * 契约：无申请时返回错误；已过冷静期（已处理）不可撤销。
   */
  async cancelDeletion(userId: string, dto: CancelDeletionDto): Promise<DeletionStatusView> {
    const request = await this.prisma.userDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
      orderBy: { requestedAt: 'desc' },
      select: { id: true, scheduledAt: true },
    });

    if (!request) {
      // 区分「从未申请」与「已过冷静期」：前者 NOT_REQUESTED，后者 NOT_CANCELLABLE
      const processed = await this.prisma.userDeletionRequest.findFirst({
        where: { userId, status: { in: ['PROCESSING', 'COMPLETED'] } },
        select: { id: true },
      });

      if (processed) {
        throw BusinessException.conflict(ErrorCode.DELETION_NOT_CANCELLABLE);
      }

      throw BusinessException.conflict(ErrorCode.DELETION_NOT_REQUESTED);
    }

    if (request.scheduledAt.getTime() <= Date.now()) {
      throw BusinessException.conflict(ErrorCode.DELETION_NOT_CANCELLABLE);
    }

    await this.prisma.userDeletionRequest.update({
      where: { id: request.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        ...(dto.reason ? { failureReason: dto.reason.slice(0, 512) } : {}),
      },
    });

    this.logger.log(`用户撤销注销申请 userId=${userId} requestId=${request.id}`);

    return this.getDeletionStatus(userId);
  }

  // ==========================================================================
  // 内部：include 块
  // ==========================================================================

  private async loadProfile(userId: string): Promise<ProfileBlock | null> {
    const profile = await this.prisma.personalityProfile.findFirst({
      where: { userId, isCurrent: true, deletedAt: null },
      select: {
        id: true,
        mbtiType: true,
        engineVersion: true,
        version: true,
        mbtiConfidence: true,
        openness: true,
        conscientiousness: true,
        extraversion: true,
        agreeableness: true,
        neuroticism: true,
        attachmentStyle: true,
        loveLanguages: true,
        conflictStyle: true,
        computedAt: true,
      },
    });

    if (!profile) return null;

    return {
      profileId: profile.id,
      mbtiType: profile.mbtiType,
      engineVersion: profile.engineVersion,
      version: profile.version,
      confidence: profile.mbtiConfidence,
      bigFive: {
        openness: profile.openness,
        conscientiousness: profile.conscientiousness,
        extraversion: profile.extraversion,
        agreeableness: profile.agreeableness,
        neuroticism: profile.neuroticism,
      },
      relationshipStyle: {
        attachment: profile.attachmentStyle,
        loveLanguage: profile.loveLanguages,
        conflictStyle: profile.conflictStyle,
      },
      generatedAt: profile.computedAt.toISOString(),
    };
  }

  private async loadMembership(userId: string): Promise<MembershipBlock> {
    const now = new Date();

    const membership = await this.prisma.membership.findFirst({
      where: { userId, status: 'ACTIVE', deletedAt: null },
      orderBy: { expireAt: 'desc' },
      select: {
        startAt: true,
        expireAt: true,
        autoRenew: true,
        plan: { select: { code: true, name: true } },
      },
    });

    if (!membership || membership.expireAt.getTime() <= now.getTime()) {
      return {
        isActive: false,
        planCode: membership?.plan.code ?? null,
        planName: membership?.plan.name ?? null,
        startedAt: membership ? membership.startAt.toISOString() : null,
        expiresAt: membership ? membership.expireAt.toISOString() : null,
        autoRenew: membership?.autoRenew ?? false,
        remainingDays: null,
      };
    }

    return {
      isActive: true,
      planCode: membership.plan.code,
      planName: membership.plan.name,
      startedAt: membership.startAt.toISOString(),
      expiresAt: membership.expireAt.toISOString(),
      autoRenew: membership.autoRenew,
      remainingDays: Math.max(0, Math.ceil((membership.expireAt.getTime() - now.getTime()) / 86_400_000)),
    };
  }

  /**
   * AI 配额摘要
   *
   * 会员：每日配额（`membership.dailyAiUsed` 按自然日重置）
   * 免费用户：总次数配额（`quota.freeAiMessages`，Phase 5 接入使用计数后精确化）
   */
  private async loadAiQuota(userId: string): Promise<AiQuotaBlock> {
    const now = new Date();
    const startOfTomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

    const [membership, credits] = await Promise.all([
      this.prisma.membership.findFirst({
        where: { userId, status: 'ACTIVE', deletedAt: null, expireAt: { gt: now } },
        orderBy: { expireAt: 'desc' },
        select: { dailyAiUsed: true, dailyAiUsedDate: true },
      }),
      this.prisma.entitlement.aggregate({
        where: {
          userId,
          type: 'AI_CREDITS',
          status: 'ACTIVE',
          OR: [{ expireAt: null }, { expireAt: { gt: now } }],
        },
        _sum: { remainingQuota: true },
      }),
    ]);

    const isMember = membership !== null;

    // 仅当计数日期是「今天」时才计入已用，否则视为已重置
    const usedToday = membership && this.isSameUtcDate(membership.dailyAiUsedDate, now) ? membership.dailyAiUsed : 0;

    const dailyLimit = isMember ? this.memberDailyAiMessages : 0;

    return {
      remaining: isMember ? Math.max(0, dailyLimit - usedToday) : this.freeAiMessages,
      dailyLimit,
      usedToday,
      resetAt: startOfTomorrow.toISOString(),
      creditBalance: credits._sum?.remainingQuota ?? 0,
    };
  }

  private async loadStats(userId: string): Promise<StatsBlock> {
    const [testSessionCount, reportCount, relationshipCount, aiMessageCount] = await Promise.all([
      this.prisma.testSession.count({ where: { userId } }),
      this.prisma.aiReport.count({ where: { userId, deletedAt: null } }),
      this.prisma.relationship.count({
        where: { OR: [{ userAId: userId }, { userBId: userId }], status: 'ACTIVE' },
      }),
      // 契约规则 4：累计计数仅用于展示，允许误差
      this.prisma.aiMessage.count({ where: { userId, role: 'USER' } }),
    ]);

    return { testSessionCount, reportCount, relationshipCount, aiMessageCount };
  }

  // ==========================================================================
  // 内部：辅助
  // ==========================================================================

  /** 冷静期内禁止的操作统一入口（契约错误码 30018 语义） */
  private async assertNotInDeletionGrace(userId: string, code: number): Promise<void> {
    const pending = await this.prisma.userDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
      select: { id: true },
    });

    if (pending) {
      throw BusinessException.forbidden(code, undefined);
    }
  }

  /** 解析并校验生日范围（1900-01-01 ~ 今天） */
  private parseBirthday(value: string): Date {
    const birthday = new Date(`${value}T00:00:00.000Z`);

    if (Number.isNaN(birthday.getTime())) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '生日格式不合法');
    }

    const min = new Date('1900-01-01T00:00:00.000Z');
    const today = new Date();
    const max = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

    if (birthday.getTime() < min.getTime() || birthday.getTime() > max.getTime()) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '生日需在 1900-01-01 至今天之间');
    }

    return birthday;
  }

  private emptyDeletionStatus(): DeletionStatusView {
    return {
      hasRequest: false,
      requestId: null,
      status: null,
      reason: null,
      requestedAt: null,
      scheduledAt: null,
      remainingDays: null,
      canCancel: false,
      cancelDeadline: null,
      completedAt: null,
      retainedDataNotice: RETAINED_DATA_NOTICE,
    };
  }

  private deletionNotice(): string {
    return '冷静期内你可以随时撤销注销申请。冷静期结束前 1 天我们会尝试通过订阅消息提醒你。';
  }

  private joinReason(code: string, detail?: string): string {
    const trimmed = detail?.trim();
    return trimmed ? `${code}${REASON_DETAIL_SEPARATOR}${trimmed}`.slice(0, 512) : code;
  }

  private splitReason(stored: string): { code: string; detail: string | null } {
    const index = stored.indexOf(REASON_DETAIL_SEPARATOR);
    if (index === -1) return { code: stored, detail: null };
    return { code: stored.slice(0, index), detail: stored.slice(index + 1) };
  }

  private isSameUtcDate(value: Date | null, reference: Date): boolean {
    if (!value) return false;
    return (
      value.getUTCFullYear() === reference.getUTCFullYear() &&
      value.getUTCMonth() === reference.getUTCMonth() &&
      value.getUTCDate() === reference.getUTCDate()
    );
  }

  /**
   * 构造协议正文地址
   *
   * 未配置 `LEGAL_BASE_URL` 时返回 null —— 宁可让前端隐藏「查看原文」入口，
   * 也不要返回一个猜出来的、可能 404 的链接（合规页面的死链比没有链接更糟）。
   */
  private buildLegalUrl(type: ConsentTypeValue, version: string): string | null {
    if (this.legalBaseUrl === '') return null;
    return `${this.legalBaseUrl}/${type.toLowerCase()}/${version}`;
  }
}
