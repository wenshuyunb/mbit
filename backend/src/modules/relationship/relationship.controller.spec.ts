/**
 * 关系控制器路由契约测试（API_DESIGN §3.6）
 *
 * 为什么单测路由元数据而不是只测 Service：
 * 关系域是**越权风险最高的业务入口**之一 —— 一旦控制器被误加 `@Public()`，
 * 或 `:relationshipId` 的路径参数名与 DTO 字段名不一致（后者会让校验静默失效、
 * 拿到 `undefined` 直接查库），Service 层测试全绿而线上已经出问题。
 * 本文件把「路径 / HTTP 方法 / 必须鉴权 / 参数名对齐」钉死为断言。
 *
 * 额外覆盖响应成形的**纯派生**字段：`sharePath`、`remainingSeconds`。
 * 它们没有独立 Service 承载，错了不会被 Service 测试发现。
 */

import { RequestMethod, ValidationPipe } from '@nestjs/common';
import type { BadRequestException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import {
  AcceptInviteDto,
  ConfirmRelationshipDto,
  CreateInviteDto,
  InviteCodeParamDto,
  RelationshipIdParamDto,
  RemoveRelationshipQueryDto,
} from './dto/relationship.dto';
import { RelationshipController } from './relationship.controller';
import { RelationshipService, type InviteView } from './relationship.service';
import type { CompatibilityService } from './compatibility.service';

/** 读取方法上的路径元数据 */
const pathOf = (method: keyof RelationshipController): unknown =>
  Reflect.getMetadata(PATH_METADATA, RelationshipController.prototype[method]);

/** 读取方法上的 HTTP 方法元数据 */
const httpMethodOf = (method: keyof RelationshipController): unknown =>
  Reflect.getMetadata(METHOD_METADATA, RelationshipController.prototype[method]);

/** 校验一个普通对象是否为合法 DTO，返回错误字段名列表 */
const invalidFieldsOf = async (cls: new () => object, payload: Record<string, unknown>): Promise<string[]> => {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property).sort();
};

/**
 * 走**真实的 ValidationPipe** 校验请求体，返回校验错误消息
 *
 * 为什么在空 DTO 的用例上不用上面的 `invalidFieldsOf`：手搓 `validate()` 对
 * 「无任何装饰器属性的类」会产出一个 `property` 为 `undefined` 的错误对象，
 * 拿不到字段名，也就无法区分「真的拒绝了」与「校验器直接罢工」。
 * 用与 `main.ts` 同配置的 pipe，测的就是线上那条路径。
 */
const validationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const bodyRejectionMessages = async (cls: new () => object, payload: Record<string, unknown>): Promise<string[]> => {
  try {
    await validationPipe.transform(payload, { type: 'body', metatype: cls });
    return [];
  } catch (error) {
    const response = (error as BadRequestException).getResponse();
    const messages = (response as { message?: string[] | string }).message ?? '';

    return Array.isArray(messages) ? messages : [messages];
  }
};

// ============================================================================
// 路由与鉴权
// ============================================================================

describe('RelationshipController 路由契约（API_DESIGN §3.6）', () => {
  it('控制器基础路径为 relationships', () => {
    expect(Reflect.getMetadata(PATH_METADATA, RelationshipController)).toBe('relationships');
  });

  it('创建邀请：POST /relationships/invites', () => {
    expect(pathOf('createInvite')).toBe('invites');
    expect(httpMethodOf('createInvite')).toBe(RequestMethod.POST);
  });

  it('接受邀请：POST /relationships/invites/:code/accept', () => {
    expect(pathOf('acceptInvite')).toBe('invites/:code/accept');
    expect(httpMethodOf('acceptInvite')).toBe(RequestMethod.POST);
  });

  it('确认关系：POST /relationships/:relationshipId/confirm', () => {
    expect(pathOf('confirmRelationship')).toBe(':relationshipId/confirm');
    expect(httpMethodOf('confirmRelationship')).toBe(RequestMethod.POST);
  });

  it('解除关系：DELETE /relationships/:relationshipId', () => {
    expect(pathOf('removeRelationship')).toBe(':relationshipId');
    expect(httpMethodOf('removeRelationship')).toBe(RequestMethod.DELETE);
  });

  it('关系列表：GET /relationships', () => {
    // 路径为空串（`@Get()`）。`/relationships` 只有一段，不会命中
    // `@Get(':relationshipId')`（那段要求两段路径）
    expect(pathOf('listRelationships')).toBe('/');
    expect(httpMethodOf('listRelationships')).toBe(RequestMethod.GET);
  });

  it('关系详情：GET /relationships/:relationshipId', () => {
    expect(pathOf('getRelationship')).toBe(':relationshipId');
    expect(httpMethodOf('getRelationship')).toBe(RequestMethod.GET);
  });

  it('【关键】全部端点必须鉴权（不得标记 @Public）', () => {
    for (const method of [
      'createInvite',
      'getInviteDetail',
      'acceptInvite',
      'listRelationships',
      'getRelationship',
      'confirmRelationship',
      'removeRelationship',
    ] as const) {
      // undefined 表示未标记 @Public → 全局 JwtAuthGuard 默认拒绝匿名访问
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, RelationshipController.prototype[method])).toBeUndefined();
    }
    // 控制器类本身也不得被标记，避免整个关系域敞开
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, RelationshipController)).toBeUndefined();
  });

  it('【关键】每个端点都显式限流（契约 §2.6 逐接口限流表）', () => {
    // 键是 `${THROTTLER_LIMIT}${throttler.name}`，唯一限流器名为 `global`
    // （见 ThrottlerModule.forRootAsync 的 `name: 'global'`）。写错名字时
    // `@Throttle` 会变成空操作、静默回落到全局默认值 —— 这正是要断言的。
    for (const method of [
      'createInvite',
      'getInviteDetail',
      'acceptInvite',
      'listRelationships',
      'getRelationship',
      'confirmRelationship',
      'removeRelationship',
    ] as const) {
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}global`, RelationshipController.prototype[method])).toBeDefined();
    }
    // 邀请创建是成本敏感接口（契约：10 次/24h），限额必须真的收窄到 10
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}global`, RelationshipController.prototype.createInvite)).toBe(10);
    // 邀请详情面向扫码场景，限额必须收窄到 30 次/60s（防邀请码枚举）
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}global`, RelationshipController.prototype.getInviteDetail)).toBe(30);
  });

  it('已实现的路由恰好只有八个（新增路由必须同步更新本测试与文档）', () => {
    const handlerNames = Object.getOwnPropertyNames(RelationshipController.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        typeof RelationshipController.prototype[name as keyof RelationshipController] === 'function',
    );

    expect(handlerNames.sort()).toEqual([
      'acceptInvite',
      'confirmRelationship',
      'createInvite',
      'generateCompatibility',
      'getCompatibility',
      'getInviteDetail',
      'getRelationship',
      'listRelationships',
      'removeRelationship',
    ]);
  });

  it('Service 被正确注入（构造参数类型是 RelationshipService）', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', RelationshipController) as unknown[] | undefined;

    expect(paramTypes?.[0]).toBe(RelationshipService);
  });
});

// ============================================================================
// 路径参数名与 DTO 字段名必须对齐
// ============================================================================

describe('路径参数与 DTO 字段名对齐', () => {
  /**
   * 这是**最容易静默失效**的一类错误：
   * `@Param() params: RelationshipIdParamDto` 依赖 `:relationshipId` 这个路径参数名
   * 与 DTO 属性名完全一致。写成 `:id` 时 Nest 会把整个 params 对象传进来，
   * DTO 上 `relationshipId` 为 `undefined`，`@IsUUID` 直接失败或（关掉校验时）
   * 把 `undefined` 拿去查库 —— 前者报"ID 不合法"让人以为是前端问题，
   * 后者更糟。这里用「路径里出现的参数名 ⊆ DTO 属性名」把它们钉在一起。
   */
  const paramNamesIn = (path: string): string[] => [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);

  it('关系 ID 路径参数名与 RelationshipIdParamDto 一致', () => {
    const names = paramNamesIn(pathOf('confirmRelationship') as string)
      .concat(paramNamesIn(pathOf('removeRelationship') as string))
      .concat(paramNamesIn(pathOf('getRelationship') as string));

    expect(names).toEqual(['relationshipId', 'relationshipId', 'relationshipId']);
    expect(new RelationshipIdParamDto()).toHaveProperty('relationshipId');
  });

  it('邀请码路径参数名与 InviteCodeParamDto 一致', () => {
    expect(paramNamesIn(pathOf('acceptInvite') as string)).toEqual(['code']);
    expect(new InviteCodeParamDto()).toHaveProperty('code');
  });
});

// ============================================================================
// DTO 校验
// ============================================================================

describe('关系 DTO 校验', () => {
  it('CreateInviteDto 接受合法载荷', async () => {
    await expect(
      invalidFieldsOf(CreateInviteDto, { relationType: 'COUPLE', message: '一起测测看', channel: 'MINIAPP_CODE' }),
    ).resolves.toEqual([]);
  });

  it('【关键】CreateInviteDto 拒绝契约外的 relationType', async () => {
    await expect(invalidFieldsOf(CreateInviteDto, { relationType: 'LOVER' })).resolves.toEqual(['relationType']);
  });

  it('【关键】CreateInviteDto 的 channel 必须是 ShareChannel 枚举值', async () => {
    // 该值直接写进 PG 枚举列 `share_channel`。此前 Service 用 `channel as never`
    // 绕过类型检查，非法值会在 Prisma 写入时抛底层枚举错误 → 500。
    // 在 HTTP 边界拦掉，错误码才是可控的 400。
    await expect(invalidFieldsOf(CreateInviteDto, { relationType: 'COUPLE', channel: 'wechat' })).resolves.toEqual([
      'channel',
    ]);
    await expect(invalidFieldsOf(CreateInviteDto, { relationType: 'COUPLE', channel: 'COPY_LINK' })).resolves.toEqual(
      [],
    );
  });

  it('【关键】CreateInviteDto 拒绝超长留言（会撑破对方看到的邀请卡片）', async () => {
    await expect(
      invalidFieldsOf(CreateInviteDto, { relationType: 'FRIEND', message: 'x'.repeat(61) }),
    ).resolves.toEqual(['message']);
    // 边界值 60 字必须放行，否则用户会在"刚好写满"时莫名失败
    await expect(
      invalidFieldsOf(CreateInviteDto, { relationType: 'FRIEND', message: 'x'.repeat(60) }),
    ).resolves.toEqual([]);
  });

  it('【关键】未声明字段被拒绝而非静默丢弃（whitelist + forbidNonWhitelisted）', async () => {
    // 静默丢弃会让前端以为设置生效了（例如误传 relationTypeId），实际用默认值建了邀请
    await expect(invalidFieldsOf(CreateInviteDto, { relationType: 'COUPLE', unknownField: 'x' })).resolves.toEqual([
      'unknownField',
    ]);
  });

  it('【关键】无列可存的契约字段被明确拒绝（inviteeName / displayName）', async () => {
    // `relationships` 与 `relationship_invites` 两张表都没有承载这些字段的列。
    // 「接收 + 校验 + 丢掉」会让前端拿到 200 而用户输入凭空消失，
    // 因此这里断言它们被**明确报错**，而不是被接受后静默忽略。
    await expect(invalidFieldsOf(CreateInviteDto, { relationType: 'COUPLE', inviteeName: '小王' })).resolves.toEqual([
      'inviteeName',
    ]);
    await expect(
      invalidFieldsOf(ConfirmRelationshipDto, { autoGenerateReport: true, displayName: '亲爱的' }),
    ).resolves.toEqual(['displayName']);
  });

  it('【关键】接受邀请的请求体必须为空（所有契约字段均无列可存）', async () => {
    // 走真实 ValidationPipe：空对象放行
    await expect(bodyRejectionMessages(AcceptInviteDto, {})).resolves.toEqual([]);

    // 契约 §3.6.3 定义了这三个字段，但 relationships / relationship_invites
    // 两张表都没有承载它们的列 —— 一律明确报错，而不是「接收后静默丢弃」
    for (const field of ['acceptMessage', 'displayName', 'confirmTestCode']) {
      const messages = await bodyRejectionMessages(AcceptInviteDto, { [field]: 'x' });

      expect(messages.length).toBeGreaterThan(0);
      expect(messages.join(' ')).toContain(field);
    }
  });

  it('ConfirmRelationshipDto 的 autoGenerateReport 必须是布尔', async () => {
    await expect(invalidFieldsOf(ConfirmRelationshipDto, { autoGenerateReport: true })).resolves.toEqual([]);
    // 字符串 "true" 是前端常见误传，必须拒绝而不是当作真值
    await expect(invalidFieldsOf(ConfirmRelationshipDto, { autoGenerateReport: 'true' })).resolves.toEqual([
      'autoGenerateReport',
    ]);
  });

  it('RemoveRelationshipQueryDto 只接受契约枚举内的 reason', async () => {
    await expect(
      invalidFieldsOf(RemoveRelationshipQueryDto, { reason: 'PRIVACY', keepHistory: false }),
    ).resolves.toEqual([]);
    await expect(invalidFieldsOf(RemoveRelationshipQueryDto, { reason: '不想用了' })).resolves.toEqual(['reason']);
  });

  it('【关键】InviteCodeParamDto 只接受 8 位邀请码', async () => {
    await expect(invalidFieldsOf(InviteCodeParamDto, { code: 'K7M2XQ9V' })).resolves.toEqual([]);
    await expect(invalidFieldsOf(InviteCodeParamDto, { code: 'K7M2XQ9' })).resolves.toEqual(['code']);
  });

  it('【关键】RelationshipIdParamDto 拦住非 UUID（否则 Prisma 会抛底层错 → 500）', async () => {
    await expect(
      invalidFieldsOf(RelationshipIdParamDto, { relationshipId: '0195f3a2-d46a-7ca8-8d13-9fca6d7e8b67' }),
    ).resolves.toEqual([]);
    await expect(invalidFieldsOf(RelationshipIdParamDto, { relationshipId: 'rel-1' })).resolves.toEqual([
      'relationshipId',
    ]);
  });
});

// ============================================================================
// 响应成形的纯派生字段
// ============================================================================

describe('createInvite 响应成形', () => {
  const expiresAt = '2026-10-17T12:00:00.000Z';
  const inviteView: InviteView = {
    inviteId: 'invite-1',
    code: 'K7M2XQ9V',
    relationType: 'COUPLE',
    status: 'PENDING',
    expiresAt,
    qrCodeUrl: null,
  };

  interface ControllerInternals {
    relationshipService: { createInvite: (input: unknown) => Promise<InviteView> };
  }

  const createController = (): { controller: RelationshipController; calls: unknown[] } => {
    const calls: unknown[] = [];
    const service = {
      createInvite: (input: unknown): Promise<InviteView> => {
        calls.push(input);
        return Promise.resolve(inviteView);
      },
    };
    const controller = new RelationshipController(
      service as unknown as RelationshipService,
      {} as unknown as CompatibilityService,
    );

    return { controller, calls };
  };

  it('把 Service 的 `code` 同时暴露为契约字段名 `inviteCode`', async () => {
    const { controller } = createController();

    const view = await controller.createInvite('user-1', { relationType: 'COUPLE' });

    expect(view.inviteCode).toBe('K7M2XQ9V');
    expect(view.code).toBe('K7M2XQ9V');
  });

  it('生成 onShareAppMessage 可直接使用的分享路径', async () => {
    const { controller } = createController();

    const view = await controller.createInvite('user-1', { relationType: 'COUPLE' });

    expect(view.sharePath).toBe('pkgMatch/pages/invite?scene=K7M2XQ9V');
    expect(view.qrCodeScene).toBe('K7M2XQ9V');
  });

  it('remainingSeconds 由 expiresAt 推算且不为负', async () => {
    const { controller } = createController();

    const future = await controller.createInvite('user-1', { relationType: 'COUPLE' });
    expect(future.remainingSeconds).toBeGreaterThan(0);

    // 已过期时钳到 0：负数会让前端显示"剩余 -3600 秒"这类荒谬文案
    const expired = new RelationshipController(
      {
        createInvite: () => Promise.resolve({ ...inviteView, expiresAt: '2020-01-01T00:00:00.000Z' }),
      } as unknown as RelationshipService,
      {} as unknown as CompatibilityService,
    );
    const past = await expired.createInvite('user-1', { relationType: 'COUPLE' });
    expect(past.remainingSeconds).toBe(0);
  });

  it('expiresAt 无法解析时 remainingSeconds 退化为 0（不抛错）', async () => {
    const controller = new RelationshipController(
      {
        createInvite: () => Promise.resolve({ ...inviteView, expiresAt: 'not-a-date' }),
      } as unknown as RelationshipService,
      {} as unknown as CompatibilityService,
    );

    const view = await controller.createInvite('user-1', { relationType: 'COUPLE' });

    expect(view.remainingSeconds).toBe(0);
  });

  it('【关键】可选字段未传时不写入 undefined（避免污染 Redis 键与日志）', async () => {
    const { controller, calls } = createController();

    await controller.createInvite('user-1', { relationType: 'FRIEND' });

    const input = calls[0] as Record<string, unknown>;
    expect(input).toEqual({ userId: 'user-1', relationType: 'FRIEND' });
    expect('message' in input).toBe(false);
    expect('channel' in input).toBe(false);
  });

  it('传入的可选字段被原样透传给 Service', async () => {
    const { controller, calls } = createController();

    await controller.createInvite('user-1', {
      relationType: 'COUPLE',
      message: '一起测测看',
      channel: 'MINIAPP_CODE',
    });

    expect(calls[0]).toEqual({
      userId: 'user-1',
      relationType: 'COUPLE',
      message: '一起测测看',
      channel: 'MINIAPP_CODE',
    });
  });

  it('契约 §3.6.2（邀请详情）已实现，不再是"未实现的读接口"', () => {
    const internals = RelationshipController.prototype as unknown as ControllerInternals;

    expect(internals).toBeDefined();
    // 这条断言的作用与之前相反：§3.6.2 已由 `getInviteDetail` 实现，
    // 于是由「断言不存在」翻转为「断言存在、路径与参数名对齐」——
    // 实现被删除或路径被改写时，这里同样会立刻变红
    expect(Reflect.getMetadata(PATH_METADATA, RelationshipController.prototype.getInviteDetail)).toBe('invites/:code');
    expect(new InviteCodeParamDto()).toHaveProperty('code');
  });
});

/**
 * 确认关系的**参数透传**（契约 §3.6.6）
 *
 * 守的是一个真实发生过的缺陷：服务层**已经**实现了「`autoGenerateReport = false`
 * 就不触发匹配算分」，但控制器把它丢掉、永远走默认值 `true` ——
 * 用户显式要求不自动生成，服务端照样入队算分（契约 §3.6.8 注明重复触发会消耗会员额度）。
 *
 * 这类"参数在中间某一层被悄悄丢掉"的缺陷，编译器、路由元数据测试、
 * 甚至服务层自己的单测（直接传参、绕过控制器）**都发现不了**，
 * 只有断言控制器真实传给 Service 的入参才能守住 —— 与 `removeRelationship`
 * 丢掉 `keepHistory` 是同一类问题。
 */
describe('RelationshipController 参数透传', () => {
  const build = (): { controller: RelationshipController; calls: unknown[][] } => {
    const calls: unknown[][] = [];
    const service = {
      confirmRelationship: (...args: unknown[]): Promise<unknown> => {
        calls.push(args);
        return Promise.resolve({ relationshipId: 'rel-1', status: 'ACTIVE' });
      },
      unbindRelationship: (...args: unknown[]): Promise<unknown> => {
        calls.push(args);
        return Promise.resolve({ relationshipId: 'rel-1', status: 'REMOVED' });
      },
    };

    return {
      controller: new RelationshipController(
        service as unknown as RelationshipService,
        {} as unknown as CompatibilityService,
      ),
      calls,
    };
  };

  it('【关键】confirmRelationship 透传 autoGenerateReport（false 必须传下去）', async () => {
    const { controller, calls } = build();

    await controller.confirmRelationship('user-1', { relationshipId: 'rel-1' }, { autoGenerateReport: false });

    expect(calls[0]).toEqual(['user-1', 'rel-1', false]);
  });

  it('未传 autoGenerateReport 时透传 undefined（由服务层套用契约默认值 true）', async () => {
    const { controller, calls } = build();

    await controller.confirmRelationship('user-1', { relationshipId: 'rel-1' }, {});

    expect(calls[0]).toEqual(['user-1', 'rel-1', undefined]);
  });

  it('【关键】removeRelationship 透传 keepHistory（隐私开关不能被中间层吞掉）', async () => {
    const { controller, calls } = build();

    await controller.removeRelationship(
      'user-1',
      { relationshipId: 'rel-1' },
      { reason: 'PRIVACY', keepHistory: false },
    );

    expect(calls[0]).toEqual(['user-1', 'rel-1', { reason: 'PRIVACY', keepHistory: false }]);
  });

  it('removeRelationship 未传可选参数时**不产生该键**（服务层按缺省处理）', async () => {
    const { controller, calls } = build();

    await controller.removeRelationship('user-1', { relationshipId: 'rel-1' }, {});

    expect(calls[0]).toEqual(['user-1', 'rel-1', {}]);
  });
});
