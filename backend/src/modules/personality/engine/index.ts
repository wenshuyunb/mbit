/**
 * 人格引擎模块出口
 *
 * 只导出「纯逻辑」部分：类型契约、算法引擎、规则求值器、数学工具。
 * 访问数据库的 PersonalityService（画像读写、快照、画像查询接口）在下一阶段接入，
 * 与引擎保持**单向依赖**：Service → Engine，引擎永不反向依赖 Service。
 */

export { PersonalityEngine } from './personality-engine.service';
export {
  DEFAULT_RELATIONSHIP_STYLE,
  evaluateConditions,
  evaluatePredicate,
  resolveRelationshipStyle,
} from './relationship-style.evaluator';
export { clamp, mean, normalizeToUnit, roundTo } from './engine-math.util';
export * from './personality-engine.types';
