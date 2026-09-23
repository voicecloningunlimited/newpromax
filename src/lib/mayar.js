import { HttpError } from './util.js';

function base(env) {
  return (env.MAYAR_API_BASE || 'https://api.mayar.id/hl/v1').replace(/\/+$/, '');
}

async function call(env, path, init = {}) {
  const res = await fetch(`${base(env)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.MAYAR_API_KEY}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || (j.statusCode && j.statusCode !== 200)) {
    console.error('mayar error', path, res.status, JSON.stringify(j));
    throw new HttpError(502, `Mayar menolak permintaan${j?.messages ? `: ${j.messages}` : '.'}`, 'mayar_error');
  }
  return j.data;
}

/** https://docs.mayar.id/api-reference/invoice/create */
export function mayarCreateInvoice(env, payload) {
  return call(env, '/invoice/create', { method: 'POST', body: JSON.stringify(payload) });
}

/** https://docs.mayar.id/api-reference/invoice/detail → { status: 'paid' | 'unpaid' | ..., amount, ... } */
export function mayarGetInvoice(env, invoiceId) {
  return call(env, `/invoice/${encodeURIComponent(invoiceId)}`, { method: 'GET' });
}
