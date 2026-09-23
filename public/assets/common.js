export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error('Koneksi terputus. Periksa internet lalu coba lagi.'), { status: 0 });
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Permintaan gagal (${res.status}).`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

const nf = new Intl.NumberFormat('id-ID');
export const num = (n) => nf.format(n || 0);
export const rp = (n) => `Rp ${nf.format(n || 0)}`;
export const fmtDate = (ms) =>
  ms ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) : '-';
export const fmtDay = (ms) =>
  ms ? new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ms)) : '-';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function countChars(t) {
  return [...String(t).replace(/<\|[^|]*\|>/g, '')].length;
}

let toastBox;
export function toast(msg, kind = 'info', ms = 4200) {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    document.body.append(toastBox);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

export async function busy(btn, fn) {
  if (btn.classList.contains('is-busy')) return;
  btn.classList.add('is-busy');
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-busy');
    btn.disabled = false;
  }
}

export const STATUS_LABEL = {
  pending: ['Menunggu pembayaran', 'warn'],
  paid: ['Lunas', 'ok'],
  expired: ['Kedaluwarsa', 'dim'],
  review: ['Perlu dicek', 'bad'],
};

export const CHARS_PER_MINUTE = 800;

/** Konsol paket: tiap paket adalah fader, tinggi isian = kuota relatif terhadap paket terbesar. */
export function renderConsole(plans, { ctaFor, currentId } = {}) {
  const max = Math.max(...plans.map((p) => p.char_quota), 1);
  const cols = plans
    .map((p) => {
      const fill = Math.max(3, Math.round((p.char_quota / max) * 100));
      const cta = ctaFor(p);
      const minutes = Math.max(1, Math.round(p.char_quota / CHARS_PER_MINUTE));
      const period = p.price === 0 ? 'sekali saat daftar' : p.duration_days > 0 ? `per ${p.duration_days} hari` : 'sekali bayar';
      const feats = p.features.length
        ? p.features.map((f) => `<li>${esc(f)}</li>`).join('')
        : '<li class="soon">Kelebihan paket segera diumumkan</li>';
      const cls = ['ch', p.id === 'free' ? 'free' : '', p.is_featured ? 'featured' : '', p.id === currentId ? 'current' : ''].join(' ');
      const tag = p.id === currentId ? '<span class="pill ok">Paketmu</span>' : p.is_featured ? '<span class="pill">Pilihan populer</span>' : '';
      const btn = cta.href
        ? `<a class="btn ${cta.ghost ? 'btn-ghost' : ''}" href="${esc(cta.href)}">${esc(cta.label)}</a>`
        : `<button class="btn ${cta.ghost ? 'btn-ghost' : ''}" data-plan="${esc(p.id)}" ${cta.disabled ? 'disabled' : ''}>${esc(cta.label)}</button>`;
      return `
      <article class="${cls}">
        <div class="ch-head"><h3>${esc(p.name)}</h3>${tag}</div>
        <div class="ch-body">
          <div class="track" style="--fill:${fill}%" aria-hidden="true"><div class="fill"></div><div class="knob"></div></div>
          <div class="ch-read">
            <p class="quota">${num(p.char_quota)}<small>karakter, sekitar ${minutes} menit audio</small></p>
            <p class="price">${p.price === 0 ? 'Gratis' : rp(p.price)} <small>${period}</small></p>
          </div>
        </div>
        <ul class="feat">${feats}</ul>
        ${btn}
      </article>`;
    })
    .join('');
  return `<div class="console" style="--cols:${plans.length}">${cols}</div>
    <p class="fine">Perkiraan durasi memakai kecepatan bicara normal, sekitar ${CHARS_PER_MINUTE} karakter per menit.</p>`;
}

export const GOOGLE_G = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

export async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/?keluar=1';
}
