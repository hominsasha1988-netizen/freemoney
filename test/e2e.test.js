'use strict';
// Інтеграційні тести: справжній HTTP-сервер + SQLite in-memory + мок Telegram Bot API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { loadConfig } = require('../config');
const { openDb } = require('../db');
const { createTg } = require('../telegram');
const { createBot } = require('../bot');
const { createApp } = require('../server');
const { signInitData, verifyInitData } = require('../auth');

const TOKEN = '123456:TEST_TOKEN';
const ADMIN = 1000;
const TRC20 = 'T' + 'A'.repeat(33);

// ---------- мок Telegram ----------
function startMockTelegram() {
  const m = { members: new Map(), badChats: new Set(), blocked: new Set(), sent: [],
    botAdminIn: new Set(['chan_one', 'chan_two', '-1001234567890']) };
  m.join = (chat, uid) => m.members.set(`${chat.toLowerCase()}:${uid}`, 'member');
  m.leave = (chat, uid) => m.members.delete(`${chat.toLowerCase()}:${uid}`);
  m.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const p = raw ? JSON.parse(raw) : {};
      const reply = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      const fail = (code, description) => { res.setHeader('content-type', 'application/json'); res.statusCode = code; res.end(JSON.stringify({ ok: false, error_code: code, description })); };
      if (method === 'getMe') return reply({ id: 999, username: 'testbot' });
      if (method === 'sendMessage') {
        if (m.blocked.has(p.chat_id)) return fail(403, 'Forbidden: bot was blocked by the user');
        m.sent.push(p);
        return reply({ message_id: 1 });
      }
      if (method === 'getChat') {
        const chat = String(p.chat_id).replace(/^@/, '').toLowerCase();
        if (m.badChats.has(chat)) return fail(400, 'Bad Request: chat not found');
        if (chat === 'some_person') return reply({ id: 5, type: 'private', first_name: 'Person' });
        if (/^-100/.test(chat)) return reply({ id: Number(chat), type: 'channel', title: 'Приватний канал' });
        return reply({ id: 1, type: 'channel', title: 'Канал ' + chat, username: chat });
      }
      if (method === 'getChatMember') {
        const chat = String(p.chat_id).replace(/^@/, '').toLowerCase();
        if (m.badChats.has(chat)) return fail(400, 'Bad Request: chat not found');
        if (p.user_id === 999) return reply({ status: m.botAdminIn.has(chat) ? 'administrator' : 'member' });
        return reply({ status: m.members.get(`${chat}:${p.user_id}`) || 'left' });
      }
      return reply(true);
    });
  });
  return new Promise((r) => m.server.listen(0, () => { m.url = `http://127.0.0.1:${m.server.address().port}`; r(m); }));
}

let tgMock, server, base, db;
const initFor = (id, extra = {}, name = 'User' + id) =>
  signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: { id, first_name: name }, ...extra }, TOKEN);

async function api(path, { id, init, method = 'GET', body, startParam } = {}) {
  const initData = init ?? initFor(id, startParam ? { start_param: startParam } : {});
  const res = await fetch(base + path, {
    method,
    headers: { authorization: 'tma ' + initData, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}
const post = (path, id, body = {}, startParam) => api(path, { id, method: 'POST', body, startParam });
// Сповіщення йдуть у фоні (fire-and-forget) — чекаємо, поки мок їх отримає
async function sentMatching(pred, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (tgMock.sent.some(pred)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test.before(async () => {
  tgMock = await startMockTelegram();
  const config = loadConfig({
    BOT_TOKEN: TOKEN, ADMIN_IDS: String(ADMIN), TELEGRAM_API: tgMock.url, DB_PATH: ':memory:', CHANNELS: 'chan_one',
  });
  db = openDb(':memory:', config.seedChannels);
  const tg = createTg(config.botToken, config.tgApi);
  const bot = createBot({ config, tg, log: { log() {}, error() {} } });
  bot.setUsername('testbot');
  server = createApp({ config, db, tg, bot, log: { log() {}, error() {} }, broadcastDelayMs: 0 });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); tgMock.server.close(); });

// ---------- авторизація ----------
test('auth: відхиляє відсутній, підроблений і прострочений initData', async () => {
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const forged = initFor(1).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  assert.equal((await api('/api/state', { init: forged })).status, 401);
  const tampered = initFor(1).replace('User1', 'Hacker');
  assert.equal((await api('/api/state', { init: tampered })).status, 401);
  const old = signInitData({ auth_date: String(Math.floor(Date.now() / 1000) - 3 * 86400), user: { id: 1, first_name: 'X' } }, TOKEN);
  assert.equal((await api('/api/state', { init: old })).status, 401);
  const wrongToken = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: { id: 1, first_name: 'X' } }, 'other:token');
  assert.equal((await api('/api/state', { init: wrongToken })).status, 401);
  assert.ok(verifyInitData(initFor(5), TOKEN));
});

// ---------- підписка + реферали ----------
test('новий юзер: гейт, claim заборонений без підписки', async () => {
  const s = await api('/api/state', { id: 10 });
  assert.equal(s.status, 200);
  assert.equal(s.state.subscribed, false);
  assert.equal(s.state.balance, 0);
  assert.equal(s.state.refLink, 'https://t.me/testbot/app?startapp=ref_10');
  assert.deepEqual(s.state.channels.map((c) => c.url), ['https://t.me/chan_one']);
  assert.equal((await post('/api/claim', 10, { kind: 'bonus', id: 'first' })).status, 403);
});

test('підписка: не підписаний → false, після підписки → true; частота обмежена', async () => {
  let r = await post('/api/check-subscription', 11);
  assert.equal(r.all, false);
  assert.equal(r.state.subscribed, false);
  assert.equal((await post('/api/check-subscription', 11)).status, 429); // < 3 c
  tgMock.join('chan_one', 11);
  await new Promise((res) => setTimeout(res, 3100));
  r = await post('/api/check-subscription', 11);
  assert.equal(r.all, true);
  assert.equal(r.state.subscribed, true);
});

test('підписка: бот не адмін/канал недоступний → 502, а не «не підписаний»', async () => {
  tgMock.badChats.add('chan_one');
  const r = await post('/api/check-subscription', 12);
  assert.equal(r.status, 502);
  assert.equal(r.error, 'channel_check_failed');
  tgMock.badChats.delete('chan_one');
});

test('реферали: бонус при активації, без дублів, без self/неіснуючих/повторних', async () => {
  const A = 20, B = 21;
  await api('/api/state', { id: A }); // створили реферера
  tgMock.join('chan_one', B);
  assert.equal((await api('/api/state', { id: B, startParam: 'ref_' + A })).state.balance, 0);
  assert.equal((await api('/api/state', { id: A })).state.balance, 0); // поки B не підписався — нічого

  await post('/api/check-subscription', B, {}, 'ref_' + A);
  let a = (await api('/api/state', { id: A })).state;
  assert.equal(a.balance, 10);
  assert.equal(a.totalRefs, 1);
  assert.equal(a.activeRefs, 1);
  assert.equal(a.referrals[0].name, 'User21');
  assert.ok(await sentMatching((m) => m.chat_id === A && /\+10/.test(m.text)), 'реферер отримав сповіщення');

  await new Promise((res) => setTimeout(res, 3100));
  await post('/api/check-subscription', B);
  assert.equal((await api('/api/state', { id: A })).state.balance, 10, 'повторна перевірка не нараховує вдруге');

  // self-referral і неіснуючий реферер
  const S = (await api('/api/state', { id: 22, startParam: 'ref_22' })).state;
  assert.equal(S.totalRefs, 0);
  await api('/api/state', { id: 23, startParam: 'ref_99999' });
  assert.equal(db.prepare('SELECT referrer_id FROM users WHERE id = 23').get().referrer_id, null);
  // існуючого юзера не можна «перепризначити»
  await api('/api/state', { id: 24 });
  await api('/api/state', { id: 24, startParam: 'ref_' + A });
  assert.equal(db.prepare('SELECT referrer_id FROM users WHERE id = 24').get().referrer_id, null);
  // XSS-ім'я просто зберігається як текст (екранування на клієнті)
  assert.equal((await api('/api/state', { init: initFor(25, {}, '<img src=x onerror=1>') })).state.user.firstName, '<img src=x onerror=1>');
});

// ---------- бонуси / завдання ----------
test('claim: умова, одноразовість, гонка', async () => {
  const A = 20; // має 1 активного реферала, підписку немає → спочатку підписка
  tgMock.join('chan_one', A);
  await post('/api/check-subscription', A);

  assert.equal((await post('/api/claim', A, { kind: 'bonus', id: 'bronze' })).error, 'not_ready'); // треба 5
  assert.equal((await post('/api/claim', A, { kind: 'bonus', id: 'nope' })).status, 400);
  assert.equal((await post('/api/claim', A, { kind: 'task', id: 'share' })).error, 'not_ready'); // ще не ділився

  const results = await Promise.all([1, 2, 3, 4, 5].map(() => post('/api/claim', A, { kind: 'bonus', id: 'first' })));
  assert.equal(results.filter((r) => r.ok).length, 1, 'рівно один успішний claim');
  assert.equal(results.filter((r) => r.status === 409).length, 4);

  await post('/api/share', A);
  assert.equal((await post('/api/claim', A, { kind: 'task', id: 'share' })).amount, 10);
  assert.equal((await post('/api/claim', A, { kind: 'task', id: 'invite_1' })).amount, 15);
  const st = (await api('/api/state', { id: A })).state;
  assert.equal(st.balance, 10 + 25 + 10 + 15);
  assert.deepEqual(st.claimedBonuses, ['first']);
});

// ---------- вивід + адмінка ----------
test('вивід: валідація, заявка, адмін approve/reject, повернення коштів', async () => {
  const A = 20; // баланс 60
  assert.equal((await post('/api/withdraw', A, { amount: 60, address: TRC20 })).error, 'below_min'); // мін 100
  assert.equal((await post('/api/admin/settings', A, { minWithdraw: 10 })).status, 403, 'не-адмін не може міняти налаштування');
  assert.equal((await post('/api/admin/overview', A)).status, 403);

  const s = await post('/api/admin/settings', ADMIN, { minWithdraw: 40, usdtRate: 10 });
  assert.equal(s.settings.minWithdraw, 40);
  assert.equal((await post('/api/admin/settings', ADMIN, { minWithdraw: -5 })).status, 400);

  assert.equal((await post('/api/withdraw', A, { amount: 50, address: 'not-an-address' })).error, 'bad_address');
  assert.equal((await post('/api/withdraw', A, { amount: 500, address: TRC20 })).error, 'insufficient');
  assert.equal((await post('/api/withdraw', A, { amount: 12.5, address: TRC20 })).error, 'bad_amount');

  const ok = await post('/api/withdraw', A, { amount: 50, address: TRC20 });
  assert.equal(ok.ok, true);
  assert.equal(ok.state.balance, 10);
  assert.equal(ok.state.withdrawals[0].status, 'pending');
  assert.ok(await sentMatching((m) => m.chat_id === ADMIN && /Нова заявка/.test(m.text) && m.text.includes(TRC20)), 'адмін отримав сповіщення');
  assert.equal((await post('/api/withdraw', A, { amount: 10, address: TRC20 })).status, 400); // 10 < min 40
  assert.equal((await post('/api/withdraw', A, { amount: 50, address: TRC20 })).error, 'pending_exists'); // одна заявка за раз

  const ov = await post('/api/admin/overview', ADMIN);
  assert.equal(ov.stats.pendingCount, 1);
  assert.equal(ov.stats.pendingSum, 50);
  const pend = (await post('/api/admin/withdrawals', ADMIN, { scope: 'pending' })).withdrawals;
  assert.equal(pend.length, 1);
  assert.equal(pend[0].address, TRC20);
  const wid = pend[0].id;

  // reject → гроші повертаються, повторно обробити не можна
  const rej = await post(`/api/admin/withdrawals/${wid}`, ADMIN, { action: 'reject' });
  assert.equal(rej.pendingCount, 0);
  assert.equal((await api('/api/state', { id: A })).state.balance, 60);
  assert.equal((await post(`/api/admin/withdrawals/${wid}`, ADMIN, { action: 'approve' })).error, 'already_resolved');
  assert.equal((await api('/api/state', { id: A })).state.balance, 60, 'без подвійного повернення');

  // approve → гроші не повертаються
  await post('/api/withdraw', A, { amount: 40, address: TRC20 });
  const wid2 = (await post('/api/admin/withdrawals', ADMIN, {})).withdrawals[0].id;
  const [r1, r2] = await Promise.all([
    post(`/api/admin/withdrawals/${wid2}`, ADMIN, { action: 'approve' }),
    post(`/api/admin/withdrawals/${wid2}`, ADMIN, { action: 'reject' }),
  ]);
  assert.equal([r1, r2].filter((r) => r.ok).length, 1, 'одна з двох паралельних дій');
  const bal = (await api('/api/state', { id: A })).state.balance;
  assert.ok(bal === 20 || bal === 60, 'баланс або 20 (виплачено), або 60 (відхилено) — не інакше');
  assert.ok(await sentMatching((m) => m.chat_id === A && /#\d+/.test(m.text) && /(виплачено|відхилено)/.test(m.text)));
});

test('вивід заблокований, якщо юзер відписався від каналу', async () => {
  const A = 20;
  const before = (await api('/api/state', { id: A })).state.balance;
  await post('/api/admin/settings', ADMIN, { minWithdraw: 1 });
  tgMock.leave('chan_one', A);
  const r = await post('/api/withdraw', A, { amount: 1, address: TRC20 });
  assert.equal(r.error, 'not_subscribed');
  const st = (await api('/api/state', { id: A })).state;
  assert.equal(st.balance, before, 'баланс не списано');
  assert.equal(st.subscribed, false, 'гейт знову закритий');
});

test('адмін-ендпоінти закриті для звичайних юзерів', async () => {
  for (const [p, body] of [['/api/admin/channels', { chat: 'chan_two' }], ['/api/admin/users', {}], ['/api/admin/broadcast', { text: 'x' }],
    ['/api/admin/config/save', {}], ['/api/admin/users/20/ban', { banned: true }], ['/api/admin/users/20/balance', { delta: 5 }]]) {
    assert.equal((await post(p, 20, body)).status, 403, p);
  }
  assert.equal((await api('/api/admin/channels/1', { id: 20, method: 'DELETE' })).status, 403);
});

test('лідерборд рахує реальні дані', async () => {
  const s = (await api('/api/state', { id: 20 })).state;
  assert.equal(s.leaders[0].refs, 1);
  assert.equal(s.leaders[0].isMe, true);
});

// ---------- статика / бот ----------
test('статика: index віддається, path traversal заблоковано', async () => {
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /<html/i);
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/config.js', '/data/app.db']) {
    const r = await fetch(base + p);
    assert.notEqual(r.status, 200, p);
  }
});

test('бот: /start відповідає кнопкою, ref-параметр дає startapp-посилання', async () => {
  const config = loadConfig({ BOT_TOKEN: TOKEN, PUBLIC_URL: 'https://example.com', TELEGRAM_API: tgMock.url, DB_PATH: ':memory:' });
  const bot = createBot({ config, tg: createTg(TOKEN, tgMock.url), log: { log() {}, error() {} } });
  bot.setUsername('testbot');
  tgMock.sent.length = 0;
  await bot.onUpdate({ message: { text: '/start', chat: { id: 77, type: 'private' } } });
  assert.equal(tgMock.sent[0].reply_markup.inline_keyboard[0][0].web_app.url, 'https://example.com');
  await bot.onUpdate({ message: { text: '/start ref_555', chat: { id: 77, type: 'private' } } });
  assert.equal(tgMock.sent[1].reply_markup.inline_keyboard[0][0].url, 'https://t.me/testbot/app?startapp=ref_555');
  await bot.onUpdate({ message: { text: '/start', chat: { id: -5, type: 'group' } } });
  assert.equal(tgMock.sent.length, 2, 'у групах не відповідає');
});

test('webhook: без правильного секрету → 403', async () => {
  const config = loadConfig({ BOT_TOKEN: TOKEN });
  const bad = await fetch(base + config.webhookPath, { method: 'POST', body: '{}', headers: { 'x-telegram-bot-api-secret-token': 'nope' } });
  assert.equal(bad.status, 403);
  const good = await fetch(base + config.webhookPath, { method: 'POST', body: '{}', headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret } });
  assert.equal(good.status, 200);
});

// =====================================================================
//                       Адмін-панель v2
// =====================================================================

test('канали: різні формати вводу, зрозумілі помилки, приватні канали, статус', async () => {
  // посилання замість username, назва підтягується з Telegram
  let r = await post('/api/admin/channels', ADMIN, { chat: 'https://t.me/chan_two' });
  assert.equal(r.ok, true);
  assert.equal(r.warning, null);
  const two = r.channels.find((c) => c.chat === '@chan_two');
  assert.equal(two.title, 'Канал chan_two');
  assert.equal(two.url, 'https://t.me/chan_two');

  assert.equal((await post('/api/admin/channels', ADMIN, { chat: '@Chan_Two' })).error, 'already_added', 'без урахування регістру');

  // зрозумілі повідомлення про помилки
  tgMock.badChats.add('ghost_chan');
  r = await post('/api/admin/channels', ADMIN, { chat: '@ghost_chan' });
  assert.equal(r.error, 'channel_unreachable');
  assert.match(r.message, /не знайдено/);
  assert.equal((await post('/api/admin/channels', ADMIN, { chat: 'bad name!' })).error, 'bad_username');
  assert.equal((await post('/api/admin/channels', ADMIN, { chat: '' })).error, 'bad_channel');
  assert.equal((await post('/api/admin/channels', ADMIN, { chat: '@some_person' })).error, 'not_a_channel');
  assert.equal((await post('/api/admin/channels', ADMIN, { chat: 'https://t.me/+AbCdEf123' })).error, 'invite_link');

  // бот у каналі, але не адмін → додається з попередженням
  r = await post('/api/admin/channels', ADMIN, { chat: '@not_admin_chan', title: 'Без прав' });
  assert.equal(r.ok, true);
  assert.match(r.warning, /не є адміністратором/);

  // приватний канал: ID + посилання-запрошення
  assert.equal((await post('/api/admin/channels', ADMIN, { chat: '-1001234567890' })).error, 'need_invite');
  r = await post('/api/admin/channels', ADMIN, { chat: '-1001234567890', url: 'https://t.me/+AbCdEf123' });
  assert.equal(r.ok, true);
  const priv = r.channels.find((c) => c.chat === '-1001234567890');
  assert.equal(priv.url, 'https://t.me/+AbCdEf123');
  assert.equal(priv.title, 'Приватний канал');

  // живий статус
  tgMock.botAdminIn.delete('-1001234567890');
  const st = (await post('/api/admin/channels/status', ADMIN)).channels;
  assert.equal(st.find((c) => c.chat === '@chan_one').ok, true);
  const bad = st.find((c) => c.chat === '-1001234567890');
  assert.equal(bad.ok, false);
  assert.match(bad.problem, /не адміністратор/i);
  tgMock.botAdminIn.add('-1001234567890');

  // перевірка підписки працює і для приватного каналу (ключ у відповіді — id каналу)
  const me = (await api('/api/state', { id: 40 })).state;
  assert.equal(me.channels.length, 4);
  tgMock.join('chan_one', 40); tgMock.join('chan_two', 40); tgMock.join('not_admin_chan', 40);
  let chk = await post('/api/check-subscription', 40);
  assert.equal(chk.all, false, 'не підписаний на приватний');
  assert.equal(chk.channels[priv.id], false);
  tgMock.join('-1001234567890', 40);
  await new Promise((res) => setTimeout(res, 3100));
  chk = await post('/api/check-subscription', 40);
  assert.equal(chk.all, true);

  // видалення
  const ids = (await post('/api/admin/channels/status', ADMIN)).channels.map((c) => c.id);
  for (const id of ids.slice(1)) assert.equal((await api('/api/admin/channels/' + id, { id: ADMIN, method: 'DELETE' })).ok, true);
  assert.equal((await api('/api/admin/channels/99999', { id: ADMIN, method: 'DELETE' })).status, 404);
  assert.deepEqual((await api('/api/state', { id: 41 })).state.channels.map((c) => c.url), ['https://t.me/chan_one']);
});

test('юзери: пошук, пагінація, зміна балансу, бан', async () => {
  const all = await post('/api/admin/users', ADMIN, {});
  assert.ok(all.total >= 10);
  assert.ok(all.users.length <= 15);

  const byId = await post('/api/admin/users', ADMIN, { q: '21' });
  assert.ok(byId.users.some((u) => u.id === 21));
  const byName = await post('/api/admin/users', ADMIN, { q: 'user21' });
  assert.equal(byName.users[0].id, 21);
  assert.equal(byName.users[0].name, 'User21');
  assert.equal((await post('/api/admin/users', ADMIN, { q: 'нема_такого' })).total, 0);
  assert.equal((await post('/api/admin/users', ADMIN, { q: '%' })).total, 0, 'спецсимволи LIKE екрануються');
  const a = (await post('/api/admin/users', ADMIN, { q: '20' })).users.find((u) => u.id === 20);
  assert.equal(a.refsActive, 1);
  assert.equal(a.refsTotal, 1);
  const page2 = await post('/api/admin/users', ADMIN, { offset: 15 });
  assert.ok(page2.users.every((u) => !all.users.some((x) => x.id === u.id)), 'друга сторінка не дублює першу');

  // баланс
  const before = (await api('/api/state', { id: 21 })).state.balance;
  let r = await post('/api/admin/users/21/balance', ADMIN, { delta: 100, notify: true });
  assert.equal(r.user.balance, before + 100);
  assert.ok(await sentMatching((m) => m.chat_id === 21 && /\+100/.test(m.text)), 'юзер отримав сповіщення');
  assert.equal((await post('/api/admin/users/21/balance', ADMIN, { delta: -100000 })).error, 'insufficient');
  assert.equal((await post('/api/admin/users/21/balance', ADMIN, { delta: 0 })).error, 'bad_value');
  assert.equal((await post('/api/admin/users/21/balance', ADMIN, { delta: 1.5 })).error, 'bad_value');
  assert.equal((await post('/api/admin/users/777777/balance', ADMIN, { delta: 5 })).status, 404);
  r = await post('/api/admin/users/21/balance', ADMIN, { delta: -100 });
  assert.equal(r.user.balance, before);

  // бан
  r = await post('/api/admin/users/21/ban', ADMIN, { banned: true });
  assert.equal(r.user.banned, 1);
  const blocked = await api('/api/state', { id: 21 });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error, 'banned');
  assert.equal((await post('/api/admin/users/' + ADMIN + '/ban', ADMIN, { banned: true })).error, 'cant_ban_admin');
  r = await post('/api/admin/users/21/ban', ADMIN, { banned: false });
  assert.equal((await api('/api/state', { id: 21 })).status, 200);
});

test('правила: редагування завдань/нагород/рівнів з адмінки діє одразу', async () => {
  const cur = (await post('/api/admin/config/get', ADMIN)).config;
  assert.equal(cur.tasks.find((t) => t.id === 'share').reward, 10);

  const edited = JSON.parse(JSON.stringify(cur));
  edited.tasks.find((t) => t.id === 'share').reward = 99;
  edited.bonuses.push({ id: 'vip', title: 'VIP', desc: '', amount: 7, need: 1 });
  edited.levels[1].name = 'Бронза+';
  const saved = await post('/api/admin/config/save', ADMIN, edited);
  assert.equal(saved.ok, true);

  // новий юзер бачить зміни і отримує нову суму
  tgMock.join('chan_one', 50);
  await post('/api/check-subscription', 50);
  const st = (await api('/api/state', { id: 50 })).state;
  assert.equal(st.levels[1].name, 'Бронза+');
  assert.ok(st.bonuses.some((b) => b.id === 'vip'));
  await post('/api/share', 50);
  assert.equal((await post('/api/claim', 50, { kind: 'task', id: 'share' })).amount, 99);
  assert.equal((await post('/api/claim', 50, { kind: 'bonus', id: 'vip' })).error, 'not_ready');

  // валідація
  const bad = (patch) => post('/api/admin/config/save', ADMIN, patch(JSON.parse(JSON.stringify(edited))));
  assert.equal((await bad((c) => { c.levels[1].min = 0; return c; })).error, 'bad_config', 'рівні мають зростати');
  assert.equal((await bad((c) => { c.levels[0].min = 3; return c; })).error, 'bad_config', 'перший рівень з 0');
  assert.equal((await bad((c) => { c.tasks[0].reward = -5; return c; })).error, 'bad_config');
  assert.equal((await bad((c) => { c.tasks[0].reward = 1.5; return c; })).error, 'bad_config');
  assert.equal((await bad((c) => { c.tasks[1].id = c.tasks[0].id; return c; })).error, 'bad_config', 'дублікат id');
  assert.equal((await bad((c) => { c.bonuses[0].id = 'Bad Id!'; return c; })).error, 'bad_config');
  assert.equal((await bad((c) => { c.tasks[0].title = ''; return c; })).error, 'bad_config');
  assert.equal((await bad((c) => { c.levels = []; return c; })).error, 'bad_config');
  assert.equal((await post('/api/admin/config/get', ADMIN)).config.tasks.find((t) => t.id === 'share').reward, 99, 'невалідне не збереглось');

  await post('/api/admin/config/save', ADMIN, cur); // повертаємо як було
});

test('розсилка: тест собі, аудиторії, заблоковані, бан виключений, кнопка', async () => {
  assert.equal((await post('/api/admin/broadcast', ADMIN, { text: '   ' })).error, 'empty');
  assert.equal((await post('/api/admin/broadcast', ADMIN, { text: 'x'.repeat(3600) })).error, 'too_long');

  const waitDone = async () => {
    for (let i = 0; i < 100; i++) {
      const s = await post('/api/admin/broadcast/status', ADMIN);
      if (s.job && !s.job.running) return s;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('розсилка не завершилась');
  };

  // тест: тільки адміну
  tgMock.sent.length = 0;
  await post('/api/admin/broadcast', ADMIN, { text: 'Тестове повідомлення', test: true });
  let s = await waitDone();
  assert.equal(s.job.total, 1);
  assert.equal(s.job.sent, 1);
  assert.deepEqual(tgMock.sent.map((m) => m.chat_id), [ADMIN]);
  assert.equal(tgMock.sent[0].parse_mode, undefined, 'простий текст, без HTML-розмітки');

  // усім: бан виключено, заблокований ботом — рахується окремо
  await post('/api/admin/users/22/ban', ADMIN, { banned: true });
  tgMock.blocked.add(23);
  const counts = (await post('/api/admin/broadcast/status', ADMIN)).audience; // рахуємо ПІСЛЯ бану
  assert.equal(counts.all, db.prepare('SELECT COUNT(*) AS n FROM users WHERE banned = 0').get().n);
  tgMock.sent.length = 0;
  const started = await post('/api/admin/broadcast', ADMIN, { text: '<b>Привіт</b> усім', audience: 'all', button: true });
  assert.equal(started.ok, true);
  s = await waitDone();
  assert.equal(s.job.total, counts.all);
  assert.equal(s.job.blocked, 1);
  assert.equal(s.job.sent + s.job.blocked + s.job.failed, s.job.total);
  assert.ok(!tgMock.sent.some((m) => m.chat_id === 22), 'забанений не отримав');
  assert.ok(!tgMock.sent.some((m) => m.chat_id === 23));
  assert.equal(tgMock.sent[0].text, '<b>Привіт</b> усім', 'текст не міняється');
  assert.ok(tgMock.sent[0].reply_markup.inline_keyboard[0][0].url.includes('t.me/testbot/app'), 'кнопка «Відкрити додаток»');
  tgMock.blocked.delete(23);
  await post('/api/admin/users/22/ban', ADMIN, { banned: false });

  // тільки підписані
  tgMock.sent.length = 0;
  await post('/api/admin/broadcast', ADMIN, { text: 'Для підписаних', audience: 'subscribed' });
  s = await waitDone();
  const subscribedIds = db.prepare('SELECT id FROM users WHERE subscribed = 1 AND banned = 0').all().map((r) => r.id);
  assert.equal(s.job.total, subscribedIds.length);
  assert.ok(tgMock.sent.every((m) => subscribedIds.includes(m.chat_id)));
});

test('огляд: статистика, графік за 14 днів, топ, журнал дій', async () => {
  const ov = await post('/api/admin/overview', ADMIN);
  assert.equal(ov.series.length, 14);
  assert.ok(ov.series[13].users >= 10, 'реєстрації за сьогодні');
  assert.ok(ov.series[13].activated >= 1, 'активації за сьогодні');
  assert.ok(ov.stats.users >= 10 && ov.stats.newToday >= 10);
  assert.equal(ov.top[0].id, 20);
  assert.ok(ov.recent.length > 0);
  assert.ok(ov.recent.some((r) => r.action === 'balance'));
  assert.ok(ov.recent.some((r) => r.action === 'broadcast'));
  const hist = (await post('/api/admin/withdrawals', ADMIN, { scope: 'history' })).withdrawals;
  assert.ok(hist.length >= 1 && hist.every((w) => w.status !== 'pending'));
});

test('міграція: стара БД (v4) оновлюється без втрати даних', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(os.tmpdir(), `mig-${process.pid}-${Date.now()}.db`);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL DEFAULT '', username TEXT, photo_url TEXT,
      referrer_id INTEGER, balance INTEGER NOT NULL DEFAULT 0, earned_total INTEGER NOT NULL DEFAULT 0, subscribed INTEGER NOT NULL DEFAULT 0,
      ref_rewarded INTEGER NOT NULL DEFAULT 0, ref_bonus_paid INTEGER NOT NULL DEFAULT 0, shared_once INTEGER NOT NULL DEFAULT 0,
      onboarded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE channels (username TEXT PRIMARY KEY COLLATE NOCASE, title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users(id, first_name, balance, created_at, last_seen) VALUES (1, 'Old', 77, 1, 1);
    INSERT INTO channels(username, title, position) VALUES ('old_chan', 'Старий канал', 0);`);
  old.close();

  const migrated = openDb(file, ['should_not_seed']);
  assert.equal(migrated.prepare('SELECT balance, banned FROM users WHERE id = 1').get().balance, 77);
  assert.equal(migrated.prepare('SELECT banned FROM users WHERE id = 1').get().banned, 0);
  const ch = migrated.prepare('SELECT chat, title, url FROM channels').all();
  assert.deepEqual(ch.map((c) => ({ ...c })), [{ chat: '@old_chan', title: 'Старий канал', url: 'https://t.me/old_chan' }]);
  migrated.close();
  migrated.constructor; // eslint-disable-line
  const again = openDb(file); // повторний запуск не ламає
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM channels').get().n, 1);
  again.close();
  for (const ext of ['', '-wal', '-shm']) try { fs.unlinkSync(file + ext); } catch {}
});

test('пошук юзерів не залежить від регістру, у тому числі для кирилиці', async () => {
  await api('/api/state', { init: initFor(60, {}, 'Максим') });
  for (const q of ['макс', 'МАКС', 'Максим', 'ксим']) {
    const r = await post('/api/admin/users', ADMIN, { q });
    assert.ok(r.users.some((u) => u.id === 60), `q="${q}"`);
  }
  assert.equal((await post('/api/admin/users', ADMIN, { q: 'максимка' })).users.some((u) => u.id === 60), false);
});
