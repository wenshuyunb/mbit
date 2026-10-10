-- ============================================================================
-- 补齐两张被接口契约要求、但首版数据模型遗漏的审计表（ADR-029）
--
--   · stored_files       —— 契约 §3.10.3 规则 4：文件元数据落库，供内容安全与
--                           「孤儿对象 24h 清理」使用（OSS 侧无法区分「已登记」与
--                           「上传后未登记」，因此该判断只能由本表承担）
--   · user_phone_history —— 契约 §3.2.4 规则 3：手机号换绑历史，供合规审计
--                           明文零落库：只存 phone_hash 与脱敏值（架构 §14.2）
--
-- 顺带新增 storage_scene 枚举，使上传场景在数据库层有取值约束，
-- 而非仅依赖应用层校验（避免脏数据进入后无法用类型发现问题）。
--
-- 生成方式（非手写）：
--   prisma migrate diff \
--     --from-schema-datamodel <变更前 schema> \
--     --to-schema-datamodel   prisma/schema.prisma --script
-- ============================================================================

-- CreateEnum
CREATE TYPE "storage_scene" AS ENUM ('AVATAR', 'REPORT_PDF', 'SHARE_CARD', 'FEEDBACK_IMAGE', 'CHAT_ATTACHMENT');

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "object_key" VARCHAR(200) NOT NULL,
    "user_id" UUID,
    "scene" "storage_scene" NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "mime_type" VARCHAR(64) NOT NULL,
    "etag" VARCHAR(64),
    "safety_status" "safety_check_status" NOT NULL DEFAULT 'PENDING',
    "safety_labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "registered_at" TIMESTAMPTZ(3),
    "callback_count" INTEGER NOT NULL DEFAULT 1,
    "last_callback_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_phone_history" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_hash" VARCHAR(64) NOT NULL,
    "phone_masked" VARCHAR(32) NOT NULL,
    "country_code" VARCHAR(8) NOT NULL DEFAULT '86',
    "source" VARCHAR(16),
    "replaced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_phone_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_object_key_key" ON "stored_files"("object_key");

-- CreateIndex
CREATE INDEX "stored_files_user_id_created_at_idx" ON "stored_files"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stored_files_scene_created_at_idx" ON "stored_files"("scene", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stored_files_safety_status_idx" ON "stored_files"("safety_status");

-- CreateIndex
CREATE INDEX "stored_files_registered_at_created_at_idx" ON "stored_files"("registered_at", "created_at");

-- CreateIndex
CREATE INDEX "user_phone_history_user_id_created_at_idx" ON "user_phone_history"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "user_phone_history_phone_hash_idx" ON "user_phone_history"("phone_hash");

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_phone_history" ADD CONSTRAINT "user_phone_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
