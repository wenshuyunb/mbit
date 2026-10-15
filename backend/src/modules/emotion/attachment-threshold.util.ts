/**
 * 依恋两轴判定阈值（系统配置）的**读取规则**
 *
 * ## 为什么单独成文件
 *
 * 这条阈值原先只有一处读（`test.service.ts` 的私有方法 `loadAttachmentThreshold`）。
 * 报告详情要画"两条轴各自在哪儿、离中线多远"的条形图，也需要同一份阈值 ——
 * 而"要不要把某个配置值当成合法阈值"这条规则**只能有一份**：
 * 两处各写一遍，迟早会出现"结果页说 52 是中等、报告页说 52 是偏高"这种自相矛盾。
 *
 * 因此把**解析与校验**抽到这里（纯函数），两个调用方各自查一次配置表、
 * 共用同一份判定。查询本身很短，不值得为它再造一层 Service。
 *
 * ## 兜底口径
 *
 * 读不到或值非法时返回 `undefined`，由调用方回落到 ECR 惯例的中位切分 `50`。
 * **不抛错**：一个可选的产品口径配置缺失，不该让用户提交不了测评、
 * 也不该让报告详情打不开。
 */

/** 依恋两轴阈值 */
export interface AttachmentThreshold {
  readonly anxiety: number;
  readonly avoidance: number;
}

/** 阈值的兜底值（ECR 惯例的中位切分） */
export const DEFAULT_ATTACHMENT_THRESHOLD: AttachmentThreshold = { anxiety: 50, avoidance: 50 };

/** 两项阈值在 `system_configs` 里的键 */
export const ATTACHMENT_THRESHOLD_CONFIG_KEYS = [
  'attachment_threshold_anxiety',
  'attachment_threshold_avoidance',
] as const;

/**
 * 从配置行解析阈值
 *
 * `system_configs.value` 是 `Text` 列 —— 配置值**一律以字符串存储**，
 * 由 `valueType` 说明它该怎么解释，因此这里按字符串解析后校验范围。
 */
export const parseAttachmentThreshold = (
  rows: readonly { readonly key: string; readonly value: string }[],
): AttachmentThreshold | undefined => {
  const readNumber = (key: string): number | undefined => {
    const raw = rows.find((row) => row.key === key)?.value;
    const value = raw === undefined ? Number.NaN : Number(raw);

    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
  };

  const anxiety = readNumber(ATTACHMENT_THRESHOLD_CONFIG_KEYS[0]);
  const avoidance = readNumber(ATTACHMENT_THRESHOLD_CONFIG_KEYS[1]);

  return anxiety === undefined || avoidance === undefined ? undefined : { anxiety, avoidance };
};
