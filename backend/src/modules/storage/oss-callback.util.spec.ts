/**
 * OSS 回调验签与魔数校验测试
 *
 * 本文件是**真实密码学往返**验证：测试侧用 `generateKeyPairSync` 生成 RSA 密钥对，
 * 用私钥按阿里云规则签名，再交给被测函数验签。因此能真正覆盖
 * 「签名算法、被签名字节串构造、公钥解析」三层，而不是断言「调用过某个 mock」。
 *
 * 重点覆盖的是**拒绝**分支：本接口公开无鉴权，每条放行分支都必须是
 * 「攻击者无法构造」的，而不是「我们没写过那种情况」。
 */

import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import {
  MAGIC_BYTES_REQUIRED,
  buildCallbackSignaturePayload,
  detectMimeTypeFromMagic,
  isTrustedOssPublicKeyUrl,
  parseOssAuthorization,
  verifyOssCallbackSignature,
} from './oss-callback.util';

// ============================================================================
// 夹具
// ============================================================================

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** 另一个密钥对（模拟攻击者自己的密钥） */
const attackerKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const CALLBACK_URL = 'https://api.soulmap.cn/api/v1/storage/callback';
const CALLBACK_BODY = JSON.stringify({
  objectKey: 'avatar/0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70/20260214_a7c3f9e1b2d4c6a8.webp',
  etag: 'F1A2B3C4D5E6F708192A3B4C5D6E7F80',
  size: 86420,
  mimeType: 'image/webp',
});

/** 按阿里云规则生成 Authorization 头 */
const buildAuthorization = (signingKey: string, url = CALLBACK_URL, body = CALLBACK_BODY): string => {
  const signature = cryptoSign('RSA-SHA1', Buffer.from(buildCallbackSignaturePayload(url, body), 'utf8'), signingKey);
  return `OSS LTAI5tTestKeyId:${signature.toString('base64')}`;
};

/** 构造文件头缓冲 */
const withHeader = (bytes: number[], totalLength = MAGIC_BYTES_REQUIRED): Buffer => {
  const buffer = Buffer.alloc(totalLength, 0x00);
  Buffer.from(bytes).copy(buffer);
  return buffer;
};

const JPEG = withHeader([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(4),
]);
const PDF = withHeader([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

// ============================================================================

describe('detectMimeTypeFromMagic', () => {
  it('识别 JPEG / PNG / WebP / PDF', () => {
    expect(detectMimeTypeFromMagic(JPEG)).toBe('image/jpeg');
    expect(detectMimeTypeFromMagic(PNG)).toBe('image/png');
    expect(detectMimeTypeFromMagic(WEBP)).toBe('image/webp');
    expect(detectMimeTypeFromMagic(PDF)).toBe('application/pdf');
  });

  it('【关键】无法识别时返回 null（调用方不得回退为信任声明值）', () => {
    expect(detectMimeTypeFromMagic(withHeader([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    // HTML 文件（伪装成图片的典型攻击载荷）
    expect(detectMimeTypeFromMagic(withHeader([0x3c, 0x21, 0x44, 0x4f]))).toBeNull();
    // ELF 可执行文件
    expect(detectMimeTypeFromMagic(withHeader([0x7f, 0x45, 0x4c, 0x46]))).toBeNull();
  });

  it('【关键】RIFF 容器但不是 WebP 时返回 null（WAV 不应被当成图片）', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
      Buffer.alloc(4),
    ]);

    expect(detectMimeTypeFromMagic(wav)).toBeNull();
  });

  it('【关键】字节数不足时不误判（PNG 需完整 8 字节签名）', () => {
    // 只给 4 字节 PNG 前缀：契约写的是 4 字节，但实现要求完整 8 字节更严格
    expect(detectMimeTypeFromMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    // 只给 2 字节 JPEG 前缀（FFD8 缺少第三个 FF）
    expect(detectMimeTypeFromMagic(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('空缓冲与非 Buffer 输入返回 null', () => {
    expect(detectMimeTypeFromMagic(Buffer.alloc(0))).toBeNull();
    expect(detectMimeTypeFromMagic('not a buffer' as unknown as Buffer)).toBeNull();
  });

  it('【关键】PDF 只认前缀 %PDF，且不误判 %PDX', () => {
    expect(detectMimeTypeFromMagic(withHeader([0x25, 0x50, 0x44, 0x58]))).toBeNull();
  });
});

describe('parseOssAuthorization', () => {
  it('解析标准形态', () => {
    expect(parseOssAuthorization('OSS LTAI5tKey:YWJjZGVm+/==')).toEqual({
      accessKeyId: 'LTAI5tKey',
      signature: 'YWJjZGVm+/==',
    });
  });

  it('允许前后空白（HTTP 头可能带空格）', () => {
    expect(parseOssAuthorization('  OSS key:sig  ')).toEqual({ accessKeyId: 'key', signature: 'sig' });
  });

  it('【关键】缺失或形态不符时返回 null', () => {
    expect(parseOssAuthorization(undefined)).toBeNull();
    expect(parseOssAuthorization('')).toBeNull();
    expect(parseOssAuthorization('Bearer abc:def')).toBeNull();
    expect(parseOssAuthorization('OSS nosignature')).toBeNull();
    // base64 中不会出现空格，故带空格的签名必然非法
    expect(parseOssAuthorization('OSS key:sig with space')).toBeNull();
  });
});

describe('buildCallbackSignaturePayload', () => {
  it('URL 与 body 之间以单个换行符连接（阿里云规则）', () => {
    expect(buildCallbackSignaturePayload('https://a.cn/cb', '{"a":1}')).toBe('https://a.cn/cb\n{"a":1}');
  });

  it('body 中的换行原样保留（不做规范化）', () => {
    expect(buildCallbackSignaturePayload('u', '{\n"a":1\n}')).toBe('u\n{\n"a":1\n}');
  });
});

describe('verifyOssCallbackSignature', () => {
  it('真实私钥签名验签通过', () => {
    expect(
      verifyOssCallbackSignature({
        publicKeyPem: publicKey,
        authorization: buildAuthorization(privateKey),
        url: CALLBACK_URL,
        rawBody: CALLBACK_BODY,
      }),
    ).toBe(true);
  });

  it('【关键】body 被篡改即验签失败', () => {
    const tampered = CALLBACK_BODY.replace('86420', '99999');

    expect(
      verifyOssCallbackSignature({
        publicKeyPem: publicKey,
        authorization: buildAuthorization(privateKey),
        url: CALLBACK_URL,
        rawBody: tampered,
      }),
    ).toBe(false);
  });

  it('【关键】URL 不匹配即验签失败（防重放到其他路径）', () => {
    expect(
      verifyOssCallbackSignature({
        publicKeyPem: publicKey,
        authorization: buildAuthorization(privateKey),
        url: 'https://api.soulmap.cn/api/v1/storage/other',
        rawBody: CALLBACK_BODY,
      }),
    ).toBe(false);
  });

  it('【关键】换用他人私钥签名时验签失败', () => {
    expect(
      verifyOssCallbackSignature({
        publicKeyPem: publicKey,
        authorization: buildAuthorization(attackerKeys.privateKey),
        url: CALLBACK_URL,
        rawBody: CALLBACK_BODY,
      }),
    ).toBe(false);
  });

  it('【关键】换用他人公钥 + 他人签名时验签通过 —— 因此公钥来源必须另行限制', () => {
    // 这条用例说明「验签本身」不足以自证来源：只要公钥可被替换，
    // 攻击者就能用自己的密钥对通过验签。真正的防线是 isTrustedOssPublicKeyUrl。
    expect(
      verifyOssCallbackSignature({
        publicKeyPem: attackerKeys.publicKey,
        authorization: buildAuthorization(attackerKeys.privateKey),
        url: CALLBACK_URL,
        rawBody: CALLBACK_BODY,
      }),
    ).toBe(true);
  });

  it('Authorization 缺失或形态非法时失败（不抛异常）', () => {
    for (const authorization of [undefined, '', 'garbage', 'OSS key']) {
      expect(
        verifyOssCallbackSignature({
          publicKeyPem: publicKey,
          authorization,
          url: CALLBACK_URL,
          rawBody: CALLBACK_BODY,
        }),
      ).toBe(false);
    }
  });

  it('公钥不可解析时失败（不抛异常）', () => {
    for (const publicKeyPem of ['', 'not a pem', '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----']) {
      expect(
        verifyOssCallbackSignature({
          publicKeyPem,
          authorization: buildAuthorization(privateKey),
          url: CALLBACK_URL,
          rawBody: CALLBACK_BODY,
        }),
      ).toBe(false);
    }
  });

  it('签名被截断时失败', () => {
    const authorization = buildAuthorization(privateKey);
    const truncated = authorization.slice(0, authorization.length - 8);

    expect(
      verifyOssCallbackSignature({
        publicKeyPem: publicKey,
        authorization: truncated,
        url: CALLBACK_URL,
        rawBody: CALLBACK_BODY,
      }),
    ).toBe(false);
  });
});

describe('isTrustedOssPublicKeyUrl', () => {
  const trustedParams = { bucket: 'soulmap-private', region: 'oss-cn-hangzhou' };

  it('接受阿里云官方公钥分发点', () => {
    expect(
      isTrustedOssPublicKeyUrl({
        ...trustedParams,
        rawUrl: 'http://gosspublic.alicdn.com/callback_pub_key_v1.pem',
      }),
    ).toBe(true);
  });

  it('接受本桶自己的域名（http 与 https 均可）', () => {
    for (const protocol of ['http', 'https']) {
      expect(
        isTrustedOssPublicKeyUrl({
          ...trustedParams,
          rawUrl: `${protocol}://soulmap-private.oss-cn-hangzhou.aliyuncs.com/callback_pub_key_v1.pem`,
        }),
      ).toBe(true);
    }
  });

  it('【关键】拒绝他人 OSS 桶的域名（否则攻击者可用自带密钥通过验签）', () => {
    expect(
      isTrustedOssPublicKeyUrl({
        ...trustedParams,
        rawUrl: 'https://attacker-bucket.oss-cn-hangzhou.aliyuncs.com/callback_pub_key_v1.pem',
      }),
    ).toBe(false);
  });

  it('【关键】拒绝任意 *.aliyuncs.com 子域（不能只做后缀匹配）', () => {
    for (const rawUrl of [
      'https://evil.aliyuncs.com/key.pem',
      'https://aliyuncs.com/key.pem',
      'https://soulmap-private.oss-cn-hangzhou.aliyuncs.com.evil.com/key.pem',
    ]) {
      expect(isTrustedOssPublicKeyUrl({ ...trustedParams, rawUrl })).toBe(false);
    }
  });

  it('【关键】拒绝 SSRF 目标（内网、云元数据、本机）', () => {
    for (const rawUrl of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/admin',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/key.pem',
      'http://[::1]/key.pem',
      'file:///etc/passwd',
      'gopher://internal/',
    ]) {
      expect(isTrustedOssPublicKeyUrl({ ...trustedParams, rawUrl })).toBe(false);
    }
  });

  it('拒绝非 http(s) 协议与畸形 URL', () => {
    for (const rawUrl of ['ftp://gosspublic.alicdn.com/k.pem', 'not-a-url', '', '//gosspublic.alicdn.com/k.pem']) {
      expect(isTrustedOssPublicKeyUrl({ ...trustedParams, rawUrl })).toBe(false);
    }
    expect(isTrustedOssPublicKeyUrl({ ...trustedParams, rawUrl: undefined as unknown as string })).toBe(false);
  });

  it('【关键】桶名/区域配置变化后旧域名立即失效（白名单是动态的）', () => {
    expect(
      isTrustedOssPublicKeyUrl({
        bucket: 'other-bucket',
        region: 'oss-cn-beijing',
        rawUrl: 'https://soulmap-private.oss-cn-hangzhou.aliyuncs.com/k.pem',
      }),
    ).toBe(false);
  });
});

describe('MAGIC_BYTES_REQUIRED', () => {
  it('足以判定全部支持类型（WebP 需 12 字节，故不得小于 12）', () => {
    expect(MAGIC_BYTES_REQUIRED).toBeGreaterThanOrEqual(12);
  });
});
