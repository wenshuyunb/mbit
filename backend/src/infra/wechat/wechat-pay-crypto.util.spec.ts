/**
 * 微信支付 v3 验签与解密测试
 *
 * **全部使用真实加解密往返**（真 RSA 密钥对、真 AES-256-GCM），不使用桩：
 * 这类代码的价值就在于"算得对"，用桩测等于把公式抄一遍再断言自己抄对了 ——
 * 真实的密钥长度、tag 位置、AAD 一致性这些坑一个都测不出来。
 *
 * 与 `wechat-crypto.util.spec.ts` 同一取向。
 */

import { createCipheriv, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

import {
  TIMESTAMP_TOLERANCE_SECONDS,
  WechatPayCryptoError,
  buildWechatPaySignaturePayload,
  decryptWechatPayResource,
  isWechatPayTimestampFresh,
  safeEquals,
  verifyWechatPaySignature,
} from './wechat-pay-crypto.util';

// ---------------------------------------------------------------------------
// 夹具：真实 RSA 密钥对
// ---------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** 用私钥对回调签名 */
const sign = (timestamp: string, nonce: string, body: string): string => {
  const signer = createSign('RSA-SHA256');
  signer.update(buildWechatPaySignaturePayload(timestamp, nonce, body), 'utf8');

  return signer.sign(privateKey, 'base64');
};

const API_V3_KEY = 'a'.repeat(32);

/** 按微信的格式加密 `resource`（tag 拼在密文末尾） */
const encryptResource = (
  payload: Record<string, unknown>,
  options: { key?: string; nonce?: string; associatedData?: string } = {},
): { ciphertext: string; nonce: string; associatedData: string } => {
  const key = Buffer.from(options.key ?? API_V3_KEY, 'utf8');
  const nonce = Buffer.from(options.nonce ?? 'b'.repeat(12), 'utf8');
  const associatedData = options.associatedData ?? 'transaction';

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));

  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);

  return {
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
    nonce: nonce.toString('utf8'),
    associatedData,
  };
};

const BODY = JSON.stringify({ id: 'evt-1', event_type: 'TRANSACTION.SUCCESS' });
const NONCE = 'nonce-1234567890';
const TIMESTAMP = '1770000000';

// ============================================================================
// 待签名字符串
// ============================================================================

describe('buildWechatPaySignaturePayload', () => {
  it('【关键】末尾的换行不能少', () => {
    // 少了它签名永远不匹配，而错误表现只是"验签失败"，很难看出是格式问题
    expect(buildWechatPaySignaturePayload('100', 'abc', '{}')).toBe('100\nabc\n{}\n');
  });
});

// ============================================================================
// 验签
// ============================================================================

describe('verifyWechatPaySignature', () => {
  it('【关键】真实密钥对签名的回调验签通过', () => {
    expect(
      verifyWechatPaySignature({
        timestamp: TIMESTAMP,
        nonce: NONCE,
        body: BODY,
        signature: sign(TIMESTAMP, NONCE, BODY),
        platformCertificatePem: publicKey,
      }),
    ).toBe(true);
  });

  it('【关键】请求体被改动一个字节即失败', () => {
    const signature = sign(TIMESTAMP, NONCE, BODY);
    const tampered = BODY.replace('evt-1', 'evt-2');

    expect(
      verifyWechatPaySignature({
        timestamp: TIMESTAMP,
        nonce: NONCE,
        body: tampered,
        signature,
        platformCertificatePem: publicKey,
      }),
    ).toBe(false);
  });

  it('时间戳或随机串被改动即失败', () => {
    const signature = sign(TIMESTAMP, NONCE, BODY);

    for (const [timestamp, nonce] of [
      ['1770000001', NONCE],
      [TIMESTAMP, 'other-nonce'],
    ]) {
      expect(
        verifyWechatPaySignature({
          timestamp,
          nonce,
          body: BODY,
          signature,
          platformCertificatePem: publicKey,
        }),
      ).toBe(false);
    }
  });

  it('【关键】换一把公钥即失败（防止自签证书伪造回调）', () => {
    const { publicKey: otherPublicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    expect(
      verifyWechatPaySignature({
        timestamp: TIMESTAMP,
        nonce: NONCE,
        body: BODY,
        signature: sign(TIMESTAMP, NONCE, BODY),
        platformCertificatePem: otherPublicKey,
      }),
    ).toBe(false);
  });

  it('【关键】非法输入返回 false 而不抛错', () => {
    // 抛错会让调用方不得不用 try/catch 当控制流，且异常信息可能被
    // 全局异常过滤器带进响应
    for (const params of [
      { signature: 'not-base64!!', platformCertificatePem: publicKey },
      { signature: sign(TIMESTAMP, NONCE, BODY), platformCertificatePem: 'not-a-cert' },
      { signature: '', platformCertificatePem: '' },
    ]) {
      expect(
        verifyWechatPaySignature({
          timestamp: TIMESTAMP,
          nonce: NONCE,
          body: BODY,
          ...params,
        }),
      ).toBe(false);
    }
  });
});

// ============================================================================
// 时间戳新鲜度
// ============================================================================

describe('isWechatPayTimestampFresh', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it('当前时间为真', () => {
    expect(isWechatPayTimestampFresh(String(nowSeconds), now)).toBe(true);
  });

  it('【关键】边界：正好 300 秒放行，301 秒拒绝', () => {
    expect(isWechatPayTimestampFresh(String(nowSeconds - TIMESTAMP_TOLERANCE_SECONDS), now)).toBe(true);
    expect(isWechatPayTimestampFresh(String(nowSeconds - TIMESTAMP_TOLERANCE_SECONDS - 1), now)).toBe(false);
  });

  it('【关键】未来时间戳同样拒绝（双向比较）', () => {
    // 只判"太旧"的话，服务器时钟被校正到未来时会放行一批未来时间戳的回调
    expect(isWechatPayTimestampFresh(String(nowSeconds + TIMESTAMP_TOLERANCE_SECONDS), now)).toBe(true);
    expect(isWechatPayTimestampFresh(String(nowSeconds + TIMESTAMP_TOLERANCE_SECONDS + 1), now)).toBe(false);
  });

  it('【关键】非纯数字一律拒绝', () => {
    // `Number('')` 是 0（会被判"太旧"而拒绝，方向安全），
    // 但 `Number(' 12 ')` 这类宽容解析会让边界判断不可预测
    for (const bad of ['', '  ', 'abc', '12.5', '1e9', ' 12 ', '+12', 'NaN', 'Infinity']) {
      expect(isWechatPayTimestampFresh(bad, now)).toBe(false);
    }
  });

  it('超出安全整数范围时拒绝', () => {
    expect(isWechatPayTimestampFresh('99999999999999999999', now)).toBe(false);
  });
});

// ============================================================================
// 解密
// ============================================================================

describe('decryptWechatPayResource', () => {
  it('【关键】真实 AES-256-GCM 往返（含 tag 在末尾的微信格式）', () => {
    const payload = {
      mchid: '1900000109',
      out_trade_no: 'SM20261010000001',
      transaction_id: '4200001234202610101234567890',
      trade_state: 'SUCCESS',
      amount: { total: 19900, payer_total: 19900, currency: 'CNY' },
    };
    const resource = encryptResource(payload);

    expect(decryptWechatPayResource({ ...resource, apiV3Key: API_V3_KEY })).toEqual(payload);
  });

  it('【关键】额外（恶意）字段原样返回，由调用方决定是否使用', () => {
    // 解密层不做字段白名单：它只保证"这是微信加密的内容"。
    // 字段校验属于业务层，混在这里会让"解密失败"与"字段非法"两类问题难以区分
    const resource = encryptResource({ out_trade_no: 'X1', injected: 'evil' });
    const decrypted = decryptWechatPayResource({ ...resource, apiV3Key: API_V3_KEY });

    expect(decrypted.injected).toBe('evil');
  });

  it('【关键】密钥错误即认证失败（不能用错密钥解出内容）', () => {
    const resource = encryptResource({ out_trade_no: 'X1' });

    expect(() => decryptWechatPayResource({ ...resource, apiV3Key: 'b'.repeat(32) })).toThrow(WechatPayCryptoError);
  });

  it('【关键】AAD 不一致即认证失败', () => {
    const resource = encryptResource({ out_trade_no: 'X1' }, { associatedData: 'transaction' });

    expect(() => decryptWechatPayResource({ ...resource, associatedData: 'refund', apiV3Key: API_V3_KEY })).toThrow(
      WechatPayCryptoError,
    );
  });

  it('密文被篡改即认证失败', () => {
    const resource = encryptResource({ out_trade_no: 'X1' });
    const raw = Buffer.from(resource.ciphertext, 'base64');
    raw[0] = (raw[0] ?? 0) ^ 0xff;

    expect(() =>
      decryptWechatPayResource({ ...resource, ciphertext: raw.toString('base64'), apiV3Key: API_V3_KEY }),
    ).toThrow(WechatPayCryptoError);
  });

  it('【关键】key / nonce 长度不合法时明确报错（而不是解出乱码）', () => {
    const resource = encryptResource({ out_trade_no: 'X1' });

    expect(() => decryptWechatPayResource({ ...resource, apiV3Key: 'short' })).toThrow(/apiV3Key/);
    expect(() => decryptWechatPayResource({ ...resource, nonce: 'short', apiV3Key: API_V3_KEY })).toThrow(/nonce/);
  });

  it('密文长度不足（缺认证标签）时明确报错', () => {
    const resource = encryptResource({ out_trade_no: 'X1' });

    expect(() =>
      decryptWechatPayResource({ ...resource, ciphertext: randomBytes(8).toString('base64'), apiV3Key: API_V3_KEY }),
    ).toThrow(/长度不足/);
  });

  it('【关键】明文不是 JSON 对象时抛错', () => {
    const key = Buffer.from(API_V3_KEY, 'utf8');
    const nonce = Buffer.from('b'.repeat(12), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('transaction', 'utf8'));
    const encrypted = Buffer.concat([cipher.update('"[1,2,3]"', 'utf8'), cipher.final()]);

    expect(() =>
      decryptWechatPayResource({
        ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
        nonce: nonce.toString('utf8'),
        associatedData: 'transaction',
        apiV3Key: API_V3_KEY,
      }),
    ).toThrow(/JSON 对象/);
  });

  it('空 associatedData 与未设置 AAD 不等价（必须显式设置空串）', () => {
    // GCM 里"不设置 AAD"与"设置空 AAD"在实现上通常等价，
    // 但 `setAAD` 若不调用，某些实现会与加密端不一致 —— 这里用真实往返确认一致
    const resource = encryptResource({ out_trade_no: 'X1' }, { associatedData: '' });

    expect(decryptWechatPayResource({ ...resource, apiV3Key: API_V3_KEY })).toEqual({ out_trade_no: 'X1' });
  });
});

// ============================================================================
// 常量时间比较
// ============================================================================

describe('safeEquals', () => {
  it('相同字符串为真，不同为假', () => {
    expect(safeEquals('1900000109', '1900000109')).toBe(true);
    expect(safeEquals('1900000109', '1900000108')).toBe(false);
  });

  it('【关键】长度不同返回 false 而不是抛错', () => {
    // `timingSafeEqual` 对长度不等的入参会抛错；长度本身不是秘密，
    // 直接返回 false 即可
    expect(safeEquals('abc', 'abcd')).toBe(false);
    expect(safeEquals('', 'a')).toBe(false);
    expect(safeEquals('', '')).toBe(true);
  });

  it('中文与多字节字符按 UTF-8 字节比较', () => {
    expect(safeEquals('订单', '订单')).toBe(true);
    expect(safeEquals('订单', '订単')).toBe(false);
  });
});
