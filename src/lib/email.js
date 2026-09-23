import { HttpError } from './util.js';

// Kirim email lewat Cloudflare Email Service (binding `EMAIL` di wrangler.jsonc).
// Saat `wrangler dev`, binding ini disimulasikan: email dicatat ke log, tidak benar-benar terkirim.
export async function sendEmail(env, { to, subject, html, text }) {
  if (!env.EMAIL) {
    console.error('Binding EMAIL belum dipasang di wrangler.jsonc');
    throw new HttpError(503, 'Pengiriman email belum diaktifkan. Hubungi admin Voice Promax.', 'email_not_configured');
  }
  try {
    return await env.EMAIL.send({
      to,
      from: { email: env.EMAIL_FROM || 'noreply@voicepromax.com', name: env.EMAIL_FROM_NAME || 'Voice Promax' },
      subject,
      html,
      text,
    });
  } catch (e) {
    console.error('email gagal', e.code, e.message);
    if (e.code === 'E_RATE_LIMIT_EXCEEDED' || e.code === 'E_DAILY_LIMIT_EXCEEDED') {
      throw new HttpError(503, 'Server email sedang penuh. Coba lagi beberapa menit lagi.', 'email_busy');
    }
    if (e.code === 'E_RECIPIENT_SUPPRESSED' || e.code === 'E_DELIVERY_FAILED') {
      throw new HttpError(400, 'Email tidak bisa dikirim ke alamat ini. Periksa kembali alamat email Anda.', 'email_undeliverable');
    }
    throw new HttpError(503, 'Email belum bisa dikirim. Coba lagi beberapa saat lagi.', 'email_failed');
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ heading, intro, button, link, outro }) {
  return `<!doctype html><html lang="id"><body style="margin:0;background:#070a12;padding:32px 12px;font-family:Inter,Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#101623;border:1px solid #232a3a;border-radius:16px">
<tr><td style="padding:28px 28px 8px;font-size:18px;font-weight:800;color:#eef2f9">Voice Promax</td></tr>
<tr><td style="padding:8px 28px 0;font-size:20px;font-weight:700;color:#eef2f9">${esc(heading)}</td></tr>
<tr><td style="padding:12px 28px 0;font-size:15px;line-height:1.6;color:#b7c0d1">${intro}</td></tr>
<tr><td style="padding:24px 28px"><a href="${esc(link)}" style="display:inline-block;background:#22d3ee;background-image:linear-gradient(100deg,#22d3ee,#6366f1,#a855f7);color:#05070d;font-weight:700;font-size:15px;text-decoration:none;padding:13px 22px;border-radius:10px">${esc(button)}</a></td></tr>
<tr><td style="padding:0 28px 8px;font-size:13px;line-height:1.6;color:#8b97ad">Kalau tombol tidak berfungsi, salin link ini ke browser:<br><a href="${esc(link)}" style="color:#5eead4;word-break:break-all">${esc(link)}</a></td></tr>
<tr><td style="padding:12px 28px 28px;font-size:13px;line-height:1.6;color:#8b97ad">${outro}</td></tr>
</table></td></tr></table></body></html>`;
}

export function verifyEmailTemplate({ username, link }) {
  return {
    subject: 'Verifikasi email akun Voice Promax Anda',
    html: layout({
      heading: `Halo, ${username}`,
      intro: 'Terima kasih sudah mendaftar. Klik tombol di bawah untuk memverifikasi email Anda. Setelah terverifikasi, <b style="color:#eef2f9">10.000 karakter gratis</b> langsung masuk ke akun.',
      button: 'Verifikasi email',
      link,
      outro: 'Link ini berlaku 24 jam. Kalau Anda tidak merasa mendaftar di Voice Promax, abaikan email ini.',
    }),
    text: `Halo, ${username}\n\nKlik link berikut untuk memverifikasi email akun Voice Promax Anda (berlaku 24 jam):\n${link}\n\nSetelah terverifikasi, 10.000 karakter gratis langsung masuk ke akun.\n\nKalau Anda tidak merasa mendaftar, abaikan email ini.`,
  };
}

export function confirmEmailTemplate({ name, link }) {
  return {
    subject: 'Konfirmasi email untuk akun Voice Promax',
    html: layout({
      heading: `Halo, ${name}`,
      intro: 'Kamu meminta menyambungkan email ini ke akun Voice Promax. Klik tombol di bawah untuk mengonfirmasi. Setelah itu email ini dipakai untuk bukti pembayaran dan memulihkan password.',
      button: 'Sambungkan email',
      link,
      outro: 'Link ini berlaku 24 jam dan hanya bisa dipakai sekali. Kalau kamu tidak memintanya, abaikan email ini.',
    }),
    text: `Halo, ${name}\n\nBuka link berikut untuk menyambungkan email ini ke akun Voice Promax (berlaku 24 jam):\n${link}\n\nKalau kamu tidak memintanya, abaikan email ini.`,
  };
}

export function resetEmailTemplate({ name, link }) {
  return {
    subject: 'Atur ulang password Voice Promax',
    html: layout({
      heading: `Halo, ${name}`,
      intro: 'Kami menerima permintaan untuk membuat password baru akun Anda. Klik tombol di bawah untuk melanjutkan.',
      button: 'Buat password baru',
      link,
      outro: 'Link ini berlaku 1 jam dan hanya bisa dipakai sekali. Kalau Anda tidak meminta ini, abaikan email ini; password Anda tidak berubah.',
    }),
    text: `Halo, ${name}\n\nBuka link berikut untuk membuat password baru (berlaku 1 jam, sekali pakai):\n${link}\n\nKalau Anda tidak meminta ini, abaikan email ini.`,
  };
}
