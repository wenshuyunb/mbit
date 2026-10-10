/**
 * 包元数据探测脚本
 *
 * 用途：查询指定包（可带 dist-tag）的 dependencies / peerDependencies，
 *       用于确定组合依赖的兼容版本，避免凭猜测写版本号。
 *
 * 运行：
 *   node scripts/inspect-package.mjs @dcloudio/vite-plugin-uni@vue3
 *   node scripts/inspect-package.mjs @dcloudio/uni-app@vue3 element-plus
 */

const REGISTRY = process.env['NPM_REGISTRY'] ?? 'https://registry.npmmirror.com';

const specs = process.argv.slice(2);
if (specs.length === 0) {
  console.error('用法: node scripts/inspect-package.mjs <pkg[@tag|@version]> [...]');
  process.exit(1);
}

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const resolveSpec = (spec) => {
  // 处理 @scope/name@tag 形式
  const atIndex = spec.lastIndexOf('@');
  if (atIndex > 0) {
    return { name: spec.slice(0, atIndex), ref: spec.slice(atIndex + 1) };
  }
  return { name: spec, ref: 'latest' };
};

const printSection = (title, record) => {
  const entries = Object.entries(record ?? {});
  console.log(`  ${title} (${entries.length})`);
  if (entries.length === 0) {
    console.log('    (none)');
    return;
  }
  for (const [key, value] of entries) {
    console.log(`    ${key.padEnd(46, ' ')} ${value}`);
  }
};

for (const spec of specs) {
  const { name, ref } = resolveSpec(spec);
  console.log('='.repeat(110));
  console.log(`package: ${name}   ref: ${ref}`);

  try {
    const meta = await fetchJson(`${REGISTRY}/${name.replace('/', '%2f')}`);
    const version = meta['dist-tags']?.[ref] ?? ref;
    const manifest = meta.versions?.[version];

    if (!manifest) {
      console.log(
        `  ERROR: 版本 ${version} 不存在。可用 dist-tags: ${Object.keys(meta['dist-tags'] ?? {}).join(', ')}`,
      );
      continue;
    }

    console.log(`resolved version: ${version}`);
    console.log(`engines: ${JSON.stringify(manifest.engines ?? {})}`);
    printSection('dependencies', manifest.dependencies);
    printSection('peerDependencies', manifest.peerDependencies);
    printSection('peerDependenciesMeta', manifest.peerDependenciesMeta);
  } catch (error) {
    console.log(`  ERROR: ${error.message}`);
  }
}
