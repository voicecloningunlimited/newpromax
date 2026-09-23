import { DAY, now, randomToken, sha256Hex, serializeCookie } from './util.js';

export const SESSION_COOKIE = 'vc_session';
export const SESSION_TTL = 30 * DAY;

export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Buat sesi baru di D1 dan kembalikan header Set-Cookie-nya. */
export async function createSessionCookie(env, userId) {
  const token = randomToken(32);
  const t = now();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, t + SESSION_TTL, t).run();
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL / 1000 });
}

/**
 * Tandai email terverifikasi. Bonus kuota Free diberikan tepat sekali,
 * yaitu saat email_verified_at berubah dari kosong menjadi terisi.
 */
export async function markVerified(env, user) {
  const t = now();
  const free = await env.DB.prepare(`SELECT char_quota FROM plans WHERE id = 'free'`).first();
  const bonus = free?.char_quota ?? 10000;
  const makeAdmin = adminEmails(env).includes(String(user.email).toLowerCase());
  const r = await env.DB.prepare(
    `UPDATE users SET email_verified_at = ?, char_balance = char_balance + ?,
       role = CASE WHEN ? = 1 THEN 'admin' ELSE role END
     WHERE id = ? AND email_verified_at IS NULL`
  ).bind(t, bonus, makeAdmin ? 1 : 0, user.id).run();
  if (r.meta.changes) {
    await env.DB.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'signup_bonus', 'free', ?)`)
      .bind(user.id, bonus, t).run();
    return true;
  }
  return false;
}
