-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'DISABLED', 'DELETED');

-- CreateEnum
CREATE TYPE "user_gender" AS ENUM ('UNKNOWN', 'MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "wechat_platform" AS ENUM ('MINIAPP', 'OFFICIAL_ACCOUNT', 'WEB', 'APP');

-- CreateEnum
CREATE TYPE "consent_type" AS ENUM ('PRIVACY_POLICY', 'TERMS_OF_SERVICE', 'AGE_DECLARATION', 'AI_CONTENT_NOTICE', 'MARKETING');

-- CreateEnum
CREATE TYPE "deletion_request_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "test_category" AS ENUM ('MBTI', 'BIG_FIVE', 'RELATIONSHIP_STYLE', 'COMPREHENSIVE');

-- CreateEnum
CREATE TYPE "test_definition_status" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "question_selection_mode" AS ENUM ('STATIC_SET', 'DIMENSION_QUOTA');

-- CreateEnum
CREATE TYPE "question_type" AS ENUM ('LIKERT5', 'BINARY', 'FORCED_CHOICE', 'RANK');

-- CreateEnum
CREATE TYPE "dimension" AS ENUM ('EI', 'SN', 'TF', 'JP', 'OPENNESS', 'CONSCIENTIOUSNESS', 'EXTRAVERSION', 'AGREEABLENESS', 'NEUROTICISM', 'ATTACHMENT', 'LOVE_LANGUAGE', 'CONFLICT_STYLE');

-- CreateEnum
CREATE TYPE "test_session_status" AS ENUM ('CREATED', 'IN_PROGRESS', 'SUBMITTED', 'SCORED', 'REPORT_READY', 'EXPIRED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "attachment_style" AS ENUM ('SECURE', 'ANXIOUS', 'AVOIDANT', 'FEARFUL');

-- CreateEnum
CREATE TYPE "prompt_type" AS ENUM ('MBTI_REPORT', 'RELATIONSHIP_REPORT', 'AI_COMPANION', 'EMOTION_ANALYSIS', 'SYSTEM_SAFETY');

-- CreateEnum
CREATE TYPE "prompt_version_status" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ai_task_type" AS ENUM ('MBTI_REPORT', 'RELATIONSHIP_REPORT', 'AI_COMPANION', 'EMOTION_ANALYSIS', 'MEMORY_SUMMARY', 'STRUCTURED_EXTRACT', 'SAFETY_CHECK');

-- CreateEnum
CREATE TYPE "ai_provider" AS ENUM ('DEEPSEEK', 'OPENAI', 'QWEN');

-- CreateEnum
CREATE TYPE "ai_report_type" AS ENUM ('MBTI_REPORT', 'BIG_FIVE_REPORT', 'RELATIONSHIP_REPORT', 'GROWTH_SUMMARY');

-- CreateEnum
CREATE TYPE "ai_report_status" AS ENUM ('QUEUED', 'GENERATING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ai_message_role" AS ENUM ('SYSTEM', 'USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "ai_conversation_status" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "safety_check_status" AS ENUM ('PENDING', 'PASS', 'BLOCKED', 'REVIEW');

-- CreateEnum
CREATE TYPE "ai_call_status" AS ENUM ('SUCCESS', 'FAILED', 'TIMEOUT', 'CIRCUIT_OPEN', 'BLOCKED', 'CACHE_HIT');

-- CreateEnum
CREATE TYPE "relationship_type" AS ENUM ('COUPLE', 'FRIEND', 'FAMILY');

-- CreateEnum
CREATE TYPE "relationship_status" AS ENUM ('PENDING_A_CONFIRM', 'ACTIVE', 'REJECTED', 'UNBOUND');

-- CreateEnum
CREATE TYPE "relationship_invite_status" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "compatibility_report_status" AS ENUM ('QUEUED', 'COMPUTING', 'GENERATING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "product_type" AS ENUM ('REPORT_PERSONAL', 'REPORT_COMPATIBILITY', 'MEMBERSHIP', 'AI_CREDITS');

-- CreateEnum
CREATE TYPE "product_status" AS ENUM ('DRAFT', 'ON_SALE', 'OFF_SALE');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('CREATED', 'PENDING_PAY', 'PAID', 'FULFILLED', 'CLOSED', 'CANCELLED', 'REFUNDED', 'PARTIAL_REFUNDED');

-- CreateEnum
CREATE TYPE "pay_channel" AS ENUM ('WECHAT_JSAPI', 'WECHAT_NATIVE', 'WECHAT_H5', 'SANDBOX');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('INIT', 'SUCCESS', 'FAILED', 'CLOSED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CLOSED');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED', 'FROZEN');

-- CreateEnum
CREATE TYPE "membership_source" AS ENUM ('PURCHASE', 'GRANT', 'TRIAL', 'PROMOTION');

-- CreateEnum
CREATE TYPE "entitlement_type" AS ENUM ('REPORT_UNLOCK', 'MEMBERSHIP_ACTIVE', 'AI_CREDITS', 'PDF_EXPORT');

-- CreateEnum
CREATE TYPE "entitlement_status" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "admin_user_status" AS ENUM ('ACTIVE', 'DISABLED', 'LOCKED');

-- CreateEnum
CREATE TYPE "admin_audit_action" AS ENUM ('LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'CREATE', 'UPDATE', 'DELETE', 'PUBLISH', 'UNPUBLISH', 'ROLLBACK', 'GRANT', 'REVOKE', 'REFUND', 'MANUAL_FULFILL', 'EXPORT', 'IMPORT', 'CONFIG_CHANGE');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('SUBSCRIPTION_MESSAGE', 'IN_APP');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ', 'CANCELLED');

-- CreateEnum
CREATE TYPE "share_channel" AS ENUM ('WECHAT_SESSION', 'WECHAT_TIMELINE', 'MINIAPP_CODE', 'POSTER', 'QRCODE', 'COPY_LINK');

-- CreateEnum
CREATE TYPE "share_target_type" AS ENUM ('TEST_RESULT', 'AI_REPORT', 'COMPATIBILITY_REPORT', 'INVITE', 'PROFILE_CARD', 'APP_HOME');

-- CreateEnum
CREATE TYPE "config_value_type" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "nickname" VARCHAR(64),
    "avatar_url" VARCHAR(512),
    "gender" "user_gender" NOT NULL DEFAULT 'UNKNOWN',
    "birthday" DATE,
    "age_verified" BOOLEAN NOT NULL DEFAULT false,
    "phone_enc" VARCHAR(512),
    "phone_hash" VARCHAR(64),
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "inviter_user_id" UUID,
    "register_channel" VARCHAR(32),
    "last_login_at" TIMESTAMPTZ(3),
    "last_login_ip" VARCHAR(64),
    "export_requested_at" TIMESTAMPTZ(3),
    "anonymized_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wechat_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "appid" VARCHAR(64) NOT NULL,
    "platform" "wechat_platform" NOT NULL DEFAULT 'MINIAPP',
    "openid" VARCHAR(64) NOT NULL,
    "unionid" VARCHAR(64),
    "session_key_enc" VARCHAR(512),
    "session_key_expire_at" TIMESTAMPTZ(3),
    "nickname_enc" VARCHAR(512),
    "avatar_url" VARCHAR(512),
    "last_auth_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "wechat_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "jti" VARCHAR(64) NOT NULL,
    "refresh_token_hash" VARCHAR(128) NOT NULL,
    "platform" VARCHAR(32),
    "device_id" VARCHAR(128),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(256),
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(64),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "consent_type" NOT NULL,
    "policy_version" VARCHAR(32) NOT NULL,
    "agreed" BOOLEAN NOT NULL DEFAULT true,
    "agreed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "channel" VARCHAR(32),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(256),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_deletion_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "deletion_request_status" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(512),
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "operator_admin_id" UUID,
    "operator_name" VARCHAR(64),
    "anonymize_log" JSONB,
    "retention_note" VARCHAR(512),
    "ip" VARCHAR(64),
    "failure_reason" VARCHAR(512),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_definitions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "category" "test_category" NOT NULL,
    "description" VARCHAR(512),
    "version" VARCHAR(16) NOT NULL DEFAULT '1.0.0',
    "status" "test_definition_status" NOT NULL DEFAULT 'DRAFT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "question_count" INTEGER NOT NULL DEFAULT 0,
    "estimated_minutes" INTEGER NOT NULL DEFAULT 0,
    "selection_mode" "question_selection_mode" NOT NULL DEFAULT 'STATIC_SET',
    "dimension_quotas" JSONB,
    "scoring_config" JSONB,
    "result_template" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "cover_url" VARCHAR(512),
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "test_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "test_definition_id" UUID NOT NULL,
    "code" VARCHAR(48) NOT NULL,
    "content" TEXT NOT NULL,
    "type" "question_type" NOT NULL,
    "dimension" "dimension" NOT NULL,
    "sub_dimension" VARCHAR(32),
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "reverse_scored" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_value" INTEGER,
    "max_value" INTEGER,
    "scoring_config" JSONB,
    "explanation" TEXT,
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_options" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "label" VARCHAR(256) NOT NULL,
    "value" INTEGER NOT NULL,
    "score_map" JSONB NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "test_definition_id" UUID NOT NULL,
    "definition_code" VARCHAR(32) NOT NULL,
    "definition_version" VARCHAR(16) NOT NULL,
    "status" "test_session_status" NOT NULL DEFAULT 'CREATED',
    "paper_snapshot" JSONB NOT NULL,
    "question_count" INTEGER NOT NULL DEFAULT 0,
    "answered_count" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3),
    "expired_at" TIMESTAMPTZ(3),
    "scored_at" TIMESTAMPTZ(3),
    "report_ready_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "consistency_score" DOUBLE PRECISION,
    "completion_rate" DOUBLE PRECISION,
    "client_platform" VARCHAR(32),
    "client_version" VARCHAR(32),
    "idempotency_key" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "test_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_answers" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "question_type" "question_type" NOT NULL,
    "raw_value" JSONB NOT NULL,
    "score_value" DOUBLE PRECISION,
    "response_ms" INTEGER,
    "is_skipped" BOOLEAN NOT NULL DEFAULT false,
    "answered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "test_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_results" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "test_definition_id" UUID NOT NULL,
    "definition_code" VARCHAR(32) NOT NULL,
    "engine_version" VARCHAR(16) NOT NULL,
    "mbti_type" VARCHAR(4),
    "mbti_dimensions" JSONB,
    "big_five_scores" JSONB,
    "raw_scores" JSONB NOT NULL,
    "relationship_style" JSONB,
    "quality_metrics" JSONB,
    "consistency_score" DOUBLE PRECISION,
    "completion_rate" DOUBLE PRECISION,
    "avg_response_ms" INTEGER,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personality_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "test_result_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "engine_version" VARCHAR(16) NOT NULL,
    "mbti_type" VARCHAR(4) NOT NULL,
    "mbti_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ei_percent" DOUBLE PRECISION NOT NULL,
    "sn_percent" DOUBLE PRECISION NOT NULL,
    "tf_percent" DOUBLE PRECISION NOT NULL,
    "jp_percent" DOUBLE PRECISION NOT NULL,
    "openness" DOUBLE PRECISION NOT NULL,
    "conscientiousness" DOUBLE PRECISION NOT NULL,
    "extraversion" DOUBLE PRECISION NOT NULL,
    "agreeableness" DOUBLE PRECISION NOT NULL,
    "neuroticism" DOUBLE PRECISION NOT NULL,
    "attachment_style" "attachment_style" NOT NULL,
    "love_languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conflict_style" VARCHAR(32),
    "relationship_style" JSONB,
    "traits" JSONB,
    "consistency_score" DOUBLE PRECISION,
    "completion_rate" DOUBLE PRECISION,
    "avg_response_ms" INTEGER,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "personality_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personality_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "profile_id" UUID,
    "source_session_id" UUID,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mbti_type" VARCHAR(4) NOT NULL,
    "big_five" JSONB NOT NULL,
    "relationship_style" JSONB,
    "completeness_score" DOUBLE PRECISION,
    "mood_score" DOUBLE PRECISION,
    "note" VARCHAR(256),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personality_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationship_style_rules" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(512),
    "priority" INTEGER NOT NULL DEFAULT 100,
    "conditions" JSONB NOT NULL,
    "result_attachment" "attachment_style" NOT NULL,
    "result_love_languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "result_conflict_style" VARCHAR(32),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" VARCHAR(16) NOT NULL DEFAULT '1.0.0',
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "relationship_style_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "type" "prompt_type" NOT NULL,
    "description" VARCHAR(512),
    "active_version_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "user_prompt_template" TEXT NOT NULL,
    "variables" JSONB,
    "output_schema" JSONB,
    "model" VARCHAR(64),
    "provider" "ai_provider",
    "temperature" DOUBLE PRECISION DEFAULT 0.7,
    "max_tokens" INTEGER DEFAULT 2048,
    "top_p" DOUBLE PRECISION,
    "status" "prompt_version_status" NOT NULL DEFAULT 'DRAFT',
    "traffic_weight" INTEGER NOT NULL DEFAULT 100,
    "change_note" VARCHAR(512),
    "published_at" TIMESTAMPTZ(3),
    "published_by_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_task_routings" (
    "id" UUID NOT NULL,
    "task_type" "ai_task_type" NOT NULL,
    "primary_provider" "ai_provider" NOT NULL,
    "primary_model" VARCHAR(64) NOT NULL,
    "fallback_provider" "ai_provider",
    "fallback_model" VARCHAR(64),
    "temperature" DOUBLE PRECISION DEFAULT 0.7,
    "max_tokens" INTEGER DEFAULT 2048,
    "timeout_ms" INTEGER NOT NULL DEFAULT 60000,
    "stream_first_token_ms" INTEGER DEFAULT 20000,
    "stream_total_ms" INTEGER DEFAULT 180000,
    "max_retries" INTEGER NOT NULL DEFAULT 2,
    "circuit_failure_threshold" INTEGER NOT NULL DEFAULT 5,
    "circuit_open_ms" INTEGER NOT NULL DEFAULT 60000,
    "daily_cost_budget_amount" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(256),
    "updated_by_admin_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_task_routings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "relationship_id" UUID,
    "title" VARCHAR(128),
    "scene" VARCHAR(32),
    "status" "ai_conversation_status" NOT NULL DEFAULT 'ACTIVE',
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_cost_amount" INTEGER NOT NULL DEFAULT 0,
    "memory_summary" TEXT,
    "memory_tokens" INTEGER NOT NULL DEFAULT 0,
    "memory_updated_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID,
    "role" "ai_message_role" NOT NULL,
    "content" TEXT NOT NULL,
    "content_length" INTEGER NOT NULL DEFAULT 0,
    "provider" "ai_provider",
    "model" VARCHAR(64),
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_amount" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "finish_reason" VARCHAR(32),
    "safety_status" "safety_check_status" NOT NULL DEFAULT 'PENDING',
    "safety_labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "client_message_id" VARCHAR(64),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_reports" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "ai_report_type" NOT NULL,
    "status" "ai_report_status" NOT NULL DEFAULT 'QUEUED',
    "session_id" UUID,
    "relationship_id" UUID,
    "profile_id" UUID,
    "prompt_template_key" VARCHAR(64) NOT NULL,
    "prompt_version_id" UUID,
    "cache_key" VARCHAR(128) NOT NULL,
    "title" VARCHAR(128),
    "summary" VARCHAR(1024),
    "content" TEXT,
    "content_length" INTEGER NOT NULL DEFAULT 0,
    "free_preview_length" INTEGER NOT NULL DEFAULT 0,
    "section_count" INTEGER NOT NULL DEFAULT 0,
    "provider" "ai_provider",
    "model" VARCHAR(64),
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_amount" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(32),
    "error_message" VARCHAR(1024),
    "generation_started_at" TIMESTAMPTZ(3),
    "generation_finished_at" TIMESTAMPTZ(3),
    "pdf_url" VARCHAR(512),
    "pdf_generated_at" TIMESTAMPTZ(3),
    "share_image_url" VARCHAR(512),
    "quality_score" DOUBLE PRECISION,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_sections" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "section_key" VARCHAR(48) NOT NULL,
    "title" VARCHAR(128) NOT NULL,
    "content" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_free_preview" BOOLEAN NOT NULL DEFAULT false,
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "model" VARCHAR(64),
    "generated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "conversation_id" UUID,
    "report_id" UUID,
    "message_id" UUID,
    "task_type" "ai_task_type" NOT NULL,
    "provider" "ai_provider" NOT NULL,
    "model" VARCHAR(64) NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_amount" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "retry_index" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "request_id" VARCHAR(64),
    "usage_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_call_audits" (
    "id" UUID NOT NULL,
    "request_id" VARCHAR(64) NOT NULL,
    "user_id" UUID,
    "report_id" UUID,
    "task_type" "ai_task_type" NOT NULL,
    "provider" "ai_provider" NOT NULL,
    "model" VARCHAR(64) NOT NULL,
    "prompt_fingerprint" VARCHAR(64) NOT NULL,
    "prompt_length" INTEGER NOT NULL DEFAULT 0,
    "response_length" INTEGER NOT NULL DEFAULT 0,
    "redacted_sample" VARCHAR(2000),
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "status" "ai_call_status" NOT NULL,
    "http_status" INTEGER,
    "error_code" VARCHAR(32),
    "error_message" VARCHAR(512),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_call_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" UUID NOT NULL,
    "pair_key" VARCHAR(80) NOT NULL,
    "user_a_id" UUID NOT NULL,
    "user_b_id" UUID NOT NULL,
    "type" "relationship_type" NOT NULL,
    "status" "relationship_status" NOT NULL DEFAULT 'PENDING_A_CONFIRM',
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_by_user_id" UUID,
    "unbound_at" TIMESTAMPTZ(3),
    "unbound_reason" VARCHAR(256),
    "unbound_by_user_id" UUID,
    "last_report_at" TIMESTAMPTZ(3),
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationship_invites" (
    "id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "inviter_id" UUID NOT NULL,
    "invitee_id" UUID,
    "relation_type" "relationship_type" NOT NULL,
    "status" "relationship_invite_status" NOT NULL DEFAULT 'PENDING',
    "message" VARCHAR(256),
    "scene" VARCHAR(64),
    "qr_code_url" VARCHAR(512),
    "channel" "share_channel",
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "relationship_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "relationship_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compatibility_reports" (
    "id" UUID NOT NULL,
    "relationship_id" UUID NOT NULL,
    "profile_a_id" UUID NOT NULL,
    "profile_b_id" UUID NOT NULL,
    "weights_id" UUID NOT NULL,
    "weights_version" VARCHAR(16) NOT NULL,
    "status" "compatibility_report_status" NOT NULL DEFAULT 'QUEUED',
    "total_score" INTEGER,
    "mbti_score" INTEGER,
    "big_five_score" INTEGER,
    "attachment_score" INTEGER,
    "communication_score" INTEGER,
    "score_breakdown" JSONB,
    "advantages" JSONB,
    "conflicts" JSONB,
    "suggestions" JSONB,
    "cache_key" VARCHAR(128) NOT NULL,
    "engine_version" VARCHAR(16) NOT NULL,
    "ai_report_id" UUID,
    "prompt_version_id" UUID,
    "provider" "ai_provider",
    "model" VARCHAR(64),
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_amount" INTEGER NOT NULL DEFAULT 0,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(32),
    "error_message" VARCHAR(1024),
    "computed_at" TIMESTAMPTZ(3),
    "generated_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "compatibility_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compatibility_weights" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "version" VARCHAR(16) NOT NULL,
    "description" VARCHAR(512),
    "mbti_matrix" JSONB NOT NULL,
    "big_five_config" JSONB NOT NULL,
    "attachment_matrix" JSONB NOT NULL,
    "communication_config" JSONB,
    "dimension_weights" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "compatibility_weights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "code" VARCHAR(48) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "type" "product_type" NOT NULL,
    "description" VARCHAR(1024),
    "price_amount" INTEGER NOT NULL,
    "original_amount" INTEGER,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "credits" INTEGER,
    "duration_days" INTEGER,
    "membership_plan_id" UUID,
    "report_type" "ai_report_type",
    "cover_url" VARCHAR(512),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "product_status" NOT NULL DEFAULT 'DRAFT',
    "purchase_limit" INTEGER,
    "valid_from" TIMESTAMPTZ(3),
    "valid_to" TIMESTAMPTZ(3),
    "is_recommended" BOOLEAN NOT NULL DEFAULT false,
    "created_by_admin_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_plans" (
    "id" UUID NOT NULL,
    "code" VARCHAR(48) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(1024),
    "duration_days" INTEGER NOT NULL,
    "price_amount" INTEGER NOT NULL,
    "original_amount" INTEGER,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "benefits" JSONB NOT NULL,
    "daily_ai_quota" INTEGER NOT NULL DEFAULT 0,
    "total_ai_quota" INTEGER,
    "pdf_export_quota" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_recommended" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_admin_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "membership_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_no" VARCHAR(32) NOT NULL,
    "user_id" UUID NOT NULL,
    "product_id" UUID,
    "plan_id" UUID,
    "product_type" "product_type" NOT NULL,
    "product_snapshot" JSONB NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "total_amount" INTEGER NOT NULL,
    "discount_amount" INTEGER NOT NULL DEFAULT 0,
    "paid_amount" INTEGER NOT NULL DEFAULT 0,
    "refunded_amount" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "status" "order_status" NOT NULL DEFAULT 'CREATED',
    "pay_channel" "pay_channel",
    "client_ip" VARCHAR(64),
    "remark" VARCHAR(256),
    "related_report_id" UUID,
    "related_relationship_id" UUID,
    "expired_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "fulfilled_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(256),
    "idempotency_key" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "out_trade_no" VARCHAR(32) NOT NULL,
    "transaction_id" VARCHAR(64),
    "prepay_id" VARCHAR(64),
    "channel" "pay_channel" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'INIT',
    "amount" INTEGER NOT NULL,
    "payer_amount" INTEGER,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "trade_state" VARCHAR(32),
    "bank_type" VARCHAR(32),
    "appid" VARCHAR(64),
    "mchid" VARCHAR(64),
    "notify_payload" JSONB,
    "notify_received_at" TIMESTAMPTZ(3),
    "idempotency_key" VARCHAR(64),
    "success_time" TIMESTAMPTZ(3),
    "error_code" VARCHAR(32),
    "error_message" VARCHAR(512),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "refund_no" VARCHAR(32) NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "out_refund_no" VARCHAR(32) NOT NULL,
    "refund_id" VARCHAR(64),
    "refund_amount" INTEGER NOT NULL,
    "total_amount" INTEGER NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "reason" VARCHAR(256),
    "status" "refund_status" NOT NULL DEFAULT 'PENDING',
    "channel" "pay_channel" NOT NULL,
    "operator_admin_id" UUID,
    "approved_by_admin_id" UUID,
    "notify_payload" JSONB,
    "success_time" TIMESTAMPTZ(3),
    "error_code" VARCHAR(32),
    "error_message" VARCHAR(512),
    "idempotency_key" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "order_id" UUID,
    "status" "membership_status" NOT NULL DEFAULT 'ACTIVE',
    "source" "membership_source" NOT NULL DEFAULT 'PURCHASE',
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "expire_at" TIMESTAMPTZ(3) NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(256),
    "benefits_snapshot" JSONB NOT NULL,
    "daily_ai_used" INTEGER NOT NULL DEFAULT 0,
    "daily_ai_used_date" DATE,
    "granted_by_admin_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlements" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "entitlement_type" NOT NULL,
    "status" "entitlement_status" NOT NULL DEFAULT 'ACTIVE',
    "resource_key" VARCHAR(128),
    "order_id" UUID,
    "membership_id" UUID,
    "report_id" UUID,
    "relationship_id" UUID,
    "total_quota" INTEGER,
    "used_quota" INTEGER NOT NULL DEFAULT 0,
    "remaining_quota" INTEGER,
    "start_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expire_at" TIMESTAMPTZ(3),
    "consumed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" VARCHAR(256),
    "idempotency_key" VARCHAR(128),
    "granted_by_admin_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(48) NOT NULL,
    "password_hash" VARCHAR(256) NOT NULL,
    "nickname" VARCHAR(64),
    "real_name" VARCHAR(64),
    "email_enc" VARCHAR(512),
    "phone_enc" VARCHAR(512),
    "status" "admin_user_status" NOT NULL DEFAULT 'ACTIVE',
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "password_updated_at" TIMESTAMPTZ(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "last_login_ip" VARCHAR(64),
    "mfa_secret_enc" VARCHAR(512),
    "remark" VARCHAR(256),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" VARCHAR(48) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(256),
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(96) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "domain" VARCHAR(32) NOT NULL,
    "resource" VARCHAR(32) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "description" VARCHAR(256),
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_user_roles" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by_admin_id" UUID,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID,
    "admin_username" VARCHAR(48) NOT NULL,
    "action" "admin_audit_action" NOT NULL,
    "resource_type" VARCHAR(48) NOT NULL,
    "resource_id" UUID,
    "target_user_id" UUID,
    "before_data" JSONB,
    "after_data" JSONB,
    "diff_summary" VARCHAR(1024),
    "reason" VARCHAR(256),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(256),
    "request_id" VARCHAR(64),
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error_code" VARCHAR(32),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "template_id" VARCHAR(64),
    "title" VARCHAR(128),
    "content" VARCHAR(1024),
    "page_path" VARCHAR(256),
    "payload" JSONB,
    "outbox_event_id" UUID,
    "idempotency_key" VARCHAR(128),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    "fail_reason" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "share_channel" NOT NULL,
    "scene" VARCHAR(64) NOT NULL,
    "target_type" "share_target_type" NOT NULL,
    "target_id" UUID,
    "invite_id" UUID,
    "page_path" VARCHAR(256),
    "poster_url" VARCHAR(512),
    "click_count" INTEGER NOT NULL DEFAULT 0,
    "new_user_count" INTEGER NOT NULL DEFAULT 0,
    "converted_count" INTEGER NOT NULL DEFAULT 0,
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "share_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_configs" (
    "id" UUID NOT NULL,
    "key" VARCHAR(96) NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "config_value_type" NOT NULL DEFAULT 'STRING',
    "group" VARCHAR(48) NOT NULL,
    "description" VARCHAR(512),
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "is_editable" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_admin_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "system_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "aggregate_type" VARCHAR(48) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" VARCHAR(128) NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 5,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" VARCHAR(64),
    "last_error" VARCHAR(1024),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_hash_key" ON "users"("phone_hash");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at" DESC);

-- CreateIndex
CREATE INDEX "users_status_created_at_idx" ON "users"("status", "created_at");

-- CreateIndex
CREATE INDEX "users_inviter_user_id_idx" ON "users"("inviter_user_id");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "wechat_accounts_user_id_key" ON "wechat_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wechat_accounts_openid_key" ON "wechat_accounts"("openid");

-- CreateIndex
CREATE UNIQUE INDEX "wechat_accounts_unionid_key" ON "wechat_accounts"("unionid");

-- CreateIndex
CREATE INDEX "wechat_accounts_unionid_idx" ON "wechat_accounts"("unionid");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_jti_key" ON "user_sessions"("jti");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_refresh_token_hash_key" ON "user_sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_replaced_by_id_key" ON "user_sessions"("replaced_by_id");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_expires_at_idx" ON "user_sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "user_consents_user_id_type_idx" ON "user_consents"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "user_consents_user_id_type_policy_version_key" ON "user_consents"("user_id", "type", "policy_version");

-- CreateIndex
CREATE INDEX "user_deletion_requests_status_scheduled_at_idx" ON "user_deletion_requests"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "user_deletion_requests_user_id_status_idx" ON "user_deletion_requests"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "test_definitions_code_key" ON "test_definitions"("code");

-- CreateIndex
CREATE INDEX "test_definitions_category_is_active_idx" ON "test_definitions"("category", "is_active");

-- CreateIndex
CREATE INDEX "test_definitions_is_active_sort_order_idx" ON "test_definitions"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "questions_code_key" ON "questions"("code");

-- CreateIndex
CREATE INDEX "questions_test_definition_id_order_idx" ON "questions"("test_definition_id", "order");

-- CreateIndex
CREATE INDEX "questions_dimension_is_active_idx" ON "questions"("dimension", "is_active");

-- CreateIndex
CREATE INDEX "questions_is_active_idx" ON "questions"("is_active");

-- CreateIndex
CREATE INDEX "question_options_question_id_idx" ON "question_options"("question_id");

-- CreateIndex
CREATE UNIQUE INDEX "question_options_question_id_order_key" ON "question_options"("question_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "test_sessions_idempotency_key_key" ON "test_sessions"("idempotency_key");

-- CreateIndex
CREATE INDEX "test_sessions_user_id_status_idx" ON "test_sessions"("user_id", "status");

-- CreateIndex
CREATE INDEX "test_sessions_created_at_idx" ON "test_sessions"("created_at" DESC);

-- CreateIndex
CREATE INDEX "test_sessions_test_definition_id_status_idx" ON "test_sessions"("test_definition_id", "status");

-- CreateIndex
CREATE INDEX "test_sessions_status_expired_at_idx" ON "test_sessions"("status", "expired_at");

-- CreateIndex
CREATE INDEX "test_answers_user_id_answered_at_idx" ON "test_answers"("user_id", "answered_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "test_answers_session_id_question_id_key" ON "test_answers"("session_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_results_session_id_key" ON "test_results"("session_id");

-- CreateIndex
CREATE INDEX "test_results_user_id_computed_at_idx" ON "test_results"("user_id", "computed_at" DESC);

-- CreateIndex
CREATE INDEX "test_results_mbti_type_idx" ON "test_results"("mbti_type");

-- CreateIndex
CREATE INDEX "personality_profiles_user_id_is_current_idx" ON "personality_profiles"("user_id", "is_current");

-- CreateIndex
CREATE INDEX "personality_profiles_mbti_type_idx" ON "personality_profiles"("mbti_type");

-- CreateIndex
CREATE UNIQUE INDEX "personality_profiles_user_id_version_key" ON "personality_profiles"("user_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "personality_snapshots_source_session_id_key" ON "personality_snapshots"("source_session_id");

-- CreateIndex
CREATE INDEX "personality_snapshots_user_id_captured_at_idx" ON "personality_snapshots"("user_id", "captured_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "relationship_style_rules_code_key" ON "relationship_style_rules"("code");

-- CreateIndex
CREATE INDEX "relationship_style_rules_is_active_priority_idx" ON "relationship_style_rules"("is_active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_key_key" ON "prompt_templates"("key");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_active_version_id_key" ON "prompt_templates"("active_version_id");

-- CreateIndex
CREATE INDEX "prompt_templates_type_is_active_idx" ON "prompt_templates"("type", "is_active");

-- CreateIndex
CREATE INDEX "prompt_versions_status_idx" ON "prompt_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_template_id_version_key" ON "prompt_versions"("template_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ai_task_routings_task_type_key" ON "ai_task_routings"("task_type");

-- CreateIndex
CREATE INDEX "ai_task_routings_is_active_idx" ON "ai_task_routings"("is_active");

-- CreateIndex
CREATE INDEX "ai_conversations_user_id_status_last_message_at_idx" ON "ai_conversations"("user_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "ai_conversations_last_message_at_idx" ON "ai_conversations"("last_message_at" DESC);

-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_created_at_idx" ON "ai_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_messages_user_id_created_at_idx" ON "ai_messages"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ai_messages_conversation_id_client_message_id_key" ON "ai_messages"("conversation_id", "client_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_reports_cache_key_key" ON "ai_reports"("cache_key");

-- CreateIndex
CREATE INDEX "ai_reports_user_id_type_status_idx" ON "ai_reports"("user_id", "type", "status");

-- CreateIndex
CREATE INDEX "ai_reports_status_created_at_idx" ON "ai_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "ai_reports_user_id_created_at_idx" ON "ai_reports"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "report_sections_report_id_order_idx" ON "report_sections"("report_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "report_sections_report_id_section_key_key" ON "report_sections"("report_id", "section_key");

-- CreateIndex
CREATE INDEX "ai_usage_logs_usage_date_task_type_idx" ON "ai_usage_logs"("usage_date", "task_type");

-- CreateIndex
CREATE INDEX "ai_usage_logs_user_id_created_at_idx" ON "ai_usage_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_usage_logs_provider_usage_date_idx" ON "ai_usage_logs"("provider", "usage_date");

-- CreateIndex
CREATE INDEX "ai_call_audits_created_at_idx" ON "ai_call_audits"("created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_call_audits_task_type_status_created_at_idx" ON "ai_call_audits"("task_type", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_call_audits_provider_created_at_idx" ON "ai_call_audits"("provider", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_call_audits_user_id_created_at_idx" ON "ai_call_audits"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "relationships_pair_key_key" ON "relationships"("pair_key");

-- CreateIndex
CREATE INDEX "relationships_user_a_id_status_idx" ON "relationships"("user_a_id", "status");

-- CreateIndex
CREATE INDEX "relationships_user_b_id_status_idx" ON "relationships"("user_b_id", "status");

-- CreateIndex
CREATE INDEX "relationships_status_created_at_idx" ON "relationships"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "relationship_invites_code_key" ON "relationship_invites"("code");

-- CreateIndex
CREATE UNIQUE INDEX "relationship_invites_relationship_id_key" ON "relationship_invites"("relationship_id");

-- CreateIndex
CREATE INDEX "relationship_invites_inviter_id_status_idx" ON "relationship_invites"("inviter_id", "status");

-- CreateIndex
CREATE INDEX "relationship_invites_status_expires_at_idx" ON "relationship_invites"("status", "expires_at");

-- CreateIndex
CREATE INDEX "relationship_invites_invitee_id_idx" ON "relationship_invites"("invitee_id");

-- CreateIndex
CREATE UNIQUE INDEX "compatibility_reports_cache_key_key" ON "compatibility_reports"("cache_key");

-- CreateIndex
CREATE UNIQUE INDEX "compatibility_reports_ai_report_id_key" ON "compatibility_reports"("ai_report_id");

-- CreateIndex
CREATE INDEX "compatibility_reports_relationship_id_status_idx" ON "compatibility_reports"("relationship_id", "status");

-- CreateIndex
CREATE INDEX "compatibility_reports_relationship_id_created_at_idx" ON "compatibility_reports"("relationship_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "compatibility_reports_status_created_at_idx" ON "compatibility_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "compatibility_weights_is_active_idx" ON "compatibility_weights"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "compatibility_weights_code_version_key" ON "compatibility_weights"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "products_type_status_idx" ON "products"("type", "status");

-- CreateIndex
CREATE INDEX "products_status_sort_order_idx" ON "products"("status", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "membership_plans_code_key" ON "membership_plans"("code");

-- CreateIndex
CREATE INDEX "membership_plans_is_active_sort_order_idx" ON "membership_plans"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_no_key" ON "orders"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "orders_user_id_status_idx" ON "orders"("user_id", "status");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_expired_at_idx" ON "orders"("status", "expired_at");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_product_id_idx" ON "orders"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_out_trade_no_key" ON "payments"("out_trade_no");

-- CreateIndex
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "refunds_refund_no_key" ON "refunds"("refund_no");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_out_refund_no_key" ON "refunds"("out_refund_no");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_refund_id_key" ON "refunds"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_order_id_idx" ON "refunds"("order_id");

-- CreateIndex
CREATE INDEX "refunds_user_id_created_at_idx" ON "refunds"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "refunds_status_created_at_idx" ON "refunds"("status", "created_at");

-- CreateIndex
CREATE INDEX "memberships_user_id_status_idx" ON "memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "memberships_status_expire_at_idx" ON "memberships"("status", "expire_at");

-- CreateIndex
CREATE INDEX "memberships_order_id_idx" ON "memberships"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_idempotency_key_key" ON "entitlements"("idempotency_key");

-- CreateIndex
CREATE INDEX "entitlements_user_id_type_status_idx" ON "entitlements"("user_id", "type", "status");

-- CreateIndex
CREATE INDEX "entitlements_status_expire_at_idx" ON "entitlements"("status", "expire_at");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_user_id_type_resource_key_key" ON "entitlements"("user_id", "type", "resource_key");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE INDEX "admin_users_status_idx" ON "admin_users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE INDEX "roles_is_system_idx" ON "roles"("is_system");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "permissions_domain_resource_idx" ON "permissions"("domain", "resource");

-- CreateIndex
CREATE INDEX "admin_user_roles_role_id_idx" ON "admin_user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_user_roles_admin_user_id_role_id_key" ON "admin_user_roles"("admin_user_id", "role_id");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_user_id_created_at_idx" ON "admin_audit_logs"("admin_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_logs_resource_type_resource_id_idx" ON "admin_audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_created_at_idx" ON "admin_audit_logs"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_idempotency_key_key" ON "notifications"("idempotency_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_status_created_at_idx" ON "notifications"("user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at");

-- CreateIndex
CREATE INDEX "share_records_user_id_created_at_idx" ON "share_records"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "share_records_scene_created_at_idx" ON "share_records"("scene", "created_at");

-- CreateIndex
CREATE INDEX "share_records_channel_created_at_idx" ON "share_records"("channel", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "system_configs_key_key" ON "system_configs"("key");

-- CreateIndex
CREATE INDEX "system_configs_group_idx" ON "system_configs"("group");

-- CreateIndex
CREATE INDEX "system_configs_is_public_idx" ON "system_configs"("is_public");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_idempotency_key_key" ON "outbox_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "outbox_events_created_at_idx" ON "outbox_events"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_inviter_user_id_fkey" FOREIGN KEY ("inviter_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wechat_accounts" ADD CONSTRAINT "wechat_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "user_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_deletion_requests" ADD CONSTRAINT "user_deletion_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_deletion_requests" ADD CONSTRAINT "user_deletion_requests_operator_admin_id_fkey" FOREIGN KEY ("operator_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_definitions" ADD CONSTRAINT "test_definitions_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_test_definition_id_fkey" FOREIGN KEY ("test_definition_id") REFERENCES "test_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_sessions" ADD CONSTRAINT "test_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_sessions" ADD CONSTRAINT "test_sessions_test_definition_id_fkey" FOREIGN KEY ("test_definition_id") REFERENCES "test_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_answers" ADD CONSTRAINT "test_answers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_answers" ADD CONSTRAINT "test_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_answers" ADD CONSTRAINT "test_answers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_definition_id_fkey" FOREIGN KEY ("test_definition_id") REFERENCES "test_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personality_profiles" ADD CONSTRAINT "personality_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personality_profiles" ADD CONSTRAINT "personality_profiles_test_result_id_fkey" FOREIGN KEY ("test_result_id") REFERENCES "test_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personality_snapshots" ADD CONSTRAINT "personality_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personality_snapshots" ADD CONSTRAINT "personality_snapshots_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "personality_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personality_snapshots" ADD CONSTRAINT "personality_snapshots_source_session_id_fkey" FOREIGN KEY ("source_session_id") REFERENCES "test_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_style_rules" ADD CONSTRAINT "relationship_style_rules_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "prompt_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "prompt_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_task_routings" ADD CONSTRAINT "ai_task_routings_updated_by_admin_id_fkey" FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reports" ADD CONSTRAINT "ai_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reports" ADD CONSTRAINT "ai_reports_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "test_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reports" ADD CONSTRAINT "ai_reports_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reports" ADD CONSTRAINT "ai_reports_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "personality_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reports" ADD CONSTRAINT "ai_reports_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_sections" ADD CONSTRAINT "report_sections_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "ai_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "ai_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_call_audits" ADD CONSTRAINT "ai_call_audits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_call_audits" ADD CONSTRAINT "ai_call_audits_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "ai_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_confirmed_by_user_id_fkey" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_unbound_by_user_id_fkey" FOREIGN KEY ("unbound_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_invites" ADD CONSTRAINT "relationship_invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_invites" ADD CONSTRAINT "relationship_invites_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_invites" ADD CONSTRAINT "relationship_invites_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compatibility_reports" ADD CONSTRAINT "compatibility_reports_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compatibility_reports" ADD CONSTRAINT "compatibility_reports_profile_a_id_fkey" FOREIGN KEY ("profile_a_id") REFERENCES "personality_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compatibility_reports" ADD CONSTRAINT "compatibility_reports_profile_b_id_fkey" FOREIGN KEY ("profile_b_id") REFERENCES "personality_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compatibility_reports" ADD CONSTRAINT "compatibility_reports_weights_id_fkey" FOREIGN KEY ("weights_id") REFERENCES "compatibility_weights"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compatibility_reports" ADD CONSTRAINT "compatibility_reports_ai_report_id_fkey" FOREIGN KEY ("ai_report_id") REFERENCES "ai_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compatibility_reports" ADD CONSTRAINT "compatibility_reports_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compatibility_weights" ADD CONSTRAINT "compatibility_weights_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_membership_plan_id_fkey" FOREIGN KEY ("membership_plan_id") REFERENCES "membership_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_plans" ADD CONSTRAINT "membership_plans_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "membership_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_operator_admin_id_fkey" FOREIGN KEY ("operator_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_admin_id_fkey" FOREIGN KEY ("approved_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "membership_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_granted_by_admin_id_fkey" FOREIGN KEY ("granted_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "ai_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_granted_by_admin_id_fkey" FOREIGN KEY ("granted_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_granted_by_admin_id_fkey" FOREIGN KEY ("granted_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_records" ADD CONSTRAINT "share_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_records" ADD CONSTRAINT "share_records_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "relationship_invites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_configs" ADD CONSTRAINT "system_configs_updated_by_admin_id_fkey" FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
