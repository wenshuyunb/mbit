/**
 * 人格画像接口
 *
 * 对应后端模块：personality
 * 注意：画像的「算法版本」由服务端返回（engineVersion），前端不得自行推断。
 */

import { http } from './request';

/** Big Five 五维分数（0-100） */
export interface BigFiveScores {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

/** 关系风格（由 Big Five 组合规则推导，规则表在后端可配） */
export interface RelationshipStyle {
  attachment: 'SECURE' | 'ANXIOUS' | 'AVOIDANT' | 'FEARFUL';
  attachmentLabel: string;
  loveLanguage: string[];
  conflictStyle: string;
}

/** 人格画像 */
export interface PersonalityProfile {
  id: string;
  userId: string;
  mbti: string;
  /** 四个维度的倾向百分比（0-100，>50 偏向正极字母） */
  dimensions: Record<string, number>;
  bigFive: BigFiveScores;
  relationshipStyle: RelationshipStyle;
  summary: string;
  /** 结果置信度（0-100），低于阈值时前端应提示「结果置信度偏低」 */
  confidence: number;
  /** 算法版本，画像随算法升级会产生新版本记录 */
  engineVersion: string;
  createdAt: string;
}

/** 成长曲线数据点 */
export interface PersonalitySnapshot {
  id: string;
  mbti: string;
  bigFive: BigFiveScores;
  capturedAt: string;
}

/** 当前画像 */
export const getMyProfile = (): Promise<PersonalityProfile> => http.get<PersonalityProfile>('/personality/me');

/** 历史画像版本（算法升级后保留历史，便于对比） */
export const getProfileHistory = (): Promise<PersonalityProfile[]> =>
  http.get<PersonalityProfile[]>('/personality/me/history');

/** 成长曲线（时间序列） */
export const getSnapshots = (query: { limit?: number } = {}): Promise<PersonalitySnapshot[]> =>
  http.get<PersonalitySnapshot[]>('/personality/me/snapshots', query);

/** MBTI 类型百科（公开接口，用于分享落地页） */
export const getMbtiTypeInfo = (type: string): Promise<Record<string, unknown>> =>
  http.get<Record<string, unknown>>(`/personality/types/${type}`, undefined, { needAuth: false });
