/**
 * 查询串布尔解析（服务端唯一实现）
 *
 * ## 这个文件在修一个**全局静默失效**
 *
 * 查询串里的值**天生是字符串**（`?flag=false` 传进来就是 `'false'`）。
 * 而 `main.ts` 的全局管道开了 `transformOptions: { enableImplicitConversion: true }`，
 * class-transformer 会**先按属性的反射类型做隐式转换**：`boolean` 类型的属性会被
 * `Boolean('false')` 转成 **`true`** —— 任何非空字符串都是 `true`。
 *
 * 更坑的是：**`@Transform` 的回调拿到的 `value` 已经是转换后的布尔值**，
 * 于是各处的 `toBoolean({ value })`（判 `value === 'false'`）永远走不到
 * "字符串"分支，直接原样返回 —— 也就是说那些 helper **看起来在防这个问题，
 * 实际一次都没生效过**。实测（`?flag=false` → `true`）：
 *
 * | 写法 | `'false'` | `'true'` | `'0'` |
 * | --- | --- | --- | --- |
 * | 只有 `@IsBoolean()` | `true` ✗ | `true` ✓ | `true` ✗ |
 * | `@Transform(({ value }) => …)` | `true` ✗ | `true` ✓ | `true` ✗ |
 * | **本文件（读 `obj[key]` 原值）** | `false` ✓ | `true` ✓ | `false` ✓ |
 *
 * 影响面是"每一个查询串布尔筛选"：`?keepHistory=false`（隐私开关）被当成 `true`、
 * `?hasRefund=false` 会只返回有退款的订单、`?includeContent=false` 仍下发正文……
 * **都不报错**，只是结果与预期相反 —— 属最难排查的那一类。
 *
 * ## 为什么读 `obj[key]` 是可行的
 *
 * `@Transform` 的回调入参里 `obj` 是**原始输入对象**（查询串解析出来的 plain object），
 * 它没有被隐式转换过，因此 `obj[key]` 就是客户端真正发来的字符串。
 *
 * ## 为什么不能靠 `transformOptions.enableImplicitConversion` 解决
 *
 * 关掉它会让所有 `page=1` / `pageSize=20` 的隐式数字转换一起失效
 * （`@IsInt()` 会收到字符串而全部 400），那是把一处缺陷换成一堆故障。
 *
 * ## 收敛说明
 *
 * 这个 helper 原先在 **7 个 DTO 文件**里各有一份副本（`ai/report`、`ai/chat`、
 * `relationship`、`payment`、`admin/{user,config,prompt,test-definition,question}`），
 * 且**没有一份是有效的**。本文件是唯一实现；仍引用旧副本的文件在各自注释里
 * 标了待收敛（见 `docs/CONTRACT_DRIFT_AUDIT.md`）。
 */

/** `@Transform` 回调入参里本函数用到的部分（避免依赖 class-transformer 的类型导出） */
interface RawQueryTransformParams {
  readonly value: unknown;
  readonly obj?: unknown;
  readonly key?: string;
}

const TRUTHY = new Set(['true', '1']);
const FALSY = new Set(['false', '0']);

/**
 * 把查询串参数解析为布尔值
 *
 * 优先读 `obj[key]`（**原始字符串**），拿不到时回落到 `value`（兼容"已经是真布尔"的场景，
 * 例如单元测试直接构造对象、或该字段其实来自 JSON 请求体）。
 *
 * 无法识别的值（`'maybe'` 之类）**原样透出**，交给 `@IsBoolean()` 拒绝 ——
 * 猜一个默认值会让客户端的拼写错误静默变成"某个合理的行为"。
 */
export const parseQueryBoolean = ({ value, obj, key }: RawQueryTransformParams): unknown => {
  const raw =
    key !== undefined && obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
  const source = raw === undefined ? value : raw;

  if (typeof source === 'boolean') return source;
  if (typeof source === 'number') return source === 1 ? true : source === 0 ? false : source;

  if (typeof source === 'string') {
    const normalized = source.trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;

    return source;
  }

  return source;
};
