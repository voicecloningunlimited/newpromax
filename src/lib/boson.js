import { HttpError } from './util.js';

const BASE = 'https://api.boson.ai/v1';
const MODEL = 'higgs-tts-3';

export const PRESET_VOICES = [
  { id: 'chloe', name: 'Chloe', desc: 'Perempuan, ramah dan jelas' },
  { id: 'eleanor', name: 'Eleanor', desc: 'Perempuan, tenang dan profesional' },
  { id: 'nora', name: 'Nora', desc: 'Perempuan, lembut untuk bercerita' },
  { id: 'jake', name: 'Jake', desc: 'Laki-laki, energik' },
  { id: 'marcus', name: 'Marcus', desc: 'Laki-laki, percaya diri' },
  { id: 'oliver', name: 'Oliver', desc: 'Laki-laki, kalem dan reflektif' },
];

async function toError(res) {
  let msg = '';
  try {
    const j = await res.json();
    msg = j?.error?.message || '';
  } catch { /* bukan JSON */ }
  console.error('boson error', res.status, msg);
  if (res.status === 400) return new HttpError(400, msg || 'Permintaan ke mesin suara tidak valid.', 'boson_bad_request');
  if (res.status === 429) return new HttpError(503, 'Mesin suara sedang sibuk. Coba lagi dalam beberapa detik.', 'boson_busy');
  return new HttpError(502, 'Mesin suara tidak merespons. Coba lagi sebentar lagi.', 'boson_error');
}

/** Teks → audio MP3. `voice` = nama preset atau ID custom voice (voice_...). */
export async function bosonSpeech(env, { input, voice, format = 'mp3' }) {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.BOSON_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input, voice, response_format: format }),
  });
  if (!res.ok) throw await toError(res);
  return {
    body: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') || 'audio/mpeg',
  };
}

/** Daftarkan rekaman referensi sebagai custom voice yang bisa dipakai ulang. */
export async function bosonCreateVoice(env, { bytes, type, filename, refText, description }) {
  const fd = new FormData();
  fd.append('ref_audio', new Blob([bytes], { type }), filename);
  fd.append('ref_text', refText);
  if (description) fd.append('description', description);

  const res = await fetch(`${BASE}/audio/voices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.BOSON_API_KEY}` },
    body: fd,
  });
  if (!res.ok) throw await toError(res);
  const j = await res.json();
  // Referensi API memakai `voice`, contoh panduan memakai `voice_id`: dukung keduanya.
  const id = j.voice || j.voice_id;
  if (!id) throw new HttpError(502, 'Mesin suara tidak mengembalikan ID suara.', 'boson_error');
  return id;
}
