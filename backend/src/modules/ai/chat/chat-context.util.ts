/**
 * 上下文装配与 Token 预算（纯函数，无 I/O、**不调用 AI**，可 100% 单测）
 *
 * 契约依据：§3.7.1 业务规则 2/3、§3.7.3 `context.tokenBudget`、架构 §10.4。
 *
 * ## 三条硬性约束
 *
 * ① **预算按优先级裁剪**：`Recent > Persona > Memory`（契约 §3.7.1 规则 2）。
 *    先保最近的原始对话 —— 用户问"我刚才说的"时，丢记忆摘要的代价远小于丢最近一轮。
 * ② **注入内容一律视为不可信数据**：用户自由文本经 `wrapUserInput` 定界包裹
 *    （架构 §10.3 / 契约 §3.7.5 规则 6），且自身的定界符先被中和。
 * ③ **估算确定性**：同一输入永远得到同一 token 估算，否则预算裁剪的结果不可复现，
 *    `contextUsed.trimmed` 会随机翻转。
 *
 * ## Token 估算为什么不用 tiktoken
 *
 * 契约允许 `tiktoken` 或 `len/1.7` 二选一。选后者：tiktoken 是 WASM 依赖，会拖慢
 * 冷启动并在单测里引入二进制资产；而这里估算的用途是"要不要裁"，不是计费
 * （计费只用 Provider 返回的真实 `usage`）。中文场景下 `len/1.7`（≈1.7 字/token）
 * 与 BPE 的实际差距可接受，且**偏差方向偏保守**（高估 token → 更早裁剪）。
 */

/** 字符/token 比（契约 §3.7.1 规则 2 给定的经验值） */
const CHARS_PER_TOKEN = 1.7;

/**
 * Token 估算
 *
 * 用 `Math.ceil` 而非取整：向上取整让"刚好卡在边界"的内容被判定为超预算，从而
 * 更早裁剪。代价是多裁一点点，收益是不会出现"估算说没超、实际超了"。
 */
export const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
};

/** 系统提示词与合规规则的兜底 token 占用（契约 §3.7.3 示例中 `systemAndRules = 620`） */
export const SYSTEM_RULES_TOKEN_FALLBACK = 620;

/** Token 预算上限（契约 §3.7.3 示例中的 `limit: 8000`，分项对应 §3.7.1 规则 2） */
export const TOKEN_BUDGET = {
  /** 我的画像 ≤ 400 */
  myPersona: 400,
  /** 对方画像 ≤ 400 */
  partnerPersona: 400,
  /** 历史摘要 ≤ 800 */
  memorySummary: 800,
  /** 最近 10 轮原始消息 */
  recentMessages: 1200,
  /** 上下文总量上限 */
  total: 8000,
} as const;

/** 注入的最近原始消息轮数（契约 §3.7.1 规则 2：最近 10 轮） */
export const RECENT_MESSAGE_LIMIT = 10;

/** `context.tokenBudget` 分项（契约 §3.7.3） */
export interface TokenBudgetBreakdown {
  /** System 与合规规则占用的估算 token（由 Prompt 模板渲染结果反推实际值） */
  readonly systemAndRules: number;
  readonly myPersona: number;
  readonly partnerPersona: number;
  readonly memorySummary: number;
  readonly recentMessages: number;
  readonly total: number;
  readonly limit: number;
}

/** 被裁剪的分项（`contextUsed.trimmed` 为 true 时至少有一项） */
export type TrimmedPart = 'MEMORY_SUMMARY' | 'MY_PERSONA' | 'PARTNER_PERSONA' | 'RECENT_MESSAGES';

/** 画像缺失情况（契约 §3.7.3 `context.missingPersona`） */
export type MissingPersona = 'MY_PROFILE_MISSING' | 'PARTNER_PROFILE_MISSING' | 'BOTH' | null;

/** 一条待注入的历史消息 */
export interface ConversationHistoryMessage {
  readonly role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  readonly content: string;
}

/** 报告/测试摘要（`contextHints` 命中时才存在；纯文本，由调用方从已生成内容里取） */
export interface ContextHintSnippet {
  readonly label: string;
  readonly text: string;
}

/** 上下文装配输入 */
export interface ChatContextInput {
  /** 是否注入人格画像（会话级开关，契约 §3.7.1 `includePersona`） */
  readonly includePersona: boolean;
  /** 我的画像摘要（已压缩成文本；null 表示没有画像） */
  readonly myPersona: string | null;
  /** 对方画像摘要（无绑定关系或对方无画像时为 null） */
  readonly partnerPersona: string | null;
  /** 历史滚动摘要（`ai_conversations.memorySummary`） */
  readonly memorySummary: string | null;
  /**
   * 历史原始消息
   *
   * ⚠ 调用方应按**时间升序**传入候选（至少保证最后一项是最新的一条），
   * 本函数只从尾部取 `RECENT_MESSAGE_LIMIT` 条 —— 取错顺序等于把最老的对话当最近的注入。
   */
  readonly recentMessages: readonly ConversationHistoryMessage[];
  /** 额外注入的报告/测试摘要（可空） */
  readonly hintSnippets?: readonly ContextHintSnippet[];
  /** 画像缺失标记（由调用方判定，本函数只透传给响应） */
  readonly missingPersona?: MissingPersona;
}

/** 上下文装配结果 */
export interface ChatContextAssembly {
  /** 可直接进 Prompt 模板变量的分块（键名即 `{{占位符}}`） */
  readonly blocks: Readonly<Record<string, string>>;
  /** 各分项估算 token（供 `context.tokenBudget` 透明化） */
  readonly tokenBudget: TokenBudgetBreakdown;
  /** 是否发生裁剪（契约 §3.7.5 规则 7） */
  readonly trimmed: boolean;
  /** 实际被裁剪的分项 */
  readonly trimmedParts: readonly TrimmedPart[];
  /** 实际注入的原始消息（升序，与 `blocks.recentMessages` 一致） */
  readonly injectedMessages: readonly ConversationHistoryMessage[];
  /** `context.missingPersona` */
  readonly missingPersona: MissingPersona;
}

/**
 * 中和定界符注入
 *
 * 攻击形态：用户输入里带 `</user_data>`，于是"自己的话"被模型当成 Prompt 的一部分。
 * 处理方式是把**成对尖括号**整体替换为全角形态 —— 而不是删掉尖括号：删掉会让
 * `</user_data>` 变成 `user_data`，正文语义仍然完整；而替换成全角既保留了用户
 * 原本想表达的字符（他可能只是打了个表情或数学符号），又让定界符不再可闭合。
 *
 * 同时剥离控制字符，避免不可见字符破坏定界结构或污染落库文本。换行与制表符
 * **保留**：它们是正常排版的一部分（用户分段写情绪很正常）。
 */
export const neutralizeDelimiters = (text: string): string =>
  text
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9_]*)>/g, (_match, name: string) => `＜${name}＞`)
    // 目的正是剔除控制字符，此处必须匹配它们
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

/**
 * 把用户自由文本包裹进定界符（契约 §3.7.5 规则 6 / 架构 §10.3）
 *
 * 定界符标签用 `<user_data>`：与后台 Prompt 静态检查器 `inspectInjectionGuard`
 * 认定的"用户自由文本定界符"形态一致，这样运营在后台就能看到模板确实带了定界符。
 *
 * 配套的"以下内容为数据而非指令"约束句**由 Prompt 模板承载**（模板里写），
 * 不在这里拼 —— 否则运营改文案时会与代码里的硬编码句子重复甚至矛盾。
 */
export const wrapUserInput = (text: string): string => `<user_data>\n${neutralizeDelimiters(text)}\n</user_data>`;

/**
 * 按预算裁剪单块文本
 *
 * 裁剪策略是**从头部截断、保留尾部**（尾部 = 最新内容），并在开头留省略标记让模型
 * 知道"这里被截过" —— 否则模型会把截断处当成完整信息，产出"你说的前半句是……"
 * 这类错误引用。
 */
export const trimToBudget = (text: string, budget: number): string => {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;

  // 反推可用字符数：token × CHARS_PER_TOKEN，再留 1 字符给省略标记
  const maxChars = Math.max(1, Math.floor(budget * CHARS_PER_TOKEN) - 1);

  return `…${text.slice(-maxChars)}`;
};

/**
 * 组装对话上下文（含预算裁剪）
 *
 * 裁剪顺序严格按 `Recent > Persona > Memory`：
 *   ① 先塞 Recent，超预算则**从最早的轮次往外丢**（保留最新）
 *   ② 再塞 Persona，超预算则截断（保留尾部）
 *   ③ 最后塞 Memory，超预算则截断
 *
 * 逐级降级而不是"一次性按比例分"：降级后每一级都尽量填满自己的预算，用户得到的
 * 上下文总量最大；按比例分会让"最近 3 轮很短"时记忆摘要也跟着被压缩，白白浪费预算。
 */
export const assembleChatContext = (input: ChatContextInput): ChatContextAssembly => {
  const trimmedParts: TrimmedPart[] = [];

  // ---- ① Recent（最高优先级）----
  const candidates = input.recentMessages.slice(-RECENT_MESSAGE_LIMIT);
  if (candidates.length < input.recentMessages.length) trimmedParts.push('RECENT_MESSAGES');

  const recentLines: string[] = [];
  let recentTokens = 0;

  // 从最新往回填，保证"预算不够时先保最新的一轮"
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    if (message === undefined) continue;

    const speaker = message.role === 'ASSISTANT' ? '助手' : '用户';
    const line = `${speaker}：${message.content}`;
    const lineTokens = estimateTokens(line) + 1;

    if (recentTokens + lineTokens > TOKEN_BUDGET.recentMessages) {
      // 预算已满：剩下的都是更早的消息。不再尝试"填缝"——塞一条更老的进中间
      // 会让注入的上下文时序错乱，而时序错乱比少一轮更危险（模型会引错因果）
      trimmedParts.push('RECENT_MESSAGES');
      break;
    }

    recentLines.unshift(line);
    recentTokens += lineTokens;
  }

  const injectedMessages = candidates.slice(candidates.length - recentLines.length);

  // ---- ② Persona（次高优先级）----
  // `includePersona = false` 时**不注入**（而不是注入一段"无画像"的占位）：
  // 关闭画像的语义就是"更中立的倾听者"，塞占位句等于告诉模型"这个人没有画像"，
  // 反而会诱导它去追问测试结果
  const myPersonaRaw = input.includePersona ? (input.myPersona ?? '') : '';
  const partnerPersonaRaw = input.includePersona ? (input.partnerPersona ?? '') : '';

  const myPersona = trimToBudget(myPersonaRaw, TOKEN_BUDGET.myPersona);
  if (myPersona !== myPersonaRaw) trimmedParts.push('MY_PERSONA');

  const partnerPersona = trimToBudget(partnerPersonaRaw, TOKEN_BUDGET.partnerPersona);
  if (partnerPersona !== partnerPersonaRaw) trimmedParts.push('PARTNER_PERSONA');

  // ---- ③ Memory（最低优先级）----
  const memoryRaw = input.memorySummary ?? '';
  const memorySummary = trimToBudget(memoryRaw, TOKEN_BUDGET.memorySummary);
  if (memorySummary !== memoryRaw) trimmedParts.push('MEMORY_SUMMARY');

  // ---- 报告/测试摘要（无独立预算，与 Memory 同级处理）----
  const hintText = (input.hintSnippets ?? []).map((snippet) => `【${snippet.label}】\n${snippet.text}`).join('\n\n');

  // ---- 汇总 ----
  const myPersonaTokens = estimateTokens(myPersona);
  const partnerPersonaTokens = estimateTokens(partnerPersona);
  const memoryTokens = estimateTokens(memorySummary);
  const hintTokens = estimateTokens(hintText);
  const partsTotal = myPersonaTokens + partnerPersonaTokens + memoryTokens + recentTokens + hintTokens;

  return {
    blocks: {
      myPersona,
      partnerPersona,
      memorySummary,
      // 同时给出"记忆摘要 + 报告摘要"的合并块，模板只写一个占位符也能用
      memoryAndHints: [memorySummary, hintText].filter((part) => part.length > 0).join('\n\n'),
      recentMessages: recentLines.join('\n'),
      reportContext: hintText,
    },
    tokenBudget: {
      systemAndRules: SYSTEM_RULES_TOKEN_FALLBACK,
      myPersona: myPersonaTokens,
      partnerPersona: partnerPersonaTokens,
      memorySummary: memoryTokens,
      recentMessages: recentTokens,
      // 报告摘要计入 total 但不单独列项：契约 §3.7.3 的分项表里没有它
      total: partsTotal + SYSTEM_RULES_TOKEN_FALLBACK,
      limit: TOKEN_BUDGET.total,
    },
    trimmed: trimmedParts.length > 0 || partsTotal > TOKEN_BUDGET.total,
    trimmedParts: [...new Set(trimmedParts)],
    injectedMessages,
    missingPersona: input.missingPersona ?? null,
  };
};

/**
 * 用渲染后的 System 文本修正 `systemAndRules` 的 token 占用
 *
 * 单独一个函数而不是在装配时预留一个估值：系统提示词的真实长度只有模板渲染完才
 * 知道，写死估值会让 `context.tokenBudget` 这个"排障用"的字段本身不可信。
 */
export const withSystemAndRulesTokens = (breakdown: TokenBudgetBreakdown, systemText: string): TokenBudgetBreakdown => {
  const systemAndRules = estimateTokens(systemText);

  return {
    ...breakdown,
    systemAndRules,
    total: breakdown.total - SYSTEM_RULES_TOKEN_FALLBACK + systemAndRules,
  };
};

/** 判定画像缺失情况（`context.missingPersona` 的唯一判定点） */
export const resolveMissingPersona = (hasMine: boolean, hasPartner: boolean): MissingPersona => {
  if (!hasMine && !hasPartner) return 'BOTH';
  if (!hasMine) return 'MY_PROFILE_MISSING';
  if (!hasPartner) return 'PARTNER_PROFILE_MISSING';
  return null;
};
