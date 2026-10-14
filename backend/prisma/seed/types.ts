/**
 * 题库种子数据类型契约
 *
 * 设计要点（架构 §11.1）：
 *   · 题目**不写死在业务代码里**，而是通过 seed 脚本灌入数据库，生产环境可在后台增删改
 *   · 种子数据只描述「内容与元数据」，选项（李克特量表 1–5）由 seed 脚本按题型统一生成，
 *     避免 82 道题重复书写 410 行结构相同的选项
 *   · `reverseScored` 必须在每个维度内**均衡分布**：只有正反向题都有，一致性评分才有意义
 *     （见 `PersonalityEngine.computeConsistency` 的判据）
 */

import type { RelationshipStyleRule } from '../../src/modules/personality/engine/personality-engine.types';

/**
 * 关系风格规则种子
 *
 * 在引擎的求值契约之上补一个 `description` 字段：
 *   · 引擎只关心 `conditions` 与结果字段，`description` 对它没有意义
 *   · 但后台需要面向运营的中文说明（「这条规则描述的是怎样的人」），
 *     因此它属于**持久化数据**而非算法契约 —— 用交叉类型扩展，而不是污染引擎类型
 */
export type SeedRelationshipRule = RelationshipStyleRule & { description?: string | null };

/** 可计分维度（与 Prisma Dimension 枚举对齐） */
export type SeedDimension =
  // 人格模块
  | 'EI'
  | 'SN'
  | 'TF'
  | 'JP'
  | 'OPENNESS'
  | 'CONSCIENTIOUSNESS'
  | 'EXTRAVERSION'
  | 'AGREEABLENESS'
  | 'NEUROTICISM'
  // 情感模块（ADR-038 阶段 3）：依恋 ECR 双轴 / 爱的语言五项 / 冲突风格五项 TKI
  | 'ATTACH_ANXIETY'
  | 'ATTACH_AVOIDANCE'
  | 'LOVE_WORDS'
  | 'LOVE_TIME'
  | 'LOVE_GIFTS'
  | 'LOVE_SERVICE'
  | 'LOVE_TOUCH'
  | 'CONFLICT_COLLABORATING'
  | 'CONFLICT_COMPROMISING'
  | 'CONFLICT_ACCOMMODATING'
  | 'CONFLICT_AVOIDING'
  | 'CONFLICT_COMPETING'
  // 心理健康模块（ADR-038 阶段 4）
  //
  // ⚠ 六个维度方向一致：**分数越高 = 状态越值得留意**。
  // 混进一个"越高越好"的维度（如直觉上更顺口的「社会支持」）会让整体档位静默反向。
  | 'MH_STRESS'
  | 'MH_MOOD'
  | 'MH_ANXIETY'
  | 'MH_SLEEP'
  | 'MH_ENERGY'
  | 'MH_LONELINESS';

/** 种子题目 */
export interface SeedQuestion {
  /** 题目编码，全局唯一，形如 `Q_EI_001`（维度前缀 + 三位序号） */
  code: string;
  /** 题干（中文，单句陈述句，适合李克特量表作答） */
  content: string;
  /** 所属维度 */
  dimension: SeedDimension;
  /**
   * 是否反向计分
   *
   * true 表示「同意该陈述」代表**远离**该维度正极：
   *   · EI 维度反向题：同意 = 偏内向（I）
   *   · NEUROTICISM 反向题：同意 = 情绪更稳定（神经质得分低）
   */
  reverseScored: boolean;
  /** 题目权重（默认 1；仅在需要调节某题影响力时使用非 1 值） */
  weight?: number;
  /** 展示顺序（同一维度内从 0 递增） */
  order: number;
  /** 标签，用于后台筛选与分组展示 */
  tags: string[];
}

/** 测试定义种子 */
export interface SeedTestDefinition {
  /** 定义编码（对外接口路径参数） */
  code: string;
  name: string;
  /** 与 Prisma TestCategory 对齐：模块内的细分，决定用哪套算分逻辑 */
  category: 'MBTI' | 'BIG_FIVE' | 'RELATIONSHIP_STYLE' | 'COMPREHENSIVE' | 'MENTAL_HEALTH';
  /**
   * 所属模块（ADR-038），与 Prisma `TestModule` 对齐
   *
   * 决定**结果写进哪份画像、出哪种报告**；三个模块互不干扰。
   * 与 `category` 是两层概念：一个模块下可以有多个 category。
   */
  module: 'PERSONALITY' | 'EMOTION' | 'MENTAL_HEALTH';
  description: string;
  version: string;
  /** 与 Prisma TestDefinitionStatus 对齐 */
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  isActive: boolean;
  /** 预计耗时（分钟） */
  estimatedMinutes: number;
  /** 抽题方式：固定集合 / 按维度配额动态抽取 */
  selectionMode: 'STATIC_SET' | 'DIMENSION_QUOTA';
  /** selectionMode = DIMENSION_QUOTA 时，每个维度抽取的题量 */
  dimensionQuotas?: Record<string, number>;
  /** 展示排序 */
  sortOrder: number;
  /** 是否要求会员权益（Phase 6 接入权益校验） */
  requiredEntitlement?: string | null;
}
