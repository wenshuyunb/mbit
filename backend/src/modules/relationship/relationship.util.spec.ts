/**
 * 关系模块纯函数测试
 *
 * 两组主张：
 *   · **pairKey 必须与顺序无关** —— 否则同一对用户能建出两条关系，
 *     `UNIQUE(pairKey)` 这个防重机制完全失效（ADR-020）
 *   · **邀请码必须能被用户"输对"** —— 大小写、分隔符、混淆字符都要容错，
 *     否则用户看着屏幕坚信自己输对了，客服也无从自查
 */

import { ErrorCode } from '../../common/errors/error-code';
import {
  buildPairKey,
  generateInviteCode,
  INVITE_CODE_LENGTH,
  isValidInviteCode,
  normalizeInviteCode,
  pairKeyIncludes,
  parseInviteCode,
  parsePairKey,
} from './relationship.util';

const USER_A = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const USER_B = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';

describe('buildPairKey', () => {
  it('【关键】与传入顺序无关（A:B === B:A）', () => {
    expect(buildPairKey(USER_A, USER_B)).toBe(buildPairKey(USER_B, USER_A));
  });

  it('按字典序拼接两端 id', () => {
    const smaller = [USER_A, USER_B].sort();
    expect(buildPairKey(USER_A, USER_B)).toBe(`${smaller[0]}:${smaller[1]}`);
  });

  it('确定性：同一对用户永远得到同一个键', () => {
    const first = buildPairKey(USER_A, USER_B);
    const second = buildPairKey(USER_A, USER_B);

    expect(first).toBe(second);
  });

  it('【关键】同一用户与自己建立关系时拒绝（自关系无业务意义）', () => {
    expect(() => buildPairKey(USER_A, USER_A)).toThrow(
      expect.objectContaining({ code: ErrorCode.RELATIONSHIP_INVITE_SELF }),
    );
  });

  it('空 id 拒绝', () => {
    for (const bad of ['', undefined as unknown as string]) {
      expect(() => buildPairKey(bad, USER_B)).toThrow();
      expect(() => buildPairKey(USER_A, bad)).toThrow();
    }
  });
});

describe('parsePairKey', () => {
  it('往返一致', () => {
    const parsed = parsePairKey(buildPairKey(USER_A, USER_B));

    expect(parsed).not.toBeNull();
    expect([parsed?.userA, parsed?.userB].sort()).toEqual([USER_A, USER_B].sort());
  });

  it('非法输入返回 null（不抛错）', () => {
    for (const input of ['', 'only-one', 'a:b:c', ':b', 'a:', 123 as unknown as string]) {
      expect(parsePairKey(input)).toBeNull();
    }
  });
});

describe('pairKeyIncludes', () => {
  const pairKey = buildPairKey(USER_A, USER_B);

  it('两端用户都在其中', () => {
    expect(pairKeyIncludes(pairKey, USER_A)).toBe(true);
    expect(pairKeyIncludes(pairKey, USER_B)).toBe(true);
  });

  it('【关键】第三方不在其中（关系详情页的权限判断依赖它）', () => {
    expect(pairKeyIncludes(pairKey, '0195f3a2-0000-7000-8000-000000000000')).toBe(false);
  });

  it('非法 pairKey 一律返回 false', () => {
    expect(pairKeyIncludes('garbage', USER_A)).toBe(false);
  });
});

describe('generateInviteCode', () => {
  it('长度为 8 且只含 Crockford 字符集', () => {
    for (let index = 0; index < 50; index += 1) {
      const code = generateInviteCode();

      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      expect(isValidInviteCode(code)).toBe(true);
    }
  });

  it('【关键】不含易混淆字符 I / L / O / U', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateInviteCode()).not.toMatch(/[ILOU]/);
    }
  });

  it('【关键】连续生成不重复（密码学随机源）', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateInviteCode()));

    expect(codes.size).toBe(500);
  });

  it('字符集利用率正常（不是总出同一个字符）', () => {
    const chars = new Set(
      Array.from({ length: 100 }, () => generateInviteCode())
        .join('')
        .split(''),
    );

    // 500 次生成 4000 个字符，至少应覆盖 20 种以上
    expect(chars.size).toBeGreaterThan(20);
  });
});

describe('normalizeInviteCode', () => {
  it('转大写', () => {
    expect(normalizeInviteCode('k7m2xq9v')).toBe('K7M2XQ9V');
  });

  it('去掉空格与连字符（用户习惯四位一断）', () => {
    expect(normalizeInviteCode('K7M2-XQ9V')).toBe('K7M2XQ9V');
    expect(normalizeInviteCode('K7M2 XQ9V')).toBe('K7M2XQ9V');
    expect(normalizeInviteCode(' K7M2 - XQ9V ')).toBe('K7M2XQ9V');
  });

  it('【关键】混淆字符容错：O→0、I/L→1', () => {
    expect(normalizeInviteCode('K7M2XQ9O')).toBe('K7M2XQ90');
    expect(normalizeInviteCode('K7M2XQ9I')).toBe('K7M2XQ91');
    expect(normalizeInviteCode('K7M2XQ9L')).toBe('K7M2XQ91');
  });

  it('非字符串输入返回空串（不抛错）', () => {
    expect(normalizeInviteCode(null as unknown as string)).toBe('');
    expect(normalizeInviteCode(undefined as unknown as string)).toBe('');
  });
});

describe('isValidInviteCode', () => {
  it('接受合法码', () => {
    expect(isValidInviteCode('K7M2XQ9V')).toBe(true);
    expect(isValidInviteCode('00000000')).toBe(true);
  });

  it('拒绝长度不符', () => {
    expect(isValidInviteCode('K7M2XQ9')).toBe(false);
    expect(isValidInviteCode('K7M2XQ9VZ')).toBe(false);
    expect(isValidInviteCode('')).toBe(false);
  });

  it('拒绝字符集外的字符（含被排除的 I/L/O/U）', () => {
    for (const code of ['K7M2XQ9I', 'K7M2XQ9L', 'K7M2XQ9O', 'K7M2XQ9U', 'K7M2XQ9@', 'K7M2XQ9中']) {
      expect(isValidInviteCode(code)).toBe(false);
    }
  });
});

describe('parseInviteCode', () => {
  it('返回归一化后的码', () => {
    expect(parseInviteCode(' k7m2-xq9v ')).toBe('K7M2XQ9V');
  });

  it('【关键】用户把 O 输成 0 时能正常解析（容错后仍合法）', () => {
    expect(parseInviteCode('K7M2XQ90')).toBe('K7M2XQ90');
    expect(parseInviteCode('k7m2xq9o')).toBe('K7M2XQ90');
  });

  it('归一化后仍不合法时抛邀请码无效', () => {
    try {
      parseInviteCode('SHORT');
      throw new Error('期望抛出错误');
    } catch (error) {
      expect((error as { code: number }).code).toBe(ErrorCode.RELATIONSHIP_INVITE_NOT_FOUND);
    }
  });

  it('生成的码一定能被解析回来（生成与解析使用同一字符集）', () => {
    for (let index = 0; index < 100; index += 1) {
      const code = generateInviteCode();
      expect(parseInviteCode(code)).toBe(code);
    }
  });
});
