/**
 * Commitlint 配置 — 强制 Conventional Commits
 * 格式: <type>(<scope>): <subject>
 * 例:   feat(auth): 实现微信静默登录与 JWT 签发
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat', // 新功能
        'fix', // 缺陷修复
        'docs', // 文档
        'style', // 格式（不影响逻辑）
        'refactor', // 重构
        'perf', // 性能优化
        'test', // 测试
        'build', // 构建/依赖
        'ci', // CI/CD
        'chore', // 杂项
        'revert', // 回滚
      ],
    ],
    'scope-enum': [
      1, // warning 级别，允许新增 scope
      'always',
      [
        'server',
        'auth',
        'user',
        'test',
        'personality',
        'ai',
        'report',
        'relationship',
        'payment',
        'membership',
        'notification',
        'storage',
        'admin',
        'miniapp',
        'web-admin',
        'db',
        'infra',
        'docs',
        'deps',
        'ci',
      ],
    ],
    'subject-case': [0],
    'subject-max-length': [2, 'always', 100],
    'header-max-length': [2, 'always', 120],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
