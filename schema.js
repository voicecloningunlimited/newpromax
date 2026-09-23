// Membuat tabel otomatis pada database yang masih kosong, sehingga deploy lewat GitHub
// tidak perlu menjalankan schema.sql secara manual. Sumbernya schema.sql itu sendiri.
import SCHEMA_SQL from '../../schema.sql';

let siap = null;

function pecahPerintah(sql) {
  return sql
    .split('\n')
    .map((baris) => baris.replace(/\s--.*$/, '').replace(/^--.*$/, ''))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ensureSchema(env) {
  if (!siap) {
    siap = (async () => {
      const ada = await env.DB.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`).first();
      if (ada) return;
      console.log('Database kosong: membuat tabel dari schema.sql');
      await env.DB.batch(pecahPerintah(SCHEMA_SQL).map((s) => env.DB.prepare(s)));
    })().catch((e) => {
      siap = null; // coba lagi pada permintaan berikutnya
      throw e;
    });
  }
  return siap;
}
