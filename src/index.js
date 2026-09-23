import { json, HttpError } from './lib/util.js';
import { handleAuth, getUser, AUTH_PATHS } from './lib/auth.js';
import { runCron } from './lib/payments.js';
import { ensureSchema } from './lib/schema.js';
import { apiRoutes } from './routes/api.js';
import { adminRoutes } from './routes/admin.js';
import { accountRoutes } from './routes/account.js';

const routes = [...apiRoutes, ...adminRoutes, ...accountRoutes];

// Tolak permintaan pengubah data dari situs lain (perlindungan CSRF)
function checkOrigin(req, url) {
  const origin = req.headers.get('Origin');
  if (!origin || origin !== url.origin) throw new HttpError(403, 'Permintaan ditolak.', 'bad_origin');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      const butuhDb = url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/app' || url.pathname === '/admin';
      if (butuhDb) await ensureSchema(env);
      if (AUTH_PATHS.has(url.pathname)) return await handleAuth(req, env, url);

      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
        const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        if (mutating && !url.pathname.startsWith('/api/webhooks/')) checkOrigin(req, url);

        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          return await r.handler({ req, env, ctx, url, params });
        }
        throw new HttpError(404, 'Endpoint tidak ditemukan.');
      }

      // Alamat lama /dashboard diarahkan ke studio
      if (url.pathname === '/dashboard') return Response.redirect(`${url.origin}/app${url.search}`, 301);

      // Penjaga halaman: /app butuh login, /admin butuh peran admin
      if (url.pathname === '/app' || url.pathname === '/admin') {
        const user = await getUser(req, env);
        if (!user || user.status !== 'active') {
          const next = encodeURIComponent(url.pathname + url.search);
          return Response.redirect(`${url.origin}/auth/google?next=${next}`, 302);
        }
        if (url.pathname === '/admin' && user.role !== 'admin') return Response.redirect(`${url.origin}/app`, 302);
      }

      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: { message: e.message, code: e.code } }, e.status);
      console.error('unhandled', e?.stack || e);
      return json({ error: { message: 'Terjadi kesalahan di server. Coba lagi sebentar lagi.' } }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => runCron(env)));
  },
};
