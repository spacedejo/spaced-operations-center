const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export function onRequestGet({ env }) {
  if (!env.DEJO_WEBHOOK_URL || !env.DEJO_TURNSTILE_SITE_KEY || !env.DEJO_TURNSTILE_SECRET || !env.DEJO_PROXY_KEY) {
    return json({ error: 'unavailable' }, 503);
  }
  try {
    if (new URL(env.DEJO_WEBHOOK_URL).protocol !== 'https:') return json({ error: 'unavailable' }, 503);
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
  return json({ siteKey: env.DEJO_TURNSTILE_SITE_KEY }, 200);
}
