/**
 * 模块算分调度（ADR-038）
 *
 * ## 为什么需要这一层
 *
 * ADR-038 确立三个互不干扰的模块（人格 / 情感 / 心理健康），各自独立画像。
 * 而现状是：算分**没有"模块"这个概念** —— 分派键是 `question.dimension`，
 * 白名单硬编码在人格引擎里，MBTI 与大五是同一个 `compute()` 的两个固定输出字段。
 * 后果是"新增一类测评"必然走不通：题目被静默跳过 → `mbti.type === null` →
 * `submit()` 抛 `40011`（HTTP 500），**且用户已答的数据再也提交不了**。
 *
 * 本文件提供那个缺失的接缝：**按模块把算分派给对应的算分器**。
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

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { TestModule } from '@prisma/client';

import { PersonalityEngine } from './personality-engine.service';
import type { PersonalityEngineInput, PersonalityEngineOutput } from './personality-engine.types';

/**
 * 模块算分结果
 *
 * ⚠ 现阶段**只有人格模块有实现**，因此类型先收敛为 `PersonalityEngineOutput`。
 * 情感与心理健康模块接入时（阶段 3 / 4）再扩成按 `module` 区分的联合类型 ——
 * 那时会有真实的第二、第三个实现来驱动类型的形状，而不是现在凭空设计。
 */
export type ModuleScoringResult = PersonalityEngineOutput;

/** 一个模块的算分器 */
export interface ModuleScorer {
  /** 归属模块 */
  readonly module: TestModule;
  /** 人类可读名（日志与错误信息用） */
  readonly label: string;
  /** 执行算分（纯函数，无 I/O） */
  score(input: PersonalityEngineInput): ModuleScoringResult;
}

@Injectable()
export class ModuleScoringService {
  /** 模块 → 算分器。**显式表**，不用运行期注册（见文件头） */
  private readonly scorers: ReadonlyMap<TestModule, ModuleScorer>;

  constructor(personalityEngine: PersonalityEngine) {
    this.scorers = new Map<TestModule, ModuleScorer>([
      [
        'PERSONALITY',
        {
          module: 'PERSONALITY',
          label: 'MBTI 人格',
          /**
           * 直接委托给既有 `compute()` —— ADR-038 阶段 1 **刻意不改它的实现**：
           * 它已经被回归锁（`personality-engine.regression.spec.ts`）逐字段冻结。
           * 把它拆成独立 evaluator 属于机械搬迁，等情感模块真正需要时再做，
           * 那时有第二份实现可以对照，比现在凭想象拆更安全。
           */
          score: (input) => personalityEngine.compute(input),
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

  /**
   * 按模块算分
   *
   * @throws BusinessException 该模块的算分器尚未接入（`40011`）——
   *         绝不返回空结果或占位画像，理由见文件头
   */
  score(module: TestModule, input: PersonalityEngineInput): ModuleScoringResult {
    const scorer = this.scorers.get(module);

    if (scorer === undefined) {
      throw BusinessException.internal(
        ErrorCode.PERSONALITY_PROFILE_BUILDING,
        `模块「${module}」的算分器尚未接入，无法产出结果`,
        { module, registered: this.registeredModules().join(',') },
      );
    }

    return scorer.score(input);
  }
}
