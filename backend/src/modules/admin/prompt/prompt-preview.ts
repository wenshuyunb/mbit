/**
 * Prompt 后台预览与静态检查（纯函数，无 I/O、可 100% 单测）
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.5.4（变量校验 / 注入防护 / 边界规则）
 *           与 §3.14.5.7（`test-render` 变量渲染预览）
 *
 * ## 为什么后台需要自己实现一遍渲染，而不是复用 `ai/prompt/prompt-renderer.ts`
 *
 * 两者服务于**不同目的**，故意不共享实现：
 *   · 运行期渲染器（`prompt-renderer.ts`）刻意**不支持任何逻辑**，只做 `{{var}}` 替换，
 *     变量缺失即抛错 —— 线上宁可失败也不产出「缺了半句话」的 Prompt；
 *   · 后台预览（本文件）必须**支持 `{{#if var}}...{{/if}}`**（契约 §3.14.5.4 明确要求模板
 *     语法含条件块），且在 `strictValidation=false` 时把缺失变量渲染为空串，
 *     以便运营在变量还没凑齐时先看排版。
 *
 * ⚠ **这是一处必须向使用方说明的差异**：当前运行期渲染器并不识别 `{{#if}}`，
 *   含条件块的模板在真实调用时会把 `{{#if x}}` / `{{/if}}` 原样带进提示词。
 *   因此 `test-render` 的响应里会显式给出 `conditionalBlocks` 的渲染结果，
 *   让运营在发布前就能看出「这段条件在线上不会生效」。
 */

/** 单个变量值（请求体 `variables` 的取值形态：JSON 允许任意类型，模板渲染一律按文本处理） */
export type PreviewVariableValue = unknown;

/** 变量表 */
export type PreviewVariables = Readonly<Record<string, PreviewVariableValue>>;

/** 变量声明（JSON Schema 的 `properties` / `required`） */
export interface DeclaredVariables {
  /** 变量名 → 声明的 JSON 类型（`type` 缺失时为 `unknown`） */
  readonly properties: ReadonlyMap<string, string>;
  /** 必填变量名 */
  readonly required: readonly string[];
}

/** 条件块渲染结果（契约 `validation.conditionalBlocks`） */
export interface ConditionalBlockResult {
  variable: string;
  rendered: boolean;
  reason?: string;
}

/** 渲染结果 */
export interface PreviewRenderResult {
  system: string;
  user: string;
  /** 实际参与替换的变量（含求值为真、真正生效的条件变量） */
  usedVariables: string[];
  conditionalBlocks: ConditionalBlockResult[];
}

/** 注入防护检查结果 */
export interface InjectionGuardInspection {
  delimitersPresent: boolean;
  delimiterPairs: string[];
  instructionGuardPresent: boolean;
  guardText: string | null;
}

/** 边界规则检查结果 */
export interface BoundaryRulesInspection {
  present: boolean;
  detail: string | null;
}

// ============================================================================
// 模板解析
// ============================================================================

/** `{{var}}` / `{{ var }}` */
const placeholderPattern = (): RegExp => /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** `{{#if var}} ... {{/if}}`（单层；不支持嵌套，见 `CONDITIONAL_LIMITATION`） */
const conditionalPattern = (): RegExp => /\{\{#if\s+([A-Za-z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

/** 嵌套条件块的已知限制说明（会出现在 `validation.warning` 中） */
export const CONDITIONAL_LIMITATION =
  '条件块仅支持单层 `{{#if x}}...{{/if}}`；嵌套条件块按最外层处理，请拆成两段或改用代码分支';

/** 是否为「普通对象」 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 解析 `variables`（JSON Schema）
 *
 * 契约要求该字段是 `type: object` 的 JSON Schema。这里对**不合法/缺失**的声明不做抛错，
 * 而是返回空声明 —— 判定「能不能发布」是调用方的职责（见 `AdminPromptService`），
 * 纯函数只管解析，这样它才能被 100% 单测覆盖。
 */
export const parseDeclaredVariables = (schema: unknown): DeclaredVariables => {
  const properties = new Map<string, string>();

  if (!isRecord(schema)) return { properties, required: [] };

  const rawProperties = schema['properties'];

  if (isRecord(rawProperties)) {
    for (const [name, definition] of Object.entries(rawProperties)) {
      const type = isRecord(definition) && typeof definition['type'] === 'string' ? definition['type'] : 'unknown';
      properties.set(name, type);
    }
  }

  const rawRequired = schema['required'];
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((item): item is string => typeof item === 'string')
    : [];

  return { properties, required };
};

/**
 * 提取模板中**全部**变量引用
 *
 * 包含两类：普通占位符 `{{var}}` 与条件变量 `{{#if var}}`。
 * 条件块**内部**的占位符同样计入 —— 分支一旦渲染，它们就需要有值，
 * 漏计会让「使用了未声明的变量」在发布后才暴露。
 */
export const extractVariableReferences = (...templates: readonly string[]): string[] => {
  const found = new Set<string>();

  for (const template of templates) {
    for (const match of template.matchAll(placeholderPattern())) found.add(match[1]);
    for (const match of template.matchAll(conditionalPattern())) found.add(match[1]);
  }

  return [...found].sort();
};

// ============================================================================
// 渲染
// ============================================================================

/** 变量值 → 文本（模板是文案，不做格式化；对象按 JSON 呈现便于排查） */
const stringify = (value: PreviewVariableValue): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
};

/** 变量是否视为「有值」（空串与 null/undefined 视为无值，与运行期渲染器的判据一致） */
const hasValue = (value: PreviewVariableValue): boolean => value !== undefined && value !== null && value !== '';

/**
 * 渲染一份 Prompt（**纯预览**：不调用 LLM、不写库）
 *
 * 处理顺序必须是「先条件块、后占位符」：反过来的话，条件块内的占位符会先被替换成空串，
 * 于是「未提供的变量」与「被跳过的条件块」在输出里无法区分，运营也看不出条件块是否生效。
 */
export const renderPromptPreview = (
  content: { systemPrompt: string; userPromptTemplate: string },
  variables: PreviewVariables,
): PreviewRenderResult => {
  const conditionalBlocks: ConditionalBlockResult[] = [];
  const used = new Set<string>();

  const renderOne = (template: string): string => {
    // 第一步：条件块
    const withoutConditionals = template.replace(conditionalPattern(), (_match, name: string, body: string) => {
      const value = variables[name];
      const rendered = hasValue(value);

      if (!rendered) {
        conditionalBlocks.push({ variable: name, rendered: false, reason: '未提供该变量，条件块被跳过' });
        return '';
      }

      conditionalBlocks.push({ variable: name, rendered: true });
      used.add(name);
      return body;
    });

    // 第二步：占位符（未提供 → 空串；strictValidation 的拦截在 Service 层）
    return withoutConditionals.replace(placeholderPattern(), (_match, name: string) => {
      used.add(name);
      return stringify(variables[name]);
    });
  };

  const system = renderOne(content.systemPrompt);
  const user = renderOne(content.userPromptTemplate);

  return { system, user, usedVariables: [...used].sort(), conditionalBlocks };
};

// ============================================================================
// 静态检查（注入防护 / 边界规则）
// ============================================================================

/** 定界符标签（形如 `<user_data>`，架构 10.3 要求用户自由文本被包裹其中） */
const delimiterTagPattern = (): RegExp => /<\/?([a-z][a-z0-9_]*)>/g;

/**
 * 注入防护检查（契约 §3.14.5.4 业务规则 2）
 *
 * 判据刻意做成**启发式**并如实返回：运营看到的应该是「检测到什么」，
 * 而不是一个无法追溯的布尔值 —— 所以同时返回命中的定界符对与约束原句。
 */
export const inspectInjectionGuard = (text: string): InjectionGuardInspection => {
  const opened = new Set<string>();
  const closed = new Set<string>();

  for (const match of text.matchAll(delimiterTagPattern())) {
    const [tag, name] = [match[0], match[1]];
    if (tag.startsWith('</')) closed.add(name);
    else opened.add(name);
  }

  const delimiterPairs = [...opened].filter((name) => closed.has(name)).map((name) => `<${name}> 与 </${name}>`);

  // 「数据而非指令」类约束的常见表述（中英文都覆盖，运营可能用英文写）
  const guardMatch =
    /([^\n。；;]*(?:不是指令|视为数据|作为数据|数据而非指令|忽略[^\n。；;]*指令|not\s+instructions?)[^\n。；;]*)/i.exec(
      text,
    );

  return {
    delimitersPresent: delimiterPairs.length > 0,
    delimiterPairs,
    instructionGuardPresent: guardMatch !== null,
    guardText: guardMatch === null ? null : guardMatch[1].trim(),
  };
};

/** 禁止性表述（「不做…」比单纯出现「诊断」二字更有意义） */
const NEGATION_PATTERN = /(不[做得出提供给予要会]|禁止|严禁|不得|绝不|切勿|avoid|do\s+not|don't|never)/i;

/** 合规敏感词（架构 §1.2：不得诊断、不得给药、不得做危机干预） */
const SENSITIVE_TERMS = ['诊断', '用药', '危机干预', '治疗', '病理性', '症状'] as const;

/**
 * 边界规则检查（契约 §3.14.5.4 业务规则 3）
 *
 * 只有「出现了敏感词」且「同一句里出现了否定表述」才算命中 ——
 * 单纯统计敏感词会把「不得进行诊断」这类正确写法判成风险，比不检查更糟。
 */
export const inspectBoundaryRules = (text: string): BoundaryRulesInspection => {
  for (const line of text.split(/\n|。|；|;/)) {
    if (!NEGATION_PATTERN.test(line)) continue;

    const term = SENSITIVE_TERMS.find((item) => line.includes(item));

    if (term !== undefined) {
      return { present: true, detail: `检测到禁止性边界声明：${line.trim().slice(0, 120)}` };
    }
  }

  return { present: false, detail: null };
};

// ============================================================================
// Token 估算
// ============================================================================

/**
 * 粗略估算 token 数
 *
 * 中文一字约 1 token，英文/符号约 4 字符 1 token（业界通用近似）。
 * 之所以不引入 tokenizer：它要么带巨大词表，要么依赖远端接口，
 * 而后台这个数字只用于「心里有数」（是否可能超出上下文/预算），不是计费依据。
 */
export const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0;

  let cjk = 0;
  let other = 0;

  for (const char of text) {
    // CJK 统一表意文字 + 中文标点区间
    if (/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)) cjk += 1;
    else other += 1;
  }

  return cjk + Math.ceil(other / 4);
};
