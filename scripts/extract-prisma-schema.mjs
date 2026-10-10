/**
 * 从数据库设计文档中抽取 Prisma schema 并落地为 backend/prisma/schema.prisma
 *
 * 背景：docs/DATABASE_DESIGN.md 是全项目数据模型的唯一权威来源，
 *       其第 6 章包含完整的 Prisma 模型定义（分 6.1 / 6.2 两段）。
 *       本脚本把文档中的定义抽取为可执行文件，保证「文档即代码」，避免两份内容漂移。
 *
 * 运行：node scripts/extract-prisma-schema.mjs
 * 校验：node scripts/extract-prisma-schema.mjs --check
 *       （只比对不写入；不一致时以非零码退出，供 CI 使用）
 *
 * `--check` 是**必需**的，不是锦上添花：`schema.prisma` 是 `DATABASE_DESIGN.md`
 * 的生成物，而开发者常常直接改 schema（因为 Prisma 工具链只认它）。
 * 没有这个校验，文档与代码会静默漂移 —— 等到下一次重新生成时，
 * 手改的内容会被无声地覆盖掉。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkOnly = process.argv.includes('--check');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const sourceDoc = join(repoRoot, 'docs', 'DATABASE_DESIGN.md');
const targetSchema = join(repoRoot, 'backend', 'prisma', 'schema.prisma');

if (!existsSync(sourceDoc)) {
  console.error(`缺少设计文档: ${sourceDoc}`);
  process.exit(1);
}

const doc = readFileSync(sourceDoc, 'utf8');
const lines = doc.split(/\r?\n/);

/** 收集所有 ```prisma 代码块的内容 */
const prismaBlocks = [];
let insidePrisma = false;
let buffer = [];

for (const line of lines) {
  const trimmed = line.trim();

  if (!insidePrisma && trimmed === '```prisma') {
    insidePrisma = true;
    buffer = [];
    continue;
  }

  if (insidePrisma && trimmed === '```') {
    insidePrisma = false;
    prismaBlocks.push(buffer.join('\n'));
    continue;
  }

  if (insidePrisma) {
    buffer.push(line);
  }
}

if (prismaBlocks.length === 0) {
  console.error('未在文档中找到 ```prisma 代码块，请检查文档结构。');
  process.exit(1);
}

// 第 1 段包含 generator + datasource + 枚举 + 前半模型；第 2 段为后半模型。
// 若文档后续拆分方式变化，这里按「含 generator 的段优先」排序，保证文件开头合法。
const generatorIndex = prismaBlocks.findIndex((block) => block.includes('generator client'));
if (generatorIndex === -1) {
  console.error('未找到包含 generator client 的 Prisma 代码块。');
  process.exit(1);
}

const ordered = [prismaBlocks[generatorIndex], ...prismaBlocks.filter((_, index) => index !== generatorIndex)];

const header = `// ============================================================================
// SoulMap AI — Prisma Schema
// ----------------------------------------------------------------------------
// ⚠ 本文件由 scripts/extract-prisma-schema.mjs 从 docs/DATABASE_DESIGN.md 自动生成。
//    请勿手工修改：所有模型变更必须先更新设计文档，再重新生成并执行迁移。
//
// 生成命令： node scripts/extract-prisma-schema.mjs
// 校验命令： node backend/node_modules/prisma/build/index.js validate --schema backend/prisma/schema.prisma
//
// 通用约定（见 PROJECT_ARCHITECTURE.md §8.3）：
//   · 主键 uuid(7) —— 时间有序、索引友好、不暴露业务规模
//   · 时间戳统一 @db.Timestamptz(3)，UTC 存储
//   · 金额统一 Int，单位「分」，字段名以 Amount 结尾
//   · 物理表名/列名统一 snake_case（@@map / @map），表名复数
//   · 敏感字段以 Enc 结尾，AES-256-GCM 加密后存储
//   · personality_profiles.version 是画像版本号，非乐观锁（ADR-018）
// ============================================================================

`;

const body = ordered.map((block) => block.replace(/^\s*\n/, '').trimEnd()).join('\n\n');
const generated = `${header}${body}\n`;

const modelCount = (body.match(/^model\s+\w+/gm) ?? []).length;
const enumCount = (body.match(/^enum\s+\w+/gm) ?? []).length;

if (checkOnly) {
  if (!existsSync(targetSchema)) {
    console.error(`缺少生成物: ${targetSchema}`);
    console.error('请运行： node scripts/extract-prisma-schema.mjs');
    process.exit(1);
  }

  const current = readFileSync(targetSchema, 'utf8');

  if (current !== generated) {
    const currentLines = current.split('\n');
    const generatedLines = generated.split('\n');
    const firstDiff = currentLines.findIndex((line, index) => line !== generatedLines[index]);

    console.error('❌ schema.prisma 与 docs/DATABASE_DESIGN.md 不一致');
    console.error(`   首个差异在第 ${firstDiff + 1} 行：`);
    console.error(`     文件: ${(currentLines[firstDiff] ?? '<无>').slice(0, 100)}`);
    console.error(`     应为: ${(generatedLines[firstDiff] ?? '<无>').slice(0, 100)}`);
    console.error('');
    console.error('   数据模型的唯一权威来源是设计文档。');
    console.error('   若这次改动是**有意**的：请改 DATABASE_DESIGN.md，再运行生成脚本。');
    console.error('   若你直接改了 schema：那些改动会被下一次生成覆盖，必须搬回文档。');

    process.exit(1);
  }

  console.log('Prisma schema 与设计文档一致');
  console.log(`  model : ${modelCount}`);
  console.log(`  enum  : ${enumCount}`);

  process.exit(0);
}

writeFileSync(targetSchema, generated, 'utf8');

console.log('已生成 Prisma schema');
console.log(`  来源   : ${sourceDoc}`);
console.log(`  目标   : ${targetSchema}`);
console.log(`  代码块 : ${prismaBlocks.length} 段（顺序：含 generator 的段优先）`);
console.log(`  model  : ${modelCount}`);
console.log(`  enum   : ${enumCount}`);
console.log(`  行数   : ${`${header}${body}`.split('\n').length}`);
