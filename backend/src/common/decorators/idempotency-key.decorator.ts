/**
 * @IdempotencyKey() — 提取并校验客户端幂等键
 *
 * 契约约定（API_DESIGN §2.5）：标记为必须幂等的写接口（如提交注销申请、下单）
 * 需要客户端在 `X-Idempotency-Key` 中传入唯一键；缺失时返回 `IDEMPOTENCY_KEY_MISSING`。
 *
 * 校验规则（与前端 `createIdempotencyKey()` 的产物对齐）：
 *   · 长度 8–64
 *   · 字符白名单 `[A-Za-z0-9_-]` —— 防止把任意内容（含换行）写进 Redis 键
 */

import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-code';
import type { RequestWithContext } from '../types/request.type';

/** 幂等键请求头 */
export const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';

/** 幂等键格式（与前端生成器保持一致） */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 从请求头取出幂等键
 *
 * @param required 为 true 时缺失即报错（默认 true，与「必须幂等」的接口语义一致）
 */
export const IdempotencyKey = createParamDecorator(
  (required: boolean | undefined, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<RequestWithContext>();
    const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (value === undefined || value.trim() === '') {
      if (required === false) return undefined;
      throw BusinessException.badRequest(ErrorCode.IDEMPOTENCY_KEY_MISSING, '缺少幂等键 X-Idempotency-Key');
    }

    if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw BusinessException.badRequest(
        ErrorCode.PARAM_INVALID,
        'X-Idempotency-Key 格式不合法（8–64 位字母/数字/下划线/连字符）',
      );
    }

    return value;
  },
);
