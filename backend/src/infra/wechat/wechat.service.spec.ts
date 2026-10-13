/**
 * `WechatService.getMiniAppCode`（微信 `wxacode.getUnlimited`）
 *
 * ## 为什么这个方法的测试要单独写
 *
 * 它有一个**容易写错且后果隐蔽**的点：该接口成功时返回**图片二进制**，
 * 失败时返回 JSON —— 而且失败响应的 HTTP 状态码**仍然是 200**。
 * 因此实现必须按 `Content-Type` 分流；若照抄 `postJson` 去解析 JSON，
 * 成功路径会抛解析错误，表现为"二维码永远生成不了"，而日志里只看到 JSON 解析失败。
 *
 * 第二个点是**失败即降级**：邀请与分享卡都不该因为码生成不了而失败，
 * 所以未配置凭证 / 微信报错 / 空响应体都必须返回 `null` 而不是抛错。
 */

import type { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/config.type';
import type { RedisService } from '../redis/redis.service';
import { WechatService } from './wechat.service';

/** 一张最小的 PNG（只用于"是不是二进制"的判定） */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

interface FetchCall {
  url: string;
  init: { method?: string; body?: string };
}

const createService = (
  options: { configured?: boolean; cachedToken?: string | null } = {},
): {
  service: WechatService;
  redis: RedisService;
} => {
  const configured = options.configured ?? true;

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'wechat.appId') return configured ? 'wx-app-id' : '';
      if (key === 'wechat.appSecret') return configured ? 'wx-app-secret' : '';
      if (key === 'wechat.msgSecCheck') return true;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;

  const redis = {
    key: jest.fn((...parts: string[]) => parts.join(':')),
    // 直接命中缓存令牌，避免把 access_token 的刷新锁也拖进本文件的测试范围
    get: jest.fn().mockResolvedValue(options.cachedToken === undefined ? 'cached-token' : options.cachedToken),
    set: jest.fn().mockResolvedValue(undefined),
    acquireLock: jest.fn().mockResolvedValue('lock-token'),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  } as unknown as RedisService;

  return { service: new WechatService(config, redis), redis };
};

/** 造一个"看起来像图片"的响应 */
const binaryResponse = (body: Buffer): Response =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }) as unknown as Response;

/** 造一个"微信报错"的响应：HTTP 200 + JSON 体 */
const jsonErrorResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  }) as unknown as Response;

describe('WechatService.getMiniAppCode', () => {
  const originalFetch = global.fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const mockFetch = (response: Response): void => {
    global.fetch = jest.fn(async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, init });
      return response;
    }) as unknown as typeof fetch;
  };

  it('未配置微信凭证时返回 null（不抛错，调用方降级即可）', async () => {
    mockFetch(binaryResponse(PNG_BYTES));
    const { service } = createService({ configured: false });

    await expect(service.getMiniAppCode({ scene: 'ABC123' })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('拿不到 access_token 时返回 null', async () => {
    mockFetch(binaryResponse(PNG_BYTES));
    const { service } = createService({ cachedToken: null });

    await expect(service.getMiniAppCode({ scene: 'ABC123' })).resolves.toBeNull();
  });

  it('【关键】成功路径按二进制返回（照抄 postJson 会在成功时抛 JSON 解析错误）', async () => {
    mockFetch(binaryResponse(PNG_BYTES));
    const { service } = createService();

    const image = await service.getMiniAppCode({ scene: 'ABC123', page: 'pkgMatch/pages/invite' });

    expect(image).toEqual(PNG_BYTES);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('getwxacodeunlimit');
    expect(calls[0]?.url).toContain('access_token=cached-token');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('请求体带上 scene / page / width，且不传的可选参数不出现', async () => {
    mockFetch(binaryResponse(PNG_BYTES));
    const { service } = createService();

    await service.getMiniAppCode({ scene: 'ABC123', page: 'pkgMatch/pages/invite', width: 430 });

    const body = JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({ scene: 'ABC123', page: 'pkgMatch/pages/invite', width: 430 });
    expect('check_path' in body).toBe(false);
  });

  it('【关键】微信返回 JSON 错误（HTTP 仍 200）时返回 null', async () => {
    mockFetch(jsonErrorResponse({ errcode: 40001, errmsg: 'invalid credential' }));
    const { service } = createService();

    await expect(service.getMiniAppCode({ scene: 'ABC123' })).resolves.toBeNull();
  });

  it('空响应体返回 null（存成坏图会让用户扫不出二维码却看不出原因）', async () => {
    mockFetch(binaryResponse(Buffer.alloc(0)));
    const { service } = createService();

    await expect(service.getMiniAppCode({ scene: 'ABC123' })).resolves.toBeNull();
  });

  it('网络异常返回 null（邀请不能被二维码拖垮）', async () => {
    // 不带类型断言：`jest.fn` 的返回类型本就可赋给 `typeof fetch`，
    // 多写一层 `as unknown as` 反而被 lint 判为多余
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    const { service } = createService();

    await expect(service.getMiniAppCode({ scene: 'ABC123' })).resolves.toBeNull();
  });
});
