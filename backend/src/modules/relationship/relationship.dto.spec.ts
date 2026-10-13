/**
 * 关系域 DTO 校验（契约 §3.6.3 / §3.6.6 / §3.6.7 / §3.6.8）
 *
 * ## 这个文件锁的是一组**刻意的"明确拒绝"决定**
 *
 * 契约在这几个写接口上声明了一些实现交不出来的字段（接受邀请的 `displayName`、
 * 触发算分的 `forceRecalculate` 等）。原实现有两种坏做法：
 *   · 端点**根本不绑定 `@Body()`** → 传什么都没人看，静默忽略；
 *   · 绑定了空 DTO 但没说明原因 → 后来人容易"顺手加回来"。
 *
 * 静默忽略在**计费相关**的字段上尤其危险：契约对 `forceRecalculate` 明确写着
 * 「忽略算法幂等键强制重算（**会消耗会员额度**）」，客户端传 `true` 拿到 202 后
 * 会以为已强制重算、准备好再付一次配额，而服务端其实复用了缓存且什么都没消耗。
 *
 * 因此统一改为**显式拒绝**（空 DTO + 全局 `forbidNonWhitelisted` ⇒ `400/10001`），
 * 并在契约里把未交付字段移除。下面用与 `main.ts` **同配置**的真实 ValidationPipe
 * 走一遍，确保线上行为就是这样。
 */

import { ValidationPipe } from '@nestjs/common';
import type { BadRequestException } from '@nestjs/common';

import {
  AcceptInviteDto,
  ConfirmRelationshipDto,
  GenerateCompatibilityBodyDto,
  RemoveRelationshipQueryDto,
} from './dto/relationship.dto';

/** 与 `main.ts` 的全局管道同配置（改一处必须改另一处，否则测试就成了摆设） */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const transform = async <T>(
  metatype: new () => T,
  value: Record<string, unknown>,
  type: 'body' | 'query',
): Promise<T> => (await pipe.transform(value, { type, metatype })) as T;

/** 校验失败时的错误消息（空数组表示通过） */
const rejectionMessages = async (
  metatype: new () => unknown,
  value: Record<string, unknown>,
  type: 'body' | 'query',
): Promise<string[]> => {
  try {
    await transform(metatype, value, type);
    return [];
  } catch (error) {
    const response = (error as BadRequestException).getResponse();
    const messages = (response as { message?: string[] | string }).message ?? '';

    return Array.isArray(messages) ? messages : [messages];
  }
};

describe('关系域 DTO 校验', () => {
  describe('GenerateCompatibilityBodyDto（§3.6.8）', () => {
    it('空请求体通过（该端点的参数全部由路径决定）', async () => {
      await expect(transform(GenerateCompatibilityBodyDto, {}, 'body')).resolves.toBeDefined();
    });

    it('【关键】契约里那四个未交付字段一旦出现即 400（而不是"收下再假装支持"）', async () => {
      for (const payload of [
        { forceRecalculate: true },
        { focus: ['RELATIONSHIP'] },
        { tone: 'WARM' },
        { includeAdviceFor: 'BOTH' },
      ]) {
        expect(await rejectionMessages(GenerateCompatibilityBodyDto, payload, 'body')).not.toHaveLength(0);
      }
    });
  });

  describe('AcceptInviteDto（§3.6.3）', () => {
    it('空请求体通过', async () => {
      await expect(transform(AcceptInviteDto, {}, 'body')).resolves.toBeDefined();
    });

    it('【关键】displayName / acceptMessage / confirmTestCode 一律 400（数据模型无列可存）', async () => {
      for (const payload of [{ displayName: '阿泽' }, { acceptMessage: '好啊' }, { confirmTestCode: 'MBTI_LITE' }]) {
        expect(await rejectionMessages(AcceptInviteDto, payload, 'body')).not.toHaveLength(0);
      }
    });
  });

  describe('ConfirmRelationshipDto（§3.6.6）', () => {
    it('autoGenerateReport 布尔值被接收；缺省时为空（由服务层套用契约默认值 true）', async () => {
      await expect(transform(ConfirmRelationshipDto, { autoGenerateReport: false }, 'body')).resolves.toMatchObject({
        autoGenerateReport: false,
      });
      await expect(transform(ConfirmRelationshipDto, {}, 'body')).resolves.toMatchObject({
        autoGenerateReport: undefined,
      });
    });

    it('【关键】字符串布尔在请求体里同样会被隐式转换（已知风险，见下）', async () => {
      // 隐式转换对**请求体**同样生效：`'yes'` / `'false'` 都会被 `Boolean(...)` 变成 `true`。
      // 这与查询串那处是全站同类问题，但危害小得多 —— JSON 客户端本来就会发真布尔
      // （小程序 SDK 发的是 `true`/`false` 字面量），而查询串**天生只能发字符串**。
      // 这里把真实行为钉下来，避免误以为"字符串会被拒"：
      // 若将来要收紧，给该字段加 `@Transform(parseQueryBoolean)` 即可（`'yes'` 会 400）。
      await expect(transform(ConfirmRelationshipDto, { autoGenerateReport: 'false' }, 'body')).resolves.toMatchObject({
        autoGenerateReport: true,
      });
    });

    it('契约里的 displayName 不再被接收（无列可存，与接受邀请同一处理）', async () => {
      expect(await rejectionMessages(ConfirmRelationshipDto, { displayName: '小满' }, 'body')).not.toHaveLength(0);
    });
  });

  describe('RemoveRelationshipQueryDto（§3.6.7）', () => {
    it('reason 与 keepHistory 都被接收（keepHistory 已真正生效：软删除历史报告）', async () => {
      await expect(
        transform(RemoveRelationshipQueryDto, { reason: 'PRIVACY', keepHistory: 'false' }, 'query'),
      ).resolves.toMatchObject({ reason: 'PRIVACY', keepHistory: false });
    });

    it('reason 非枚举被拒', async () => {
      expect(await rejectionMessages(RemoveRelationshipQueryDto, { reason: 'BECAUSE' }, 'query')).not.toHaveLength(0);
    });
  });
});
