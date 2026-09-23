import { DAY, now } from './util.js';
import { mayarGetInvoice } from './mayar.js';

const PAID = ['paid', 'settled', 'success', 'completed'];
const DEAD = ['closed', 'expired', 'cancelled', 'canceled', 'failed'];

/**
 * Aktifkan paket untuk pembayaran yang sudah lunas. Idempoten:
 * hanya baris yang berhasil berpindah ke 'paid' yang menambah kuota.
 */
export async function fulfillPayment(env, p, source = 'mayar') {
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE payments SET status = 'paid', paid_at = ?, updated_at = ?, note = ?
     WHERE id = ? AND status IN ('pending', 'expired', 'review')`
  ).bind(t, t, source, p.id).run();
  if (!res.meta.changes) return false;

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(p.user_id).first();
  if (!user) return false;

  const stillActive = user.plan_id !== 'free' && user.plan_expires_at && user.plan_expires_at > t;
  const start = stillActive ? user.plan_expires_at : t;
  const expires = p.duration_days > 0 ? start + p.duration_days * DAY : null;

  await env.DB.batch([
    // Paket aktif: kuota ditambahkan dan masa aktif diperpanjang.
    // Paket sudah lewat masa aktif: sisa kuota lama hangus, mulai dari kuota paket baru.
    env.DB.prepare(
      `UPDATE users SET
         char_balance = (CASE WHEN plan_id != 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at < ?1
                              THEN 0 ELSE char_balance END) + ?2,
         plan_id = ?3,
         plan_expires_at = ?4
       WHERE id = ?5`
    ).bind(t, p.char_quota, p.plan_id, expires, user.id),
    env.DB.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'purchase', ?, ?)`)
      .bind(user.id, p.char_quota, p.id, t),
  ]);
  return true;
}

/** Cek status invoice langsung ke Mayar (tidak pernah percaya isi webhook begitu saja). */
export async function syncPayment(env, p) {
  if (p.status === 'paid' || !p.mayar_invoice_id) return p.status;
  const inv = await mayarGetInvoice(env, p.mayar_invoice_id);
  const st = String(inv?.status ?? '').toLowerCase();
  const t = now();

  if (PAID.includes(st)) {
    const paidAmount = Number(inv.amount);
    if (paidAmount && paidAmount < p.amount) {
      await env.DB.prepare(`UPDATE payments SET status = 'review', updated_at = ?, note = ? WHERE id = ? AND status != 'paid'`)
        .bind(t, `Nominal dibayar ${paidAmount} kurang dari ${p.amount}`, p.id).run();
      return 'review';
    }
    await fulfillPayment(env, p, 'mayar');
    return 'paid';
  }

  const expired = DEAD.includes(st) || (inv?.expiredAt && Number(inv.expiredAt) < t);
  if (p.status === 'pending' && expired) {
    await env.DB.prepare(`UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'`)
      .bind(t, p.id).run();
    return 'expired';
  }
  return p.status;
}

/** Cron: cadangan kalau webhook tidak sampai, plus bersih-bersih sesi. */
export async function runCron(env) {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT * FROM payments WHERE status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 30`
  ).bind(t - 3 * DAY).all();
  for (const p of results) {
    try {
      await syncPayment(env, p);
    } catch (e) {
      console.error('cron sync gagal', p.id, e.message);
    }
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE payments SET status = 'expired', updated_at = ? WHERE status = 'pending' AND created_at <= ?`).bind(t, t - 3 * DAY),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
    // Pendaftaran yang tidak pernah diverifikasi dalam 3 hari dihapus (membebaskan username/email)
    env.DB.prepare(`DELETE FROM auth_tokens WHERE user_id IN (SELECT id FROM users WHERE email_verified_at IS NULL AND google_sub IS NULL AND created_at < ?)`).bind(t - 3 * DAY),
    env.DB.prepare(`DELETE FROM users WHERE email_verified_at IS NULL AND google_sub IS NULL AND created_at < ?`).bind(t - 3 * DAY),
    env.DB.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').bind(t - DAY),
    env.DB.prepare('DELETE FROM rate_limits WHERE created_at < ?').bind(t - 2 * DAY),
  ]);
}
