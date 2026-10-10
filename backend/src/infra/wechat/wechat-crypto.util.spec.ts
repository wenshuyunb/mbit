/**
 * 微信加密数据解密测试
 *
 * 本文件是**真实加解密往返**验证（不是断言「调用过某个 mock」）：
 * 测试侧用 `aes-128-cbc` 按微信的格式加密，再交给被测函数解密，
 * 因此能真正覆盖 padding、base64 解码与 JSON 解析三层失败路径。
 */

import { createCipheriv, randomBytes } from 'node:crypto';

import { WechatDecryptError, decryptWechatEncryptedData } from './wechat-crypto.util';

/** 固定 session_key（16 字节 → base64 24 字符） */
const SESSION_KEY = Buffer.from('0123456789abcdef', 'utf8');

/** 固定 IV（16 字节） */
const IV = Buffer.from('fedcba9876543210', 'utf8');

/** 按微信格式加密（AES-128-CBC + PKCS#7） */
const encryptLikeWechat = (plaintext: string, sessionKey: Buffer = SESSION_KEY, iv: Buffer = IV): string => {
  const cipher = createCipheriv('aes-128-cbc', sessionKey, iv);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
};

/** 断言抛出解密错误 */
const expectDecryptError = (execute: () => unknown): WechatDecryptError => {
  try {
    execute();
  } catch (error) {
    expect(error).toBeInstanceOf(WechatDecryptError);
    return error as WechatDecryptError;
  }
  throw new Error('期望抛出 WechatDecryptError，但函数正常返回');
};

describe('decryptWechatEncryptedData', () => {
  it('解密合法密文并返回对象（真实往返）', () => {
    const payload = {
      phoneNumber: '+86 13800006721',
      purePhoneNumber: '13800006721',
      countryCode: '86',
      watermark: { appid: 'wx123', timestamp: 1771000000 },
    };

    const result = decryptWechatEncryptedData({
      encryptedData: encryptLikeWechat(JSON.stringify(payload)),
      iv: IV.toString('base64'),
      sessionKey: SESSION_KEY.toString('base64'),
    });

    expect(result).toEqual(payload);
  });

  it('能解密含中文与 emoji 的明文（UTF-8 解码正确）', () => {
    const payload = { nickname: '小明', emoji: '😀', nested: { 中文键: '值' } };

    const result = decryptWechatEncryptedData({
      encryptedData: encryptLikeWechat(JSON.stringify(payload)),
      iv: IV.toString('base64'),
      sessionKey: SESSION_KEY.toString('base64'),
    });

    expect(result['nickname']).toBe('小明');
    expect(result['emoji']).toBe('😀');
    expect(result['nested']).toEqual({ 中文键: '值' });
  });

  it('每次加密结果不同（CBC 随机 IV 场景下密文可复现，但换 IV 即变化）', () => {
    const otherIv = randomBytes(16);
    const plaintext = JSON.stringify({ a: 1 });

    const first = decryptWechatEncryptedData({
      encryptedData: encryptLikeWechat(plaintext, SESSION_KEY, IV),
      iv: IV.toString('base64'),
      sessionKey: SESSION_KEY.toString('base64'),
    });
    const second = decryptWechatEncryptedData({
      encryptedData: encryptLikeWechat(plaintext, SESSION_KEY, otherIv),
      iv: otherIv.toString('base64'),
      sessionKey: SESSION_KEY.toString('base64'),
    });

    expect(first).toEqual(second);
  });

  it('【关键】session_key 长度不是 16 字节即拒绝（不做长度猜测）', () => {
    expectDecryptError(() =>
      decryptWechatEncryptedData({
        encryptedData: encryptLikeWechat('{}'),
        iv: IV.toString('base64'),
        sessionKey: 'short',
      }),
    );

    expectDecryptError(() =>
      decryptWechatEncryptedData({
        encryptedData: encryptLikeWechat('{}'),
        iv: IV.toString('base64'),
        // 32 字节密钥：AES-256 而非微信使用的 AES-128
        sessionKey: randomBytes(32).toString('base64'),
      }),
    );
  });

  it('【关键】iv 长度不是 16 字节即拒绝', () => {
    for (const badIv of ['', 'AAAA', randomBytes(12).toString('base64')]) {
      const error = expectDecryptError(() =>
        decryptWechatEncryptedData({
          encryptedData: encryptLikeWechat('{}'),
          iv: badIv,
          sessionKey: SESSION_KEY.toString('base64'),
        }),
      );
      expect(error.message).toContain('iv');
    }
  });

  it('session_key 缺失或为空时拒绝', () => {
    for (const badKey of ['', '   ']) {
      expectDecryptError(() =>
        decryptWechatEncryptedData({
          encryptedData: encryptLikeWechat('{}'),
          iv: IV.toString('base64'),
          sessionKey: badKey,
        }),
      );
    }
  });

  it('encryptedData 缺失时拒绝', () => {
    const error = expectDecryptError(() =>
      decryptWechatEncryptedData({
        encryptedData: '',
        iv: IV.toString('base64'),
        sessionKey: SESSION_KEY.toString('base64'),
      }),
    );
    expect(error.message).toContain('encryptedData');
  });

  it('密文被截断时拒绝（padding 校验失败）', () => {
    const cipherText = encryptLikeWechat(JSON.stringify({ a: 1 }));
    const truncated = Buffer.from(cipherText, 'base64').subarray(0, 8).toString('base64');

    expectDecryptError(() =>
      decryptWechatEncryptedData({
        encryptedData: truncated,
        iv: IV.toString('base64'),
        sessionKey: SESSION_KEY.toString('base64'),
      }),
    );
  });

  it('【关键】用错误的 session_key 解密必定抛出（绝不返回脏数据）', () => {
    const wrongKey = randomBytes(16);
    // 错误密钥下 padding 校验通常失败；极小概率 padding 侥幸合法，
    // 此时明文也不是合法 JSON —— 两条路径都抛出，因此断言「必抛」是稳健的
    expectDecryptError(() =>
      decryptWechatEncryptedData({
        encryptedData: encryptLikeWechat(JSON.stringify({ phoneNumber: '13800006721' }), SESSION_KEY),
        iv: IV.toString('base64'),
        sessionKey: wrongKey.toString('base64'),
      }),
    );
  });

  it('明文不是合法 JSON 时拒绝', () => {
    expectDecryptError(() =>
      decryptWechatEncryptedData({
        encryptedData: encryptLikeWechat('这不是 JSON'),
        iv: IV.toString('base64'),
        sessionKey: SESSION_KEY.toString('base64'),
      }),
    );
  });

  it('明文是 JSON 但非对象（数组 / null / 字符串）时拒绝', () => {
    for (const plaintext of ['[1,2,3]', 'null', '"just a string"', '42']) {
      expectDecryptError(() =>
        decryptWechatEncryptedData({
          encryptedData: encryptLikeWechat(plaintext),
          iv: IV.toString('base64'),
          sessionKey: SESSION_KEY.toString('base64'),
        }),
      );
    }
  });

  it('【关键】异常信息不包含明文内容（避免随日志外泄）', () => {
    const secret = '13800006721';
    const error = expectDecryptError(() =>
      decryptWechatEncryptedData({
        // 明文合法但外层 IV 错误 → 解密失败路径
        encryptedData: encryptLikeWechat(`{"phoneNumber":"${secret}"}`),
        iv: randomBytes(16).toString('base64'),
        sessionKey: SESSION_KEY.toString('base64'),
      }),
    );

    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(SESSION_KEY.toString('base64'));
  });
});
