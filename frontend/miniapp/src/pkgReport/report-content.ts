/**
 * 报告正文的**版式解析**（纯函数，可 100% 单测）
 *
 * ## 为什么要在前端拆正文
 *
 * 用户的实测反馈：「点开一看，哇，全是字，我是用户我看都不想看，累不累啊，
 * 最好是图文并茂，一针见血，显得有亲和力，而不是字多就行」。
 *
 * 报告正文本身是**有结构**的（模板规定了每段先给结论、建议必须编号、
 * 行动按两周排），但 `report_sections.content` 存的是 Markdown 文本，
 * 直接整段塞进 `<text>` 就是一堵墙。这里把结构**解析出来**交给页面渲染：
 *
 *   · `lead`     —— 每段的**第一句**，单独放大显示（"一针见血"就靠它）
 *   · `paragraphs` —— 其余段落，默认折叠，想看细节再展开
 *   · `cards`    —— 「五条建议」段拆成 5 张编号卡（模板要求编号，因此可解析）
 *   · `weeks`    —— 「两周行动」段拆成 第一周 / 第二周 两块
 *
 * ## 三条原则
 *
 * ① **解析失败要能降级**：模型偶尔不编号、不写"第一周"。任何一处解析不出来，
 *    就退回普通段落渲染 —— **绝不因为版式解析失败而丢内容**（内容比版式重要）。
 * ② **不重排、不删改原文**：只做切分与去空白，句子逐字保留。报告是"AI 根据我的
 *    作答写的"，前端擅自改写会让人察觉不到地篡改原意。
 * ③ **不解析 Markdown 语法**：正文只允许二级标题（标题由段落声明给出，不在 content 里），
 *    正文里出现的 `**加粗**` 等标记按原样保留 —— 引入 Markdown 渲染器要额外处理
 *    小程序端的安全与样式问题，而这里只需要"分块 + 折叠"。
 */

/** 建议卡（「五条具体建议」段的每条） */
export interface SuggestionCard {
  /** 原文里的序号（1–9）；解析不到时为数组下标 + 1 */
  readonly index: number;
  /** 一句话标题（取第一条句号前的部分），过长时截断 */
  readonly title: string;
  /** 卡内正文（原文剩余部分，逐字保留） */
  readonly body: string;
}

/** 行动块（「两周行动」段按周拆出的块） */
export interface ActionWeek {
  readonly label: string;
  readonly text: string;
}

/** 一段正文的版式结构 */
export interface SectionLayout {
  /** 第一句（放大显示）；正文为空时为空串 */
  readonly lead: string;
  /** 其余段落（已去空白；正文只有一句时为空数组） */
  readonly paragraphs: readonly string[];
  /** 编号建议卡（非建议段或无编号时为空数组） */
  readonly cards: readonly SuggestionCard[];
  /** 两周行动块（非行动段或解析不出"第一周/第二周"时为空数组） */
  readonly weeks: readonly ActionWeek[];
  /** 正文字数（用于"展开全文"按钮上的提示） */
  readonly charCount: number;
}

/** 建议卡的标题上限（超过就截断，避免一张卡的开头占满整屏） */
const CARD_TITLE_MAX = 42;

/** 「第一句」的上限：超过这个长度就不再找句号，直接截断 */
const LEAD_MAX = 90;

/** 建议段与行动段的段落键（与模板段落声明一致） */
const SUGGESTIONS_SECTION_KEY = 'GROWTH_SUGGESTIONS';
const ACTION_SECTION_KEY = 'ACTION_PLAN';

/**
 * 按空行切段（段落是模型输出里最稳定的结构：两段之间一定有空行）
 *
 * 兜底：整段只有一个 `\n` 分隔的长文本时（模型偶尔只换行不空行），
 * 再按单换行切一次 —— 判据是"切出来的每一行都够长"，避免把正文里的短行
 * （例如列表项）误切成段落。
 */
const splitParagraphs = (content: string): string[] => {
  const normalized = content.replace(/\r\n/g, '\n').trim();

  if (normalized.length === 0) return [];

  const byBlankLine = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  if (byBlankLine.length > 1) return byBlankLine;

  const bySingleLine = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  /**
   * 每一行都够长才算"其实是分段"，否则原样当一段。
   *
   * ⚠ 阈值取 **24** 而不是 40：实测模型写的段落行常在 25–35 字之间
   * （"你的两条轴也说明了这一点。焦虑轴 52、回避轴 0……"），
   * 阈值过高会让这些报告**切不开段**，而"切不开段"在页面上的表现
   * 就是回到了那堵墙 —— 正好是这个改动要解决的问题。
   * 而列表项（`1. …` / `- …`）通常远短于 24 字，仍能被挡住。
   */
  return bySingleLine.length > 1 && bySingleLine.every((line) => line.length >= 24) ? bySingleLine : [normalized];
};

/**
 * 取第一句
 *
 * 报告模板要求每段"首句直接给结论"，因此第一句就是这一段最该被看见的那句话。
 * 找不到句末标点时退回整段（上限 `LEAD_MAX`，超出按逗号处断开，尽量不切在半句中间）。
 */
export const firstSentence = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';

  const matched = /^[\s\S]{4,120}?[。！？]/.exec(trimmed);
  if (matched !== null && matched[0].length <= LEAD_MAX) return matched[0];

  if (trimmed.length <= LEAD_MAX) return trimmed;

  // 太长：优先在逗号/顿号处断开，读起来是完整的一口气
  const cut = trimmed.slice(0, LEAD_MAX);
  const lastPause = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf('、'));

  return lastPause >= 30 ? `${cut.slice(0, lastPause + 1)}…` : `${cut}…`;
};

/**
 * 解析编号建议
 *
 * 模板明确要求「五条用 `1.`–`5.` 编号，每条把三件事写在同一条里」，
 * 因此按行首序号切分是**有依据的**解析，不是猜。找不到两条以上就返回空数组
 * （调用方据此退回普通段落渲染）。
 */
const parseSuggestionCards = (content: string): SuggestionCard[] => {
  /**
   * ⚠ 这里必须匹配 `**1.**` 这种"加粗序号"写法：模型很爱把序号加粗，
   * 而只匹配裸 `1.` 会一条都切不出来（表现为建议段又变回一堵墙）。
   */
  const pattern = /^\s*(?:\*\*)?\s*([1-9])\s*[.、)]\s*(?:\*\*)?\s*/;
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  const cards: SuggestionCard[] = [];
  let buffer: string[] = [];
  let currentIndex: number | null = null;

  const flush = (): void => {
    if (currentIndex === null) return;

    const body = buffer.join('\n').trim();
    if (body.length === 0) return;

    const firstStop = body.indexOf('。');
    const headline = firstStop > 0 ? body.slice(0, firstStop + 1) : body;

    cards.push({
      index: currentIndex,
      title: headline.length > CARD_TITLE_MAX ? `${headline.slice(0, CARD_TITLE_MAX)}…` : headline,
      body,
    });
  };

  for (const line of lines) {
    const matched = pattern.exec(line);

    if (matched !== null) {
      flush();
      currentIndex = Number(matched[1]);
      buffer = [line.slice(matched[0].length).trim()];
      continue;
    }

    if (currentIndex !== null) buffer.push(line);
  }

  flush();

  // 少于两条说明不是"编号建议"（可能是普通分点叙述），交给通用段落渲染
  return cards.length >= 2 ? cards : [];
};

/**
 * 解析"第一周 / 第二周"两块（解析不出就返回空数组，退回普通段落）
 *
 * ⚠ 中文数字与阿拉伯数字都要认：模板写的是"第一周/第二周"，
 * 而模型偶尔写成"第 1 周"。只认一种时，另一种就解析不出来 ——
 * 表现为"两周行动"那一段的版式退化成普通段落（不会丢内容，但会变回一堵墙）。
 */
const parseActionWeeks = (content: string): ActionWeek[] => {
  const CHINESE_BY_DIGIT: Readonly<Record<string, string>> = { '1': '一', '2': '二', '3': '三' };
  const pattern = /第\s*([一二三1-3])\s*周/;

  const blocks = splitParagraphs(content)
    .map((paragraph) => {
      const matched = pattern.exec(paragraph);
      if (matched === null) return null;

      const raw = matched[1] ?? '';
      const chinese = CHINESE_BY_DIGIT[raw] ?? raw;

      return { label: `第${chinese}周`, text: paragraph };
    })
    .filter((block): block is ActionWeek => block !== null);

  // 至少要认出一周，否则说明这一段不是按周写的
  return blocks.length >= 1 ? blocks : [];
};

/**
 * 解析一段正文的版式
 *
 * @param sectionKey 段落键（只有建议段/行动段做特殊解析）
 * @param content    正文字符串（未解锁时为 `null`，调用方先判断）
 */
export const buildSectionLayout = (sectionKey: string, content: string): SectionLayout => {
  const paragraphs = splitParagraphs(content);
  const lead = paragraphs.length > 0 ? firstSentence(paragraphs[0]) : '';

  /**
   * 首句之外的**其余内容**包括：第一段里首句之后的部分 + 第 2..n 段。
   * 丢掉首句会造成"正文缺一句"（用户对照 AI 写的原文时会发现），因此必须保留。
   */
  const restOfFirst = paragraphs.length > 0 ? paragraphs[0].slice(lead.length).trim() : '';
  const bodyParagraphs = [restOfFirst, ...paragraphs.slice(1)].filter((text) => text.length > 0);

  const cards = sectionKey === SUGGESTIONS_SECTION_KEY ? parseSuggestionCards(content) : [];
  const weeks = sectionKey === ACTION_SECTION_KEY ? parseActionWeeks(content) : [];

  return {
    lead,
    /**
     * 建议段一旦成功拆成卡片，段落数组就不再参与渲染（否则同一段内容会被渲染两遍：
     * 一遍在卡片里、一遍在折叠正文里）。这里把它清空，让页面只有一个渲染入口。
     */
    paragraphs: cards.length > 0 ? [] : bodyParagraphs,
    cards,
    weeks,
    charCount: content.trim().length,
  };
};

/**
 * 首屏折叠时显示的字数上限
 *
 * 为什么要"折叠"而不是全展开：用户的原话是"累不累啊"。默认只读到每段的
 * **一句结论**（约 40–90 字），想深读再点开全文 —— 同一份报告因此有了
 * "3 秒扫完"和"慢慢细读"两种读法。
 */
export const COLLAPSED_HINT_LENGTH = 60;
