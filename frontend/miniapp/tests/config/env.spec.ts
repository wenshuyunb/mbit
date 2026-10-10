/**
 * 环境配置测试
 *
 * 关键约束（架构文档 §16.3）：
 *   · 环境由运行时 envVersion 决定，而不是构建期注入
 *   · 生产环境必须使用 HTTPS（微信要求 request 合法域名必须 HTTPS）
 *   · 小程序包内不得出现任何密钥类配置
 */

import { describe, expect, it, vi } from 'vitest';

import { appEnv, env, isDebug, isProduction, timeout } from '@/config/env';
import { FALLBACK_DISCLAIMER, MBTI_DIMENSIONS, STORAGE_KEYS } from '@/config/constants';

describe('环境配置', () => {
  it('测试环境（getAccountInfoSync 返回 develop）判定为开发环境', () => {
    expect(appEnv).toBe('develop');
    expect(isDebug).toBe(true);
    expect(isProduction).toBe(false);
  });

  it('baseUrl 由环境映射得到，且不含结尾斜杠（避免出现双斜杠）', () => {
    expect(env.baseUrl).not.toMatch(/\/$/);
    expect(env.baseUrl).toContain('/api/v1');
  });

  it('生产环境的基址必须是 HTTPS（微信 request 域名要求）', () => {
    // 读取源码常量映射中的 release 分支：通过切换 envVersion 后重新导入模块验证
    vi.resetModules();
    vi.mocked(uni.getAccountInfoSync).mockReturnValueOnce({
      miniProgram: { appId: 'wxprod', envVersion: 'release', version: '1.0.0' },
      plugin: {},
    } as ReturnType<typeof uni.getAccountInfoSync>);

    // 动态导入以获得重新求值的模块
    return import('@/config/env').then((mod) => {
      expect(mod.appEnv).toBe('release');
      expect(mod.isProduction).toBe(true);
      expect(mod.env.baseUrl.startsWith('https://')).toBe(true);
      expect(mod.env.cdnUrl.startsWith('https://')).toBe(true);
    });
  });

  it('getAccountInfoSync 抛异常时回退为 develop，不阻断启动', () => {
    vi.resetModules();
    vi.mocked(uni.getAccountInfoSync).mockImplementationOnce(() => {
      throw new Error('not supported');
    });

    return import('@/config/env').then((mod) => {
      expect(mod.appEnv).toBe('develop');
    });
  });

  it('平台标识与超时配置符合契约', () => {
    expect(env.platform).toBe('miniapp');
    expect(timeout.default).toBe(15_000);
    expect(timeout.ai).toBeGreaterThan(timeout.default);
  });
});

describe('业务常量', () => {
  it('MBTI 四维度覆盖 E/I、S/N、T/F、J/P', () => {
    expect(MBTI_DIMENSIONS).toHaveLength(4);

    const letters = MBTI_DIMENSIONS.flatMap((item) => [item.positive, item.negative]);
    expect(new Set(letters)).toEqual(new Set(['E', 'I', 'S', 'N', 'T', 'F', 'J', 'P']));
  });

  it('存储 key 统一使用 sm_ 前缀，避免与第三方 SDK 冲突', () => {
    for (const key of Object.values(STORAGE_KEYS)) {
      expect(key.startsWith('sm_')).toBe(true);
    }
  });

  it('兜底免责声明包含合规关键措辞（非诊断/非医疗建议）', () => {
    expect(FALLBACK_DISCLAIMER).toContain('AI');
    expect(FALLBACK_DISCLAIMER).toContain('不构成');
  });
});
