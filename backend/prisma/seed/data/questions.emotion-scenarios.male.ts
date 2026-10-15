/**
 * 沉浸式情感测评场景题库 —— **男生版**（ADR-039，24 个场景）
 *
 * ## 这套题与旧的李克特题库有什么不同
 *
 * 旧题库是 52 句陈述 + 五级同意程度（"我很容易担心对方是不是不再在意我了"）；
 * 这套题是 24 个**具体处境** + "你会怎么做"。用户看到的是自己的生活被问，
 * 而不是一张量表。
 *
 * ## 计分：分值挂在**选项**上，且一个场景内**所有选项的维度键必须一致**
 *
 * 每个做法带一组维度分（`scores`），一个"你会怎么做"的选择本来就会同时透露多件事。
 *
 * ⚠ **同场景内所有选项的键集合必须完全相同**（有单测断言）。两个原因都很硬：
 *
 *   1. **量程推导**：`resolveScale` 只在"全部选项都带该维度"时才用选项分值推导量程；
 *      部分覆盖会退回题型默认量程 `0–1`，而分值可能是 4 —— `clamp(4, 0, 1) = 1`，
 *      该选项直接顶到满分，且没有任何报错；
 *   2. **可比性**：引擎按**所选选项**里出现的维度累加。若 A 选项带 `LOVE_TOUCH`
 *      而 B 选项不带，则"选 A 的人有这项数据、选 B 的人没有"，两人的画像无法比较。
 *
 * ## 维度覆盖（硬约束，有单测断言：每维度 ≥4 个选项命中、≥3 个不同场景）
 *
 *   场景 1–6   依恋两轴（焦虑 / 回避）
 *   场景 7–16  爱的语言（每题涉及其中的 3 项，全 5 项各有 5–8 个场景覆盖）
 *   场景 17–24 冲突风格（每题涉及其中的 3 种，全 5 种各有 3–6 个场景覆盖）
 *
 * ## 写作红线（改题库时别踩）
 *
 *   · **即时反馈不评判**：写"这样做常见的后续"，不写"这样才对/你太敏感了"。
 *     本模块做测量、不做指导；无论选什么都要拿到一句有用的回响；
 *   · **不写性别刻板印象**：男生版不是"男性应该怎样"，而是"男生更常遇到哪些处境"。
 *     处境差异是真实的（谁先开口、被说"你根本不懂我"、要不要先低头），
 *     但**没有任何一个选项是"正确答案"**；
 *   · **不出现诊断与量表术语**：不写"焦虑型依恋""竞争型冲突"这类词 ——
 *     做题的人不该在这里看到结论。
 */

import type { SeedScenarioQuestion } from '../types';

export const EMOTION_SCENARIOS_MALE: SeedScenarioQuestion[] = [
  // ============================================================ 一、依恋两轴（1–6）
  {
    code: 'SC_M_01',
    audience: 'MALE',
    content: '你加班到十一点多，进家门时她坐在沙发上没开灯。你问她怎么还没睡，她说"没事，你先洗澡吧"。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '坐下来先问问她今天怎么了',
        scores: { ATTACH_ANXIETY: 3, ATTACH_AVOIDANCE: 1 },
        feedback: '她通常先愣一下，然后把憋着的话说出来。',
      },
      {
        label: '先去洗澡，回头再说',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 4 },
        feedback: '事情常常留到第二天，也可能就这么过去了。',
      },
      {
        label: '反复回想今天是不是哪里做错了',
        scores: { ATTACH_ANXIETY: 5, ATTACH_AVOIDANCE: 2 },
        feedback: '这种反复自查，往往比事情本身更耗人。',
      },
    ],
    tags: ['日常相处', '回应速度'],
  },
  {
    code: 'SC_M_02',
    audience: 'MALE',
    content: '你发了条消息，她到晚上才回，只回了两个字"好的"。你翻了下白天的记录，发现自己也没说什么。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '直接问她是不是有什么事',
        scores: { ATTACH_ANXIETY: 4, ATTACH_AVOIDANCE: 1 },
        feedback: '多数时候答案是"今天很累"，而不是"我生气了"。',
      },
      {
        label: '先不追问，等她主动说',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 4 },
        feedback: '她可能过两天才提起，也可能以为你不在意。',
      },
      {
        label: '把那条"好的"翻来覆去看很多遍',
        scores: { ATTACH_ANXIETY: 5, ATTACH_AVOIDANCE: 2 },
        feedback: '同一句话看第二十遍，也不会多出一个意思来。',
      },
    ],
    tags: ['消息', '猜测'],
  },
  {
    code: 'SC_M_03',
    audience: 'MALE',
    content: '周末她临时说要和同事去爬山，没有提前跟你商量。你本来打算两个人去看那部刚上映的电影。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说清楚自己有点失落，也让她去',
        scores: { ATTACH_ANXIETY: 3, ATTACH_AVOIDANCE: 1 },
        feedback: '把"我有点失落"和"你去吧"一起说出口，挺难但很有用。',
      },
      {
        label: '说没关系，自己在家待着',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 4 },
        feedback: '当时最省事，但攒着的那点情绪不会自己消失。',
      },
      {
        label: '问她为什么没提前跟你说一声',
        scores: { ATTACH_ANXIETY: 5, ATTACH_AVOIDANCE: 2 },
        feedback: '这句很容易被听成质问，话题就跑到别处去了。',
      },
    ],
    tags: ['临时安排', '边界'],
  },
  {
    code: 'SC_M_04',
    audience: 'MALE',
    content: '她这周很忙，你已经三天没怎么和她说上话。今晚你终于有空，她的回复是"我在赶方案，明天聊"。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说好，明天再聊，然后去忙自己的',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 3 },
        feedback: '各自忙各自的，关系不会因为几天安静就散掉。',
      },
      {
        label: '告诉她你有点想她，不打扰她工作',
        scores: { ATTACH_ANXIETY: 3, ATTACH_AVOIDANCE: 1 },
        feedback: '一句轻的话，常常比一小时的电话更让人记挂。',
      },
      {
        label: '在心里记下"她好像没以前上心了"',
        scores: { ATTACH_ANXIETY: 5, ATTACH_AVOIDANCE: 2 },
        feedback: '这念头一旦记下，之后每次忙碌都会被它解释一遍。',
      },
    ],
    tags: ['忙碌', '距离感'],
  },
  {
    code: 'SC_M_05',
    audience: 'MALE',
    content: '你和朋友聚会到很晚，手机静音。回家发现她打了四个电话，最后一条消息是"算了"。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '马上回电话，把今晚的情况说清楚',
        scores: { ATTACH_ANXIETY: 3, ATTACH_AVOIDANCE: 1 },
        feedback: '把来龙去脉讲清楚，比一句"没看见"有用得多。',
      },
      {
        label: '发条消息说"刚看到，睡了没"',
        scores: { ATTACH_ANXIETY: 2, ATTACH_AVOIDANCE: 3 },
        feedback: '多数时候这样就够，但她可能还醒着等了很久。',
      },
      {
        label: '觉得她管得太紧，先冷一冷',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 5 },
        feedback: '两个人都在等对方先开口时，时间会变得很长。',
      },
    ],
    tags: ['联系不上', '担心'],
  },
  {
    code: 'SC_M_06',
    audience: 'MALE',
    content: '她第一次带你去见她最好的朋友。饭桌上她们聊起很多你不知道的往事，你插不上话。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '听着，偶尔问一句细节',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 2 },
        feedback: '愿意听，本身就是参与的一种方式。',
      },
      {
        label: '找机会把话题引到你们都熟的事上',
        scores: { ATTACH_ANXIETY: 4, ATTACH_AVOIDANCE: 2 },
        feedback: '有时能把场面接过来，有时会让她们觉得被打断。',
      },
      {
        label: '全程安静，等回去再说',
        scores: { ATTACH_ANXIETY: 2, ATTACH_AVOIDANCE: 4 },
        feedback: '这一晚你大概不会出错，但也参与得很少。',
      },
    ],
    tags: ['社交场合', '融入'],
  },

  // ============================================================ 二、爱的语言（7–16）
  {
    code: 'SC_M_07',
    audience: 'MALE',
    content: '你连着加班两周，今天终于能早点回家。她临时发来一句"我做了你爱吃的菜"。',
    prompt: '这一刻你更想要的是哪一种？',
    options: [
      {
        label: '和她一起把饭吃完，慢慢聊',
        scores: { LOVE_TIME: 5, LOVE_WORDS: 2, LOVE_SERVICE: 1 },
        feedback: '一整顿饭的时间，是很多人最缺的那种陪伴。',
      },
      {
        label: '听她说一句"这段时间辛苦你了"',
        scores: { LOVE_TIME: 2, LOVE_WORDS: 5, LOVE_SERVICE: 1 },
        feedback: '被看见的辛苦，和辛苦本身不是一回事。',
      },
      {
        label: '她顺手把你明天要带的东西也备好',
        scores: { LOVE_TIME: 1, LOVE_WORDS: 2, LOVE_SERVICE: 5 },
        feedback: '不说出口的照顾，有人觉得最踏实。',
      },
    ],
    tags: ['下班', '被在乎'],
  },
  {
    code: 'SC_M_08',
    audience: 'MALE',
    content: '生日那天，她给你准备了两样东西：一个你随口提过的小物件，和一张手写的卡片。',
    prompt: '哪一样更让你心里一动？',
    options: [
      {
        label: '那个随口提过的小物件',
        scores: { LOVE_GIFTS: 5, LOVE_WORDS: 2, LOVE_TIME: 1 },
        feedback: '被记住一句随口的闲话，是礼物真正的分量。',
      },
      {
        label: '那张写了字的卡片',
        scores: { LOVE_GIFTS: 2, LOVE_WORDS: 5, LOVE_TIME: 1 },
        feedback: '写下来的话，会被人反复拿出来看。',
      },
      {
        label: '她陪你待了一整天',
        scores: { LOVE_GIFTS: 1, LOVE_WORDS: 2, LOVE_TIME: 5 },
        feedback: '时间是最不好补的东西，所以它最贵。',
      },
    ],
    tags: ['生日', '礼物'],
  },
  {
    code: 'SC_M_09',
    audience: 'MALE',
    content: '你工作上出了个不小的差错，心情很差。回家没说，她看出来了，问你怎么了。',
    prompt: '这时候你最希望她怎么做？',
    options: [
      {
        label: '坐下来陪你待着，不用说什么',
        scores: { LOVE_TIME: 4, LOVE_SERVICE: 1, LOVE_GIFTS: 1 },
        feedback: '有时候陪着不出主意，比出主意更难得。',
      },
      {
        label: '默默把你明天要处理的事接手安排一下',
        scores: { LOVE_TIME: 1, LOVE_SERVICE: 5, LOVE_GIFTS: 1 },
        feedback: '有人替你分担掉几件小事，压力会明显小一圈。',
      },
      {
        label: '回来路上给你带了你爱吃的',
        scores: { LOVE_TIME: 1, LOVE_SERVICE: 2, LOVE_GIFTS: 5 },
        feedback: '被顺手惦记着，是很具体的一种安慰。',
      },
    ],
    tags: ['挫败', '安慰'],
  },
  {
    code: 'SC_M_10',
    audience: 'MALE',
    content: '你们一起去看电影，散场后走了一段路。路上她一直挽着你的胳膊，没怎么说话。',
    prompt: '这段路你的感受是？',
    options: [
      {
        label: '很放松，觉得这样就挺好',
        scores: { LOVE_TOUCH: 5, LOVE_TIME: 3, LOVE_WORDS: 1 },
        feedback: '身体上的靠近，是最不需要翻译的那种安心。',
      },
      {
        label: '想找点话题，聊聊刚才的电影',
        scores: { LOVE_TOUCH: 2, LOVE_TIME: 3, LOVE_WORDS: 4 },
        feedback: '聊得来的人，连沉默都能接得住。',
      },
      {
        label: '心里想着明天的事，有点走神',
        scores: { LOVE_TOUCH: 2, LOVE_TIME: 1, LOVE_WORDS: 1 },
        feedback: '人在旁边、心不在，是很容易被察觉到的那种缺席。',
      },
    ],
    tags: ['散步', '亲近'],
  },
  {
    code: 'SC_M_11',
    audience: 'MALE',
    content: '她出差一周。临走前给你留了张便条，还把冰箱塞满了。这一周她每天忙完会打个短电话。',
    prompt: '这一周里，你更在意哪一样？',
    options: [
      {
        label: '那张便条，你留到了她回来',
        scores: { LOVE_WORDS: 5, LOVE_SERVICE: 2, LOVE_TIME: 3 },
        feedback: '一张纸条能撑一周，靠的不是内容，是它一直在那儿。',
      },
      {
        label: '冰箱里那些她准备的吃的',
        scores: { LOVE_WORDS: 1, LOVE_SERVICE: 5, LOVE_TIME: 2 },
        feedback: '被照顾过日子的痕迹，一顿饭就能想起来。',
      },
      {
        label: '那每天五分钟的电话',
        scores: { LOVE_WORDS: 3, LOVE_SERVICE: 1, LOVE_TIME: 5 },
        feedback: '哪怕只有五分钟，那五分钟是专门给你的。',
      },
    ],
    tags: ['出差', '想念'],
  },
  {
    code: 'SC_M_12',
    audience: 'MALE',
    content: '你刚换了工作，收入暂时少了一截。你还没想好怎么跟她说，她自己提起了这件事。',
    prompt: '你更希望她怎么表达？',
    options: [
      {
        label: '"没事，我们一起算算怎么安排"',
        scores: { LOVE_SERVICE: 2, LOVE_GIFTS: 1, LOVE_WORDS: 5 },
        feedback: '"一起"这两个字，比"没事"更能托住人。',
      },
      {
        label: '多做一点，把开销压下来',
        scores: { LOVE_SERVICE: 5, LOVE_GIFTS: 1, LOVE_WORDS: 2 },
        feedback: '有人用行动接住了难处，却很少提。',
      },
      {
        label: '默默把之前想买的东西先放下',
        scores: { LOVE_SERVICE: 2, LOVE_GIFTS: 5, LOVE_WORDS: 1 },
        feedback: '放弃想要的东西这件事，很少有人会说出来。',
      },
    ],
    tags: ['压力', '共同面对'],
  },
  {
    code: 'SC_M_13',
    audience: 'MALE',
    content: '你感冒发烧躺了一天。她下班回来，手里拎着药和粥，坐下陪你聊到很晚。',
    prompt: '这一刻你更想要的是？',
    options: [
      {
        label: '她把药和水递到手里',
        scores: { LOVE_TIME: 2, LOVE_SERVICE: 5, LOVE_TOUCH: 1 },
        feedback: '生病时的照顾，很少有人会忘记。',
      },
      {
        label: '她坐在床边陪你说话',
        scores: { LOVE_TIME: 5, LOVE_SERVICE: 2, LOVE_TOUCH: 3 },
        feedback: '难受的时候有人在旁边，时间会过得快一点。',
      },
      {
        label: '她伸手试了试你的额头',
        scores: { LOVE_TIME: 2, LOVE_SERVICE: 3, LOVE_TOUCH: 5 },
        feedback: '一个很小的动作，常常比一句话更让人安心。',
      },
    ],
    tags: ['生病', '照顾'],
  },
  {
    code: 'SC_M_14',
    audience: 'MALE',
    content: '她升职了，很高兴地跟你讲了一路。你听着，心里有一半是为她高兴，一半是说不清的东西。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '认真听她讲完，把高兴说出来',
        scores: { LOVE_WORDS: 5, LOVE_TIME: 3, LOVE_TOUCH: 1 },
        feedback: '被认真听完的那一刻，比自己升职还开心。',
      },
      {
        label: '说"那今晚我请你吃饭"',
        scores: { LOVE_WORDS: 2, LOVE_TIME: 5, LOVE_TOUCH: 1 },
        feedback: '把高兴变成一件具体的事，两个人都会记住这天。',
      },
      {
        label: '抱住她说"厉害啊"',
        scores: { LOVE_WORDS: 3, LOVE_TIME: 2, LOVE_TOUCH: 5 },
        feedback: '有些高兴，用动作表达比用句子更到位。',
      },
    ],
    tags: ['好消息', '分享'],
  },
  {
    code: 'SC_M_15',
    audience: 'MALE',
    content: '你们计划了很久的一次旅行，出发前一晚她有点紧张，翻来覆去睡不着。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '陪她聊一会儿，直到她困了',
        scores: { LOVE_TIME: 5, LOVE_TOUCH: 2, LOVE_SERVICE: 1 },
        feedback: '有人在旁边说话，紧张会慢慢松下来。',
      },
      {
        label: '握着她的手，什么都不说',
        scores: { LOVE_TIME: 2, LOVE_TOUCH: 5, LOVE_SERVICE: 1 },
        feedback: '有些紧张不需要被解决，只需要被陪着。',
      },
      {
        label: '起来把行李再检查一遍',
        scores: { LOVE_TIME: 1, LOVE_TOUCH: 1, LOVE_SERVICE: 5 },
        feedback: '"都准备好了"这句话，本身就有安心的作用。',
      },
    ],
    tags: ['旅行', '安抚'],
  },
  {
    code: 'SC_M_16',
    audience: 'MALE',
    content: '你们已经很久没有单独出去过了。这个周末两天都有空，她想安排点什么。',
    prompt: '你更想怎么过？',
    options: [
      {
        label: '找家安静的店，坐一下午',
        scores: { LOVE_TOUCH: 2, LOVE_TIME: 5, LOVE_GIFTS: 1 },
        feedback: '一下午没什么事做，反而常常聊出点真东西。',
      },
      {
        label: '牵手去逛一逛老城区',
        scores: { LOVE_TOUCH: 5, LOVE_TIME: 3, LOVE_GIFTS: 1 },
        feedback: '走路时牵着的手，比坐着说话更放松。',
      },
      {
        label: '买件她念叨过的东西给她',
        scores: { LOVE_TOUCH: 1, LOVE_TIME: 2, LOVE_GIFTS: 5 },
        feedback: '惦记过的东西出现时，人会觉得被记住了。',
      },
    ],
    tags: ['周末', '相处'],
  },

  // ============================================================ 三、冲突风格（17–24）
  {
    code: 'SC_M_17',
    audience: 'MALE',
    content: '你们为一件小事吵起来：她认为你答应过的事没做到，你觉得自己当时只是随口应了一声。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '先把事情捋清楚，说清当时是怎么理解的',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPETING: 2 },
        feedback: '把"我听到的是什么"说明白，争论常常就换了方向。',
      },
      {
        label: '先认下来，别再吵了',
        scores: { CONFLICT_COLLABORATING: 2, CONFLICT_ACCOMMODATING: 5, CONFLICT_COMPETING: 1 },
        feedback: '架是停了，但"你根本不当回事"的印象留了下来。',
      },
      {
        label: '证明自己没答应过，把聊天记录翻出来',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPETING: 5 },
        feedback: '赢下这一场，常常要付出下一场。',
      },
    ],
    tags: ['口角', '承诺'],
  },
  {
    code: 'SC_M_18',
    audience: 'MALE',
    content: '她说了句"你根本不懂我"。你觉得自己明明一直在努力理解她，这句话让你一时说不出话。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '问她"那你说说，我哪里没懂"',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_AVOIDING: 1, CONFLICT_COMPETING: 2 },
        feedback: '这句话有时能打开局面，有时会让她更委屈。',
      },
      {
        label: '不接话，等这阵子过去',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_AVOIDING: 5, CONFLICT_COMPETING: 1 },
        feedback: '情绪会过去，但那句话还挂在两个人中间。',
      },
      {
        label: '反驳：我做的那些你都没看见吗',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_AVOIDING: 2, CONFLICT_COMPETING: 5 },
        feedback: '把付出摆出来，很少能换来理解。',
      },
    ],
    tags: ['被否定', '沟通'],
  },
  {
    code: 'SC_M_19',
    audience: 'MALE',
    content: '你们在商量要不要换城市工作。她想去，你更倾向留在这里，谁也说服不了谁。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '把两个选项的代价都摊开，一起算',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_COMPROMISING: 2, CONFLICT_COMPETING: 1 },
        feedback: '把利弊摆出来，往往能找到第三个选项。',
      },
      {
        label: '各让一步，先按她的想法试一年',
        scores: { CONFLICT_COLLABORATING: 2, CONFLICT_COMPROMISING: 5, CONFLICT_COMPETING: 1 },
        feedback: '试一年，比争一年更有信息量。',
      },
      {
        label: '坚持自己的判断，理由讲到底',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_COMPROMISING: 2, CONFLICT_COMPETING: 5 },
        feedback: '道理讲赢了，日子还是要两个人一起过。',
      },
    ],
    tags: ['重大决定', '分歧'],
  },
  {
    code: 'SC_M_20',
    audience: 'MALE',
    content: '她因为你忘了纪念日不高兴。你确实忘了，但最近实在忙得转不开。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '先认下来，再一起补过一下',
        scores: { CONFLICT_ACCOMMODATING: 5, CONFLICT_COMPROMISING: 2, CONFLICT_AVOIDING: 1 },
        feedback: '补过的意义不在日期，在"这件事我记住了"。',
      },
      {
        label: '商量一个两个人都能记住的方式',
        scores: { CONFLICT_ACCOMMODATING: 2, CONFLICT_COMPROMISING: 5, CONFLICT_AVOIDING: 1 },
        feedback: '把"记不住"变成"换个记法"，比反复道歉有用。',
      },
      {
        label: '觉得日子不重要，不解释',
        scores: { CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPROMISING: 1, CONFLICT_AVOIDING: 5 },
        feedback: '在你这里是小事，在她那里可能是"不在意"。',
      },
    ],
    tags: ['纪念日', '遗忘'],
  },
  {
    code: 'SC_M_21',
    audience: 'MALE',
    content: '吵架的时候她说了一句很重的话。你愣住了，她也愣住了，房间里很安静。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说出"这句话让我挺难受的"',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_AVOIDING: 1, CONFLICT_COMPETING: 2 },
        feedback: '把感受讲出来，比把这句话记下来更有用。',
      },
      {
        label: '先出去走一圈再回来',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_AVOIDING: 5, CONFLICT_COMPETING: 1 },
        feedback: '离开一下能让火降下来，前提是说了会回来。',
      },
      {
        label: '用更重的话顶回去',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_AVOIDING: 1, CONFLICT_COMPETING: 5 },
        feedback: '这种话两个人都不会忘，只是都不会提。',
      },
    ],
    tags: ['激烈', '受伤'],
  },
  {
    code: 'SC_M_22',
    audience: 'MALE',
    content: '她的家人对你有些意见，她夹在中间。这次家庭聚会，她希望你能多待一会儿。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '留下来，把该做的礼数做足',
        scores: { CONFLICT_ACCOMMODATING: 5, CONFLICT_COMPROMISING: 2, CONFLICT_AVOIDING: 1 },
        feedback: '你在替她分担一件她很难自己解决的事。',
      },
      {
        label: '跟她说清楚你的不舒服，商量待多久',
        scores: { CONFLICT_ACCOMMODATING: 2, CONFLICT_COMPROMISING: 5, CONFLICT_AVOIDING: 1 },
        feedback: '"我待到几点"比"我不想待"更容易谈成。',
      },
      {
        label: '找理由先走',
        scores: { CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPROMISING: 1, CONFLICT_AVOIDING: 5 },
        feedback: '你轻松了，她要独自面对剩下的那些问话。',
      },
    ],
    tags: ['家人', '立场'],
  },
  {
    code: 'SC_M_23',
    audience: 'MALE',
    content: '同一个小矛盾你们已经吵过三次了，每次都是绕回同一句话。这次又开始了。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '停下来说"我们好像一直在绕同一件事"',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_COMPROMISING: 2, CONFLICT_AVOIDING: 1 },
        feedback: '把循环本身指出来，是打破它最常见的方式。',
      },
      {
        label: '换个说法再谈一次，各退半步',
        scores: { CONFLICT_COLLABORATING: 2, CONFLICT_COMPROMISING: 5, CONFLICT_AVOIDING: 1 },
        feedback: '换个说法有时真的能让对方听进去。',
      },
      {
        label: '敷衍过去，别又吵起来',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_COMPROMISING: 1, CONFLICT_AVOIDING: 5 },
        feedback: '第四次通常不会比前三次轻。',
      },
    ],
    tags: ['重复矛盾', '模式'],
  },
  {
    code: 'SC_M_24',
    audience: 'MALE',
    content: '你和她都对，只是看法不同。她说"这事就这么定了"，语气不容商量。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说"我还有点想法，给我五分钟"',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPETING: 2 },
        feedback: '要五分钟，比要一个结论容易得多。',
      },
      {
        label: '这次随她，下次再说',
        scores: { CONFLICT_COLLABORATING: 2, CONFLICT_ACCOMMODATING: 5, CONFLICT_COMPETING: 1 },
        feedback: '"下次"攒多了会变成一件说不清的事。',
      },
      {
        label: '把话说重，逼她重新考虑',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPETING: 5 },
        feedback: '这一次或许有效，代价是以后每次都要用力。',
      },
    ],
    tags: ['僵持', '让步'],
  },
];
