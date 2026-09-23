import {
  HttpError, DAY, now, uid, randomToken, sha256Hex, parseCookies, serializeCookie,
} from './util.js';

const SESSION_COOKIE = 'vc_session';
const STATE_COOKIE = 'vc_oauth';
const SESSION_TTL = 30 * DAY;

function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/app';
}

function redirect(location, cookies = []) {
  const h = new Headers({ Location: location, 'cache-control': 'no-store' });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
}

export async function handleAuth(req, env, url) {
  const redirectUri = `${url.origin}/auth/google/callback`;

  // 1) Arahkan ke halaman login Google
  if (url.pathname === '/auth/google' && req.method === 'GET') {
    const state = randomToken(16);
    const next = safeNext(url.searchParams.get('next'));
    const g = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    g.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    }).toString();
    return redirect(g.toString(), [serializeCookie(STATE_COOKIE, `${state}|${next}`, { maxAge: 600 })]);
  }

  // 2) Google mengembalikan code → tukar token → ambil profil → buat sesi
  if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
    const clearState = serializeCookie(STATE_COOKIE, '', { maxAge: 0 });
    const fail = (reason = '1') => redirect(`${url.origin}/?login_error=${reason}`, [clearState]);

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const saved = parseCookies(req)[STATE_COOKIE] || '';
    const sep = saved.indexOf('|');
    const savedState = sep > 0 ? saved.slice(0, sep) : '';
    const savedNext = sep > 0 ? saved.slice(sep + 1) : '/app';
    if (url.searchParams.get('error') || !code || !state || !savedState || state !== savedState) return fail();

    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokRes.ok) {
      console.error('google token error', tokRes.status, await tokRes.text());
      return fail();
    }
    const tok = await tokRes.json();

    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!infoRes.ok) return fail();
    const info = await infoRes.json();
    if (!info.sub || !info.email || info.email_verified === false) return fail('email');

    const user = await upsertUser(env, info);
    if (user.status !== 'active') return fail('banned');

    return redirect(`${url.origin}${safeNext(savedNext)}`, [clearState, await createSession(env, user.id)]);
  }

  // 3) Keluar
  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
    const h = new Headers({ 'content-type': 'application/json' });
    h.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
    return new Response('{"ok":true}', { headers: h });
  }

  throw new HttpError(404, 'Halaman tidak ditemukan.');
}

async function upsertUser(env, info) {
  const email = info.email.toLowerCase();
  const t = now();
  const makeAdmin = adminEmails(env).includes(email);

  let user = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(info.sub).first();
  if (!user) {
    user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (user) {
      // Akun dengan email sama sudah ada (daftar lewat password, atau ID Google berubah): tautkan.
      // Kalau emailnya BELUM diverifikasi, password lama dihapus. Tanpa ini, orang lain bisa
      // mendaftarkan email Anda lebih dulu dengan password buatannya, lalu ikut masuk ke akun
      // yang Anda buka lewat Google.
      const unverified = !user.email_verified_at;
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE users SET google_sub = ?, email_verified_at = COALESCE(email_verified_at, ?),
             password_hash = CASE WHEN ? = 1 THEN NULL ELSE password_hash END WHERE id = ?`
        ).bind(info.sub, t, unverified ? 1 : 0, user.id),
        ...(unverified ? [env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id)] : []),
      ]);
    }
  }

  if (user) {
    await env.DB.prepare(
      `UPDATE users SET email = ?, name = COALESCE(?, name), avatar = COALESCE(?, avatar), last_login_at = ?,
         role = CASE WHEN ? = 1 THEN 'admin' ELSE role END
       WHERE id = ?`
    ).bind(email, info.name || null, info.picture || null, t, makeAdmin ? 1 : 0, user.id).run();
    await grantFreeBonus(env, user.id);
    return { ...user, role: makeAdmin ? 'admin' : user.role };
  }

  const id = uid('u_');
  await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, email_verified_at, name, avatar, role, plan_id, char_balance, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'free', 0, ?, ?)`
  ).bind(id, info.sub, email, t, info.name || null, info.picture || null, makeAdmin ? 'admin' : 'user', t, t).run();
  await grantFreeBonus(env, id);
  return { id, status: 'active', role: makeAdmin ? 'admin' : 'user' };
}

/** Kuota paket Free diberikan sekali per akun, setelah email terbukti milik pengguna. */
export async function grantFreeBonus(env, userId) {
  const free = await env.DB.prepare(`SELECT char_quota FROM plans WHERE id = 'free'`).first();
  const bonus = free?.char_quota ?? 10000;
  const t = now();
  const r = await env.DB.prepare(
    'UPDATE users SET char_balance = char_balance + ?, free_bonus_at = ? WHERE id = ? AND free_bonus_at IS NULL'
  ).bind(bonus, t, userId).run();
  if (r.meta.changes) {
    await env.DB.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'signup_bonus', 'free', ?)`)
      .bind(userId, bonus, t).run();
  }
  return !!r.meta.changes;
}

/** Buat sesi baru dan kembalikan header Set-Cookie-nya. */
export async function createSession(env, userId) {
  const token = randomToken(32);
  const t = now();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, t + SESSION_TTL, t).run();
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL / 1000 });
}

/** Hash ID sesi yang sedang dipakai (untuk mengeluarkan perangkat lain saja). */
export async function currentSessionId(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  return token ? sha256Hex(token) : null;
}

export const AUTH_PATHS = new Set(['/auth/google', '/auth/google/callback', '/auth/logout']);

/** Mengembalikan user dari cookie sesi, sekaligus menurunkan paket yang sudah kedaluwarsa. */
export async function getUser(req, env) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const t = now();
  let u = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`
  ).bind(await sha256Hex(token), t).first();
  if (!u) return null;

  if (u.plan_id !== 'free' && u.plan_expires_at && u.plan_expires_at < t) {
    const r = await env.DB.prepare(
      `UPDATE users SET plan_id = 'free', char_balance = 0, plan_expires_at = NULL WHERE id = ? AND plan_expires_at < ?`
    ).bind(u.id, t).run();
    if (r.meta.changes) {
      await env.DB.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'plan_expired', ?, ?)`)
        .bind(u.id, -u.char_balance, u.plan_id, t).run();
    }
    u = { ...u, plan_id: 'free', char_balance: 0, plan_expires_at: null };
  }
  return u;
}

export async function requireUser({ req, env }) {
  const u = await getUser(req, env);
  if (!u) throw new HttpError(401, 'Silakan masuk dengan Google terlebih dahulu.', 'unauthenticated');
  if (u.status !== 'active') throw new HttpError(403, 'Akun ini dinonaktifkan. Hubungi admin Voice Promax.', 'banned');
  return u;
}

export async function requireAdmin(ctx) {
  const u = await requireUser(ctx);
  if (u.role !== 'admin') throw new HttpError(403, 'Halaman ini khusus admin.', 'forbidden');
  return u;
}
