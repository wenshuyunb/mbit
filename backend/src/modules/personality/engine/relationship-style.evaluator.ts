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

/**
 * 默认风格的**副本**
 *
 * 不能写成 `{ ...DEFAULT_RELATIONSHIP_STYLE }`：对象展开只复制属性，
 * `loveLanguage` 仍然是那个**模块级空数组的同一个引用**，于是"所有未命中规则的
 * 返回值共享一个数组"。任何一处对它 push，就会让此后进程内所有默认风格都多一项。
 * 空数组很便宜，每次新建即可。
 */
const emptyRelationshipStyle = (): RelationshipStyleResult => ({
  ...DEFAULT_RELATIONSHIP_STYLE,
  loveLanguage: [],
});

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
    return emptyRelationshipStyle();
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
        // 复制而不是直接引用 `rule.resultLoveLanguages`：那个数组属于**规则对象**，
        // 而规则对象在进程内是长期共享的（每次请求都从同一份表映射出来）。
        // 一旦某个消费方对结果里的数组做了 push/sort，就会把规则表本身改脏，
        // 而且这种污染会表现为"后来某个用户的爱的语言莫名多了一项"，极难定位
        loveLanguage: [...(rule.resultLoveLanguages ?? [])],
        conflictStyle: rule.resultConflictStyle ?? null,
        matchedRuleCode: rule.code,
      };
    }
  }

  return emptyRelationshipStyle();
};

/**
 * 供推导使用的大五数据源
 *
 * 与 {@link BigFiveResult} 的唯一区别是**允许 `null`**：画像表里这五列理论上可空
 * （历史脏数据、被清理过的行）。有了这个类型，调用方就不必为了通过类型检查
 * 先把 null 改成 50 —— 那会让"缺失"与"真的 50 分"在调用方被抹平成同一个值，
 * 而把这件事收敛到本文件里做，只有一个地方需要解释这个约定。
 */
export interface BigFiveSource {
  readonly openness: number | null;
  readonly conscientiousness: number | null;
  readonly extraversion: number | null;
  readonly agreeableness: number | null;
  readonly neuroticism: number | null;
}

/**
 * 画像上的大五分数 → 关系风格（ADR-038 的「按需推导」入口）
 *
 * ## 为什么需要它
 *
 * 依恋 / 爱的语言 / 冲突处理是**情感模块**的结论，但它们原先被**落库在人格画像上**
 * （`PersonalityProfile.attachmentStyle` 等四列），然后由情侣匹配、AI 人设、报告
 * 上下文各自去读列。ADR-038 判定这是模块越界，把四列删掉：人格画像只放人格数据。
 *
 * 但消费者还在，且情侣匹配（`REPORT_COMPATIBILITY_DEEP`）是付费产品，不能因为
 * 拆模块就停摆。因此它们改为**在需要时用同一份大五数据现算** —— 同一个
 * {@link resolveRelationshipStyle}、同一份输入、同一份规则表，所以**值不变**，
 * 只是把存储换成了计算。
 *
 * ## 语义上必须说清楚的两件事
 *
 * 1. **这是推导值，不是测量值**。情感模块（阶段 3）会用**自己的题目直接测量**依恋风格
 *    与爱的语言，那才是真实观测。本函数是"用户没做过情感测评"时的**兜底**，
 *    在文案里不能把它说成"你测出来是……"。待情感模块接上直接测量后，调用方应优先
 *    使用直接测量结果，仅在其缺失时才回落到这里。
 * 2. **它把"提交时冻结"改成了"读取时计算"**。原先的值在提交那一刻写死，之后改规则表
 *    不影响历史用户；现在改规则表会同时改变历史用户的推导值。这是 ADR-038 明确接受的
 *    代价（规则表是产品配置，不是用户数据），已在 `docs/CONTRACT_DRIFT_AUDIT.md` 记录。
 *
 * @param profile 画像上的五个大五分数，允许 `null`
 * @param rules   当前生效的关系风格规则（由调用方读 `relationship_style_rules` 后传入）
 */
export const deriveRelationshipStyleFromBigFive = (
  profile: BigFiveSource,
  rules: RelationshipStyleRule[],
): RelationshipStyleResult =>
  resolveRelationshipStyle(
    {
      // 与 PersonalityEngine.compute 的取值口径保持一致：缺失按中位 50 处理。
      // 正常落库的画像五列都非空，这里的兜底只为防御历史脏数据，不改变既有结果。
      openness: profile.openness ?? 50,
      conscientiousness: profile.conscientiousness ?? 50,
      extraversion: profile.extraversion ?? 50,
      agreeableness: profile.agreeableness ?? 50,
      neuroticism: profile.neuroticism ?? 50,
    },
    rules,
  );
