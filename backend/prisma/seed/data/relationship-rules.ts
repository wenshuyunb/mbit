/**
 * 关系风格推导规则种子数据
 *
 * 设计原则（架构 §11.3）：
 *   · 规则**存数据库、后台可调**，算分引擎只负责求值，不硬编码任何阈值
 *   · 按 `priority` 升序求值，**首个命中即采用**（可理解为有序的诊断条件）
 *   · 依恋类型映射参考成人依恋理论的两维模型：
 *       回避亲密（低宜人 + 低外向） × 焦虑被弃（高神经质）
 *       → SECURE（两者皆低）/ ANXIOUS（高焦虑）/ AVOIDANT（高回避）/ FEARFUL（两者皆高）
 *
 * 注意：这里的阈值是**产品可用性导向**的初始值，并非临床量表的分界点。
 *       上线后应基于真实数据的分布（分位数）调整，而不是照搬理论常数。
 */

import type { SeedRelationshipRule } from '../types';

export const RELATIONSHIP_STYLE_RULES: SeedRelationshipRule[] = [
  {
    // 高焦虑 + 高回避 → 恐惧型（既渴望亲密又害怕受伤）
    code: 'ATTACH_FEARFUL',
    name: '恐惧型依恋',
    description: '情绪易波动，同时对亲密关系保持防御，容易陷入「靠近—推开」的循环',
    priority: 10,
    conditions: {
      all: [
        { field: 'neuroticism', op: 'gte', value: 60 },
        { field: 'agreeableness', op: 'lt', value: 45 },
        { field: 'extraversion', op: 'lt', value: 45 },
      ],
    },
    resultAttachment: 'FEARFUL',
    resultLoveLanguages: ['WORDS_OF_AFFIRMATION', 'QUALITY_TIME'],
    resultConflictStyle: 'COMPETING',
  },
  {
    // 高焦虑 + 较高宜人 → 焦虑型（担心被抛弃，倾向讨好）
    code: 'ATTACH_ANXIOUS',
    name: '焦虑型依恋',
    description: '对关系中的细微变化敏感，容易反复确认对方的态度，倾向通过付出来维系关系',
    priority: 20,
    conditions: {
      all: [
        { field: 'neuroticism', op: 'gte', value: 60 },
        { field: 'agreeableness', op: 'gte', value: 45 },
      ],
    },
    resultAttachment: 'ANXIOUS',
    resultLoveLanguages: ['WORDS_OF_AFFIRMATION', 'QUALITY_TIME'],
    resultConflictStyle: 'ACCOMMODATING',
  },
  {
    // 低焦虑 + 高回避 → 回避型（情绪稳定但保持距离）
    code: 'ATTACH_AVOIDANT',
    name: '回避型依恋',
    description: '情绪相对稳定，但在关系中看重独立空间，遇到冲突倾向退开而非沟通',
    priority: 30,
    conditions: {
      all: [
        { field: 'neuroticism', op: 'lt', value: 55 },
        { field: 'extraversion', op: 'lt', value: 45 },
        { field: 'agreeableness', op: 'lt', value: 55 },
      ],
    },
    resultAttachment: 'AVOIDANT',
    resultLoveLanguages: ['ACTS_OF_SERVICE', 'QUALITY_TIME'],
    resultConflictStyle: 'AVOIDING',
  },
  {
    // 低焦虑 + 高宜人 → 安全型（既能亲近也能独立）
    code: 'ATTACH_SECURE',
    name: '安全型依恋',
    description: '对亲密关系有基本信任，能直接表达需求，也能容纳对方的差异',
    priority: 40,
    conditions: {
      all: [
        { field: 'neuroticism', op: 'lt', value: 60 },
        { field: 'agreeableness', op: 'gte', value: 50 },
      ],
    },
    resultAttachment: 'SECURE',
    resultLoveLanguages: ['QUALITY_TIME', 'ACTS_OF_SERVICE'],
    resultConflictStyle: 'COLLABORATING',
  },
  {
    // 兜底：高开放 + 高尽责的探索型（不满足上述典型组合时给出可用的中性解读）
    code: 'ATTACH_EXPLORING',
    name: '探索型关系风格',
    description: '在关系中重视共同成长与目标一致，倾向于用行动而非言语表达在意',
    priority: 90,
    conditions: {
      all: [
        { field: 'openness', op: 'gte', value: 60 },
        { field: 'conscientiousness', op: 'gte', value: 55 },
      ],
    },
    resultAttachment: 'SECURE',
    resultLoveLanguages: ['ACTS_OF_SERVICE', 'RECEIVING_GIFTS'],
    resultConflictStyle: 'COMPROMISING',
  },
  {
    // 最终兜底：任何分数都能得到有意义的解读，不返回空风格
    code: 'ATTACH_BALANCED',
    name: '均衡型关系风格',
    description: '五个特质分布较为均衡，关系中的表现更多取决于具体情境与对方风格',
    priority: 999,
    conditions: {
      // 用「永远成立」的条件作为兜底：任意维度分数都 ≥ 0
      all: [
        { field: 'openness', op: 'gte', value: 0 },
        { field: 'conscientiousness', op: 'gte', value: 0 },
      ],
    },
    resultAttachment: 'SECURE',
    resultLoveLanguages: ['QUALITY_TIME'],
    resultConflictStyle: 'COMPROMISING',
  },
];
