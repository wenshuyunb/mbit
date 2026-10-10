/**
 * 关系风格规则求值器
 *
 * 设计目标（架构 §11.3）：
 *   · 关系风格推导规则**不写死在代码里**，而是存 `relationship_style_rules` 表，后台可调
 *   · 求值是纯函数：相同规则 + 相同分数 → 相同结果（可复现、可单测）
 *
 * 规则条件格式（`conditions` 字段的 JSON 结构）：
 *   {
 *     "all": [ { "field": "neuroticism", "op": "gte", "value": 60 }, ... ],
 *     "any": [ { "field": "extraversion", "op": "lt", "value": 45 }, ... ]
 *   }
 *   语义：`all` 中全部满足，且若存在 `any` 则至少满足一条。
 *
 * 匹配顺序：按 priority 升序，**首个命中即采用**（first-match-wins）——
 * 这让规则集可以被理解为一组有序的「诊断」条件，便于运营人员推理与调整。
 */

import type {
  BigFiveResult,
  ConditionPredicate,
  RelationshipRuleConditions,
  RelationshipStyleResult,
  RelationshipStyleRule,
} from './personality-engine.types';

/** 未命中任何规则时的默认风格 */
export const DEFAULT_RELATIONSHIP_STYLE: RelationshipStyleResult = {
  attachment: 'SECURE',
  loveLanguage: [],
  conflictStyle: null,
  matchedRuleCode: null,
};

/** 维度名归一化：允许规则中写 `Neuroticism` / `NEUROTICISM` / `neuroticism` */
const normalizeField = (field: string): string => field.trim().toLowerCase();

/** 大五结果 → 归一化小写键的查找表 */
const toFieldMap = (bigFive: BigFiveResult): Record<string, number> => ({
  openness: bigFive.openness,
  conscientiousness: bigFive.conscientiousness,
  extraversion: bigFive.extraversion,
  agreeableness: bigFive.agreeableness,
  neuroticism: bigFive.neuroticism,
});

/**
 * 判断单条断言是否成立
 *
 * 约定：**未知维度视为不满足**（fail-closed）。
 * 理由：规则里写了错别字（如 `extravertion`）时，若视为满足会让「错误规则」静默生效；
 *       视为不满足则会让该规则不命中，配合测试即可在配置阶段发现。
 */
export const evaluatePredicate = (predicate: ConditionPredicate, fields: Record<string, number>): boolean => {
  const field = normalizeField(predicate.field);
  const actual = fields[field];

  if (actual === undefined || !Number.isFinite(actual)) return false;

  switch (predicate.op) {
    case 'gte':
      return predicate.value !== undefined && actual >= predicate.value;
    case 'gt':
      return predicate.value !== undefined && actual > predicate.value;
    case 'lte':
      return predicate.value !== undefined && actual <= predicate.value;
    case 'lt':
      return predicate.value !== undefined && actual < predicate.value;
    case 'eq':
      return predicate.value !== undefined && actual === predicate.value;
    case 'between': {
      if (!predicate.range || predicate.range.length !== 2) return false;
      const [lower, upper] = predicate.range;
      // 区间为闭区间；若误写成 lower > upper 则自动纠正，避免配置失误导致规则永不命中
      const min = Math.min(lower, upper);
      const max = Math.max(lower, upper);
      return actual >= min && actual <= max;
    }
    default:
      return false;
  }
};

/**
 * 判断一组条件是否成立
 *
 * 空条件（无 all 也无 any）视为**不匹配** —— 否则一条空规则会命中所有用户，
 * 这在配置层面几乎总是笔误。
 */
export const evaluateConditions = (
  conditions: RelationshipRuleConditions | null | undefined,
  fields: Record<string, number>,
): boolean => {
  if (!conditions) return false;

  const all = conditions.all ?? [];
  const any = conditions.any ?? [];

  if (all.length === 0 && any.length === 0) return false;

  if (all.length > 0 && !all.every((predicate) => evaluatePredicate(predicate, fields))) {
    return false;
  }

  if (any.length > 0 && !any.some((predicate) => evaluatePredicate(predicate, fields))) {
    return false;
  }

  return true;
};

/**
 * 依据大五分数与规则表推导关系风格
 *
 * @param bigFive 大五分数
 * @param rules   规则集（调用方从数据库读入；引擎不访问数据库）
 */
export const resolveRelationshipStyle = (
  bigFive: BigFiveResult,
  rules: RelationshipStyleRule[] = [],
): RelationshipStyleResult => {
  if (rules.length === 0) {
    return { ...DEFAULT_RELATIONSHIP_STYLE };
  }

  const fields = toFieldMap(bigFive);

  // 按 priority 升序；同优先级按 code 字典序，保证结果稳定可复现
  const ordered = [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.code.localeCompare(b.code);
  });

  for (const rule of ordered) {
    if (evaluateConditions(rule.conditions, fields)) {
      return {
        attachment: rule.resultAttachment,
        loveLanguage: rule.resultLoveLanguages ?? [],
        conflictStyle: rule.resultConflictStyle ?? null,
        matchedRuleCode: rule.code,
      };
    }
  }

  return { ...DEFAULT_RELATIONSHIP_STYLE };
};
