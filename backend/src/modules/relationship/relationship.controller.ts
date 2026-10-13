/**
 * 关系控制器（契约 §3.6）
 *
 * 分层约定（架构 §6.1 P2）：Controller 只做参数校验、调用 Service、返回 DTO。
 *
 * ## 本轮实现的端点（4 个写操作）
 *
 * | 契约     | 方法与路径                                          |
 * | -------- | --------------------------------------------------- |
 * | §3.6.1   | `POST /relationships/invites`                       |
 * | §3.6.2   | `GET  /relationships/invites/{code}`（邀请详情）    |
 * | §3.6.3   | `POST /relationships/invites/{code}/accept`         |
 * | §3.6.6   | `POST /relationships/{id}/confirm`                  |
 * | §3.6.7   | `DELETE /relationships/{id}`                        |
 *
 * 后续轮次又补齐了读端点：`GET /relationships`（§3.6.4）、
 * `GET /relationships/{id}`（§3.6.5）、`POST|GET /relationships/{id}/compatibility`
 * （§3.6.8/§3.6.9）。按**报告 ID** 查的 §3.6.10/§3.6.11 在
 * `compatibility-report.controller.ts`（同一模块、同一 Service）。
 *
 * §3.6.2 的实现要点：**只下发邀请人的公开资料**（昵称/头像/MBTI），
 * 手机号密文、openid、画像明细既不在 DTO 里也**不在查询里**；
 * 自邀与"被我自己接受过"仍返回 200（契约错误码表如此要求），
 * 被他人接受才返回 409 且不透露接受者。
 *
 * ## 响应体与契约的差距（**有意为之，已在 README 记录**）
 *
 * 契约 §3.6.1 的响应含 `inviter`（邀请方昵称/头像/MBTI）、`dailyQuota`、
 * `qrCodeUrl`/`wideQrCodeUrl`、`suggestedTestCode`、`shareText`/`shareTitle`，
 * 本控制器**不下发这些字段**，而不是下发空对象或占位文案：
 *
 *   · `qrCodeUrl` / `wideQrCodeUrl` —— 小程序码生成（`wxacode.getUnlimited`
 *     + OSS 上传）是独立一段工作，尚未实现。Service 已按契约返回 `null`
 *     表示"降级"，前端据此回落到展示短码
 *   · `inviter` / `dailyQuota` —— 需要额外的用户联查与配额计数表，未实现；
 *     下发空对象会让前端 `inviter.nickname` 拿到 `undefined` 并在渲染层炸开，
 *     比"字段不存在"更难排查
 *   · `shareText` / `shareTitle` —— 分享文案属于运营内容，应由服务端配置下发。
 *     在控制器里硬编码会把文案烤进代码，之后改文案必须发版，故暂不下发
 *
 * ## 契约要求、但数据模型无法承载的字段（**判断过后的拒绝，不是遗漏**）
 *
 * `inviteeName`（§3.6.1）、`displayName` / `acceptMessage`（§3.6.3）在契约里
 * 都是真实功能，但 `relationships` 与 `relationship_invites` 两张表**没有任何
 * 列**能存它们。因此这些字段既不在 DTO 里、也不在响应里：
 *
 *   · 若「接收 + 校验 + 丢掉」，前端会拿到 200、以为设置生效，而用户输入的称呼
 *     与留言凭空消失 —— 这是最难排查的一类缺陷（无报错、无日志、数据不在）
 *   · 现在的行为是**明确报错**：未知字段被 `forbidNonWhitelisted` 拦成 400，
 *     接受邀请接口更是一个空 DTO，任何请求体字段都会被拒
 *
 * 补齐需要先改 `DATABASE_DESIGN.md` 并加迁移（属冻结项变更，须先补 ADR），
 * 因此不在本轮静默处理。
 *
 * 已知差距集中在 `README.md` 的「已知差距」清单，避免被误当成已完成。
 */

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../common/decorators';
import {
  AcceptInviteDto,
  ConfirmRelationshipDto,
  CreateInviteDto,
  GenerateCompatibilityBodyDto,
  InviteCodeParamDto,
  ListRelationshipsQueryDto,
  RelationshipIdParamDto,
  RemoveRelationshipQueryDto,
} from './dto/relationship.dto';
import {
  RelationshipService,
  type AcceptedRelationshipView,
  type InviteDetailView,
  type InviteView,
  type RelationshipDetailView,
  type RelationshipListView,
  type RelationshipStateView,
} from './relationship.service';
import {
  CompatibilityService,
  type CompatibilityReportView,
  type CompatibilityRequestView,
} from './compatibility.service';

/**
 * 邀请创建视图（在 Service 视图之上补齐**纯派生**字段）
 *
 * 只加「由已有字段算得、无需新数据源」的字段：`sharePath` 是短码的字符串
 * 拼装，`remainingSeconds` 是时间差。任何需要查库或生成资源的字段都不在这里
 * 伪造 —— 那会让响应看起来比实际能力完整。
 */
export interface InviteCreatedView extends InviteView {
  /** 契约字段名是 `inviteCode`，Service 内部用 `code` */
  readonly inviteCode: string;
  /** 小程序码携带的 scene 参数（即邀请码） */
  readonly qrCodeScene: string;
  /** 小程序分享路径（`onShareAppMessage` 直接使用） */
  readonly sharePath: string;
  readonly remainingSeconds: number;
}

/** 契约 §3.6.1 约定的分享路径模板 */
const buildSharePath = (code: string): string => `pages/match/scan?scene=${code}`;

/** 剩余有效秒数（契约字段；已过期为 0，不返回负数） */
const remainingSecondsOf = (expiresAt: string, now: number): number => {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return 0;

  return Math.max(0, Math.floor((expires - now) / 1000));
};

const toInviteCreatedView = (view: InviteView, now: number): InviteCreatedView => ({
  ...view,
  inviteCode: view.code,
  qrCodeScene: view.code,
  sharePath: buildSharePath(view.code),
  remainingSeconds: remainingSecondsOf(view.expiresAt, now),
});

@ApiTags('关系')
@ApiBearerAuth('user-token')
@Controller('relationships')
export class RelationshipController {
  constructor(
    private readonly relationshipService: RelationshipService,
    private readonly compatibilityService: CompatibilityService,
  ) {}

  @Post('invites')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ global: { limit: 10, ttl: 24 * 60 * 60 * 1000 } })
  @ApiOperation({
    summary: '创建邀请（生成 8 位短码）',
    description: [
      '生成 8 位 Crockford Base32 短码，7 天有效，邀请码**只能用一次**。',
      '',
      '**限流**：10 次/24h（契约 §3.6.1）。同时未使用的邀请数上限 5 个，超出返回 `60007`。',
      '',
      '**建议携带 `X-Idempotency-Key`**：契约将其列为必填，但服务端目前未做幂等去重存储；',
      '重复提交的兜底是上面那条「未使用邀请 ≤ 5」的上限，不会无限创建。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '创建成功，返回短码、有效期与分享路径' })
  @ApiResponse({ status: 400, description: '参数不合法（`10001`）' })
  @ApiResponse({ status: 429, description: '超出每日邀请上限（`10010`）' })
  @ApiResponse({ status: 409, description: '未使用的邀请过多（`60007`）' })
  @ApiResponse({ status: 500, description: '短码连续碰撞 5 次，码空间异常（`90000`）' })
  async createInvite(@CurrentUser('userId') userId: string, @Body() dto: CreateInviteDto): Promise<InviteCreatedView> {
    const view = await this.relationshipService.createInvite({
      userId,
      relationType: dto.relationType,
      ...(dto.message !== undefined ? { message: dto.message } : {}),
      ...(dto.channel !== undefined ? { channel: dto.channel } : {}),
    });

    // 在控制器内取一次时间，保证同一响应里的字段基于同一时刻
    return toInviteCreatedView(view, Date.now());
  }

  @Get('invites/:code')
  @Throttle({ global: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: '邀请详情（扫码进入时展示）',
    description: [
      '**需登录**（契约 §3.6.2）：不是为了拦住游客看内容，而是**避免游客用这个接口',
      '探测邀请码**。登录只静默进行，不强制点头像昵称。',
      '',
      '**只返回邀请人的公开资料**：昵称、头像、MBTI 类型。手机号密文、openid、',
      '画像详情（大五分数）等字段**根本没有进入查询** —— 从源头杜绝泄露，',
      '而不是查出来再删（后者迟早会被某次 select 改动带出去）。',
      '',
      '**自邀仍返回 200**：`canAccept = false` 且 `blockedReason = SELF_INVITE`',
      '（契约错误码表明确如此），前端据此展示「这是你自己的邀请」并隐藏接受按钮。',
      '',
      '**已被我自己接受的邀请也返回 200**，并附 `acceptedRelationshipId`，',
      '前端直接跳关系详情；被**他人**接受则返回 `409`（`60005`），',
      '且不透露接受者是谁 —— 否则这个接口就成了"凭邀请码查他人关系"的入口。',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: '查询成功（含 `inviter` 公开资料、`canAccept` / `blockedReason`、`myStatus`、`flow`）',
  })
  @ApiResponse({ status: 400, description: '邀请码长度不为 8（`10001`）' })
  @ApiResponse({ status: 401, description: '未登录或登录态失效（`20000`/`20001`）' })
  @ApiResponse({ status: 404, description: '邀请码不存在或含非法字符（`60003`）' })
  @ApiResponse({ status: 409, description: '邀请已被他人接受（`60005`）' })
  @ApiResponse({ status: 410, description: '邀请已过期或已被撤销（`60004`）' })
  @ApiResponse({ status: 429, description: '超出限流（30 次/60s，防邀请码暴力枚举）' })
  async getInviteDetail(
    @CurrentUser('userId') userId: string,
    @Param() params: InviteCodeParamDto,
  ): Promise<InviteDetailView> {
    return this.relationshipService.getInviteDetail(userId, params.code);
  }

  @Post('invites/:code/accept')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ global: { limit: 10, ttl: 60 * 60 * 1000 } })
  @ApiOperation({
    summary: '接受邀请（建立关系，待对方确认）',
    description: [
      '校验链：码格式 → 邀请存在 → 非自邀 → 未过期/未撤销 → 对方已有画像 → 事务内建关系并核销邀请。',
      '',
      '**天然幂等**：重复接受同一邀请返回既有关系而非报错（`isDuplicate: true`），',
      '因此不依赖 `X-Idempotency-Key` —— 幂等语义由数据库状态保证，比键去重更可靠。',
      '',
      '接受后状态为 `PENDING_A_CONFIRM`，需**邀请方**确认才转 `ACTIVE`。',
    ].join('\n'),
  })
  @ApiResponse({ status: 201, description: '建立成功（或返回既有关系，幂等命中）' })
  @ApiResponse({ status: 400, description: '码格式非法（`10001`）或自邀（`60006`）' })
  @ApiResponse({ status: 403, description: '对方尚未完成测评（`60009`）' })
  @ApiResponse({ status: 404, description: '邀请不存在（`60003`）' })
  @ApiResponse({ status: 409, description: '邀请已过期/已撤销（`60004`）、已被使用（`60005`）或关系已存在（`60002`）' })
  @ApiResponse({ status: 429, description: '超出接受邀请频率上限（`10010`）' })
  async acceptInvite(
    @CurrentUser('userId') userId: string,
    @Param() params: InviteCodeParamDto,
    @Body() _dto: AcceptInviteDto,
  ): Promise<AcceptedRelationshipView> {
    return this.relationshipService.acceptInvite(userId, params.code);
  }

  @Get()
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '关系列表',
    description: [
      '**不传 `status` 时只返回 `ACTIVE` 与 `PENDING_A_CONFIRM`** —— 这不是"不筛选"，',
      '而是避免已解除的历史记录淹没首屏。要查历史需显式传 `status=REMOVED`。',
      '',
      '`summary` 里的统计是**全部关系**的口径，不随筛选与翻页变化。',
      '',
      '伙伴画像只返回 `mbtiType` / `typeName` / `profileVersion`；大五明细与关系风格',
      '需关系生效且解锁匹配报告后才可见（契约 §3.6.5 的隐私约束）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（`items` + `total` + `hasNext` + `summary`）' })
  @ApiResponse({ status: 400, description: '分页越界（`10005`）、排序字段越界（`10004`）或枚举非法（`10001`）' })
  async listRelationships(
    @CurrentUser('userId') userId: string,
    @Query() query: ListRelationshipsQueryDto,
  ): Promise<RelationshipListView> {
    return this.relationshipService.listRelationships({
      userId,
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.relationType !== undefined ? { relationType: query.relationType } : {}),
      ...(query.sortBy !== undefined ? { sortBy: query.sortBy } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
    });
  }

  @Get(':relationshipId')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '关系详情',
    description: [
      '**非双方一律按「不存在」处理**（`60000`），而不是返回 403 —— 返回 403 等于',
      '告诉攻击者这条 ID 真实存在，可被用来枚举；「不存在」不泄露任何信息。',
      '',
      '`permissions` 由**服务端**计算，前端只按结果渲染；让前端自己判断"我是不是邀请方"',
      '等于把规则复制一份到客户端，两边一旦不一致就会出现按钮点了报错或该有的按钮没有。',
      '',
      '`timeline` 为最近 20 条，按时间升序（时间线是叙事，倒序读起来像倒放）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（含 `userA`/`userB`、`timeline`、`permissions`）' })
  @ApiResponse({ status: 400, description: '关系 ID 不合法（`10001`）' })
  @ApiResponse({ status: 404, description: '关系不存在或不属于当前用户（`60000`）' })
  async getRelationship(
    @CurrentUser('userId') userId: string,
    @Param() params: RelationshipIdParamDto,
  ): Promise<RelationshipDetailView> {
    return this.relationshipService.getRelationship(userId, params.relationshipId);
  }

  @Post(':relationshipId/compatibility')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ global: { limit: 3, ttl: 24 * 60 * 60 * 1000 } })
  @ApiOperation({
    summary: '触发匹配算分（异步）',
    description: [
      '返回 `202` 与 `reportId`，由 `compatibility.calc` 队列异步算分。',
      '',
      '**幂等**：同一组「双方画像版本 + 权重版本 + 引擎版本」只会有一份报告，',
      '重复触发返回既有报告（`isReused: true`）—— 连点两次不会消耗两次配额。',
      '',
      '**本期只做确定性算分**（`CompatibilityEngine`，已单测）。AI 解读复用 `ai.report`',
      '管道，尚未接入，因此 `GET` 查询结果的 `aiInterpretation.available` 恒为 `false`。',
      '',
      '算分结果由纯数学决定，与 AI 无关（ADR-005）：同一份输入必然得到同一个分数。',
    ].join('\n'),
  })
  @ApiResponse({ status: 202, description: '已受理，返回 `reportId` 与预估耗时' })
  @ApiResponse({ status: 400, description: '关系 ID 不合法（`10001`）' })
  @ApiResponse({ status: 404, description: '关系不存在或不属于当前用户（`60000`）、我尚无画像（`40010`）' })
  @ApiResponse({ status: 409, description: '关系尚未生效（`60008`）、对方无画像（`60009`）或正在生成（`60011`）' })
  @ApiResponse({ status: 429, description: '超出触发频率上限（`10010`）' })
  async generateCompatibility(
    @CurrentUser('userId') userId: string,
    @Param() params: RelationshipIdParamDto,
    @Body() _dto: GenerateCompatibilityBodyDto,
  ): Promise<CompatibilityRequestView> {
    return this.compatibilityService.requestCompatibility(userId, params.relationshipId);
  }

  @Get(':relationshipId/compatibility')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '查询匹配报告',
    description: [
      '尚未生成时返回 `data: null`（**不是错误**）—— 列表与详情页都要展示"尚未生成"',
      '这个正常状态，用异常表达正常状态会让前端不得不用 `try/catch` 当控制流。',
      '',
      '失败的报告只下发**友好文案**，不透出引擎或数据库错误原文。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功；`data` 为 `null` 表示尚未生成' })
  @ApiResponse({ status: 400, description: '关系 ID 不合法（`10001`）' })
  @ApiResponse({ status: 404, description: '关系不存在或不属于当前用户（`60000`）' })
  async getCompatibility(
    @CurrentUser('userId') userId: string,
    @Param() params: RelationshipIdParamDto,
  ): Promise<CompatibilityReportView | null> {
    return this.compatibilityService.getCompatibility(userId, params.relationshipId);
  }

  @Post(':relationshipId/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 20, ttl: 60 * 60 * 1000 } })
  @ApiOperation({
    summary: '确认关系（转为 ACTIVE）',
    description: [
      '**仅邀请方可以确认**（契约 §3.6.6 的「待 A 确认」语义）：接受方调用返回 `60008`。',
      '',
      '**天然幂等**：已是 `ACTIVE` 时返回当前状态，不报错、不重复触发算分。',
      '',
      '`autoGenerateReport = false` 时不触发匹配算分（契约 §3.6.6 的默认值是 `true`）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '确认成功，返回关系状态' })
  @ApiResponse({ status: 400, description: '关系 ID 不合法（`10001`）' })
  @ApiResponse({ status: 403, description: '非邀请方发起确认（`60008`）' })
  @ApiResponse({ status: 404, description: '关系不存在或不属于当前用户（`60000`）' })
  @ApiResponse({ status: 409, description: '当前状态不支持确认（`60008`）' })
  async confirmRelationship(
    @CurrentUser('userId') userId: string,
    @Param() params: RelationshipIdParamDto,
    @Body() dto: ConfirmRelationshipDto,
  ): Promise<RelationshipStateView> {
    // 必须透传 `autoGenerateReport`：服务层**已经**实现了"false 就不触发算分"，
    // 但控制器此前把它丢掉、永远走默认值 true —— 用户显式传 false 仍会被触发算分
    // （契约 §3.6.8 注明重复触发会消耗会员额度），属"接收了却静默忽略"的缺陷。
    return this.relationshipService.confirmRelationship(userId, params.relationshipId, dto.autoGenerateReport);
  }

  @Delete(':relationshipId')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 10, ttl: 60 * 60 * 1000 } })
  @ApiOperation({
    summary: '解除关系 / 拒绝确认 / 撤回邀请',
    description: [
      '契约 §3.6.7 的三种语义合并到同一端点，按当前状态与我的角色决定：',
      '`ACTIVE` → `REMOVED`；待确认且我是邀请方 → `REJECTED`（拒绝）；待确认且我是接受方 → `REMOVED`（撤回）。',
      '',
      '**双方任一方均可单方解除**，无需对方同意 —— 强制双方同意会让人无法离开一段已结束的关系。',
      '',
      '**天然幂等**：已处于终态时返回现状，不覆盖首次解除的时间与原因。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '解除成功（或返回既有终态，幂等命中）' })
  @ApiResponse({ status: 400, description: '关系 ID 或 reason 不合法（`10001`）' })
  @ApiResponse({ status: 404, description: '关系不存在或不属于当前用户（`60000`）' })
  @ApiResponse({ status: 429, description: '超出解除频率上限（`10010`）' })
  async removeRelationship(
    @CurrentUser('userId') userId: string,
    @Param() params: RelationshipIdParamDto,
    @Query() query: RemoveRelationshipQueryDto,
  ): Promise<RelationshipStateView> {
    return this.relationshipService.unbindRelationship(userId, params.relationshipId, {
      ...(query.reason !== undefined ? { reason: query.reason } : {}),
      // 透传 `keepHistory`：此前这里只传 `reason`，于是那个隐私开关**被静默忽略**
      ...(query.keepHistory !== undefined ? { keepHistory: query.keepHistory } : {}),
    });
  }
}
