/**
 * 星座运势服务
 *
 * ## 三条职责边界（每一处都刻意收窄，别扩张）
 *
 *   ① **不落库**：运势由 `(日期 + 星座)` 确定性生成，随时可复算 → 不需要表、不需要迁移。
 *      唯一被持久化的是**出生日期**，而它存在已有的 `users.birthday` 列上。
 *   ② **不算分、不画像**：本模块不进测评框架，不写任何 profile，也不影响三个测评模块
 *      （ADR-038 的模块隔离，用户也明确要求"完全隔离"）。
 *   ③ **不调模型**：内容全部来自逐句过审的文案池（见 `zodiac-content.ts`）。
 *
 * ## 生日从哪来
 *
 * 优先用当前用户的 `users.birthday`（用户拍板"存进账号"，下次进来不必再选）。
 * 也允许请求里显式带 `birthday`（游客/临时查看用），但**不写入**账号 ——
 * 写入只走 `PATCH /users/me`，避免这个只读模块产生副作用。
 */

import { Injectable } from '@nestjs/common';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SystemConfigService } from '../system/system-config.service';
import { ZODIAC_PROFILES } from './zodiac-content';
import {
  buildDailyFortune,
  buildMonthlyFortune,
  buildWeeklyFortune,
  buildZodiacMatch,
  type DailyFortuneView,
  type MonthlyFortuneView,
  type WeeklyFortuneView,
  type ZodiacMatchView,
} from './zodiac-fortune.util';
import { resolveZodiacSignFromDate } from './zodiac-sign.util';
import { ZODIAC_ELEMENT_LABELS, ZODIAC_SIGNS, type ZodiacProfile, type ZodiacSign } from './zodiac.types';

/** 星座档案列表项（含元素说明，供前端"星座百科"直接渲染） */
export interface ZodiacProfileView extends ZodiacProfile {
  readonly elementLabel: string;
  readonly elementDescription: string;
}

/** 今日运势响应（含服务端下发的娱乐性质声明） */
export interface DailyFortuneResponse extends DailyFortuneView {
  /** 判定依据：生日（`MM-DD` 形态，不回显年份——减少不必要的个人信息暴露） */
  readonly birthdaySource: string;
  /** 合规声明（**服务端下发，前端不得硬编码**） */
  readonly disclaimer: string;
}

@Injectable()
export class ZodiacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /** 十二星座档案（纯文化常识，不含预测；按固定顺序返回） */
  listProfiles(): readonly ZodiacProfileView[] {
    return ZODIAC_SIGNS.map((sign) => this.toProfileView(sign));
  }

  /** 单个星座档案 */
  getProfile(sign: ZodiacSign): ZodiacProfileView {
    return this.toProfileView(sign);
  }

  /** 当前用户的星座（读 `users.birthday`）；没设生日时抛 `30019` 由前端引导设置 */
  async getMySign(userId: string): Promise<{ sign: ZodiacSign; signName: string; birthday: string }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { birthday: true },
    });

    if (!user) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    if (user.birthday === null) {
      throw BusinessException.badRequest(ErrorCode.ZODIAC_BIRTHDAY_REQUIRED, '请先选择你的出生日期');
    }

    const birthday = user.birthday.toISOString().slice(0, 10);
    const sign = resolveZodiacSignFromDate(birthday);

    if (sign === null) {
      // 库里存了非法的生日（后台导入等）：不猜，直接要求重新设置
      throw BusinessException.badRequest(ErrorCode.ZODIAC_BIRTHDAY_REQUIRED, '出生日期不合法，请重新设置');
    }

    return { sign, signName: ZODIAC_PROFILES[sign].name, birthday };
  }

  /** 今日运势 */
  async getDaily(userId: string, date: string, birthday?: string): Promise<DailyFortuneResponse> {
    const resolved = await this.resolveSign(userId, birthday);
    const fortune = buildDailyFortune(resolved.sign, date);

    return {
      ...fortune,
      birthdaySource: resolved.birthdaySource,
      disclaimer: await this.loadDisclaimer(),
    };
  }

  /** 周运 */
  async getWeekly(userId: string, date: string, birthday?: string): Promise<WeeklyFortuneView> {
    const resolved = await this.resolveSign(userId, birthday);

    return buildWeeklyFortune(resolved.sign, date);
  }

  /** 月运 */
  async getMonthly(userId: string, date: string, birthday?: string): Promise<MonthlyFortuneView> {
    const resolved = await this.resolveSign(userId, birthday);

    return buildMonthlyFortune(resolved.sign, date);
  }

  /** 两个星座的配对解读（顺序无关：同一对被调换顺序得到同一份结果） */
  async getMatch(a: ZodiacSign, b: ZodiacSign): Promise<ZodiacMatchView & { disclaimer: string }> {
    return { ...buildZodiacMatch(a, b), disclaimer: await this.loadDisclaimer() };
  }

  // ------------------------------------------------------------------ 内部

  private toProfileView(sign: ZodiacSign): ZodiacProfileView {
    const profile = ZODIAC_PROFILES[sign];
    const element = ZODIAC_ELEMENT_LABELS[profile.element];

    return {
      ...profile,
      elementLabel: element.label,
      elementDescription: element.description,
    };
  }

  /**
   * 解析本次请求用的星座
   *
   * 优先用请求里显式带的 `birthday`（临时查看，不写库），否则读账号里的生日。
   * 两者都没有 → `30019`，前端据此弹"选择出生日期"。
   */
  private async resolveSign(userId: string, birthday?: string): Promise<{ sign: ZodiacSign; birthdaySource: string }> {
    if (birthday !== undefined) {
      const sign = resolveZodiacSignFromDate(birthday);

      if (sign === null) {
        throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'birthday 需为 YYYY-MM-DD 格式且日期合法');
      }

      return { sign, birthdaySource: birthday.slice(5) };
    }

    const mine = await this.getMySign(userId);

    return { sign: mine.sign, birthdaySource: mine.birthday.slice(5) };
  }

  /**
   * 娱乐性质声明
   *
   * 由服务端下发（`disclaimer.zodiac`，运营可改、改它要二次确认密码）。
   * 读不到时用**兜底文案**而不是空串：星座内容没有这句声明就是合规风险，
   * 配置缺失时宁可显示兜底，也不能什么都不显示。
   */
  private async loadDisclaimer(): Promise<string> {
    const config = await this.systemConfig.getPublicConfig({});

    const disclaimers = (config['disclaimers'] ?? {}) as Record<string, unknown>;
    const value = disclaimers['zodiac'];

    return typeof value === 'string' && value.length > 0
      ? value
      : '星座内容属于娱乐性质的传统文化解读，仅供消遣参考，不构成任何预测、建议或决策依据。';
  }
}
