import { DEJO_ENDPOINT, DEJO_MESSAGE_MAX_LENGTH } from './dejo-config.js';

export class DejoServiceError extends Error {
  constructor(kind, retryAfterSeconds = 0) {
    super(kind);
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function createConversationId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `dejo_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function sendDejoMessage({ sessionId, message, challengeToken }) {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > DEJO_MESSAGE_MAX_LENGTH) throw new DejoServiceError('validation');

  let response;
  try {
    response = await fetch(DEJO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, message: trimmed, turnstile_token: challengeToken }),
    });
  } catch {
    throw new DejoServiceError('unavailable');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new DejoServiceError('unavailable');
  }

  if (response.status === 400 || payload?.error === 'invalid_request') throw new DejoServiceError('validation');
  if (response.status === 403) throw new DejoServiceError('security');
  if (response.status === 429 || payload?.error === 'rate_limited' || payload?.error === 'busy') {
    const seconds = Number(payload?.retry_after_seconds);
    throw new DejoServiceError('limited', Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0);
  }
  if (!response.ok) throw new DejoServiceError('unavailable');
  if (typeof payload?.reply !== 'string' || typeof payload?.session_id !== 'string' || payload.session_id !== sessionId) {
    throw new DejoServiceError('unavailable');
  }
  return payload;
}
