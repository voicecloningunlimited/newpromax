import { route, json, HttpError, readJson, now, toInt, DAY } from '../lib/util.js';
import { requireAdmin, grantFreeBonus } from '../lib/auth.js';
import { hashPassword, checkUsername, checkEmail, checkPassword } from '../lib/password.js';
import { uid } from '../lib/util.js';
import { syncPayment, fulfillPayment } from '../lib/payments.js';
import { planOut } from './api.js';

const WIB = 7 * 3_600_000; // agregasi harian mengikuti jam Indonesia (WIB)

// Jangan pernah kirim hash password atau ID Google ke browser, termasuk ke admin
function safeUser({ google_sub, password_hash, ...u }) {
  return { ...u, login_methods: [google_sub && 'google', password_hash && 'password'].filter(Boolean) };
}

export const adminRoutes = [
  route('GET', '/api/admin/stats', async (c) => {
    await requireAdmin(c);
    const db = c.env.DB;
    const t = now();
    const d30 = t - 30 * DAY;
    const d14 = t - 14 * DAY;

    const [users, newUsers, paying, revenue, gen, voices, daily, planMix] = await db.batch([
      db.prepare('SELECT COUNT(*) AS n FROM users'),
      db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at > ?').bind(d30),
      db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM payments WHERE status = 'paid'`),
      db.prepare(`SELECT COALESCE(SUM(amount),0) AS total,
                         COALESCE(SUM(CASE WHEN paid_at > ? THEN amount END),0) AS last30,
                         COUNT(CASE WHEN paid_at > ? THEN 1 END) AS count30
                  FROM payments WHERE status = 'paid'`).bind(d30, d30),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(chars),0) AS chars,
                         COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed
                  FROM generations WHERE created_at > ?`).bind(d30),
      db.prepare('SELECT COUNT(*) AS n FROM voices WHERE deleted_at IS NULL'),
      db.prepare(`SELECT (paid_at + ${WIB}) / ${DAY} AS day, SUM(amount) AS amount, COUNT(*) AS n
                  FROM payments WHERE status = 'paid' AND paid_at > ? GROUP BY day ORDER BY day`).bind(d14),
      db.prepare('SELECT plan_id, COUNT(*) AS n FROM users GROUP BY plan_id'),
    ]);

    return json({
      users: users.results[0].n,
      new_users_30d: newUsers.results[0].n,
      paying_users: paying.results[0].n,
      revenue_total: revenue.results[0].total,
      revenue_30d: revenue.results[0].last30,
      payments_30d: revenue.results[0].count30,
      generations_30d: gen.results[0].n,
      chars_30d: gen.results[0].chars,
      failed_30d: gen.results[0].failed,
      voices: voices.results[0].n,
      daily_revenue: daily.results.map((r) => ({ day_ms: r.day * DAY, amount: r.amount, n: r.n })),
      plan_mix: planMix.results,
    });
  }),

  // ---------- Pengguna ----------
  route('GET', '/api/admin/users', async (c) => {
    await requireAdmin(c);
    const q = (c.url.searchParams.get('q') || '').trim();
    const page = toInt(c.url.searchParams.get('page'), { min: 1, fallback: 1 });
    const size = 25;
    const where = q ? 'WHERE email LIKE ?1 OR name LIKE ?1 OR username LIKE ?1' : '';
    const like = `%${q}%`;
    const list = c.env.DB.prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM voices v WHERE v.user_id = u.id AND v.deleted_at IS NULL) AS voice_count,
              (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS total_paid
       FROM users u ${where} ORDER BY u.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`
    );
    const count = c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users ${where}`);
    const [rows, total] = await c.env.DB.batch(q ? [list.bind(like), count.bind(like)] : [list, count]);
    return json({ users: rows.results.map(safeUser), total: total.results[0].n, page, size });
  }),

  // Buat akun manual (username + password, email opsional)
  route('POST', '/api/admin/users', async (c) => {
    const me = await requireAdmin(c);
    const db = c.env.DB;
    const b = await readJson(c.req);
    const un = checkUsername(b.username);
    if (un.error) throw new HttpError(400, un.error, 'username');
    const pw = checkPassword(b.password);
    if (pw.error) throw new HttpError(400, pw.error, 'password');
    let email = null;
    if (b.email) {
      const e = checkEmail(b.email);
      if (e.error) throw new HttpError(400, e.error, 'email');
      email = e.value;
    }
    if (await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(un.value).first()) throw new HttpError(409, 'Username sudah dipakai.', 'username_taken');
    if (email && await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw new HttpError(409, 'Email sudah dipakai akun lain.', 'email_taken');
    const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').bind(b.plan_id || 'free').first();
    if (!plan) throw new HttpError(400, 'Paket tidak ditemukan.');
    const saldo = toInt(b.char_balance, { min: 0, max: 100_000_000, fallback: plan.char_quota });
    const hari = toInt(b.duration_days, { min: 0, max: 3650, fallback: plan.id === 'free' ? 0 : plan.duration_days });
    const t = now();
    const id = uid('u_');
    await db.batch([
      // free_bonus_at diisi supaya bonus pendaftaran tidak diberikan lagi saat pengguna menyambungkan email
      db.prepare(
        `INSERT INTO users (id, username, email, email_verified_at, password_hash, name, role, plan_id, char_balance,
                            plan_expires_at, free_bonus_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)`
      ).bind(id, un.value, email, email ? t : null, await hashPassword(pw.value), String(b.name || '').trim().slice(0, 80) || un.value,
        plan.id, saldo, hari > 0 ? t + hari * DAY : null, t, t),
      db.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'admin_adjust', ?, ?)`)
        .bind(id, saldo, `akun manual oleh ${me.email || me.username}`, t),
    ]);
    const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return json({ user: safeUser(fresh) }, 201);
  }),

  route('PATCH', '/api/admin/users/:id', async (c) => {
    const me = await requireAdmin(c);
    const db = c.env.DB;
    const body = await readJson(c.req);
    const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(c.params.id).first();
    if (!u) throw new HttpError(404, 'Pengguna tidak ditemukan.');

    const sets = [];
    const vals = [];
    const extra = [];
    const t = now();

    if (body.role !== undefined) {
      if (!['user', 'admin'].includes(body.role)) throw new HttpError(400, 'Peran tidak valid.');
      if (u.id === me.id && body.role !== 'admin') throw new HttpError(400, 'Kamu tidak bisa mencabut akses admin milikmu sendiri.');
      sets.push('role = ?'); vals.push(body.role);
    }
    if (body.status !== undefined) {
      if (!['active', 'banned'].includes(body.status)) throw new HttpError(400, 'Status tidak valid.');
      if (u.id === me.id && body.status !== 'active') throw new HttpError(400, 'Kamu tidak bisa menonaktifkan akunmu sendiri.');
      sets.push('status = ?'); vals.push(body.status);
      if (body.status === 'banned') extra.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id));
    }
    if (body.plan_id !== undefined) {
      const plan = await db.prepare('SELECT id FROM plans WHERE id = ?').bind(body.plan_id).first();
      if (!plan) throw new HttpError(400, 'Paket tidak ditemukan.');
      sets.push('plan_id = ?'); vals.push(plan.id);
    }
    if (body.plan_expires_at !== undefined) {
      const exp = body.plan_expires_at === null ? null : toInt(body.plan_expires_at, { min: 0 });
      sets.push('plan_expires_at = ?'); vals.push(exp);
    }
    const delta = toInt(body.char_delta, { min: -100_000_000, max: 100_000_000, fallback: 0 });
    if (delta) {
      sets.push('char_balance = MAX(0, char_balance + ?)'); vals.push(delta);
      extra.push(db.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'admin_adjust', ?, ?)`)
        .bind(u.id, delta, `${me.email || me.username}${body.note ? `: ${String(body.note).slice(0, 120)}` : ''}`, t));
    }
    if (body.new_password) {
      const pw = checkPassword(body.new_password);
      if (pw.error) throw new HttpError(400, pw.error, 'password');
      sets.push('password_hash = ?'); vals.push(await hashPassword(pw.value));
      extra.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id));
    }
    if (body.verify_email === true && u.email && !u.email_verified_at) {
      sets.push('email_verified_at = ?'); vals.push(t);
    }
    if (!sets.length) throw new HttpError(400, 'Tidak ada perubahan untuk disimpan.');

    await db.batch([db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, u.id), ...extra]);
    if (body.verify_email === true && u.email && !u.email_verified_at) await grantFreeBonus(c.env, u.id);
    const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first();
    return json({ user: safeUser(fresh) });
  }),

  route('GET', '/api/admin/users/:id/ledger', async (c) => {
    await requireAdmin(c);
    const { results } = await c.env.DB.prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .bind(c.params.id).all();
    return json({ ledger: results });
  }),

  // ---------- Pembayaran ----------
  route('GET', '/api/admin/payments', async (c) => {
    await requireAdmin(c);
    const status = c.url.searchParams.get('status');
    const page = toInt(c.url.searchParams.get('page'), { min: 1, fallback: 1 });
    const size = 30;
    const where = status ? 'WHERE p.status = ?' : '';
    const stmt = c.env.DB.prepare(
      `SELECT p.*, u.email, u.name FROM payments p LEFT JOIN users u ON u.id = p.user_id
       ${where} ORDER BY p.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`
    );
    const { results } = await (status ? stmt.bind(status) : stmt).all();
    return json({ payments: results, page, size });
  }),

  route('POST', '/api/admin/payments/:id/verify', async (c) => {
    await requireAdmin(c);
    const p = await c.env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(c.params.id).first();
    if (!p) throw new HttpError(404, 'Tagihan tidak ditemukan.');
    return json({ status: await syncPayment(c.env, p) });
  }),

  route('POST', '/api/admin/payments/:id/mark-paid', async (c) => {
    const me = await requireAdmin(c);
    const p = await c.env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(c.params.id).first();
    if (!p) throw new HttpError(404, 'Tagihan tidak ditemukan.');
    if (p.status === 'paid') throw new HttpError(400, 'Tagihan ini sudah lunas.');
    await fulfillPayment(c.env, p, `manual oleh ${me.email || me.username}`);
    return json({ status: 'paid' });
  }),

  // ---------- Paket ----------
  route('GET', '/api/admin/plans', async (c) => {
    await requireAdmin(c);
    const { results } = await c.env.DB.prepare('SELECT * FROM plans ORDER BY sort, price').all();
    return json({ plans: results.map(planOut) });
  }),

  route('PUT', '/api/admin/plans/:id', async (c) => {
    await requireAdmin(c);
    const id = c.params.id.toLowerCase();
    if (!/^[a-z0-9_-]{2,24}$/.test(id)) throw new HttpError(400, 'ID paket hanya boleh huruf kecil, angka, - dan _.');
    const b = await readJson(c.req);
    const name = String(b.name || '').trim().slice(0, 40);
    const price = toInt(b.price, { min: 0 });
    const quota = toInt(b.char_quota, { min: 1 });
    const days = toInt(b.duration_days, { min: 0, max: 3650, fallback: 30 });
    const maxVoices = toInt(b.max_voices, { min: 0, fallback: null });
    const features = Array.isArray(b.features) ? b.features.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : [];
    if (!name || price === null || !quota) throw new HttpError(400, 'Nama, harga, dan kuota karakter wajib diisi.');
    if (id === 'free' && price !== 0) throw new HttpError(400, 'Paket Free harus berharga Rp 0.');

    await c.env.DB.prepare(
      `INSERT INTO plans (id, name, price, char_quota, duration_days, max_voices, features, is_active, is_featured, sort, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id) DO UPDATE SET name = ?2, price = ?3, char_quota = ?4, duration_days = ?5, max_voices = ?6,
         features = ?7, is_active = ?8, is_featured = ?9, sort = ?10, updated_at = ?11`
    ).bind(id, name, price, quota, days, maxVoices, JSON.stringify(features), b.is_active ? 1 : 0, b.is_featured ? 1 : 0,
      toInt(b.sort, { fallback: 0 }), now()).run();

    const plan = await c.env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(id).first();
    return json({ plan: planOut(plan) });
  }),

  // ---------- Aktivitas ----------
  route('GET', '/api/admin/generations', async (c) => {
    await requireAdmin(c);
    const status = c.url.searchParams.get('status');
    const stmt = c.env.DB.prepare(
      `SELECT g.id, g.user_id, g.voice_label, g.chars, g.status, g.error, g.created_at, substr(g.text, 1, 140) AS text, u.email
       FROM generations g LEFT JOIN users u ON u.id = g.user_id
       ${status ? 'WHERE g.status = ?' : ''} ORDER BY g.created_at DESC LIMIT 100`
    );
    const { results } = await (status ? stmt.bind(status) : stmt).all();
    return json({ generations: results });
  }),
];
