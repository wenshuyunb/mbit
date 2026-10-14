/**
 * 心理健康测评题库种子数据（共 24 题）
 *
 * 这套题测的是**近两周的状态体验**（最近、这些天、这段时间），不是性格或长期特质：
 * 问「这段时间你过得怎么样」，而不是「你是一个怎样的人」。
 *
 * 与情感题库（questions.emotion.ts）的差别：
 *   · 情感题库是**多维各自计分**（依恋两轴、爱的语言五项、冲突风格五项），
 *     维度之间没有"好/坏"之分 —— 回避得分高只说明风格不同，不代表更糟；
 *   · 本套六个维度**方向一致**（情感题库则是方向中立的）：分数越高 = 状态越值得留意。
 *     这是本文件的正确性前提（见 `MENTAL_HEALTH_HIGHER_IS_WORSE`）。只要有一个维度
 *     写成"越高越好"，六维均值聚合出的整体档位就会**静默反向** ——
 *     状态好的人被判成值得留意，而结论文案读起来完全通顺，不会报错。
 *   · 因此第六维是「缺少支持」（MH_LONELINESS）而**不是**直觉上更顺口的「社会支持」：
 *     正向题写"想找人聊聊却找不到人"，反向题写"遇到难处我知道可以找谁帮忙"。
 *     写题时对每一维都要自查一遍：同意这句话，代表这一维的程度**更高**还是更低。
 *
 * 题量分布（24 题，整卷抽取）：
 *   一、压力感受 MH_STRESS   4 题（2 正 + 2 反）被事情压住、时间不够用、难以放松
 *   二、情绪低落 MH_MOOD     4 题（2 正 + 2 反）提不起劲、兴趣减退、容易想哭、缺期待
 *   三、紧张不安 MH_ANXIETY  4 题（2 正 + 2 反）心里发紧、提前担心、静不下来、身体反应
 *   四、睡眠困扰 MH_SLEEP    4 题（2 正 + 2 反）入睡困难、夜里易醒、作息乱、醒后不解乏
 *   五、精力不足 MH_ENERGY   4 题（2 正 + 2 反）容易疲惫、小事费力、恢复慢、白天犯困
 *   六、缺少支持 MH_LONELINESS 4 题（2 正 + 2 反）没人可聊、没人可求助、不被理解、缺陪伴
 *
 * 每个维度都按「正—反—正—反」排列（反向落在 order 1 与 3）：
 *   前半区（order 0–1）与后半区（order 2–3）各有一道反向题，且不会出现连续两道反向题
 *   （判据见 seed-data.spec.ts「反向题不成块聚集，且两个半区都有分布」）。
 *   2 正 2 反也让一致性评分有对称的两组数据，不至于由单道反向题主导结果。
 *
 * 题干写法约定：全部为中文单句陈述句（8–40 字），用日常体验的口吻自述，不出现量表术语、
 * 也不写任何判定性表述 —— 本模块只做状态描述，题面更不该暗示危重：
 * 写"躺下以后我的脑子常常停不下来"，而不是"我快要撑不住了"。
 * 提示文案由 test-definitions.ts 与 test.service.ts 统一给出。
 * 计分轴定义与六维档位见 src/modules/mental-health/engine/mental-health-engine.types.ts。
 */
import type { SeedQuestion } from '../types';

export const MENTAL_HEALTH_QUESTIONS: SeedQuestion[] = [
  // ===== 一、压力感受（4 题：2 正 + 2 反 — 被事情压住、喘不过气、时间不够用、难以放松）=====
  {
    code: 'Q_MS_001',
    content: '这段时间我常被事情压得喘不过气',
    dimension: 'MH_STRESS',
    reverseScored: false,
    order: 0,
    tags: ['事情太多', '被压感'],
  },
  {
    code: 'Q_MS_002',
    content: '这些天我能给自己留出喘息的空档',
    dimension: 'MH_STRESS',
    reverseScored: true,
    order: 1,
    tags: ['放松', '喘息空间'],
  },
  {
    code: 'Q_MS_003',
    content: '最近我总觉得时间不够用',
    dimension: 'MH_STRESS',
    reverseScored: false,
    order: 2,
    tags: ['时间不够', '赶节奏'],
  },
  {
    code: 'Q_MS_004',
    content: '我基本能按自己的节奏安排每天的事',
    dimension: 'MH_STRESS',
    reverseScored: true,
    order: 3,
    tags: ['节奏掌控', '从容'],
  },

  // ===== 二、情绪低落（4 题：2 正 + 2 反 — 提不起劲、兴趣减退、容易想哭、缺期待）=====
  {
    code: 'Q_MM_001',
    content: '近来我做什么都提不起劲来',
    dimension: 'MH_MOOD',
    reverseScored: false,
    order: 0,
    tags: ['提不起劲', '动力'],
  },
  {
    code: 'Q_MM_002',
    content: '我对以前喜欢的事情仍然有兴趣',
    dimension: 'MH_MOOD',
    reverseScored: true,
    order: 1,
    tags: ['兴趣', '乐趣'],
  },
  {
    code: 'Q_MM_003',
    content: '最近我容易因为一点小事就想哭',
    dimension: 'MH_MOOD',
    reverseScored: false,
    order: 2,
    tags: ['想哭', '情绪波动'],
  },
  {
    code: 'Q_MM_004',
    content: '我对以后的日子还有不少期待',
    dimension: 'MH_MOOD',
    reverseScored: true,
    order: 3,
    tags: ['期待感', '盼头'],
  },

  // ===== 三、紧张不安（4 题：2 正 + 2 反 — 心里发紧、提前担心、静不下来、身体反应）=====
  {
    code: 'Q_MX_001',
    content: '这些天我心里常有一种发紧的感觉',
    dimension: 'MH_ANXIETY',
    reverseScored: false,
    order: 0,
    tags: ['心里发紧', '紧张感'],
  },
  {
    code: 'Q_MX_002',
    content: '我很少为还没发生的事提前担心',
    dimension: 'MH_ANXIETY',
    reverseScored: true,
    order: 1,
    tags: ['提前担心', '担忧'],
  },
  {
    code: 'Q_MX_003',
    content: '我很难让自己安静地待一会儿',
    dimension: 'MH_ANXIETY',
    reverseScored: false,
    order: 2,
    tags: ['静不下来', '坐不住'],
  },
  {
    code: 'Q_MX_004',
    content: '我这些天很少觉得心跳快或手心出汗',
    dimension: 'MH_ANXIETY',
    reverseScored: true,
    order: 3,
    tags: ['身体反应', '心跳出汗'],
  },

  // ===== 四、睡眠困扰（4 题：2 正 + 2 反 — 入睡困难、夜里易醒、作息乱、醒后不解乏）=====
  {
    code: 'Q_MZ_001',
    content: '躺下以后我的脑子常常停不下来',
    dimension: 'MH_SLEEP',
    reverseScored: false,
    order: 0,
    tags: ['入睡困难', '脑子活跃'],
  },
  {
    code: 'Q_MZ_002',
    content: '这些天我基本能一觉睡到天亮',
    dimension: 'MH_SLEEP',
    reverseScored: true,
    order: 1,
    tags: ['夜里易醒', '睡得连贯'],
  },
  {
    code: 'Q_MZ_003',
    content: '这段时间我每天睡觉的时间都不固定',
    dimension: 'MH_SLEEP',
    reverseScored: false,
    order: 2,
    tags: ['作息紊乱', '时间不固定'],
  },
  {
    code: 'Q_MZ_004',
    content: '早上醒来我一般能恢复精神',
    dimension: 'MH_SLEEP',
    reverseScored: true,
    order: 3,
    tags: ['醒后恢复', '睡眠质量'],
  },

  // ===== 五、精力不足（4 题：2 正 + 2 反 — 容易疲惫、小事费力、恢复慢、白天犯困）=====
  {
    code: 'Q_ME_001',
    content: '最近我做一点事情就觉得累',
    dimension: 'MH_ENERGY',
    reverseScored: false,
    order: 0,
    tags: ['容易疲惫', '体力'],
  },
  {
    code: 'Q_ME_002',
    content: '日常小事我都能比较轻松地做完',
    dimension: 'MH_ENERGY',
    reverseScored: true,
    order: 1,
    tags: ['日常小事', '轻松感'],
  },
  {
    code: 'Q_ME_003',
    content: '累过之后我很久都缓不过来',
    dimension: 'MH_ENERGY',
    reverseScored: false,
    order: 2,
    tags: ['恢复慢', '缓不过来'],
  },
  {
    code: 'Q_ME_004',
    content: '白天我大多数时候是清醒的',
    dimension: 'MH_ENERGY',
    reverseScored: true,
    order: 3,
    tags: ['白天犯困', '清醒度'],
  },

  // ===== 六、缺少支持（4 题：2 正 + 2 反 — 没人可聊、没人可求助、不被理解、缺陪伴）=====
  {
    code: 'Q_MU_001',
    content: '想找人聊聊的时候我找不到合适的人',
    dimension: 'MH_LONELINESS',
    reverseScored: false,
    order: 0,
    tags: ['没人可聊', '倾诉'],
  },
  {
    code: 'Q_MU_002',
    content: '遇到难处我知道可以找谁帮忙',
    dimension: 'MH_LONELINESS',
    reverseScored: true,
    order: 1,
    tags: ['求助对象', '有人可找'],
  },
  {
    code: 'Q_MU_003',
    content: '身边的人很少真正理解我的感受',
    dimension: 'MH_LONELINESS',
    reverseScored: false,
    order: 2,
    tags: ['被理解', '懂我的人'],
  },
  {
    code: 'Q_MU_004',
    content: '我难受的时候身边有人愿意陪着',
    dimension: 'MH_LONELINESS',
    reverseScored: true,
    order: 3,
    tags: ['陪伴', '可依靠'],
  },
];
