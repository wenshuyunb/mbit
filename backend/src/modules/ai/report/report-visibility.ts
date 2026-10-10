/**
 * 报告段落可见性判定（纯函数，无 I/O、可 100% 单测）
 *
 * ADR-004 的核心安全要求：**未解锁的段落不下发正文**，
 * 而不是「把全文发给前端，让前端隐藏」。
 *
 * 后者有两个致命问题：
 *   ① 抓包即可看到全文 —— 付费墙形同虚设
 *   ② 前端一旦有 bug（或有人改了渲染逻辑），付费内容直接暴露
 *
 * 本模块用**类型层面的保证**落实这一点：可见性对象的 `content` 字段
 * 在未解锁时只能是 `null`，且**整个类型里没有任何字段可以承载正文**。
 * 想泄露付费正文，必须主动新增一个字段 —— 而不是"忘了过滤"就会泄露。
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';

/** 段落（来自 `report_sections`） */
export interface SectionRecord {
  readonly sectionKey: string;
  readonly title: string;
  readonly content: string;
  readonly order: number;
  readonly isFreePreview: boolean;
}

/** 段落可见性（对外下发的形状） */
export interface SectionVisibility {
  readonly sectionKey: string;
  readonly title: string;
  readonly order: number;
  /** 是否属于免费预览段（与是否解锁无关：免费段永远可见） */
  readonly isFreePreview: boolean;
  /** 是否已解锁（可读全文） */
  readonly isUnlocked: boolean;
  /** 已解锁时为全文；**未解锁时为 null**（正文根本不出现在响应里） */
  readonly content: string | null;
  /** 未解锁时给前端展示的解锁提示（不含正文片段） */
  readonly lockedHint: string | null;
  /** 正文长度：未解锁时也可下发（只暴露体量，不算内容泄露） */
  readonly contentLength: number;
}

/** 可见性汇总（供列表页与前端判断） */
export interface VisibilitySummary {
  readonly totalSections: number;
  readonly unlockedSections: number;
  readonly lockedSections: number;
  /** 是否全部可读 */
  readonly isFullyUnlocked: boolean;
  /** 是否连一段都读不到（异常态：报告不应完全没有免费内容） */
  readonly isFullyLocked: boolean;
}

/** 未解锁提示文案 */
const LOCKED_HINT = '解锁后可阅读本段完整内容';

/** 判定单段是否解锁 */
const isSectionUnlocked = (
  section: SectionRecord,
  options: { allUnlocked: boolean; unlockedSectionKeys: ReadonlySet<string> },
): boolean => {
  // 免费预览段永远可见 —— 这是 ADR-004 给用户的最低保证
  if (section.isFreePreview) return true;
  if (options.allUnlocked) return true;
  return options.unlockedSectionKeys.has(section.sectionKey);
};

/**
 * 构建段落可见性列表
 *
 * @param sections 数据库中的段落（顺序以 `order` 为准，不信任入参顺序）
 * @param options 解锁状态：`allUnlocked` 表示整体已解锁（如会员）；否则按段落键逐个判断
 */
export const buildSectionViews = (
  sections: readonly SectionRecord[],
  options: { allUnlocked: boolean; unlockedSectionKeys: ReadonlySet<string> },
): SectionVisibility[] =>
  [...sections]
    .sort((a, b) => a.order - b.order)
    .map((section) => {
      const isUnlocked = isSectionUnlocked(section, options);

      return {
        sectionKey: section.sectionKey,
        title: section.title,
        order: section.order,
        isFreePreview: section.isFreePreview,
        isUnlocked,
        // 未解锁时正文**不进入响应对象**（而非置空字符串后由前端隐藏）
        content: isUnlocked ? section.content : null,
        lockedHint: isUnlocked ? null : LOCKED_HINT,
        contentLength: section.content.length,
      };
    });

/** 汇总可见性 */
export const summarizeVisibility = (views: readonly SectionVisibility[]): VisibilitySummary => {
  const unlockedSections = views.filter((view) => view.isUnlocked).length;

  return {
    totalSections: views.length,
    unlockedSections,
    lockedSections: views.length - unlockedSections,
    isFullyUnlocked: views.length > 0 && unlockedSections === views.length,
    isFullyLocked: unlockedSections === 0,
  };
};

/**
 * 断言段落列表可对外下发
 *
 * 两份报告都没有任何可读段落属于配置事故（模板没标任何免费段，用户也没解锁），
 * 此时应当显式失败并告警，而不是下发一个空壳报告让用户以为报告坏了。
 */
export const assertHasReadableSection = (summary: VisibilitySummary): void => {
  if (summary.totalSections === 0) {
    throw new BusinessException(ErrorCode.AI_REPORT_NOT_FOUND, '该报告暂无可阅读内容');
  }

  if (summary.isFullyLocked) {
    throw new BusinessException(ErrorCode.AI_REPORT_NOT_UNLOCKED, '该报告需要解锁后才能阅读，请先解锁');
  }
};
