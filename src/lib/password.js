// Hash password dengan PBKDF2-SHA256 (WebCrypto bawaan Workers, tanpa library).
// 100.000 iterasi adalah batas maksimum yang diizinkan Workers.
const ITER = 100_000;
const enc = new TextEncoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, ITER);
  return `pbkdf2$${ITER}$${toB64(salt)}$${toB64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [algo, iter, salt, hash] = String(stored || '').split('$');
  if (algo !== 'pbkdf2' || !iter || !salt || !hash) return false;
  const bits = new Uint8Array(await derive(password, fromB64(salt), Number(iter)));
  const expected = fromB64(hash);
  if (bits.length !== expected.length) return false;
  return crypto.subtle.timingSafeEqual(bits, expected);
}

// Dipakai saat akun tidak ditemukan, supaya waktu respons sama dan
// penyerang tidak bisa menebak username mana yang terdaftar dari lamanya jawaban.
let dummy;
export async function burnTime(password) {
  dummy ||= await hashPassword('voicepromax-dummy-password');
  await verifyPassword(password, dummy);
  return false;
}

export const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'support', 'bantuan', 'cs', 'official', 'voicepromax',
  'system', 'sistem', 'api', 'auth', 'app', 'dashboard', 'billing', 'mayar', 'null', 'undefined',
]);

export function checkUsername(raw) {
  const u = String(raw || '').trim().toLowerCase();
  if (u.length < 3 || u.length > 20) return { error: 'Username harus 3 sampai 20 karakter.' };
  if (!/^[a-z][a-z0-9._]*$/.test(u)) return { error: 'Username diawali huruf, lalu hanya huruf kecil, angka, titik, atau garis bawah.' };
  if (/[._]{2}/.test(u) || /[._]$/.test(u)) return { error: 'Titik atau garis bawah tidak boleh berurutan atau di akhir username.' };
  if (RESERVED_USERNAMES.has(u)) return { error: 'Username ini tidak bisa dipakai. Pilih yang lain.' };
  return { value: u };
}

export function checkEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return { error: 'Alamat email tidak valid.' };
  return { value: e };
}

export function checkPassword(pw, confirm) {
  const p = String(pw || '');
  if (p.length < 8) return { error: 'Password minimal 8 karakter.' };
  if (p.length > 128) return { error: 'Password maksimal 128 karakter.' };
  if (!/[a-zA-Z]/.test(p) || !/\d/.test(p)) return { error: 'Password harus berisi huruf dan angka.' };
  if (confirm !== undefined && p !== String(confirm || '')) return { error: 'Ulangi password belum sama dengan password.' };
  return { value: p };
}
