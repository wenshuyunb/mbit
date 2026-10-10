/**
 * 报告列表纯逻辑测试（契约 §3.5.2）
 *
 * 重点覆盖两类**只在边界上出错**的逻辑：
 *   ① 置顶分页的区间算术 —— 页码正好落在「进行中 / 其余」切分点时最容易出错，
 *      表现为某条报告重复出现或被整条跳过，而单条数据的正常用例完全看不出来
 *   ② 推导字段的退化情形（除零、缺时间戳、超长截断）
 */

import {
  ACTIVE_REPORT_STATUSES,
  buildListSummary,
  buildPreviewText,
  computeFreePreviewRatio,
  computeGenerationDurationMs,
  friendlyFailureReason,
  planPinnedPagination,
  reportTypeName,
} from './report-list.util';

describe('reportTypeName', () => {
  it('已知类型返回中文名', () => {
    expect(reportTypeName('MBTI_REPORT')).toBe('人格深度报告');
    expect(reportTypeName('GROWTH_SUMMARY')).toBe('成长回顾报告');
  });

  it('未知类型回落到原始值而非空串', () => {
    // 回落到空串会让新增类型在列表里显示为空白标题，问题被藏起来；
    // 返回原始值至少能让「UNKNOWN_TYPE」出现在界面上被发现
    expect(reportTypeName('FUTURE_TYPE')).toBe('FUTURE_TYPE');
  });
});

describe('computeFreePreviewRatio', () => {
  it('正常比例', () => {
    expect(computeFreePreviewRatio(200, 1000)).toBe(0.2);
  });

  it('【关键】内容为空时返回 0 而不是 NaN', () => {
    // 失败的报告 contentLength 为 0。直接相除得到 NaN，而 NaN 会被
    // JSON.stringify 序列化成 null —— 前端拿到的不是数字，这类"看起来是
    // 数据问题、实际是序列化副作用"的缺陷最难定位
    expect(computeFreePreviewRatio(0, 0)).toBe(0);
    expect(computeFreePreviewRatio(100, 0)).toBe(0);
    expect(Number.isNaN(computeFreePreviewRatio(100, 0))).toBe(false);
  });

  it('数据异常时夹到 [0,1]（预览长度大于总长不该给出 >1）', () => {
    expect(computeFreePreviewRatio(2000, 1000)).toBe(1);
    expect(computeFreePreviewRatio(-5, 1000)).toBe(0);
  });

  it('结果保留 4 位小数，避免浮点噪音进入响应', () => {
    expect(computeFreePreviewRatio(1, 3)).toBe(0.3333);
  });
});

describe('computeGenerationDurationMs', () => {
  const started = new Date('2026-10-10T12:00:00.000Z');
  const finished = new Date('2026-10-10T12:00:52.400Z');

  it('优先用墙钟时间差（用户实际等待的时长）', () => {
    expect(computeGenerationDurationMs(started, finished, 1200)).toBe(52_400);
  });

  it('缺时间戳时回落到单次调用延迟', () => {
    expect(computeGenerationDurationMs(null, finished, 1200)).toBe(1200);
    expect(computeGenerationDurationMs(started, null, 1200)).toBe(1200);
  });

  it('两者都缺时返回 0（未开始生成）', () => {
    expect(computeGenerationDurationMs(null, null, null)).toBe(0);
  });

  it('时间戳倒置（时钟回拨）时钳到 0，不返回负数', () => {
    expect(computeGenerationDurationMs(finished, started, null)).toBe(0);
  });
});

describe('friendlyFailureReason', () => {
  it('返回友好文案', () => {
    expect(friendlyFailureReason()).toBe('AI 服务暂时不可用，请重新生成');
  });

  it('【关键】不包含任何上游细节', () => {
    // 契约 §3.5.2 规则 6：不得暴露内部错误细节。这条断言防止有人日后
    // 图省事把 ai_reports.error_message 直接透出去（可能含 Provider 名、
    // HTTP 状态码，等于免费泄露技术栈）
    const reason = friendlyFailureReason();

    for (const leak of ['deepseek', 'openai', 'qwen', 'HTTP', '500', 'timeout', 'Error']) {
      expect(reason).not.toContain(leak);
    }
  });
});

describe('planPinnedPagination', () => {
  it('第一页正好被进行中的报告填满', () => {
    // 3 条进行中 + 10 条其余，每页 3 条 → 第 1 页全是进行中的
    expect(planPinnedPagination(3, 10, 1, 3)).toEqual({
      activeSkip: 0,
      activeTake: 3,
      inactiveSkip: 0,
      inactiveTake: 0,
    });
  });

  it('【关键】第一页跨过切分点（一部分进行中 + 一部分其余）', () => {
    // 2 条进行中 + 10 条其余，每页 5 条 → 第 1 页 = 2 进行中 + 3 其余
    // 这是最容易写错的边界：只算 activeTake 会少给 3 条，用户看到"每页 5 条却只有 2 条"
    expect(planPinnedPagination(2, 10, 1, 5)).toEqual({
      activeSkip: 0,
      activeTake: 2,
      inactiveSkip: 0,
      inactiveTake: 3,
    });
  });

  it('【关键】第二页完全落在"其余"区间，且跳过量已扣掉进行中的条数', () => {
    // 2 进行中 + 10 其余，每页 5 → 第 2 页 = 其余的第 3..7 条
    // 若忘记扣掉 activeTotal，会从这里开始重复输出第 1 页最后几条
    expect(planPinnedPagination(2, 10, 2, 5)).toEqual({
      activeSkip: 2,
      activeTake: 0,
      inactiveSkip: 3,
      inactiveTake: 5,
    });
  });

  it('没有进行中的报告时退化为普通分页', () => {
    expect(planPinnedPagination(0, 25, 3, 10)).toEqual({
      activeSkip: 0,
      activeTake: 0,
      inactiveSkip: 20,
      inactiveTake: 5,
    });
  });

  it('全部都是进行中的报告', () => {
    expect(planPinnedPagination(7, 0, 2, 3)).toEqual({
      activeSkip: 3,
      activeTake: 3,
      inactiveSkip: 0,
      inactiveTake: 0,
    });
  });

  it('越过末页时两个区间都取 0（不返回负数）', () => {
    // 负数 skip 会让 Prisma 抛错 → 500。越界本该由 DTO 拦成 10005，
    // 但 Service 不该因为分页参数就崩
    expect(planPinnedPagination(2, 3, 99, 20)).toEqual({
      activeSkip: 2,
      activeTake: 0,
      inactiveSkip: 3,
      inactiveTake: 0,
    });
  });

  it('总数为零时全为 0', () => {
    expect(planPinnedPagination(0, 0, 1, 20)).toEqual({
      activeSkip: 0,
      activeTake: 0,
      inactiveSkip: 0,
      inactiveTake: 0,
    });
  });

  it('【关键】任何输入的取数总量都不超过 pageSize，且区间互不重叠', () => {
    // 用穷举代替逐例推断：置顶分页的算术错误几乎都表现为「总量越界」或
    // 「两份区间重叠」，这两条不变量可以直接对所有小规模组合断言
    for (let active = 0; active <= 5; active += 1) {
      for (let inactive = 0; inactive <= 5; inactive += 1) {
        for (let page = 1; page <= 4; page += 1) {
          for (let pageSize = 1; pageSize <= 5; pageSize += 1) {
            const plan = planPinnedPagination(active, inactive, page, pageSize);
            const label = `active=${active} inactive=${inactive} page=${page} size=${pageSize}`;

            expect(plan.activeTake + plan.inactiveTake).toBeLessThanOrEqual(pageSize);
            expect(plan.activeTake).toBeGreaterThanOrEqual(0);
            expect(plan.inactiveTake).toBeGreaterThanOrEqual(0);
            expect(plan.activeSkip).toBeLessThanOrEqual(active);
            expect(plan.inactiveSkip).toBeLessThanOrEqual(inactive);

            // 虚拟列表上的连续区间长度必须等于两组 take 之和
            const virtualSkip = Math.min((page - 1) * pageSize, active + inactive);
            const expected = Math.max(0, Math.min(pageSize, active + inactive - virtualSkip));
            expect(plan.activeTake + plan.inactiveTake).toBe(expected);

            // 落在进行中区间内的条数必须与虚拟位置一致（不重叠、不跳号）
            const expectedActiveTake = Math.max(0, Math.min(active - virtualSkip, pageSize));
            expect(plan.activeTake).toBe(expectedActiveTake);
            expect(plan.activeSkip).toBe(Math.min(virtualSkip, active));

            if (plan.activeTake + plan.inactiveTake > 0) {
              expect(label.length).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });
});

describe('buildListSummary', () => {
  it('原样透传统计数字', () => {
    const summary = buildListSummary({
      totalReports: 3,
      unlockedReports: 1,
      generatingReports: 0,
      failedReports: 1,
      latestReportId: 'report-1',
    });

    expect(summary).toEqual({
      totalReports: 3,
      unlockedReports: 1,
      generatingReports: 0,
      failedReports: 1,
      latestReportId: 'report-1',
    });
  });

  it('无报告时 latestReportId 为 null', () => {
    expect(
      buildListSummary({
        totalReports: 0,
        unlockedReports: 0,
        generatingReports: 0,
        failedReports: 0,
        latestReportId: null,
      }).latestReportId,
    ).toBeNull();
  });
});

describe('buildPreviewText', () => {
  it('短内容原样返回', () => {
    expect(buildPreviewText('你很可能是 INFJ')).toBe('你很可能是 INFJ');
  });

  it('【关键】按字符截断（中文按字符才符合"120 字"的直觉）', () => {
    // 按字节截断会把一个汉字切成两半，产生乱码
    const content = '测'.repeat(200);
    const preview = buildPreviewText(content);

    expect(preview).toBe(`${'测'.repeat(120)}…`);
    expect(preview?.length).toBe(121);
  });

  it('恰好等于上限时不加省略号', () => {
    const preview = buildPreviewText('x'.repeat(120));

    expect(preview).toBe('x'.repeat(120));
    expect(preview).not.toContain('…');
  });

  it('null 与纯空白返回 null（列表页据此不渲染预览行）', () => {
    expect(buildPreviewText(null)).toBeNull();
    expect(buildPreviewText('   \n  ')).toBeNull();
  });

  it('前后空白被裁剪', () => {
    expect(buildPreviewText('  内容  ')).toBe('内容');
  });
});

describe('ACTIVE_REPORT_STATUSES', () => {
  it('【关键】与置顶逻辑共用同一份定义（两处各写一份会导致重复或跳条）', () => {
    // 这个常量同时用于「排序置顶」与「分页区间计算」。若两处各写一份字面量，
    // 日后新增状态时只改一处，就会出现「置顶了但没参与分页」→ 某条报告重复出现
    expect([...ACTIVE_REPORT_STATUSES]).toEqual(['QUEUED', 'GENERATING']);
  });
});
