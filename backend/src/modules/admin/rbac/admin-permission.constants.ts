/**
 * 管理端 RBAC 权限点与角色矩阵
 *
 * 契约来源：`docs/API_DESIGN.md` §2.7.3（权限点清单 + 内置角色映射）
 * 命名规范：`<domain>:<resource>:<action>`，与前端 `frontend/admin/src/constants/index.ts`
 * 的 `PERMISSIONS` **逐字一致** —— 两边不一致会导致「菜单可见但接口 403」这类诡异现象。
 *
 * ⚠ 契约 §2.7.3 的角色表里把 OPERATOR 的封禁权限写作 `user:user:ban`，
 *   但同一节的完整权限点清单与附录 A.13 的接口索引都写的是 `user:user:write`。
 *   本文件以**清单与接口索引**为准（`user:user:ban` 视为笔误），否则该权限点
 *   会既不在清单里、又没有任何接口声明使用它。
 */

/** 权限点（25 个，契约 §2.7.3 完整清单） */
export const ADMIN_PERMISSIONS = {
  // 看板
  DASHBOARD_METRICS_READ: 'dashboard:metrics:read',

  // 用户
  USER_READ: 'user:user:read',
  USER_WRITE: 'user:user:write',
  USER_DELETION_READ: 'user:deletion:read',

  // 题库与测试定义
  QUESTION_READ: 'test:question:read',
  QUESTION_WRITE: 'test:question:write',
  TEST_DEFINITION_READ: 'test:definition:read',
  TEST_DEFINITION_WRITE: 'test:definition:write',

  // Prompt
  PROMPT_READ: 'ai:prompt:read',
  PROMPT_WRITE: 'ai:prompt:write',
  PROMPT_PUBLISH: 'ai:prompt:publish',

  // AI 统计
  AI_STATS_READ: 'ai:stats:read',
  AI_CALLLOG_READ: 'ai:calllog:read',

  // 订单与支付
  ORDER_READ: 'payment:order:read',
  ORDER_REFUND: 'payment:order:refund',
  ORDER_EXPORT: 'payment:order:export',

  // 关系与报告
  RELATIONSHIP_READ: 'relationship:relationship:read',
  REPORT_READ: 'report:report:read',

  // 系统
  CONFIG_READ: 'system:config:read',
  CONFIG_WRITE: 'system:config:write',
  AUDIT_READ: 'system:audit:read',
  ADMIN_READ: 'system:admin:read',
  ADMIN_WRITE: 'system:admin:write',
  ROLE_READ: 'system:role:read',
  ROLE_WRITE: 'system:role:write',
} as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];

/** 全部权限点清单（seed 与角色配置界面使用） */
export const ALL_ADMIN_PERMISSIONS: readonly AdminPermission[] = Object.values(ADMIN_PERMISSIONS);

/** 权限点中文名（seed 写入 `permissions.name`，也用于角色配置界面） */
export const ADMIN_PERMISSION_NAMES: Readonly<Record<AdminPermission, string>> = {
  'dashboard:metrics:read': '查看数据看板',
  'user:user:read': '查看用户',
  'user:user:write': '修改用户（封禁/解封）',
  'user:deletion:read': '查看注销申请',
  'test:question:read': '查看题库',
  'test:question:write': '维护题库（增删改/导入）',
  'test:definition:read': '查看测试定义',
  'test:definition:write': '维护测试定义',
  'ai:prompt:read': '查看 Prompt',
  'ai:prompt:write': '新建 Prompt 版本',
  'ai:prompt:publish': '发布/回滚 Prompt 版本',
  'ai:stats:read': '查看 AI 用量与成本',
  'ai:calllog:read': '查看 AI 调用日志',
  'payment:order:read': '查看订单',
  'payment:order:refund': '发起退款',
  'payment:order:export': '导出订单',
  'relationship:relationship:read': '查看关系数据',
  'report:report:read': '查看报告数据',
  'system:config:read': '查看系统配置',
  'system:config:write': '修改系统配置',
  'system:audit:read': '查看审计日志',
  'system:admin:read': '查看管理员账号',
  'system:admin:write': '管理管理员账号',
  'system:role:read': '查看角色',
  'system:role:write': '管理角色与权限',
};

/** 通配标识：SUPER_ADMIN 拥有全部权限 */
export const PERMISSION_WILDCARD = '*';

/** 内置角色码（与 `common/decorators/roles.decorator.ts` 的 `AdminRoleCode` 一致） */
export const ADMIN_ROLES = ['SUPER_ADMIN', 'OPERATOR', 'CONTENT_EDITOR', 'FINANCE', 'ANALYST'] as const;
export type AdminRoleCodeValue = (typeof ADMIN_ROLES)[number];

export const ADMIN_ROLE_NAMES: Readonly<Record<AdminRoleCodeValue, string>> = {
  SUPER_ADMIN: '超级管理员',
  OPERATOR: '运营',
  CONTENT_EDITOR: '内容编辑',
  FINANCE: '财务',
  ANALYST: '数据分析',
};

/**
 * 角色 → 权限点映射（契约 §2.7.3）
 *
 * ⚠ 契约原文标注为「主要权限点」，即**非穷尽**。这里补上了各角色所需权限点的
 * **读侧对应项**：一个只能写、不能读的角色在界面上连列表都打不开，
 * 实际不可用（例如 CONTENT_EDITOR 若没有 `test:question:read`，
 * 打开题库页会直接 403）。补齐的项已在下表内注明。
 */
export const ADMIN_ROLE_PERMISSIONS: Readonly<Record<AdminRoleCodeValue, readonly string[]>> = {
  // 全部权限（用通配符表达，避免新增权限点时忘记同步）
  SUPER_ADMIN: [PERMISSION_WILDCARD],

  // 运营：用户 / 内容 / 订单只读 + 客服操作
  OPERATOR: [
    ADMIN_PERMISSIONS.USER_READ,
    ADMIN_PERMISSIONS.USER_WRITE, // 客服操作：封禁 / 解封（契约写 user:user:ban，见文件头说明）
    ADMIN_PERMISSIONS.USER_DELETION_READ, // 补：注销申请查看，客服日常需要
    ADMIN_PERMISSIONS.QUESTION_READ,
    ADMIN_PERMISSIONS.TEST_DEFINITION_READ, // 补：内容只读
    ADMIN_PERMISSIONS.ORDER_READ,
    ADMIN_PERMISSIONS.RELATIONSHIP_READ,
    ADMIN_PERMISSIONS.REPORT_READ,
    ADMIN_PERMISSIONS.DASHBOARD_METRICS_READ, // 补：运营需要看板
  ],

  // 内容：题库 / Prompt
  CONTENT_EDITOR: [
    ADMIN_PERMISSIONS.QUESTION_READ, // 补：不能读就无法编辑
    ADMIN_PERMISSIONS.QUESTION_WRITE,
    ADMIN_PERMISSIONS.TEST_DEFINITION_READ, // 补：同上
    ADMIN_PERMISSIONS.TEST_DEFINITION_WRITE,
    ADMIN_PERMISSIONS.PROMPT_READ, // 补：同上
    ADMIN_PERMISSIONS.PROMPT_WRITE,
    ADMIN_PERMISSIONS.PROMPT_PUBLISH,
  ],

  // 财务：订单 / 对账 / 退款
  FINANCE: [
    ADMIN_PERMISSIONS.ORDER_READ,
    ADMIN_PERMISSIONS.ORDER_REFUND,
    ADMIN_PERMISSIONS.ORDER_EXPORT,
    ADMIN_PERMISSIONS.DASHBOARD_METRICS_READ, // 补：财务需要看营收看板
  ],

  // 分析：AI 统计只读
  ANALYST: [
    ADMIN_PERMISSIONS.AI_STATS_READ,
    ADMIN_PERMISSIONS.AI_CALLLOG_READ,
    ADMIN_PERMISSIONS.DASHBOARD_METRICS_READ,
    ADMIN_PERMISSIONS.REPORT_READ, // 补：分析报告产出质量需要读报告
  ],
};

/** 角色 → 中文名（seed 写入 `roles.name`） */
export const ADMIN_ROLE_DESCRIPTIONS: Readonly<Record<AdminRoleCodeValue, string>> = {
  SUPER_ADMIN: '拥有全部权限',
  OPERATOR: '用户 / 内容 / 订单只读，含客服封禁操作',
  CONTENT_EDITOR: '题库与 AI Prompt 维护',
  FINANCE: '订单查询、对账与退款',
  ANALYST: 'AI 用量与成本统计（只读）',
};
