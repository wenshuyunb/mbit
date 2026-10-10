/**
 * 存储服务测试
 *
 * 重点不在「能签出票据」，而在**签不出来**的那些路径：
 * 越权对象必须整批拒绝、非法请求不得消耗 STS 配额、预留场景不得开放。
 * 这些分支若失守，表现为静默的越权能力，而非报错。
 */

import type { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import type { OssService, ObjectMetadata, SignedUrl } from '../../infra/oss/oss.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { SignUrlDto, UploadTicketDto } from './dto/storage.dto';
import { StorageService } from './storage.service';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OTHER_USER_ID = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';

/** 全局单文件上限（与服务端默认一致：20MB，覆盖 REPORT_PDF 场景上限） */
const GLOBAL_MAX_BYTES = 20 * 1024 * 1024;

/** OssService 的测试替身 */
interface OssServiceMock {
  isConfigured: boolean;
  canAssumeRole: boolean;
  defaultSignedUrlTtl: number;
  endpoint: string;
  publicDomain: string;
  assumeUploadCredentials: jest.Mock;
  signUrl: jest.Mock;
  headObject: jest.Mock;
}

const createOssMock = (): OssServiceMock => ({
  isConfigured: true,
  canAssumeRole: true,
  defaultSignedUrlTtl: 900,
  endpoint: 'https://soulmap-private.oss-cn-hangzhou.aliyuncs.com',
  publicDomain: 'https://cdn.soulmap.cn',
  assumeUploadCredentials: jest.fn().mockResolvedValue({
    accessKeyId: 'STS.NUtest',
    accessKeySecret: 'secret-value',
    securityToken: 'security-token-value',
    expiration: '2026-02-14T18:30:00.000Z',
    expiresInSeconds: 900,
  }),
  signUrl: jest.fn().mockReturnValue({
    url: 'https://soulmap-private.oss-cn-hangzhou.aliyuncs.com/avatar/u/20260214_a.webp?Expires=1771092900&OSSAccessKeyId=STS.NUtest&Signature=ab%2Fcd%3D',
    expiresAt: new Date('2026-02-14T18:35:00.000Z'),
  } satisfies SignedUrl),
  headObject: jest.fn().mockResolvedValue({
    exists: true,
    sizeBytes: 86420,
    mimeType: 'image/webp',
    etag: 'F1A2B3C4D5E6F708192A3B4C5D6E7F80',
  } satisfies ObjectMetadata),
});

/** ConfigService 的测试替身（只为 oss.* 取值服务） */
const createConfigMock = (): ConfigService<AppConfig, true> => {
  const values: Record<string, unknown> = {
    'oss.maxUploadBytes': GLOBAL_MAX_BYTES,
    'oss.region': 'oss-cn-hangzhou',
    'oss.bucket': 'soulmap-private',
  };

  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService<AppConfig, true>;
};

/** 合法上传请求 */
const uploadDto = (overrides: Partial<UploadTicketDto> = {}): UploadTicketDto => ({
  scene: 'AVATAR',
  fileName: 'avatar_temp_20260214.jpg',
  mimeType: 'image/jpeg',
  size: 186420,
  ...overrides,
});

/** 合法签名请求 */
const signDto = (overrides: Partial<SignUrlDto> = {}): SignUrlDto => ({
  objectKeys: [`avatar/${USER_ID}/20260214_${'a'.repeat(32)}.webp`],
  ...overrides,
});

describe('StorageService', () => {
  let oss: OssServiceMock;
  let service: StorageService;

  beforeEach(() => {
    oss = createOssMock();
    service = new StorageService(
      oss as unknown as OssService,
      // 本文件只覆盖 upload-ticket / sign-url（回调见 storage.callback.spec.ts），
      // 因此 Prisma 与 Redis 用最小桩即可
      { storedFile: {}, outboxEvent: {} } as unknown as PrismaService,
      { key: (...parts: string[]) => parts.join(':'), get: jest.fn(), set: jest.fn() } as unknown as RedisService,
      createConfigMock(),
    );
  });

  // ==========================================================================
  // POST /storage/upload-ticket
  // ==========================================================================

  describe('issueUploadTicket', () => {
    it('签发凭证并返回完整票据', async () => {
      const ticket = await service.issueUploadTicket(USER_ID, uploadDto());

      expect(ticket.provider).toBe('aliyun-oss');
      expect(ticket.region).toBe('oss-cn-hangzhou');
      expect(ticket.bucket).toBe('soulmap-private');
      expect(ticket.scene).toBe('AVATAR');
      expect(ticket.maxSize).toBe(2 * 1024 * 1024);
      expect(ticket.credentials.accessKeyId).toBe('STS.NUtest');
      expect(ticket.notice.acl).toBe('private');
      expect(ticket.notice.signedUrlTtlSeconds).toBe(900);
    });

    it('对象键为 `avatar/{userId}/{yyyyMMdd}_{id}.jpg` 形态', async () => {
      const ticket = await service.issueUploadTicket(USER_ID, uploadDto());

      expect(ticket.objectKey).toMatch(new RegExp(`^avatar/${USER_ID}/\\d{8}_[a-f0-9]{32}\\.jpg$`));
      // 绝不包含用户提供的文件名
      expect(ticket.objectKey).not.toContain('avatar_temp_20260214');
    });

    it('【关键】扩展名由 MIME 推导，不使用用户声明的扩展名', async () => {
      const ticket = await service.issueUploadTicket(
        USER_ID,
        uploadDto({ fileName: 'photo.jpeg', mimeType: 'image/jpeg' }),
      );

      expect(ticket.objectKey.endsWith('.jpg')).toBe(true);
      expect(ticket.objectKey.endsWith('.jpeg')).toBe(false);
    });

    it('两次签发得到不同对象键（同秒同用户也不冲突）', async () => {
      const first = await service.issueUploadTicket(USER_ID, uploadDto());
      const second = await service.issueUploadTicket(USER_ID, uploadDto());

      expect(first.objectKey).not.toBe(second.objectKey);
    });

    it('上传表单字段齐全且对象默认私有', async () => {
      const ticket = await service.issueUploadTicket(USER_ID, uploadDto());
      const { fields, method } = ticket.uploadForm;

      expect(method).toBe('POST');
      expect(ticket.uploadForm.url).toBe(oss.endpoint);
      expect(fields.key).toBe(ticket.objectKey);
      expect(fields.OSSAccessKeyId).toBe('STS.NUtest');
      expect(fields['security-token']).toBe('security-token-value');
      expect(fields['x-oss-object-acl']).toBe('private');
      expect(fields['Content-Type']).toBe('image/jpeg');
    });

    it('【关键】不返回 callback 字段（回调接口尚未实现，带上会让 OSS 判定上传失败）', async () => {
      const ticket = await service.issueUploadTicket(USER_ID, uploadDto());

      expect(ticket.uploadForm.fields.callback).toBeUndefined();
    });

    it('提供 md5 时转换为 base64 的 Content-MD5（OSS 校验完整性）', async () => {
      const md5 = '7f3a91c24b8e4d1f9a026c5e8b7d1f30';
      const ticket = await service.issueUploadTicket(USER_ID, uploadDto({ md5 }));

      const encoded = ticket.uploadForm.fields['Content-MD5'];
      expect(encoded).toBeDefined();
      // 往返校验：base64 解回来必须还原为原 16 字节 MD5
      expect(Buffer.from(encoded, 'base64').toString('hex')).toBe(md5);
    });

    it('未提供 md5 时不写入该字段', async () => {
      const ticket = await service.issueUploadTicket(USER_ID, uploadDto());

      expect(ticket.uploadForm.fields['Content-MD5']).toBeUndefined();
    });

    it('【关键】非法请求在换取 STS 之前就被拒绝（不消耗 AssumeRole 配额）', async () => {
      const cases: Array<[Partial<UploadTicketDto>, number]> = [
        [{ scene: 'CHAT_ATTACHMENT' }, ErrorCode.STORAGE_SCENE_NOT_ALLOWED],
        [{ mimeType: 'application/pdf' }, ErrorCode.FILE_TYPE_NOT_ALLOWED],
        [{ size: 2 * 1024 * 1024 + 1 }, ErrorCode.FILE_TOO_LARGE],
        [{ mimeType: 'image/png' }, ErrorCode.FILE_TYPE_NOT_ALLOWED],
      ];

      for (const [overrides, expectedCode] of cases) {
        oss.assumeUploadCredentials.mockClear();
        await expect(service.issueUploadTicket(USER_ID, uploadDto(overrides))).rejects.toMatchObject({
          code: expectedCode,
        });
        expect(oss.assumeUploadCredentials).not.toHaveBeenCalled();
      }
    });

    it('STS 签发失败时透传 80012（不泄露底层错误）', async () => {
      oss.assumeUploadCredentials.mockRejectedValue(new BusinessException(ErrorCode.STS_ASSUME_ROLE_FAILED));

      await expect(service.issueUploadTicket(USER_ID, uploadDto())).rejects.toMatchObject({
        code: ErrorCode.STS_ASSUME_ROLE_FAILED,
      });
    });

    it('把生成的对象键交给 STS 签发（策略与实际写入对象一致）', async () => {
      const ticket = await service.issueUploadTicket(USER_ID, uploadDto());

      expect(oss.assumeUploadCredentials).toHaveBeenCalledWith(ticket.objectKey);
    });
  });

  // ==========================================================================
  // POST /storage/sign-url
  // ==========================================================================

  describe('createSignedUrls', () => {
    it('为本人对象签发 URL 并回带元数据', async () => {
      const result = await service.createSignedUrls(USER_ID, signDto());

      expect(result.total).toBe(1);
      expect(result.expiresInSeconds).toBe(900);
      expect(result.items[0].exists).toBe(true);
      expect(result.items[0].sizeBytes).toBe(86420);
      expect(result.items[0].mimeType).toBe('image/webp');
      expect(result.items[0].signedUrl).not.toBeNull();
    });

    it('签名域名被替换为 CDN，且签名参数逐字节保留', async () => {
      const result = await service.createSignedUrls(USER_ID, signDto());

      expect(result.items[0].signedUrl).toContain('https://cdn.soulmap.cn/avatar/u/');
      expect(result.items[0].signedUrl).toContain('Signature=ab%2Fcd%3D');
    });

    it('对象不存在时该项 signedUrl 为 null 且仍返回 200（不抛错）', async () => {
      oss.headObject.mockResolvedValue({
        exists: false,
        sizeBytes: null,
        mimeType: null,
        etag: null,
      });

      const result = await service.createSignedUrls(USER_ID, signDto());

      expect(result.items[0].exists).toBe(false);
      expect(result.items[0].signedUrl).toBeNull();
      expect(oss.signUrl).not.toHaveBeenCalled();
    });

    it('公开静态资源直接返回 CDN 地址，不做 HEAD 与签名', async () => {
      const result = await service.createSignedUrls(
        USER_ID,
        signDto({ objectKeys: ['public/static/avatar/default.webp'] }),
      );

      expect(result.items[0].exists).toBe(true);
      expect(result.items[0].signedUrl).toBe('https://cdn.soulmap.cn/public/static/avatar/default.webp');
      expect(oss.headObject).not.toHaveBeenCalled();
      expect(oss.signUrl).not.toHaveBeenCalled();
    });

    it('显式有效期被采用', async () => {
      const result = await service.createSignedUrls(USER_ID, signDto({ expiresInSeconds: 3600 }));

      expect(result.expiresInSeconds).toBe(3600);
      expect(oss.signUrl).toHaveBeenCalledWith(expect.any(String), {
        expiresInSeconds: 3600,
      });
    });

    it('【关键】有效期被钳制在 3600 秒内（绝不签发长期 URL）', async () => {
      const result = await service.createSignedUrls(
        USER_ID,
        // DTO 会拦截该值，此处绕过 DTO 直接验证服务的防御性钳制
        { objectKeys: signDto().objectKeys, expiresInSeconds: 999_999 },
      );

      expect(result.expiresInSeconds).toBe(3600);
    });

    it('process 与下载文件名同时透传并进行签名', async () => {
      const result = await service.createSignedUrls(
        USER_ID,
        signDto({ process: 'image/resize,w_240/format,webp', responseContentDisposition: 'attachment' }),
      );

      expect(oss.signUrl).toHaveBeenCalledWith(expect.any(String), {
        expiresInSeconds: 900,
        process: 'image/resize,w_240/format,webp',
        responseContentDisposition: 'attachment',
      });
      expect(result.items[0].process).toBe('image/resize,w_240/format,webp');
    });

    it('未指定 process 时该项为 null 且不传该选项', async () => {
      const result = await service.createSignedUrls(USER_ID, signDto());

      expect(result.items[0].process).toBeNull();
      expect(oss.signUrl).toHaveBeenCalledWith(expect.any(String), { expiresInSeconds: 900 });
    });

    it('【关键】批次中任一项越权即整批拒绝，且不产生任何 I/O', async () => {
      const otherKey = `avatar/${OTHER_USER_ID}/20260214_${'b'.repeat(32)}.webp`;

      await expect(
        service.createSignedUrls(USER_ID, {
          objectKeys: [signDto().objectKeys[0], otherKey],
        }),
      ).rejects.toMatchObject({ code: ErrorCode.OBJECT_NOT_OWNED });

      // 关键：合法的那一项也**不能**被签名，否则可通过响应差异探测他人对象是否存在
      expect(oss.headObject).not.toHaveBeenCalled();
      expect(oss.signUrl).not.toHaveBeenCalled();
    });

    it('【关键】非法规格的对象键整批拒绝（80008）', async () => {
      await expect(
        service.createSignedUrls(USER_ID, {
          objectKeys: [signDto().objectKeys[0], `avatar/${USER_ID}/../x.webp`],
        }),
      ).rejects.toMatchObject({ code: ErrorCode.OBJECT_KEY_INVALID });

      expect(oss.signUrl).not.toHaveBeenCalled();
    });

    it('未知前缀整批拒绝（不因结构合法而放行）', async () => {
      await expect(
        service.createSignedUrls(USER_ID, {
          objectKeys: [`evil/${USER_ID}/x.webp`],
        }),
      ).rejects.toMatchObject({ code: ErrorCode.OBJECT_KEY_INVALID });
    });

    it('批量混合本人对象与公开资源均返回结果', async () => {
      const ownKey = signDto().objectKeys[0];
      const result = await service.createSignedUrls(USER_ID, {
        objectKeys: [ownKey, 'public/a.webp'],
      });

      expect(result.total).toBe(2);
      expect(result.items.map((item) => item.objectKey)).toEqual([ownKey, 'public/a.webp']);
      expect(oss.headObject).toHaveBeenCalledTimes(1);
    });

    it('每项都带 expiresAt 与 process，便于前端按项处理', async () => {
      const result = await service.createSignedUrls(USER_ID, signDto());

      expect(typeof result.items[0].expiresAt).toBe('string');
      expect(Number.isNaN(Date.parse(result.items[0].expiresAt))).toBe(false);
      expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
    });

    it('OSS 未配置时的错误由 OssService 抛出并向上透传', async () => {
      oss.headObject.mockRejectedValue(new BusinessException(ErrorCode.OSS_NOT_CONFIGURED));

      await expect(service.createSignedUrls(USER_ID, signDto())).rejects.toMatchObject({
        code: ErrorCode.OSS_NOT_CONFIGURED,
      });
    });
  });
});
