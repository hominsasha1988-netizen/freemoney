'use strict';

// Правила гри живуть ТІЛЬКИ на сервері; клієнт отримує їх у відповіді /api/state.
// Прогрес рахується по АКТИВОВАНИХ рефералах (тих, хто пройшов перевірку підписки).

const LEVELS = [
  { name: 'Новачок', icon: '🌱', min: 0 },
  { name: 'Бронза', icon: '🥉', min: 5 },
  { name: 'Срібло', icon: '🥈', min: 15 },
  { name: 'Золото', icon: '🥇', min: 40 },
  { name: 'Платина', icon: '💎', min: 80 },
  { name: 'Легенда', icon: '👑', min: 150 },
];

const BONUSES = [
  { id: 'first', title: 'Перше запрошення', desc: 'Запроси хоча б одного', amount: 25, need: 1 },
  { id: 'bronze', title: 'Бронзовий рівень', desc: '5 запрошень', amount: 50, need: 5 },
  { id: 'silver', title: 'Срібний рівень', desc: '15 запрошень', amount: 150, need: 15 },
  { id: 'gold', title: 'Золотий рівень', desc: '40 запрошень', amount: 400, need: 40 },
  { id: 'plat', title: 'Платиновий рівень', desc: '80 запрошень', amount: 1000, need: 80 },
];

const TASKS = [
  { id: 'invite_1', title: 'Запроси 1 друга', desc: 'Перший крок', reward: 15, need: 1, type: 'refs' },
  { id: 'invite_3', title: 'Запроси 3 друзів', desc: 'Розгін', reward: 40, need: 3, type: 'refs' },
  { id: 'invite_10', title: 'Запроси 10 друзів', desc: 'Серйозний старт', reward: 120, need: 10, type: 'refs' },
  { id: 'share', title: 'Поділись посиланням', desc: 'Натисни «Поділитися»', reward: 10, need: 1, type: 'share' },
];

// Формат TRC20 (USDT у мережі TRON): починається з T, 34 символи, base58
const TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

module.exports = { LEVELS, BONUSES, TASKS, TRC20_RE };
