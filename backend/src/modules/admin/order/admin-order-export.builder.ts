/**
 * 订单导出文件构建（CSV / XLSX）—— 纯函数，无 I/O
 *
 * ## 为什么自己写最小 XLSX 写入器
 *
 * 契约 §3.14.6.4 的 `format` 白名单是 `CSV | XLSX`，但项目**没有安装任何
 * Excel 写库**（无 exceljs / xlsx），而 `package.json` 属共享文件（本轮不可改）。
 * 退化为「只支持 CSV」会直接违反契约，因此这里用**已装依赖（node:zlib）**
 * 生成最小可用的 OOXML 包：ZIP + 5 个 XML part，单元格全部用 `inlineStr`
 * （内联字符串），既避免 sharedStrings 的复杂度，也不需要样式表。
 *
 * 取舍：所有单元格都是**文本类型**（金额不会变成科学计数法或丢精度），
 * 这对财务导出反而更稳；代价是 Excel 里需要手动转数值才能求和。
 *
 * ## 脱敏是硬要求
 *
 * 契约 §3.14.6.4 规则 2：导出文件**永不包含**手机号、openid、unionid、
 * 支付者标识。因此本文件的字段白名单里**根本没有**这些列 ——
 * 不是「按开关过滤」，而是「不存在」。`maskSensitive` 只额外掩码昵称与用户 ID。
 */

import { deflateRawSync } from 'node:zlib';

import type { AdminOrderListItem } from './admin-order.service';
import { maskNickname, maskUserId } from './admin-order.util';
import type { OrderExportField } from './dto/admin-order.dto';
import { ORDER_EXPORT_FIELDS } from './dto/admin-order.dto';

/** 导出列的中文表头（面向财务/客服直接阅读，而非程序解析） */
const EXPORT_FIELD_LABELS: Readonly<Record<OrderExportField, string>> = {
  orderNo: '订单号',
  status: '订单状态',
  productName: '商品名称',
  productType: '商品类型',
  userId: '用户ID',
  userNickname: '用户昵称',
  amount: '订单金额(分)',
  payAmount: '实付金额(分)',
  refundedAmount: '已退金额(分)',
  payMethod: '支付方式',
  transactionId: '微信交易号',
  createdAt: '创建时间',
  paidAt: '支付时间',
  fulfilledAt: '发放时间',
  refundCount: '退款笔数',
};

/** 导出文件的行数据（表头 + 数据行） */
export type OrderExportMatrix = string[][];

/** 按字段白名单与脱敏开关渲染单元格值 */
const cellOf = (item: AdminOrderListItem, field: OrderExportField, maskSensitive: boolean): string => {
  switch (field) {
    case 'orderNo':
      return item.orderNo;
    case 'status':
      return item.statusLabel;
    case 'productName':
      return item.productName ?? '';
    case 'productType':
      return item.productType;
    case 'userId':
      return (maskSensitive ? maskUserId(item.userId) : item.userId) ?? '';
    case 'userNickname':
      return (maskSensitive ? maskNickname(item.userNickname) : item.userNickname) ?? '';
    case 'amount':
      return String(item.amount);
    case 'payAmount':
      return String(item.payAmount);
    case 'refundedAmount':
      return String(item.refundedAmount);
    case 'payMethod':
      return item.payMethod ?? '';
    case 'transactionId':
      return item.transactionId ?? '';
    case 'createdAt':
      return item.createdAt;
    case 'paidAt':
      return item.paidAt ?? '';
    case 'fulfilledAt':
      return item.fulfilledAt ?? '';
    case 'refundCount':
      return String(item.refundCount);
  }
};

/**
 * 构建导出矩阵
 *
 * 字段顺序以**契约白名单的声明顺序**为准（传入的 `fields` 已由
 * `resolveExportFields` 归一为白名单顺序），保证「同样筛选条件的两次导出
 * 列顺序一致」，便于财务做 diff。
 */
export const buildOrderExportMatrix = (
  items: readonly AdminOrderListItem[],
  fields: readonly OrderExportField[],
  maskSensitive: boolean,
): OrderExportMatrix => {
  const header = fields.map((field) => EXPORT_FIELD_LABELS[field]);
  const rows = items.map((item) => fields.map((field) => cellOf(item, field, maskSensitive)));
  return [header, ...rows];
};

/**
 * 归一导出字段
 *
 * 未指定时返回**全部白名单字段**；指定时按白名单声明顺序重排 ——
 * 调用方传入 `payAmount,orderNo` 与 `orderNo,payAmount` 得到同一份文件，
 * 避免「同一条件导出两次、列顺序不同」导致下游脚本误判。
 */
export const resolveExportFields = (fields: readonly OrderExportField[] | undefined): OrderExportField[] => {
  if (fields === undefined || fields.length === 0) return [...ORDER_EXPORT_FIELDS];
  const requested = new Set(fields);
  return ORDER_EXPORT_FIELDS.filter((field) => requested.has(field));
};

/** CSV 单元格转义：含分隔符/引号/换行时加引号并把内部引号翻倍（RFC 4180） */
const csvCell = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * 渲染 CSV
 *
 * 前置 UTF-8 BOM：Excel 在中文 Windows 上默认按 GBK 解析无 BOM 的 UTF-8 文件，
 * 表头会整片乱码 —— 而这份文件的主要读者正是用 Excel 的财务同事。
 * 行尾用 `\r\n`（RFC 4180），Excel 与 LibreOffice 均无兼容问题。
 */
export const renderOrderExportCsv = (matrix: OrderExportMatrix): Buffer => {
  const lines = matrix.map((row) => row.map(csvCell).join(','));
  return Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')]);
};

// ============================================================================
// 最小 XLSX 写入器
// ============================================================================

/** XML 文本转义（`'` 与 `"` 一并转义：两种引号都可能出现在商品名里） */
const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** 列序号 → 列名（0 → A，26 → AA） */
const columnLetter = (index: number): string => {
  let remaining = index;
  let letters = '';

  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);

  return letters;
};

/** CRC-32 查表（ZIP 局部文件头与中央目录都需要） */
const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];

  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }

  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

/** DOS 时间/日期（ZIP 头要求；固定为传入时刻，保证同样输入产出同样字节） */
const dosDateTime = (date: Date): { time: number; date: number } => {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day & 0xffff };
};

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/**
 * 生成 ZIP 包（deflate 压缩）
 *
 * 只实现「写入」所需的最小子集：无 ZIP64、无数据描述符、无目录项属性 ——
 * 我们的 part 都是几 KB 的 XML，用不到那些能力。
 */
const buildZip = (entries: readonly ZipEntry[], now: Date): Buffer => {
  const { time, date } = dosDateTime(now);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // method = deflate
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // method
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const localBlock = Buffer.concat(localParts);
  const centralBlock = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(localBlock.length, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localBlock, centralBlock, end]);
};

/** 工作表 XML（所有单元格为内联字符串） */
const buildSheetXml = (matrix: OrderExportMatrix): string => {
  const rows = matrix
    .map((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cellXml = cells
        .map((value, columnIndex) => {
          if (value.length === 0) return '';
          const ref = `${columnLetter(columnIndex)}${rowNumber}`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNumber}">${cellXml}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
};

/** 渲染 XLSX（最小可用 OOXML 包） */
export const renderOrderExportXlsx = (matrix: OrderExportMatrix, sheetName: string, now: Date): Buffer => {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  return buildZip(
    [
      { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
      { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
      { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(buildSheetXml(matrix), 'utf8') },
    ],
    now,
  );
};

/** 导出格式对应的 MIME 与扩展名 */
export const EXPORT_FORMAT_META: Readonly<Record<'CSV' | 'XLSX', { mime: string; extension: string }>> = {
  CSV: { mime: 'text/csv; charset=utf-8', extension: 'csv' },
  XLSX: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' },
};
