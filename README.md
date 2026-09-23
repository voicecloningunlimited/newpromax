# Voice Promax

Website voice cloning dengan Boson AI (Higgs TTS 3), login Google atau username/password dengan verifikasi email, dan pembayaran Mayar.
Seluruhnya berjalan di Cloudflare: Workers, Static Assets, D1, R2, Email Service, dan Cron Triggers.
Tidak ada dependensi npm dan tidak ada langkah build.

## Struktur

```
voicepromax/
├── wrangler.jsonc          Konfigurasi Cloudflare (Worker, assets, D1, R2, cron, variabel)
├── schema.sql              Tabel database + 5 paket awal (Free, Lite, Starter, Pro, Studio)
├── migrations/             Migrasi untuk database yang dibuat dengan versi lama
├── .dev.vars.example       Contoh secret untuk uji lokal
├── src/
│   ├── index.js            Router, penjaga halaman /app dan /admin, handler cron
│   ├── lib/
│   │   ├── auth.js         Login Google (OAuth), sesi, bonus pendaftaran
│   │   ├── password.js     Hash & validasi password, username, email
│   │   ├── email.js        Kirim email + template verifikasi/reset
│   │   ├── ratelimit.js    Pembatas percobaan (disimpan di D1)
│   │   ├── boson.js        Klien Boson: text-to-speech dan simpan suara klon
│   │   ├── mayar.js        Klien Mayar: buat dan cek invoice
│   │   ├── payments.js     Verifikasi pembayaran, aktivasi paket, cron
│   │   └── util.js         Fungsi bantu
│   └── routes/
│       ├── account.js      Daftar, masuk, verifikasi, lupa & reset password
│       ├── api.js          API pengguna + webhook Mayar
│       └── admin.js        API admin
└── public/
    ├── index.html          Halaman utama Voice Promax (harga diisi dari /api/plans)
    ├── app.html            Studio pengguna (tema gelap: TTS, Kloning, Podcast, Hasil/Riwayat, Paket)
    ├── admin.html          Panel admin
    └── assets/             CSS dan JavaScript halaman (studio.css + studio.js untuk Studio)
```

## Yang perlu disiapkan

1. **Akun Cloudflare** (paket gratis cukup untuk mulai) dan Node.js 18+ di komputer untuk menjalankan `npx wrangler`.
2. **API key Boson AI** dari https://docs.boson.ai/set-up-your-account
3. **API key Mayar** dari https://web.mayar.id/api-keys (untuk uji coba: https://web.mayar.io)
4. **Google OAuth Client**, langkahnya di bawah.

### Membuat Google OAuth Client

1. Buka https://console.cloud.google.com → buat project baru.
2. **APIs & Services → OAuth consent screen**: pilih *External*, isi nama aplikasi "Voice Promax", email dukungan, dan domain. Scope cukup `openid`, `email`, `profile`. Setelah siap, klik **Publish app**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: *Web application*
   - Authorized redirect URIs:
     - `https://DOMAIN-ANDA/auth/google/callback`
     - `https://voicepromax.NAMA-AKUN.workers.dev/auth/google/callback` (opsional)
     - `http://localhost:8787/auth/google/callback` (untuk uji lokal)
4. Simpan **Client ID** dan **Client Secret**.

## Deploy

```bash
# 1. Login ke Cloudflare
npx wrangler login

# 2. Buat database, lalu salin "database_id" dari output ke wrangler.jsonc
npx wrangler d1 create voicepromax-db

# 3. Buat bucket untuk file audio
npx wrangler r2 bucket create voicepromax-audio

# 4. Buat tabel dan paket awal
npx wrangler d1 execute voicepromax-db --remote --file=./schema.sql

# 5. Isi secret satu per satu (akan diminta nilainya)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put BOSON_API_KEY
npx wrangler secret put MAYAR_API_KEY
npx wrangler secret put MAYAR_WEBHOOK_TOKEN   # string acak panjang buatan Anda sendiri

# 6. Deploy
npx wrangler deploy
```

Sebelum deploy, ubah bagian `vars` di `wrangler.jsonc`:

| Variabel | Isi |
| --- | --- |
| `APP_URL` | Alamat website, misal `https://voicepromax.com` (dipakai untuk tautan kembali dari Mayar) |
| `MAYAR_API_BASE` | Produksi `https://api.mayar.id/hl/v1`, sandbox `https://api.mayar.io/hl/v1` |
| `ADMIN_EMAILS` | Email Google admin, pisahkan dengan koma. Otomatis jadi admin saat login |

Untuk membuat token webhook acak: `openssl rand -hex 24`.

### Email verifikasi (Cloudflare Email Service)

Email verifikasi dan reset password dikirim langsung oleh Worker lewat Cloudflare Email Service, tanpa layanan email pihak ketiga. Syaratnya:

1. **Workers Paid plan** (USD 5/bulan). Paket gratis hanya bisa mengirim ke alamat yang sudah Anda verifikasi sendiri, jadi tidak bisa dipakai untuk pengguna umum.
2. **Domain memakai DNS Cloudflare.** Buka **Email Service** di dashboard Cloudflare, masuk ke bagian **Email Sending**, lalu onboard domain `voicepromax.com` (panduan: https://developers.cloudflare.com/email-service/get-started/send-emails/). Cloudflare menambahkan record SPF, DKIM, DMARC, dan MX bounce secara otomatis. Tunggu status domain aktif (biasanya beberapa menit, paling lama 24 jam).
3. Samakan alamat pengirim di `wrangler.jsonc`: `EMAIL_FROM` dan `allowed_sender_addresses` (default `noreply@voicepromax.com`).

Email Service masih berstatus beta, dan akun baru mendapat kuota kirim harian yang kecil lalu dinaikkan bertahap. Cek batasnya di dashboard. Kalau email verifikasi tidak sampai ke pengguna, admin bisa memverifikasi manual di **Admin → Pengguna → Kelola**.

Saat `npx wrangler dev`, email tidak benar-benar dikirim. Isinya disimpan di `.wrangler/tmp/email/`, jadi link verifikasi bisa dibuka dari sana.

### Sudah pernah deploy versi lama (login Google saja)?

Jalankan migrasi sekali. Data pengguna lama tetap utuh dan otomatis ditandai terverifikasi:

```bash
npx wrangler d1 execute voicepromax-db --remote --file=./migrations/0002_daftar_password.sql
```

Kalau database dibuat sebelum fitur akun manual ditambahkan, jalankan juga migrasi berikutnya (setelah 0002):

```bash
npx wrangler d1 execute voicepromax-db --remote --file=./migrations/0003_akun_tanpa_email.sql
```

Database baru cukup memakai `schema.sql` seperti di langkah deploy.

### Domain sendiri

Di dashboard Cloudflare: **Workers & Pages → voicepromax → Settings → Domains & Routes → Add → Custom domain**.
Setelah itu samakan `APP_URL` dan redirect URI Google dengan domain tersebut.

### Webhook Mayar

Di dashboard Mayar buka **Integrasi → Webhook**, isi URL:

```
https://DOMAIN-ANDA/api/webhooks/mayar?token=ISI_MAYAR_WEBHOOK_TOKEN
```

Klik simpan lalu **Test**. Webhook hanya memicu pengecekan; status lunas selalu dikonfirmasi
langsung ke API Mayar sebelum kuota ditambahkan. Kalau webhook gagal terkirim, cron setiap
15 menit dan pengecekan saat pengguna kembali dari halaman bayar tetap akan mengaktifkan paket.

## Uji di komputer sendiri

```bash
cp .dev.vars.example .dev.vars          # lalu isi nilainya
npx wrangler d1 execute voicepromax-db --local --file=./schema.sql
npx wrangler dev
```

Buka http://localhost:8787. Gunakan API sandbox Mayar selama pengujian. Untuk menguji cron:
`curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.

## Cara kerja

**Akun.** Pengguna bisa masuk dengan Google, atau mendaftar dengan username, email, dan password:

- Username 3–20 karakter (huruf kecil, angka, titik, garis bawah; diawali huruf). Password minimal 8 karakter dan harus berisi huruf serta angka. Kolom "ulangi password" dicek di browser dan di server.
- Setelah daftar, link verifikasi dikirim ke email dan berlaku 24 jam. Akun baru bisa masuk setelah email terverifikasi, dan saat itulah 10.000 karakter gratis diberikan. Bonus hanya sekali per akun.
- Pendaftaran yang tidak diverifikasi dalam 3 hari dihapus otomatis oleh cron, sehingga username dan emailnya bisa dipakai lagi.
- Lupa password mengirim link sekali pakai yang berlaku 1 jam. Setelah password baru disimpan, semua perangkat lain otomatis keluar.
- Kalau seseorang masuk dengan Google memakai email yang sama dengan akun password, keduanya digabung. Jika akun password itu belum diverifikasi, passwordnya dihapus. Ini mencegah orang lain mendaftarkan email Anda lebih dulu lalu ikut masuk ke akun Anda.
- Password disimpan sebagai hash PBKDF2-SHA256 (100.000 iterasi, salt acak). Percobaan dibatasi: 8 kali login gagal per akun per 15 menit, 1 email per menit dan 5 email per hari per alamat, serta 10 pendaftaran per jam per jaringan.

**Akun manual dari admin.** Di **Admin → Pengguna → Tambah pengguna**, buat akun dengan username dan password (email opsional), pilih paket, dan tentukan kuota awal. Pengguna langsung bisa masuk dengan username tersebut. Di menu **Akun**, pengguna bisa:

- menyambungkan email lewat link konfirmasi (wajib sebelum membeli paket, karena Mayar mengirim bukti pembayaran ke email),
- mengganti email dengan cara yang sama,
- mengganti password (perangkat lain otomatis keluar).

Akun manual tanpa email tidak bisa memakai Lupa password, jadi admin bisa mengatur password baru di **Kelola** pada daftar pengguna. Akun manual tidak menerima bonus pendaftaran tambahan saat menyambungkan email.

**Kuota karakter.** Semua huruf, angka, spasi, dan tanda baca dihitung. Tag gaya seperti
`<|prosody:pause|>` tidak dihitung. Kuota dipotong sebelum audio dibuat dan dikembalikan
otomatis bila Boson gagal. Batas satu kali buat adalah 5.000 karakter (batas Boson).

**Paket.** Pengguna baru mendapat kuota paket Free (10.000 karakter) sekali saat daftar, tanpa
kedaluwarsa. Paket berbayar berlaku sesuai `duration_days` (default 30 hari). Membeli lagi saat
masih aktif akan menambah kuota dan memperpanjang masa aktif. Saat paket habis masa aktifnya,
sisa kuota hangus dan akun kembali ke Free. Tidak ada perpanjangan otomatis.

**Kelebihan paket.** Isi dari **Admin → Paket**, satu kelebihan per baris. Kolom
"Maks. suara klon" langsung diterapkan sebagai batas jumlah suara yang bisa disimpan.
Perubahan harga dan kuota hanya berlaku untuk tagihan baru.

**Suara klon.** Rekaman (5–30 detik, maks. 10 MB, WAV/MP3/FLAC/AAC/OPUS) didaftarkan ke Boson
sebagai custom voice, lalu ID-nya dipakai ulang. Rekaman dari mikrofon browser diubah ke WAV
di sisi browser. Pengguna wajib menyatakan punya hak atas suara tersebut.

**Keamanan.** Sesi disimpan sebagai hash SHA-256 di D1 dengan cookie HttpOnly + Secure +
SameSite=Lax. Semua permintaan pengubah data diperiksa header `Origin`-nya. Webhook dilindungi
token dan tidak pernah dipercaya tanpa konfirmasi ke Mayar. File audio hanya bisa diakses pemiliknya.

## Endpoint

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/auth/google` | Mulai login Google |
| GET | `/auth/google/callback` | Callback Google |
| POST | `/auth/logout` | Keluar |
| GET | `/auth/username-available?u=` | Cek ketersediaan username |
| POST | `/auth/register` | Daftar `{ username, email, password, password_confirm, agree }` |
| POST | `/auth/login` | Masuk `{ identifier, password }` (username atau email) |
| POST | `/auth/resend-verification` | Kirim ulang link verifikasi `{ email }` |
| GET | `/auth/verify?token=` | Link verifikasi dari email |
| POST | `/auth/forgot` | Kirim link reset password `{ email }` |
| POST | `/auth/reset` | Simpan password baru `{ token, password, password_confirm }` |
| GET | `/api/account` | Data halaman Akun (email, status, email yang menunggu konfirmasi) |
| POST | `/api/account/email` | Kirim link konfirmasi untuk menyambungkan/mengganti email `{ email }` |
| GET | `/auth/confirm-email?token=` | Link konfirmasi email |
| POST | `/api/account/password` | Ganti/buat password `{ current_password?, password, password_confirm }` |
| POST | `/api/admin/users` | Buat akun manual `{ username, password, name?, email?, plan_id, char_balance? }` |
| GET | `/api/plans` | Daftar paket aktif (publik) |
| GET/PATCH | `/api/me` | Profil, kuota, simpan nomor HP |
| GET/POST | `/api/voices` | Daftar / simpan suara klon (multipart) |
| DELETE | `/api/voices/:id` | Hapus suara |
| GET | `/api/voices/:id/sample` | Putar rekaman referensi |
| POST | `/api/tts` | Buat audio `{ text, voice }` |
| GET | `/api/generations` | Riwayat audio |
| DELETE | `/api/generations/:id` | Hapus audio |
| GET | `/api/audio/:id` | Putar / unduh (`?download=1`) |
| POST | `/api/checkout` | Buat invoice Mayar `{ plan_id, phone }` |
| GET | `/api/payments` | Riwayat tagihan |
| POST | `/api/payments/:id/verify` | Cek status ke Mayar |
| POST | `/api/webhooks/mayar?token=` | Webhook Mayar |
| GET | `/api/admin/stats` | Ringkasan |
| GET/PATCH | `/api/admin/users[/:id]` | Kelola pengguna |
| GET | `/api/admin/users/:id/ledger` | Riwayat perubahan kuota |
| GET | `/api/admin/payments` | Semua tagihan |
| POST | `/api/admin/payments/:id/verify` | Cek ke Mayar |
| POST | `/api/admin/payments/:id/mark-paid` | Tandai lunas manual |
| GET/PUT | `/api/admin/plans[/:id]` | Lihat / ubah / tambah paket |
| GET | `/api/admin/generations` | Aktivitas terbaru |

## Catatan

- Suara bawaan Boson (Chloe, Eleanor, Nora, Jake, Marcus, Oliver) berkarakter bahasa Inggris.
  Untuk naskah bahasa Indonesia, hasil terbaik didapat dari suara klon.
- Batas ukuran request Workers paket gratis adalah 100 MB, jauh di atas batas upload 10 MB.
- Pantau log dengan `npx wrangler tail`.

## File pendukung halaman utama

Halaman utama (`public/index.html`) merujuk beberapa file yang perlu Anda taruh sendiri di folder `public/`:

| File | Dipakai untuk | Kalau belum ada |
| --- | --- | --- |
| `public/demo/asli.mp3` | Contoh rekaman asli di bagian "Dengar bedanya" | Kartu menampilkan "Contoh suara belum tersedia" |
| `public/demo/kloning.mp3` | Contoh hasil kloning | Kartu menampilkan "Contoh hasil kloning sedang disiapkan" |
| `public/logo.png` | Ikon di layar utama HP dan gambar pratinjau saat link dibagikan | Ikon/pratinjau kosong |
| `public/kebijakan.html` | Halaman Syarat & Kebijakan Privasi | Tautan di FAQ dan footer menghasilkan 404 |

Teks contoh di skrip halaman (konstanta `DEMO`) harus sama persis dengan isi audionya.
Halaman kebijakan juga wajib ada agar aplikasi OAuth Google bisa dipublikasikan untuk umum.
