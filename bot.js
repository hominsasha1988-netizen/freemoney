'use strict';

const REF_PARAM_RE = /^ref_\d{1,15}$/;

/**
 * Частина бота: /start, кнопка меню, отримання апдейтів (webhook або long polling).
 * Вся бізнес-логіка живе в Mini App + API; бот лише відкриває апку.
 */
function createBot({ config, tg, log = console }) {
  let botUsername = '';
  let stopped = false;

  const isHttps = /^https:\/\//.test(config.publicUrl);

  function directLink(param) {
    return `https://t.me/${botUsername}/${config.appShortName}${param ? '?startapp=' + param : ''}`;
  }

  async function onUpdate(update) {
    const m = update && update.message;
    if (!m || typeof m.text !== 'string' || !m.chat || m.chat.type !== 'private') return;
    const text = m.text.trim();

    if (/^\/start(@\w+)?(\s|$)/i.test(text)) {
      const param = (text.split(/\s+/)[1] || '').trim();
      // Рефералка працює тільки через startapp-посилання (так initData містить start_param),
      // тому якщо прийшли зі /start ref_X — даємо кнопку-посилання саме з цим параметром.
      let button;
      if (REF_PARAM_RE.test(param)) {
        button = { text: '🚀 Відкрити додаток', url: directLink(param) };
      } else if (isHttps) {
        button = { text: '🚀 Відкрити додаток', web_app: { url: config.publicUrl } };
      } else {
        button = { text: '🚀 Відкрити додаток', url: directLink('') };
      }
      await tg.notify(
        m.chat.id,
        'Привіт! 👋\nЗапрошуй друзів, виконуй завдання та отримуй бонуси.\nНатисни кнопку нижче, щоб відкрити додаток.',
        { reply_markup: { inline_keyboard: [[button]] } }
      );
    } else if (/^\/help(@\w+)?$/i.test(text)) {
      await tg.notify(m.chat.id, 'Усе керування — в додатку. Натисни /start і відкрий його.');
    }
  }

  async function pollLoop() {
    let offset = 0;
    let backoff = 1000;
    while (!stopped) {
      try {
        const updates = await tg.call(
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message'] },
          35000
        );
        backoff = 1000;
        for (const u of updates) {
          offset = u.update_id + 1;
          onUpdate(u).catch((e) => log.error('update error', e.message));
        }
      } catch (e) {
        if (stopped) return;
        log.error('getUpdates:', e.message);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  async function start() {
    const me = await tg.call('getMe');
    botUsername = me.username;
    log.log(`Бот: @${botUsername}`);

    await tg.call('setMyCommands', {
      commands: [{ command: 'start', description: 'Відкрити додаток' }],
    }).catch(() => {});

    if (isHttps) {
      await tg.call('setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Відкрити', web_app: { url: config.publicUrl } },
      }).catch((e) => log.error('setChatMenuButton:', e.message));
    }

    const useWebhook = config.botMode === 'webhook' || (config.botMode === 'auto' && isHttps);
    if (useWebhook) {
      if (!isHttps) throw new Error('Для webhook потрібен PUBLIC_URL з https://');
      await tg.call('setWebhook', {
        url: config.publicUrl + config.webhookPath,
        secret_token: config.webhookSecret,
        allowed_updates: ['message'],
        drop_pending_updates: false,
      });
      log.log('Режим: webhook');
    } else {
      await tg.call('deleteWebhook').catch(() => {});
      log.log('Режим: long polling');
      pollLoop();
    }
    return me;
  }

  return {
    start,
    onUpdate,
    stop() { stopped = true; },
    get username() { return botUsername; },
    setUsername(u) { botUsername = u; }, // для тестів
  };
}

module.exports = { createBot };
