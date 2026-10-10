/**
 * 头像登记服务测试（契约 §3.2.3）
 *
 * `StorageService` 用替身（其自身行为已由 `storage.register.spec.ts` 覆盖），
 * 本文件聚焦 user 模块的职责：**分支选择**（默认头像 vs 登记对象）、
 * **旧头像清理的判定**（只清理确属本系统的对象）、以及失败不留痕。
 */

import type { ConfigService } from '@nestjs/config';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { WechatService } from '../../infra/wechat/wechat.service';
import type { StorageService } from '../storage/storage.service';
import type { UpdateAvatarDto } from './dto/user.dto';
import { UserService } from './user.service';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const NEW_KEY = `avatar/${USER_ID}/20260214_${'a'.repeat(32)}.webp`;
const OLD_KEY = `avatar/${USER_ID}/20260101_${'b'.repeat(32)}.webp`;
const CDN = 'https://cdn.soulmap.cn';
const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');

const configService = {
  get: (path: string): unknown =>
    ({
      'crypto.key': TEST_KEY,
      'crypto.ivSalt': 'salt',
      'quota.accountDeletionGraceDays': 7,
      'quota.freeAiMessages': 5,
      'quota.memberDailyAiMessages': 100,
      'app.legalBaseUrl': '',
    })[path],
} as unknown as ConfigService<AppConfig, true>;

interface Harness {
  service: UserService;
  prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    systemConfig: { findUnique: jest.Mock };
    userDeletionRequest: { findFirst: jest.Mock };
  };
  storage: { registerUploadedObject: jest.Mock; scheduleObjectCleanup: jest.Mock };
}

const createHarness = (options: { avatarUrl?: string | null; defaultAvatar?: string | null } = {}): Harness => {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: USER_ID, avatarUrl: options.avatarUrl ?? null }),
      update: jest.fn().mockResolvedValue({ id: USER_ID }),
    },
    systemConfig: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.defaultAvatar === undefined || options.defaultAvatar === null
            ? null
            : { value: options.defaultAvatar },
        ),
    },
    userDeletionRequest: { findFirst: jest.fn().mockResolvedValue(null) },
  };

  const storage = {
    registerUploadedObject: jest.fn().mockResolvedValue({
      objectKey: NEW_KEY,
      sizeBytes: 86420,
      mimeType: 'image/webp',
      etag: 'ETAG',
      publicUrl: `${CDN}/${NEW_KEY}`,
    }),
    scheduleObjectCleanup: jest.fn().mockResolvedValue(true),
  };

  const service = new UserService(
    prisma as unknown as PrismaService,
    new CryptoService(configService),
    {} as unknown as WechatService,
    {} as unknown as RedisService,
    storage as unknown as StorageService,
    configService,
  );

  return { service, prisma, storage };
};

const objectKeyDto = (overrides: Partial<UpdateAvatarDto> = {}): UpdateAvatarDto => ({
  objectKey: NEW_KEY,
  size: 86420,
  ...overrides,
});

/** 断言拒绝且不写库、不登记 */
const expectRejected = async (promise: Promise<unknown>, code: number, harness: Harness): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code });
  expect(harness.prisma.user.update).not.toHaveBeenCalled();
};

describe('UserService.updateAvatar', () => {
  describe('登记已上传对象', () => {
    it('登记成功后写入 CDN 地址并返回缩略图地址', async () => {
      const harness = createHarness();

      const view = await harness.service.updateAvatar(USER_ID, objectKeyDto());

      expect(view.avatarUrl).toBe(`${CDN}/${NEW_KEY}`);
      expect(view.avatarThumbUrl).toBe(`${CDN}/${NEW_KEY}?x-oss-process=image/resize,w_120/format,webp`);
      expect(view.size).toBe(86420);
      expect(view.mimeType).toBe('image/webp');
      expect(harness.prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { avatarUrl: `${CDN}/${NEW_KEY}` },
      });
    });

    it('把登记职责交给 storage 模块（用户模块不触碰 OSS 细节）', async () => {
      const harness = createHarness();

      await harness.service.updateAvatar(USER_ID, objectKeyDto());

      expect(harness.storage.registerUploadedObject).toHaveBeenCalledWith(
        expect.objectContaining({ objectKey: NEW_KEY, userId: USER_ID, scene: 'AVATAR' }),
      );
    });

    it('【关键】旧头像是本系统对象时安排 7 天延迟清理', async () => {
      const harness = createHarness({ avatarUrl: `${CDN}/${OLD_KEY}` });

      await harness.service.updateAvatar(USER_ID, objectKeyDto());

      expect(harness.storage.scheduleObjectCleanup).toHaveBeenCalledWith(OLD_KEY, 7);
    });

    it('【关键】旧头像是外部地址时不安排清理（避免误删他人资源）', async () => {
      const harness = createHarness({ avatarUrl: 'https://third-party.example.com/a.webp' });

      await harness.service.updateAvatar(USER_ID, objectKeyDto());

      expect(harness.storage.scheduleObjectCleanup).not.toHaveBeenCalled();
    });

    it('旧头像未配置（null）时不安排清理', async () => {
      const harness = createHarness({ avatarUrl: null });

      await harness.service.updateAvatar(USER_ID, objectKeyDto());

      expect(harness.storage.scheduleObjectCleanup).not.toHaveBeenCalled();
    });

    it('重复登记同一对象时不安排清理（否则会删掉刚设好的头像）', async () => {
      const harness = createHarness({ avatarUrl: `${CDN}/${NEW_KEY}` });

      await harness.service.updateAvatar(USER_ID, objectKeyDto());

      expect(harness.storage.scheduleObjectCleanup).not.toHaveBeenCalled();
    });

    it('【关键】缺少 objectKey 且未指定默认头像时返回 400', async () => {
      const harness = createHarness();

      await expectRejected(harness.service.updateAvatar(USER_ID, {}), ErrorCode.PARAM_INVALID, harness);
      expect(harness.storage.registerUploadedObject).not.toHaveBeenCalled();
    });

    it('冷静期内返回 403 且不登记', async () => {
      const harness = createHarness();
      harness.prisma.userDeletionRequest.findFirst.mockResolvedValue({ id: 'd-1' });

      await expectRejected(
        harness.service.updateAvatar(USER_ID, objectKeyDto()),
        ErrorCode.PROFILE_EDIT_LOCKED,
        harness,
      );
      expect(harness.storage.registerUploadedObject).not.toHaveBeenCalled();
    });

    it('用户不存在时返回 404', async () => {
      const harness = createHarness();
      harness.prisma.user.findUnique.mockResolvedValue(null);

      await expectRejected(harness.service.updateAvatar(USER_ID, objectKeyDto()), ErrorCode.USER_NOT_FOUND, harness);
    });

    it('storage 的拒绝会原样向上传递（越权 / 魔数 / 大小）', async () => {
      for (const code of [
        ErrorCode.OBJECT_NOT_OWNED,
        ErrorCode.FILE_MAGIC_MISMATCH,
        ErrorCode.FILE_TOO_LARGE,
        ErrorCode.OBJECT_NOT_FOUND,
      ]) {
        const harness = createHarness();
        harness.storage.registerUploadedObject.mockRejectedValue(new BusinessException(code));

        await expectRejected(harness.service.updateAvatar(USER_ID, objectKeyDto()), code, harness);
      }
    });
  });

  describe('系统默认头像', () => {
    it('isDefault 时读取配置写入，且不触碰 OSS', async () => {
      const defaultUrl = `${CDN}/static/avatar/default.webp`;
      const harness = createHarness({ defaultAvatar: defaultUrl });

      const view = await harness.service.updateAvatar(USER_ID, { isDefault: true });

      expect(view.avatarUrl).toBe(defaultUrl);
      expect(view.avatarThumbUrl).toBe(defaultUrl);
      expect(view.size).toBeNull();
      expect(view.mimeType).toBeNull();
      expect(harness.storage.registerUploadedObject).not.toHaveBeenCalled();
      expect(harness.prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { avatarUrl: defaultUrl },
      });
    });

    it('【关键】未配置默认头像时显式报错（不静默写入假地址）', async () => {
      const harness = createHarness({ defaultAvatar: null });

      await expectRejected(
        harness.service.updateAvatar(USER_ID, { isDefault: true }),
        ErrorCode.AVATAR_INVALID,
        harness,
      );
    });

    it('配置为空字符串时同样视为未配置', async () => {
      const harness = createHarness({ defaultAvatar: '   ' });

      await expectRejected(
        harness.service.updateAvatar(USER_ID, { isDefault: true }),
        ErrorCode.AVATAR_INVALID,
        harness,
      );
    });

    it('配置读取失败时按未配置处理（不阻断流程、不抛出底层错误）', async () => {
      const harness = createHarness();
      harness.prisma.systemConfig.findUnique.mockRejectedValue(new Error('db down'));

      await expectRejected(
        harness.service.updateAvatar(USER_ID, { isDefault: true }),
        ErrorCode.AVATAR_INVALID,
        harness,
      );
    });

    it('isDefault 为 false 时走正常登记路径', async () => {
      const harness = createHarness();

      await harness.service.updateAvatar(USER_ID, objectKeyDto({ isDefault: false }));

      expect(harness.storage.registerUploadedObject).toHaveBeenCalled();
    });
  });
});
