/**
 * 沉浸式情感测评场景题库 —— **总入口**（ADR-039）
 *
 * ## 三套独立内容，不是一套换代词
 *
 * 场景题分男 / 女 / 中性三套（用户选定），因为"恋爱里会遇到什么处境"本身
 * 有性别角色差异：谁先开口、见家长时的位置、要不要先低头、被说"你根本不懂我"……
 * 只换代词的做法，用户一眼就能看出"这题不是给我出的"。
 *
 * ## 交付进度
 *
 * | 适用人群 | 文件                              | 状态        |
 * | -------- | --------------------------------- | ----------- |
 * | `MALE`   | `questions.emotion-scenarios.male.ts` | ✅ 已交付 24 场景 |
 * | `FEMALE` | `questions.emotion-scenarios.female.ts` | ⏳ 待交付 |
 * | `NEUTRAL`| `questions.emotion-scenarios.neutral.ts` | ⏳ 待交付 |
 *
 * 中性套给"不想说"的用户；它与男/女两套**同等完整**，不是降级版。
 * 未交付的两套加进来时，只需在本文件补一行 import 与一条映射 ——
 * 覆盖率单测是按 `EMOTION_SCENARIO_SETS` 逐套跑的，加进来即自动纳入检查。
 */

import type { SeedAudience, SeedScenarioQuestion } from '../types';
import { EMOTION_SCENARIOS_MALE } from './questions.emotion-scenarios.male';

/** 已交付的场景题库（按适用人群） */
export const EMOTION_SCENARIO_SETS: Partial<Record<SeedAudience, SeedScenarioQuestion[]>> = {
  MALE: EMOTION_SCENARIOS_MALE,
};

/** 尚未交付的适用人群（seed 与单测据此提示"还差哪一套"） */
export const PENDING_AUDIENCES: SeedAudience[] = (['MALE', 'FEMALE', 'NEUTRAL'] as SeedAudience[]).filter(
  (audience) => EMOTION_SCENARIO_SETS[audience] === undefined,
);

/** 已交付的全部场景题（拍平，供 seed 一次性写入） */
export const ALL_EMOTION_SCENARIOS: SeedScenarioQuestion[] = Object.values(EMOTION_SCENARIO_SETS).flat();
