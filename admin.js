'use strict';
const { tx } = require('./db');
const { validateConfig, ConfigError } = require('./game');
const { TgError } = require('./telegram');
const { ApiError } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clampInt = (v, min, max, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/**
 * Уся логіка адмін-панелі. Викликається з server.js ЛИШЕ після перевірки, що юзер — адмін.
 * route() повертає об'єкт відповіді або undefined, якщо маршрут не знайдено.
 */
function createAdmin({ db, tg, bot, config, now, esc, credit, settings, getIntSetting, setSetting,
                       getGameConfig, saveGameConfig, listChannels, broadcastDelayMs = 50, log = console }) {
  let meCache = null;
  const getMe = async () => (meCache ||= await tg.call('getMe'));

  const adminLog = (adminId, action, detail = '') =>
    db.prepare('INSERT INTO admin_log(admin_id, action, detail, created_at) VALUES (?,?,?,?)')
      .run(adminId, action, String(detail).slice(0, 300), now());

  // ---------- пояснення помилок Telegram людською мовою ----------
  function explainTg(e) {
    const d = String(e?.description || e?.message || '').toLowerCase();
    if (e instanceof TgError && e.code === 0) return 'Telegram не відповів. Спробуй ще раз за хвилину.';
    if (/chat not found|username_invalid|username not occupied/.test(d)) {
      return 'Канал не знайдено. Перевір username: канал має бути публічним. Для приватного каналу вкажи його ID (-100…) і посилання-запрошення.';
    }
    if (/not enough rights|administrator rights|chat_admin_required|member list is inaccessible|not a member|kicked|forbidden/.test(d)) {
      return `Бот @${bot.username} не є адміністратором цього каналу. Додай його адміном (Адміністратори → Додати адміністратора) і повтори.`;
    }
    return 'Помилка Telegram: ' + (e?.description || e?.message || 'невідома');
  }

  // ---------- огляд ----------
  function overview() {
    const t = now();
    const dayStart = t - (t % 86400);
    const stats = db.prepare(
      `SELECT COUNT(*) AS users, COALESCE(SUM(subscribed),0) AS subscribed, COALESCE(SUM(ref_rewarded),0) AS referrals,
              COALESCE(SUM(balance),0) AS balances, COALESCE(SUM(banned),0) AS banned,
              COALESCE(SUM(created_at >= ?),0) AS newToday, COALESCE(SUM(created_at >= ?),0) AS new7d FROM users`
    ).get(dayStart, t - 7 * 86400);
    const pend = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum FROM withdrawals WHERE status = 'pending'").get();
    const paid = db.prepare("SELECT COALESCE(SUM(amount),0) AS sum FROM withdrawals WHERE status = 'done'").get();

    const from = t - 13 * 86400 - (t % 86400);
    const reg = Object.fromEntries(db.prepare(
      "SELECT date(created_at,'unixepoch') AS d, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY d").all(from).map((r) => [r.d, r.n]));
    const act = Object.fromEntries(db.prepare(
      "SELECT date(ref_rewarded_at,'unixepoch') AS d, COUNT(*) AS n FROM users WHERE ref_rewarded_at >= ? GROUP BY d").all(from).map((r) => [r.d, r.n]));
    const series = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date((t - i * 86400) * 1000).toISOString().slice(0, 10);
      series.push({ day: d, users: reg[d] || 0, activated: act[d] || 0 });
    }

    const top = db.prepare(
      `SELECT u.id, u.first_name AS name, u.username, COUNT(r.id) AS refs, u.earned_total AS earned
         FROM users u JOIN users r ON r.referrer_id = u.id AND r.ref_rewarded = 1
        GROUP BY u.id ORDER BY refs DESC, earned DESC LIMIT 5`).all();
    const recent = db.prepare('SELECT admin_id AS adminId, action, detail, created_at AS ts FROM admin_log ORDER BY id DESC LIMIT 10').all();

    return {
      stats: { ...stats, pendingCount: pend.n, pendingSum: pend.sum, paidSum: paid.sum },
      series, top, recent, settings: settings(),
      broadcastRunning: !!(job && job.running),
    };
  }

  // ---------- заявки на вивід ----------
  function withdrawals(scope) {
    if (scope === 'history') {
      return db.prepare(
        `SELECT w.id, w.amount, w.address, w.status, w.created_at AS ts, w.resolved_at AS resolvedAt,
                u.id AS userId, u.first_name AS name, u.username
           FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status != 'pending' ORDER BY w.id DESC LIMIT 30`).all();
    }
    return db.prepare(
      `SELECT w.id, w.amount, w.address, w.status, w.created_at AS ts,
              u.id AS userId, u.first_name AS name, u.username
         FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'pending' ORDER BY w.id`).all();
  }

  async function resolveWithdrawal(adminId, id, body) {
    const action = body?.action;
    if (action !== 'approve' && action !== 'reject') throw new ApiError(400, 'bad_action', 'Невідома дія');
    const wd = tx(db, () => {
      const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (!row) throw new ApiError(404, 'not_found', 'Заявку не знайдено');
      const r = db.prepare("UPDATE withdrawals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(action === 'approve' ? 'done' : 'rejected', now(), id);
      if (r.changes === 0) throw new ApiError(409, 'already_resolved', 'Заявку вже оброблено');
      if (action === 'reject') credit(row.user_id, row.amount, { countAsEarned: false }); // повертаємо бонуси
      return row;
    });
    adminLog(adminId, action === 'approve' ? 'withdraw_done' : 'withdraw_reject', `#${wd.id} ${wd.amount} бонусів, юзер ${wd.user_id}`);
    const usdt = (wd.amount / getIntSetting('usdt_rate')).toFixed(2);
    tg.notify(wd.user_id, action === 'approve'
      ? `✅ Заявку #${wd.id} виплачено: <b>${usdt} USDT</b> (${wd.amount} бонусів).`
      : `❌ Заявку #${wd.id} відхилено. <b>${wd.amount}</b> бонусів повернено на баланс.`);
    return { pendingCount: db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'").get().n };
  }

  // ---------- юзери ----------
  const USER_SELECT = `
    SELECT u.id, u.first_name AS name, u.username, u.balance, u.earned_total AS earned, u.subscribed, u.banned,
           u.created_at AS createdAt, u.last_seen AS lastSeen, u.referrer_id AS referrerId,
           (SELECT COUNT(*) FROM users r WHERE r.referrer_id = u.id) AS refsTotal,
           (SELECT COUNT(*) FROM users r WHERE r.referrer_id = u.id AND r.ref_rewarded = 1) AS refsActive,
           (SELECT COALESCE(SUM(amount),0) FROM withdrawals w WHERE w.user_id = u.id AND w.status = 'done') AS paid
      FROM users u`;

  function userRow(id) {
    const u = db.prepare(USER_SELECT + ' WHERE u.id = ?').get(id);
    if (!u) throw new ApiError(404, 'not_found', 'Юзера не знайдено');
    return u;
  }

  function usersList(body) {
    const q = String(body?.q ?? '').trim().replace(/^@/, '').slice(0, 64);
    const offset = clampInt(body?.offset, 0, 1e7, 0);
    let where = '';
    const params = [];
    if (q) {
      const like = '%' + q.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      const byText = "ulower(u.username) LIKE ? ESCAPE '\\' OR ulower(u.first_name) LIKE ? ESCAPE '\\'";
      if (/^\d{1,15}$/.test(q)) { where = ' WHERE u.id = ? OR ' + byText; params.push(Number(q), like, like); }
      else { where = ' WHERE ' + byText; params.push(like, like); }
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM users u' + where).get(...params).n;
    const users = db.prepare(USER_SELECT + where + ' ORDER BY u.created_at DESC, u.id DESC LIMIT 15 OFFSET ?').all(...params, offset);
    return { total, users };
  }

  function adjustBalance(adminId, id, body) {
    const delta = Number(body?.delta);
    if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1e7) throw new ApiError(400, 'bad_value', 'Вкажи ціле число, не 0');
    tx(db, () => {
      const u = db.prepare('SELECT balance FROM users WHERE id = ?').get(id);
      if (!u) throw new ApiError(404, 'not_found', 'Юзера не знайдено');
      if (u.balance + delta < 0) throw new ApiError(400, 'insufficient', `Баланс не може бути від'ємним (зараз ${u.balance})`);
      credit(id, delta, { countAsEarned: false });
    });
    adminLog(adminId, 'balance', `юзер ${id}: ${delta > 0 ? '+' : ''}${delta}`);
    if (body?.notify) tg.notify(id, `ℹ️ Адміністратор змінив твій баланс: <b>${delta > 0 ? '+' : ''}${delta}</b> бонусів.`);
    return { user: userRow(id) };
  }

  function setBan(adminId, id, body) {
    if (config.adminIds.has(id)) throw new ApiError(400, 'cant_ban_admin', 'Адміна не можна заблокувати');
    const banned = body?.banned ? 1 : 0;
    const r = db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned, id);
    if (r.changes === 0) throw new ApiError(404, 'not_found', 'Юзера не знайдено');
    adminLog(adminId, banned ? 'ban' : 'unban', `юзер ${id}`);
    return { user: userRow(id) };
  }

  // ---------- канали ----------
  const normalizeInvite = (u) => {
    const s = String(u ?? '').trim();
    return /^https:\/\/t\.me\/[+\w\/-]{3,}$/i.test(s) ? s : null;
  };

  function parseChannelInput(raw, rawUrl) {
    const s0 = String(raw ?? '').trim();
    if (!s0) throw new ApiError(400, 'bad_channel', 'Вкажи @username каналу або посилання на нього');
    if (/^-100\d{5,}$/.test(s0)) {
      const url = normalizeInvite(rawUrl);
      if (!url) throw new ApiError(400, 'need_invite', 'Для каналу за ID вкажи ще й посилання-запрошення (https://t.me/+…)');
      return { chat: s0, url, username: null };
    }
    if (/t\.me\/(\+|joinchat\/)/i.test(s0) || s0.startsWith('+')) {
      throw new ApiError(400, 'invite_link', 'Це посилання-запрошення. Для приватного каналу вкажи його ID (-100…) у першому полі, а це посилання — у другому.');
    }
    const name = s0.replace(/^https?:\/\//i, '').replace(/^(www\.)?t(elegram)?\.me\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) {
      throw new ApiError(400, 'bad_username', 'Некоректний username. Приклад: @my_channel або https://t.me/my_channel');
    }
    return { chat: '@' + name, url: 'https://t.me/' + name, username: name };
  }

  async function addChannel(adminId, body) {
    const parsed = parseChannelInput(body?.chat ?? body?.username, body?.url);
    if (db.prepare('SELECT COUNT(*) AS n FROM channels').get().n >= 10) throw new ApiError(400, 'too_many', 'Максимум 10 каналів');

    let info;
    let warning = null;
    try {
      info = await tg.call('getChat', { chat_id: parsed.chat });
      const me = await getMe();
      const m = await tg.call('getChatMember', { chat_id: parsed.chat, user_id: me.id });
      if (['left', 'kicked'].includes(m.status)) {
        throw new ApiError(400, 'bot_not_in_channel', `Бота @${bot.username} немає в цьому каналі. Додай його адміністратором.`);
      }
      if (!['administrator', 'creator'].includes(m.status)) {
        warning = 'Бот не є адміністратором — перевірка підписки може не працювати. Зроби його адміном каналу.';
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, 'channel_unreachable', explainTg(e));
    }
    if (!['channel', 'supergroup', 'group'].includes(info.type)) {
      throw new ApiError(400, 'not_a_channel', 'Це не канал і не група. Вкажи канал, на який треба підписатись.');
    }

    const title = String(body?.title ?? '').trim().slice(0, 64) || info.title || parsed.chat;
    const url = info.username ? 'https://t.me/' + info.username : parsed.url;
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM channels').get().p;
    const r = db.prepare('INSERT OR IGNORE INTO channels(chat, title, url, position) VALUES (?,?,?,?)').run(parsed.chat, title, url, pos);
    if (r.changes === 0) throw new ApiError(409, 'already_added', 'Цей канал уже доданий');
    adminLog(adminId, 'channel_add', `${parsed.chat} «${title}»`);
    return { warning, channels: listChannels() };
  }

  /** Живий статус кожного каналу: чи бот там адмін і може перевіряти підписку. */
  async function channelsStatus() {
    const list = listChannels();
    const out = await Promise.all(list.map(async (ch) => {
      try {
        const me = await getMe();
        const m = await tg.call('getChatMember', { chat_id: ch.chat, user_id: me.id });
        if (['administrator', 'creator'].includes(m.status)) return { ...ch, ok: true };
        return { ...ch, ok: false, problem: `Бот не адміністратор (статус: ${m.status}). Додай @${bot.username} адміном.` };
      } catch (e) {
        return { ...ch, ok: false, problem: explainTg(e) };
      }
    }));
    return { channels: out };
  }

  function deleteChannel(adminId, id) {
    const ch = db.prepare('SELECT chat, title FROM channels WHERE id = ?').get(id);
    if (!ch) throw new ApiError(404, 'not_found', 'Канал не знайдено');
    db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    adminLog(adminId, 'channel_del', `${ch.chat} «${ch.title}»`);
    return { channels: listChannels() };
  }

  // ---------- налаштування і правила ----------
  function saveSettings(adminId, body) {
    const next = {};
    for (const [field, key, min, max] of [['minWithdraw', 'min_withdraw', 1, 1e9], ['refBonus', 'ref_bonus', 0, 1e6], ['usdtRate', 'usdt_rate', 1, 1e6]]) {
      if (body?.[field] === undefined) continue;
      const n = Number(body[field]);
      if (!Number.isSafeInteger(n) || n < min || n > max) throw new ApiError(400, 'bad_value', `Некоректне значення: ${field} (від ${min} до ${max})`);
      next[key] = n;
    }
    for (const [k, v] of Object.entries(next)) setSetting(k, v);
    adminLog(adminId, 'settings', JSON.stringify(next));
    return { settings: settings() };
  }

  function saveConfig(adminId, body) {
    let cfg;
    try { cfg = validateConfig(body); } catch (e) {
      if (e instanceof ConfigError) throw new ApiError(400, 'bad_config', e.message);
      throw e;
    }
    saveGameConfig(cfg);
    adminLog(adminId, 'game_config', `рівнів ${cfg.levels.length}, нагород ${cfg.bonuses.length}, завдань ${cfg.tasks.length}`);
    return { config: cfg };
  }

  // ---------- розсилка ----------
  let job = null;
  const snapshot = () => (job ? { ...job } : null);

  async function sendOne(chatId, text, markup) {
    const params = { chat_id: chatId, text, disable_web_page_preview: true };
    if (markup) params.reply_markup = markup;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await tg.call('sendMessage', params);
        return 'sent';
      } catch (e) {
        const m = /retry after (\d+)/i.exec(e.description || '');
        if (m && attempt === 0) { await sleep(Math.min(Number(m[1]), 30) * 1000 + 300); continue; }
        if (e instanceof TgError && (e.code === 403 || /blocked|deactivated|chat not found/i.test(e.description))) return 'blocked';
        return 'failed';
      }
    }
    return 'failed';
  }

  async function runBroadcast(j, ids, text, markup) {
    for (const id of ids) {
      const r = await sendOne(id, text, markup);
      if (r === 'sent') j.sent++; else if (r === 'blocked') j.blocked++; else j.failed++;
      await sleep(broadcastDelayMs); // ≈20 повідомлень/с — нижче ліміту Telegram (30/с)
    }
    j.running = false;
    j.finishedAt = now();
  }

  function startBroadcast(adminId, body) {
    const text = String(body?.text ?? '').trim();
    if (!text) throw new ApiError(400, 'empty', 'Напиши текст повідомлення');
    if (text.length > 3500) throw new ApiError(400, 'too_long', 'Максимум 3500 символів');
    if (job && job.running) throw new ApiError(409, 'broadcast_running', 'Попередня розсилка ще триває');

    const test = !!body?.test;
    const audience = body?.audience === 'subscribed' ? 'subscribed' : 'all';
    const ids = test
      ? [adminId]
      : db.prepare(`SELECT id FROM users WHERE banned = 0${audience === 'subscribed' ? ' AND subscribed = 1' : ''}`).all().map((r) => r.id);
    if (!ids.length) throw new ApiError(400, 'no_recipients', 'Немає одержувачів');

    let markup;
    if (body?.button) {
      const https = /^https:\/\//.test(config.publicUrl);
      const btn = https
        ? { text: '🚀 Відкрити додаток', web_app: { url: config.publicUrl } }
        : { text: '🚀 Відкрити додаток', url: `https://t.me/${bot.username}/${config.appShortName}` };
      markup = { inline_keyboard: [[btn]] };
    }

    job = { total: ids.length, sent: 0, failed: 0, blocked: 0, running: true, test, startedAt: now(), finishedAt: null };
    adminLog(adminId, test ? 'broadcast_test' : 'broadcast', `${ids.length} одерж., ${audience}, ${text.length} симв.`);
    runBroadcast(job, ids, text, markup).catch((e) => { log.error('broadcast', e.message); job.running = false; });
    return { job: snapshot() };
  }

  /** Скільки людей отримає розсилку — для підтвердження перед відправкою. */
  function audienceCounts() {
    const all = db.prepare('SELECT COUNT(*) AS n FROM users WHERE banned = 0').get().n;
    const subscribed = db.prepare('SELECT COUNT(*) AS n FROM users WHERE banned = 0 AND subscribed = 1').get().n;
    return { all, subscribed };
  }

  // ---------- маршрутизація ----------
  async function route(pathname, method, body, admin) {
    const p = pathname.replace(/^\/api\/admin/, '');
    let m;

    if (method === 'POST') {
      switch (p) {
        case '/overview': return overview();
        case '/withdrawals': return { withdrawals: withdrawals(body?.scope === 'history' ? 'history' : 'pending') };
        case '/users': return usersList(body);
        case '/channels': return addChannel(admin.id, body);
        case '/channels/status': return channelsStatus();
        case '/config/get': return { config: getGameConfig() };
        case '/config/save': return saveConfig(admin.id, body);
        case '/settings': return saveSettings(admin.id, body);
        case '/broadcast': return startBroadcast(admin.id, body);
        case '/broadcast/status': return { job: snapshot(), audience: audienceCounts() };
      }
      if ((m = /^\/withdrawals\/(\d{1,12})$/.exec(p))) return resolveWithdrawal(admin.id, parseInt(m[1], 10), body);
      if ((m = /^\/users\/(\d{1,15})\/balance$/.exec(p))) return adjustBalance(admin.id, Number(m[1]), body);
      if ((m = /^\/users\/(\d{1,15})\/ban$/.exec(p))) return setBan(admin.id, Number(m[1]), body);
    }
    if (method === 'DELETE' && (m = /^\/channels\/(\d{1,9})$/.exec(p))) return deleteChannel(admin.id, parseInt(m[1], 10));
    return undefined;
  }

  return { route };
}

module.exports = { createAdmin };
