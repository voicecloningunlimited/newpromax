import {
  HttpError, json, now, uid, DAY, randomToken, sha256Hex, readJson, appOrigin,
  hashPassword, verifyPassword, burnPasswordCheck, rateLimit, clientIp,
} from './util.js';
import { createSessionCookie, markVerified, adminEmails } from './session.js';
import { sendEmail, verifyEmailContent, resetPasswordContent } from './email.js';

const VERIFY_TTL = DAY;
const RESET_TTL = 3_600_000;
const RESEND_COOLDOWN = 60_000;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.]{1,18}[a-z0-9]$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'support', 'help', 'voicepromax', 'system', 'api', 'app',
  'dashboard', 'studio', 'billing', 'null', 'undefined', 'official', 'cs', 'moderator']);

const bad = (message, field, status = 400, code = 'invalid') => new HttpError(status, message, code, { field });

export function checkEmail(v) {
  const email = String(v || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('Masukkan alamat email yang valid.', 'email');
  return email;
}

function checkUsername(v) {
  const u = String(v || '').trim().toLowerCase();
  if (u.length < 3 || u.length > 20) throw bad('Username harus 3 sampai 20 karakter.', 'username');
  if (!USERNAME_RE.test(u) || u.includes('..')) {
    throw bad('Username hanya boleh huruf kecil, angka, titik, dan garis bawah, dan tidak diawali atau diakhiri titik.', 'username');
  }
  if (/^\d+$/.test(u)) throw bad('Username tidak boleh hanya angka.', 'username');
  if (RESERVED.has(u)) throw bad('Username ini tidak bisa dipakai. Coba yang lain.', 'username');
  return u;
}

function checkPassword(pw, confirm) {
  const p = String(pw || '');
  if (p.length < 8) throw bad('Password minimal 8 karakter.', 'password');
  if (p.length > 128) throw bad('Password maksimal 128 karakter.', 'password');
  if (!/[a-zA-Z]/.test(p) || !/\d/.test(p)) throw bad('Password harus berisi huruf dan angka.', 'password');
  if (p !== String(confirm ?? '')) throw bad('Ulangi password tidak sama dengan password.', 'password_confirm');
  return p;
}

async function issueToken(env, userId, purpose, ttl) {
  const t = now();
  const token = randomToken(32);
  await env.DB.batch([
    // Tautan lama untuk tujuan yang sama langsung tidak berlaku
    env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(t, userId, purpose),
    env.DB.prepare('INSERT INTO email_tokens (id, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), userId, purpose, t + ttl, t),
  ]);
  return token;
}

async function inCooldown(env, userId, purpose) {
  const last = await env.DB.prepare('SELECT created_at FROM email_tokens WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1')
    .bind(userId, purpose).first();
  return last && now() - last.created_at < RESEND_COOLDOWN;
}

async function sendVerification(env, url, user) {
  const token = await issueToken(env, user.id, 'verify', VERIFY_TTL);
  const link = `${appOrigin(env, url)}/auth/verify?token=${token}`;
  await sendEmail(env, { to: user.email, ...verifyEmailContent(user.username || user.name || 'di sana', link) });
}

async function sendReset(env, url, user) {
  const token = await issueToken(env, user.id, 'reset', RESET_TTL);
  const link = `${appOrigin(env, url)}/?reset=${token}`;
  await sendEmail(env, { to: user.email, ...resetPasswordContent(user.username || user.name || 'di sana', link) });
}

function withCookie(res, cookie) {
  res.headers.append('Set-Cookie', cookie);
  return res;
}

function redirect(location, cookie) {
  const h = new Headers({ Location: location, 'cache-control': 'no-store' });
  if (cookie) h.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers: h });
}

/* ================= Daftar ================= */
export async function register(req, env, url) {
  await rateLimit(env, `reg:ip:${clientIp(req)}`, 6, 3600);
  const b = await readJson(req);
  const email = checkEmail(b.email);
  const username = checkUsername(b.username);
  const password = checkPassword(b.password, b.password_confirm);
  const t = now();

  // Pendaftaran lama yang belum diverifikasi tidak boleh mengunci email/username selamanya
  const stale = `SELECT id FROM users WHERE email_verified_at IS NULL AND (email = ?1 OR (username = ?2 AND created_at < ?3))`;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM email_tokens WHERE user_id IN (${stale})`).bind(email, username, t - VERIFY_TTL),
    env.DB.prepare(`DELETE FROM users WHERE id IN (${stale})`).bind(email, username, t - VERIFY_TTL),
  ]);

  const byEmail = await env.DB.prepare('SELECT google_sub, password_hash FROM users WHERE email = ?').bind(email).first();
  if (byEmail) {
    throw bad(byEmail.google_sub && !byEmail.password_hash
      ? 'Email ini sudah terdaftar lewat Google. Silakan masuk dengan tombol Google.'
      : 'Email ini sudah terdaftar. Silakan masuk, atau pakai Lupa password.', 'email', 409, 'exists');
  }
  if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()) {
    throw bad('Username sudah dipakai. Coba yang lain.', 'username', 409, 'exists');
  }

  const user = { id: uid('u_'), email, username, name: username };
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, username, name, password_hash, role, plan_id, char_balance, created_at)
       VALUES (?, ?, ?, ?, ?, 'user', 'free', 0, ?)`
    ).bind(user.id, email, username, username, await hashPassword(password), t).run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw bad('Email atau username baru saja dipakai. Coba lagi.', 'username', 409, 'exists');
    throw e;
  }

  await sendVerification(env, url, user);
  return json({ ok: true, email });
}

/* ================= Tautan verifikasi dari email ================= */
export async function verify(req, env, url) {
  const token = url.searchParams.get('token') || '';
  const back = (why) => redirect(`${url.origin}/?verify=${why}`);
  if (!token) return back('invalid');

  const row = await env.DB.prepare(`SELECT * FROM email_tokens WHERE id = ? AND purpose = 'verify'`).bind(await sha256Hex(token)).first();
  if (!row) return back('invalid');
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
  if (!user) return back('invalid');
  if (user.email_verified_at) return back('done');
  if (row.used_at) return back('invalid');
  if (row.expires_at < now()) return back('expired');

  const used = await env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now(), row.id).run();
  if (!used.meta.changes) return back('done');
  await markVerified(env, user);
  if (user.status !== 'active') return redirect(`${url.origin}/?login_error=banned`);

  return redirect(`${url.origin}/app?welcome=1`, await createSessionCookie(env, user.id));
}

/* ================= Masuk dengan username/email + password ================= */
export async function login(req, env) {
  await rateLimit(env, `login:ip:${clientIp(req)}`, 20, 900);
  const b = await readJson(req);
  const id = String(b.login || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!id || !password) throw bad('Isi username atau email, dan password.', id ? 'password' : 'login');
  await rateLimit(env, `login:id:${id}`, 8, 900);

  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?1 OR email = ?1 LIMIT 1').bind(id).first();
  const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : await burnPasswordCheck(password);

  if (!ok) {
    if (user && !user.password_hash && user.google_sub && id.includes('@')) {
      throw bad('Akun ini dibuat lewat Google. Masuk dengan tombol Google, atau buat password lewat Lupa password.', 'login', 401, 'google_only');
    }
    throw bad('Username/email atau password salah.', 'password', 401, 'bad_credentials');
  }
  if (user.status !== 'active') throw new HttpError(403, 'Akun ini dinonaktifkan. Hubungi admin Voice Promax.', 'banned');
  if (!user.email_verified_at) {
    throw new HttpError(403, 'Email Anda belum diverifikasi. Klik tautan di email kami, atau kirim ulang tautannya.', 'unverified', { email: user.email });
  }

  const t = now();
  const makeAdmin = adminEmails(env).includes(user.email);
  await env.DB.prepare(`UPDATE users SET last_login_at = ?, role = CASE WHEN ? = 1 THEN 'admin' ELSE role END WHERE id = ?`)
    .bind(t, makeAdmin ? 1 : 0, user.id).run();
  return withCookie(json({ ok: true, redirect: '/app' }), await createSessionCookie(env, user.id));
}

/* ================= Kirim ulang verifikasi ================= */
export async function resend(req, env, url) {
  await rateLimit(env, `mail:ip:${clientIp(req)}`, 6, 3600);
  const email = checkEmail((await readJson(req)).email);
  await rateLimit(env, `mail:to:${email}`, 4, 3600);
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (user && !user.email_verified_at && user.status === 'active' && !(await inCooldown(env, user.id, 'verify'))) {
    try { await sendVerification(env, url, user); } catch (e) { console.error('kirim ulang gagal', e.message); }
  }
  // Jawaban selalu sama, supaya tidak bisa dipakai menebak email siapa yang terdaftar
  return json({ ok: true });
}

/* ================= Lupa password ================= */
export async function forgot(req, env, url) {
  await rateLimit(env, `mail:ip:${clientIp(req)}`, 6, 3600);
  const email = checkEmail((await readJson(req)).email);
  await rateLimit(env, `mail:to:${email}`, 4, 3600);
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (user && user.status === 'active' && !(await inCooldown(env, user.id, 'reset'))) {
    try { await sendReset(env, url, user); } catch (e) { console.error('email reset gagal', e.message); }
  }
  return json({ ok: true });
}

/* ================= Simpan password baru ================= */
export async function resetPassword(req, env) {
  await rateLimit(env, `reset:ip:${clientIp(req)}`, 10, 3600);
  const b = await readJson(req);
  const password = checkPassword(b.password, b.password_confirm);
  const row = await env.DB.prepare(`SELECT * FROM email_tokens WHERE id = ? AND purpose = 'reset'`)
    .bind(await sha256Hex(String(b.token || ''))).first();
  if (!row || row.used_at || row.expires_at < now()) {
    throw new HttpError(400, 'Tautan ini sudah tidak berlaku. Minta tautan baru lewat Lupa password.', 'token_invalid');
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
  if (!user) throw new HttpError(400, 'Akun tidak ditemukan.', 'token_invalid');
  if (user.status !== 'active') throw new HttpError(403, 'Akun ini dinonaktifkan. Hubungi admin Voice Promax.', 'banned');

  const used = await env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now(), row.id).run();
  if (!used.meta.changes) throw new HttpError(400, 'Tautan ini sudah dipakai. Minta tautan baru lewat Lupa password.', 'token_invalid');

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), user.id),
    // Semua perangkat yang sedang login dikeluarkan
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  // Membuka tautan dari email membuktikan kepemilikan email
  await markVerified(env, user);
  return withCookie(json({ ok: true, redirect: '/app' }), await createSessionCookie(env, user.id));
}
