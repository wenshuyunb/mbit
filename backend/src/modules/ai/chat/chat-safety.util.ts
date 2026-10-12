/**
 * 危险内容关键词预筛（纯函数，无 I/O、**不调用模型**，可 100% 单测）
 *
 * 契约依据：§3.7.5 业务规则 1（危险内容拦截前置，架构 §10.5）。
 *
 * ## 为什么必须是"预筛"而不是"让模型判断"
 *
 * 命中自伤/自杀信号的场景下，**延迟本身就是伤害**：等模型生成完再判，用户已经多等了
 * 几秒；更糟的是模型有可能把这种表达"共情"成一次普通的情绪宣泄 —— 这是大模型最
 * 常见的失败模式之一。因此命中即短路：不调用模型、返回固定关怀文案 + 转介资源。
 *
 * ## 为什么 `HARM_TO_OTHER` 走同一套兜底
 *
 * 契约把"他伤"与自伤并列（同一条预筛规则）。两者都需要转介而不是"聊天"：前者需要
 * 被劝止并告知法律风险，后者需要危机干预资源。文案由 `buildSafetyResponseContent`
 * 按类别分别组装，**不共用一段纯自伤文案**。
 *
 * ## 误报与漏报的取舍
 *
 * 关键词表刻意做得**偏保守（宁可多命中）**：
 *   · 漏报 = 一个正在求助的人收到一段普通的"共情式聊天"，方向不可接受；
 *   · 误报 = 用户收到一条含热线的关怀回复 + 一次不扣配额的对话，代价可接受
 *     （契约明确 `consumed = 0`，误报不会让用户损失额度）。
 * 但"偏保守"不等于无脑匹配：所有模式都要求**动作/诉求 + 对象**同时出现
 * （"自杀"单独出现可能是用户在转述新闻，"我想自杀"才是信号），
 * 并对常见的口语化否定与比喻做了排除（见 `NEGATED_INPUT_PATTERNS`）。
 *
 * ⚠ 本文件是"服务端规则 + 敏感词库"中的**规则**部分。运营侧可热更的敏感词库当前
 * 没有任何表承载（见简报「缺失的表/列」），因此暂时只有这份代码内规则。
 */

import type { SafetyResource } from './chat.types';

/** 危险内容类别（契约 §3.7.5 响应字段 `matchedCategory`） */
export const RISK_CATEGORIES = ['SELF_HARM', 'HARM_TO_OTHER', 'MEDICAL_DIAGNOSIS', 'MEDICATION'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** 命中原因（契约 §3.7.5 响应字段 `blockedReason`） */
export const BLOCKED_REASON_KEYWORD_MATCH = 'SAFETY_KEYWORD_MATCH';

/** 类别中文名（写进日志，便于人工排查为什么被拦） */
export const RISK_CATEGORY_LABELS: Readonly<Record<RiskCategory, string>> = {
  SELF_HARM: '自伤/自杀风险',
  HARM_TO_OTHER: '伤害他人风险',
  MEDICAL_DIAGNOSIS: '医疗诊断诉求',
  MEDICATION: '用药诉求',
};

/** 预筛结果 */
export interface RiskScreeningResult {
  readonly matched: boolean;
  readonly category: RiskCategory | null;
}

/** 单条类别规则 */
interface RiskRule {
  readonly category: RiskCategory;
  readonly patterns: readonly RegExp[];
}

/**
 * 类别规则
 *
 * 每条规则写成"动作或诉求的出现形态"而不是单个词：单字词的误报率高到无法上线
 * （"自杀式减肥""这个方案简直是自杀"都会被拦）。
 */
const RISK_RULES: readonly RiskRule[] = [
  {
    category: 'SELF_HARM',
    patterns: [
      // 明确的自我了断意图（"想/要/打算 + 自杀/自尽/结束生命"）。
      // `着|上|过` 可选：真实表达常见"最近总是想着结束生命"这类插入
      /(想|要|准备|打算|计划|考虑)(着|上|过)?\s*(自杀|自尽|轻生|结束(自己)?(的)?生命|了结(自己)?|一了百了)/,
      // 自我否定的存在价值（"活着没意思""不想活了"）
      /活(着)?(也|都)?(没有|没|毫无)?(什么)?(意思|意义)/,
      /不想(再)?活(着|了|下去|成)?/,
      // 具体手段（手段词 + 第一人称，才算信号）
      /(我|自己).{0,8}(割腕|跳楼|跳河|上吊|服药自尽|烧炭|安眠药.{0,4}(吃|吞|过量))/,
    ],
  },
  {
    category: 'HARM_TO_OTHER',
    patterns: [
      /(想|要|准备|打算|计划)\s*(杀(了|掉)?(他|她|它|你|他们|她们)|弄死|捅死|砍死|毒死)/,
      /(我|自己).{0,8}(想弄死|要弄死|想捅死|想砍死|想毒死|想杀(了|掉))/,
    ],
  },
  {
    category: 'MEDICAL_DIAGNOSIS',
    patterns: [
      // 要求给出诊断结论（合规红线：AI 不得诊断）
      /(帮我|给我|替我)?\s*(诊断|确诊|判断|看看).{0,8}(我|自己)?(是不是|有没有|算不算|得了)\s*(抑郁症|焦虑症|双相|躁郁|精神病|人格障碍|ADHD|自闭症|强迫症)/,
      /(我|自己)(是不是|算不算|有没有)(得|患)(了)?\s*(抑郁症|焦虑症|双相|躁郁|精神病)/,
    ],
  },
  {
    category: 'MEDICATION',
    patterns: [
      // 要求给出用药方案（合规红线：AI 不得给药）
      /(该|应该|要不要|能不能|可不可以)\s*(吃|服用|用)\s*(什么|哪种|多少)\s*(药|药物|药量|剂量)/,
      /(推荐|建议|开)\s*(点|些)?\s*(药|药物|抗抑郁药|安眠药|镇定剂)/,
      /(吃药|服药|用药)\s*(剂量|用量|多少片|加量|减量|停药)/,
    ],
  },
];

/**
 * 口语化否定 / 反事实 / 第三人称转述
 *
 * 命中这些形态时**不做**危险内容拦截，理由：
 *   · "自杀式加班"是比喻 —— 拦下来会让用户觉得产品在瞎紧张
 *   · "我才不想活成那样"表达的是价值观，不是自伤
 *   · "他不想活了"是转述第三方：此时更该走正常对话让用户讲清楚，
 *     而不是直接甩资源卡；若真的升级为风险，用户下一句会带第一人称。
 *
 * 这些排除让规则从"有噪声的报警器"变成"能上线的报警器"。
 */
const NEGATED_INPUT_PATTERNS: readonly RegExp[] = [
  // 比喻 / 反事实："自杀式加班"、"不想活成他那样"
  /(自杀|轻生|不想活)(式|般|成|那样|一样|似的)/,
  // 第三人称转述（"他/她 + （不想）活/自杀"）
  /(他|她|他们|她们|它)\s*不?\s*(想|要)?\s*(自杀|轻生|活(了|着)?|死)/,
];

/**
 * 危险内容预筛
 *
 * 返回**第一个命中**的类别（而不是全部）：文案与资源卡只按一个类别组装，同时报多个
 * 类别会让关怀文案自相矛盾（"请珍惜生命"和"请勿伤害他人"混在一起）。类别优先级即
 * `RISK_RULES` 的顺序：自伤优先于他伤，因为他伤的落点仍是"劝止 + 转介"，
 * 而自伤需要的是危机资源。
 */
export const screenRiskContent = (input: string): RiskScreeningResult => {
  const text = input.trim();
  if (text.length === 0) return { matched: false, category: null };

  for (const exclusion of NEGATED_INPUT_PATTERNS) {
    if (exclusion.test(text)) return { matched: false, category: null };
  }

  for (const rule of RISK_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return { matched: true, category: rule.category };
    }
  }

  return { matched: false, category: null };
};

/** 关怀文案原料（全部来自 `system_configs`，见 `chat-safety.service.ts`） */
export interface SafetyContentInput {
  readonly category: RiskCategory;
  readonly resources: readonly SafetyResource[];
  readonly crisisNotice: string;
  readonly emergencyNotice: string;
}

/** 单条热线的展示行：`· 全国心理援助热线：12356（24 小时）` */
const formatResourceLine = (resource: SafetyResource): string =>
  `· ${resource.name}：${resource.phone}（${resource.available}）`;

/** 没有任何热线配置时的兜底行（不能只说"请联系专业机构"却不告诉联系谁） */
const NO_RESOURCE_LINE = '· 请拨打 120，或前往最近的医院急诊，或告知身边可信任的人';

/**
 * 组装固定关怀文案（契约 §3.7.5 响应示例的文案结构）
 *
 * 结构固定为四段：**接住情绪 → 说明能力边界 → 给出可联系的资源 → 具体的行动指令**。
 *
 * 为什么在代码里拼而不是做成 Prompt 模板：这段文案**必须在完全不调用模型、也不依赖
 * 模板渲染的情况下**产出（契约要求命中即短路）。任何依赖模板的路径都可能在模板缺失
 * 或渲染失败时挂掉 —— 而这是最不能失败的一条路径。可变部分（热线、提示语）
 * 全部来自 `system_configs`，运营改配置即可生效。
 */
export const buildSafetyResponseContent = (input: SafetyContentInput): string => {
  const resourceLines =
    input.resources.length > 0 ? input.resources.map(formatResourceLine).join('\n') : NO_RESOURCE_LINE;

  switch (input.category) {
    case 'SELF_HARM':
      return [
        '谢谢你愿意把这句话说出来，这需要很大的勇气。',
        '你现在的痛苦是真实的，也值得被认真对待。我无法替代专业的支持，但我很希望你能联系下面这些可以真正帮到你的人：',
        '**专业支持资源**',
        resourceLines,
        input.crisisNotice,
        input.emergencyNotice,
        '我会一直在这里，但请不要只依靠我。你值得被真实的人接住。',
      ].join('\n\n');

    case 'HARM_TO_OTHER':
      return [
        '我听到了你话里非常强烈的愤怒和受伤，这些情绪是真实的。',
        '但我不能陪你继续想"怎么伤害对方"这件事——一旦真的做了，你要承担的是法律后果，而你的痛苦不会因此减少。',
        '此刻更值得做的是先把距离拉开：离开现场、找一个能陪你的人、把想说的话先写下来。',
        '**如果冲突正在进行中，请立即联系：**',
        '· 报警：110',
        '· 全国心理援助热线：12356（24 小时）',
        input.crisisNotice,
        '等你平静一些，我很愿意陪你一起理清这段关系里到底发生了什么。',
      ].join('\n\n');

    case 'MEDICAL_DIAGNOSIS':
      return [
        '我很理解你想给自己的状态找到一个名字——有了名字，好像就知道该怎么办了。',
        '但我不能给你下诊断。心理状态的判断需要专业评估，我看到的只是你在文字里描述的部分，任何"你可能是××症"的说法对你都不公平，也可能误导你。',
        '**如果这些困扰已经影响到你的生活，去找有能力判断的人：**',
        '· 精神科门诊（三甲医院心理科/精神科）',
        resourceLines,
        input.crisisNotice,
        '在那之前，我更想陪你做的是：把你具体在经历什么讲清楚，我们一起看有哪些当下能做的事。',
      ].join('\n\n');

    case 'MEDICATION':
      return [
        '关于用药，我确实帮不上你——药物涉及剂量、相互作用和你的既往病史，这些只有能面诊的医生才能判断。',
        '我不会建议你吃任何药，也不会建议你自行加量、减量或停药。**自行调整精神类药物是危险的**。',
        '**请找能开药的人：**',
        '· 为你开药的医生（复诊或电话问诊）',
        '· 精神科门诊（三甲医院心理科/精神科）',
        resourceLines,
        input.crisisNotice,
        '如果你愿意，我们可以聊聊服药过程中让你困扰的部分——那些感受我可以陪你一起梳理。',
      ].join('\n\n');
  }
};

/**
 * 预筛结果 → 响应 `blockedReason`
 *
 * 单独抽出来是为了让"命中原因"这个对外字段**只有一处产出点**：日后若增加
 * "用户举报""人工标记"等其他拦截来源，各自给不同的 reason 即可，不会与关键词预筛混淆。
 */
export const blockedReasonOf = (result: RiskScreeningResult): string | null =>
  result.matched ? BLOCKED_REASON_KEYWORD_MATCH : null;
