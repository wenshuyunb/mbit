/**
 * 情感测评题库种子数据（共 52 题）
 *
 * 与 MBTI 题库（questions.mbti.ts）的差别：
 *   · MBTI 是**二分轴**：每维度分正负极，题目测「你偏哪一边」；
 *     情感题库是**多族测量**：依恋两轴各自独立计分（可同高同低），
 *     爱的语言与冲突风格则是五项**各自得分再排序**，没有正负极之说。
 *   · 因此这里的 `reverseScored` 语义统一为「同意该陈述 = 该维度程度**低**」，
 *     题干必须写成与维度相反的意思，反向题用于抵消默认同意倾向。
 *
 * 题量分布（52 题，由 EMOTION_LITE 以 STATIC_SET 方式整卷抽取）：
 *   一、依恋（ECR 双轴模型）12 题：ATTACH_ANXIETY 6 题（4 正 + 2 反）、
 *       ATTACH_AVOIDANCE 6 题（4 正 + 2 反）
 *   二、爱的语言（Gary Chapman 五语言）20 题：每项 4 题（2 正 + 2 反）
 *   三、冲突风格（Thomas–Kilmann 五种）20 题：每项 4 题（2 正 + 2 反）
 *
 * 每个维度都**正反向并存**，且两种方向在题目前后半区各有分布：
 *   · 依恋轴 6 题按「正—反—正—正—反—正」排列（反向落在 order 1 与 4）；
 *   · 爱的语言与冲突风格每项 4 题按「正—反—正—反」排列（反向落在 order 1 与 3）。
 * 这样受测者无法从题序识别出反向题区段；每项 2 正 2 反也让一致性评分有对称的两组数据，
 * 不至于像「2 正 1 反」时那样由单道反向题主导结果。
 *
 * 题干写法约定：全部为中文单句陈述句（8–40 字），用生活场景里的话描述
 * 「我当时会怎么做 / 我事后会怎么想」，不出现量表术语、不做临床描述。
 * 计分轴定义见 src/modules/emotion/engine/emotion-engine.types.ts。
 */
import type { SeedQuestion } from '../types';

export const EMOTION_QUESTIONS: SeedQuestion[] = [
  // ===== 一、依恋·焦虑轴（6 题：4 正 + 2 反 — 对被疏远的担忧、反复确认、回应慢时的不安）=====
  {
    code: 'Q_AN_001',
    content: '我很容易担心对方是不是不再在意我了',
    dimension: 'ATTACH_ANXIETY',
    reverseScored: false,
    order: 0,
    tags: ['亲密关系', '安全感'],
  },
  {
    code: 'Q_AN_002',
    content: '我不太会因为对方回消息慢而不安',
    dimension: 'ATTACH_ANXIETY',
    reverseScored: true,
    order: 1,
    tags: ['回应速度', '安全感'],
  },
  {
    code: 'Q_AN_003',
    content: '我需要对方经常告诉我他还在乎这段关系',
    dimension: 'ATTACH_ANXIETY',
    reverseScored: false,
    order: 2,
    tags: ['反复确认', '亲密关系'],
  },
  {
    code: 'Q_AN_004',
    content: '对方情绪稍有变化我就会想是不是我做错了什么',
    dimension: 'ATTACH_ANXIETY',
    reverseScored: false,
    order: 3,
    tags: ['过度留意', '自我怀疑'],
  },
  {
    code: 'Q_AN_005',
    content: '我很少怀疑自己在对方心里的位置',
    dimension: 'ATTACH_ANXIETY',
    reverseScored: true,
    order: 4,
    tags: ['信任', '安全感'],
  },
  {
    code: 'Q_AN_006',
    content: '分开一段时间我就会担心关系出问题',
    dimension: 'ATTACH_ANXIETY',
    reverseScored: false,
    order: 5,
    tags: ['分离感受', '安全感'],
  },

  // ===== 一、依恋·回避轴（6 题：4 正 + 2 反 — 对亲密的不适、强调自我依靠、被靠近时的退缩）=====
  {
    code: 'Q_AV_001',
    content: '我不太愿意向对方说出自己心里的难处',
    dimension: 'ATTACH_AVOIDANCE',
    reverseScored: false,
    order: 0,
    tags: ['袒露心声', '亲密不适'],
  },
  {
    code: 'Q_AV_002',
    content: '我愿意依赖对方也能接受对方依赖我',
    dimension: 'ATTACH_AVOIDANCE',
    reverseScored: true,
    order: 1,
    tags: ['相互依靠', '信任'],
  },
  {
    code: 'Q_AV_003',
    content: '关系太亲密时我会本能地想后退一点',
    dimension: 'ATTACH_AVOIDANCE',
    reverseScored: false,
    order: 2,
    tags: ['距离感', '退缩'],
  },
  {
    code: 'Q_AV_004',
    content: '遇到困难时我更习惯自己解决而不是求助对方',
    dimension: 'ATTACH_AVOIDANCE',
    reverseScored: false,
    order: 3,
    tags: ['强调独立', '不求人'],
  },
  {
    code: 'Q_AV_005',
    content: '我很享受和对方分享日常的琐碎小事',
    dimension: 'ATTACH_AVOIDANCE',
    reverseScored: true,
    order: 4,
    tags: ['日常分享', '亲近'],
  },
  {
    code: 'Q_AV_006',
    content: '对方想靠得更近时我会觉得有压力',
    dimension: 'ATTACH_AVOIDANCE',
    reverseScored: false,
    order: 5,
    tags: ['亲近压力', '距离感'],
  },

  // ===== 二、爱的语言·肯定的言辞（4 题：2 正 + 2 反 — 听到被欣赏、被认可的话才最感到被爱）=====
  {
    code: 'Q_LW_001',
    content: '听到对方说欣赏我的话我会格外开心',
    dimension: 'LOVE_WORDS',
    reverseScored: false,
    order: 0,
    tags: ['被肯定', '言语表达'],
  },
  {
    code: 'Q_LW_002',
    content: '有没有被夸奖这件事对我影响不大',
    dimension: 'LOVE_WORDS',
    reverseScored: true,
    order: 1,
    tags: ['被肯定', '在意程度'],
  },
  {
    code: 'Q_LW_003',
    content: '对方一句鼓励的话能让我振作很久',
    dimension: 'LOVE_WORDS',
    reverseScored: false,
    order: 2,
    tags: ['鼓励', '情绪支持'],
  },
  {
    code: 'Q_LW_004',
    content: '听到甜言蜜语我反而会觉得不自在',
    dimension: 'LOVE_WORDS',
    reverseScored: true,
    order: 3,
    tags: ['言语表达', '感受体验'],
  },

  // ===== 二、爱的语言·精心的时刻（4 题：2 正 + 2 反 — 专注的陪伴与共同经历才最感到被爱）=====
  {
    code: 'Q_LT_001',
    content: '我最珍惜两个人专心待在一起的时间',
    dimension: 'LOVE_TIME',
    reverseScored: false,
    order: 0,
    tags: ['陪伴', '专注相处'],
  },
  {
    code: 'Q_LT_002',
    content: '对方忙自己的事情没空陪我时我不会介意',
    dimension: 'LOVE_TIME',
    reverseScored: true,
    order: 1,
    tags: ['陪伴方式', '在意程度'],
  },
  {
    code: 'Q_LT_003',
    content: '对方放下手机陪我聊天时我最感到被爱',
    dimension: 'LOVE_TIME',
    reverseScored: false,
    order: 2,
    tags: ['专注陪伴', '被爱体验'],
  },
  {
    code: 'Q_LT_004',
    content: '我更喜欢各自安排时间而不是刻意留出共同时间',
    dimension: 'LOVE_TIME',
    reverseScored: true,
    order: 3,
    tags: ['相处方式', '陪伴需求'],
  },

  // ===== 二、爱的语言·接受礼物（4 题：2 正 + 2 反 — 用心挑选的心意比礼物本身更重要）=====
  {
    code: 'Q_LG_001',
    content: '收到对方用心挑选的小礼物我会记很久',
    dimension: 'LOVE_GIFTS',
    reverseScored: false,
    order: 0,
    tags: ['礼物', '被惦记'],
  },
  {
    code: 'Q_LG_002',
    content: '礼物收到也好收不到也好我都无所谓',
    dimension: 'LOVE_GIFTS',
    reverseScored: true,
    order: 1,
    tags: ['礼物', '在意程度'],
  },
  {
    code: 'Q_LG_003',
    content: '看到对方带回来的纪念品我会觉得很温暖',
    dimension: 'LOVE_GIFTS',
    reverseScored: false,
    order: 2,
    tags: ['礼物', '温暖感受'],
  },
  {
    code: 'Q_LG_004',
    content: '对方送我礼物我总觉得欠了人情',
    dimension: 'LOVE_GIFTS',
    reverseScored: true,
    order: 3,
    tags: ['礼物', '心理负担'],
  },

  // ===== 二、爱的语言·服务的行动（4 题：2 正 + 2 反 — 对方替我做事的实际行动才最感到被爱）=====
  {
    code: 'Q_LS_001',
    content: '对方默默帮我分担家务时我特别感动',
    dimension: 'LOVE_SERVICE',
    reverseScored: false,
    order: 0,
    tags: ['行动支持', '被照顾'],
  },
  {
    code: 'Q_LS_002',
    content: '对方没有帮我分担事情我也觉得没什么',
    dimension: 'LOVE_SERVICE',
    reverseScored: true,
    order: 1,
    tags: ['行动支持', '在意程度'],
  },
  {
    code: 'Q_LS_003',
    content: '我最被打动的是对方替我把事情安排好',
    dimension: 'LOVE_SERVICE',
    reverseScored: false,
    order: 2,
    tags: ['行动支持', '体贴'],
  },
  {
    code: 'Q_LS_004',
    content: '我自己能搞定的事情不需要对方插手',
    dimension: 'LOVE_SERVICE',
    reverseScored: true,
    order: 3,
    tags: ['行动支持', '独立'],
  },

  // ===== 二、爱的语言·身体的接触（4 题：2 正 + 2 反 — 牵手、拥抱等身体亲近才最感到被爱）=====
  {
    code: 'Q_LO_001',
    content: '牵手和拥抱能让我很快安心下来',
    dimension: 'LOVE_TOUCH',
    reverseScored: false,
    order: 0,
    tags: ['身体接触', '安心'],
  },
  {
    code: 'Q_LO_002',
    content: '肢体上的亲近对我来说可有可无',
    dimension: 'LOVE_TOUCH',
    reverseScored: true,
    order: 1,
    tags: ['身体接触', '在意程度'],
  },
  {
    code: 'Q_LO_003',
    content: '难过的时候我最想要对方抱抱我',
    dimension: 'LOVE_TOUCH',
    reverseScored: false,
    order: 2,
    tags: ['身体接触', '情绪安抚'],
  },
  {
    code: 'Q_LO_004',
    content: '我不喜欢在公开场合和对方有身体接触',
    dimension: 'LOVE_TOUCH',
    reverseScored: true,
    order: 3,
    tags: ['身体接触', '公开场合'],
  },

  // ===== 三、冲突风格·协作型（4 题：2 正 + 2 反 — 一起找双方都满意的双赢方案）=====
  {
    code: 'Q_CB_001',
    content: '有分歧时我会先弄清楚双方真正想要什么',
    dimension: 'CONFLICT_COLLABORATING',
    reverseScored: false,
    order: 0,
    tags: ['冲突处理', '沟通'],
  },
  {
    code: 'Q_CB_002',
    content: '争论时我不太关心对方在意什么',
    dimension: 'CONFLICT_COLLABORATING',
    reverseScored: true,
    order: 1,
    tags: ['冲突处理', '关注对方'],
  },
  {
    code: 'Q_CB_003',
    content: '我愿意和对方一起找两个人都满意的办法',
    dimension: 'CONFLICT_COLLABORATING',
    reverseScored: false,
    order: 2,
    tags: ['双赢', '合作'],
  },
  {
    code: 'Q_CB_004',
    content: '我宁愿直接按自己的想法来也不愿多讨论',
    dimension: 'CONFLICT_COLLABORATING',
    reverseScored: true,
    order: 3,
    tags: ['冲突处理', '沟通意愿'],
  },

  // ===== 三、冲突风格·妥协型（4 题：2 正 + 2 反 — 各让一步、快速达成可接受的折中）=====
  {
    code: 'Q_CM_001',
    content: '争吵时我通常愿意各让一步把事情了结',
    dimension: 'CONFLICT_COMPROMISING',
    reverseScored: false,
    order: 0,
    tags: ['各让一步', '快速和解'],
  },
  {
    code: 'Q_CM_002',
    content: '分歧时我更愿意坚持到底而不轻易让步',
    dimension: 'CONFLICT_COMPROMISING',
    reverseScored: true,
    order: 1,
    tags: ['让步意愿', '坚持立场'],
  },
  {
    code: 'Q_CM_003',
    content: '我常提出折中的方案让双方都能接受',
    dimension: 'CONFLICT_COMPROMISING',
    reverseScored: false,
    order: 2,
    tags: ['折中', '和解'],
  },
  {
    code: 'Q_CM_004',
    content: '谈条件时我很少考虑给对方留余地',
    dimension: 'CONFLICT_COMPROMISING',
    reverseScored: true,
    order: 3,
    tags: ['让步意愿', '折中'],
  },

  // ===== 三、冲突风格·迁就型（4 题：2 正 + 2 反 — 压下自己的需要去满足对方）=====
  {
    code: 'Q_CD_001',
    content: '为了让对方舒服我常压下自己的想法',
    dimension: 'CONFLICT_ACCOMMODATING',
    reverseScored: false,
    order: 0,
    tags: ['压下需求', '照顾对方'],
  },
  {
    code: 'Q_CD_002',
    content: '即使对方不高兴我也会坚持自己的需要',
    dimension: 'CONFLICT_ACCOMMODATING',
    reverseScored: true,
    order: 1,
    tags: ['坚持自己', '需求表达'],
  },
  {
    code: 'Q_CD_003',
    content: '吵架后我往往是先低头道歉的那一个',
    dimension: 'CONFLICT_ACCOMMODATING',
    reverseScored: false,
    order: 2,
    tags: ['先低头', '和解方式'],
  },
  {
    code: 'Q_CD_004',
    content: '我不太会为了平息争执而放弃自己的主张',
    dimension: 'CONFLICT_ACCOMMODATING',
    reverseScored: true,
    order: 3,
    tags: ['坚持自己', '让步意愿'],
  },

  // ===== 三、冲突风格·回避型（4 题：2 正 + 2 反 — 绕开冲突、不谈或转移话题）=====
  {
    code: 'Q_CA_001',
    content: '遇到矛盾时我倾向于先躲开不谈',
    dimension: 'CONFLICT_AVOIDING',
    reverseScored: false,
    order: 0,
    tags: ['绕开冲突', '拖延沟通'],
  },
  {
    code: 'Q_CA_002',
    content: '有问题我会立刻摊开来和对方谈清楚',
    dimension: 'CONFLICT_AVOIDING',
    reverseScored: true,
    order: 1,
    tags: ['直接沟通', '面对问题'],
  },
  {
    code: 'Q_CA_003',
    content: '我会用沉默或者转移话题来避开争吵',
    dimension: 'CONFLICT_AVOIDING',
    reverseScored: false,
    order: 2,
    tags: ['沉默', '转移话题'],
  },
  {
    code: 'Q_CA_004',
    content: '我习惯把不愉快的事情当面说开',
    dimension: 'CONFLICT_AVOIDING',
    reverseScored: true,
    order: 3,
    tags: ['直接沟通', '面对问题'],
  },

  // ===== 三、冲突风格·竞争型（4 题：2 正 + 2 反 — 坚持己见、要赢、要占据上风）=====
  {
    code: 'Q_CC_001',
    content: '争论时我一定要说服对方接受我的看法',
    dimension: 'CONFLICT_COMPETING',
    reverseScored: false,
    order: 0,
    tags: ['坚持己见', '好胜'],
  },
  {
    code: 'Q_CC_002',
    content: '争输赢这件事对我来说并不重要',
    dimension: 'CONFLICT_COMPETING',
    reverseScored: true,
    order: 1,
    tags: ['输赢', '好胜程度'],
  },
  {
    code: 'Q_CC_003',
    content: '我习惯在争执中占据上风',
    dimension: 'CONFLICT_COMPETING',
    reverseScored: false,
    order: 2,
    tags: ['好胜', '主导权'],
  },
  {
    code: 'Q_CC_004',
    content: '我很少在争执中非要分出谁对谁错',
    dimension: 'CONFLICT_COMPETING',
    reverseScored: true,
    order: 3,
    tags: ['输赢', '好胜程度'],
  },
];
