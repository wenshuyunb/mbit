/**
 * 测评引擎的纯函数实现（**无 I/O**）
 *
 * ⚠ `ModuleScoringService`（按模块分派算分）**不在这里**：它要同时引用人格引擎与
 * 情感引擎，住在人格模块下就等于人格模块 import 情感模块 —— 那是 ADR-038 要消除的
 * 越界。它现在住在唯一的消费方 `test` 模块里（`test/module-scoring.service.ts`）。
 */

export { PersonalityEngine } from './personality-engine.service';
export { ENGINE_VERSION } from './personality-engine.types';
export type {
  BigFiveDimension,
  BigFiveResult,
  EngineAnswer,
  EngineQuestion,
  MbtiDimension,
  MbtiResult,
  PersonalityEngineInput,
  PersonalityEngineOutput,
  QualityMetrics,
  RelationshipStyleRule,
} from './personality-engine.types';

export { clamp, mean, normalizeToUnit, roundTo } from './engine-math.util';

export {
  DEFAULT_RELATIONSHIP_STYLE,
  deriveRelationshipStyleFromBigFive,
  resolveRelationshipStyle,
} from './relationship-style.evaluator';
export type { BigFiveSource } from './relationship-style.evaluator';
