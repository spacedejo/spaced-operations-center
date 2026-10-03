import { DEJO_MESSAGE_MAX_LENGTH } from './dejo-config.js';
import { createConversationId, sendDejoMessage } from './dejo-service.js';
import { createDejoChallenge } from './dejo-security.js';

const root = document.querySelector('.dejo-chat');
const panel = root.querySelector('.dejo-chat__panel');
const toggle = root.querySelector('.dejo-chat__toggle');
const close = root.querySelector('.dejo-chat__close');
const messages = root.querySelector('.dejo-chat__messages');
const challengeContainer = root.querySelector('.dejo-chat__challenge');
const status = root.querySelector('.dejo-chat__status');
const form = root.querySelector('.dejo-chat__form');
const input = root.querySelector('textarea');
const send = root.querySelector('.dejo-chat__send');
const retry = root.querySelector('.dejo-chat__retry');

let sessionId = null;
let pending = false;
let failedMessage = null;
let retryUntil = 0;
let retryTimer = null;
let challenge = null;
let securityLoading = null;
let securityReady = false;

function syncButtons() {
  const blocked = pending || Date.now() < retryUntil || !securityReady;
  send.disabled = blocked;
  retry.disabled = blocked;
}

function initializeSecurity() {
  if (challenge || securityLoading) return;
  status.textContent = 'Preparando a verificação de segurança...';
  securityLoading = createDejoChallenge(challengeContainer, (ready) => {
    securityReady = ready;
    syncButtons();
    if (!pending && ready && status.textContent === 'Preparando a verificação de segurança...') {
      status.textContent = '';
    }
  }).then((instance) => {
    challenge = instance;
    syncButtons();
  }).catch(() => {
    securityLoading = null;
    status.textContent = 'A conversa com o DEJO está indisponível no momento.';
    syncButtons();
  });
}

function openChat() {
  panel.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', 'Fechar conversa com DEJO');
  input.focus();
  initializeSecurity();
}

function closeChat() {
  panel.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Abrir conversa com DEJO');
  toggle.focus();
}

function addMessage(text, sender) {
  const bubble = document.createElement('p');
  bubble.className = `dejo-chat__message dejo-chat__message--${sender}`;
  bubble.textContent = text;
  messages.append(bubble);
  messages.scrollTop = messages.scrollHeight;
}

function updateLimit() {
  const seconds = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
  if (seconds) {
    status.textContent = `Aguarde ${seconds}s para tentar novamente.`;
    syncButtons();
  } else {
    clearInterval(retryTimer);
    retryTimer = null;
    retryUntil = 0;
    status.textContent = 'Você pode tentar novamente.';
    syncButtons();
  }
}

async function submitMessage(message, isRetry = false) {
  const trimmed = message.trim();
  if (pending || Date.now() < retryUntil) return;
  const challengeToken = challenge?.getToken();
  if (!challengeToken) {
    status.textContent = 'Conclua a verificação de segurança para enviar.';
    return;
  }
  if (!trimmed || trimmed.length > DEJO_MESSAGE_MAX_LENGTH) {
    status.textContent = `Escreva uma mensagem de até ${DEJO_MESSAGE_MAX_LENGTH} caracteres.`;
    return;
  }

  sessionId ||= createConversationId();
  if (!isRetry) {
    addMessage(trimmed, 'visitor');
    input.value = '';
  }
  failedMessage = trimmed;
  pending = true;
  challenge.reset();
  syncButtons();
  retry.hidden = true;
  status.textContent = 'DEJO está respondendo...';

  try {
    const result = await sendDejoMessage({ sessionId, message: trimmed, challengeToken });
    addMessage(result.reply, 'dejo');
    failedMessage = null;
    status.textContent = '';
  } catch (error) {
    if (error.kind === 'validation') {
      status.textContent = 'Essa mensagem não pôde ser enviada. Revise o texto e tente novamente.';
    } else if (error.kind === 'security') {
      status.textContent = 'A verificação expirou. Conclua-a novamente para tentar.';
    } else if (error.kind === 'limited') {
      status.textContent = 'Muitas solicitações no momento. Tente novamente em instantes.';
      if (error.retryAfterSeconds) {
        retryUntil = Date.now() + error.retryAfterSeconds * 1000;
        updateLimit();
        retryTimer = setInterval(updateLimit, 1000);
      }
    } else {
      status.textContent = 'Não consegui responder agora. Tente novamente em instantes.';
    }
    retry.hidden = false;
  } finally {
    pending = false;
    syncButtons();
  }
}

toggle.addEventListener('click', () => panel.hidden ? openChat() : closeChat());
close.addEventListener('click', closeChat);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !panel.hidden) closeChat();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitMessage(input.value);
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
retry.addEventListener('click', () => {
  if (failedMessage) submitMessage(failedMessage, true);
});
