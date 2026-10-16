export { MBTI_QUESTIONS } from './questions.mbti';
export { BIG_FIVE_QUESTIONS } from './questions.bigfive';

// ⚠ 情感模块的题库**不在这里** —— 它是 `questions.emotion-scenarios.*`（沉浸式场景题，ADR-039），
// 由 `seedEmotionScenarios()` 单独灌入。原先的 52 题李克特量表题库（`questions.emotion.ts`）
// 已随 ADR-039 退役并删除：情感测评的产品形态已经改成场景题，
// 留着那份数据只会有两种下场 —— 要么被误当成"仍在用的题库"，要么被重新 import 回去。
//
// ⚠ 心理状态自评同理（2026-10-15）：题库是 `questions.mental-health-scenes.ts`
//（「这两周的一天」时间轴式情境自评），由 `seedMentalHealthScenes()` 单独灌入。
// 原先的 24 题李克特量表题库（`questions.mental-health.ts`）同样退役并删除。
