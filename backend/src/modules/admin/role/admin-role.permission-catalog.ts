/**
 * 权限点元数据（契约 §3.14.9.7 `allPermissions`）
 *
 * 为什么单独放一个文件：`GET /admin/roles` 要在角色配置界面上展示**每个权限点**的
 * 中文名、风险等级与说明，这些是**展示层元数据**（`name` / `severity` / `description`），
 * 与 `admin-permission.constants.ts` 里的授权用常量（码值本身）不是一回事：
 *   · 码值（`ALL_ADMIN_PERMISSIONS`）是**授权依据**，必须与前端 `PERMISSIONS` 逐字一致；
 *   · 展示文案（本文件）是**给配置者看的说明**，改文案不会影响任何鉴权行为。
 *
 * ⚠ 文案逐条取自契约 §3.14.9.7（17142–17445 行）。注意它与 `permissions` 表里
 *   `ADMIN_PERMISSION_NAMES`（seed 写入）的措辞**故意不完全相同**（例如
 *   `user:user:write` 在 seed 里是「修改用户（封禁/解封）」，契约是「修改用户」+
 *   说明「封禁/解封用户」）。界面按契约文案展示，数据库里的 `name` 仍供后台检索使用。
 *
 * ⚠ 另一处易混淆点：`user:user:write` 在本文件（契约 §3.14.9.7 权限点风险等级）是
 *   `CRITICAL`，而契约 §3.14.9.3 的**审计等级表**把它标为 `SENSITIVE`。二者不是同一维度：
 *   · 这里是「**权限风险等级**」——授予这个权限点时前端要二次确认；
 *   · 审计表那里是「**审计条目等级**」——写入 `admin_audit_logs` 时该条记录的严重度。
 *   故本文件按 §3.14.9.7 取值，不要拿审计表的等级来"修正"它。
 */

import type { AdminPermission } from '../rbac/admin-permission.constants';

/** 权限风险等级（契约 §3.14.9.7 的 `severity`） */
export type AdminPermissionSeverity = 'NORMAL' | 'SENSITIVE' | 'CRITICAL';

export interface AdminPermissionMeta {
  /** 中文名（契约原文） */
  name: string;
  /** 风险等级：CRITICAL 级权限在授予/移除时接口会返回 `riskWarnings` */
  severity: AdminPermissionSeverity;
  /** 一句话说明这个权限能做什么 */
  description: string;
}

/** 领域 → 中文名（契约 §3.14.9.7 的分组标题） */
export const ADMIN_PERMISSION_DOMAIN_NAMES: Readonly<Record<string, string>> = {
  user: '用户',
  test: '测试与题库',
  ai: 'AI',
  payment: '支付与资金',
  relationship: '关系',
  report: '报告',
  system: '系统治理',
  dashboard: '数据看板',
};

/**
 * 领域的展示顺序（契约 §3.14.9.7 的排列顺序）
 *
 * 顺序写死而不是按字典序：界面上「用户 / 题库 / AI / 支付」的排列是产品语义，
 * 字典序（ai < dashboard < payment < relationship < report < system < test < user）
 * 会让最常用的用户与题库排到最后。
 */
export const ADMIN_PERMISSION_DOMAIN_ORDER: readonly string[] = [
  'user',
  'test',
  'ai',
  'payment',
  'relationship',
  'report',
  'system',
  'dashboard',
];

/**
 * 权限点 → 展示元数据
 *
 * 类型为 `Record<AdminPermission, ...>` 是**刻意**的：`AdminPermission` 是全部权限点的
 * 联合类型，漏登记任何一个权限点都会编译失败 —— 否则新增权限点后界面上会静默少一项。
 */
export const ADMIN_PERMISSION_CATALOG: Readonly<Record<AdminPermission, AdminPermissionMeta>> = {
  // ---------------------------------------------------------------- 用户
  'user:user:read': {
    name: '查看用户',
    severity: 'NORMAL',
    description: '查询用户列表与详情（敏感字段脱敏）',
  },
  'user:user:write': {
    name: '修改用户',
    severity: 'CRITICAL',
    description: '封禁/解封用户',
  },
  'user:deletion:read': {
    name: '查看注销申请',
    severity: 'NORMAL',
    description: '查看用户注销申请与状态',
  },

  // ------------------------------------------------------------ 测试与题库
  'test:question:read': {
    name: '查看题库',
    severity: 'NORMAL',
    description: '查询题目与统计',
  },
  'test:question:write': {
    name: '编辑题库',
    severity: 'SENSITIVE',
    description: '新增/修改/删除/导入题目',
  },
  'test:definition:read': {
    name: '查看测试定义',
    severity: 'NORMAL',
    description: '查询测试定义与抽题配置',
  },
  'test:definition:write': {
    name: '编辑测试定义',
    severity: 'SENSITIVE',
    description: '新增/修改测试定义（影响算分口径）',
  },

  // -------------------------------------------------------------------- AI
  'ai:prompt:read': {
    name: '查看 Prompt',
    severity: 'SENSITIVE',
    description: '查看 Prompt 模板与版本全文',
  },
  'ai:prompt:write': {
    name: '编辑 Prompt',
    severity: 'SENSITIVE',
    description: '新建 Prompt 版本与试渲染',
  },
  'ai:prompt:publish': {
    name: '发布 Prompt',
    severity: 'CRITICAL',
    description: '发布/回滚 Prompt 版本（影响全站 AI 输出）',
  },
  'ai:stats:read': {
    name: '查看 AI 统计',
    severity: 'NORMAL',
    description: '用量、成本与质量统计',
  },
  'ai:calllog:read': {
    name: '查看 AI 调用日志',
    severity: 'NORMAL',
    description: '调用审计日志（不含全文）',
  },

  // ------------------------------------------------------------ 支付与资金
  'payment:order:read': {
    name: '查看订单',
    severity: 'NORMAL',
    description: '查询订单与支付信息',
  },
  'payment:order:refund': {
    name: '发起退款',
    severity: 'CRITICAL',
    description: '全额/部分退款并撤销权益',
  },
  'payment:order:export': {
    name: '导出订单',
    severity: 'CRITICAL',
    description: '导出订单数据（脱敏）',
  },

  // ------------------------------------------------------------------ 关系
  'relationship:relationship:read': {
    name: '查看关系',
    severity: 'NORMAL',
    description: '查询关系与匹配数据',
  },

  // ------------------------------------------------------------------ 报告
  'report:report:read': {
    name: '查看报告',
    severity: 'SENSITIVE',
    description: '查询报告元数据（正文需二次确认）',
  },

  // -------------------------------------------------------------- 系统治理
  'system:config:read': {
    name: '查看配置',
    severity: 'NORMAL',
    description: '查看系统配置项',
  },
  'system:config:write': {
    name: '修改配置',
    severity: 'CRITICAL',
    description: '修改系统配置与功能开关',
  },
  'system:audit:read': {
    name: '查看审计日志',
    severity: 'SENSITIVE',
    description: '查询管理员操作审计',
  },
  'system:admin:read': {
    name: '查看管理员',
    severity: 'NORMAL',
    description: '查询管理员账号',
  },
  'system:admin:write': {
    name: '管理管理员',
    severity: 'CRITICAL',
    description: '新建管理员、重置密码',
  },
  'system:role:read': {
    name: '查看角色',
    severity: 'NORMAL',
    description: '查询角色与权限点',
  },
  'system:role:write': {
    name: '管理角色',
    severity: 'CRITICAL',
    description: '修改角色权限映射',
  },

  // -------------------------------------------------------------- 数据看板
  'dashboard:metrics:read': {
    name: '查看指标看板',
    severity: 'NORMAL',
    description: '北极星与业务指标看板',
  },
};
