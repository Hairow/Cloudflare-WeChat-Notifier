-- ============================================================================
-- 迁移：从单 Bot 单例模式 → 多 Bot 支持
-- ============================================================================
-- 改动：
--   bot_state:   去掉 singleton_key，改以 bot_id 为主键，新增 label 字段
--   delivery_log: 新增 bot_id 字段，幂等键改为 bot_id + source + dedupe_key
-- ============================================================================

-- ---- 1. 重建 bot_state（单行 → 多行，用 bot_id 做 PK） ----
DROP TABLE IF EXISTS bot_state_new;
CREATE TABLE bot_state_new (
  bot_id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  bot_token_ciphertext TEXT NOT NULL,
  ilink_user_id_ciphertext TEXT NOT NULL,
  context_token_ciphertext TEXT,
  get_updates_buf_ciphertext TEXT,
  status TEXT NOT NULL CHECK (status IN ('logged_in', 'needs_activation', 'ready', 'needs_login', 'error')),
  last_error TEXT,
  updated_at TEXT NOT NULL
);

-- 迁移旧数据（如果存在），label 留空即可
INSERT INTO bot_state_new (
  bot_id,
  bot_token_ciphertext,
  ilink_user_id_ciphertext,
  context_token_ciphertext,
  get_updates_buf_ciphertext,
  status,
  last_error,
  updated_at
)
SELECT
  bot_id,
  bot_token_ciphertext,
  ilink_user_id_ciphertext,
  context_token_ciphertext,
  get_updates_buf_ciphertext,
  status,
  last_error,
  updated_at
FROM bot_state
WHERE singleton_key = 1;

DROP TABLE bot_state;
ALTER TABLE bot_state_new RENAME TO bot_state;

-- ---- 2. delivery_log：重建表，去掉 idempotency_key，新增 bot_id ----
-- D1/SQLite 不支持直接 DROP 带 UNIQUE 约束的列，故整体重建
DROP TABLE IF EXISTS delivery_log_new;
CREATE TABLE delivery_log_new (
  delivery_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  trace_id TEXT,
  dedupe_key TEXT,
  text TEXT NOT NULL,
  meta TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'retrying', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  response_code INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 迁移旧数据，idempotency_key 不再需要，bot_id 默认为空（无旧 bot_id 可关联）
-- 注意：旧表列名是 meta_json，新表改名为 meta
INSERT INTO delivery_log_new (
  delivery_id,
  source,
  trace_id,
  dedupe_key,
  text,
  meta,
  status,
  attempts,
  error,
  response_code,
  created_at,
  updated_at
)
SELECT
  delivery_id,
  source,
  trace_id,
  dedupe_key,
  text,
  meta_json,
  status,
  attempts,
  error,
  response_code,
  created_at,
  updated_at
FROM delivery_log;

DROP TABLE delivery_log;
ALTER TABLE delivery_log_new RENAME TO delivery_log;

-- 幂等键（bot_id + source + dedupe_key 联合唯一）
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_log_idempotency
  ON delivery_log(bot_id, source, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_log_created_at
  ON delivery_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_log_bot_id
  ON delivery_log(bot_id);
