/**
 * 微信支付 v3 官方签名测试（查单 / 关单 / 退款方向）
 *
 * 本文件与 `wechat-pay-sign.util.spec.ts` **刻意分开**：那个文件断言的是既有的
 * `mchid\nnonce\ntimestamp\nbody\n` 形态（v2 思路），而 v3 官方规范要求
 * `METHOD\nURL\ntimestamp\nnonce\nbody\n`。两者不能混在一个 describe 里 ——
 * 放在一起会让人以为"随便哪种都行"，而实际结果是 401 SIGN_ERROR。
 *
 * 用**真实 RSA 密钥对**做真签真验：格式错了但"看起来对"的签名只能靠公钥验证发现。
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';

import { buildV3AuthorizationHeader, buildV3SignaturePayload } from './wechat-pay-sign.util';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const NOW = new Date('2026-10-10T12:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));

const verify = (payload: string, signature: string): boolean => {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(payload, 'utf8');

  return verifier.verify(publicKey, Buffer.from(signature, 'base64'));
};

describe('buildV3SignaturePayload', () => {
  it('【关键】五段式且以换行结尾，方法为大写', () => {
    expect(
      buildV3SignaturePayload({
        method: 'get',
        urlPath: '/v3/pay/transactions/out-trade-no/SM1?mchid=1900000109',
        timestamp: '1770000000',
        nonceStr: 'n1',
        body: '',
      }),
    ).toBe('GET\n/v3/pay/transactions/out-trade-no/SM1?mchid=1900000109\n1770000000\nn1\n\n');
  });

  it('【关键】URL 里的 query string 参与签名（漏掉它必然验签失败）', () => {
    const withQuery = buildV3SignaturePayload({
      method: 'GET',
      urlPath: '/v3/pay/transactions/out-trade-no/SM1?mchid=1',
      timestamp: 't',
      nonceStr: 'n',
      body: '',
    });
    const withoutQuery = buildV3SignaturePayload({
      method: 'GET',
      urlPath: '/v3/pay/transactions/out-trade-no/SM1',
      timestamp: 't',
      nonceStr: 'n',
      body: '',
    });

    expect(withQuery).not.toBe(withoutQuery);
  });

  it('与 v2 形态不同（防止有人把两个函数当成"等价实现"）', () => {
    const v3 = buildV3SignaturePayload({
      method: 'POST',
      urlPath: '/v3/refund/domestic/refunds',
      timestamp: TIMESTAMP,
      nonceStr: 'n',
      body: '{"a":1}',
    });

    // v2 形态是 `mchid\nnonce\ntimestamp\nbody\n`
    expect(v3).not.toBe(`1900000109\nn\n${TIMESTAMP}\n{"a":1}\n`);
    expect(v3.startsWith('POST\n')).toBe(true);
  });
});

describe('buildV3AuthorizationHeader', () => {
  const header = (): string =>
    buildV3AuthorizationHeader({
      mchId: '1900000109',
      serialNo: 'SERIAL123',
      privateKeyPem: privateKey,
      method: 'POST',
      urlPath: '/v3/refund/domestic/refunds',
      body: '{"out_refund_no":"RF1"}',
      now: NOW,
    });

  it('头格式与五个字段名（下划线）正确', () => {
    const value = header();

    expect(value.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true);
    expect(value).toContain('mchid="1900000109"');
    expect(value).toContain('nonce_str="');
    expect(value).toContain('signature="');
    expect(value).toContain(`timestamp="${TIMESTAMP}"`);
    expect(value).toContain('serial_no="SERIAL123"');
  });

  it('【关键】头里的签名能覆盖「方法 + URL + body」三者', () => {
    const body = '{"out_refund_no":"RF1"}';
    const urlPath = '/v3/refund/domestic/refunds';
    const value = buildV3AuthorizationHeader({
      mchId: '1900000109',
      serialNo: 'SERIAL123',
      privateKeyPem: privateKey,
      method: 'POST',
      urlPath,
      body,
      now: NOW,
    });

    const nonce = /nonce_str="([^"]+)"/.exec(value)?.[1] ?? '';
    const signature = /signature="([^"]+)"/.exec(value)?.[1] ?? '';
    const payload = buildV3SignaturePayload({ method: 'POST', urlPath, timestamp: TIMESTAMP, nonceStr: nonce, body });

    expect(verify(payload, signature)).toBe(true);

    // 改方法、改 URL、改 body 任一者都应验不过 —— 三者确实都在待签名串里
    expect(
      verify(
        buildV3SignaturePayload({ method: 'GET', urlPath, timestamp: TIMESTAMP, nonceStr: nonce, body }),
        signature,
      ),
    ).toBe(false);
    expect(
      verify(
        buildV3SignaturePayload({
          method: 'POST',
          urlPath: `${urlPath}x`,
          timestamp: TIMESTAMP,
          nonceStr: nonce,
          body,
        }),
        signature,
      ),
    ).toBe(false);
    expect(
      verify(
        buildV3SignaturePayload({
          method: 'POST',
          urlPath,
          timestamp: TIMESTAMP,
          nonceStr: nonce,
          body: '{"out_refund_no":"RF2"}',
        }),
        signature,
      ),
    ).toBe(false);
  });

  it('GET 请求空 body 也要能签出（查单/查退款用）', () => {
    const value = buildV3AuthorizationHeader({
      mchId: '1900000109',
      serialNo: 'SERIAL123',
      privateKeyPem: privateKey,
      method: 'GET',
      urlPath: '/v3/pay/transactions/out-trade-no/SM1?mchid=1900000109',
      body: '',
      now: NOW,
    });

    const nonce = /nonce_str="([^"]+)"/.exec(value)?.[1] ?? '';
    const signature = /signature="([^"]+)"/.exec(value)?.[1] ?? '';
    const payload = buildV3SignaturePayload({
      method: 'GET',
      urlPath: '/v3/pay/transactions/out-trade-no/SM1?mchid=1900000109',
      timestamp: TIMESTAMP,
      nonceStr: nonce,
      body: '',
    });

    expect(verify(payload, signature)).toBe(true);
  });

  it('两次调用的 nonce 不同（不可预测）', () => {
    expect(header()).not.toBe(header());
  });
});
