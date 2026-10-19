/**
 * 塔罗牌服务
 *
 * ## 职责边界
 *
 *   · **不落库**：牌阵结果由 `(用户 + 日期 + 牌阵)` 确定性生成，随时可复算；
 *   · **不画像**：塔罗是娱乐内容，不写任何 profile，也不参与测评结论；
 *   · **不调模型**：78 张牌的文案与牌阵解读都来自逐句过审的内容池，不经过 AI。
 */

import { Injectable } from '@nestjs/common';

import { TAROT_DECK } from './tarot-deck';
import { drawDailyCard } from './tarot-draw.util';
import { drawSpread, type SpreadReading } from './tarot-spread.util';
import { findSpread, TAROT_SPREADS, type TarotSpread } from './tarot-spreads';
import type { TarotCard, TarotDraw } from './tarot.types';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { SystemConfigService } from '../system/system-config.service';

/** 今日抽卡的响应（含服务端下发的娱乐性质声明） */
export interface DailyCardResponse extends TarotDraw {
  readonly disclaimer: string;
}

/** 牌阵抽卡的响应 */
export interface SpreadDrawResponse extends SpreadReading {
  readonly disclaimer: string;
}

@Injectable()
export class TarotService {
  constructor(private readonly systemConfig: SystemConfigService) {}

  /** 牌组（公开接口，给"牌义速查"用） */
  listDeck(): readonly TarotCard[] {
    return TAROT_DECK;
  }

  /** 全部牌阵（公开接口：选择页在未登录时也能看介绍） */
  listSpreads(): readonly TarotSpread[] {
    return TAROT_SPREADS;
  }

  /**
   * 今日单张（轻量玩法）
   *
   * 与牌阵并存：用户可能只想抽一张看今天，不想展开一个完整牌阵。
   */
  async getDailyCard(userId: string, date: string): Promise<DailyCardResponse> {
    const draw = drawDailyCard(TAROT_DECK, userId, date);

    return { ...draw, disclaimer: await this.loadDisclaimer() };
  }

  /**
   * 按牌阵抽卡 + 解读
   *
   * ⚠ 牌阵不存在时返回 400，**不回退到某个默认牌阵** ——
   * 回退会让用户以为自己在抽"时间之流"，实际拿到的是"今日指引"，
   * 而页面上的位置标签对不上牌义，属于最难排查的一类不一致。
   */
  async drawSpread(userId: string, date: string, spreadId: string): Promise<SpreadDrawResponse> {
    const spread = findSpread(spreadId);

    if (spread === null) {
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, '牌阵不存在，请重新选择');
    }

    const reading = drawSpread(TAROT_DECK, spread, userId, date);

    return { ...reading, disclaimer: await this.loadDisclaimer() };
  }

  /**
   * 娱乐性质声明
   *
   * 塔罗单独一个配置项 `disclaimer.tarot`（与星座分开）：塔罗要额外强调
   * "牌面代表的是象征而非事实" —— 星座谈"倾向"，塔罗更容易被读成"预言"。
   * 读不到时给兜底文案：塔罗内容没有这句声明就是合规风险。
   */
  private async loadDisclaimer(): Promise<string> {
    const config = await this.systemConfig.getPublicConfig({});
    const disclaimers = (config['disclaimers'] ?? {}) as Record<string, unknown>;
    const value = disclaimers['tarot'];

    return typeof value === 'string' && value.length > 0
      ? value
      : '塔罗牌是流行于西方的文化象征体系，本模块的牌义解读仅作娱乐与自我觉察之用，牌面代表的是象征意义而非事实，不构成任何预测、建议或决策依据。';
  }
}
