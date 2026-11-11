'use strict';
const crypto = require('node:crypto');

/**
 * Перевірка підпису Telegram WebApp initData (HMAC-SHA256).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Повертає { user, startParam } або null, якщо підпис невірний/застарілий.
 */
function verifyInitData(initData, botToken, maxAgeSec = 86400, now = Date.now()) {
  if (typeof initData !== 'string' || !initData || initData.length > 8192) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  const authDate = parseInt(params.get('auth_date') || '', 10);
  if (!Number.isFinite(authDate)) return null;
  if (Math.abs(now / 1000 - authDate) > maxAgeSec) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || '');
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;

  return { user, startParam: params.get('start_param') || '' };
}

/** Допоміжне для тестів: підписати initData так, як це робить Telegram. */
function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const dcs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

module.exports = { verifyInitData, signInitData };
