// DOM for the notification system: bell + notification centre, full-screen alert overlay, toasts, the "lost connection"
// banner, the duty queue chip, the away-mode warning chips, the one-time tip and the settings sheet.
// Pure presentation: notify.js decides what to show and passes its `api` in.

import * as audio from "./notify-audio.js";
import { h, openPopover, closePopover } from "./ui.js";
import { esc } from "./util.js";

const P = {
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
  swords: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M8 16H3v5"/>',
  wifi: '<path d="M2 8.8a15 15 0 0 1 4-2.4"/><path d="M10.7 5.1A15 15 0 0 1 22 8.8"/><path d="M5 12.9a10 10 0 0 1 5-2.7"/><path d="M14 10.2a10 10 0 0 1 5 2.7"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M12 20h.01"/><path d="m2 2 20 20"/>',
  hourglass: '<path d="M6 2h12"/><path d="M6 22h12"/><path d="M7 2v4a5 5 0 0 0 2 4l3 2-3 2a5 5 0 0 0-2 4v4"/><path d="M17 2v4a5 5 0 0 1-2 4l-3 2 3 2a5 5 0 0 1 2 4v4"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
};
const ic = (n, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || P.bell}</svg>`;
const $ = (id) => document.getElementById(id);

const fmtClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function mountUi(api) {
  const S = api.settings;
  const bell = $("btn-bell"), strip = $("n-strip"), qchip = $("n-queue"), awakeBtn = $("btn-awake");
  const rel = (ts) => {
    const s = Math.max(0, Math.round((api.srvNow() - ts) / 1000));
    return s < 5 ? "now" : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(ts).toLocaleDateString();
  };
  let online = false;

  // ---- bell + badge ------------------------------------------------------------------------------------
  function renderBell() {
    if (!bell) return;
    const n = api.unread();
    bell.innerHTML = `${ic("bell")}<span class="n-badge"${n ? "" : " hidden"}>${n > 99 ? "99+" : n}</span>`;
    bell.classList.toggle("n-off", !S.enabled);
    bell.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
    bell.title = S.enabled ? "Notifications" : "Notifications (turned off)";
  }
  bell?.addEventListener("click", () => (sheet?.kind === "center" ? closeSheet() : openCenter()));

  // ---- sheets (notification centre + settings) ------------------------------------------------------
  let sheet = null;
  function closeSheet() {
    if (!sheet) return;
    const s = sheet; sheet = null;
    document.removeEventListener("keydown", s.onKey, true);
    clearInterval(s.timer);
    s.unsub?.();
    s.wrap.classList.remove("show");
    setTimeout(() => s.wrap.remove(), 180);
    bell?.setAttribute("aria-expanded", "false");
  }
  function openSheet(kind, title, { back, actions = [] } = {}) {
    closePopover();
    if (sheet) { const s = sheet; sheet = null; document.removeEventListener("keydown", s.onKey, true); clearInterval(s.timer); s.unsub?.(); s.wrap.remove(); }
    const wrap = h("div", `n-sheet-wrap n-${kind}`);
    const backdrop = h("div", "n-backdrop");
    const el = h("section", "n-sheet");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", title);
    const head = h("header", "n-sheet-head");
    if (back) {
      const b = h("button", "n-iconbtn", ic("back"));
      b.type = "button"; b.setAttribute("aria-label", "Back");
      b.addEventListener("click", back);
      head.append(b);
    }
    head.append(h("h2", "n-sheet-title", esc(title)), h("span", "ph-sp"));
    for (const a of actions) head.append(a);
    const x = h("button", "n-iconbtn", ic("x"));
    x.type = "button"; x.setAttribute("aria-label", "Close");
    x.addEventListener("click", closeSheet);
    head.append(x);
    const body = h("div", "n-sheet-body");
    el.append(head, body);
    wrap.append(backdrop, el);
    backdrop.addEventListener("click", closeSheet);
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeSheet(); } };
    document.addEventListener("keydown", onKey, true);
    document.body.append(wrap);
    requestAnimationFrame(() => wrap.classList.add("show"));
    sheet = { kind, wrap, body, onKey, timer: 0, unsub: null };
    bell?.setAttribute("aria-expanded", String(kind === "center"));
    return sheet;
  }

  // ---- notification centre ---------------------------------------------------------------------------
  function openCenter() {
    const clear = h("button", "n-textbtn", `${ic("trash")}<span>Clear all</span>`);
    clear.type = "button"; clear.dataset.act = "clear";
    clear.addEventListener("click", () => api.clearAll());
    const gear = h("button", "n-iconbtn", ic("sliders"));
    gear.type = "button"; gear.dataset.act = "settings"; gear.setAttribute("aria-label", "Notification settings"); gear.title = "Settings";
    gear.addEventListener("click", openSettings);
    const s = openSheet("center", "Notifications", { actions: [clear, gear] });
    const fresh = new Set(api.items.filter((i) => !i.read).map((i) => i.id));
    const list = h("div", "n-list");
    s.body.append(list);
    const render = () => {
      const items = api.items;
      clear.hidden = !items.length;
      list.textContent = "";
      if (!items.length) {
        list.append(h("div", "n-empty", `${ic("bell", "big")}<p>No notifications yet.</p><small>Duty pops, tells, ready checks, retainer ventures and more show up here.</small>`));
        return;
      }
      for (const i of items) {
        const row = h("div", `n-item p-${i.prio}${fresh.has(i.id) ? " new" : ""}`);
        row.dataset.id = i.id; row.dataset.type = i.type;
        row.innerHTML = `<span class="n-i-ico">${ic(api.typeInfo(i.type).icon)}</span>
          <div class="n-i-main"><div class="n-i-title">${esc(i.title)}${i.test ? ' <span class="n-tag">TEST</span>' : ""}</div>${i.body ? `<div class="n-i-body">${esc(i.body)}</div>` : ""}</div>
          <time class="n-i-time" title="${esc(new Date(i.ts).toLocaleString())}">${esc(rel(i.ts))}</time>`;
        list.append(row);
      }
    };
    render();
    api.markRead();
    s.unsub = api.onChange(() => { render(); api.markRead(); });
    s.timer = setInterval(() => { for (const t of list.querySelectorAll("time")) { const it = api.items.find((i) => i.id === t.parentElement.dataset.id); if (it) t.textContent = rel(it.ts); } }, 15000);
  }

  // ---- full-screen alert overlay (high priority) ---------------------------------------------------------
  const stack = [];
  let overlay = null, tickId = 0;

  const vibrateLoop = () => { if (api.settings.vibrate && navigator.vibrate) navigator.vibrate([500, 150, 500, 150, 500]); };
  function syncLoop() {
    const need = stack.some((o) => o.loopSound);
    if (need && !audio.isLooping("duty")) audio.startLoop("duty", "duty", audio.DUTY_LOOP_MS, vibrateLoop);
    if (!need && audio.isLooping("duty")) { audio.stopLoop("duty"); try { navigator.vibrate?.(0); } catch { /* ignore */ } }
  }

  function showOverlay(ev, opts = {}) {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].ev.type === ev.type) stack.splice(i, 1); // a newer pop replaces an older one
    stack.push({ ev, label: opts.label || "", countdown: opts.countdown || "Expires in", loopSound: !!opts.loopSound });
    renderOverlay();
    syncLoop();
  }
  function dismissTop() { stack.pop(); renderOverlay(); syncLoop(); }

  function renderOverlay() {
    if (!stack.length) {
      overlay?.remove(); overlay = null;
      clearInterval(tickId); tickId = 0;
      document.body.classList.remove("n-lock");
      return;
    }
    const o = stack[stack.length - 1];
    const ev = o.ev;
    if (!overlay) {
      overlay = h("div", "n-overlay");
      overlay.setAttribute("role", "alertdialog");
      overlay.setAttribute("aria-live", "assertive");
      document.body.append(overlay);
      document.body.classList.add("n-lock");
    }
    overlay.dataset.type = ev.type;
    overlay.innerHTML = `<div class="n-ov-card">
        <div class="n-ov-ico">${ic(api.typeInfo(ev.type).icon)}</div>
        <div class="n-ov-kicker">${esc(o.label || api.typeInfo(ev.type).label)}${ev.data?.test ? ' <span class="n-tag">TEST</span>' : ""}</div>
        <h2 class="n-ov-title">${esc(ev.title)}</h2>
        ${ev.body ? `<p class="n-ov-body">${esc(ev.body)}</p>` : ""}
        <div class="n-ov-count"${ev.expiresAt ? "" : " hidden"}><span class="n-ov-clabel">${esc(o.countdown)}</span> <b class="n-ov-time">0:00</b></div>
        <div class="n-ov-bar"${ev.expiresAt ? "" : " hidden"}><i></i></div>
        <button type="button" class="n-ov-dismiss">Dismiss</button>
        <div class="n-ov-hint" hidden>Tap anywhere to enable sound</div>
        <div class="n-ov-more"${stack.length > 1 ? "" : " hidden"}>+${stack.length - 1} more waiting</div>
      </div>`;
    overlay.querySelector(".n-ov-dismiss").addEventListener("click", dismissTop);
    updateOverlayHint();
    tickOverlay();
    if (!tickId) tickId = setInterval(tickOverlay, 200);
  }

  function tickOverlay() {
    const now = api.srvNow();
    let changed = false;
    for (let i = stack.length - 1; i >= 0; i--) {
      const e = stack[i].ev;
      if (e.expiresAt && e.expiresAt <= now) { stack.splice(i, 1); changed = true; }
    }
    if (changed) { renderOverlay(); syncLoop(); return; }
    const o = stack[stack.length - 1];
    if (!o || !overlay) return;
    if (o.ev.expiresAt) {
      const left = o.ev.expiresAt - now;
      overlay.querySelector(".n-ov-time").textContent = fmtClock(left);
      const total = Math.max(1000, o.ev.expiresAt - o.ev.ts);
      overlay.querySelector(".n-ov-bar i").style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
    }
  }
  function updateOverlayHint() {
    const hint = overlay?.querySelector(".n-ov-hint");
    if (hint) hint.hidden = audio.isUnlocked() || !stack.some((o) => o.loopSound || o.ev.priority === "high");
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && stack.length && !sheet) dismissTop(); });

  // ---- toasts (normal priority) ----------------------------------------------------------------------
  let toasts = null;
  function toastHost() {
    if (!toasts) { toasts = h("div", "n-toasts"); toasts.setAttribute("aria-live", "polite"); document.body.append(toasts); }
    return toasts;
  }
  function pushToast(el, ms) {
    const host = toastHost();
    host.append(el);
    requestAnimationFrame(() => el.classList.add("show"));
    while (host.children.length > 4) host.firstElementChild.remove();
    const kill = () => { el.classList.remove("show"); setTimeout(() => el.remove(), 200); };
    el.addEventListener("click", kill);
    setTimeout(kill, ms);
  }
  function showToast(ev) {
    const el = h("div", "n-toast p-normal", `<span class="n-i-ico">${ic(api.typeInfo(ev.type).icon)}</span>
      <div class="n-i-main"><div class="n-i-title">${esc(ev.title)}${ev.data?.test ? ' <span class="n-tag">TEST</span>' : ""}</div>${ev.body ? `<div class="n-i-body">${esc(ev.body)}</div>` : ""}</div>`);
    el.dataset.type = ev.type;
    el.setAttribute("role", "status");
    pushToast(el, 7000);
  }
  function info(msg) {
    const el = h("div", "n-toast info", `<div class="n-i-main"><div class="n-i-title">${esc(msg)}</div></div>`);
    pushToast(el, 2800);
  }

  // ---- lost connection banner -----------------------------------------------------------------------
  let down = null;
  function showDown(ev) {
    down?.remove();
    down = h("div", "n-down", `${ic("wifi")}<div class="n-i-main"><div class="n-i-title">${esc(ev.title)}</div><div class="n-i-body">${esc(ev.body || "")}</div></div>`);
    down.setAttribute("role", "alert");
    const x = h("button", "n-iconbtn", ic("x"));
    x.type = "button"; x.setAttribute("aria-label", "Dismiss");
    x.addEventListener("click", () => { down?.remove(); down = null; });
    down.append(x);
    document.body.append(down);
  }

  function clearType(base) {
    if (base === "disconnect") { down?.remove(); down = null; return; }
    let changed = false;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].ev.type === base) { stack.splice(i, 1); changed = true; }
    if (changed) { renderOverlay(); syncLoop(); }
  }

  // ---- queue chip ---------------------------------------------------------------------------------------
  let queue = null, srvNowFn = Date.now;
  const qsig = (q) => (q ? [q.state, q.kind, q.name, q.enteredAt, q.position, q.avgWaitMin].join("|") : "");
  function queueName(q) { return q.name ? (q.kind === "roulette" ? `Roulette: ${q.name}` : q.name) : ""; }
  function renderQueue() {
    if (!qchip) return;
    const q = queue;
    if (!q || !["queued", "pending", "ready"].includes(q.state)) { qchip.hidden = true; return; }
    qchip.hidden = false;
    const elapsed = q.enteredAt ? fmtElapsed(srvNowFn() - q.enteredAt) : "";
    qchip.classList.toggle("ready", q.state === "ready");
    const state = q.state === "ready" ? "Duty ready" : q.state === "pending" ? "Joining queue" : "In queue";
    const name = queueName(q);
    qchip.innerHTML = `${ic("hourglass")}<span class="q-state">${state}</span>${elapsed && q.state !== "ready" ? `<span class="q-time"><span class="q-sep"> · </span>${elapsed}</span>` : ""}${name ? `<span class="q-name"><span class="q-sep"> · </span>${esc(name)}</span>` : ""}`;
    qchip.setAttribute("aria-label", `${state}${elapsed ? ` ${elapsed}` : ""}${name ? `, ${name}` : ""}`);
  }
  qchip?.addEventListener("click", () => {
    const q = queue;
    if (!q) return;
    const box = h("div", "menu n-qinfo");
    const lines = [["Status", q.state === "ready" ? "Duty ready, accept it in the game" : q.state === "pending" ? "Joining the queue" : "Waiting in queue"]];
    if (queueName(q)) lines.push([q.kind === "roulette" ? "Roulette" : "Duty", q.name + (q.entries > 1 && q.kind !== "roulette" ? "" : "")]);
    if (q.enteredAt) lines.push(["Time in queue", fmtElapsed(srvNowFn() - q.enteredAt)]);
    if (q.position) lines.push(["Position", `#${q.position}`]);
    if (q.avgWaitMin) lines.push(["Average wait", `about ${q.avgWaitMin} min`]);
    if (q.roles) lines.push(["Party found", `Tanks ${q.roles.tanks}/${q.roles.tanksNeeded}, Healers ${q.roles.healers}/${q.roles.healersNeeded}, DPS ${q.roles.dps}/${q.roles.dpsNeeded}`]);
    box.append(h("div", "menu-title", "Duty Finder"));
    for (const [k, v] of lines) box.append(h("div", "n-qline", `<span>${esc(k)}</span><b>${esc(v)}</b>`));
    openPopover(qchip, box);
  });
  setInterval(() => { if (queue && !qchip.hidden) renderQueue(); }, 1000);
  function setQueue(q, nowFn) {
    srvNowFn = nowFn || Date.now;
    if (qsig(q) === qsig(queue)) return;
    queue = q || null;
    renderQueue();
  }

  // ---- away-mode warning chips ----------------------------------------------------------------------
  function awakeState() {
    if (!awakeBtn) return "n/a";
    if (awakeBtn.getAttribute("aria-pressed") === "true") return "on";
    return awakeBtn.classList.contains("pending") ? "pending" : "off";
  }
  function renderStrip() {
    if (!strip) return;
    strip.textContent = "";
    if (S.enabled && S.hints !== false) {
      const aw = awakeState();
      if (aw === "off" || aw === "pending") {
        const c = h("button", "n-warn", `${ic("sun")}<span>${aw === "pending" ? "Tap to resume Keep awake" : "Keep awake is off"}</span>`);
        c.type = "button"; c.dataset.warn = "awake";
        c.title = "Alerts only reach you while this page is open and the screen is on. Tap to turn on Keep awake.";
        c.addEventListener("click", () => awakeBtn?.click());
        strip.append(c);
      }
      if (audio.isSupported() && !audio.isUnlocked()) {
        const c = h("button", "n-warn", `${ic("mute")}<span>Tap to enable sound</span>`);
        c.type = "button"; c.dataset.warn = "sound";
        c.title = "Your browser needs one tap before this page can play alert sounds.";
        c.addEventListener("click", () => audio.unlock());
        strip.append(c);
      }
    }
    strip.hidden = !strip.children.length;
  }
  if (awakeBtn) new MutationObserver(renderStrip).observe(awakeBtn, { attributes: true, attributeFilter: ["aria-pressed", "class"] });
  audio.onChange(() => { renderStrip(); updateOverlayHint(); });

  // ---- one-time tip ----------------------------------------------------------------------------------
  const TIP_KEY = "ss.notify.tip";
  let tipShown = false;
  function maybeShowTip() {
    if (tipShown || !S.enabled) return;
    try { if (localStorage.getItem(TIP_KEY)) return; } catch { return; }
    tipShown = true;
    const tip = h("div", "n-tip", `<div class="n-tip-title">${ic("bell")}<b>Walking away from the PC?</b></div>
      <p>${AWAY_TEXT}</p>
      <div class="n-tip-actions"><button type="button" class="btn" data-act="settings">Settings</button><button type="button" class="btn primary" data-act="ok">Got it</button></div>`);
    tip.setAttribute("role", "dialog");
    tip.setAttribute("aria-label", "Away mode tip");
    const done = () => { try { localStorage.setItem(TIP_KEY, "1"); } catch { /* ignore */ } tip.remove(); };
    tip.querySelector('[data-act="ok"]').addEventListener("click", done);
    tip.querySelector('[data-act="settings"]').addEventListener("click", () => { done(); openSettings(); });
    document.body.append(tip);
  }

  // ---- settings sheet --------------------------------------------------------------------------------
  const AWAY_TEXT = "Keep this page open and in front, turn on Keep awake (☀), keep the volume up. Locked screens and background tabs can't receive alerts.";

  function sw(on, label, onChange) {
    const b = h("button", "n-switch");
    b.type = "button";
    b.setAttribute("role", "switch");
    b.setAttribute("aria-label", label);
    const set = (v) => { b.setAttribute("aria-checked", String(v)); b.classList.toggle("on", v); };
    set(on);
    b.addEventListener("click", () => { const v = b.getAttribute("aria-checked") !== "true"; set(v); onChange(v); });
    return b;
  }
  const row = (title, hint, control) => {
    const r = h("div", "n-row");
    const t = h("div", "n-row-t", `<div class="n-row-title">${esc(title)}</div>${hint ? `<div class="n-row-hint">${esc(hint)}</div>` : ""}`);
    r.append(t);
    if (control) r.append(control);
    return r;
  };
  const section = (title) => h("div", "n-sec-title", esc(title));

  function openSettings() {
    const s = openSheet("settings", "Notification settings", { back: openCenter });
    const body = s.body;
    const save = () => api.saveSettings();

    // master
    body.append(row("Notifications", "Turn all alerts on or off for this device.", sw(S.enabled, "Notifications", (v) => { S.enabled = v; save(); })));

    // away mode
    body.append(h("div", "n-away", `<div class="n-away-ico">${ic("sun")}</div><div><b>Away mode</b><p>${esc(AWAY_TEXT)}</p></div>`));
    body.append(row("Show reminders", "Warn me at the top of the page when Keep awake is off or sound is locked.", sw(S.hints !== false, "Show reminders", (v) => { S.hints = v; save(); })));

    // sound + test
    body.append(section("Sound and testing"));
    const vol = h("input", "n-range");
    vol.type = "range"; vol.min = "0"; vol.max = "100"; vol.step = "5"; vol.value = String(Math.round(S.volume * 100));
    vol.setAttribute("aria-label", "Volume");
    const volOut = h("b", "n-vol", `${vol.value}%`);
    vol.addEventListener("input", () => { S.volume = Number(vol.value) / 100; volOut.textContent = `${vol.value}%`; save(); });
    vol.addEventListener("change", () => { audio.play("ding"); });
    const vr = h("div", "n-row n-vrow");
    vr.append(h("div", "n-row-t", `<div class="n-row-title">Volume</div>`), vol, volOut);
    body.append(vr);
    if (navigator.vibrate) body.append(row("Vibration", "Buzz the device on alerts, where the browser allows it.", sw(S.vibrate, "Vibration", (v) => { S.vibrate = v; save(); })));
    if (api.systemSupported()) {
      body.append(row("System notifications", "Also show a notification from the browser when this tab is not in front.",
        sw(S.system, "System notifications", async (v) => {
          if (!v) { S.system = false; save(); return; }
          const ok = await api.enableSystem();
          if (!ok) { info("Notifications are blocked in your browser settings."); s.body.querySelector('[aria-label="System notifications"]')?.classList.remove("on"); s.body.querySelector('[aria-label="System notifications"]')?.setAttribute("aria-checked", "false"); }
        })));
    }
    const status = h("div", "n-sound-status");
    const renderStatus = () => { status.innerHTML = audio.isUnlocked() ? `${ic("volume")}<span>Sound is on for this page.</span>` : `${ic("mute")}<span>Sound is locked until you tap or click this page.</span>`; };
    renderStatus();
    const offAudio = audio.onChange(renderStatus);
    const prevUnsub = s.unsub;
    s.unsub = () => { offAudio(); prevUnsub?.(); };
    const msg = h("div", "n-test-msg"); msg.setAttribute("role", "status");
    const runTest = async (kind, btn) => {
      btn.disabled = true; msg.textContent = "";
      try { await api.test(kind); msg.textContent = "Test sent."; }
      catch { msg.textContent = "Could not reach the game."; }
      finally { setTimeout(() => { btn.disabled = false; }, 600); }
    };
    const tb = h("button", "btn primary n-big", `${ic("bell")}Send test notification`);
    tb.type = "button"; tb.dataset.act = "test";
    tb.addEventListener("click", () => runTest("normal", tb));
    const tb2 = h("button", "btn n-big", `${ic("swords")}Test duty pop alert`);
    tb2.type = "button"; tb2.dataset.act = "test-duty";
    tb2.addEventListener("click", () => { closeSheet(); runTest("duty_pop", tb2); });
    const tr = h("div", "n-test");
    tr.append(tb, tb2);
    body.append(status, tr, msg);

    // events
    body.append(section("Events"));
    for (const [type, info_] of Object.entries(api.TYPES)) {
      const cfg = S.types[type];
      const r = h("div", "n-ev");
      r.dataset.type = type;
      r.append(h("div", "n-ev-head", `<span class="n-i-ico">${ic(info_.icon)}</span><div class="n-row-t"><div class="n-row-title">${esc(info_.label)}</div><div class="n-row-hint">${esc(info_.hint)}</div></div>`));
      const head = r.firstChild;
      const on = sw(cfg.on, `${info_.label}: on`, (v) => { cfg.on = v; r.classList.toggle("off", !v); save(); });
      head.append(on);
      const opts = h("div", "n-ev-opts");
      const snd = h("label", "n-opt");
      snd.append(h("span", "", "Sound"), sw(cfg.sound, `${info_.label}: sound`, (v) => { cfg.sound = v; save(); }));
      const pr = h("label", "n-opt");
      const sel = h("select", "n-select");
      sel.setAttribute("aria-label", `${info_.label}: priority`);
      for (const [v, t] of [["default", `Default (${info_.priority})`], ["high", "High: full-screen alert"], ["normal", "Normal: pop-up"], ["low", "Low: list only"]]) {
        const o = h("option", "", esc(t)); o.value = v; sel.append(o);
      }
      sel.value = cfg.priority || "default";
      sel.addEventListener("change", () => { cfg.priority = sel.value; save(); });
      pr.append(h("span", "", "Priority"), sel);
      opts.append(snd, pr);
      r.append(opts);
      r.classList.toggle("off", !cfg.on);
      body.append(r);
    }

    // quiet hours
    body.append(section("Quiet hours"));
    const q = S.quiet;
    const qbox = h("div", "n-quiet");
    const from = h("input", "n-time"); from.type = "time"; from.value = q.from; from.setAttribute("aria-label", "Quiet hours start");
    const to = h("input", "n-time"); to.type = "time"; to.value = q.to; to.setAttribute("aria-label", "Quiet hours end");
    from.addEventListener("change", () => { q.from = from.value || "22:00"; save(); });
    to.addEventListener("change", () => { q.to = to.value || "07:00"; save(); });
    const qrow = row("Quiet hours", "No pop-ups or sounds in this window. Alerts still appear in the list.", sw(q.on, "Quiet hours", (v) => { q.on = v; qbox.classList.toggle("off", !v); save(); }));
    qbox.append(h("span", "", "From"), from, h("span", "", "to"), to);
    qbox.classList.toggle("off", !q.on);
    body.append(qrow, qbox, row("High priority gets through", "Duty pops, tells and ready checks still alert during quiet hours.", sw(!!q.allowHigh, "High priority gets through", (v) => { q.allowHigh = v; save(); })));

    // keywords (stored in the plugin so chat matching runs in the game)
    body.append(section("Chat keywords"));
    body.append(h("p", "n-note", "Your character's first name always counts. Add other words that should raise a Mention, such as an FC name or a trade you are waiting for. Matching happens in the game, so it works for every device."));
    const kwWrap = h("div", "n-kw");
    const kwList = h("div", "n-kw-list");
    const kwForm = h("form", "n-kw-form");
    const kwIn = h("input", "n-kw-in"); kwIn.type = "text"; kwIn.placeholder = "Add a word"; kwIn.maxLength = 40; kwIn.autocomplete = "off"; kwIn.autocapitalize = "off"; kwIn.spellcheck = false; kwIn.setAttribute("aria-label", "New keyword");
    const kwAdd = h("button", "btn", "Add"); kwAdd.type = "submit";
    kwForm.append(kwIn, kwAdd);
    const kwErr = h("div", "n-kw-err"); kwErr.hidden = true;
    kwWrap.append(kwList, kwForm, kwErr);
    body.append(kwWrap);
    let words = [];
    let kwLoaded = false;
    const renderKw = () => {
      kwList.textContent = "";
      if (!words.length) kwList.append(h("span", "n-kw-none", kwLoaded ? "No extra keywords." : "Loading..."));
      for (const w of words) {
        const c = h("span", "n-kw-chip", `<span>${esc(w)}</span>`);
        const rm = h("button", "", ic("x")); rm.type = "button"; rm.setAttribute("aria-label", `Remove ${w}`);
        rm.addEventListener("click", () => persist(words.filter((x) => x !== w)));
        c.append(rm);
        kwList.append(c);
      }
    };
    const persist = async (next) => {
      kwErr.hidden = true;
      try { words = await api.putKeywords(next); kwLoaded = true; }
      catch { kwErr.textContent = "Could not save keywords. Is the game running?"; kwErr.hidden = false; }
      renderKw();
    };
    kwForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = kwIn.value.trim();
      if (!v) return;
      kwIn.value = "";
      if (!words.some((w) => w.toLowerCase() === v.toLowerCase())) persist([...words, v]);
    });
    renderKw();
    api.getKeywords().then((k) => { words = k; kwLoaded = true; renderKw(); }, () => { kwErr.textContent = "Could not load keywords from the game."; kwErr.hidden = false; kwLoaded = true; renderKw(); });
  }

  // ---- wiring ----------------------------------------------------------------------------------------
  api.onChange(() => { renderBell(); renderStrip(); });
  renderBell();
  renderStrip();
  return {
    showOverlay, showToast, showDown, clearType, info, setQueue, maybeShowTip,
    setOnline(v) { online = v; },
  };
}
