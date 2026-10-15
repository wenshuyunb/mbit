/**
 * 依恋两轴阈值解析规则测试
 *
 * 这条规则现在有**两个调用方**（测评算分、报告详情画图），
 * 因此必须钉住"什么算合法值、什么算读不到"：
 * 两处若分叉，表现是"结果页说 52 是中等、报告页说 52 是偏高"这种自相矛盾。
 */

import {
  ATTACHMENT_THRESHOLD_CONFIG_KEYS,
  DEFAULT_ATTACHMENT_THRESHOLD,
  parseAttachmentThreshold,
} from './attachment-threshold.util';

describe('parseAttachmentThreshold', () => {
  it('两项都有合法值时原样返回', () => {
    expect(
      parseAttachmentThreshold([
        { key: 'attachment_threshold_anxiety', value: '60' },
        { key: 'attachment_threshold_avoidance', value: '40' },
      ]),
    ).toEqual({ anxiety: 60, avoidance: 40 });
  });

  it('配置键名在本文件里唯一（改键名必须同时改两处调用方）', () => {
    expect([...ATTACHMENT_THRESHOLD_CONFIG_KEYS]).toEqual([
      'attachment_threshold_anxiety',
      'attachment_threshold_avoidance',
    ]);
    expect(DEFAULT_ATTACHMENT_THRESHOLD).toEqual({ anxiety: 50, avoidance: 50 });
  });

  it.each([
    ['缺行', [{ key: 'attachment_threshold_anxiety', value: '60' }]],
    ['空数组', []],
    [
      '非数字',
      [
        { key: 'attachment_threshold_anxiety', value: '高' },
        { key: 'attachment_threshold_avoidance', value: '40' },
      ],
    ],
    [
      '超范围（>100）',
      [
        { key: 'attachment_threshold_anxiety', value: '120' },
        { key: 'attachment_threshold_avoidance', value: '40' },
      ],
    ],
    [
      '负数',
      [
        { key: 'attachment_threshold_anxiety', value: '-1' },
        { key: 'attachment_threshold_avoidance', value: '40' },
      ],
    ],
  ])('读不到合法值时返回 undefined（%s）', (_label, rows) => {
    expect(parseAttachmentThreshold(rows)).toBeUndefined();
  });

  it('边界值 0 与 100 是合法的（不是"没配"）', () => {
    expect(
      parseAttachmentThreshold([
        { key: 'attachment_threshold_anxiety', value: '0' },
        { key: 'attachment_threshold_avoidance', value: '100' },
      ]),
    ).toEqual({ anxiety: 0, avoidance: 100 });
  });
});
