/**
 * 沉浸式情感测评场景题库 —— **女生版**（ADR-039，24 个场景）
 *
 * ## 与男生版的关系
 *
 * 两套是**独立内容**，不是一套换代词。处境本身有性别角色差异：
 * 被说"你想太多了"、要不要等他先开口、在他家人面前的位置、朋友聚会里被忽略……
 * 换代词的做法用户一眼就看得出来（"这题不是给我出的"）。
 *
 * 但**处境差异不等于脚本差异**：没有一个选项是"女生应该怎样"。
 * 每个做法都能拿到一句中性的、关于后续的反馈。
 *
 * ## 计分：分值挂在**选项**上，且一个场景内**所有选项的维度键必须一致**
 *
 * ⚠ 见男生版文件头的完整说明。两条都是会让分数静默失真的规则：
 *   ① 部分覆盖会退回题型默认量程 `0–1`，把分值 4 的选项 `clamp` 成满分；
 *   ② 键集合不同会让"选 A 的人有这项数据、选 B 的人没有"，两人的画像无法比较。
 *
 * ## 维度覆盖（硬约束，单测断言：每维度 ≥4 个选项命中、≥3 个不同场景）
 *
 *   场景 1–6   依恋两轴      场景 7–16  爱的语言（每题 3 项）
 *   场景 17–24 冲突风格（每题 3 种）
 *
 * ## 写作红线
 *
 *   · 反馈**只描述"这样做的常见后续"**，不评判对错、不给建议；
 *   · 不写性别刻板印象，也不写"男生都这样"这类归因；
 *   · 不出现诊断与量表术语（"焦虑型依恋""回避型"等词只在结果页出现，不在题面上）。
 */

import type { SeedScenarioQuestion } from '../types';

export const EMOTION_SCENARIOS_FEMALE: SeedScenarioQuestion[] = [
  // ============================================================ 一、依恋两轴（1–6）
  {
    code: 'SC_F_01',
    audience: 'FEMALE',
    content: '你等到十一点多他才进门，一直开着的那盏灯有点刺眼。你问他怎么这么晚，他说"临时有事，忘了说"。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说清楚自己等得有点难受',
        scores: { ATTACH_ANXIETY: 3, ATTACH_AVOIDANCE: 1 },
        feedback: '把"我一直在等"说出来，比说"你怎么才回来"更容易被听见。',
      },
      {
        label: '说没事，去把灯关掉',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 4 },
        feedback: '灯关了，那点没说出口的委屈还在。',
      },
      {
        label: '一直想着他是不是不想回来',
        scores: { ATTACH_ANXIETY: 5, ATTACH_AVOIDANCE: 2 },
        feedback: '这个念头会跟着你到第二天，而它多半没有依据。',
      },
    ],
    tags: ['晚归', '等待'],
  },
  {
    code: 'SC_F_02',
    audience: 'FEMALE',
    content: '你发了一大段话跟他讲今天遇到的事，他回了"嗯，知道了"。你盯着这五个字看了很久。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '问他刚才是不是在忙',
        scores: { ATTACH_ANXIETY: 3, ATTACH_AVOIDANCE: 1 },
        feedback: '多数时候答案是"在开会"，而不是"不想听"。',
      },
      {
        label: '先不说了，等他有空再聊',
        scores: { ATTACH_ANXIETY: 2, ATTACH_AVOIDANCE: 4 },
        feedback: '等一等通常没问题，只是那句"知道了"会一直留着。',
      },
      {
        label: '觉得他根本不在意你说什么',
        scores: { ATTACH_ANXIETY: 5, ATTACH_AVOIDANCE: 2 },
        feedback: '一句话被读成一个态度，是很容易发生的事。',
      },
    ],
    tags: ['消息', '被忽略'],
  },
  {
    code: 'SC_F_03',
    audience: 'FEMALE',
    content: '你们约好周末去看展，他昨晚说同事约了球局，问你"能不能改天"。票是你上周就买好的。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说清楚票已经买了，商量怎么办',
        scores: { ATTACH_ANXIETY: 3, ATTACH_AVOIDANCE: 1 },
        feedback: '把事实摆出来，通常能找到一个两个人都能接受的办法。',
      },
      {
        label: '说你去吧，我自己去也行',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 4 },
        feedback: '你确实可以自己去，只是那天可能会有点安静。',
      },
      {
        label: '问他是不是不想跟你去',
        scores: { ATTACH_ANXIETY: 5, ATTACH_AVOIDANCE: 2 },
        feedback: '这句话很容易让话题从"改天"变成"你多想了"。',
      },
    ],
    tags: ['临时变卦', '约定'],
  },
  {
    code: 'SC_F_04',
    audience: 'FEMALE',
    content: '他最近在赶项目，你已经三天没和他好好说过话。今晚你终于有空，他说"我再忙两天"。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说好，那你有空叫我，然后安排自己的事',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 3 },
        feedback: '各自忙各自的，关系不会因为几天安静就散掉。',
      },
      {
        label: '告诉他你有点想他，不用回',
        scores: { ATTACH_ANXIETY: 3, ATTACH_AVOIDANCE: 1 },
        feedback: '不要求回应的一句话，反而常常被记住。',
      },
      {
        label: '开始回想他最近是不是变了',
        scores: { ATTACH_ANXIETY: 5, ATTACH_AVOIDANCE: 2 },
        feedback: '有了这个开头，之后每一次忙都会被它解释一遍。',
      },
    ],
    tags: ['忙碌', '距离感'],
  },
  {
    code: 'SC_F_05',
    audience: 'FEMALE',
    content: '他和朋友聚会，手机一直没接。你打了三个电话，最后一个被挂掉了。屏幕暗下去的时候，房间里很静。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '发条消息说"看到回我一下就好"，然后去做别的事',
        scores: { ATTACH_ANXIETY: 2, ATTACH_AVOIDANCE: 3 },
        feedback: '把话说完就放下手机，比守着屏幕好过得多。',
      },
      {
        label: '一直打到他接为止',
        scores: { ATTACH_ANXIETY: 5, ATTACH_AVOIDANCE: 1 },
        feedback: '他接起来时，两个人大概都已经很不平静了。',
      },
      {
        label: '不打了，心里记下这件事',
        scores: { ATTACH_ANXIETY: 4, ATTACH_AVOIDANCE: 3 },
        feedback: '记下的这件事，之后会以别的形式再出现一次。',
      },
    ],
    tags: ['联系不上', '不安'],
  },
  {
    code: 'SC_F_06',
    audience: 'FEMALE',
    content: '他带你见他的老同学。饭桌上他们聊起大学时的事，笑得很开心，你插不上话，只能跟着笑。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '听着，偶尔问一句那时候的事',
        scores: { ATTACH_ANXIETY: 1, ATTACH_AVOIDANCE: 2 },
        feedback: '愿意听，本身就是参与的一种方式。',
      },
      {
        label: '找机会把话题引到你们都熟的事上',
        scores: { ATTACH_ANXIETY: 4, ATTACH_AVOIDANCE: 2 },
        feedback: '有时能把场面接过来，有时会让气氛顿一下。',
      },
      {
        label: '安静吃饭，等结束再说',
        scores: { ATTACH_ANXIETY: 2, ATTACH_AVOIDANCE: 4 },
        feedback: '这一晚你大概不会出错，但也参与得很少。',
      },
    ],
    tags: ['社交场合', '融入'],
  },

  // ============================================================ 二、爱的语言（7–16）
  {
    code: 'SC_F_07',
    audience: 'FEMALE',
    content: '你连着加班两周，今天终于早点回家。他发来一句"我把饭做好了，你直接回来"。',
    prompt: '这一刻你更想要的是哪一种？',
    options: [
      {
        label: '和他一起把饭吃完，慢慢聊',
        scores: { LOVE_TIME: 5, LOVE_WORDS: 2, LOVE_SERVICE: 1 },
        feedback: '一整顿饭的时间，是很多人最缺的那种陪伴。',
      },
      {
        label: '听他说一句"这段时间辛苦你了"',
        scores: { LOVE_TIME: 2, LOVE_WORDS: 5, LOVE_SERVICE: 1 },
        feedback: '被看见的辛苦，和辛苦本身不是一回事。',
      },
      {
        label: '他不声不响把碗也洗了',
        scores: { LOVE_TIME: 1, LOVE_WORDS: 2, LOVE_SERVICE: 5 },
        feedback: '不说出口的照顾，有人觉得最踏实。',
      },
    ],
    tags: ['下班', '被在乎'],
  },
  {
    code: 'SC_F_08',
    audience: 'FEMALE',
    content: '生日那天，他准备了两样东西：一个你提过好几次的小东西，和一封写满一页的信。',
    prompt: '哪一样更让你心里一动？',
    options: [
      {
        label: '那个你提过好几次的小东西',
        scores: { LOVE_GIFTS: 5, LOVE_WORDS: 2, LOVE_TIME: 1 },
        feedback: '被记住一句随口的念叨，是礼物真正的分量。',
      },
      {
        label: '那封写了一整页的信',
        scores: { LOVE_GIFTS: 2, LOVE_WORDS: 5, LOVE_TIME: 1 },
        feedback: '写下来的话，会被人反复拿出来看。',
      },
      {
        label: '他推掉别的安排陪你一整天',
        scores: { LOVE_GIFTS: 1, LOVE_WORDS: 2, LOVE_TIME: 5 },
        feedback: '时间是最不好补的东西，所以它最贵。',
      },
    ],
    tags: ['生日', '礼物'],
  },
  {
    code: 'SC_F_09',
    audience: 'FEMALE',
    content: '你在会上被否了一个做了很久的方案，回家情绪很差。你已经尽量不表现出来，他还是问了。',
    prompt: '这时候你最希望他怎么做？',
    options: [
      {
        label: '坐下来陪你待着，不用说什么',
        scores: { LOVE_TIME: 4, LOVE_SERVICE: 1, LOVE_GIFTS: 1 },
        feedback: '有时候陪着不出主意，比出主意更难得。',
      },
      {
        label: '默默把今晚的家务都接过去',
        scores: { LOVE_TIME: 1, LOVE_SERVICE: 5, LOVE_GIFTS: 1 },
        feedback: '有人替你分担掉几件小事，情绪会松一圈。',
      },
      {
        label: '回来路上给你带了你爱吃的',
        scores: { LOVE_TIME: 1, LOVE_SERVICE: 2, LOVE_GIFTS: 5 },
        feedback: '被顺手惦记着，是很具体的一种安慰。',
      },
    ],
    tags: ['受挫', '安慰'],
  },
  {
    code: 'SC_F_10',
    audience: 'FEMALE',
    content: '你们看完电影走了一段夜路，他一直牵着你的手，没怎么说话。风有点凉。',
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
        label: '心里还在想着白天的事，有点走神',
        scores: { LOVE_TOUCH: 2, LOVE_TIME: 1, LOVE_WORDS: 1 },
        feedback: '人在旁边、心不在，是很容易被察觉到的那种缺席。',
      },
    ],
    tags: ['散步', '亲近'],
  },
  {
    code: 'SC_F_11',
    audience: 'FEMALE',
    content: '他出差一周。走之前留了张便条，把家里收拾好，还每天忙完给你打个短电话。',
    prompt: '这一周里，你更在意哪一样？',
    options: [
      {
        label: '那张便条，你留到了他回来',
        scores: { LOVE_WORDS: 5, LOVE_SERVICE: 2, LOVE_TIME: 3 },
        feedback: '一张纸条能撑一周，靠的不是内容，是它一直在那儿。',
      },
      {
        label: '他把家里都收拾妥当了',
        scores: { LOVE_WORDS: 1, LOVE_SERVICE: 5, LOVE_TIME: 2 },
        feedback: '被人照顾过日子的痕迹，一进门就能想起来。',
      },
      {
        label: '那每天几分钟的电话',
        scores: { LOVE_WORDS: 3, LOVE_SERVICE: 1, LOVE_TIME: 5 },
        feedback: '哪怕只有几分钟，那几分钟是专门给你的。',
      },
    ],
    tags: ['出差', '想念'],
  },
  {
    code: 'SC_F_12',
    audience: 'FEMALE',
    content: '你换了工作，收入暂时降了一截。你还在犹豫怎么开口，他先提起了这件事。',
    prompt: '你更希望他怎么表达？',
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
        label: '把自己的计划往后放一放',
        scores: { LOVE_SERVICE: 2, LOVE_GIFTS: 5, LOVE_WORDS: 1 },
        feedback: '把想要的东西先放下，很少有人会说出口。',
      },
    ],
    tags: ['压力', '共同面对'],
  },
  {
    code: 'SC_F_13',
    audience: 'FEMALE',
    content: '你生理期第一天，疼得只能蜷在床上。他下班回来，手里拎着热水袋和粥。',
    prompt: '这一刻你更想要的是？',
    options: [
      {
        label: '他把热水袋和药递到手里',
        scores: { LOVE_TIME: 2, LOVE_SERVICE: 5, LOVE_TOUCH: 1 },
        feedback: '难受时被照顾到细节，很少有人会忘记。',
      },
      {
        label: '他坐在床边陪你说说话',
        scores: { LOVE_TIME: 5, LOVE_SERVICE: 2, LOVE_TOUCH: 3 },
        feedback: '难受的时候有人在旁边，时间会过得快一点。',
      },
      {
        label: '他伸手帮你揉一揉肚子',
        scores: { LOVE_TIME: 2, LOVE_SERVICE: 3, LOVE_TOUCH: 5 },
        feedback: '一个很小的动作，常常比一句话更让人安心。',
      },
    ],
    tags: ['身体不适', '照顾'],
  },
  {
    code: 'SC_F_14',
    audience: 'FEMALE',
    content: '你终于拿下了那个准备了很久的机会，回家跟他讲了一路。他一直在听，中间没怎么插话。',
    prompt: '这时候你更希望他怎么做？',
    options: [
      {
        label: '认真听完，把高兴说出来',
        scores: { LOVE_WORDS: 5, LOVE_TIME: 3, LOVE_TOUCH: 1 },
        feedback: '被认真听完的那一刻，比自己拿下还开心。',
      },
      {
        label: '说"那今晚出去吃一顿"',
        scores: { LOVE_WORDS: 2, LOVE_TIME: 5, LOVE_TOUCH: 1 },
        feedback: '把高兴变成一件具体的事，两个人都记得住这天。',
      },
      {
        label: '抱住你说"厉害啊"',
        scores: { LOVE_WORDS: 3, LOVE_TIME: 2, LOVE_TOUCH: 5 },
        feedback: '有些高兴，用动作表达比用句子更到位。',
      },
    ],
    tags: ['好消息', '分享'],
  },
  {
    code: 'SC_F_15',
    audience: 'FEMALE',
    content: '你们计划了很久的一次旅行，出发前一晚你有点紧张，翻来覆去睡不着。',
    prompt: '这时候你更希望他怎么做？',
    options: [
      {
        label: '陪你聊一会儿，直到你困了',
        scores: { LOVE_TIME: 5, LOVE_TOUCH: 2, LOVE_SERVICE: 1 },
        feedback: '有人在旁边说话，紧张会慢慢松下来。',
      },
      {
        label: '握着你的手，什么都不说',
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
    code: 'SC_F_16',
    audience: 'FEMALE',
    content: '你们已经很久没有单独出去过了。这个周末两天都有空，你想安排点什么。',
    prompt: '你更想怎么过？',
    options: [
      {
        label: '找家安静的店，坐一下午',
        scores: { LOVE_TOUCH: 2, LOVE_TIME: 5, LOVE_GIFTS: 1 },
        feedback: '一下午没什么事做，反而常常聊出点真东西。',
      },
      {
        label: '牵着手去逛一逛老城区',
        scores: { LOVE_TOUCH: 5, LOVE_TIME: 3, LOVE_GIFTS: 1 },
        feedback: '走路时牵着的手，比坐着说话更放松。',
      },
      {
        label: '让他陪你去挑那件看了很久的东西',
        scores: { LOVE_TOUCH: 1, LOVE_TIME: 2, LOVE_GIFTS: 5 },
        feedback: '有人愿意陪你逛很久，这件事本身也在里面。',
      },
    ],
    tags: ['周末', '相处'],
  },

  // ============================================================ 三、冲突风格（17–24）
  {
    code: 'SC_F_17',
    audience: 'FEMALE',
    content: '你说了半天今天有多累，他说了句"你想太多了"。你一下子不想说了。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说"我需要的不是解决办法，是听我说完"',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPETING: 2 },
        feedback: '把需求说具体，对方才知道该怎么做。',
      },
      {
        label: '算了，不说了，去洗澡',
        scores: { CONFLICT_COLLABORATING: 2, CONFLICT_ACCOMMODATING: 5, CONFLICT_COMPETING: 1 },
        feedback: '这一次避开了，下一次开口会更难。',
      },
      {
        label: '反问"那我以后什么都别说了？"',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPETING: 5 },
        feedback: '这句话一出，话题就变成谁的态度更差了。',
      },
    ],
    tags: ['被否定', '表达'],
  },
  {
    code: 'SC_F_18',
    audience: 'FEMALE',
    content: '你发现他答应过的事又忘了。这次你什么都没说，只是那天晚上没怎么理他。',
    prompt: '这时候你更接近哪种做法？',
    options: [
      {
        label: '把这件事拿出来谈一次',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_AVOIDING: 1, CONFLICT_COMPETING: 2 },
        feedback: '"又忘了"这件事，谈一次比压三次有用。',
      },
      {
        label: '就这样冷着，等他自己发现',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_AVOIDING: 5, CONFLICT_COMPETING: 1 },
        feedback: '他很可能只感觉到你心情不好，却不知道原因。',
      },
      {
        label: '说一句"你从来都记不住我的事"',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_AVOIDING: 2, CONFLICT_COMPETING: 5 },
        feedback: '"从来"这个词一出来，对方只会去证明它不成立。',
      },
    ],
    tags: ['失望', '冷战'],
  },
  {
    code: 'SC_F_19',
    audience: 'FEMALE',
    content: '你们在商量要不要和他父母一起住。你觉得需要时间适应，他认为"这有什么好想的"。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '把顾虑一条条讲清楚，一起找折中方案',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_COMPROMISING: 2, CONFLICT_COMPETING: 1 },
        feedback: '具体的顾虑比笼统的"我不想"更容易被接住。',
      },
      {
        label: '先试住一段时间，说好再商量',
        scores: { CONFLICT_COLLABORATING: 2, CONFLICT_COMPROMISING: 5, CONFLICT_COMPETING: 1 },
        feedback: '设一个期限，比含糊地答应要安全得多。',
      },
      {
        label: '态度强硬一点，让他知道这事不能这么定',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_COMPROMISING: 2, CONFLICT_COMPETING: 5 },
        feedback: '把态度摆出来有用，但接下来要谈的就不只是这件事了。',
      },
    ],
    tags: ['重大决定', '家人'],
  },
  {
    code: 'SC_F_20',
    audience: 'FEMALE',
    content: '他忘了你们的纪念日。你其实早就提醒过一次，他说"最近实在太忙了"。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '直接说你很在意这个日子',
        scores: { CONFLICT_ACCOMMODATING: 5, CONFLICT_COMPROMISING: 2, CONFLICT_AVOIDING: 1 },
        feedback: '把在意说出来，他才有可能记住下一次。',
      },
      {
        label: '商量一个两个人都能记住的方式',
        scores: { CONFLICT_ACCOMMODATING: 2, CONFLICT_COMPROMISING: 5, CONFLICT_AVOIDING: 1 },
        feedback: '把"记不住"换成"换个记法"，比反复失望有用。',
      },
      {
        label: '说没关系，然后自己难过了好几天',
        scores: { CONFLICT_ACCOMMODATING: 2, CONFLICT_COMPROMISING: 1, CONFLICT_AVOIDING: 5 },
        feedback: '"没关系"说多了，对方会真的以为没关系。',
      },
    ],
    tags: ['纪念日', '在意'],
  },
  {
    code: 'SC_F_21',
    audience: 'FEMALE',
    content: '吵架时他说了一句很难听的话。你愣住了，他也停住了，屋里安静得能听见钟走。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说出"这句话让我很难受"',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_AVOIDING: 1, CONFLICT_COMPETING: 2 },
        feedback: '把感受讲出来，比把这句话记下来更有用。',
      },
      {
        label: '转身进房间，把门关上',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_AVOIDING: 5, CONFLICT_COMPETING: 1 },
        feedback: '门关上之后，两个人各自想的往往是不同的事。',
      },
      {
        label: '把更重的话还回去',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_AVOIDING: 1, CONFLICT_COMPETING: 5 },
        feedback: '这种话两个人都不会忘，只是都不会提。',
      },
    ],
    tags: ['激烈', '受伤'],
  },
  {
    code: 'SC_F_22',
    audience: 'FEMALE',
    content: '他妈妈当面问你们"打算什么时候要孩子"。他低头夹菜，没接话，桌上几个人都在看你。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '笑着接一句，把话题岔开',
        scores: { CONFLICT_ACCOMMODATING: 5, CONFLICT_COMPROMISING: 2, CONFLICT_AVOIDING: 1 },
        feedback: '这一顿过去了，但这件事还会被问第二次。',
      },
      {
        label: '说"我们还在商量，定了会告诉您"',
        scores: { CONFLICT_ACCOMMODATING: 2, CONFLICT_COMPROMISING: 5, CONFLICT_AVOIDING: 1 },
        feedback: '给一个不承诺也不失礼的答案，是最常见的解法。',
      },
      {
        label: '当场看向他，等他先开口',
        scores: { CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPROMISING: 1, CONFLICT_AVOIDING: 5 },
        feedback: '他多半会尴尬，而你想要的回答通常不会出现。',
      },
    ],
    tags: ['长辈', '边界'],
  },
  {
    code: 'SC_F_23',
    audience: 'FEMALE',
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
        label: '不说了，说也说不明白',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_COMPROMISING: 1, CONFLICT_AVOIDING: 5 },
        feedback: '第四次通常不会比前三次轻。',
      },
    ],
    tags: ['重复矛盾', '模式'],
  },
  {
    code: 'SC_F_24',
    audience: 'FEMALE',
    content: '你和他都觉得自己有理。他说"这事就这么定了"，语气不容商量。',
    prompt: '这时候你会怎么做？',
    options: [
      {
        label: '说"我还有点想法，给我五分钟"',
        scores: { CONFLICT_COLLABORATING: 5, CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPETING: 2 },
        feedback: '要五分钟，比要一个结论容易得多。',
      },
      {
        label: '这次听他的，下次再说',
        scores: { CONFLICT_COLLABORATING: 2, CONFLICT_ACCOMMODATING: 5, CONFLICT_COMPETING: 1 },
        feedback: '"下次"攒多了会变成一件说不清的事。',
      },
      {
        label: '坚持自己的方案，不让步',
        scores: { CONFLICT_COLLABORATING: 1, CONFLICT_ACCOMMODATING: 1, CONFLICT_COMPETING: 5 },
        feedback: '这一次或许有效，代价是以后每次都要用力。',
      },
    ],
    tags: ['僵持', '话语权'],
  },
];
