/**
 * 加密服务测试
 *
 * 覆盖「安全属性」而非仅「能加密能解密」：
 *   · 同一明文两次加密结果不同（IV 随机化，防止密文可比对）
 *   · 密文被篡改必须解密失败（GCM 认证能力，而非静默返回错误明文）
 *   · 解密失败不泄露具体原因（不给攻击者反馈信号）
 *   · 密钥非法时启动告警、调用时报错（fail closed，不静默降级为明文）
 */

import type { ConfigService } from '@nestjs/config';
import { CryptoService, parseDurationToSeconds } from './crypto.service';
import { BusinessException } from '../../common/errors/business.exception';
import type { AppConfig } from '../../config/config.type';

/** 32 字节 base64 密钥（仅测试用；必须恰好 32 字节，AES-256 要求） */
const TEST_KEY_BASE64 = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');

const createService = (key: string = TEST_KEY_BASE64): CryptoService => {
  const configService = {
    get: (path: string) => {
      if (path === 'crypto.key') return key;
      if (path === 'crypto.ivSalt') return 'test_salt';
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;

  return new CryptoService(configService);
};

describe('CryptoService', () => {
  describe('AES-256-GCM 加解密', () => {
    it('加密后可正确解密（含中文与 emoji）', () => {
      const service = createService();
      const plaintext = 'session_key_abc123_中文_🔐';

      const ciphertext = service.encrypt(plaintext);

      expect(ciphertext).not.toBe(plaintext);
      expect(ciphertext.startsWith('v1.')).toBe(true);
      expect(service.decrypt(ciphertext)).toBe(plaintext);
    });

    it('密文格式为 v1.<iv>.<tag>.<data>，各段为 base64url', () => {
      const service = createService();
      const parts = service.encrypt('hello').split('.');

      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('v1');
      // base64url 不含 + / =
      for (const part of parts.slice(1)) {
        expect(part).not.toMatch(/[+/=]/);
      }
    });

    it('同一明文两次加密结果不同（IV 随机化）', () => {
      const service = createService();
      const first = service.encrypt('same-input');
      const second = service.encrypt('same-input');

      // 若此处相等，说明 IV 被复用 —— 在 GCM 下等同于密钥流复用，属于严重缺陷
      expect(first).not.toBe(second);
      expect(service.decrypt(first)).toBe('same-input');
      expect(service.decrypt(second)).toBe('same-input');
    });

    it('空字符串可正常往返', () => {
      const service = createService();
      const ciphertext = service.encrypt('');

      expect(ciphertext.split('.')[3]).toBe('');
      expect(service.decrypt(ciphertext)).toBe('');
    });

    it('长文本（模拟大 JSON）可正常往返', () => {
      const service = createService();
      const plaintext = JSON.stringify({ scores: Array.from({ length: 500 }, (_, index) => index) });

      expect(service.decrypt(service.encrypt(plaintext))).toBe(plaintext);
    });

    describe('完整性校验（GCM 认证加密）', () => {
      it('密文被篡改时解密失败，而不是返回错误明文', () => {
        const service = createService();
        const parts = service.encrypt('important-data').split('.');

        // 在**字节层**翻转一位：直接改 base64 末位可能只改动填充位而被解码还原，
        // 导致测试结果不确定。字节层篡改必定改变真实内容。
        const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
        ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;

        const tampered = [parts[0], parts[1], parts[2], ciphertext.toString('base64url')].join('.');

        expect(() => service.decrypt(tampered)).toThrow(BusinessException);
      });

      it('认证标签被篡改时解密失败', () => {
        const service = createService();
        const parts = service.encrypt('important-data').split('.');

        const authTag = Buffer.from(parts[2] ?? '', 'base64url');
        authTag[0] = (authTag[0] ?? 0) ^ 0xff;

        const tampered = [parts[0], parts[1], authTag.toString('base64url'), parts[3]].join('.');

        expect(() => service.decrypt(tampered)).toThrow(BusinessException);
      });

      it('用另一把密钥解密会失败（而非得到乱码）', () => {
        const otherKey = Buffer.from('fedcba9876543210fedcba9876543210', 'utf8').toString('base64');
        const encrypted = createService().encrypt('secret');

        expect(() => createService(otherKey).decrypt(encrypted)).toThrow(BusinessException);
      });
    });

    describe('异常输入', () => {
      it.each([
        ['分段数量不足', 'v1.abc.def'],
        ['完全非法', 'not-a-ciphertext'],
        ['版本不支持', 'v9.a.b.c'],
      ])('%s → 抛出业务异常', (_label, payload) => {
        const service = createService();
        expect(() => service.decrypt(payload)).toThrow(BusinessException);
      });

      it('解密失败的对外信息不区分原因（无反馈信号）', () => {
        const service = createService();

        const messages = ['v1.a.b.c', 'garbage', 'v9.x.y.z'].map((payload) => {
          try {
            service.decrypt(payload);
            return 'no-error';
          } catch (error) {
            return (error as BusinessException).userMessage;
          }
        });

        expect(new Set(messages).size).toBe(1);
        expect(messages[0]).toBe('数据解密失败');
      });

      it('tryDecrypt 对空值返回 null，对坏数据返回 null 而不抛异常', () => {
        const service = createService();

        expect(service.tryDecrypt(null)).toBeNull();
        expect(service.tryDecrypt(undefined)).toBeNull();
        expect(service.tryDecrypt('')).toBeNull();
        expect(service.tryDecrypt('garbage')).toBeNull();
        expect(service.tryDecrypt(service.encrypt('ok'))).toBe('ok');
      });
    });

    it('密钥未配置时调用加解密失败（fail closed，不降级为明文）', () => {
      const service = createService('');

      expect(() => service.encrypt('x')).toThrow(BusinessException);
      expect(() => service.decrypt('v1.a.b.c')).toThrow(BusinessException);
    });

    it('密钥长度非法时（非 32 字节）视为未配置', () => {
      const shortKey = Buffer.from('too-short', 'utf8').toString('base64');
      const service = createService(shortKey);

      expect(() => service.encrypt('x')).toThrow(BusinessException);
    });
  });

  describe('摘要与随机数', () => {
    it('sha256 输出稳定的 64 位十六进制', () => {
      const service = createService();
      const hash = service.sha256('13800138000');

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(service.sha256('13800138000')).toBe(hash);
      expect(service.sha256('13800138001')).not.toBe(hash);
    });

    it('randomToken 每次不同且为 base64url', () => {
      const service = createService();
      const tokens = new Set(Array.from({ length: 200 }, () => service.randomToken()));

      expect(tokens.size).toBe(200);
      for (const token of tokens) {
        expect(token).not.toMatch(/[+/=]/);
        // 32 字节 base64url ≈ 43 字符
        expect(token.length).toBeGreaterThanOrEqual(42);
      }
    });

    it('generateRefreshToken 带 rt_ 前缀（便于识别令牌类型）', () => {
      const service = createService();
      expect(service.generateRefreshToken().startsWith('rt_')).toBe(true);
    });

    it('safeEqual 等长时正确比较，长度不等直接 false', () => {
      const service = createService();

      expect(service.safeEqual('abc', 'abc')).toBe(true);
      expect(service.safeEqual('abc', 'abd')).toBe(false);
      expect(service.safeEqual('abc', 'abcd')).toBe(false);
      expect(service.safeEqual('', '')).toBe(true);
    });
  });

  describe('parseDurationToSeconds', () => {
    it.each([
      ['7200', 7200],
      ['30s', 30],
      ['15m', 900],
      ['2h', 7200],
      ['30d', 2592000],
      [' 2h ', 7200],
    ])('%s → %i 秒', (input, expected) => {
      expect(parseDurationToSeconds(input)).toBe(expected);
    });

    it('无法解析时回退 0（暴露配置错误而不是静默用错值）', () => {
      expect(parseDurationToSeconds('abc')).toBe(0);
      expect(parseDurationToSeconds('')).toBe(0);
      expect(parseDurationToSeconds('-5')).toBe(0);
    });
  });
});
