import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
};
const payload = {
  session_id: 'dejo_test_session_1234',
  message: 'Olá',
  turnstile_token: 'test-token',
};

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
