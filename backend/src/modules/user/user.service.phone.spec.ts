/**
 * 手机号绑定服务测试（契约 §3.2.4）
 *
 * 独立成文件的原因：本模块依赖的 Prisma 委托（`userPhoneHistory`、`$transaction`）
 * 与 Redis 计数器在原 `user.service.spec.ts` 的桩中并不存在，
 * 就地扩展那套桩会波及既有 92 个用例；独立文件可以用贴合本功能的桩，
 * 且 `CryptoService` 使用**真实实现**（无 I/O），从而验证「密文可还原、哈希可复现」。
 *
 * 本文件的核心主张是**安全属性**而非流程走通：
 *   · 明文不落库（落库的密文需解密才等于号码，且哈希不含号码）
 *   · 加盐哈希可复现且与区号写法无关
 *   · 失败不留痕（任何拒绝路径都不得写库）
 */

import type { ConfigService } from '@nestjs/config';
import { createCipheriv } from 'node:crypto';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { WechatService } from '../../infra/wechat/wechat.service';
import type { StorageService } from '../storage/storage.service';
import type { BindPhoneDto } from './dto/user.dto';
import { UserService } from './user.service';

// ============================================================================
// 夹具
// ============================================================================

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');
const TEST_SALT = 'unit-test-salt';
const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OTHER_USER_ID = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';
const PURE_PHONE = '13800006721';
/** 微信 session_key（AES-128 需要 16 字节） */
const SESSION_KEY = Buffer.from('0123456789abcdef', 'utf8');
const SESSION_IV = Buffer.from('fedcba9876543210', 'utf8');

/** 构造 ConfigService 替身；`saltConfigured=false` 用于验证「盐缺失即拒绝」 */
const createConfigService = (saltConfigured = true): ConfigService<AppConfig, true> =>
  ({
    get: (path: string): unknown => {
      switch (path) {
        case 'crypto.key':
          return TEST_KEY;
        case 'crypto.ivSalt':
          return saltConfigured ? TEST_SALT : '';
        case 'quota.accountDeletionGraceDays':
          return 7;
        case 'quota.freeAiMessages':
          return 5;
        case 'quota.memberDailyAiMessages':
          return 100;
        case 'app.legalBaseUrl':
          return '';
        default:
          return undefined;
      }
    },
  }) as unknown as ConfigService<AppConfig, true>;

/** 事务客户端桩（与 prisma 桩共享同一个对象，便于断言写入内容） */
interface TxStub {
  userPhoneHistory: { updateMany: jest.Mock; create: jest.Mock };
  user: { update: jest.Mock };
}

const createTxStub = (): TxStub => ({
  userPhoneHistory: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), create: jest.fn() },
  user: { update: jest.fn() },
});

interface Harness {
  service: UserService;
  prisma: {
    user: { findUnique: jest.Mock };
    wechatAccount: { findUnique: jest.Mock };
    userPhoneHistory: { findFirst: jest.Mock };
    userDeletionRequest: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  tx: TxStub;
  redis: { key: jest.Mock; incrWithTtl: jest.Mock };
  wechat: { getPhoneNumber: jest.Mock };
  crypto: CryptoService;
}

const createHarness = (options: { saltConfigured?: boolean } = {}): Harness => {
  const crypto = new CryptoService(createConfigService(options.saltConfigured ?? true));
  const tx = createTxStub();

  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: USER_ID, phoneHash: null }) },
    wechatAccount: {
      findUnique: jest.fn().mockResolvedValue({ sessionKeyEnc: crypto.encrypt(SESSION_KEY.toString('base64')) }),
    },
    userPhoneHistory: {
      findFirst: jest.fn().mockResolvedValue({ createdAt: new Date('2026-02-01T00:00:00.000Z') }),
    },
    userDeletionRequest: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
  };

  const redis = {
    key: jest.fn((...parts: Array<string | number>) => parts.join(':')),
    incrWithTtl: jest.fn().mockResolvedValue(1),
  };

  const wechat = {
    getPhoneNumber: jest.fn().mockResolvedValue({
      phoneNumber: `+86 ${PURE_PHONE}`,
      purePhoneNumber: PURE_PHONE,
      countryCode: '86',
    }),
  };

  const service = new UserService(
    prisma as unknown as PrismaService,
    crypto,
    wechat as unknown as WechatService,
    redis as unknown as RedisService,
    // 本文件不涉及头像；storage 能力由 user.service.avatar.spec.ts 覆盖
    { registerUploadedObject: jest.fn(), scheduleObjectCleanup: jest.fn() } as unknown as StorageService,
    createConfigService(options.saltConfigured ?? true),
  );

  return { service, prisma, tx, redis, wechat, crypto };
};

/** 按微信格式加密（AES-128-CBC + PKCS#7） */
const encryptLikeWechat = (plaintext: string): string => {
  const cipher = createCipheriv('aes-128-cbc', SESSION_KEY, SESSION_IV);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
};

/** code 路径的请求体 */
const codeDto = (overrides: Partial<BindPhoneDto> = {}): BindPhoneDto => ({
  code: 'phone-code-abc',
  ...overrides,
});

/** 旧版加密数据路径的请求体 */
const legacyDto = (plaintext?: string): BindPhoneDto => ({
  encryptedData: encryptLikeWechat(
    plaintext ?? JSON.stringify({ phoneNumber: `+86 ${PURE_PHONE}`, purePhoneNumber: PURE_PHONE, countryCode: '86' }),
  ),
  iv: SESSION_IV.toString('base64'),
});

/** 断言拒绝且**未发生任何写入**（失败不留痕，契约 §3.2.4 规则 5） */
const expectRejectedWithoutWrites = async (
  promise: Promise<unknown>,
  expectedCode: number,
  harness: Harness,
): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code: expectedCode });
  expect(harness.tx.user.update).not.toHaveBeenCalled();
  expect(harness.tx.userPhoneHistory.create).not.toHaveBeenCalled();
  expect(harness.prisma.$transaction).not.toHaveBeenCalled();
};

describe('UserService.bindPhone', () => {
  // ==========================================================================
  // 首次绑定
  // ==========================================================================

  describe('首次绑定（code 路径）', () => {
    it('绑定成功并返回脱敏信息', async () => {
      const harness = createHarness();

      const view = await harness.service.bindPhone(USER_ID, codeDto());

      expect(view).toMatchObject({
        phoneBound: true,
        phoneMasked: '138****6721',
        countryCode: '86',
        isReplaced: false,
      });
      expect(Number.isNaN(Date.parse(view.boundAt))).toBe(false);
    });

    it('【关键】落库的是密文，明文号码不出现在任何写入中', async () => {
      const harness = createHarness();

      await harness.service.bindPhone(USER_ID, codeDto());

      const written = harness.tx.user.update.mock.calls[0][0] as {
        data: { phoneEnc: string; phoneHash: string };
      };

      // 密文不等于明文
      expect(written.data.phoneEnc).not.toContain(PURE_PHONE);
      // 但可被服务端密钥还原
      expect(harness.crypto.decrypt(written.data.phoneEnc)).toBe(PURE_PHONE);
      // 哈希是 64 位十六进制，且不含号码
      expect(written.data.phoneHash).toMatch(/^[a-f0-9]{64}$/);
      expect(written.data.phoneHash).not.toContain(PURE_PHONE);
    });

    it('【关键】加盐哈希可复现，且与区号写法无关', async () => {
      const withCountryCode = createHarness();
      await withCountryCode.service.bindPhone(USER_ID, codeDto());

      const plain = createHarness();
      plain.wechat.getPhoneNumber.mockResolvedValue({
        phoneNumber: PURE_PHONE,
        purePhoneNumber: PURE_PHONE,
        countryCode: '86',
      });
      await plain.service.bindPhone(USER_ID, codeDto());

      const hashOf = (harness: Harness): string =>
        (harness.tx.user.update.mock.calls[0][0] as { data: { phoneHash: string } }).data.phoneHash;

      expect(hashOf(withCountryCode)).toBe(hashOf(plain));

      // 不同号码必须得到不同哈希
      const other = createHarness();
      other.wechat.getPhoneNumber.mockResolvedValue({
        phoneNumber: '13900006722',
        purePhoneNumber: '13900006722',
        countryCode: '86',
      });
      await other.service.bindPhone(USER_ID, codeDto());
      expect(hashOf(other)).not.toBe(hashOf(plain));
    });

    it('【关键】未加盐时拒绝绑定（不写入弱哈希）', async () => {
      const harness = createHarness({ saltConfigured: false });

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, codeDto()),
        ErrorCode.CONFIG_MISSING,
        harness,
      );
      // 而且不应消耗微信接口配额
      expect(harness.wechat.getPhoneNumber).not.toHaveBeenCalled();
    });

    it('写入手机号历史（含脱敏值与来源）', async () => {
      const harness = createHarness();

      await harness.service.bindPhone(USER_ID, codeDto({ source: 'PROFILE' }));

      expect(harness.tx.userPhoneHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: USER_ID,
          phoneMasked: '138****6721',
          countryCode: '86',
          source: 'PROFILE',
        }),
      });
    });

    it('source 缺省为 BUTTON', async () => {
      const harness = createHarness();

      await harness.service.bindPhone(USER_ID, codeDto());

      expect(harness.tx.userPhoneHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ source: 'BUTTON' }),
      });
    });

    it('首次绑定不占用换绑额度（不触碰计数器）', async () => {
      const harness = createHarness();

      await harness.service.bindPhone(USER_ID, codeDto());

      expect(harness.redis.incrWithTtl).not.toHaveBeenCalled();
      expect(harness.tx.userPhoneHistory.updateMany).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 幂等
  // ==========================================================================

  describe('幂等', () => {
    it('重复绑定同一号码返回成功且不写库', async () => {
      const harness = createHarness();
      const hash = createHarness();
      await hash.service.bindPhone(USER_ID, codeDto());
      const phoneHash = (hash.tx.user.update.mock.calls[0][0] as { data: { phoneHash: string } }).data.phoneHash;

      harness.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, phoneHash });

      const view = await harness.service.bindPhone(USER_ID, codeDto());

      expect(view.isReplaced).toBe(false);
      expect(view.phoneMasked).toBe('138****6721');
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('幂等路径返回历史行记录的绑定时间', async () => {
      const harness = createHarness();
      const hash = createHarness();
      await hash.service.bindPhone(USER_ID, codeDto());
      const phoneHash = (hash.tx.user.update.mock.calls[0][0] as { data: { phoneHash: string } }).data.phoneHash;
      harness.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, phoneHash });

      const view = await harness.service.bindPhone(USER_ID, codeDto());

      expect(view.boundAt).toBe('2026-02-01T00:00:00.000Z');
    });

    it('幂等路径不消耗换绑额度', async () => {
      const harness = createHarness();
      const hash = createHarness();
      await hash.service.bindPhone(USER_ID, codeDto());
      const phoneHash = (hash.tx.user.update.mock.calls[0][0] as { data: { phoneHash: string } }).data.phoneHash;
      harness.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, phoneHash });

      await harness.service.bindPhone(USER_ID, codeDto());

      expect(harness.redis.incrWithTtl).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 换绑
  // ==========================================================================

  describe('换绑', () => {
    it('换绑成功：标记旧号码被替换并写入新历史行', async () => {
      const harness = createHarness();
      harness.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, phoneHash: 'a'.repeat(64) });

      const view = await harness.service.bindPhone(USER_ID, codeDto());

      expect(view.isReplaced).toBe(true);
      expect(harness.tx.userPhoneHistory.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, replacedAt: null },
        data: { replacedAt: expect.any(Date) },
      });
      expect(harness.tx.userPhoneHistory.create).toHaveBeenCalledTimes(1);
    });

    it('换绑计数在 7 天窗口内累计', async () => {
      const harness = createHarness();
      harness.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, phoneHash: 'a'.repeat(64) });

      await harness.service.bindPhone(USER_ID, codeDto());

      expect(harness.redis.incrWithTtl).toHaveBeenCalledWith(expect.stringContaining(USER_ID), 7 * 24 * 60 * 60);
    });

    it('第 3 次换绑仍然允许', async () => {
      const harness = createHarness();
      harness.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, phoneHash: 'a'.repeat(64) });
      harness.redis.incrWithTtl.mockResolvedValue(3);

      await expect(harness.service.bindPhone(USER_ID, codeDto())).resolves.toMatchObject({
        isReplaced: true,
      });
    });

    it('【关键】超过 3 次换绑被拒且不写库', async () => {
      const harness = createHarness();
      harness.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, phoneHash: 'a'.repeat(64) });
      harness.redis.incrWithTtl.mockResolvedValue(4);

      await expectRejectedWithoutWrites(harness.service.bindPhone(USER_ID, codeDto()), ErrorCode.RATE_LIMITED, harness);
    });
  });

  // ==========================================================================
  // 号码归属冲突
  // ==========================================================================

  describe('号码归属冲突', () => {
    it('【关键】号码已属于他人时返回 409 且不写库', async () => {
      const harness = createHarness();
      harness.prisma.user.findUnique
        .mockResolvedValueOnce({ id: USER_ID, phoneHash: null })
        .mockResolvedValueOnce({ id: OTHER_USER_ID });

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, codeDto()),
        ErrorCode.PHONE_ALREADY_BOUND,
        harness,
      );
    });

    it('【关键】并发抢绑触发的唯一约束冲突被归一为 409（而非 500）', async () => {
      const harness = createHarness();
      harness.prisma.$transaction.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );

      await expect(harness.service.bindPhone(USER_ID, codeDto())).rejects.toMatchObject({
        code: ErrorCode.PHONE_ALREADY_BOUND,
      });
    });

    it('非唯一约束的数据库错误原样抛出（不掩盖真实故障）', async () => {
      const harness = createHarness();
      harness.prisma.$transaction.mockRejectedValue(Object.assign(new Error('connection lost'), { code: 'P1001' }));

      await expect(harness.service.bindPhone(USER_ID, codeDto())).rejects.toMatchObject({
        code: 'P1001',
      });
    });
  });

  // ==========================================================================
  // 请求校验与前置条件
  // ==========================================================================

  describe('请求校验与前置条件', () => {
    it('code 与 encryptedData 均缺失时返回 400', async () => {
      const harness = createHarness();

      await expectRejectedWithoutWrites(harness.service.bindPhone(USER_ID, {}), ErrorCode.PARAM_INVALID, harness);
    });

    it('仅有 encryptedData 而缺 iv 时返回 400', async () => {
      const harness = createHarness();

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, { encryptedData: 'abc' }),
        ErrorCode.PARAM_INVALID,
        harness,
      );
    });

    it('空字符串视为未提供', async () => {
      const harness = createHarness();

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, { code: '' }),
        ErrorCode.PARAM_INVALID,
        harness,
      );
    });

    it('注销冷静期内返回 403 且不调用微信', async () => {
      const harness = createHarness();
      harness.prisma.userDeletionRequest.findFirst.mockResolvedValue({ id: 'deletion-1' });

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, codeDto()),
        ErrorCode.PROFILE_EDIT_LOCKED,
        harness,
      );
      expect(harness.wechat.getPhoneNumber).not.toHaveBeenCalled();
    });

    it('用户不存在时返回 404', async () => {
      const harness = createHarness();
      harness.prisma.user.findUnique.mockResolvedValue(null);

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, codeDto()),
        ErrorCode.USER_NOT_FOUND,
        harness,
      );
    });

    it('非中国大陆号码被拒（不把可疑值写进唯一索引列）', async () => {
      const harness = createHarness();
      harness.wechat.getPhoneNumber.mockResolvedValue({
        phoneNumber: '+1 4155552671',
        purePhoneNumber: '4155552671',
        countryCode: '1',
      });

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, codeDto()),
        ErrorCode.PHONE_DECRYPT_FAILED,
        harness,
      );
    });

    it('微信换取失败时透传错误码且不写库', async () => {
      const harness = createHarness();
      harness.wechat.getPhoneNumber.mockRejectedValue(new BusinessException(ErrorCode.WECHAT_SESSION_EXPIRED));

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, codeDto()),
        ErrorCode.WECHAT_SESSION_EXPIRED,
        harness,
      );
    });
  });

  // ==========================================================================
  // 旧版 encryptedData 路径
  // ==========================================================================

  describe('旧版 encryptedData 路径', () => {
    it('用 session_key 解密成功并绑定', async () => {
      const harness = createHarness();

      const view = await harness.service.bindPhone(USER_ID, legacyDto());

      expect(view).toMatchObject({ phoneBound: true, phoneMasked: '138****6721' });
      expect(harness.wechat.getPhoneNumber).not.toHaveBeenCalled();
    });

    it('【关键】session_key 缺失或无法解密时返回 401（引导重新授权）', async () => {
      const harness = createHarness();
      harness.prisma.wechatAccount.findUnique.mockResolvedValue(null);

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, legacyDto()),
        ErrorCode.WECHAT_SESSION_EXPIRED,
        harness,
      );
    });

    it('【关键】解密失败返回 30008 且不写库', async () => {
      const harness = createHarness();

      // IV 合法长度但与加密时不同 → 解密失败
      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, {
          ...legacyDto(),
          iv: Buffer.from('0000000000000000', 'utf8').toString('base64'),
        }),
        ErrorCode.PHONE_DECRYPT_FAILED,
        harness,
      );
    });

    it('解密结果缺少手机号时返回 30008', async () => {
      const harness = createHarness();

      await expectRejectedWithoutWrites(
        harness.service.bindPhone(USER_ID, legacyDto(JSON.stringify({ watermark: { appid: 'x' } }))),
        ErrorCode.PHONE_DECRYPT_FAILED,
        harness,
      );
    });

    it('同时提供 code 与 encryptedData 时以 code 为准', async () => {
      const harness = createHarness();

      await harness.service.bindPhone(USER_ID, { ...legacyDto(), code: 'phone-code-abc' });

      expect(harness.wechat.getPhoneNumber).toHaveBeenCalledWith('phone-code-abc');
      expect(harness.prisma.wechatAccount.findUnique).not.toHaveBeenCalled();
    });
  });
});
