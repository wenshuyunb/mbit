/**
 * 测试定义种子数据
 *
 * 说明：
 *   · `questionCount` 由 seed 脚本按实际灌入的题目数**回填**，不在此硬编码
 *     （避免「定义说有 60 题、实际只有 32 题」导致运行期下发残缺试卷）
 *   · `MBTI_FULL`（64 题深度版）暂以 DRAFT 状态存在：深度版需要独立撰写的题库内容，
 *     在内容增量到位前保持不可用状态 —— 宁可缺少入口，也不能下发题量不足的试卷
 */

import type { SeedTestDefinition } from '../types';

export const TEST_DEFINITIONS: SeedTestDefinition[] = [
  {
    code: 'MBTI_LITE',
    name: '人格速测（MBTI 精简版）',
    category: 'MBTI',
    module: 'PERSONALITY',
    description:
      '基于荣格类型学的四维度人格速测，32 道题覆盖能量来源、信息获取、决策方式与生活态度四个维度，约 5 分钟完成。',
    version: '1.0.0',
    status: 'ACTIVE',
    isActive: true,
    estimatedMinutes: 5,
    selectionMode: 'STATIC_SET',
    sortOrder: 10,
    requiredEntitlement: null,
  },
  {
    code: 'BIG_FIVE_50',
    name: '大五人格测评（50 题）',
    category: 'BIG_FIVE',
    module: 'PERSONALITY',
    description:
      '基于五因素人格理论（Big Five）的标准测评，50 道题覆盖开放性、尽责性、外向性、宜人性与神经质五个特质，约 8 分钟完成。',
    version: '1.0.0',
    status: 'ACTIVE',
    isActive: true,
    estimatedMinutes: 8,
    selectionMode: 'STATIC_SET',
    sortOrder: 20,
    requiredEntitlement: null,
  },
  {
    code: 'MBTI_FULL',
    name: '人格深度测评（MBTI 完整版）',
    category: 'COMPREHENSIVE',
    module: 'PERSONALITY',
    description: '在精简版基础上扩展的深度测评，包含 MBTI 四维度与大五人格的联合评估，用于生成更精细的画像与报告。',
    version: '1.0.0',
    // 尚未灌入配套题库（64 题），保持 DRAFT + isActive=false，避免被误用
    status: 'DRAFT',
    isActive: false,
    estimatedMinutes: 15,
    selectionMode: 'STATIC_SET',
    sortOrder: 30,
    requiredEntitlement: null,
  },
  {
    /**
     * ⚠ 这是**情感模块**的测评（ADR-038 阶段 3），不是人格测评
     *
     * `module: 'EMOTION'` 决定三件事，全部由代码强制而不靠约定：
     *   ① `submit()` 走情感落库分支 → 写 `emotion_profiles`（**不碰**人格画像）
     *   ② `ModuleScoringService` 用它自己的算分器（依恋双轴 / 爱的语言 / 冲突风格）
     *   ③ 结果接口只返回情感字段，不含 `mbtiType` / `bigFive`
     *
     * `category` 用 `RELATIONSHIP_STYLE`：它衡量的是**关系中的风格**，
     * 与模块是两个层次的概念（见 `TestModule` 枚举的注释）。
     */
    code: 'EMOTION_LITE',
    name: '情感测评（亲密关系风格）',
    category: 'RELATIONSHIP_STYLE',
    module: 'EMOTION',
    description:
      '基于依恋理论（ECR 双轴）、爱的语言与冲突处理风格（TKI）三个成熟模型，52 道题看清你在亲密关系中的依恋类型、最在意的被爱方式与冲突时的反应，约 8 分钟完成。',
    version: '1.0.0',
    status: 'ACTIVE',
    isActive: true,
    estimatedMinutes: 8,
    selectionMode: 'STATIC_SET',
    sortOrder: 40,
    requiredEntitlement: null,
  },
];
