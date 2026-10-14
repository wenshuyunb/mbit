/**
 * 关系风格规则表（`relationship_style_rules`）的**唯一读取口径**
 *
 * ## 为什么要有这个文件
 *
 * ADR-038 之前，依恋 / 爱的语言 / 冲突处理被**算在提交那一刻**并落库到人格画像的
 * 四列上：`test` 模块写、其余模块读列。四列删掉后，多个消费方都要**自己读规则表再现算**：
 *
 * | 消费方 | 用途 |
 * |---|---|
 * | `test.service.ts` | 提交时算分（结果回给用户，也是历史值的来源） |
 * | `compatibility.service.ts` | 情侣匹配的依恋 / 沟通两个子项 |
 * | `ai/report-generation.service.ts` | 关系报告的双方风格变量 |
 * | `ai/chat-context.service.ts` | AI 人设里的依恋与爱的语言 |
 *
 * 如果每个消费方各写一份 `findMany`，就会出现**同一份数据在不同页面结论不同**的
 * 经典隐患：比如有人给某处加了 `isActive: true` 而别处忘了，用户看到的"你是焦虑型"
 * 与匹配报告里用的"安全型"就对不上，而且没有任何报错。因此查询条件集中在这里，
 * 谁需要就调用这一个函数。
 *
 * ## 数据归属
 *
 * 关系风格属于**情感模块**（ADR-038）。本文件暂时放在 `personality/` 下，是因为
 * 现阶段 `PersonalityEngine` 仍是这套规则唯一的求值实现；阶段 3 情感模块落地、
 * 由它自己直接测量依恋与爱的语言后，本文件随之迁入情感模块，调用方改为优先使用
 * 直接测量值、仅缺失时回落到规则推导。
 *
 * ## 为什么要接收 `PrismaService` 而不是做成 `@Injectable()` Provider
 *
 * 三个消费方本来就已注入 `PrismaService`，做成 Provider 只会额外要求
 * `relationship` / `ai` 两个模块去 `imports: [PersonalityModule]`，
 * 白白增加模块耦合与循环依赖风险，而这里没有任何需要生命周期管理的东西。
 * 因此它是一个**无状态的读函数**：给一个 Prisma 客户端，返回引擎能直接吃的规则数组。
 *
 * @param prisma 调用方已注入的 Prisma 客户端
 * @returns 生效中的规则，按 `priority` 升序（引擎内部还会再按 code 兜底排序）
 */
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RelationshipStyleRule } from './engine/personality-engine.types';

export const loadRelationshipStyleRules = async (prisma: PrismaService): Promise<RelationshipStyleRule[]> => {
  const rows = await prisma.relationshipStyleRule.findMany({
    // 软删与停用的规则都不参与推导：规则表是产品配置，改配置即改所有人的推导值，
    // 因此"停用"必须真的立刻生效，不能留历史包袱
    where: { isActive: true, deletedAt: null },
    orderBy: { priority: 'asc' },
    select: {
      code: true,
      name: true,
      priority: true,
      conditions: true,
      resultAttachment: true,
      resultLoveLanguages: true,
      resultConflictStyle: true,
    },
  });

  return rows.map((rule) => ({
    code: rule.code,
    name: rule.name,
    priority: rule.priority,
    // `conditions` 是 `Json` 列：数据库不校验结构，只有引擎知道它该长什么样。
    // 这里只能断言，但 `evaluateConditions` 对畸形输入是 fail-closed（未知维度视为不满足），
    // 所以配置写错的表现是"该规则不命中"，而不是算分崩掉
    conditions: rule.conditions as unknown as RelationshipStyleRule['conditions'],
    resultAttachment: rule.resultAttachment,
    resultLoveLanguages: rule.resultLoveLanguages,
    resultConflictStyle: rule.resultConflictStyle,
  }));
};
