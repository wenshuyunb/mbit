/**
 * 依赖版本探测脚本
 *
 * 用途：在锁定前端依赖版本前，查询 registry 上各包的 dist-tags（latest / next / alpha ...），
 *       避免凭记忆写版本号导致安装失败。uni-app 生态的版本号形如 3.0.0-4060620250520001，
 *       必须查询实际存在的 tag 才能正确锁定。
 *
 * 运行：
 *   node scripts/check-dependency-versions.mjs
 *   node scripts/check-dependency-versions.mjs @dcloudio/uni-app vue pinia
 */

const REGISTRY = process.env['NPM_REGISTRY'] ?? 'https://registry.npmmirror.com';

const DEFAULT_PACKAGES = [
  // uni-app 生态
  '@dcloudio/uni-app',
  '@dcloudio/uni-app-plus',
  '@dcloudio/uni-components',
  '@dcloudio/uni-h5',
  '@dcloudio/uni-mp-weixin',
  '@dcloudio/vite-plugin-uni',
  '@dcloudio/uni-automator',
  '@dcloudio/types',
  // 小程序 UI
  '@vant/weapp',
  // 前端基础
  'vue',
  'vue-router',
  'pinia',
  'vite',
  'typescript',
  'vue-tsc',
  '@vitejs/plugin-vue',
  // Admin
  'element-plus',
  '@element-plus/icons-vue',
  'axios',
  'echarts',
  'vue-echarts',
  'pinia-plugin-persistedstate',
  // 测试
  'vitest',
  '@vue/test-utils',
  'jsdom',
  '@playwright/test',
  'sass',
  'openapi-typescript',
  'unplugin-auto-import',
  'unplugin-vue-components',
];

const packages = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_PACKAGES;

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
};

const results = await Promise.all(
  packages.map(async (name) => {
    try {
      const meta = await fetchJson(`${REGISTRY}/${name.replace('/', '%2f')}`);
      const tags = meta['dist-tags'] ?? {};
      const versions = Object.keys(meta.versions ?? {});
      return {
        name,
        ok: true,
        tags,
        latest: tags['latest'] ?? versions[versions.length - 1] ?? 'unknown',
        versionCount: versions.length,
      };
    } catch (error) {
      return { name, ok: false, error: error.message };
    }
  }),
);

const pad = (text, width) => String(text).padEnd(width, ' ');

console.log(`registry: ${REGISTRY}`);
console.log(`${pad('package', 38)} ${pad('latest', 28)} other dist-tags`);
console.log('-'.repeat(110));

for (const row of results) {
  if (!row.ok) {
    console.log(`${pad(row.name, 38)} ERROR: ${row.error}`);
    continue;
  }

  const others = Object.entries(row.tags)
    .filter(([tag]) => tag !== 'latest')
    .map(([tag, version]) => `${tag}=${version}`)
    .join(' ');

  console.log(`${pad(row.name, 38)} ${pad(row.latest, 28)} ${others}`);
}
