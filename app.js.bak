/**
 * Telegram Referral Mini App v3
 * + Обов'язкова підписка на канали з перевіркою
 *
 * Реальна перевірка працює тільки через бекенд (getChatMember).
 * Зараз: демо-режим + готова структура під API.
 */

const tg = window.Telegram?.WebApp;

// ===== Конфіг =====
const BOT_USERNAME = "YourBotUsername"; // <-- заміни
const APP_NAME = "app";

// URL бекенду (коли буде готовий). Залиш порожнім для демо.
const API_BASE = ""; // наприклад: "https://your-api.com"

// Обов'язкові канали
// username — без @, або invite link
// id — chat_id каналу (потрібен для бекенду, можна залишити null)
const REQUIRED_CHANNELS = [
  {
    id: null,
    username: "durov",           // приклад — заміни на свої
    title: "Канал 1",
    url: "https://t.me/durov",
    icon: "📢",
  },
  {
    id: null,
    username: "telegram",
    title: "Канал 2",
    url: "https://t.me/telegram",
    icon: "✈️",
  },
  // Додай скільки потрібно
];

// Рівні
const LEVELS = [
  { name: "Новачок", icon: "🌱", min: 0,   reward: 0 },
  { name: "Бронза",  icon: "🥉", min: 5,   reward: 50 },
  { name: "Срібло",  icon: "🥈", min: 15,  reward: 150 },
  { name: "Золото",  icon: "🥇", min: 40,  reward: 400 },
  { name: "Платина", icon: "💎", min: 80,  reward: 1000 },
  { name: "Легенда", icon: "👑", min: 150, reward: 2500 },
];

const BONUSES = [
  { id: "first",  title: "Перше запрошення", desc: "Запроси хоча б одного", amount: 25, need: 1 },
  { id: "bronze", title: "Бронзовий рівень", desc: "5 запрошень", amount: 50, need: 5 },
  { id: "silver", title: "Срібний рівень", desc: "15 запрошень", amount: 150, need: 15 },
  { id: "gold",   title: "Золотий рівень", desc: "40 запрошень", amount: 400, need: 40 },
  { id: "plat",   title: "Платиновий рівень", desc: "80 запрошень", amount: 1000, need: 80 },
];

const TASKS = [
  { id: "invite_1",  title: "Запроси 1 друга", desc: "Перший крок", reward: 15, need: 1, type: "refs" },
  { id: "invite_3",  title: "Запроси 3 друзів", desc: "Розгін", reward: 40, need: 3, type: "refs" },
  { id: "invite_10", title: "Запроси 10 друзів", desc: "Серйозний старт", reward: 120, need: 10, type: "refs" },
  { id: "share",     title: "Поділись посиланням", desc: "Натисни «Поділитися»", reward: 10, need: 1, type: "share" },
];

const MOCK_LEADERS = [
  { name: "Олександр К.", refs: 214, score: 4820 },
  { name: "Марія В.",     refs: 187, score: 4210 },
  { name: "Дмитро П.",    refs: 156, score: 3650 },
  { name: "Анна С.",      refs: 132, score: 2980 },
  { name: "Ігор Л.",      refs: 98,  score: 2140 },
];

// ===== Стан =====
let state = {
  userId: null,
  firstName: "",
  username: "",
  photoUrl: null,
  totalRefs: 0,
  activeRefs: 0,
  bonusBalance: 0,
  earnedTotal: 0,
  claimedBonuses: [],
  claimedTasks: [],
  sharedOnce: false,
  referrals: [],
  isDemo: false,
  onboarded: false,
  subscribed: false,          // чи пройшов перевірку підписки
  channelStatus: {},          // { username: true/false }
};

// ===== Init =====
function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor("#0f0f13");
      tg.setBackgroundColor("#0f0f13");
    } catch (_) {}

    const user = tg.initDataUnsafe?.user;
    if (user) {
      state.userId = String(user.id);
      state.firstName = user.first_name || "Користувач";
      state.username = user.username ? `@${user.username}` : "";
      state.photoUrl = user.photo_url || null;
    }
  }

  if (!state.userId) {
    state.userId = "demo_user";
    state.firstName = "Демо Користувач";
    state.username = "@demo";
    state.isDemo = true;
  }

  loadState();
  renderChannels();
  bindGateEvents();

  // Якщо вже підписаний раніше — одразу в апку
  if (state.subscribed) {
    openApp();
  } else {
    // Показуємо гейт
    document.getElementById("gate").style.display = "flex";
    document.getElementById("app").style.display = "none";
  }
}

// ===== Storage =====
function storageKey() {
  return `ref_v3_${state.userId}`;
}

function loadState() {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return;
    const s = JSON.parse(raw);
    Object.assign(state, {
      totalRefs: s.totalRefs || 0,
      activeRefs: s.activeRefs || 0,
      bonusBalance: s.bonusBalance || 0,
      earnedTotal: s.earnedTotal || 0,
      claimedBonuses: s.claimedBonuses || [],
      claimedTasks: s.claimedTasks || [],
      sharedOnce: !!s.sharedOnce,
      referrals: s.referrals || [],
      onboarded: !!s.onboarded,
      subscribed: !!s.subscribed,
      channelStatus: s.channelStatus || {},
    });
  } catch (e) {
    console.warn(e);
  }
}

function saveState() {
  const data = {
    totalRefs: state.totalRefs,
    activeRefs: state.activeRefs,
    bonusBalance: state.bonusBalance,
    earnedTotal: state.earnedTotal,
    claimedBonuses: state.claimedBonuses,
    claimedTasks: state.claimedTasks,
    sharedOnce: state.sharedOnce,
    referrals: state.referrals,
    onboarded: state.onboarded,
    subscribed: state.subscribed,
    channelStatus: state.channelStatus,
  };
  localStorage.setItem(storageKey(), JSON.stringify(data));
}

// ===== Subscription Gate =====
function renderChannels() {
  const box = document.getElementById("channelsList");
  box.innerHTML = "";

  REQUIRED_CHANNELS.forEach(ch => {
    const status = state.channelStatus[ch.username];
    const joined = status === true;
    const missing = status === false;

    const el = document.createElement("div");
    el.className = "channel-item" + (joined ? " joined" : "") + (missing ? " missing" : "");
    el.innerHTML = `
      <div class="channel-avatar">${ch.icon || "📢"}</div>
      <div class="channel-info">
        <div class="channel-name">${ch.title || "@" + ch.username}</div>
        <div class="channel-status">${
          joined ? "✓ Підписаний" : missing ? "✗ Не підписаний" : "Очікує перевірки"
        }</div>
      </div>
      <button class="channel-btn" data-url="${ch.url}">${joined ? "OK" : "Підписатись"}</button>
    `;

    el.querySelector(".channel-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openChannel(ch.url);
    });

    box.appendChild(el);
  });
}

function openChannel(url) {
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(url);
  } else {
    window.open(url, "_blank");
  }
  haptic("light");
}

async function checkSubscriptions() {
  const btn = document.getElementById("checkSubBtn");
  const errEl = document.getElementById("gateError");
  errEl.style.display = "none";
  btn.classList.add("loading");
  document.getElementById("checkSubText").textContent = "Перевіряю";

  try {
    let results;

    if (API_BASE) {
      // ===== Реальний запит до бекенду =====
      const res = await fetch(`${API_BASE}/api/check-subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initData: tg?.initData || "",
          userId: state.userId,
          channels: REQUIRED_CHANNELS.map(c => ({
            username: c.username,
            id: c.id,
          })),
        }),
      });

      if (!res.ok) throw new Error("Помилка сервера");
      const data = await res.json();
      // Очікуємо: { ok: true, channels: { username: true/false } }
      results = data.channels || {};
    } else {
      // ===== Демо-режим =====
      // Симулюємо перевірку (1.2 сек)
      await sleep(1200);

      // У демо: після першої перевірки вважаємо всі підписаними
      // (щоб можна було тестувати апку)
      results = {};
      REQUIRED_CHANNELS.forEach(ch => {
        results[ch.username] = true;
      });

      // Якщо хочеш тестувати "не підписаний" — розкоментуй:
      // results[REQUIRED_CHANNELS[0].username] = false;
    }

    // Оновлюємо статус
    state.channelStatus = results;
    renderChannels();

    const allJoined = REQUIRED_CHANNELS.every(ch => results[ch.username] === true);

    if (allJoined) {
      state.subscribed = true;
      saveState();
      haptic("success");
      showToast("Підписку підтверджено!");
      setTimeout(() => openApp(), 600);
    } else {
      const missing = REQUIRED_CHANNELS
        .filter(ch => !results[ch.username])
        .map(ch => ch.title || "@" + ch.username);

      errEl.textContent = "Не підписаний на: " + missing.join(", ");
      errEl.style.display = "block";
      haptic("medium");
    }
  } catch (e) {
    console.error(e);
    errEl.textContent = "Не вдалося перевірити. Спробуй ще раз.";
    errEl.style.display = "block";
  } finally {
    btn.classList.remove("loading");
    document.getElementById("checkSubText").textContent = "Перевірити підписку";
  }
}

function openApp() {
  document.getElementById("gate").style.display = "none";
  document.getElementById("app").style.display = "block";

  render();
  bindAppEvents();

  if (tg) {
    tg.MainButton.setText("Запросити друзів");
    tg.MainButton.onClick(shareLink);
    tg.MainButton.show();
  }

  if (state.isDemo) {
    document.getElementById("demoPanel").style.display = "block";
  }

  if (!state.onboarded) {
    setTimeout(() => {
      document.getElementById("onboarding").classList.add("show");
    }, 350);
  }
}

function bindGateEvents() {
  document.getElementById("checkSubBtn").addEventListener("click", checkSubscriptions);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===== Levels =====
function getCurrentLevel() {
  let cur = LEVELS[0];
  for (const l of LEVELS) {
    if (state.totalRefs >= l.min) cur = l;
  }
  return cur;
}

function getNextLevel() {
  const cur = getCurrentLevel();
  const i = LEVELS.findIndex(l => l.name === cur.name);
  return LEVELS[i + 1] || null;
}

// ===== Render App =====
function render() {
  document.getElementById("userName").textContent = state.firstName;
  document.getElementById("userUsername").textContent = state.username;

  const av = document.getElementById("avatar");
  if (state.photoUrl) {
    av.innerHTML = `<img src="${state.photoUrl}" alt="" />`;
  } else {
    av.textContent = (state.firstName[0] || "?").toUpperCase();
  }

  document.getElementById("bonusBalance").textContent = state.bonusBalance;

  const level = getCurrentLevel();
  const next = getNextLevel();
  document.getElementById("levelName").textContent = level.name;
  document.getElementById("levelIcon").textContent = level.icon;

  const prevMin = level.min;
  const nextMin = next ? next.min : level.min;
  const progress = next
    ? Math.min(100, ((state.totalRefs - prevMin) / (nextMin - prevMin)) * 100)
    : 100;

  document.getElementById("progressFill").style.width = progress + "%";
  document.getElementById("currentRefs").textContent = state.totalRefs;
  document.getElementById("nextLevelRefs").textContent = next ? next.min : "∞";

  document.getElementById("totalRefs").textContent = state.totalRefs;
  document.getElementById("activeRefs").textContent = state.activeRefs;
  document.getElementById("earnedBonus").textContent = state.earnedTotal;
  document.getElementById("refLink").value = buildRefLink();

  renderTasks();
  renderBonuses();
  renderLeaderboard();
  renderHistory();
}

function buildRefLink() {
  return `https://t.me/${BOT_USERNAME}/${APP_NAME}?startapp=ref_${state.userId}`;
}

// ===== Tasks / Bonuses / Leaderboard / History =====
function renderTasks() {
  const box = document.getElementById("tasksList");
  box.innerHTML = "";

  TASKS.forEach(t => {
    const claimed = state.claimedTasks.includes(t.id);
    let progress = 0;
    if (t.type === "refs") progress = state.totalRefs;
    if (t.type === "share") progress = state.sharedOnce ? 1 : 0;

    const done = progress >= t.need;
    const claimable = done && !claimed;

    const el = document.createElement("div");
    el.className = "task-item" + (claimed ? " done" : "") + (claimable ? " claimable" : "");
    el.innerHTML = `
      <div class="task-icon">${claimed ? "✅" : "🎯"}</div>
      <div class="task-info">
        <div class="task-title">${t.title}</div>
        <div class="task-desc">${t.desc}${t.type === "refs" ? ` · ${Math.min(progress, t.need)}/${t.need}` : ""}</div>
      </div>
      <div class="task-reward">${claimed ? "✓" : "+" + t.reward}</div>
    `;
    if (claimable) el.addEventListener("click", () => claimTask(t));
    box.appendChild(el);
  });
}

function claimTask(task) {
  if (state.claimedTasks.includes(task.id)) return;
  state.claimedTasks.push(task.id);
  state.bonusBalance += task.reward;
  state.earnedTotal += task.reward;
  saveState();
  render();
  haptic("success");
  showToast(`Завдання виконано! +${task.reward}`);
  if (task.reward >= 40) confetti();
}

function renderBonuses() {
  const box = document.getElementById("bonusesList");
  box.innerHTML = "";

  BONUSES.forEach(b => {
    const claimed = state.claimedBonuses.includes(b.id);
    const can = !claimed && state.totalRefs >= b.need;

    const el = document.createElement("div");
    el.className = "bonus-item" + (claimed ? " claimed" : "") + (can ? " claimable" : "");
    el.innerHTML = `
      <div class="bonus-icon">${claimed ? "✅" : "🎁"}</div>
      <div class="bonus-info">
        <div class="bonus-title">${b.title}</div>
        <div class="bonus-desc">${b.desc}</div>
      </div>
      <div class="bonus-amount">${claimed ? "Отримано" : "+" + b.amount}</div>
    `;
    if (can) el.addEventListener("click", () => claimBonus(b));
    box.appendChild(el);
  });
}

function claimBonus(b) {
  if (state.claimedBonuses.includes(b.id) || state.totalRefs < b.need) return;
  state.claimedBonuses.push(b.id);
  state.bonusBalance += b.amount;
  state.earnedTotal += b.amount;
  saveState();
  render();
  haptic("success");
  showToast(`+${b.amount} бонусів!`);
  confetti();
  bumpLevelIcon();
}

function renderLeaderboard() {
  const box = document.getElementById("leaderboard");
  box.innerHTML = "";

  const me = {
    name: state.firstName + " (ти)",
    refs: state.totalRefs,
    score: state.earnedTotal,
    isMe: true,
  };

  const list = [...MOCK_LEADERS, me].sort((a, b) => b.score - a.score).slice(0, 6);

  list.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = "lb-item" + (item.isMe ? " me" : "");
    el.innerHTML = `
      <div class="lb-rank">${i + 1}</div>
      <div class="lb-avatar">${(item.name[0] || "?").toUpperCase()}</div>
      <div class="lb-info">
        <div class="lb-name">${item.name}</div>
        <div class="lb-refs">${item.refs} запрошень</div>
      </div>
      <div class="lb-score">${item.score}</div>
    `;
    box.appendChild(el);
  });
}

function renderHistory() {
  const list = document.getElementById("refsList");
  const empty = document.getElementById("emptyRefs");
  list.innerHTML = "";

  if (!state.referrals.length) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  [...state.referrals].reverse().slice(0, 15).forEach(r => {
    const el = document.createElement("div");
    el.className = "ref-item";
    el.innerHTML = `
      <div class="ref-avatar">${(r.name[0] || "?").toUpperCase()}</div>
      <div class="ref-info">
        <div class="ref-name">${r.name}</div>
        <div class="ref-date">${r.date}</div>
      </div>
      <div class="ref-bonus">+${r.bonus}</div>
    `;
    list.appendChild(el);
  });
}

// ===== Actions =====
function addReferral(name) {
  const bonus = 10 + Math.floor(Math.random() * 16);
  const names = ["Оля", "Макс", "Андрій", "Катя", "Ігор", "Настя", "Діма", "Софія", "Віка", "Артем"];
  const finalName = name || (names[Math.floor(Math.random() * names.length)] + " " + (10 + Math.floor(Math.random() * 80)));

  state.referrals.push({
    name: finalName,
    date: new Date().toLocaleDateString("uk-UA", { day: "numeric", month: "short" }),
    bonus,
    active: true,
  });

  state.totalRefs += 1;
  state.activeRefs += 1;
  state.bonusBalance += bonus;
  state.earnedTotal += bonus;

  saveState();
  render();
  haptic("medium");
  showToast(`+1 запрошення · +${bonus} бонусів`);
  bumpLevelIcon();
}

function copyLink() {
  const val = buildRefLink();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(val).then(() => {
      showToast("Посилання скопійовано");
      haptic("light");
    });
  } else {
    const input = document.getElementById("refLink");
    input.select();
    document.execCommand("copy");
    showToast("Посилання скопійовано");
  }
}

function shareLink() {
  const link = buildRefLink();
  const text = "Приєднуйся за моїм посиланням і отримуй бонуси! 🚀";

  state.sharedOnce = true;
  saveState();
  renderTasks();

  if (tg?.openTelegramLink) {
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    tg.openTelegramLink(url);
  } else if (navigator.share) {
    navigator.share({ title: "Рефералка", text, url: link }).catch(() => copyLink());
  } else {
    copyLink();
  }
  haptic("light");
}

// ===== UI helpers =====
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2300);
}

function haptic(type = "light") {
  try {
    if (tg?.HapticFeedback) {
      if (type === "success") tg.HapticFeedback.notificationOccurred("success");
      else if (type === "medium") tg.HapticFeedback.impactOccurred("medium");
      else tg.HapticFeedback.impactOccurred("light");
    }
  } catch (_) {}
}

function bumpLevelIcon() {
  const icon = document.getElementById("levelIcon");
  icon.classList.remove("bump");
  void icon.offsetWidth;
  icon.classList.add("bump");
}

function confetti() {
  const box = document.getElementById("confetti");
  const colors = ["#2aabee", "#7b5cff", "#34c759", "#ff9f0a", "#ff453a", "#ffd60a"];
  for (let i = 0; i < 36; i++) {
    const p = document.createElement("div");
    p.className = "confetti-piece";
    p.style.left = Math.random() * 100 + "%";
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDelay = Math.random() * 0.4 + "s";
    p.style.animationDuration = 1.6 + Math.random() * 1.1 + "s";
    p.style.width = 6 + Math.random() * 6 + "px";
    p.style.height = p.style.width;
    box.appendChild(p);
    setTimeout(() => p.remove(), 3000);
  }
}

// ===== App Events =====
function bindAppEvents() {
  document.getElementById("copyBtn").addEventListener("click", copyLink);
  document.getElementById("shareBtn").addEventListener("click", shareLink);
  document.getElementById("inviteBtn").addEventListener("click", shareLink);

  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
      haptic("light");
    });
  });

  document.getElementById("startBtn").addEventListener("click", () => {
    state.onboarded = true;
    saveState();
    document.getElementById("onboarding").classList.remove("show");
    haptic("medium");
  });

  document.getElementById("addRefBtn")?.addEventListener("click", () => addReferral());
  document.getElementById("resetBtn")?.addEventListener("click", () => {
    if (confirm("Скинути всі дані?")) {
      localStorage.removeItem(storageKey());
      location.reload();
    }
  });
}

// Start
init();
