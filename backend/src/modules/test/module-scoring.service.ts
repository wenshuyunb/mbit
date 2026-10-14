/**
 * 模块算分调度（ADR-038）
 *
 * ## 为什么需要这一层
 *
 * ADR-038 确立三个互不干扰的模块（人格 / 情感 / 心理健康），各自独立画像。
 * 而阶段 1 之前算分**没有"模块"这个概念** —— 分派键是 `question.dimension`，
 * 白名单硬编码在人格引擎里，MBTI 与大五是同一个 `compute()` 的两个固定输出字段。
 * 后果是"新增一类测评"必然走不通：题目被静默跳过 → `mbti.type === null` →
 * `submit()` 抛 `40011`（HTTP 500），**且用户已答的数据再也提交不了**。
 *
 * 本文件提供那个缺失的接缝：**按模块把算分派给对应的算分器**。
 *
 * ## 为什么它住在 `test/` 而不是某个模块里
 *
 * 它要同时引用人格引擎与情感引擎。放在 `personality/engine/` 下的话，
 * 人格模块就会 import 情感模块 —— 而"三个模块互不干扰"不允许这种事，
 * 哪怕只是 import。放在**唯一的消费方**（`test` 模块，即测评管道）里，
 * 依赖方向就变成 `test → personality` + `test → emotion`，两条都是单向的。
 *
 * ## 为什么不用"动态注册 + 自动发现"
 *
 * 只有三个模块、且都是编译期已知的，做成运行期可注册的插件表只会增加
 * "谁在什么时候注册了它"的隐式时序问题（Nest 的 provider 初始化顺序、
 * 测试里注册顺序泄漏到彼此）—— 那是过度设计。
 * 这里用**显式的表**：加模块就是在构造函数里加一行，一眼能看全有几个实现。
 *
 * ## 未接入的模块必须**显式报错**
 *
 * 按本项目一贯的取舍（宁可明确失败也不产出假结果）：对尚未接入的模块抛错，
 * 而不是返回一个"空结果"或"全 50 的占位画像"。后者会被写进画像、顶掉
 * `isCurrent` 版本，让用户看到一份**看起来正常、实际毫无意义**的画像 ——
 * 这正是 ADR-038 要消除的那类问题。
 */

import { Injectable } from '@nestjs/common';
import type { TestModule } from '@prisma/client';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { EmotionEngine } from '../emotion/engine/emotion-engine.service';
import type { EmotionEngineInput, EmotionEngineOutput } from '../emotion/engine/emotion-engine.types';
import { PersonalityEngine } from '../personality/engine/personality-engine.service';
import type { PersonalityEngineInput, PersonalityEngineOutput } from '../personality/engine/personality-engine.types';

/**
 * 模块算分结果 —— **按模块区分的联合类型**
 *
 * 阶段 1 时这里只是 `PersonalityEngineOutput`，注释写着"等有第二个实现再扩成联合类型，
 * 那时有真实的实现来驱动形状，而不是凭空设计"。现在情感模块落地，正是那个时候：
 *
 *   · `PERSONALITY`   → `PersonalityEngineOutput`（MBTI + 大五 + 关系风格）
 *   · `EMOTION`       → `EmotionEngineOutput`（依恋双轴 + 爱的语言排序 + 冲突风格）
 *   · `MENTAL_HEALTH` → 待阶段 4 接入（现在没有这个成员，漏了会被编译器抓住）
 *
 * 判别靠**在分派处收窄**（见 `score()`）：调用方本来就按 `session.testDefinition.module`
 * 走各自的落库分支，因此不需要在类型里再挂一个 `module` 字段来运行时判别。
 */
export type ModuleScoringResult = PersonalityEngineOutput | EmotionEngineOutput;

/** 一个模块的算分器（`input` 的具体形状由实现自己收窄） */
export interface ModuleScorer {
  /** 归属模块 */
  readonly module: TestModule;
  /** 人类可读名（日志与错误信息用） */
  readonly label: string;
  /** 执行算分（纯函数，无 I/O） */
  readonly score: (input: never) => ModuleScoringResult;
}

@Injectable()
export class ModuleScoringService {
  /** 模块 → 算分器。**显式表**，不用运行期注册（见文件头） */
  private readonly scorers: ReadonlyMap<TestModule, ModuleScorer>;

  constructor(personalityEngine: PersonalityEngine, emotionEngine: EmotionEngine) {
    this.scorers = new Map<TestModule, ModuleScorer>([
      [
        'PERSONALITY',
        {
          module: 'PERSONALITY',
          label: 'MBTI 人格',
          /**
           * 直接委托给既有 `compute()` —— ADR-038 **刻意不重写它的实现**：
           * 它已被回归锁（`personality-engine.regression.spec.ts`）逐字段冻结，
           * 而全部存量画像与四类报告都压在它上面。
           */
          score: (input: PersonalityEngineInput) => personalityEngine.compute(input),
        },
      ],
      [
        'EMOTION',
        {
          module: 'EMOTION',
          label: '情感测评',
          score: (input: EmotionEngineInput) => emotionEngine.compute(input),
        },
      ],
    ]);
  }

  /** 该模块是否已接入算分 */
  supports(module: TestModule): boolean {
    return this.scorers.has(module);
  }

  /** 已接入的模块（用于排障与测试断言） */
  registeredModules(): TestModule[] {
    return [...this.scorers.keys()];
  }

  /** 模块的中文名（错误信息用；未接入时回落模块枚举值本身） */
  labelOf(module: TestModule): string {
    return this.scorers.get(module)?.label ?? module;
  }

  /** 按模块算分，**人格模块**的结果（调用方必须先确认模块） */
  scorePersonality(module: TestModule, input: PersonalityEngineInput): PersonalityEngineOutput {
    const result = this.dispatch(module, input);

    if (!isPersonalityOutput(result)) {
      throw BusinessException.internal(
        ErrorCode.PERSONALITY_PROFILE_BUILDING,
        `模块「${module}」的结果不是人格结果，不能写入人格画像`,
        { module },
      );
    }

    return result;
  }

  /** 按模块算分，**情感模块**的结果 */
  scoreEmotion(module: TestModule, input: EmotionEngineInput): EmotionEngineOutput {
    const result = this.dispatch(module, input);

    if (!isEmotionOutput(result)) {
      throw BusinessException.internal(
        ErrorCode.EMOTION_PROFILE_BUILDING,
        `模块「${module}」的结果不是情感结果，不能写入情感画像`,
        { module },
      );
    }

    return result;
  }

  /**
   * 按模块分派（**类型不安全的底层入口**，业务代码请用 `scorePersonality` / `scoreEmotion`）
   *
   * 之所以把它暴露出来：`supports()` 与错误信息需要它，
   * 而两个具名入口在拿到结果后必须做运行时判别（联合类型收窄），
   * 那一步无法在类型层面完成 —— 分派表里的 `score` 是异质函数，
   * TypeScript 无法从 `module` 推出 `input`/输出类型。
   *
   * @throws BusinessException 该模块的算分器尚未接入（`40011`）——
   *         绝不返回空结果或占位画像，理由见文件头
   */
  dispatch(module: TestModule, input: unknown): ModuleScoringResult {
    const scorer = this.scorers.get(module);

    if (scorer === undefined) {
      throw BusinessException.internal(
        ErrorCode.PERSONALITY_PROFILE_BUILDING,
        `模块「${module}」的算分器尚未接入，无法产出结果`,
        { module, registered: this.registeredModules().join(',') },
      );
    }

    return (scorer.score as (value: unknown) => ModuleScoringResult)(input);
  }
}

/** 运行时判别：人格输出（有 `mbti` 与 `bigFive`） */
export const isPersonalityOutput = (result: ModuleScoringResult): result is PersonalityEngineOutput =>
  'mbti' in result && 'bigFive' in result;

/** 运行时判别：情感输出（有 `attachment` 与 `loveLanguage`） */
export const isEmotionOutput = (result: ModuleScoringResult): result is EmotionEngineOutput =>
  'attachment' in result && 'loveLanguage' in result;
