/**
 * 数据导出服务测试（契约 §3.2.7 / §3.2.8）
 *
 * 重点覆盖三类容易被忽略、后果却很实在的问题：
 *   · **幂等重放**：连点两次必须拿到同一个 taskId，而不是两个任务
 *   · **入队失败的状态回收**：否则用户会被一个永远不会执行的任务锁住 7 天
 *   · **归属校验同码**：区分「不存在」与「不属于你」等于确认 taskId 存在
 */

import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';

import { ErrorCode } from '../../common/errors/error-code';
import type { AppConfig } from '../../config/config.type';
import { CryptoService } from '../../infra/crypto/crypto.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { RedisService } from '../../infra/redis/redis.service';
import type { ExportTaskState, RequestExportDto } from './dto/user.dto';
import { DataExportService } from './data-export.service';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const OTHER_USER_ID = '0195f3a2-8d5f-7c42-ab7e-3f6a9c2d8e81';
const TASK_ID = '0195f3a2-4be1-7d1f-9e8a-a6db3e4f5c3e';
const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');

const configService = {
  get: (path: string): unknown => ({ 'crypto.key': TEST_KEY, 'crypto.ivSalt': 'salt' })[path],
} as unknown as ConfigService<AppConfig, true>;

interface Harness {
  service: DataExportService;
  prisma: { user: { update: jest.Mock }; userDeletionRequest: { findFirst: jest.Mock } };
  redis: {
    store: Map<string, unknown>;
    key: jest.Mock;
    get: jest.Mock;
    set: jest.Mock;
    setJson: jest.Mock;
    getJson: jest.Mock;
    del: jest.Mock;
  };
  queue: { add: jest.Mock };
}

const createHarness = (): Harness => {
  const store = new Map<string, unknown>();

  const redis = {
    store,
    key: jest.fn((...parts: Array<string | number>) => parts.join(':')),
    get: jest.fn(async (key: string) => (store.get(key) as string | undefined) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    getJson: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (...keys: string[]) => {
      keys.forEach((key) => store.delete(key));
      return keys.length;
    }),
  };

  const prisma = {
    user: { update: jest.fn().mockResolvedValue({ id: USER_ID }) },
    userDeletionRequest: { findFirst: jest.fn().mockResolvedValue(null) },
  };

  const queue = { add: jest.fn().mockResolvedValue({ id: TASK_ID }) };

  const service = new DataExportService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    new CryptoService(configService),
    queue as unknown as Queue,
  );

  return { service, prisma, redis, queue };
};

const dto = (overrides: Partial<RequestExportDto> = {}): RequestExportDto => ({ ...overrides });

/** 向 store 中预置一个任务状态 */
const seedTask = (harness: Harness, overrides: Partial<ExportTaskState> = {}): ExportTaskState => {
  const task: ExportTaskState = {
    taskId: TASK_ID,
    userId: USER_ID,
    scope: 'ALL',
    status: 'PENDING',
    stage: 'QUEUED',
    progress: 0,
    files: [],
    errorMessage: null,
    requestedAt: '2026-02-14T13:00:00.000Z',
    finishedAt: null,
    // 过期时间必须**相对当前时间**计算：写死契约示例里的日期会在真实时钟走过之后
    // 让全部用例静默变成「已过期」，从而掩盖真实缺陷（本文件初次运行即踩到）
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
  harness.redis.store.set(`export:task:${task.taskId}`, task);
  return task;
};

describe('DataExportService', () => {
  describe('requestExport', () => {
    it('创建任务、入队并返回 202 视图', async () => {
      const harness = createHarness();

      const view = await harness.service.requestExport(USER_ID, dto(), 'key-1');

      expect(view.status).toBe('PENDING');
      expect(view.stage).toBe('QUEUED');
      expect(view.isReused).toBe(false);
      expect(view.pollUrl).toBe(`/api/v1/users/me/export/${view.taskId}`);
      expect(harness.queue.add).toHaveBeenCalledWith(
        'generate',
        expect.objectContaining({ taskId: view.taskId, userId: USER_ID, scope: 'ALL' }),
        // jobId = taskId：同名 job 天然去重
        { jobId: view.taskId },
      );
    });

    it('scope 缺省为 ALL', async () => {
      const harness = createHarness();

      await harness.service.requestExport(USER_ID, dto(), 'key-1');

      expect(harness.queue.add).toHaveBeenCalledWith(
        'generate',
        expect.objectContaining({ scope: 'ALL' }),
        expect.anything(),
      );
    });

    it('写入单任务索引与幂等键，并把导出行为落库（合规审计）', async () => {
      const harness = createHarness();

      const view = await harness.service.requestExport(USER_ID, dto(), 'key-1');

      expect(harness.redis.store.get(`export:active:${USER_ID}`)).toBe(view.taskId);
      // 幂等键以哈希形式存储（不把客户端可控字符串原样写进键空间）
      expect([...harness.redis.store.keys()].some((key) => key.startsWith(`idem:export:${USER_ID}:`))).toBe(true);
      expect(harness.prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { exportRequestedAt: expect.any(Date) },
      });
    });

    it('【关键】同一幂等键重放返回同一 taskId，且不重复入队', async () => {
      const harness = createHarness();

      const first = await harness.service.requestExport(USER_ID, dto(), 'key-1');
      const second = await harness.service.requestExport(USER_ID, dto(), 'key-1');

      expect(second.taskId).toBe(first.taskId);
      expect(second.isReused).toBe(true);
      expect(harness.queue.add).toHaveBeenCalledTimes(1);
    });

    it('不同幂等键在无在途任务时各自建任务（键不同即视为不同请求）', async () => {
      const harness = createHarness();

      const first = await harness.service.requestExport(USER_ID, dto(), 'key-1');
      // 首个任务结束后释放占用，模拟任务已完成
      await harness.service.releaseActiveSlot(USER_ID);
      const second = await harness.service.requestExport(USER_ID, dto(), 'key-2');

      expect(second.taskId).not.toBe(first.taskId);
    });

    it('幂等键仍在但任务已被 TTL 回收时清掉陈旧键并正常建任务', async () => {
      const harness = createHarness();
      const hash = new CryptoService(configService).sha256('ALL|key-1');
      harness.redis.store.set(`idem:export:${USER_ID}:${hash}`, 'gone-task-id');

      const view = await harness.service.requestExport(USER_ID, dto(), 'key-1');

      expect(view.taskId).not.toBe('gone-task-id');
      expect(harness.queue.add).toHaveBeenCalledTimes(1);
    });

    it('【关键】已有在途任务时返回 30009，并在 details 中给出已有 taskId', async () => {
      const harness = createHarness();
      seedTask(harness, { status: 'PROCESSING' });
      harness.redis.store.set(`export:active:${USER_ID}`, TASK_ID);

      try {
        await harness.service.requestExport(USER_ID, dto(), 'key-2');
        throw new Error('期望抛出错误');
      } catch (error) {
        const exception = error as { code: number; details?: Array<{ issue: string }> };
        expect(exception.code).toBe(ErrorCode.DATA_EXPORT_IN_PROGRESS);
        expect(exception.details?.[0].issue).toBe(TASK_ID);
      }

      expect(harness.queue.add).not.toHaveBeenCalled();
    });

    it('已有任务但已终结（SUCCEEDED）时允许新建', async () => {
      const harness = createHarness();
      seedTask(harness, { status: 'SUCCEEDED', stage: 'DONE' });
      harness.redis.store.set(`export:active:${USER_ID}`, TASK_ID);

      const view = await harness.service.requestExport(USER_ID, dto(), 'key-2');

      expect(view.taskId).not.toBe(TASK_ID);
      expect(harness.queue.add).toHaveBeenCalledTimes(1);
    });

    it('索引指向的任务已被回收时允许新建（不因陈旧索引卡住）', async () => {
      const harness = createHarness();
      harness.redis.store.set(`export:active:${USER_ID}`, 'vanished-task-id');

      const view = await harness.service.requestExport(USER_ID, dto(), 'key-2');

      expect(view.taskId).not.toBe('vanished-task-id');
    });

    it('【关键】冷静期内返回 403 且不入队', async () => {
      const harness = createHarness();
      harness.prisma.userDeletionRequest.findFirst.mockResolvedValue({ id: 'd-1' });

      await expect(harness.service.requestExport(USER_ID, dto(), 'key-1')).rejects.toMatchObject({
        code: ErrorCode.PROFILE_EDIT_LOCKED,
      });
      expect(harness.queue.add).not.toHaveBeenCalled();
    });

    it('【关键】入队失败时回收全部已写状态（不把用户锁在永不执行的任务上）', async () => {
      const harness = createHarness();
      harness.queue.add.mockRejectedValue(new Error('redis down'));

      await expect(harness.service.requestExport(USER_ID, dto(), 'key-1')).rejects.toMatchObject({
        code: ErrorCode.QUEUE_ERROR,
      });

      expect(harness.redis.store.get(`export:active:${USER_ID}`)).toBeUndefined();
      expect([...harness.redis.store.keys()].some((key) => key.startsWith(`idem:export:${USER_ID}:`))).toBe(false);
      expect([...harness.redis.store.keys()].some((key) => key.startsWith('export:task:'))).toBe(false);
    });

    it('记录 exportRequestedAt 失败不影响任务返回（导出已入队）', async () => {
      const harness = createHarness();
      harness.prisma.user.update.mockRejectedValue(new Error('db down'));

      await expect(harness.service.requestExport(USER_ID, dto(), 'key-1')).resolves.toMatchObject({
        status: 'PENDING',
      });
    });

    it('先写状态再入队（避免 Worker 读到空任务）', async () => {
      const harness = createHarness();
      const order: string[] = [];
      harness.redis.setJson.mockImplementation(async (key: string, value: unknown) => {
        order.push('saveTask');
        harness.redis.store.set(key, value);
      });
      harness.queue.add.mockImplementation(async () => {
        order.push('enqueue');
        return { id: TASK_ID };
      });

      await harness.service.requestExport(USER_ID, dto(), 'key-1');

      expect(order).toEqual(['saveTask', 'enqueue']);
    });
  });

  describe('getTask', () => {
    it('返回完整任务视图', async () => {
      const harness = createHarness();
      seedTask(harness, {
        status: 'SUCCEEDED',
        stage: 'DONE',
        progress: 100,
        finishedAt: '2026-02-14T13:00:42.000Z',
        files: [
          {
            format: 'JSON',
            fileName: 'soulmap-export-json-20260214.json',
            sizeBytes: 1843200,
            downloadUrl: 'https://cdn.soulmap.cn/export/a.json?Expires=1&Signature=x',
            expiresAt: '2026-02-15T13:00:00.000Z',
          },
        ],
      });

      const view = await harness.service.getTask(USER_ID, TASK_ID);

      expect(view.status).toBe('SUCCEEDED');
      expect(view.progress).toBe(100);
      expect(view.files).toHaveLength(1);
      expect(view.isExpired).toBe(false);
    });

    it('任务不存在时返回 80005', async () => {
      const harness = createHarness();

      await expect(harness.service.getTask(USER_ID, TASK_ID)).rejects.toMatchObject({
        code: ErrorCode.EXPORT_TASK_NOT_FOUND,
      });
    });

    it('【关键】他人任务返回与「不存在」相同的错误码（不泄露 taskId 是否存在）', async () => {
      const harness = createHarness();
      seedTask(harness, { userId: OTHER_USER_ID });

      await expect(harness.service.getTask(USER_ID, TASK_ID)).rejects.toMatchObject({
        code: ErrorCode.EXPORT_TASK_NOT_FOUND,
      });
    });

    it('【关键】源文件已过期时对外呈现 EXPIRED 并清空下载地址', async () => {
      const harness = createHarness();
      seedTask(harness, {
        status: 'SUCCEEDED',
        stage: 'DONE',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        files: [
          {
            format: 'JSON',
            fileName: 'a.json',
            sizeBytes: 1,
            downloadUrl: 'https://cdn.soulmap.cn/export/a.json?Signature=x',
            expiresAt: new Date(Date.now() - 120_000).toISOString(),
          },
        ],
      });

      const view = await harness.service.getTask(USER_ID, TASK_ID);

      expect(view.isExpired).toBe(true);
      expect(view.status).toBe('EXPIRED');
      expect(view.stage).toBe('EXPIRED');
      // 过期后不应再下发可能已失效的下载地址
      expect(view.files).toEqual([]);
    });

    it('未完成的任务不受过期判定影响（仍在处理中）', async () => {
      const harness = createHarness();
      seedTask(harness, {
        status: 'PROCESSING',
        stage: 'COLLECTING',
        progress: 30,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const view = await harness.service.getTask(USER_ID, TASK_ID);

      expect(view.status).toBe('PROCESSING');
      expect(view.stage).toBe('EXPIRED');
      expect(view.isExpired).toBe(true);
    });
  });

  describe('任务状态读写', () => {
    it('saveTask 与 loadTask 往返一致', async () => {
      const harness = createHarness();
      const task = seedTask(harness, { status: 'PROCESSING', progress: 55 });

      await harness.service.saveTask({ ...task, progress: 80 });

      await expect(harness.service.loadTask(TASK_ID)).resolves.toMatchObject({ progress: 80 });
    });

    it('loadTask 对不存在任务返回 null（不抛错）', async () => {
      const harness = createHarness();

      await expect(harness.service.loadTask('missing')).resolves.toBeNull();
    });

    it('releaseActiveSlot 释放单任务占用', async () => {
      const harness = createHarness();
      harness.redis.store.set(`export:active:${USER_ID}`, TASK_ID);

      await harness.service.releaseActiveSlot(USER_ID);

      expect(harness.redis.store.get(`export:active:${USER_ID}`)).toBeUndefined();
    });
  });
});
