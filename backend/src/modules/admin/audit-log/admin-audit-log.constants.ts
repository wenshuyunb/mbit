/**
 * 审计日志查询的「契约 ↔ 数据模型」映射表（纯逻辑，无 I/O）
 *
 * 契约来源：`docs/API_DESIGN.md` §3.14.9.3
 *
 * ## 为什么必须有这张表
 *
 * 契约响应里的四个字段在 `admin_audit_logs` 表里**一个都没有列**：
 *   · `action`（权限点字符串，如 `payment:order:refund`）—— 表里只有枚举
 *     `AdminAuditAction`（`LOGIN` / `UPDATE` / `REFUND` …），**没有权限点列**；
 *   · `severity` —— 契约业务规则 2 说它由权限点决定，表里同样没有；
 *   · `actionLabel`、`targetType` —— 表里没有，属于展示层派生字段；
 *   · `changeNote` —— 表里只有 `reason` / `diff_summary`。
 *
 * `admin_audit_logs` 是 append-only 的合规表，加列要走迁移（本目录不允许改
 * `prisma/schema.prisma`），因此这些字段只能由 `(resourceType, action)` **反推**。
 *
 * ## 反推的代价（必须说清楚，否则会被当成「精确数据」误用）
 *
 *   · `resourceType` 是**自由字符串**（没有枚举约束，现有写入方
 *     `admin-auth.service.ts` 用 `'admin_user'`），所以只能靠别名表归一；
 *   · 反推是**有损**的：`(resourceType, action)` 相同的记录必然被归到同一权限点。
 *     例如「重置密码」和「修改管理员资料」在表里都是 `admin_user + UPDATE`，
 *     都会显示为 `system:admin:write`；要靠 `diffSummary` / `reason` 才能区分，
 *     本表不做逐行猜测（猜错比不猜更危险）。
 *
 * ## 为什么把表放在常量文件而不是 Service 里
 *
 * 表是**契约的映射规则**而非查询逻辑：`severity` 过滤（`CRITICAL` 要能翻译成
 * SQL 条件）、摘要聚合（`byAction` 要按权限点而非枚举分组）、单条记录展示三处
 * 必须用**同一张表**。分散写会出现「列表显示 CRITICAL 但按 CRITICAL 过滤查不到」
 * 这类自相矛盾的结果。
 */

import { ErrorCode } from '../../../common/errors/error-code';

// ============================================================================
// 契约枚举
// ============================================================================

/** 风险等级（契约 §3.14.9.3 Query 参数 `severity`） */
export type AuditSeverity = 'NORMAL' | 'SENSITIVE' | 'CRITICAL';

/** `severity` 可选值（顺序即风险由低到高） */
export const AUDIT_SEVERITIES: readonly AuditSeverity[] = ['NORMAL', 'SENSITIVE', 'CRITICAL'];

/** 操作结果（契约 §3.14.9.3 Query 参数 `result`） */
export type AuditResult = 'SUCCESS' | 'FAILED' | 'DENIED';

/** `result` 可选值 */
export const AUDIT_RESULTS: readonly AuditResult[] = ['SUCCESS', 'FAILED', 'DENIED'];

/** 目标类型（契约 §3.14.9.3 Query 参数 `targetType`） */
export const AUDIT_TARGET_TYPES = [
  'USER',
  'ORDER',
  'REFUND',
  'QUESTION',
  'TEST_DEFINITION',
  'PROMPT',
  'CONFIG',
  'ROLE',
  'ADMIN',
  'REPORT',
  'RELATIONSHIP',
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * 审计动作名（与 Prisma 枚举 `AdminAuditAction` 逐字一致）
 *
 * 这里**重复声明**而没有 `import type { AdminAuditAction } from '@prisma/client'`，
 * 是为了让本文件保持「纯逻辑」：不触发 Prisma 客户端的模块加载，单测可以直接
 * 覆盖映射规则。一致性的保障来自下面两处编译期约束：
 *   · `AUDIT_ACTION_LABELS` 声明为 `Record<AuditActionName, string>`，枚举多一个
 *     成员或本处拼错一个成员都会让 `tsc` 失败；
 *   · Service 里 `AdminAuditAction`（来自 Prisma）与本类型**双向赋值**，任一侧
 *     缺成员同样编译失败。
 */
export type AuditActionName =
  | 'LOGIN'
  | 'LOGOUT'
  | 'LOGIN_FAILED'
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'PUBLISH'
  | 'UNPUBLISH'
  | 'ROLLBACK'
  | 'GRANT'
  | 'REVOKE'
  | 'REFUND'
  | 'MANUAL_FULFILL'
  | 'EXPORT'
  | 'IMPORT'
  | 'CONFIG_CHANGE';

/**
 * 动作名 → 中文动作名（`actionLabel` 的兜底表）
 *
 * 声明为 `Record<AuditActionName, string>`（而非 `Record<string, string>`）是刻意的：
 * Prisma 枚举新增成员时这里会**编译失败**，逼着人补中文名，而不是在界面上
 * 显示一个英文枚举值。
 */
export const AUDIT_ACTION_LABELS: Readonly<Record<AuditActionName, string>> = {
  LOGIN: '登录',
  LOGOUT: '登出',
  LOGIN_FAILED: '登录失败',
  CREATE: '新建',
  UPDATE: '更新',
  DELETE: '删除',
  PUBLISH: '发布',
  UNPUBLISH: '撤下发布',
  ROLLBACK: '版本回滚',
  GRANT: '授权',
  REVOKE: '撤销授权',
  REFUND: '发起退款',
  MANUAL_FULFILL: '手工补发权益',
  EXPORT: '数据导出',
  IMPORT: '批量导入',
  CONFIG_CHANGE: '修改系统配置',
};

// ============================================================================
// 风险等级
// ============================================================================

/**
 * 权限点 → 风险等级（契约 §3.14.9.3 业务规则 2 的原表）
 *
 * 表里只有 8 个权限点，其余一律 `NORMAL`（含 `LOGIN` 这类登录动作 ——
 * 契约把 `NORMAL` 定义为「只读查询」，但登录/登出既不涉资金也不涉内容与用户数据，
 * 归到 `SENSITIVE` 会把「敏感」这个信号稀释掉，故按契约示例的语义留在 `NORMAL`）。
 *
 * ⚠ **不要**改成复用 `../role/admin-role.permission-catalog.ts` 的
 *   `ADMIN_PERMISSION_CATALOG[].severity`：那是契约 §3.14.9.7 的「**权限**风险等级」
 *   （授予该权限时前端要二次确认），与这里的「**审计条目**风险等级」不是同一维度。
 *   两表在多个权限点上**故意不同**：
 *     · `user:user:write`     —— 权限等级 CRITICAL，审计等级 SENSITIVE
 *     · `ai:prompt:publish`   —— 权限等级 CRITICAL，审计等级 SENSITIVE
 *     · `system:audit:read`   —— 权限等级 SENSITIVE（本表未登记 → NORMAL）
 *   互换会让审计页的风险排序与契约 §3.14.9.3 的示例对不上。
 */
const SEVERITY_BY_PERMISSION: Readonly<Record<string, AuditSeverity>> = {
  'system:config:write': 'CRITICAL',
  'system:admin:write': 'CRITICAL',
  'system:role:write': 'CRITICAL',
  'payment:order:refund': 'CRITICAL',
  'payment:order:export': 'CRITICAL',
  'ai:prompt:publish': 'SENSITIVE',
  'user:user:write': 'SENSITIVE',
  'report:report:read': 'SENSITIVE',
};

/** 取权限点对应的风险等级；未登记即为 `NORMAL`（契约业务规则 2 的补集语义） */
export const severityOfPermission = (permission: string): AuditSeverity =>
  SEVERITY_BY_PERMISSION[permission] ?? 'NORMAL';

// ============================================================================
// 资源类型别名 / 目标类型
// ============================================================================

/**
 * 目标类型 → 已知的 `resourceType` 取值（含写入方实际使用的形态）
 *
 * `resourceType` 是自由字符串，写入方各写各的（`admin_user` / `admin` / `ADMIN`），
 * 因此过滤与归一都必须走这张别名表。键值里的写法尽量覆盖：
 * 小写单数（写入方约定）、小写复数、下划线组合、以及契约枚举名本身。
 */
export const TARGET_TYPE_RESOURCE_TYPES: Readonly<Record<AuditTargetType, readonly string[]>> = {
  USER: ['user', 'users', 'user_profile', 'user_profiles', 'USER'],
  ORDER: ['order', 'orders', 'payment_order', 'order_info', 'ORDER'],
  REFUND: ['refund', 'refunds', 'refund_order', 'REFUND'],
  QUESTION: ['question', 'questions', 'QUESTION'],
  TEST_DEFINITION: ['test_definition', 'test_definitions', 'test-definition', 'TEST_DEFINITION'],
  PROMPT: ['prompt', 'prompts', 'prompt_template', 'prompt_templates', 'prompt_version', 'PROMPT'],
  CONFIG: ['config', 'configs', 'system_config', 'system_configs', 'CONFIG'],
  ROLE: ['role', 'roles', 'ROLE'],
  // 现有写入方（admin-auth.service.ts）用的是 'admin_user'
  ADMIN: ['admin', 'admins', 'admin_user', 'admin_users', 'ADMIN'],
  REPORT: ['report', 'reports', 'ai_report', 'REPORT'],
  RELATIONSHIP: ['relationship', 'relationships', 'RELATIONSHIP'],
};

/** 归一化比对用（大小写不敏感）：别名（小写）→ 目标类型 */
const RESOURCE_TYPE_TO_TARGET_TYPE: ReadonlyMap<string, AuditTargetType> = new Map(
  AUDIT_TARGET_TYPES.flatMap((targetType) =>
    TARGET_TYPE_RESOURCE_TYPES[targetType].map((alias): [string, AuditTargetType] => [alias.toLowerCase(), targetType]),
  ),
);

/**
 * `resourceType` → 契约的 `targetType` 枚举
 *
 * 命中不了返回 `null`（而不是硬塞一个 `USER`）：调用方需要区分「确定是用户」
 * 与「不认识」，后者必须**原样返回**，否则一条 `resourceType = 'coupon'` 的日志
 * 会被显示成用户操作，属于凭空捏造事实。
 */
export const toTargetType = (resourceType: string): AuditTargetType | null =>
  RESOURCE_TYPE_TO_TARGET_TYPE.get(resourceType.trim().toLowerCase()) ?? null;

/** 对外展示的目标类型：归一命中则用枚举，否则原样返回（契约允许未知值透出） */
export const displayTargetType = (resourceType: string): string => toTargetType(resourceType) ?? resourceType;

/**
 * 某个值可以被当成哪些 `resourceType` 来匹配
 *
 * 用于过滤：客户端可能传枚举名（`ADMIN`）、别名（`admin`）或真实写入值（`admin_user`），
 * 三者应当等价。返回集合至少含入参本身，保证「精确匹配」这条底线不会丢。
 */
export const resourceTypeAliasesOf = (resourceType: string): readonly string[] => {
  const targetType = toTargetType(resourceType);

  if (targetType === null) return [resourceType];

  return [resourceType, ...TARGET_TYPE_RESOURCE_TYPES[targetType]];
};

// ============================================================================
// (resourceType, action) → 权限点 / 动作中文名
// ============================================================================

/** 单条反推规则 */
interface AuditActionRule {
  readonly action: AuditActionName;
  /** 契约的 `action` 字段（权限点字符串） */
  readonly permission: string;
  /** 契约的 `actionLabel` 字段（中文动作名） */
  readonly actionLabel: string;
}

/**
 * 反推规则表
 *
 * 契约的 `action` 是**权限点**，而表里只有动作枚举，因此这张表是唯一的真相来源。
 * 未命中任何规则的记录回退为 `${resourceType}:${action.toLowerCase()}`（见
 * `resolveAuditAction`）—— 回退值看起来像权限点但**并不是**有效权限点，
 * 这一点在前端需要知道：它只能用于展示与去重，不能拿去比对权限。
 */
const ACTION_RULES: Readonly<Record<AuditTargetType, readonly AuditActionRule[]>> = {
  CONFIG: [
    { action: 'CONFIG_CHANGE', permission: 'system:config:write', actionLabel: '修改系统配置' },
    { action: 'UPDATE', permission: 'system:config:write', actionLabel: '更新系统配置' },
  ],
  ADMIN: [
    { action: 'CREATE', permission: 'system:admin:write', actionLabel: '新建管理员' },
    // 「重置密码」也走 UPDATE，契约没有单独的权限点，与「修改管理员」同归一项
    { action: 'UPDATE', permission: 'system:admin:write', actionLabel: '修改管理员（含重置密码）' },
    { action: 'DELETE', permission: 'system:admin:write', actionLabel: '删除管理员' },
    { action: 'GRANT', permission: 'system:admin:write', actionLabel: '授予管理员角色' },
    { action: 'REVOKE', permission: 'system:admin:write', actionLabel: '撤销管理员角色' },
    { action: 'LOGIN', permission: 'admin:auth:login', actionLabel: '管理员登录' },
    { action: 'LOGOUT', permission: 'admin:auth:logout', actionLabel: '管理员登出' },
    { action: 'LOGIN_FAILED', permission: 'admin:auth:login', actionLabel: '管理员登录失败' },
  ],
  ROLE: [
    { action: 'CREATE', permission: 'system:role:write', actionLabel: '新建角色' },
    { action: 'UPDATE', permission: 'system:role:write', actionLabel: '修改角色与权限' },
    { action: 'DELETE', permission: 'system:role:write', actionLabel: '删除角色' },
    { action: 'GRANT', permission: 'system:role:write', actionLabel: '授予角色权限' },
    { action: 'REVOKE', permission: 'system:role:write', actionLabel: '撤销角色权限' },
  ],
  PROMPT: [
    { action: 'PUBLISH', permission: 'ai:prompt:publish', actionLabel: '发布 Prompt 版本' },
    { action: 'ROLLBACK', permission: 'ai:prompt:publish', actionLabel: '回滚 Prompt 版本' },
    { action: 'UNPUBLISH', permission: 'ai:prompt:publish', actionLabel: '撤下 Prompt 版本' },
    { action: 'CREATE', permission: 'ai:prompt:write', actionLabel: '新建 Prompt 版本' },
    { action: 'UPDATE', permission: 'ai:prompt:write', actionLabel: '更新 Prompt 内容' },
  ],
  ORDER: [
    { action: 'REFUND', permission: 'payment:order:refund', actionLabel: '发起退款' },
    { action: 'EXPORT', permission: 'payment:order:export', actionLabel: '导出订单' },
    // 手工补发权益是资金等价操作；仓库没有专门的权限点，并入订单退款（CRITICAL）而非当普通动作
    { action: 'MANUAL_FULFILL', permission: 'payment:order:refund', actionLabel: '手工补发权益' },
  ],
  REFUND: [
    { action: 'CREATE', permission: 'payment:order:refund', actionLabel: '创建退款单' },
    { action: 'UPDATE', permission: 'payment:order:refund', actionLabel: '更新退款单' },
  ],
  USER: [
    { action: 'UPDATE', permission: 'user:user:write', actionLabel: '修改用户（封禁/解封）' },
    { action: 'DELETE', permission: 'user:user:write', actionLabel: '删除用户' },
  ],
  QUESTION: [
    { action: 'CREATE', permission: 'test:question:write', actionLabel: '新建题目' },
    { action: 'UPDATE', permission: 'test:question:write', actionLabel: '修改题目' },
    { action: 'DELETE', permission: 'test:question:write', actionLabel: '删除题目' },
    { action: 'IMPORT', permission: 'test:question:write', actionLabel: '批量导入题目' },
    { action: 'PUBLISH', permission: 'test:question:write', actionLabel: '上架题目' },
    { action: 'UNPUBLISH', permission: 'test:question:write', actionLabel: '下架题目' },
  ],
  TEST_DEFINITION: [
    { action: 'CREATE', permission: 'test:definition:write', actionLabel: '新建测试定义' },
    { action: 'UPDATE', permission: 'test:definition:write', actionLabel: '修改测试定义' },
    { action: 'DELETE', permission: 'test:definition:write', actionLabel: '删除测试定义' },
    { action: 'PUBLISH', permission: 'test:definition:write', actionLabel: '上架测试定义' },
    { action: 'UNPUBLISH', permission: 'test:definition:write', actionLabel: '下架测试定义' },
  ],
  REPORT: [{ action: 'EXPORT', permission: 'report:report:read', actionLabel: '导出报告数据' }],
  // 关系域目前没有管理端写接口写审计（§3.14 未提供），保留空表以便后续补齐
  RELATIONSHIP: [],
};

/** 反推结果 */
export interface ResolvedAuditAction {
  /** 契约的 `action` 字段 */
  readonly permission: string;
  /** 契约的 `actionLabel` 字段 */
  readonly actionLabel: string;
  /** 契约的 `severity` 字段 */
  readonly severity: AuditSeverity;
}

/**
 * 反推一条审计记录的权限点 / 中文动作名 / 风险等级
 *
 * 未命中规则时**不抛错也不猜**：权限点用 `${resourceType}:${action.toLowerCase()}`
 * 回退（足够唯一，便于前端分组），中文名回退到动作枚举的中文表，等级为 `NORMAL`。
 * 抛错会让整页审计因一条陌生记录而 500 —— 审计页最不该出现的就是「查不了」。
 */
export const resolveAuditAction = (resourceType: string, action: AuditActionName): ResolvedAuditAction => {
  const targetType = toTargetType(resourceType);
  const rule = targetType === null ? undefined : ACTION_RULES[targetType].find((item) => item.action === action);

  if (rule) {
    return {
      permission: rule.permission,
      actionLabel: rule.actionLabel,
      severity: severityOfPermission(rule.permission),
    };
  }

  const permission = `${resourceType}:${action.toLowerCase()}`;

  return {
    permission,
    actionLabel: AUDIT_ACTION_LABELS[action],
    severity: severityOfPermission(permission),
  };
};

/** 过滤条件用的一对（资源类型别名集合 + 动作） */
export interface AuditFilterPair {
  readonly resourceTypes: readonly string[];
  readonly action: AuditActionName;
}

/**
 * 权限点 → 过滤候选对
 *
 * `action` 查询参数收的是**权限点**，而 SQL 里只有 `(action, resourceType)`，
 * 因此要把权限点展开成候选对。一个权限点可能对应多对（例如
 * `system:config:write` 对应 `CONFIG_CHANGE` 与 `UPDATE` 两个动作），
 * 调用方用 `OR` 把它们并发出去。
 *
 * 返回空数组表示「无法反推」，调用方应按 `resourceType` 精确匹配兜底。
 */
export const permissionFilterPairs = (permission: string): readonly AuditFilterPair[] => {
  const normalized = permission.trim().toLowerCase();
  const pairs: AuditFilterPair[] = [];

  for (const targetType of AUDIT_TARGET_TYPES) {
    for (const rule of ACTION_RULES[targetType]) {
      if (rule.permission.toLowerCase() !== normalized) continue;

      pairs.push({ resourceTypes: TARGET_TYPE_RESOURCE_TYPES[targetType], action: rule.action });
    }
  }

  return pairs;
};

/**
 * 风险等级 → 过滤候选对
 *
 * `CRITICAL` / `SENSITIVE` 可以直接展开为 `OR` 条件；`NORMAL` 是补集，
 * 调用方要用 `NOT (CRITICAL OR SENSITIVE)` 表达（见 Service）。
 * 二者必须由**同一张表**推导，否则会出现「按 NORMAL 过滤查不到、按 CRITICAL
 * 过滤能查到」的重叠/漏项。
 */
export const severityFilterPairs = (severity: AuditSeverity): readonly AuditFilterPair[] => {
  const pairs: AuditFilterPair[] = [];

  for (const targetType of AUDIT_TARGET_TYPES) {
    for (const rule of ACTION_RULES[targetType]) {
      if (severityOfPermission(rule.permission) !== severity) continue;

      pairs.push({ resourceTypes: TARGET_TYPE_RESOURCE_TYPES[targetType], action: rule.action });
    }
  }

  return pairs;
};

// ============================================================================
// 结果反解 / 其它契约常量
// ============================================================================

/**
 * `DENIED` 的判定依据：`PERMISSION_DENIED`（20009）
 *
 * 表里没有 `result` 列，只有 `success` + `errorCode`，`DENIED`（越权尝试）
 * 只能靠错误码识别 —— 契约业务规则 3 说它是安全审计的重要信号，所以这个
 * 常量在**过滤**与**展示**两处必须一致。
 */
export const DENIED_ERROR_CODE = String(ErrorCode.PERMISSION_DENIED);

/** 由 `success` + `errorCode` 反解契约的 `result` */
export const resolveAuditResult = (success: boolean, errorCode: string | null): AuditResult => {
  if (success) return 'SUCCESS';
  return errorCode === DENIED_ERROR_CODE ? 'DENIED' : 'FAILED';
};

/** 时间范围上限（契约 §3.14.9.3：范围 ≤ 90 天） */
export const AUDIT_MAX_RANGE_DAYS = 90;

/** 时间范围上限（毫秒），避免每次比较都算一遍 */
export const AUDIT_MAX_RANGE_MS = AUDIT_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** `sortBy` 白名单（契约 §3.14.9.3 只有 `createdAt`） */
export const AUDIT_SORT_FIELDS = ['createdAt'] as const;

export type AuditSortField = (typeof AUDIT_SORT_FIELDS)[number];

/** 排序方向（契约：`asc` | `desc`，默认 `desc`） */
export const AUDIT_SORT_ORDERS = ['asc', 'desc'] as const;

export type AuditSortOrder = (typeof AUDIT_SORT_ORDERS)[number];

/** 趋势图的窗口长度（契约 §3.14.9.3：`endTime` 所在日往前 7 天） */
export const AUDIT_TREND_DAYS = 7;

/** 摘要 Top 榜长度（契约 `byAction` / `byOperator` 示例各 3~6 条，这里取前 10） */
export const AUDIT_SUMMARY_TOP_N = 10;

/** 保留期提示（契约 §3.14.9.3 原文，逐字照抄） */
export const RETENTION_NOTICE = '审计日志保留 1 年（法定合规要求）；超过保留期的日志将归档至冷存储。';

/** UUID 形态校验（契约里 `operatorAdminId` / `targetId` 最终落在 `@db.Uuid` 列上） */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一天（毫秒） */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 取 UTC 当日零点（契约的 `weeklyTrend` 按 UTC 分桶） */
export const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** UTC 日期键 `YYYY-MM-DD`（`toISOString` 本身就是 UTC，无需手写补零） */
export const toUtcDateKey = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * 解析裸动作名（大小写不敏感，接受 `refund` / `REFUND` 两种写法）
 *
 * 返回**归一后**的动作名而非布尔值：契约的 `action` 参数允许传裸动作名，
 * 而表里存的是大写枚举，用返回布尔值的 `is` 断言会把调用方引向
 * 「用原始小写串去查库」的写法（永远查不到）。
 *
 * 这里的 `as AuditActionName` 无法避免：`hasOwnProperty` 不做类型收窄，
 * 而 `Record` 的键集合在运行时就是这 16 个值（由上面的类型声明保证）。
 */
export const parseAuditActionName = (value: string): AuditActionName | null => {
  const upper = value.trim().toUpperCase();

  return Object.prototype.hasOwnProperty.call(AUDIT_ACTION_LABELS, upper) ? (upper as AuditActionName) : null;
};
