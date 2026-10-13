/**
 * 关系服务（契约 §3.6；架构 §12.1 邀请与关系建立）
 *
 * 状态机（与 Prisma 枚举一致）：
 *
 * ```
 * 邀请：PENDING ──accept──→ ACCEPTED
 *                  ├─ 过期 ─→ EXPIRED
 *                  └─ 撤销 ─→ REVOKED
 *
 * 关系：PENDING_A_CONFIRM ──A 确认──→ ACTIVE
 *                          ├─ A 拒绝 / B 撤回 ─→ REJECTED
 *                          ├─ 超时 7 天 ──────→ EXPIRED
 *                          └─ 任一方解除 ─────→ REMOVED
 * ```
 *
 * 两个关键机制：
 *   ① `pairKey` 唯一约束（ADR-020）从**数据库层**杜绝重复关系 ——
 *      应用层的「先查再插」在并发下必然漏判，唯一约束才是可靠的那道闸门
 *   ② 邀请码 **DB + Redis 双写**：DB 是事实源（可审计），Redis 承担扫码时的高频查询
 */

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ShareChannel } from '@prisma/client';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { isUniqueConstraintError } from '../../common/utils/prisma-error.util';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { QUEUE_COMPATIBILITY_CALC } from '../../infra/queue/queue.module';
import { RedisService } from '../../infra/redis/redis.service';
import { WechatService } from '../../infra/wechat/wechat.service';
import { StorageService } from '../storage/storage.service';
// 用普通 import 而非 `import type`：Nest 的构造参数注入依赖 `design:paramtypes`
// 元数据里的**运行时类引用**，`import type` 会被编译期擦除，注入会静默失败。
// 依赖方向是单向的（`relationship.service` → `compatibility.service`），无循环。
import { CompatibilityService } from './compatibility.service';
import { buildPairKey, generateInviteCode, parseInviteCode } from './relationship.util';
import { isCompatibilityInProgress, resolveCompatibilityBlocker } from './compatibility.util';
import {
  buildInviteFlow,
  inviteRemainingSeconds,
  resolveInviteAcceptability,
  type InviteBlockedReason,
  type InviteFlowStepView,
} from './invite-view.util';
import {
  buildPermissions,
  buildRelationshipSummary,
  buildTimeline,
  compatibilityScoreLabel,
  compatibilityScoreLevel,
  daysTogether,
  mbtiTypeName,
  relationStatusLabel,
  relationTypeName,
  relationshipExpiresAt,
  type CompatibilityScoreLevel,
  type RelationshipListSummary,
  type RelationshipPermissions,
  type RelationshipTimelineItem,
} from './relationship-view.util';

/** 确认关系时顺带触发的匹配算分结果（契约 §3.6.6 的 `compatibilityTask`） */
export interface CompatibilityTaskView {
  readonly enqueued: boolean;
  readonly reportId: string | null;
  readonly queue: string;
  readonly estimatedSeconds: number;
  /**
   * 未入队的原因
   *
   * 契约要求「队列不可用仍激活关系」（`90005`），所以这里必须是**可选**的：
   * 关系已生效、只是报告没排上，两者是不同的事实，不能因为后者失败就回滚前者。
   */
  readonly skipReason?: string;
}

/** 关系状态视图（确认/解除返回） */
export interface RelationshipStateView {
  readonly relationshipId: string;
  readonly status: string;
  readonly confirmedAt: string | null;
  readonly unboundAt: string | null;
  /** 仅确认接口返回 */
  readonly compatibilityTask?: CompatibilityTaskView;
}

// ============================================================================
// 列表与详情视图（契约 §3.6.4 / §3.6.5）
// ============================================================================

/** 关系里的一个用户（A = 邀请方，B = 接受方，**不按 pairKey 排序**） */
export interface RelationshipSideView {
  readonly userId: string;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
  readonly mbtiType: string | null;
  readonly isMe: boolean;
  readonly role: 'INVITER' | 'INVITEE';
  readonly confirmedAt: string | null;
  readonly hasProfile: boolean;
  readonly profileVersion: number;
}

/** 匹配报告摘要 */
export interface CompatibilitySummaryView {
  readonly hasReport: boolean;
  readonly latestReportId: string | null;
  readonly overallScore: number | null;
  readonly scoreLevel: CompatibilityScoreLevel | null;
  readonly scoreLabel: string | null;
  readonly generatedAt: string | null;
  readonly canGenerate: boolean;
  readonly isGenerating: boolean;
  /**
   * 不能生成时的原因
   *
   * ⚠ **可能为 `null`**，与契约字面不完全一致：契约要求 `canGenerate=false`
   * 时必须给出原因，但 `compatibility.calc` 队列与匹配报告链路尚未实现 ——
   * 此时"用户已满足全部前置条件却仍不能生成"，而契约的枚举里没有对应取值。
   * 与其硬塞一个不真实的原因（如谎称对方没画像），不如留空，让前端按
   * 「暂不可用」展示。链路落地后此字段会稳定填写。
   */
  readonly blockedReason: string | null;
}

/** 列表项 */
export interface RelationshipListItemView {
  readonly relationshipId: string;
  readonly relationType: string;
  readonly relationTypeName: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly myRole: 'INVITER' | 'INVITEE';
  readonly partner: {
    readonly userId: string;
    readonly nickname: string | null;
    readonly avatarUrl: string | null;
    readonly mbtiType: string | null;
    readonly typeName: string | null;
    readonly profileVersion: number | null;
    readonly hasProfile: boolean;
  };
  readonly invitedAt: string | null;
  readonly acceptedAt: string | null;
  readonly activatedAt: string | null;
  readonly expiresAt: string | null;
  readonly daysTogether: number | null;
  readonly compatibility: CompatibilitySummaryView;
  readonly conversationCount: number;
  readonly lastInteractionAt: string;
}

/** 列表响应 */
export interface RelationshipListView {
  readonly items: readonly RelationshipListItemView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly summary: RelationshipListSummary;
}

/** 详情视图 */
export interface RelationshipDetailView {
  readonly relationshipId: string;
  /**
   * ⚠ 契约要求返回，但**刻意不下发**
   *
   * `pairKey` 里含两个用户的 UUID，是服务端内部的防重键；把它交给客户端等于
   * 多暴露一份"谁与谁有关系"的可枚举标识，而客户端没有任何用途（它需要的是
   * `relationshipId`）。契约里列出它多半是照搬数据模型，不是前端需求。
   */
  readonly relationType: string;
  readonly relationTypeName: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly myRole: 'INVITER' | 'INVITEE';
  readonly pendingConfirmationBy: string | null;
  readonly userA: RelationshipSideView;
  readonly userB: RelationshipSideView;
  readonly acceptedAt: string | null;
  readonly activatedAt: string | null;
  readonly daysTogether: number | null;
  readonly compatibility: CompatibilitySummaryView;
  readonly aiConversation: {
    readonly conversationCount: number;
    readonly latestConversationId: string | null;
    readonly lastMessageAt: string | null;
    readonly canStartNew: boolean;
  };
  readonly timeline: readonly RelationshipTimelineItem[];
  readonly permissions: RelationshipPermissions;
  readonly disclaimer: string;
}

/** 列表查询入参 */
export interface ListRelationshipsInput {
  readonly userId: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: readonly string[];
  readonly relationType?: readonly string[];
  readonly sortBy?: 'createdAt' | 'activatedAt';
  readonly order?: 'asc' | 'desc';
}

/**
 * 默认状态筛选（契约 §3.6.4）
 *
 * 不传 `status` 时只返回 `ACTIVE` + `PENDING_A_CONFIRM` —— 用户看「我的关系」时
 * 不该被一堆已解除的历史记录淹没。注意这**不同于**"不筛选"：若返回全部状态，
 * 列表首屏会被历史数据占满。
 */
const DEFAULT_STATUS_FILTER = ['ACTIVE', 'PENDING_A_CONFIRM'];

/** 免责声明兜底文案（`system_config` 未配置时使用） */
const RELATIONSHIP_DISCLAIMER = '匹配结果基于 MBTI 与大五人格的理论框架计算，仅供参考，不构成对关系的判断或建议。';

/** 邀请有效期（天）—— 契约 §3.6.1：7 天 */
const INVITE_TTL_DAYS = 7;

/**
 * 小程序码要打开的目标页（含**分包前缀**）
 *
 * 必须与 `frontend/miniapp/src/pages.json` 里的一致：该页在 `pkgMatch` 分包下，
 * 路径写成 `pages/invite` 会被微信侧判为页面不存在。改前端路由时这里要同步改。
 */
const INVITE_PAGE_PATH = 'pkgMatch/pages/invite';

/** 邀请码 Redis 缓存前缀 */
const INVITE_CODE_CACHE_PREFIX = 'invite:code';

/** 同一用户同时可持有的未使用邀请数上限 */
const MAX_PENDING_INVITES = 5;

/** 邀请码生成的最大重试次数（碰撞时重试） */
const CODE_GENERATION_ATTEMPTS = 5;

/** 创建邀请入参 */
export interface CreateInviteInput {
  readonly userId: string;
  readonly relationType: 'COUPLE' | 'FRIEND' | 'FAMILY';
  readonly message?: string;
  /**
   * 分享渠道（用于裂变归因）
   *
   * 类型取 Prisma 生成的 `ShareChannel` 枚举，而不是 `string`。此前是 `string`
   * 并在写入时用 `channel as never` 绕过检查 —— 于是任意字符串都能通过编译，
   * 却在 PG 枚举列上抛错变成 **500**。用真实枚举类型后，非法值在编译期就暴露，
   * HTTP 边界上再由 DTO 的 `@IsIn(SHARE_CHANNELS)` 拦一层。
   */
  readonly channel?: ShareChannel;
}

/** 邀请视图 */
export interface InviteView {
  readonly inviteId: string;
  readonly code: string;
  readonly relationType: string;
  readonly status: string;
  readonly expiresAt: string;
  /** 小程序码地址（生成失败时为 null，前端可降级为展示短码） */
  readonly qrCodeUrl: string | null;
}

/** 接受邀请结果 */
export interface AcceptedRelationshipView {
  readonly relationshipId: string;
  readonly status: string;
  readonly relationType: string;
  readonly peerUserId: string;
  /** 待另一方确认时为 true（前端据此展示"等待对方确认"） */
  readonly awaitingPeerConfirm: boolean;
}

// ============================================================================
// 邀请详情（契约 §3.6.2）
// ============================================================================

/**
 * 邀请人的**公开资料子集**
 *
 * 只包含昵称、头像与 MBTI 类型 —— 契约规则 1 明确要求「不返回手机号、openid、
 * 画像详情、Big Five 分数」。这里的字段列表就是全部可下发内容：
 * `phoneEnc` / `wechatAccounts.openid` / 大五分数**根本没有被查出来**，
 * 而不是查出来再删 —— 后者迟早会有人往 select 里加一个字段就漏出去。
 */
export interface InviteInviterView {
  readonly userId: string;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
  readonly mbtiType: string | null;
  readonly typeName: string | null;
  readonly profileVersion: number | null;
}

/** 我的现状（契约 §3.6.2 的 `myStatus`），用于前端个性化引导 */
export interface InviteMyStatusView {
  readonly hasProfile: boolean;
  readonly mbtiType: string | null;
  readonly profileVersion: number | null;
  readonly isInviter: boolean;
  readonly existingRelationshipId: string | null;
  readonly existingRelationshipStatus: string | null;
}

/** 邀请详情视图（契约 §3.6.2） */
export interface InviteDetailView {
  readonly inviteId: string;
  readonly inviteCode: string;
  readonly relationType: string;
  readonly relationTypeName: string;
  readonly status: string;
  readonly canAccept: boolean;
  readonly blockedReason: InviteBlockedReason | null;
  /** `blockedReason` 的中文说明；可接受时为 `null` */
  readonly blockedReasonLabel: string | null;
  readonly inviter: InviteInviterView;
  /**
   * ⚠ 契约要求返回「被邀请人的称呼」，但**数据模型无法承载**
   *
   * `relationship_invites` 没有任何列能存它（与 `POST /relationships/invites` 的
   * `inviteeName` 是同一个缺口，见 `relationship.controller.ts` 文件头）。
   * 因此恒为 `null`，而不是编一个「对方」之类的占位文案 —— 占位会被当成真实数据
   * 展示给用户，而用户会以为对方真的这么称呼自己。
   */
  readonly inviteeName: string | null;
  readonly message: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly remainingSeconds: number;
  /** 建议先完成的测评编码（库里查得到才返回，查不到为 `null`） */
  readonly suggestedTestCode: string | null;
  readonly myStatus: InviteMyStatusView;
  readonly flow: { readonly steps: readonly InviteFlowStepView[] };
  readonly disclaimer: string;
  /**
   * 已经是**我**接受过的邀请时返回既有关系 ID（契约规则 5）
   *
   * 此时接口仍返回 200 而不是 409：用户扫到自己已接受过的码，直接带去关系详情
   * 才是他想要的；报「邀请已被使用」会让他以为出了错。
   */
  readonly acceptedRelationshipId?: string | null;
}

/**
 * 建议的测评编码（契约 §3.6.2 的 `suggestedTestCode`）
 *
 * 邀请流程建议先完成**精简版**测评（几分钟即可），因此用种子数据里的
 * `MBTI_LITE`。这里仍会去库里确认它存在且启用 —— 硬编码一个编码在种子改名后
 * 会变成前端跳转到 404 页面。
 */
const SUGGESTED_TEST_CODE = 'MBTI_LITE';

@Injectable()
export class RelationshipService {
  private readonly logger = new Logger(RelationshipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly compatibility: CompatibilityService,
    private readonly wechat: WechatService,
    private readonly storage: StorageService,
  ) {}

  /**
   * 生成邀请的小程序码并落库（**失败不影响邀请**）
   *
   * ## 为什么需要它
   *
   * `relationship_invites.qrCodeUrl` 这一列此前**只有读、没有写** ——
   * 接口始终返回 `null`，而契约 §3.6.1 把它列为邀请响应的一部分（"扫码即可加入"）。
   * 也就是说「扫码邀请」这条路一直是断的，只能靠分享文案/链接。
   *
   * ## 为什么"生成了就存、存不了就算了"
   *
   * 邀请本身靠 `code` 就能完成（对方输入邀请码或点链接）。二维码是**体验增强**，
   * 微信侧抖动、OSS 未配置、页面尚未发布（`check_path`）都不该让邀请失败 ——
   * 那会把可选能力变成整条链路的单点。失败时返回 `null`，前端不渲染二维码位。
   *
   * 返回值为最终写入库里的 URL（失败即 `null`），调用方直接用它构响应，
   * 避免"先写库再读回来"这种多一次查询的写法。
   */
  private async attachInviteQrCode(inviteId: string, code: string): Promise<string | null> {
    try {
      const image = await this.wechat.getMiniAppCode({
        scene: code,
        // 分包页路径必须带分包前缀（`pkgMatch`），否则微信侧校验不通过
        page: INVITE_PAGE_PATH,
        width: 430,
      });

      if (image === null) return null;

      const objectKey = `invite/qr/${code}.png`;
      await this.storage.uploadServerObject({ objectKey, body: image, contentType: 'image/png' });

      const url = this.storage.publicUrlOf(objectKey);
      await this.prisma.relationshipInvite.update({ where: { id: inviteId }, data: { qrCodeUrl: url } });

      return url;
    } catch (error) {
      this.logger.warn(
        `邀请二维码生成失败（邀请本身不受影响）code=${code}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  /**
   * 隐藏某段关系的全部历史匹配报告（软删除）
   *
   * 用软删除（写 `deletedAt`）而不是物理删除：所有匹配报告的查询都带
   * `deletedAt: null`（见 `compatibility.service.ts`、本文件的列表查询），
   * 因此软删除即可满足契约「对双方隐藏」的效果，同时保留审计与误操作恢复的余地 ——
   * 「用户要求删除」与「数据必须可追溯」在这类合规场景里通常需要同时成立。
   *
   * `updateMany` 天然幂等（条件里带 `deletedAt: null`），重复调用只会影响剩余未隐藏的行。
   */
  private async hideCompatibilityReports(relationshipId: string): Promise<number> {
    const result = await this.prisma.compatibilityReport.updateMany({
      where: { relationshipId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return result.count;
  }

  /**
   * 创建邀请（契约 §3.6.1）
   *
   * 邀请码碰撞的处理：`code` 有唯一约束，生成时可能撞上已存在的码。
   * 这里**重试生成**而不是把它当异常抛出 —— 32^8 ≈ 1.1×10¹² 的空间里碰撞是
   * 正常概率事件，重试几次必然成功；抛错会让用户看到"生成失败请重试"，
   * 而实际上系统完全有能力自己解决。
   */
  async createInvite(input: CreateInviteInput): Promise<InviteView> {
    // 限制未使用邀请的数量：防止刷码占用码空间，也避免用户自己都记不清哪个是哪个
    const pendingCount = await this.prisma.relationshipInvite.count({
      where: { inviterId: input.userId, status: 'PENDING', deletedAt: null },
    });

    if (pendingCount >= MAX_PENDING_INVITES) {
      throw BusinessException.tooManyRequests(
        ErrorCode.RELATIONSHIP_INVITE_LIMIT,
        `同时最多保留 ${MAX_PENDING_INVITES} 个未使用的邀请，请先撤销部分邀请`,
      );
    }

    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    for (let attempt = 1; attempt <= CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const code = generateInviteCode();

      try {
        const invite = await this.prisma.relationshipInvite.create({
          data: {
            code,
            inviterId: input.userId,
            relationType: input.relationType,
            status: 'PENDING',
            expiresAt,
            maxUses: 1,
            ...(input.message !== undefined ? { message: input.message.slice(0, 256) } : {}),
            ...(input.channel !== undefined ? { channel: input.channel } : {}),
          },
          select: { id: true, code: true, relationType: true, status: true, expiresAt: true, qrCodeUrl: true },
        });

        // DB 写成功后再写 Redis：Redis 只是查询加速层，即使写失败也不影响正确性
        // （扫码时会回落到 DB 查询），因此不因缓存失败而回滚业务
        await this.redis
          .set(this.redis.key(INVITE_CODE_CACHE_PREFIX, code), invite.id, INVITE_TTL_DAYS * 24 * 60 * 60)
          .catch((error: Error) => {
            this.logger.warn(`邀请码写入 Redis 失败（不影响正确性）code=${code}: ${error.message}`);
          });

        this.logger.log(`邀请已创建 inviteId=${invite.id} inviter=${input.userId} type=${input.relationType}`);

        // 小程序码是**增强能力**：生成失败不影响邀请（邀请码与分享文案已经可用）
        const qrCodeUrl = await this.attachInviteQrCode(invite.id, invite.code);

        return {
          inviteId: invite.id,
          code: invite.code,
          relationType: invite.relationType,
          status: invite.status,
          expiresAt: invite.expiresAt.toISOString(),
          qrCodeUrl,
        };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          this.logger.warn(`邀请码碰撞，重试生成 attempt=${attempt}`);
          continue;
        }
        throw error;
      }
    }

    // 连续碰撞说明码空间异常（或随机源有问题），必须暴露而不是静默失败
    this.logger.error(`邀请码生成连续碰撞 ${CODE_GENERATION_ATTEMPTS} 次，码空间可能异常`);
    throw new BusinessException(ErrorCode.INTERNAL_ERROR, '邀请码生成失败，请稍后重试');
  }

  /**
   * 接受邀请（契约 §3.6.2）
   *
   * 校验顺序：码格式 → 邀请存在 → 不能自邀 → 未过期/未撤销 → 邀请人已有画像 → 建关系。
   * 「不能自邀」放在最前是因为它是**用户输入错误**，其余是状态问题，
   * 错误提示应当精确区分（前者提示"不能邀请自己"，后者提示"邀请已失效"）。
   */
  async acceptInvite(userId: string, rawCode: string): Promise<AcceptedRelationshipView> {
    const code = parseInviteCode(rawCode);

    const invite = await this.prisma.relationshipInvite.findFirst({
      where: { code, deletedAt: null },
      select: {
        id: true,
        inviterId: true,
        inviteeId: true,
        relationType: true,
        status: true,
        expiresAt: true,
        relationshipId: true,
      },
    });

    if (invite === null) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_INVITE_NOT_FOUND);
    }

    if (invite.inviterId === userId) {
      // 自邀是常见误操作（用户自己点开了自己的分享链接），需给出准确提示
      throw BusinessException.badRequest(ErrorCode.RELATIONSHIP_INVITE_SELF, '不能接受自己发起的邀请');
    }

    if (invite.status === 'REVOKED') {
      throw BusinessException.conflict(ErrorCode.RELATIONSHIP_INVITE_EXPIRED, '邀请已被撤销');
    }

    if (invite.status === 'ACCEPTED') {
      // 幂等：同一邀请被重复接受时，返回既有关系而不是报错
      if (invite.relationshipId !== null) {
        const existing = await this.prisma.relationship.findUnique({
          where: { id: invite.relationshipId },
          select: { id: true, status: true, type: true, userAId: true, userBId: true },
        });

        if (existing !== null) {
          return {
            relationshipId: existing.id,
            status: existing.status,
            relationType: existing.type,
            peerUserId: existing.userAId === userId ? existing.userBId : existing.userAId,
            awaitingPeerConfirm: existing.status === 'PENDING_A_CONFIRM',
          };
        }
      }

      throw BusinessException.conflict(ErrorCode.RELATIONSHIP_INVITE_USED);
    }

    if (invite.expiresAt.getTime() <= Date.now()) {
      throw BusinessException.conflict(ErrorCode.RELATIONSHIP_INVITE_EXPIRED);
    }

    // 双方都必须有画像：没有画像就无法算分，匹配报告无从生成
    const peerProfile = await this.prisma.personalityProfile.findFirst({
      where: { userId: invite.inviterId, deletedAt: null },
      select: { id: true },
    });
    if (peerProfile === null) {
      throw new BusinessException(ErrorCode.COMPATIBILITY_PEER_NOT_READY, '对方尚未完成人格测评，暂时无法建立匹配关系');
    }

    const pairKey = buildPairKey(userId, invite.inviterId);
    const [userAId, userBId] = [userId, invite.inviterId].sort();

    try {
      const relationship = await this.prisma.$transaction(async (tx) => {
        const created = await tx.relationship.create({
          data: {
            pairKey,
            userAId,
            userBId,
            type: invite.relationType,
            // 由 A（发起方）最终确认，符合架构 §12.1 的状态机
            status: 'PENDING_A_CONFIRM',
          },
          select: { id: true, status: true, type: true },
        });

        await tx.relationshipInvite.update({
          where: { id: invite.id },
          data: {
            status: 'ACCEPTED',
            inviteeId: userId,
            acceptedAt: new Date(),
            usedCount: { increment: 1 },
            relationshipId: created.id,
          },
        });

        return created;
      });

      this.logger.log(`邀请已接受 inviteId=${invite.id} relationshipId=${relationship.id} pairKey=${pairKey}`);

      return {
        relationshipId: relationship.id,
        status: relationship.status,
        relationType: relationship.type,
        peerUserId: invite.inviterId,
        awaitingPeerConfirm: true,
      };
    } catch (error) {
      // 并发接受同一邀请、或两人互相邀请时，pairKey 唯一约束会拦住重复关系。
      // 这是**正确的拒绝**，应转成明确的业务码而不是 500。
      if (isUniqueConstraintError(error)) {
        throw BusinessException.conflict(
          ErrorCode.RELATIONSHIP_ALREADY_EXISTS,
          '你们之间已经存在一条关系，无需重复建立',
        );
      }
      throw error;
    }
  }

  // ==========================================================================
  // 邀请详情（契约 §3.6.2）
  // ==========================================================================

  /**
   * 邀请详情（扫码/点链接进入后展示）
   *
   * 契约 §3.6.2 标 🔑 **需登录**：不是为了拦住游客看内容，而是**避免游客用这个
   * 接口探测邀请码**。登录只静默进行，不强制点头像昵称。
   *
   * 三种「异常」其实都是正常可预期的状态，按契约分别处理：
   *   · 已过期 / 已撤销 → `410`（`60004`）
   *   · 已被**他人**接受 → `409`（`60005`）
   *   · 已被**我**接受 → **200** 并附 `acceptedRelationshipId`（契约规则 5）
   *
   * 自邀（`blockedReason = SELF_INVITE`）同样返回 **200**，只在 `canAccept` 上体现
   * （契约错误码表明确写「本接口仍返回 200，只在接受时拒绝」）。
   */
  async getInviteDetail(userId: string, rawCode: string): Promise<InviteDetailView> {
    const code = parseInviteCode(rawCode);

    const invite = await this.prisma.relationshipInvite.findFirst({
      where: { code, deletedAt: null },
      select: {
        id: true,
        code: true,
        inviterId: true,
        inviteeId: true,
        relationType: true,
        status: true,
        message: true,
        expiresAt: true,
        relationshipId: true,
        createdAt: true,
      },
    });

    if (invite === null) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_INVITE_NOT_FOUND);
    }

    if (invite.status === 'REVOKED') {
      throw new BusinessException(ErrorCode.RELATIONSHIP_INVITE_EXPIRED, '邀请已被撤销', {
        httpStatus: HttpStatus.GONE,
      });
    }

    if (invite.status === 'ACCEPTED') {
      return this.buildAcceptedInviteDetail(userId, invite);
    }

    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new BusinessException(ErrorCode.RELATIONSHIP_INVITE_EXPIRED, '邀请已过期', {
        httpStatus: HttpStatus.GONE,
      });
    }

    const [inviter, inviterProfile, myProfile, existing, sameTypeCount, activeCount, liteTest] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: invite.inviterId },
        // 只取公开字段：手机号密文、openid 等**不进入查询**，从源头杜绝泄露
        select: { id: true, nickname: true, avatarUrl: true },
      }),
      this.prisma.personalityProfile.findFirst({
        where: { userId: invite.inviterId, isCurrent: true },
        select: { mbtiType: true, version: true },
      }),
      this.prisma.personalityProfile.findFirst({
        where: { userId, isCurrent: true },
        select: { mbtiType: true, version: true },
      }),
      this.prisma.relationship.findFirst({
        where: {
          deletedAt: null,
          status: { in: ['PENDING_A_CONFIRM', 'ACTIVE'] },
          OR: [
            { userAId: userId, userBId: invite.inviterId },
            { userAId: invite.inviterId, userBId: userId },
          ],
        },
        select: { id: true, status: true },
      }),
      // 同类型关系数（契约的 TYPE_MISMATCH：如我已有 COUPLE）
      this.prisma.relationship.count({
        where: {
          deletedAt: null,
          status: { in: ['PENDING_A_CONFIRM', 'ACTIVE'] },
          type: invite.relationType,
          OR: [{ userAId: userId }, { userBId: userId }],
        },
      }),
      this.prisma.relationship.count({
        where: { deletedAt: null, status: 'ACTIVE', OR: [{ userAId: userId }, { userBId: userId }] },
      }),
      // `suggestedTestCode` 去库里确认：种子改名后硬编码会指向前端 404 页
      this.prisma.testDefinition.findFirst({
        where: { code: SUGGESTED_TEST_CODE, isActive: true, deletedAt: null },
        select: { code: true },
      }),
    ]);

    const isInviter = invite.inviterId === userId;
    const hasExistingRelationship = existing !== null;

    const acceptability = resolveInviteAcceptability({
      isInviter,
      iHaveProfile: myProfile !== null,
      hasExistingRelationship,
      // 与邀请人的那条已由 `hasExistingRelationship` 覆盖，这里只数**其他人**的
      sameTypeRelationshipCount: hasExistingRelationship ? Math.max(0, sameTypeCount - 1) : sameTypeCount,
      relationType: invite.relationType,
      activeRelationshipCount: activeCount,
    });

    this.logger.log(
      `邀请详情已读取 inviteId=${invite.id} viewer=${userId} canAccept=${acceptability.canAccept} reason=${acceptability.blockedReason ?? '无'}`,
    );

    return {
      inviteId: invite.id,
      inviteCode: invite.code,
      relationType: invite.relationType,
      relationTypeName: relationTypeName(invite.relationType),
      status: invite.status,
      canAccept: acceptability.canAccept,
      blockedReason: acceptability.blockedReason,
      blockedReasonLabel: acceptability.blockedReasonLabel,
      inviter: {
        userId: invite.inviterId,
        nickname: inviter?.nickname ?? null,
        avatarUrl: inviter?.avatarUrl ?? null,
        mbtiType: inviterProfile?.mbtiType ?? null,
        typeName: mbtiTypeName(inviterProfile?.mbtiType ?? null),
        profileVersion: inviterProfile?.version ?? null,
      },
      inviteeName: null,
      message: invite.message,
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(),
      remainingSeconds: inviteRemainingSeconds(invite.expiresAt, new Date()),
      suggestedTestCode: liteTest?.code ?? null,
      myStatus: {
        hasProfile: myProfile !== null,
        mbtiType: myProfile?.mbtiType ?? null,
        profileVersion: myProfile?.version ?? null,
        isInviter,
        existingRelationshipId: existing?.id ?? null,
        existingRelationshipStatus: existing?.status ?? null,
      },
      flow: {
        steps: buildInviteFlow({
          hasProfile: myProfile !== null,
          canAccept: acceptability.canAccept,
          isAccepted: false,
          isActive: false,
        }),
      },
      disclaimer: RELATIONSHIP_DISCLAIMER,
    };
  }

  /**
   * 已接受邀请的详情分支（契约规则 5）
   *
   * 只看**一条**事实：接受者是不是当前用户。是则带回既有关系（200，体验优先）；
   * 否则一律 `409`「邀请已被使用」——
   * 不能给出任何关于"谁接受了它"的信息，否则这个接口就成了「凭邀请码查他人关系」
   * 的入口。
   */
  private async buildAcceptedInviteDetail(
    userId: string,
    invite: {
      readonly id: string;
      readonly code: string;
      readonly inviterId: string;
      readonly inviteeId: string | null;
      readonly relationType: string;
      readonly status: string;
      readonly message: string | null;
      readonly expiresAt: Date;
      readonly relationshipId: string | null;
      readonly createdAt: Date;
    },
  ): Promise<InviteDetailView> {
    if (invite.inviteeId !== userId || invite.relationshipId === null) {
      throw BusinessException.conflict(ErrorCode.RELATIONSHIP_INVITE_USED);
    }

    const [relationship, inviter, inviterProfile, myProfile] = await Promise.all([
      this.prisma.relationship.findUnique({
        where: { id: invite.relationshipId },
        select: { id: true, status: true },
      }),
      this.prisma.user.findUnique({
        where: { id: invite.inviterId },
        select: { id: true, nickname: true, avatarUrl: true },
      }),
      this.prisma.personalityProfile.findFirst({
        where: { userId: invite.inviterId, isCurrent: true },
        select: { mbtiType: true, version: true },
      }),
      this.prisma.personalityProfile.findFirst({
        where: { userId, isCurrent: true },
        select: { mbtiType: true, version: true },
      }),
    ]);

    if (relationship === null) {
      // 关系已不存在（软删/硬删）时不能假装成功：附一个空的 relationshipId
      // 会让前端跳到不存在的页面
      throw BusinessException.conflict(ErrorCode.RELATIONSHIP_INVITE_USED);
    }

    const isActive = relationship.status === 'ACTIVE';

    return {
      inviteId: invite.id,
      inviteCode: invite.code,
      relationType: invite.relationType,
      relationTypeName: relationTypeName(invite.relationType),
      status: invite.status,
      // 已接受：无需再"接受"，前端应直接跳关系详情（契约规则 5）
      canAccept: false,
      blockedReason: null,
      blockedReasonLabel: null,
      inviter: {
        userId: invite.inviterId,
        nickname: inviter?.nickname ?? null,
        avatarUrl: inviter?.avatarUrl ?? null,
        mbtiType: inviterProfile?.mbtiType ?? null,
        typeName: mbtiTypeName(inviterProfile?.mbtiType ?? null),
        profileVersion: inviterProfile?.version ?? null,
      },
      inviteeName: null,
      message: invite.message,
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(),
      remainingSeconds: inviteRemainingSeconds(invite.expiresAt, new Date()),
      suggestedTestCode: null,
      myStatus: {
        hasProfile: myProfile !== null,
        mbtiType: myProfile?.mbtiType ?? null,
        profileVersion: myProfile?.version ?? null,
        // 接受者不是我发起的，因此这里恒为 false；但仍如实回读我的现有关系
        isInviter: false,
        existingRelationshipId: relationship.id,
        existingRelationshipStatus: relationship.status,
      },
      flow: {
        steps: buildInviteFlow({
          hasProfile: myProfile !== null,
          canAccept: false,
          isAccepted: true,
          isActive,
        }),
      },
      disclaimer: RELATIONSHIP_DISCLAIMER,
      acceptedRelationshipId: relationship.id,
    };
  }

  /**
   * 确认关系（契约 §3.6.4：`PENDING_A_CONFIRM → ACTIVE`）
   *
   * **只有邀请发起方可以确认**（架构 §12.1 状态机的「待 A 确认」，A = 发起方）。
   * 发起方从**已接受的邀请**反查（`relationshipId` 是邀请上的唯一外键），
   * 因为 `Relationship` 表本身不记录谁发起了邀请 —— 用既有数据推导，
   * 而不是新增一个可能与之不一致的冗余字段。
   */
  async confirmRelationship(
    userId: string,
    relationshipId: string,
    autoGenerateReport = true,
  ): Promise<RelationshipStateView> {
    const relationship = await this.prisma.relationship.findFirst({
      where: { id: relationshipId, deletedAt: null },
      select: { id: true, status: true, userAId: true, userBId: true },
    });

    if (relationship === null) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }

    // 归属校验：非关系双方一律按「不存在」处理（不确认 id 是否存在）
    if (relationship.userAId !== userId && relationship.userBId !== userId) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }

    const invite = await this.prisma.relationshipInvite.findFirst({
      where: { relationshipId, deletedAt: null },
      select: { inviterId: true },
    });

    if (invite !== null && invite.inviterId !== userId) {
      throw BusinessException.forbidden(ErrorCode.RELATIONSHIP_STATUS_INVALID, '需要由邀请发起方确认这段关系');
    }

    if (relationship.status === 'ACTIVE') {
      // 幂等：重复确认返回当前状态
      return {
        relationshipId: relationship.id,
        status: 'ACTIVE',
        confirmedAt: null,
        unboundAt: null,
      };
    }

    if (relationship.status !== 'PENDING_A_CONFIRM') {
      throw BusinessException.conflict(ErrorCode.RELATIONSHIP_STATUS_INVALID, '当前关系状态不支持确认');
    }

    const confirmedAt = new Date();

    await this.prisma.relationship.update({
      where: { id: relationship.id },
      data: { status: 'ACTIVE', confirmedAt, confirmedByUserId: userId },
    });

    this.logger.log(`关系已确认 relationshipId=${relationship.id} by=${userId}`);

    return {
      relationshipId: relationship.id,
      status: 'ACTIVE',
      confirmedAt: confirmedAt.toISOString(),
      unboundAt: null,
      compatibilityTask: await this.triggerCompatibility(userId, relationship.id, autoGenerateReport),
    };
  }

  /**
   * 确认后自动触发匹配算分（契约 §3.6.6）
   *
   * **失败绝不影响激活**：关系已经生效是既成事实，把它回滚掉会让用户"确认了却没确认上"，
   * 而正确的补救是稍后手动重试算分。因此这里吞掉异常并如实返回 `enqueued: false`。
   */
  private async triggerCompatibility(
    userId: string,
    relationshipId: string,
    autoGenerateReport: boolean,
  ): Promise<CompatibilityTaskView> {
    const skipped = (skipReason: string): CompatibilityTaskView => ({
      enqueued: false,
      reportId: null,
      queue: QUEUE_COMPATIBILITY_CALC,
      estimatedSeconds: 0,
      skipReason,
    });

    if (!autoGenerateReport) return skipped('用户未要求自动生成');

    try {
      const result = await this.compatibility.requestCompatibility(userId, relationshipId);

      return {
        enqueued: true,
        reportId: result.reportId,
        queue: result.queue,
        estimatedSeconds: result.estimatedSeconds,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`匹配算分入队失败（关系已激活，可稍后手动重试）relationshipId=${relationshipId}: ${message}`);

      return skipped(message.slice(0, 200));
    }
  }

  /**
   * 解除关系（契约 §3.6.7：`ACTIVE → REMOVED`；待确认阶段被拒则 `REJECTED`）
   *
   * 双方任一方均可解除（不需要对方同意）—— 强制要求双方同意会让人无法离开
   * 一段已结束的关系，这在情感产品里是不可接受的。
   *
   * **关键**：本方法**不改写 `pairKey`**（ADR-030）。契约要求保留原值作审计，
   * 而「解除后同一对用户可重新建立关系」由数据库层的部分唯一索引
   * `WHERE status IN ('PENDING_A_CONFIRM','ACTIVE')` 保证 —— 本行进入终态后
   * 不再占用唯一键。此前的墓碑方案与契约冲突且有两个已证实的缺陷。
   */
  async unbindRelationship(
    userId: string,
    relationshipId: string,
    options: { reason?: string; keepHistory?: boolean } = {},
  ): Promise<RelationshipStateView> {
    const { reason, keepHistory } = options;

    const relationship = await this.prisma.relationship.findFirst({
      where: { id: relationshipId, deletedAt: null },
      select: { id: true, status: true, userAId: true, userBId: true, unboundAt: true },
    });

    if (relationship === null) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }

    if (relationship.userAId !== userId && relationship.userBId !== userId) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }

    /**
     * `keepHistory === false`：把这段关系的历史匹配报告**一并隐藏**（契约 §3.6.7）
     *
     * 这是**隐私相关**能力。此前的实现收下这个参数然后完全忽略 —— 用户明确要求
     * "不保留历史"，而解除后双方仍能读到全部匹配报告。**收下却做不到，比不声明更糟**：
     * 用户以为记录已经消失。
     *
     * 刻意放在**状态变更之前**、且**不受下面幂等早返回影响**：
     *   · 放在前面 → 若隐藏失败会抛错，此时关系状态还没动，用户可以重试；
     *     反过来（先改状态再隐藏）一旦隐藏失败，就变成"关系已解除、报告却还在"，
     *     而重试会命中幂等早返回、永远不会再补做；
     *   · 不受早返回影响 → 已处于 `REMOVED` 的关系再传 `keepHistory=false` 也能补做隐藏。
     */
    if (keepHistory === false) {
      const hidden = await this.hideCompatibilityReports(relationship.id);

      this.logger.log(`已按用户要求隐藏关系历史报告 relationshipId=${relationship.id} 隐藏 ${hidden} 份`);
    }

    // 幂等：已进入任一终态则直接返回现状，不覆盖首次的原因与时间。
    // 必须回读**首次**时间 —— 返回 null 会让客户端以为"从未解除过"，
    // 从而把已结束的关系显示为仍然有效。
    if (relationship.status === 'REMOVED') {
      return {
        relationshipId: relationship.id,
        status: 'REMOVED',
        confirmedAt: null,
        unboundAt: relationship.unboundAt?.toISOString() ?? null,
      };
    }

    const unboundAt = new Date();

    await this.prisma.relationship.update({
      where: { id: relationship.id },
      data: {
        status: 'REMOVED',
        unboundAt,
        unboundByUserId: userId,
        ...(reason !== undefined ? { unboundReason: reason.slice(0, 256) } : {}),
        // ⚠ 刻意**不**改写 pairKey（ADR-030）：契约 §3.6.7 要求保留原值作审计，
        // 而重复关系由部分唯一索引 `WHERE status IN ('PENDING_A_CONFIRM','ACTIVE')`
        // 在数据库层阻止 —— 本行已进入 REMOVED 终态，不再占用唯一键，
        // 同一对用户因此可以重新建立关系。
      },
    });

    this.logger.log(`关系已解除 relationshipId=${relationship.id} by=${userId}`);

    return {
      relationshipId: relationship.id,
      status: 'REMOVED',
      confirmedAt: null,
      unboundAt: unboundAt.toISOString(),
    };
  }

  /**
   * 关系列表（契约 §3.6.4）
   *
   * 三处需要留意的口径：
   *
   * ① **不传 `status` 时只返回 `ACTIVE` + `PENDING_A_CONFIRM`**（契约规则）。
   *    这不是"不筛选"：用户看「我的关系」时不该被历史记录淹没。
   *
   * ② **摘要统计覆盖全部关系，不受筛选与分页影响**。数当前页会让用户翻到第 2 页时
   *    看到"共 1 段关系"，以为数据丢了。
   *
   * ③ **伙伴信息只查一次**。列表最多 100 条，逐条查用户与画像就是 200 次往返；
   *    这里先取回本页的关系，再用两次 `in` 查询批量补齐。
   */
  async listRelationships(input: ListRelationshipsInput): Promise<RelationshipListView> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;

    const statuses = input.status !== undefined && input.status.length > 0 ? input.status : DEFAULT_STATUS_FILTER;

    const where = {
      deletedAt: null,
      OR: [{ userAId: input.userId }, { userBId: input.userId }],
      status: { in: [...statuses] as never },
      ...(input.relationType !== undefined && input.relationType.length > 0
        ? { type: { in: [...input.relationType] as never } }
        : {}),
    };

    const sortField = input.sortBy ?? 'createdAt';

    const [rows, total, summaryRows, conversationCounts] = await Promise.all([
      this.prisma.relationship.findMany({
        where,
        // `activatedAt` 在 schema 里是 `confirmedAt`
        orderBy: { [sortField === 'activatedAt' ? 'confirmedAt' : 'createdAt']: input.order ?? 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          userAId: true,
          userBId: true,
          confirmedAt: true,
          createdAt: true,
          lastReportAt: true,
          updatedAt: true,
          invites: { select: { createdAt: true, expiresAt: true }, orderBy: { createdAt: 'asc' }, take: 1 },
        },
      }),
      this.prisma.relationship.count({ where }),
      this.prisma.relationship.groupBy({
        by: ['status', 'type'],
        where: { deletedAt: null, OR: [{ userAId: input.userId }, { userBId: input.userId }] },
        _count: { _all: true },
      }),
      this.prisma.aiConversation.groupBy({
        by: ['relationshipId'],
        where: {
          userId: input.userId,
          relationshipId: { not: null },
          deletedAt: null,
        },
        _count: { _all: true },
      }),
    ]);

    const now = new Date();
    const partnerIds = rows.map((row) => (row.userAId === input.userId ? row.userBId : row.userAId));
    const [users, profiles, myProfile, latestReports] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: partnerIds } },
        select: { id: true, nickname: true, avatarUrl: true },
      }),
      this.prisma.personalityProfile.findMany({
        where: { userId: { in: partnerIds }, isCurrent: true },
        select: { userId: true, mbtiType: true, version: true },
      }),
      // 我自己的画像：`canGenerate` 需要知道"我测过没有"，否则无法区分
      // "我没测" 与 "对方没测" 这两种需要不同引导的情况
      this.prisma.personalityProfile.findFirst({
        where: { userId: input.userId, isCurrent: true },
        select: { id: true },
      }),
      // 一次取回本页所有关系的最新匹配报告，避免逐条查询（N+1）
      this.prisma.compatibilityReport.findMany({
        where: { relationshipId: { in: rows.map((row) => row.id) }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, relationshipId: true, status: true, totalScore: true, generatedAt: true },
      }),
    ]);

    const userById = new Map(users.map((user) => [user.id, user]));
    const profileByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));
    const conversationByRelationshipId = new Map(
      conversationCounts.map((row) => [row.relationshipId as string, row._count._all]),
    );
    // `orderBy` 为 createdAt 倒序，因此每个关系第一次出现的就是最新一份
    const latestReportByRelationshipId = new Map<string, (typeof latestReports)[number]>();
    for (const report of latestReports) {
      if (!latestReportByRelationshipId.has(report.relationshipId)) {
        latestReportByRelationshipId.set(report.relationshipId, report);
      }
    }

    const items = rows.map((row): RelationshipListItemView => {
      const isInviter = row.userAId === input.userId;
      const partnerId = isInviter ? row.userBId : row.userAId;
      const partner = userById.get(partnerId);
      const profile = profileByUserId.get(partnerId);
      const hasProfile = profile !== undefined;
      const invite = row.invites[0] ?? null;

      return {
        relationshipId: row.id,
        relationType: row.type,
        relationTypeName: relationTypeName(row.type),
        status: row.status,
        statusLabel: relationStatusLabel(row.status),
        myRole: isInviter ? 'INVITER' : 'INVITEE',
        partner: {
          userId: partnerId,
          nickname: partner?.nickname ?? null,
          avatarUrl: partner?.avatarUrl ?? null,
          mbtiType: profile?.mbtiType ?? null,
          typeName: mbtiTypeName(profile?.mbtiType ?? null),
          profileVersion: profile?.version ?? null,
          hasProfile,
        },
        invitedAt: invite?.createdAt.toISOString() ?? null,
        acceptedAt: row.createdAt.toISOString(),
        activatedAt: row.confirmedAt?.toISOString() ?? null,
        expiresAt: relationshipExpiresAt(row.status, invite?.expiresAt ?? null),
        daysTogether: daysTogether(row.confirmedAt, now),
        compatibility: this.buildCompatibilitySummary({
          lastReportAt: row.lastReportAt,
          latestReport: latestReportByRelationshipId.get(row.id) ?? null,
          status: row.status,
          iHaveProfile: myProfile !== null,
          partnerHasProfile: hasProfile,
        }),
        conversationCount: conversationByRelationshipId.get(row.id) ?? 0,
        // 契约字段名是 `lastInteractionAt`，而关系表没有这一列。
        // 用 `updatedAt` 作为代理：关系行只在状态变更时被写，语义上接近"最近互动"。
        lastInteractionAt: row.updatedAt.toISOString(),
      };
    });

    return {
      items,
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
      summary: buildRelationshipSummary(this.summarizeRelationships(summaryRows)),
    };
  }

  /**
   * 关系详情（契约 §3.6.5）
   *
   * IDOR 防护：非双方一律按**不存在**处理（`60000`），而不是返回 403。
   * 返回 403 等于告诉攻击者"这条 ID 是真实存在的"，可以被用来枚举；
   * 「不存在」不泄露任何信息。
   */
  async getRelationship(userId: string, relationshipId: string): Promise<RelationshipDetailView> {
    const row = await this.prisma.relationship.findFirst({
      where: {
        id: relationshipId,
        deletedAt: null,
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      select: {
        id: true,
        type: true,
        status: true,
        userAId: true,
        userBId: true,
        confirmedAt: true,
        confirmedByUserId: true,
        createdAt: true,
        lastReportAt: true,
        invites: {
          select: { inviterId: true, createdAt: true, acceptedAt: true, expiresAt: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });

    if (row === null) {
      throw BusinessException.notFound(ErrorCode.RELATIONSHIP_NOT_FOUND);
    }

    const [users, profiles, conversations, latestReport] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [row.userAId, row.userBId] } },
        select: { id: true, nickname: true, avatarUrl: true },
      }),
      this.prisma.personalityProfile.findMany({
        where: { userId: { in: [row.userAId, row.userBId] }, isCurrent: true },
        select: { userId: true, mbtiType: true, version: true },
      }),
      this.prisma.aiConversation.findMany({
        where: { userId, relationshipId: row.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, lastMessageAt: true },
      }),
      this.prisma.compatibilityReport.findFirst({
        where: { relationshipId: row.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, totalScore: true, generatedAt: true },
      }),
    ]);

    const userById = new Map(users.map((user) => [user.id, user]));
    const profileByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));
    const invite = row.invites[0] ?? null;
    const isInviter = row.userAId === userId;

    const sideOf = (sideId: string, role: 'INVITER' | 'INVITEE'): RelationshipSideView => {
      const profile = profileByUserId.get(sideId);

      return {
        userId: sideId,
        nickname: userById.get(sideId)?.nickname ?? null,
        avatarUrl: userById.get(sideId)?.avatarUrl ?? null,
        mbtiType: profile?.mbtiType ?? null,
        isMe: sideId === userId,
        role,
        confirmedAt: row.confirmedAt?.toISOString() ?? null,
        hasProfile: profile !== undefined,
        profileVersion: profile?.version ?? 0,
      };
    };

    const bothHaveProfiles = profileByUserId.has(row.userAId) && profileByUserId.has(row.userBId);
    const latestConversation = conversations[0] ?? null;

    return {
      relationshipId: row.id,
      relationType: row.type,
      relationTypeName: relationTypeName(row.type),
      status: row.status,
      statusLabel: relationStatusLabel(row.status),
      myRole: isInviter ? 'INVITER' : 'INVITEE',
      pendingConfirmationBy: row.status === 'PENDING_A_CONFIRM' ? row.userAId : null,
      userA: sideOf(row.userAId, 'INVITER'),
      userB: sideOf(row.userBId, 'INVITEE'),
      acceptedAt: row.createdAt.toISOString(),
      activatedAt: row.confirmedAt?.toISOString() ?? null,
      daysTogether: daysTogether(row.confirmedAt, new Date()),
      compatibility: this.buildCompatibilitySummary({
        lastReportAt: row.lastReportAt,
        latestReport,
        status: row.status,
        iHaveProfile: profileByUserId.has(userId),
        partnerHasProfile: bothHaveProfiles,
      }),
      aiConversation: {
        conversationCount: conversations.length,
        latestConversationId: latestConversation?.id ?? null,
        lastMessageAt: latestConversation?.lastMessageAt?.toISOString() ?? null,
        // 关系解除后保留历史对话可读，但不能再开启新对话（契约 §3.6.7）
        canStartNew: row.status === 'ACTIVE',
      },
      timeline: buildTimeline({
        invitedAt: invite?.createdAt ?? null,
        invitedByUserId: invite?.inviterId ?? null,
        acceptedAt: invite?.acceptedAt ?? row.createdAt,
        acceptedByUserId: row.userBId,
        activatedAt: row.confirmedAt,
        activatedByUserId: row.confirmedByUserId,
        lastReportAt: row.lastReportAt,
      }),
      permissions: buildPermissions({
        status: row.status,
        isInviter,
        bothHaveProfiles,
      }),
      disclaimer: RELATIONSHIP_DISCLAIMER,
    };
  }

  /**
   * 匹配报告摘要
   *
   * 管道落地后（`compatibility.calc`）这里读**真实报告**，不再硬编码 `false`：
   * `canGenerate` 由 `resolveCompatibilityBlocker` 判定，与触发接口用的是**同一份
   * 规则** —— 否则会出现"列表说可以生成、点进去报不能生成"这类自相矛盾的界面。
   */
  private buildCompatibilitySummary(params: {
    lastReportAt: Date | null;
    latestReport: { id: string; status: string; totalScore: number | null; generatedAt: Date | null } | null;
    status: string;
    iHaveProfile: boolean;
    partnerHasProfile: boolean;
  }): CompatibilitySummaryView {
    const report = params.latestReport;
    const level =
      report?.totalScore === null || report?.totalScore === undefined
        ? null
        : compatibilityScoreLevel(report.totalScore);

    const blocker = resolveCompatibilityBlocker({
      status: params.status,
      iHaveProfile: params.iHaveProfile,
      partnerHasProfile: params.partnerHasProfile,
      isGenerating: report !== null && isCompatibilityInProgress(report.status),
    });

    return {
      // 有报告记录即算"有"：正在生成也是一份进行中的报告，前端据此展示进度
      hasReport: report !== null,
      latestReportId: report?.id ?? null,
      overallScore: report?.totalScore ?? null,
      scoreLevel: level,
      scoreLabel: level === null ? null : compatibilityScoreLabel(level),
      generatedAt: report?.generatedAt?.toISOString() ?? params.lastReportAt?.toISOString() ?? null,
      canGenerate: blocker === null,
      isGenerating: report !== null && isCompatibilityInProgress(report.status),
      blockedReason: blocker === 'ALREADY_GENERATING' ? null : blocker,
    };
  }

  /** 把 `groupBy` 结果折叠成摘要计数 */
  private summarizeRelationships(rows: readonly { status: string; type: string; _count: { _all: number } }[]): {
    activeCount: number;
    pendingCount: number;
    coupleCount: number;
    friendCount: number;
    familyCount: number;
  } {
    const counts = {
      activeCount: 0,
      pendingCount: 0,
      coupleCount: 0,
      friendCount: 0,
      familyCount: 0,
    };

    for (const row of rows) {
      const count = row._count._all;
      if (row.status === 'ACTIVE') counts.activeCount += count;
      if (row.status === 'PENDING_A_CONFIRM') counts.pendingCount += count;
      if (row.type === 'COUPLE') counts.coupleCount += count;
      if (row.type === 'FRIEND') counts.friendCount += count;
      if (row.type === 'FAMILY') counts.familyCount += count;
    }

    return counts;
  }
}
