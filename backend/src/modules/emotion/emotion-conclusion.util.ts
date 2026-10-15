/**
 * 情感测评的**确定性结论**（结果页直接展示的那一段）
 *
 * ## 为什么需要它
 *
 * 结果页原先只有"标签 + 分数"：依恋型、两轴数字、五项爱的语言、五种冲突风格。
 * 用户的原话是「看完甚至不知道想表达什么，信息也不多，也没有告诉我我属于什么、
 * 需要什么、给的建议是什么」——**有数字、没有含义**。
 *
 * 深度解读确实有 AI 报告，但：
 *   ① 用户不一定生成它（实测：用户做完测评后库里一条 `EMOTION_REPORT` 都没有）；
 *   ② 生成要等十几秒，而"我刚做完题"的那一刻是最想知道结论的。
 *
 * 因此这一段是**纯函数**（与 ADR-005 一致）：同样的画像，任何时候都得到同样的结论，
 * 不调用模型、不消耗额度、不需要等待，也不依赖提示词版本。
 *
 * ## 写作红线（与 AI 报告同一套）
 *
 *   · **只描述、不评判**：不说"这样不好"、不判断"你们合不合适"；
 *   · **不做诊断、不做心理干预**：不出现临床词汇；
 *   · **不贴标签**：每种类型都补一句"这是当下的倾向，会随情境与对象变化"；
 *   · 建议是**具体可做的小事**，每条都要说清"为什么对这个类型有效"，
 *     而不是"多沟通""要自信"这类正确但没用的话。
 */

/** 依恋类型（与 Prisma `AttachmentStyle` 对齐） */
type AttachmentStyle = 'SECURE' | 'ANXIOUS' | 'AVOIDANT' | 'FEARFUL';

/** 结论输入（只声明用到的字段，便于上层按需投影） */
export interface EmotionConclusionInput {
  readonly attachmentStyle: string;
  readonly attachmentAnxiety: number;
  readonly attachmentAvoidance: number;
  readonly loveLanguageScores: Readonly<Record<string, number>> | null;
  readonly primaryLoveLanguages: readonly string[];
  readonly conflictStyle: string;
  readonly conflictScores: Readonly<Record<string, number>> | null;
}

/** 结果页直接展示的结论 */
export interface EmotionConclusion {
  /** 一句话画像（最先看到的那句，5–40 字） */
  readonly headline: string;
  /** 依恋姿态的人话解读（2–4 句，含两轴分数与档位） */
  readonly portrait: string;
  /** 你在关系里**最需要什么**（把主导爱的语言翻成需求句） */
  readonly needs: string;
  /** 有分歧时的你（冲突风格的人话） */
  readonly conflict: string;
  /** 你在关系里的优势（2–3 条，都是真的、不空泛） */
  readonly strengths: readonly string[];
  /** 可以立刻开始做的三件事（每条：做什么 + 为什么对你有效） */
  readonly suggestions: readonly string[];
  /** 这一段只是描述性结论的提示（合规） */
  readonly note: string;
}

// ---------------------------------------------------------------- 文案表

/** 一句话画像：四型各自最扎心也最准确的那一句 */
const HEADLINES: Record<AttachmentStyle, string> = {
  SECURE: '你在关系里是那种"靠得住"的人：敢靠近，也不怕对方有自己的空间。',
  ANXIOUS: '你在关系里最怕的是被冷落：一点风吹草动，你会先想是不是自己哪里不对。',
  AVOIDANT: '你在关系里需要留一点自己的空间：太近会想退开，退远了又会想念。',
  FEARFUL: '你在关系里既想靠近又怕受伤：想抓紧，又怕抓紧了反而失去。',
};

/** 需求的收尾（按主导爱的语言） */
const NEEDS_BY_LOVE_LANGUAGE: Record<string, { want: string; works: string }> = {
  LOVE_TOUCH: {
    want: '被抱住、被牵着、被自然地靠近',
    works: '一个拥抱、走路时牵着的手，比什么都能让你确认关系还在',
  },
  LOVE_TIME: {
    want: '对方把完整的时间给你，而不是边刷手机边陪你',
    works: '一起待着、不被打断的那段时间，才是你真正收到的东西',
  },
  LOVE_WORDS: {
    want: '被明确地说出来：夸你、肯定你、告诉你"我很在意你"',
    works: '一句具体的话，你能记很久；反之没被说出口就等于没发生',
  },
  LOVE_SERVICE: {
    want: '对方替你分担掉具体的事，而不是只说"需要帮忙叫我"',
    works: '他默默把一件麻烦事做掉，比十句安慰更让你踏实',
  },
  LOVE_GIFTS: {
    want: '被记住：你随口提过的东西，对方真的买了回来',
    works: '礼物的分量从来不在价格，在"你上次说的那个，我记着"',
  },
};

/** 冲突风格的人话（TKI 五种） */
const CONFLICT_LINES: Record<string, string> = {
  CONFLICT_COLLABORATING:
    '有分歧时你偏向「协作型」：你习惯把问题摊开来谈，愿意一起找办法。这通常最能解决问题，代价是你容易低估"对方需要先缓一缓"这件事——你要的是当场解决，而对方可能还没准备好开口。',
  CONFLICT_COMPROMISING:
    '有分歧时你偏向「妥协型」：你会主动各让一步，先把事情推进下去。这让关系很少卡死，代价是让步多了以后，你会在某个时刻突然觉得"总是我在退"。',
  CONFLICT_ACCOMMODATING:
    '有分歧时你偏向「迁就型」：你更愿意先顺着对方，把火压下去。当下最省事，但那件没被说出口的事不会消失，它会攒着，然后在别的小事上冒出来。',
  CONFLICT_AVOIDING:
    '有分歧时你偏向「回避型」：你会先离开现场、等情绪过去。这能避免说出伤人的话，代价是问题常常被留下来，而对方会把你的沉默读成"不在意"。',
  CONFLICT_COMPETING:
    '有分歧时你偏向「竞争型」：你倾向于把道理讲清楚、把立场守住。你不太会被情绪带走，代价是对方记住的往往不是道理，而是当时的语气。',
};

/** 建议池：按依恋类型挑选（每型 4 条，取前 3 条） */
const SUGGESTIONS_BY_ATTACHMENT: Record<AttachmentStyle, readonly string[]> = {
  ANXIOUS: [
    '想确认关系时，把"你是不是不高兴了"换成"我想抱一下"。前者把对方推到解释的位置，后者对方伸个手就能回应你——你要的是确认，不是审问。',
    '给自己定一条"不追问"的规矩：对方没回消息的两小时里，先去做一件具体的事（洗个碗也算）。焦虑最难熬的是空转，有事做它就降得快。',
    '把你最需要的那样东西直接说出来一次（"我更喜欢你直接说想我"）。焦虑型的人常常等对方猜，而猜中的概率远比说出口低。',
    '记录一次"我担心的事其实没发生"。这不是自我安慰，是用真实记录替换掉脑子里的最坏剧本。',
  ],
  AVOIDANT: [
    '想退开的时候，先说一句"我需要缓一下，晚点聊"，而不是直接消失。对方要的往往不是立刻解决，而是知道你不会走。',
    '每周留一件"主动靠近"的小事（发一句"今天想你了"、约一次只有你们两个人的饭）。回避型的舒适区是远距离，关系要靠这一点点主动维持。',
    '把"我自己能行"和"让对方帮一次"分开看：接受帮助不等于失去独立。',
    '对方追问时，先说结论再说原因（"我没事，只是今天有点累"）。回避型的沉默在对方那里会自动被翻译成最坏的解释。',
  ],
  FEARFUL: [
    '把"想靠近"和"怕受伤"两句话都说出来，而不是只做其中一个。你表现出来的是忽冷忽热，而对方看不到你心里的那两股力气。',
    '给关系设一个"可以慢"的节奏：不必每一步都立刻确信，允许自己在不确定里待一阵子。恐惧型最消耗人的是"必须马上确定"。',
    '当你想要推开对方的那一刻，先停十秒，问自己"我现在怕的具体是什么"。把模糊的恐惧写具体，它通常就没那么大了。',
    '找一个能稳定回应你的人（朋友也可以）练习"说需求—被满足"这件事，先在低风险的关系里试。',
  ],
  SECURE: [
    '你不太容易被关系里的波动带跑，这份稳定很珍贵——但别默认对方也一样。对方情绪不好时，多问一句"你现在需要我听，还是需要我给建议"。',
    '把你在关系里的做法讲给对方听（"我一般不联系你的时候是在忙，不是不在意"）。你的稳定需要被解释，否则容易被误读成冷淡。',
    '留意自己是不是承担了太多"情绪劳动"：一直当那个稳住的人，也会有耗尽的时候。',
    '把边界说清楚（"这件事我需要自己待一会儿"）。安全型的人常常因为"我能扛"而长期扛着不该扛的部分。',
  ],
};

/** 与主导爱的语言对应的那一条建议（补进建议列表的第一位） */
const SUGGESTIONS_BY_LOVE_LANGUAGE: Record<string, string> = {
  LOVE_TOUCH:
    '把你需要的接触说出来：出门前要一个拥抱、看电影时挽住对方。不少人默认"想要抱"是不好意思开口的事，而对你来说它是刚需。',
  LOVE_TIME:
    '把"一起待着"变成固定安排（比如每周留一个晚上，手机放远一点）。对你来说零碎时间不算陪伴，完整的、不被打断的那段才算。',
  LOVE_WORDS:
    '直接告诉对方你喜欢被夸、被明确说出来，并且在他做对的时候当场说"这句话我听了很开心"。你在意的东西需要被教会，而不是被猜到。',
  LOVE_SERVICE:
    '把"我希望你帮我做的那件事"具体说出来（越具体越好），而不是等对方主动发现。你需要的不是心意，是这件事真的发生了。',
  LOVE_GIFTS: '告诉对方"我更喜欢你记住我说过的东西，而不是买贵的"。把需求说准确，能让对方少走很多弯路。',
};

const ATTACHMENT_LABELS: Record<AttachmentStyle, string> = {
  SECURE: '安全型',
  ANXIOUS: '焦虑型',
  AVOIDANT: '回避型',
  FEARFUL: '恐惧型',
};

const LOVE_LANGUAGE_LABELS: Record<string, string> = {
  LOVE_WORDS: '肯定的言辞',
  LOVE_TIME: '精心的时刻',
  LOVE_GIFTS: '接受礼物',
  LOVE_SERVICE: '服务的行动',
  LOVE_TOUCH: '身体的接触',
};

// ---------------------------------------------------------------- 工具

const asAttachment = (style: string): AttachmentStyle =>
  style === 'SECURE' || style === 'ANXIOUS' || style === 'AVOIDANT' || style === 'FEARFUL' ? style : 'SECURE';

/** 0–100 的档位措辞（与情感引擎的 `describeEmotionLevel` 同一口径，避免两处说法不一致） */
const levelOf = (value: number): string => {
  if (value >= 80) return '很高';
  if (value >= 65) return '偏高';
  if (value >= 45) return '中等';
  if (value >= 30) return '偏低';
  return '很低';
};

const round = (value: number): number => Math.round(value);

/** 按分数取前 N 项（并列时按传入顺序，保证确定性） */
const topOf = (scores: Readonly<Record<string, number>> | null, order: readonly string[], count: number): string[] => {
  if (scores === null) return [];

  return order
    .filter((key) => typeof scores[key] === 'number')
    .slice()
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
    .slice(0, count);
};

const lowestOf = (scores: Readonly<Record<string, number>> | null, order: readonly string[]): string | null => {
  if (scores === null) return null;

  const present = order.filter((key) => typeof scores[key] === 'number');
  if (present.length === 0) return null;

  return present.reduce((lowest, key) => ((scores[key] ?? 0) < (scores[lowest] ?? 0) ? key : lowest));
};

const LOVE_ORDER: readonly string[] = ['LOVE_WORDS', 'LOVE_TIME', 'LOVE_GIFTS', 'LOVE_SERVICE', 'LOVE_TOUCH'];

// ---------------------------------------------------------------- 主函数

/**
 * 由情感画像生成结果页的结论
 *
 * 纯函数：同样的输入永远得到同样的输出，可缓存、可单测、可离线复算。
 */
export const buildEmotionConclusion = (input: EmotionConclusionInput): EmotionConclusion => {
  const style = asAttachment(input.attachmentStyle);
  const anxiety = round(input.attachmentAnxiety);
  const avoidance = round(input.attachmentAvoidance);

  // ---- 依恋姿态：两轴分数 + 档位 + 组合含义（把"分数"翻译成"我是什么样的人"）----
  const portrait = [
    `你的依恋焦虑 ${anxiety} 分（${levelOf(anxiety)}），回避 ${avoidance} 分（${levelOf(avoidance)}）。`,
    anxiety >= 45
      ? '焦虑偏高说明你容易担心对方的态度变化，需要比较确定的回应才踏实；'
      : '焦虑偏低说明你不太担心被疏远，对方忙起来时你也能安稳地过自己的日子；',
    avoidance >= 45
      ? '回避偏高说明靠得太近时你会想退开一点，亲密到一定程度会让你有点喘不过气。'
      : '回避偏低说明你并不排斥亲密，愿意贴近对方，也不太需要靠拉开距离来保护自己。',
    `这两条轴合起来，就是「${ATTACHMENT_LABELS[style]}」——它描述的是你**当下**在亲密关系里的倾向，会随对象和阶段变化，不是贴在你身上的标签。`,
  ].join('');

  // ---- 需求：把主导爱的语言翻译成一句"我需要什么" ----
  const primary = input.primaryLoveLanguages.filter((code) => LOVE_LANGUAGE_LABELS[code] !== undefined);
  const primaryLabels = primary.map((code) => `「${LOVE_LANGUAGE_LABELS[code]}」`).join('与');
  const primaryDetail = primary[0] === undefined ? null : NEEDS_BY_LOVE_LANGUAGE[primary[0]];
  const weakest = lowestOf(input.loveLanguageScores, LOVE_ORDER);
  const weakestLabel = weakest === null ? null : LOVE_LANGUAGE_LABELS[weakest];

  const needs =
    primary.length === 0 || primaryDetail === null
      ? '这次测评里爱的语言部分数据不足，暂时给不出"你最需要什么"的结论。可以重新做一次完整作答。'
      : [
          `你最需要的是${primaryLabels}：${primaryDetail.want}。`,
          `具体一点说，${primaryDetail.works}。`,
          weakestLabel === null
            ? ''
            : `相比之下，「${weakestLabel}」对你几乎不起作用——不是你不领情，而是它替代不了你真正需要的那个确认。`,
        ]
          .filter((line) => line !== '')
          .join('');

  // ---- 冲突风格 ----
  const conflict = CONFLICT_LINES[input.conflictStyle] ?? '这次测评里冲突风格部分数据不足，暂时给不出结论。';
  const secondConflict = topOf(
    input.conflictScores,
    [
      'CONFLICT_COLLABORATING',
      'CONFLICT_COMPROMISING',
      'CONFLICT_ACCOMMODATING',
      'CONFLICT_AVOIDING',
      'CONFLICT_COMPETING',
    ],
    2,
  )[1];
  const conflictWithSecond =
    secondConflict === undefined || secondConflict === input.conflictStyle
      ? conflict
      : `${conflict} 另外，你的次高分风格是「${
          {
            CONFLICT_COLLABORATING: '协作',
            CONFLICT_COMPROMISING: '妥协',
            CONFLICT_ACCOMMODATING: '迁就',
            CONFLICT_AVOIDING: '回避',
            CONFLICT_COMPETING: '竞争',
          }[secondConflict] ?? secondConflict
        }」，在对方态度强硬时你可能会切到它。`;

  // ---- 优势：只写这个画像真的支持的那几条，不写通用好话 ----
  const strengths: string[] = [];
  if (avoidance < 45) strengths.push('你不回避亲密：愿意靠近、愿意让对方进来，这是很多人在关系里做不到的');
  if (anxiety < 45) strengths.push('你不太内耗：不会因为一条没回的消息反复推翻整段关系');
  if (input.conflictStyle === 'CONFLICT_COLLABORATING')
    strengths.push('你愿意把问题摊开谈，而不是让对方猜——这能省掉关系里最耗人的那部分');
  if (primary.length > 0)
    strengths.push(`你很清楚自己被爱的条件（${primaryLabels}），这本身就比"说不清想要什么"好办得多`);
  if (strengths.length === 0) strengths.push('你愿意做完这 24 个场景去了解自己，这已经是在关系里主动的那一方');

  // ---- 建议：第一条贴主导爱的语言，后两条贴依恋类型（各型有 4 条备用）----
  const suggestions: string[] = [];
  const loveAdvice = primary[0] === undefined ? undefined : SUGGESTIONS_BY_LOVE_LANGUAGE[primary[0]];
  if (loveAdvice !== undefined) suggestions.push(loveAdvice);
  for (const advice of SUGGESTIONS_BY_ATTACHMENT[style]) {
    if (suggestions.length >= 3) break;
    suggestions.push(advice);
  }

  return {
    headline: HEADLINES[style],
    portrait,
    needs,
    conflict: conflictWithSecond,
    strengths: strengths.slice(0, 3),
    suggestions: suggestions.slice(0, 3),
    note: '以上结论由你的作答按固定规则直接算出，不含 AI 生成内容；它描述的是你当下的倾向，不构成心理诊断，也不评判任何一段具体关系。',
  };
};
