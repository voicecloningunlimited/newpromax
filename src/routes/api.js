import {
  route, json, HttpError, readJson, now, uid, countChars, parseFeatures, appOrigin, safeEqual, toInt, DAY,
} from '../lib/util.js';
import { requireUser } from '../lib/auth.js';
import { bosonSpeech, bosonCreateVoice, PRESET_VOICES } from '../lib/boson.js';
import { mayarCreateInvoice } from '../lib/mayar.js';
import { syncPayment } from '../lib/payments.js';

const MAX_INPUT = 5000;                  // batas Boson per permintaan
const MAX_REF_BYTES = 10 * 1024 * 1024;  // batas Boson untuk rekaman referensi
const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/opus' };
const TYPE_TO_EXT = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/aac': 'aac', 'audio/x-aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
};

export function planOut(p) {
  return {
    id: p.id, name: p.name, price: p.price, char_quota: p.char_quota, duration_days: p.duration_days,
    max_voices: p.max_voices, features: parseFeatures(p.features), is_featured: !!p.is_featured,
    is_active: !!p.is_active, sort: p.sort,
  };
}

const getPlan = (env, id) => env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(id).first();

function meOut(u, plan) {
  return {
    id: u.id, username: u.username, email: u.email, name: u.name, avatar: u.avatar, phone: u.phone, role: u.role,
    login_methods: [u.google_sub && 'google', u.password_hash && 'password'].filter(Boolean),
    email_verified: !!u.email_verified_at,
    plan_id: u.plan_id, plan_name: plan?.name ?? u.plan_id, plan_quota: plan?.char_quota ?? 0,
    char_balance: u.char_balance, plan_expires_at: u.plan_expires_at, max_voices: plan?.max_voices ?? null,
  };
}

function voiceOut(v) {
  return { id: v.id, name: v.name, ref_text: v.ref_text, created_at: v.created_at, sample_url: `/api/voices/${v.id}/sample` };
}

function genOut(g) {
  return {
    id: g.id, text: g.text, chars: g.chars, voice_id: g.voice_id, voice_label: g.voice_label,
    status: g.status, created_at: g.created_at, url: g.audio_key ? `/api/audio/${g.id}` : null,
  };
}

function payOut(p) {
  return {
    id: p.id, plan_id: p.plan_id, amount: p.amount, char_quota: p.char_quota, status: p.status,
    payment_url: p.status === 'pending' ? p.payment_url : null, created_at: p.created_at, paid_at: p.paid_at,
  };
}

function normalizePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('62')) d = '0' + d.slice(2);
  if (d.startsWith('8')) d = '0' + d;
  return /^0\d{8,13}$/.test(d) ? d : null;
}

async function refund(env, userId, chars, ref) {
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET char_balance = char_balance + ? WHERE id = ?').bind(chars, userId),
    env.DB.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'refund', ?, ?)`)
      .bind(userId, chars, ref, now()),
  ]);
}

export const apiRoutes = [
  // ---------- Publik ----------
  route('GET', '/api/plans', async ({ env }) => {
    const { results } = await env.DB.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort, price').all();
    return json({ plans: results.map(planOut) });
  }),

  // ---------- Akun ----------
  route('GET', '/api/me', async (c) => {
    const u = await requireUser(c);
    return json({ user: meOut(u, await getPlan(c.env, u.plan_id)) });
  }),

  route('PATCH', '/api/me', async (c) => {
    const u = await requireUser(c);
    const body = await readJson(c.req);
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'Nomor HP tidak valid. Contoh: 081234567890.');
    await c.env.DB.prepare('UPDATE users SET phone = ? WHERE id = ?').bind(phone, u.id).run();
    return json({ ok: true, phone });
  }),

  // ---------- Suara (voice cloning) ----------
  route('GET', '/api/voices', async (c) => {
    const u = await requireUser(c);
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM voices WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
    ).bind(u.id).all();
    return json({ voices: results.map(voiceOut), presets: PRESET_VOICES });
  }),

  route('POST', '/api/voices', async (c) => {
    const { env } = c;
    const u = await requireUser(c);
    const form = await c.req.formData().catch(() => null);
    if (!form) throw new HttpError(400, 'Kirim data suara sebagai formulir.');

    const name = String(form.get('name') || '').trim().slice(0, 60);
    const refText = String(form.get('ref_text') || '').trim().slice(0, 2000);
    const file = form.get('audio');
    if (!name) throw new HttpError(400, 'Beri nama untuk suara ini.');
    if (refText.length < 3) throw new HttpError(400, 'Tulis transkrip rekaman kata per kata agar hasil klon lebih mirip.');
    if (form.get('consent') !== 'yes') throw new HttpError(400, 'Centang pernyataan bahwa kamu berhak mengklon suara ini.');
    if (!file || typeof file === 'string') throw new HttpError(400, 'Pilih file audio atau rekam langsung.');
    if (file.size > MAX_REF_BYTES) throw new HttpError(400, 'Ukuran rekaman maksimal 10 MB.');
    if (file.size < 16_000) throw new HttpError(400, 'Rekaman terlalu pendek. Gunakan 5 sampai 30 detik ucapan.');

    const type = String(file.type || '').toLowerCase().split(';')[0];
    const ext = TYPE_TO_EXT[type] || String(file.name || '').split('.').pop().toLowerCase();
    if (!MIME[ext]) throw new HttpError(400, 'Format audio belum didukung. Gunakan WAV, MP3, FLAC, AAC, atau OPUS.');

    const plan = await getPlan(env, u.plan_id);
    if (plan?.max_voices != null) {
      const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM voices WHERE user_id = ? AND deleted_at IS NULL').bind(u.id).first();
      if (cnt.n >= plan.max_voices) {
        throw new HttpError(403, `Paket ${plan.name} bisa menyimpan ${plan.max_voices} suara. Hapus salah satu atau naikkan paket.`);
      }
    }

    const bytes = await file.arrayBuffer();
    const bosonId = await bosonCreateVoice(env, {
      bytes, type: MIME[ext], filename: `ref.${ext}`, refText, description: `${name} (${u.id})`,
    });

    const id = uid('v_');
    const key = `voices/${u.id}/${id}.${ext}`;
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: MIME[ext] } });
    const t = now();
    await env.DB.prepare(
      `INSERT INTO voices (id, user_id, boson_voice_id, name, ref_text, sample_key, sample_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, u.id, bosonId, name, refText, key, MIME[ext], t).run();

    return json({ voice: voiceOut({ id, name, ref_text: refText, created_at: t }) }, 201);
  }),

  route('DELETE', '/api/voices/:id', async (c) => {
    const u = await requireUser(c);
    const v = await c.env.DB.prepare('SELECT * FROM voices WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(c.params.id, u.id).first();
    if (!v) throw new HttpError(404, 'Suara tidak ditemukan.');
    await c.env.DB.prepare('UPDATE voices SET deleted_at = ? WHERE id = ?').bind(now(), v.id).run();
    if (v.sample_key) await c.env.BUCKET.delete(v.sample_key);
    return json({ ok: true });
  }),

  route('GET', '/api/voices/:id/sample', async (c) => {
    const u = await requireUser(c);
    const v = await c.env.DB.prepare('SELECT * FROM voices WHERE id = ? AND deleted_at IS NULL').bind(c.params.id).first();
    if (!v || (v.user_id !== u.id && u.role !== 'admin')) throw new HttpError(404, 'Rekaman tidak ditemukan.');
    const obj = v.sample_key && (await c.env.BUCKET.get(v.sample_key));
    if (!obj) throw new HttpError(404, 'Rekaman tidak ditemukan.');
    return new Response(obj.body, { headers: { 'content-type': v.sample_type || 'audio/wav', 'cache-control': 'private, max-age=3600' } });
  }),

  // ---------- Text to speech ----------
  route('POST', '/api/tts', async (c) => {
    const { env } = c;
    const u = await requireUser(c);
    const body = await readJson(c.req);
    const text = String(body.text || '').trim();
    if (!text) throw new HttpError(400, 'Tulis naskah yang ingin dibacakan.');
    if (text.length > MAX_INPUT) throw new HttpError(400, `Naskah maksimal ${MAX_INPUT.toLocaleString('id-ID')} karakter sekali buat.`);
    const chars = countChars(text);
    if (chars === 0) throw new HttpError(400, 'Naskah hanya berisi tag. Tambahkan teks yang ingin diucapkan.');

    // Tentukan suara
    let bosonVoice;
    let voiceLabel;
    let voiceId = null;
    const preset = PRESET_VOICES.find((p) => p.id === body.voice);
    if (preset) {
      bosonVoice = preset.id;
      voiceLabel = preset.name;
    } else {
      const v = await env.DB.prepare('SELECT * FROM voices WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
        .bind(String(body.voice || ''), u.id).first();
      if (!v) throw new HttpError(404, 'Pilih suara dari daftar terlebih dahulu.');
      bosonVoice = v.boson_voice_id;
      voiceLabel = v.name;
      voiceId = v.id;
    }

    // Potong kuota di awal secara atomik; dikembalikan kalau pembuatan gagal
    const dec = await env.DB.prepare('UPDATE users SET char_balance = char_balance - ? WHERE id = ? AND char_balance >= ?')
      .bind(chars, u.id, chars).run();
    if (!dec.meta.changes) {
      throw new HttpError(402, `Kuota tidak cukup. Naskah ini butuh ${chars.toLocaleString('id-ID')} karakter, sisa kuotamu ${u.char_balance.toLocaleString('id-ID')}.`, 'quota');
    }

    const genId = uid('g_');
    const t = now();
    let audio;
    try {
      audio = await bosonSpeech(env, { input: text, voice: bosonVoice });
    } catch (e) {
      await refund(env, u.id, chars, genId);
      await env.DB.prepare(
        `INSERT INTO generations (id, user_id, voice_id, voice_label, text, chars, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 'failed', ?, ?)`
      ).bind(genId, u.id, voiceId, voiceLabel, text, String(e.message).slice(0, 300), t).run();
      throw e;
    }

    const key = `gen/${u.id}/${genId}.mp3`;
    await env.BUCKET.put(key, audio.body, { httpMetadata: { contentType: audio.contentType } });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO generations (id, user_id, voice_id, voice_label, text, chars, audio_key, content_type, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`
      ).bind(genId, u.id, voiceId, voiceLabel, text, chars, key, audio.contentType, t),
      env.DB.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'tts', ?, ?)`)
        .bind(u.id, -chars, genId, t),
    ]);
    const bal = await env.DB.prepare('SELECT char_balance FROM users WHERE id = ?').bind(u.id).first();

    return json({
      generation: genOut({ id: genId, text, chars, voice_id: voiceId, voice_label: voiceLabel, status: 'done', created_at: t, audio_key: key }),
      char_balance: bal.char_balance,
    });
  }),

  route('GET', '/api/generations', async (c) => {
    const u = await requireUser(c);
    const limit = toInt(c.url.searchParams.get('limit'), { min: 1, max: 50, fallback: 20 });
    const before = toInt(c.url.searchParams.get('before'), { fallback: Number.MAX_SAFE_INTEGER });
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM generations WHERE user_id = ? AND status = 'done' AND created_at < ? ORDER BY created_at DESC LIMIT ?`
    ).bind(u.id, before, limit).all();
    return json({ generations: results.map(genOut), has_more: results.length === limit });
  }),

  route('DELETE', '/api/generations/:id', async (c) => {
    const u = await requireUser(c);
    const g = await c.env.DB.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?').bind(c.params.id, u.id).first();
    if (!g) throw new HttpError(404, 'Audio tidak ditemukan.');
    if (g.audio_key) await c.env.BUCKET.delete(g.audio_key);
    await c.env.DB.prepare('DELETE FROM generations WHERE id = ?').bind(g.id).run();
    return json({ ok: true });
  }),

  route('GET', '/api/audio/:id', async (c) => {
    const u = await requireUser(c);
    const g = await c.env.DB.prepare('SELECT * FROM generations WHERE id = ?').bind(c.params.id).first();
    if (!g || !g.audio_key || (g.user_id !== u.id && u.role !== 'admin')) throw new HttpError(404, 'Audio tidak ditemukan.');
    const obj = await c.env.BUCKET.get(g.audio_key);
    if (!obj) throw new HttpError(404, 'Audio tidak ditemukan.');
    const headers = { 'content-type': g.content_type || 'audio/mpeg', 'cache-control': 'private, max-age=86400' };
    if (c.url.searchParams.get('download')) headers['content-disposition'] = `attachment; filename="voicepromax-${g.id.slice(2, 10)}.mp3"`;
    return new Response(obj.body, { headers });
  }),

  // ---------- Pembayaran (Mayar) ----------
  route('POST', '/api/checkout', async (c) => {
    const { env } = c;
    const u = await requireUser(c);
    const body = await readJson(c.req);
    const plan = await getPlan(env, String(body.plan_id || ''));
    if (!plan || !plan.is_active) throw new HttpError(404, 'Paket tidak ditemukan.');
    if (plan.price <= 0) throw new HttpError(400, 'Paket ini gratis dan sudah otomatis didapat saat mendaftar.');
    if (!u.email || !u.email_verified_at) {
      throw new HttpError(400, 'Sambungkan email dulu di menu Akun. Mayar mengirim bukti pembayaran ke email tersebut.', 'need_email');
    }

    const phone = normalizePhone(body.phone || u.phone);
    if (!phone) throw new HttpError(400, 'Masukkan nomor HP aktif untuk tagihan Mayar. Contoh: 081234567890.', 'phone');
    if (phone !== u.phone) await env.DB.prepare('UPDATE users SET phone = ? WHERE id = ?').bind(phone, u.id).run();

    // Pakai ulang tagihan yang sama bila baru dibuat (hindari tagihan ganda saat tombol diklik berulang)
    const t = now();
    const recent = await env.DB.prepare(
      `SELECT * FROM payments WHERE user_id = ? AND plan_id = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 1`
    ).bind(u.id, plan.id, t - 30 * 60_000).first();
    if (recent?.payment_url && recent.amount === plan.price) return json({ payment_id: recent.id, payment_url: recent.payment_url });

    const orderId = uid('pay_');
    const origin = appOrigin(env, c.url);
    const invoice = await mayarCreateInvoice(env, {
      name: u.name || u.username || u.email.split('@')[0],
      email: u.email,
      mobile: phone,
      redirectUrl: `${origin}/app?tab=billing&payment=${orderId}`,
      description: `Paket ${plan.name} Voice Promax (${plan.char_quota.toLocaleString('id-ID')} karakter)`,
      expiredAt: new Date(t + DAY).toISOString(),
      items: [{ quantity: 1, rate: plan.price, description: `Voice Promax ${plan.name}: ${plan.char_quota.toLocaleString('id-ID')} karakter` }],
      extraData: { noCustomer: u.id, idProd: orderId },
    });

    await env.DB.prepare(
      `INSERT INTO payments (id, user_id, plan_id, amount, char_quota, duration_days, status, mayar_invoice_id,
                             mayar_transaction_id, payment_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
    ).bind(orderId, u.id, plan.id, plan.price, plan.char_quota, plan.duration_days,
      invoice.id, invoice.transactionId || null, invoice.link, t, t).run();

    return json({ payment_id: orderId, payment_url: invoice.link });
  }),

  route('GET', '/api/payments', async (c) => {
    const u = await requireUser(c);
    const { results } = await c.env.DB.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(u.id).all();
    return json({ payments: results.map(payOut) });
  }),

  route('POST', '/api/payments/:id/verify', async (c) => {
    const u = await requireUser(c);
    const p = await c.env.DB.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').bind(c.params.id, u.id).first();
    if (!p) throw new HttpError(404, 'Tagihan tidak ditemukan.');
    const status = await syncPayment(c.env, p);
    return json({ status });
  }),

  // ---------- Webhook Mayar ----------
  // Daftarkan di dashboard Mayar: https://DOMAIN/api/webhooks/mayar?token=MAYAR_WEBHOOK_TOKEN
  route('POST', '/api/webhooks/mayar', async (c) => {
    const { env } = c;
    if (!env.MAYAR_WEBHOOK_TOKEN || !safeEqual(c.url.searchParams.get('token') || '', env.MAYAR_WEBHOOK_TOKEN)) {
      return json({ ok: false }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    const d = body?.data || {};
    const ids = [...new Set([d.id, d.transactionId, d.invoiceId, d.paymentLinkId, d.productId, d?.extraData?.idProd]
      .filter((x) => typeof x === 'string' && x))];

    let rows = [];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      rows = (await env.DB.prepare(
        `SELECT * FROM payments WHERE status != 'paid' AND (id IN (${ph}) OR mayar_invoice_id IN (${ph}) OR mayar_transaction_id IN (${ph}))`
      ).bind(...ids, ...ids, ...ids).all()).results;
    }
    if (!rows.length && d.customerEmail) {
      rows = (await env.DB.prepare(
        `SELECT p.* FROM payments p JOIN users u ON u.id = p.user_id
         WHERE lower(u.email) = lower(?) AND p.status = 'pending' AND p.created_at > ?`
      ).bind(d.customerEmail, now() - 3 * DAY).all()).results;
    }
    // Status selalu diverifikasi ulang ke API Mayar di syncPayment
    for (const p of rows) {
      try { await syncPayment(env, p); } catch (e) { console.error('webhook sync gagal', p.id, e.message); }
    }
    return json({ ok: true, matched: rows.length });
  }),
];
