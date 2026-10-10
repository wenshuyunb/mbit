/**
 * @RawResponse() — 跳过统一响应包络
 *
 * 用于 SSE 流、文件下载、第三方回调（微信支付回调要求返回指定结构）等场景。
 */

import { SetMetadata } from '@nestjs/common';
import { RAW_RESPONSE_KEY } from '../interceptors/transform.interceptor';

export const RawResponse = (): MethodDecorator => SetMetadata(RAW_RESPONSE_KEY, true);
