/**
 * 版本清单探测脚本
 *
 * 用途：列出某包最近的稳定版本（可按 major 过滤），用于在存在多个大版本线时
 *       选出与既有依赖兼容的那一条（例如 uni-app 生态锁死 vite 5，就需要选
 *       仍支持 vite 5 的 vitest / pinia 版本）。
 *
 * 运行：
 *   node scripts/list-versions.mjs vitest --major 2
 *   node scripts/list-versions.mjs pinia --major 2 --limit 10
 */

const REGISTRY = process.env['NPM_REGISTRY'] ?? 'https://registry.npmmirror.com';

const args = process.argv.slice(2);
const name = args.find((arg) => !arg.startsWith('--'));
if (!name) {
  console.error('用法: node scripts/list-versions.mjs <pkg> [--major N] [--limit N]');
  process.exit(1);
}

const readFlag = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value === undefined ? fallback : Number(value);
};

const major = readFlag('--major', null);
const limit = readFlag('--limit', 15);

const response = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, {
  headers: { accept: 'application/json' },
});
if (!response.ok) {
  console.error(`HTTP ${response.status}`);
  process.exit(1);
}

const meta = await response.json();
let versions = Object.keys(meta.versions ?? {});

// 过滤掉预发布版本
versions = versions.filter((version) => !/-/.test(version));

if (major !== null) {
  versions = versions.filter((version) => version.split('.')[0] === String(major));
}

// 按 semver 排序（仅处理三段式主版本）
const compare = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
};
versions.sort(compare);

console.log(`package: ${name}`);
console.log(`dist-tags: ${JSON.stringify(meta['dist-tags'] ?? {})}`);
console.log(`stable versions (major=${major ?? 'any'}): total ${versions.length}`);
console.log(`last ${limit}: ${versions.slice(-limit).join(', ')}`);
if (major === null) {
  const majors = [...new Set(versions.map((version) => version.split('.')[0]))];
  console.log(`major lines: ${majors.join(', ')}`);
}
