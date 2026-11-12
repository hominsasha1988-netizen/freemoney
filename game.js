'use strict';

// Правила гри. Значення нижче — типові; адмін може змінити їх у панелі
// (зберігаються в БД, settings.game_config), тож код міняти не потрібно.
// Прогрес рахується по АКТИВОВАНИХ рефералах (тих, хто пройшов перевірку підписки).

const DEFAULT_CONFIG = {
  levels: [
    { name: 'Новачок', icon: '🌱', min: 0 },
    { name: 'Бронза', icon: '🥉', min: 5 },
    { name: 'Срібло', icon: '🥈', min: 15 },
    { name: 'Золото', icon: '🥇', min: 40 },
    { name: 'Платина', icon: '💎', min: 80 },
    { name: 'Легенда', icon: '👑', min: 150 },
  ],
  bonuses: [
    { id: 'first', title: 'Перше запрошення', desc: 'Запроси хоча б одного', amount: 25, need: 1 },
    { id: 'bronze', title: 'Бронзовий рівень', desc: '5 запрошень', amount: 50, need: 5 },
    { id: 'silver', title: 'Срібний рівень', desc: '15 запрошень', amount: 150, need: 15 },
    { id: 'gold', title: 'Золотий рівень', desc: '40 запрошень', amount: 400, need: 40 },
    { id: 'plat', title: 'Платиновий рівень', desc: '80 запрошень', amount: 1000, need: 80 },
  ],
  tasks: [
    { id: 'invite_1', title: 'Запроси 1 друга', desc: 'Перший крок', reward: 15, need: 1, type: 'refs' },
    { id: 'invite_3', title: 'Запроси 3 друзів', desc: 'Розгін', reward: 40, need: 3, type: 'refs' },
    { id: 'invite_10', title: 'Запроси 10 друзів', desc: 'Серйозний старт', reward: 120, need: 10, type: 'refs' },
    { id: 'share', title: 'Поділись посиланням', desc: 'Натисни «Поділитися»', reward: 10, need: 1, type: 'share' },
  ],
};

// Формат TRC20 (USDT у мережі TRON): починається з T, 34 символи, base58
const TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

class ConfigError extends Error {}

const str = (v, field, max, { allowEmpty = false } = {}) => {
  const s = String(v ?? '').trim();
  if ((!allowEmpty && !s) || s.length > max) throw new ConfigError(`«${field}»: від 1 до ${max} символів`);
  return s;
};
const int = (v, field, min, max) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ConfigError(`«${field}»: ціле число від ${min} до ${max}`);
  return n;
};
const idOf = (v, field) => {
  const s = String(v ?? '').trim();
  if (!/^[a-z0-9_]{1,24}$/.test(s)) throw new ConfigError(`${field}: некоректний id`);
  return s;
};
const uniq = (items, what) => {
  const ids = items.map((i) => i.id);
  if (new Set(ids).size !== ids.length) throw new ConfigError(`${what}: дублікати id`);
};

/** Перевіряє й нормалізує конфіг, який прийшов від адміна. Кидає ConfigError з поясненням. */
function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new ConfigError('Порожній конфіг');
  const { levels, bonuses, tasks } = cfg;
  if (!Array.isArray(levels) || levels.length < 1 || levels.length > 12) throw new ConfigError('Рівнів має бути від 1 до 12');
  if (!Array.isArray(bonuses) || bonuses.length > 30) throw new ConfigError('Нагород не більше 30');
  if (!Array.isArray(tasks) || tasks.length > 30) throw new ConfigError('Завдань не більше 30');

  const outLevels = levels.map((l) => ({
    name: str(l.name, 'Назва рівня', 24),
    icon: str(l.icon, 'Іконка рівня', 8),
    min: int(l.min, 'Запрошень для рівня', 0, 1e6),
  }));
  if (outLevels[0].min !== 0) throw new ConfigError('Перший рівень має починатись з 0 запрошень');
  for (let i = 1; i < outLevels.length; i++) {
    if (outLevels[i].min <= outLevels[i - 1].min) throw new ConfigError('Кількість запрошень для рівнів має зростати');
  }

  const outBonuses = bonuses.map((b) => ({
    id: idOf(b.id, 'Нагорода'),
    title: str(b.title, 'Назва нагороди', 48),
    desc: str(b.desc, 'Опис нагороди', 80, { allowEmpty: true }),
    amount: int(b.amount, 'Сума нагороди', 1, 1e7),
    need: int(b.need, 'Запрошень для нагороди', 1, 1e6),
  }));
  uniq(outBonuses, 'Нагороди');

  const outTasks = tasks.map((t) => {
    const type = t.type === 'share' ? 'share' : 'refs';
    return {
      id: idOf(t.id, 'Завдання'),
      title: str(t.title, 'Назва завдання', 48),
      desc: str(t.desc, 'Опис завдання', 80, { allowEmpty: true }),
      reward: int(t.reward, 'Винагорода за завдання', 1, 1e7),
      need: type === 'share' ? 1 : int(t.need, 'Запрошень для завдання', 1, 1e6),
      type,
    };
  });
  uniq(outTasks, 'Завдання');

  return { levels: outLevels, bonuses: outBonuses, tasks: outTasks };
}

module.exports = { DEFAULT_CONFIG, TRC20_RE, validateConfig, ConfigError };
