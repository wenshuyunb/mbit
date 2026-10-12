/**
 * AI 对话内容安全服务（契约 §3.7.5 规则 2/3、§3.7.6 规则 4）
 *
 * ## 两道防线，顺序不可颠倒
 *
 * ```
 * ① 关键词预筛（chat-safety.util.ts，纯函数，零延迟）
 *    └ 命中 → 🚫 不调用模型，直接返回固定关怀文案 + 转介资源
 * ② msgSecCheck（WechatService，架构 §10.5「发布前必接」）
 *    └ 命中 → 输入侧 50007 / 451（消息不入库）；输出侧 50019 / 422（回复丢弃）
 * ```
 *
 * 顺序不能反：先跑预筛能在**不产生任何外部调用**的前提下挡住危机场景（快且稳），
 * 而 `msgSecCheck` 依赖微信 access_token，本身就可能是不可用的那一个。
 *
 * ## fail-open 的正确范围
 *
 * `WechatService.msgSecCheck` 在服务异常时 **fail-open 放行**并返回 `checked: false`
 * （契约 §3.7.5 错误码 `90008` → 本项目 `CONFIG_MISSING`：内容安全服务异常，
 * fail-open 放行并记录审计，**不阻断对话**）。这是一个刻意的取舍，本服务**沿用**
 * 而不是改成 fail-closed：
 *   · fail-closed 时微信侧一次抖动就会让全站用户发不出消息，而这属于"可用性事故"；
 *   · 违规内容仍有事后处置手段（后台审核、举报、封禁）；
 *   · 而**危机场景不依赖微信**——它由 ① 的本地关键词预筛兜住。
 *
 * ⚠ 但 **输出侧** 有一个例外：`msgSecCheck` 判定**明确违规**（`pass = false` 且
 * `checked = true`）时必须丢弃回复。这里不会因为"已经花掉了 token"而放行 ——
 * 违规内容一旦落库就会被用户看到，成本已经沉没，不能把违规也一起交付。
 */

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../infra/prisma/prisma.service';
import { WechatService, type MsgSecCheckResult } from '../../../infra/wechat/wechat.service';
import { ChatQuotaService } from './chat-quota.service';
import {
  buildSafetyResponseContent,
  screenRiskContent,
  type RiskCategory,
  type RiskScreeningResult,
} from './chat-safety.util';
import {
  CONFIG_KEY_CRISIS_NOTICE,
  CONFIG_KEY_EMERGENCY_NOTICE,
  FALLBACK_CRISIS_NOTICE,
  FALLBACK_EMERGENCY_NOTICE,
  type SafetyResource,
} from './chat.types';

/** 单侧内容安全检测结果 */
export interface ContentCheckResult {
  /** 是否放行（`true` 时一定是"没发现问题"或"检测服务不可用而放行"） */
  readonly pass: boolean;
  /** 检测是否**真正执行**了（`false` = 服务未开启/调用失败 → fail-open 放行） */
  readonly checked: boolean;
  /** 微信侧判定：`pass` / `review` / `risky` / `unknown` */
  readonly suggest: string;
  /** 微信侧违规标签（用于后台排查，不下发前端） */
  readonly label: string | null;
}

/** 输入侧综合判定（预筛 + msgSecCheck） */
export interface InputSafetyResult {
  /** 关键词预筛结果（命中时调用方必须短路，不调用模型） */
  readonly risk: RiskScreeningResult;
  /** msgSecCheck 结果（预筛命中时**不执行**，此时 `checked = false`） */
  readonly content: ContentCheckResult;
}

/** 危险内容拦截的完整载荷（契约 §3.7.5「成功响应 200（危险内容拦截）」） */
export interface SafetyInterventionPayload {
  readonly category: RiskCategory;
  readonly content: string;
  readonly resources: readonly SafetyResource[];
  readonly crisisNotice: string;
  readonly emergencyNotice: string;
}

@Injectable()
export class ChatSafetyService {
  private readonly logger = new Logger(ChatSafetyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wechat: WechatService,
    private readonly quota: ChatQuotaService,
  ) {}

  // ==========================================================================
  // 输入侧
  // ==========================================================================

  /**
   * 输入侧综合检测
   *
   * 预筛命中时**跳过** `msgSecCheck`：那是一次外部 HTTP 调用，而结果已经注定被拦截 ——
   * 对危机场景而言，省下这几百毫秒的等待比"多一层审核结论"更有价值。
   */
  async checkInput(userId: string, content: string): Promise<InputSafetyResult> {
    const risk = screenRiskContent(content);

    if (risk.matched) {
      // 命中预筛时仍记录审计（契约要求写 `ai_call_audits` 的命中类别），但不送审
      this.logger.warn(`危险内容预筛命中 userId=${userId} category=${risk.category ?? 'UNKNOWN'}`);

      return { risk, content: { pass: true, checked: false, suggest: 'skipped', label: null } };
    }

    const openid = await this.resolveOpenid(userId);
    const result = await this.wechat.msgSecCheck(content, openid ?? undefined);

    return { risk, content: toCheckResult(result) };
  }

  // ==========================================================================
  // 输出侧
  // ==========================================================================

  /**
   * 输出侧内容安全检测（契约 §3.7.5 规则 3）
   *
   * 对 `msgSecCheck` 的 `openid` 传当前用户：微信 v2 接口用它做风控画像，
   * 缺失时接口仍可用，但判定会偏保守 —— 这里传真实 openid 是为了减少
   * "因为不知道是谁而一律拦下"的误报。
   */
  async checkOutput(userId: string, content: string): Promise<ContentCheckResult> {
    const openid = await this.resolveOpenid(userId);
    const result = await this.wechat.msgSecCheck(content, openid ?? undefined);

    return toCheckResult(result);
  }

  // ==========================================================================
  // 危机响应载荷
  // ==========================================================================

  /**
   * 组装危险内容拦截响应（文案 + 转介资源 + 提示语）
   *
   * 全部原料来自 `system_configs`（运营可改文案与热线），任何一项读不到都用
   * catalog 同源兜底 —— 危机路径**不允许**因为配置缺失而降级为"没有资源可给"。
   */
  async buildIntervention(category: RiskCategory): Promise<SafetyInterventionPayload> {
    const [resources, crisisNotice, emergencyNotice] = await Promise.all([
      this.quota.loadSafetyResources(),
      this.quota.readStringConfig(CONFIG_KEY_CRISIS_NOTICE, FALLBACK_CRISIS_NOTICE),
      this.quota.readStringConfig(CONFIG_KEY_EMERGENCY_NOTICE, FALLBACK_EMERGENCY_NOTICE),
    ]);

    return {
      category,
      content: buildSafetyResponseContent({ category, resources, crisisNotice, emergencyNotice }),
      resources,
      crisisNotice,
      emergencyNotice,
    };
  }

  /** 危机资源清单（`GET /ai/quota` 与详情接口的 `resources` 复用同一来源） */
  async resources(): Promise<readonly SafetyResource[]> {
    return this.quota.loadSafetyResources();
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /**
   * 取用户 openid
   *
   * 微信 `msgSecCheck` v2 的 `openid` 是**可选**参数，但传了判定更准。取不到
   * （未绑定微信账号、历史数据）不报错：内容安全检测的主体是文本，不是身份。
   *
   * 与 `user.service.ts` 的昵称检测走同一张表（`wechat_accounts`），
   * 保持"同一个用户在哪都是同一个 openid"的一致性。
   */
  private async resolveOpenid(userId: string): Promise<string | null> {
    try {
      const account = await this.prisma.wechatAccount.findFirst({
        where: { userId, deletedAt: null },
        select: { openid: true },
        orderBy: { createdAt: 'asc' },
      });

      return account?.openid ?? null;
    } catch (error) {
      this.logger.warn(`读取 openid 失败（不影响内容安全检测）userId=${userId}: ${(error as Error).message}`);
      return null;
    }
  }
}

/** `WechatService.msgSecCheck` 结果 → 本模块的检查结果 */
const toCheckResult = (result: MsgSecCheckResult): ContentCheckResult => ({
  pass: result.pass,
  checked: result.checked,
  suggest: result.suggest,
  label: result.label,
});
