/**
 * 匹配报告纯逻辑测试（契约 §3.6.8 / §3.6.9）
 *
 * 重点覆盖两类问题：
 *   ① `cacheKey` 遗漏维度 —— 少一个因素就会让"输入变了却复用旧报告"，
 *      而且因为命中的是缓存，**永远不会重新计算**，用户重测后看到的还是旧结果
 *   ② 阻断原因的判定顺序 —— 顺序错会让用户去催对方，而问题其实在自己这边
 */

import {
  ACTIVE_COMPATIBILITY_STATUSES,
  MAX_CACHE_KEY_LENGTH,
  buildCompatibilityCacheKey,
  isCompatibilityInProgress,
  resolveCompatibilityBlocker,
} from './compatibility.util';

const PROFILE_A = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const PROFILE_B = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';

describe('buildCompatibilityCacheKey', () => {
  const base = {
    engineVersion: '1.0.0',
    weightsVersion: '1.0.0',
    profileAId: PROFILE_A,
    profileAVersion: 1,
    profileBId: PROFILE_B,
    profileBVersion: 1,
  };

  it('相同输入产生相同键（算分确定性的前提）', () => {
    expect(buildCompatibilityCacheKey(base)).toBe(buildCompatibilityCacheKey({ ...base }));
  });

  it('【关键】五个因素各自变化都会产生新键', () => {
    // 逐项断言而不是只测一两个：少测的那一项就是日后被漏掉的那一项
    const original = buildCompatibilityCacheKey(base);

    expect(buildCompatibilityCacheKey({ ...base, engineVersion: '1.0.1' })).not.toBe(original);
    expect(buildCompatibilityCacheKey({ ...base, weightsVersion: '1.1.0' })).not.toBe(original);
    expect(buildCompatibilityCacheKey({ ...base, profileAId: PROFILE_B })).not.toBe(original);
    expect(buildCompatibilityCacheKey({ ...base, profileBId: PROFILE_A })).not.toBe(original);
    expect(buildCompatibilityCacheKey({ ...base, profileAVersion: 2 })).not.toBe(original);
    expect(buildCompatibilityCacheKey({ ...base, profileBVersion: 2 })).not.toBe(original);
  });

  it('【关键】画像版本必须进键（否则用户重测后仍拿到旧报告）', () => {
    // 这是最隐蔽的一类错误：`cacheKey` 命中 → 永不重算 → 用户以为"重测没生效"
    const v1 = buildCompatibilityCacheKey({ ...base, profileAVersion: 1 });
    const v2 = buildCompatibilityCacheKey({ ...base, profileAVersion: 2 });

    expect(v1).not.toBe(v2);
  });

  it('【关键】A/B 顺序敏感 —— 与契约「A 恒为邀请方」一致，不按 UUID 排序', () => {
    // 若这里改成排序，`cacheKey` 与算分输入的顺序就会不一致：
    // 同一份缓存键可能对应两次方向相反的算分
    const ab = buildCompatibilityCacheKey(base);
    const ba = buildCompatibilityCacheKey({ ...base, profileAId: PROFILE_B, profileBId: PROFILE_A });

    expect(ab).not.toBe(ba);
  });

  it('长度在上限内', () => {
    expect(buildCompatibilityCacheKey(base).length).toBeLessThanOrEqual(MAX_CACHE_KEY_LENGTH);
  });

  it('【关键】超长时抛错而不是截断', () => {
    // 截断会让"不同输入"碰撞到同一个键 → 返回**错误的报告**，
    // 比直接失败恶劣得多：用户会看到一份不属于自己的匹配结果
    expect(() => buildCompatibilityCacheKey({ ...base, engineVersion: 'x'.repeat(200) })).toThrow(/超出上限/);
  });
});

describe('resolveCompatibilityBlocker', () => {
  const ready = { status: 'ACTIVE', iHaveProfile: true, partnerHasProfile: true, isGenerating: false };

  it('全部满足时返回 null（可以触发）', () => {
    expect(resolveCompatibilityBlocker(ready)).toBeNull();
  });

  it('关系未生效时阻断', () => {
    for (const status of ['PENDING_A_CONFIRM', 'REJECTED', 'EXPIRED', 'REMOVED']) {
      expect(resolveCompatibilityBlocker({ ...ready, status })).toBe('RELATIONSHIP_NOT_ACTIVE');
    }
  });

  it('【关键】我先没画像时优先报「我」而不是「对方」', () => {
    // 顺序反了会让用户去催对方测试，而问题其实在自己这边 —— 白等一轮
    expect(resolveCompatibilityBlocker({ ...ready, iHaveProfile: false, partnerHasProfile: false })).toBe(
      'MY_NO_PROFILE',
    );
    expect(resolveCompatibilityBlocker({ ...ready, iHaveProfile: false })).toBe('MY_NO_PROFILE');
  });

  it('我有画像但对方没有时提示对方', () => {
    expect(resolveCompatibilityBlocker({ ...ready, partnerHasProfile: false })).toBe('PARTNER_NO_PROFILE');
  });

  it('【关键】已在生成时阻断（防重复扣配额）', () => {
    expect(resolveCompatibilityBlocker({ ...ready, isGenerating: true })).toBe('ALREADY_GENERATING');
  });

  it('关系状态优先于画像与生成中（未生效时连"谁没测"都不必提）', () => {
    expect(
      resolveCompatibilityBlocker({
        status: 'PENDING_A_CONFIRM',
        iHaveProfile: false,
        partnerHasProfile: false,
        isGenerating: true,
      }),
    ).toBe('RELATIONSHIP_NOT_ACTIVE');
  });
});

describe('isCompatibilityInProgress', () => {
  it('进行中的三个状态为真', () => {
    for (const status of ACTIVE_COMPATIBILITY_STATUSES) {
      expect(isCompatibilityInProgress(status)).toBe(true);
    }
  });

  it('终态为假', () => {
    expect(isCompatibilityInProgress('SUCCEEDED')).toBe(false);
    expect(isCompatibilityInProgress('FAILED')).toBe(false);
  });

  it('【关键】常量与实际状态集一致（防止两处各写一份）', () => {
    // 这个常量同时被 Service 的 DB 查询与 blocker 判定使用。
    // 两处各写一份字面量时，日后新增状态只会改一处 → 出现
    // "查不到进行中的报告所以允许触发，但 blocker 又说在生成"的矛盾
    expect([...ACTIVE_COMPATIBILITY_STATUSES]).toEqual(['QUEUED', 'COMPUTING', 'GENERATING']);
    expect(ACTIVE_COMPATIBILITY_STATUSES).not.toContain('SUCCEEDED');
  });
});
