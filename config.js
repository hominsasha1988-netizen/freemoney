'use strict';
const crypto = require('node:crypto');
const path = require('node:path');

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

/**
 * Уся конфігурація — зі змінних оточення. Токен бота НІКОЛИ не пишемо в код.
 */
function loadConfig(env = process.env) {
  const botToken = (env.BOT_TOKEN || '').trim();
  if (!botToken) {
    throw new Error('BOT_TOKEN не заданий. Отримай токен у @BotFather і задай змінну оточення BOT_TOKEN.');
  }

  const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');

  return {
    botToken,
    port: int(env.PORT, 3000),
    dbPath: env.DB_PATH || path.join(__dirname, 'data', 'app.db'),
    // Telegram ID адмінів, через кому: ADMIN_IDS=12345,67890
    adminIds: new Set(
      (env.ADMIN_IDS || '')
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter(Number.isFinite)
    ),
    publicUrl, // https://your-app.onrender.com
    appShortName: (env.APP_SHORT_NAME || 'app').trim(), // short name, заданий у BotFather /newapp
    botMode: (env.BOT_MODE || 'auto').toLowerCase(), // auto | webhook | polling
    tgApi: (env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, ''),
    initDataMaxAgeSec: int(env.INITDATA_MAX_AGE, 24 * 3600),
    // Канали за замовчуванням (лише при першому запуску, далі керуються з адмінки)
    seedChannels: (env.CHANNELS || 'Crypto_Rabbit3')
      .split(',')
      .map((s) => s.trim().replace(/^@/, ''))
      .filter(Boolean),
    webhookSecret: crypto.createHash('sha256').update('wh:' + botToken).digest('hex').slice(0, 48),
    webhookPath: '/tg/' + crypto.createHash('sha256').update('path:' + botToken).digest('hex').slice(0, 32),
  };
}

module.exports = { loadConfig };
