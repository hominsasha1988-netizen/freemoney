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
  const m = { members: new Map(), badChats: new Set(), botAdminIn: new Set(['chan_one', 'chan_two']), sent: [] };
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
      if (method === 'sendMessage') { m.sent.push(p); return reply({ message_id: 1 }); }
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
  server = createApp({ config, db, tg, bot, log: { log() {}, error() {} } });
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
  assert.deepEqual(s.state.channels.map((c) => c.username), ['chan_one']);
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
  assert.equal(s.admin.settings.minWithdraw, 40);
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
  assert.equal(ov.admin.pending.length, 1);
  assert.equal(ov.admin.stats.pendingSum, 50);
  const wid = ov.admin.pending[0].id;

  // reject → гроші повертаються, повторно обробити не можна
  const rej = await post(`/api/admin/withdrawals/${wid}`, ADMIN, { action: 'reject' });
  assert.equal(rej.admin.pending.length, 0);
  assert.equal((await api('/api/state', { id: A })).state.balance, 60);
  assert.equal((await post(`/api/admin/withdrawals/${wid}`, ADMIN, { action: 'approve' })).error, 'already_resolved');
  assert.equal((await api('/api/state', { id: A })).state.balance, 60, 'без подвійного повернення');

  // approve → гроші не повертаються
  await post('/api/withdraw', A, { amount: 40, address: TRC20 });
  const wid2 = (await post('/api/admin/overview', ADMIN)).admin.pending[0].id;
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

test('адмін: канали додаються/видаляються, перевіряється доступ бота', async () => {
  assert.equal((await post('/api/admin/channels', ADMIN, { username: 'chan_two', title: 'Два' })).ok, true);
  assert.deepEqual((await post('/api/admin/overview', ADMIN)).admin.channels.map((c) => c.username), ['chan_one', 'chan_two']);
  tgMock.badChats.add('ghost_chan');
  assert.equal((await post('/api/admin/channels', ADMIN, { username: 'ghost_chan' })).error, 'channel_unreachable');
  assert.equal((await post('/api/admin/channels', ADMIN, { username: 'bad name!' })).error, 'bad_username');
  const del = await api('/api/admin/channels/chan_two', { id: ADMIN, method: 'DELETE' });
  assert.deepEqual(del.admin.channels.map((c) => c.username), ['chan_one']);
  assert.equal((await api('/api/admin/channels/chan_one', { id: 20, method: 'DELETE' })).status, 403);
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
