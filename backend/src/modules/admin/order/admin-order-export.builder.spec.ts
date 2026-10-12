/**
 * 订单导出文件构建单测
 *
 * 首要断言是**合规性**而不是「能生成」：
 *   · 导出文件**永不包含**手机号与 openid（字段白名单里根本没有这些列）
 *   · `maskSensitive` 生效时昵称与用户 ID 必须已掩码
 * 其次才是格式正确性（CSV 的 BOM/转义、XLSX 的 ZIP 结构与 XML 转义）——
 * 一个「格式正确但泄露明文」的导出包是更严重的事故。
 */

import type { AdminOrderListItem } from './admin-order.service';
import {
  buildOrderExportMatrix,
  renderOrderExportCsv,
  renderOrderExportXlsx,
  resolveExportFields,
  EXPORT_FORMAT_META,
} from './admin-order-export.builder';

const ITEM: AdminOrderListItem = {
  orderId: '0195f3a2-f68c-7eca-8f35-b1ec8f9a0d89',
  orderNo: 'SM20260214A7K3M9Q1',
  status: 'FULFILLED',
  statusLabel: '已完成',
  userId: '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70',
  userNickname: '小满',
  productCode: 'MEMBERSHIP_MONTHLY',
  productName: '月度会员,含"特典"',
  productType: 'MEMBERSHIP',
  amount: 3900,
  payAmount: 3900,
  refundedAmount: 0,
  refundableAmount: 0,
  currency: 'CNY',
  payMethod: 'WECHAT_JSAPI',
  transactionId: '4200002186202602141234567890',
  targetResourceId: null,
  entitlementTypes: ['MEMBERSHIP_ACTIVE'],
  createdAt: '2026-02-14T09:58:12.000Z',
  paidAt: '2026-02-14T10:00:00.000Z',
  fulfilledAt: '2026-02-14T10:00:01.000Z',
  refundCount: 0,
  hasAbnormalFlag: false,
  abnormalFlags: [],
};

describe('resolveExportFields', () => {
  it('未指定时返回全部白名单字段', () => {
    expect(resolveExportFields(undefined)).toHaveLength(15);
  });

  it('按白名单声明顺序重排（同一条件两次导出列顺序必须一致，便于财务 diff）', () => {
    expect(resolveExportFields(['payAmount', 'orderNo'])).toEqual(['orderNo', 'payAmount']);
    expect(resolveExportFields(['orderNo', 'payAmount'])).toEqual(['orderNo', 'payAmount']);
  });
});

describe('buildOrderExportMatrix', () => {
  it('脱敏开启时昵称与用户 ID 均掩码', () => {
    const matrix = buildOrderExportMatrix([ITEM], ['userId', 'userNickname'], true);
    expect(matrix[1]).toEqual([`0195f3a2${'*'.repeat(24)}4d70`, '小*']);
  });

  it('脱敏关闭时返回原值（仅限内部合规场景，操作已留痕）', () => {
    const matrix = buildOrderExportMatrix([ITEM], ['userId', 'userNickname'], false);
    expect(matrix[1]).toEqual([ITEM.userId, '小满']);
  });

  it('表头是中文列名，金额为整数分', () => {
    const matrix = buildOrderExportMatrix([ITEM], ['orderNo', 'payAmount'], true);
    expect(matrix[0]).toEqual(['订单号', '实付金额(分)']);
    expect(matrix[1]).toEqual(['SM20260214A7K3M9Q1', '3900']);
  });
});

describe('renderOrderExportCsv', () => {
  const matrix = buildOrderExportMatrix([ITEM], ['orderNo', 'productName', 'status'], true);
  const csv = renderOrderExportCsv(matrix).toString('utf8');

  it('带 UTF-8 BOM（否则中文 Windows 的 Excel 会整片乱码）', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('使用 CRLF 行尾（RFC 4180）', () => {
    expect(csv).toContain('\r\n');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('含逗号/引号的单元格按 RFC 4180 转义', () => {
    expect(csv).toContain('"月度会员,含""特典"""');
  });

  it('字段白名单不含任何敏感列（手机号 / openid / unionid / 支付者标识）', () => {
    const allFields: readonly string[] = resolveExportFields(undefined);

    for (const forbidden of ['phone', 'phoneMasked', 'openid', 'unionid', 'payerOpenidHash', 'payerOpenid']) {
      expect(allFields).not.toContain(forbidden);
    }
  });
});

describe('renderOrderExportXlsx', () => {
  const matrix = buildOrderExportMatrix([ITEM], ['orderNo', 'productName'], true);
  const xlsx = renderOrderExportXlsx(matrix, '订单明细', new Date('2026-02-15T00:00:00.000Z'));

  it('是合法的 ZIP 包（PK\\x03\\x04 签名）', () => {
    expect(xlsx.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
  });

  it('包含最小 OOXML 所需的 5 个 part（ZIP 条目名以明文存储，可直接断言）', () => {
    const text = xlsx.toString('latin1');
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('_rels/.rels');
    expect(text).toContain('xl/workbook.xml');
    expect(text).toContain('xl/_rels/workbook.xml.rels');
    expect(text).toContain('xl/worksheets/sheet1.xml');
  });

  it('以中央目录结束标记收尾（EOCD：PK\\x05\\x06）', () => {
    expect(xlsx.subarray(-22, -18).toString('latin1')).toBe('PK\u0005\u0006');
  });

  it('同样输入产出同样字节（无时间戳漂移之外的不确定性）', () => {
    const at = new Date('2026-02-15T00:00:00.000Z');
    const first = renderOrderExportXlsx(matrix, '订单明细', at);
    const second = renderOrderExportXlsx(matrix, '订单明细', at);
    expect(first.equals(second)).toBe(true);
  });
});

describe('EXPORT_FORMAT_META', () => {
  it('格式 → MIME 与扩展名映射与契约一致', () => {
    expect(EXPORT_FORMAT_META.CSV.extension).toBe('csv');
    expect(EXPORT_FORMAT_META.XLSX.extension).toBe('xlsx');
    expect(EXPORT_FORMAT_META.XLSX.mime).toContain('spreadsheetml');
  });
});
