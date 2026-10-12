/**
 * AdminConfigService — 管理端系统配置读写（契约 §3.14.9.1 / §3.14.9.2）
 *
 * ## 为什么复用 `SystemConfigService` 而不是自己查库
 *
 * 配置的「读取口径」（目录语义、环境变量锁定、兜底默认值、内容哈希版本号）与
 * 「缓存失效」必须只有一份实现。管理端如果自己拼 SQL 再自己删缓存，
 * 就会出现「后台看到的默认值和前台下发的不一样」以及「删了缓存键名但前台用的是另一个键」
 * 这两类只有线上才发现的问题。因此本服务只负责**管理端特有的逻辑**：
 * 分组展示、字段级校验、试运行、事务写入、审计与影响评估。
 *
 * ## 事务边界
 *
 * 契约 §3.14.9.2 规则 1 要求「全部成功或全部回滚」。多键更新落在**单个 Prisma 事务**里，
 * 任何一项校验失败都在事务外提前抛出 —— 校验失败时根本不进事务，
 * 避免用异常控制事务回滚（回滚会消耗连接并让错误归因变模糊）。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigValueType, Prisma } from '@prisma/client';

import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import {
  CONFIG_DEFINITION_MAP,
  CONFIG_GROUPS,
  CONFIG_GROUP_FILTERS,
  CONFIG_GROUP_NAMES,
  isConfigGroup,
  type ConfigGroup,
} from '../../system/system-config.catalog';
import { SystemConfigService, type ResolvedConfigEntry } from '../../system/system-config.service';
import { normalizeConfigValue, type ConfigValueValidation } from '../../system/system-config.util';

/** 环境变量锁定项的提示（契约 §3.14.9.1 规则 1） */
const ENV_LOCKED_NOTE = '被环境变量锁定的配置（envOverride 非空）在后台只读，需通过部署修改。';

/** 审计中保存的历史条目（`GET /admin/configs?includeHistory=true` 的数据来源） */
interface ConfigHistoryEntry {
  at: string;
  by: string;
  before: unknown;
  after: unknown;
  changeNote: string | null;
}

export interface AdminConfigListQuery {
  group?: string;
  keys?: string;
  includeHistory?: boolean;
}

export interface AdminConfigUpdateInput {
  items: ReadonlyArray<{ key: string; value: unknown; changeNote?: string }>;
  dryRun?: boolean;
  invalidateCaches?: boolean;
}

/** 管理端写操作的请求上下文（审计与响应回显用） */
export interface AdminConfigActor {
  adminUserId: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

@Injectable()
export class AdminConfigService {
  private readonly logger = new Logger(AdminConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigs: SystemConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  // ==========================================================================
  // 查询：GET /admin/configs
  // ==========================================================================

  async list(query: AdminConfigListQuery): Promise<Record<string, unknown>> {
    const snapshot = await this.systemConfigs.getSnapshot();
    const includeHistory = query.includeHistory === true;

    const groups = this.parseGroups(query.group);
    const keyFilter = this.parseKeys(query.keys);

    const entries = snapshot.entries.filter((entry) => {
      if (groups !== null && !groups.includes(entry.group as ConfigGroup)) return false;
      if (keyFilter !== null && !keyFilter.has(entry.key)) return false;
      return true;
    });

    const names = await this.resolveAdminNames(
      entries.map((entry) => entry.updatedByAdminId).filter((id): id is string => id !== null),
    );
    const history = includeHistory ? await this.loadHistory(entries.map((entry) => entry.key)) : new Map();

    const grouped = CONFIG_GROUPS.filter((group) => entries.some((entry) => entry.group === group)).map((group) => ({
      group,
      groupName: CONFIG_GROUP_NAMES[group],
      items: entries.filter((entry) => entry.group === group).map((entry) => this.toListItem(entry, names, history)),
    }));

    return {
      configVersion: snapshot.version,
      groups: grouped,
      totalItems: entries.length,
      editableItems: entries.filter((entry) => entry.isEditable).length,
      envLockedItems: entries.filter((entry) => entry.envOverride !== null).length,
      envLockedNote: ENV_LOCKED_NOTE,
      serverTime: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // 更新：PUT /admin/configs
  // ==========================================================================

  async update(input: AdminConfigUpdateInput, actor: AdminConfigActor): Promise<Record<string, unknown>> {
    const dryRun = input.dryRun === true;
    const invalidateCaches = input.invalidateCaches !== false;

    // 强制回源读取：如果读到缓存，`before` 与 `previousConfigVersion` 可能是过期值，
    // 会让审计里的「变更前」与实际落库值不符（审计失真比慢几十毫秒严重得多）
    const before = await this.systemConfigs.getSnapshot(true);
    const beforeMap = new Map(before.entries.map((entry) => [entry.key, entry]));

    const plans = input.items.map((item) => this.buildPlan(item, beforeMap));

    const admin = await this.prisma.adminUser.findFirst({
      where: { id: actor.adminUserId, deletedAt: null },
      select: { username: true, nickname: true },
    });

    const displayName = admin?.nickname ?? admin?.username ?? '未知管理员';

    const beforeValues: Record<string, unknown> = {};
    const afterValues: Record<string, unknown> = {};
    for (const plan of plans) {
      beforeValues[plan.key] = plan.before;
      afterValues[plan.key] = plan.after;
    }

    if (dryRun) {
      /**
       * 试运行：契约只说「不写入并返回 before/after」。这里把 `updatedCount` 记为 0，
       * 另给 `wouldUpdateCount` —— 若把「会改几条」也写成 `updatedCount`，
       * 调用方很容易误以为已经写进去了。
       */
      return {
        dryRun: true,
        updatedCount: 0,
        wouldUpdateCount: plans.length,
        configVersion: before.version,
        previousConfigVersion: before.version,
        items: plans.map((plan) => this.toUpdateItem(plan)),
        cacheInvalidation: { invalidatedKeys: [], note: '试运行未写入，缓存无需失效。' },
        impactAssessment: this.buildImpactAssessment(plans.map((plan) => plan.key)),
        updatedAt: new Date().toISOString(),
        updatedBy: { adminId: actor.adminUserId, displayName },
        auditLogId: null,
      };
    }

    const now = new Date();

    await this.prisma.$transaction(
      async (tx) => {
        for (const plan of plans) {
          const definition = CONFIG_DEFINITION_MAP.get(plan.key);
          if (!definition) continue;

          await tx.systemConfig.upsert({
            where: { key: plan.key },
            create: {
              key: plan.key,
              value: plan.rawValue,
              valueType: definition.valueType,
              group: definition.group,
              description: definition.description,
              isPublic: definition.isPublic,
              isEditable: true,
              updatedByAdminId: actor.adminUserId,
            },
            update: {
              value: plan.rawValue,
              // 同步目录里的元信息：键迁移分组或描述变更后，库里的行不应仍是旧语义
              valueType: definition.valueType,
              group: definition.group,
              description: definition.description,
              isPublic: definition.isPublic,
              // 历史软删行必须复活，否则「键被删过」会让后续更新永远不生效
              deletedAt: null,
              updatedByAdminId: actor.adminUserId,
              version: { increment: 1 },
            },
          });
        }
      },
      { timeout: 10_000 },
    );

    const invalidatedKeys = invalidateCaches ? await this.systemConfigs.invalidate('admin_update_configs') : [];

    // 写入后强制回源：响应里的 configVersion 必须与落库内容一致，
    // 否则前端会拿一个「查不到对应内容」的版本号去比对缓存
    const after = await this.systemConfigs.getSnapshot(true);

    const changeNotes = plans
      .map((plan) => (plan.changeNote ? `${plan.key}: ${plan.changeNote}` : null))
      .filter((note): note is string => note !== null);

    await this.audit.log({
      adminUserId: actor.adminUserId,
      adminUsername: admin?.username ?? actor.adminUserId,
      action: 'CONFIG_CHANGE',
      resourceType: 'CONFIG',
      // 经 JSON 往返归一：审计列是 JsonB，配置值可能是任意 JSON，
      // 这里同时充当「可序列化」的强制校验（不可序列化的值会在这一步被剔除而非写库时才失败）
      beforeData: toJsonPayload({ items: plans.map((plan) => ({ key: plan.key, value: plan.before })) }),
      afterData: toJsonPayload({
        items: plans.map((plan) => ({ key: plan.key, value: plan.after, changeNote: plan.changeNote ?? null })),
      }),
      diffSummary: this.audit.buildDiffSummary(beforeValues, afterValues),
      reason: changeNotes.length > 0 ? changeNotes.join('; ') : null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
      success: true,
    });

    this.logger.log(
      `系统配置已更新 count=${plans.length} by=${displayName} version=${before.version}→${after.version}`,
    );

    return {
      dryRun: false,
      updatedCount: plans.length,
      configVersion: after.version,
      previousConfigVersion: before.version,
      items: plans.map((plan) => this.toUpdateItem(plan)),
      cacheInvalidation: {
        invalidatedKeys,
        note:
          invalidatedKeys.length > 0
            ? '配置缓存已失效，客户端在下次请求 GET /system/config 时获取新值（前端本地 TTL 1h 内可能仍展示旧值）'
            : '未失效缓存（invalidateCaches=false 或缓存服务不可用），新值将在缓存 TTL（300s）到期后生效',
      },
      impactAssessment: this.buildImpactAssessment(plans.map((plan) => plan.key)),
      updatedAt: now.toISOString(),
      updatedBy: { adminId: actor.adminUserId, displayName },
      // AdminAuditService.log 只回传布尔值（审计是旁路，不阻塞业务），因此这里没有 id 可回填
      auditLogId: null,
    };
  }

  // ==========================================================================
  // 内部：校验与计划
  // ==========================================================================

  /** 单项更新的完整计划（校验结果 + 归一化值 + before/after） */
  private buildPlan(
    item: { key: string; value: unknown; changeNote?: string },
    beforeMap: ReadonlyMap<string, ResolvedConfigEntry>,
  ): ConfigUpdatePlan {
    const entry = beforeMap.get(item.key);

    if (!entry) {
      /**
       * 契约 §3.14.9.2 用 `90010` 表示「key 不存在」，本仓库没有该码；
       * `90008 CONFIG_MISSING` 是最近的同域错误码（配置类），配合 404 状态返回，
       * 语义上正是「你给的配置键没有」。
       */
      throw BusinessException.notFound(ErrorCode.CONFIG_MISSING, `配置键 ${item.key} 不存在`);
    }

    if (entry.envOverride !== null) {
      throw BusinessException.forbidden(
        ErrorCode.OPERATION_FORBIDDEN,
        `配置键 ${item.key} 由环境变量 ${entry.envOverride} 锁定，请通过部署修改`,
      );
    }

    if (!entry.isEditable) {
      throw BusinessException.forbidden(
        ErrorCode.OPERATION_FORBIDDEN,
        `配置键 ${item.key} 为只读项（未纳入配置目录或已被标记不可编辑）`,
      );
    }

    const definition = CONFIG_DEFINITION_MAP.get(item.key);
    if (!definition) {
      throw BusinessException.forbidden(ErrorCode.OPERATION_FORBIDDEN, `配置键 ${item.key} 不在可编辑目录中`);
    }

    const normalized = normalizeConfigValue(definition, item.value);

    if ('errors' in normalized) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        `配置键 ${item.key} 的值不合法`,
        normalized.errors.map((issue) => ({ field: item.key, issue, value: item.value })),
      );
    }

    return {
      key: item.key,
      valueType: definition.valueType,
      context: definition.description,
      before: entry.value,
      after: item.value,
      rawValue: normalized.rawValue,
      changeNote: item.changeNote ?? null,
      validation: { isValid: true, errors: [] },
    };
  }

  /** 列表项（契约 §3.14.9.1 items[]） */
  private toListItem(
    entry: ResolvedConfigEntry,
    names: ReadonlyMap<string, string>,
    history: ReadonlyMap<string, ConfigHistoryEntry[]>,
  ): Record<string, unknown> {
    const item: Record<string, unknown> = {
      key: entry.key,
      label: entry.label,
      value: entry.value,
      valueType: entry.valueType,
      description: entry.description,
      isEditable: entry.isEditable,
      requiresConfirmPassword: entry.requiresConfirmPassword,
      envOverride: entry.envOverride,
      impactScope: entry.impactScope,
      updatedAt: entry.updatedAt,
      updatedBy: entry.updatedByAdminId ? (names.get(entry.updatedByAdminId) ?? '未知管理员') : '系统',
    };

    // 数值型才下发区间，避免前端对文案类配置也渲染滑块
    if (entry.valueType === ConfigValueType.NUMBER) {
      item.min = entry.min;
      item.max = entry.max;
    }

    const entries = history.get(entry.key);
    if (entries) item.history = entries;

    return item;
  }

  /** 更新项（契约 §3.14.9.2 items[]） */
  private toUpdateItem(plan: ConfigUpdatePlan): Record<string, unknown> {
    return {
      key: plan.key,
      valueType: plan.valueType,
      before: plan.before,
      after: plan.after,
      changeNote: plan.changeNote,
      validation: plan.validation,
    };
  }

  /**
   * 分组解析
   *
   * 契约示例是 `?group=FEATURE_FLAG,LIMIT`（逗号分隔），因此按多值处理；
   * `ALL` 或省略表示不过滤。非法值直接 400 —— 静默忽略非法分组会让调用方
   * 以为「查了全部」而实际只查到一部分。
   */
  private parseGroups(group: string | undefined): ConfigGroup[] | null {
    if (!group || group.trim().length === 0) return null;

    const requested = [
      ...new Set(
        group
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    ];

    if (requested.includes('ALL')) return null;

    const invalid = requested.filter((value) => !isConfigGroup(value));
    if (invalid.length > 0) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        'group 取值不合法',
        invalid.map((value) => ({ field: 'group', issue: `不支持的配置分组：${value}`, value })),
      );
    }

    return requested.filter(isConfigGroup);
  }

  /** 键白名单解析（契约：≤ 50 个） */
  private parseKeys(keys: string | undefined): Set<string> | null {
    if (!keys || keys.trim().length === 0) return null;

    const requested = [
      ...new Set(
        keys
          .split(',')
          .map((key) => key.trim())
          .filter((key) => key.length > 0),
      ),
    ];

    if (requested.length > 50) {
      /**
       * 契约此处的错误码是 `10016`，本仓库没有该码（`10016` 未被定义、
       * 现有区间也无可复用的语义），故用 `10001 PARAM_INVALID` + 明确文案。
       */
      throw BusinessException.badRequest(ErrorCode.PARAM_INVALID, 'keys 最多 50 个');
    }

    return new Set(requested);
  }

  /** 批量取管理员展示名（避免逐条查询造成 N+1） */
  private async resolveAdminNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    try {
      const admins = await this.prisma.adminUser.findMany({
        where: { id: { in: unique } },
        select: { id: true, username: true, nickname: true },
      });

      return new Map(admins.map((admin) => [admin.id, admin.nickname ?? admin.username]));
    } catch (error) {
      // 展示名解析失败不应让配置列表不可用（列表本身的价值远大于某一列的名字）
      this.logger.warn(`解析配置更新人失败: ${(error as Error).message}`);
      return new Map();
    }
  }

  /**
   * 变更历史（契约 §3.14.9.1 `includeHistory`）
   *
   * 本项目**没有**配置专用的历史表，但每次配置变更都写入了 `admin_audit_logs`
   *（`resourceType = 'CONFIG'`、`action = 'CONFIG_CHANGE'`，`afterData.items` 保留了
   * 每项的 before/after/changeNote）。因此历史直接由审计表还原 —— 好处是文案「谁在何时
   * 改了什么」与审计完全同源，不会出现两套记录互相矛盾。
   */
  private async loadHistory(keys: readonly string[]): Promise<Map<string, ConfigHistoryEntry[]>> {
    const result = new Map<string, ConfigHistoryEntry[]>();
    if (keys.length === 0) return result;

    const wanted = new Set(keys);

    try {
      const logs = await this.prisma.adminAuditLog.findMany({
        where: { resourceType: 'CONFIG', action: 'CONFIG_CHANGE' },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { adminUsername: true, beforeData: true, afterData: true, createdAt: true },
      });

      for (const log of logs) {
        const afterItems = readItems(log.afterData);
        const beforeItems = readItems(log.beforeData);

        for (const item of afterItems) {
          if (!wanted.has(item.key)) continue;

          const bucket = result.get(item.key) ?? [];
          // 每条配置只保留最近 5 次（契约 §3.14.9.1）
          if (bucket.length >= 5) continue;

          bucket.push({
            at: log.createdAt.toISOString(),
            by: log.adminUsername,
            before: beforeItems.find((candidate) => candidate.key === item.key)?.value ?? null,
            after: item.value,
            changeNote: item.changeNote,
          });

          result.set(item.key, bucket);
        }
      }
    } catch (error) {
      this.logger.warn(`读取配置变更历史失败，本次不返回 history: ${(error as Error).message}`);
    }

    return result;
  }

  /**
   * 影响评估（契约 §3.14.9.2 规则 4）
   *
   * 逐项说明是契约的硬要求：运营在后台点「保存」时必须知道「已生成的报告不会回溯」，
   * 否则会出现「改了比例但老报告没变」的工单。
   */
  private buildImpactAssessment(keys: readonly string[]): Record<string, unknown> {
    const notes = keys.map((key) => {
      if (key === 'reportFreePreviewRatio') {
        return `${key} 影响新生成的报告；已生成报告的预览按生成时比例裁剪，不回溯调整。`;
      }
      if (key === 'memberAiDailyLimit' || key === 'freeAiQuotaTotal') {
        return `${key} 对当日已用配额立即生效（剩余次数相应增加）。`;
      }
      if (key.startsWith('FEATURE_')) {
        return `${key} 为新请求即时生效；客户端需重新拉取配置（最长 60 分钟）后入口才会变化。`;
      }
      if (key.startsWith('disclaimer.')) {
        return `${key} 为合规文案，变更会影响所有用户的展示，请确认已通过合规审核。`;
      }
      if (key.startsWith('policy.version.')) {
        return `${key} 变更后，客户端提交旧版本同意书会得到 30017，需要用户重新阅读并确认。`;
      }
      if (key === 'maintenanceMode') {
        return 'maintenanceMode 开启后写接口返回 90007；配置读取接口仍返回 200，保证维护公告可展示。';
      }
      return `${key} 对新请求立即生效；客户端本地缓存最长 1h 内可能仍展示旧值。`;
    });

    return {
      affectsNewRequestsOnly: true,
      inFlightRequestsUnaffected: true,
      estimatedClientPropagationMinutes: 60,
      notes,
    };
  }
}

/** 单项更新计划 */
interface ConfigUpdatePlan {
  key: string;
  valueType: ConfigValueType;
  /** 目录里的说明（写库时同步，便于后台查看原始语义） */
  context: string;
  before: unknown;
  after: unknown;
  /** 归一化后的写库字符串 */
  rawValue: string;
  changeNote: string | null;
  validation: ConfigValueValidation;
}

/** 从审计 JSON 中安全取出 items（类型守卫，避免把脏数据当结构用） */
const readItems = (
  value: Prisma.JsonValue | null,
): Array<{ key: string; value: unknown; changeNote: string | null }> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];

  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  return items.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as { key?: unknown; value?: unknown; changeNote?: unknown };
    if (typeof record.key !== 'string') return [];

    return [
      {
        key: record.key,
        value: record.value,
        changeNote: typeof record.changeNote === 'string' ? record.changeNote : null,
      },
    ];
  });
};

/** 供控制器在 Swagger 描述里复用的分组说明 */
export const ADMIN_CONFIG_GROUPS = CONFIG_GROUP_FILTERS;

/**
 * 审计载荷标准化
 *
 * 配置值可以是任意 JSON（`share.templates` 是嵌套对象），而 `AdminAuditService` 的参数
 * 类型刻意收窄为 `Prisma.InputJsonValue`。用 JSON 往返转换而不是 `as` 断言：
 * 断言会把「值不可序列化」的问题推迟到写库时才暴露（那时业务操作已经成功，审计却丢了）。
 */
const toJsonPayload = (payload: Record<string, unknown>): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
