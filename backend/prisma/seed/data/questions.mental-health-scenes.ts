/**
 * 心理状态自评题库：**「这两周的一天」时间轴式情境自评**（24 幕）
 *
 * ## 为什么改（用户拍板）
 *
 * 用户的反馈是：心理状态自评也要**取消普通问卷作答**，换一种方式。
 * 原题库是 24 道抽象自评陈述（"这段时间我常被事情压得喘不过气"），
 * 读起来就是一张量表 —— 而量表在这个产品里已经被用户判定为"不想答"。
 *
 * 改法是**换掉问卷感，保住测量骨架**：把同样 24 道题按"一天的时间轴"重排成
 * **6 个生活时刻 × 4 幕**（早上醒来 → 出门通勤 → 白天做事 → 跟人相处 →
 * 晚上一个人 → 躺下之后），每一幕是一段具体处境 + 一句提问 + 四档频率。
 *
 * ## 为什么不能像情感模块那样自由改
 *
 * 情感测的是**风格偏好**（怎么问都不影响"准不准"）；本模块的六个维度
 * （压力 / 情绪 / 紧张 / 睡眠 / 精力 / 缺少支持）与 PHQ-9、GAD-7 这类筛查量表重叠，
 * 分数越高越值得留意 —— 换句话说它**必须仍然是一个可信的自评**。
 * 因此这里**一个字都没动计分口径**：
 *
 *   · 仍是六个维度、每维 4 题（**2 正 + 2 反**）；
 *   · 仍是四档频率作答（1 = 几乎没有 … 4 = 几乎每天），分值挂在选项的 `scoreMap` 上；
 *   · 反向题沿用引擎的 `reverseScored`（`min + max − value`），
 *     一致性评分照旧能从正/反两组数据里算出矛盾程度；
 *   · 档位阈值（30 / 50 / 70）、整体档位、确定性结论文案**全部不变**。
 *
 * ## 三个写作红线
 *
 * ① **不做性别分卷**（ADR-039 ⓕ）：本模块的题目 `audience` 一律 `ALL`。
 *    情感场景题按性别分三套，规律是"恋爱里的处境确有性别角色差异"；
 *    近两周的压力、睡眠、精力没有这种差异，按性别分开问反而是在暗示
 *    "某个性别更容易出问题"。
 * ② **不给建议**：即时反馈只做**中性确认**（"这两周出现过几次"），
 *    🚫 不出现"试试早点睡""多休息"这类指导。给建议是本模块的合规红线，
 *    深度解读与建议由 AI 助手承担（用户主动追问），不是在这里被动收到。
 * ③ **不用临床构念**：不写"障碍""治疗""崩溃""绝望"这类词（与 `seed-data.spec.ts`
 *    的敏感词表同一口径）。本模块只描述近两周的体验，不做判定。
 *
 * ## 反向题的判据（写题时最容易搞错的地方）
 *
 * 每一幕都要自查一遍：**"几乎没有 → 几乎每天"这一档，代表该维度更高还是更低？**
 *   · 正向题（`reverseScored: false`）：描述的是"症状出现"，
 *     频率越高 → 该维度分数越高。例：M1-1「起身之后身体像还没开机」→ 精力不足更高。
 *   · 反向题（`reverseScored: true`）：描述的是"症状缺席"，
 *     频率越高 → 该维度分数**越低**。例：M1-3「睁眼就知道自己睡够了」→ 精力不足更低。
 *
 * 写反了不会报错，只会让该维度**静默反向**：状态差的人被判成状态好，
 * 而结论文案读起来完全通顺。`questions.mental-health-scenes.spec.ts` 里
 * 用逐题断言把方向钉住。
 *
 * ## 频次的四档为什么固定不变
 *
 * 四个选项（几乎没有 / 有那么两三天 / 一半以上的日子 / 几乎每天）对 24 幕**完全一致**，
 * 且由 `MENTAL_HEALTH_FREQUENCY_OPTIONS` 统一定义 —— 这与 PHQ-9 一类的
 * 频率作答格式一致：**作答格式必须固定**，用户才是在同一把尺子上回答 24 次；
 * 每题换一套说法会让分数之间失去可比性。
 */

import type { SeedDimension, SeedMentalHealthScene, SeedScenarioOption } from '../types';

/** 本模块的时刻键（一天的时间轴，顺序即试卷顺序） */
export type MentalHealthMoment = 'MORNING' | 'COMMUTE' | 'DAYTIME' | 'PEOPLE' | 'EVENING' | 'BEDTIME';

/** 时刻的中文名（文档与后台筛选用） */
export const MENTAL_HEALTH_MOMENT_LABELS: Readonly<Record<MentalHealthMoment, string>> = {
  MORNING: '早上醒来',
  COMMUTE: '出门与通勤',
  DAYTIME: '白天做事',
  PEOPLE: '跟人相处',
  EVENING: '晚上一个人',
  BEDTIME: '躺下之后',
};

/**
 * 统一的四档频率选项
 *
 * `value` 同时是 `scoreMap` 里该维度的取值（1–4）：引擎会据此推导量程 `{min:1, max:4}`，
 * 反向题再由 `reverseScored` 翻到同一极（`min + max − value`）。
 *
 * ⚠ 反馈文案是**共用**的（不是每题一份）：本模块的反馈只承担"确认听到了"，
 * 不解释、不建议。逐题写 96 条反馈不但稀释定位，还极易滑向"你该怎么做"，
 * 那正是本模块明确不做的事。
 */
export const MENTAL_HEALTH_FREQUENCY_OPTIONS: ReadonlyArray<{
  readonly label: string;
  readonly value: number;
  readonly feedback: string;
}> = [
  { label: '几乎没有', value: 1, feedback: '这两周，这样的时刻很少。' },
  { label: '有那么两三天', value: 2, feedback: '这两周出现过几次，不算多。' },
  { label: '一半以上的日子', value: 3, feedback: '这样的日子超过了一半。' },
  { label: '几乎每天', value: 4, feedback: '这样的日子几乎天天都有。' },
];

/**
 * 由维度生成四个选项
 *
 * 分值只挂在**该题自己的维度**上（情感场景题会同时挂多个维度，这里不需要）：
 * 本模块的每一幕只问一件事，跨维度计分会让"压力高"和"睡眠差"互相污染。
 */
export const buildMentalHealthOptions = (dimension: SeedDimension): SeedScenarioOption[] =>
  MENTAL_HEALTH_FREQUENCY_OPTIONS.map((option) => ({
    label: option.label,
    scores: { [dimension]: option.value },
    feedback: option.feedback,
  }));

/**
 * 24 幕题库
 *
 * ⚠ `order` 必须**全局唯一且连续**（0–23）。旧题库的 order 是"维度内 0–3"，
 * 六个维度各写一遍，于是排序出现大量并列 —— 试卷顺序取决于数据库对并列行的返回次序，
 * 属于"看起来有顺序、实际上没保证"。这里按时间轴从早到晚排一次，顺序即叙事顺序。
 */
export const MENTAL_HEALTH_SCENES: SeedMentalHealthScene[] = [
  // ======================= 一、早上醒来（4 幕）=======================
  {
    code: 'MH_SC_01',
    order: 0,
    moment: 'MORNING',
    dimension: 'MH_ENERGY',
    reverseScored: false,
    content: '闹钟响了第三遍，你才把自己从床上撑起来。起身之后身体像还没开机，做什么动作都是慢的。',
    prompt: '这两周，这样的早晨大概有多少？',
    tags: ['早上', '起床', '精力'],
  },
  {
    code: 'MH_SC_02',
    order: 1,
    moment: 'MORNING',
    dimension: 'MH_SLEEP',
    reverseScored: false,
    content: '昨晚躺下的时候已经很晚，早上被闹钟硬生生叫醒。白天你一直惦记着什么时候能补一觉。',
    prompt: '这两周，这样的早晨大概有多少？',
    tags: ['早上', '睡不够', '补觉'],
  },
  {
    code: 'MH_SC_03',
    order: 2,
    moment: 'MORNING',
    dimension: 'MH_ENERGY',
    reverseScored: true,
    content: '醒来的时候天刚亮，你睁眼就知道自己睡够了。起身的时候不费劲，手脚是听使唤的。',
    prompt: '这两周，这样的早晨大概有多少？',
    tags: ['早上', '睡够了', '清醒'],
  },
  {
    code: 'MH_SC_04',
    order: 3,
    moment: 'MORNING',
    dimension: 'MH_SLEEP',
    reverseScored: true,
    content: '早上你回想了一下：昨晚几乎没醒过，一觉就到了闹钟响，中间没什么印象。',
    prompt: '这两周，这样的夜里大概有多少？',
    tags: ['早上', '睡得连贯', '夜里没醒'],
  },

  // ======================= 二、出门与通勤（4 幕）=======================
  {
    code: 'MH_SC_05',
    order: 4,
    moment: 'COMMUTE',
    dimension: 'MH_STRESS',
    reverseScored: false,
    content: '出门前你在屋里来回找东西，鞋带是边走边系的。到车站的时候，你已经在心里算自己会迟到几分钟。',
    prompt: '这两周，这样赶着出门的早上大概有多少？',
    tags: ['通勤', '赶时间', '被追着'],
  },
  {
    code: 'MH_SC_06',
    order: 5,
    moment: 'COMMUTE',
    dimension: 'MH_STRESS',
    reverseScored: true,
    content: '出门的时间是你自己定的。路上还有空看一眼天，也来得及买杯喝的再上车。',
    prompt: '这两周，这样的早上大概有多少？',
    tags: ['通勤', '节奏自己定', '从容'],
  },
  {
    code: 'MH_SC_07',
    order: 6,
    moment: 'COMMUTE',
    dimension: 'MH_ANXIETY',
    reverseScored: false,
    content: '车上人挤人，你忽然发现自己心跳得很快，手心有点潮，胃里也不太舒服。并没有发生什么事。',
    prompt: '这两周，这样的时刻大概有多少？',
    tags: ['通勤', '心跳快', '手心出汗'],
  },
  {
    code: 'MH_SC_08',
    order: 7,
    moment: 'COMMUTE',
    dimension: 'MH_ANXIETY',
    reverseScored: true,
    content: '出门前你在门口停了一下，把今天要做的事在心里摆好，然后才推门出去。',
    prompt: '这两周，你能这样出门的日子大概有多少？',
    tags: ['通勤', '稳住', '出门前'],
  },

  // ======================= 三、白天做事（4 幕）=======================
  {
    code: 'MH_SC_09',
    order: 8,
    moment: 'DAYTIME',
    dimension: 'MH_ENERGY',
    reverseScored: false,
    content: '才做了不到一小时，你就想找个地方靠一会儿。手边的事没做完，身体已经在说"今天到这儿吧"。',
    prompt: '这两周，这样的白天大概有多少？',
    tags: ['白天', '做一点就累', '靠一会儿'],
  },
  {
    code: 'MH_SC_10',
    order: 9,
    moment: 'DAYTIME',
    dimension: 'MH_ENERGY',
    reverseScored: true,
    content: '回消息、整理材料、把该交的交出去，一件件做完了。做完这些，你没觉得自己被掏空。',
    prompt: '这两周，这样的白天大概有多少？',
    tags: ['白天', '做完事', '不觉得空'],
  },
  {
    code: 'MH_SC_11',
    order: 10,
    moment: 'DAYTIME',
    dimension: 'MH_MOOD',
    reverseScored: false,
    content: '屏幕开着，鼠标停在原地。你知道该做什么，但就是提不起劲，最后刷了半小时手机，什么都没推进。',
    prompt: '这两周，这样的下午大概有多少？',
    tags: ['白天', '提不起劲', '拖延'],
  },
  {
    code: 'MH_SC_12',
    order: 11,
    moment: 'DAYTIME',
    dimension: 'MH_MOOD',
    reverseScored: true,
    content: '忙到一半，你被手头的事带了进去，忘了看时间。抬头的时候，外面已经黑了。',
    prompt: '这两周，这样能沉进去的时刻大概有多少？',
    tags: ['白天', '投入', '忘了时间'],
  },

  // ======================= 四、跟人相处（4 幕）=======================
  {
    code: 'MH_SC_13',
    order: 12,
    moment: 'PEOPLE',
    dimension: 'MH_LONELINESS',
    reverseScored: false,
    content: '手机翻了半天，通讯录里的名字滑过去一个又一个。你最后把屏幕扣在桌上——想说话，但不知道能找谁。',
    prompt: '这两周，这样的时刻大概有多少？',
    tags: ['相处', '没人可聊', '想说话'],
  },
  {
    code: 'MH_SC_14',
    order: 13,
    moment: 'PEOPLE',
    dimension: 'MH_LONELINESS',
    reverseScored: true,
    content: '事情卡住的时候，你心里很清楚该找谁。电话接通，对方一句"你说"，你就知道自己找对人了。',
    prompt: '这两周，这样的时刻大概有多少？',
    tags: ['相处', '有人可找', '接得住'],
  },
  {
    code: 'MH_SC_15',
    order: 14,
    moment: 'PEOPLE',
    dimension: 'MH_LONELINESS',
    reverseScored: false,
    content: '你跟人说了半天，对方回你"想开点""大家都这样"。你把后半截话咽回去了。',
    prompt: '这两周，这样的时候大概有多少？',
    tags: ['相处', '不被理解', '咽回去'],
  },
  {
    code: 'MH_SC_16',
    order: 15,
    moment: 'PEOPLE',
    dimension: 'MH_LONELINESS',
    reverseScored: true,
    content: '那天你状态很差，谁也没叫。但有人看出来了，什么也没问，就在你旁边坐了一会儿。',
    prompt: '这两周，这样被人接住的时刻大概有多少？',
    tags: ['相处', '有人陪着', '被看见'],
  },

  // ======================= 五、晚上一个人（4 幕）=======================
  {
    code: 'MH_SC_17',
    order: 16,
    moment: 'EVENING',
    dimension: 'MH_MOOD',
    reverseScored: false,
    content: '洗完澡坐在床边，本来想看点喜欢的剧，点开两分钟就关了——好像也没什么意思。',
    prompt: '这两周，这样的晚上大概有多少？',
    tags: ['晚上', '兴趣减退', '没意思'],
  },
  {
    code: 'MH_SC_18',
    order: 17,
    moment: 'EVENING',
    dimension: 'MH_MOOD',
    reverseScored: true,
    content: '睡前你想起下个月要去做的那件事，心里有点期待，甚至盘算了一下要准备什么。',
    prompt: '这两周，这样的晚上大概有多少？',
    tags: ['晚上', '有期待', '盼头'],
  },
  {
    code: 'MH_SC_19',
    order: 18,
    moment: 'EVENING',
    dimension: 'MH_STRESS',
    reverseScored: false,
    content: '白天那件事还在你脑子里转。明明已经到家了，肩膀却还是端着的，一直松不下来。',
    prompt: '这两周，这样的晚上大概有多少？',
    tags: ['晚上', '放松不下来', '还在转'],
  },
  {
    code: 'MH_SC_20',
    order: 19,
    moment: 'EVENING',
    dimension: 'MH_STRESS',
    reverseScored: true,
    content: '睡前你把明天要做的事写在纸上。写完合上本子，今天就算过完了。',
    prompt: '这两周，这样能收住的晚上大概有多少？',
    tags: ['晚上', '收尾', '放下'],
  },

  // ======================= 六、躺下之后（4 幕）=======================
  {
    code: 'MH_SC_21',
    order: 20,
    moment: 'BEDTIME',
    dimension: 'MH_SLEEP',
    reverseScored: false,
    content: '关灯躺好，脑子却开始转：白天说错的那句话、明天可能出的岔子。越想越清醒。',
    prompt: '这两周，这样的夜里大概有多少？',
    tags: ['睡前', '脑子停不下来', '入睡难'],
  },
  {
    code: 'MH_SC_22',
    order: 21,
    moment: 'BEDTIME',
    dimension: 'MH_SLEEP',
    reverseScored: true,
    content: '躺下没多久你就睡过去了，中间没醒，早上是被闹钟叫醒的。',
    prompt: '这两周，这样的夜里大概有多少？',
    tags: ['睡前', '入睡快', '一觉到天亮'],
  },
  {
    code: 'MH_SC_23',
    order: 22,
    moment: 'BEDTIME',
    dimension: 'MH_ANXIETY',
    reverseScored: false,
    content: '半夜醒来，屋里很静。你摸过手机看了一眼时间，又躺回去，心里开始盘算那件还没解决的事。',
    prompt: '这两周，这样半夜醒来的夜里大概有多少？',
    tags: ['夜里', '半夜醒', '盘算'],
  },
  {
    code: 'MH_SC_24',
    order: 23,
    moment: 'BEDTIME',
    dimension: 'MH_ANXIETY',
    reverseScored: true,
    content: '关灯之后你能让自己慢慢松下来：肩膀放下，呼吸变慢，脑子里的声音也跟着小下去。',
    prompt: '这两周，这样的夜里大概有多少？',
    tags: ['睡前', '松下来', '安静'],
  },
];

/** 全部 24 幕（供 seed 与 spec 使用；`audience` 一律 `ALL`，不做性别分卷） */
export const ALL_MENTAL_HEALTH_SCENES = MENTAL_HEALTH_SCENES;
