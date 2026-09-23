import { HttpError, now } from './util.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';
}

/** Batasi jumlah percobaan per kunci dalam jendela waktu. Disimpan di D1. */
export async function limit(env, key, max, windowMs, message) {
  const t = now();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ? AND created_at > ?')
    .bind(key, t - windowMs).first();
  if (row.n >= max) {
    throw new HttpError(429, message || 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.', 'rate_limited');
  }
  await env.DB.prepare('INSERT INTO rate_limits (key, created_at) VALUES (?, ?)').bind(key, t).run();
}
