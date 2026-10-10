/**
 * 汇总 Vitest JSON 报告中的失败用例
 *
 * 用途：CI 与本地在受限环境下无法直接读取子进程退出码时，通过 JSON 报告
 *       精确提取失败用例名称、断言差异与堆栈首行，便于快速定位。
 *
 * 运行：
 *   node scripts/summarize-vitest-failures.mjs .runlogs/verify/miniapp-vitest.json
 *   node scripts/summarize-vitest-failures.mjs <report1.json> <report2.json>
 */

import { readFileSync, existsSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node scripts/summarize-vitest-failures.mjs <vitest-json-report> [...]');
  process.exit(1);
}

const cleanMessage = (message) =>
  String(message ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

let totalFailed = 0;

for (const file of files) {
  if (!existsSync(file)) {
    console.log(`\n### ${file}\n  报告文件不存在`);
    continue;
  }

  const report = JSON.parse(readFileSync(file, 'utf8'));

  console.log(`\n${'='.repeat(100)}`);
  console.log(`报告: ${file}`);
  console.log(
    `总计: ${report.numTotalTests} 个用例 / 通过 ${report.numPassedTests} / 失败 ${report.numFailedTests} / 套件 ${report.numTotalTestSuites}`,
  );

  if (report.numFailedTests === 0) {
    console.log('无失败用例');
    continue;
  }

  totalFailed += report.numFailedTests;

  for (const suite of report.testResults ?? []) {
    const failedCases = (suite.assertionResults ?? []).filter((item) => item.status === 'failed');
    if (failedCases.length === 0) continue;

    const relativePath = String(suite.name ?? '')
      .replace(/\\/g, '/')
      .split('/frontend/')
      .pop();
    console.log(`\n--- ${relativePath} ---`);

    for (const testCase of failedCases) {
      console.log(`\n  ✗ ${testCase.fullName ?? testCase.title}`);

      const lines = cleanMessage(testCase.failureMessages?.[0]);
      // 打印断言差异与错误类型行，跳过冗长的内部堆栈
      const interesting = lines.filter(
        (line) =>
          line.startsWith('AssertionError') ||
          line.startsWith('Error:') ||
          line.startsWith('TypeError') ||
          line.startsWith('ReferenceError') ||
          line.startsWith('Expected') ||
          line.startsWith('Received') ||
          line.startsWith('- Expected') ||
          line.startsWith('+ Received') ||
          line.startsWith('expected') ||
          line.startsWith('→') ||
          /^\s*[-+]/.test(line) ||
          line.includes('to be') ||
          line.includes('to equal') ||
          line.includes('to contain'),
      );

      const shown = interesting.length > 0 ? interesting.slice(0, 12) : lines.slice(0, 8);
      for (const line of shown) {
        console.log(`      ${line}`);
      }
    }
  }
}

console.log(`\n${'='.repeat(100)}`);
console.log(`失败用例合计: ${totalFailed}`);
process.exit(totalFailed === 0 ? 0 : 1);
