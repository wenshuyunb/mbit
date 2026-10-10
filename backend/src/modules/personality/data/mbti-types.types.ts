/**
 * MBTI 类型百科 — 类型契约
 *
 * 为什么是代码常量而不是数据库表：
 *   · 这是**静态参考文献**（16 种类型的通用描述），不随业务运营变化，
 *     不像题库与 Prompt 那样需要热更
 *   · 由 `GET /personality/types/{mbti}` 公开返回，是纯读接口，无写入路径
 *   · 若未来需要运营可编辑（例如按类型定制营销文案），再迁移到 `system_configs` 或独立表即可
 *
 * 与「画像 summary」的关系：
 *   画像接口的 `summary`（headline / strengths / watchouts）由这里的
 *   `summary` 字段提供模板内容，**不是 AI 生成**（`isAiGenerated: false`）。
 *   AI 生成的深度解读属于 `report` 模块职责。
 */

/** 四大类型组 */
export type MbtiGroup = 'ANALYST' | 'DIPLOMAT' | 'SENTINEL' | 'EXPLORER';

/** 维度极性标签（用于类型百科的维度画像展示） */
export interface MbtiDimensionProfile {
  dimension: 'EI' | 'SN' | 'TF' | 'JP';
  /** 该类型的极性字母 */
  pole: 'E' | 'I' | 'S' | 'N' | 'T' | 'F' | 'J' | 'P';
  /** 中文标签，如「内向」 */
  label: string;
  /** 该类型在该维度上的典型倾向百分比（50–90），用于展示强度条 */
  percent: number;
}

/** 带标题的条目（优势 / 盲点 / 关系建议共用） */
export interface MbtiTypeItem {
  title: string;
  description: string;
}

/** 画像摘要模板 */
export interface MbtiSummaryTemplate {
  /** 一句话画像，12–20 个汉字 */
  headline: string;
  /** 3 个优势关键词（每个 2–6 汉字） */
  strengths: string[];
  /** 3 个需要留意的关键词（每个 2–6 汉字） */
  watchouts: string[];
}

/** 单个 MBTI 类型的百科条目 */
export interface MbtiTypeProfile {
  /** 四字母类型码，必须是大写标准写法 */
  type: string;
  /** 中文类型名（如「提倡者」） */
  typeName: string;
  /** 英文类型名（如「Advocate」） */
  typeNameEn: string;
  group: MbtiGroup;
  /** 组的中文名 */
  groupName: string;
  /** 组的主题色（十六进制，用于前端渲染） */
  groupColor: string;
  /** 一句话标语（16–24 个汉字） */
  tagline: string;
  /** 类型描述（80–140 个汉字） */
  description: string;
  /** 四个维度的典型倾向（顺序固定 EI / SN / TF / JP） */
  dimensionProfile: MbtiDimensionProfile[];
  /** 优势，恰好 4 条 */
  strengths: MbtiTypeItem[];
  /** 盲点，恰好 3 条 */
  blindSpots: MbtiTypeItem[];
  /** 关系相处建议，恰好 3 条 */
  relationshipTips: MbtiTypeItem[];
  /** 画像摘要模板 */
  summary: MbtiSummaryTemplate;
}
