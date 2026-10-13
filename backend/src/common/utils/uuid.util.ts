/**
 * UUID 形状校验（服务端）
 *
 * ## 为什么不用 class-validator 的 `@IsUUID()`
 *
 * 本仓库主键是 **UUIDv7**，而 `validator` 库的 `isUUID` 只认 v1–v5（不传版本时
 * 亦然）—— 用它会**把全部合法请求判成 400**，而不是只拦住非法值。
 * 这一点已由两处单测守住：`admin-audit-log-query.dto.spec.ts`
 *（「UUIDv7 必须通过：class-validator 的 isUUID 只认 v1–v5」）与
 * `report-engagement.dto.ts` 的注释（同一结论）。
 * 因此这里只校验**形状**（8-4-4-4-12 十六进制），既拦得住明显非法值，
 * 又不绑定版本。
 *
 * ## 为什么必须在进库前拦（而不是交给 PostgreSQL）
 *
 * 非法 UUID 走进 Prisma 的 `where: { id }` 时，PostgreSQL 会直接抛类型错误
 *（`invalid input syntax for type uuid`），被全局异常过滤器翻译成
 * **`90002` 数据服务异常 / HTTP 500** —— 用户看到「服务端坏了」，排障的人看到
 * 一条 SQL 报错，而真正的原因只是**路径参数写错了**。契约对这类入参明确要求
 * `400 / 10001`（见 §3.5.3 `GET /reports/{id}` 的错误码表）。
 *
 * ## 收敛范围（刻意的边界）
 *
 * 这个模式目前在仓库里仍有多份**局部副本**：`admin/audit-log` 常量里的
 * `UUID_PATTERN`，以及 `admin-user` / `admin-role` / `admin-order` /
 * `order-query.service` / `refund.service` 里的同名常量。
 * 本文件作为**新代码的唯一来源**，报告模块的两个 ID DTO 已改用它；
 * 其余副本的收敛单独做 —— 一次改 8 个管理端文件属于无关重构，
 * 会把「修一个缺失的入参校验」变成「动一遍管理端」，风险与收益不成正比。
 */

/**
 * UUID 形状（8-4-4-4-12 十六进制）
 *
 * 注意**不加 `g` 标志**：带 `g` 的正则 `.test()` 会因 `lastIndex` 在多次调用间
 * 残留而间歇性返回 `false`，这是校验器里最隐蔽的一类「时灵时不灵」缺陷。
 */
export const UUID_SHAPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 是否为 UUID 形状（不校验版本，因此 UUIDv7 通过） */
export const isUuidShape = (value: string): boolean => UUID_SHAPE_PATTERN.test(value);
