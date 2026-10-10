/**
 * 存储纯函数工具测试
 *
 * 本文件锁定的全是**安全边界**：扩展名伪造、路径穿越、越权登记、签名参数注入。
 * 这些分支一旦失守不会表现为「功能报错」，而是静默地允许越权读写，
 * 因此必须逐条写成断言，而不是靠集成测试顺带覆盖。
 */

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import {
  EXTENSION_MIME,
  MIME_CANONICAL_EXTENSION,
  SCENE_POLICIES,
  SCENE_PREFIXES,
  sceneAllowedMimeTypes,
} from './storage-policy';
import { STORAGE_SCENES } from './storage.types';
import {
  applyCdnDomain,
  assertObjectKeyOwnedBy,
  buildObjectKey,
  extractExtension,
  formatObjectKeyDate,
  isSafePublicObjectKey,
  normalizeUploadRequest,
  parseObjectKey,
} from './storage.util';

/** 当前用户 ID（UUIDv7 形态） */
const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';

/** 他人用户 ID */
const OTHER_USER_ID = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';

/** 合法对象键（三段式，扩展名 .webp） */
const OWN_OBJECT_KEY = `avatar/${USER_ID}/20260214_a7c3f9e1b2d4c6a8e1f2a3b4c5d6e7f8.webp`;

/** 断言抛出指定业务错误码 */
const expectErrorCode = (execute: () => unknown, expectedCode: number): void => {
  try {
    execute();
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).code).toBe(expectedCode);
    return;
  }
  throw new Error(`期望抛出错误码 ${expectedCode}，但函数正常返回`);
};

describe('extractExtension', () => {
  it('取出小写扩展名', () => {
    expect(extractExtension('photo.jpg')).toBe('jpg');
    expect(extractExtension('PHOTO.JPG')).toBe('jpg');
    expect(extractExtension('a.b.c.png')).toBe('png');
  });

  it('jpeg 与 jpg 都保留原样（由场景白名单决定是否接受）', () => {
    expect(extractExtension('photo.jpeg')).toBe('jpeg');
    expect(extractExtension('photo.jpg')).toBe('jpg');
  });

  it('无扩展名返回 null', () => {
    expect(extractExtension('photo')).toBeNull();
    expect(extractExtension('')).toBeNull();
  });

  it('以点结尾返回 null（避免取到空扩展名）', () => {
    expect(extractExtension('photo.')).toBeNull();
  });

  it('以点开头的隐藏文件返回 null', () => {
    expect(extractExtension('.hidden')).toBeNull();
    expect(extractExtension('.env.jpg')).toBe('jpg');
  });

  it('【关键】含路径分隔符的文件名一律拒绝（不做路径猜测）', () => {
    expect(extractExtension('../../etc/passwd.jpg')).toBeNull();
    expect(extractExtension('a/b.jpg')).toBeNull();
    expect(extractExtension('C:\\temp\\photo.jpg')).toBeNull();
  });

  it('【关键】含 `..` 的文件名一律拒绝', () => {
    expect(extractExtension('..jpg')).toBeNull();
    expect(extractExtension('photo..jpg')).toBeNull();
  });

  it('【关键】含 URL 定界符的文件名一律拒绝（拼接链接时会篡改参数）', () => {
    expect(extractExtension('photo.jpg?x=1')).toBeNull();
    expect(extractExtension('photo.jpg#frag')).toBeNull();
    expect(extractExtension('photo%2ejpg')).toBeNull();
  });

  it('含控制字符返回 null', () => {
    expect(extractExtension('photo\u0000.jpg')).toBeNull();
    expect(extractExtension('photo\n.jpg')).toBeNull();
  });

  it('超过 128 字符返回 null', () => {
    expect(extractExtension(`${'a'.repeat(125)}.jpg`)).toBeNull();
    expect(extractExtension(`${'a'.repeat(120)}.jpg`)).toBe('jpg');
  });

  it('扩展名过长（> 8 位）返回 null', () => {
    expect(extractExtension('photo.verylongext')).toBeNull();
  });

  it('扩展名含非字母数字返回 null', () => {
    expect(extractExtension('photo.j-pg')).toBeNull();
    expect(extractExtension('photo.jp g')).toBeNull();
  });
});

describe('formatObjectKeyDate', () => {
  it('输出 UTC 的 yyyyMMdd', () => {
    expect(formatObjectKeyDate(new Date('2026-02-14T12:00:00.000Z'))).toBe('20260214');
    // 月份与日期需补零
    expect(formatObjectKeyDate(new Date('2026-01-05T00:00:00.000Z'))).toBe('20260105');
  });

  it('【关键】不随本地时区漂移（同一天的两端都落在同一日期段）', () => {
    expect(formatObjectKeyDate(new Date('2026-02-14T00:00:00.000Z'))).toBe('20260214');
    expect(formatObjectKeyDate(new Date('2026-02-14T23:59:59.999Z'))).toBe('20260214');
  });
});

describe('buildObjectKey', () => {
  const objectId = 'a'.repeat(32);

  it('按 `{prefix}/{userId}/{yyyyMMdd}_{objectId}.{ext}` 生成', () => {
    const key = buildObjectKey({
      prefix: 'avatar',
      userId: USER_ID,
      objectId,
      extension: 'webp',
      date: new Date('2026-02-14T10:00:00.000Z'),
    });

    expect(key).toBe(`avatar/${USER_ID}/20260214_${objectId}.webp`);
  });

  it('生成结果必然是三段式且能被 parseObjectKey 解析回来', () => {
    const key = buildObjectKey({
      prefix: 'report-pdf',
      userId: USER_ID,
      objectId,
      extension: 'pdf',
      date: new Date('2026-02-14T10:00:00.000Z'),
    });

    expect(parseObjectKey(key)).toEqual({
      prefix: 'report-pdf',
      ownerUserId: USER_ID,
      fileName: `20260214_${objectId}.pdf`,
    });
  });

  it('【关键】前缀含 `/` 时拒绝（否则可凭空造出额外目录层级）', () => {
    expectErrorCode(
      () =>
        buildObjectKey({
          prefix: 'avatar/../evil',
          userId: USER_ID,
          objectId,
          extension: 'webp',
          date: new Date(),
        }),
      ErrorCode.OBJECT_KEY_INVALID,
    );
  });

  it('【关键】userId 含 `/` 或 `.` 时拒绝（防止逃逸出自己的目录）', () => {
    for (const badUserId of ['../other', 'a/b', 'a.b', 'a b', '']) {
      expectErrorCode(
        () =>
          buildObjectKey({
            prefix: 'avatar',
            userId: badUserId,
            objectId,
            extension: 'webp',
            date: new Date(),
          }),
        ErrorCode.OBJECT_KEY_INVALID,
      );
    }
  });

  it('objectId 必须为十六进制（16–64 位）', () => {
    expectErrorCode(
      () =>
        buildObjectKey({
          prefix: 'avatar',
          userId: USER_ID,
          objectId: '../evil',
          extension: 'webp',
          date: new Date(),
        }),
      ErrorCode.OBJECT_KEY_INVALID,
    );
    expectErrorCode(
      () =>
        buildObjectKey({
          prefix: 'avatar',
          userId: USER_ID,
          objectId: 'abc',
          extension: 'webp',
          date: new Date(),
        }),
      ErrorCode.OBJECT_KEY_INVALID,
    );
  });

  it('扩展名必须为 1–8 位小写字母数字', () => {
    for (const badExtension of ['WEBP', 'web/p', '', '..', 'verylongext']) {
      expectErrorCode(
        () =>
          buildObjectKey({
            prefix: 'avatar',
            userId: USER_ID,
            objectId,
            extension: badExtension,
            date: new Date(),
          }),
        ErrorCode.OBJECT_KEY_INVALID,
      );
    }
  });
});

describe('parseObjectKey', () => {
  it('解析合法三段式对象键', () => {
    expect(parseObjectKey(OWN_OBJECT_KEY)).toEqual({
      prefix: 'avatar',
      ownerUserId: USER_ID,
      fileName: '20260214_a7c3f9e1b2d4c6a8e1f2a3b4c5d6e7f8.webp',
    });
  });

  it('【关键】段数不为 3 一律返回 null', () => {
    expect(parseObjectKey(`avatar/${USER_ID}`)).toBeNull();
    expect(parseObjectKey(`avatar/${USER_ID}/a/b.webp`)).toBeNull();
    expect(parseObjectKey(`avatar/${USER_ID}/`)).toBeNull();
    expect(parseObjectKey('')).toBeNull();
  });

  it('【关键】出现空段（`//`）返回 null', () => {
    expect(parseObjectKey(`avatar//${USER_ID}/x.webp`)).toBeNull();
    expect(parseObjectKey(`avatar/${USER_ID}//x.webp`)).toBeNull();
  });

  it('【关键】`..` 无法通过段白名单（段白名单不含点号）', () => {
    expect(parseObjectKey(`avatar/${USER_ID}/../x.webp`)).toBeNull();
    expect(parseObjectKey(`avatar/../${USER_ID}/x.webp`)).toBeNull();
    expect(parseObjectKey(`../${USER_ID}/x.webp`)).toBeNull();
  });

  it('【关键】以 `/` 开头或结尾一律拒绝', () => {
    expect(parseObjectKey(`/${OWN_OBJECT_KEY}`)).toBeNull();
    expect(parseObjectKey(`${OWN_OBJECT_KEY}/`)).toBeNull();
  });

  it('【关键】含 URL 定界符返回 null（防签名参数注入）', () => {
    expect(parseObjectKey(`${OWN_OBJECT_KEY}?x=1`)).toBeNull();
    expect(parseObjectKey(`${OWN_OBJECT_KEY}#frag`)).toBeNull();
    expect(parseObjectKey(`avatar/${USER_ID}/x%2ewebp`)).toBeNull();
  });

  it('含反斜杠或控制字符返回 null', () => {
    expect(parseObjectKey(`avatar\\${USER_ID}\\x.webp`)).toBeNull();
    expect(parseObjectKey(`avatar/${USER_ID}/x\u0000.webp`)).toBeNull();
  });

  it('文件名不得以点或连字符开头', () => {
    expect(parseObjectKey(`avatar/${USER_ID}/.hidden`)).toBeNull();
    expect(parseObjectKey(`avatar/${USER_ID}/-x.webp`)).toBeNull();
  });

  it('【关键】所有者段含点号或空格时返回 null（挡住 `a.b` 这类相对路径写法）', () => {
    expect(parseObjectKey('avatar/a.b/x.webp')).toBeNull();
    expect(parseObjectKey('avatar/.. /x.webp')).toBeNull();
    expect(parseObjectKey(`avatar/${USER_ID} /x.webp`)).toBeNull();
  });

  it('超过 200 字符返回 null', () => {
    expect(parseObjectKey(`avatar/${USER_ID}/${'a'.repeat(200)}.webp`)).toBeNull();
  });

  it('前缀大小写与下划线由场景白名单把关（parseObjectKey 只做结构校验）', () => {
    // 结构上 `Avatar` / `avatar_x` 都是合法的路径段，因此 parseObjectKey 会接受。
    // 真正的把关在下一层的场景白名单 —— 两层职责分离是有意的：
    // 结构层回答「这个键的形态对不对」，白名单层回答「这个目录允许不允许」。
    expect(parseObjectKey(`Avatar/${USER_ID}/x.webp`)?.prefix).toBe('Avatar');

    expectErrorCode(() => assertObjectKeyOwnedBy(`Avatar/${USER_ID}/x.webp`, USER_ID), ErrorCode.OBJECT_KEY_INVALID);
    expectErrorCode(() => assertObjectKeyOwnedBy(`avatar_x/${USER_ID}/x.webp`, USER_ID), ErrorCode.OBJECT_KEY_INVALID);
  });
});

describe('isSafePublicObjectKey', () => {
  it('接受多层公开静态资源', () => {
    expect(isSafePublicObjectKey('public/static/avatar/default.webp')).toBe(true);
    expect(isSafePublicObjectKey('public/a.webp')).toBe(true);
  });

  it('拒绝非 public 前缀', () => {
    expect(isSafePublicObjectKey('publicx/a.webp')).toBe(false);
    expect(isSafePublicObjectKey('avatar/x/a.webp')).toBe(false);
  });

  it('拒绝仅 `public` 与 `public/` 两种退化写法', () => {
    expect(isSafePublicObjectKey('public')).toBe(false);
    expect(isSafePublicObjectKey('public/')).toBe(false);
  });

  it('【关键】长度为合法值但以 `/` 结尾时同样拒绝（目录本身不是对象）', () => {
    expect(isSafePublicObjectKey('public/a/')).toBe(false);
    expect(isSafePublicObjectKey('public/static/')).toBe(false);
  });

  it('【关键】公开资源同样禁止穿越与危险字符', () => {
    expect(isSafePublicObjectKey('public/a/../b.webp')).toBe(false);
    expect(isSafePublicObjectKey('public//a.webp')).toBe(false);
    expect(isSafePublicObjectKey('public/a.webp?x=1')).toBe(false);
    expect(isSafePublicObjectKey('public/.hidden')).toBe(false);
  });
});

describe('assertObjectKeyOwnedBy', () => {
  it('本人对象键通过校验并返回解析结果', () => {
    const parsed = assertObjectKeyOwnedBy(OWN_OBJECT_KEY, USER_ID);
    expect(parsed?.ownerUserId).toBe(USER_ID);
  });

  it('【关键】他人对象键返回 403 越权（而非 400 参数错误）', () => {
    const otherKey = `avatar/${OTHER_USER_ID}/20260214_${'a'.repeat(32)}.webp`;
    expectErrorCode(() => assertObjectKeyOwnedBy(otherKey, USER_ID), ErrorCode.OBJECT_NOT_OWNED);

    // 越权必须是 403，才能在监控上与普通参数错误区分开
    try {
      assertObjectKeyOwnedBy(otherKey, USER_ID);
    } catch (error) {
      expect((error as BusinessException).getStatus()).toBe(403);
    }
  });

  it('【关键】未知前缀返回 400（不暴露越权信号，因为前缀本身就不合法）', () => {
    expectErrorCode(() => assertObjectKeyOwnedBy(`evil/${USER_ID}/x.webp`, USER_ID), ErrorCode.OBJECT_KEY_INVALID);
    expectErrorCode(() => assertObjectKeyOwnedBy(`avatar2/${USER_ID}/x.webp`, USER_ID), ErrorCode.OBJECT_KEY_INVALID);
  });

  it('结构非法返回 400', () => {
    expectErrorCode(() => assertObjectKeyOwnedBy('not-a-key', USER_ID), ErrorCode.OBJECT_KEY_INVALID);
    expectErrorCode(() => assertObjectKeyOwnedBy(`avatar/${USER_ID}/../x.webp`, USER_ID), ErrorCode.OBJECT_KEY_INVALID);
  });

  it('公开静态资源返回 null（无需归属校验）', () => {
    expect(assertObjectKeyOwnedBy('public/static/avatar/default.webp', USER_ID)).toBeNull();
  });

  it('每个场景前缀都能被识别（白名单与策略表一致）', () => {
    for (const prefix of ['avatar', 'report-pdf', 'share-card', 'feedback', 'chat']) {
      const key = `${prefix}/${USER_ID}/20260214_${'a'.repeat(32)}.webp`;
      expect(assertObjectKeyOwnedBy(key, USER_ID)?.prefix).toBe(prefix);
    }
  });
});

describe('applyCdnDomain', () => {
  const signed =
    'https://soulmap-prod-private.oss-cn-hangzhou.aliyuncs.com/avatar/u/20260214_a.webp?Expires=1771092900&OSSAccessKeyId=STS.x&Signature=ab%2Fcd%3D';

  it('只替换 origin，path 与 query 逐字节保留', () => {
    const result = applyCdnDomain(signed, 'https://cdn.soulmap.cn');

    expect(result).toBe(
      'https://cdn.soulmap.cn/avatar/u/20260214_a.webp?Expires=1771092900&OSSAccessKeyId=STS.x&Signature=ab%2Fcd%3D',
    );
    // 签名本身不能被再编码：编码后的 `%2F` 若变成 `/` 则签名立即失效
    expect(result).toContain('Signature=ab%2Fcd%3D');
  });

  it('域名末尾斜杠被去除（避免出现 `//` 路径）', () => {
    expect(applyCdnDomain(signed, 'https://cdn.soulmap.cn/')).toContain('cn/avatar/u/');
    expect(applyCdnDomain(signed, 'https://cdn.soulmap.cn///')).toContain('cn/avatar/u/');
  });

  it('未配置域名时原样返回', () => {
    expect(applyCdnDomain(signed, '')).toBe(signed);
    expect(applyCdnDomain(signed, '   ')).toBe(signed);
  });

  it('域名格式非法时原样返回（不把请求导向可疑地址）', () => {
    expect(applyCdnDomain(signed, 'cdn.soulmap.cn')).toBe(signed);
    expect(applyCdnDomain(signed, 'https://cdn.soulmap.cn/extra/path')).toBe(signed);
    expect(applyCdnDomain(signed, 'ftp://cdn.soulmap.cn')).toBe(signed);
  });

  it('输入本身不是合法 URL 时原样返回', () => {
    expect(applyCdnDomain('avatar/u/a.webp', 'https://cdn.soulmap.cn')).toBe('avatar/u/a.webp');
    expect(applyCdnDomain('', 'https://cdn.soulmap.cn')).toBe('');
  });
});

describe('normalizeUploadRequest', () => {
  const globalMax = 20 * 1024 * 1024;

  it('AVATAR + jpg 通过，落库扩展名由 MIME 推导', () => {
    const result = normalizeUploadRequest(
      { scene: 'AVATAR', fileName: 'photo.jpg', mimeType: 'image/jpeg', size: 1024 },
      globalMax,
    );

    expect(result.policy.prefix).toBe('avatar');
    expect(result.extension).toBe('jpg');
  });

  it('image/jpeg 声明 .jpeg 时落库扩展名统一为 jpg（同族归一）', () => {
    const result = normalizeUploadRequest(
      { scene: 'AVATAR', fileName: 'photo.jpeg', mimeType: 'image/jpeg', size: 1024 },
      globalMax,
    );

    expect(result.extension).toBe('jpg');
  });

  it('REPORT_PDF 只接受 pdf', () => {
    expect(
      normalizeUploadRequest(
        { scene: 'REPORT_PDF', fileName: 'r.pdf', mimeType: 'application/pdf', size: 1024 },
        globalMax,
      ).extension,
    ).toBe('pdf');

    expectErrorCode(
      () =>
        normalizeUploadRequest(
          { scene: 'REPORT_PDF', fileName: 'r.png', mimeType: 'image/png', size: 1024 },
          globalMax,
        ),
      ErrorCode.FILE_TYPE_NOT_ALLOWED,
    );
  });

  it('【关键】预留场景返回 80007（不得提前开放未评审的上传入口）', () => {
    expectErrorCode(
      () =>
        normalizeUploadRequest(
          { scene: 'CHAT_ATTACHMENT', fileName: 'a.png', mimeType: 'image/png', size: 1024 },
          globalMax,
        ),
      ErrorCode.STORAGE_SCENE_NOT_ALLOWED,
    );
  });

  it('MIME 不在场景白名单返回 80001', () => {
    expectErrorCode(
      () =>
        normalizeUploadRequest(
          { scene: 'AVATAR', fileName: 'a.pdf', mimeType: 'application/pdf', size: 1024 },
          globalMax,
        ),
      ErrorCode.FILE_TYPE_NOT_ALLOWED,
    );
  });

  it('【关键】扩展名与 MIME 不同族返回 80001（声明自相矛盾的上传）', () => {
    expectErrorCode(
      () =>
        normalizeUploadRequest(
          { scene: 'AVATAR', fileName: 'photo.png', mimeType: 'image/jpeg', size: 1024 },
          globalMax,
        ),
      ErrorCode.FILE_TYPE_NOT_ALLOWED,
    );
    expectErrorCode(
      () =>
        normalizeUploadRequest(
          { scene: 'AVATAR', fileName: 'photo.webp', mimeType: 'image/png', size: 1024 },
          globalMax,
        ),
      ErrorCode.FILE_TYPE_NOT_ALLOWED,
    );
  });

  it('【关键】声明 image/png 实传 .html 被拒（CDN 可执行内容风险）', () => {
    expectErrorCode(
      () =>
        normalizeUploadRequest(
          { scene: 'AVATAR', fileName: 'evil.html', mimeType: 'image/png', size: 1024 },
          globalMax,
        ),
      ErrorCode.FILE_TYPE_NOT_ALLOWED,
    );
  });

  it('无扩展名返回 80001', () => {
    expectErrorCode(
      () =>
        normalizeUploadRequest({ scene: 'AVATAR', fileName: 'photo', mimeType: 'image/jpeg', size: 1024 }, globalMax),
      ErrorCode.FILE_TYPE_NOT_ALLOWED,
    );
  });

  it('大小为 0、负数或非整数返回 80000', () => {
    for (const size of [0, -1, 1.5, Number.NaN]) {
      expectErrorCode(
        () => normalizeUploadRequest({ scene: 'AVATAR', fileName: 'a.jpg', mimeType: 'image/jpeg', size }, globalMax),
        ErrorCode.FILE_TOO_LARGE,
      );
    }
  });

  it('超出场景上限返回 80000（AVATAR 上限 2MB）', () => {
    expectErrorCode(
      () =>
        normalizeUploadRequest(
          { scene: 'AVATAR', fileName: 'a.jpg', mimeType: 'image/jpeg', size: 2 * 1024 * 1024 + 1 },
          globalMax,
        ),
      ErrorCode.FILE_TOO_LARGE,
    );

    // 恰好等于上限应通过（闭区间）
    expect(
      normalizeUploadRequest(
        { scene: 'AVATAR', fileName: 'a.jpg', mimeType: 'image/jpeg', size: 2 * 1024 * 1024 },
        globalMax,
      ).policy.maxBytes,
    ).toBe(2 * 1024 * 1024);
  });

  it('【关键】全局硬顶只能收紧、不能放宽场景上限', () => {
    // REPORT_PDF 场景上限 20MB，全局硬顶 1MB → 以 1MB 为准
    expectErrorCode(
      () =>
        normalizeUploadRequest(
          { scene: 'REPORT_PDF', fileName: 'r.pdf', mimeType: 'application/pdf', size: 2 * 1024 * 1024 },
          1024 * 1024,
        ),
      ErrorCode.FILE_TOO_LARGE,
    );

    // 全局硬顶未配置（0）时回退到场景上限，不得变成「不允许任何上传」
    expect(
      normalizeUploadRequest(
        { scene: 'REPORT_PDF', fileName: 'r.pdf', mimeType: 'application/pdf', size: 15 * 1024 * 1024 },
        0,
      ).policy.maxBytes,
    ).toBe(20 * 1024 * 1024);
  });

  it('场景策略表覆盖全部五个场景（避免新增枚举却漏配策略）', () => {
    for (const scene of STORAGE_SCENES) {
      const policy = SCENE_POLICIES[scene];

      expect(policy.scene).toBe(scene);
      // 每个场景都应有明确的类型白名单与大小上限，不允许空映射
      expect(Object.keys(policy.mimeExtensions).length).toBeGreaterThan(0);
      expect(policy.maxBytes).toBeGreaterThan(0);
    }
  });

  it('【关键】场景允许的每个 MIME 都必须能推出落库扩展名', () => {
    // 这是重构前需要手工维护的隐式不变量（三张表保持同步）；
    // 现在它由「一张映射同时当白名单与扩展名来源」在结构上保证，本测试守住该结构
    for (const scene of STORAGE_SCENES) {
      for (const [mimeType, extension] of Object.entries(SCENE_POLICIES[scene].mimeExtensions)) {
        expect(MIME_CANONICAL_EXTENSION[mimeType]).toBe(extension);
        // 落库扩展名必须能被 EXTENSION_MIME 反查回同一个 MIME（同族校验依赖它）
        expect(EXTENSION_MIME[extension]).toBe(mimeType);
      }
    }
  });

  it('对外下发的 allowedMimeTypes 与场景白名单一致', () => {
    for (const scene of STORAGE_SCENES) {
      expect([...sceneAllowedMimeTypes(SCENE_POLICIES[scene])].sort()).toEqual(
        Object.keys(SCENE_POLICIES[scene].mimeExtensions).sort(),
      );
    }
  });

  it('前缀与场景一一对应且不重复（归属校验白名单依赖前缀唯一）', () => {
    const prefixes = STORAGE_SCENES.map((scene) => SCENE_POLICIES[scene].prefix);

    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const prefix of prefixes) {
      expect(SCENE_PREFIXES.has(prefix)).toBe(true);
    }
  });
});
