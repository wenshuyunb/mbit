/**
 * 星座运势控制器
 *
 * 路由挂在 `/zodiac`：与三个测评模块**完全隔离**（ADR-038 + 用户明确要求）。
 * 本模块不写任何画像、不进测评框架，因此它出现在这里不会影响任何测评结论。
 *
 * ⚠ 接口文档里也要写清"娱乐性质"：这份文档是前端与第三方的唯一契约，
 * 描述里写"预测"就等于我们自己把它当成了预测。
 */

import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../common/decorators';
import {
  ZodiacChartQueryDto,
  ZodiacCityQueryDto,
  ZodiacFortuneQueryDto,
  ZodiacMatchQueryDto,
  ZodiacRegionResolveQueryDto,
} from './dto/zodiac.dto';
import {
  ZodiacService,
  type DailyFortuneResponse,
  type ZodiacChartResponse,
  type ZodiacProfileView,
} from './zodiac.service';
import { ZodiacReadingService } from './zodiac-reading.service';
import type { MonthlyFortuneView, WeeklyFortuneView, YearlyFortuneView, ZodiacMatchView } from './zodiac-fortune.util';
import type { BirthCity, RegionTree } from './zodiac-city.data';
import type { ZodiacReadingResponse } from './zodiac-reading.service';
import type { ZodiacSign } from './zodiac.types';

@ApiTags('星座运势')
@Controller('zodiac')
export class ZodiacController {
  constructor(
    private readonly zodiacService: ZodiacService,
    private readonly zodiacReadingService: ZodiacReadingService,
  ) {}

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

  @Get('yearly')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '今年运势',
    description: [
      '按 `YYYY` 为种子生成：年度主题词、整体星级与分数、四个季度、以及一句年度提醒。',
      '',
      '分段用**四个季度**而不是十二个月 —— 一年的颗粒度写十二段必然注水，每段都会退化成"这个月还行"。',
      '',
      '⚠ 越长的周期越不可能被"说准"，因此年运**不写具体事件**，只给这一年的主线与节奏。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getYearly(
    @CurrentUser('userId') userId: string,
    @Query() query: ZodiacFortuneQueryDto,
  ): Promise<YearlyFortuneView> {
    return this.zodiacService.getYearly(userId, query.date, query.birthday);
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

  @Get('regions')
  /**
   * 三级联动数据：**公开**（同 `signs` / `cities`，漏了 `@Public()` 会被全局守卫拦成 401）
   */
  @Public()
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '出生地的三级联动数据（省 / 市 / 县）',
    description: [
      '返回「省 → 地级市 → 县/区」的**名称树**（不含经纬度），给小程序的多列转盘用：',
      '小程序的 `picker mode="multiSelector"` 需要三列同时就位，用关键词搜索拼不出层级。',
      '',
      '规模：31 个省级 + 360 个地级市 + 2812 个县级单位。',
      '',
      '⚠ 没有区县的地级市（东莞、中山、嘉峪关、儋州、神农架林区这类"直筒子市"）第三列只有 ',
      '`全市` 一个选项，选中即用地级市坐标 —— 这类城市本来就没有区县一级。',
      '',
      '⚠ 港澳台与海外**不在**这棵树里（它们没有省市县层级），请用 `GET /zodiac/cities?keyword=`。',
      '',
      '选定后用 `GET /zodiac/regions/resolve` 换到带经纬度的城市记录。**不需要登录**。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  getRegions(): RegionTree {
    return this.zodiacService.getRegionTree();
  }

  @Get('regions/resolve')
  @Public()
  @Throttle({ global: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: '按「省 / 市 / 县」取具体城市（含经纬度与时区）',
    description: [
      '把三级联动选中的路径换成算星盘要用的城市记录：名称、所属地区、纬度、经度、',
      '**标准时区偏移**，以及（新疆等地区）可能存在的另一种惯用时间 `altTimezoneOffset`。',
      '',
      '⚠ 路径不合法返回 `400`，**不会回退到默认城市** —— 回退会让用户选的地方与',
      '实际算盘的地方不一致，属于最难排查的一类错误。',
      '',
      '⚠ 拿到结果后请把 `birthPlace` + `birthLatitude` + `birthLongitude` + `birthTimezoneOffset`',
      '**一起**通过 `PATCH /users/me` 存进账号。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '省份/城市/区县路径不合法（`10001`）' })
  resolveRegion(@Query() query: ZodiacRegionResolveQueryDto): BirthCity {
    return this.zodiacService.resolveRegion(query.province, query.city, query.county);
  }

  @Get('reading')
  @ApiBearerAuth('user-token')
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '我的星盘解读（首段免费，完整章节需解锁）',
    description: [
      '把用户的本命星盘翻译成一篇**人话版解读**：三巨头、元素与三分类、相位、命主星、十二宫、怎么用。',
      '',
      '**免费与付费**：`preview` 永远免费返回；完整 `sections` 需要解锁 ——',
      '解锁途径：会员、单次购买、或邀请一位**新用户**注册（当天有效）。',
      '未解锁时 `sections` 为 `null`（**不返回、不打码**），同时返回 `totalSections` / `totalChars`，',
      '让用户知道完整解读有多长。',
      '',
      '**内容来源**：`source` 为 `TEMPLATE`（确定性模板，秒出、永远可用）或 `AI`（模型生成，更细）。',
      '首次访问总是先得到模板版；用户点"用 AI 重新写"才会调模型（见 `POST /zodiac/reading/generate`）。',
      '',
      '**缓存**：同一份盘（出生日期+时间+经纬度+时区）永远复用同一份解读，不重复生成。',
      '',
      '⚠ `disclaimer` 与 `access.hint` 由服务端下发，前端不得硬编码。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '尚未设置出生日期（`30019`）' })
  async getReading(@CurrentUser('userId') userId: string): Promise<ZodiacReadingResponse> {
    return this.zodiacReadingService.getReading(userId);
  }

  @Post('reading/generate')
  @ApiBearerAuth('user-token')
  /**
   * 显式 200：本接口是"重写已有资源"（解读一直都在，只是换个来源重写一遍），
   * 不是创建新资源。Nest 对 POST 默认返回 201，语义不符，也会让前端多一个特例分支。
   */
  @HttpCode(200)
  @Throttle({ global: { limit: 6, ttl: 60_000 } })
  @ApiOperation({
    summary: '用 AI 重写我的星盘解读',
    description: [
      '把这份解读交给模型重写，内容更细。**同步接口**，通常 10–30 秒返回。',
      '',
      '⚠ 为什么是"用户点一下"而不是自动生成：解读一辈子只生成一次，成本极低，',
      '但自动触发会让每个只是点进星盘页的用户都消耗一次调用（包括不看解读的人）。',
      '改成显式动作后，只为真正想看的人花钱。',
      '',
      '**失败不报错**：没配 Key、模型超时、返回格式不合格时，一律返回**已有内容**',
      '（模板版或上一次的 AI 版），响应里的 `source` 会告诉你实际用的是哪一版。',
      '',
      '限流 6 次/分钟，防止连点造成重复调用。',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: '生成完成（可能回退为模板版，见 `source`）' })
  @ApiResponse({ status: 400, description: '尚未设置出生日期（`30019`）' })
  async generateReading(@CurrentUser('userId') userId: string): Promise<ZodiacReadingResponse> {
    return this.zodiacReadingService.generateWithAi(userId);
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
