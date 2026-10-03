import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';

const source = readFileSync(new URL('../functions/api/dejo.js', import.meta.url), 'utf8');
const { onRequestPost } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const configSource = readFileSync(new URL('../functions/api/dejo-config.js', import.meta.url), 'utf8');
const { onRequestGet } = await import(`data:text/javascript,${encodeURIComponent(configSource)}`);

const url = 'https://spaced-operations-center.pages.dev/api/dejo';
const env = {
  DEJO_WEBHOOK_URL: 'https://example.invalid/dejo',
  DEJO_TURNSTILE_SECRET: 'test-secret',
  DEJO_TURNSTILE_SITE_KEY: 'test-site-key',
  DEJO_PROXY_KEY: 'test-proxy-key',
  DEJO_CHAT_SESSION_SECRET: 'test-chat-session-secret-with-at-least-32-bytes',
};
const payload = {
  session_id: 'dejo_test_session_1234',
  message: 'Olá',
  turnstile_token: 'test-token',
};

const cachedRates = new Map();
globalThis.caches = { default: {
  async match(request) { return cachedRates.get(request.url)?.clone(); },
  async put(request, response) { cachedRates.set(request.url, response.clone()); },
} };
beforeEach(() => cachedRates.clear());

function context(body = payload, headers = {}) {
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin, ...headers },
      body: JSON.stringify(body),
    }),
    env,
  };
}

test('recusa configuração ausente sem chamar serviços externos', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('fetch should not run'); };
  try {
    const response = await onRequestPost({ ...context(), env: {} });
    assert.equal(response.status, 503);
    assert.equal(onRequestGet({ env: {} }).status, 503);
  } finally { globalThis.fetch = original; }
});

test('configuração pública devolve somente a site key', async () => {
  const response = onRequestGet({ env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { siteKey: env.DEJO_TURNSTILE_SITE_KEY });
});

test('recusa origem externa e corpo inválido', async () => {
  assert.equal((await onRequestPost(context(payload, { Origin: 'https://other.example' }))).status, 403);
  assert.equal((await onRequestPost(context(payload, { Origin: '' }))).status, 403);
  assert.equal((await onRequestPost(context({ ...payload, message: '' }))).status, 400);
});

test('não chama o n8n quando Turnstile falha', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ success: false });
  };
  try {
    const response = await onRequestPost(context());
    assert.equal(response.status, 403);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('recusa token emitido para outro hostname ou ação', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ success: true, hostname: 'other.example', action: 'dejo_chat' });
  };
  try {
    assert.equal((await onRequestPost(context())).status, 403);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('encaminha só após Turnstile válido e preserva o contrato', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (target, options) => {
    calls.push({ target, options });
    if (calls.length === 1) return Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' });
    return Response.json({ reply: 'Tudo bem!', session_id: payload.session_id });
  };
  try {
    const response = await onRequestPost(context());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reply: 'Tudo bem!', session_id: payload.session_id });
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[1].options.body), { session_id: payload.session_id, message: payload.message });
    assert.equal(calls[1].options.headers['X-Dejo-Proxy-Key'], env.DEJO_PROXY_KEY);
    const cookie = response.headers.get('Set-Cookie');
    assert.match(cookie, /Max-Age=900; Path=\/api\/dejo; HttpOnly; Secure; SameSite=Strict/);
    assert.equal(cookie.includes(env.DEJO_CHAT_SESSION_SECRET), false);
    assert.equal(cookie.includes(payload.turnstile_token), false);
  } finally { globalThis.fetch = original; }
});

test('repassa limitação do n8n sem expor detalhes internos', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' })
    : Response.json({ error: 'rate_limited', retry_after_seconds: 30, detail: 'internal' }, { status: 429 });
  try {
    const response = await onRequestPost(context());
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'rate_limited', retry_after_seconds: 30 });
  } finally { globalThis.fetch = original; }
});

test('transforma 403 interno do n8n em erro genérico sem vazar headers ou detalhe', async () => {
  const original = globalThis.fetch;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const diagnostics = [];
  console.info = (...args) => diagnostics.push(args);
  console.warn = (...args) => diagnostics.push(args);
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' })
    : Response.json({ error: 'forbidden', detail: 'invalid proxy key' }, {
        status: 403,
        headers: { 'X-Internal-Reason': 'private' },
      });
  try {
    const response = await onRequestPost(context());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
    assert.equal(response.headers.get('X-Internal-Reason'), null);
    assert.deepEqual(diagnostics, [
      ['dejo_proxy', { stage: 'upstream_response', status: 403 }],
      ['dejo_proxy', { stage: 'upstream_contract', category: 'unexpected_response', status: 403 }],
    ]);
  } finally {
    globalThis.fetch = original;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});

test('registra status antes de tentar ler resposta não JSON, sem registrar segredo', async () => {
  const original = globalThis.fetch;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const diagnostics = [];
  console.info = (...args) => diagnostics.push(args);
  console.warn = (...args) => diagnostics.push(args);
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' })
    : new Response('Forbidden', { status: 403 });
  try {
    const response = await onRequestPost(context());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
    assert.deepEqual(diagnostics, [
      ['dejo_proxy', { stage: 'upstream_response', status: 403 }],
      ['dejo_proxy', { stage: 'upstream_body', category: 'invalid_json', status: 403 }],
    ]);
    assert.equal(JSON.stringify(diagnostics).includes(env.DEJO_PROXY_KEY), false);
    assert.equal(JSON.stringify(diagnostics).includes(env.DEJO_WEBHOOK_URL), false);
  } finally {
    globalThis.fetch = original;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});

test('distingue falha de conexão sem registrar detalhes da infraestrutura', async () => {
  const original = globalThis.fetch;
  const originalWarn = console.warn;
  const diagnostics = [];
  console.warn = (...args) => diagnostics.push(args);
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) return Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' });
    throw new Error('private upstream URL and credential must not be logged');
  };
  try {
    const response = await onRequestPost(context());
    assert.equal(response.status, 502);
    assert.deepEqual(diagnostics, [
      ['dejo_proxy', { stage: 'upstream_fetch', category: 'connection_or_timeout' }],
    ]);
  } finally {
    globalThis.fetch = original;
    console.warn = originalWarn;
  }
});

test('sem autorização ou token exige Turnstile e não chama n8n', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('external fetch should not run'); };
  try {
    const response = await onRequestPost(context({ ...payload, turnstile_token: undefined }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'verification_required' });
  } finally { globalThis.fetch = original; }
});

test('autorização válida permite mensagem seguinte sem repetir Turnstile', async () => {
  const original = globalThis.fetch;
  let challenges = 0;
  let upstream = 0;
  globalThis.fetch = async (target) => {
    if (String(target).includes('/siteverify')) {
      challenges += 1;
      return Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' });
    }
    upstream += 1;
    return Response.json({ reply: 'Tudo bem!', session_id: payload.session_id });
  };
  try {
    const first = await onRequestPost(context());
    assert.equal(first.status, 200);
    const cookie = first.headers.get('Set-Cookie').split(';')[0];
    const next = await onRequestPost(context({ ...payload, turnstile_token: undefined }, { Cookie: cookie }));
    assert.equal(next.status, 200);
    assert.equal(next.headers.get('Set-Cookie'), null);
    assert.equal(challenges, 1);
    assert.equal(upstream, 2);
  } finally { globalThis.fetch = original; }
});

test('autorização inválida ou adulterada exige Turnstile antes do n8n', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (target) => {
    calls += 1;
    return String(target).includes('/siteverify')
      ? Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' })
      : Response.json({ reply: 'Tudo bem!', session_id: payload.session_id });
  };
  try {
    const first = await onRequestPost(context());
    const cookie = first.headers.get('Set-Cookie').split(';')[0];
    const signature = cookie.slice(-43);
    const altered = `${cookie.slice(0, -43)}${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    const response = await onRequestPost(context({ ...payload, turnstile_token: undefined }, { Cookie: altered }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'verification_required' });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('autorização expirada aos 15 minutos exige novo Turnstile', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const issuedAt = 1791039600000;
  let calls = 0;
  Date.now = () => issuedAt;
  globalThis.fetch = async (target) => {
    calls += 1;
    return String(target).includes('/siteverify')
      ? Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' })
      : Response.json({ reply: 'Tudo bem!', session_id: payload.session_id });
  };
  try {
    const first = await onRequestPost(context());
    assert.equal(first.status, 200);
    const cookie = first.headers.get('Set-Cookie').split(';')[0];
    Date.now = () => issuedAt + 900000;
    const expired = await onRequestPost(context({ ...payload, turnstile_token: undefined }, { Cookie: cookie }));
    assert.equal(expired.status, 403);
    assert.deepEqual(await expired.json(), { error: 'verification_required' });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('limite Cloudflare de 12 mensagens por minuto bloqueia antes do n8n', async () => {
  const original = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = async (target) => {
    if (String(target).includes('/siteverify')) {
      return Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' });
    }
    upstream += 1;
    return Response.json({ reply: 'Tudo bem!', session_id: payload.session_id });
  };
  try {
    const first = await onRequestPost(context());
    const cookie = first.headers.get('Set-Cookie').split(';')[0];
    for (let index = 0; index < 11; index += 1) {
      assert.equal((await onRequestPost(context({ ...payload, turnstile_token: undefined }, { Cookie: cookie }))).status, 200);
    }
    const limited = await onRequestPost(context({ ...payload, turnstile_token: undefined }, { Cookie: cookie }));
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'rate_limited');
    assert.equal(upstream, 12);
  } finally { globalThis.fetch = original; }
});

test('indisponibilidade do contador Cloudflare falha fechada antes do n8n', async () => {
  const originalFetch = globalThis.fetch;
  const originalCache = globalThis.caches;
  const originalWarn = console.warn;
  let upstream = 0;
  console.warn = () => {};
  globalThis.caches = undefined;
  globalThis.fetch = async (target) => {
    if (String(target).includes('/siteverify')) {
      return Response.json({ success: true, hostname: new URL(url).hostname, action: 'dejo_chat' });
    }
    upstream += 1;
    return Response.json({ reply: 'Tudo bem!', session_id: payload.session_id });
  };
  try {
    const response = await onRequestPost(context());
    assert.equal(response.status, 503);
    assert.equal(upstream, 0);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCache; console.warn = originalWarn; }
});

test('widget usa interaction-only e não reaproveita token consumido', async () => {
  const securitySource = readFileSync(new URL('../components/dejo-chat/dejo-security.js', import.meta.url), 'utf8');
  const { createDejoChallenge } = await import(`data:text/javascript,${encodeURIComponent(securitySource)}`);
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let options;
  let removed = false;
  globalThis.window = { turnstile: {
    render(_container, config) { options = config; return 'widget-1'; },
    reset() {},
    remove() { removed = true; },
  } };
  globalThis.document = { documentElement: { dataset: { theme: 'dark' } } };
  globalThis.fetch = async () => Response.json({ siteKey: 'public-site-key' });
  const container = { replaceChildren() {} };
  try {
    const challenge = await createDejoChallenge(container, () => {});
    assert.equal(options.appearance, 'interaction-only');
    options.callback('one-use-token');
    assert.equal(challenge.getToken(), 'one-use-token');
    challenge.consume();
    assert.equal(challenge.getToken(), '');
    challenge.destroy();
    assert.equal(removed, true);
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; globalThis.document = originalDocument; }
});

test('abrir o chat libera o primeiro envio sem antecipar o desafio', async () => {
  const chatSource = readFileSync(new URL('../components/dejo-chat/dejo-chat.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  const originalDocument = globalThis.document;
  const listeners = new Map();
  const simpleElement = () => ({ addEventListener() {}, setAttribute() {}, focus() {} });
  const panel = { hidden: true };
  const send = { disabled: true };
  const retry = { ...simpleElement(), disabled: false };
  const toggle = { ...simpleElement(), addEventListener(type, listener) { listeners.set(type, listener); } };
  const elements = new Map([
    ['.dejo-chat__panel', panel], ['.dejo-chat__toggle', toggle],
    ['.dejo-chat__close', simpleElement()], ['.dejo-chat__messages', simpleElement()],
    ['.dejo-chat__challenge', simpleElement()], ['.dejo-chat__status', simpleElement()],
    ['.dejo-chat__form', simpleElement()], ['textarea', simpleElement()],
    ['.dejo-chat__send', send], ['.dejo-chat__retry', retry],
  ]);
  globalThis.document = {
    querySelector() { return { querySelector(selector) { return elements.get(selector); } }; },
    addEventListener() {},
  };
  try {
    const stubs = `const DEJO_MESSAGE_MAX_LENGTH = 1000;
      const createConversationId = () => 'test-session';
      const sendDejoMessage = () => { throw new Error('unexpected_send'); };
      const createDejoChallenge = () => { throw new Error('unexpected_challenge'); };`;
    await import(`data:text/javascript,${encodeURIComponent(`${stubs}\n${chatSource}`)}`);
    assert.equal(send.disabled, true);
    listeners.get('click')();
    assert.equal(panel.hidden, false);
    assert.equal(send.disabled, false);
  } finally { globalThis.document = originalDocument; }
});

test('código público não contém credenciais e config devolve apenas site key', async () => {
  for (const file of ['dejo-chat.js', 'dejo-security.js', 'dejo-service.js']) {
    const client = readFileSync(new URL(`../components/dejo-chat/${file}`, import.meta.url), 'utf8');
    assert.equal(client.includes(env.DEJO_PROXY_KEY), false);
    assert.equal(client.includes(env.DEJO_CHAT_SESSION_SECRET), false);
    assert.equal(client.includes(env.DEJO_WEBHOOK_URL), false);
    assert.doesNotMatch(client, /DEJO_PROXY_KEY|DEJO_WEBHOOK_URL|DEJO_CHAT_SESSION_SECRET/);
  }
  const response = onRequestGet({ env });
  assert.deepEqual(await response.json(), { siteKey: env.DEJO_TURNSTILE_SITE_KEY });
});
