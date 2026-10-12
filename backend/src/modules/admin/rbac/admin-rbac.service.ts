/**
 * AdminRbacService — 解析管理员的角色与权限点
 *
 * 权限来源是**数据库**（`admin_user_roles` → `role_permissions` → `permissions`），
 * 而不是写死在代码里：契约 §3.14.1.1 要求登录响应返回 `permissions` 数组，
 * 且 §3.14 提供了角色管理接口（`PATCH /admin/roles/{id}`），意味着权限可被运营调整。
 * 代码里只保留「内置角色 → 权限」的**初始映射**（seed 用），运行期一律查库。
 *
 * 临时授权：`admin_user_roles.expiresAt` 支持「临时授予某角色」，
 * 解析时必须过滤掉已过期的授予，否则临时权限会变成永久权限。
 */

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  ADMIN_ROLES,
  ADMIN_ROLE_NAMES,
  ALL_ADMIN_PERMISSIONS,
  PERMISSION_WILDCARD,
} from './admin-permission.constants';

/** 角色摘要（登录响应 `admin.roles`） */
export interface AdminRoleBrief {
  roleCode: string;
  roleName: string;
  /** 该角色授予的权限点数量 */
  permissionCount: number;
}

/** 解析结果 */
export interface AdminGrant {
  /** 角色码（用于 `@Roles` 判定） */
  roles: string[];
  /** 扁平化后的权限点（用于 `@RequirePermission` 判定） */
  permissions: string[];
  /** 角色明细（用于登录响应展示） */
  roleBriefs: AdminRoleBrief[];
}

@Injectable()
export class AdminRbacService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 解析某管理员的角色码与权限点
   *
   * @param isSuperAdmin 为 `true` 时直接返回通配权限，不再查库 ——
   *   `SUPER_ADMIN` 的语义是「全部权限」，若依赖角色表配置，一旦运营误删了
   *   超管角色的权限行，系统就再也没人能改回来了（自锁死）
   */
  async resolve(adminUserId: string, isSuperAdmin: boolean): Promise<AdminGrant> {
    if (isSuperAdmin) {
      return {
        roles: ['SUPER_ADMIN'],
        permissions: [PERMISSION_WILDCARD],
        roleBriefs: [
          {
            roleCode: 'SUPER_ADMIN',
            roleName: ADMIN_ROLE_NAMES.SUPER_ADMIN,
            // 通配符不是「一个权限」，对外展示应为系统全部权限点的数量
            permissionCount: ALL_ADMIN_PERMISSIONS.length,
          },
        ],
      };
    }

    const now = new Date();

    const grants = await this.prisma.adminUserRole.findMany({
      where: {
        adminUserId,
        // 临时授予过期即失效；未设置 expiresAt 表示永久授予
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: {
        role: {
          select: {
            code: true,
            name: true,
            deletedAt: true,
            permissions: {
              select: { permission: { select: { code: true } } },
            },
          },
        },
      },
    });

    const roles = new Set<string>();
    const permissions = new Set<string>();
    const roleBriefs: AdminRoleBrief[] = [];

    for (const grant of grants) {
      // 已软删的角色不再产生任何权限
      if (grant.role.deletedAt !== null) continue;

      roles.add(grant.role.code);

      const codes = grant.role.permissions.map((rp) => rp.permission.code);
      for (const code of codes) {
        permissions.add(code);
      }

      roleBriefs.push({
        roleCode: grant.role.code,
        roleName: grant.role.name,
        // 角色自身配了通配符时，其等效权限数是全部权限点
        permissionCount: codes.includes(PERMISSION_WILDCARD) ? ALL_ADMIN_PERMISSIONS.length : codes.length,
      });
    }

    // 防御：若某角色被配上通配符（例如运营手工把 SUPER_ADMIN 的 `*` 复制给了别的角色），
    // 只保留通配符，避免下游出现「既有 * 又有一堆具体权限」的混乱状态
    const permissionList = permissions.has(PERMISSION_WILDCARD) ? [PERMISSION_WILDCARD] : [...permissions].sort();

    return {
      roles: [...roles].sort(),
      permissions: permissionList,
      roleBriefs: roleBriefs.sort((a, b) => a.roleCode.localeCompare(b.roleCode)),
    };
  }

  /** 判断角色码是否是内置角色（角色管理接口用，内置角色不允许删除） */
  isBuiltinRole(roleCode: string): boolean {
    return (ADMIN_ROLES as readonly string[]).includes(roleCode);
  }
}
