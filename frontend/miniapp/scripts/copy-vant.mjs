/**
 * 复制 Vant Weapp 组件到小程序项目
 *
 * 背景：@vant/weapp 是**原生微信小程序自定义组件**（不是 uni-app 组件），
 *       在 uni-app Vue3 项目中需要通过 easycom 规则引用编译后的组件目录：
 *         pages.json → easycom.custom."^van-(.*)" → "@/wxcomponents/vant/$1/index"
 *       而 WXML/WXSS/JSON 必须存在于源码目录中，因此需要把 npm 包里的
 *       dist 目录复制到 src/wxcomponents/vant 下。
 *
 * 为什么不让 uni-app 自动处理：
 *   uni-app 的「原生组件」支持只覆盖 uni_modules，npm 形式的原生组件需手动落盘。
 *   这也是微信小程序生态的通行做法（官方文档同样建议复制 dist）。
 *
 * 运行：node scripts/copy-vant.mjs
 *       （或 pnpm --filter @soulmap/miniapp copy:vant）
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const source = join(projectRoot, 'node_modules', '@vant', 'weapp', 'dist');
const target = join(projectRoot, 'src', 'wxcomponents', 'vant');

if (!existsSync(source)) {
  console.error('未找到 @vant/weapp，请先执行 pnpm install。');
  console.error(`期望路径: ${source}`);
  process.exit(1);
}

// 先清理，保证与依赖版本严格一致（避免残留旧版本组件导致样式错乱）
if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true });
}

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

/** 统计复制的组件数量与总体积，便于关注主包体积 */
const countComponents = (dir) => {
  let count = 0;
  let bytes = 0;

  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        bytes += statSync(full).size;
      }
    }
  };

  walk(dir);

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += 1;
  }

  return { count, bytes };
};

const { count, bytes } = countComponents(target);

console.log('Vant Weapp 组件已复制');
console.log(`  来源: ${source}`);
console.log(`  目标: ${target}`);
console.log(`  组件目录数: ${count}`);
console.log(`  占用体积  : ${(bytes / 1024).toFixed(1)} KB`);
console.log('');
console.log('⚠ 主包体积提示：微信小程序主包上限 2MB。');
console.log('  仅复制实际使用到的组件（按需删除未使用目录），否则容易超限。');
