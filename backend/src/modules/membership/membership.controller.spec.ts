/**
 * 会员商品列表的**权益矩阵下发**（契约 §3.8.1）
 *
 * ## 为什么要专门测这一条
 *
 * `membership_plans.benefits` 这个 JsonB 列一直都在（种子也已灌入，形状与契约示例
 * 逐字一致），但接口此前**只下发 `tags`**，权益矩阵从未出现在响应里 ——
 * 会员页因此只能显示"最受欢迎""折合 ¥33/月"这类营销标签，用户看不到
 * 「这一档到底比免费的多了什么」，而对比权益恰恰是付费决策的依据。
 * 这是 ADR-033 记录、本轮补齐的缺口。
 *
 * 第二个重点是**脏数据防御**：JsonB 是自由 JSON，写成 `null`、缺字段、
 * 甚至塞进一个字符串都是可能的。权益是付费依据，少一个字段就会在页面上
 * 显示成空白 —— 因此解析器必须逐项校验，宁缺勿错。
 */

import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { EntitlementService } from './entitlement.service';
import { MembershipController } from './membership.controller';

const MEMBERSHIP_VIEW = {
  isMember: false,
  planCode: null,
  expiresAt: null,
  remainingDays: null,
} as const;

/** 契约 §3.8.1 的权益项形状 */
const BENEFITS = [
  { key: 'AI_DAILY_LIMIT', label: 'AI 助手每日对话', value: '50 次', highlight: true },
  { key: 'PDF_EXPORT', label: 'PDF 导出', value: '不限次', highlight: true },
];

interface ProductRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: string;
  priceAmount: number;
  originalAmount: number | null;
  currency: string;
  durationDays: number | null;
  credits: number | null;
  tags: string[];
  isRecommended: boolean;
  membershipPlan: { benefits: unknown } | null;
}

const productRow = (overrides: Partial<ProductRow> = {}): ProductRow => ({
  id: 'product-1',
  code: 'MEMBERSHIP_MONTHLY',
  name: '月度会员',
  description: null,
  type: 'MEMBERSHIP',
  priceAmount: 3900,
  originalAmount: 4900,
  currency: 'CNY',
  durationDays: 30,
  credits: null,
  tags: ['随时可取消'],
  isRecommended: false,
  membershipPlan: { benefits: BENEFITS },
  ...overrides,
});

const createHarness = (rows: ProductRow[]): { controller: MembershipController; findMany: jest.Mock } => {
  const findMany = jest.fn().mockResolvedValue(rows);
  const controller = new MembershipController(
    { product: { findMany } } as unknown as PrismaService,
    { getMembership: jest.fn().mockResolvedValue(MEMBERSHIP_VIEW) } as unknown as EntitlementService,
  );

  return { controller, findMany };
};

describe('MembershipController.listProducts —— 权益矩阵（契约 §3.8.1）', () => {
  it('【关键】会员商品下发套餐的 benefits（此前只下发 tags，权益对照表拿不到）', async () => {
    const { controller } = createHarness([productRow()]);

    const result = await controller.listProducts('user-1');

    expect(result.items[0]?.benefits).toEqual(BENEFITS);
  });

  it('查询时按商品关联套餐取权益（权益挂在套餐上，商品行没有这一列）', async () => {
    const { controller, findMany } = createHarness([productRow()]);

    await controller.listProducts('user-1');

    const args = findMany.mock.calls[0][0] as { select: Record<string, unknown> };
    expect(args.select['membershipPlan']).toEqual({ select: { benefits: true } });
  });

  it('没挂套餐的一次性商品返回**空数组**而不是省略字段（契约里该字段必有）', async () => {
    const { controller } = createHarness([
      productRow({ id: 'product-2', code: 'AI_CREDITS_50', type: 'AI_CREDITS', credits: 50, membershipPlan: null }),
    ]);

    const result = await controller.listProducts('user-1');

    expect(result.items[0]?.benefits).toEqual([]);
    expect('benefits' in (result.items[0] as object)).toBe(true);
  });

  it('【关键】脏数据防御：缺字段/类型不对的权益项被丢弃，不把半条数据发给前端', async () => {
    const { controller } = createHarness([
      productRow({
        membershipPlan: {
          benefits: [
            BENEFITS[0],
            { key: 'NO_LABEL', value: 'x', highlight: true }, // 缺 label
            { key: '', label: '空 key', value: 'x', highlight: false }, // key 为空
            { key: 'NO_VALUE', label: '缺 value', highlight: false }, // 缺 value
            { key: 'BAD_VALUE', label: '值不是字符串', value: 42, highlight: false },
            null,
            'not-an-object',
            BENEFITS[1],
          ],
        },
      }),
    ]);

    const result = await controller.listProducts('user-1');

    expect(result.items[0]?.benefits).toEqual(BENEFITS);
  });

  it('benefits 不是数组时（历史脏行）返回空数组，不抛错', async () => {
    const { controller } = createHarness([
      productRow({ membershipPlan: { benefits: 'oops' } }),
      productRow({ id: 'product-3', membershipPlan: { benefits: null } }),
    ]);

    const result = await controller.listProducts('user-1');

    expect(result.items.map((item) => item.benefits)).toEqual([[], []]);
  });

  it('highlight 缺失时按 false 处理（契约里它是布尔，不能下发 undefined）', async () => {
    const { controller } = createHarness([
      productRow({ membershipPlan: { benefits: [{ key: 'K', label: 'L', value: 'V' }] } }),
    ]);

    const result = await controller.listProducts('user-1');

    expect(result.items[0]?.benefits).toEqual([{ key: 'K', label: 'L', value: 'V', highlight: false }]);
  });

  it('与会员状态一起返回（会员页一次请求拿全，避免首屏中间态）', async () => {
    const { controller } = createHarness([productRow()]);

    const result = await controller.listProducts('user-1');

    expect(result.membership).toEqual(MEMBERSHIP_VIEW);
  });
});
