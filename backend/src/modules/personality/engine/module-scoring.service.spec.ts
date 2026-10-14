/**
 * 模块算分调度测试（ADR-038）
 *
 * 守两件事：
 *
 * 1. **分派不得改变结果** —— `score('PERSONALITY', input)` 必须与直接调用
 *    `PersonalityEngine.compute(input)` **逐字段相同**。否则"引入一层调度"
 *    就成了偷偷改算分，而算分结果连着全部存量画像与四类报告。
 *
 * 2. **未接入的模块必须显式报错** —— 不能返回空结果、也不能返回"全 50 的占位画像"。
 *    后者会被写进画像并顶掉 `isCurrent` 版本，让用户看到一份看起来正常、
 *    实际毫无意义的画像 —— 这正是 ADR-038 要消除的那类静默错误。
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { ModuleScoringService } from './module-scoring.service';
import { PersonalityEngine } from './personality-engine.service';
import { MBTI_DIMENSIONS, type EngineAnswer, type EngineQuestion } from './personality-engine.types';

/** 最小可用夹具：每个 MBTI 维度正反向各一，够驱动出非 null 的 MBTI 类型 */
const QUESTIONS: EngineQuestion[] = MBTI_DIMENSIONS.flatMap((dimension) => [
  {
    id: `q-${dimension}-f`,
    type: 'LIKERT5' as const,
    dimension,
    weight: 1,
    reverseScored: false,
    minValue: 1,
    maxValue: 5,
    options: [1, 2, 3, 4, 5].map((value) => ({ value, scoreMap: null })),
  },
  {
    id: `q-${dimension}-r`,
    type: 'LIKERT5' as const,
    dimension,
    weight: 1,
    reverseScored: true,
    minValue: 1,
    maxValue: 5,
    options: [1, 2, 3, 4, 5].map((value) => ({ value, scoreMap: null })),
  },
]);

const ANSWERS: EngineAnswer[] = QUESTIONS.map((question) => ({
  questionId: question.id,
  value: question.reverseScored ? 1 : 5,
  responseMs: 3000,
}));

const INPUT = { questions: QUESTIONS, answers: ANSWERS };

const createService = (): { scoring: ModuleScoringService; engine: PersonalityEngine } => {
  const engine = new PersonalityEngine();

  return { scoring: new ModuleScoringService(engine), engine };
};

describe('ModuleScoringService（ADR-038 模块算分调度）', () => {
  it('【关键】PERSONALITY 分派结果与直接调用引擎**逐字段相同**', () => {
    const { scoring, engine } = createService();

    // 逐字段深比较：不是"看着差不多"，而是完全一致
    expect(scoring.score('PERSONALITY', INPUT)).toEqual(engine.compute(INPUT));
  });

  it('【关键】未接入的模块显式报错，绝不返回空结果或占位画像', () => {
    const { scoring } = createService();

    for (const module of ['EMOTION', 'MENTAL_HEALTH'] as const) {
      expect(() => scoring.score(module, INPUT)).toThrow(BusinessException);

      try {
        scoring.score(module, INPUT);
        throw new Error('本应抛错');
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessException);
        expect((error as BusinessException).code).toBe(ErrorCode.PERSONALITY_PROFILE_BUILDING);
        // 报错文本要说清是"哪个模块没接入"，而不是一句笼统的"算分失败"
        expect((error as BusinessException).message).toContain(module);
      }
    }
  });

  it('`supports` 如实反映已接入的模块', () => {
    const { scoring } = createService();

    expect(scoring.supports('PERSONALITY')).toBe(true);
    expect(scoring.supports('EMOTION')).toBe(false);
    expect(scoring.supports('MENTAL_HEALTH')).toBe(false);
  });

  it('已接入模块清单可枚举（排障与"还差哪些模块"一眼可见）', () => {
    const { scoring } = createService();

    expect(scoring.registeredModules()).toEqual(['PERSONALITY']);
  });

  it('同一次调度内算分是纯函数：同一输入两次结果相同（ADR-005 可复现性）', () => {
    const { scoring } = createService();

    expect(scoring.score('PERSONALITY', INPUT)).toEqual(scoring.score('PERSONALITY', INPUT));
  });
});
