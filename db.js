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
  ref_bonus_paid INTEGER NOT NULL DEFAULT 0,
  shared_once    INTEGER NOT NULL DEFAULT 0,
  onboarded      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);

-- Одноразові нагороди (завдання / бонуси): PRIMARY KEY гарантує, що вдруге не отримати
CREATE TABLE IF NOT EXISTS claims (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  amount     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, key)
);

CREATE TABLE IF NOT EXISTS channels (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  title    TEXT NOT NULL,
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
`;

const DEFAULT_SETTINGS = {
  min_withdraw: '100', // мін. сума виводу, у бонусах
  ref_bonus: '10',     // скільки бонусів рефереру за активованого друга
  usdt_rate: '100',    // скільки бонусів = 1 USDT (для відображення і виплат)
};

function openDb(file, seedChannels = []) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);

  const { c } = db.prepare('SELECT COUNT(*) AS c FROM channels').get();
  if (c === 0) {
    const insCh = db.prepare('INSERT OR IGNORE INTO channels(username, title, position) VALUES (?, ?, ?)');
    seedChannels.forEach((u, i) => insCh.run(u, u.replace(/_/g, ' '), i));
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
