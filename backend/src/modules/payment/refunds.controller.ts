/**
 * 用户端退款记录控制器（契约 §3.9.9）
 *
 * 只读接口，**刻意不标 `@Public()`**（契约是 🔑）；强归属过滤在 Service 层。
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../common/decorators';
import { ListRefundsQueryDto } from './refund.dto';
import { RefundService } from './refund.service';
import type { RefundListView } from './refund.service';

@ApiTags('退款')
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundService) {}

  @Get()
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '退款记录列表',
    description: [
      '分页返回**当前用户**的退款记录（强归属过滤 `WHERE userId = currentUser.id`）。',
      '',
      '**`entitlementRevoked` / `revokedEntitlementIds`**：退款成功且已撤销对应权益时为 `true`',
      '与非空数组。这两个字段存放在 `refunds.notify_payload` 的命名空间键下 ——',
      '`refunds` 表没有承载它们的列（见交付简报的模型差异清单）。',
      '',
      '**到账时间**：`arrivalNotice` 明确说明为 1–3 个工作日（微信与银行决定），',
      '🚫 不承诺即时到账。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '查询成功（items + summary）' })
  @ApiResponse({ status: 400, description: 'status 非枚举 / pageSize > 100（均 `10001`）' })
  @ApiResponse({ status: 404, description: '`orderId` 对当前用户不存在（`70002`）' })
  @ApiResponse({ status: 429, description: '60s 内超过 120 次（`10007`）' })
  async listRefunds(
    @CurrentUser('userId') userId: string,
    @Query() query: ListRefundsQueryDto,
  ): Promise<RefundListView> {
    return this.refunds.listRefunds(userId, query);
  }
}
