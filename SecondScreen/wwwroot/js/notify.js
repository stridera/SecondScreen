// In-browser notifications: the plugin detects game events and keeps the last ~200 in a ring buffer; this module catches
// the browser up on them and decides how loudly to alert. There is no push service, so alerts only work while this page
// is open (see the "Away mode" guidance in the settings).
//
// Data flow: every WebSocket push carries notifySeq (the server's high-water mark) and the duty queue state. When
// notifySeq moves past what we have seen we GET /api/notifications?since=<seq>. The same call after a reconnect (the first
// push of a new connection also carries notifySeq) is the catch-up, so nothing is missed and nothing is shown twice
// (events are applied strictly in seq order and only once).
//
// Per-device preferences live in localStorage; only the chat keywords are stored in the plugin.

import * as audio from "./notify-audio.js";
import { mountUi } from "./notify-ui.js";

const SETTINGS_KEY = "ss.notify.settings";
const ITEMS_KEY = "ss.notify.items";
const SEQ_KEY = "ss.notify.seq";
const MAX_ITEMS = 100;
const FRESH_MS = 60_000;      // older events are listed but never alerted (they were missed while away)
const DOWN_MS = 30_000;       // WebSocket down this long => "Lost connection to game"

/** Event types the plugin emits (plus the client-side "disconnect"). `priority` is the plugin's default. */
export const TYPES = {
  duty_pop:     { label: "Duty ready", hint: "Your queued duty pops. Loud, repeating chime with a countdown.", priority: "high", icon: "swords", countdown: "Accept within", loop: true },
  ready_check:  { label: "Ready check", hint: "A party ready check is waiting for you.", priority: "high", icon: "check", countdown: "Respond within" },
  tell:         { label: "Tells", hint: "Private messages sent to you.", priority: "high", icon: "message" },
  party_invite: { label: "Party invites", hint: "Someone invites you to a party.", priority: "normal", icon: "users" },
  mention:      { label: "Mentions", hint: "Your character name or one of your keywords appears in chat.", priority: "normal", icon: "at" },
  venture_done: { label: "Retainer ventures", hint: "A retainer finishes a venture.", priority: "normal", icon: "clock" },
  queue_ended:  { label: "Queue ended", hint: "You leave the duty queue without a pop.", priority: "normal", icon: "hourglass" },
  reset:        { label: "Daily and weekly reset", hint: "Listed in the notification center only.", priority: "low", icon: "refresh" },
  disconnect:   { label: "Lost connection", hint: "This page cannot reach the game for 30 seconds.", priority: "high", icon: "wifi" },
};
const TEST_INFO = { label: "Test", icon: "bell" };
export const typeInfo = (t) => TYPES[t] || (t === "test" ? TEST_INFO : { label: String(t || "Event").replace(/_/g, " "), icon: "bell" });

const defaultSettings = () => ({
  enabled: true,
  volume: 0.8,
  vibrate: true,
  system: false,
  quiet: { on: false, from: "22:00", to: "07:00", allowHigh: false },
  types: Object.fromEntries(Object.keys(TYPES).map((k) => [k, { on: true, sound: true, priority: "default" }])),
});

function loadSettings() {
  const d = defaultSettings();
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (s && typeof s === "object") {
      for (const k of ["enabled", "vibrate", "system"]) if (typeof s[k] === "boolean") d[k] = s[k];
      if (typeof s.volume === "number") d.volume = Math.min(1, Math.max(0, s.volume));
      if (s.quiet && typeof s.quiet === "object") Object.assign(d.quiet, s.quiet);
      for (const k of Object.keys(d.types)) if (s.types?.[k]) Object.assign(d.types[k], s.types[k]);
    }
  } catch { /* corrupt: use defaults */ }
  return d;
}

export function initNotify({ token }) {
  const settings = loadSettings();
  let items = [];
  try { items = JSON.parse(localStorage.getItem(ITEMS_KEY) || "[]").filter((i) => i && i.id); } catch { items = []; }
  let lastSeq = Number(localStorage.getItem(SEQ_KEY)) || 0;
  let firstLoad = lastSeq === 0;     // no history on this device: list what the plugin has, silently
  let skew = 0;                      // server clock minus this device's clock (ms)
  let fetching = false, again = false, retryAt = 0, fails = 0;
  let localId = 0;
  const subs = new Set();

  const srvNow = () => Date.now() + skew;
  const url = (path) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  const emitChange = () => { for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } } };
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage blocked */ } audio.setVolume(settings.volume); emitChange(); };
  const saveItems = () => {
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
      localStorage.setItem(SEQ_KEY, String(lastSeq));
    } catch { /* storage blocked */ }
  };

  audio.setVolume(settings.volume);
  audio.init();

  const api = {
    settings,
    TYPES,
    typeInfo,
    srvNow,
    get items() { return items; },
    unread: () => items.filter((i) => !i.read).length,
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    saveSettings,
    markRead() { let n = false; for (const i of items) if (!i.read) { i.read = true; n = true; } if (n) { saveItems(); emitChange(); } },
    clearAll() { items = []; saveItems(); emitChange(); },
    async test(kind) {
      const body = kind === "duty_pop" ? { type: "duty_pop" } : { priority: kind };
      const r = await fetch(url("/api/notifications/test"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      pull(); // do not wait for the next push
    },
    async getKeywords() {
      const r = await fetch(url("/api/notifications/settings"), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).keywords || [];
    },
    async putKeywords(list) {
      const r = await fetch(url("/api/notifications/settings"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keywords: list }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).keywords || [];
    },
    /** Ask the OS for permission to show system notifications (needs a secure context and a user gesture). */
    async enableSystem() {
      if (!systemSupported()) return false;
      let perm = Notification.permission;
      if (perm === "default") { try { perm = await Notification.requestPermission(); } catch { perm = "denied"; } }
      settings.system = perm === "granted";
      saveSettings();
      return settings.system;
    },
    systemSupported: () => systemSupported(),
  };

  const ui = mountUi(api);

  function systemSupported() { return "Notification" in window && window.isSecureContext; }

  // ---- decisions ------------------------------------------------------------------------------------

  function inQuietHours() {
    const q = settings.quiet;
    if (!q.on) return false;
    const mins = (s) => { const [h, m] = String(s).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
    const d = new Date();
    const now = d.getHours() * 60 + d.getMinutes();
    const a = mins(q.from), b = mins(q.to);
    if (a === b) return false;
    return a < b ? now >= a && now < b : now >= a || now < b; // a window like 22:00-07:00 wraps midnight
  }

  /** Returns how an event is presented, or null when the user turned it off. */
  function decide(ev) {
    if (ev.type === "test") return { prio: ev.priority, sound: true, quiet: false };
    if (!settings.enabled) return null;
    const cfg = settings.types[ev.type];
    if (cfg && !cfg.on) return null;
    const prio = cfg && cfg.priority && cfg.priority !== "default" ? cfg.priority : ev.priority;
    const quiet = inQuietHours() && !(prio === "high" && settings.quiet.allowHigh);
    return { prio, sound: !cfg || cfg.sound !== false, quiet };
  }

  function deliver(ev, d) {
    const info = typeInfo(ev.type);
    if (d.quiet || d.prio === "low") return; // centre only
    const loud = d.prio === "high";
    let sound = d.sound ? (loud ? "high" : "ding") : null;
    if (ev.type === "duty_pop" && loud) sound = d.sound ? "duty" : null;
    else if (ev.type === "ready_check") sound = d.sound ? "ready" : null;
    else if (ev.type === "tell" || ev.type === "mention") sound = d.sound ? "message" : null;
    else if (ev.type === "disconnect") sound = d.sound ? "alarm" : null;

    if (ev.type === "disconnect") ui.showDown(ev);
    else if (loud) ui.showOverlay(ev, { label: info.label, countdown: info.countdown, loopSound: sound === "duty" });
    else ui.showToast(ev);

    if (sound && !(ev.type === "duty_pop" && loud)) audio.play(sound); // the duty chime is driven by the overlay (it repeats)
    if (settings.vibrate && d.sound && navigator.vibrate && !(ev.type === "duty_pop" && loud)) {
      try { navigator.vibrate(loud ? [300, 120, 300, 120, 300] : [160]); } catch { /* needs user activation */ }
    }
    if (settings.system && systemSupported() && Notification.permission === "granted" && (document.hidden || !document.hasFocus())) {
      try { new Notification(ev.title, { body: ev.body || "", tag: `ss-${ev.type}`, requireInteraction: loud }); } catch { /* not allowed here */ }
    }
  }

  function apply(ev, silent) {
    if (ev.type.endsWith("_cleared")) { ui.clearType(ev.type.slice(0, -8)); return; } // control event: dismiss the banner
    const d = decide(ev);
    if (!d) return;
    const item = {
      id: ev.seq ? `s${ev.seq}` : `l${++localId}-${Date.now()}`,
      type: ev.type, title: ev.title, body: ev.body || "", prio: d.prio, ts: ev.ts, expiresAt: ev.expiresAt || null,
      test: !!ev.data?.test, read: silent,
    };
    if (items.some((i) => i.id === item.id)) return;
    items.unshift(item);
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
    const fresh = srvNow() - ev.ts <= FRESH_MS || (ev.expiresAt && ev.expiresAt > srvNow());
    // An already-expired countdown is never worth a banner, however recent.
    const live = !ev.expiresAt || ev.expiresAt > srvNow();
    if (!silent && fresh && live) deliver({ ...ev, data: ev.data || {}, prio: d.prio }, d);
    else if (!silent && ev.expiresAt && !live) item.read = true;
  }

  // ---- catching up with the plugin ----------------------------------------------------------------------

  async function pull() {
    if (Date.now() < retryAt) return;
    if (fetching) { again = true; return; }
    fetching = true;
    try {
      const t0 = Date.now();
      const r = await fetch(url(`/api/notifications?since=${lastSeq}`), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      skew = d.now - (t0 + Date.now()) / 2;
      fails = 0;
      if (d.seq < lastSeq) { items = []; lastSeq = 0; again = true; return; } // the plugin restarted with a smaller counter
      const events = (d.events || []).filter((e) => e.seq > lastSeq).sort((a, b) => a.seq - b.seq);
      const silent = firstLoad;
      for (const ev of events) { lastSeq = ev.seq; apply(ev, silent); }
      lastSeq = Math.max(lastSeq, d.seq);
      firstLoad = false;
      saveItems();
      emitChange();
    } catch {
      // Old plugin build without the endpoint, or the game is shutting down: back off instead of hammering at 6 Hz.
      fails++;
      retryAt = Date.now() + Math.min(30_000, 1500 * fails);
    } finally {
      fetching = false;
      if (again) { again = false; pull(); }
    }
  }

  // ---- connection -----------------------------------------------------------------------------------------

  let downSince = 0, downTimer = 0, downShown = false, tipTimer = 0;

  function checkDown() {
    clearTimeout(downTimer);
    if (!downSince || downShown) return;
    const left = DOWN_MS - (Date.now() - downSince);
    if (left > 0) { downTimer = setTimeout(checkDown, left + 50); return; }
    downShown = true;
    apply({ seq: 0, ts: srvNow(), type: "disconnect", priority: "high", title: "Lost connection to game",
      body: "This page cannot reach the game. Check that the game is running and that this device is on the same network.", data: {} }, false);
  }

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkDown(); });

  const onStatus = (s) => {
    if (s === "online") {
      downSince = 0; clearTimeout(downTimer);
      if (downShown) { downShown = false; ui.clearType("disconnect"); ui.info("Reconnected to the game."); }
      ui.setOnline(true);
      if (!tipTimer) tipTimer = setTimeout(() => ui.maybeShowTip(), 2500);
    } else {
      ui.setOnline(false);
      if (!downSince) { downSince = Date.now(); downTimer = setTimeout(checkDown, DOWN_MS + 50); }
    }
  };

  const onMessage = (msg) => {
    if (msg.queue !== undefined) ui.setQueue(msg.queue, srvNow);
    const s = msg.notifySeq;
    if (typeof s === "number" && s !== lastSeq) pull();
  };

  return { onStatus, onMessage, api };
}
