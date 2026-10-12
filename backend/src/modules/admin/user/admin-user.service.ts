/**
 * AdminUserService — 管理端用户管理
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.2（4 个接口：列表 / 详情 / 封禁 / 解封）
 *
 * ============================================================================
 * 一、契约与数据模型的映射（先说清楚，后面所有「不一致」都是同一批原因）
 * ============================================================================
 *
 * 1. **`status` 是「展示态」，不是数据层枚举**
 *    契约取值 `ACTIVE | BANNED | PENDING_DELETION | DELETED`，而 schema 的
 *    `UserStatus` 只有 `ACTIVE | DISABLED | DELETED`（无 `BANNED`），
 *    「注销冷静期」也不是用户状态而是 `user_deletion_requests` 里的一条 PENDING 记录。
 *    因此本服务统一用 `displayStatus()` 把「用户行 + 是否有待处理注销申请」翻译成展示态：
 *      · `DELETED`           ← `status = DELETED` 或 `deletedAt/anonymizedAt` 非空
 *      · `BANNED`            ← `status = DISABLED`（封禁在数据层即 DISABLED，
 *                              与 `auth.service.ts` / `token.service.ts` 的既有约定一致）
 *      · `PENDING_DELETION`  ← 存在 PENDING 的注销申请
 *      · `ACTIVE`            ← 其余
 *    优先级 `DELETED > BANNED > PENDING_DELETION` 是刻意选的：契约 §3.14.2.3 明确
 *    「PENDING_DELETION 与 BANNED 可共存」，而 `status` 只能有一个值，
 *    因此取「更不可逆的一方」，另一事实由 `hasDeletionRequest` / `isBanned` 字段单独暴露。
 *
 * 2. **封禁元数据无处落库 → 以审计日志为唯一事实来源**
 *    契约要求封禁记录 `reason` / `reasonDetail` / `expiresAt` / `bannedAt`，
 *    但 `users` 表没有这些列（schema 不可改）。本服务把封禁元数据完整写入
 *    `admin_audit_logs.after_data`（契约 §3.14.2.3 规则 5 本就要求 before/after diff），
 *    再以「该用户最新一条带 `ban: true` 标记的 UPDATE 审计」为封禁状态的读取来源。
 *    好处：审计是已经存在的事实记录，无需新增表；代价：封禁状态读取依赖审计表，
 *    且 `GET /admin/users` 的 `bannedReason` 需要一次批量反查（见 `loadBanStates()`）。
 *    ⚠ 契约 §3.14.2.3 规则 6 的「到期自动解封」需要一个 maintenance cron，
 *      该任务不在本模块交付范围内（本模块只负责写入 `expiresAt`）。
 *
 * 3. **`riskFlags` / `statusMessage` / `lastActiveAt` / `openidHash` 等字段的来源**
 *    · `riskFlags`：生产环境应由风控任务写入，本项目尚无风控表 → 恒返回 `[]`（不伪造数据）
 *    · `statusMessage`：`users` 表无该列 → 恒返回 `null`
 *    · `lastActiveAt`：`users` 表无该列，取 `lastLoginAt`（最近一次登录）作为活跃近似值
 *    · `openidHash`：`wechat_accounts.openid` 明文落库（有唯一索引，需精确查重），
 *      对外**只返回 `sha256(openid)`**，绝不返回原文（契约 §3.14.2.1 规则 2）
 *    · `phoneMasked`：优先取 `user_phone_history.phone_masked`（专为人工审计存的脱敏值），
 *      缺失时才解密 `phone_enc` 后就地脱敏；明文永不进入响应或日志
 *
 * 4. **错误码冲突（只使用 `common/errors/error-code.ts` 已有码，不新增）**
 *    契约 §3.14.2 使用的 `10003`（id 非法 UUID）与 `30001`（用户不存在）在本项目的错误码表里
 *    已被占用且含义完全不同（`10003 = RESOURCE_CONFLICT`(409)、`30001 = USER_PROFILE_INCOMPLETE`(400)）。
 *    强行复用会给出语义错误的码，因此这里改用语义正确的既有码，并在每处标注：
 *      · 参数类：`10001 PARAM_INVALID`（400）承接契约的 `10003` 与 `10001`
 *      · 用户不存在：`30000 USER_NOT_FOUND`（404）承接契约的 `30001`
 *      · 契约的 `10004`（sortBy 白名单）与 `10005`（pageSize 超限）虽语义怪但码存在，
 *        为「逐字段遵守契约」仍按契约码返回（HTTP 400 用 `BusinessException.badRequest` 强制）
 *
 * 5. **审计动作枚举同样受限**：契约要求 `action = user:user:read`，但
 *    `AdminAuditAction` 是 PG 枚举，取值固定为 LOGIN/UPDATE/GRANT/... （无权限点形态的值）。
 *    schema 不可改，故：只读访问 → `EXPORT`（数据被读出系统，最接近的语义），
 *    状态变更 → `UPDATE`，补偿发放 → `MANUAL_FULFILL`；
 *    真正的「权限点形态动作名」写进 `diff_summary` 前缀，保证审计列表仍可按动作检索到人。
 *
 * 6. **会话撤销为什么不直接调 `TokenService.revokeAllSessions()`**
 *    架构 §6.1 的模块依赖白名单要求 `admin` 只使用其它模块的**只读**服务方法，
 *    而撤销会话是用户端写操作；同时本模块的 Nest 装配被要求只 `imports: [AdminModule]`。
 *    因此这里按 `TokenService` 的**同一套 Redis 键布局**就地实现（键名与语义逐一对齐：
 *    `rt:session:{jti}` / `rt:used:{jti}` / `sess:user:{userId}` / `jwt:blacklist:{jti}`），
 *    并在此标注：键布局是跨模块契约，日后若抽取为 infra 能力需同步改造本文件。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { AdminAuditAction, Prisma } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { maskPhone, normalizePhoneDigits, toAgeRange } from '../../../common/utils/mask.util';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { TokenService } from '../../auth/token.service';
import { AdminAuditService, type AdminAuditEntry } from '../audit/admin-audit.service';
import {
  ADMIN_USER_INCLUDE_BLOCKS,
  ADMIN_USER_MAX_PAGE_SIZE,
  ADMIN_USER_SORT_FIELDS,
  ADMIN_USER_STATUSES,
  ADMIN_USER_DEFAULT_PAGE_SIZE,
  BAN_REASON_LABELS,
  DEFAULT_ADMIN_USER_INCLUDES,
  MBTI_TYPES,
  type AdminUserDisplayStatus,
  type AdminUserIncludeBlock,
  type AdminUserListQueryDto,
  type AdminUserSortField,
  type AdminUserStatusFilter,
  type BanReason,
  type BanUserDto,
  type ResolvedInclude,
  type UnbanUserDto,
} from './dto/admin-user.dto';

// ============================================================================
// 响应类型（与契约 §3.14.2 的响应示例逐字段对齐）
// ============================================================================

/** 列表条目（契约 §3.14.2.1 `data.items[]`） */
export interface AdminUserListItem {
  userId: string;
  nickname: string | null;
  avatarUrl: string | null;
  gender: string;
  ageRange: string | null;
  status: AdminUserDisplayStatus;
  phoneBound: boolean;
  phoneMasked: string | null;
  openidHash: string | null;
  mbtiType: string | null;
  profileVersion: number | null;
  isMember: boolean;
  membershipPlan: string | null;
  membershipExpiresAt: string | null;
  orderCount: number;
  totalPaidAmount: number;
  reportCount: number;
  relationshipCount: number;
  aiMessageCount: number;
  createdAt: string;
  lastActiveAt: string | null;
  isBanned: boolean;
  bannedReason: string | null;
  hasDeletionRequest: boolean;
  riskFlags: string[];
}

/**
 * 列表统计概览（契约 §3.14.2.1 `data.summary`）
 *
 * 刻意是**全库口径**（不受筛选条件影响）：示例里 `total` 为 2 而 `totalUsers` 为 18420，
 * 说明它服务于「顶部卡片」而不是「当前筛选结果」。
 */
export interface AdminUserListSummary {
  totalUsers: number;
  activeUsers: number;
  bannedUsers: number;
  memberUsers: number;
  pendingDeletionUsers: number;
  newUsersToday: number;
}

/** 列表响应（契约 §3.14.2.1） */
export interface AdminUserListView {
  items: AdminUserListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  summary: AdminUserListSummary;
}

/** 详情：用户资料块（契约 §3.14.2.2 `data.user`） */
export interface AdminUserDetailUser {
  userId: string;
  nickname: string | null;
  avatarUrl: string | null;
  gender: string;
  birthday: string | null;
  ageRange: string | null;
  /** 个人状态签名；数据模型暂无该列，恒为 null（见文件头说明 3） */
  statusMessage: string | null;
  status: AdminUserDisplayStatus;
  ageVerified: boolean;
  phoneBound: boolean;
  phoneMasked: string | null;
  openidHash: string | null;
  unionidHash: string | null;
  wechatAccountCreatedAt: string | null;
  sessionKeyUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  deletedAt: string | null;
  riskFlags: string[];
}

/** 详情：画像块 */
export interface AdminUserProfileBlock {
  profileId: string;
  version: number;
  mbtiType: string;
  confidence: number;
  engineVersion: string;
  bigFive: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
  };
  attachment: string;
  generatedAt: string;
}

/** 详情：会员块 */
export interface AdminUserMembershipBlock {
  isActive: boolean;
  planCode: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  sourceOrderNo: string | null;
  historyCount: number;
}

/** 详情：订单块 */
export interface AdminUserOrdersBlock {
  items: Array<{
    orderId: string;
    orderNo: string;
    productName: string | null;
    amount: number;
    status: string;
    paidAt: string | null;
  }>;
  totalCount: number;
  totalPaidAmount: number;
  refundedAmount: number;
}

/** 详情：报告块 */
export interface AdminUserReportsBlock {
  items: Array<{
    reportId: string;
    type: string;
    status: string;
    wordCount: number;
    isUnlocked: boolean;
    generatedAt: string | null;
  }>;
  totalCount: number;
}

/** 详情：关系块 */
export interface AdminUserRelationshipsBlock {
  items: Array<{
    relationshipId: string;
    relationType: string;
    status: string;
    partnerUserId: string | null;
    partnerNickname: string | null;
    activatedAt: string | null;
  }>;
  totalCount: number;
}

/** 详情：AI 用量块（只有计量，永远没有对话原文，契约 §3.14.2.2 规则 1） */
export interface AdminUserAiUsageBlock {
  totalMessages: number;
  totalTokens: number;
  totalCostCents: number;
  todayMessages: number;
  todayTokens: number;
  conversationCount: number;
  safetyBlockedCount: number;
  lastMessageAt: string | null;
}

/** 详情：同意记录条目 */
export interface AdminUserConsentEntry {
  type: string;
  version: string | null;
  agreed: boolean;
  agreedAt: string | null;
  channel: string | null;
}

/** 详情：注销申请块 */
export interface AdminUserDeletionBlock {
  hasRequest: boolean;
  requestId: string | null;
  status: string | null;
  requestedAt: string | null;
  scheduledAt: string | null;
}

/** 详情：后台操作轨迹条目 */
export interface AdminUserAuditTrailEntry {
  at: string;
  action: string;
  operatorAdminId: string | null;
  operatorName: string;
  detail: string | null;
}

/**
 * 详情：测试会话块
 *
 * ⚠ 契约 §3.14.2.2 把 `testSessions` 列入 `include` 白名单，但**没有给出响应示例**，
 *   因此字段是按其用途（排查用户作答链路）取最小必要集，属于「契约未定，本实现自定义」。
 */
export interface AdminUserTestSessionsBlock {
  items: Array<{
    sessionId: string;
    testDefinitionId: string;
    definitionCode: string;
    status: string;
    startedAt: string | null;
    submittedAt: string | null;
  }>;
  totalCount: number;
}

/**
 * 详情响应（契约 §3.14.2.2）
 *
 * `user` / `profile` / `serverTime` 恒定返回；其余块**仅在 `include` 中显式请求时才出现**
 * （与用户端 `GET /users/me` 的 include 语义一致：未请求的块不出现 key，而非返回 null）。
 */
export interface AdminUserDetailView {
  user: AdminUserDetailUser;
  profile: AdminUserProfileBlock | null;
  orders?: AdminUserOrdersBlock;
  membership?: AdminUserMembershipBlock;
  reports?: AdminUserReportsBlock;
  relationships?: AdminUserRelationshipsBlock;
  aiUsage?: AdminUserAiUsageBlock;
  consents?: AdminUserConsentEntry[];
  deletion?: AdminUserDeletionBlock;
  auditTrail?: AdminUserAuditTrailEntry[];
  testSessions?: AdminUserTestSessionsBlock;
  serverTime: string;
}

/** 操作者摘要（封禁 / 解封响应里的 bannedBy / unbannedBy） */
export interface AdminOperatorBrief {
  adminId: string;
  displayName: string;
}

/** 封禁响应（契约 §3.14.2.3） */
export interface BanUserView {
  userId: string;
  nickname: string | null;
  previousStatus: AdminUserDisplayStatus;
  status: AdminUserDisplayStatus;
  banType: 'TEMPORARY' | 'PERMANENT';
  reason: string;
  reasonDetail: string | null;
  bannedAt: string;
  bannedBy: AdminOperatorBrief;
  expiresAt: string | null;
  isPermanent: boolean;
  revokedSessions: number;
  notifiedUser: boolean;
  auditLogId: string | null;
  affectedResources: {
    note: string;
    activeMembershipPreserved: boolean;
    unusedAiCreditsPreserved: boolean;
  };
}

/** 上一次封禁快照（解封响应里的 previousBan，用于申诉复盘） */
export interface AdminPreviousBanView {
  reason: string;
  bannedAt: string;
  expiresAt: string | null;
  /** 实际封禁时长（秒）；永久封禁为 null（契约示例给的是数字，但永久封禁无时长语义） */
  durationSeconds: number | null;
}

/** 补偿权益（解封响应里的 compensation） */
export interface AdminCompensationView {
  granted: boolean;
  entitlementId: string | null;
  type: string | null;
  durationDays: number;
  expiresAt: string | null;
  note: string | null;
}

/** 解封响应（契约 §3.14.2.4） */
export interface UnbanUserView {
  userId: string;
  nickname: string | null;
  previousStatus: AdminUserDisplayStatus;
  status: AdminUserDisplayStatus;
  unbannedAt: string;
  unbannedBy: AdminOperatorBrief;
  reason: string;
  previousBan: AdminPreviousBanView | null;
  compensation: AdminCompensationView;
  notifiedUser: boolean;
  auditLogId: string | null;
}

/**
 * 操作者上下文（由 Controller 从 `request` 注入）
 *
 * `adminUserId` 来自 `@CurrentUser('userId')`，其余字段用于审计留痕；
 * `jti` 也一并采集：审计里带上会话标识才能在「同一管理员多设备登录」时定位到具体会话。
 */
export interface AdminOperatorContext {
  adminUserId: string;
  jti?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

// ============================================================================
// 常量
// ============================================================================

/** 审计资源类型（与 `AdminAuditLog.resourceType` 的取值约定一致） */
const RESOURCE_TYPE_USER = 'user';
const RESOURCE_TYPE_ENTITLEMENT = 'entitlement';

/**
 * 审计动作映射（见文件头说明 5）
 *
 * 只读访问没有专属枚举值，选 `EXPORT`（「数据被读出系统」）；
 * 这是**有损映射**：真正的动作名（`user:user:read` / `user:user:write`）写进 diffSummary 前缀。
 */
const AUDIT_ACTION_READ: AdminAuditAction = 'EXPORT';
const AUDIT_ACTION_WRITE: AdminAuditAction = 'UPDATE';
const AUDIT_ACTION_GRANT: AdminAuditAction = 'MANUAL_FULFILL';

/** 契约规定的权限点（写进审计摘要，便于按动作检索） */
const PERMISSION_USER_READ = 'user:user:read';
const PERMISSION_USER_WRITE = 'user:user:write';

/** 封禁元数据在审计 afterData 里的标记位（用于与其他 UPDATE 审计区分） */
const BAN_AUDIT_MARKER = 'ban';

/** 细节块列表的返回条数上限（契约示例每条最多 3 条，这里给运维排查留出余量） */
const DETAIL_LIST_TAKE = 20;

/** 详情 `auditTrail` 的条数上限（审计轨迹是「最近发生了什么」，不需要全量） */
const AUDIT_TRAIL_TAKE = 20;

/** 封禁时撤销会话的审计原因（写入 `user_sessions.revoked_reason`） */
const REVOKE_REASON_BAN = 'ADMIN_BANNED';

/** 补偿：优先给会员延期天数（契约 §3.14.2.4 规则 2「会员延期优先」） */
const COMPENSATION_MEMBERSHIP_DAYS = 7;

/**
 * 补偿：无有效会员时改为等值 AI 次数
 *
 * ⚠ 契约原文只写「赠送 7 天会员**或等值 AI 次数**」，未给出换算比例。
 *   这里按「1 天会员 ≈ 7 次 AI」取整为 50 次作为**当前默认值**，
 *   待运营确认后应改为 `system_configs` 下发（本模块未引入配置读取，避免与后台配置域耦合）。
 */
const COMPENSATION_AI_CREDITS = 50;

/** 补偿 AI 次数权益的有效期（天）——契约未定，取 30 天与月度权益口径一致 */
const COMPENSATION_AI_CREDITS_VALID_DAYS = 30;

/** UUID 形态（`id` 非法时返回 10001，见文件头说明 4） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 中国大陆手机号形态（契约 §3.14.2.1 规则 1 只对手机号做哈希精确匹配） */
const CHINA_MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/** 固定 5 类同意项（顺序即前端展示顺序，与 Prisma `ConsentType` 对齐） */
const CONSENT_TYPES = [
  'PRIVACY_POLICY',
  'TERMS_OF_SERVICE',
  'AGE_DECLARATION',
  'AI_CONTENT_NOTICE',
  'MARKETING',
] as const;

/** 契约 §3.14.2.3 响应里的权益保留说明（固定文案，避免多处漂移） */
const AFFECTED_RESOURCES_NOTE = '封禁不影响已购权益与订单；用户可在封禁期满后继续使用未过期的权益。';

/** 封禁 / 解封通知文案（契约要求「明确原因分类但不暴露内部风控规则细节」） */
const BAN_NOTIFICATION_TITLE = '账号使用受限通知';
const UNBAN_NOTIFICATION_TITLE = '账号限制已解除';
const UNBAN_COMPENSATION_NOTE = '因平台误判，已为你补发补偿权益，给你带来不便敬请谅解。';

// ============================================================================
// 查询片段
// ============================================================================

/**
 * 列表行的字段选择
 *
 * 只选列表需要的列：契约 §3.14.2.1 规则 3 明确「不返回敏感字段」，
 * 因此这里连 `phone_enc` 都只在需要兜底脱敏时读取（见 `loadPhoneMasks`）。
 */
const LIST_USER_SELECT = {
  id: true,
  nickname: true,
  avatarUrl: true,
  gender: true,
  birthday: true,
  status: true,
  phoneHash: true,
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
  deletedAt: true,
  anonymizedAt: true,
  wechatAccounts: {
    where: { deletedAt: null },
    take: 1,
    select: { openid: true },
  },
  profiles: {
    where: { isCurrent: true, deletedAt: null },
    take: 1,
    orderBy: { version: 'desc' },
    select: { mbtiType: true, version: true },
  },
} as const satisfies Prisma.UserSelect;

type ListUserRow = Prisma.UserGetPayload<{ select: typeof LIST_USER_SELECT }>;

@Injectable()
export class AdminUserService {
  private readonly logger = new Logger(AdminUserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    /**
     * 会话撤销复用 `auth` 模块的 `TokenService`，而**不是**在本地按它的 Redis 键布局
     * 重写一遍：键布局属于 `auth` 的内部实现，复制一份会在它调整键名/存储时
     * **静默失效**，且没有编译期提示。这是架构 §6.1 依赖白名单的显式登记例外（ADR-032）。
     */
    private readonly tokens: TokenService,
    private readonly audit: AdminAuditService,
  ) {}

  // ==========================================================================
  // GET /admin/users
  // ==========================================================================

  /**
   * 用户列表（契约 §3.14.2.1）
   *
   * 契约规则 5：本接口属于**强审计**范围 —— 每次查询都要写审计（含查询条件），
   * 目的是让「谁在什么时候翻了哪些用户」可回溯（防内部人员无痕拖库）。
   * 因此审计在**查询成功后立即写**，且把筛选条件原样记进 diffSummary。
   */
  async listUsers(query: AdminUserListQueryDto, operator: AdminOperatorContext): Promise<AdminUserListView> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ADMIN_USER_DEFAULT_PAGE_SIZE;

    // 契约：pageSize > 100 → 10005（注意 10005 的默认 HTTP 是 413，契约要求 400，故显式指定）
    if (pageSize > ADMIN_USER_MAX_PAGE_SIZE) {
      throw BusinessException.badRequest(ErrorCode.PAYLOAD_TOO_LARGE, `pageSize 最大为 ${ADMIN_USER_MAX_PAGE_SIZE}`);
    }

    // 契约：sortBy 不在白名单 → 10004
    const sortBy = (query.sortBy ?? 'createdAt') as AdminUserSortField;
    if (!ADMIN_USER_SORT_FIELDS.includes(sortBy)) {
      throw BusinessException.badRequest(
        ErrorCode.METHOD_NOT_ALLOWED,
        `sortBy 仅支持：${ADMIN_USER_SORT_FIELDS.join(', ')}`,
      );
    }

    const order = query.order ?? 'desc';
    const statuses = this.parseStatuses(query.status);
    // MBTI 统一大写后再入查询：否则 'infj' 能通过校验却匹配不到任何数据（大小写不一致的经典坑）
    const mbtiType = this.normalizeMbtiType(query.mbtiType);

    const where = this.buildListWhere({ ...query, mbtiType }, statuses);

    const [pageResult, summary] = await Promise.all([
      this.loadListPage({ where, sortBy, order, skip: (page - 1) * pageSize, take: pageSize }),
      this.loadSummary(),
    ]);

    const items = await this.assembleListItems(pageResult.rows);
    const resolvedOperator = await this.resolveOperator(operator.adminUserId);

    await this.writeAudit({
      adminUserId: resolvedOperator.adminId,
      adminUsername: resolvedOperator.username,
      action: AUDIT_ACTION_READ,
      resourceType: RESOURCE_TYPE_USER,
      resourceId: null,
      targetUserId: null,
      diffSummary: `[${PERMISSION_USER_READ}] 用户列表查询（${this.describeListQuery(query, page, pageSize)}）`,
      reason: null,
      ip: operator.ip ?? null,
      userAgent: operator.userAgent ?? null,
      requestId: operator.requestId ?? null,
    });

    return {
      items,
      total: pageResult.total,
      page,
      pageSize,
      hasNext: page * pageSize < pageResult.total,
      summary,
    };
  }

  /** 列表查询条件的可读描述（写进审计摘要，便于事后复盘「他查了什么」） */
  private describeListQuery(query: AdminUserListQueryDto, page: number, pageSize: number): string {
    const parts = [`page=${page}`, `pageSize=${pageSize}`];

    if (query.keyword) {
      // 关键词可能是手机号（低熵），审计里不落原文，只记长度与形态
      parts.push(`keyword(长度${query.keyword.length})`);
    }
    if (query.status) parts.push(`status=${query.status}`);
    if (query.mbtiType) parts.push(`mbtiType=${query.mbtiType}`);
    if (query.isMember !== undefined) parts.push(`isMember=${String(query.isMember)}`);
    if (query.hasPaid !== undefined) parts.push(`hasPaid=${String(query.hasPaid)}`);
    if (query.phoneBound !== undefined) parts.push(`phoneBound=${String(query.phoneBound)}`);
    if (query.sortBy) parts.push(`sortBy=${query.sortBy}`);
    if (query.order) parts.push(`order=${query.order}`);

    return parts.join(', ');
  }

  /**
   * 组装分页查询的 where
   *
   * 契约把「展示态」当作筛选值，这里逐项翻译成数据层条件；
   * `status` 多值时用 OR（契约允许逗号分隔多选），并与 `ACTIVE` 的
   * 「不含注销冷静期用户」语义保持一致（否则 ACTIVE 与 PENDING_DELETION 会重叠）。
   */
  private buildListWhere(query: AdminUserListQueryDto, statuses: AdminUserStatusFilter[]): Prisma.UserWhereInput {
    const and: Prisma.UserWhereInput[] = [];

    // ---------------------------------------------------------------- 关键词
    if (query.keyword && query.keyword.length > 0) {
      and.push({ OR: this.buildKeywordConditions(query.keyword) });
    }

    // ------------------------------------------------------------ 状态筛选
    if (statuses.length > 0) {
      and.push({ OR: statuses.map((status) => this.statusCondition(status)) });
    }

    // ------------------------------------------------------------ MBTI 筛选
    if (query.mbtiType) {
      and.push({
        profiles: { some: { isCurrent: true, deletedAt: null, mbtiType: query.mbtiType } },
      });
    }

    // ---------------------------------------------------------------- 会员
    if (query.isMember !== undefined) {
      const activeMembership: Prisma.MembershipWhereInput = {
        status: 'ACTIVE',
        deletedAt: null,
        expireAt: { gt: new Date() },
      };

      and.push(
        query.isMember ? { memberships: { some: activeMembership } } : { memberships: { none: activeMembership } },
      );
    }

    // ------------------------------------------------------------ 已支付订单
    if (query.hasPaid !== undefined) {
      and.push(
        query.hasPaid
          ? { orders: { some: { paidAt: { not: null } } } }
          : { orders: { none: { paidAt: { not: null } } } },
      );
    }

    // ------------------------------------------------------------ 手机号绑定
    if (query.phoneBound !== undefined) {
      and.push({ phoneHash: query.phoneBound ? { not: null } : null });
    }

    // ---------------------------------------------------------- 注册时间范围
    if (query.registeredStartTime ?? query.registeredEndTime) {
      and.push({
        createdAt: {
          ...(query.registeredStartTime ? { gte: new Date(query.registeredStartTime) } : {}),
          ...(query.registeredEndTime ? { lte: new Date(query.registeredEndTime) } : {}),
        },
      });
    }

    // ---------------------------------------------------------- 活跃时间范围
    // 数据层没有 last_active_at，用 last_login_at 作为「最近活跃」的近似（见文件头说明 3）
    if (query.lastActiveStartTime ?? query.lastActiveEndTime) {
      and.push({
        lastLoginAt: {
          ...(query.lastActiveStartTime ? { gte: new Date(query.lastActiveStartTime) } : {}),
          ...(query.lastActiveEndTime ? { lte: new Date(query.lastActiveEndTime) } : {}),
        },
      });
    }

    return and.length > 0 ? { AND: and } : {};
  }

  /**
   * 关键词 → 查询条件（契约 §3.14.2.1 规则 1）
   *
   * 三条命中路径是**刻意不对称**的：
   *   · 昵称：模糊（运营需要按昵称找人对客服）
   *   · 手机号：只允许「服务端加盐 SHA-256 后精确匹配 phoneHash」，
   *     🚫 绝不模糊 —— 模糊匹配等于把手机号空间暴露成可枚举的查询接口（防批量拖库）
   *   · 用户 ID：精确（客服拿着 ID 直接定位）
   */
  private buildKeywordConditions(keyword: string): Prisma.UserWhereInput[] {
    const conditions: Prisma.UserWhereInput[] = [];

    if (UUID_PATTERN.test(keyword)) {
      conditions.push({ id: keyword });
    }

    // 手机号分支：只有形态合法且盐值可用时才查，否则静默跳过（不报错、不泄露「是否配置了盐」）
    const digits = normalizePhoneDigits(keyword);
    if (digits !== null && CHINA_MOBILE_PATTERN.test(digits) && this.crypto.saltedHashAvailable) {
      conditions.push({ phoneHash: this.crypto.sha256Salted(digits) });
    }

    conditions.push({ nickname: { contains: keyword, mode: 'insensitive' } });

    return conditions;
  }

  /** 展示态 → 数据层条件（映射理由见文件头说明 1） */
  private statusCondition(status: AdminUserStatusFilter): Prisma.UserWhereInput {
    switch (status) {
      case 'ACTIVE':
        // 「正常」必须排除注销冷静期：冷静期用户在展示态上不是 ACTIVE
        return {
          status: 'ACTIVE',
          deletedAt: null,
          anonymizedAt: null,
          deletionRequests: { none: { status: 'PENDING' } },
        };
      case 'BANNED':
        return { status: 'DISABLED' };
      case 'PENDING_DELETION':
        return {
          status: { not: 'DELETED' },
          deletedAt: null,
          deletionRequests: { some: { status: 'PENDING' } },
        };
      case 'DELETED':
      default:
        return { OR: [{ status: 'DELETED' }, { deletedAt: { not: null } }, { anonymizedAt: { not: null } }] };
    }
  }

  /**
   * 分页取数
   *
   * `totalPaidAmount` 排序需要说明：Prisma 无法按 `SUM` 聚合列排序（`orderBy` 不支持聚合），
   * 因此该分支退化为「取 id 集合 → groupBy 求和 → 内存排序 → 回表」。
   * 取舍：避免了手写原生 SQL（跨表 JOIN + 全部筛选条件的参数化拼装更难维护、更易出错），
   * 代价是筛选结果集很大时内存占用与耗时随用户量增长。
   * ⚠ 用户量级增长后应改为物化列（如 `users.total_paid_amount` 由支付成功时更新）或
   *   `ORDER BY (SELECT SUM(...))` 的原生子查询 —— 已在代码评审中标注为技术债。
   */
  private async loadListPage(options: {
    where: Prisma.UserWhereInput;
    sortBy: AdminUserSortField;
    order: Prisma.SortOrder;
    skip: number;
    take: number;
  }): Promise<{ rows: ListUserRow[]; total: number }> {
    const { where, sortBy, order, skip, take } = options;

    if (sortBy !== 'totalPaidAmount') {
      const orderBy: Prisma.UserOrderByWithRelationInput =
        sortBy === 'lastActiveAt' ? { lastLoginAt: order } : { createdAt: order };

      const [rows, total] = await Promise.all([
        this.prisma.user.findMany({ where, select: LIST_USER_SELECT, orderBy, skip, take }),
        this.prisma.user.count({ where }),
      ]);

      return { rows, total };
    }

    // ------------------------------------------------- 按累计支付金额排序分支
    const idRows = await this.prisma.user.findMany({ where, select: { id: true, createdAt: true } });
    const ids = idRows.map((row) => row.id);

    if (ids.length === 0) {
      return { rows: [], total: 0 };
    }

    const sums = await this.prisma.order.groupBy({
      by: ['userId'],
      where: { userId: { in: ids }, paidAt: { not: null } },
      _sum: { paidAmount: true },
    });

    const amountOf = new Map<string, number>(sums.map((row) => [row.userId, row._sum.paidAmount ?? 0]));
    const createdAtOf = new Map<string, number>(idRows.map((row) => [row.id, row.createdAt.getTime()]));

    /**
     * 金额相同时用「注册时间倒序」兜底：排序必须是**全序**，
     * 否则 `skip/take` 分页在同一金额的大批用户上会出现重复或漏出。
     */
    const sorted = [...ids].sort((a, b) => {
      const diff = (amountOf.get(a) ?? 0) - (amountOf.get(b) ?? 0);
      if (diff !== 0) return order === 'asc' ? diff : -diff;

      return (createdAtOf.get(b) ?? 0) - (createdAtOf.get(a) ?? 0);
    });

    const pageIds = sorted.slice(skip, skip + take);
    const rows = await this.prisma.user.findMany({ where: { id: { in: pageIds } }, select: LIST_USER_SELECT });

    // `in` 查询不保证顺序，回表后按已排好的 id 顺序重排
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const ordered = pageIds.map((id) => rowsById.get(id)).filter((row): row is ListUserRow => row !== undefined);

    return { rows: ordered, total: ids.length };
  }

  /**
   * 把用户行组装成列表条目
   *
   * 计数类字段（订单 / 报告 / 关系 / AI 消息）一律**批量查询后在内存里合并**，
   * 而不是在 `include` 里逐行取关系：Prisma 不支持「带条件的关系计数」，
   * 若退化为逐用户查询会产生 N+1（一页 20 条 = 上百次查询）。
   */
  private async assembleListItems(rows: ListUserRow[]): Promise<AdminUserListItem[]> {
    if (rows.length === 0) return [];

    const userIds = rows.map((row) => row.id);
    const now = new Date();

    const [
      orderStats,
      reportCounts,
      relationshipStats,
      aiMessageCounts,
      phoneMasks,
      banStates,
      pendingDeletions,
      memberships,
    ] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, paidAt: { not: null } },
        _count: { _all: true },
        _sum: { paidAmount: true },
      }),
      this.prisma.aiReport.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, deletedAt: null },
        _count: { _all: true },
      }),
      this.loadRelationshipCounts(userIds),
      this.prisma.aiMessage.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, deletedAt: null },
        _count: { _all: true },
      }),
      this.loadPhoneMasks(userIds),
      this.loadBanStates(userIds),
      this.prisma.userDeletionRequest.findMany({
        where: { userId: { in: userIds }, status: 'PENDING' },
        select: { userId: true },
      }),
      this.prisma.membership.findMany({
        where: { userId: { in: userIds }, status: 'ACTIVE', deletedAt: null, expireAt: { gt: now } },
        orderBy: { expireAt: 'desc' },
        select: { userId: true, expireAt: true, plan: { select: { code: true } } },
      }),
    ]);

    const orderCountOf = new Map<string, number>(orderStats.map((row) => [row.userId, row._count._all]));
    const paidAmountOf = new Map<string, number>(orderStats.map((row) => [row.userId, row._sum.paidAmount ?? 0]));
    const reportCountOf = new Map<string, number>(reportCounts.map((row) => [row.userId, row._count._all]));
    // `ai_messages.user_id` 可为 NULL（注销匿名化时置 NULL），故这里过滤掉空归属的行
    const aiMessageCountOf = new Map<string, number>();
    for (const row of aiMessageCounts) {
      if (row.userId !== null) aiMessageCountOf.set(row.userId, row._count._all);
    }
    // 会员按 expireAt 倒序取首条 = 到期最晚的会员（与详情块口径一致）
    const membershipOf = new Map<string, (typeof memberships)[number]>();
    for (const membership of memberships) {
      if (!membershipOf.has(membership.userId)) membershipOf.set(membership.userId, membership);
    }
    const pendingDeletionSet = new Set(pendingDeletions.map((row) => row.userId));

    return rows.map((row) => {
      const hasDeletionRequest = pendingDeletionSet.has(row.id);
      const status = this.displayStatus(row, hasDeletionRequest);
      const membership = membershipOf.get(row.id);
      const profile = row.profiles[0] ?? null;
      const banState = banStates.get(row.id) ?? null;

      return {
        userId: row.id,
        nickname: row.nickname,
        avatarUrl: row.avatarUrl,
        gender: row.gender,
        ageRange: toAgeRange(row.birthday),
        status,
        phoneBound: row.phoneHash !== null,
        phoneMasked: phoneMasks.get(row.id) ?? null,
        openidHash: this.hashOpenid(row.wechatAccounts[0]?.openid ?? null),
        mbtiType: profile?.mbtiType ?? null,
        profileVersion: profile?.version ?? null,
        isMember: membership !== undefined,
        membershipPlan: membership?.plan.code ?? null,
        membershipExpiresAt: membership ? membership.expireAt.toISOString() : null,
        orderCount: orderCountOf.get(row.id) ?? 0,
        totalPaidAmount: paidAmountOf.get(row.id) ?? 0,
        reportCount: reportCountOf.get(row.id) ?? 0,
        relationshipCount: relationshipStats.get(row.id) ?? 0,
        aiMessageCount: aiMessageCountOf.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(),
        lastActiveAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
        isBanned: row.status === 'DISABLED',
        // 只有当前处于封禁态才回填原因；已解封的历史封禁对运营是噪声
        bannedReason: row.status === 'DISABLED' ? (banState?.reason ?? null) : null,
        hasDeletionRequest,
        riskFlags: [],
      };
    });
  }

  /** 批量统计「生效中」的关系数（`relationships` 以 userA/userB 两侧存列，故分两次查后合并） */
  private async loadRelationshipCounts(userIds: string[]): Promise<Map<string, number>> {
    const [asUserA, asUserB] = await Promise.all([
      this.prisma.relationship.groupBy({
        by: ['userAId'],
        where: { userAId: { in: userIds }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.relationship.groupBy({
        by: ['userBId'],
        where: { userBId: { in: userIds }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
    ]);

    const counts = new Map<string, number>();
    for (const row of asUserA) counts.set(row.userAId, (counts.get(row.userAId) ?? 0) + row._count._all);
    for (const row of asUserB) counts.set(row.userBId, (counts.get(row.userBId) ?? 0) + row._count._all);

    return counts;
  }

  /**
   * 批量取脱敏手机号
   *
   * 优先用 `user_phone_history.phone_masked`（该表就是为人工审计保留的脱敏值），
   * 只有历史表缺失（老数据）时才回退到「解密 → 就地脱敏」：
   * 明文只在 `maskPhone()` 的调用点短暂存在，绝不进入返回值之外的任何位置。
   */
  private async loadPhoneMasks(userIds: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.userPhoneHistory.findMany({
      where: { userId: { in: userIds }, replacedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { userId: true, phoneMasked: true },
    });

    const masks = new Map<string, string>();
    for (const row of rows) {
      if (!masks.has(row.userId)) masks.set(row.userId, row.phoneMasked);
    }

    return masks;
  }

  /** 展示态计算（映射理由见文件头说明 1） */
  private displayStatus(
    user: { status: string; deletedAt: Date | null; anonymizedAt: Date | null },
    hasPendingDeletion: boolean,
  ): AdminUserDisplayStatus {
    if (user.status === 'DELETED' || user.deletedAt !== null || user.anonymizedAt !== null) return 'DELETED';
    if (user.status === 'DISABLED') return 'BANNED';
    if (hasPendingDeletion) return 'PENDING_DELETION';

    return 'ACTIVE';
  }

  /** 契约 §3.14.2.1 规则 2：只返回 openid 的哈希，原文不出库 */
  private hashOpenid(openid: string | null): string | null {
    return openid === null ? null : this.crypto.sha256(openid);
  }

  /**
   * 顶部统计概览（契约 §3.14.2.1 `data.summary`）
   *
   * 全库口径（不受筛选条件影响），且各项独立计数：
   * 契约示例里 `activeUsers + bannedUsers + pendingDeletionUsers = totalUsers`，
   * 用独立条件分别计数能自然满足该关系，且避免「先算总数再作减法」在边界数据上算出负数。
   */
  private async loadSummary(): Promise<AdminUserListSummary> {
    const now = new Date();
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const notDeleted: Prisma.UserWhereInput = { status: { not: 'DELETED' }, deletedAt: null, anonymizedAt: null };

    const [totalUsers, activeUsers, bannedUsers, memberUsers, pendingDeletionUsers, newUsersToday] = await Promise.all([
      this.prisma.user.count({ where: notDeleted }),
      this.prisma.user.count({
        where: { ...notDeleted, status: 'ACTIVE', deletionRequests: { none: { status: 'PENDING' } } },
      }),
      this.prisma.user.count({ where: { status: 'DISABLED' } }),
      this.prisma.user.count({
        where: { memberships: { some: { status: 'ACTIVE', deletedAt: null, expireAt: { gt: now } } } },
      }),
      this.prisma.user.count({ where: { ...notDeleted, deletionRequests: { some: { status: 'PENDING' } } } }),
      this.prisma.user.count({ where: { createdAt: { gte: startOfToday }, deletedAt: null } }),
    ]);

    return { totalUsers, activeUsers, bannedUsers, memberUsers, pendingDeletionUsers, newUsersToday };
  }

  // ==========================================================================
  // GET /admin/users/{id}
  // ==========================================================================

  /**
   * 用户 360 视图（契约 §3.14.2.2）
   *
   * 隐私底线（契约规则 1、2）：
   *   · AI 用量只给**计量数字**，不提供任何读取对话原文的能力（连查询都不做）
   *   · 手机号只给脱敏值，没有任何接口路径可以拿到明文（含超级管理员）
   */
  async getUserDetail(
    userId: string,
    includeRaw: string | undefined,
    operator: AdminOperatorContext,
  ): Promise<AdminUserDetailView> {
    this.assertUserId(userId);

    const include = this.parseInclude(includeRaw);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        avatarUrl: true,
        gender: true,
        birthday: true,
        status: true,
        ageVerified: true,
        phoneEnc: true,
        phoneHash: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        deletedAt: true,
        anonymizedAt: true,
        wechatAccounts: {
          where: { deletedAt: null },
          take: 1,
          select: { openid: true, unionid: true, createdAt: true, updatedAt: true },
        },
      },
    });

    // 契约 §3.14.2.2 错误码：用户不存在或已完全匿名化 → 404。
    // 用 30000（USER_NOT_FOUND，语义完全吻合）承接契约里的 30001（本项目 30001 是「资料未完善」）
    if (!user || user.status === 'DELETED' || user.deletedAt !== null || user.anonymizedAt !== null) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    const pendingDeletion = await this.prisma.userDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
      select: { id: true },
    });
    const hasPendingDeletion = pendingDeletion !== null;

    const account = user.wechatAccounts[0] ?? null;
    const phoneMask = await this.loadSinglePhoneMask(userId, user.phoneEnc, user.phoneHash);

    const view: AdminUserDetailView = {
      user: {
        userId: user.id,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        gender: user.gender,
        birthday: user.birthday ? user.birthday.toISOString().slice(0, 10) : null,
        ageRange: toAgeRange(user.birthday),
        statusMessage: null,
        status: this.displayStatus(user, hasPendingDeletion),
        ageVerified: user.ageVerified,
        phoneBound: user.phoneHash !== null,
        phoneMasked: phoneMask,
        openidHash: this.hashOpenid(account?.openid ?? null),
        unionidHash: account?.unionid ? this.crypto.sha256(account.unionid) : null,
        wechatAccountCreatedAt: account ? account.createdAt.toISOString() : null,
        sessionKeyUpdatedAt: account ? account.updatedAt.toISOString() : null,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        lastActiveAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
        // 已注销（含软删/匿名化）的账号在上面的守卫里已被拒绝，走到这里 deletedAt 必为 null
        deletedAt: null,
        riskFlags: [],
      },
      profile: await this.loadProfile(userId),
      serverTime: new Date().toISOString(),
    };

    const tasks: Array<Promise<void>> = [];

    if (include.orders) tasks.push(this.loadOrders(userId).then((block) => void (view.orders = block)));
    if (include.membership) tasks.push(this.loadMembership(userId).then((block) => void (view.membership = block)));
    if (include.reports) tasks.push(this.loadReports(userId).then((block) => void (view.reports = block)));
    if (include.relationships) {
      tasks.push(this.loadRelationships(userId).then((block) => void (view.relationships = block)));
    }
    if (include.aiUsage) tasks.push(this.loadAiUsage(userId).then((block) => void (view.aiUsage = block)));
    if (include.consents) tasks.push(this.loadConsents(userId).then((block) => void (view.consents = block)));
    if (include.deletion) tasks.push(this.loadDeletion(userId).then((block) => void (view.deletion = block)));
    if (include.audit) tasks.push(this.loadAuditTrail(userId).then((block) => void (view.auditTrail = block)));
    if (include.testSessions) {
      tasks.push(this.loadTestSessions(userId).then((block) => void (view.testSessions = block)));
    }

    await Promise.all(tasks);

    // 契约规则 3：查看用户详情属于敏感数据访问，必须记录操作人与查询范围
    const resolvedOperator = await this.resolveOperator(operator.adminUserId);
    await this.writeAudit({
      adminUserId: resolvedOperator.adminId,
      adminUsername: resolvedOperator.username,
      action: AUDIT_ACTION_READ,
      resourceType: RESOURCE_TYPE_USER,
      resourceId: userId,
      targetUserId: userId,
      diffSummary: `[${PERMISSION_USER_READ}] 查看用户详情（include=${this.activeIncludeNames(include).join(',')}）`,
      reason: null,
      ip: operator.ip ?? null,
      userAgent: operator.userAgent ?? null,
      requestId: operator.requestId ?? null,
    });

    return view;
  }

  /** 单用户脱敏手机号（列表用批量版 `loadPhoneMasks`，详情只有一行） */
  private async loadSinglePhoneMask(
    userId: string,
    phoneEnc: string | null,
    phoneHash: string | null,
  ): Promise<string | null> {
    if (phoneHash === null) return null;

    const history = await this.prisma.userPhoneHistory.findFirst({
      where: { userId, replacedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { phoneMasked: true },
    });

    if (history) return history.phoneMasked;

    // 兜底：历史表缺失时解密后就地脱敏（明文只存在于本行调用栈内）
    return maskPhone(this.crypto.tryDecrypt(phoneEnc));
  }

  /** 画像块：只取 `isCurrent` 的最新一条（契约示例展示的就是「最新画像」） */
  private async loadProfile(userId: string): Promise<AdminUserProfileBlock | null> {
    const profile = await this.prisma.personalityProfile.findFirst({
      where: { userId, isCurrent: true, deletedAt: null },
      select: {
        id: true,
        version: true,
        mbtiType: true,
        mbtiConfidence: true,
        engineVersion: true,
        openness: true,
        conscientiousness: true,
        extraversion: true,
        agreeableness: true,
        neuroticism: true,
        attachmentStyle: true,
        computedAt: true,
      },
    });

    if (!profile) return null;

    return {
      profileId: profile.id,
      version: profile.version,
      mbtiType: profile.mbtiType,
      confidence: profile.mbtiConfidence,
      engineVersion: profile.engineVersion,
      bigFive: {
        openness: profile.openness,
        conscientiousness: profile.conscientiousness,
        extraversion: profile.extraversion,
        agreeableness: profile.agreeableness,
        neuroticism: profile.neuroticism,
      },
      attachment: profile.attachmentStyle,
      generatedAt: profile.computedAt.toISOString(),
    };
  }

  /** 会员块：`historyCount` 是历史会员段数（申诉复盘要看「买过几次」） */
  private async loadMembership(userId: string): Promise<AdminUserMembershipBlock> {
    const now = new Date();

    const [current, historyCount] = await Promise.all([
      this.prisma.membership.findFirst({
        where: { userId, status: 'ACTIVE', deletedAt: null, expireAt: { gt: now } },
        orderBy: { expireAt: 'desc' },
        select: {
          startAt: true,
          expireAt: true,
          plan: { select: { code: true } },
          order: { select: { orderNo: true } },
        },
      }),
      this.prisma.membership.count({ where: { userId } }),
    ]);

    return {
      isActive: current !== null,
      planCode: current?.plan.code ?? null,
      startedAt: current ? current.startAt.toISOString() : null,
      expiresAt: current ? current.expireAt.toISOString() : null,
      sourceOrderNo: current?.order?.orderNo ?? null,
      historyCount,
    };
  }

  /**
   * 订单块
   *
   * 只统计**已支付**订单（`paidAt` 非空）：未支付订单不属于用户的消费事实，
   * 混进来会让客服对不上账。`totalPaidAmount` 为累计支付原额（不扣退款），
   * 退款额单独用 `refundedAmount` 表达 —— 两者混在一起会让「退了多少钱」无法追溯。
   */
  private async loadOrders(userId: string): Promise<AdminUserOrdersBlock> {
    const paidFilter: Prisma.OrderWhereInput = { userId, paidAt: { not: null } };

    const [rows, totalCount, paidAgg, refundedAgg] = await Promise.all([
      this.prisma.order.findMany({
        where: paidFilter,
        orderBy: { paidAt: 'desc' },
        take: DETAIL_LIST_TAKE,
        select: {
          id: true,
          orderNo: true,
          productSnapshot: true,
          paidAmount: true,
          status: true,
          paidAt: true,
        },
      }),
      this.prisma.order.count({ where: paidFilter }),
      this.prisma.order.aggregate({ where: paidFilter, _sum: { paidAmount: true } }),
      this.prisma.order.aggregate({ where: { userId }, _sum: { refundedAmount: true } }),
    ]);

    return {
      items: rows.map((row) => ({
        orderId: row.id,
        orderNo: row.orderNo,
        productName: this.readSnapshotName(row.productSnapshot),
        amount: row.paidAmount,
        status: row.status,
        paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      })),
      totalCount,
      totalPaidAmount: paidAgg._sum.paidAmount ?? 0,
      refundedAmount: refundedAgg._sum.refundedAmount ?? 0,
    };
  }

  /**
   * 报告块
   *
   * `wordCount` 用 `content_length`（报告正文字符数）表示：schema 没有「词数」列，
   * 中文场景下「字数」才是运营理解的量级（契约字段名为 wordCount，此处取等价度量）。
   * `isUnlocked` 取决于是否存在报告解锁权益，**不受退款影响**（`CONSUMED` 仍视为已解锁）。
   */
  private async loadReports(userId: string): Promise<AdminUserReportsBlock> {
    const [rows, totalCount] = await Promise.all([
      this.prisma.aiReport.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: DETAIL_LIST_TAKE,
        select: {
          id: true,
          type: true,
          status: true,
          contentLength: true,
          generationFinishedAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.aiReport.count({ where: { userId, deletedAt: null } }),
    ]);

    const reportIds = rows.map((row) => row.id);
    const unlocks =
      reportIds.length === 0
        ? []
        : await this.prisma.entitlement.findMany({
            where: {
              userId,
              type: 'REPORT_UNLOCK',
              status: { in: ['ACTIVE', 'CONSUMED'] },
              reportId: { in: reportIds },
            },
            select: { reportId: true },
          });
    const unlockedIds = new Set(unlocks.map((row) => row.reportId));

    return {
      items: rows.map((row) => ({
        reportId: row.id,
        type: row.type,
        status: row.status,
        wordCount: row.contentLength,
        isUnlocked: unlockedIds.has(row.id),
        generatedAt: (row.generationFinishedAt ?? row.updatedAt).toISOString(),
      })),
      totalCount,
    };
  }

  /** 关系块：只列生效中的关系（已解除/被拒的历史关系对客服排查无意义） */
  private async loadRelationships(userId: string): Promise<AdminUserRelationshipsBlock> {
    const where: Prisma.RelationshipWhereInput = {
      status: 'ACTIVE',
      OR: [{ userAId: userId }, { userBId: userId }],
    };

    const [rows, totalCount] = await Promise.all([
      this.prisma.relationship.findMany({
        where,
        orderBy: { confirmedAt: 'desc' },
        take: DETAIL_LIST_TAKE,
        select: {
          id: true,
          type: true,
          status: true,
          userAId: true,
          userBId: true,
          confirmedAt: true,
          userA: { select: { id: true, nickname: true } },
          userB: { select: { id: true, nickname: true } },
        },
      }),
      this.prisma.relationship.count({ where }),
    ]);

    return {
      items: rows.map((row) => {
        const partner = row.userAId === userId ? row.userB : row.userA;

        return {
          relationshipId: row.id,
          relationType: row.type,
          status: row.status,
          partnerUserId: partner.id,
          partnerNickname: partner.nickname,
          activatedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
        };
      }),
      totalCount,
    };
  }

  /**
   * AI 用量块（契约规则 1：只有计量数据）
   *
   * ⚠ 契约没有说明 `todayMessages` 的「今天」以哪个时区切分。这里统一用 **UTC 自然日**：
   *   全库时间列都是 `timestamptz`，用 UTC 才能保证统计口径与数据库索引一致；
   *   若运营需要北京时间，应在看板层做时区偏移，而不是让接口层各处自行切分。
   */
  private async loadAiUsage(userId: string): Promise<AdminUserAiUsageBlock> {
    const now = new Date();
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const [all, today, conversationCount, safetyBlockedCount, lastMessage] = await Promise.all([
      this.prisma.aiMessage.aggregate({
        where: { userId, deletedAt: null },
        _count: { _all: true },
        _sum: { totalTokens: true, costAmount: true },
      }),
      this.prisma.aiMessage.aggregate({
        where: { userId, deletedAt: null, createdAt: { gte: startOfToday } },
        _count: { _all: true },
        _sum: { totalTokens: true },
      }),
      this.prisma.aiConversation.count({ where: { userId, deletedAt: null } }),
      this.prisma.aiMessage.count({ where: { userId, deletedAt: null, safetyStatus: 'BLOCKED' } }),
      this.prisma.aiMessage.findFirst({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    return {
      totalMessages: all._count._all,
      totalTokens: all._sum.totalTokens ?? 0,
      totalCostCents: all._sum.costAmount ?? 0,
      todayMessages: today._count._all,
      todayTokens: today._sum.totalTokens ?? 0,
      conversationCount,
      safetyBlockedCount,
      lastMessageAt: lastMessage ? lastMessage.createdAt.toISOString() : null,
    };
  }

  /**
   * 同意记录块
   *
   * 返回**固定 5 类**（即使某类从未同意也出现，`agreed: false`）：
   * 客服需要回答「用户到底同意过哪些协议」，缺失项与「未同意」是两种不同的合规事实，
   * 若只返回存在的记录，前端无法区分「没同意过」和「这版协议还没上线」。
   */
  private async loadConsents(userId: string): Promise<AdminUserConsentEntry[]> {
    const records = await this.prisma.userConsent.findMany({
      where: { userId },
      orderBy: { agreedAt: 'desc' },
      select: { type: true, policyVersion: true, agreed: true, agreedAt: true, revokedAt: true, channel: true },
    });

    // 同一类型可能有多条（版本迭代），按 agreedAt 倒序取最新一条
    const latestByType = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      if (!latestByType.has(record.type)) latestByType.set(record.type, record);
    }

    return CONSENT_TYPES.map((type) => {
      const record = latestByType.get(type);
      const agreed = record !== undefined && record.agreed && record.revokedAt === null;

      return {
        type,
        version: record ? record.policyVersion : null,
        agreed,
        agreedAt: record && agreed ? record.agreedAt.toISOString() : null,
        channel: record ? record.channel : null,
      };
    });
  }

  /** 注销申请块：取最近一条申请（含已完成/已撤销，便于说明「为什么后来又没注销」） */
  private async loadDeletion(userId: string): Promise<AdminUserDeletionBlock> {
    const request = await this.prisma.userDeletionRequest.findFirst({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      select: { id: true, status: true, requestedAt: true, scheduledAt: true },
    });

    if (!request) {
      return { hasRequest: false, requestId: null, status: null, requestedAt: null, scheduledAt: null };
    }

    return {
      hasRequest: request.status === 'PENDING',
      requestId: request.id,
      status: request.status,
      requestedAt: request.requestedAt.toISOString(),
      scheduledAt: request.scheduledAt.toISOString(),
    };
  }

  /**
   * 后台操作轨迹
   *
   * 同时按 `targetUserId` 与 `resourceId` 命中：前者是本模块写入的（用户域操作），
   * 后者覆盖「以用户 ID 作为资源 ID」的其他管理端操作（如注销申请处理），
   * 保证 360 视图能看到跨模块对该用户做过的所有后台动作。
   */
  private async loadAuditTrail(userId: string): Promise<AdminUserAuditTrailEntry[]> {
    const rows = await this.prisma.adminAuditLog.findMany({
      where: { OR: [{ targetUserId: userId }, { resourceId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: AUDIT_TRAIL_TAKE,
      select: {
        createdAt: true,
        action: true,
        adminUserId: true,
        adminUsername: true,
        diffSummary: true,
        reason: true,
      },
    });

    return rows.map((row) => ({
      at: row.createdAt.toISOString(),
      // ⚠ 存储的是 PG 枚举值（EXPORT/UPDATE/...），不是契约示例里的 `user:user:read`，
      //   原因见文件头说明 5；真实动作名在 detail 里以 `[user:user:read]` 前缀保留
      action: row.action,
      operatorAdminId: row.adminUserId,
      operatorName: row.adminUsername,
      detail: row.diffSummary ?? row.reason,
    }));
  }

  /** 测试会话块（契约未给示例，字段取排查所需的最小集，见类型注释） */
  private async loadTestSessions(userId: string): Promise<AdminUserTestSessionsBlock> {
    const where: Prisma.TestSessionWhereInput = { userId, deletedAt: null };

    const [rows, totalCount] = await Promise.all([
      this.prisma.testSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: DETAIL_LIST_TAKE,
        select: {
          id: true,
          testDefinitionId: true,
          definitionCode: true,
          status: true,
          startedAt: true,
          submittedAt: true,
        },
      }),
      this.prisma.testSession.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        sessionId: row.id,
        testDefinitionId: row.testDefinitionId,
        definitionCode: row.definitionCode,
        status: row.status,
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      })),
      totalCount,
    };
  }

  // ==========================================================================
  // POST /admin/users/{id}/ban
  // ==========================================================================

  /**
   * 封禁用户（契约 §3.14.2.3）
   *
   * 幂等语义（契约「已封禁再封禁返回当前状态，不报错」）：
   *   · 已封禁 → 不改状态、不再撤销会话、不重复发通知，只补一条「幂等命中」审计，
   *     并返回**当前**封禁事实（优先取审计里的原始封禁参数，而不是本次请求体，
   *     否则会让人误以为封禁被改成了新原因）
   *   · 未封禁 → 改状态 + 撤销会话 + 通知 + 写审计（含 before/after）
   *
   * 权益处理（契约规则 3）：封禁**不没收**已购权益与订单 —— 因此本方法不触碰
   * `memberships` / `entitlements` / `orders`，只改 `users.status`。
   * 会话撤销（契约规则 2）：撤销全部 RT，并把会话 jti 加入 AT 黑名单（AT 与 RT 共用 jti）。
   */
  async banUser(userId: string, dto: BanUserDto, operator: AdminOperatorContext): Promise<BanUserView> {
    this.assertUserId(userId);

    const reason = this.requireBanReason(dto);
    const reasonDetail = this.resolveBanReasonDetail(reason, dto.reasonDetail);
    const durationDays = dto.durationDays ?? null;
    const isPermanent = durationDays === null;
    const notifyUser = dto.notifyUser ?? true;
    const revokeSessions = dto.revokeSessions ?? true;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        status: true,
        deletedAt: true,
        anonymizedAt: true,
        deletionRequests: { where: { status: 'PENDING' }, select: { id: true } },
      },
    });

    if (!user) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    /**
     * 已注销（匿名化完成）的账号无法封禁：记录已被匿名化，封禁它没有任何实际效果，
     * 只会在审计里留下误导性的「已封禁一个不存在的用户」。
     * 契约的封禁错误码表未覆盖该情形，这里用语义最接近的既有码 30014
     * （DELETION_ALREADY_COMPLETED，409）承接。
     */
    if (user.status === 'DELETED' || user.deletedAt !== null || user.anonymizedAt !== null) {
      throw BusinessException.conflict(ErrorCode.DELETION_ALREADY_COMPLETED, '用户已注销完成，无法封禁');
    }

    const resolvedOperator = await this.resolveOperator(operator.adminUserId);
    const hasPendingDeletion = user.deletionRequests.length > 0;
    const previousStatus = this.displayStatus(user, hasPendingDeletion);
    const bannedBy: AdminOperatorBrief = {
      adminId: resolvedOperator.adminId,
      displayName: resolvedOperator.displayName,
    };

    // ------------------------------------------------------------ 幂等分支
    if (user.status === 'DISABLED') {
      const existing = await this.findLatestBanState(userId);
      const auditLogId = await this.writeAudit(
        {
          adminUserId: resolvedOperator.adminId,
          adminUsername: resolvedOperator.username,
          action: AUDIT_ACTION_WRITE,
          resourceType: RESOURCE_TYPE_USER,
          resourceId: userId,
          targetUserId: userId,
          beforeData: { status: 'BANNED' },
          afterData: { status: 'BANNED', reason: existing?.reason ?? reason, idempotent: true },
          diffSummary: `[${PERMISSION_USER_WRITE}] 幂等命中：用户已处于封禁状态，本次未重复执行`,
          reason: existing?.reason ?? reason,
          ip: operator.ip ?? null,
          userAgent: operator.userAgent ?? null,
          requestId: operator.requestId ?? null,
        },
        true,
      );

      this.logger.log(`封禁幂等命中 userId=${userId} adminUserId=${resolvedOperator.adminId}`);

      return {
        userId: user.id,
        nickname: user.nickname,
        previousStatus: 'BANNED',
        status: 'BANNED',
        banType: existing?.banType ?? (isPermanent ? 'PERMANENT' : 'TEMPORARY'),
        reason: existing?.reason ?? reason,
        reasonDetail: existing?.reasonDetail ?? reasonDetail,
        bannedAt: (existing?.bannedAt ?? new Date()).toISOString(),
        bannedBy,
        expiresAt: existing
          ? existing.expiresAt
            ? existing.expiresAt.toISOString()
            : null
          : this.expiresAtOf(durationDays),
        isPermanent: existing ? existing.banType === 'PERMANENT' : isPermanent,
        revokedSessions: 0,
        notifiedUser: false,
        auditLogId,
        affectedResources: {
          note: AFFECTED_RESOURCES_NOTE,
          activeMembershipPreserved: true,
          unusedAiCreditsPreserved: true,
        },
      };
    }

    // ------------------------------------------------------------ 执行封禁
    const bannedAt = new Date();
    const expiresAt = durationDays === null ? null : new Date(bannedAt.getTime() + durationDays * 86_400_000);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: 'DISABLED',
        updatedAt: bannedAt,
      },
    });

    const revokedCount = revokeSessions ? await this.revokeUserSessions(userId, REVOKE_REASON_BAN) : 0;

    const notified = notifyUser
      ? await this.createUserNotification({
          userId,
          title: BAN_NOTIFICATION_TITLE,
          content: this.buildBanNotificationContent(reason, reasonDetail, expiresAt),
          pagePath: '/pages/profile/index',
          // 幂等键：同一用户同一时刻的封禁通知只发一次（重试不会重复打扰用户）
          idempotencyKey: `ban:${userId}:${bannedAt.getTime()}`,
          payload: {
            reason,
            banType: isPermanent ? 'PERMANENT' : 'TEMPORARY',
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
          },
        })
      : false;

    const auditLogId = await this.writeAudit(
      {
        adminUserId: resolvedOperator.adminId,
        adminUsername: resolvedOperator.username,
        action: AUDIT_ACTION_WRITE,
        resourceType: RESOURCE_TYPE_USER,
        resourceId: userId,
        targetUserId: userId,
        // 契约规则 5：before/after 必须记录状态与封禁参数
        beforeData: { status: previousStatus },
        afterData: {
          status: 'BANNED',
          [BAN_AUDIT_MARKER]: true,
          reason,
          reasonDetail,
          banType: isPermanent ? 'PERMANENT' : 'TEMPORARY',
          durationDays,
          bannedAt: bannedAt.toISOString(),
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          revokedSessions: revokedCount,
          notifiedUser: notified,
          jti: operator.jti ?? null,
        },
        diffSummary: `[${PERMISSION_USER_WRITE}] 封禁用户（${previousStatus} → BANNED，原因 ${reason}${
          isPermanent ? '，永久' : `，${durationDays} 天`
        }，撤销会话 ${revokedCount} 个）`,
        reason,
        ip: operator.ip ?? null,
        userAgent: operator.userAgent ?? null,
        requestId: operator.requestId ?? null,
      },
      true,
    );

    this.logger.log(
      `封禁用户成功 userId=${userId} adminUserId=${resolvedOperator.adminId} reason=${reason} revokedSessions=${revokedCount}`,
    );

    return {
      userId: user.id,
      nickname: user.nickname,
      previousStatus,
      status: 'BANNED',
      banType: isPermanent ? 'PERMANENT' : 'TEMPORARY',
      reason,
      reasonDetail,
      bannedAt: bannedAt.toISOString(),
      bannedBy,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      isPermanent,
      revokedSessions: revokedCount,
      notifiedUser: notified,
      auditLogId,
      affectedResources: {
        note: AFFECTED_RESOURCES_NOTE,
        // 本方法不触碰权益与订单，故两者恒为「保留」
        activeMembershipPreserved: true,
        unusedAiCreditsPreserved: true,
      },
    };
  }

  // ==========================================================================
  // POST /admin/users/{id}/unban
  // ==========================================================================

  /**
   * 解封用户（契约 §3.14.2.4）
   *
   * 幂等语义（契约「未封禁时返回当前状态，不报错」）：
   *   · 未处于封禁态 → 不改状态、不发通知、不发放补偿（补偿是针对「误判封禁」的救济，
   *     没有封禁事实就不存在救济对象），只写一条「幂等命中」审计并返回当前状态
   *   · 已封禁 → 置回 ACTIVE + 可选补偿 + 通知 + 写审计
   *
   * 契约规则 1：解封**不恢复**已撤销的会话（安全默认：用户重新登录即可，无需额外动作）。
   * 契约规则 4：`previousBan` 完整回填，便于申诉复盘（封禁原因/时刻/到期时间/实际时长）。
   */
  async unbanUser(userId: string, dto: UnbanUserDto, operator: AdminOperatorContext): Promise<UnbanUserView> {
    this.assertUserId(userId);

    const reason = this.requireUnbanReason(dto);
    const notifyUser = dto.notifyUser ?? true;
    const restoreCompensation = dto.restoreCompensation ?? false;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        status: true,
        deletedAt: true,
        anonymizedAt: true,
        deletionRequests: { where: { status: 'PENDING' }, select: { id: true } },
      },
    });

    if (!user) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    // 契约 §3.14.2.4 错误码 30014：已注销（DELETED）无法解封 —— 语义与本项目 30014 完全吻合
    if (user.status === 'DELETED' || user.deletedAt !== null || user.anonymizedAt !== null) {
      throw BusinessException.conflict(ErrorCode.DELETION_ALREADY_COMPLETED, '用户已注销完成，无法解封');
    }

    const resolvedOperator = await this.resolveOperator(operator.adminUserId);
    const hasPendingDeletion = user.deletionRequests.length > 0;
    const previousStatus = this.displayStatus(user, hasPendingDeletion);
    const unbannedBy: AdminOperatorBrief = {
      adminId: resolvedOperator.adminId,
      displayName: resolvedOperator.displayName,
    };
    const previousBanState = await this.findLatestBanState(userId);
    const previousBan = this.toPreviousBanView(previousBanState);

    // ------------------------------------------------------------ 幂等分支
    if (user.status !== 'DISABLED') {
      const auditLogId = await this.writeAudit(
        {
          adminUserId: resolvedOperator.adminId,
          adminUsername: resolvedOperator.username,
          action: AUDIT_ACTION_WRITE,
          resourceType: RESOURCE_TYPE_USER,
          resourceId: userId,
          targetUserId: userId,
          beforeData: { status: previousStatus },
          afterData: { status: previousStatus, idempotent: true },
          diffSummary: `[${PERMISSION_USER_WRITE}] 幂等命中：用户当前未处于封禁状态，本次未执行解封`,
          reason,
          ip: operator.ip ?? null,
          userAgent: operator.userAgent ?? null,
          requestId: operator.requestId ?? null,
        },
        true,
      );

      this.logger.log(`解封幂等命中 userId=${userId} status=${previousStatus}`);

      return {
        userId: user.id,
        nickname: user.nickname,
        previousStatus,
        status: previousStatus,
        unbannedAt: new Date().toISOString(),
        unbannedBy,
        reason,
        previousBan,
        // 没有实际解封就不发补偿（见方法注释）
        compensation: this.emptyCompensation(),
        notifiedUser: false,
        auditLogId,
      };
    }

    // ------------------------------------------------------------ 执行解封
    const unbannedAt = new Date();

    await this.prisma.user.update({
      where: { id: userId },
      data: { status: 'ACTIVE', updatedAt: unbannedAt },
    });

    const compensation = restoreCompensation
      ? await this.grantCompensation(userId, resolvedOperator.adminId)
      : this.emptyCompensation();

    const notified = notifyUser
      ? await this.createUserNotification({
          userId,
          title: UNBAN_NOTIFICATION_TITLE,
          content: compensation.granted
            ? `${UNBAN_COMPENSATION_NOTE}\n解除说明：${reason}`
            : `你的账号使用限制已解除，可以正常使用服务。\n解除说明：${reason}`,
          pagePath: '/pages/profile/index',
          idempotencyKey: `unban:${userId}:${unbannedAt.getTime()}`,
          payload: {
            reason,
            compensationGranted: compensation.granted,
          },
        })
      : false;

    const auditLogId = await this.writeAudit(
      {
        adminUserId: resolvedOperator.adminId,
        adminUsername: resolvedOperator.username,
        action: AUDIT_ACTION_WRITE,
        resourceType: RESOURCE_TYPE_USER,
        resourceId: userId,
        targetUserId: userId,
        // 契约规则 4：保留完整封禁历史（before 里带上一次封禁的全部信息）
        beforeData: {
          status: 'BANNED',
          previousBan: previousBan
            ? {
                reason: previousBan.reason,
                bannedAt: previousBan.bannedAt,
                expiresAt: previousBan.expiresAt,
                durationSeconds: previousBan.durationSeconds,
              }
            : null,
        },
        afterData: {
          status: 'ACTIVE',
          reason,
          unbannedAt: unbannedAt.toISOString(),
          compensationGranted: compensation.granted,
          compensationEntitlementId: compensation.entitlementId,
          notifiedUser: notified,
        },
        diffSummary: `[${PERMISSION_USER_WRITE}] 解封用户（BANNED → ACTIVE，原因：${reason}${
          compensation.granted ? '，已发放补偿权益' : ''
        }）`,
        reason,
        ip: operator.ip ?? null,
        userAgent: operator.userAgent ?? null,
        requestId: operator.requestId ?? null,
      },
      true,
    );

    this.logger.log(
      `解封用户成功 userId=${userId} adminUserId=${resolvedOperator.adminId} 补偿=${compensation.granted}`,
    );

    return {
      userId: user.id,
      nickname: user.nickname,
      previousStatus: 'BANNED',
      status: 'ACTIVE',
      unbannedAt: unbannedAt.toISOString(),
      unbannedBy,
      reason,
      previousBan,
      compensation,
      notifiedUser: notified,
      auditLogId,
    };
  }

  // ==========================================================================
  // 内部：入参校验（专属错误码，见文件头说明 4）
  // ==========================================================================

  /** `id` 非合法 UUID → 契约要求 10003；本项目 10003 是冲突类码，故用 10001（400）承接 */
  private assertUserId(id: string): void {
    if (!UUID_PATTERN.test(id)) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '用户 ID 不是合法的 UUID');
    }
  }

  /** `status` 逗号分隔 → 枚举数组；非法枚举 → 10001（契约 §3.14.2.1） */
  private parseStatuses(raw: string | undefined): AdminUserStatusFilter[] {
    if (raw === undefined || raw.trim() === '') return [];

    const values = raw
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter((item) => item.length > 0);

    for (const value of values) {
      if (!ADMIN_USER_STATUSES.includes(value as AdminUserStatusFilter)) {
        throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, `status 仅支持：${ADMIN_USER_STATUSES.join(', ')}`);
      }
    }

    return [...new Set(values as AdminUserStatusFilter[])];
  }

  /** `mbtiType` 非 16 型 → 10001（契约 §3.14.2.1）；合法值统一大写返回 */
  private normalizeMbtiType(raw: string | undefined): string | undefined {
    if (raw === undefined || raw === '') return undefined;

    const normalized = raw.toUpperCase();
    if (!MBTI_TYPES.includes(normalized as (typeof MBTI_TYPES)[number])) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'mbtiType 必须是 16 型 MBTI 合法值');
    }

    return normalized;
  }

  /** 详情 `include` 白名单（契约 §3.14.2.2）；白名单外 → 10001 */
  private parseInclude(raw: string | undefined): ResolvedInclude {
    const resolved: ResolvedInclude = {
      orders: false,
      membership: false,
      reports: false,
      relationships: false,
      aiUsage: false,
      consents: false,
      deletion: false,
      audit: false,
      testSessions: false,
    };

    const names =
      raw === undefined || raw.trim() === ''
        ? [...DEFAULT_ADMIN_USER_INCLUDES]
        : raw
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0);

    for (const name of names) {
      // 说明：错误码用 10001（契约要求）；`30015 INCLUDE_FIELD_INVALID`（400）语义更贴切，
      // 但它是用户端 GET /users/me 的码，为避免同一参数在不同端返回不同码而统一按管理端契约走
      if (!ADMIN_USER_INCLUDE_BLOCKS.includes(name as AdminUserIncludeBlock)) {
        throw BusinessException.badRequest(
          ErrorCode.PARAM_INVALID,
          `include 仅支持：${ADMIN_USER_INCLUDE_BLOCKS.join(', ')}`,
        );
      }

      resolved[name as AdminUserIncludeBlock] = true;
    }

    return resolved;
  }

  /** 实际生效的 include 块名（写审计摘要用） */
  private activeIncludeNames(include: ResolvedInclude): AdminUserIncludeBlock[] {
    return ADMIN_USER_INCLUDE_BLOCKS.filter((name) => include[name]);
  }

  /** 缺 `reason` → 10002（契约 §3.14.2.3）；本项目 10002 是 RESOURCE_NOT_FOUND，故显式指定 400 */
  private requireBanReason(dto: BanUserDto): BanReason {
    if (dto.reason === undefined) {
      throw BusinessException.badRequest(ErrorCode.RESOURCE_NOT_FOUND, '缺少封禁原因 reason');
    }

    return dto.reason;
  }

  /** `reason = OTHER` 时 `reasonDetail` 必填 → 10002（契约 §3.14.2.3） */
  private resolveBanReasonDetail(reason: BanReason, detail: string | undefined): string | null {
    const trimmed = detail?.trim() ?? '';

    if (reason === 'OTHER' && trimmed.length === 0) {
      throw BusinessException.badRequest(ErrorCode.RESOURCE_NOT_FOUND, 'reason = OTHER 时必须填写 reasonDetail');
    }

    return trimmed.length > 0 ? trimmed : null;
  }

  /** 缺解封原因 → 10002（契约 §3.14.2.4） */
  private requireUnbanReason(dto: UnbanUserDto): string {
    const trimmed = dto.reason?.trim() ?? '';

    if (trimmed.length === 0) {
      throw BusinessException.badRequest(ErrorCode.RESOURCE_NOT_FOUND, '缺少解封原因 reason');
    }

    return trimmed;
  }

  /** 临时封禁的到期时刻（UTC ISO）；永久封禁返回 null */
  private expiresAtOf(durationDays: number | null): string | null {
    if (durationDays === null) return null;
    return new Date(Date.now() + durationDays * 86_400_000).toISOString();
  }

  // ==========================================================================
  // 内部：审计
  // ==========================================================================

  /**
   * 取当前管理员身份（审计必填 `adminUsername`，且冗余存储在审计表里）
   *
   * 取不到时用 `(unknown)` 占位而不抛错：审计是旁路，不应因为「管理员刚被删除」
   * 就让封禁操作失败（与 `AdminAuditService` 的容错原则一致）。
   */
  private async resolveOperator(adminUserId: string): Promise<{
    adminId: string;
    username: string;
    displayName: string;
  }> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminUserId, deletedAt: null },
      select: { id: true, username: true, nickname: true, realName: true },
    });

    return {
      adminId: adminUserId,
      username: admin?.username ?? '(unknown)',
      displayName: admin?.nickname ?? admin?.realName ?? admin?.username ?? '(unknown)',
    };
  }

  /**
   * 写审计，并按需回读本次写入的 id
   *
   * `AdminAuditService.log()` 只返回布尔值，而契约的封禁/解封响应要求带 `auditLogId`，
   * 该服务不在本模块可修改范围内，因此这里在写入后按
   * `(管理员, 目标用户, 资源类型, 动作, 时间下界)` 反查最近一条。
   * 反查条件足以唯一定位本次调用写入的行；最坏情况（同管理员对同一用户在同一时刻
   * 并发执行同一动作）会返回一条**等价**的审计记录 id，不影响审计完整性。
   */
  private async writeAudit(entry: AdminAuditEntry, returnId = false): Promise<string | null> {
    const startedAt = new Date();
    await this.audit.log(entry);

    if (!returnId) return null;

    const row = await this.prisma.adminAuditLog.findFirst({
      where: {
        adminUserId: entry.adminUserId ?? null,
        targetUserId: entry.targetUserId ?? null,
        resourceType: entry.resourceType,
        action: entry.action,
        // 放宽 1 秒以容忍数据库与应用服务器的时钟漂移
        createdAt: { gte: new Date(startedAt.getTime() - 1000) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return row?.id ?? null;
  }

  // ==========================================================================
  // 内部：会话撤销与通知
  // ==========================================================================

  /**
   * 撤销某用户的全部会话（契约 §3.14.2.3 规则 2「复用 3.1.4 逻辑」）
   *
   * 直接调用用户端 `TokenService.revokeAllSessions` —— 契约明确要求「复用 3.1.4 逻辑」，
   * 而 3.1.4 的实现在 `auth` 模块。会话存储的键布局、AT 拉黑、复用标记、
   * `user_sessions` 落库这些细节全部由它负责，本模块不复制其中任何一项
   * （复制会导致 `auth` 调整存储时封禁**静默失效**）。见 ADR-032。
   *
   * 注：`revokeAllSessions` 会把每个会话的 `jti` 同时加入 AccessToken 黑名单，
   * 因此被封禁用户的**活跃 AT 会立刻失效**，而不是等到 2 小时后自然过期 ——
   * 这正是封禁必须立刻生效的关键。
   */
  private async revokeUserSessions(userId: string, reason: string): Promise<number> {
    return this.tokens.revokeAllSessions(userId, reason);
  }

  /**
   * 创建站内通知
   *
   * 通知失败**不影响**封禁结果：封禁已经落库，用户下次请求就会被拦；
   * 因为通知写不进去而抛错，会让管理员误以为封禁没生效并重复操作。
   *
   * ⚠ 契约写的是「站内通知 + 订阅消息（如已授权）」，但本项目订阅消息投递能力
   *   （`NotificationModule`）尚未接入，且订阅消息需要用户级模板授权与 templateId，
   *   因此这里只落**站内通知**（`IN_APP`）；订阅消息留待通知模块统一补齐，
   *   不在此处造一条永远发不出去的 `SUBSCRIPTION_MESSAGE` 脏数据。
   */
  private async createUserNotification(input: {
    userId: string;
    title: string;
    content: string;
    pagePath: string;
    idempotencyKey: string;
    payload: Prisma.InputJsonValue;
  }): Promise<boolean> {
    try {
      await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: 'IN_APP',
          // 站内通知以「行已落库」即视为已投递，故直接置 SENT 并记录时间；
          // 订阅消息类通知才需要 PENDING + 投递 worker
          status: 'SENT',
          sentAt: new Date(),
          title: input.title,
          content: input.content,
          pagePath: input.pagePath,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey,
        },
      });

      return true;
    } catch (error) {
      this.logger.warn(
        `用户通知写入失败（不影响主流程）userId=${input.userId} key=${input.idempotencyKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /** 封禁通知文案（明确原因分类，但不暴露内部风控规则细节，契约规则 4） */
  private buildBanNotificationContent(reason: BanReason, reasonDetail: string | null, expiresAt: Date | null): string {
    const validity = expiresAt ? `限制将于 ${expiresAt.toISOString().slice(0, 10)} 解除。` : '本次限制为永久限制。';
    const detail = reasonDetail ? `\n补充说明：${reasonDetail}` : '';

    return `你的账号因「${BAN_REASON_LABELS[reason]}」被限制使用。${validity}${detail}\n如对处理结果有异议，可通过客服申诉。`;
  }

  // ==========================================================================
  // 内部：封禁状态读取（见文件头说明 2）
  // ==========================================================================

  /** 最近一次封禁的原始参数（从审计 afterData 反解；无封禁历史返回 null） */
  private async findLatestBanState(userId: string): Promise<StoredBanState | null> {
    const rows = await this.prisma.adminAuditLog.findMany({
      where: { targetUserId: userId, resourceType: RESOURCE_TYPE_USER, action: AUDIT_ACTION_WRITE },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { afterData: true },
    });

    for (const row of rows) {
      const state = this.parseBanState(row.afterData);
      if (state) return state;
    }

    return null;
  }

  /** 批量版（列表用，避免 N+1） */
  private async loadBanStates(userIds: string[]): Promise<Map<string, StoredBanState>> {
    const rows = await this.prisma.adminAuditLog.findMany({
      where: { targetUserId: { in: userIds }, resourceType: RESOURCE_TYPE_USER, action: AUDIT_ACTION_WRITE },
      orderBy: { createdAt: 'desc' },
      select: { targetUserId: true, afterData: true },
    });

    const states = new Map<string, StoredBanState>();

    for (const row of rows) {
      if (row.targetUserId === null || states.has(row.targetUserId)) continue;

      const state = this.parseBanState(row.afterData);
      if (state) states.set(row.targetUserId, state);
    }

    return states;
  }

  /**
   * 从审计 afterData 解析封禁参数
   *
   * 只有带 `ban: true` 的 UPDATE 审计才是封禁记录：解封审计的 afterData 里没有该标记，
   * 因此「解封后仍能读到上一次封禁」正是靠这个标记区分（契约规则 4 需要 previousBan）。
   */
  private parseBanState(afterData: Prisma.JsonValue | null): StoredBanState | null {
    const record = this.asRecord(afterData);
    if (record === null || record[BAN_AUDIT_MARKER] !== true) return null;

    const bannedAt = this.toDate(record['bannedAt']);
    if (bannedAt === null) return null;

    const expiresAt = this.toDate(record['expiresAt']);
    const reason = typeof record['reason'] === 'string' ? record['reason'] : 'OTHER';

    return {
      reason,
      reasonDetail: typeof record['reasonDetail'] === 'string' ? record['reasonDetail'] : null,
      banType: record['banType'] === 'PERMANENT' ? 'PERMANENT' : 'TEMPORARY',
      bannedAt,
      expiresAt,
    };
  }

  /** 封禁快照 → 响应里的 previousBan（含实际时长；永久封禁时长为 null） */
  private toPreviousBanView(state: StoredBanState | null): AdminPreviousBanView | null {
    if (!state) return null;

    return {
      reason: state.reason,
      bannedAt: state.bannedAt.toISOString(),
      expiresAt: state.expiresAt ? state.expiresAt.toISOString() : null,
      durationSeconds:
        state.expiresAt === null ? null : Math.round((state.expiresAt.getTime() - state.bannedAt.getTime()) / 1000),
    };
  }

  // ==========================================================================
  // 内部：补偿权益（契约 §3.14.2.4 规则 2）
  // ==========================================================================

  /**
   * 发放误判补偿
   *
   * 优先级（契约「会员延期优先」）：
   *   1. 存在生效中的会员 → 直接在原到期时间上加 7 天，并同步落一条 `MEMBERSHIP_ACTIVE` 权益
   *      （权益是解锁判定的唯一依据，只改会员不写权益会出现「会员显示到 3 月但权益 2 月就过期」）
   *   2. 没有生效中的会员 → 改发等值 AI 次数权益（`AI_CREDITS`）
   *      这里刻意**不新建会员**：`memberships.plan_id` 非空，凭空挑一个套餐等于替运营做定价决策
   */
  private async grantCompensation(userId: string, adminUserId: string): Promise<AdminCompensationView> {
    const now = new Date();
    const membership = await this.prisma.membership.findFirst({
      where: { userId, status: 'ACTIVE', deletedAt: null, expireAt: { gt: now } },
      orderBy: { expireAt: 'desc' },
      select: { id: true, expireAt: true },
    });

    if (membership) {
      const expiresAt = new Date(membership.expireAt.getTime() + COMPENSATION_MEMBERSHIP_DAYS * 86_400_000);

      const entitlement = await this.prisma.$transaction(async (tx) => {
        await tx.membership.update({
          where: { id: membership.id },
          data: { expireAt: expiresAt },
        });

        // 权益同步延期：延长既有权益而不新建了一条重复权益（同一会员段对应一条权益）
        const existing = await tx.entitlement.findFirst({
          where: {
            userId,
            type: 'MEMBERSHIP_ACTIVE',
            membershipId: membership.id,
            status: { in: ['ACTIVE', 'EXPIRED'] },
          },
          orderBy: { expireAt: 'desc' },
          select: { id: true },
        });

        if (existing) {
          return tx.entitlement.update({
            where: { id: existing.id },
            data: { expireAt: expiresAt, status: 'ACTIVE', revokedAt: null },
            select: { id: true },
          });
        }

        return tx.entitlement.create({
          data: {
            userId,
            type: 'MEMBERSHIP_ACTIVE',
            status: 'ACTIVE',
            membershipId: membership.id,
            startAt: now,
            expireAt: expiresAt,
            grantedByAdminId: adminUserId,
            idempotencyKey: `compensation:membership:${userId}:${now.getTime()}`,
          },
          select: { id: true },
        });
      });

      await this.auditGrant(userId, adminUserId, entitlement.id, {
        type: 'MEMBERSHIP_ACTIVE',
        durationDays: COMPENSATION_MEMBERSHIP_DAYS,
        expiresAt: expiresAt.toISOString(),
      });

      return {
        granted: true,
        entitlementId: entitlement.id,
        type: 'MEMBERSHIP_ACTIVE',
        durationDays: COMPENSATION_MEMBERSHIP_DAYS,
        expiresAt: expiresAt.toISOString(),
        note: `误判补偿：${COMPENSATION_MEMBERSHIP_DAYS} 天会员延期`,
      };
    }

    const expiresAt = new Date(now.getTime() + COMPENSATION_AI_CREDITS_VALID_DAYS * 86_400_000);

    const entitlement = await this.prisma.entitlement.create({
      data: {
        userId,
        type: 'AI_CREDITS',
        status: 'ACTIVE',
        totalQuota: COMPENSATION_AI_CREDITS,
        usedQuota: 0,
        remainingQuota: COMPENSATION_AI_CREDITS,
        startAt: now,
        expireAt: expiresAt,
        grantedByAdminId: adminUserId,
        idempotencyKey: `compensation:ai-credits:${userId}:${now.getTime()}`,
      },
      select: { id: true },
    });

    await this.auditGrant(userId, adminUserId, entitlement.id, {
      type: 'AI_CREDITS',
      durationDays: COMPENSATION_MEMBERSHIP_DAYS,
      expiresAt: expiresAt.toISOString(),
    });

    return {
      granted: true,
      entitlementId: entitlement.id,
      type: 'AI_CREDITS',
      durationDays: COMPENSATION_MEMBERSHIP_DAYS,
      expiresAt: expiresAt.toISOString(),
      note: `误判补偿：等值 AI 对话次数 ${COMPENSATION_AI_CREDITS} 次（账号当前无生效会员）`,
    };
  }

  /**
   * 补偿属于**资金相关操作**（契约规则 2：必须写审计）
   *
   * 单独记一条 `MANUAL_FULFILL`（手工补发权益）而不是塞进解封那条审计里：
   * 财务对账要能按动作筛出「所有后台补发」，混在 UPDATE 里就筛不出来。
   */
  private async auditGrant(
    userId: string,
    adminUserId: string,
    entitlementId: string,
    detail: { type: string; durationDays: number; expiresAt: string },
  ): Promise<void> {
    const operator = await this.resolveOperator(adminUserId);

    await this.writeAudit({
      adminUserId: operator.adminId,
      adminUsername: operator.username,
      action: AUDIT_ACTION_GRANT,
      resourceType: RESOURCE_TYPE_ENTITLEMENT,
      resourceId: entitlementId,
      targetUserId: userId,
      beforeData: null,
      afterData: {
        type: detail.type,
        durationDays: detail.durationDays,
        expiresAt: detail.expiresAt,
      },
      diffSummary: `[${PERMISSION_USER_WRITE}] 误判封禁补偿：发放 ${detail.type}（${detail.durationDays} 天）`,
      reason: '误判封禁补偿',
    });
  }

  /** 未发放补偿时的空结构（保持响应字段形状稳定，前端无需判空整个对象） */
  private emptyCompensation(): AdminCompensationView {
    return { granted: false, entitlementId: null, type: null, durationDays: 0, expiresAt: null, note: null };
  }

  // ==========================================================================
  // 内部：JsonB / 日期读取工具
  // ==========================================================================

  /** JsonB → 普通对象（非对象、数组、null 一律返回 null，避免后续属性访问抛错） */
  private asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  }

  /** JsonB 里的 ISO 字符串 → Date；非法/缺失返回 null */
  private toDate(value: unknown): Date | null {
    if (typeof value !== 'string') return null;

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /** 从订单商品快照里取商品名（快照结构见 `payment/order.util.ts` 的 `buildProductSnapshot`） */
  private readSnapshotName(snapshot: Prisma.JsonValue | null): string | null {
    const record = this.asRecord(snapshot);
    const name = record?.['name'];

    return typeof name === 'string' && name.length > 0 ? name : null;
  }
}

// ============================================================================
// 内部类型
// ============================================================================

/** 从审计 afterData 反解出的封禁事实 */
interface StoredBanState {
  reason: string;
  reasonDetail: string | null;
  banType: 'TEMPORARY' | 'PERMANENT';
  bannedAt: Date;
  expiresAt: Date | null;
}
