/**
 * 导出包构建与导出处理器测试
 *
 * 本文件的**首要断言是合规性**：导出包是用户会转发出去的文件，
 * 因此「包里不含 openid 原文 / session_key / phoneEnc / phoneHash」
 * 比「包能生成出来」重要得多 —— 后者失败了用户会看到报错，
 * 前者失败了则是一次静默的数据泄露。
 */

import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';

import { ErrorCode } from '../../../common/errors/error-code';
import type { AppConfig } from '../../../config/config.type';
import { CryptoService } from '../../../infra/crypto/crypto.service';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { StorageService } from '../../storage/storage.service';
import {
  EXPORT_COLLECTION_LIMIT,
  buildExportFileName,
  buildExportObjectKey,
  buildExportPayload,
  buildExportUser,
  buildExportWechat,
  scopeIncludes,
  serializeExportPayload,
} from '../data-export.builder';
import type { DataExportService } from '../data-export.service';
import type { ExportTaskState } from '../dto/user.dto';
import { DataExportProcessor, type ExportJobData } from './data-export.processor';

const USER_ID = '0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70';
const TASK_ID = '0195f3a2-4be1-7d1f-9e8a-a6db3e4f5c3e';
const PLAIN_PHONE = '13800006721';
const OPENID = 'oQ7Xk5aBcDeFgHiJkLmNoPqRsTuVwX';
const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');

const configService = {
  get: (path: string): unknown => ({ 'crypto.key': TEST_KEY, 'crypto.ivSalt': 'salt' })[path],
} as unknown as ConfigService<AppConfig, true>;

const crypto = new CryptoService(configService);

const EXPORTED_AT = new Date('2026-10-10T12:00:00.000Z');

const userSection = (): ReturnType<typeof buildExportUser> =>
  buildExportUser({
    id: USER_ID,
    nickname: '测试用户',
    gender: 'FEMALE',
    birthday: new Date('1995-03-08T00:00:00.000Z'),
    ageVerified: true,
    phonePlain: PLAIN_PHONE,
    status: 'ACTIVE',
    registerChannel: 'DIRECT',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: new Date('2026-10-09T00:00:00.000Z'),
  });

const fullPayload = (): ReturnType<typeof buildExportPayload> =>
  buildExportPayload({
    scope: 'ALL',
    exportedAt: EXPORTED_AT,
    user: userSection(),
    wechat: buildExportWechat({
      platform: 'MINIAPP',
      openid: OPENID,
      unionid: 'uQ7Xk5aBcDeFgHiJkLmNoPqRsTuVwX',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    consents: [
      {
        type: 'PRIVACY_POLICY',
        policyVersion: '2026-01-01',
        agreed: true,
        agreedAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null,
      },
    ],
    testSessions: [{ id: 's-1', definitionCode: 'MBTI_LITE' }],
    personalityProfiles: [{ id: 'p-1', mbtiType: 'INFJ' }],
    aiReports: [{ id: 'r-1', title: '报告' }],
    aiConversations: [{ id: 'c-1', title: '对话' }],
    truncated: [],
  });

describe('导出包构建', () => {
  it('【合规底线】序列化后的包不含任何凭证或明文敏感字段', () => {
    const serialized = serializeExportPayload(fullPayload());

    // openid / unionid 只能以掩码形式出现
    expect(serialized).not.toContain(OPENID);
    expect(serialized).not.toContain('uQ7Xk5aBcDeFgHiJkLmNoPqRsTuVwX');
    // 手机号明文不得出现（只允许脱敏形态）
    expect(serialized).not.toContain(PLAIN_PHONE);
    expect(serialized).toContain('138****6721');
    // 这些字段名根本不应存在
    for (const forbidden of ['sessionKeyEnc', 'session_key', 'phoneEnc', 'phoneHash', 'openid"']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('openid 以「前 4 后 4」掩码呈现（用户可核对账号，但不构成可用凭证）', () => {
    const wechat = buildExportWechat({
      platform: 'MINIAPP',
      openid: OPENID,
      unionid: null,
      createdAt: EXPORTED_AT,
    });

    expect(wechat?.openidMasked).toBe(`oQ7X${'*'.repeat(OPENID.length - 8)}${OPENID.slice(-4)}`);
    expect(wechat?.unionidMasked).toBeNull();
  });

  it('极短标识整体打码（不因长度不足而泄露原文）', () => {
    expect(
      buildExportWechat({ platform: 'MINIAPP', openid: 'short', unionid: null, createdAt: EXPORTED_AT })?.openidMasked,
    ).toBe('*****');
  });

  it('未绑定微信账号时该段为 null', () => {
    expect(buildExportWechat(null)).toBeNull();
  });

  it('未绑定手机号时 phoneMasked 为 null', () => {
    const section = buildExportUser({
      id: USER_ID,
      nickname: null,
      gender: 'UNKNOWN',
      birthday: null,
      ageVerified: false,
      phonePlain: null,
      status: 'ACTIVE',
      registerChannel: null,
      createdAt: EXPORTED_AT,
      lastLoginAt: null,
    });

    expect(section.phoneMasked).toBeNull();
    expect(section.birthday).toBeNull();
    expect(section.lastLoginAt).toBeNull();
  });

  it('生日按日期（不含时间）输出，便于人工阅读', () => {
    expect(userSection().birthday).toBe('1995-03-08');
  });

  it('scope 决定包含哪些段', () => {
    expect(scopeIncludes('ALL', 'PROFILE')).toBe(true);
    expect(scopeIncludes('ALL', 'CONVERSATIONS')).toBe(true);
    expect(scopeIncludes('PROFILE', 'REPORTS')).toBe(false);
    expect(scopeIncludes('REPORTS', 'REPORTS')).toBe(true);
    expect(scopeIncludes('CONVERSATIONS', 'PROFILE')).toBe(false);
  });

  it('按 scope 裁剪后只保留对应段', () => {
    const profileOnly = buildExportPayload({
      scope: 'PROFILE',
      exportedAt: EXPORTED_AT,
      user: userSection(),
      wechat: null,
      consents: [],
      testSessions: [],
      personalityProfiles: [],
      aiReports: [],
      aiConversations: [],
      truncated: [],
    });

    expect(profileOnly.profile).toBeDefined();
    expect(profileOnly.reports).toBeUndefined();
    expect(profileOnly.conversations).toBeUndefined();
  });

  it('截断信息随包下发（用户有权知道导出是否完整）', () => {
    const payload = buildExportPayload({
      scope: 'REPORTS',
      exportedAt: EXPORTED_AT,
      user: userSection(),
      wechat: null,
      consents: [],
      testSessions: [],
      personalityProfiles: [],
      aiReports: [],
      aiConversations: [],
      truncated: ['testSessions'],
    });

    expect(payload.truncated).toEqual(['testSessions']);
    expect(payload.notice).toContain('SoulMap AI');
  });

  it('对象键与文件名由服务端生成且可预测', () => {
    expect(buildExportObjectKey(USER_ID, TASK_ID, 'json')).toBe(`export/${USER_ID}/${TASK_ID}.json`);
    expect(buildExportFileName(TASK_ID, 'json', EXPORTED_AT)).toBe(
      `soulmap-export-${TASK_ID.slice(0, 8)}-20261010.json`,
    );
  });

  it('包为 2 空格缩进（面向人的文件，可读性优先）', () => {
    expect(serializeExportPayload(fullPayload())).toContain('\n  "schemaVersion"');
  });
});

// ============================================================================

interface Harness {
  processor: DataExportProcessor;
  prisma: {
    user: { findUnique: jest.Mock };
    wechatAccount: { findUnique: jest.Mock };
    userConsent: { findMany: jest.Mock };
    testSession: { findMany: jest.Mock };
    personalityProfile: { findMany: jest.Mock };
    aiReport: { findMany: jest.Mock };
    aiConversation: { findMany: jest.Mock };
  };
  storage: { uploadServerObject: jest.Mock; signServerObjectUrl: jest.Mock };
  exportService: { loadTask: jest.Mock; saveTask: jest.Mock; releaseActiveSlot: jest.Mock };
}

const taskState = (overrides: Partial<ExportTaskState> = {}): ExportTaskState => ({
  taskId: TASK_ID,
  userId: USER_ID,
  scope: 'ALL',
  status: 'PENDING',
  stage: 'QUEUED',
  progress: 0,
  files: [],
  errorMessage: null,
  requestedAt: EXPORTED_AT.toISOString(),
  finishedAt: null,
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  ...overrides,
});

const createHarness = (): Harness => {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: USER_ID,
        nickname: 'N',
        gender: 'FEMALE',
        birthday: null,
        ageVerified: true,
        phoneEnc: crypto.encrypt(PLAIN_PHONE),
        status: 'ACTIVE',
        registerChannel: 'DIRECT',
        createdAt: EXPORTED_AT,
        lastLoginAt: null,
      }),
    },
    wechatAccount: {
      findUnique: jest.fn().mockResolvedValue({
        platform: 'MINIAPP',
        openid: OPENID,
        unionid: null,
        createdAt: EXPORTED_AT,
      }),
    },
    userConsent: { findMany: jest.fn().mockResolvedValue([]) },
    testSession: { findMany: jest.fn().mockResolvedValue([]) },
    personalityProfile: { findMany: jest.fn().mockResolvedValue([]) },
    aiReport: { findMany: jest.fn().mockResolvedValue([]) },
    aiConversation: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const storage = {
    uploadServerObject: jest.fn().mockResolvedValue({ etag: 'E', sizeBytes: 1234 }),
    signServerObjectUrl: jest.fn().mockReturnValue({
      url: 'https://cdn.soulmap.cn/export/a.json?Signature=x',
      expiresAt: new Date('2026-10-11T12:00:00.000Z'),
    }),
  };

  const exportService = {
    loadTask: jest.fn().mockResolvedValue(taskState()),
    saveTask: jest.fn().mockResolvedValue(undefined),
    releaseActiveSlot: jest.fn().mockResolvedValue(undefined),
  };

  const processor = new DataExportProcessor(
    prisma as unknown as PrismaService,
    crypto,
    storage as unknown as StorageService,
    exportService as unknown as DataExportService,
  );

  return { processor, prisma, storage, exportService };
};

const job = (overrides: { attemptsMade?: number; attempts?: number } = {}): Job<ExportJobData> =>
  ({
    data: { taskId: TASK_ID, userId: USER_ID, scope: 'ALL' },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 2 },
  }) as unknown as Job<ExportJobData>;

/** 取出最后一次 saveTask 写入的状态 */
const lastSaved = (harness: Harness): ExportTaskState =>
  harness.exportService.saveTask.mock.calls.at(-1)?.[0] as ExportTaskState;

describe('DataExportProcessor', () => {
  it('生成导出包、上传并签发下载 URL，最终标记 SUCCEEDED', async () => {
    const harness = createHarness();

    await harness.processor.process(job());

    expect(harness.storage.uploadServerObject).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: `export/${USER_ID}/${TASK_ID}.json`,
        contentType: 'application/json',
      }),
    );

    const finalState = lastSaved(harness);
    expect(finalState.status).toBe('SUCCEEDED');
    expect(finalState.stage).toBe('DONE');
    expect(finalState.progress).toBe(100);
    expect(finalState.files).toHaveLength(1);
    expect(finalState.files[0].downloadUrl).toContain('Signature=');
    expect(harness.exportService.releaseActiveSlot).toHaveBeenCalledWith(USER_ID);
  });

  it('【关键】上传的对象内容不含明文手机号与 openid', async () => {
    const harness = createHarness();

    await harness.processor.process(job());

    const uploaded = harness.storage.uploadServerObject.mock.calls[0][0] as { body: string };
    expect(uploaded.body).not.toContain(PLAIN_PHONE);
    expect(uploaded.body).not.toContain(OPENID);
    expect(uploaded.body).toContain('138****6721');
  });

  it('进度分阶段写回（前端可见阶段而非只有转圈）', async () => {
    const harness = createHarness();

    await harness.processor.process(job());

    const stages = harness.exportService.saveTask.mock.calls.map((call) => (call[0] as ExportTaskState).stage);
    expect(stages).toEqual(['COLLECTING', 'RENDERING_JSON', 'UPLOADING', 'DONE']);
  });

  it('【关键】任务已完成时跳过重复生成（重复投递不产生两份文件）', async () => {
    const harness = createHarness();
    harness.exportService.loadTask.mockResolvedValue(taskState({ status: 'SUCCEEDED' }));

    await harness.processor.process(job());

    expect(harness.storage.uploadServerObject).not.toHaveBeenCalled();
    expect(harness.exportService.saveTask).not.toHaveBeenCalled();
  });

  it('任务状态已被 TTL 回收时静默跳过（重试无意义）', async () => {
    const harness = createHarness();
    harness.exportService.loadTask.mockResolvedValue(null);

    await expect(harness.processor.process(job())).resolves.toBeUndefined();
    expect(harness.storage.uploadServerObject).not.toHaveBeenCalled();
  });

  it('【关键】失败时标记 FAILED 并抛出（让 BullMQ 重试）', async () => {
    const harness = createHarness();
    harness.storage.uploadServerObject.mockRejectedValue(new Error('OSS 不可用'));

    await expect(harness.processor.process(job({ attemptsMade: 0, attempts: 2 }))).rejects.toThrow('OSS 不可用');

    const finalState = lastSaved(harness);
    expect(finalState.status).toBe('FAILED');
    expect(finalState.stage).toBe('ERROR');
    expect(finalState.errorMessage).toContain('OSS 不可用');
  });

  it('【关键】非最后一次尝试失败时**不**释放单任务占用（避免产生两份导出）', async () => {
    const harness = createHarness();
    harness.storage.uploadServerObject.mockRejectedValue(new Error('boom'));

    await expect(harness.processor.process(job({ attemptsMade: 0, attempts: 2 }))).rejects.toThrow();
    expect(harness.exportService.releaseActiveSlot).not.toHaveBeenCalled();
  });

  it('【关键】最后一次尝试仍失败时释放占用（不让用户被永久锁住）', async () => {
    const harness = createHarness();
    harness.storage.uploadServerObject.mockRejectedValue(new Error('boom'));

    await expect(harness.processor.process(job({ attemptsMade: 1, attempts: 2 }))).rejects.toThrow();
    expect(harness.exportService.releaseActiveSlot).toHaveBeenCalledWith(USER_ID);
  });

  it('用户不存在时任务失败并带上明确错误码', async () => {
    const harness = createHarness();
    harness.prisma.user.findUnique.mockResolvedValue(null);

    await expect(harness.processor.process(job())).rejects.toMatchObject({
      code: ErrorCode.USER_NOT_FOUND,
    });
    expect(lastSaved(harness).status).toBe('FAILED');
  });

  it('超出上限的集合被截断并在包内标注', async () => {
    const harness = createHarness();
    harness.prisma.testSession.findMany.mockResolvedValue(
      Array.from({ length: EXPORT_COLLECTION_LIMIT + 1 }, (_, index) => ({ id: `s-${index}` })),
    );

    await harness.processor.process(job());

    const uploaded = harness.storage.uploadServerObject.mock.calls[0][0] as { body: string };
    const payload = JSON.parse(uploaded.body) as {
      truncated: string[];
      reports: { testSessions: unknown[] };
    };

    expect(payload.truncated).toEqual(['testSessions']);
    expect(payload.reports.testSessions).toHaveLength(EXPORT_COLLECTION_LIMIT);
  });

  it('REPORTS 范围不查询会话数据（不做无谓查询）', async () => {
    const harness = createHarness();
    harness.exportService.loadTask.mockResolvedValue(taskState({ scope: 'REPORTS' }));

    await harness.processor.process({
      ...job(),
      data: { taskId: TASK_ID, userId: USER_ID, scope: 'REPORTS' },
    } as Job<ExportJobData>);

    expect(harness.prisma.aiConversation.findMany).not.toHaveBeenCalled();
    expect(harness.prisma.wechatAccount.findUnique).not.toHaveBeenCalled();
  });
});
