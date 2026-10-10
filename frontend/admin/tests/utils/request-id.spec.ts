/**
 * 请求追踪 ID 单元测试
 *
 * 覆盖重点：
 *   - 生成的 ID 必须符合后端 `CLIENT_ID_PATTERN`（`^[A-Za-z0-9_-]{8,64}$`），
 *     否则服务端会忽略客户端值并重新生成，链路追踪失效；
 *   - 优先使用 crypto.randomUUID，不可用时退化为 UUID v4 形态且仍然合法；
 *   - 每次调用都必须产生新 ID（否则无法定位单次请求）。
 */

import { describe, expect, it, vi } from 'vitest';
import { REQUEST_ID_HEADER, REQUEST_ID_PREFIX, generateRequestId, isValidRequestId } from '@/utils/request-id';

/** UUID v4 形态（版本位 4、变体位 8/9/a/b） */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('utils/request-id', () => {
  it('请求头名称与后端一致', () => {
    expect(REQUEST_ID_HEADER).toBe('X-Request-Id');
    expect(REQUEST_ID_PREFIX).toBe('req_');
  });

  it('生成的请求 ID 符合后端白名单格式', () => {
    const requestId = generateRequestId();

    expect(requestId.startsWith(REQUEST_ID_PREFIX)).toBe(true);
    expect(isValidRequestId(requestId)).toBe(true);
    expect(UUID_V4_PATTERN.test(requestId.slice(REQUEST_ID_PREFIX.length))).toBe(true);
  });

  it('优先使用 crypto.randomUUID', () => {
    vi.stubGlobal('crypto', { randomUUID: (): string => '11111111-2222-4333-8444-555555555555' });

    expect(generateRequestId()).toBe(`${REQUEST_ID_PREFIX}11111111-2222-4333-8444-555555555555`);

    vi.unstubAllGlobals();
  });

  it('crypto.randomUUID 不可用时退化为 UUID v4 形态，且仍然合法', () => {
    vi.stubGlobal('crypto', {});

    const requestId = generateRequestId();

    expect(UUID_V4_PATTERN.test(requestId.slice(REQUEST_ID_PREFIX.length))).toBe(true);
    expect(isValidRequestId(requestId)).toBe(true);

    vi.unstubAllGlobals();
  });

  it('连续多次调用互不相同（保证可独立追踪每次请求）', () => {
    const ids = new Set<string>(Array.from({ length: 500 }, () => generateRequestId()));
    expect(ids.size).toBe(500);
  });

  it('格式校验规则与后端一致（长度 8–64、仅字母数字与下划线连字符）', () => {
    expect(isValidRequestId('req_01HQ8Z3K7M2XQ9V4T6B1NDCFA5')).toBe(true);
    expect(isValidRequestId('short')).toBe(false);
    expect(isValidRequestId('带中文的请求标识123456')).toBe(false);
    expect(isValidRequestId('has space in it')).toBe(false);
    expect(isValidRequestId('a'.repeat(65))).toBe(false);
  });
});
