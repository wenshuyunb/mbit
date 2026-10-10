/**
 * 从后端源码生成权威错误码文档
 *
 * 背景：错误码同时出现在三处（后端实现、API 设计文档、前端常量），手工维护必然漂移。
 *       本脚本以 `backend/src/common/errors/error-code.ts` 为唯一事实源生成
 *       `docs/ERROR_CODES.md`，API 文档只引用该文件，不再手工维护表格。
 *
 * 运行：node scripts/generate-error-code-doc.mjs
 *      node scripts/generate-error-code-doc.mjs --check   # 仅校验，不写文件（CI 用）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const sourceFile = join(repoRoot, 'backend', 'src', 'common', 'errors', 'error-code.ts');
const targetFile = join(repoRoot, 'docs', 'ERROR_CODES.md');
const checkOnly = process.argv.includes('--check');

if (!existsSync(sourceFile)) {
  console.error(`缺少后端错误码文件: ${sourceFile}`);
  process.exit(1);
}

const source = readFileSync(sourceFile, 'utf8');

/** 提取 `ErrorCode` 常量对象：NAME: number */
const extractCodeNames = () => {
  const block = source.match(/export const ErrorCode = \{([\s\S]*?)\} as const;/);
  if (!block) throw new Error('未找到 ErrorCode 定义');

  const entries = [];
  for (const line of block[1].split(/\r?\n/)) {
    const cleaned = line.replace(/\/\/.*$/, '').trim();
    const match = cleaned.match(/^([A-Z0-9_]+)\s*:\s*(\d+),?$/);
    if (match) entries.push({ name: match[1], code: Number(match[2]) });
  }
  return entries;
};

/** 提取 `ERROR_HTTP_STATUS`：number -> number */
const extractHttpStatus = () => {
  const block = source.match(/export const ERROR_HTTP_STATUS[^=]*= \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('未找到 ERROR_HTTP_STATUS 定义');

  const map = new Map();
  for (const line of block[1].split(/\r?\n/)) {
    const cleaned = line.replace(/\/\/.*$/, '').trim();
    const match = cleaned.match(/^(\d+)\s*:\s*(\d+),?$/);
    if (match) map.set(Number(match[1]), Number(match[2]));
  }
  return map;
};

/** 提取 `ERROR_MESSAGE`：number -> '中文文案' */
const extractMessage = () => {
  const block = source.match(/export const ERROR_MESSAGE[^=]*= \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('未找到 ERROR_MESSAGE 定义');

  const map = new Map();
  for (const line of block[1].split(/\r?\n/)) {
    const cleaned = line.trim();
    // 兼容 `10000: '文案',` 与 `[ErrorCode.UNKNOWN]: '文案',` 两种写法
    const direct = cleaned.match(/^(\d+)\s*:\s*'((?:[^'\\]|\\.)*)',?$/);
    if (direct) {
      map.set(Number(direct[1]), direct[2].replace(/\\'/g, "'"));
      continue;
    }
    const named = cleaned.match(/^\[ErrorCode\.([A-Z0-9_]+)\]\s*:\s*'((?:[^'\\]|\\.)*)',?$/);
    if (named) {
      map.set(named[1], named[2].replace(/\\'/g, "'"));
    }
  }
  return map;
};

const codeNames = extractCodeNames();
const httpStatus = extractHttpStatus();
const rawMessages = extractMessage();

/** 错误码 → 中文文案（ERROR_MESSAGE 支持用 [ErrorCode.X] 引用） */
const messageOf = (code, name) => rawMessages.get(code) ?? rawMessages.get(name) ?? '';

/** 分段定义（与架构文档 §6.2 的 AABBB 规则一致） */
const SEGMENTS = [
  { id: 0, title: '成功', range: '0' },
  { id: 10, title: '通用 / 参数校验', range: '10000–10999' },
  { id: 20, title: '认证与鉴权', range: '20000–20999' },
  { id: 30, title: '用户与隐私', range: '30000–30999' },
  { id: 40, title: '测试与人格', range: '40000–40999' },
  { id: 50, title: 'AI / 报告', range: '50000–50999' },
  { id: 60, title: '关系与匹配', range: '60000–60999' },
  { id: 70, title: '支付与会员', range: '70000–70999' },
  { id: 80, title: '存储与文件', range: '80000–80999' },
  { id: 90, title: '系统与第三方', range: '90000–90999' },
];

const escapeCell = (text) => String(text).replace(/\|/g, '\\|');

const grouped = new Map();
for (const entry of codeNames) {
  const segment = entry.code === 0 ? 0 : Math.floor(entry.code / 1000);
  if (!grouped.has(segment)) grouped.set(segment, []);
  grouped.get(segment).push(entry);
}

const lines = [];

lines.push('# SoulMap AI 错误码总表（自动生成）');
lines.push('');
lines.push('> ⚠ **本文件由 `scripts/generate-error-code-doc.mjs` 自动生成，请勿手工编辑。**');
lines.push('>');
lines.push('> 唯一事实源：`backend/src/common/errors/error-code.ts`。');
lines.push('> 修改错误码请改源码，然后执行 `node scripts/generate-error-code-doc.mjs` 重新生成。');
lines.push('> CI 会用 `--check` 模式校验本文件与源码是否同步。');
lines.push('');
lines.push('编码规则：`AABBB` = 模块（2 位）+ 序号（3 位），见 `PROJECT_ARCHITECTURE.md` §6.2。');
lines.push('');
lines.push(`本次生成基于 ${codeNames.length} 个错误码定义。`);
lines.push('');

// 汇总表
lines.push('## 0. 分段汇总');
lines.push('');
lines.push('| 段 | 模块 | 区间 | 错误码数量 |');
lines.push('|---|---|---|---|');
for (const segment of SEGMENTS) {
  const items = grouped.get(segment.id) ?? [];
  if (items.length === 0) continue;
  lines.push(`| ${segment.id} | ${segment.title} | ${segment.range} | ${items.length} |`);
}
lines.push(`| — | **合计** | — | **${codeNames.length}** |`);
lines.push('');

// 明细表
let sectionIndex = 1;
for (const segment of SEGMENTS) {
  const items = grouped.get(segment.id) ?? [];
  if (items.length === 0) continue;

  items.sort((a, b) => a.code - b.code);

  lines.push(`## ${sectionIndex}. ${segment.title}（${segment.range}）`);
  lines.push('');
  lines.push('| 常量名 | 错误码 | HTTP | 用户可见文案 |');
  lines.push('|---|---|---|---|');
  for (const item of items) {
    const status = httpStatus.get(item.code) ?? '—';
    const message = messageOf(item.code, item.name);
    lines.push(`| \`${item.name}\` | ${item.code} | ${status} | ${escapeCell(message)} |`);
  }
  lines.push('');
  sectionIndex += 1;
}

// 前端同步提示
const frontendConstants = [
  { path: 'frontend/miniapp/src/api/types.ts', name: 'ERROR_CODES（小程序端子集）' },
  { path: 'frontend/admin/src/constants/error-code.ts', name: 'ErrorCode（管理后台子集）' },
];

lines.push('## 前端同步');
lines.push('');
lines.push('前端只需声明「会做分支处理」的错误码子集，不要求全量镜像。已存在的子集：');
lines.push('');
lines.push('| 文件 | 说明 |');
lines.push('|---|---|');
for (const item of frontendConstants) {
  lines.push(`| \`${item.path}\` | ${item.name} |`);
}
lines.push('');
lines.push('新增前端分支处理时，必须从本表取值，禁止在业务代码里写裸数字。');
lines.push('');

const output = `${lines.join('\n')}\n`;

if (checkOnly) {
  const current = existsSync(targetFile) ? readFileSync(targetFile, 'utf8') : '';
  if (current === output) {
    console.log('错误码文档与源码一致');
    process.exit(0);
  }
  console.error('错误码文档与后端源码不一致，请执行: node scripts/generate-error-code-doc.mjs');
  process.exit(1);
}

writeFileSync(targetFile, output, 'utf8');

console.log('错误码文档已生成');
console.log(`  来源: ${sourceFile}`);
console.log(`  目标: ${targetFile}`);
console.log(`  错误码: ${codeNames.length}`);
console.log(`  分段: ${[...grouped.keys()].sort((a, b) => a - b).join(', ')}`);

const missingStatus = codeNames.filter((item) => item.code !== 0 && !httpStatus.has(item.code));
const missingMessage = codeNames.filter((item) => !messageOf(item.code, item.name));
if (missingStatus.length > 0) {
  console.warn(`  ⚠ 缺少 HTTP 状态码映射: ${missingStatus.map((item) => item.name).join(', ')}`);
}
if (missingMessage.length > 0) {
  console.warn(`  ⚠ 缺少中文文案: ${missingMessage.map((item) => item.name).join(', ')}`);
}
