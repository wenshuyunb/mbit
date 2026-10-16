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
import { EntitlementService } from '../membership/entitlement.service';
import { SystemConfigService } from '../system/system-config.service';
import { findCityByName, searchCities, type BirthCity } from './zodiac-city.data';
import { buildNatalChart, CHART_LOCKED_SECTIONS, CHART_MEMBERSHIP_HINT, type NatalChart } from './zodiac-chart.util';
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

/** 星盘对非会员开放的那一部分（"三巨头"只给星座名，不给度数） */
export interface ChartPreviewBody {
  readonly sign: ZodiacSign;
  readonly signName: string;
  readonly elementLabel: string;
  /** 位置是否不可靠（缺出生时间时的月亮） */
  readonly uncertain: boolean;
}

export interface ChartPreview {
  readonly sun: ChartPreviewBody;
  readonly moon: ChartPreviewBody;
  readonly ascendant: ChartPreviewBody | null;
  readonly hasBirthTime: boolean;
  readonly hasBirthPlace: boolean;
}

/**
 * 星盘接口的解锁信息
 *
 * ⚠ `preview` 与 `chart` 是**互斥**的：非会员拿 `preview`（只有三个星座名），
 * 会员拿完整 `chart`。非会员的 `chart` 恒为 `null` —— 不是在完整数据上打码，
 * 而是根本不返回，避免"前端忘记隐藏字段"这类泄露（打码式的权限控制迟早出错）。
 */
export interface ChartAccess {
  readonly isMember: boolean;
  /** 完整星盘是否解锁 */
  readonly chartUnlocked: boolean;
  readonly lockedSections: readonly string[];
  /** 面向用户的解锁说明（服务端下发，前端不得硬编码） */
  readonly membershipHint: string;
  /** 会员到期时间（非会员为 null） */
  readonly expireAt: string | null;
}

/** 星盘响应 */
export interface ZodiacChartResponse {
  readonly preview: ChartPreview | null;
  readonly chart: NatalChart | null;
  readonly access: ChartAccess;
  /** 出生信息是否齐全（不齐时前端引导补全） */
  readonly birthInfo: {
    readonly birthday: string;
    readonly birthTime: string | null;
    readonly birthPlace: string | null;
    readonly birthLatitude: number | null;
    readonly birthLongitude: number | null;
    /** 城市是用户填的，还是按城市名从内置城市表补出来的 */
    readonly placeResolvedFrom: 'USER_INPUT' | 'CITY_TABLE' | 'MISSING';
  };
  readonly disclaimer: string;
}

/** 会员才能看的星盘区块（文案在 `zodiac-chart.util.ts`，与其它用户可见文案一起过审） */
const LOCKED_SECTIONS = CHART_LOCKED_SECTIONS;

const MEMBERSHIP_HINT = CHART_MEMBERSHIP_HINT;

@Injectable()
export class ZodiacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly entitlement: EntitlementService,
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

  /**
   * 本命星盘（会员给完整盘，非会员只给"三巨头"的星座名）
   *
   * ## 为什么要读账号里的出生信息，而不是让前端传
   *
   * 出生日期/时间/城市是**用户资料**，不是请求参数。放账号里有两个好处：
   *   ① 用户不必每次重新选（用户拍板"存进账号"）；
   *   ② 星盘只可能由**服务端**算，前端拿不到经纬度也伪造不了一份盘，
   *      会员门槛才是有意义的（若让前端传坐标，等于把数据权交出去了）。
   *
   * ## 出生城市的兜底
   *
   * 经纬度为空但城市名已知时，按城市名去内置城市表补坐标 —— 用于兼容
   * "只填了城市名"的历史数据。补不出来就**不算四轴**，交给前端引导补全，
   * 绝不拿某个默认城市去猜（见 `zodiac-chart.util.ts` 的说明）。
   */
  async getChart(userId: string): Promise<ZodiacChartResponse> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        birthday: true,
        birthTime: true,
        birthPlace: true,
        birthLatitude: true,
        birthLongitude: true,
        birthTimezoneOffset: true,
      },
    });

    if (!user) {
      throw BusinessException.notFound(ErrorCode.USER_NOT_FOUND);
    }

    if (user.birthday === null) {
      throw BusinessException.badRequest(ErrorCode.ZODIAC_BIRTHDAY_REQUIRED, '请先选择你的出生日期');
    }

    const birthday = user.birthday.toISOString().slice(0, 10);

    // 坐标缺失时按城市名补；补到了就一并把该城市的时区偏移也用上
    const needsCityLookup = user.birthLatitude === null || user.birthLongitude === null;
    const city: BirthCity | null = needsCityLookup && user.birthPlace !== null ? findCityByName(user.birthPlace) : null;

    const latitude = user.birthLatitude ?? city?.latitude ?? null;
    const longitude = user.birthLongitude ?? city?.longitude ?? null;
    const timezoneOffset = user.birthTimezoneOffset ?? city?.timezoneOffset ?? null;

    const chart = buildNatalChart({
      birthday,
      birthTime: user.birthTime,
      birthPlace: user.birthPlace,
      birthLatitude: latitude,
      birthLongitude: longitude,
      birthTimezoneOffset: timezoneOffset,
    });

    const membership = await this.entitlement.getMembership(userId);
    const disclaimer = await this.loadDisclaimer();

    const preview: ChartPreview = {
      sun: this.toPreviewBody(chart, 'SUN'),
      moon: this.toPreviewBody(chart, 'MOON'),
      ascendant: chart.angles.ascendant === null ? null : this.toPreviewBody(chart, 'ASCENDANT'),
      hasBirthTime: chart.hasBirthTime,
      hasBirthPlace: chart.hasBirthPlace,
    };

    return {
      // 会员给完整盘（chart），非会员给预览（preview）—— 两者互斥，不做"打码"
      preview: membership.isMember ? null : preview,
      chart: membership.isMember ? chart : null,
      access: {
        isMember: membership.isMember,
        chartUnlocked: membership.isMember,
        lockedSections: membership.isMember ? [] : LOCKED_SECTIONS,
        membershipHint: MEMBERSHIP_HINT,
        expireAt: membership.expireAt,
      },
      birthInfo: {
        birthday,
        birthTime: user.birthTime,
        birthPlace: user.birthPlace,
        birthLatitude: latitude,
        birthLongitude: longitude,
        placeResolvedFrom:
          user.birthLatitude !== null && user.birthLongitude !== null
            ? 'USER_INPUT'
            : latitude !== null && longitude !== null
              ? 'CITY_TABLE'
              : 'MISSING',
      },
      disclaimer,
    };
  }

  /** 出生城市搜索（给"出生地"选择器用；数据是内置静态表，不查库） */
  searchBirthCities(keyword: string | undefined): readonly BirthCity[] {
    return searchCities(keyword ?? '');
  }

  // ------------------------------------------------------------------ 内部

  /**
   * 从一个天体的位置构造预览条目
   *
   * ⚠ 预览**只给星座**，不给度数、不给宫位、不给相位 —— 度数就是专业用户
   * 真正想要的东西，免费给出去会员门槛就形同虚设。同时这里刻意只用
   * `sign` / `signName` / 元素 / 是否不可靠这几个字段，避免以后有人"顺手"
   * 把整个 `ChartPosition` 塞进预览里。
   */
  private toPreviewBody(chart: NatalChart, key: 'SUN' | 'MOON' | 'ASCENDANT'): ChartPreviewBody {
    const position =
      key === 'ASCENDANT' ? chart.angles.ascendant : (chart.positions.find((item) => item.key === key) ?? null);

    if (position === null) {
      // 理论上不可达（太阳与月亮恒存在）；给一个明确错误而不是 undefined 泄漏到响应里
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, `星盘缺少 ${key} 的位置`);
    }

    const profile = ZODIAC_PROFILES[position.sign];

    return {
      sign: position.sign,
      signName: position.signName,
      elementLabel: ZODIAC_ELEMENT_LABELS[profile.element].label,
      uncertain: position.uncertain,
    };
  }

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
