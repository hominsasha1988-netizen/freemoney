/**
 * Адмін-панель v2. Підключається після app.js і користується його глобальними
 * api(), esc(), $(), S, reloadState(), render(), haptic(), tg.
 * Усі права перевіряє сервер — тут лише інтерфейс.
 */
(() => {
  "use strict";

  const panel = document.getElementById("adminPanel");
  const body = document.getElementById("admBody");
  const msgEl = document.getElementById("admMsg");
  const tabsEl = document.getElementById("admTabs");
  const badge = document.getElementById("admBadge");

  const A = { tab: "overview", seq: 0, wdScope: "pending", users: [], usersTotal: 0, usersQ: "", openUser: null, poll: null, backBound: false };

  // ---------- хелпери ----------
  const num = (v) => Number(v || 0).toLocaleString("uk-UA");
  const dt = (ts) =>
    ts ? new Date(ts * 1000).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  const rate = () => (typeof S !== "undefined" && S && S.settings.usdtRate) || 100;
  const usdt = (b) => (b / rate()).toFixed(2);
  const botName = () => ((typeof S !== "undefined" && S && S.refLink.match(/t\.me\/([^/]+)\//)) || [])[1] || "бот";

  /** Повідомлення ВСЕРЕДИНІ панелі (раніше тост ховався під модалкою). Помилки висять довше. */
  function say(text, kind = "ok") {
    msgEl.textContent = text;
    msgEl.className = "adm-msg show " + kind;
    clearTimeout(say.t);
    say.t = setTimeout(() => msgEl.classList.remove("show"), kind === "err" ? 8000 : 3500);
    if (kind === "err") haptic("medium");
  }

  async function call(path, payload = {}, method = "POST") {
    try {
      return await api(path, { method, body: method === "DELETE" ? undefined : payload });
    } catch (e) {
      say(e.message || "Помилка", "err");
      return null;
    }
  }

  /** Двокрокове підтвердження на кнопці (надійніше за confirm() у Telegram). */
  function twoStep(btn, armedText, fn) {
    btn.addEventListener("click", (ev) => {
      if (btn.dataset.armed === "1") {
        clearTimeout(btn._t);
        btn.dataset.armed = "0";
        btn.classList.remove("armed");
        btn.textContent = btn._orig;
        return fn(ev);
      }
      btn._orig = btn.textContent;
      btn.dataset.armed = "1";
      btn.classList.add("armed");
      btn.textContent = armedText;
      btn._t = setTimeout(() => {
        btn.dataset.armed = "0";
        btn.classList.remove("armed");
        btn.textContent = btn._orig;
      }, 4000);
    });
  }

  function copy(text) {
    const ok = () => say("Скопійовано");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok).catch(() => say("Не вдалося скопіювати", "err"));
    else say("Скопіюй вручну: " + text);
  }

  function setBadge(n) {
    badge.textContent = n;
    badge.hidden = !n;
  }

  const loading = () => (body.innerHTML = '<div class="adm-loading"><span class="adm-spin"></span>Завантаження…</div>');
  const empty = (t) => `<div class="adm-empty">${esc(t)}</div>`;
  const card = (title, inner, extra = "") => `<section class="adm-card ${extra}">${title ? `<h3>${title}</h3>` : ""}${inner}</section>`;

  // ---------- відкриття / закриття ----------
  function open() {
    if (typeof S === "undefined" || !S || !S.user.isAdmin) return;
    panel.classList.add("show");
    panel.setAttribute("aria-hidden", "false");
    document.body.classList.add("adm-open");
    try {
      tg?.MainButton?.hide();
      if (tg?.BackButton) {
        tg.BackButton.show();
        if (!A.backBound) { tg.BackButton.onClick(close); A.backBound = true; }
      }
    } catch (_) {}
    show(A.tab);
  }

  function close() {
    clearTimeout(A.poll);
    panel.classList.remove("show");
    panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("adm-open");
    try {
      tg?.BackButton?.hide();
      tg?.MainButton?.show();
    } catch (_) {}
  }

  async function show(tab) {
    A.tab = tab;
    A.seq++;
    clearTimeout(A.poll);
    const seq = A.seq;
    tabsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.adm === tab));
    tabsEl.querySelector(".active")?.scrollIntoView({ inline: "center", block: "nearest" });
    body.scrollTop = 0;
    loading();
    const fn = { overview, withdrawals, users, channels, rules, broadcast, settings }[tab];
    try {
      await fn(seq);
    } catch (e) {
      if (seq === A.seq) body.innerHTML = empty("Помилка: " + e.message);
    }
  }

  // =====================================================================
  // 📊 ОГЛЯД
  // =====================================================================
  const ACTIONS = {
    balance: "Зміна балансу", ban: "Блокування", unban: "Розблокування", channel_add: "Додано канал", channel_del: "Видалено канал",
    withdraw_done: "Виплачено", withdraw_reject: "Відхилено заявку", settings: "Налаштування", game_config: "Правила",
    broadcast: "Розсилка", broadcast_test: "Тест розсилки",
  };

  function chart(series) {
    const W = 336, H = 110, n = series.length, gw = W / n, bw = (gw - 5) / 2;
    const max = Math.max(1, ...series.flatMap((s) => [s.users, s.activated]));
    let svg = `<svg class="adm-chart" viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="Реєстрації та активації за 14 днів">`;
    series.forEach((s, i) => {
      const x = i * gw + 2;
      const h1 = s.users ? Math.max(2, Math.round((s.users / max) * H)) : 0;
      const h2 = s.activated ? Math.max(2, Math.round((s.activated / max) * H)) : 0;
      svg += `<rect class="c1" x="${x}" y="${H - h1}" width="${bw}" height="${h1}" rx="2"><title>${esc(s.day)}: ${s.users} реєстрацій</title></rect>`;
      svg += `<rect class="c2" x="${x + bw + 1}" y="${H - h2}" width="${bw}" height="${h2}" rx="2"><title>${esc(s.day)}: ${s.activated} активацій</title></rect>`;
      if (i % 3 === 0 || i === n - 1) svg += `<text x="${x + bw}" y="${H + 13}" text-anchor="middle">${esc(s.day.slice(8))}.${esc(s.day.slice(5, 7))}</text>`;
    });
    return svg + "</svg>";
  }

  const tile = (v, label, sub = "", cls = "") =>
    `<div class="adm-tile ${cls}"><b>${esc(v)}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;

  async function overview(seq) {
    const d = await call("/api/admin/overview");
    if (!d || seq !== A.seq) return;
    const s = d.stats;
    setBadge(s.pendingCount);

    const top = d.top.length
      ? d.top.map((t, i) => `<div class="adm-row"><span class="adm-rank">${i + 1}</span><div class="adm-grow"><b>${esc(t.name)}</b>
          <small>${t.username ? "@" + esc(t.username) + " · " : ""}ID ${t.id}</small></div><div class="adm-right"><b>${num(t.refs)}</b><small>запрош.</small></div></div>`).join("")
      : empty("Поки немає активних рефералів");

    const recent = d.recent.length
      ? d.recent.map((r) => `<div class="adm-row"><div class="adm-grow"><b>${esc(ACTIONS[r.action] || r.action)}</b><small>${esc(r.detail)}</small></div>
          <small class="adm-right">${dt(r.ts)}</small></div>`).join("")
      : empty("Дій ще не було");

    body.innerHTML = `
      <div class="adm-tiles">
        ${tile(num(s.users), "Юзерів", `+${num(s.newToday)} сьогодні · +${num(s.new7d)} за 7 днів`)}
        ${tile(num(s.referrals), "Активних рефералів", `${num(s.subscribed)} підписані`)}
        ${tile(num(s.balances), "Бонусів на балансах", `≈ ${usdt(s.balances)} USDT боргу`)}
        ${tile(usdt(s.paidSum), "USDT виплачено", s.pendingCount ? `в черзі: ${s.pendingCount} (${usdt(s.pendingSum)} USDT)` : "черга порожня", s.pendingCount ? "warn" : "")}
      </div>
      ${card("Останні 14 днів", chart(d.series) +
        '<div class="adm-legend"><span class="l1">Реєстрації</span><span class="l2">Активації (підписались)</span></div>')}
      ${card("Топ запрошувачів", top)}
      ${card("Останні дії адмінів", recent)}`;
  }

  // =====================================================================
  // 💸 ЗАЯВКИ
  // =====================================================================
  const WD_STATUS = { pending: "На розгляді", done: "Виплачено", rejected: "Відхилено" };

  async function withdrawals(seq) {
    const scope = A.wdScope;
    const d = await call("/api/admin/withdrawals", { scope });
    if (!d || seq !== A.seq) return;
    if (scope === "pending") setBadge(d.withdrawals.length);

    const seg = `<div class="adm-seg">
      <button data-scope="pending" class="${scope === "pending" ? "active" : ""}">Очікують</button>
      <button data-scope="history" class="${scope === "history" ? "active" : ""}">Історія</button></div>`;

    const items = d.withdrawals.map((w) => {
      const who = `${esc(w.name)}${w.username ? " · @" + esc(w.username) : ""}`;
      const head = `<div class="adm-wd-head"><b>#${w.id} · ${who}</b><span>${dt(w.ts)}</span></div>
        <div class="adm-wd-sum">${num(w.amount)} бонусів <em>≈ ${usdt(w.amount)} USDT</em></div>
        <button class="adm-addr" data-copy="${esc(w.address)}" title="Натисни, щоб скопіювати">${esc(w.address)}</button>`;
      if (scope === "history") {
        return `<div class="adm-item">${head}<div class="adm-wd-foot"><span class="adm-pill ${esc(w.status)}">${esc(WD_STATUS[w.status] || w.status)}</span>
          <small>${dt(w.resolvedAt)} · ID ${w.userId}</small></div></div>`;
      }
      return `<div class="adm-item" data-id="${w.id}">${head}<div class="adm-btns">
        <button class="adm-btn primary" data-act="approve" data-sum="${usdt(w.amount)}">✓ Виплачено</button>
        <button class="adm-btn" data-act="reject">✕ Відхилити</button></div></div>`;
    }).join("");

    const hint = scope === "pending"
      ? '<div class="adm-hint">Спочатку <b>сам відправ USDT</b> на адресу, і лише потім тисни «Виплачено». Апка крипту не відправляє.</div>'
      : "";
    body.innerHTML = seg + hint + (items || empty(scope === "pending" ? "Немає заявок на розгляді 🎉" : "Історія порожня"));

    body.querySelectorAll(".adm-seg button").forEach((b) => b.addEventListener("click", () => { A.wdScope = b.dataset.scope; show("withdrawals"); }));
    body.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => copy(b.dataset.copy)));
    body.querySelectorAll("[data-act]").forEach((b) => {
      const id = b.closest("[data-id]").dataset.id;
      const reject = b.dataset.act === "reject";
      twoStep(b, reject ? "Точно відхилити?" : `Підтверджую: відправлено ${b.dataset.sum} USDT`, async () => {
        const r = await call(`/api/admin/withdrawals/${id}`, { action: b.dataset.act });
        if (!r) return;
        say(reject ? "Заявку відхилено, бонуси повернуто юзеру" : "Позначено як виплачено");
        haptic("success");
        show("withdrawals");
      });
    });
  }

  // =====================================================================
  // 👥 ЮЗЕРИ
  // =====================================================================
  let searchTimer = null;

  async function users(seq) {
    body.innerHTML = `<input type="search" class="adm-input" id="admQ" placeholder="Пошук: ID, @username або ім’я" value="${esc(A.usersQ)}" autocomplete="off" />
      <div class="adm-info" id="admUsersInfo"></div><div id="admUsersList"></div><button class="adm-btn wide" id="admMore" hidden>Показати ще</button>`;
    $("admQ").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { A.usersQ = e.target.value.trim(); loadUsers(true); }, 350);
    });
    $("admMore").addEventListener("click", () => loadUsers(false));
    await loadUsers(true, seq);
  }

  async function loadUsers(reset, seq = A.seq) {
    const d = await call("/api/admin/users", { q: A.usersQ, offset: reset ? 0 : A.users.length });
    if (!d || seq !== A.seq || A.tab !== "users") return;
    A.users = reset ? d.users : A.users.concat(d.users);
    A.usersTotal = d.total;
    if (reset) A.openUser = null;
    renderUsers();
  }

  function renderUsers() {
    const list = $("admUsersList");
    if (!list) return;
    $("admUsersInfo").textContent = A.usersQ ? `Знайдено: ${num(A.usersTotal)}` : `Усього юзерів: ${num(A.usersTotal)}`;
    $("admMore").hidden = A.users.length >= A.usersTotal;

    list.innerHTML = A.users.length ? A.users.map(userCard).join("") : empty("Нікого не знайдено");
    list.querySelectorAll(".adm-user-head").forEach((h) =>
      h.addEventListener("click", () => {
        const id = Number(h.parentElement.dataset.id);
        A.openUser = A.openUser === id ? null : id;
        renderUsers();
      })
    );
    const open = list.querySelector(".adm-user.open");
    if (open) bindUserActions(open);
  }

  function userCard(u) {
    const open = A.openUser === u.id;
    const badges =
      (u.banned ? '<span class="adm-pill rejected">Заблоковано</span>' : "") +
      (u.subscribed ? "" : '<span class="adm-pill muted">не підписаний</span>');
    const detail = !open ? "" : `
      <div class="adm-user-detail">
        <div class="adm-facts">
          <div><span>ID</span><button class="adm-link" data-copy="${u.id}">${u.id} ⧉</button></div>
          <div><span>Зароблено</span><b>${num(u.earned)}</b></div>
          <div><span>Запрошено</span><b>${num(u.refsActive)} / ${num(u.refsTotal)}</b></div>
          <div><span>Виплачено</span><b>${usdt(u.paid)} USDT</b></div>
          <div><span>Реєстрація</span><b>${dt(u.createdAt)}</b></div>
          <div><span>Остання активність</span><b>${dt(u.lastSeen)}</b></div>
          <div><span>Запросив</span><b>${u.referrerId ? "ID " + u.referrerId : "—"}</b></div>
        </div>
        <label class="adm-label">Змінити баланс (бонусів)</label>
        <div class="adm-inline">
          <input type="number" inputmode="numeric" class="adm-input" data-f="delta" placeholder="Напр. 50" />
          <button class="adm-btn primary" data-do="add">+ Нарахувати</button>
          <button class="adm-btn" data-do="sub">− Списати</button>
        </div>
        <label class="adm-check"><input type="checkbox" data-f="notify" /> Повідомити юзера в Telegram</label>
        <div class="adm-btns">
          <button class="adm-btn ${u.banned ? "primary" : "danger"}" data-do="ban" data-banned="${u.banned ? 0 : 1}">${u.banned ? "Розблокувати" : "Заблокувати"}</button>
        </div>
      </div>`;
    return `<div class="adm-user ${open ? "open" : ""} ${u.banned ? "is-banned" : ""}" data-id="${u.id}">
      <div class="adm-user-head" role="button" tabindex="0">
        <div class="adm-ava">${esc((u.name[0] || "?").toUpperCase())}</div>
        <div class="adm-grow"><b>${esc(u.name)}</b><small>${u.username ? "@" + esc(u.username) + " · " : ""}ID ${u.id}</small>${badges ? `<div class="adm-badges">${badges}</div>` : ""}</div>
        <div class="adm-right"><b>${num(u.balance)}</b><small>${num(u.refsActive)} запр.</small></div>
      </div>${detail}</div>`;
  }

  function bindUserActions(el) {
    const id = Number(el.dataset.id);
    const replace = (u) => { A.users = A.users.map((x) => (x.id === u.id ? u : x)); renderUsers(); };
    el.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => copy(b.dataset.copy)));

    const doBalance = async (sign) => {
      const raw = Number(el.querySelector('[data-f="delta"]').value);
      if (!Number.isInteger(raw) || raw <= 0) return say("Вкажи додатне ціле число", "err");
      const r = await call(`/api/admin/users/${id}/balance`, { delta: sign * raw, notify: el.querySelector('[data-f="notify"]').checked });
      if (!r) return;
      say(`Баланс: ${num(r.user.balance)}`);
      haptic("success");
      replace(r.user);
    };
    el.querySelector('[data-do="add"]').addEventListener("click", () => doBalance(1));
    el.querySelector('[data-do="sub"]').addEventListener("click", () => doBalance(-1));

    const banBtn = el.querySelector('[data-do="ban"]');
    const banned = banBtn.dataset.banned === "1";
    twoStep(banBtn, banned ? "Точно заблокувати?" : "Точно розблокувати?", async () => {
      const r = await call(`/api/admin/users/${id}/ban`, { banned });
      if (!r) return;
      say(banned ? "Юзера заблоковано" : "Юзера розблоковано");
      replace(r.user);
    });
  }

  // =====================================================================
  // 📢 КАНАЛИ
  // =====================================================================
  async function channels(seq) {
    body.innerHTML = card("Додати канал", `
      <div class="adm-steps"><b>1.</b> Додай <b>@${esc(botName())}</b> адміністратором каналу<br><b>2.</b> Встав @username або посилання на канал<br><b>3.</b> Натисни «Додати»: бот сам перевірить доступ</div>
      <input class="adm-input" id="chChat" placeholder="@username або https://t.me/назва" autocomplete="off" autocapitalize="off" />
      <input class="adm-input" id="chTitle" placeholder="Назва для юзерів (необов’язково: візьму з Telegram)" />
      <details class="adm-details"><summary>Приватний канал (без username)</summary>
        <div class="adm-hint">Встав замість username <b>числовий ID</b> каналу (починається з -100…; його покаже, наприклад, @getidsbot, якщо переслати йому повідомлення з каналу), а нижче — посилання-запрошення.</div>
        <input class="adm-input" id="chUrl" placeholder="https://t.me/+AbCdEf…" autocapitalize="off" />
      </details>
      <button class="adm-btn primary wide" id="chAdd">+ Додати канал</button>
      <div class="adm-formmsg" id="chMsg"></div>`) +
      `<div id="chList">${'<div class="adm-loading"><span class="adm-spin"></span>Перевіряю доступ бота до каналів…</div>'}</div>`;

    $("chAdd").addEventListener("click", addChannel);
    $("chChat").addEventListener("keydown", (e) => e.key === "Enter" && addChannel());
    await loadChannels(seq);
  }

  async function loadChannels(seq = A.seq) {
    const d = await call("/api/admin/channels/status");
    if (!d || seq !== A.seq || A.tab !== "channels") return;
    const list = $("chList");
    if (!list) return;
    list.innerHTML = d.channels.length
      ? d.channels.map((c) => `<div class="adm-item ${c.ok ? "" : "bad"}" data-id="${c.id}">
          <div class="adm-wd-head"><b>${esc(c.title)}</b><span class="adm-pill ${c.ok ? "done" : "rejected"}">${c.ok ? "✓ Працює" : "⚠ Проблема"}</span></div>
          <small class="adm-mono">${esc(c.chat)}</small>
          ${c.ok ? "" : `<div class="adm-problem">${esc(c.problem)}</div>`}
          <div class="adm-btns"><a class="adm-btn" href="${esc(c.url)}" target="_blank" rel="noopener" data-open="${esc(c.url)}">Відкрити</a>
          <button class="adm-btn danger" data-del="${c.id}">Видалити</button></div></div>`).join("")
      : card("", empty("Каналів немає. Без них гейт підписки пропускає всіх."));
    list.querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", (e) => {
      if (tg?.openTelegramLink) { e.preventDefault(); tg.openTelegramLink(a.dataset.open); }
    }));
    list.querySelectorAll("[data-del]").forEach((b) => twoStep(b, "Точно видалити?", async () => {
      const r = await call(`/api/admin/channels/${b.dataset.del}`, {}, "DELETE");
      if (!r) return;
      say("Канал видалено");
      loadChannels();
    }));
  }

  async function addChannel() {
    const btn = $("chAdd"), out = $("chMsg");
    const chat = $("chChat").value.trim();
    if (!chat) { out.className = "adm-formmsg err"; out.textContent = "Вкажи @username або посилання на канал"; return; }
    btn.disabled = true;
    btn.textContent = "Перевіряю…";
    out.className = "adm-formmsg";
    out.textContent = "";
    try {
      const r = await api("/api/admin/channels", { method: "POST", body: { chat, title: $("chTitle").value.trim(), url: $("chUrl")?.value.trim() } });
      out.className = "adm-formmsg " + (r.warning ? "warn" : "ok");
      out.textContent = r.warning ? "Додано, але: " + r.warning : "✓ Канал додано";
      say(r.warning ? "Канал додано з попередженням" : "Канал додано", r.warning ? "warn" : "ok");
      haptic("success");
      $("chChat").value = ""; $("chTitle").value = ""; if ($("chUrl")) $("chUrl").value = "";
      loadChannels();
    } catch (e) {
      out.className = "adm-formmsg err";
      out.textContent = e.message; // конкретна причина: не знайдено / бот не адмін / не канал…
      say(e.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "+ Додати канал";
    }
  }

  // =====================================================================
  // 🎯 ПРАВИЛА (завдання / нагороди / рівні)
  // =====================================================================
  const rid = (p) => p + Math.random().toString(36).slice(2, 8);
  const inp = (f, v, type = "text", ph = "", extra = "") =>
    `<input class="adm-input sm" data-f="${f}" type="${type}" value="${esc(v)}" placeholder="${esc(ph)}" ${type === "number" ? 'inputmode="numeric"' : ""} ${extra} />`;

  const taskRow = (t) => `<div class="adm-edit" data-kind="task" data-id="${esc(t.id)}">
      <div class="adm-edit-grid">
        <label>Назва${inp("title", t.title, "text", "Назва", 'maxlength="48"')}</label>
        <label>Опис${inp("desc", t.desc, "text", "Короткий опис", 'maxlength="80"')}</label>
        <label>Тип<select class="adm-input sm" data-f="type"><option value="refs" ${t.type === "refs" ? "selected" : ""}>За запрошення</option><option value="share" ${t.type === "share" ? "selected" : ""}>Поділитись посиланням</option></select></label>
        <label>Запрошень${inp("need", t.type === "share" ? 1 : t.need, "number", "", `min="1" ${t.type === "share" ? "disabled" : ""}`)}</label>
        <label>Винагорода${inp("reward", t.reward, "number", "", 'min="1"')}</label>
      </div><button class="adm-x" data-rm aria-label="Видалити">🗑</button></div>`;

  const bonusRow = (b) => `<div class="adm-edit" data-kind="bonus" data-id="${esc(b.id)}">
      <div class="adm-edit-grid">
        <label>Назва${inp("title", b.title, "text", "Назва", 'maxlength="48"')}</label>
        <label>Опис${inp("desc", b.desc, "text", "Короткий опис", 'maxlength="80"')}</label>
        <label>Запрошень${inp("need", b.need, "number", "", 'min="1"')}</label>
        <label>Нагорода${inp("amount", b.amount, "number", "", 'min="1"')}</label>
      </div><button class="adm-x" data-rm aria-label="Видалити">🗑</button></div>`;

  const levelRow = (l) => `<div class="adm-edit" data-kind="level">
      <div class="adm-edit-grid lv">
        <label>Іконка${inp("icon", l.icon, "text", "🌱", 'maxlength="8"')}</label>
        <label>Назва${inp("name", l.name, "text", "Назва", 'maxlength="24"')}</label>
        <label>Від запрошень${inp("min", l.min, "number", "", 'min="0"')}</label>
      </div><button class="adm-x" data-rm aria-label="Видалити">🗑</button></div>`;

  async function rules(seq) {
    const d = await call("/api/admin/config/get");
    if (!d || seq !== A.seq) return;
    const c = d.config;
    body.innerHTML =
      '<div class="adm-hint">Зміни діють одразу для всіх. Прогрес рахується за <b>активними</b> рефералами (ті, хто підписався). Уже видані бонуси не забираються.</div>' +
      card("Завдання", '<div id="rTasks">' + c.tasks.map(taskRow).join("") + '</div><button class="adm-btn wide" data-add="task">+ Завдання</button>') +
      card("Нагороди", '<div id="rBonuses">' + c.bonuses.map(bonusRow).join("") + '</div><button class="adm-btn wide" data-add="bonus">+ Нагорода</button>') +
      card("Рівні", '<div class="adm-hint">Перший рівень — завжди від 0 запрошень, далі значення мають зростати.</div><div id="rLevels">' + c.levels.map(levelRow).join("") + '</div><button class="adm-btn wide" data-add="level">+ Рівень</button>') +
      '<div class="adm-formmsg" id="rMsg"></div><div class="adm-sticky"><button class="adm-btn primary wide" id="rSave">Зберегти правила</button></div>';

    const lastLevelMin = () => Math.max(0, ...[...body.querySelectorAll('#rLevels [data-f="min"]')].map((i) => Number(i.value) || 0));
    const wire = (root) => {
      root.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => b.closest(".adm-edit").remove()));
      root.querySelectorAll('select[data-f="type"]').forEach((s) => s.addEventListener("change", () => {
        const need = s.closest(".adm-edit").querySelector('[data-f="need"]');
        need.disabled = s.value === "share";
        if (s.value === "share") need.value = 1;
      }));
    };
    wire(body);
    body.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.add;
      const [target, html] = {
        task: ["rTasks", taskRow({ id: rid("t_"), title: "", desc: "", type: "refs", need: 1, reward: 10 })],
        bonus: ["rBonuses", bonusRow({ id: rid("b_"), title: "", desc: "", need: 1, amount: 10 })],
        level: ["rLevels", levelRow({ icon: "⭐", name: "", min: lastLevelMin() + 5 })],
      }[k];
      const holder = document.createElement("div");
      holder.innerHTML = html;
      const row = holder.firstElementChild;
      $(target).appendChild(row);
      wire(row);
      row.querySelector("input")?.focus();
    }));

    $("rSave").addEventListener("click", saveRules);
  }

  function collectRules() {
    const val = (row, f) => row.querySelector(`[data-f="${f}"]`).value;
    const rows = (k) => [...body.querySelectorAll(`.adm-edit[data-kind="${k}"]`)];
    return {
      tasks: rows("task").map((r) => ({ id: r.dataset.id, title: val(r, "title"), desc: val(r, "desc"), type: val(r, "type"), need: Number(val(r, "need")), reward: Number(val(r, "reward")) })),
      bonuses: rows("bonus").map((r) => ({ id: r.dataset.id, title: val(r, "title"), desc: val(r, "desc"), need: Number(val(r, "need")), amount: Number(val(r, "amount")) })),
      levels: rows("level").map((r) => ({ icon: val(r, "icon"), name: val(r, "name"), min: Number(val(r, "min")) })),
    };
  }

  async function saveRules() {
    const out = $("rMsg"), btn = $("rSave");
    btn.disabled = true;
    try {
      await api("/api/admin/config/save", { method: "POST", body: collectRules() });
      out.className = "adm-formmsg ok";
      out.textContent = "✓ Збережено";
      say("Правила збережено");
      haptic("success");
      reloadState().then(render).catch(() => {});
    } catch (e) {
      out.className = "adm-formmsg err";
      out.textContent = e.message;
      say(e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  // =====================================================================
  // ✉️ РОЗСИЛКА
  // =====================================================================
  async function broadcast(seq) {
    const st = await call("/api/admin/broadcast/status");
    if (!st || seq !== A.seq) return;
    const au = st.audience;
    body.innerHTML = card("Нова розсилка", `
      <textarea class="adm-input adm-ta" id="bcText" maxlength="3500" rows="6" placeholder="Текст повідомлення (простий текст, без розмітки)"></textarea>
      <div class="adm-counter"><span id="bcCount">0</span> / 3500</div>
      <label class="adm-label">Кому</label>
      <label class="adm-radio"><input type="radio" name="bcAud" value="all" checked /> Усім (${num(au.all)})</label>
      <label class="adm-radio"><input type="radio" name="bcAud" value="subscribed" /> Лише підписаним на канали (${num(au.subscribed)})</label>
      <label class="adm-check"><input type="checkbox" id="bcBtn" checked /> Додати кнопку «🚀 Відкрити додаток»</label>
      <div class="adm-btns">
        <button class="adm-btn" id="bcTest">Тест собі</button>
        <button class="adm-btn primary" id="bcSend">Надіслати</button>
      </div>
      <div class="adm-hint">Заблоковані юзери розсилку не отримують. Швидкість ~20 повідомлень/с, тож велика база піде кілька хвилин, але розсилка триває, навіть якщо закрити панель.</div>`) +
      '<div id="bcJob"></div>';

    $("bcText").addEventListener("input", (e) => ($("bcCount").textContent = e.target.value.length));
    const payload = (test) => ({
      text: $("bcText").value, test, button: $("bcBtn").checked,
      audience: body.querySelector('input[name="bcAud"]:checked').value,
    });
    const send = async (test) => {
      if (!$("bcText").value.trim()) return say("Напиши текст повідомлення", "err");
      const r = await call("/api/admin/broadcast", payload(test));
      if (!r) return;
      say(test ? "Тест надіслано тобі" : `Розсилку запущено: ${num(r.job.total)} одержувачів`);
      renderJob(r.job);
      pollJob();
    };
    $("bcTest").addEventListener("click", () => send(true));
    const aud = () => body.querySelector('input[name="bcAud"]:checked').value;
    twoStep($("bcSend"), "Точно надіслати?", () => send(false));
    body.querySelectorAll('input[name="bcAud"]').forEach((r) => r.addEventListener("change", () => {
      $("bcSend").title = `Одержувачів: ${num(au[aud()])}`;
    }));

    renderJob(st.job);
    if (st.job?.running) pollJob();
  }

  function renderJob(j) {
    const el = $("bcJob");
    if (!el) return;
    if (!j) { el.innerHTML = ""; return; }
    const done = j.sent + j.blocked + j.failed;
    const pct = j.total ? Math.round((done / j.total) * 100) : 100;
    el.innerHTML = card(j.running ? "Розсилка триває…" : j.test ? "Тест завершено" : "Остання розсилка", `
      <div class="adm-progress"><i style="width:${pct}%"></i></div>
      <div class="adm-facts three">
        <div><span>Надіслано</span><b>${num(j.sent)}</b></div>
        <div><span>Заблокували бота</span><b>${num(j.blocked)}</b></div>
        <div><span>Помилки</span><b>${num(j.failed)}</b></div>
      </div>
      <small class="adm-hint">${pct}% · ${num(done)} з ${num(j.total)} · старт ${dt(j.startedAt)}${j.finishedAt ? " · кінець " + dt(j.finishedAt) : ""}</small>`);
  }

  async function pollJob() {
    clearTimeout(A.poll);
    const d = await call("/api/admin/broadcast/status");
    if (!d || A.tab !== "broadcast") return;
    renderJob(d.job);
    if (d.job?.running) A.poll = setTimeout(pollJob, 1200);
  }

  // =====================================================================
  // ⚙️ НАЛАШТУВАННЯ
  // =====================================================================
  async function settings(seq) {
    const d = await call("/api/admin/overview");
    if (!d || seq !== A.seq) return;
    const s = d.settings;
    body.innerHTML = card("Виплати і бонуси", `
      <label class="adm-label">Мінімальна сума виводу (бонусів)</label>
      <input class="adm-input" id="sMin" type="number" inputmode="numeric" min="1" value="${s.minWithdraw}" />
      <label class="adm-label">Бонус рефереру за кожного друга (бонусів)</label>
      <input class="adm-input" id="sRef" type="number" inputmode="numeric" min="0" value="${s.refBonus}" />
      <label class="adm-label">Курс: скільки бонусів = 1 USDT</label>
      <input class="adm-input" id="sRate" type="number" inputmode="numeric" min="1" value="${s.usdtRate}" />
      <div class="adm-hint">Курс впливає лише на відображення і суму, яку ти виплачуєш вручну. Бонус за друга діє для нових активацій.</div>
      <div class="adm-formmsg" id="sMsg"></div>
      <button class="adm-btn primary wide" id="sSave">Зберегти</button>`);
    $("sSave").addEventListener("click", async () => {
      const r = await call("/api/admin/settings", { minWithdraw: Number($("sMin").value), refBonus: Number($("sRef").value), usdtRate: Number($("sRate").value) });
      if (!r) { $("sMsg").className = "adm-formmsg err"; $("sMsg").textContent = msgEl.textContent; return; }
      $("sMsg").className = "adm-formmsg ok";
      $("sMsg").textContent = "✓ Збережено";
      say("Налаштування збережено");
      haptic("success");
      reloadState().then(render).catch(() => {});
    });
  }

  // ---------- події ----------
  tabsEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-adm]");
    if (b) { haptic("light"); show(b.dataset.adm); }
  });
  $("admClose").addEventListener("click", close);
  $("admRefresh").addEventListener("click", () => show(A.tab));

  window.AdminPanel = { open, close };
})();
