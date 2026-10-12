/**
 * 通知控制器（契约 §3.11）
 *
 * | 契约     | 方法与路径                              | 鉴权 | 成功码 |
 * | -------- | --------------------------------------- | ---- | ------ |
 * | §3.11.1  | `GET  /notifications`                   | 🔑   | 200    |
 * | §3.11.2  | `POST /notifications/read`              | 🔑   | 200    |
 * | §3.11.3  | `POST /notifications/subscribe`         | 🔑   | 200    |
 *
 * 三个端点**全部需要登录**（契约里都是 🔑），因此本控制器**不得**标记 `@Public()`：
 * 全局 `JwtAuthGuard` 默认拒绝匿名访问，任何一条通知都属于某个具体用户，
 * 开放一条就等于把「谁能收到什么消息」暴露出去。
 *
 * 两个 POST 都显式声明 `@HttpCode(HttpStatus.OK)`：NestJS 对 POST 默认返回 201，
 * 而契约给的是 200。客户端若按 `code === 0 && status === 200` 判断成功，
 * 201 会被当成异常分支 —— 这类"看起来能跑"的差异最难在联调时发现。
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../common/decorators';
import { ListNotificationsQueryDto, MarkNotificationsReadDto, SubscribeNotificationsDto } from './dto/notification.dto';
import {
  NotificationService,
  type MarkNotificationsReadView,
  type NotificationListView,
  type SubscribeNotificationsView,
} from './notification.service';

@ApiTags('通知')
@ApiBearerAuth('user-token')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '站内通知列表',
    description: [
      '分页返回**当前用户**的站内通知，含已读状态、业务类型与跳转目标。',
      '',
      '**强归属过滤**：`WHERE userId = 当前用户`，没有任何按 ID 读取他人通知的入口。',
      '',
      '**不传 `status` 时只返回未读**（契约默认值 `UNREAD`）—— 这不是"不筛选"，',
      '而是因为红点场景下未读才是用户要找的东西；要看全部需显式传 `status=ALL`。',
      '',
      '**过期通知不再返回**：TTL 为派生值（默认 30 天，`SECURITY_ALERT` 180 天）。',
      '',
      '`summary` 的统计口径是**全部通知**，不随 `status` / `type` 筛选变化 ——',
      '否则切到「已读」页会看到「未读 0」，像是消息被清空了。',
      '',
      '⚠ `type` 是**服务端派生**的业务类型：`notifications` 表只存传输通道',
      '（`IN_APP` / `SUBSCRIPTION_MESSAGE`），业务类型由 `payload.bizType`',
      '（白名单）→ `idempotencyKey` 前缀 → `SYSTEM` 兜底推导。',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: '查询成功（`items` + `total` + `page` + `pageSize` + `hasNext` + `summary`）',
  })
  @ApiResponse({
    status: 400,
    description: '`status` / `type` 含非法枚举值、`sortBy` 不在白名单或 `pageSize > 100`（均返回 `10001`）',
  })
  @ApiResponse({ status: 401, description: '未登录或登录态失效（`20000`/`20001`）' })
  @ApiResponse({ status: 429, description: '超出限流（120 次/60s）' })
  async listNotifications(
    @CurrentUser('userId') userId: string,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<NotificationListView> {
    return this.notifications.listNotifications({
      userId,
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.sortBy !== undefined ? { sortBy: query.sortBy } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
    });
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '标记通知已读',
    description: [
      '按 `notificationIds` 批量标记，或用 `all: true` 全部标记（可叠加 `type` 仅标记某类）。',
      '',
      '**天然幂等**：已读的再次标记不改 `readAt`（保留首次已读时间），只计入 `skippedCount`。',
      '',
      '**越权 ID 静默跳过**：他人的 / 不存在的通知 ID 一律进 `skippedIds`，',
      '**不返回 403** —— 返回 403 等于告诉攻击者「这个 ID 真实存在」，可被用来枚举。',
      '',
      '`all: true` 时单次最多处理 20000 条（内部按 1000 条分批），超出部分留待下次调用。',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: '处理完成（`requestedCount` / `updatedCount` / `skippedCount` / `skippedIds` / `unreadCount`）',
  })
  @ApiResponse({
    status: 400,
    description:
      '`notificationIds` 非数组或含非法 UUID、`notificationIds` 与 `all` 均未提供、`type` 非枚举、数组长度 > 100（均返回 `10001`）',
  })
  @ApiResponse({ status: 401, description: '未登录或登录态失效（`20000`/`20001`）' })
  @ApiResponse({ status: 429, description: '超出限流（60 次/60s）' })
  async markRead(
    @CurrentUser('userId') userId: string,
    @Body() dto: MarkNotificationsReadDto,
  ): Promise<MarkNotificationsReadView> {
    return this.notifications.markRead(userId, dto);
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '记录订阅消息授权',
    description: [
      '上报小程序端 `wx.requestSubscribeMessage` 的授权结果（`ACCEPT` / `REJECT` / `BAN`）。',
      '',
      '**只记录，不发送**：微信授权动作在小程序端完成，本接口仅上报；',
      '发送由 `notify.subscribe` 队列负责（契约规则 1）。',
      '',
      '**一次性授权语义**：`ACCEPT` 记 `remainingQuota = 1`，发送成功后递减；',
      '`REJECT` / `BAN` 记 0，且同样落记录 —— 只记 `ACCEPT` 会让服务端无法区分',
      '「用户拒绝过」与「从未问过」，于是每次都会再弹一次授权框。',
      '',
      '**天然幂等**：同一 `scene` 重复上报覆盖上一次结果，不累加配额。',
      '',
      '**`templateId` 以服务端为准**：服务端用 `scene` 映射 `system_configs` 的',
      '`notify.template.{scene}`；客户端值仅用于核对，不一致时忽略并记告警（防伪造）。',
      '库中未配置该键时（项目现状）采用客户端值并留下告警。',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: '记录完成（`items` + `acceptedCount` + `rejectedCount` + `totalRemainingQuota` + `allScenes`）',
  })
  @ApiResponse({
    status: 400,
    description:
      '`subscriptions` 缺失或为空、`scene` / `result` 非枚举、`templateId` 长度非法、数组长度 > 10（均返回 `10001`）',
  })
  @ApiResponse({ status: 401, description: '未登录或登录态失效（`20000`/`20001`）' })
  @ApiResponse({ status: 429, description: '超出限流（60 次/60s）' })
  @ApiResponse({
    status: 502,
    description: '⚠️ 契约列出 `90007`（微信侧失败），但**本接口不会返回**：它只记录授权，不调用微信接口',
  })
  async subscribe(
    @CurrentUser('userId') userId: string,
    @Body() dto: SubscribeNotificationsDto,
  ): Promise<SubscribeNotificationsView> {
    return this.notifications.recordSubscriptions(userId, dto);
  }
}
