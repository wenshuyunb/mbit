/**
 * MBTI 16 类型百科 — 内容数据（纯数据文件，无逻辑）
 *
 * 内容：每个类型的标语、描述、四维倾向强度、优势 / 盲点 / 关系建议与画像摘要模板。
 * 分组：分析家（INTJ/INTP/ENTJ/ENTP）、外交家（INFJ/INFP/ENFJ/ENFP）、
 *       守护者（ISTJ/ISFJ/ESTJ/ESFJ）、探险家（ISTP/ISFP/ESTP/ESFP）。
 * 用途：自我探索类参考内容，供类型百科接口与画像摘要模板使用。
 */

import type { MbtiTypeProfile } from './mbti-types.types';

export const MBTI_TYPE_PROFILES: MbtiTypeProfile[] = [
  {
    type: 'INTJ',
    typeName: '建筑师',
    typeNameEn: 'Architect',
    group: 'ANALYST',
    groupName: '分析家',
    groupColor: '#88619A',
    tagline: '习惯在推演里预演未来，然后安静地把它建成',
    description:
      '习惯先在内部搭建模型再接触外界，把零散信息整理成因果链。决策时更看重逻辑一致性与效率而非现场气氛，需要独立判断的场合表现稳定。人际中不算冷淡，只是偏就事论事，容易让重视情绪回应的人感到距离。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'I', label: '内向', percent: 78 },
      { dimension: 'SN', pole: 'N', label: '直觉', percent: 72 },
      { dimension: 'TF', pole: 'T', label: '思考', percent: 70 },
      { dimension: 'JP', pole: 'J', label: '判断', percent: 76 },
    ],
    strengths: [
      { title: '长期布局', description: '愿意用较长的时间尺度衡量选择，为尚未到来的结果持续投入准备。' },
      { title: '独立校验', description: '面对冲突信息时倾向于自己拆解验证，不易被多数意见或现场情绪带走。' },
      { title: '结构拆解', description: '擅长把模糊的问题切成可处理的层次，找出其中起决定作用的环节。' },
      { title: '目标韧性', description: '认定方向值得之后，能承受较长的枯燥期并稳定推进既定计划。' },
    ],
    blindSpots: [
      { title: '情绪盲区', description: '注意力集中在问题本身，可能没察觉对方此刻更需要被理解而非建议。' },
      { title: '过早收敛', description: '形成判断后容易停止收集新信息，使结论慢慢脱离实际发生的变化。' },
      { title: '标准偏严', description: '对自己和他人的要求都偏高，可能低估团队需要被肯定的部分。' },
    ],
    relationshipTips: [
      { title: '先说感受', description: '表达观点前先讲一句自己的真实感受，例如我今天有点累，再进入讨论。' },
      { title: '定期确认', description: '每周留十分钟只问对方最近哪件事让你不舒服，听完先不急着辩解。' },
      { title: '留出空档', description: '和亲近的人相处时可以先不安排目的，把节奏交给对方主导一次。' },
    ],
    summary: {
      headline: '安静的战略家，用长期视角处理复杂问题',
      strengths: ['长期规划', '独立验证', '结构思维'],
      watchouts: ['情绪疏漏', '应变偏慢', '标准偏高'],
    },
  },
  {
    type: 'INTP',
    typeName: '逻辑学家',
    typeNameEn: 'Logician',
    group: 'ANALYST',
    groupName: '分析家',
    groupColor: '#88619A',
    tagline: '对世界保持好奇，也对自己的结论保留怀疑',
    description:
      '注意力常被原理与机制吸引，相比记住结论更想弄清结论怎么来的。习惯在脑内反复推演各种可能性，因此常同时保留几个待解的疑问。表达偏精确自洽，对含糊说法较敏感，也不太习惯给出即时的情绪反馈。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'I', label: '内向', percent: 72 },
      { dimension: 'SN', pole: 'N', label: '直觉', percent: 80 },
      { dimension: 'TF', pole: 'T', label: '思考', percent: 74 },
      { dimension: 'JP', pole: 'P', label: '知觉', percent: 76 },
    ],
    strengths: [
      { title: '原理探究', description: '比起结论本身，更愿意弄清背后的运行机制与前提假设是什么。' },
      { title: '逻辑校验', description: '能较快发现说法里的前后矛盾，并指出论证中缺失的关键环节。' },
      { title: '思维开放', description: '遇到更合理的解释时愿意修改原有判断，不把观点当成立场。' },
      { title: '独立探索', description: '不需要外部督促，也能长时间沉浸在感兴趣的题目里直到弄通。' },
    ],
    blindSpots: [
      { title: '落地偏慢', description: '想法停留在推演阶段的时间较长，容易耽误已经约定好的节点。' },
      { title: '忽略细节', description: '对流程性与重复性的细碎事项兴趣不高，可能遗漏必要步骤。' },
      { title: '回应延迟', description: '面对情绪表达时容易先分析原因，让对方觉得回应来得太慢。' },
    ],
    relationshipTips: [
      { title: '及时回应', description: '对方说完后先回一句我听到了，再讲你的分析，别让沉默太久。' },
      { title: '说清需求', description: '把需要独处的时段提前告知对方，并约定结束后的联系时间。' },
      { title: '一起做事', description: '用共同做一件小事代替长时间的闲聊，能在放松的状态里保持连接。' },
    ],
    summary: {
      headline: '喜欢追问原理的思考者，独立且乐于修正',
      strengths: ['原理洞察', '逻辑严谨', '开放修正'],
      watchouts: ['落地偏慢', '细节疏漏', '回应延迟'],
    },
  },
  {
    type: 'ENTJ',
    typeName: '指挥官',
    typeNameEn: 'Commander',
    group: 'ANALYST',
    groupName: '分析家',
    groupColor: '#88619A',
    tagline: '先确定方向，再把人和资源组织起来推进',
    description:
      '倾向先确定目标与优先级，再调动人和资源推进下去，对低效和拖延耐受度偏低。决策以结果与逻辑为主要依据，愿意承担责任，也习惯直接给出反馈。关系里更看重共同目标与相互尊重，表达直接，容易让人感觉节奏偏快。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'E', label: '外向', percent: 76 },
      { dimension: 'SN', pole: 'N', label: '直觉', percent: 68 },
      { dimension: 'TF', pole: 'T', label: '思考', percent: 78 },
      { dimension: 'JP', pole: 'J', label: '判断', percent: 80 },
    ],
    strengths: [
      { title: '目标导向', description: '能迅速判断什么最重要，并让团队把注意力集中在这件事上。' },
      { title: '决断力强', description: '信息不完整时也敢于做出选择，并在推进过程中根据反馈调整。' },
      { title: '担当责任', description: '出现问题时不回避，倾向先承认这是我的判断失误再谈补救。' },
      { title: '组织资源', description: '擅长把分散的人和条件串成一条可执行的推进路径，再分配任务。' },
    ],
    blindSpots: [
      { title: '节奏过快', description: '推进速度容易超出他人的适应范围，使同伴经常感到被催促。' },
      { title: '情绪忽略', description: '关注事情进展多于关注对方感受，可能错过他当下需要的支持。' },
      { title: '耐受偏低', description: '对反复与缓慢的容忍度不高，压力大时语气会变得明显强硬。' },
    ],
    relationshipTips: [
      { title: '询问节奏', description: '推进计划前先问对方现在的节奏能接住多少，再定具体时间表。' },
      { title: '反馈方式', description: '指出问题后补一句具体的肯定，说明你认可对方哪部分努力。' },
      { title: '留出倾听', description: '每天留出十分钟只听对方讲完，不评价也不急着提改进方案。' },
    ],
    summary: {
      headline: '目标明确的推动者，愿意为结果承担责任',
      strengths: ['目标清晰', '决断果断', '组织推进'],
      watchouts: ['节奏过快', '情绪忽略', '耐心偏少'],
    },
  },
  {
    type: 'ENTP',
    typeName: '辩论家',
    typeNameEn: 'Debater',
    group: 'ANALYST',
    groupName: '分析家',
    groupColor: '#88619A',
    tagline: '用提问撬动既有结论，也享受可能性本身',
    description:
      '对新想法反应快，喜欢从不同角度重排问题。相比维护现有结论，更愿意检验它是否站得住，因此对话里常出现反问与假设。兴趣切换较快，容易同时开启多个方向，关系中以思想交流建立亲近感，也需留意对方的情绪需求。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'E', label: '外向', percent: 70 },
      { dimension: 'SN', pole: 'N', label: '直觉', percent: 82 },
      { dimension: 'TF', pole: 'T', label: '思考', percent: 68 },
      { dimension: 'JP', pole: 'P', label: '知觉', percent: 74 },
    ],
    strengths: [
      { title: '快速联想', description: '能在很短时间里把两个不相干的领域连起来，提出新的角度。' },
      { title: '敢于质疑', description: '面对流传很广的说法，会先追问它究竟在什么前提下才成立。' },
      { title: '临场应变', description: '讨论中局势变化时能迅速换一套说法，把对话重新带回到轨道上。' },
      { title: '兴趣广博', description: '对多个领域都保持兴趣，容易从中找到可以借用的思路与方法。' },
    ],
    blindSpots: [
      { title: '收尾偏弱', description: '开启的讨论与项目往往较多，真正收尾的部分容易比预期少。' },
      { title: '言语锋利', description: '辩论时会顺着逻辑一路推下去，可能没注意对方已经觉得被冒犯。' },
      { title: '承诺过满', description: '兴致上来时容易答应超出精力范围的安排，之后需要解释推迟。' },
    ],
    relationshipTips: [
      { title: '先听后辩', description: '对方讲完先复述一遍他的意思，确认没理解偏再提出不同看法。' },
      { title: '落实约定', description: '把答应过的事写进日程并设好提醒，不要只留在当时的对话里。' },
      { title: '注意语气', description: '想说这不对之前先加一句我理解你的想法，再讲出自己的不同意见。' },
    ],
    summary: {
      headline: '思路活跃的探索者，用提问打开新的可能',
      strengths: ['快速联想', '敢于质疑', '临场应变'],
      watchouts: ['收尾偏弱', '言语锋利', '承诺过满'],
    },
  },
  {
    type: 'INFJ',
    typeName: '提倡者',
    typeNameEn: 'Advocate',
    group: 'DIPLOMAT',
    groupName: '外交家',
    groupColor: '#33A474',
    tagline: '安静地相信人的可能性，并愿意为之行动',
    description:
      '对人和情境的细微变化比较敏感，倾向追问表面现象背后的动机与意义。与人相处时常先理解对方处境再回应，因此容易被当作可以倾诉的对象。独处是其恢复精力的主要方式，希望自己的选择与内在价值保持一致。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'I', label: '内向', percent: 74 },
      { dimension: 'SN', pole: 'N', label: '直觉', percent: 78 },
      { dimension: 'TF', pole: 'F', label: '情感', percent: 66 },
      { dimension: 'JP', pole: 'J', label: '判断', percent: 72 },
    ],
    strengths: [
      { title: '深度共情', description: '能听出对方话里没说出口的部分，并给出贴近其处境的回应。' },
      { title: '价值坚定', description: '一旦确认某件事符合自己的原则，愿意长期坚持而不轻易转向。' },
      { title: '长远洞察', description: '习惯从人的动机与长期走向理解当下，较少被短期波动带偏。' },
      { title: '文字表达', description: '常能把复杂的感受整理成准确的说法，让别人更容易理解自己。' },
    ],
    blindSpots: [
      { title: '过度承担', description: '容易把别人的困难当成自己的责任，长期下来精力被大量占用。' },
      { title: '理想落差', description: '对关系与工作的期待偏高，现实不如预期时容易感到明显失落。' },
      { title: '不易求助', description: '习惯自己消化压力，等到愿意开口求助时往往已经积累了较久。' },
    ],
    relationshipTips: [
      { title: '说出需要', description: '不要用暗示让对方猜，直接讲出你希望他做的一件具体的事。' },
      { title: '设定期限', description: '帮助别人之前先约定好你投入的时间与范围，避免无限期延长。' },
      { title: '接受差异', description: '发现对方做法不同时先问清他的理由，再决定是否坚持自己。' },
    ],
    summary: {
      headline: '安静的理想主义者，敏感而坚定',
      strengths: ['深度共情', '价值驱动', '长期专注'],
      watchouts: ['过度承担', '期待偏高', '忽视自己'],
    },
  },
  {
    type: 'INFP',
    typeName: '调停者',
    typeNameEn: 'Mediator',
    group: 'DIPLOMAT',
    groupName: '外交家',
    groupColor: '#33A474',
    tagline: '把内心的价值感，一点点带进现实世界',
    description:
      '内心有一套关于对错的标准，做选择时更在意是否符合它，而不只是权衡利弊。对语言和氛围中的情绪信号比较敏感，容易被他人的处境打动，也习惯在独处中慢慢整理感受。表达偏含蓄，需要时间才能把内在的想法说清楚。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'I', label: '内向', percent: 76 },
      { dimension: 'SN', pole: 'N', label: '直觉', percent: 70 },
      { dimension: 'TF', pole: 'F', label: '情感', percent: 76 },
      { dimension: 'JP', pole: 'P', label: '知觉', percent: 66 },
    ],
    strengths: [
      { title: '真诚一致', description: '说出来的立场通常和内心的判断一致，不太会为了让场面好看而改口。' },
      { title: '共情细腻', description: '对他人语气和用词的变化比较敏感，能察觉情绪里的细微起伏。' },
      { title: '创意表达', description: '常借助文字、画面或故事，把难以直接说清的感受准确地表达出来。' },
      { title: '忠于价值', description: '选择时更在意是否符合自己的原则，愿意为此放弃一些便利。' },
    ],
    blindSpots: [
      { title: '回避冲突', description: '遇到对立时倾向先退开，问题可能因此被搁置而没有被解决。' },
      { title: '拖延启动', description: '想法在内心打磨的时间较久，真正开始行动常比预想的更晚一些。' },
      { title: '过度内耗', description: '反复回想自己说过的话，容易把小事放大成持续的内在压力。' },
    ],
    relationshipTips: [
      { title: '小步表达', description: '每天说出一件当天真实的感受，从一句话开始，不必解释完整。' },
      { title: '约定边界', description: '提前说明你需要多少独处时间，让对方知道这并不是在有意疏远。' },
      { title: '先做再调', description: '把想做的事拆成十五分钟能开始的版本，先动手再慢慢完善。' },
    ],
    summary: {
      headline: '内向的理想主义者，温和而忠于内心标准',
      strengths: ['真诚一致', '共情细腻', '创意表达'],
      watchouts: ['回避冲突', '启动偏慢', '容易内耗'],
    },
  },
  {
    type: 'ENFJ',
    typeName: '主人公',
    typeNameEn: 'Protagonist',
    group: 'DIPLOMAT',
    groupName: '外交家',
    groupColor: '#33A474',
    tagline: '看见他人的潜力，也愿为这份看见负责',
    description:
      '对他人的状态与团队气氛较敏锐，习惯主动照顾集体的情绪和需要，也善于用语言鼓舞别人。做决定时会把人的感受纳入考量，也希望事情方向清楚。在关系中常是主动维系的一方，但容易把别人的问题接过来。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'E', label: '外向', percent: 78 },
      { dimension: 'SN', pole: 'N', label: '直觉', percent: 68 },
      { dimension: 'TF', pole: 'F', label: '情感', percent: 76 },
      { dimension: 'JP', pole: 'J', label: '判断', percent: 74 },
    ],
    strengths: [
      { title: '激励他人', description: '能指出对方具体做得好的地方，让人感到被看见并愿意再尝试。' },
      { title: '组织协调', description: '擅长把不同性格的人安排在合适的位置上，让合作顺畅起来。' },
      { title: '表达感染', description: '说话时能照顾到听众的感受与立场，容易把想法传递得更有说服力。' },
      { title: '关注成长', description: '会留意同伴长期的变化，愿意花时间陪对方一起把事情做好。' },
    ],
    blindSpots: [
      { title: '过度介入', description: '习惯替别人做决定和安排，可能让对方失去自己处理问题的机会。' },
      { title: '忽视自己', description: '注意力大多放在他人的需要上，自己的疲惫容易被放到最后才处理。' },
      { title: '在意评价', description: '被否定时容易反复检查自己，情绪恢复需要比预想更长的时间。' },
    ],
    relationshipTips: [
      { title: '允许拒绝', description: '对方说不想时先接受下来，不追问理由，把决定权交还给他自己。' },
      { title: '分工明确', description: '帮忙之前先问一句你希望我做到哪一步，避免把事情全部接过来。' },
      { title: '表达需要', description: '每周至少一次直接说出自己的需要，而不是每次都先去照顾别人。' },
    ],
    summary: {
      headline: '热心的引导者，善于看见他人的潜力',
      strengths: ['激励他人', '组织协调', '关注成长'],
      watchouts: ['过度介入', '忽视自己', '在意评价'],
    },
  },
  {
    type: 'ENFP',
    typeName: '竞选者',
    typeNameEn: 'Campaigner',
    group: 'DIPLOMAT',
    groupName: '外交家',
    groupColor: '#33A474',
    tagline: '被新的想法吸引，也想把热情传给别人',
    description:
      '容易被新的想法和新面孔点燃，思维在不同主题间跳跃，常把看似无关的事情联系起来。重视关系里的真诚与新鲜感，愿意主动靠近别人，也希望得到同等的热度回应。计划性相对弱，兴趣易转移，需要外部结构帮助落地。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'E', label: '外向', percent: 74 },
      { dimension: 'SN', pole: 'N', label: '直觉', percent: 80 },
      { dimension: 'TF', pole: 'F', label: '情感', percent: 70 },
      { dimension: 'JP', pole: 'P', label: '知觉', percent: 76 },
    ],
    strengths: [
      { title: '热情感染', description: '情绪表达外显且带动性强，常能让沉闷的场合重新活跃起来。' },
      { title: '创意发散', description: '短时间内能想到许多种可能，为卡住的问题提供新的入口和角度。' },
      { title: '共情理解', description: '愿意听别人讲自己的经历，并给出不带评判的认真回应和反馈。' },
      { title: '适应变化', description: '环境或计划发生变动时调整较快，不容易长时间停在失落里。' },
    ],
    blindSpots: [
      { title: '虎头蛇尾', description: '开局时投入很多精力，进入重复阶段之后热情下降得比较明显。' },
      { title: '精力分散', description: '同时进行的事情偏多，重要但无趣的任务容易被挤到日程后面。' },
      { title: '回避沉重', description: '面对负面情绪时倾向转头找轻松话题，对方可能觉得被绕开。' },
    ],
    relationshipTips: [
      { title: '落实承诺', description: '答应的事情当场记下来并定好时间，别只靠当时的那股热情推动。' },
      { title: '深度对话', description: '每周留一次不谈计划只谈感受的对话，轮流讲各自最近的状态。' },
      { title: '整理节奏', description: '睡前用三分钟写下明天最重要的一件事，第二天起床后先做它。' },
    ],
    summary: {
      headline: '热情的探索者，用好奇心连接人与想法',
      strengths: ['热情感染', '创意发散', '共情理解'],
      watchouts: ['虎头蛇尾', '精力分散', '回避沉重'],
    },
  },
  {
    type: 'ISTJ',
    typeName: '物流师',
    typeNameEn: 'Logistician',
    group: 'SENTINEL',
    groupName: '守护者',
    groupColor: '#4298B4',
    tagline: '把承诺过的事情，按既定标准稳妥完成',
    description:
      '做事习惯先明确标准与流程再按步骤推进，对细节与准确度有要求，答应的事通常按时兑现。判断以事实与既往经验为主，对临时变更较谨慎。关系中重视稳定与责任，较少主动谈感受，多用实际行动维持承诺。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'I', label: '内向', percent: 70 },
      { dimension: 'SN', pole: 'S', label: '实感', percent: 76 },
      { dimension: 'TF', pole: 'T', label: '思考', percent: 72 },
      { dimension: 'JP', pole: 'J', label: '判断', percent: 80 },
    ],
    strengths: [
      { title: '可靠守信', description: '答应过的时间与结果大多能按原样交付，不需要别人反复跟进。' },
      { title: '注重细节', description: '对数字、日期与流程中的不一致比较敏感，常能提前发现疏漏。' },
      { title: '流程清晰', description: '习惯把做过的事情整理成步骤，让后来接手的人可以照着执行。' },
      { title: '耐力持久', description: '能长期维持同一套做事节奏，不因为短期没有看到反馈就中断。' },
    ],
    blindSpots: [
      { title: '应变偏慢', description: '计划外的情况出现时，通常需要时间重新确认之后才愿意调整。' },
      { title: '表达偏少', description: '内心的在意大多放在行动里，对方可能因为没有听到而怀疑。' },
      { title: '标准固化', description: '习惯用过去有效的方法判断现在的事情，可能错过更简单的做法。' },
    ],
    relationshipTips: [
      { title: '主动表达', description: '每天对亲近的人说一句具体的欣赏，不要只把事情默默做完。' },
      { title: '预留余地', description: '安排时间时留出两成弹性，用来应对临时的变化与突发请求。' },
      { title: '说明理由', description: '提出不同意见时先讲出依据与担心，别只说这样是不合规矩的。' },
    ],
    summary: {
      headline: '踏实可靠的执行者，把承诺落实到细节',
      strengths: ['可靠守信', '注重细节', '耐力持久'],
      watchouts: ['应变偏慢', '表达偏少', '标准固化'],
    },
  },
  {
    type: 'ISFJ',
    typeName: '守卫者',
    typeNameEn: 'Defender',
    group: 'SENTINEL',
    groupName: '守护者',
    groupColor: '#4298B4',
    tagline: '记得住具体的小事，也守得住长久的承诺',
    description:
      '对身边人的习惯和需要记得很细，常通过具体照顾表达在意。做事踏实，倾向按已有方法把任务完成得有始有终。判断上兼顾规则与人情，冲突时多先退让，不太主动提出自己的需求，长期付出未被看见时容易积累疲惫。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'I', label: '内向', percent: 72 },
      { dimension: 'SN', pole: 'S', label: '实感', percent: 74 },
      { dimension: 'TF', pole: 'F', label: '情感', percent: 74 },
      { dimension: 'JP', pole: 'J', label: '判断', percent: 76 },
    ],
    strengths: [
      { title: '细致体贴', description: '能记住对方的口味、习惯与各种忌讳，并在具体的小事上做出照应。' },
      { title: '踏实尽责', description: '接手的事情会一直跟到结束，中途不轻易放手让别人来补位。' },
      { title: '记忆具体', description: '对共同经历过的细节记得很清楚，常能提起别人已经忘掉的事。' },
      { title: '耐心守候', description: '愿意在对方状态不好时保持陪伴，而不是催促他尽快好起来。' },
    ],
    blindSpots: [
      { title: '委屈自己', description: '常把自己的需要排在后面，时间久了容易积累说不出口的不满。' },
      { title: '难以拒绝', description: '别人开口请自己帮忙时不太会说不行，结果承担了过多的任务。' },
      { title: '抗拒变化', description: '既有的安排被改动时会感到不安，需要时间才能适应新方式。' },
    ],
    relationshipTips: [
      { title: '提出需求', description: '把想请对方帮的忙说成一件具体的事，而不是等他自己发现。' },
      { title: '接受帮助', description: '别人主动提出帮忙时先答应下来，不要因为怕麻烦对方而推掉。' },
      { title: '说出不满', description: '感到委屈时当天就讲出具体的那一件事，别让它积到很久以后。' },
    ],
    summary: {
      headline: '温和的守护者，用细节照顾身边的人',
      strengths: ['细致体贴', '踏实尽责', '耐心守候'],
      watchouts: ['委屈自己', '难以拒绝', '抗拒变化'],
    },
  },
  {
    type: 'ESTJ',
    typeName: '总经理',
    typeNameEn: 'Executive',
    group: 'SENTINEL',
    groupName: '守护者',
    groupColor: '#4298B4',
    tagline: '把混乱的事情理成流程，让每件事按计划落地',
    description:
      '习惯把模糊的任务拆成明确的步骤、责任与时间点，并推动相关的人按约定完成。判断以事实、规则与实际效果为基准，对空谈和含糊表述的耐心有限。关系中常扮演组织者，表达偏直接，有时忽略对方需要先被安抚。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'E', label: '外向', percent: 76 },
      { dimension: 'SN', pole: 'S', label: '实感', percent: 72 },
      { dimension: 'TF', pole: 'T', label: '思考', percent: 78 },
      { dimension: 'JP', pole: 'J', label: '判断', percent: 82 },
    ],
    strengths: [
      { title: '统筹落地', description: '能把任务拆成责任与时间点，并盯着进度直到事情真正完成。' },
      { title: '标准明确', description: '事先把要求与验收方式都讲清楚，减少之后来回返工的可能。' },
      { title: '执行果断', description: '讨论结束后能迅速定下方案并开始行动，不让议题反复悬置。' },
      { title: '责任清楚', description: '出现问题时倾向先分清环节与职责，而不是先追究谁的态度。' },
    ],
    blindSpots: [
      { title: '方式偏硬', description: '指出错误时容易直接切入问题本身，让对方只感到被否定和批评。' },
      { title: '忽视感受', description: '关注进度多于关注人的状态，可能错过同伴发出的疲惫信号。' },
      { title: '不易变通', description: '既定规则被挑战时倾向坚持原有做法，留给讨论的空间会变小。' },
    ],
    relationshipTips: [
      { title: '先问后说', description: '给出建议之前先问对方需要办法，还是只需要有人听他讲完。' },
      { title: '留出弹性', description: '安排家庭或团队活动时留出一个可选环节，允许大家临时调整安排。' },
      { title: '表达关心', description: '把在意直接用语言说出来一次，例如今天你看起来有点疲惫。' },
    ],
    summary: {
      headline: '务实的组织者，把秩序带进具体事务',
      strengths: ['统筹落地', '标准明确', '执行果断'],
      watchouts: ['方式偏硬', '忽视感受', '不易变通'],
    },
  },
  {
    type: 'ESFJ',
    typeName: '执政官',
    typeNameEn: 'Consul',
    group: 'SENTINEL',
    groupName: '守护者',
    groupColor: '#4298B4',
    tagline: '让身边的人被照顾到，也让场子暖起来',
    description:
      '对人际气氛和他人的情绪变化比较留意，愿意主动承担照顾与协调的角色。做事注重实际与秩序，喜欢把安排提前落实，也希望得到明确的回应和认可。关系是其投入最多的领域，但容易过度在意别人的看法。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'E', label: '外向', percent: 74 },
      { dimension: 'SN', pole: 'S', label: '实感', percent: 76 },
      { dimension: 'TF', pole: 'F', label: '情感', percent: 78 },
      { dimension: 'JP', pole: 'J', label: '判断', percent: 72 },
    ],
    strengths: [
      { title: '照顾周到', description: '会留意每个人是否被安排到，尽量不让任何一个人被落在边上。' },
      { title: '人情练达', description: '记得住他人的重要日子与偏好，往来应对得体而不显得刻意。' },
      { title: '执行有序', description: '喜欢把自己的事情提前安排好，按流程推进时效率通常比较稳定。' },
      { title: '营造气氛', description: '善于用话题与细节让在场的人放松下来，减少彼此的陌生感。' },
    ],
    blindSpots: [
      { title: '在意评价', description: '比较看重别人的反馈，一句负面的评价就可能影响很久的心情。' },
      { title: '边界模糊', description: '对亲近的人的事务介入较深，容易越过对方希望自己保留的范围。' },
      { title: '回避矛盾', description: '察觉气氛不对时倾向先做调和，真正存在的问题可能被暂时掩住。' },
    ],
    relationshipTips: [
      { title: '说出想法', description: '不同意时先讲出自己的想法，再和对方一起商量折中的做法。' },
      { title: '保留空间', description: '关心他人之前先问一句现在方便聊吗，给对方留下拒绝的余地。' },
      { title: '直接提问', description: '不确定对方是否介意时就开口直接问，不要靠猜测反复揣摩。' },
    ],
    summary: {
      headline: '热心的组织者，让关系维持在融洽状态',
      strengths: ['照顾周到', '人情练达', '营造气氛'],
      watchouts: ['在意评价', '边界模糊', '回避矛盾'],
    },
  },
  {
    type: 'ISTP',
    typeName: '鉴赏家',
    typeNameEn: 'Virtuoso',
    group: 'EXPLORER',
    groupName: '探险家',
    groupColor: '#E4AE3A',
    tagline: '喜欢先动手拆开看看，弄懂了再谈道理',
    description:
      '更愿意通过动手操作理解事物，拆解、试错、观察反馈的过程让其投入，对纯理论讨论兴趣有限。遇到突发状况反应冷静，倾向先处理眼前的问题，而不是先讨论原因。重视个人空间与自主安排，常用解决问题的方式表示关心。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'I', label: '内向', percent: 68 },
      { dimension: 'SN', pole: 'S', label: '实感', percent: 74 },
      { dimension: 'TF', pole: 'T', label: '思考', percent: 76 },
      { dimension: 'JP', pole: 'P', label: '知觉', percent: 78 },
    ],
    strengths: [
      { title: '动手能力', description: '面对工具、设备或具体问题时，通常能快速上手并找到可行做法。' },
      { title: '临场冷静', description: '突发状况下情绪起伏较小，通常能冷静地把眼前问题处理掉。' },
      { title: '独立自主', description: '不需要别人太多指导与陪同，能自己找到方法把手上的事情做完。' },
      { title: '效率务实', description: '倾向用最短的路径解决实际问题，不做多余的流程和铺垫工作。' },
    ],
    blindSpots: [
      { title: '表达偏少', description: '内心其实很在意但很少主动说出来，对方可能误以为你并不关心。' },
      { title: '不耐长期', description: '对周期长又缺少反馈的事情兴趣下降较快，中途容易转移注意。' },
      { title: '回避承诺', description: '涉及较为长远的约定时会先观望，容易被理解为不愿承担责任。' },
    ],
    relationshipTips: [
      { title: '直接说明', description: '用一两句简单的话讲清自己的想法，不必等到整理得很完整再说。' },
      { title: '留出空间', description: '告诉对方你需要安静一会儿，并说明大概多久之后会重新回来。' },
      { title: '用行动说', description: '把在意落在一件具体的事情上，同时用一句话点明这是关心。' },
    ],
    summary: {
      headline: '冷静的实干者，用动手解决具体问题',
      strengths: ['动手能力', '临场冷静', '效率务实'],
      watchouts: ['表达偏少', '不耐长期', '回避承诺'],
    },
  },
  {
    type: 'ISFP',
    typeName: '探险家',
    typeNameEn: 'Adventurer',
    group: 'EXPLORER',
    groupName: '探险家',
    groupColor: '#E4AE3A',
    tagline: '按自己的节奏生活，用具体的行动表达在意',
    description:
      '对环境里的色彩、声音与氛围比较敏感，做选择时更依赖自身感受与审美，而非外部标准。性格温和，不喜欢冲突和说教，常以实际行动照顾身边人。需要属于自己的节奏和空间，被密集安排或强行评价时容易退缩。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'I', label: '内向', percent: 70 },
      { dimension: 'SN', pole: 'S', label: '实感', percent: 72 },
      { dimension: 'TF', pole: 'F', label: '情感', percent: 76 },
      { dimension: 'JP', pole: 'P', label: '知觉', percent: 74 },
    ],
    strengths: [
      { title: '审美敏锐', description: '对色彩、质感与氛围的变化感知细致，常能提出恰到好处的调整。' },
      { title: '温和包容', description: '很少评判他人的生活方式与选择，让人相处时感到放松而不被审视。' },
      { title: '务实行动', description: '不擅长用长篇说服别人，更愿意直接做出成品让对方看到结果。' },
      { title: '忠于感受', description: '做选择时更尊重自己的真实反应，不容易被外界的标准推着走。' },
    ],
    blindSpots: [
      { title: '回避冲突', description: '遇到紧张的局面倾向沉默或离开，未说清的部分会留在心里。' },
      { title: '规划偏弱', description: '对较远的安排考虑较少，临时出现变动时可能需要仓促应对。' },
      { title: '不易表态', description: '被要求立刻给出答案时容易含糊带过，让合作方难以判断你的倾向。' },
    ],
    relationshipTips: [
      { title: '提前说明', description: '需要独处或切换状态时提前讲一声，避免对方误以为这是在冷淡。' },
      { title: '小步表达', description: '把不满拆成一句具体的话慢慢说出来，不必一次讲清所有感受。' },
      { title: '共同做事', description: '用一起散步、做饭这类日常活动代替长谈，更容易说出心里话。' },
    ],
    summary: {
      headline: '温和的感受者，按自己的节奏认真生活',
      strengths: ['审美敏锐', '温和包容', '忠于感受'],
      watchouts: ['回避冲突', '规划偏弱', '不易表态'],
    },
  },
  {
    type: 'ESTP',
    typeName: '企业家',
    typeNameEn: 'Entrepreneur',
    group: 'EXPLORER',
    groupName: '探险家',
    groupColor: '#E4AE3A',
    tagline: '在变化发生的当下，第一时间做出反应',
    description:
      '精力充沛，偏好直接进入现场获取信息，通过实际操作和即时反馈判断下一步。对风险和机会都比较敏感，愿意在不确定中先行动再修正。关系中轻松直接，喜欢有活力的相处方式，对需要长期铺垫的部分投入度偏低。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'E', label: '外向', percent: 78 },
      { dimension: 'SN', pole: 'S', label: '实感', percent: 78 },
      { dimension: 'TF', pole: 'T', label: '思考', percent: 70 },
      { dimension: 'JP', pole: 'P', label: '知觉', percent: 80 },
    ],
    strengths: [
      { title: '行动迅速', description: '想到可行方案就先试一下，用实际结果判断下一步该怎么走。' },
      { title: '应变灵活', description: '现场条件发生变化时能马上找到替代办法，不执着于原来的安排。' },
      { title: '谈判说服', description: '在直接交流中能抓住对方在意的点，比较快地把共识谈下来。' },
      { title: '现实判断', description: '对人对事的实际能力评估比较准，不太依赖书面印象下判断。' },
    ],
    blindSpots: [
      { title: '耐心有限', description: '需要长期积累才能看到结果的事情，容易在中途失去兴趣并放弃。' },
      { title: '忽略细节', description: '推进较快时容易跳过确认环节，留下需要回头再补的细小疏漏。' },
      { title: '承诺随意', description: '兴致高的时候答应得比较多，实际精力未必能覆盖全部安排。' },
    ],
    relationshipTips: [
      { title: '事后复盘', description: '冲动说完话之后当天补一句说明，不要让对方把误会留到第二天。' },
      { title: '按时兑现', description: '答应的事情写进手机提醒，按约定的时间向对方确认是否完成。' },
      { title: '听完再说', description: '对方讲烦恼时先忍住不出主意，等他说完再问需不需要建议。' },
    ],
    summary: {
      headline: '行动优先的现实派，擅长在当下解决问题',
      strengths: ['行动迅速', '应变灵活', '现实判断'],
      watchouts: ['耐心有限', '忽略细节', '承诺随意'],
    },
  },
  {
    type: 'ESFP',
    typeName: '表演者',
    typeNameEn: 'Entertainer',
    group: 'EXPLORER',
    groupName: '探险家',
    groupColor: '#E4AE3A',
    tagline: '把眼前这一刻过好，也把气氛带给大家',
    description:
      '对身边正在发生的事很敏锐，喜欢与人互动，也善于让场面变得轻松愉快。做决定更依赖当下感受与实际体验，相比长期规划更关注眼前能做的事。相处中慷慨热情，愿意分享情绪和资源，回避沉重话题时问题容易被搁置。',
    dimensionProfile: [
      { dimension: 'EI', pole: 'E', label: '外向', percent: 80 },
      { dimension: 'SN', pole: 'S', label: '实感', percent: 76 },
      { dimension: 'TF', pole: 'F', label: '情感', percent: 74 },
      { dimension: 'JP', pole: 'P', label: '知觉', percent: 78 },
    ],
    strengths: [
      { title: '感染力强', description: '情绪表达直接而生动，往往能把身边的人一起带动得放松下来。' },
      { title: '体贴当下', description: '能迅速察觉到身边人的状态，并及时做出让人舒服的小小调整。' },
      { title: '适应环境', description: '进入新的场合或团队时融入比较快，不容易长时间感到拘谨和紧张。' },
      { title: '乐于分享', description: '愿意把自己的时间、食物与好消息都大方地分享给身边的朋友。' },
    ],
    blindSpots: [
      { title: '规划偏短', description: '对较远的安排投入的思考比较少，突然遇到变化时容易手足无措。' },
      { title: '回避沉重', description: '气氛变沉时倾向换个轻松的话题，对方正在难受的部分没被接住。' },
      { title: '易受氛围', description: '周围人的情绪对自己的影响比较明显，情绪容易跟着一起起伏。' },
    ],
    relationshipTips: [
      { title: '约定节点', description: '把重要的事情定下一个具体日期，并写进两个人共同的日程里。' },
      { title: '谈一次未来', description: '每月找一次时间聊半年之后的打算，把想法记下来再排顺序。' },
      { title: '留意信号', description: '对方情绪变低时先问一句今天是不是不太顺，再决定聊什么话题。' },
    ],
    summary: {
      headline: '热情的体验者，把精力放在眼前的人和事',
      strengths: ['感染力强', '体贴当下', '适应环境'],
      watchouts: ['规划偏短', '回避沉重', '易受氛围'],
    },
  },
];
