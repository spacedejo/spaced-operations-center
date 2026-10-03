// Cloudflare Pages Function: mantém o webhook n8n fora do código público.
const sessionPattern = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_MESSAGE_LENGTH = 1000;
const AUTH_COOKIE = '__Secure-dejo_auth';
const AUTH_TTL_SECONDS = 15 * 60;
// Defesa adicional: 12 mensagens por 60s por autorização em cada datacenter.
// Não é um contador atômico/global; o limite autoritativo do n8n permanece ativo.
const RATE_LIMIT = 12;
const RATE_WINDOW_SECONDS = 60;
const encoder = new TextEncoder();

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const base64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function cookieFrom(request) {
  const values = (request.headers.get('Cookie') || '').split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${AUTH_COOKIE}=`));
  return values.length === 1 ? values[0].slice(AUTH_COOKIE.length + 1) : null;
}

async function validTicket(ticket, secret, hostname, now) {
  if (!ticket) return false;
  const parts = ticket.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !/^\d{13}$/.test(parts[1]) ||
      !/^[A-Za-z0-9_-]{22}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) return false;
  const issued = Number(parts[1]);
  if (!Number.isSafeInteger(issued) || issued > now || now - issued >= AUTH_TTL_SECONDS * 1000) return false;
  const signature = decodeBase64url(parts[3]);
  if (signature?.length !== 32) return false;
  const key = await signingKey(secret);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${hostname}|${parts.slice(0, 3).join('.')}`));
}

async function createTicket(secret, hostname, now) {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `v1.${now}.${nonce}`;
  const key = await signingKey(secret);
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${hostname}|${payload}`))));
  return `${payload}.${signature}`;
}

function withTicket(response, ticket) {
  if (ticket) response.headers.set('Set-Cookie', `${AUTH_COOKIE}=${ticket}; Max-Age=${AUTH_TTL_SECONDS}; Path=/api/dejo; HttpOnly; Secure; SameSite=Strict`);
  return response;
}

// Cache API existe em Pages (.pages.dev). Este contador é local ao datacenter e não é atômico.
// É uma barreira leve antes do n8n, não substitui o limite autoritativo de lá.
async function checkRateLimit(request, ticket, secret, now) {
  const cache = globalThis.caches?.default;
  if (!cache) throw new Error('rate_limit_unavailable');
  const key = await signingKey(secret);
  const digest = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`rate|${ticket}`))));
  const cacheKey = new Request(new URL(`/__dejo_rate/${digest}`, request.url), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  let state = cached ? await cached.json() : null;
  if (!state || !Number.isSafeInteger(state.start) || !Number.isSafeInteger(state.count) ||
      state.start > now || now - state.start >= RATE_WINDOW_SECONDS * 1000) {
    state = { start: now, count: 0 };
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((RATE_WINDOW_SECONDS * 1000 - (now - state.start)) / 1000));
  if (state.count >= RATE_LIMIT) return retryAfterSeconds;
  state.count += 1;
  await cache.put(cacheKey, new Response(JSON.stringify(state), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${retryAfterSeconds}` },
  }));
  return 0;
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (origin !== new URL(request.url).origin) return json({ error: 'forbidden' }, 403);
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
      (challengeToken !== undefined && (typeof challengeToken !== 'string' || !challengeToken || challengeToken.length > 2048))) {
    return json({ error: 'invalid_request' }, 400);
  }

  const webhookUrl = env.DEJO_WEBHOOK_URL;
  const turnstileSecret = env.DEJO_TURNSTILE_SECRET;
  const proxyKey = env.DEJO_PROXY_KEY;
  const chatSecret = env.DEJO_CHAT_SESSION_SECRET;
  if (!webhookUrl || !turnstileSecret || !env.DEJO_TURNSTILE_SITE_KEY || !proxyKey ||
      typeof chatSecret !== 'string' || encoder.encode(chatSecret).length < 32) {
    return json({ error: 'unavailable' }, 503);
  }
  try {
    if (new URL(webhookUrl).protocol !== 'https:') return json({ error: 'unavailable' }, 503);
  } catch {
    return json({ error: 'unavailable' }, 503);
  }

  const hostname = new URL(request.url).hostname;
  let ticket = cookieFrom(request);
  const authorized = await validTicket(ticket, chatSecret, hostname, Date.now());
  let issuedTicket = null;
  if (!authorized) {
    if (!challengeToken) return json({ error: 'verification_required' }, 403);
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
    if (verification?.success !== true || verification.hostname !== hostname ||
        verification.action !== 'dejo_chat') {
      return json({ error: 'verification_required' }, 403);
    }
    ticket = await createTicket(chatSecret, hostname, Date.now());
    issuedTicket = ticket;
  }

  try {
    const retryAfterSeconds = await checkRateLimit(request, ticket, chatSecret, Date.now());
    if (retryAfterSeconds) return withTicket(json({ error: 'rate_limited', retry_after_seconds: retryAfterSeconds }, 429), issuedTicket);
  } catch {
    console.warn('dejo_proxy', { stage: 'rate_limit', category: 'storage_unavailable' });
    return withTicket(json({ error: 'unavailable' }, 503), issuedTicket);
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
    return withTicket(json({ error: 'unavailable' }, 502), issuedTicket);
  }
  console.info('dejo_proxy', { stage: 'upstream_response', status: upstream.status });

  let responseBody;
  try {
    responseBody = await upstream.json();
  } catch {
    console.warn('dejo_proxy', { stage: 'upstream_body', category: 'invalid_json', status: upstream.status });
    return withTicket(json({ error: 'unavailable' }, 502), issuedTicket);
  }

  if (upstream.status === 400) return withTicket(json({ error: 'invalid_request' }, 400), issuedTicket);
  if (upstream.status === 429) {
    const seconds = Number(responseBody?.retry_after_seconds);
    return withTicket(json({ error: responseBody?.error === 'busy' ? 'busy' : 'rate_limited',
      ...(Number.isFinite(seconds) && seconds > 0 ? { retry_after_seconds: Math.ceil(seconds) } : {}) }, 429), issuedTicket);
  }
  if (!upstream.ok || typeof responseBody?.reply !== 'string' || responseBody?.session_id !== sessionId) {
    console.warn('dejo_proxy', { stage: 'upstream_contract', category: 'unexpected_response', status: upstream.status });
    return withTicket(json({ error: 'unavailable' }, 502), issuedTicket);
  }

  return withTicket(json({ reply: responseBody.reply, session_id: sessionId }, 200), issuedTicket);
}
