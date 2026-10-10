/**
 * Prisma 错误判定工具
 *
 * 用途：把数据库层异常归一为业务错误码。典型场景是**并发抢写唯一索引** ——
 * 对用户而言这是「资源已被占用」（409），而不是系统故障（500）。
 * 若让 P2002 冒泡，监控里会出现大量「5xx」，把真正的故障淹没。
 */

/**
 * 判定 Prisma 唯一约束冲突
 *
 * `P2002` 是 Prisma 对「违反 UNIQUE 约束」的固定错误码。
 * 这里用结构判断而非 `instanceof PrismaClientKnownRequestError`：
 * 一是避免在纯函数/工具层引入 Prisma 运行时依赖，
 * 二是测试与 mock 场景下抛出的常是普通对象。
 */
export const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
