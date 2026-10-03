let scriptPromise;

function loadTurnstile() {
  scriptPromise ||= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile_unavailable'));
    script.onerror = () => reject(new Error('turnstile_unavailable'));
    document.head.append(script);
  });
  return scriptPromise;
}

export async function createDejoChallenge(container, onChange) {
  const response = await fetch('/api/dejo-config', { cache: 'no-store' });
  if (!response.ok) throw new Error('security_unavailable');
  const config = await response.json();
  if (typeof config?.siteKey !== 'string' || !config.siteKey) throw new Error('security_unavailable');

  const turnstile = await loadTurnstile();
  let token = '';
  const widgetId = turnstile.render(container, {
    sitekey: config.siteKey,
    action: 'dejo_chat',
    theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    size: 'flexible',
    callback(value) { token = value; onChange(true); },
    'expired-callback'() { token = ''; onChange(false); },
    'error-callback'() { token = ''; onChange(false); },
  });
  if (widgetId === undefined) throw new Error('security_unavailable');

  return {
    getToken() { return token; },
    reset() { token = ''; onChange(false); turnstile.reset(widgetId); },
  };
}
