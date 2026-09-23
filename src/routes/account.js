import { route, json, HttpError, readJson, now, uid, randomToken, sha256Hex, appOrigin, DAY } from '../lib/util.js';
import { createSession, grantFreeBonus, requireUser, currentSessionId } from '../lib/auth.js';
import { hashPassword, verifyPassword, burnTime, checkUsername, checkEmail, checkPassword } from '../lib/password.js';
import { sendEmail, verifyEmailTemplate, resetEmailTemplate, confirmEmailTemplate } from '../lib/email.js';
import { limit, clientIp, MIN, HOUR } from '../lib/ratelimit.js';

const VERIFY_TTL = DAY;
const RESET_TTL = HOUR;
const PENDING_TTL = 3 * DAY; // akun yang tidak diverifikasi dihapus setelah ini

function withCookie(body, cookie, status = 200) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (cookie) h.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers: h });
}

async function issueToken(env, userId, purpose, ttl, data = null) {
  const token = randomToken(32);
  const t = now();
  await env.DB.batch([
    // Link lama untuk tujuan yang sama tidak berlaku lagi
    env.DB.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(t, userId, purpose),
    env.DB.prepare('INSERT INTO auth_tokens (id, user_id, purpose, expires_at, created_at, data) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), userId, purpose, t + ttl, t, data),
  ]);
  return token;
}

async function findToken(env, token, purpose) {
  if (!token || token.length > 100) return null;
  return env.DB.prepare(
    `SELECT t.id AS token_id, t.data AS token_data, u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.id = ? AND t.purpose = ? AND t.used_at IS NULL AND t.expires_at > ?`
  ).bind(await sha256Hex(token), purpose, now()).first();
}

async function sendVerification(env, url, user) {
  const token = await issueToken(env, user.id, 'verify', VERIFY_TTL);
  const link = `${appOrigin(env, url)}/auth/verify?token=${encodeURIComponent(token)}`;
  await sendEmail(env, { to: user.email, ...verifyEmailTemplate({ username: user.username || user.name || 'pengguna', link }) });
}

/** Batas kirim email per alamat: 1 per menit, 5 per hari. */
async function mailLimits(env, email) {
  await limit(env, `mail1m:${email}`, 1, MIN, 'Tunggu 1 menit sebelum meminta email lagi.');
  await limit(env, `mail1d:${email}`, 5, DAY, 'Batas pengiriman email hari ini sudah tercapai. Coba lagi besok.');
}

export const accountRoutes = [
  // ---------- Cek ketersediaan username (untuk formulir daftar) ----------
  route('GET', '/auth/username-available', async ({ env, url }) => {
    const chk = checkUsername(url.searchParams.get('u'));
    if (chk.error) return json({ available: false, reason: chk.error });
    const row = await env.DB.prepare(
      'SELECT email_verified_at, google_sub, created_at FROM users WHERE username = ?'
    ).bind(chk.value).first();
    const taken = row && (row.email_verified_at || row.google_sub || row.created_at > now() - PENDING_TTL);
    return json({ available: !taken, reason: taken ? 'Username sudah dipakai.' : null });
  }),

  // ---------- Daftar ----------
  route('POST', '/auth/register', async ({ req, env, url }) => {
    const b = await readJson(req);

    const u = checkUsername(b.username);
    if (u.error) throw new HttpError(400, u.error, 'username');
    const e = checkEmail(b.email);
    if (e.error) throw new HttpError(400, e.error, 'email');
    const p = checkPassword(b.password, b.password_confirm);
    if (p.error) throw new HttpError(400, p.error, 'password');
    if (b.agree !== true) throw new HttpError(400, 'Centang persetujuan Syarat & Kebijakan Privasi untuk melanjutkan.', 'agree');
    // Dihitung setelah validasi, supaya salah ketik di formulir tidak membuat pengguna terblokir
    await limit(env, `reg:${clientIp(req)}`, 10, HOUR, 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi dalam 1 jam.');

    const db = env.DB;
    const t = now();

    // Email sudah dipakai akun aktif?
    const byEmail = await db.prepare('SELECT * FROM users WHERE email = ?').bind(e.value).first();
    if (byEmail && (byEmail.email_verified_at || byEmail.google_sub)) {
      throw new HttpError(409, 'Email ini sudah terdaftar. Silakan masuk, atau pakai Lupa password.', 'email_taken');
    }
    // Username sudah dipakai? (pendaftaran lama yang tak diverifikasi & kedaluwarsa boleh ditimpa)
    const byName = await db.prepare('SELECT * FROM users WHERE username = ?').bind(u.value).first();
    if (byName && byName.id !== byEmail?.id) {
      const stale = !byName.email_verified_at && !byName.google_sub && byName.created_at <= t - PENDING_TTL;
      if (!stale) throw new HttpError(409, 'Username sudah dipakai. Pilih yang lain.', 'username_taken');
      await db.batch([
        db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').bind(byName.id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(byName.id),
      ]);
    }
    // Pendaftaran sebelumnya dengan email ini belum diverifikasi: ganti dengan data baru
    if (byEmail) {
      await db.batch([
        db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').bind(byEmail.id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(byEmail.id),
      ]);
    }

    await mailLimits(env, e.value);
    const user = { id: uid('u_'), username: u.value, email: e.value };
    await db.prepare(
      `INSERT INTO users (id, username, email, password_hash, name, role, plan_id, char_balance, created_at)
       VALUES (?, ?, ?, ?, ?, 'user', 'free', 0, ?)`
    ).bind(user.id, user.username, user.email, await hashPassword(p.value), user.username, t).run();

    try {
      await sendVerification(env, url, user);
    } catch (err) {
      // Email gagal terkirim: batalkan pendaftaran supaya pengguna bisa langsung mencoba lagi
      await db.batch([
        db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').bind(user.id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
      ]);
      throw err;
    }
    return json({ ok: true, email: user.email }, 201);
  }),

  // ---------- Masuk dengan username/email + password ----------
  route('POST', '/auth/login', async ({ req, env }) => {
    const b = await readJson(req);
    const ident = String(b.identifier || '').trim().toLowerCase().slice(0, 254);
    const password = String(b.password || '');
    if (!ident || !password) throw new HttpError(400, 'Isi username/email dan password.');

    await limit(env, `login-ip:${clientIp(req)}`, 30, 15 * MIN);
    await limit(env, `login:${ident}`, 8, 15 * MIN, 'Terlalu banyak percobaan untuk akun ini. Tunggu 15 menit, atau pakai Lupa password.');

    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1').bind(ident, ident).first();
    const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : await burnTime(password);
    if (!ok) {
      if (user && !user.password_hash && user.google_sub && ident.includes('@')) {
        throw new HttpError(401, 'Akun ini terdaftar dengan Google. Gunakan tombol "Lanjutkan dengan Google", atau buat password lewat Lupa password.', 'google_account');
      }
      throw new HttpError(401, 'Username/email atau password salah.', 'bad_credentials');
    }
    if (user.status !== 'active') throw new HttpError(403, 'Akun ini dinonaktifkan. Hubungi admin Voice Promax.', 'banned');
    if (user.email && !user.email_verified_at) {
      return json({ error: { message: 'Email Anda belum diverifikasi. Buka link di email dari kami, atau kirim ulang.', code: 'unverified' }, email: user.email }, 403);
    }

    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), user.id).run();
    return withCookie({ ok: true }, await createSession(env, user.id));
  }),

  // ---------- Kirim ulang email verifikasi ----------
  route('POST', '/auth/resend-verification', async ({ req, env, url }) => {
    await limit(env, `resend-ip:${clientIp(req)}`, 10, HOUR);
    const e = checkEmail((await readJson(req)).email);
    if (e.error) throw new HttpError(400, e.error);
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE email = ? AND email_verified_at IS NULL AND password_hash IS NOT NULL'
    ).bind(e.value).first();
    if (user) {
      await mailLimits(env, e.value);
      await sendVerification(env, url, user);
    }
    // Jawaban selalu sama, supaya tidak bisa dipakai menebak email mana yang terdaftar
    return json({ ok: true });
  }),

  // ---------- Link verifikasi dari email ----------
  route('GET', '/auth/verify', async ({ env, url }) => {
    const user = await findToken(env, url.searchParams.get('token'), 'verify');
    if (!user) return Response.redirect(`${url.origin}/?verify_error=1`, 302);
    if (user.status !== 'active') return Response.redirect(`${url.origin}/?login_error=banned`, 302);

    // Token tidak langsung dihanguskan: pemindai tautan di beberapa layanan email membuka link
    // lebih dulu. Link tetap bisa diklik pemiliknya sampai kedaluwarsa (24 jam).
    await env.DB.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), last_login_at = ? WHERE id = ?')
      .bind(now(), now(), user.id).run();
    const fresh = await grantFreeBonus(env, user.id);

    const h = new Headers({ Location: `${url.origin}/app?${fresh ? 'welcome=1' : 'verified=1'}`, 'cache-control': 'no-store' });
    h.append('Set-Cookie', await createSession(env, user.id));
    return new Response(null, { status: 302, headers: h });
  }),

  // ---------- Lupa password ----------
  route('POST', '/auth/forgot', async ({ req, env, url }) => {
    await limit(env, `forgot-ip:${clientIp(req)}`, 10, HOUR);
    const e = checkEmail((await readJson(req)).email);
    if (e.error) throw new HttpError(400, e.error);
    const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ? AND email_verified_at IS NOT NULL AND status = 'active'`).bind(e.value).first();
    if (user) {
      await mailLimits(env, e.value);
      const token = await issueToken(env, user.id, 'reset', RESET_TTL);
      const link = `${appOrigin(env, url)}/?reset=${encodeURIComponent(token)}`;
      await sendEmail(env, { to: user.email, ...resetEmailTemplate({ name: user.username || user.name || 'pengguna', link }) });
    }
    return json({ ok: true });
  }),

  // ---------- Simpan password baru ----------
  route('POST', '/auth/reset', async ({ req, env }) => {
    await limit(env, `reset-ip:${clientIp(req)}`, 20, HOUR);
    const b = await readJson(req);
    const p = checkPassword(b.password, b.password_confirm);
    if (p.error) throw new HttpError(400, p.error, 'password');
    const user = await findToken(env, String(b.token || ''), 'reset');
    if (!user) throw new HttpError(400, 'Link sudah tidak berlaku. Minta link baru lewat Lupa password.', 'bad_token');
    if (user.status !== 'active') throw new HttpError(403, 'Akun ini dinonaktifkan. Hubungi admin Voice Promax.', 'banned');

    const t = now();
    await env.DB.batch([
      env.DB.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ?').bind(t, user.token_id),
      // Membuka link di email juga membuktikan kepemilikan email
      env.DB.prepare('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), last_login_at = ? WHERE id = ?')
        .bind(await hashPassword(p.value), t, t, user.id),
      // Keluarkan semua perangkat lain
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ]);
    await grantFreeBonus(env, user.id);
    return withCookie({ ok: true, username: user.username }, await createSession(env, user.id));
  }),

  // ================= Halaman Akun (butuh login) =================
  route('GET', '/api/account', async (c) => {
    const u = await requireUser(c);
    const pending = await c.env.DB.prepare(
      `SELECT data, created_at FROM auth_tokens WHERE user_id = ? AND purpose = 'email_change' AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    ).bind(u.id, now()).first();
    return json({
      account: {
        username: u.username, email: u.email, email_verified: !!u.email_verified_at, name: u.name,
        has_password: !!u.password_hash, google: !!u.google_sub, created_at: u.created_at,
        pending_email: pending?.data || null,
      },
    });
  }),

  // Sambungkan atau ganti email: kirim link konfirmasi ke alamat baru
  route('POST', '/api/account/email', async (c) => {
    const { env, url } = c;
    const u = await requireUser(c);
    const e = checkEmail((await readJson(c.req)).email);
    if (e.error) throw new HttpError(400, e.error, 'email');
    if (u.google_sub && u.email && e.value !== u.email) {
      throw new HttpError(400, 'Akun ini masuk lewat Google, jadi emailnya mengikuti akun Google tersebut.', 'google_email');
    }
    if (e.value === u.email && u.email_verified_at) throw new HttpError(400, 'Email ini sudah tersambung ke akunmu.', 'same_email');
    const lain = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(e.value, u.id).first();
    if (lain) throw new HttpError(409, 'Email ini sudah dipakai akun lain.', 'email_taken');

    await limit(env, `email-change:${u.id}`, 5, DAY, 'Batas penggantian email hari ini sudah tercapai. Coba lagi besok.');
    await mailLimits(env, e.value);
    const token = await issueToken(env, u.id, 'email_change', VERIFY_TTL, e.value);
    const link = `${appOrigin(env, url)}/auth/confirm-email?token=${encodeURIComponent(token)}`;
    await sendEmail(env, { to: e.value, ...confirmEmailTemplate({ name: u.username || u.name || 'pengguna', link }) });
    return json({ ok: true, pending_email: e.value });
  }),

  route('GET', '/auth/confirm-email', async ({ env, url }) => {
    const row = await findToken(env, url.searchParams.get('token'), 'email_change');
    if (!row || !row.token_data) return Response.redirect(`${url.origin}/app?tab=akun&email=gagal`, 302);
    const email = row.token_data;
    const lain = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(email, row.id).first();
    if (lain) return Response.redirect(`${url.origin}/app?tab=akun&email=dipakai`, 302);
    const t = now();
    await env.DB.batch([
      env.DB.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(t, row.id, 'email_change'),
      env.DB.prepare('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?').bind(email, t, row.id),
    ]);
    return Response.redirect(`${url.origin}/app?tab=akun&email=ok`, 302);
  }),

  // Ganti password (atau buat password untuk akun yang belum punya)
  route('POST', '/api/account/password', async (c) => {
    const { env, req } = c;
    const u = await requireUser(c);
    const b = await readJson(req);
    await limit(env, `pw-change:${u.id}`, 10, HOUR);
    if (u.password_hash) {
      const ok = await verifyPassword(String(b.current_password || ''), u.password_hash);
      if (!ok) throw new HttpError(400, 'Password saat ini salah.', 'current_password');
    }
    const p = checkPassword(b.password, b.password_confirm);
    if (p.error) throw new HttpError(400, p.error, 'password');
    const sesiIni = await currentSessionId(req);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(p.value), u.id),
      // Perangkat lain dikeluarkan, perangkat ini tetap masuk
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(u.id, sesiIni || ''),
    ]);
    return json({ ok: true });
  }),
];
