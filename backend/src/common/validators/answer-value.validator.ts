import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * 答案值 `value` 的形状校验器。
 *
 * 背景（真实缺陷）：`value` 原先只挂了 `@Transform`（class-transformer），没有任何
 * class-validator 装饰器。全局 ValidationPipe 开启了 `whitelist: true` +
 * `forbidNonWhitelisted: true`，而 `whitelist` 依据的是**校验元数据**：
 * 只有 `@Transform` 的属性被视为「非白名单字段」，于是**每一次** `PUT
 * /tests/sessions/{id}/answers` 都被 400 拒绝，答题链路对全部客户端不可用。
 *
 * 契约（API_DESIGN §3.3.5）：值域由「题目类型 + `options[].value`」在服务端判定
 * （越界返回 `40008`），本校验器**只判形状**，不判范围，避免把题型知识上移到 DTO：
 * - 单选题：整数（LIKERT5 为 1–5，BINARY 为 0/1）
 * - 排序题：全部选项 value 的排列 → 非空整数数组
 */
export function IsAnswerValue(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isAnswerValue',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value === 'number') {
            return Number.isInteger(value) && Number.isFinite(value);
          }
          if (Array.isArray(value)) {
            return (
              value.length > 0 &&
              value.every((item) => typeof item === 'number' && Number.isInteger(item) && Number.isFinite(item))
            );
          }
          return false;
        },
        defaultMessage(): string {
          return 'value 必须是整数，或非空的整数数组（排序题传全部选项 value 的排列）';
        },
      },
    });
  };
}
