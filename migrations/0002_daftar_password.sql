-- Voice Promax: tambah daftar dengan username + password dan verifikasi email.
-- HANYA untuk database yang sudah dibuat dengan schema.sql versi lama (login Google saja).
-- Database baru cukup memakai schema.sql terbaru.
--   npx wrangler d1 execute voicepromax-db --remote --file=./migrations/0002_daftar_password.sql

CREATE TABLE users_baru (
  id                TEXT PRIMARY KEY,
  google_sub        TEXT UNIQUE,
  username          TEXT UNIQUE,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT,
  email_verified_at INTEGER,
  free_bonus_at     INTEGER,
  name              TEXT,
  avatar            TEXT,
  phone             TEXT,
  role              TEXT NOT NULL DEFAULT 'user',
  status            TEXT NOT NULL DEFAULT 'active',
  plan_id           TEXT NOT NULL DEFAULT 'free',
  char_balance      INTEGER NOT NULL DEFAULT 0,
  plan_expires_at   INTEGER,
  created_at        INTEGER NOT NULL,
  last_login_at     INTEGER
);

-- Pengguna lama semuanya masuk lewat Google: email sudah terverifikasi dan bonus sudah diterima.
INSERT INTO users_baru (id, google_sub, email, email_verified_at, free_bonus_at, name, avatar, phone, role,
                        status, plan_id, char_balance, plan_expires_at, created_at, last_login_at)
SELECT id, google_sub, email, created_at, created_at, name, avatar, phone, role,
       status, plan_id, char_balance, plan_expires_at, created_at, last_login_at
FROM users;

DROP TABLE users;
ALTER TABLE users_baru RENAME TO users;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(user_id, purpose);

CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_key ON rate_limits(key, created_at);
