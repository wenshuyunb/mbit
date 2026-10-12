/**
 * 微信支付商户侧签名与订单纯逻辑测试
 *
 * 签名用**真实 RSA 密钥对**验证（真签真验），格式差异用逐字符断言 ——
 * 这类代码的错误表现是"微信返回 401"，靠肉眼比对三种换行格式几乎不可能发现。
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';

import { buildMiniAppPayParams, normalizePemKey, randomNonce, signWithMerchantKey } from './wechat-pay-sign.util';
import {
  ORDER_TTL_MINUTES,
  buildProductSnapshot,
  generateOrderIdempotencyKey,
  generateOrderNo,
  isValidOrderNo,
  isValidPayAmount,
  normalizeClientIp,
  orderExpiresAt,
} from '../../modules/payment/order.util';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const NOW = new Date('2026-10-10T12:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));

/** 用公钥验证签名的原始字符串 */
const verifyPayload = (payload: string, signature: string): boolean => {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(payload, 'utf8');

  return verifier.verify(publicKey, Buffer.from(signature, 'base64'));
};

// 说明：这里原有两个 describe（`buildRequestSignaturePayload` 与
// `buildAuthorizationHeader`），它们断言的是 `mchid\nnonce_str\ntimestamp\nbody\n`
// 这一**不符合微信支付 v3 规范**的格式（缺请求方法与 URL），随实现一并删除。
// v3 官方格式（`METHOD\nURL\ntimestamp\nnonce_str\nbody\n`）的格式断言与真签真验
// 见 `wechat-pay-v3-sign.spec.ts`。

describe('signWithMerchantKey', () => {
  it('【关键】真实密钥对签出的内容可用公钥验过', () => {
    const payload = 'POST\n/v3/pay/transactions/jsapi\n1700000000\nn1\n{}\n';
    const signature = signWithMerchantKey(payload, privateKey);

    expect(verifyPayload(payload, signature)).toBe(true);
  });

  it('签名内容被改动即验不过', () => {
    const payload = 'a\nb\nc\n';
    const signature = signWithMerchantKey(payload, privateKey);

    expect(verifyPayload(`${payload}x`, signature)).toBe(false);
  });

  it('【关键】私钥格式非法时抛出带可操作提示的错误', () => {
    // 环境变量里存 PEM 时 `\n` 常是字面量而不是换行，这是最常见的失败原因
    expect(() => signWithMerchantKey('payload', 'not-a-key')).toThrow(/商户私钥签名失败/);
  });
});

describe('buildMiniAppPayParams', () => {
  it('【关键】字段名是驼峰 `timeStamp`，待签名字符串用 `package`', () => {
    const params = buildMiniAppPayParams({ appId: 'wx123', prepayId: 'pre_1', privateKeyPem: privateKey, now: NOW });

    expect(params.timeStamp).toBe(TIMESTAMP);
    expect(params.package).toBe('prepay_id=pre_1');
    expect(params.signType).toBe('RSA');
    // 请求头那边是 `timestamp`（下划线），这里是 `timeStamp`（驼峰）——
    // 照抄会签出一个永远验不过的 paySign，而开发者工具只提示"签名失败"
    expect(params.timeStamp).not.toBe('timestamp');
  });

  it('【关键】paySign 的待签名字符串为 `appId\\ntimeStamp\\nnonceStr\\npackage\\n`', () => {
    const params = buildMiniAppPayParams({ appId: 'wx123', prepayId: 'pre_1', privateKeyPem: privateKey, now: NOW });
    const payload = `wx123\n${params.timeStamp}\n${params.nonceStr}\nprepay_id=pre_1\n`;

    expect(verifyPayload(payload, params.paySign)).toBe(true);
  });
});

describe('normalizePemKey', () => {
  it('多行 PEM 原样返回（仅去首尾空白）', () => {
    expect(normalizePemKey(`  ${privateKey}  `)).toBe(privateKey.trim());
  });

  it('【关键】把字面量 `\\n` 还原成真实换行', () => {
    const singleLine = privateKey.trim().replace(/\n/g, '\\n');
    const restored = normalizePemKey(singleLine);

    expect(restored).toContain('\n');
    expect(restored).toBe(privateKey.trim());
  });

  it('既不是 PEM 也不含可还原换行时抛错', () => {
    expect(() => normalizePemKey('garbage')).toThrow();
  });
});

describe('randomNonce', () => {
  it('32 位十六进制（微信要求 ≤32 且无特殊字符）', () => {
    const nonce = randomNonce();

    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ============================================================================
// 订单
// ============================================================================

describe('generateOrderNo', () => {
  it('格式为 `SM` + yyyyMMdd + 10 位数字，共 20 位', () => {
    const orderNo = generateOrderNo(NOW);

    expect(orderNo).toMatch(/^SM\d{18}$/);
    expect(orderNo.length).toBe(20);
    expect(orderNo.startsWith('SM20261010')).toBe(true);
  });

  it('【关键】两次生成不同（避免同一用户重复下单撞号）', () => {
    expect(generateOrderNo(NOW)).not.toBe(generateOrderNo(NOW));
  });

  it('`isValidOrderNo` 与生成格式一致', () => {
    expect(isValidOrderNo(generateOrderNo(NOW))).toBe(true);
    expect(isValidOrderNo('SM123')).toBe(false);
    expect(isValidOrderNo('XX202610101234567890')).toBe(false);
  });
});

describe('orderExpiresAt', () => {
  it('默认 15 分钟', () => {
    expect(ORDER_TTL_MINUTES).toBe(15);
    expect(orderExpiresAt(NOW).toISOString()).toBe('2026-10-10T12:15:00.000Z');
  });
});

describe('normalizeClientIp', () => {
  it('【关键】去掉 IPv4-mapped IPv6 前缀', () => {
    // 带前缀的形态在风控规则里会被当成 IPv6，与纯 IPv4 规则匹配不上
    expect(normalizeClientIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeClientIp('1.2.3.4')).toBe('1.2.3.4');
  });

  it('空值与空白返回 null', () => {
    expect(normalizeClientIp(undefined)).toBeNull();
    expect(normalizeClientIp('  ')).toBeNull();
  });

  it('超长值截断到 64 字符（列长度限制）', () => {
    expect(normalizeClientIp('x'.repeat(100))?.length).toBe(64);
  });
});

describe('isValidPayAmount', () => {
  it('正整数分为合法', () => {
    expect(isValidPayAmount(1)).toBe(true);
    expect(isValidPayAmount(19900)).toBe(true);
  });

  it('【关键】0、负数、小数、非安全整数都非法', () => {
    // 微信要求整数分。小数与 0 都会被拒，及早拦掉而不是让它走到微信那一步
    for (const amount of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(isValidPayAmount(amount)).toBe(false);
    }
  });

  it('超过上限（1 亿元）非法', () => {
    expect(isValidPayAmount(100_000_001)).toBe(false);
  });
});

describe('buildProductSnapshot', () => {
  it('【关键】快照含价格与快照时间（订单必须固化下单当时的约定）', () => {
    const snapshot = buildProductSnapshot(
      {
        productId: 'p1',
        code: 'REPORT_PERSONAL',
        name: '单份报告解锁',
        priceAmount: 19900,
        productType: 'REPORT_PERSONAL',
        durationDays: null,
      },
      NOW,
    );

    expect(snapshot.priceAmount).toBe(19900);
    // 商品价格日后会被运营修改；没有快照时间就无从回答
    // "为什么这个订单是 19.9 而现在是 29.9"
    expect(snapshot.snapshotAt).toBe(NOW.toISOString());
    expect(snapshot.name).toBe('单份报告解锁');
  });
});

describe('generateOrderIdempotencyKey', () => {
  it('24 位十六进制且每次不同', () => {
    const key = generateOrderIdempotencyKey();

    expect(key).toMatch(/^[0-9a-f]{24}$/);
    expect(key).not.toBe(generateOrderIdempotencyKey());
  });
});
