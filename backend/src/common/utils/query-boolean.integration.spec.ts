/**
 * 查询串布尔解析 · **逐文件**真实管道回归（7 个 DTO 文件各一条）
 *
 * ## 为什么必须有这个文件（而不能只测 `parseQueryBoolean`）
 *
 * 这个缺陷的本质**不是函数写错了，而是接线错了**：
 * 七个文件里各有一份 `toBoolean` 副本，它们的"判字符串"分支写得都对，
 * 但全局管道开了 `enableImplicitConversion`，class-transformer 会**先**按属性的反射类型
 * 做隐式转换、**然后**才调用 `@Transform` —— 回调拿到的 `value` 已经是
 * `Boolean('false') === true`，那份"对"的代码**一次都没被执行到过**。
 *
 * 于是"函数级单测全绿 + 线上 `?flag=false` 仍然是 true"可以同时成立。
 * 本文件用与 `main.ts` **同配置**的真实 `ValidationPipe`（`whitelist` +
 * `forbidNonWhitelisted` + `transform: true` + `transformOptions.enableImplicitConversion`）
 * 逐文件验证**接线**，而不是验证函数。
 *
 * ## 收敛前的实测（走同样的真实管道）
 *
 * | 文件 | 字段 | `'false'` |
 * | --- | --- | --- |
 * | `ai/chat` | `DeleteConversationQueryDto.hardDelete` | `true` ✗ |
 * | `ai/chat` | `AiQuotaQueryDto.includeUsage` | `true` ✗ |
 * | `payment/refund` | `AdminRefundQueryDto.force` | `false` ✓（见下） |
 * | `admin/user` | `AdminUserListQueryDto.isMember` | `true` ✗ |
 * | `admin/config` | `AdminConfigListQueryDto.includeHistory` | `true` ✗ |
 * | `admin/prompt` | `ListPromptsQueryDto.hasAbTest` | `true` ✗ |
 * | `admin/prompt` | `PromptDetailQueryDto.includeContent` | `true` ✗ |
 * | `admin/test-definition` | `ListTestDefinitionsQueryDto.isActive` | `true` ✗ |
 * | `admin/question` | `ListAdminQuestionsQueryDto.isActive` | `false` ✓（本来就对） |
 *
 * `payment/refund` 与 `admin/question` 是**例外**，各自的原因写在对应 describe 里 ——
 * 它们证明"这份副本看起来和别人一样"，但失效与否取决于两个毫不相干的细节。
 *
 * ## 本文件不覆盖的部分（有意为之）
 *
 * 7 个文件里**请求体**布尔字段中，有些本来就没有 `@Transform`（如
 * `PublishPromptVersionDto.archiveOtherActive`、`CreateTestDefinitionDto.isFree`）。
 * 给它们补 `@Transform` 会顺带改变 `{"flag":"yes"}` 这类入参的行为（从"静默变 true"
 * 变成 400），属于本次收敛之外的语义变更，因此**刻意没动**；现状与实测结果见交付报告。
 */

import { ValidationPipe } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { AiQuotaQueryDto, CreateConversationDto, DeleteConversationQueryDto } from '../../modules/ai/chat/chat.dto';
import { AdminConfigListQueryDto, AdminUpdateConfigsDto } from '../../modules/admin/config/dto/admin-config.dto';
import { ListAdminQuestionsQueryDto } from '../../modules/admin/question/dto/admin-question.dto';
import { ListPromptsQueryDto, PromptDetailQueryDto } from '../../modules/admin/prompt/dto/prompt.dto';
import { ListTestDefinitionsQueryDto } from '../../modules/admin/test-definition/dto/test-definition.dto';
import { AdminUserListQueryDto, BanUserDto, UnbanUserDto } from '../../modules/admin/user/dto/admin-user.dto';
import { AdminRefundBodyDto, AdminRefundQueryDto } from '../../modules/payment/refund.dto';

/** 与 `main.ts` 的全局管道同配置 —— **这个文件的意义全在这里** */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const transformQuery = async <T extends object>(
  metatype: new () => T,
  payload: Record<string, unknown>,
): Promise<T> => {
  const result = await pipe.transform(payload, { type: 'query', metatype });

  return result as T;
};

const transformBody = async <T extends object>(metatype: new () => T, payload: Record<string, unknown>): Promise<T> => {
  const result = await pipe.transform(payload, { type: 'body', metatype });

  return result as T;
};

// ============================================================================
// 1/7 ai/chat · chat.dto.ts
// ============================================================================

describe('1/7 ai/chat · chat.dto.ts', () => {
  it('【关键】查询 ?hardDelete=false → false（此前是 true：本该「保留消息正文」却清空成 [已删除]）', async () => {
    await expect(transformQuery(DeleteConversationQueryDto, { hardDelete: 'false' })).resolves.toMatchObject({
      hardDelete: false,
    });
  });

  it('查询 ?includeUsage=false / =0 / =true / =1 全部正确', async () => {
    await expect(transformQuery(AiQuotaQueryDto, { includeUsage: 'false' })).resolves.toMatchObject({
      includeUsage: false,
    });
    await expect(transformQuery(AiQuotaQueryDto, { includeUsage: '0' })).resolves.toMatchObject({
      includeUsage: false,
    });
    await expect(transformQuery(AiQuotaQueryDto, { includeUsage: 'true' })).resolves.toMatchObject({
      includeUsage: true,
    });
    await expect(transformQuery(AiQuotaQueryDto, { includeUsage: '1' })).resolves.toMatchObject({ includeUsage: true });
  });

  it('查询未传时保持 undefined（默认值由各自的 Service 契约决定）', async () => {
    const dto = await transformQuery(AiQuotaQueryDto, {});

    expect(dto.includeUsage).toBeUndefined();
  });

  it('查询无法识别的值 400，而不是静默当成 true', async () => {
    await expect(transformQuery(AiQuotaQueryDto, { includeUsage: 'maybe' })).rejects.toBeDefined();
  });

  it('请求体 {"includePersona":"false"} → false（该字段此前也被取反：本想"中立倾听"却注入了人格画像）', async () => {
    await expect(transformBody(CreateConversationDto, { includePersona: 'false' })).resolves.toMatchObject({
      includePersona: false,
    });
  });
});

// ============================================================================
// 2/7 payment/refund · refund.dto.ts
// ============================================================================

/**
 * ⚠ 本文件是 7 份副本里**唯一"侥幸仍然有效"**的一份：三个布尔字段都声明为
 * `boolean | string`，联合类型的 `design:type` 实测是 `Object`，隐式转换不会做
 * `Boolean()`，`value` 到 `@Transform` 时仍是原字符串，副本的字符串分支真的跑到了。
 * 因此这里的断言在收敛**前后都通过** —— 它现在的作用是**防止哪天有人把
 * `boolean | string` 收敛成 `boolean`**：那一刻隐式转换会立刻接管，
 * 若 `@Transform` 不是共享实现（即不看 `obj[key]`），这几条会马上变红。
 */
describe('2/7 payment/refund · refund.dto.ts', () => {
  it('查询 ?force=false → false（覆盖退款策略的强制开关）', async () => {
    await expect(transformQuery(AdminRefundQueryDto, { force: 'false' })).resolves.toMatchObject({ force: false });
  });

  it('查询 ?force=true / =1 / =0 / 空值 / 非法值', async () => {
    await expect(transformQuery(AdminRefundQueryDto, { force: 'true' })).resolves.toMatchObject({ force: true });
    await expect(transformQuery(AdminRefundQueryDto, { force: '1' })).resolves.toMatchObject({ force: true });
    await expect(transformQuery(AdminRefundQueryDto, { force: '0' })).resolves.toMatchObject({ force: false });
    await expect(transformQuery(AdminRefundQueryDto, { force: ' TRUE ' })).resolves.toMatchObject({ force: true });
    await expect(transformQuery(AdminRefundQueryDto, { force: 'maybe' })).rejects.toBeDefined();
  });

  it('请求体 revokeEntitlement / notifyUser 传字符串 "false" 也是 false', async () => {
    const dto = await transformBody(AdminRefundBodyDto, {
      reason: '报告生成失败且多次重试无效，客服核实后全额退款',
      revokeEntitlement: 'false',
      notifyUser: 'false',
    });

    expect(dto.revokeEntitlement).toBe(false);
    expect(dto.notifyUser).toBe(false);
  });
});

// ============================================================================
// 3/7 admin/user · admin-user.dto.ts
// ============================================================================

describe('3/7 admin/user · admin-user.dto.ts', () => {
  it('【关键】查询 ?isMember=false → false（此前会变成「只筛会员」，结果与预期相反）', async () => {
    await expect(transformQuery(AdminUserListQueryDto, { isMember: 'false' })).resolves.toMatchObject({
      isMember: false,
    });
  });

  it('查询 ?hasPaid=0 → false、?phoneBound=true → true（三个筛选位逐一验证）', async () => {
    await expect(transformQuery(AdminUserListQueryDto, { hasPaid: '0' })).resolves.toMatchObject({ hasPaid: false });
    await expect(transformQuery(AdminUserListQueryDto, { phoneBound: 'true' })).resolves.toMatchObject({
      phoneBound: true,
    });
  });

  it('查询非布尔串被 400 拒绝', async () => {
    await expect(transformQuery(AdminUserListQueryDto, { isMember: 'yes' })).rejects.toBeDefined();
  });

  it('请求体封禁 / 解封的布尔字段：传字符串 "false" 也得到 false', async () => {
    const ban = await transformBody(BanUserDto, { notifyUser: 'false', revokeSessions: 'false' });

    expect(ban.notifyUser).toBe(false);
    expect(ban.revokeSessions).toBe(false);

    const unban = await transformBody(UnbanUserDto, { notifyUser: 'false', restoreCompensation: '0' });

    expect(unban.notifyUser).toBe(false);
    expect(unban.restoreCompensation).toBe(false);
  });
});

// ============================================================================
// 4/7 admin/config · admin-config.dto.ts
// ============================================================================

describe('4/7 admin/config · admin-config.dto.ts', () => {
  it('【关键】查询 ?includeHistory=false → false（此前会真的把每条配置的变更历史都查出来）', async () => {
    await expect(transformQuery(AdminConfigListQueryDto, { includeHistory: 'false' })).resolves.toMatchObject({
      includeHistory: false,
    });
  });

  it('查询非法布尔串被 400 拒绝', async () => {
    await expect(transformQuery(AdminConfigListQueryDto, { includeHistory: 'off' })).rejects.toBeDefined();
  });

  it('【关键】请求体 dryRun=false → false（此前恒为 true，"试运行"会真的写库）', async () => {
    const dto = await transformBody(AdminUpdateConfigsDto, {
      items: [{ key: 'reportFreePreviewRatio', value: 0.25 }],
      dryRun: 'false',
      invalidateCaches: 'false',
    });

    expect(dto.dryRun).toBe(false);
    expect(dto.invalidateCaches).toBe(false);
  });
});

// ============================================================================
// 5/7 admin/prompt · prompt.dto.ts
// ============================================================================

describe('5/7 admin/prompt · prompt.dto.ts', () => {
  it('【关键】查询 ?hasAbTest=false → false（此前会把"非 AB 模板"筛成"AB 模板"）', async () => {
    await expect(transformQuery(ListPromptsQueryDto, { hasAbTest: 'false' })).resolves.toMatchObject({
      hasAbTest: false,
    });
  });

  it('【关键】查询 ?includeContent=false → false（此前管理员想要元数据，却拿到了 Prompt 全文）', async () => {
    await expect(transformQuery(PromptDetailQueryDto, { includeContent: 'false' })).resolves.toMatchObject({
      includeContent: false,
    });
  });

  it('查询 ?hasAbTest=0 / =1 与非法值', async () => {
    await expect(transformQuery(ListPromptsQueryDto, { hasAbTest: '0' })).resolves.toMatchObject({ hasAbTest: false });
    await expect(transformQuery(ListPromptsQueryDto, { hasAbTest: '1' })).resolves.toMatchObject({ hasAbTest: true });
    await expect(transformQuery(ListPromptsQueryDto, { hasAbTest: 'yes' })).rejects.toBeDefined();
  });

  it('查询未传时 undefined（分页基类的 1 / 20 不受影响）', async () => {
    const dto = await transformQuery(ListPromptsQueryDto, {});

    expect(dto.hasAbTest).toBeUndefined();
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(20);
  });
});

// ============================================================================
// 6/7 admin/test-definition · test-definition.dto.ts
// ============================================================================

describe('6/7 admin/test-definition · test-definition.dto.ts', () => {
  it('【关键】查询 ?isActive=false → false（此前结果是反的：要看"已停用"，拿到的是"启用中"）', async () => {
    await expect(transformQuery(ListTestDefinitionsQueryDto, { isActive: 'false' })).resolves.toMatchObject({
      isActive: false,
    });
  });

  it('查询 ?includeQuestionIds=0 → false，?isActive=true → true', async () => {
    await expect(transformQuery(ListTestDefinitionsQueryDto, { includeQuestionIds: '0' })).resolves.toMatchObject({
      includeQuestionIds: false,
    });
    await expect(transformQuery(ListTestDefinitionsQueryDto, { isActive: 'true' })).resolves.toMatchObject({
      isActive: true,
    });
  });

  it('查询非法布尔串被 400 拒绝', async () => {
    await expect(transformQuery(ListTestDefinitionsQueryDto, { isActive: '' })).rejects.toBeDefined();
  });
});

// ============================================================================
// 7/7 admin/question · admin-question.dto.ts
// ============================================================================

/**
 * ⚠ 本文件此前是 7 份副本里**唯一读对了 `obj[key]` 的一份**，因此收敛**前后
 * `'false'` 都是 `false`**（详见文件内的收敛说明）。但它比共享实现更严：
 * `'1'` / `'0'` / `' TRUE '` / `'False'` 在旧副本下会被 **400 拒绝**，
 * 收敛到共享实现后与全仓语义统一。下面把这些边界显式钉住 —— 这是本次收敛
 * **唯一一处可观测的语义放宽**，属于有意为之（同一个 `?flag=1` 不该在管理端
 * 某个接口能过、另一个接口 400）。
 */
describe('7/7 admin/question · admin-question.dto.ts', () => {
  it('【关键】查询 ?isActive=false → false（收敛前后一致：这份副本原本就有效）', async () => {
    await expect(transformQuery(ListAdminQuestionsQueryDto, { isActive: 'false' })).resolves.toMatchObject({
      isActive: false,
    });
  });

  it('查询 ?reverseScored=false → false', async () => {
    await expect(transformQuery(ListAdminQuestionsQueryDto, { reverseScored: 'false' })).resolves.toMatchObject({
      reverseScored: false,
    });
  });

  it('收敛带来的放宽：?isActive=1 / =0 / 大小写与空白（旧副本下这些是 400）', async () => {
    await expect(transformQuery(ListAdminQuestionsQueryDto, { isActive: '1' })).resolves.toMatchObject({
      isActive: true,
    });
    await expect(transformQuery(ListAdminQuestionsQueryDto, { isActive: '0' })).resolves.toMatchObject({
      isActive: false,
    });
    await expect(transformQuery(ListAdminQuestionsQueryDto, { isActive: ' TRUE ' })).resolves.toMatchObject({
      isActive: true,
    });
    await expect(transformQuery(ListAdminQuestionsQueryDto, { isActive: 'False' })).resolves.toMatchObject({
      isActive: false,
    });
  });

  it('非法值仍然被 400 拒绝（没有因为放宽而开始猜默认值）', async () => {
    await expect(transformQuery(ListAdminQuestionsQueryDto, { isActive: 'maybe' })).rejects.toBeDefined();
    await expect(transformQuery(ListAdminQuestionsQueryDto, { isActive: '' })).rejects.toBeDefined();
  });
});

// ============================================================================
// 工具自检：这套测试真的能发现"接线错了"吗？
// ============================================================================

/**
 * 对照组：把**收敛前的写法**（只读 `value`）搬回来，断言它在本配置下必然得到 `true`。
 *
 * 这条断言不测业务，它测**测试装置本身**：
 *   · 如果它开始失败（旧写法也能得到 `false`），说明 class-transformer 的执行顺序变了，
 *     那么"这些 `@Transform` 到底有没有意义"需要重新评估；
 *   · 它同时证明上面那些 `→ false` 的断言**不是因为"本来就该是 false"**，
 *     而是因为接线改对了 —— 否则整个文件都是假绿。
 */
describe('工具自检：旧写法（只读 value）在本配置下必然失效', () => {
  class LegacyWireDto {
    @IsOptional()
    @Transform(({ value }: { value: unknown }) => {
      // 这就是收敛前 7 份副本的写法：判字符串 —— 但 value 此时已经是布尔值
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;

      return value;
    })
    @IsBoolean()
    flag?: boolean;
  }

  it('旧接线：?flag=false 得到 true（证明本文件的断言有鉴别力）', async () => {
    await expect(transformQuery(LegacyWireDto, { flag: 'false' })).resolves.toMatchObject({ flag: true });
  });
});
