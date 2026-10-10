/**
 * Prompt 模板渲染（纯函数，无 I/O、可 100% 单测）
 *
 * 契约来源：docs/API_DESIGN.md §3.5（AI 报告）；ADR-014（Prompt 存数据库 + 版本化）。
 *
 * 占位符语法：`{{variableName}}`（允许 `{{ name }}` 带空格）
 *
 * 为什么刻意做成**无逻辑**模板（不支持 if/for/表达式）：
 *   · 模板由运营在后台编辑，一旦支持分支就等于让他们写程序 ——
 *     而这段"程序"没有类型检查、没有单测、没有代码评审
 *   · 分支与拼接逻辑应留在代码里（可测、可 review），模板只负责文案与结构
 *   · 变量缺失必须**立即失败**，而不是渲染出一个缺了半句话的 Prompt：
 *     那种 Prompt 会让模型产出看似合理的错误解读，且难以归因
 */

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';

/**
 * 占位符正则
 *
 * 每次调用**新建**实例，绝不复用模块级 `/g` 正则：带 `g` 标志的正则对象携带
 * 可变的 `lastIndex`，在 `replace`/`matchAll`/`test` 混用时会产生"第一次正常、
 * 第二次少匹配"这类间歇性问题。
 */
const placeholderPattern = (): RegExp => /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** 模板内容 */
export interface PromptTemplateContent {
  readonly systemPrompt: string;
  readonly userPromptTemplate: string;
}

/** 渲染结果 */
export interface RenderedPrompt {
  readonly system: string;
  readonly user: string;
  /** 实际被使用的变量名（去重排序，便于排查与统计） */
  readonly usedVariables: readonly string[];
}

/**
 * 提取模板中出现的全部变量名
 *
 * 这是**必需的**变量清单 —— 以占位符为准，而不是以 `PromptVersion.variables`
 * 里声明的清单为准。声明可能随文案修改而漂移，占位符不会：
 * 模板里写了 `{{mbtiType}}` 就必须有值，这无需任何人额外维护。
 */
export const extractPlaceholders = (template: string): string[] => {
  const found = new Set<string>();

  for (const match of template.matchAll(placeholderPattern())) {
    found.add(match[1]);
  }

  return [...found].sort();
};

/**
 * 渲染单个模板串
 *
 * 变量值一律按字符串处理：模板是文案，不做数值格式化（要格式化应由调用方
 * 在组装变量时完成）—— 这样渲染器不需要理解任何业务语义。
 */
export const renderTemplate = (
  template: string,
  variables: Readonly<Record<string, string>>,
): { text: string; used: string[] } => {
  const used: string[] = [];
  const missing = new Set<string>();

  const text = template.replace(placeholderPattern(), (_match, name: string) => {
    const value = variables[name];

    if (value === undefined) {
      missing.add(name);
      return '';
    }

    used.push(name);
    return value;
  });

  if (missing.size > 0) {
    throw new BusinessException(
      ErrorCode.AI_PROMPT_VARIABLE_MISSING,
      `模板缺少必需变量：${[...missing].sort().join(', ')}`,
    );
  }

  return { text, used };
};

/** 渲染整份 Prompt（system + user 两条消息） */
export const renderPromptVersion = (
  content: PromptTemplateContent,
  variables: Readonly<Record<string, string>>,
): RenderedPrompt => {
  const system = renderTemplate(content.systemPrompt, variables);
  const user = renderTemplate(content.userPromptTemplate, variables);

  return {
    system: system.text,
    user: user.text,
    usedVariables: [...new Set([...system.used, ...user.used])].sort(),
  };
};
