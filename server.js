'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('./config');
const { openDb, tx } = require('./db');
const { verifyInitData } = require('./auth');
const { createTg, TgError } = require('./telegram');
const { createBot } = require('./bot');
const { LEVELS, BONUSES, TASKS, TRC20_RE } = require('./game');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const now = () => Math.floor(Date.now() / 1000);

function createApp({ config, db, tg, bot, log = console }) {
  // ---------- settings ----------
  const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const getIntSetting = (key) => parseInt(getSetting(key), 10);
  const setSetting = (key, value) =>
    db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  const settings = () => ({
    minWithdraw: getIntSetting('min_withdraw'),
    refBonus: getIntSetting('ref_bonus'),
    usdtRate: getIntSetting('usdt_rate'),
  });

  const listChannels = () =>
    db.prepare('SELECT username, title FROM channels ORDER BY position, rowid').all()
      .map((c) => ({ username: c.username, title: c.title, url: `https://t.me/${c.username}` }));

  const isAdmin = (id) => config.adminIds.has(id);

  // ---------- rate limit (в пам'яті, достатньо для одного інстансу) ----------
  const buckets = new Map();
  function limit(key, max, windowMs) {
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < t) {
      b = { n: 0, reset: t + windowMs };
      buckets.set(key, b);
    }
    if (++b.n > max) throw new ApiError(429, 'rate_limited', 'Забагато запитів. Зачекай трохи.');
  }
  setInterval(() => {
    const t = Date.now();
    for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
  }, 60000).unref();

  // ---------- користувачі ----------
  function upsertUser(tgUser, startParam) {
    const t = now();
    const firstName = String(tgUser.first_name || 'Користувач').slice(0, 64);
    const username = tgUser.username ? String(tgUser.username).slice(0, 64) : null;
    const photo = typeof tgUser.photo_url === 'string' ? tgUser.photo_url.slice(0, 512) : null;

    return tx(db, () => {
      const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(tgUser.id);
      if (existing) {
        db.prepare('UPDATE users SET first_name = ?, username = ?, photo_url = ?, last_seen = ? WHERE id = ?')
          .run(firstName, username, photo, t, tgUser.id);
      } else {
        // Реферера фіксуємо ТІЛЬКИ при першому створенні юзера, не себе, і лише існуючого
        let referrerId = null;
        const m = /^ref_(\d{1,15})$/.exec(startParam || '');
        if (m) {
          const rid = parseInt(m[1], 10);
          if (rid !== tgUser.id && db.prepare('SELECT 1 FROM users WHERE id = ?').get(rid)) referrerId = rid;
        }
        db.prepare(
          'INSERT INTO users(id, first_name, username, photo_url, referrer_id, created_at, last_seen) VALUES (?,?,?,?,?,?,?)'
        ).run(tgUser.id, firstName, username, photo, referrerId, t, t);
      }
      return db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
    });
  }

  const credit = (userId, amount, { countAsEarned = true } = {}) =>
    db.prepare('UPDATE users SET balance = balance + ?, earned_total = earned_total + ? WHERE id = ?')
      .run(amount, countAsEarned ? amount : 0, userId);

  // ---------- стан для клієнта ----------
  function buildState(u) {
    const counts = db.prepare(
      'SELECT COUNT(*) AS total, COALESCE(SUM(ref_rewarded), 0) AS active FROM users WHERE referrer_id = ?'
    ).get(u.id);
    const claims = db.prepare('SELECT kind, key FROM claims WHERE user_id = ?').all(u.id);
    const claimedTasks = claims.filter((c) => c.kind === 'task').map((c) => c.key);
    const claimedBonuses = claims.filter((c) => c.kind === 'bonus').map((c) => c.key);

    const referrals = db.prepare(
      'SELECT first_name, created_at, ref_rewarded, ref_bonus_paid FROM users WHERE referrer_id = ? ORDER BY created_at DESC LIMIT 30'
    ).all(u.id).map((r) => ({ name: r.first_name, ts: r.created_at, active: !!r.ref_rewarded, bonus: r.ref_bonus_paid }));

    const withdrawals = db.prepare(
      'SELECT id, amount, address, status, created_at AS ts FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 30'
    ).all(u.id);

    const top = db.prepare(
      `SELECT u.id, u.first_name AS name, u.earned_total AS earned, COUNT(r.id) AS refs
         FROM users u JOIN users r ON r.referrer_id = u.id AND r.ref_rewarded = 1
        GROUP BY u.id ORDER BY refs DESC, earned DESC LIMIT 10`
    ).all();
    const leaders = top.map((l, i) => ({ rank: i + 1, name: l.name, refs: l.refs, earned: l.earned, isMe: l.id === u.id }));
    if (counts.active > 0 && !top.some((l) => l.id === u.id)) {
      const { better } = db.prepare(
        `SELECT COUNT(*) AS better FROM (SELECT referrer_id FROM users WHERE ref_rewarded = 1 GROUP BY referrer_id HAVING COUNT(*) > ?)`
      ).get(counts.active);
      leaders.push({ rank: better + 1, name: u.first_name, refs: counts.active, earned: u.earned_total, isMe: true });
    }

    return {
      user: { id: u.id, firstName: u.first_name, username: u.username ? '@' + u.username : '', photoUrl: u.photo_url, isAdmin: isAdmin(u.id) },
      balance: u.balance,
      earnedTotal: u.earned_total,
      totalRefs: counts.total,
      activeRefs: counts.active,
      subscribed: !!u.subscribed,
      onboarded: !!u.onboarded,
      sharedOnce: !!u.shared_once,
      refLink: `https://t.me/${bot.username}/${config.appShortName}?startapp=ref_${u.id}`,
      channels: listChannels(),
      levels: LEVELS,
      bonuses: BONUSES,
      tasks: TASKS,
      claimedTasks,
      claimedBonuses,
      referrals,
      withdrawals,
      leaders,
      settings: settings(),
    };
  }

  // ---------- підписка ----------
  async function isMember(username, userId) {
    try {
      const m = await tg.call('getChatMember', { chat_id: '@' + username, user_id: userId });
      return ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member === true);
    } catch (e) {
      // «user not found» / «participant» = юзера в каналі немає. Інші помилки = проблема налаштування (бот не адмін тощо)
      if (e instanceof TgError && /user not found|USER_NOT_PARTICIPANT|participant/i.test(e.description)) return false;
      throw e;
    }
  }

  async function verifySubscription(userId) {
    const results = {};
    for (const ch of listChannels()) {
      try {
        results[ch.username] = await isMember(ch.username, userId);
      } catch (e) {
        log.error(`getChatMember @${ch.username}:`, e.message);
        throw new ApiError(502, 'channel_check_failed',
          `Не вдалося перевірити канал «${ch.title}». Адміністратор має додати бота в канал як адміністратора.`);
      }
    }
    return { results, all: Object.values(results).every(Boolean) };
  }

  /** Нараховує бонус рефереру, коли друг уперше пройшов підписку. Ідемпотентно. */
  function activateReferral(userId) {
    return tx(db, () => {
      const u = db.prepare('SELECT referrer_id, ref_rewarded FROM users WHERE id = ?').get(userId);
      if (!u || !u.referrer_id || u.ref_rewarded) return null;
      const bonus = getIntSetting('ref_bonus');
      db.prepare('UPDATE users SET ref_rewarded = 1, ref_bonus_paid = ? WHERE id = ?').run(bonus, userId);
      credit(u.referrer_id, bonus);
      return { referrerId: u.referrer_id, bonus };
    });
  }

  // ---------- маршрути користувача ----------
  async function checkSubscription(u) {
    limit('sub:' + u.id, 1, 3000); // не частіше разу на 3 с (кожна перевірка = запит до Telegram)
    const { results, all } = await verifySubscription(u.id);
    db.prepare('UPDATE users SET subscribed = ? WHERE id = ?').run(all ? 1 : 0, u.id);

    if (all) {
      const act = activateReferral(u.id);
      if (act) {
        tg.notify(act.referrerId, `🎉 Твій друг <b>${esc(u.first_name)}</b> приєднався за твоїм посиланням. <b>+${act.bonus}</b> бонусів!`);
      }
    }
    return { ok: true, channels: results, all };
  }

  function claim(u, body) {
    const { kind, id } = body || {};
    const def = kind === 'task' ? TASKS.find((t) => t.id === id) : kind === 'bonus' ? BONUSES.find((b) => b.id === id) : null;
    if (!def) throw new ApiError(400, 'bad_request', 'Невідоме завдання');
    if (!u.subscribed) throw new ApiError(403, 'not_subscribed', 'Спочатку підпишись на канали');

    return tx(db, () => {
      const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
      const active = db.prepare('SELECT COALESCE(SUM(ref_rewarded), 0) AS n FROM users WHERE referrer_id = ?').get(u.id).n;
      const progress = kind === 'task' && def.type === 'share' ? (fresh.shared_once ? 1 : 0) : active;
      if (progress < def.need) throw new ApiError(400, 'not_ready', 'Умову ще не виконано');

      const amount = kind === 'task' ? def.reward : def.amount;
      const r = db.prepare('INSERT OR IGNORE INTO claims(user_id, kind, key, amount, created_at) VALUES (?,?,?,?,?)')
        .run(u.id, kind, def.id, amount, now());
      if (r.changes === 0) throw new ApiError(409, 'already_claimed', 'Уже отримано');
      credit(u.id, amount);
      return amount;
    });
  }

  async function withdraw(u, body) {
    if (!u.subscribed) throw new ApiError(403, 'not_subscribed', 'Спочатку підпишись на канали');

    const amount = Number(body?.amount);
    const address = String(body?.address ?? '').trim();
    const s = settings();
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new ApiError(400, 'bad_amount', 'Некоректна сума');
    if (amount < s.minWithdraw) throw new ApiError(400, 'below_min', `Мінімум ${s.minWithdraw} бонусів`);
    if (!TRC20_RE.test(address)) throw new ApiError(400, 'bad_address', 'Некоректна адреса. Потрібен USDT TRC20 (починається з T, 34 символи)');

    // Ліміт лише для запитів, що пройшли дешеву валідацію (далі йде запит до Telegram)
    limit('wd:' + u.id, 5, 60000);

    // Живе повторне підтвердження підписки перед виплатою (мережевий запит — поза транзакцією)
    const { all } = await verifySubscription(u.id);
    if (!all) {
      db.prepare('UPDATE users SET subscribed = 0 WHERE id = ?').run(u.id);
      throw new ApiError(403, 'not_subscribed', 'Ти відписався від каналу. Підпишись знову, щоб вивести бонуси');
    }

    const wd = tx(db, () => {
      const pending = db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ? AND status = 'pending'").get(u.id).n;
      if (pending >= 1) throw new ApiError(409, 'pending_exists', 'У тебе вже є заявка на розгляді');
      const r = db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').run(amount, u.id, amount);
      if (r.changes === 0) throw new ApiError(400, 'insufficient', 'Недостатньо бонусів');
      const ins = db.prepare('INSERT INTO withdrawals(user_id, amount, address, created_at) VALUES (?,?,?,?)').run(u.id, amount, address, now());
      return { id: Number(ins.lastInsertRowid), amount, address };
    });

    const usdt = (amount / s.usdtRate).toFixed(2);
    for (const adminId of config.adminIds) {
      tg.notify(adminId,
        `💸 <b>Нова заявка на вивід #${wd.id}</b>\nВід: ${esc(u.first_name)} ${u.username ? '(@' + esc(u.username) + ') ' : ''}<code>${u.id}</code>\n` +
        `Сума: <b>${wd.amount}</b> бонусів ≈ <b>${usdt} USDT</b>\nАдреса (TRC20): <code>${esc(wd.address)}</code>\n\nОбробити можна в адмін-панелі додатку.`);
    }
  }

  // ---------- адмінка ----------
  function adminOverview() {
    const stats = db.prepare(
      `SELECT COUNT(*) AS users, COALESCE(SUM(subscribed),0) AS subscribed,
              COALESCE(SUM(ref_rewarded),0) AS referrals, COALESCE(SUM(balance),0) AS balances FROM users`
    ).get();
    const pend = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum FROM withdrawals WHERE status = 'pending'").get();
    const paid = db.prepare("SELECT COALESCE(SUM(amount),0) AS sum FROM withdrawals WHERE status = 'done'").get();
    const pending = db.prepare(
      `SELECT w.id, w.amount, w.address, w.created_at AS ts, u.id AS userId, u.first_name AS name, u.username
         FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'pending' ORDER BY w.id`
    ).all();
    return {
      stats: { ...stats, pendingCount: pend.n, pendingSum: pend.sum, paidSum: paid.sum },
      pending, channels: listChannels(), settings: settings(),
    };
  }

  function adminSettings(body) {
    const next = {};
    for (const [field, key, min, max] of [['minWithdraw', 'min_withdraw', 1, 1e9], ['refBonus', 'ref_bonus', 0, 1e6], ['usdtRate', 'usdt_rate', 1, 1e6]]) {
      if (body[field] === undefined) continue;
      const n = Number(body[field]);
      if (!Number.isSafeInteger(n) || n < min || n > max) throw new ApiError(400, 'bad_value', `Некоректне значення: ${field}`);
      next[key] = n;
    }
    for (const [k, v] of Object.entries(next)) setSetting(k, v);
  }

  async function adminAddChannel(body) {
    const username = String(body?.username ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
    const title = String(body?.title ?? '').trim().slice(0, 64) || username;
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) throw new ApiError(400, 'bad_username', 'Некоректний username каналу');

    // Перевіряємо, що канал існує і бот там адмін — інакше getChatMember не працюватиме
    let warning = null;
    try {
      const me = await tg.call('getMe');
      const m = await tg.call('getChatMember', { chat_id: '@' + username, user_id: me.id });
      if (!['administrator', 'creator'].includes(m.status)) warning = 'Бот не є адміністратором каналу — перевірка підписки не працюватиме.';
    } catch (e) {
      throw new ApiError(400, 'channel_unreachable', 'Канал не знайдено або бот не доданий в нього як адміністратор.');
    }
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM channels').get().p;
    db.prepare('INSERT OR REPLACE INTO channels(username, title, position) VALUES (?,?,?)').run(username, title, pos);
    return warning;
  }

  async function adminResolve(id, body) {
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
    const usdt = (wd.amount / getIntSetting('usdt_rate')).toFixed(2);
    tg.notify(wd.user_id, action === 'approve'
      ? `✅ Заявку #${wd.id} виплачено: <b>${usdt} USDT</b> (${wd.amount} бонусів).`
      : `❌ Заявку #${wd.id} відхилено. <b>${wd.amount}</b> бонусів повернено на баланс.`);
  }

  // ---------- HTTP ----------
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 16 * 1024) { reject(new ApiError(413, 'too_large', 'Запит завеликий')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new ApiError(400, 'bad_json', 'Некоректний JSON')); }
      });
      req.on('error', reject);
    });
  }

  function send(res, status, obj, extra = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(body);
  }

  function authenticate(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('tma ')) throw new ApiError(401, 'unauthorized', 'Відкрий додаток через Telegram');
    const v = verifyInitData(h.slice(4), config.botToken, config.initDataMaxAgeSec);
    if (!v) throw new ApiError(401, 'unauthorized', 'Сесія недійсна. Закрий і відкрий додаток знову');
    return v;
  }

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/health') return send(res, 200, { ok: true });

    const auth = authenticate(req);
    limit('api:' + auth.user.id, 120, 60000);
    const user = upsertUser(auth.user, auth.startParam);
    const state = () => buildState(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
    const method = req.method;

    if (pathname === '/api/state' && method === 'GET') return send(res, 200, { ok: true, state: state() });

    if (method !== 'POST' && method !== 'DELETE') throw new ApiError(404, 'not_found', 'Не знайдено');
    const body = method === 'POST' ? await readJson(req) : {};

    switch (pathname) {
      case '/api/check-subscription': {
        const r = await checkSubscription(user);
        return send(res, 200, { ok: true, all: r.all, channels: r.channels, state: state() });
      }
      case '/api/onboarded':
        db.prepare('UPDATE users SET onboarded = 1 WHERE id = ?').run(user.id);
        return send(res, 200, { ok: true, state: state() });
      case '/api/share':
        db.prepare('UPDATE users SET shared_once = 1 WHERE id = ?').run(user.id);
        return send(res, 200, { ok: true, state: state() });
      case '/api/claim': {
        const amount = claim(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), body);
        return send(res, 200, { ok: true, amount, state: state() });
      }
      case '/api/withdraw':
        await withdraw(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), body);
        return send(res, 200, { ok: true, state: state() });
    }

    // ----- /api/admin/* -----
    if (pathname.startsWith('/api/admin/')) {
      if (!isAdmin(user.id)) throw new ApiError(403, 'forbidden', 'Немає доступу');
      if (pathname === '/api/admin/overview' && method === 'POST') return send(res, 200, { ok: true, admin: adminOverview() });
      if (pathname === '/api/admin/settings' && method === 'POST') {
        adminSettings(body);
        return send(res, 200, { ok: true, admin: adminOverview() });
      }
      if (pathname === '/api/admin/channels' && method === 'POST') {
        const warning = await adminAddChannel(body);
        return send(res, 200, { ok: true, warning, admin: adminOverview() });
      }
      let m;
      if ((m = /^\/api\/admin\/channels\/([A-Za-z0-9_]{1,40})$/.exec(pathname)) && method === 'DELETE') {
        db.prepare('DELETE FROM channels WHERE username = ?').run(m[1]);
        return send(res, 200, { ok: true, admin: adminOverview() });
      }
      if ((m = /^\/api\/admin\/withdrawals\/(\d{1,12})$/.exec(pathname)) && method === 'POST') {
        await adminResolve(parseInt(m[1], 10), body);
        return send(res, 200, { ok: true, admin: adminOverview() });
      }
    }
    throw new ApiError(404, 'not_found', 'Не знайдено');
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*', // авторизація через заголовок, не cookie → безпечно
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    };
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

      if (pathname === config.webhookPath && req.method === 'POST') {
        if (req.headers['x-telegram-bot-api-secret-token'] !== config.webhookSecret) { res.writeHead(403); return res.end(); }
        const update = await readJson(req);
        res.writeHead(200); res.end('ok');
        bot.onUpdate(update).catch((e) => log.error('update error', e.message));
        return;
      }
      if (pathname.startsWith('/api/')) {
        res.setHeader('access-control-allow-origin', cors['access-control-allow-origin']);
        return await handleApi(req, res, pathname);
      }
      return serveStatic(req, res, pathname);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { ok: false, error: e.code, message: e.message }, cors);
      log.error('Unhandled:', e);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'server_error', message: 'Помилка сервера' }, cors);
    }
  });

  return server;
}

async function main() {
  const config = loadConfig();
  const db = openDb(config.dbPath, config.seedChannels);
  const tg = createTg(config.botToken, config.tgApi);
  const bot = createBot({ config, tg });
  const server = createApp({ config, db, tg, bot });

  await new Promise((r) => server.listen(config.port, r));
  console.log(`Сервер на порті ${config.port}`);
  if (!config.adminIds.size) console.warn('⚠️  ADMIN_IDS не задано — адмін-панель буде недоступна.');
  if (!config.publicUrl) console.warn('⚠️  PUBLIC_URL не задано — кнопка меню і webhook не налаштовані (бот працює через polling).');

  await bot.start();

  const shutdown = () => { bot.stop(); server.close(); try { db.close(); } catch {} process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { createApp };
