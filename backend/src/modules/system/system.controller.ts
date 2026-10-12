/**
 * 用户端系统控制器（契约 §3.12）
 *
 * ## 为什么这两个接口是公开的
 *
 * 它们是小程序**启动链路**的一部分：功能开关决定首页展示什么、免责声明必须在任何
 * AI 内容之前可渲染。如果要求登录，启动时就得先完成登录换取配置，再取业务数据，
 * 首屏串行请求数直接翻倍；游客态下也无法展示合规文案。
 * 因此两个接口都标 `@Public()`（跳过用户端全局 `JwtAuthGuard`），
 * 并靠限流（IP 240 次/60s）而不是鉴权来防刷。
 *
 * ## 与其他模块的关系
 *
 * 这两个接口是 `system_configs` 的**唯一公开出口**：`personality` / `user` 等模块
 * 直接读库做兜底，管理端通过 `PUT /admin/configs` 写入，公开侧统一由本控制器下发，
 * 保证「后台写」与「前台读」是同一份数据与同一个缓存。
 */

import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { DisclaimersQueryDto, SystemConfigQueryDto } from './dto/system.dto';
import { ConfigRequestError, SystemConfigService } from './system-config.service';

@ApiTags('系统-配置')
// 跳过用户端全局守卫：游客也必须能拿到开关与合规文案（见文件头说明）
@Public()
@Controller('system')
export class SystemController {
  constructor(private readonly configs: SystemConfigService) {}

  @Get('config')
  // IP 维度 240 次/60s（契约 §3.12.1）；配置接口被所有客户端在启动时调用，
  // 限流阈值必须明显高于业务接口，否则一次发布就会把正常启动挡在 429
  @Throttle({ global: { limit: 240, ttl: 60_000 } })
  // 契约 §3.12.1 规则 2：private（不含用户私有数据但也不该被共享缓存放大）+ max-age=300
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({
    summary: '小程序启动配置',
    description: [
      '一次性返回启动所需配置：功能开关、免责声明、套餐价格、分享文案、资源域名、限额。',
      '',
      '**公开接口**：游客也要能启动，因此不校验登录态；相应地，与个人相关的字段',
      '（如 `policies.requiresReconsent`）恒为空数组，个性化状态请走 `GET /users/me/consents`。',
      '',
      '**维护模式不返回 503**：`features.maintenanceMode = true` 时仍返回 200，',
      '前端据此渲染维护页 —— 否则维护期间连配置都拉不到，页面只能白屏。',
      '',
      '**强更**：传入 `clientVersion` 且低于 `app.minClientVersion` 时，`app.forceUpdate` 置为 true。',
      '',
      '**兼容字段**：除契约字段外，另返回小程序已消费的扁平别名',
      '（`features.payment` / `disclaimers.reportFooter` / `support` / `reportFreePreviewRatio` / `version`），',
      '这些是契约字段的派生视图，不额外维护第二份数据。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功（含 configVersion 内容哈希，便于前端比对缓存新鲜度）' })
  @ApiResponse({ status: 400, description: '`platform` 非枚举 / `clientVersion` 非 x.y.z / `keys` 过长（`10001`）' })
  async getConfig(@Query() query: SystemConfigQueryDto): Promise<Record<string, unknown>> {
    try {
      return await this.configs.getPublicConfig({
        clientVersion: query.clientVersion,
        platform: query.platform,
        keys: query.keys,
      });
    } catch (error) {
      // `keys` 数量上限这类本地校验错误要转成统一错误响应，而不是 500
      if (error instanceof ConfigRequestError) {
        throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, error.message);
      }
      throw error;
    }
  }

  @Get('disclaimers')
  @Throttle({ global: { limit: 240, ttl: 60_000 } })
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({
    summary: '免责声明与合规文案',
    description: [
      '返回结构化合规文案（`position` 指导渲染位置、`required` 表示不可绕过）、',
      '危机干预资源、协议版本号，供协议页、报告页尾、AI 对话页脚使用。',
      '',
      '**与 `GET /system/config` 同源**：`/system/config` 下发首屏用的内联精简文案，',
      '本接口下发完整结构化文案（含危机资源与位置元信息），两者读同一份 `system_configs`，',
      '不会出现口径不一致。',
      '',
      '**`version` 为文案内容哈希**：用于合规举证（「该用户在 X 时间看到的文案版本为 Y」）。',
      '',
      '**多语言**：当前 `system_configs` 无语言维度，`language=en-US` 时如实返回中文文案',
      '并将 `language` 标为 `zh-CN`（不伪装成已支持英文）。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '`scene` / `language` 非枚举值（`10001`）' })
  async getDisclaimers(@Query() query: DisclaimersQueryDto): Promise<Record<string, unknown>> {
    return this.configs.getDisclaimers({ scene: query.scene, language: query.language });
  }
}
