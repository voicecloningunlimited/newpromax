-- Voice Promax: skema database Cloudflare D1
-- Jalankan: npx wrangler d1 execute voicepromax-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  price         INTEGER NOT NULL DEFAULT 0,      -- Rupiah
  char_quota    INTEGER NOT NULL,                -- kuota karakter
  duration_days INTEGER NOT NULL DEFAULT 30,     -- 0 = tidak kedaluwarsa
  max_voices    INTEGER,                         -- NULL = tanpa batas (kelebihan paket, bisa diatur nanti)
  features      TEXT NOT NULL DEFAULT '[]',      -- JSON array teks kelebihan paket
  is_active     INTEGER NOT NULL DEFAULT 1,
  is_featured   INTEGER NOT NULL DEFAULT 0,
  sort          INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  google_sub        TEXT UNIQUE,                   -- terisi jika pernah masuk dengan Google
  username          TEXT UNIQUE,                   -- terisi jika daftar dengan username + password (huruf kecil)
  email             TEXT UNIQUE,                   -- boleh kosong: akun manual dari admin (username + password)
  password_hash     TEXT,                          -- PBKDF2-SHA256; NULL untuk akun khusus Google
  email_verified_at INTEGER,                       -- NULL = belum verifikasi, tidak bisa masuk
  free_bonus_at     INTEGER,                       -- kapan kuota Free diberikan (sekali per akun)
  name              TEXT,
  avatar            TEXT,
  phone             TEXT,
  role              TEXT NOT NULL DEFAULT 'user',    -- user | admin
  status            TEXT NOT NULL DEFAULT 'active',  -- active | banned
  plan_id           TEXT NOT NULL DEFAULT 'free',
  char_balance      INTEGER NOT NULL DEFAULT 0,
  plan_expires_at   INTEGER,
  created_at        INTEGER NOT NULL,
  last_login_at     INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,   -- SHA-256 dari token cookie
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS voices (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  boson_voice_id TEXT NOT NULL,
  name           TEXT NOT NULL,
  ref_text       TEXT,
  sample_key     TEXT,
  sample_type    TEXT,
  created_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_voices_user ON voices(user_id, deleted_at);

CREATE TABLE IF NOT EXISTS generations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  voice_id     TEXT,
  voice_label  TEXT,
  text         TEXT NOT NULL,
  chars        INTEGER NOT NULL DEFAULT 0,
  audio_key    TEXT,
  content_type TEXT,
  status       TEXT NOT NULL,   -- done | failed
  error        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gen_user ON generations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gen_created ON generations(created_at);

CREATE TABLE IF NOT EXISTS payments (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  plan_id              TEXT NOT NULL,
  amount               INTEGER NOT NULL,
  char_quota           INTEGER NOT NULL,
  duration_days        INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending', -- pending | paid | expired | review
  mayar_invoice_id     TEXT,
  mayar_transaction_id TEXT,
  payment_url          TEXT,
  note                 TEXT,
  created_at           INTEGER NOT NULL,
  paid_at              INTEGER,
  updated_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pay_user ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pay_status ON payments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pay_invoice ON payments(mayar_invoice_id);
CREATE INDEX IF NOT EXISTS idx_pay_trx ON payments(mayar_transaction_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,   -- signup_bonus | purchase | tts | refund | plan_expired | admin_adjust
  ref        TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         TEXT PRIMARY KEY,   -- SHA-256 dari token di link email
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL,      -- verify | reset | email_change
  data       TEXT,               -- email_change: alamat email baru
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

-- Paket sesuai tabel harga. Kelebihan tiap paket menyusul (isi lewat halaman admin).
INSERT OR IGNORE INTO plans (id, name, price, char_quota, duration_days, is_featured, sort) VALUES
  ('free',    'Free',    0,      10000,  0,  0, 0),
  ('lite',    'Lite',    29000,  50000,  30, 0, 1),
  ('starter', 'Starter', 49000,  100000, 30, 0, 2),
  ('pro',     'Pro',     99000,  250000, 30, 1, 3),
  ('studio',  'Studio',  179000, 500000, 30, 0, 4);
