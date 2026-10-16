/**
 * 星座运势控制器
 *
 * 路由挂在 `/zodiac`：与三个测评模块**完全隔离**（ADR-038 + 用户明确要求）。
 * 本模块不写任何画像、不进测评框架，因此它出现在这里不会影响任何测评结论。
 *
 * ⚠ 接口文档里也要写清"娱乐性质"：这份文档是前端与第三方的唯一契约，
 * 描述里写"预测"就等于我们自己把它当成了预测。
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../common/decorators';
import { ZodiacChartQueryDto, ZodiacCityQueryDto, ZodiacFortuneQueryDto, ZodiacMatchQueryDto } from './dto/zodiac.dto';
import {
  ZodiacService,
  type DailyFortuneResponse,
  type ZodiacChartResponse,
  type ZodiacProfileView,
} from './zodiac.service';
import type { MonthlyFortuneView, WeeklyFortuneView, ZodiacMatchView } from './zodiac-fortune.util';
import type { BirthCity } from './zodiac-city.data';
import type { ZodiacSign } from './zodiac.types';

@ApiTags('星座运势')
@Controller('zodiac')
export class ZodiacController {
  constructor(private readonly zodiacService: ZodiacService) {}

  @Get('signs')
  /**
   * ⚠ `@Public()` 不可省（2026-10-16 修）
   *
   * 全局 `JwtAuthGuard` 注册在 `APP_GUARD` 上，**默认拒绝所有未标记的接口**；
   * 用户实测时这个接口返回 401，就是漏了这一个装饰器 ——
   * 而它在文档里写的是"不需要登录即可访问"，文档与实现因此直接对不上。
   */
  @Public()
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '十二星座档案',
    description: [
      '返回十二星座的**文化常识**档案：日期区间、元素、守护星、关键词、性格与爱情/事业/友情的倾向、优势与需要留意的地方。',
      '',
      '⚠ 本接口的内容**不含任何预测**，是星座文化的通识描述；**不需要登录**即可访问。',
      '',
      '日期区间采用**国际通用的固定区间**（与用户对"我是几号到几号"的认知一致），',
      '不是天文黄道日期 —— 后者每年漂 ±1 天，反而会让用户觉得算错了。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  listSigns(): readonly ZodiacProfileView[] {
    return this.zodiacService.listProfiles();
  }

  @Get('me')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '我的星座（读账号里的出生日期）',
    description: [
      '按账号已保存的出生日期判定星座。**年份不影响星座**，只取月与日。',
      '',
      '未设置出生日期时返回 `400` / `30019`，前端据此弹"选择出生日期"并调用 `PATCH /users/me` 保存。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '尚未设置出生日期（`30019`）' })
  async getMySign(
    @CurrentUser('userId') userId: string,
  ): Promise<{ sign: ZodiacSign; signName: string; birthday: string }> {
    return this.zodiacService.getMySign(userId);
  }

  @Get('daily')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '今日运势',
    description: [
      '五个维度（综合 / 感情 / 事业 / 财运 / 状态）的星级与一句话解读，外加速配与需要留意的星座、',
      '幸运色/数字/方位/时段、今日宜忌与一句箴言。',
      '',
      '**确定性生成**：同一日期 + 同一星座永远返回同一份内容（下拉刷新不会变）。',
      '内容来自逐句过审的文案池，不调用模型。',
      '',
      '⚠ 娱乐性质内容，`disclaimer` 由服务端下发，前端**不得**硬编码或省略。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '`date` 格式不合法（`10001`）或未设置出生日期（`30019`）' })
  async getDaily(
    @CurrentUser('userId') userId: string,
    @Query() query: ZodiacFortuneQueryDto,
  ): Promise<DailyFortuneResponse> {
    return this.zodiacService.getDaily(userId, query.date, query.birthday);
  }

  @Get('weekly')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '本周运势',
    description: [
      '按**所在周的周一**为种子生成，因此同一周内任何一天查看都是同一份内容。',
      '返回事业与学业 / 感情与关系 / 状态与节奏三个方向，外加一句本周提醒。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getWeekly(
    @CurrentUser('userId') userId: string,
    @Query() query: ZodiacFortuneQueryDto,
  ): Promise<WeeklyFortuneView> {
    return this.zodiacService.getWeekly(userId, query.date, query.birthday);
  }

  @Get('monthly')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '本月运势',
    description: '按 `YYYY-MM` 为种子生成：本月主题词、整体星级、上旬/中旬/下旬三段。',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getMonthly(
    @CurrentUser('userId') userId: string,
    @Query() query: ZodiacFortuneQueryDto,
  ): Promise<MonthlyFortuneView> {
    return this.zodiacService.getMonthly(userId, query.date, query.birthday);
  }

  @Get('chart')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '本命星盘（会员给完整盘，非会员给三巨头预览）',
    description: [
      '按账号里的**出生日期 + 出生时间 + 出生城市**实时计算本命星盘：十大行星位置、上升点与天顶、',
      '十二宫（整宫制）、行星相位、四元素与三分类分布、星群与命主星。',
      '',
      '**权限**：会员返回完整 `chart`；非会员返回 `preview`（太阳/月亮/上升的**星座名**，不含度数、',
      '宫位与相位），且 `chart` 恒为 `null` —— 不是打码，而是根本不返回。',
      '',
      '**缺信息时的行为**（刻意"宁可少给，不给错"）：',
      '  · 缺出生时间 → 没有上升点/天顶/十二宫（上升星座约 2 小时换一个，用"默认中午"推算对大多数人是错的）；',
      '  · 缺出生城市 → 同样没有四轴（中国横跨 62 个经度，按固定城市猜会让新疆用户错一个星座）。',
      '两种情况都会返回对应的提示文案，前端直接展示并引导补全。',
      '',
      '`access.lockedSections` 与 `access.membershipHint` 由服务端下发，前端**不得硬编码**。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '尚未设置出生日期（`30019`）' })
  async getChart(
    @CurrentUser('userId') userId: string,
    @Query() query: ZodiacChartQueryDto,
  ): Promise<ZodiacChartResponse> {
    // 目前没有可用的查询参数：出生信息一律从账号读（见 ZodiacChartQueryDto 的说明）。
    // 这里显式引用一下，避免"留个没用的参数"变成 lint 噪音。
    void query;

    return this.zodiacService.getChart(userId);
  }

  @Get('cities')
  /**
   * 出生城市搜索：**公开**（同 `signs`，漏了 `@Public()` 会被全局守卫拦成 401）
   *
   * 内容只是一张静态城市表（名称/经纬度/时区），不含任何用户数据。
   */
  @Public()
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '出生城市搜索（给"出生地"选择器用）',
    description: [
      '按关键词搜索内置城市表，返回城市名、所属地区、纬度、经度与**时区偏移**。',
      '',
      '⚠ 为什么必须存时区偏移：中国 1986–1991 年实行过夏令时，海外出生还要按当地时区。',
      '前端选完城市后，应把 `birthPlace` + `birthLatitude` + `birthLongitude` + `birthTimezoneOffset`',
      '**一起**通过 `PATCH /users/me` 存进账号 —— 只存城市名会让后端少了经度，算不出上升点。',
      '',
      '关键词为空时返回热门城市。**不需要登录**。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  searchCities(@Query() query: ZodiacCityQueryDto): readonly BirthCity[] {
    return this.zodiacService.searchBirthCities(query.keyword);
  }

  @Get('match')
  /** 同上：配对不需要知道"你是谁"，因此也公开（用户常想看朋友的组合） */
  @Public()
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '星座配对',
    description: [
      '给两个星座的相处解读：合拍指数、三档结论（很合得来 / 需要磨合 / 差异明显）、',
      '元素组合基调、沟通方式 / 相处氛围 / 长期节奏三个维度，以及一句相处建议。',
      '',
      '**顺序无关**：`match(a,b)` 与 `match(b,a)` 返回同一份结果（种子按排序后的组合串生成）。',
      '',
      '⚠ 它描述的是"两种星座文化性格的相处特点"，**不判断任何一段具体关系是否合适**。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '星座取值不合法（`10001`）' })
  async getMatch(@Query() query: ZodiacMatchQueryDto): Promise<ZodiacMatchView & { disclaimer: string }> {
    return this.zodiacService.getMatch(query.a, query.b);
  }
}
