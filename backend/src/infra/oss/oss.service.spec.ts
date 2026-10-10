/**
 * OSS 服务测试
 *
 * `signatureUrl` 是**纯本地 HMAC 计算**，不产生网络请求，因此签名路径可以做真实验证
 * （而不是断言「调用过 mock」）。STS 与 HEAD 需要网络，通过子类替换
 * `getClient()` / `createStsClient()` 两个受保护接缝来覆盖错误映射分支。
 */

import type { ConfigService } from '@nestjs/config';
import type OSS from 'ali-oss';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import { OssService } from './oss.service';

/** 可注入替身客户端的测试子类 */
class TestableOssService extends OssService {
  public clientStub: unknown = null;
  public stsStub: unknown = null;

  protected override getClient(): OSS {
    if (this.clientStub === null) return super.getClient();
    return this.clientStub as OSS;
  }

  protected override createStsClient(): OSS.STS {
    if (this.stsStub === null) return super.createStsClient();
    return this.stsStub as OSS.STS;
  }

  /** 暴露真实 STS 客户端的构造路径，供单测做**不联网**的构造冒烟 */
  public buildRealStsClient(): OSS.STS {
    return super.createStsClient();
  }
}

/** 构造 ConfigService 替身 */
const createConfigMock = (overrides: Partial<Record<string, unknown>> = {}): ConfigService<AppConfig, true> => {
  const values: Record<string, unknown> = {
    oss: {
      region: 'oss-cn-hangzhou',
      bucket: 'soulmap-private',
      accessKeyId: 'LTAI-test-key-id',
      accessKeySecret: 'test-key-secret',
      stsRoleArn: 'acs:ram::1234567890:role/soulmap-upload',
      cdnDomain: 'https://cdn.soulmap.cn',
      signedUrlTtl: 900,
      maxUploadBytes: 20 * 1024 * 1024,
    },
    ...overrides,
  };

  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService<AppConfig, true>;
};

/** 创建一个已配置的服务实例 */
const createService = (overrides: Partial<Record<string, unknown>> = {}): TestableOssService =>
  new TestableOssService(createConfigMock(overrides));

const OBJECT_KEY = `avatar/0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70/20260214_${'a'.repeat(32)}.webp`;

describe('OssService', () => {
  describe('配置探测', () => {
    it('bucket / accessKeyId / accessKeySecret 齐全时视为已配置', () => {
      expect(createService().isConfigured).toBe(true);
    });

    it('缺任一必填项即视为未配置', () => {
      for (const bucket of ['', undefined]) {
        expect(createService({ oss: { ...baseOssConfig(), bucket } }).isConfigured).toBe(false);
      }
      expect(createService({ oss: { ...baseOssConfig(), accessKeyId: '' } }).isConfigured).toBe(false);
      expect(createService({ oss: { ...baseOssConfig(), accessKeySecret: '' } }).isConfigured).toBe(false);
    });

    it('签发 STS 额外要求配置 RAM 角色 ARN', () => {
      expect(createService().canAssumeRole).toBe(true);
      expect(createService({ oss: { ...baseOssConfig(), stsRoleArn: '' } }).canAssumeRole).toBe(false);
    });

    it('endpoint 由 bucket + region 推导（与契约示例一致）', () => {
      expect(createService().endpoint).toBe('https://soulmap-private.oss-cn-hangzhou.aliyuncs.com');
    });

    it('publicDomain 优先取 CDN 域名，未配置时回退 Bucket 域名', () => {
      expect(createService().publicDomain).toBe('https://cdn.soulmap.cn');
      expect(createService({ oss: { ...baseOssConfig(), cdnDomain: '' } }).publicDomain).toBe(
        'https://soulmap-private.oss-cn-hangzhou.aliyuncs.com',
      );
    });

    it('默认签名有效期取自配置', () => {
      expect(createService().defaultSignedUrlTtl).toBe(900);
      expect(createService({ oss: { ...baseOssConfig(), signedUrlTtl: 3600 } }).defaultSignedUrlTtl).toBe(3600);
    });
  });

  describe('buildUploadPolicy', () => {
    it('【关键】资源精确到单个对象，不含通配符', () => {
      const policy = createService().buildUploadPolicy(OBJECT_KEY) as {
        Version: string;
        Statement: Array<{ Effect: string; Action: string[]; Resource: string[] }>;
      };

      expect(policy.Version).toBe('1');
      expect(policy.Statement).toHaveLength(1);
      expect(policy.Statement[0].Effect).toBe('Allow');
      expect(policy.Statement[0].Action).toEqual(['oss:PutObject']);
      expect(policy.Statement[0].Resource).toEqual([`acs:oss:*:*:soulmap-private/${OBJECT_KEY}`]);
      // 不得出现 `/*` 之类的目录级授权
      expect(policy.Statement[0].Resource[0].endsWith('*')).toBe(false);
    });

    it('【关键】策略不含读取与删除权限', () => {
      const serialized = JSON.stringify(createService().buildUploadPolicy(OBJECT_KEY));

      expect(serialized).not.toContain('GetObject');
      expect(serialized).not.toContain('DeleteObject');
      expect(serialized).not.toContain('ListObjects');
    });
  });

  describe('signUrl', () => {
    it('生成含 Expires 与 Signature 的签名 URL（真实本地计算）', () => {
      const signed = createService().signUrl(OBJECT_KEY, { expiresInSeconds: 900 });

      expect(signed.url).toContain('soulmap-private.oss-cn-hangzhou.aliyuncs.com');
      expect(signed.url).toContain(OBJECT_KEY);
      expect(signed.url).toContain('Expires=');
      expect(signed.url).toContain('Signature=');
      expect(signed.url).toContain(`OSSAccessKeyId=LTAI-test-key-id`);
    });

    it('未指定有效期时使用配置默认值', () => {
      const signed = createService().signUrl(OBJECT_KEY);

      expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 900 * 1000 + 1000);
    });

    it('有效期影响签名结果（不同 TTL 产生不同链接）', () => {
      const short = createService().signUrl(OBJECT_KEY, { expiresInSeconds: 60 });
      const long = createService().signUrl(OBJECT_KEY, { expiresInSeconds: 3600 });

      expect(short.url).not.toBe(long.url);
      expect(long.expiresAt.getTime() - short.expiresAt.getTime()).toBeGreaterThan(3_000_000);
    });

    it('透传图片处理参数为 x-oss-process', () => {
      const signed = createService().signUrl(OBJECT_KEY, {
        process: 'image/resize,w_240/format,webp',
      });

      expect(decodeURIComponent(signed.url)).toContain('x-oss-process=image/resize,w_240/format,webp');
    });

    it('透传下载文件名提示为 response-content-disposition', () => {
      const signed = createService().signUrl(OBJECT_KEY, {
        responseContentDisposition: 'attachment; filename="report.pdf"',
      });

      expect(signed.url).toContain('response-content-disposition=');
    });

    it('未配置 OSS 时返回 80003（且不抛底层异常）', () => {
      const service = createService({ oss: { ...baseOssConfig(), bucket: '' } });

      try {
        service.signUrl(OBJECT_KEY);
        throw new Error('期望抛出错误');
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessException);
        expect((error as BusinessException).code).toBe(ErrorCode.OSS_NOT_CONFIGURED);
      }
    });

    it('签名函数抛错时归一为 80011（不把 SDK 异常细节透给客户端）', () => {
      const service = createService();
      service.clientStub = {
        signatureUrl: jest.fn(() => {
          throw new Error('internal sdk failure');
        }),
      };

      try {
        service.signUrl(OBJECT_KEY);
        throw new Error('期望抛出错误');
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessException);
        expect((error as BusinessException).code).toBe(ErrorCode.SIGN_URL_FAILED);
        expect((error as BusinessException).userMessage).not.toContain('sdk');
      }
    });
  });

  describe('assumeUploadCredentials', () => {
    it('成功时返回归一化凭证与剩余秒数', async () => {
      const service = createService();
      const expiration = new Date(Date.now() + 900 * 1000).toISOString();
      service.stsStub = {
        assumeRole: jest.fn().mockResolvedValue({
          credentials: {
            AccessKeyId: 'STS.NUtest',
            AccessKeySecret: 'sts-secret',
            SecurityToken: 'sts-token',
            Expiration: expiration,
          },
        }),
      };

      const credentials = await service.assumeUploadCredentials(OBJECT_KEY);

      expect(credentials.accessKeyId).toBe('STS.NUtest');
      expect(credentials.securityToken).toBe('sts-token');
      expect(credentials.expiration).toBe(expiration);
      expect(credentials.expiresInSeconds).toBeGreaterThanOrEqual(898);
      expect(credentials.expiresInSeconds).toBeLessThanOrEqual(900);
    });

    it('【关键】STS 策略只授权本次对象', async () => {
      const service = createService();
      const assumeRole = jest.fn().mockResolvedValue({
        credentials: {
          AccessKeyId: 'STS.NUtest',
          AccessKeySecret: 's',
          SecurityToken: 't',
          Expiration: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      service.stsStub = { assumeRole };

      await service.assumeUploadCredentials(OBJECT_KEY);

      const [roleArn, policy, ttl] = assumeRole.mock.calls[0];
      expect(roleArn).toBe('acs:ram::1234567890:role/soulmap-upload');
      expect(ttl).toBe(900);
      expect(JSON.stringify(policy)).toContain(`soulmap-private/${OBJECT_KEY}`);
      expect(JSON.stringify(policy)).not.toContain('GetObject');
    });

    it('未配置 RAM 角色时返回 80003', async () => {
      const service = createService({ oss: { ...baseOssConfig(), stsRoleArn: '' } });

      await expect(service.assumeUploadCredentials(OBJECT_KEY)).rejects.toMatchObject({
        code: ErrorCode.OSS_NOT_CONFIGURED,
      });
    });

    it('【关键】首次失败会重试一次，仍失败才返回 80012', async () => {
      const service = createService();
      const assumeRole = jest.fn().mockRejectedValue(new Error('Throttling.User'));
      service.stsStub = { assumeRole };

      await expect(service.assumeUploadCredentials(OBJECT_KEY)).rejects.toMatchObject({
        code: ErrorCode.STS_ASSUME_ROLE_FAILED,
      });
      expect(assumeRole).toHaveBeenCalledTimes(2);
    });

    it('首次失败但重试成功时不报错（瞬时抖动被吸收）', async () => {
      const service = createService();
      const assumeRole = jest
        .fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({
          credentials: {
            AccessKeyId: 'STS.NUretry',
            AccessKeySecret: 's',
            SecurityToken: 't',
            Expiration: new Date(Date.now() + 900_000).toISOString(),
          },
        });
      service.stsStub = { assumeRole };

      const credentials = await service.assumeUploadCredentials(OBJECT_KEY);

      expect(credentials.accessKeyId).toBe('STS.NUretry');
      expect(assumeRole).toHaveBeenCalledTimes(2);
    });

    it('【关键】失败信息不泄露 AK/SK', async () => {
      const service = createService();
      service.stsStub = {
        assumeRole: jest.fn().mockRejectedValue(new Error('AccessKeyId LTAI-test-key-id denied')),
      };

      try {
        await service.assumeUploadCredentials(OBJECT_KEY);
        throw new Error('期望抛出错误');
      } catch (error) {
        expect((error as BusinessException).userMessage).not.toContain('LTAI');
        expect((error as BusinessException).userMessage).not.toContain('secret');
      }
    });

    it('SDK 抛出非 Error 值时仍归一为 80012（不因错误形状异常而 500）', async () => {
      const service = createService();
      // ali-oss 的部分失败路径会 reject 字符串或普通对象，而非 Error 实例
      service.stsStub = { assumeRole: jest.fn().mockRejectedValue('Throttling') };

      await expect(service.assumeUploadCredentials(OBJECT_KEY)).rejects.toMatchObject({
        code: ErrorCode.STS_ASSUME_ROLE_FAILED,
      });
    });

    it('真实 STS 客户端可用当前配置构造（不发起网络请求）', () => {
      // 覆盖 createStsClient 的真实实现：此前所有用例都替换了该接缝，
      // 构造路径本身（凭据读取、SDK 初始化）从未被执行过
      expect(() => createService().buildRealStsClient()).not.toThrow();
    });
  });

  describe('headObject', () => {
    it('存在时解析 content-length / content-type / etag', async () => {
      const service = createService();
      service.clientStub = {
        head: jest.fn().mockResolvedValue({
          res: {
            headers: {
              'content-length': '86420',
              'content-type': 'image/webp',
              etag: '"F1A2B3C4D5E6F708192A3B4C5D6E7F80"',
            },
          },
        }),
      };

      const metadata = await service.headObject(OBJECT_KEY);

      expect(metadata).toEqual({
        exists: true,
        sizeBytes: 86420,
        mimeType: 'image/webp',
        etag: 'F1A2B3C4D5E6F708192A3B4C5D6E7F80',
      });
    });

    it('【关键】404 返回 exists:false 而不抛错（批量场景不因单项缺失而失败）', async () => {
      for (const notFoundError of [
        Object.assign(new Error('Not Found'), { status: 404 }),
        Object.assign(new Error('No such key'), { code: 'NoSuchKey' }),
      ]) {
        const service = createService();
        service.clientStub = { head: jest.fn().mockRejectedValue(notFoundError) };

        await expect(service.headObject(OBJECT_KEY)).resolves.toEqual({
          exists: false,
          sizeBytes: null,
          mimeType: null,
          etag: null,
        });
      }
    });

    it('缺失响应头时字段为 null 而非 NaN', async () => {
      const service = createService();
      service.clientStub = { head: jest.fn().mockResolvedValue({ res: { headers: {} } }) };

      const metadata = await service.headObject(OBJECT_KEY);

      expect(metadata.sizeBytes).toBeNull();
      expect(metadata.mimeType).toBeNull();
      expect(metadata.etag).toBeNull();
    });

    it('res 缺失时也不抛 TypeError', async () => {
      const service = createService();
      service.clientStub = { head: jest.fn().mockResolvedValue({}) };

      await expect(service.headObject(OBJECT_KEY)).resolves.toMatchObject({ exists: true });
    });

    it('其他错误归一为 80002（不泄露 OSS 内部错误）', async () => {
      const service = createService();
      service.clientStub = {
        head: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
      };

      await expect(service.headObject(OBJECT_KEY)).rejects.toMatchObject({
        code: ErrorCode.FILE_UPLOAD_FAILED,
      });
    });

    it('SDK 抛出非 Error 值时同样归一为 80002（catch 的 error 是 unknown，可能不是对象）', async () => {
      const service = createService();
      service.clientStub = { head: jest.fn().mockRejectedValue('NetworkError') };

      await expect(service.headObject(OBJECT_KEY)).rejects.toMatchObject({
        code: ErrorCode.FILE_UPLOAD_FAILED,
      });
    });

    it('未配置 OSS 时返回 80003', async () => {
      const service = createService({ oss: { ...baseOssConfig(), accessKeyId: '' } });

      await expect(service.headObject(OBJECT_KEY)).rejects.toMatchObject({
        code: ErrorCode.OSS_NOT_CONFIGURED,
      });
    });
  });
});

/** 基准 OSS 配置（便于按字段覆盖） */
function baseOssConfig(): Record<string, unknown> {
  return {
    region: 'oss-cn-hangzhou',
    bucket: 'soulmap-private',
    accessKeyId: 'LTAI-test-key-id',
    accessKeySecret: 'test-key-secret',
    stsRoleArn: 'acs:ram::1234567890:role/soulmap-upload',
    cdnDomain: 'https://cdn.soulmap.cn',
    signedUrlTtl: 900,
    maxUploadBytes: 20 * 1024 * 1024,
  };
}
