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
import { argon2id, hash as argonHash } from 'argon2';

import {
  ADMIN_PERMISSION_NAMES,
  ADMIN_ROLE_DESCRIPTIONS,
  ADMIN_ROLE_NAMES,
  ADMIN_ROLE_PERMISSIONS,
  ALL_ADMIN_PERMISSIONS,
} from '../../src/modules/admin/rbac/admin-permission.constants';
import { BIG_FIVE_QUESTIONS, MBTI_QUESTIONS } from './data';
import { MEMBERSHIP_PLANS, PRODUCTS } from './data/catalog';
import { RELATIONSHIP_STYLE_RULES } from './data/relationship-rules';
import { COMPATIBILITY_WEIGHTS } from './data/compatibility-weights';
import { PROMPT_TEMPLATES } from './data/prompt-templates';
import { SYSTEM_CONFIGS } from './data/system-configs';
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
  /** 系统配置项数（`system_configs`） */
  systemConfigs?: number;
  /** 匹配权重矩阵数 */
  compatibilityWeights?: number;
  /** 会员套餐数 */
  membershipPlans?: number;
  /** 可售商品数 */
  products?: number;
  /** 管理端权限点数 */
  adminPermissions?: number;
  /** 管理端角色数 */
  adminRoles?: number;
  /** 角色-权限映射数 */
  adminRolePermissions?: number;
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

  // 可售目录：价格是收款的唯一依据，错误的价格会直接造成资损，必须在灌库前拦住
  for (const plan of MEMBERSHIP_PLANS) {
    if (!Number.isInteger(plan.priceAmount) || plan.priceAmount <= 0) {
      errors.push(`套餐 ${plan.code} 的现价必须是正整数分（当前 ${plan.priceAmount}）`);
    }
    if (plan.originalAmount < plan.priceAmount) {
      errors.push(`套餐 ${plan.code} 的划线价 ${plan.originalAmount} 低于现价 ${plan.priceAmount}（会显示成涨价）`);
    }
    if (plan.durationDays <= 0) {
      errors.push(`套餐 ${plan.code} 的时长必须为正数（当前 ${plan.durationDays}）`);
    }
    if (plan.benefits.length === 0) {
      errors.push(`套餐 ${plan.code} 没有任何权益项（会员页会渲染出空权益列表）`);
    }
  }

  const seenProductCodes = new Set<string>();

  for (const product of PRODUCTS) {
    if (seenProductCodes.has(product.code)) {
      errors.push(`商品编码重复：${product.code}`);
    }
    seenProductCodes.add(product.code);

    if (!Number.isInteger(product.priceAmount) || product.priceAmount <= 0) {
      errors.push(`商品 ${product.code} 的现价必须是正整数分（当前 ${product.priceAmount}）`);
    }
    if (product.originalAmount !== null && product.originalAmount < product.priceAmount) {
      errors.push(`商品 ${product.code} 的划线价低于现价`);
    }

    // 三类商品各自的必填语义：漏填会导致前端展示缺项或权益发放错误
    if (product.type === 'MEMBERSHIP' && (product.durationDays === null || product.durationDays <= 0)) {
      errors.push(`会员商品 ${product.code} 必须设置 durationDays`);
    }
    if (product.type === 'AI_CREDITS' && (product.credits === null || product.credits <= 0)) {
      errors.push(`次数包商品 ${product.code} 必须设置 credits`);
    }
    if (product.type.startsWith('REPORT_') && product.reportType === null) {
      errors.push(`报告商品 ${product.code} 必须设置 reportType`);
    }
  }

  // 会员商品的 productCode 必须能找到对应套餐，否则商品的 membershipPlanId 会为空，
  // 支付成功后无法据套餐发放会员权益
  for (const plan of MEMBERSHIP_PLANS) {
    if (!seenProductCodes.has(plan.productCode)) {
      errors.push(`套餐 ${plan.code} 指向的商品 ${plan.productCode} 不存在`);
    }
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
 * 灌入系统配置（`system_configs`）
 *
 * 此前这张表**一行都没有**，AI 助手链路的文案与限额全靠代码里的兜底值 ——
 * 运营改一句话要走发版流程，后台也看不到线上到底用的什么值（详见
 * `data/system-configs.ts` 的文件头）。
 *
 * 幂等：按 `key` upsert（`key` 是唯一约束）。
 *
 * `update` 里**必须显式写 `deletedAt: null`**：后台"删除配置"是软删，
 * 一行软删过的同名键被 upsert 命中后仍是删除态 —— `SystemConfigService`
 * 的查询条件带 `deletedAt: null`，表现就是"种子说灌成功了、线上读不到"
 * （与 `admin-config.service.ts` 的写入路径同一处理）。
 *
 * 只 upsert 本文件声明的键，**不做 deleteMany**：运维在后台新增的键与改过的值
 * 不能被种子脚本抹掉，`system_configs` 是运行时真值而不是种子的从属数据。
 */
const seedSystemConfigs = async (): Promise<number> => {
  for (const config of SYSTEM_CONFIGS) {
    const data = {
      value: config.value,
      valueType: config.valueType,
      group: config.group,
      description: config.description,
      isPublic: config.isPublic,
      isEditable: config.isEditable,
      deletedAt: null,
    };

    await prisma.systemConfig.upsert({
      where: { key: config.key },
      create: { key: config.key, ...data },
      update: data,
    });
  }

  return SYSTEM_CONFIGS.length;
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
// 可售目录（会员套餐 + 商品）
// ============================================================================

/**
 * 灌入会员套餐
 *
 * 必须在商品之前执行：商品通过 `membershipPlanId` 外键指向套餐。
 */
const seedMembershipPlans = async (): Promise<number> => {
  for (const plan of MEMBERSHIP_PLANS) {
    const data = {
      name: plan.name,
      description: plan.description,
      durationDays: plan.durationDays,
      priceAmount: plan.priceAmount,
      originalAmount: plan.originalAmount,
      currency: 'CNY',
      // 权益项是 JsonB：Prisma 的 InputJsonValue 要求索引签名，而接口类型没有，
      // 这是 Prisma 的已知类型摩擦，值本身是合法 JSON
      benefits: plan.benefits as unknown as Prisma.InputJsonValue,
      dailyAiQuota: plan.dailyAiQuota,
      totalAiQuota: plan.totalAiQuota,
      pdfExportQuota: plan.pdfExportQuota,
      sortOrder: plan.sortOrder,
      isActive: true,
      isRecommended: plan.isRecommended,
      tags: plan.tags,
    };

    await prisma.membershipPlan.upsert({
      where: { code: plan.code },
      create: { code: plan.code, ...data },
      update: data,
    });
  }

  return MEMBERSHIP_PLANS.length;
};

/**
 * 灌入可售商品
 *
 * 状态一律置为 `ON_SALE`：只有该状态才会出现在 `GET /membership/products`
 * 与 `POST /payment/orders` 的可售集合里。契约说定价「可后台配置」，
 * 而配置的前提是初始目录存在 —— 此前该表为空，导致整条支付链路无法验证。
 */
const seedProducts = async (): Promise<number> => {
  const plans = await prisma.membershipPlan.findMany({ select: { id: true, code: true } });
  const planIdByCode = new Map(plans.map((plan) => [plan.code, plan.id]));

  for (const product of PRODUCTS) {
    // 会员商品与同名套餐一一对应（`productCode` ↔ `planCode`）
    const planCode = MEMBERSHIP_PLANS.find((plan) => plan.productCode === product.code)?.code;
    const membershipPlanId = planCode === undefined ? null : (planIdByCode.get(planCode) ?? null);

    const data = {
      name: product.name,
      type: product.type,
      description: product.description,
      priceAmount: product.priceAmount,
      originalAmount: product.originalAmount,
      currency: 'CNY',
      credits: product.credits,
      durationDays: product.durationDays,
      membershipPlanId,
      reportType: product.reportType,
      tags: product.tags,
      sortOrder: product.sortOrder,
      status: 'ON_SALE' as const,
      isRecommended: product.isRecommended,
    };

    await prisma.product.upsert({
      where: { code: product.code },
      create: { code: product.code, ...data },
      update: data,
    });
  }

  return PRODUCTS.length;
};

// ============================================================================
// 管理端 RBAC
// ============================================================================

/**
 * 管理端初始账号
 *
 * ⚠ **默认密码仅供本地开发**：`mustChangePassword` 恒为 `true`，
 * 首次登录会被强制跳转改密页，因此默认密码不会在生产环境长期存活。
 * 生产环境通过 `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` 注入。
 */
const SEED_ADMIN_USERNAME = process.env['SEED_ADMIN_USERNAME'] ?? 'admin@soulmap.cn';
const SEED_ADMIN_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'S0ulM@p#2026Admin';
const SEED_ADMIN_DISPLAY_NAME = process.env['SEED_ADMIN_DISPLAY_NAME'] ?? '超级管理员';

/**
 * 灌入权限点、内置角色、角色权限映射与初始超管
 *
 * 顺序不可颠倒：权限 → 角色 → 角色权限映射 → 管理员 → 管理员角色关联。
 *
 * 幂等策略：
 *   · 权限与角色按 `code` upsert
 *   · 角色权限映射**先清后建**（映射是集合而非实体，增量同步的复杂度远高于重写，
 *     且这里的数据量只有几十行）
 *   · 管理员按 `username` upsert；**已存在时不覆盖密码**，避免把运维改过的密码重置回默认值
 */
const seedAdminRbac = async (): Promise<{
  permissions: number;
  roles: number;
  rolePermissions: number;
  adminUsername: string;
  adminCreated: boolean;
}> => {
  // ------------------------------------------------------------------ 权限点
  for (const code of ALL_ADMIN_PERMISSIONS) {
    const [domain, resource, action] = code.split(':');

    await prisma.permission.upsert({
      where: { code },
      create: {
        code,
        name: ADMIN_PERMISSION_NAMES[code],
        domain: domain ?? 'unknown',
        resource: resource ?? 'unknown',
        action: action ?? 'unknown',
        isSystem: true,
      },
      update: {
        name: ADMIN_PERMISSION_NAMES[code],
        domain: domain ?? 'unknown',
        resource: resource ?? 'unknown',
        action: action ?? 'unknown',
      },
    });
  }

  // ------------------------------------------------------------------ 角色
  const roleCodes = Object.keys(ADMIN_ROLE_PERMISSIONS) as Array<keyof typeof ADMIN_ROLE_PERMISSIONS>;

  for (const [index, roleCode] of roleCodes.entries()) {
    await prisma.role.upsert({
      where: { code: roleCode },
      create: {
        code: roleCode,
        name: ADMIN_ROLE_NAMES[roleCode],
        description: ADMIN_ROLE_DESCRIPTIONS[roleCode],
        isSystem: true,
        sortOrder: index,
      },
      update: {
        name: ADMIN_ROLE_NAMES[roleCode],
        description: ADMIN_ROLE_DESCRIPTIONS[roleCode],
        isSystem: true,
        sortOrder: index,
      },
    });
  }

  // -------------------------------------------------------- 角色权限映射
  const permissionRows = await prisma.permission.findMany({ select: { id: true, code: true } });
  const permissionIdByCode = new Map(permissionRows.map((row) => [row.code, row.id]));

  let rolePermissionCount = 0;

  for (const roleCode of roleCodes) {
    const role = await prisma.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) continue;

    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });

    for (const permissionCode of ADMIN_ROLE_PERMISSIONS[roleCode]) {
      // SUPER_ADMIN 的映射里是通配符 `*`，它**不是**一个真实权限点行，
      // 而是「全部权限」的语义标记，由 AdminRbacService 按 isSuperAdmin 处理，
      // 因此这里跳过，避免往 permissions 表塞一条假的 `*`
      if (permissionCode === '*') continue;

      const permissionId = permissionIdByCode.get(permissionCode);

      if (!permissionId) {
        // 角色映射引用了不存在的权限点：属种子数据自身错误，必须立刻暴露
        throw new Error(`角色 ${roleCode} 引用了未定义的权限点：${permissionCode}`);
      }

      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId },
      });
      rolePermissionCount += 1;
    }
  }

  // -------------------------------------------------------------- 初始超管
  const existing = await prisma.adminUser.findUnique({
    where: { username: SEED_ADMIN_USERNAME },
    select: { id: true },
  });

  const passwordHash = await argonHash(SEED_ADMIN_PASSWORD, {
    type: argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const admin = existing
    ? await prisma.adminUser.update({
        where: { id: existing.id },
        data: {
          // 已存在则不覆盖密码：避免把运维改过的密码重置回默认值
          isSuperAdmin: true,
          deletedAt: null,
        },
        select: { id: true },
      })
    : await prisma.adminUser.create({
        data: {
          username: SEED_ADMIN_USERNAME,
          passwordHash,
          nickname: SEED_ADMIN_DISPLAY_NAME,
          isSuperAdmin: true,
          status: 'ACTIVE',
          // 强制首次登录改密：默认密码不得在生产环境长期存活
          mustChangePassword: true,
        },
        select: { id: true },
      });

  // 超管的角色关联（`AdminUserRole`）也建上，便于后台「管理员列表」展示角色
  const superAdminRole = await prisma.role.findUnique({ where: { code: 'SUPER_ADMIN' }, select: { id: true } });

  if (superAdminRole) {
    await prisma.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId: admin.id, roleId: superAdminRole.id } },
      create: { adminUserId: admin.id, roleId: superAdminRole.id },
      update: {},
    });
  }

  return {
    permissions: ALL_ADMIN_PERMISSIONS.length,
    roles: roleCodes.length,
    rolePermissions: rolePermissionCount,
    adminUsername: SEED_ADMIN_USERNAME,
    adminCreated: existing === null,
  };
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
  summary.systemConfigs = await seedSystemConfigs();
  summary.compatibilityWeights = await seedCompatibilityWeights();

  // 顺序不可颠倒：商品通过 membershipPlanId 引用套餐
  summary.membershipPlans = await seedMembershipPlans();
  summary.products = await seedProducts();

  const adminRbac = await seedAdminRbac();
  summary.adminPermissions = adminRbac.permissions;
  summary.adminRoles = adminRbac.roles;
  summary.adminRolePermissions = adminRbac.rolePermissions;

  const elapsed = Date.now() - started;

  console.log(
    [
      '种子数据灌入完成：',
      `  测试定义 : ${summary.definitions}`,
      `  题目     : ${summary.questions}`,
      `  选项     : ${summary.options}`,
      `  关系规则 : ${summary.rules}`,
      `  Prompt   : ${summary.promptTemplates ?? 0}`,
      `  系统配置 : ${summary.systemConfigs ?? 0}`,
      `  匹配权重 : ${summary.compatibilityWeights ?? 0}`,
      `  会员套餐 : ${summary.membershipPlans ?? 0}`,
      `  商品     : ${summary.products ?? 0}`,
      `  权限点   : ${summary.adminPermissions ?? 0}`,
      `  角色     : ${summary.adminRoles ?? 0}`,
      `  角色权限 : ${summary.adminRolePermissions ?? 0}`,
      `  初始超管 : ${adminRbac.adminUsername}（${adminRbac.adminCreated ? '已创建' : '已存在，密码未改动'}）`,
      `  耗时     : ${elapsed}ms`,
    ].join('\n'),
  );

  if (adminRbac.adminCreated) {
    console.log(
      [
        '',
        '⚠ 初始超管已创建，首次登录后必须立即修改密码（mustChangePassword = true）。',
        '   默认密码仅供本地开发；生产环境请通过 SEED_ADMIN_PASSWORD 注入。',
      ].join('\n'),
    );
  }
}

void main()
  .catch((error: unknown) => {
    console.error(`种子数据灌入失败：${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
