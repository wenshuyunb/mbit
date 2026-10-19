/**
 * 星盘解读（**确定性模板**，AI 不可用时的兜底，也是「首段免费」的来源）
 *
 * ## 为什么要有一份模板，而不是全靠 AI
 *
 * 三层理由，每一层都独立成立：
 *
 *   ① **不能因为 AI 不可用就整页空白**：没配 Key、额度耗尽、厂商抖动、
 *      合规拒答 —— 任何一种都真实存在。模板保证"永远有内容"；
 *   ② **首段免费必须秒出**：免费段落如果要等 20 秒模型，转化率会被等待吃掉；
 *   ③ **模板不会胡说**：它只根据**盘上真实存在的东西**（太阳/月亮/上升星座、
 *      元素与三分类分布、相位、命主星、宫位）来组织，不预测、不承诺。
 *
 * ## 与 AI 版的关系
 *
 * 两者**共用同一套章节结构**（`ReadingSection`），因此前端与解锁逻辑完全一致：
 * AI 版只是把同样的章节写得更细。AI 失败时回退到模板，用户看到的仍是完整结构。
 *
 * ## 合规红线（与 `zodiac-content.spec.ts` 同一套，并由用例断言）
 *
 *   · 不做决策引导（不出现投资/签约/就医/辞职这类词）；
 *   · 不做医疗暗示（状态只谈作息、运动、饮水、用眼）；
 *   · 不做承诺式预测（不写"必定""准确率"）；
 *   · 不用占卜词汇（算命/风水/转运/消灾/改命）。
 */

import { ZODIAC_PROFILES } from './zodiac-content';
import { ZODIAC_ELEMENT_LABELS } from './zodiac.types';
import type { NatalChart } from './zodiac-chart.util';

/** 解读的一个章节 */
export interface ReadingSection {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

/** 一份完整解读 */
export interface ChartReading {
  /** 免费首段（一句话结论 + 三巨头概览），不需要解锁即可看 */
  readonly preview: string;
  /** 完整章节（会员 / 已解锁 / 邀请解锁才返回） */
  readonly sections: readonly ReadingSection[];
}

/** 星盘指纹：出生数据一变就换一份解读（同一份盘永远复用同一份解读） */
export const buildChartHash = (chart: NatalChart): string => {
  const moment = chart.moment;

  // 只取**影响星盘**的字段：生日、时间、经纬度、时区
  const raw = [moment.localDateTime, moment.latitude ?? 'null', moment.longitude ?? 'null', moment.timezoneOffset].join(
    '|',
  );

  // FNV-1a：不需要密码学强度，只需要稳定且足够短
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `${hash.toString(16).padStart(8, '0')}-${raw.length}`;
};

/** 相位性质 → 一句人话解释 */
const aspectNatureText = (nature: 'HARMONIOUS' | 'TENSE' | 'NEUTRAL'): string => {
  if (nature === 'HARMONIOUS') return '这两股力量配合得顺，做起来省力';
  if (nature === 'TENSE') return '这两股力量方向不一致，容易内耗，但也最容易磨出能力';

  return '这两股力量叠在一起，会互相加强';
};

/**
 * 用**盘上真实存在的信息**组织一份解读
 *
 * 每个章节都对应一个可验证的盘面事实，而不是泛泛而谈：
 * 第一章来自三巨头的星座、第二章来自元素与三分类计数、第三章来自相位、
 * 第四章来自命主星与它的落点、第五章来自宫位。
 */
export const buildTemplateReading = (chart: NatalChart): ChartReading => {
  const sun = chart.positions.find((item) => item.key === 'SUN');
  const moon = chart.positions.find((item) => item.key === 'MOON');
  const ascendant = chart.angles.ascendant;

  const sunSign = sun?.sign ?? 'ARIES';
  const moonSign = moon?.sign ?? 'ARIES';
  const sunProfile = ZODIAC_PROFILES[sunSign];
  const moonProfile = ZODIAC_PROFILES[moonSign];
  const ascProfile = ascendant === null ? null : ZODIAC_PROFILES[ascendant.sign];

  const sections: ReadingSection[] = [];

  // ---------------------------------------------------------------- 第一章：三巨头
  const risingText =
    ascProfile === null
      ? '上升星座需要出生时间与出生城市才能算，你补齐之后这一层解读会更完整（它讲的是"别人第一眼看到的你"）。'
      : `上升在${ascProfile.name}：${ascProfile.personality}这是你给外界的第一印象，也是你遇到陌生场合时最先启动的那套反应。`;

  sections.push({
    key: 'big-three',
    title: '你的三巨头：太阳、月亮、上升',
    body: [
      `太阳在${sunProfile.name}：${sunProfile.personality}`,
      `月亮在${moonProfile.name}：${moonProfile.personality}月亮管的是"你私下的样子"——没人看着的时候，你靠什么恢复能量。`,
      risingText,
      `把这三个放在一起看：太阳${sunProfile.traits.join('、')}，月亮${moonProfile.traits.join('、')}${
        ascProfile === null ? '' : `，上升${ascProfile.traits.join('、')}`
      }。它们一致的地方，是你最不需要用力就很自然的部分；不一致的地方，通常就是你觉得"有点撕扯"的地方。`,
    ].join('\n\n'),
  });

  // ---------------------------------------------------------------- 第二章：元素与三分类
  const dominantElement = chart.dominantElement;
  const dominantMode = chart.dominantMode;
  const elementLines = chart.elementDistribution.map((entry) => `${entry.label} ${entry.count} 个`).join('、');
  const missingText =
    chart.missingElements.length === 0
      ? '四元素都占到了，属于比较少见的均衡盘 —— 这类盘的好处是切换得动，代价是"没有一个特别省力的默认模式"。'
      : `你的盘里完全没有${chart.missingElements
          .map((element) => ZODIAC_ELEMENT_LABELS[element].label)
          .join('、')}，这一块往往是你要**刻意补**的地方，而不是天生顺手的。`;

  sections.push({
    key: 'elements',
    title: '你处理事情的默认方式：元素与三分类',
    body: [
      `十大行星的元素分布是：${elementLines}。${
        dominantElement === null
          ? ''
          : `其中${dominantElement.label}最多（${dominantElement.count} 个），${dominantElement.description}`
      }`,
      missingText,
      dominantMode === null
        ? ''
        : `三分类上${dominantMode.label}最多（${dominantMode.count} 个）：${dominantMode.description}另外两类的计数是 ${chart.modeDistribution
            .filter((entry) => entry.key !== dominantMode.key)
            .map((entry) => `${entry.label} ${entry.count} 个`)
            .join('、')}。`,
    ]
      .filter((line) => line.length > 0)
      .join('\n\n'),
  });

  // ---------------------------------------------------------------- 第三章：相位
  const topAspects = chart.aspects.slice(0, 4);
  const aspectLines =
    topAspects.length === 0
      ? ['你的盘上没有形成主要相位的行星对，各行星的独立性比较强 —— 这通常意味着你在不同场合的表现差异会比较明显。']
      : topAspects.map((aspect) => {
          const from = chart.positions.find((item) => item.key === aspect.from)?.name ?? aspect.from;
          const to = chart.positions.find((item) => item.key === aspect.to)?.name ?? aspect.to;

          return `${from}${aspect.symbol}${to}（${aspect.name}，偏差 ${aspect.orb.toFixed(2)}°）：${aspectNatureText(
            aspect.nature,
          )}。`;
        });

  const harmonious = chart.aspects.filter((aspect) => aspect.nature === 'HARMONIOUS').length;
  const tense = chart.aspects.filter((aspect) => aspect.nature === 'TENSE').length;

  sections.push({
    key: 'aspects',
    title: '你的强项与卡点：行星相位',
    body: [
      `相位是行星之间的角度关系。你的盘里共有 ${chart.aspects.length} 条主要相位，其中和谐向 ${harmonious} 条、紧张向 ${tense} 条。`,
      ...aspectLines,
      tense > harmonious
        ? '紧张相位更多不代表"不好"：它对应的是内在有张力、需要反复协调的部分，这类人往往在自己没解决的问题上反而更有办法。'
        : '和谐相位更多意味着你的能力之间配合得好、启动成本低；要注意的是"顺"也容易让人停在舒适区，挑战性的事需要主动找。',
    ].join('\n\n'),
  });

  // ---------------------------------------------------------------- 第四章：命主星
  const ruler = chart.chartRuler;
  sections.push({
    key: 'ruler',
    title: '人生的主线：命主星',
    body:
      ruler === null
        ? `命主星由上升星座决定，补齐出生时间与城市之后才知道。它代表"你这一生反复会回到的那件事"。`
        : `你的上升星座是${ascProfile?.name ?? ''}，守护星是${ruler.planetName}，它落在${ruler.position}（${ruler.signName}）。命主星的落点是"你反复会回到的那件事"：它落在哪一宫，那一宫的议题就会在你人生里反复出现。${
            ascProfile === null ? '' : `结合${ascProfile.name}的特质看，${ascProfile.career}`
          }`,
  });

  // ---------------------------------------------------------------- 第五章：宫位
  const houseText =
    chart.houses === null
      ? '宫位需要出生时间与出生城市才能算。补齐之后，这一章会告诉你哪几个生活领域在你盘上被加重了。'
      : (() => {
          const occupied = chart.positions
            .filter((position) => position.house !== null)
            .reduce<Record<number, string[]>>((accumulator, position) => {
              const house = position.house as number;
              accumulator[house] = [...(accumulator[house] ?? []), position.name];

              return accumulator;
            }, {});

          const busiest = Object.entries(occupied)
            .map(([house, names]) => ({ house: Number(house), names }))
            .sort((left, right) => right.names.length - left.names.length)
            .slice(0, 2);

          return [
            `你的盘采用整宫制：上升星座所在的星座是第 1 宫，之后每个星座一宫。`,
            ...busiest.map(
              (entry) =>
                `第 ${entry.house} 宫最拥挤（${entry.names.join('、')}）—— 这一宫对应的生活领域在你身上会被反复放大。`,
            ),
            chart.stelliums.length === 0
              ? '你的盘里没有 3 颗以上的星群，各领域的力量比较分散。'
              : `盘里有星群：${chart.stelliums.map((item) => `${item.signName}（${item.bodies.join('、')}）`).join('；')}。星群会把那个星座的特质明显放大。`,
          ].join('\n\n');
        })();

  sections.push({ key: 'houses', title: '生活里被加重的领域：十二宫', body: houseText });

  // ---------------------------------------------------------------- 第六章：怎么用
  const strengths = sunProfile.strengths.slice(0, 2).join('、');
  const watchouts = sunProfile.watchouts.slice(0, 2).join('、');

  sections.push({
    key: 'apply',
    title: '可以怎么用这份盘',
    body: [
      `从盘面看，你比较靠得住的地方是：${strengths}。`,
      `需要留意的是：${watchouts}。`,
      `一个具体的做法：把自己最近反复卡住的一件事，对照上面"元素缺失"和"紧张相位"那两段各看一遍 —— 前者提示你要刻意补的能力，后者提示你反复内耗的地方。星盘不负责给你答案，但它能帮你把"为什么总是卡在同一个地方"说得更清楚一点。`,
    ].join('\n\n'),
  });

  // ---------------------------------------------------------------- 首段（免费）
  const preview = [
    `你的太阳在${sunProfile.name}、月亮在${moonProfile.name}${
      ascProfile === null ? '' : `、上升在${ascProfile.name}`
    }。`,
    `最值得先知道的一点：${sunProfile.personality}`,
    ascProfile === null ? '补齐出生时间与出生城市后，会多出上升星座、十二宫与宫位解读。' : `${ascProfile.personality}`,
  ].join('');

  return { preview, sections };
};
