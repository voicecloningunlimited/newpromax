import { api, num, rp, esc, fmtDate, fmtDay, countChars, toast, busy, STATUS_LABEL, logout } from './common.js';

const $ = (id) => document.getElementById(id);
const ik = (n) => `<svg class="ik"><use href="#i-${n}"/></svg>`;
const MAKS_DETIK = 30;
const MIN_DETIK = 3;

const state = {
  me: null, plans: [], voices: [], presets: [], payments: [],
  view: 'tts', hasilTab: 'hasil', riwayatCursor: null, riwayatSiap: false,
  berkas: null, // File rekaman referensi yang sudah siap dikirim
};

const HERO = {
  tts: ['Text to Speech', 'Teks jadi Suara AI', 'Ubah tulisan jadi suara manusiawi, cepat dan mudah.'],
  kloning: ['Voice Cloning', 'Kloning Suara AI', 'Tiru suara dari rekaman singkat, cepat dan mudah.'],
  podcast: ['Podcast', 'Podcast Multi Suara', 'Segera hadir: satu naskah, banyak tokoh.'],
};

const TAGS = [
  { label: 'Antusias', tag: '<|emotion:enthusiasm|>', lead: true },
  { label: 'Gembira', tag: '<|emotion:elation|>', lead: true },
  { label: 'Tenang', tag: '<|emotion:contentment|>', lead: true },
  { label: 'Sedih', tag: '<|emotion:sadness|>', lead: true },
  { label: 'Berbisik', tag: '<|style:whispering|>', lead: true },
  { label: 'Pelan', tag: '<|prosody:speed_slow|>', lead: true },
  { label: 'Cepat', tag: '<|prosody:speed_fast|>', lead: true },
  { label: 'Jeda', tag: ' <|prosody:pause|> ' },
  { label: 'Jeda panjang', tag: ' <|prosody:long_pause|> ' },
  { label: 'Tawa', tag: '<|sfx:laughter|>Haha, ' },
  { label: 'Menghela napas', tag: '<|sfx:sigh|>Hmm, ' },
];

/* ================= Ilustrasi ================= */
function acak(benih) {
  return () => ((benih = (benih * 16807) % 2147483647) / 2147483647);
}

function batangGelombang({ x0, x1, cy, tinggi, jumlah, benih, tebal = 4 }) {
  const r = acak(benih);
  const jarak = (x1 - x0) / jumlah;
  let s = '';
  for (let i = 0; i < jumlah; i++) {
    const x = x0 + i * jarak;
    const t = i / (jumlah - 1);
    const selubung = Math.sin(Math.PI * t) ** 0.8;
    const h = Math.max(6, tinggi * selubung * (0.35 + r() * 0.65));
    s += `<rect x="${x.toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${tebal}" height="${h.toFixed(1)}" rx="${tebal / 2}"/>`;
  }
  return s;
}

function seniMikrofon(cx, cy, skala = 1) {
  const s = skala;
  const w = 104 * s, h = 150 * s, x = cx - w / 2, y = cy - h * 0.72;
  let kisi = '';
  for (let i = 1; i < 9; i++) {
    const yy = y + (h * 0.62 / 9) * i + 6 * s;
    kisi += `<line x1="${x + 10 * s}" y1="${yy}" x2="${x + w - 10 * s}" y2="${yy}" stroke="#0b1340" stroke-width="${5 * s}" stroke-linecap="round" opacity=".75"/>`;
  }
  return `
    <clipPath id="kapsul"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2}"/></clipPath>
    <ellipse cx="${cx}" cy="${cy}" rx="${w * 1.05}" ry="${h * 0.95}" fill="url(#pendar)"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2}" fill="url(#badanMic)" stroke="#8fa8ff" stroke-opacity=".55" stroke-width="${2 * s}"/>
    <g clip-path="url(#kapsul)">${kisi}</g>
    <rect x="${x + 12 * s}" y="${y + 10 * s}" width="${14 * s}" height="${h * 0.7}" rx="${7 * s}" fill="#ffffff" opacity=".16"/>
    <rect x="${x - 4 * s}" y="${y + h * 0.66}" width="${w + 8 * s}" height="${14 * s}" rx="${7 * s}" fill="#2a2f8f" stroke="#8fa8ff" stroke-opacity=".5"/>
    <path d="M${x - 16 * s} ${y + h * 0.5} v${16 * s} a${w / 2 + 16 * s} ${w / 2 + 16 * s} 0 0 0 ${w + 32 * s} 0 v-${16 * s}" fill="none" stroke="url(#garisMic)" stroke-width="${9 * s}" stroke-linecap="round"/>
    <rect x="${cx - 8 * s}" y="${y + h + 22 * s}" width="${16 * s}" height="${40 * s}" rx="${6 * s}" fill="url(#garisMic)"/>
    <ellipse cx="${cx}" cy="${y + h + 66 * s}" rx="${46 * s}" ry="${9 * s}" fill="url(#garisMic)" opacity=".9"/>`;
}

// Setiap SVG memakai awalan ID sendiri: gradien dengan ID sama di panel tersembunyi tidak dirender browser
const unik = (svg, awalan) => svg.replace(/(id="|url\(#)([a-zA-Z]+)/g, `$1${awalan}-$2`);

const DEFS = `<defs>
  <linearGradient id="gelombang" x1="0" x2="1"><stop offset="0" stop-color="#3d63ff" stop-opacity=".25"/><stop offset=".5" stop-color="#8b5cf6"/><stop offset="1" stop-color="#3d63ff" stop-opacity=".25"/></linearGradient>
  <linearGradient id="badanMic" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d8bff"/><stop offset=".45" stop-color="#5b3df5"/><stop offset="1" stop-color="#1f1a7a"/></linearGradient>
  <linearGradient id="garisMic" x1="0" x2="1"><stop offset="0" stop-color="#7b4dff"/><stop offset="1" stop-color="#3d63ff"/></linearGradient>
  <radialGradient id="pendar"><stop offset="0" stop-color="#6d4bff" stop-opacity=".55"/><stop offset="1" stop-color="#6d4bff" stop-opacity="0"/></radialGradient>
</defs>`;

function gambarHero() {
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.onerror = gambarHeroVektor; // cadangan kalau gambar tidak ada
  img.src = '/img/hero-kloning.webp';
  $('heroSeni').replaceChildren(img);
}

function gambarHeroVektor() {
  $('heroSeni').innerHTML = unik(`<svg viewBox="0 0 560 300" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${DEFS}
    <g fill="url(#gelombang)">${batangGelombang({ x0: 10, x1: 470, cy: 150, tinggi: 180, jumlah: 46, benih: 5 })}</g>
    ${seniMikrofon(250, 146, 0.95)}</svg>`, 'hero');
}

function seniBulat(id) {
  $(id).innerHTML = unik(`<svg class="seni" viewBox="0 0 300 160" xmlns="http://www.w3.org/2000/svg">${DEFS}
    <g fill="url(#gelombang)">${batangGelombang({ x0: 6, x1: 92, cy: 80, tinggi: 70, jumlah: 11, benih: 3, tebal: 3 })}
    ${batangGelombang({ x0: 208, x1: 294, cy: 80, tinggi: 70, jumlah: 11, benih: 9, tebal: 3 })}</g>
    <circle cx="150" cy="80" r="74" fill="url(#pendar)"/>
    <circle cx="150" cy="80" r="62" fill="#101a4a" stroke="#5b8cff" stroke-opacity=".45" stroke-width="1.5"/>
    <rect x="136" y="44" width="28" height="48" rx="14" fill="url(#badanMic)"/>
    <path d="M124 76 a26 26 0 0 0 52 0" fill="none" stroke="url(#garisMic)" stroke-width="5" stroke-linecap="round"/>
    <rect x="147" y="102" width="6" height="12" rx="3" fill="#5b8cff"/><rect x="136" y="113" width="28" height="5" rx="2.5" fill="#5b8cff"/></svg>`, id);
}

/* ================= Akun, kuota, menu ================= */
function inisial(u) {
  const n = (u.name || u.username || u.email || 'Pengguna').trim();
  const bagian = n.split(/[\s._@]+/).filter(Boolean);
  return ((bagian[0]?.[0] || '') + (bagian[1]?.[0] || '')).toUpperCase() || n[0].toUpperCase();
}

function renderMe() {
  const u = state.me;
  const nama = u.name || u.username || (u.email || '').split('@')[0] || 'Pengguna';
  document.querySelectorAll('[data-nama]').forEach((el) => { el.textContent = nama; });
  document.querySelectorAll('[data-avatar]').forEach((el) => {
    el.textContent = inisial(u);
    if (u.avatar) {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.onload = () => { el.textContent = ''; el.append(img); };
      img.src = u.avatar;
    }
  });

  const maks = Math.max(u.plan_quota, u.char_balance, 1);
  const persen = Math.min(100, (u.char_balance / maks) * 100);
  $('paketNama').textContent = `Paket ${u.plan_name}`;
  $('paketSisa').textContent = `${num(u.char_balance)} karakter tersisa`;
  $('paketBar').style.width = `${persen}%`;
  $('paketBar').classList.toggle('tipis', persen < 10);

  const isiMenu = `
    <div class="kepala-dd"><b>${esc(nama)}</b><small>${[u.username && `@${esc(u.username)}`, u.email ? esc(u.email) : 'Belum ada email'].filter(Boolean).join(' &middot; ')}</small></div>
    <button class="item" type="button" data-view="akun">${ik('akun')}Akun</button>
    <button class="item" type="button" data-view="paket">${ik('kartu')}Paket &amp; tagihan</button>
    ${u.role === 'admin' ? `<a href="/admin">${ik('perisai')}Panel admin</a>` : ''}
    <a href="/">${ik('rumah')}Beranda</a>
    <button class="item" type="button" data-keluar>${ik('keluar')}Keluar</button>`;
  $('userMenu').innerHTML = isiMenu;
  $('sideUserMenu').innerHTML = isiMenu;
  perbaruiInfoTts();
}

async function muatUlangMe() {
  state.me = (await api('/api/me')).user;
  renderMe();
}

function pasangDropdown(tombolId, menuId, saatBuka) {
  const tombol = $(tombolId), menu = $(menuId);
  tombol.addEventListener('click', (e) => {
    e.stopPropagation();
    const buka = menu.hidden;
    tutupSemuaDropdown();
    menu.hidden = !buka;
    tombol.setAttribute('aria-expanded', String(buka));
    if (buka && saatBuka) saatBuka();
  });
}
function tutupSemuaDropdown() {
  document.querySelectorAll('.dropdown').forEach((m) => { m.hidden = true; });
  document.querySelectorAll('[aria-haspopup]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function renderNotif() {
  const p = state.payments;
  const pending = p.filter((x) => x.status === 'pending');
  $('notifTitik').hidden = !pending.length;
  const nama = (id) => state.plans.find((x) => x.id === id)?.name || id;
  const item = p.slice(0, 5).map((x) => {
    if (x.status === 'pending') {
      return `<div class="notif"><b>Menunggu pembayaran paket ${esc(nama(x.plan_id))}</b><small>${rp(x.amount)}, dibuat ${fmtDate(x.created_at)}</small>
        <div class="aksi"><a href="${esc(x.payment_url)}">Bayar sekarang</a><button type="button" data-cek="${esc(x.id)}">Cek status</button></div></div>`;
    }
    if (x.status === 'paid') {
      return `<div class="notif"><b>Paket ${esc(nama(x.plan_id))} aktif</b><small>${num(x.char_quota)} karakter ditambahkan, ${fmtDate(x.paid_at)}</small></div>`;
    }
    return `<div class="notif"><b>Tagihan paket ${esc(nama(x.plan_id))} ${esc(STATUS_LABEL[x.status]?.[0].toLowerCase() || x.status)}</b><small>${fmtDate(x.created_at)}</small></div>`;
  }).join('');
  $('notifMenu').innerHTML = item || '<p class="notif-kosong">Belum ada notifikasi.</p>';
}

/* ================= Tampilan ================= */
const LAMA = { studio: 'tts', voices: 'kloning', history: 'tts', billing: 'paket' };

function setView(v, dorong = true) {
  v = LAMA[v] || v;
  if (!['tts', 'kloning', 'podcast', 'paket', 'akun'].includes(v)) v = 'tts';
  state.view = v;
  $('studio').hidden = v === 'paket' || v === 'akun';
  $('halPaket').hidden = v !== 'paket';
  $('halAkun').hidden = v !== 'akun';

  document.querySelectorAll('.side-nav [data-view]').forEach((a) => {
    if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-bar [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== v; });

  if (HERO[v]) {
    const [lencana, judul, sub] = HERO[v];
    $('heroLencana').textContent = lencana;
    $('heroJudul').textContent = judul;
    $('heroSub').textContent = sub;
  }
  if (v === 'paket') muatPaket().catch((e) => toast(e.message, 'bad'));
  if (v === 'akun') muatAkun().catch((e) => toast(e.message, 'bad'));

  if (dorong) {
    const url = new URL(location.href);
    url.searchParams.set('tab', v);
    ['plan', 'payment'].forEach((k) => url.searchParams.delete(k));
    history.pushState(null, '', url);
  }
  tutupSidebar();
  tutupSemuaDropdown();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function setHasilTab(t) {
  state.hasilTab = t;
  document.querySelectorAll('[data-hasil]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.hasil === t)));
  document.querySelectorAll('[data-hasil-panel]').forEach((p) => { p.hidden = p.dataset.hasilPanel !== t; });
  if (t === 'riwayat' && !state.riwayatSiap) muatRiwayat(true).catch((e) => toast(e.message, 'bad'));
}

function bukaSidebar() { $('side').classList.add('buka'); $('tiraiSide').hidden = false; }
function tutupSidebar() { $('side').classList.remove('buka'); $('tiraiSide').hidden = true; }

/* ================= Suara ================= */
async function muatSuara() {
  const r = await api('/api/voices');
  state.voices = r.voices;
  state.presets = r.presets;
  renderPilihanSuara();
  renderDaftarSuara();
}

function renderPilihanSuara(pilih) {
  const sel = $('suaraTts');
  const lama = pilih || sel.value;
  const milik = state.voices.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('');
  const bawaan = state.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}: ${esc(p.desc)}</option>`).join('');
  sel.innerHTML = (milik ? `<optgroup label="Suara saya">${milik}</optgroup>` : '') + `<optgroup label="Suara bawaan (bahasa Inggris)">${bawaan}</optgroup>`;
  if (lama && [...sel.options].some((o) => o.value === lama)) sel.value = lama;
}

function renderDaftarSuara() {
  const batas = state.me?.max_voices;
  $('jumlahSuara').textContent = batas != null ? `${state.voices.length} dari ${batas}` : `${state.voices.length} tersimpan`;
  $('daftarSuara').innerHTML = state.voices.length
    ? state.voices.map((v) => `
      <div class="suara-item" data-id="${esc(v.id)}">
        <div class="baris"><b>${esc(v.name)}</b><small>${fmtDay(v.created_at)}</small>
          <button class="btn hantu kecil" type="button" data-aksi="pakai">Pakai di TTS</button>
          <button class="btn bahaya kecil" type="button" data-aksi="hapus" aria-label="Hapus ${esc(v.name)}">${ik('hapus')}</button></div>
        <audio controls preload="none" src="${esc(v.sample_url)}"></audio>
      </div>`).join('')
    : '<p class="ket" style="color:var(--muted);font-size:13px">Belum ada suara tersimpan. Suara yang kamu kloning akan muncul di sini dan bisa dipakai lagi kapan saja.</p>';
  if (state.voices.length) $('suaraSaya').open = true;
}

/* ================= TTS ================= */
function perbaruiInfoTts() {
  if (!state.me) return;
  const teks = $('naskahTts').value;
  const dipakai = countChars(teks);
  const lebih = dipakai > state.me.char_balance;
  $('hitungTts').textContent = `${num(teks.length)}/5.000`;
  $('infoTts').innerHTML = `<span${lebih ? ' class="lebih"' : ''}><b>${num(dipakai)}</b> karakter akan dipakai</span><span>Sisa kuota <b>${num(state.me.char_balance)}</b></span>`;
}

function pasangTts() {
  const ta = $('naskahTts');
  const chip = (t) => `<button type="button" data-i="${TAGS.indexOf(t)}">${esc(t.label)}</button>`;
  $('tagTts').innerHTML = `<span class="label">Gaya:</span>${TAGS.filter((t) => t.lead).map(chip).join('')}<span class="label" style="margin-left:6px">Sisipkan:</span>${TAGS.filter((t) => !t.lead).map(chip).join('')}`;
  $('tagTts').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const t = TAGS[+b.dataset.i];
    if (t.lead) {
      ta.value = t.tag + ta.value.replace(/^(<\|(emotion|style|prosody:speed|prosody:pitch|prosody:expressive)[^|]*\|>)+/, '');
      ta.focus();
      ta.setSelectionRange(t.tag.length, t.tag.length);
    } else {
      ta.setRangeText(t.tag, ta.selectionStart, ta.selectionEnd, 'end');
      ta.focus();
    }
    perbaruiInfoTts();
  });
  ta.addEventListener('input', perbaruiInfoTts);

  $('buatTts').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const text = ta.value.trim();
    if (!text) { toast('Tulis naskah dulu, lalu klik Buat Suara.', 'bad'); ta.focus(); return; }
    await buatSuara(text, $('suaraTts').value);
  }));
}

async function buatSuara(text, voice) {
  try {
    const r = await api('/api/tts', { method: 'POST', body: { text, voice } });
    state.me.char_balance = r.char_balance;
    renderMe();
    tambahHasil(r.generation);
    toast('Suara selesai dibuat.', 'ok');
    return true;
  } catch (err) {
    toast(err.message, 'bad', 7000);
    if (err.code === 'quota') setTimeout(() => setView('paket'), 900);
    return false;
  }
}

/* ================= Hasil & riwayat ================= */
function kartuHasil(g, baru) {
  return `<article class="hasil-item${baru ? ' baru' : ''}" data-id="${esc(g.id)}">
    <audio controls preload="${baru ? 'auto' : 'none'}" src="${esc(g.url)}"></audio>
    <p>${esc(g.text)}</p>
    <div class="hasil-meta"><span>${esc(g.voice_label)}, ${num(g.chars)} karakter, ${fmtDate(g.created_at)}</span>
      <span class="tombol"><a class="btn hantu kecil" href="${esc(g.url)}?download=1">${ik('unduh')}Unduh</a>
      ${baru ? '' : `<button class="btn bahaya kecil" type="button" data-hapus-gen aria-label="Hapus">${ik('hapus')}</button>`}</span></div>
  </article>`;
}

function tambahHasil(g) {
  $('hasilKosong').hidden = true;
  const daftar = $('daftarHasil');
  daftar.hidden = false;
  daftar.querySelectorAll('.baru').forEach((el) => el.classList.remove('baru'));
  daftar.insertAdjacentHTML('afterbegin', kartuHasil(g, true));
  setHasilTab('hasil');
  state.riwayatSiap = false;
  daftar.querySelector('audio')?.play().catch(() => {});
  if (window.innerWidth < 1180) daftar.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function muatRiwayat(ulang) {
  if (ulang) { state.riwayatCursor = null; $('daftarRiwayat').innerHTML = ''; }
  const q = new URLSearchParams({ limit: '15' });
  if (state.riwayatCursor) q.set('before', state.riwayatCursor);
  const r = await api(`/api/generations?${q}`);
  state.riwayatSiap = true;
  if (ulang && !r.generations.length) {
    $('daftarRiwayat').innerHTML = '<p class="notif-kosong">Belum ada audio yang pernah dibuat.</p>';
  }
  $('daftarRiwayat').insertAdjacentHTML('beforeend', r.generations.map((g) => kartuHasil(g, false)).join(''));
  const akhir = r.generations.at(-1);
  if (akhir) state.riwayatCursor = akhir.created_at;
  $('muatLagi').hidden = !r.has_more;
}

/* ================= Kloning ================= */
const EKSTENSI_LANGSUNG = ['wav', 'mp3', 'flac', 'ogg', 'opus', 'aac'];

function durasiAudio(blob) {
  return new Promise((selesai) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { URL.revokeObjectURL(url); selesai(a.duration); };
    a.onerror = () => { URL.revokeObjectURL(url); selesai(NaN); };
    a.src = url;
  });
}

/** Ubah audio apa pun yang bisa diputar browser (M4A, WebM, dll.) menjadi WAV mono 24 kHz, dipotong maks. 30 detik. */
async function keWav(blob, maksDetik = MAKS_DETIK) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const rate = 24000;
  const rasio = buf.sampleRate / rate;
  const panjangSumber = Math.min(buf.length, Math.floor(maksDetik * buf.sampleRate));
  const len = Math.floor(panjangSumber / rasio);
  const kanal = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c));
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const dari = Math.floor(i * rasio);
    const ke = Math.max(dari + 1, Math.floor((i + 1) * rasio));
    let jumlah = 0;
    for (let j = dari; j < ke && j < panjangSumber; j++) for (const ch of kanal) jumlah += ch[j];
    const s = Math.max(-1, Math.min(1, jumlah / ((ke - dari) * kanal.length)));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const h = new DataView(new ArrayBuffer(44));
  const tulis = (o, t) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  tulis(0, 'RIFF'); h.setUint32(4, 36 + pcm.byteLength, true); tulis(8, 'WAVE');
  tulis(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  tulis(36, 'data'); h.setUint32(40, pcm.byteLength, true);
  return { file: new File([h.buffer, pcm.buffer], 'referensi.wav', { type: 'audio/wav' }), durasi: len / rate };
}

async function siapkanBerkas(sumber, nama) {
  const ext = (nama || sumber.name || '').split('.').pop().toLowerCase();
  let durasi = await durasiAudio(sumber);
  let file = sumber;
  let catatan = '';
  const perluUbah = !EKSTENSI_LANGSUNG.includes(ext) || !(durasi <= MAKS_DETIK + 0.5) || sumber.size > 9.5 * 1024 * 1024;
  if (perluUbah) {
    try {
      const hasil = await keWav(sumber);
      if (durasi > MAKS_DETIK + 0.5) catatan = `dipotong ke ${MAKS_DETIK} detik pertama`;
      else if (!EKSTENSI_LANGSUNG.includes(ext)) catatan = 'diubah ke WAV';
      file = hasil.file;
      durasi = hasil.durasi;
    } catch {
      throw new Error('Audio ini tidak bisa dibaca browser. Coba format MP3 atau WAV.');
    }
  }
  if (durasi < MIN_DETIK) throw new Error(`Rekaman terlalu pendek (${durasi.toFixed(1)} detik). Gunakan 10 sampai 20 detik ucapan.`);
  return { file, durasi, catatan, namaTampil: nama || sumber.name };
}

async function pakaiBerkas(sumber, nama) {
  try {
    const b = await siapkanBerkas(sumber, nama);
    state.berkas = b.file;
    $('berkasNama').textContent = b.namaTampil;
    $('berkasDurasi').textContent = `${b.durasi.toFixed(1)} dtk${b.catatan ? `, ${b.catatan}` : ''}`;
    const p = $('pratinjau');
    if (p.src) URL.revokeObjectURL(p.src);
    p.src = URL.createObjectURL(b.file);
    $('berkas').hidden = false;
    $('areaUnggah').hidden = true;
    document.querySelector('.atau-rekam').hidden = true;
    $('rekamBtn').hidden = true;
    if (b.durasi > 20.5 && !b.catatan) toast('Rekaman lebih dari 20 detik. Masih bisa dipakai, tapi 10 sampai 20 detik biasanya paling mirip.');
    $('namaSuara').focus();
  } catch (err) {
    toast(err.message, 'bad', 6000);
  }
}

function lepasBerkas() {
  state.berkas = null;
  $('fileRef').value = '';
  $('berkas').hidden = true;
  $('areaUnggah').hidden = false;
  document.querySelector('.atau-rekam').hidden = false;
  $('rekamBtn').hidden = false;
  $('rekamLabel').textContent = 'Rekam langsung dari mikrofon';
}

function pasangKloning() {
  const area = $('areaUnggah');
  $('fileRef').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) pakaiBerkas(f); });
  area.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileRef').click(); } });
  ['dragenter', 'dragover'].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('seret'); }));
  ['dragleave', 'drop'].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.remove('seret'); }));
  area.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!f.type.startsWith('audio/') && !/\.(mp3|wav|m4a|flac|aac|ogg|opus)$/i.test(f.name)) { toast('Pilih file audio (MP3, WAV, M4A, atau FLAC).', 'bad'); return; }
    pakaiBerkas(f);
  });
  $('hapusBerkas').addEventListener('click', lepasBerkas);
  $('teksKloning').addEventListener('input', (e) => { $('hitungKloning').textContent = `${num(e.target.value.length)}/5.000`; });

  // Rekam dari mikrofon
  let perekam = null, pewaktu = null;
  $('rekamBtn').addEventListener('click', async () => {
    if (perekam?.state === 'recording') { perekam.stop(); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast('Izin mikrofon ditolak. Izinkan mikrofon di pengaturan browser, atau upload file.', 'bad', 6000);
      return;
    }
    const potongan = [];
    perekam = new MediaRecorder(stream);
    perekam.ondataavailable = (e) => e.data.size && potongan.push(e.data);
    perekam.onstop = () => {
      clearInterval(pewaktu);
      stream.getTracks().forEach((t) => t.stop());
      $('rekamBtn').classList.remove('merekam');
      pakaiBerkas(new Blob(potongan, { type: perekam.mimeType }), 'Rekaman mikrofon.webm');
    };
    perekam.start();
    const mulai = Date.now();
    $('rekamBtn').classList.add('merekam');
    $('rekamLabel').textContent = 'Berhenti merekam (0 dtk)';
    pewaktu = setInterval(() => {
      const d = Math.floor((Date.now() - mulai) / 1000);
      $('rekamLabel').textContent = `Berhenti merekam (${d} dtk)`;
      if (d >= MAKS_DETIK) perekam.stop();
    }, 250);
  });

  // Proses: simpan suara, lalu (opsional) langsung bacakan teks
  $('formKloning').addEventListener('submit', (e) => {
    e.preventDefault();
    const nama = $('namaSuara').value.trim();
    const transkrip = $('transkrip').value.trim();
    const teks = $('teksKloning').value.trim();
    if (!state.berkas) { toast('Upload atau rekam audio referensi dulu.', 'bad'); $('areaUnggah').focus(); return; }
    if (!nama) { toast('Beri nama untuk suara ini.', 'bad'); $('namaSuara').focus(); return; }
    if (transkrip.length < 3) { toast('Tulis transkrip rekaman kata per kata.', 'bad'); $('transkrip').focus(); return; }
    if (!$('izin').checked) { toast('Centang pernyataan izin atas suara ini.', 'bad'); return; }
    busy($('prosesKloning'), async () => {
      const fd = new FormData();
      fd.append('name', nama);
      fd.append('ref_text', transkrip);
      fd.append('consent', 'yes');
      fd.append('audio', state.berkas, state.berkas.name || 'referensi.wav');
      let suara;
      try {
        suara = (await api('/api/voices', { method: 'POST', form: fd })).voice;
      } catch (err) { toast(err.message, 'bad', 7000); return; }
      state.voices.unshift(suara);
      renderDaftarSuara();
      renderPilihanSuara(suara.id);
      toast(`Suara "${suara.name}" tersimpan.`, 'ok');
      if (teks) await buatSuara(teks, suara.id);
      e.target.reset();
      $('hitungKloning').textContent = '0/5.000';
      lepasBerkas();
    });
  });

  $('daftarSuara').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-aksi]');
    if (!b) return;
    const id = b.closest('[data-id]').dataset.id;
    const v = state.voices.find((x) => x.id === id);
    if (b.dataset.aksi === 'pakai') {
      renderPilihanSuara(id);
      setView('tts');
      $('naskahTts').focus();
    } else if (confirm(`Hapus suara "${v.name}"? Audio yang sudah dibuat tetap ada di Riwayat.`)) {
      busy(b, async () => {
        try {
          await api(`/api/voices/${id}`, { method: 'DELETE' });
          state.voices = state.voices.filter((x) => x.id !== id);
          renderDaftarSuara();
          renderPilihanSuara();
          toast('Suara dihapus.');
        } catch (err) { toast(err.message, 'bad'); }
      });
    }
  });
}

/* ================= Paket & tagihan ================= */
async function muatPembayaran() {
  const [{ plans }, { payments }] = await Promise.all([api('/api/plans'), api('/api/payments')]);
  state.plans = plans;
  state.payments = payments;
  renderNotif();
}

async function muatPaket() {
  await muatPembayaran();
  const u = state.me;
  $('ringkasNama').textContent = `Paket ${u.plan_name}`;
  $('ringkasKet').textContent = u.plan_expires_at ? `Aktif sampai ${fmtDay(u.plan_expires_at)}.` : 'Kuota gratis dari pendaftaran, tanpa batas waktu.';
  $('ringkasSisa').textContent = num(u.char_balance);

  const terbesar = Math.max(1, ...state.plans.map((p) => p.char_quota));
  $('kisiPaket').innerHTML = state.plans.map((p) => {
    const gratis = p.price === 0;
    const aktif = p.id === u.plan_id;
    const fitur = p.features.length ? p.features.map((f) => `<li>${esc(f)}</li>`).join('') : '<li class="menyusul">Kelebihan paket segera diumumkan</li>';
    const isi = Math.max(3, Math.round((p.char_quota / terbesar) * 100));
    const label = gratis ? 'Bonus pendaftaran' : aktif && u.plan_expires_at ? `Tambah ${p.name}` : `Beli ${p.name}`;
    return `<article class="paket${p.is_featured ? ' unggulan' : ''}${aktif ? ' aktif' : ''}">
      ${aktif ? '<span class="pita hijau">Paketmu</span>' : p.is_featured ? '<span class="pita">Paling populer</span>' : ''}
      <h3>${esc(p.name)}</h3>
      <div class="harga">${gratis ? 'Gratis' : rp(p.price)}<small>${gratis ? 'sekali saat daftar' : `per ${p.duration_days} hari`}</small></div>
      <div class="kuota"><b>${num(p.char_quota)} karakter</b><small>sekitar ${Math.max(1, Math.round(p.char_quota / 800))} menit audio</small>
        <span class="kuota-bar"><i style="width:${isi}%"></i></span></div>
      <ul>${fitur}</ul>
      <button class="btn ${p.is_featured ? '' : 'hantu'}" type="button" data-beli="${esc(p.id)}" ${gratis ? 'disabled' : ''}>${esc(label)}</button>
    </article>`;
  }).join('');

  const namaPaket = (id) => state.plans.find((x) => x.id === id)?.name || id;
  $('daftarTagihan').innerHTML = state.payments.length
    ? `<div class="tabel-bungkus"><table><thead><tr><th>Tanggal</th><th>Paket</th><th class="num">Kuota</th><th class="num">Jumlah</th><th>Status</th><th></th></tr></thead><tbody>
      ${state.payments.map((x) => {
        const [label, jenis] = STATUS_LABEL[x.status] || [x.status, 'dim'];
        const aksi = x.status === 'pending'
          ? `<a class="btn kecil" href="${esc(x.payment_url)}">Bayar</a> <button class="btn hantu kecil" type="button" data-cek="${esc(x.id)}">Cek status</button>` : '';
        return `<tr><td>${fmtDate(x.created_at)}</td><td>${esc(namaPaket(x.plan_id))}</td><td class="num">${num(x.char_quota)}</td><td class="num">${rp(x.amount)}</td><td><span class="pil ${jenis}">${label}</span></td><td>${aksi}</td></tr>`;
      }).join('')}</tbody></table></div>`
    : '<p style="color:var(--muted);font-size:13px">Belum ada tagihan.</p>';
}

let paketDipilih = null;
function bukaBeli(id) {
  const p = state.plans.find((x) => x.id === id);
  if (!p || p.price === 0) return;
  paketDipilih = id;
  $('beliJudul').textContent = `Beli paket ${p.name}`;
  $('beliKet').textContent = `${num(p.char_quota)} karakter seharga ${rp(p.price)}, berlaku ${p.duration_days} hari. Kamu akan diarahkan ke halaman pembayaran Mayar.`;
  $('formBeli').phone.value = state.me.phone || '';
  $('dlgBeli').showModal();
}

async function cekTagihan(id, diam) {
  try {
    const { status } = await api(`/api/payments/${id}/verify`, { method: 'POST' });
    if (status === 'paid') {
      toast('Pembayaran diterima. Kuota sudah ditambahkan.', 'ok', 7000);
      await muatUlangMe();
      if (state.view === 'paket') await muatPaket(); else await muatPembayaran();
    } else if (!diam) {
      toast(status === 'pending' ? 'Pembayaran belum terkonfirmasi. Status akan diperbarui otomatis.' : `Status tagihan: ${STATUS_LABEL[status]?.[0] || status}.`);
      if (state.view === 'paket') await muatPaket(); else await muatPembayaran();
    }
    return status;
  } catch (err) {
    if (!diam) toast(err.message, 'bad');
    return null;
  }
}

async function pantauTagihan(id) {
  toast('Memeriksa pembayaranmu…');
  for (let i = 0; i < 8; i++) {
    const s = await cekTagihan(id, true);
    if (s === 'paid' || s === 'expired') return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  toast('Pembayaran belum terkonfirmasi. Kalau sudah membayar, kuota masuk otomatis dalam beberapa menit.', 'info', 8000);
}

function pasangPaket() {
  $('kisiPaket').addEventListener('click', (e) => { const b = e.target.closest('[data-beli]'); if (b) bukaBeli(b.dataset.beli); });
  $('formBeli').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'bayar') return;
    e.preventDefault();
    const phone = e.currentTarget.phone.value;
    busy($('tombolBayar'), async () => {
      try {
        const r = await api('/api/checkout', { method: 'POST', body: { plan_id: paketDipilih, phone } });
        location.href = r.payment_url;
      } catch (err) {
        toast(err.message, 'bad', 7000);
        if (err.code === 'need_email') { $('dlgBeli').close(); setView('akun'); }
      }
    });
  });
}

/* ================= Akun ================= */
const syaratPassword = (p) => p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p);

async function muatAkun() {
  const { account: a } = await api('/api/account');
  state.akun = a;
  const metode = [a.google && 'Google', a.has_password && (a.username ? `username @${a.username}` : 'email + password')].filter(Boolean);
  $('akunSub').textContent = `Masuk lewat ${metode.join(' atau ') || '-'} · bergabung ${fmtDay(a.created_at)}`;
  renderKartuEmail(false);
  renderKartuPassword();
}

function formEmail(nilai, tombol) {
  return `<form id="formEmail" novalidate>
    <label><span>Alamat email</span><input class="isian" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="nama@email.com" value="${esc(nilai || '')}" required></label>
    <button class="btn" type="submit"><span>${esc(tombol)}</span></button>
  </form>`;
}

function renderKartuEmail(bukaForm) {
  const a = state.akun;
  let isi = '';
  if (a.email) {
    isi += `<div class="email-kini"><b>${esc(a.email)}</b>${a.email_verified ? '<span class="pil ok">Terverifikasi</span>' : '<span class="pil warn">Belum diverifikasi</span>'}</div>`;
    isi += '<p class="redup">Dipakai untuk bukti pembayaran dari Mayar dan untuk memulihkan password jika lupa.</p>';
  } else {
    isi += `<div class="catatan warn"><b>Akunmu belum tersambung ke email.</b> Sambungkan agar bisa membeli paket, menerima bukti pembayaran, dan memulihkan password jika lupa.</div>`;
  }
  if (a.pending_email) {
    isi += `<div class="catatan info">Link konfirmasi sudah dikirim ke <b>${esc(a.pending_email)}</b>. Buka email itu dan klik linknya (berlaku 24 jam). Tidak ada di kotak masuk? Cek folder Spam, atau kirim ulang di bawah.</div>`;
  }
  if (!a.email || a.pending_email || bukaForm) {
    isi += formEmail(a.pending_email || (bukaForm ? '' : ''), a.pending_email ? 'Kirim ulang link konfirmasi' : a.email ? 'Kirim link ke email baru' : 'Sambungkan email');
  } else if (!a.google) {
    isi += '<button class="tautan-btn" type="button" id="gantiEmail">Ganti email</button>';
  } else {
    isi += '<p class="redup">Akun ini masuk lewat Google, jadi emailnya mengikuti akun Google tersebut.</p>';
  }
  $('akunEmail').innerHTML = isi;
}

function renderKartuPassword() {
  const a = state.akun;
  $('akunPassword').innerHTML = `
    <p class="redup">${a.has_password
      ? 'Setelah password diganti, perangkat lain otomatis keluar. Perangkat ini tetap masuk.'
      : 'Akunmu belum punya password. Buat password agar bisa masuk dengan email dan password juga, selain lewat Google.'}</p>
    <form id="formPassword" novalidate>
      ${a.has_password ? '<label><span>Password saat ini</span><input class="isian" name="current_password" type="password" autocomplete="current-password" required></label>' : ''}
      <label><span>Password baru</span><input class="isian" name="password" type="password" autocomplete="new-password" required></label>
      <label><span>Ulangi password baru</span><input class="isian" name="password_confirm" type="password" autocomplete="new-password" required></label>
      <p class="redup" style="font-size:12.5px">Minimal 8 karakter, berisi huruf dan angka.</p>
      <button class="btn" type="submit"><span>${a.has_password ? 'Simpan password baru' : 'Buat password'}</span></button>
    </form>`;
}

function pasangAkun() {
  $('akunEmail').addEventListener('click', (e) => {
    if (e.target.closest('#gantiEmail')) { renderKartuEmail(true); $('formEmail').email.focus(); }
  });
  $('akunEmail').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { toast('Alamat email tidak valid.', 'bad'); f.email.focus(); return; }
    busy(f.querySelector('button[type=submit]'), async () => {
      try {
        const r = await api('/api/account/email', { method: 'POST', body: { email } });
        state.akun.pending_email = r.pending_email;
        renderKartuEmail(false);
        toast(`Link konfirmasi dikirim ke ${r.pending_email}.`, 'ok', 6000);
      } catch (err) { toast(err.message, 'bad', 6000); }
    });
  });
  $('akunPassword').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const data = { password: f.password.value, password_confirm: f.password_confirm.value };
    if (f.current_password) data.current_password = f.current_password.value;
    if (f.current_password && !data.current_password) { toast('Isi password saat ini.', 'bad'); return; }
    if (!syaratPassword(data.password)) { toast('Password baru minimal 8 karakter dan berisi huruf serta angka.', 'bad'); return; }
    if (data.password !== data.password_confirm) { toast('Ulangi password belum sama dengan password baru.', 'bad'); return; }
    busy(f.querySelector('button[type=submit]'), async () => {
      try {
        await api('/api/account/password', { method: 'POST', body: data });
        toast(state.akun.has_password ? 'Password berhasil diganti.' : 'Password berhasil dibuat.', 'ok');
        state.akun.has_password = true;
        renderKartuPassword();
      } catch (err) { toast(err.message, 'bad'); }
    });
  });
}

/* ================= Mulai ================= */
function pasangNavigasi() {
  document.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { e.preventDefault(); setView(v.dataset.view); return; }
    const h = e.target.closest('[data-hasil]');
    if (h) { setHasilTab(h.dataset.hasil); return; }
    if (e.target.closest('[data-keluar]')) { logout(); return; }
    const c = e.target.closest('[data-cek]');
    if (c) { busy(c, () => cekTagihan(c.dataset.cek, false)); return; }
    const hg = e.target.closest('[data-hapus-gen]');
    if (hg && confirm('Hapus audio ini secara permanen?')) {
      const item = hg.closest('[data-id]');
      busy(hg, async () => {
        try { await api(`/api/generations/${item.dataset.id}`, { method: 'DELETE' }); item.remove(); toast('Audio dihapus.'); }
        catch (err) { toast(err.message, 'bad'); }
      });
      return;
    }
    if (!e.target.closest('.dropdown')) tutupSemuaDropdown();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { tutupSemuaDropdown(); tutupSidebar(); } });
  pasangDropdown('userBtn', 'userMenu');
  pasangDropdown('sideUserBtn', 'sideUserMenu');
  pasangDropdown('notifBtn', 'notifMenu', () => muatPembayaran().catch(() => {}));
  $('menuBtn').addEventListener('click', bukaSidebar);
  $('tiraiSide').addEventListener('click', tutupSidebar);
  $('muatLagi').addEventListener('click', (e) => busy(e.currentTarget, () => muatRiwayat(false).catch((err) => toast(err.message, 'bad'))));
  window.addEventListener('popstate', () => setView(new URLSearchParams(location.search).get('tab') || 'tts', false));
}

async function init() {
  $('tahun').textContent = new Date().getFullYear();
  gambarHero();
  seniBulat('seniKosong');
  seniBulat('seniPodcast');
  pasangNavigasi();
  pasangTts();
  pasangKloning();
  pasangPaket();
  pasangAkun();

  try {
    await muatUlangMe();
  } catch (e) {
    if (e.status === 401) { location.href = '/auth/google?next=/app'; return; }
    toast(e.message, 'bad');
    return;
  }

  const q = new URLSearchParams(location.search);
  const tabAwal = q.get('tab') || 'tts';
  setView(tabAwal, false);
  if (tabAwal === 'history') setHasilTab('riwayat');

  muatSuara().catch((e) => toast(e.message, 'bad'));
  muatPembayaran().catch(() => {});

  if (q.get('welcome') || q.get('verified')) {
    toast(q.get('welcome')
      ? `Email terverifikasi. Selamat datang, ${state.me.name || state.me.username || ''}! 10.000 karakter gratis sudah masuk.`
      : 'Email kamu sudah terverifikasi.', 'ok', 7000);
    const bersih = new URL(location.href);
    bersih.searchParams.delete('welcome');
    bersih.searchParams.delete('verified');
    history.replaceState(null, '', bersih);
  }
  const hasilEmail = q.get('email');
  if (hasilEmail) {
    const pesan = {
      ok: ['Email berhasil disambungkan ke akunmu.', 'ok'],
      gagal: ['Link konfirmasi sudah dipakai atau kedaluwarsa. Kirim ulang dari halaman Akun.', 'bad'],
      dipakai: ['Email itu sudah dipakai akun lain. Coba alamat email lain.', 'bad'],
    }[hasilEmail];
    if (pesan) toast(pesan[0], pesan[1], 7000);
    const bersih = new URL(location.href);
    bersih.searchParams.delete('email');
    history.replaceState(null, '', bersih);
  }
  if (q.get('payment')) pantauTagihan(q.get('payment'));
  const mauPaket = q.get('plan');
  if (mauPaket && state.view === 'paket') {
    const tunggu = setInterval(() => { if (state.plans.length) { clearInterval(tunggu); bukaBeli(mauPaket); } }, 100);
    setTimeout(() => clearInterval(tunggu), 8000);
  }
}

init();
