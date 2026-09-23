-- Voice Promax: akun boleh tanpa email (dibuat manual oleh admin dengan username + password),
-- dan pengguna bisa menyambungkan/mengganti email lewat link konfirmasi.
-- Jalankan SETELAH 0002, hanya untuk database yang dibuat sebelum versi ini:
--   npx wrangler d1 execute voicepromax-db --remote --file=./migrations/0003_akun_tanpa_email.sql

CREATE TABLE users_baru (
  id                TEXT PRIMARY KEY,
  google_sub        TEXT UNIQUE,
  username          TEXT UNIQUE,
  email             TEXT UNIQUE,
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
INSERT INTO users_baru SELECT id, google_sub, username, email, password_hash, email_verified_at, free_bonus_at,
  name, avatar, phone, role, status, plan_id, char_balance, plan_expires_at, created_at, last_login_at FROM users;
DROP TABLE users;
ALTER TABLE users_baru RENAME TO users;

ALTER TABLE auth_tokens ADD COLUMN data TEXT;
