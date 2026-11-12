'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,                 -- Telegram user id
  first_name     TEXT    NOT NULL DEFAULT '',
  username       TEXT,
  photo_url      TEXT,
  referrer_id    INTEGER REFERENCES users(id),
  balance        INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  earned_total   INTEGER NOT NULL DEFAULT 0,
  subscribed     INTEGER NOT NULL DEFAULT 0,
  ref_rewarded   INTEGER NOT NULL DEFAULT 0,          -- рефереру вже нараховано бонус за цього юзера
  ref_rewarded_at INTEGER,
  ref_bonus_paid INTEGER NOT NULL DEFAULT 0,
  shared_once    INTEGER NOT NULL DEFAULT 0,
  onboarded      INTEGER NOT NULL DEFAULT 0,
  banned         INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

-- Одноразові нагороди (завдання / бонуси): PRIMARY KEY гарантує, що вдруге не отримати
CREATE TABLE IF NOT EXISTS claims (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  amount     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, key)
);

-- chat: '@username' (публічний канал) або '-100…' (числовий ID, для приватних)
CREATE TABLE IF NOT EXISTS channels (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  title    TEXT NOT NULL,
  url      TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  address     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','rejected')),
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Журнал дій адміністраторів
CREATE TABLE IF NOT EXISTS admin_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  min_withdraw: '100', // мін. сума виводу, у бонусах
  ref_bonus: '10',     // скільки бонусів рефереру за активованого друга
  usdt_rate: '100',    // скільки бонусів = 1 USDT (для відображення і виплат)
};

const colNames = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/** Міграції зі старих версій бази (v4 → v5), безпечні для повторного запуску. */
function migrate(db) {
  // 1) старі канали мали PK = username
  let oldChannels = null;
  if (colNames(db, 'channels').includes('username')) {
    oldChannels = db.prepare('SELECT username, title, position FROM channels').all();
    db.exec('DROP TABLE channels');
  }
  db.exec(SCHEMA); // створює відсутні таблиці
  if (oldChannels) {
    const ins = db.prepare('INSERT OR IGNORE INTO channels(chat, title, url, position) VALUES (?,?,?,?)');
    for (const c of oldChannels) ins.run('@' + c.username, c.title, 'https://t.me/' + c.username, c.position);
  }
  // 2) нові колонки в users
  const cols = colNames(db, 'users');
  if (!cols.includes('banned')) db.exec('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('ref_rewarded_at')) db.exec('ALTER TABLE users ADD COLUMN ref_rewarded_at INTEGER');
}

function openDb(file, seedChannels = []) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // SQLite lower()/LIKE регістронезалежні лише для латиниці — додаємо Unicode-варіант для пошуку кирилиці
  db.function('ulower', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase()));
  migrate(db);

  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);

  const { c } = db.prepare('SELECT COUNT(*) AS c FROM channels').get();
  if (c === 0) {
    const insCh = db.prepare('INSERT OR IGNORE INTO channels(chat, title, url, position) VALUES (?,?,?,?)');
    seedChannels.forEach((u, i) => insCh.run('@' + u, u.replace(/_/g, ' '), 'https://t.me/' + u, i));
  }
  return db;
}

/** Атомарна транзакція (BEGIN IMMEDIATE — без гонок між одночасними запитами). */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { openDb, tx };
