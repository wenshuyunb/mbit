/**
 * 星盘解读服务
 *
 * ## 三条职责
 *
 *   ① **组装解读**：把用户的本命星盘变成一份"人话版"解读。
 *      AI 可用时用模型写；不可用 / 失败 / 超时时回退到确定性模板（永远有内容）。
 *   ② **缓存**：星盘是**静态**的（出生数据不变，解读就不变），
 *      同一份盘（`chartHash` 相同）永远复用同一份解读 —— 一个用户一辈子只烧一次调用。
 *   ③ **解锁判定**：首段免费；完整章节需要会员 / 单次购买 / 邀请解锁。
 *      三种解锁都走 `entitlements`（`ZODIAC_READING`），判定只有一条路径。
 *
 * ## 为什么 AI 生成是"用户点一下才生成"，而不是自动后台跑
 *
 * 解读只生成一次，成本极低；但如果**自动**触发，那么每个只是点进星盘页的用户
 * 都会消耗一次调用（包括那些根本不看解读的人）。改成显式动作（`POST .../generate`）
 * 后，只为真正想看的人花钱 —— 这也是它敢做成同步接口的前提（一次调用，几十秒可接受）。
 *
 * 副作用是"等 20 秒"，因此 `GET .../reading` 永远先返回模板版：用户立刻有内容可看，
 * AI 版在生成完成后覆盖同一行，下次刷新即见。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { LlmProviderFactory } from '../ai/provider/llm-provider.factory';
import { EntitlementService } from '../membership/entitlement.service';
import { hasActiveMembership, isEntitlementActive } from '../membership/entitlement.util';
import { SystemConfigService } from '../system/system-config.service';
import { buildNatalChart, type NatalChart } from './zodiac-chart.util';
import {
  buildReadingUserPrompt,
  parseReadingSections,
  READING_MAX_SECTIONS,
  READING_SYSTEM_PROMPT,
} from './zodiac-reading.prompt';
import { buildChartHash, buildTemplateReading, type ReadingSection } from './zodiac-reading.util';

/** 生成模式的单次最大输出 token：给足 6 章但不出书 */
const READING_MAX_TOKENS = 2600;

/** 生成超时：模型写 6 章通常 10–30 秒，超过 45 秒就当失败回退模板 */
const READING_TIMEOUT_MS = 45_000;

/** 解锁来源 */
export type ReadingUnlockSource = 'MEMBERSHIP' | 'PURCHASE' | 'INVITE' | null;

/** 解读接口的解锁信息 */
export interface ReadingAccess {
  readonly unlocked: boolean;
  readonly source: ReadingUnlockSource;
  /** 邀请解锁的当天有效期（到当日 24:00）；永久或会员为 null */
  readonly expireAt: string | null;
  /** 单次购买是否已接通（微信支付商户号未配置时为 false） */
  readonly purchaseAvailable: boolean;
  /** 面向前端的解锁说明（服务端下发，前端不得硬编码） */
  readonly hint: string;
}

/** 解读响应 */
export interface ZodiacReadingResponse {
  readonly status: 'READY' | 'PENDING' | 'FAILED';
  /** 解读来源：模板 / AI */
  readonly source: 'TEMPLATE' | 'AI';
  /** 免费首段（不需要解锁） */
  readonly preview: string;
  /** 完整章节：未解锁时为 null（**不返回、不打码**） */
  readonly sections: readonly ReadingSection[] | null;
  readonly access: ReadingAccess;
  /** 章节总数（未解锁时也告诉用户"完整解读共几章、多少字"） */
  readonly totalSections: number;
  readonly totalChars: number;
  readonly generatedAt: string | null;
  readonly disclaimer: string;
}

/** 用户出生信息（读一次给多处用） */
interface BirthRow {
  birthday: Date | null;
  birthTime: string | null;
  birthPlace: string | null;
  birthLatitude: number | null;
  birthLongitude: number | null;
  birthTimezoneOffset: number | null;
}

/** 解读行的最小形状（`toResponse` 只用到这几个字段） */
interface ZodiacReadingRow {
  id: string;
  status: string;
  source: string;
  preview: string;
  sections: unknown;
  generatedAt: Date | null;
}

@Injectable()
export class ZodiacReadingService {
  private readonly logger = new Logger(ZodiacReadingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly systemConfig: SystemConfigService,
    private readonly llmFactory: LlmProviderFactory,
  ) {}

  /**
   * 读取（必要时先按模板落地一份）解读
   *
   * ⚠ 这里**不触发 AI**：只保证"有一份可看的内容"。AI 版本由 `generateWithAi` 覆盖。
   */
  async getReading(userId: string): Promise<ZodiacReadingResponse> {
    const chart = await this.loadChart(userId);
    const chartHash = buildChartHash(chart);

    const existing = await this.prisma.zodiacReading.findUnique({
      where: { userId_chartHash: { userId, chartHash } },
    });

    const row = existing ?? (await this.createTemplateReading(userId, chart, chartHash));
    const access = await this.resolveAccess(userId);

    return this.toResponse(row, access);
  }

  /**
   * 用 AI 重写这份解读（用户显式点"生成"时才调用）
   *
   * 失败一律**回退到已有内容**（模板或上一次的 AI 版），并返回当前内容而不是报错：
   * 用户点了一次"生成"，最差的结果也应该是"看到内容"，而不是一个红色错误。
   */
  async generateWithAi(userId: string): Promise<ZodiacReadingResponse> {
    const chart = await this.loadChart(userId);
    const chartHash = buildChartHash(chart);

    const existing = await this.prisma.zodiacReading.findUnique({
      where: { userId_chartHash: { userId, chartHash } },
    });

    const base = existing ?? (await this.createTemplateReading(userId, chart, chartHash));

    const provider = this.llmFactory.listConfigured().length > 0 ? this.safeResolveProvider() : null;

    if (provider === null) {
      // 没配任何 Key：明确告诉前端"AI 不可用"，但内容照常给
      this.logger.log(`未配置任何 LLM Provider，星盘解读保持模板版 userId=${userId}`);

      return this.toResponse(base, await this.resolveAccess(userId));
    }

    try {
      const result = await provider.complete({
        messages: [
          { role: 'system', content: READING_SYSTEM_PROMPT },
          { role: 'user', content: buildReadingUserPrompt(chart) },
        ],
        responseFormat: 'json',
        maxTokens: READING_MAX_TOKENS,
        timeoutMs: READING_TIMEOUT_MS,
        temperature: 0.7,
      });

      const sections = parseReadingSections(result.json);

      if (sections === null) {
        this.logger.warn(`星盘解读 AI 返回格式不合格，保持模板版 userId=${userId}`);

        return this.toResponse(base, await this.resolveAccess(userId));
      }

      const updated = await this.prisma.zodiacReading.update({
        where: { id: base.id },
        data: {
          status: 'READY',
          source: 'AI',
          sections,
          model: result.model,
          error: null,
          generatedAt: new Date(),
        },
      });

      return this.toResponse(updated, await this.resolveAccess(userId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`星盘解读 AI 生成失败，回退已有内容 userId=${userId} reason=${message}`);

      // 失败不覆盖已有内容：模板版仍然可用，用户点了"生成"也不会看到空白
      await this.prisma.zodiacReading.update({
        where: { id: base.id },
        data: { error: message.slice(0, 250) },
      });

      return this.toResponse(base, await this.resolveAccess(userId));
    }
  }

  // ------------------------------------------------------------------ 内部

  /** 取一个可用 Provider（配置异常时不抛错，交给调用方回退） */
  private safeResolveProvider(): ReturnType<LlmProviderFactory['resolveAvailable']> | null {
    try {
      return this.llmFactory.resolveAvailable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`解析 LLM Provider 失败，星盘解读回退模板：${message}`);

      return null;
    }
  }

  /** 读出生信息 → 算星盘（缺生日时 30019，前端据此引导） */
  private async loadChart(userId: string): Promise<NatalChart> {
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

    const chart = this.buildChartFrom(user);

    return chart;
  }

  private buildChartFrom(user: BirthRow): NatalChart {
    if (user.birthday === null) {
      throw BusinessException.badRequest(ErrorCode.ZODIAC_BIRTHDAY_REQUIRED, '请先选择你的出生日期');
    }

    return buildNatalChart({
      birthday: user.birthday.toISOString().slice(0, 10),
      birthTime: user.birthTime,
      birthPlace: user.birthPlace,
      birthLatitude: user.birthLatitude,
      birthLongitude: user.birthLongitude,
      birthTimezoneOffset: user.birthTimezoneOffset,
    });
  }

  /** 首次访问：用模板落地一份（保证"永远有内容"） */
  private async createTemplateReading(userId: string, chart: NatalChart, chartHash: string): Promise<ZodiacReadingRow> {
    const reading = buildTemplateReading(chart);

    return this.prisma.zodiacReading.upsert({
      where: { userId_chartHash: { userId, chartHash } },
      create: {
        userId,
        chartHash,
        status: 'READY',
        source: 'TEMPLATE',
        preview: reading.preview,
        // 展开成普通对象：Prisma 的 Json 入参要求可索引的对象字面量，
        // 而 `ReadingSection` 是 readonly 接口（不满足隐式索引签名）
        sections: reading.sections.map((section) => ({ key: section.key, title: section.title, body: section.body })),
        generatedAt: new Date(),
      },
      // 并发下另一个请求先建好了：直接用它（不覆盖 AI 版）
      update: {},
    });
  }

  /**
   * 解锁判定
   *
   * 三种来源，优先级：会员 > 单次购买 > 邀请解锁。
   * 三者都读 `entitlements`，因此"是否已解锁"只有一条判定路径
   * （`isEntitlementActive`），不会出现两套过期逻辑。
   */
  private async resolveAccess(userId: string): Promise<ReadingAccess> {
    const entitlements = await this.entitlement.loadEntitlements(userId);
    const now = new Date();

    if (hasActiveMembership(entitlements, now)) {
      const membership = await this.entitlement.getMembership(userId);

      return {
        unlocked: true,
        source: 'MEMBERSHIP',
        expireAt: membership.expireAt,
        purchaseAvailable: false,
        hint: '会员期间可以看完整解读。',
      };
    }

    const readingEntitlements = entitlements.filter(
      (item) => item.type === 'ZODIAC_READING' && isEntitlementActive(item, now),
    );

    // 有永久权益（expireAt 为空）视为购买；否则是邀请解锁（当天有效）
    const permanent = readingEntitlements.find((item) => item.expireAt === null);

    if (permanent !== undefined) {
      return {
        unlocked: true,
        source: 'PURCHASE',
        expireAt: null,
        purchaseAvailable: true,
        hint: '这份解读已解锁，可以随时回来查看。',
      };
    }

    if (readingEntitlements.length > 0) {
      const expireAt = readingEntitlements
        .map((item) => item.expireAt)
        .filter((value): value is Date => value !== null)
        .sort((left, right) => right.getTime() - left.getTime())[0];

      return {
        unlocked: true,
        source: 'INVITE',
        expireAt: expireAt?.toISOString() ?? null,
        purchaseAvailable: true,
        hint: '邀请好友解锁的完整解读**今天有效**，明天会重新上锁。想要长期查看可以开通会员或单次解锁。',
      };
    }

    return {
      unlocked: false,
      source: null,
      expireAt: null,
      purchaseAvailable: true,
      hint: '首段是免费的。完整解读可以：开通会员、单次解锁，或邀请一位**新用户**注册（当天有效）。',
    };
  }

  /** 组装响应（**未解锁时 sections 直接为 null，不是打码**） */
  private async toResponse(row: ZodiacReadingRow, access: ReadingAccess): Promise<ZodiacReadingResponse> {
    const sections = Array.isArray(row.sections) ? (row.sections as ReadingSection[]) : [];
    const totalChars = sections.reduce((sum, section) => sum + section.body.length, 0);

    return {
      status: row.status as ZodiacReadingResponse['status'],
      source: row.source as ZodiacReadingResponse['source'],
      preview: row.preview,
      sections: access.unlocked ? sections.slice(0, READING_MAX_SECTIONS) : null,
      access,
      totalSections: sections.length,
      totalChars,
      generatedAt: row.generatedAt === null ? null : row.generatedAt.toISOString(),
      disclaimer: await this.loadDisclaimer(),
    };
  }

  /** 娱乐性质声明（与运势共用同一份配置，读不到时给兜底文案） */
  private async loadDisclaimer(): Promise<string> {
    const config = await this.systemConfig.getPublicConfig({});
    const disclaimers = (config['disclaimers'] ?? {}) as Record<string, unknown>;
    const value = disclaimers['zodiac'];

    return typeof value === 'string' && value.length > 0
      ? value
      : '星座内容属于娱乐性质的传统文化解读，仅供消遣参考，不构成任何预测、建议或决策依据。';
  }
}
