/**
 * 业务常量
 *
 * 注意：这些是「前端展示与交互」所需的常量，业务规则的权威定义在服务端。
 *       凡是可能变化的运营配置（价格、配额、开关）都必须通过 /system/config 拉取，
 *       不得在此写死。
 */

/** 本地存储 key（统一前缀，避免与第三方 SDK 冲突） */
export const STORAGE_KEYS = {
  accessToken: 'sm_access_token',
  refreshToken: 'sm_refresh_token',
  accessTokenExpireAt: 'sm_access_token_expire_at',
  userInfo: 'sm_user_info',
  systemConfig: 'sm_system_config',
  testDraft: 'sm_test_draft',
  chatDraft: 'sm_chat_draft',
} as const;

/** MBTI 四个维度及其极性 */
export const MBTI_DIMENSIONS = [
  { key: 'EI', positive: 'E', negative: 'I', label: '能量来源', positiveLabel: '外向', negativeLabel: '内向' },
  { key: 'SN', positive: 'S', negative: 'N', label: '信息获取', positiveLabel: '实感', negativeLabel: '直觉' },
  { key: 'TF', positive: 'T', negative: 'F', label: '决策方式', positiveLabel: '思考', negativeLabel: '情感' },
  { key: 'JP', positive: 'J', negative: 'P', label: '生活态度', positiveLabel: '判断', negativeLabel: '知觉' },
] as const;

/** Big Five 五维度定义 */
export const BIG_FIVE_DIMENSIONS = [
  { key: 'openness', label: '开放性', description: '对新体验、想象力与审美的好奇程度' },
  { key: 'conscientiousness', label: '尽责性', description: '自律、条理性与目标坚持程度' },
  { key: 'extraversion', label: '外向性', description: '社交活跃度与从人际中获取能量的倾向' },
  { key: 'agreeableness', label: '宜人性', description: '共情、信任与合作的倾向' },
  { key: 'neuroticism', label: '神经质', description: '情绪波动的敏感程度（分数越低越稳定）' },
] as const;

/** 关系类型 */
export const RELATION_TYPES = [
  { value: 'COUPLE', label: '情侣', description: '恋爱关系匹配分析' },
  { value: 'FRIEND', label: '朋友', description: '友情相处模式分析' },
  { value: 'FAMILY', label: '家人', description: '亲子/家庭沟通分析' },
] as const;

export type RelationType = (typeof RELATION_TYPES)[number]['value'];

/** 测试会话状态（与服务端 TestSession.status 对齐） */
export const TEST_SESSION_STATUS = {
  CREATED: 'CREATED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',
  SCORED: 'SCORED',
  REPORT_READY: 'REPORT_READY',
  EXPIRED: 'EXPIRED',
} as const;

/**
 * 报告类型的取值**不在这里** —— 见 `@/api/report` 的 `ReportType`
 *
 * 这里原先有一个 `REPORT_TYPES = { MBTI, RELATIONSHIP }`，两个问题：
 * ① 取值与后端 `REPORT_TYPES` **完全对不上**（真实值是 `MBTI_REPORT` /
 *    `BIG_FIVE_REPORT` / `RELATIONSHIP_REPORT` / `GROWTH_SUMMARY` / `EMOTION_REPORT`）；
 * ② 全仓**没有任何引用**（列表页用的是服务端下发的 `typeName`）。
 * 一个没人用又写错的常量不是"备用"，是下一个人的陷阱 —— 已删除。
 */

/** 分享文案（默认值；实际以后端 /system/config 下发为准，便于运营调整） */
export const DEFAULT_SHARE = {
  title: '我用 SoulMap AI 测了人格，结果有点准',
  path: '/pages/index/index',
} as const;

/** 合规免责声明兜底文案（后端未下发时使用；正常应由系统配置下发） */
export const FALLBACK_DISCLAIMER =
  '本内容由 AI 生成，仅供自我探索与情感成长参考，不构成心理诊断、医疗建议或专业咨询。如有持续困扰，建议寻求专业心理服务。';
