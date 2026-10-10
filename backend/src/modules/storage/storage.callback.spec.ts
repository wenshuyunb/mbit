/**
 * OSS 回调服务测试（契约 §3.10.3）
 *
 * 本接口公开无鉴权，因此每个用例都在验证一条**安全边界**：
 * 验签、公钥来源可信性、魔数校验、场景约束，以及「任何拒绝路径都不得写库」。
 */

import type { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import type { OssService } from '../../infra/oss/oss.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { StorageCallbackDto } from './dto/storage.dto';
import { buildCallbackSignaturePayload } from './oss-callback.util';
import { StorageService } from './storage.service';

// ============================================================================
// 夹具
// ============================================================================

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OBJECT_KEY = `avatar/${USER_ID}/20260214_${'a'.repeat(32)}.webp`;
const ETAG = 'F1A2B3C4D5E6F708192A3B4C5D6E7F80';
const CALLBACK_URL = 'https://api.soulmap.cn/api/v1/storage/callback';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const PUBLIC_KEY_URL = 'http://gosspublic.alicdn.com/callback_pub_key_v1.pem';
const encodedPublicKeyUrl = Buffer.from(PUBLIC_KEY_URL, 'utf8').toString('base64');

/** JPEG 文件头（16 字节） */
const JPEG_PREFIX = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);

interface OssMock {
  isConfigured: boolean;
  endpoint: string;
  publicDomain: string;
  defaultSignedUrlTtl: number;
  readPrefix: jest.Mock;
  deleteObject: jest.Mock;
  headObject: jest.Mock;
  signUrl: jest.Mock;
  assumeUploadCredentials: jest.Mock;
}

const createOssMock = (): OssMock => ({
  isConfigured: true,
  endpoint: 'https://soulmap-private.oss-cn-hangzhou.aliyuncs.com',
  publicDomain: 'https://cdn.soulmap.cn',
  defaultSignedUrlTtl: 900,
  readPrefix: jest.fn().mockResolvedValue(JPEG_PREFIX),
  deleteObject: jest.fn().mockResolvedValue(true),
  headObject: jest.fn(),
  signUrl: jest.fn(),
  assumeUploadCredentials: jest.fn(),
});

const configMock = {
  get: (path: string): unknown => {
    switch (path) {
      case 'oss.bucket':
        return 'soulmap-private';
      case 'oss.region':
        return 'oss-cn-hangzhou';
      case 'oss.maxUploadBytes':
        return 20 * 1024 * 1024;
      default:
        return undefined;
    }
  },
} as unknown as ConfigService<AppConfig, true>;

interface RedisMock {
  key: jest.Mock;
  get: jest.Mock;
  set: jest.Mock;
}

const createRedisMock = (): RedisMock => ({
  key: jest.fn((...parts: string[]) => parts.join(':')),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
});

interface PrismaMock {
  storedFile: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  outboxEvent: { create: jest.Mock };
}

const createPrismaMock = (): PrismaMock => ({
  storedFile: {
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'file-1' }),
    update: jest.fn().mockResolvedValue({ id: 'file-1' }),
  },
  outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'outbox-1' }) },
});

const callbackDto = (overrides: Partial<StorageCallbackDto> = {}): StorageCallbackDto => ({
  objectKey: OBJECT_KEY,
  etag: ETAG,
  size: 86420,
  mimeType: 'image/jpeg',
  ...overrides,
});

/** 构造与 body 匹配的签名与 Authorization 头 */
const signBody = (body: string, url = CALLBACK_URL): { rawBody: string; authorization: string } => ({
  rawBody: body,
  authorization: `OSS LTAI5tTestKey:${cryptoSign(
    'RSA-SHA1',
    Buffer.from(buildCallbackSignaturePayload(url, body), 'utf8'),
    privateKey,
  ).toString('base64')}`,
});

const SIGNED_HEADERS = { publicKeyUrl: encodedPublicKeyUrl, requestUrl: CALLBACK_URL };

/** 断言拒绝且不写库 */
const expectRejected = async (
  promise: Promise<unknown>,
  code: number,
  prisma: ReturnType<typeof createPrismaMock>,
): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code });
  expect(prisma.storedFile.create).not.toHaveBeenCalled();
  expect(prisma.storedFile.update).not.toHaveBeenCalled();
  expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
};

describe('StorageService.handleCallback', () => {
  let oss: OssMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let redis: ReturnType<typeof createRedisMock>;
  let service: StorageService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    oss = createOssMock();
    prisma = createPrismaMock();
    redis = createRedisMock();

    fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => publicKey });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    service = new StorageService(
      oss as unknown as OssService,
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      configMock,
    );
  });

  // ==========================================================================
  // 验签
  // ==========================================================================

  it('验签通过后登记文件并返回 OSS 约定的响应体', async () => {
    const body = JSON.stringify(callbackDto());
    const { rawBody, authorization } = signBody(body);

    const result = await service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, callbackDto());

    expect(result).toMatchObject({
      Status: 'OK',
      objectKey: OBJECT_KEY,
      etag: ETAG,
      size: 86420,
      mimeType: 'image/jpeg',
      safetyCheckQueued: true,
    });
    expect(prisma.storedFile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ objectKey: OBJECT_KEY, userId: USER_ID, scene: 'AVATAR' }),
      }),
    );
  });

  it('【关键】Authorization 缺失时返回 80013 且不写库', async () => {
    const body = JSON.stringify(callbackDto());

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS }, body, callbackDto()),
      ErrorCode.STORAGE_CALLBACK_INVALID,
      prisma,
    );
  });

  it('【关键】body 被篡改时验签失败', async () => {
    const body = JSON.stringify(callbackDto());
    const { authorization } = signBody(body);
    const tamperedBody = body.replace('86420', '99999');

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, tamperedBody, callbackDto()),
      ErrorCode.STORAGE_CALLBACK_INVALID,
      prisma,
    );
  });

  it('【关键】不可信的公钥来源直接拒绝，且不发起任何外呼（防 SSRF）', async () => {
    const body = JSON.stringify(callbackDto());
    const { authorization } = signBody(body);
    const attackerUrl = Buffer.from('http://169.254.169.254/latest/meta-data/', 'utf8').toString('base64');

    await expectRejected(
      service.handleCallback(
        { publicKeyUrl: attackerUrl, authorization, requestUrl: CALLBACK_URL },
        body,
        callbackDto(),
      ),
      ErrorCode.STORAGE_CALLBACK_INVALID,
      prisma,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('公钥拉取失败时返回 80013', async () => {
    const body = JSON.stringify(callbackDto());
    const { authorization } = signBody(body);
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => '' });

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, body, callbackDto()),
      ErrorCode.STORAGE_CALLBACK_INVALID,
      prisma,
    );
  });

  it('公钥内容不含 PUBLIC KEY 段时返回 80013', async () => {
    const body = JSON.stringify(callbackDto());
    const { authorization } = signBody(body);
    fetchMock.mockResolvedValue({ ok: true, text: async () => '<html>not a key</html>' });

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, body, callbackDto()),
      ErrorCode.STORAGE_CALLBACK_INVALID,
      prisma,
    );
  });

  it('公钥命中缓存时不重复外呼', async () => {
    const body = JSON.stringify(callbackDto());
    const { authorization } = signBody(body);
    redis.get.mockResolvedValue(publicKey);

    await service.handleCallback({ ...SIGNED_HEADERS, authorization }, body, callbackDto());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OSS 未配置时返回 80003', async () => {
    oss.isConfigured = false;
    const body = JSON.stringify(callbackDto());

    await expect(
      service.handleCallback({ ...SIGNED_HEADERS, authorization: 'OSS k:s' }, body, callbackDto()),
    ).rejects.toMatchObject({ code: ErrorCode.OSS_NOT_CONFIGURED });
  });

  // ==========================================================================
  // 结构 / 声明值校验
  // ==========================================================================

  it('对象键结构非法时返回 80008', async () => {
    const dto = callbackDto({ objectKey: 'not-a-valid-key' });
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto),
      ErrorCode.OBJECT_KEY_INVALID,
      prisma,
    );
  });

  it('【关键】对象前缀不是已知场景时返回 80008（不读对象、不写库）', async () => {
    const dto = callbackDto({ objectKey: `evil/${USER_ID}/x.webp` });
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto),
      ErrorCode.OBJECT_KEY_INVALID,
      prisma,
    );
    expect(oss.readPrefix).not.toHaveBeenCalled();
  });

  it('MIME 不在该场景白名单时返回 80001', async () => {
    const dto = callbackDto({ mimeType: 'application/pdf' });
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto),
      ErrorCode.FILE_TYPE_NOT_ALLOWED,
      prisma,
    );
  });

  it('大小超出场景上限时返回 80000', async () => {
    const dto = callbackDto({ size: 2 * 1024 * 1024 + 1 });
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto),
      ErrorCode.FILE_TOO_LARGE,
      prisma,
    );
  });

  // ==========================================================================
  // 魔数校验
  // ==========================================================================

  it('对象不存在时返回 80010（客户端上传中途失败）', async () => {
    oss.readPrefix.mockResolvedValue(null);
    const dto = callbackDto();
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto),
      ErrorCode.OBJECT_NOT_FOUND,
      prisma,
    );
  });

  it('【关键】魔数不符时删除对象并返回 80014（声明 jpeg 实传 HTML）', async () => {
    oss.readPrefix.mockResolvedValue(Buffer.concat([Buffer.from('<!DOCTYPE html>', 'ascii'), Buffer.alloc(4)]));
    const dto = callbackDto();
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto),
      ErrorCode.FILE_MAGIC_MISMATCH,
      prisma,
    );
    // 违规对象必须从存储中消失，不能只拒绝回调
    expect(oss.deleteObject).toHaveBeenCalledWith(OBJECT_KEY);
  });

  it('魔数无法识别（非白名单文件类型）同样删除对象', async () => {
    oss.readPrefix.mockResolvedValue(Buffer.alloc(16, 0x00));
    const dto = callbackDto();
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    await expectRejected(
      service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto),
      ErrorCode.FILE_MAGIC_MISMATCH,
      prisma,
    );
    expect(oss.deleteObject).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // 幂等与投递
  // ==========================================================================

  it('【关键】重复回调（同 objectKey + etag）只累加计数，不重复投递检测', async () => {
    prisma.storedFile.findUnique.mockResolvedValue({ id: 'file-1', etag: ETAG });
    const dto = callbackDto();
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    const result = await service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto);

    expect(prisma.storedFile.create).not.toHaveBeenCalled();
    expect(prisma.storedFile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ callbackCount: { increment: 1 } }) }),
    );
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(result.safetyCheckQueued).toBe(false);
  });

  it('【关键】同 objectKey 但 etag 变化（对象被重传）时重新投递检测', async () => {
    prisma.storedFile.findUnique.mockResolvedValue({ id: 'file-1', etag: 'OLD-ETAG-00000000' });
    const dto = callbackDto();
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    const result = await service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto);

    expect(prisma.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(result.safetyCheckQueued).toBe(true);
  });

  it('outbox 幂等键冲突时不报错且标记为未新投递', async () => {
    prisma.outboxEvent.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    const dto = callbackDto();
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    const result = await service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto);

    expect(result.safetyCheckQueued).toBe(false);
  });

  it('非图片场景（REPORT_PDF）不投递内容安全检测', async () => {
    oss.readPrefix.mockResolvedValue(Buffer.from('%PDF-1.7\n', 'ascii'));
    const dto = callbackDto({
      objectKey: `report-pdf/${USER_ID}/20260214_${'b'.repeat(32)}.pdf`,
      mimeType: 'application/pdf',
    });
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    const result = await service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto);

    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(result.safetyCheckQueued).toBe(false);
  });

  it('登记时把对象归属用户写入 stored_files（供孤儿清理与审计）', async () => {
    const dto = callbackDto();
    const { rawBody, authorization } = signBody(JSON.stringify(dto));

    await service.handleCallback({ ...SIGNED_HEADERS, authorization }, rawBody, dto);

    expect(prisma.storedFile.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: USER_ID }) }),
    );
  });

  it('抛出的错误是可识别的业务异常（便于上层转成非 2xx 让 OSS 回滚）', async () => {
    const body = JSON.stringify(callbackDto());

    try {
      await service.handleCallback({ ...SIGNED_HEADERS }, body, callbackDto());
      throw new Error('期望抛出错误');
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessException);
      expect((error as BusinessException).getStatus()).toBe(401);
    }
  });
});
