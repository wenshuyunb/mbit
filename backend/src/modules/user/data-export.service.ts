/**
 * 数据导出服务（契约 §3.2.7 / §3.2.8）
 *
 * 状态存储：**任务状态存 Redis，不新建数据库表**（ADR-024）。
 * 任务天然临时 —— 源文件在 OSS 保留 7 天、签名 URL 24h 有效 ——
 * 生命周期与 Redis TTL 语义契合；为它引入表 + 迁移 + 归档作业收益不匹配。
 * 但**安全相关的事实仍落库**：`users.exportRequestedAt` 记录导出行为本身（合规审计需要）。
 *
 * 异步必选（契约 §3.2.7 规则 1）：多表聚合 + 文件上传无法在请求内完成，
 * 因此本服务只负责「建任务 + 入队」，绝不在此同步生成文件。
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { QUEUE_EXPORT_DATA } from '../../infra/queue/queue.module';
import { RedisService } from '../../infra/redis/redis.service';
import type {
  ExportFileEntry,
  ExportTaskStage,
  ExportTaskState,
  ExportTaskStatus,
  RequestExportDto,
} from './dto/user.dto';

/** 任务状态保留时长（秒）：源文件 7 天，任务记录与之同寿，便于查询到「已过期」 */
const EXPORT_TASK_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 幂等记录保留时长（秒）：覆盖「用户重复点击申请」的场景 */
const EXPORT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** 仍算「进行中」的状态（此期间不允许新建任务，契约 §3.2.7 规则 2） */
const ACTIVE_STATUSES: ReadonlySet<ExportTaskStatus> = new Set<ExportTaskStatus>(['PENDING', 'PROCESSING']);

/** Redis 键前缀 */
const EXPORT_TASK_KEY_PREFIX = 'export:task';
const EXPORT_ACTIVE_KEY_PREFIX = 'export:active';
const EXPORT_IDEMPOTENCY_PREFIX = 'idem:export';

/** 申请导出响应（契约 §3.2.7 成功响应 202） */
export interface ExportRequestedView {
  taskId: string;
  status: ExportTaskStatus;
  stage: ExportTaskStage;
  pollUrl: string;
  requestedAt: string;
  /** 是否复用了既有任务（同幂等键重放，或已有未完成任务） */
  isReused: boolean;
}

/** 任务查询响应（契约 §3.2.8 成功响应 200） */
export interface ExportTaskView {
  taskId: string;
  status: ExportTaskStatus;
  progress: number;
  stage: ExportTaskStage;
  files: ExportFileEntry[];
  requestedAt: string;
  finishedAt: string | null;
  expiresAt: string;
  isExpired: boolean;
}

@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    @InjectQueue(QUEUE_EXPORT_DATA) private readonly exportQueue: Queue,
  ) {}

  /**
   * 申请数据导出（契约 §3.2.7）
   *
   * 判定顺序：幂等重放 → 冷静期 → 已有在途任务 → 建任务入队。
   * 把幂等放在最前是因为「同一请求重放」应当在任何业务校验之前短路 ——
   * 否则用户连点两次，第二次可能因「已有在途任务」而拿到 409，
   * 而他看到的其实应该是第一次的 202。
   */
  async requestExport(userId: string, dto: RequestExportDto, idempotencyKey: string): Promise<ExportRequestedView> {
    const scope = dto.scope ?? 'ALL';
    const idempotencyRedisKey = this.redis.key(
      EXPORT_IDEMPOTENCY_PREFIX,
      userId,
      // 哈希而非原样存储：幂等键由客户端生成，原样落 Redis 会把可控字符串引入键空间
      this.crypto.sha256(`${scope}|${idempotencyKey}`),
    );

    // ---- 幂等重放：返回首次的 202 响应体（含同一 taskId） ----
    const replayedTaskId = await this.redis.get(idempotencyRedisKey);
    if (replayedTaskId !== null && replayedTaskId.length > 0) {
      const replayed = await this.loadTask(replayedTaskId);
      if (replayed !== null && replayed.userId === userId) {
        return this.toRequestedView(replayed, true);
      }
      // 任务记录已被 TTL 回收但幂等键还在：清掉陈旧键，走正常流程
      await this.redis.del(idempotencyRedisKey);
    }

    // ---- 冷静期内禁止导出（数据即将被删除，导出无意义，契约 §3.2.7） ----
    await this.assertNotInDeletionGrace(userId);

    // ---- 单任务约束：同一用户同时只允许一个未完成任务（规则 2） ----
    const activeTaskId = await this.redis.get(this.redis.key(EXPORT_ACTIVE_KEY_PREFIX, userId));
    if (activeTaskId !== null && activeTaskId.length > 0) {
      const active = await this.loadTask(activeTaskId);
      if (active !== null && ACTIVE_STATUSES.has(active.status)) {
        // 契约要求把已有 taskId 告知前端，便于直接跳到进度页
        throw BusinessException.conflict(ErrorCode.DATA_EXPORT_IN_PROGRESS, undefined, [
          { field: 'taskId', issue: active.taskId },
        ]);
      }
      await this.redis.del(this.redis.key(EXPORT_ACTIVE_KEY_PREFIX, userId));
    }

    // ---- 建任务并入队 ----
    const taskId = randomUUID();
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + EXPORT_TASK_TTL_SECONDS * 1000);

    const task: ExportTaskState = {
      taskId,
      userId,
      scope,
      status: 'PENDING',
      stage: 'QUEUED',
      progress: 0,
      files: [],
      errorMessage: null,
      requestedAt: requestedAt.toISOString(),
      finishedAt: null,
      expiresAt: expiresAt.toISOString(),
    };

    // 先写状态再入队：若顺序相反，Worker 可能在状态写入前就开始处理并读不到任务
    await this.saveTask(task);
    await this.redis.set(this.redis.key(EXPORT_ACTIVE_KEY_PREFIX, userId), taskId, EXPORT_TASK_TTL_SECONDS);
    await this.redis.set(idempotencyRedisKey, taskId, EXPORT_IDEMPOTENCY_TTL_SECONDS);

    try {
      // jobId = taskId：同名 job 天然去重，避免重复投递生成两份导出文件
      await this.exportQueue.add('generate', { taskId, userId, scope }, { jobId: taskId });
    } catch (error) {
      // 入队失败必须**回收已写入的状态**，否则用户会被一个永远不会执行的任务锁住 7 天
      await this.redis.del(
        this.redis.key(EXPORT_ACTIVE_KEY_PREFIX, userId),
        idempotencyRedisKey,
        this.redis.key(EXPORT_TASK_KEY_PREFIX, taskId),
      );
      this.logger.error(`导出任务入队失败，已回收任务状态 taskId=${taskId}: ${(error as Error).message}`);
      throw new BusinessException(ErrorCode.QUEUE_ERROR, '导出服务暂时不可用，请稍后重试');
    }

    // 安全相关事实落库（ADR-024：合规审计不依赖易失的 Redis）
    await this.prisma.user
      .update({ where: { id: userId }, data: { exportRequestedAt: requestedAt } })
      .catch((error: Error) => {
        // 记录失败不影响任务本身：任务已入队，审计字段缺失不应让用户拿不到导出
        this.logger.warn(`记录 exportRequestedAt 失败 userId=${userId}: ${error.message}`);
      });

    this.logger.log(`导出任务已创建 taskId=${taskId} userId=${userId} scope=${scope}`);

    return this.toRequestedView(task, false);
  }

  /**
   * 查询导出任务状态（契约 §3.2.8）
   *
   * 「不存在」与「不属于当前用户」返回**同一错误码**（`80005`）：
   * 区分两者等于向攻击者确认「这个 taskId 是存在的」，属信息泄露。
   */
  async getTask(userId: string, taskId: string): Promise<ExportTaskView> {
    const task = await this.loadTask(taskId);

    if (task === null || task.userId !== userId) {
      throw BusinessException.notFound(ErrorCode.EXPORT_TASK_NOT_FOUND);
    }

    return this.toTaskView(task);
  }

  /** 保存任务状态（供 Worker 更新进度；本服务是任务状态的唯一读写入口） */
  async saveTask(task: ExportTaskState): Promise<void> {
    await this.redis.setJson(this.redis.key(EXPORT_TASK_KEY_PREFIX, task.taskId), task, EXPORT_TASK_TTL_SECONDS);
  }

  /** 读取任务状态（不存在返回 null；`isExpired` 需由调用方据 `expiresAt` 判定） */
  async loadTask(taskId: string): Promise<ExportTaskState | null> {
    return this.redis.getJson<ExportTaskState>(this.redis.key(EXPORT_TASK_KEY_PREFIX, taskId));
  }

  /** 清理任务索引（任务终结后释放「单任务」占用） */
  async releaseActiveSlot(userId: string): Promise<void> {
    await this.redis.del(this.redis.key(EXPORT_ACTIVE_KEY_PREFIX, userId));
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private toRequestedView(task: ExportTaskState, isReused: boolean): ExportRequestedView {
    return {
      taskId: task.taskId,
      status: task.status,
      stage: task.stage,
      pollUrl: `/api/v1/users/me/export/${task.taskId}`,
      requestedAt: task.requestedAt,
      isReused,
    };
  }

  private toTaskView(task: ExportTaskState): ExportTaskView {
    const isExpired = Date.parse(task.expiresAt) <= Date.now();

    return {
      taskId: task.taskId,
      // 源文件已过期时，即便曾成功也对外呈现 EXPIRED（契约 §3.2.8 状态枚举）
      status: isExpired && task.status === 'SUCCEEDED' ? 'EXPIRED' : task.status,
      progress: task.progress,
      stage: isExpired ? 'EXPIRED' : task.stage,
      files: isExpired ? [] : task.files,
      requestedAt: task.requestedAt,
      finishedAt: task.finishedAt,
      expiresAt: task.expiresAt,
      isExpired,
    };
  }

  /**
   * 冷静期内禁止导出
   *
   * 不复用 `UserService` 的同名私有方法：调用方语义不同 ——
   * 资料修改是「冷静期内不该改」，导出是「数据即将被删除，导出无意义」，
   * 若将来出现第三个调用方，再抽出共享实现。
   */
  private async assertNotInDeletionGrace(userId: string): Promise<void> {
    const pending = await this.prisma.userDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
      select: { id: true },
    });

    if (pending !== null) {
      throw BusinessException.forbidden(ErrorCode.PROFILE_EDIT_LOCKED, '账号正在注销流程中，暂不支持导出数据');
    }
  }
}
