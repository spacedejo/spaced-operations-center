// Cloudflare Pages Function: mantém o webhook n8n fora do código público.
const sessionPattern = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_MESSAGE_LENGTH = 1000;

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'forbidden' }, 403);
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return json({ error: 'invalid_request' }, 400);
  }
  if (Number(request.headers.get('Content-Length')) > 4096) return json({ error: 'invalid_request' }, 400);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'invalid_request' }, 400);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const sessionId = body?.session_id;
  const message = body?.message;
  const challengeToken = body?.turnstile_token;
  if (typeof sessionId !== 'string' || !sessionPattern.test(sessionId) ||
      typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LENGTH ||
      typeof challengeToken !== 'string' || !challengeToken || challengeToken.length > 2048) {
    return json({ error: 'invalid_request' }, 400);
  }

  const webhookUrl = env.DEJO_WEBHOOK_URL;
  const turnstileSecret = env.DEJO_TURNSTILE_SECRET;
  const proxyKey = env.DEJO_PROXY_KEY;
  if (!webhookUrl || !turnstileSecret || !env.DEJO_TURNSTILE_SITE_KEY || !proxyKey) {
    return json({ error: 'unavailable' }, 503);
  }
  try {
    if (new URL(webhookUrl).protocol !== 'https:') return json({ error: 'unavailable' }, 503);
  } catch {
    return json({ error: 'unavailable' }, 503);
  }

  let verification;
  try {
    const fields = new URLSearchParams({ secret: turnstileSecret, response: challengeToken });
    const visitorIp = request.headers.get('CF-Connecting-IP');
    if (visitorIp) fields.set('remoteip', visitorIp);
    const challengeResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fields,
      signal: AbortSignal.timeout(10000),
    });
    if (!challengeResponse.ok) return json({ error: 'unavailable' }, 503);
    verification = await challengeResponse.json();
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
  if (verification?.success !== true || verification.hostname !== new URL(request.url).hostname ||
      verification.action !== 'dejo_chat') {
    return json({ error: 'verification_failed' }, 403);
  }

  let upstream;
  try {
    upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dejo-Proxy-Key': proxyKey },
      body: JSON.stringify({ session_id: sessionId, message: message.trim() }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    console.warn('dejo_proxy', { stage: 'upstream_fetch', category: 'connection_or_timeout' });
    return json({ error: 'unavailable' }, 502);
  }
  console.info('dejo_proxy', { stage: 'upstream_response', status: upstream.status });

  let responseBody;
  try {
    responseBody = await upstream.json();
  } catch {
    console.warn('dejo_proxy', { stage: 'upstream_body', category: 'invalid_json', status: upstream.status });
    return json({ error: 'unavailable' }, 502);
  }

  if (upstream.status === 400) return json({ error: 'invalid_request' }, 400);
  if (upstream.status === 429) {
    const seconds = Number(responseBody?.retry_after_seconds);
    return json({ error: responseBody?.error === 'busy' ? 'busy' : 'rate_limited',
      ...(Number.isFinite(seconds) && seconds > 0 ? { retry_after_seconds: Math.ceil(seconds) } : {}) }, 429);
  }
  if (!upstream.ok || typeof responseBody?.reply !== 'string' || responseBody?.session_id !== sessionId) {
    console.warn('dejo_proxy', { stage: 'upstream_contract', category: 'unexpected_response', status: upstream.status });
    return json({ error: 'unavailable' }, 502);
  }

  return json({ reply: responseBody.reply, session_id: sessionId }, 200);
}
