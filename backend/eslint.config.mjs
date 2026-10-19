// ============================================================================
// SoulMap AI 后端 ESLint 配置（Flat Config, ESLint 9）
// ----------------------------------------------------------------------------
// 质量门禁（见 PROJECT_ARCHITECTURE.md §18.3）：
//   · 0 error / 0 warning
//   · 禁止 console.log（统一使用 Nest Logger / pino）
//   · 禁止 $queryRawUnsafe / $executeRawUnsafe（SQL 注入风险）
//   · 禁止在业务代码里读取 process.env（必须走 ConfigService）
// ============================================================================

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**', '*.config.js', '*.config.mjs'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module',
      },
    },
    rules: {
      // ---------------------------------------------------------------- 通用
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
      'prefer-const': 'error',
      'no-return-await': 'off',
      'require-await': 'off',

      // ------------------------------------------------------------ TypeScript
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true, allowHigherOrderFunctions: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // --------------------------------------------------------------- 安全
      // SQL 注入防护：参数化查询必须使用 $queryRaw / $executeRaw（模板标签）
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='$queryRawUnsafe']",
          message: '禁止使用 $queryRawUnsafe（SQL 注入风险），请使用参数化的 $queryRaw 模板标签。',
        },
        {
          selector: "MemberExpression[property.name='$executeRawUnsafe']",
          message: '禁止使用 $executeRawUnsafe（SQL 注入风险），请使用参数化的 $executeRaw 模板标签。',
        },
        {
          selector: "MemberExpression[property.name='queryRawUnsafe']",
          message: '禁止使用 queryRawUnsafe（SQL 注入风险）。',
        },
      ],

      // 配置必须来自环境变量并经 ConfigService 读取（架构文档 §16.2）
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: '禁止直接读取 process.env，请通过 ConfigService 读取（仅 config/ 与 main.ts 例外）。',
        },
      ],
    },
  },

  // 配置层与启动入口允许直接访问 process.env
  {
    files: [
      'src/config/**/*.ts',
      'src/main.ts',
      'src/worker.ts',
      'src/infra/**/*.ts',
      'prisma/**/*.ts',
      'test/**/*.ts',
    ],
    rules: {
      'no-restricted-properties': 'off',
    },
  },

  // ------------------------------------------------------------------ 测试文件
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'no-restricted-properties': 'off',
      // 测试替身（fake / stub）需要与真实服务保持相同的异步签名，
      // 但内部实现是同步的 —— 这是刻意的设计，不应视为缺陷。
      '@typescript-eslint/require-await': 'off',
    },
  },

  // 种子脚本与运维脚本
  {
    files: ['prisma/seed/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  /**
   * 纯 Node 脚本（`.mjs`）：**不做类型感知检查**
   *
   * 这类文件（如 `scripts/build-china-cities.mjs`）是构建期工具，不进 `tsconfig.json`
   * 的编译范围（`allowJs` 为 false），因此 `parserOptions.project` 解析不到它们 ——
   * 不关掉类型感知就会直接报 "Parsing error"，让整个 lint 门禁失效。
   */
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
      /**
       * 关掉"必须写返回类型"：该规则依赖类型信息才能识别回调
       * （`allowExpressions` / `allowHigherOrderFunctions` 都要求类型感知），
       * 而纯 JS 脚本没有类型 —— 开着它只会对每一个箭头函数都报错。
       */
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  eslintConfigPrettier,
);
