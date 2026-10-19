/**
 * 塔罗牌服务
 *
 * ## 职责边界
 *
 *   · **不落库**：今日牌由 `(用户 + 日期)` 确定性生成，随时可复算 ——
 *     不需要表、不需要迁移（与运势模块同一思路）；
 *   · **不画像**：塔罗是娱乐内容，不写任何 profile，也不参与测评结论；
 *   · **不调模型**：78 张牌的文案是逐张过审的内容池，不经过 AI。
 */

import { Injectable } from '@nestjs/common';

import { TAROT_DECK } from './tarot-deck';
import { drawDailyCard } from './tarot-draw.util';
import type { TarotCard, TarotDraw } from './tarot.types';
import { SystemConfigService } from '../system/system-config.service';

/** 今日抽卡的响应（含服务端下发的娱乐性质声明） */
export interface DailyCardResponse extends TarotDraw {
  readonly disclaimer: string;
}

@Injectable()
export class TarotService {
  constructor(private readonly systemConfig: SystemConfigService) {}

  /** 牌组（公开接口，给"牌义速查"用） */
  listDeck(): readonly TarotCard[] {
    return TAROT_DECK;
  }

  /**
   * 今日抽卡
   *
   * 同一天同一用户永远是同一张（`drawDailyCard` 的确定性由用例保证）。
   */
  async getDailyCard(userId: string, date: string): Promise<DailyCardResponse> {
    const draw = drawDailyCard(TAROT_DECK, userId, date);

    return { ...draw, disclaimer: await this.loadDisclaimer() };
  }

  /**
   * 娱乐性质声明
   *
   * 与星座共用 `disclaimer.zodiac` 吗？不 —— 两者的措辞不同（塔罗要额外说明
   * "不构成预测"），因此单独一个配置项 `disclaimer.tarot`，运营可以各改各的。
   * 读不到时给兜底文案：塔罗内容没有这句声明就是合规风险。
   */
  private async loadDisclaimer(): Promise<string> {
    const config = await this.systemConfig.getPublicConfig({});
    const disclaimers = (config['disclaimers'] ?? {}) as Record<string, unknown>;
    const value = disclaimers['tarot'];

    return typeof value === 'string' && value.length > 0
      ? value
      : '塔罗牌是流行于西方的文化象征体系，本模块仅作娱乐与自我觉察之用，不构成任何预测、建议或决策依据。';
  }
}
