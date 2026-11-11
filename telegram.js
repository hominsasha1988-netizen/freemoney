'use strict';

class TgError extends Error {
  constructor(method, code, description) {
    super(`Telegram ${method} → ${code}: ${description}`);
    this.method = method;
    this.code = code;
    this.description = description || '';
  }
}

/** Мінімальний клієнт Bot API без залежностей (глобальний fetch, Node ≥ 18). */
function createTg(token, apiBase = 'https://api.telegram.org') {
  async function call(method, params = {}, timeoutMs = 15000) {
    let res;
    try {
      res = await fetch(`${apiBase}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TgError(method, 0, 'network: ' + (e.message || e));
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      throw new TgError(method, data?.error_code || res.status, data?.description || 'bad response');
    }
    return data.result;
  }

  return {
    call,
    /** Безпечна відправка: помилки (юзер заблокував бота тощо) не ламають основну логіку. */
    async notify(chatId, text, extra = {}) {
      try {
        await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
        return true;
      } catch {
        return false;
      }
    },
  };
}

module.exports = { createTg, TgError };
