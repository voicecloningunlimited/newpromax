import { api, num, rp, esc, fmtDate, fmtDay, toast, busy, STATUS_LABEL, logout } from './common.js';

const $ = (id) => document.getElementById(id);
const state = { plans: [], users: [], userPage: 1, userQ: '', payPage: 1, editing: null };
const DEFAULT_AVATAR = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';

const toLocalInput = (ms) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);
const planName = (id) => state.plans.find((p) => p.id === id)?.name || id;
const methodLabel = (u) => (u.login_methods || []).map((m) => (m === 'google' ? 'Google' : 'Password')).join(' + ') || '-';

/* ---------------- Tab ---------------- */
const LOADERS = { overview: loadOverview, users: loadUsers, payments: loadPayments, plans: loadPlans, activity: loadActivity };

function showTab(name, push = true) {
  if (!LOADERS[name]) name = 'overview';
  document.querySelectorAll('[data-tab]').forEach((s) => { s.hidden = s.dataset.tab !== name; });
  document.querySelectorAll('[data-tab-link]').forEach((a) => {
    if (a.dataset.tabLink === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (push) history.pushState(null, '', `?tab=${name}`);
  LOADERS[name]().catch((e) => toast(e.message, 'bad'));
}

/* ---------------- Ringkasan ---------------- */
async function loadOverview() {
  const s = await api('/api/admin/stats');
  const tiles = [
    [num(s.users), 'Total pengguna'],
    [num(s.new_users_30d), 'Pengguna baru'],
    [num(s.paying_users), 'Pernah membayar (total)'],
    [rp(s.revenue_30d), `Pendapatan dari ${num(s.payments_30d)} transaksi`],
    [rp(s.revenue_total), 'Pendapatan sepanjang waktu'],
    [num(s.chars_30d), 'Karakter diubah jadi suara'],
    [num(s.generations_30d), `Audio dibuat, ${num(s.failed_30d)} gagal`],
    [num(s.voices), 'Suara klon tersimpan (total)'],
  ];
  $('stats').innerHTML = tiles.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${esc(l)}</span></div>`).join('');
  $('revenueChart').innerHTML = revenueChart(s.daily_revenue);

  const total = s.plan_mix.reduce((a, r) => a + r.n, 0) || 1;
  $('planMix').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Paket</th><th class="num">Pengguna</th><th class="num">Porsi</th></tr></thead><tbody>
    ${s.plan_mix.map((r) => `<tr><td>${esc(planName(r.plan_id))}</td><td class="num">${num(r.n)}</td><td class="num">${Math.round((r.n / total) * 100)}%</td></tr>`).join('')}
  </tbody></table></div>`;
}

function revenueChart(rows) {
  const DAY = 86_400_000;
  const WIB = 7 * 3_600_000;
  const today = Math.floor((Date.now() + WIB) / DAY) * DAY;
  const byDay = new Map(rows.map((r) => [r.day_ms, r.amount]));
  const days = [...Array(14)].map((_, i) => today - (13 - i) * DAY);
  const vals = days.map((d) => byDay.get(d) || 0);
  const max = Math.max(...vals, 1);
  const W = 700, H = 200, pad = 28, bw = (W - pad) / 14;
  const bars = vals.map((v, i) => {
    const h = Math.max(v ? 3 : 1, (v / max) * (H - 50));
    const x = pad + i * bw + bw * 0.18;
    const label = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(days[i]));
    return `<g><title>${label}: ${rp(v)}</title>
      <rect x="${x}" y="${H - 24 - h}" width="${bw * 0.64}" height="${h}" rx="3" fill="${v ? 'var(--signal)' : 'var(--line)'}"/>
      ${i % 2 === 0 ? `<text x="${x + bw * 0.32}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${label}</text>` : ''}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik pendapatan harian">
    <text x="0" y="14" font-size="11" fill="var(--muted)">${rp(max)}</text>
    <line x1="${pad}" x2="${W}" y1="${H - 24}" y2="${H - 24}" stroke="var(--line-2)"/>${bars}</svg>`;
}

/* ---------------- Pengguna ---------------- */
async function loadUsers() {
  if (!state.plans.length) state.plans = (await api('/api/admin/plans')).plans;
  const q = new URLSearchParams({ page: state.userPage });
  if (state.userQ) q.set('q', state.userQ);
  const r = await api(`/api/admin/users?${q}`);
  state.users = r.users;
  $('userTotal').textContent = `${num(r.total)} pengguna`;
  if (!r.users.length) { $('userTable').innerHTML = '<div class="table-wrap"><p class="empty">Tidak ada pengguna yang cocok.</p></div>'; $('userPager').innerHTML = ''; return; }
  $('userTable').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Pengguna</th><th>Masuk lewat</th><th>Paket</th><th class="num">Sisa kuota</th><th>Aktif sampai</th><th class="num">Suara</th><th class="num">Total bayar</th><th>Status</th><th>Bergabung</th><th></th></tr></thead>
    <tbody>${r.users.map((u) => `<tr>
      <td><div class="who"><img src="${esc(u.avatar || DEFAULT_AVATAR)}" alt="" referrerpolicy="no-referrer"><div><strong>${esc(u.name || '-')}</strong><small>${[u.username && `@${esc(u.username)}`, u.email ? esc(u.email) : '<em>tanpa email</em>'].filter(Boolean).join(', ')}</small></div></div></td>
      <td style="white-space:nowrap">${methodLabel(u)} ${u.email && !u.email_verified_at ? '<span class="pill warn">Belum verifikasi</span>' : ''}</td>
      <td>${esc(planName(u.plan_id))}${u.role === 'admin' ? ' <span class="pill">Admin</span>' : ''}</td>
      <td class="num">${num(u.char_balance)}</td>
      <td>${u.plan_expires_at ? fmtDay(u.plan_expires_at) : '-'}</td>
      <td class="num">${num(u.voice_count)}</td>
      <td class="num">${rp(u.total_paid)}</td>
      <td>${u.status === 'active' ? '<span class="pill ok">Aktif</span>' : '<span class="pill bad">Nonaktif</span>'}</td>
      <td>${fmtDay(u.created_at)}</td>
      <td><button class="btn btn-ghost btn-sm" data-edit="${esc(u.id)}">Kelola</button></td>
    </tr>`).join('')}</tbody></table></div>`;
  pager($('userPager'), r.page, Math.ceil(r.total / r.size), (p) => { state.userPage = p; loadUsers(); });
}

function pager(el, page, pages, go) {
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `<button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} data-p="${page - 1}">Sebelumnya</button>
    <span>Halaman ${page} dari ${pages}</span>
    <button class="btn btn-ghost btn-sm" ${page >= pages ? 'disabled' : ''} data-p="${page + 1}">Berikutnya</button>`;
  el.onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) go(+b.dataset.p); };
}

function openUser(id) {
  const u = state.users.find((x) => x.id === id);
  state.editing = u;
  const f = $('userForm');
  $('userDlgWho').innerHTML = `<img src="${esc(u.avatar || DEFAULT_AVATAR)}" alt="" referrerpolicy="no-referrer"><div><strong>${esc(u.name || '-')}</strong><small>${[u.username && `@${esc(u.username)}`, u.email ? esc(u.email) : 'tanpa email', u.phone && esc(u.phone)].filter(Boolean).join(', ')}</small></div>`;
  f.plan_id.innerHTML = state.plans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  f.plan_id.value = u.plan_id;
  f.plan_expires_at.value = toLocalInput(u.plan_expires_at);
  f.role.value = u.role;
  f.status.value = u.status;
  f.char_delta.value = '';
  f.note.value = '';
  $('userDlgBalance').textContent = `Sisa kuota sekarang ${num(u.char_balance)} karakter.`;
  $('verifyRow').hidden = !u.email || !!u.email_verified_at;
  f.new_password.value = '';
  f.verify_email.checked = false;
  $('userDlg').showModal();
}

function passwordAcak() {
  const huruf = 'abcdefghjkmnpqrstuvwxyz', angka = '23456789';
  const r = (s) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  let p = '';
  for (let i = 0; i < 7; i++) p += r(huruf);
  return p + r(angka) + r(angka) + r(angka);
}

function setupNewUser() {
  const dlg = $('newUserDlg'), f = $('newUserForm');
  $('addUserBtn').addEventListener('click', async () => {
    if (!state.plans.length) state.plans = (await api('/api/admin/plans')).plans;
    f.reset();
    f.plan_id.innerHTML = state.plans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${num(p.char_quota)} karakter)</option>`).join('');
    f.password.value = passwordAcak();
    dlg.showModal();
    f.username.focus();
  });
  $('genPassBtn').addEventListener('click', () => { f.password.value = passwordAcak(); });
  f.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const body = {
      username: f.username.value.trim().toLowerCase(), password: f.password.value.trim(), name: f.name.value.trim(),
      email: f.email.value.trim() || undefined, plan_id: f.plan_id.value,
      char_balance: f.char_balance.value === '' ? undefined : Number(f.char_balance.value),
    };
    busy($('newUserSave'), async () => {
      try {
        const { user } = await api('/api/admin/users', { method: 'POST', body });
        dlg.close();
        toast(`Akun @${user.username} dibuat. Password: ${body.password}`, 'ok', 12000);
        state.userPage = 1;
        loadUsers();
      } catch (err) { toast(err.message, 'bad', 6000); }
    });
  });
}

function setupUsers() {
  setupNewUser();
  let t;
  $('userSearch').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.userQ = e.target.value.trim(); state.userPage = 1; loadUsers().catch((err) => toast(err.message, 'bad')); }, 300);
  });
  $('userTable').addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) openUser(b.dataset.edit); });
  $('userForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const f = e.currentTarget;
    const u = state.editing;
    const body = {};
    if (f.plan_id.value !== u.plan_id) body.plan_id = f.plan_id.value;
    const exp = fromLocalInput(f.plan_expires_at.value);
    if (toLocalInput(exp) !== toLocalInput(u.plan_expires_at)) body.plan_expires_at = exp;
    if (f.role.value !== u.role) body.role = f.role.value;
    if (f.status.value !== u.status) {
      if (f.status.value === 'banned' && !confirm(`Nonaktifkan ${u.username ? '@' + u.username : u.email}? Pengguna akan langsung keluar dari semua perangkat.`)) return;
      body.status = f.status.value;
    }
    if (f.verify_email.checked && !u.email_verified_at) body.verify_email = true;
    if (f.new_password.value.trim()) {
      if (!confirm(`Ganti password ${u.username ? '@' + u.username : u.email}? Pengguna akan keluar dari semua perangkat.`)) return;
      body.new_password = f.new_password.value.trim();
    }
    const delta = parseInt(f.char_delta.value, 10);
    if (delta) { body.char_delta = delta; body.note = f.note.value; }
    if (!Object.keys(body).length) { $('userDlg').close(); return; }
    busy($('userSaveBtn'), async () => {
      try {
        await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
        $('userDlg').close();
        toast('Perubahan pengguna disimpan.', 'ok');
        loadUsers();
      } catch (err) { toast(err.message, 'bad', 6000); }
    });
  });
}

/* ---------------- Pembayaran ---------------- */
async function loadPayments() {
  if (!state.plans.length) state.plans = (await api('/api/admin/plans')).plans;
  const q = new URLSearchParams({ page: state.payPage });
  const st = $('payFilter').value;
  if (st) q.set('status', st);
  const r = await api(`/api/admin/payments?${q}`);
  if (!r.payments.length) { $('payTable').innerHTML = '<div class="table-wrap"><p class="empty">Belum ada tagihan dengan status ini.</p></div>'; $('payPager').innerHTML = ''; return; }
  $('payTable').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Dibuat</th><th>Pengguna</th><th>Paket</th><th class="num">Jumlah</th><th>Status</th><th>Dibayar</th><th>Catatan</th><th></th></tr></thead>
    <tbody>${r.payments.map((p) => {
      const [label, kind] = STATUS_LABEL[p.status] || [p.status, 'dim'];
      const acts = p.status === 'paid' ? '' : `
        <button class="btn btn-ghost btn-sm" data-verify="${esc(p.id)}">Cek ke Mayar</button>
        <button class="btn btn-danger btn-sm" data-mark="${esc(p.id)}">Tandai lunas</button>`;
      return `<tr>
        <td>${fmtDate(p.created_at)}<br><small class="muted">${esc(p.id)}</small></td>
        <td>${esc(p.name || '-')}<br><small class="muted">${esc(p.email || p.user_id)}</small></td>
        <td>${esc(planName(p.plan_id))}<br><small class="muted">${num(p.char_quota)} karakter</small></td>
        <td class="num">${rp(p.amount)}</td>
        <td><span class="pill ${kind}">${label}</span></td>
        <td>${fmtDate(p.paid_at)}</td>
        <td class="small">${esc(p.note || '')}</td>
        <td style="white-space:nowrap">${acts}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  const hasNext = r.payments.length === r.size;
  pager($('payPager'), r.page, hasNext ? r.page + 1 : r.page, (p) => { state.payPage = p; loadPayments(); });
}

function setupPayments() {
  $('payFilter').addEventListener('change', () => { state.payPage = 1; loadPayments().catch((e) => toast(e.message, 'bad')); });
  $('payTable').addEventListener('click', (e) => {
    const v = e.target.closest('[data-verify]');
    const m = e.target.closest('[data-mark]');
    if (v) busy(v, async () => {
      try {
        const { status } = await api(`/api/admin/payments/${v.dataset.verify}/verify`, { method: 'POST' });
        toast(`Status di Mayar: ${STATUS_LABEL[status]?.[0] || status}.`, status === 'paid' ? 'ok' : 'info');
        loadPayments();
      } catch (err) { toast(err.message, 'bad'); }
    });
    if (m && confirm('Tandai tagihan ini lunas dan tambahkan kuota ke pengguna? Pastikan dana sudah masuk di dashboard Mayar.')) {
      busy(m, async () => {
        try {
          await api(`/api/admin/payments/${m.dataset.mark}/mark-paid`, { method: 'POST' });
          toast('Tagihan ditandai lunas. Kuota sudah ditambahkan.', 'ok');
          loadPayments();
        } catch (err) { toast(err.message, 'bad'); }
      });
    }
  });
}

/* ---------------- Paket ---------------- */
function planForm(p, isNew = false) {
  return `<form class="panel plan-edit" data-plan-form="${esc(p.id)}">
    <div class="plan-edit-head">
      <h2 class="h-sm">${isNew ? 'Paket baru' : esc(p.name)}</h2>
      ${isNew ? '' : `<span class="muted small">ID: ${esc(p.id)}</span>`}
    </div>
    <div class="plan-grid">
      ${isNew ? '<label class="field"><span>ID paket</span><input type="text" name="id" pattern="[a-z0-9_-]{2,24}" placeholder="misal: agency" required></label>' : ''}
      <label class="field"><span>Nama</span><input type="text" name="name" value="${esc(p.name)}" required></label>
      <label class="field"><span>Harga (Rp)</span><input type="number" name="price" min="0" step="1000" value="${p.price}" required ${p.id === 'free' ? 'readonly' : ''}></label>
      <label class="field"><span>Kuota karakter</span><input type="number" name="char_quota" min="1" step="1000" value="${p.char_quota}" required></label>
      <label class="field"><span>Masa aktif (hari)</span><input type="number" name="duration_days" min="0" value="${p.duration_days}"><span class="hint">0 = tidak kedaluwarsa</span></label>
      <label class="field"><span>Maks. suara klon</span><input type="number" name="max_voices" min="0" value="${p.max_voices ?? ''}" placeholder="Tanpa batas"></label>
      <label class="field"><span>Urutan tampil</span><input type="number" name="sort" value="${p.sort}"></label>
      <label class="field wide"><span>Kelebihan paket (satu per baris)</span><textarea name="features" rows="3" placeholder="Kosongkan untuk menampilkan &quot;segera diumumkan&quot;">${esc(p.features.join('\n'))}</textarea></label>
    </div>
    <div class="plan-edit-foot">
      <div class="checks">
        <label class="check"><input type="checkbox" name="is_active" ${p.is_active ? 'checked' : ''}><span>Tampilkan ke pengguna</span></label>
        <label class="check"><input type="checkbox" name="is_featured" ${p.is_featured ? 'checked' : ''}><span>Tandai sebagai pilihan populer</span></label>
      </div>
      <button class="btn" type="submit">Simpan paket</button>
    </div>
  </form>`;
}

async function loadPlans() {
  state.plans = (await api('/api/admin/plans')).plans;
  $('planForms').innerHTML = state.plans.map((p) => planForm(p)).join('');
}

function setupPlans() {
  $('addPlanBtn').addEventListener('click', () => {
    if ($('planForms').querySelector('[data-plan-form="__new"]')) return;
    const blank = { id: '__new', name: '', price: 0, char_quota: 10000, duration_days: 30, max_voices: null, features: [], is_active: true, is_featured: false, sort: state.plans.length };
    $('planForms').insertAdjacentHTML('beforeend', planForm(blank, true));
    $('planForms').lastElementChild.querySelector('input').focus();
  });
  $('planForms').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const id = f.dataset.planForm === '__new' ? f.elements.id.value.trim().toLowerCase() : f.dataset.planForm;
    const body = {
      name: f.elements.name.value, price: f.price.value, char_quota: f.char_quota.value, duration_days: f.duration_days.value,
      max_voices: f.max_voices.value, sort: f.sort.value,
      features: f.features.value.split('\n').map((s) => s.trim()).filter(Boolean),
      is_active: f.is_active.checked, is_featured: f.is_featured.checked,
    };
    busy(f.querySelector('button[type=submit]'), async () => {
      try {
        await api(`/api/admin/plans/${encodeURIComponent(id)}`, { method: 'PUT', body });
        toast(`Paket ${body.name} disimpan.`, 'ok');
        loadPlans();
      } catch (err) { toast(err.message, 'bad', 6000); }
    });
  });
}

/* ---------------- Aktivitas ---------------- */
async function loadActivity() {
  const st = $('genFilter').value;
  const r = await api(`/api/admin/generations${st ? `?status=${st}` : ''}`);
  if (!r.generations.length) { $('genTable').innerHTML = '<div class="table-wrap"><p class="empty">Belum ada aktivitas.</p></div>'; return; }
  $('genTable').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Waktu</th><th>Pengguna</th><th>Suara</th><th>Naskah</th><th class="num">Karakter</th><th>Status</th></tr></thead>
    <tbody>${r.generations.map((g) => `<tr>
      <td style="white-space:nowrap">${fmtDate(g.created_at)}</td>
      <td>${esc(g.email || g.user_id)}</td>
      <td>${esc(g.voice_label || '-')}</td>
      <td class="small">${esc(g.text)}${g.error ? `<br><span class="err-text">${esc(g.error)}</span>` : ''}</td>
      <td class="num">${num(g.chars)}</td>
      <td>${g.status === 'done' ? '<span class="pill ok">Berhasil</span>' : '<span class="pill bad">Gagal</span>'}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

/* ---------------- Mulai ---------------- */
function init() {
  $('logoutBtn').addEventListener('click', logout);
  document.querySelectorAll('[data-tab-link]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); showTab(a.dataset.tabLink); }));
  window.addEventListener('popstate', () => showTab(new URLSearchParams(location.search).get('tab'), false));
  $('genFilter').addEventListener('change', () => loadActivity().catch((e) => toast(e.message, 'bad')));
  setupUsers();
  setupPayments();
  setupPlans();
  api('/api/admin/plans').then((r) => { state.plans = r.plans; }).catch(() => {});
  showTab(new URLSearchParams(location.search).get('tab') || 'overview', false);
}

init();
