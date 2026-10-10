/**
 * StorageService 业务登记测试（契约 §3.2.3 的服务端部分）
 *
 * 本文件覆盖「已直传对象被业务采用」这条链路：
 * 归属 → 内容（魔数）→ 大小 → 登记 → 公开化。
 *
 * 重点仍是**拒绝分支**与**副作用顺序**：
 * 内容不符必须删除对象；未通过校验的对象绝不能被公开（ACL 设置在最后）。
 */

import type { ConfigService } from '@nestjs/config';

import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import type { OssService } from '../../infra/oss/oss.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import { StorageService } from './storage.service';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OTHER_USER_ID = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';
const AVATAR_KEY = `avatar/${USER_ID}/20260214_${'a'.repeat(32)}.webp`;

/** PNG 文件头 */
const PNG_PREFIX = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

/** OSS 替身 */
interface OssMock {
  isConfigured: boolean;
  publicDomain: string;
  endpoint: string;
  defaultSignedUrlTtl: number;
  readPrefix: jest.Mock;
  headObject: jest.Mock;
  deleteObject: jest.Mock;
  putObjectAcl: jest.Mock;
}

const createOss = (): OssMock => ({
  isConfigured: true,
  publicDomain: 'https://cdn.soulmap.cn',
  endpoint: 'https://soulmap-private.oss-cn-hangzhou.aliyuncs.com',
  defaultSignedUrlTtl: 900,
  readPrefix: jest.fn().mockResolvedValue(PNG_PREFIX),
  headObject: jest.fn().mockResolvedValue({
    exists: true,
    sizeBytes: 86420,
    mimeType: 'image/png',
    etag: 'F1A2B3C4D5E6F708192A3B4C5D6E7F80',
  }),
  deleteObject: jest.fn().mockResolvedValue(true),
  putObjectAcl: jest.fn().mockResolvedValue(true),
});

/** Prisma 替身 */
interface PrismaMock {
  storedFile: { upsert: jest.Mock; findUnique: jest.Mock };
  outboxEvent: { create: jest.Mock };
}

const createPrisma = (): PrismaMock => ({
  storedFile: {
    upsert: jest.fn().mockResolvedValue({ id: 'file-1' }),
    findUnique: jest.fn().mockResolvedValue({ id: 'file-1' }),
  },
  outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'outbox-1' }) },
});

const configMock = {
  get: (path: string): unknown => ({ 'oss.bucket': 'soulmap-private', 'oss.region': 'oss-cn-hangzhou' })[path],
} as unknown as ConfigService<AppConfig, true>;

describe('StorageService.registerUploadedObject', () => {
  let oss: ReturnType<typeof createOss>;
  let prisma: ReturnType<typeof createPrisma>;
  let service: StorageService;

  beforeEach(() => {
    oss = createOss();
    prisma = createPrisma();
    service = new StorageService(
      oss as unknown as OssService,
      prisma as unknown as PrismaService,
      { key: jest.fn(), get: jest.fn(), set: jest.fn() } as unknown as RedisService,
      configMock,
    );
  });

  it('校验通过后登记并返回权威元数据', async () => {
    const result = await service.registerUploadedObject({
      objectKey: AVATAR_KEY,
      userId: USER_ID,
      scene: 'AVATAR',
    });

    expect(result).toMatchObject({
      objectKey: AVATAR_KEY,
      sizeBytes: 86420,
      mimeType: 'image/png',
      publicUrl: `https://cdn.soulmap.cn/${AVATAR_KEY}`,
    });
    expect(prisma.storedFile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { objectKey: AVATAR_KEY },
        update: expect.objectContaining({ registeredAt: expect.any(Date) }),
      }),
    );
  });

  it('【关键】公开场景在通过全部校验后置为 public-read（顺序不可调换）', async () => {
    const callOrder: string[] = [];
    oss.readPrefix.mockImplementation(async () => {
      callOrder.push('readPrefix');
      return PNG_PREFIX;
    });
    oss.putObjectAcl.mockImplementation(async () => {
      callOrder.push('putObjectAcl');
      return true;
    });

    await service.registerUploadedObject({ objectKey: AVATAR_KEY, userId: USER_ID, scene: 'AVATAR' });

    expect(oss.putObjectAcl).toHaveBeenCalledWith(AVATAR_KEY, 'public-read');
    expect(callOrder).toEqual(['readPrefix', 'putObjectAcl']);
  });

  it('公开化失败时仍返回成功（ACL 失败不应让合法头像登记失败）', async () => {
    oss.putObjectAcl.mockResolvedValue(false);

    await expect(
      service.registerUploadedObject({ objectKey: AVATAR_KEY, userId: USER_ID, scene: 'AVATAR' }),
    ).resolves.toMatchObject({ sizeBytes: 86420 });
  });

  it('【关键】越权登记他人对象返回 80009', async () => {
    const otherKey = `avatar/${OTHER_USER_ID}/20260214_${'b'.repeat(32)}.webp`;

    await expect(
      service.registerUploadedObject({ objectKey: otherKey, userId: USER_ID, scene: 'AVATAR' }),
    ).rejects.toMatchObject({ code: ErrorCode.OBJECT_NOT_OWNED });
    expect(oss.readPrefix).not.toHaveBeenCalled();
  });

  it('【关键】对象场景与登记接口不匹配时返回 80001', async () => {
    const pdfKey = `report-pdf/${USER_ID}/20260214_${'c'.repeat(32)}.pdf`;

    await expect(
      service.registerUploadedObject({ objectKey: pdfKey, userId: USER_ID, scene: 'AVATAR' }),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_TYPE_NOT_ALLOWED });
  });

  it('公开静态资源不能登记为个人文件（80008）', async () => {
    await expect(
      service.registerUploadedObject({
        objectKey: 'public/static/avatar/default.webp',
        userId: USER_ID,
        scene: 'AVATAR',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.OBJECT_KEY_INVALID });
  });

  it('对象不存在时返回 80010', async () => {
    oss.readPrefix.mockResolvedValue(null);

    await expect(
      service.registerUploadedObject({ objectKey: AVATAR_KEY, userId: USER_ID, scene: 'AVATAR' }),
    ).rejects.toMatchObject({ code: ErrorCode.OBJECT_NOT_FOUND });
  });

  it('【关键】魔数不符时删除对象并返回 80014', async () => {
    oss.readPrefix.mockResolvedValue(Buffer.concat([Buffer.from('<html>', 'ascii'), Buffer.alloc(10)]));

    await expect(
      service.registerUploadedObject({ objectKey: AVATAR_KEY, userId: USER_ID, scene: 'AVATAR' }),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_MAGIC_MISMATCH });
    expect(oss.deleteObject).toHaveBeenCalledWith(AVATAR_KEY);
    // 未通过校验的对象不得被登记，更不得公开
    expect(prisma.storedFile.upsert).not.toHaveBeenCalled();
    expect(oss.putObjectAcl).not.toHaveBeenCalled();
  });

  it('【关键】大小以 OSS HEAD 为准（前端声明值不可信）', async () => {
    oss.headObject.mockResolvedValue({
      exists: true,
      sizeBytes: 3 * 1024 * 1024,
      mimeType: 'image/png',
      etag: 'X',
    });

    await expect(
      service.registerUploadedObject({ objectKey: AVATAR_KEY, userId: USER_ID, scene: 'AVATAR' }),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });
  });

  it('声明值超限时提前拒绝（不读取对象）', async () => {
    await expect(
      service.registerUploadedObject({
        objectKey: AVATAR_KEY,
        userId: USER_ID,
        scene: 'AVATAR',
        declaredSize: 3 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });
  });

  it('HEAD 显示对象不存在时返回 80010', async () => {
    oss.headObject.mockResolvedValue({ exists: false, sizeBytes: null, mimeType: null, etag: null });

    await expect(
      service.registerUploadedObject({ objectKey: AVATAR_KEY, userId: USER_ID, scene: 'AVATAR' }),
    ).rejects.toMatchObject({ code: ErrorCode.OBJECT_NOT_FOUND });
  });

  it('OSS 未配置时返回 80003', async () => {
    oss.isConfigured = false;

    await expect(
      service.registerUploadedObject({ objectKey: AVATAR_KEY, userId: USER_ID, scene: 'AVATAR' }),
    ).rejects.toMatchObject({ code: ErrorCode.OSS_NOT_CONFIGURED });
  });

  it('登记时投递内容安全检测（幂等键可重复投递而不重复入队）', async () => {
    await service.registerUploadedObject({ objectKey: AVATAR_KEY, userId: USER_ID, scene: 'AVATAR' });

    expect(prisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'moderation.image' }),
      }),
    );
  });
});

describe('StorageService.scheduleObjectCleanup', () => {
  let oss: ReturnType<typeof createOss>;
  let prisma: ReturnType<typeof createPrisma>;
  let service: StorageService;

  beforeEach(() => {
    oss = createOss();
    prisma = createPrisma();
    service = new StorageService(
      oss as unknown as OssService,
      prisma as unknown as PrismaService,
      { key: jest.fn(), get: jest.fn(), set: jest.fn() } as unknown as RedisService,
      configMock,
    );
  });

  it('写入延迟清理事件（availableAt 为 N 天后）', async () => {
    const before = Date.now();

    await expect(service.scheduleObjectCleanup(AVATAR_KEY, 7)).resolves.toBe(true);

    const call = prisma.outboxEvent.create.mock.calls[0][0] as {
      data: { availableAt: Date; eventType: string; aggregateId: string };
    };
    expect(call.data.eventType).toBe('maintenance.cleanup');
    expect(call.data.aggregateId).toBe('file-1');
    // 7 天 ≈ 604800000ms（允许几秒执行误差）
    const delay = call.data.availableAt.getTime() - before;
    expect(delay).toBeGreaterThan(604_800_000 - 10_000);
    expect(delay).toBeLessThan(604_800_000 + 10_000);
  });

  it('【关键】未登记的对象不伪造审计记录，返回 false 交给孤儿清理兜底', async () => {
    prisma.storedFile.findUnique.mockResolvedValue(null);

    await expect(service.scheduleObjectCleanup(AVATAR_KEY, 7)).resolves.toBe(false);
    expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('重复安排同一对象不报错（幂等键冲突返回 false）', async () => {
    prisma.outboxEvent.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    await expect(service.scheduleObjectCleanup(AVATAR_KEY, 7)).resolves.toBe(false);
  });

  it('publicUrlOf 拼接 CDN 域名且不产生双斜杠', () => {
    expect(service.publicUrlOf(AVATAR_KEY)).toBe(`https://cdn.soulmap.cn/${AVATAR_KEY}`);
  });
});

describe('extractObjectKeyFromUrl（供旧头像清理识别本系统对象）', () => {
  it('从完整 CDN URL 还原对象键', async () => {
    const { extractObjectKeyFromUrl } = await import('./storage.util');

    expect(extractObjectKeyFromUrl(`https://cdn.soulmap.cn/${AVATAR_KEY}`)).toBe(AVATAR_KEY);
    // 带图片处理参数与查询串也要能还原
    expect(extractObjectKeyFromUrl(`https://cdn.soulmap.cn/${AVATAR_KEY}?x-oss-process=image/resize,w_120`)).toBe(
      AVATAR_KEY,
    );
  });

  it('【关键】外部地址与默认头像地址返回 null（不得误删他人资源）', async () => {
    const { extractObjectKeyFromUrl } = await import('./storage.util');

    for (const url of [
      'https://cdn.soulmap.cn/static/avatar/default.webp',
      'https://third-party.example.com/a/b.webp',
      'https://cdn.soulmap.cn/unknown-scene/u/x.webp',
      null,
      undefined,
      '',
    ]) {
      expect(extractObjectKeyFromUrl(url)).toBeNull();
    }
  });
});
