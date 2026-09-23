export class HttpError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data; // info tambahan untuk frontend, mis. { field: 'email' }
  }
}

export const DAY = 86_400_000;
export const now = () => Date.now();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function uid(prefix = '') {
  return prefix + crypto.randomUUID().replace(/-/g, '');
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}

export async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.get('cookie');
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* abaikan cookie rusak */
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'Format data tidak valid.');
  }
}

/** Karakter yang dihitung kuota: semua teks kecuali tag gaya seperti <|prosody:pause|>. */
export function countChars(text) {
  return [...String(text).replace(/<\|[^|]*\|>/g, '')].length;
}

export function parseFeatures(s) {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

export function appOrigin(env, url) {
  return (env.APP_URL || url.origin).replace(/\/+$/, '');
}

export function toInt(v, { min = -Infinity, max = Infinity, fallback = null } = {}) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function compile(path) {
  const keys = [];
  const re = new RegExp(
    '^' + path.replace(/:[a-zA-Z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$'
  );
  return { re, keys };
}

export const route = (method, path, handler) => ({ method, ...compile(path), handler });

/* ---------- Password (PBKDF2-SHA256; 100.000 iterasi = batas maksimal di Workers) ---------- */
const PBKDF2_ITER = 100_000;
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !salt || !hash) return false;
  const got = await pbkdf2(password, unb64(salt), Number(iter));
  const want = unb64(hash);
  return got.length === want.length && crypto.subtle.timingSafeEqual(got, want);
}

// Dipakai saat akun tidak ditemukan, supaya waktu respons sama dan tidak membocorkan apakah akun ada.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ||= await hashPassword('voicepromax-dummy-password');
  await verifyPassword(password, dummyHash);
  return false;
}

/* ---------- Pembatas percobaan (disimpan di D1) ---------- */
export function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || 'local';
}

export async function rateLimit(env, key, limit, windowSec) {
  const t = Date.now();
  const bucket = Math.floor(t / (windowSec * 1000));
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, bucket, count, expires_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(key, bucket) DO UPDATE SET count = count + 1 RETURNING count`
  ).bind(key, bucket, (bucket + 1) * windowSec * 1000).first();
  if (row.count > limit) {
    const wait = Math.ceil(((bucket + 1) * windowSec * 1000 - t) / 60000);
    throw new HttpError(429, `Terlalu banyak percobaan. Coba lagi dalam ${wait} menit.`, 'rate_limited');
  }
}
