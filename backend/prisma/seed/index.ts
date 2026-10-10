/**
 * 数据库种子脚本
 *
 * 运行：pnpm --filter @soulmap/server prisma:seed
 *
 * 设计原则：
 *   · **幂等**：全部使用 upsert（按唯一业务键），可反复执行而不产生重复数据
 *   · **题量以实际灌入为准**：`TestDefinition.questionCount` 由脚本回填，
 *     杜绝「定义声称 60 题、实际只有 32 题」导致运行期下发残缺试卷
 *   · **题库是数据不是代码**：题目内容来自 `data/*.ts`，生产环境可在后台增删改；
 *     本脚本只负责首次灌入与更新种子内容
 *   · **失败即退出**：任何一步失败都以非 0 退出码结束，避免 CI 误判为成功
 */

import { PrismaClient, type Dimension, type Prisma, type QuestionType } from '@prisma/client';

import { BIG_FIVE_QUESTIONS, MBTI_QUESTIONS } from './data';
import { RELATIONSHIP_STYLE_RULES } from './data/relationship-rules';
import { COMPATIBILITY_WEIGHTS } from './data/compatibility-weights';
import { PROMPT_TEMPLATES } from './data/prompt-templates';
import { TEST_DEFINITIONS } from './data/test-definitions';
import type { SeedQuestion } from './types';
const prisma = new PrismaClient();

/** 李克特 5 点量表的选项定义（所有 LIKERT5 题目共用） */
const LIKERT5_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '非常不同意', value: 1 },
  { label: '不同意', value: 2 },
  { label: '中立', value: 3 },
  { label: '同意', value: 4 },
  { label: '非常同意', value: 5 },
];

/** 题目所属的定义编码映射 */
const QUESTION_SETS: Array<{ definitionCode: string; questions: SeedQuestion[] }> = [
  { definitionCode: 'MBTI_LITE', questions: MBTI_QUESTIONS },
  { definitionCode: 'BIG_FIVE_50', questions: BIG_FIVE_QUESTIONS },
];

interface SeedSummary {
  definitions: number;
  questions: number;
  options: number;
  rules: number;
  /** Prompt 模板数（`seedQuestionsFor` 不产出该字段，故可选） */
  promptTemplates?: number;
  /** 匹配权重矩阵数 */
  compatibilityWeights?: number;
}

// ============================================================================
// 校验
// ============================================================================

/**
 * 灌库前校验种子数据自身的一致性
 *
 * 这些错误若流到数据库，会在**用户答题时**才暴露（如某维度题量为 0 导致算不出分），
 * 因此必须在灌库前拦住。
 */
const validateSeedData = (): void => {
  const errors: string[] = [];
  const seenCodes = new Set<string>();

  for (const { definitionCode, questions } of QUESTION_SETS) {
    if (questions.length === 0) {
      errors.push(`定义 ${definitionCode} 没有任何题目`);
      continue;
    }

    const perDimension = new Map<string, { total: number; reverse: number }>();

    for (const question of questions) {
      if (seenCodes.has(question.code)) {
        errors.push(`题目编码重复：${question.code}`);
      }
      seenCodes.add(question.code);

      if (question.content.trim().length < 6) {
        errors.push(`题干过短：${question.code}`);
      }

      const stats = perDimension.get(question.dimension) ?? { total: 0, reverse: 0 };
      stats.total += 1;
      if (question.reverseScored) stats.reverse += 1;
      perDimension.set(question.dimension, stats);
    }

    for (const [dimension, stats] of perDimension) {
      // 少于 2 题无法构成有意义的维度得分
      if (stats.total < 2) {
        errors.push(`定义 ${definitionCode} 的维度 ${dimension} 仅有 ${stats.total} 题（至少 2 题）`);
      }
      // 只有正向题或只有反向题时一致性评分无法计算（引擎会跳过该维度）
      if (stats.reverse === 0) {
        errors.push(`定义 ${definitionCode} 的维度 ${dimension} 缺少反向题（会影响一致性评分）`);
      }
    }
  }

  // 关系风格规则必须能覆盖所有用户：最后一条应是「永远成立」的兜底规则
  const hasFallback = RELATIONSHIP_STYLE_RULES.some((rule) =>
    rule.conditions.all?.some((predicate) => predicate.op === 'gte' && predicate.value === 0),
  );
  if (!hasFallback) {
    errors.push('关系风格规则缺少兜底规则（可能导致部分用户得不到任何风格）');
  }

  if (errors.length > 0) {
    throw new Error(`种子数据校验失败：\n  - ${errors.join('\n  - ')}`);
  }
};

// ============================================================================
// 灌库
// ============================================================================

const seedDefinitions = async (): Promise<number> => {
  for (const definition of TEST_DEFINITIONS) {
    await prisma.testDefinition.upsert({
      where: { code: definition.code },
      create: {
        code: definition.code,
        name: definition.name,
        category: definition.category,
        description: definition.description,
        version: definition.version,
        status: definition.status,
        isActive: definition.isActive,
        estimatedMinutes: definition.estimatedMinutes,
        selectionMode: definition.selectionMode,
        dimensionQuotas: definition.dimensionQuotas ?? undefined,
        sortOrder: definition.sortOrder,
      },
      update: {
        name: definition.name,
        description: definition.description,
        version: definition.version,
        status: definition.status,
        isActive: definition.isActive,
        estimatedMinutes: definition.estimatedMinutes,
        selectionMode: definition.selectionMode,
        dimensionQuotas: definition.dimensionQuotas ?? undefined,
        sortOrder: definition.sortOrder,
      },
    });
  }

  return TEST_DEFINITIONS.length;
};

const seedQuestionsFor = async (definitionCode: string, questions: SeedQuestion[]): Promise<SeedSummary> => {
  const definition = await prisma.testDefinition.findUnique({
    where: { code: definitionCode },
    select: { id: true },
  });

  if (!definition) {
    throw new Error(`未找到测试定义 ${definitionCode}（请先执行 seedDefinitions）`);
  }

  let optionCount = 0;

  for (const question of questions) {
    const questionData = {
      testDefinitionId: definition.id,
      content: question.content,
      type: 'LIKERT5' as QuestionType,
      dimension: question.dimension as Dimension,
      weight: question.weight ?? 1,
      reverseScored: question.reverseScored,
      order: question.order,
      isActive: true,
      tags: question.tags,
      minValue: 1,
      maxValue: 5,
    };

    const saved = await prisma.question.upsert({
      where: { code: question.code },
      create: { code: question.code, ...questionData },
      update: questionData,
      select: { id: true },
    });

    // 选项：LIKERT5 统一为 1–5（选项中不写 scoreMap，由引擎按 value 计算维度分）
    for (const [index, option] of LIKERT5_OPTIONS.entries()) {
      await prisma.questionOption.upsert({
        where: { questionId_order: { questionId: saved.id, order: index } },
        create: {
          questionId: saved.id,
          label: option.label,
          value: option.value,
          scoreMap: {},
          order: index,
          isActive: true,
        },
        update: {
          label: option.label,
          value: option.value,
          isActive: true,
        },
      });
      optionCount += 1;
    }
  }

  // 题量回填：以实际灌入的题目数为准
  await prisma.testDefinition.update({
    where: { code: definitionCode },
    data: { questionCount: questions.length },
  });

  return { definitions: 0, questions: questions.length, options: optionCount, rules: 0 };
};

const seedRelationshipRules = async (): Promise<number> => {
  for (const rule of RELATIONSHIP_STYLE_RULES) {
    const data = {
      name: rule.name,
      description: rule.description ?? null,
      priority: rule.priority,
      conditions: rule.conditions as unknown as object,
      resultAttachment: rule.resultAttachment,
      resultLoveLanguages: rule.resultLoveLanguages,
      resultConflictStyle: rule.resultConflictStyle,
      isActive: true,
      version: '1.0.0',
    };

    await prisma.relationshipStyleRule.upsert({
      where: { code: rule.code },
      create: { code: rule.code, ...data },
      update: data,
    });
  }

  return RELATIONSHIP_STYLE_RULES.length;
};

/**
 * 灌入 Prompt 模板与初始版本
 *
 * 三步顺序不可颠倒：模板 → 版本 → 回填 `activeVersionId`。
 * `activeVersionId` 是指向版本的外键，必须先有版本行才能写指针
 * （且 schema 用的是 `onDelete: NoAction`，不存在循环写入的捷径）。
 *
 * 幂等：模板按 `key` upsert、版本按 `(templateId, version)` upsert；
 * 重复执行只会更新内容，不会产生重复版本。
 */
const seedPromptTemplates = async (): Promise<number> => {
  for (const template of PROMPT_TEMPLATES) {
    const saved = await prisma.promptTemplate.upsert({
      where: { key: template.key },
      create: {
        key: template.key,
        name: template.name,
        type: template.type as never,
        description: template.description,
        isActive: true,
      },
      update: {
        name: template.name,
        type: template.type as never,
        description: template.description,
        isActive: true,
      },
      select: { id: true },
    });

    // Prisma 的 InputJsonValue 要求索引签名，而接口类型没有 —— 这是 Prisma 的
    // 已知类型摩擦，值本身是合法 JSON，因此这里做一次显式转换
    const outputSchema = { sections: template.sections } as unknown as Prisma.InputJsonValue;

    const version = await prisma.promptVersion.upsert({
      where: { templateId_version: { templateId: saved.id, version: template.version } },
      create: {
        templateId: saved.id,
        version: template.version,
        systemPrompt: template.systemPrompt,
        userPromptTemplate: template.userPromptTemplate,
        outputSchema,
        temperature: template.temperature,
        maxTokens: template.maxTokens,
        status: 'ACTIVE',
        trafficWeight: 100,
        changeNote: template.changeNote,
        publishedAt: new Date(),
      },
      update: {
        systemPrompt: template.systemPrompt,
        userPromptTemplate: template.userPromptTemplate,
        outputSchema,
        temperature: template.temperature,
        maxTokens: template.maxTokens,
        status: 'ACTIVE',
        trafficWeight: 100,
        changeNote: template.changeNote,
      },
      select: { id: true },
    });

    await prisma.promptTemplate.update({
      where: { id: saved.id },
      data: { activeVersionId: version.id },
    });
  }

  return PROMPT_TEMPLATES.length;
};

/**
 * 灌入匹配权重矩阵（`(code, version)` 唯一）
 *
 * 只 upsert、不删除旧版本：历史报告的 `scoreBreakdown` 会引用当时的
 * `weightsVersion`，删掉配置就无法回溯"当时是按什么权重算的"。
 */
const seedCompatibilityWeights = async (): Promise<number> => {
  for (const weights of COMPATIBILITY_WEIGHTS) {
    const data = {
      name: weights.name,
      description: weights.description,
      mbtiMatrix: weights.mbtiMatrix as unknown as Prisma.InputJsonValue,
      bigFiveConfig: weights.bigFiveConfig as unknown as Prisma.InputJsonValue,
      attachmentMatrix: weights.attachmentMatrix as unknown as Prisma.InputJsonValue,
      communicationConfig: weights.communicationConfig as unknown as Prisma.InputJsonValue,
      dimensionWeights: weights.dimensionWeights as unknown as Prisma.InputJsonValue,
      isActive: true,
    };

    await prisma.compatibilityWeight.upsert({
      where: { code_version: { code: weights.code, version: weights.version } },
      create: { code: weights.code, version: weights.version, ...data },
      update: data,
    });
  }

  return COMPATIBILITY_WEIGHTS.length;
};

// ============================================================================
// 入口
// ============================================================================
async function main(): Promise<void> {
  const started = Date.now();

  console.log('开始灌入种子数据…');

  validateSeedData();

  const summary: SeedSummary = { definitions: 0, questions: 0, options: 0, rules: 0 };

  summary.definitions = await seedDefinitions();

  for (const { definitionCode, questions } of QUESTION_SETS) {
    const result = await seedQuestionsFor(definitionCode, questions);
    summary.questions += result.questions;
    summary.options += result.options;
  }

  summary.rules = await seedRelationshipRules();
  summary.promptTemplates = await seedPromptTemplates();
  summary.compatibilityWeights = await seedCompatibilityWeights();

  const elapsed = Date.now() - started;

  console.log(
    [
      '种子数据灌入完成：',
      `  测试定义 : ${summary.definitions}`,
      `  题目     : ${summary.questions}`,
      `  选项     : ${summary.options}`,
      `  关系规则 : ${summary.rules}`,
      `  Prompt   : ${summary.promptTemplates ?? 0}`,
      `  匹配权重 : ${summary.compatibilityWeights ?? 0}`,
      `  耗时     : ${elapsed}ms`,
    ].join('\n'),
  );
}

void main()
  .catch((error: unknown) => {
    console.error(`种子数据灌入失败：${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
