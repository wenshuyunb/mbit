/**
 * 头像登记 DTO 校验（契约 §3.2.3）
 *
 * ## 这个文件锁的是一个**刻意的"不再接收"决定**
 *
 * 契约原先声明了 `width` / `height`（前端 `getImageInfo` 取得，1–4096），
 * 而实现把它们收下后**完全不参与校验**：`stored_files` 没有宽高列，
 * 也没有任何策略按尺寸校验，真正校验尺寸必须解码图片（项目禁止新增依赖）。
 *
 * "收下再忽略"比"直接拒绝"更糟 —— 客户端以为服务端校验过尺寸/比例，
 * 于是把违规图片的问题留到用户看到头像时才暴露。因此改为不收：
 * 传了会得到明确的 `400 / 10001`。这条断言防止它们被"顺手加回来"。
 *
 * 用与 `main.ts` **同配置**的真实 `ValidationPipe` 走一遍，而不是手搓 `validate()`：
 * `whitelist` + `forbidNonWhitelisted` 的行为才是线上真实行为
 * （交接文档 §6.3 第 9/10 条记录过"单测全绿但线上 400"的同类陷阱）。
 */

import { ValidationPipe } from '@nestjs/common';
import type { BadRequestException } from '@nestjs/common';

import { UpdateAvatarDto } from './dto/user.dto';

/** 与 `main.ts` 的全局管道同配置（改一处必须改另一处，否则测试就成了摆设） */
const bodyPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const OBJECT_KEY = 'avatar/0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70/20260214_a7c3f9e1.webp';

const transformBody = async (payload: Record<string, unknown>): Promise<UpdateAvatarDto> =>
  (await bodyPipe.transform(payload, { type: 'body', metatype: UpdateAvatarDto })) as UpdateAvatarDto;

/** 校验失败时的错误消息（空数组表示通过） */
const rejectionMessages = async (payload: Record<string, unknown>): Promise<string[]> => {
  try {
    await transformBody(payload);
    return [];
  } catch (error) {
    const response = (error as BadRequestException).getResponse();
    const messages = (response as { message?: string[] | string }).message ?? '';

    return Array.isArray(messages) ? messages : [messages];
  }
};

describe('UpdateAvatarDto 校验（契约 §3.2.3）', () => {
  it('【关键】width / height 不再被接收（此前收下却从不校验，客户端以为校验过尺寸）', async () => {
    expect(await rejectionMessages({ objectKey: OBJECT_KEY, width: 512 })).not.toHaveLength(0);
    expect(await rejectionMessages({ objectKey: OBJECT_KEY, height: 512 })).not.toHaveLength(0);
  });

  it('etag / size / isDefault 仍被接收（etag 现在真的参与校验）', async () => {
    await expect(
      transformBody({
        objectKey: OBJECT_KEY,
        etag: 'F1A2B3C4D5E6F708192A3B4C5D6E7F80',
        size: 86_420,
        isDefault: false,
      }),
    ).resolves.toMatchObject({ etag: 'F1A2B3C4D5E6F708192A3B4C5D6E7F80', size: 86_420 });
  });

  it('etag 长度越界被拒（契约 8–64）', async () => {
    expect(await rejectionMessages({ objectKey: OBJECT_KEY, etag: 'short' })).not.toHaveLength(0);
    expect(await rejectionMessages({ objectKey: OBJECT_KEY, etag: 'x'.repeat(65) })).not.toHaveLength(0);
  });

  it('size 超出 2MB 被拒（与 AVATAR 场景策略一致）', async () => {
    expect(await rejectionMessages({ objectKey: OBJECT_KEY, size: 2_097_153 })).not.toHaveLength(0);
    await expect(transformBody({ objectKey: OBJECT_KEY, size: 2_097_152 })).resolves.toBeDefined();
  });

  it('契约示例（去掉 width/height 后）可以原样通过', async () => {
    await expect(
      transformBody({
        objectKey: 'avatar/0195f3a2-7c4e-7b31-9a6d-2f5c8e1b4d70/20260214_a7c3f9.webp',
        etag: 'F1A2B3C4D5E6F708192A3B4C5D6E7F80',
        size: 86_420,
        isDefault: false,
      }),
    ).resolves.toBeDefined();
  });
});
