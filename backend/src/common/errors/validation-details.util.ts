/**
 * 校验错误展平工具
 *
 * 全局 ValidationPipe 的 `exceptionFactory` 需要把 class-validator 的
 * `ValidationError[]` 转成对外的字段级明细。
 *
 * 关键点：**必须递归**。嵌套 DTO（如 `answers[].value`）的约束不会出现在顶层
 * 错误的 `constraints` 上，而是挂在 `children` 里。只展平一层会得到空数组，
 * 而 `AllExceptionsFilter` 对空 `details` 会整体省略该字段 —— 客户端因此只看到
 * 「请求参数不合法」，完全不知道哪个字段错了。这条链路真实踩过坑，故抽成
 * 纯函数并单测锁死。
 */

import type { ValidationError } from 'class-validator';

import type { ErrorDetail } from './business.exception';

/**
 * 把 class-validator 的错误树展平为 `{ field, issue }` 明细。
 *
 * 嵌套字段用点号连接并带上数组下标，例如 `answers.0.value`；
 * 同一字段的多个约束会各自产出一条明细。
 */
export function flattenValidationErrors(errors: readonly ValidationError[], prefix = ''): ErrorDetail[] {
  return errors.flatMap((error) => {
    const field = prefix ? `${prefix}.${error.property}` : error.property;

    return [
      ...Object.values(error.constraints ?? {}).map((issue) => ({ field, issue })),
      ...flattenValidationErrors(error.children ?? [], field),
    ];
  });
}
