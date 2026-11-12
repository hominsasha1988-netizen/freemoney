/**
 * Telegram Referral Mini App v4
 * Уся логіка (баланси, реферали, бонуси, вивід, підписка) — на сервері.
 * Клієнт лише показує стан із /api/state і викликає дії.
 */
const tg = window.Telegram?.WebApp;

// Порожній рядок = той самий домен, з якого відкрито апку (рекомендовано).
// Якщо фронт хоститься окремо — впиши сюди URL бекенду, напр. "https://my-app.onrender.com"
const API_BASE = "";

let S = null;            // стан із сервера
let appBound = false;    // чи вже навішані обробники головного екрана

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ===== API =====
async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { Authorization: "tma " + (tg?.initData || ""), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("Немає з'єднання з сервером");
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.message || "Помилка сервера");
    err.code = data?.error;
    throw err;
  }
  return data;
}

/** Виконує дію, показує помилку тостом, оновлює стан. */
async function action(path, opts) {
  try {
    const data = await api(path, opts);
    if (data.state) { S = data.state; }
    return data;
  } catch (e) {
    showToast(e.message);
    haptic("medium");
    if (e.code === "not_subscribed") { await reloadState(); if (!S.subscribed) showGate(); }
    return null;
  }
}

async function reloadState() {
  S = (await api("/api/state")).state;
}

// ===== Init =====
async function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#0f0f13"); tg.setBackgroundColor("#0f0f13"); } catch (_) {}
  }

  if (!tg?.initData) {
    return showFatal("Відкрий додаток через Telegram", "Цей додаток працює тільки всередині Telegram.");
  }

  try {
    await reloadState();
  } catch (e) {
    if (e.code === "banned") return showFatal("Доступ заблоковано", e.message);
    return showFatal("Не вдалося завантажити", e.message, true);
  }

  $("loading").style.display = "none";
  bindGateEvents();
  if (S.subscribed) openApp(); else showGate();
}

function showFatal(title, text, retry = false) {
  $("loading").style.display = "none";
  $("app").style.display = "none";
  const g = $("gate");
  g.style.display = "flex";
  g.querySelector(".gate-content").innerHTML = `
    <div class="gate-icon">⚠️</div>
    <h1>${esc(title)}</h1>
    <p class="gate-desc">${esc(text)}</p>
    ${retry ? '<button class="btn primary full" id="retryBtn">Спробувати ще раз</button>' : ""}`;
  $("retryBtn")?.addEventListener("click", () => location.reload());
}

function showGate() {
  $("loading").style.display = "none";
  $("app").style.display = "none";
  $("gate").style.display = "flex";
  tg?.MainButton?.hide();
  renderChannels();
}

// ===== Subscription Gate =====
let channelStatus = {};

function renderChannels() {
  const box = $("channelsList");
  box.innerHTML = "";
  S.channels.forEach((ch) => {
    const st = channelStatus[ch.id];
    const el = document.createElement("div");
    el.className = "channel-item" + (st === true ? " joined" : "") + (st === false ? " missing" : "");
    el.innerHTML = `
      <div class="channel-avatar">📢</div>
      <div class="channel-info">
        <div class="channel-name">${esc(ch.title)}</div>
        <div class="channel-status">${st === true ? "✓ Підписаний" : st === false ? "✗ Не підписаний" : "Очікує перевірки"}</div>
      </div>
      <button class="channel-btn">${st === true ? "OK" : "Підписатись"}</button>`;
    el.querySelector(".channel-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openChannel(ch.url);
    });
    box.appendChild(el);
  });
}

function openChannel(url) {
  if (tg?.openTelegramLink) tg.openTelegramLink(url);
  else window.open(url, "_blank");
  haptic("light");
}

let gateBound = false;
function bindGateEvents() {
  if (gateBound) return;
  gateBound = true;
  $("checkSubBtn").addEventListener("click", checkSubscriptions);
}

async function checkSubscriptions() {
  const btn = $("checkSubBtn");
  const errEl = $("gateError");
  errEl.style.display = "none";
  btn.classList.add("loading");
  $("checkSubText").textContent = "Перевіряю";

  try {
    const data = await api("/api/check-subscription", { method: "POST", body: {} });
    S = data.state;
    channelStatus = data.channels || {};
    renderChannels();

    if (data.all) {
      haptic("success");
      showToast("Підписку підтверджено!");
      setTimeout(openApp, 600);
    } else {
      const missing = S.channels.filter((c) => !channelStatus[c.id]).map((c) => c.title);
      errEl.textContent = "Не підписаний на: " + missing.join(", ");
      errEl.style.display = "block";
      haptic("medium");
    }
  } catch (e) {
    errEl.textContent = e.message || "Не вдалося перевірити. Спробуй ще раз.";
    errEl.style.display = "block";
  } finally {
    btn.classList.remove("loading");
    $("checkSubText").textContent = "Перевірити підписку";
  }
}

function openApp() {
  $("gate").style.display = "none";
  $("app").style.display = "block";
  render();
  if (!appBound) { bindAppEvents(); appBound = true; }

  if (tg) {
    tg.MainButton.setText("Запросити друзів");
    tg.MainButton.show();
  }
  if (!S.onboarded) setTimeout(() => $("onboarding").classList.add("show"), 350);
}

// ===== Levels =====
function currentLevel() {
  let cur = S.levels[0];
  for (const l of S.levels) if (S.activeRefs >= l.min) cur = l;
  return cur;
}
function nextLevel() {
  const i = S.levels.findIndex((l) => l.name === currentLevel().name);
  return S.levels[i + 1] || null;
}

// ===== Render =====
function render() {
  $("userName").textContent = S.user.firstName;
  $("userUsername").textContent = S.user.username;

  const av = $("avatar");
  if (S.user.photoUrl) {
    av.innerHTML = "";
    const img = document.createElement("img");
    img.alt = "";
    img.src = S.user.photoUrl;
    av.appendChild(img);
  } else {
    av.textContent = (S.user.firstName[0] || "?").toUpperCase();
  }

  $("bonusBalance").textContent = S.balance;

  const level = currentLevel();
  const next = nextLevel();
  $("levelName").textContent = level.name;
  $("levelIcon").textContent = level.icon;
  const progress = next ? Math.min(100, ((S.activeRefs - level.min) / (next.min - level.min)) * 100) : 100;
  $("progressFill").style.width = progress + "%";
  $("currentRefs").textContent = S.activeRefs;
  $("nextLevelRefs").textContent = next ? next.min : "∞";

  $("totalRefs").textContent = S.totalRefs;
  $("activeRefs").textContent = S.activeRefs;
  $("earnedBonus").textContent = S.earnedTotal;
  $("refLink").value = S.refLink;

  renderTasks();
  renderBonuses();
  renderLeaderboard();
  renderHistory();
  renderWithdraw();

  $("adminBtn").style.display = S.user.isAdmin ? "flex" : "none";
}

function renderTasks() {
  const box = $("tasksList");
  box.innerHTML = "";
  S.tasks.forEach((t) => {
    const claimed = S.claimedTasks.includes(t.id);
    const progress = t.type === "share" ? (S.sharedOnce ? 1 : 0) : S.activeRefs;
    const claimable = progress >= t.need && !claimed;
    const el = document.createElement("div");
    el.className = "task-item" + (claimed ? " done" : "") + (claimable ? " claimable" : "");
    el.innerHTML = `
      <div class="task-icon">${claimed ? "✅" : "🎯"}</div>
      <div class="task-info">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-desc">${esc(t.desc)}${t.type === "refs" ? ` · ${Math.min(progress, t.need)}/${t.need}` : ""}</div>
      </div>
      <div class="task-reward">${claimed ? "✓" : "+" + t.reward}</div>`;
    if (claimable) el.addEventListener("click", () => claim("task", t));
    box.appendChild(el);
  });
}

function renderBonuses() {
  const box = $("bonusesList");
  box.innerHTML = "";
  S.bonuses.forEach((b) => {
    const claimed = S.claimedBonuses.includes(b.id);
    const can = !claimed && S.activeRefs >= b.need;
    const el = document.createElement("div");
    el.className = "bonus-item" + (claimed ? " claimed" : "") + (can ? " claimable" : "");
    el.innerHTML = `
      <div class="bonus-icon">${claimed ? "✅" : "🎁"}</div>
      <div class="bonus-info">
        <div class="bonus-title">${esc(b.title)}</div>
        <div class="bonus-desc">${esc(b.desc)}</div>
      </div>
      <div class="bonus-amount">${claimed ? "Отримано" : "+" + b.amount}</div>`;
    if (can) el.addEventListener("click", () => claim("bonus", b));
    box.appendChild(el);
  });
}

async function claim(kind, def) {
  const prevLevel = currentLevel().name;
  const data = await action("/api/claim", { method: "POST", body: { kind, id: def.id } });
  if (!data) return;
  render();
  haptic("success");
  showToast(`+${data.amount} бонусів!`);
  if (data.amount >= 40) confetti();
  if (currentLevel().name !== prevLevel) bumpLevelIcon();
}

function renderLeaderboard() {
  const box = $("leaderboard");
  box.innerHTML = "";
  if (!S.leaders.length) {
    box.innerHTML = '<div class="empty-state" style="display:block">Рейтинг поки порожній.<br>Запроси друзів — і ти будеш першим!</div>';
    return;
  }
  S.leaders.forEach((l) => {
    const el = document.createElement("div");
    el.className = "lb-item" + (l.isMe ? " me" : "");
    el.innerHTML = `
      <div class="lb-rank">${l.rank}</div>
      <div class="lb-avatar">${esc((l.name[0] || "?").toUpperCase())}</div>
      <div class="lb-info">
        <div class="lb-name">${esc(l.name)}${l.isMe ? " (ти)" : ""}</div>
        <div class="lb-refs">${l.refs} запрошень</div>
      </div>
      <div class="lb-score">${l.earned}</div>`;
    box.appendChild(el);
  });
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
}

function renderHistory() {
  const list = $("refsList");
  const empty = $("emptyRefs");
  list.innerHTML = "";
  if (!S.referrals.length) { empty.style.display = "block"; return; }
  empty.style.display = "none";
  S.referrals.forEach((r) => {
    const el = document.createElement("div");
    el.className = "ref-item";
    el.innerHTML = `
      <div class="ref-avatar">${esc((r.name[0] || "?").toUpperCase())}</div>
      <div class="ref-info">
        <div class="ref-name">${esc(r.name)}</div>
        <div class="ref-date">${fmtDate(r.ts)}${r.active ? "" : " · очікує підписки"}</div>
      </div>
      <div class="ref-bonus">${r.active ? "+" + r.bonus : "—"}</div>`;
    list.appendChild(el);
  });
}

// ===== Actions =====
function copyLink() {
  const val = S.refLink;
  const done = () => { showToast("Посилання скопійовано"); haptic("light"); };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(val).then(done).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
  function fallbackCopy() {
    const input = $("refLink");
    input.select();
    try { document.execCommand("copy"); done(); } catch (_) { showToast("Скопіюй посилання вручну"); }
  }
}

async function shareLink() {
  const link = S.refLink;
  const text = "Приєднуйся за моїм посиланням і отримуй бонуси! 🚀";
  // Фіксуємо, що юзер ділився (для завдання) — у фоні, не блокуємо відкриття вікна
  api("/api/share", { method: "POST", body: {} }).then((d) => { S = d.state; renderTasks(); }).catch(() => {});

  if (tg?.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  } else if (navigator.share) {
    navigator.share({ title: "Рефералка", text, url: link }).catch(copyLink);
  } else {
    copyLink();
  }
  haptic("light");
}

// ===== UI helpers =====
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2800);
}

function haptic(type = "light") {
  try {
    if (!tg?.HapticFeedback) return;
    if (type === "success") tg.HapticFeedback.notificationOccurred("success");
    else if (type === "medium") tg.HapticFeedback.impactOccurred("medium");
    else tg.HapticFeedback.impactOccurred("light");
  } catch (_) {}
}

function bumpLevelIcon() {
  const icon = $("levelIcon");
  icon.classList.remove("bump");
  void icon.offsetWidth;
  icon.classList.add("bump");
}

function confetti() {
  const box = $("confetti");
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
  $("copyBtn").addEventListener("click", copyLink);
  $("shareBtn").addEventListener("click", shareLink);
  $("inviteBtn").addEventListener("click", shareLink);
  tg?.MainButton?.onClick(shareLink);

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", async () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      $("tab-" + tab.dataset.tab).classList.add("active");
      haptic("light");
      // Підтягуємо свіжі дані (нові реферали, статус виплат)
      try { await reloadState(); render(); } catch (_) {}
    });
  });

  $("startBtn").addEventListener("click", () => {
    $("onboarding").classList.remove("show");
    haptic("medium");
    action("/api/onboarded", { method: "POST", body: {} });
  });

  $("withdrawBtn").addEventListener("click", createWithdraw);
  $("adminBtn").addEventListener("click", () => window.AdminPanel?.open());
}

// ===== Withdraw =====
async function createWithdraw() {
  const btn = $("withdrawBtn");
  const amount = parseInt($("withdrawAmount").value, 10);
  const address = $("withdrawAddress").value.trim();

  if (!amount || amount < S.settings.minWithdraw) return showToast(`Мінімум ${S.settings.minWithdraw} бонусів`);
  if (amount > S.balance) return showToast("Недостатньо бонусів");
  if (!address) return showToast("Введіть адресу гаманця");

  btn.disabled = true;
  const data = await action("/api/withdraw", { method: "POST", body: { amount, address } });
  btn.disabled = false;
  if (!data) return;

  $("withdrawAmount").value = "";
  $("withdrawAddress").value = "";
  render();
  showToast("Заявку створено");
  haptic("success");
}

const STATUS_TEXT = { pending: "На розгляді", done: "Виплачено", rejected: "Відхилено" };

function renderWithdraw() {
  const rate = S.settings.usdtRate;
  $("withdrawBalance").textContent = S.balance;
  $("withdrawHint").textContent =
    `Мінімум ${S.settings.minWithdraw} бонусів · курс: ${rate} бонусів = 1 USDT · одна заявка за раз`;

  const list = $("withdrawList");
  const empty = $("emptyWithdraw");
  list.innerHTML = "";
  if (!S.withdrawals.length) { empty.style.display = "block"; return; }
  empty.style.display = "none";

  S.withdrawals.forEach((w) => {
    const el = document.createElement("div");
    el.className = "withdraw-item";
    el.innerHTML = `
      <div>
        <div class="withdraw-amount">${w.amount} бонусів · ≈ ${(w.amount / rate).toFixed(2)} USDT</div>
        <div class="withdraw-address">${esc(w.address.slice(0, 8))}…${esc(w.address.slice(-6))} · ${fmtDate(w.ts)}</div>
      </div>
      <div class="withdraw-status ${esc(w.status)}">${STATUS_TEXT[w.status] || esc(w.status)}</div>`;
    list.appendChild(el);
  });
}

init();
