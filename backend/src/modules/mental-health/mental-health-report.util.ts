/**
 * 心理状态自评的**解读层**：让结果"看得出所以然、拿得走东西"
 *
 * ## 为什么要有这一层
 *
 * 用户的实测反馈是：「心理评测报告没有特色，没有建设性建议，我看不出个所以然来，
 * 请你结合市面上类似的程序或者应用，结合一下长处来设计评测报告所展示的内容」。
 *
 * 改版前那一屏只有：整体档位一句话 + 六条分数 + 一段三句话的结论 + 免责声明。
 * **分数有了，含义没有；结论有了，下一步没有。** 对照市面上的做法，
 * 一份说得过去的自评结果页至少要回答四个问题：
 *
 * | 用户的问题             | 市面常见做法                                   | 本模块的答案（本文件）        |
 * | ---------------------- | ---------------------------------------------- | ----------------------------- |
 * | 这个分数是什么意思？   | 每维配一句人话解释                             | `MENTAL_HEALTH_DIMENSION_READINGS` |
 * | 只有我这样吗？         | 去污名化的一句（"这很常见"）                   | `ENDORSEMENTS`                |
 * | 我现在能做什么？       | 2–3 条当天可做的小事（不是"多休息"这种空话）   | `SUGGESTIONS_BY_DIMENSION`    |
 * | 什么时候该找人聊聊？   | 分档的求助指引 + 官方热线                      | `buildSupport`                |
 *
 * 再加两件提升"特色"的事：
 *   · **只看最值得留意的 2 项**（而不是六条平铺）—— 一屏之内先给重点；
 *   · **两周后再测一次**：单次分数只是快照，趋势才有意义（这也是 mood 类 App 的通用做法）。
 *
 * ## 与"不做建议"这条红线的关系（**本轮明确收窄，不是取消**）
 *
 * 本模块原先的形态是「只做结论、不给建议、不做心理干预」—— 那条红线的**真正目的是
 * 不做临床建议与心理干预**，而不是"一个字都不许说"。因此本文件的建议遵守四条边界：
 *
 *   ① **只给生活层面的自我照顾**（记录、呼吸、规律作息、走出门、找人说话…），
 *      🚫 不给临床建议、不提药物、不提治疗、不承诺疗效；
 *   ② **不基于"病"说话**：措辞是"最近压力感比较明显时，可以……"，
 *      而不是"你患有……，应该……"；
 *   ③ **必须有求助指引**：分档给出"什么时候找人聊聊"，并附**官方热线**——
 *      这是行业标准做法，也是"建设性"里最重要的一条；
 *   ④ **免责声明照旧**由服务端下发并含「本结果仅供参考」。
 *
 * ## 确定性
 *
 * 与结论文本一样是**纯函数**（ADR-005）：输入是落库快照里的分数与档位，
 * 输出永远相同 —— 不调模型、不消耗额度、不随提示词版本变化。
 * ⚠ 取值只读**快照里的档位**，不重新按当前阈值判定：阈值被运营调过之后，
 * 老结果页仍该说当时那句话。
 */

import {
  MENTAL_HEALTH_DIMENSION_LABELS,
  MENTAL_HEALTH_DIMENSIONS,
  type MentalHealthDimension,
  type MentalHealthOverallLevel,
} from './engine/mental-health-engine.types';

/** 落库快照里的单维数据（`mental_health_profiles.dimension_scores`） */
export interface MentalHealthSnapshotDimension {
  readonly score: number;
  readonly band: string;
  readonly usable: boolean;
}

/** 一条可执行的小事 */
export interface MentalHealthSuggestion {
  /** 做什么（一句话，动词开头，当天就能做） */
  readonly action: string;
  /** 为什么有用（扣回这一维的测量含义，不是万能理由） */
  readonly reason: string;
  /** 什么时候做（可自检的时机，例如"睡前半小时"） */
  readonly when: string;
  /** 它针对哪一维（前端据此标"来自：睡眠困扰"） */
  readonly dimension: string;
  /** 维度中文名 */
  readonly dimensionLabel: string;
}

/** 单维的解读（分数条旁边那句人话） */
export interface MentalHealthDimensionReading {
  readonly key: string;
  readonly label: string;
  readonly score: number;
  readonly band: string;
  readonly bandLabel: string;
  readonly usable: boolean;
  /** 这一维在测什么（一句人话） */
  readonly meaning: string;
  /** 这一维偏高时，用户通常是什么体验（让用户对号入座） */
  readonly commonExperience: string;
}

/** 求助指引（分档措辞 + 官方热线） */
export interface MentalHealthSupport {
  /** 标题（按档位不同） */
  readonly title: string;
  /** 正文：什么时候该找人聊聊（**不含临床表述**） */
  readonly text: string;
  /** 官方心理援助热线（国家卫健委 2024 年统一号码） */
  readonly hotline: {
    readonly name: string;
    readonly number: string;
    readonly note: string;
  };
}

/** 完整的解读层输出 */
export interface MentalHealthReportExtras {
  readonly readings: readonly MentalHealthDimensionReading[];
  /** 只看最值得留意的 1–2 项（前端做成大卡片，一屏给重点） */
  readonly highlights: readonly MentalHealthDimensionReading[];
  /** 去污名化的一句（"这很常见"） */
  readonly endorsement: string;
  readonly suggestions: readonly MentalHealthSuggestion[];
  readonly support: MentalHealthSupport;
  /** 复测引导（把单次分数变成趋势） */
  readonly retestHint: string;
}

const DIMENSION_SET: ReadonlySet<string> = new Set<string>(MENTAL_HEALTH_DIMENSIONS);

/** 档位中文名（与引擎同一口径，只用于展示） */
const BAND_LABELS: Readonly<Record<string, string>> = {
  CALM: '平稳',
  SLIGHT: '偶尔',
  MILD: '比较明显',
  NOTABLE: '比较突出',
};

/**
 * 每一维在测什么 + 偏高时通常是什么体验
 *
 * ⚠ 两条写作红线：
 *   · `meaning` 只描述**体验**，不引入临床构念（不写"抑郁""焦虑症""症状"）；
 *   · `commonExperience` 要说**具体**（"躺下以后脑子停不下来"），
 *     因为用户是靠"对上号"来判断这份结果准不准的 —— 空泛的"你可能会不舒服"没有信息量。
 */
const DIMENSION_READINGS: Readonly<Record<MentalHealthDimension, { meaning: string; commonExperience: string }>> = {
  MH_STRESS: {
    meaning: '这一项看的是"事情压过来"的感受强度：被事情追着、时间不够用、松不下来。',
    commonExperience: '偏高的人常说：事情一件接一件，明明是休息时间，脑子里还在过待办清单。',
  },
  MH_MOOD: {
    meaning: '这一项看的是情绪的低落程度：提不起劲、对喜欢的事失去兴趣、容易想哭。',
    commonExperience: '偏高的人常说：该做的事都做了，但做的时候没什么感觉，也说不上期待什么。',
  },
  MH_ANXIETY: {
    meaning: '这一项看的是"心里发紧"的频率：提前担心、静不下来，身体也跟着紧（心跳快、手心出汗）。',
    commonExperience: '偏高的人常说：事情还没发生，已经先演了一遍最坏的结果。',
  },
  MH_SLEEP: {
    meaning: '这一项看的是睡眠的困扰程度：入睡慢、夜里易醒、作息不固定、醒来不解乏。',
    commonExperience: '偏高的人常说：躺下以后脑子最活跃，越想着"快睡"越睡不着。',
  },
  MH_ENERGY: {
    meaning: '这一项看的是精力的存量：做一点就累、恢复得慢、白天犯困。',
    commonExperience: '偏高的人常说：睡了很久，起来还是像没充上电。',
  },
  MH_LONELINESS: {
    meaning: '这一项看的是"身边有没有人接得住你"：想说话时找不找得到人、是否被理解。',
    commonExperience: '偏高的人常说：不是没有联系人，是翻完通讯录也不知道该找谁。',
  },
};

/**
 * 每一维对应的可执行小事（各 3 条，按"最该先做的"排序）
 *
 * 三条写作约束（照抄市面上"多沟通""保持乐观"这类空话是最容易犯的错）：
 *   · **当天能做**：不是"以后要规律作息"，而是"今晚把手机放到客厅充电"；
 *   · **说清为什么**：扣回这一维的测量含义（例如睡眠困扰 → 躺下后脑子活跃）；
 *   · **可自检**：给一个"怎么算做到了"的时机或次数。
 */
const SUGGESTIONS_BY_DIMENSION: Readonly<
  Record<MentalHealthDimension, readonly Omit<MentalHealthSuggestion, 'dimension' | 'dimensionLabel'>[]>
> = {
  MH_STRESS: [
    {
      action: '把待办从脑子里搬到纸上，写完就合上本子',
      reason: '压力感很大一部分来自"记着"而不是"做着"：写下来之后，大脑不用一直替你保管清单。',
      when: '睡前或早上各花三分钟',
    },
    {
      action: '给今天挑出一件"今天不做也行"的事，明确地不做',
      reason: '被事情压住的感觉来自"哪件都不能放"，主动放掉一件能把紧绷感降一档。',
      when: '每天早上挑一件事',
    },
    {
      action: '在日程里留一个 15 分钟的空档，什么也不安排',
      reason: '喘息的空档不会自己出现，它必须被"写进日程"才不会被别的事填满。',
      when: '下午最容易疲的时候',
    },
  ],
  MH_MOOD: [
    {
      action: '做一件"两分钟就能完成"的小事（洗个碗、下楼买瓶水）',
      reason: '情绪低落时最容易卡在"什么都不想开始"；两分钟的任务小到不需要动力，做完能拽回一点掌控感。',
      when: '躺着刷手机超过十分钟的时候',
    },
    {
      action: '把以前喜欢的那件事，用最小规模做一次（只做十分钟也算）',
      reason: '兴趣是"做着做着回来的"，等有心情再开始通常等不到。',
      when: '这周挑一天',
    },
    {
      action: '今天见一个"见面不用端着"的人，哪怕只待二十分钟',
      reason: '低落和独处会互相加强；一次低压力的见面比自我开导有用。',
      when: '这周挑一天',
    },
  ],
  MH_ANXIETY: [
    {
      action: '担心冒出来时，把"我在担心什么"写成一句话',
      reason: '担心一旦被写成具体的句子，就会从"弥漫的紧"变成"一件可以处理的事"。',
      when: '一天里第一次觉得心里发紧时',
    },
    {
      action: '做 4-7-8 呼吸：吸气 4 秒、屏住 7 秒、呼气 8 秒，做四轮',
      reason: '呼气拉长会让身体先慢下来，身体慢下来之后"发紧"的感觉会跟着降（这是最常用的放松技术之一）。',
      when: '心跳快、坐不住的时候',
    },
    {
      action: '把"提前担心"的那件事，写下最早能动手的时间',
      reason: '反复想是因为"还没到时候"；给它一个确定的动手时间，脑子就不用一直提醒你。',
      when: '想到就写，一次一条',
    },
  ],
  MH_SLEEP: [
    {
      action: '睡前半小时把手机放到够不着的地方充电',
      reason: '躺下后脑子最活跃时，手机是最容易接上"继续想"的东西；把它挪远，等于给大脑一个"今天结束了"的信号。',
      when: '每天睡前半小时',
    },
    {
      action: '躺下二十分钟没睡着就起来，去别的房间坐一会儿（困了再回来）',
      reason: '让"床"和"翻来覆去"脱钩，是睡眠困扰最常见的处理方式；越在床上硬躺，床和清醒绑得越紧。',
      when: '躺下超过二十分钟还清醒时',
    },
    {
      action: '把明天的第一件事写在纸上再关灯',
      reason: '夜里反复想的多半是"明天别漏了什么"；写下来之后，大脑可以把它放下。',
      when: '关灯之前',
    },
  ],
  MH_ENERGY: [
    {
      action: '下午最困的那一段，离开座位走五分钟（走到户外更好）',
      reason: '精力不足时"再撑一会儿"效率更低；五分钟的活动比再来一杯咖啡更能把状态拉回来。',
      when: '下午犯困的时候',
    },
    {
      action: '今天先做那件最费脑的事，把它放在上午',
      reason: '精力是有限的存量，先花在难事上，剩下的时间就不会一直有"还没开始"的压迫感。',
      when: '每天开工后第一件事',
    },
    {
      action: '把"做完"的标准调低一档（今天只要求完成一半）',
      reason: '累过之后恢复慢，常常是因为一直按"状态好时的标准"要求自己。',
      when: '这周挑一天试',
    },
  ],
  MH_LONELINESS: [
    {
      action: '给一个"很久没联系但不尴尬"的人发一条具体的话（不带求助，比如"看到这个想起你"）',
      reason: '连接的门槛通常是"我得有个正经理由"；一条具体的小消息比"在吗"更容易接上话。',
      when: '这周挑一天',
    },
    {
      action: '把真实感受说给一个人听，先不说结论、只说发生了什么',
      reason: '缺少支持的感受往往来自"说了也没人懂"；先讲事实、不急着要答案，更容易被接住。',
      when: '下次有人问你"最近怎么样"时',
    },
    {
      action: '找一个固定的"有人在场"的场合（运动、兴趣班、志愿活动都算）',
      reason: '稳定的弱连接比偶尔的深聊更容易维持，而它恰恰最能把"没人可说"的底色改掉。',
      when: '这周先去一次',
    },
  ],
};

/**
 * 去污名化的一句（按整体档位给不同措辞）
 *
 * 为什么需要它：自评结果最容易造出的副作用是"我是不是有问题"。
 * 市面上的产品几乎都会在同一屏里给一句"这很常见"，道理就在这里 ——
 * 它既降低焦虑，也让后面的建议变得可接受。
 */
const ENDORSEMENTS: Readonly<Record<MentalHealthOverallLevel, string>> = {
  GOOD: '这六个方面最近都比较平稳。这类自评本身只是照一面镜子，看的是这两周，不是给你下定义。',
  MILD: '你选的这些感受，在节奏快、事情多的时候很常见 —— 它反映的是这两周的状态，不是你的性格，也不是你的能力问题。',
  NOTABLE:
    '有几个方面最近确实比较吃力。这种状态在很多人的某一段时间里都出现过，它说明你最近消耗得多，不等于你"出了什么问题"。',
};

/** 复测引导：单次分数只是快照，趋势才有意义 */
const RETEST_HINT = '状态是流动的。两周后再测一次，然后看两次之间的变化 —— 比单看这一次的分数有用得多。';

/** 官方心理援助热线（国家卫健委 2024-12 统一启用的号码） */
const HOTLINE = {
  name: '全国统一心理援助热线',
  number: '12356',
  note: '由各地卫生健康部门提供，免费、可匿名；想找人说说话的时候可以打，不需要"够严重"才打。',
} as const;

/**
 * 求助指引（**分档措辞**，这是"建设性"里最重要的一条）
 *
 * ⚠ 三档的差别不是"要不要提热线"，而是**语气与紧迫度**：
 *   · GOOD：告知性的（"如果持续变差，可以…"），不制造压力；
 *   · MILD：建议性的（"如果两周以上没有缓解，值得找人聊聊"）；
 *   · NOTABLE：明确建议（"建议找专业人士聊一次"）+ 强调"这不是严重才需要"。
 * 热线**三档都显示**：状态好的人也可能某天需要，藏起来反而让它像"急救按钮"。
 */
const buildSupport = (overallLevel: MentalHealthOverallLevel): MentalHealthSupport => {
  switch (overallLevel) {
    case 'NOTABLE':
      return {
        title: '有一件事想认真告诉你',
        text:
          '这份自评显示，最近这段时间你在几个方面都比较吃力。它不是诊断，也说明不了"你是什么样的人"，' +
          '但如果这种状态已经持续了两周以上、并且影响到工作、睡眠或跟人的相处，建议找专业人士聊一次。' +
          '找心理咨询师或去医院的临床心理科都算，不需要"够严重"才去 —— 就像身体不舒服会去看医生一样。',
        hotline: HOTLINE,
      };
    case 'MILD':
      return {
        title: '什么时候值得找人聊聊',
        text:
          '如果这些感受已经持续两周以上，或者开始影响到睡眠、工作和跟人的相处，值得找人聊一次；' +
          '在那之前，跟信任的人说说、把状态记下来，都会有用。',
        hotline: HOTLINE,
      };
    default:
      return {
        title: '什么时候值得找人聊聊',
        text: '现在整体比较平稳。如果哪天这些感受明显变多、并且持续了两周以上，可以找人聊聊 —— 早一点说，比熬到撑不住再找要轻松得多。',
        hotline: HOTLINE,
      };
  }
};

/** 把快照里的对象读成有序数组（只保留本模块的六个维度、且 `usable` 的项） */
const readDimensions = (
  dimensionScores: Readonly<Record<string, MentalHealthSnapshotDimension | undefined>>,
): MentalHealthDimensionReading[] =>
  MENTAL_HEALTH_DIMENSIONS.filter((dimension) => {
    const row = dimensionScores[dimension];

    return row !== undefined && row.usable;
  }).map((dimension) => {
    const row = dimensionScores[dimension] as MentalHealthSnapshotDimension;
    const reading = DIMENSION_READINGS[dimension];

    return {
      key: dimension,
      label: MENTAL_HEALTH_DIMENSION_LABELS[dimension],
      score: row.score,
      band: row.band,
      bandLabel: BAND_LABELS[row.band] ?? row.band,
      usable: row.usable,
      meaning: reading.meaning,
      commonExperience: reading.commonExperience,
    };
  });

/**
 * 挑建议：**最高分的两维**各出一条 + 次高分的一维再出一条
 *
 * 为什么不是"每个维度都给"：六维各三条 = 18 条，等于把选择权又丢回给用户，
 * 结果就是"看了很多、什么都没做"。先给三条最贴他当下处境的。
 *
 * 为什么不是"只给最高那一维三条"：单一维度的三条容易重复，
 * 而"压力 + 睡眠"这类**常常一起出现**的组合才是用户真实的处境。
 */
const pickSuggestions = (ordered: readonly MentalHealthDimensionReading[]): MentalHealthSuggestion[] => {
  const picked: MentalHealthSuggestion[] = [];

  for (const reading of ordered) {
    const dimension = reading.key as MentalHealthDimension;
    const candidates = SUGGESTIONS_BY_DIMENSION[dimension];

    // 最高分维度取前两条，其后每个维度取一条 —— 直到凑够三条
    const take = picked.length === 0 ? 2 : 1;

    for (const item of candidates.slice(0, take)) {
      if (picked.length >= 3) break;

      picked.push({ ...item, dimension, dimensionLabel: reading.label });
    }

    if (picked.length >= 3) break;
  }

  return picked;
};

/**
 * 组装解读层
 *
 * @param dimensionScores 落库快照（`mental_health_profiles.dimension_scores`）
 * @param overallLevel    落库快照（**不重算**：阈值被调过之后，老结果仍该说当时那句话）
 * @param highlightCount  前端要"大卡片"展示的重点项数量（默认 2）
 */
export const buildMentalHealthReportExtras = (
  dimensionScores: Readonly<Record<string, MentalHealthSnapshotDimension | undefined>>,
  overallLevel: string,
  highlightCount = 2,
): MentalHealthReportExtras => {
  /** 按分数降序（并列时按固定维度顺序，保证同一份数据每次排序一致） */
  const readings = readDimensions(dimensionScores);
  const ordered = [...readings].sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;

    return (
      MENTAL_HEALTH_DIMENSIONS.indexOf(a.key as MentalHealthDimension) -
      MENTAL_HEALTH_DIMENSIONS.indexOf(b.key as MentalHealthDimension)
    );
  });

  const level = (['GOOD', 'MILD', 'NOTABLE'] as const).includes(overallLevel as MentalHealthOverallLevel)
    ? (overallLevel as MentalHealthOverallLevel)
    : 'MILD';

  return {
    readings,
    highlights: ordered.slice(0, Math.max(0, highlightCount)),
    endorsement: ENDORSEMENTS[level],
    suggestions: pickSuggestions(ordered),
    support: buildSupport(level),
    retestHint: RETEST_HINT,
  };
};

/** 本模块的六个维度（供调用方校验脏数据） */
export const isMentalHealthDimension = (key: string): boolean => DIMENSION_SET.has(key);

/** 供测试与文档引用：四档档位名 */
export const MENTAL_HEALTH_BAND_LABEL_MAP = BAND_LABELS;
