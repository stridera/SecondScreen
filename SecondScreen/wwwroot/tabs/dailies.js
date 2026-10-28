// Dailies & Weeklies widget: a checklist of what is still open today / this week, read from the game client by the plugin.
//
// Data flow: the plugin evaluates the checklist on the game thread (~1 Hz) and bumps `dailiesVersion` (a small int in the
// WebSocket payload) only when something changed. We refetch GET /api/dailies when that number moves. The model lists EVERY
// item with an `enabled` flag; hidden ones are kept so the settings view can list them. Settings are written back with
// PUT /api/dailies/settings { items: { id: bool }, jumboRegion }.
//
// Countdowns are computed here from fixed UTC anchors (the game's resets never move with DST):
//   daily reset 15:00 UTC, weekly reset Tuesday 08:00 UTC, Grand Company reset 20:00 UTC, Jumbo Cactpot draw per region.
// Time is corrected by the server clock skew (snapshot.timestamp), so a wrong clock on the phone does not matter.
//
// Layout is CSS driven: .wbody[data-size="compact|regular|wide"]; resize() has nothing to do.

import { esc } from "../js/util.js";
import { icon } from "../js/icons.js";

// Draw times as UTC weekday (0 = Sunday) + hour. NA: Saturday 6 PM PST / 7 PM PDT = Sunday 02:00 UTC.
const REGIONS = {
  na: { label: "North America", short: "NA", dow: 0, h: 2 },
  eu: { label: "Europe", short: "EU", dow: 6, h: 19 },
  jp: { label: "Japan", short: "JP", dow: 6, h: 12 },
  oce: { label: "Oceania", short: "OCE", dow: 6, h: 9 },
};
const DAY = 864e5;

const CSS = `
.dly { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dly button { font: inherit; color: inherit; touch-action: manipulation; }
.dly-top { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-bottom: -4px; }
.dly-gear { width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted);
  display: grid; place-items: center; cursor: pointer; }
.dly-gear:hover { color: var(--text); background: var(--surface-3); }
.dly-gear[aria-pressed="true"] { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
.dly-gear .ico { width: 18px; height: 18px; }
@media (pointer: coarse) { .dly-gear { width: 40px; height: 40px; } }

.dly-sec { display: flex; flex-direction: column; gap: 6px; }
.dly-sechead { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; padding: 0 2px; }
.dly-sechead h3 { margin: 0; font-size: .78rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--text); }
.dly-sum { font-size: .8rem; font-weight: 600; color: var(--muted); }
.dly-sum.all { color: var(--hp); }
.dly-reset { margin-left: auto; font-size: .78rem; color: var(--muted); white-space: nowrap; }
.dly-reset b { color: var(--text); font-weight: 650; }
.dly-secbar { height: 3px; border-radius: 3px; background: rgba(255, 255, 255, .07); overflow: hidden; }
.dly-secbar > i { display: block; height: 100%; background: var(--accent); border-radius: inherit; transition: width .3s var(--ease); }
.dly-secbar.all > i { background: var(--hp); }

.dly-list { display: flex; flex-direction: column; gap: 6px; }
.dly-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; column-gap: 11px; padding: 8px 11px; border-radius: 11px;
  background: var(--surface-2); border: 1px solid var(--border); transition: opacity .2s; }
.dly-row.done { opacity: .5; }
.dly-row.warn { border-color: rgba(224, 169, 61, .5); }
.dly-ico { width: 34px; height: 34px; border-radius: 8px; object-fit: contain; display: block; }
.dly-ico.g { display: grid; place-items: center; color: var(--accent); background: var(--accent-soft); }
.dly-ico.g .ico { width: 18px; height: 18px; }
.dly-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dly-name { font-size: .92rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dly-sub { font-size: .76rem; color: var(--muted); overflow-wrap: anywhere; }
.dly-sub b { color: var(--text); font-weight: 650; }
.dly-state { display: grid; place-items: center; width: 26px; height: 26px; }
.dly-state .ico { width: 15px; height: 15px; }
.dly-check { border-radius: 50%; background: var(--hp); color: #06140a; }
.dly-open { border-radius: 50%; border: 2px solid var(--border-strong); }
.dly-bar { grid-column: 2 / -1; height: 6px; margin-top: 6px; border-radius: 4px; background: rgba(255, 255, 255, .08); overflow: hidden; }
.dly-bar > i { display: block; height: 100%; background: var(--accent); border-radius: inherit; transition: width .3s var(--ease); }
.dly-row.done .dly-bar > i { background: var(--hp); }
.dly-row.info .dly-bar > i { background: var(--faint); }
.dly-chips { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 3px; }
.dly-chip { font-size: .72rem; padding: 1px 8px; border-radius: 99px; background: var(--surface-3); color: var(--muted); white-space: nowrap; }
.dly-chip b { color: var(--text); font-weight: 650; }
.dly-none { font-size: .8rem; color: var(--muted); padding: 6px 4px; }

.dly-times { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px; }
.dly-tile { padding: 8px 11px; border-radius: 11px; background: var(--surface-2); border: 1px solid var(--border); min-width: 0; }
.dly-tile .k { font-size: .68rem; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.dly-tile .v { font-size: 1.05rem; font-weight: 650; white-space: nowrap; }
.dly-tile .s { font-size: .72rem; color: var(--muted); }

/* settings */
.dly-sethead { display: flex; align-items: center; gap: 8px; }
.dly-sethead h3 { margin: 0; font-size: .95rem; flex: 1 1 auto; }
.dly-done { height: 34px; padding: 0 14px; border-radius: 9px; border: 1px solid var(--accent); background: var(--accent); color: #06101f; font-weight: 650; font-size: .86rem; cursor: pointer; }
@media (pointer: coarse) { .dly-done { height: 40px; } }
.dly-opt { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 11px; border-radius: 11px;
  background: var(--surface-2); border: 1px solid var(--border); font-size: .88rem; }
.dly-opt .dly-name { font-size: .88rem; }
.dly-sw { position: relative; width: 44px; height: 26px; border-radius: 99px; border: 1px solid var(--border-strong); background: var(--surface-3); cursor: pointer; padding: 0;
  transition: background-color .15s, border-color .15s; }
.dly-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: var(--muted); transition: transform .15s, background-color .15s; }
.dly-sw[aria-checked="true"] { background: var(--accent-soft); border-color: var(--accent); }
.dly-sw[aria-checked="true"]::after { transform: translateX(18px); background: var(--accent); }
@media (pointer: coarse) { .dly-sw { width: 50px; height: 30px; } .dly-sw::after { width: 24px; height: 24px; } .dly-sw[aria-checked="true"]::after { transform: translateX(20px); } }
.dly-seg { display: flex; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.dly-seg button { flex: 1 1 0; height: 34px; border: 0; background: var(--panel2); color: var(--muted); font-size: .82rem; font-weight: 650; cursor: pointer; }
.dly-seg button + button { border-left: 1px solid var(--border); }
.dly-seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
@media (pointer: coarse) { .dly-seg button { height: 40px; } }
.dly-setrow { grid-template-columns: 30px minmax(0, 1fr) auto; }
.dly-setrow .dly-ico { width: 30px; height: 30px; }

/* compact panels (< 340px): tighter rows, smaller icons, the reset countdown wraps below the title */
.wbody[data-size="compact"] .dly { gap: 10px; }
.wbody[data-size="compact"] .dly-row { grid-template-columns: 26px minmax(0, 1fr) auto; column-gap: 8px; padding: 6px 8px; border-radius: 9px; }
.wbody[data-size="compact"] .dly-ico { width: 26px; height: 26px; border-radius: 6px; }
.wbody[data-size="compact"] .dly-ico.g .ico { width: 15px; height: 15px; }
.wbody[data-size="compact"] .dly-name { font-size: .84rem; }
.wbody[data-size="compact"] .dly-sub { font-size: .7rem; }
.wbody[data-size="compact"] .dly-state { width: 22px; height: 22px; }
.wbody[data-size="compact"] .dly-bar { height: 5px; margin-top: 4px; }
.wbody[data-size="compact"] .dly-reset { margin-left: 0; flex-basis: 100%; }
.wbody[data-size="compact"] .dly-times { grid-template-columns: 1fr; }
.wbody[data-size="compact"] .dly-tile { padding: 6px 9px; }
.wbody[data-size="compact"] .dly-tile .v { font-size: .95rem; }
.wbody[data-size="wide"] .dly-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
`;

/** One independent widget instance (docked panel or floating window): every instance gets its own state `S` and timers. Shared
 *  caches (market.js) stay module-level. The body below only moved into this closure (review with `git diff -w`). */
export function create() {
  let S = null;

  // ---- time ------------------------------------------------------------------------------------------------------------------

  const nowMs = () => Date.now() + (S ? S.skew : 0);

  /** Next occurrence of hh:00 UTC strictly after `ms`. */
  function nextDaily(ms, h) {
    const d = new Date(ms);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h);
    if (t <= ms) t += DAY;
    return t;
  }

  /** Next occurrence of weekday `dow` (0 = Sunday, UTC) at hh:00 UTC strictly after `ms`. */
  function nextWeekly(ms, dow, h) {
    const d = new Date(ms);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h);
    t += ((dow - d.getUTCDay() + 7) % 7) * DAY;
    if (t <= ms) t += 7 * DAY;
    return t;
  }

  const resetAt = {
    daily: (ms) => nextDaily(ms, 15),
    weekly: (ms) => nextWeekly(ms, 2, 8),
    gc: (ms) => nextDaily(ms, 20),
    jumbo: (ms, region) => { const r = REGIONS[region] || REGIONS.na; return nextWeekly(ms, r.dow, r.h); },
  };

  function fmtLeft(ms) {
    let s = Math.max(0, Math.ceil(ms / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, "0")}m`;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }

  const utcLabel = (t) => {
    const d = new Date(t);
    return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
  };

  // ---- rendering -------------------------------------------------------------------------------------------------------------

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  function iconHtml(it, small) {
    if (it.iconId) {
      return `<img class="dly-ico" src="${esc(S.ctx.withToken(`/api/icon/${it.iconId}.png`))}" alt="" loading="lazy" data-glyph="${esc(it.glyph)}" width="${small ? 30 : 34}" height="${small ? 30 : 34}">`;
    }
    return `<span class="dly-ico g">${icon(it.glyph || "check")}</span>`;
  }

  const pctOf = (v, max) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);

  /** Shared by checklist rows: [sub line html, bar percent or null, extra html]. */
  function describe(it) {
    switch (it.kind) {
      case "flag":
        return { sub: it.done ? "Done" : "Not done yet", bar: null };
      case "remaining": {
        const used = it.max - it.value;
        return { sub: `Allowances <b>${it.value}/${it.max}</b>${it.done ? " (all used)" : ""}`, bar: pctOf(used, it.max) };
      }
      case "progress":
        return { sub: `Acquired <b>${it.value}/${it.max}</b>`, bar: pctOf(it.value, it.max) };
      case "info": {
        const refill = it.at && it.value < it.max ? ` · refill in <span data-at="${it.at * 1000}">${fmtLeft(it.at * 1000 - nowMs())}</span>` : it.value >= it.max ? " · full" : "";
        return { sub: `Allowances <b>${it.value}/${it.max}</b>${refill}`, bar: pctOf(it.value, it.max) };
      }
      case "journal": {
        if (it.state === "none") return { sub: "No journal (turned in, or not picked up)", bar: null };
        const chips = (it.parts || []).map((p) => `<span class="dly-chip">${esc(p.label)} <b>${p.value}${p.max != null ? `/${p.max}` : ""}</b></span>`).join("");
        const msg = it.state === "expired" ? "Journal expired: turn it in" : it.state === "complete" ? "All stickers placed" : "";
        return { sub: msg, bar: pctOf(it.value, it.max), extra: `<div class="dly-chips">${chips}</div>`, warn: it.state === "expired" };
      }
      default:
        return { sub: "", bar: null };
    }
  }

  function rowHtml(it) {
    const d = describe(it);
    const cls = ["dly-row", it.done ? "done" : "", it.info ? "info" : "", d.warn ? "warn" : ""].filter(Boolean).join(" ");
    const state = it.info ? "<span class=\"dly-state\"></span>"
      : it.done ? `<span class="dly-state dly-check">${icon("check")}</span>` : "<span class=\"dly-state dly-open\"></span>";
    return `<div class="${cls}" data-id="${esc(it.id)}">
    ${iconHtml(it)}
    <div class="dly-main"><div class="dly-name" title="${esc(it.name)}">${esc(it.name)}</div>${d.sub ? `<div class="dly-sub">${d.sub}</div>` : ""}${d.extra || ""}</div>
    ${state}
    ${d.bar != null ? `<div class="dly-bar"><i style="width:${d.bar.toFixed(1)}%"></i></div>` : ""}
  </div>`;
  }

  function sectionHtml(group, title, items) {
    const counted = items.filter((i) => !i.info);
    const done = counted.filter((i) => i.done).length;
    const all = counted.length > 0 && done === counted.length;
    const sum = counted.length ? `${done}/${counted.length} done` : "nothing selected";
    const ordered = S.sortDone ? [...items].sort((a, b) => (a.done && !a.info) - (b.done && !b.info)) : items;
    const rows = ordered.length ? ordered.map(rowHtml).join("") : `<div class="dly-none">No items shown. Use the gear to pick some.</div>`;
    return `<section class="dly-sec" data-group="${group}">
    <div class="dly-sechead"><h3>${title}</h3><span class="dly-sum${all ? " all" : ""}">${sum}</span>
      <span class="dly-reset">Resets in <b data-cd="${group}">${fmtLeft(resetAt[group](nowMs()) - nowMs())}</b></span></div>
    <div class="dly-secbar${all ? " all" : ""}"><i style="width:${pctOf(done, counted.length).toFixed(1)}%"></i></div>
    <div class="dly-list">${rows}</div>
  </section>`;
  }

  function timersHtml() {
    const region = REGIONS[S.model.jumboRegion] ? S.model.jumboRegion : "na";
    const r = REGIONS[region];
    const now = nowMs();
    const jumbo = resetAt.jumbo(now, region);
    const gc = resetAt.gc(now);
    const tile = (k, cd, sub) => `<div class="dly-tile"><div class="k">${k}</div><div class="v" data-cd="${cd}">${fmtLeft((cd === "jumbo" ? jumbo : gc) - now)}</div><div class="s">${sub}</div></div>`;
    return `<section class="dly-sec"><div class="dly-sechead"><h3>Timers</h3></div><div class="dly-times">
    ${tile(`Jumbo Cactpot (${r.short})`, "jumbo", utcLabel(jumbo))}
    ${tile("Grand Company reset", "gc", utcLabel(gc))}
  </div></section>`;
  }

  function settingsRowHtml(it) {
    return `<div class="dly-row dly-setrow" data-id="${esc(it.id)}">${iconHtml(it, true)}
    <div class="dly-main"><div class="dly-name" title="${esc(it.name)}">${esc(it.name)}</div></div>
    <button type="button" class="dly-sw" role="switch" aria-checked="${it.enabled}" aria-label="Show ${esc(it.name)}" data-sw="${esc(it.id)}"></button>
  </div>`;
  }

  function renderSettings() {
    const items = S.model.items;
    const region = S.model.jumboRegion;
    const group = (g, title) => `<section class="dly-sec"><div class="dly-sechead"><h3>${title}</h3></div><div class="dly-list">${items.filter((i) => i.group === g).map(settingsRowHtml).join("")}</div></section>`;
    S.root.innerHTML = `
    <div class="dly-sethead"><h3>Choose what to show</h3><button type="button" class="dly-done" data-act="close">Done</button></div>
    <div class="dly-opt"><span class="dly-name">Move completed items to the bottom</span><button type="button" class="dly-sw" role="switch" aria-checked="${S.sortDone}" aria-label="Move completed items to the bottom" data-sw="@sort"></button></div>
    ${group("daily", "Daily")}
    ${group("weekly", "Weekly")}
    <section class="dly-sec"><div class="dly-sechead"><h3>Jumbo Cactpot region</h3></div>
      <div class="dly-seg" role="group" aria-label="Jumbo Cactpot region">${Object.entries(REGIONS).map(([id, r]) => `<button type="button" data-region="${id}" aria-pressed="${id === region}" title="${esc(r.label)}">${r.short}</button>`).join("")}</div>
    </section>`;
  }

  function renderMain() {
    const m = S.model;
    const gearBtn = `<div class="dly-top"><button type="button" class="dly-gear" data-act="settings" aria-pressed="false" title="Choose what to show" aria-label="Settings">${icon("gear")}</button></div>`;
    if (!m) {
      S.root.innerHTML = `<div class="empty">${S.error ? `Could not load the checklist (${esc(S.error)}).` : "Loading..."}</div>`;
      S.ctx.setBadge("");
      return;
    }
    if (!m.loggedIn) {
      S.root.innerHTML = `<div class="empty">${icon("dailies", "big")}<div>Log in to a character to see dailies and weeklies.</div></div>`;
      S.ctx.setBadge("");
      return;
    }
    const shown = m.items.filter((i) => i.enabled);
    const daily = shown.filter((i) => i.group === "daily");
    const weekly = shown.filter((i) => i.group === "weekly");
    S.root.innerHTML = gearBtn + sectionHtml("daily", "Daily", daily) + sectionHtml("weekly", "Weekly", weekly) + timersHtml();

    const counted = shown.filter((i) => !i.info);
    S.ctx.setBadge(counted.length ? `${counted.filter((i) => i.done).length}/${counted.length}` : "");
  }

  function render() {
    if (!S) return;
    const scroll = S.el.scrollTop;
    if (S.settings && S.model && S.model.loggedIn) renderSettings(); else renderMain();
    S.el.scrollTop = scroll;
  }

  /** Cheap once-a-second pass: only the countdown texts change. */
  function tick() {
    if (!S || document.hidden) return;
    const now = nowMs();
    const region = S.model ? S.model.jumboRegion : "na";
    for (const n of S.root.querySelectorAll("[data-cd]")) {
      const t = resetAt[n.dataset.cd](now, region);
      const txt = fmtLeft(t - now);
      if (n.textContent !== txt) n.textContent = txt;
      // Timer tiles show the next occurrence ("Sun 02:00 UTC"); it moves a day / a week when the timer rolls over.
      const sub = n.nextElementSibling;
      if (sub && sub.classList.contains("s")) { const lbl = utcLabel(t); if (sub.textContent !== lbl) sub.textContent = lbl; }
    }
    for (const n of S.root.querySelectorAll("[data-at]")) {
      const txt = fmtLeft(Number(n.dataset.at) - now);
      if (n.textContent !== txt) n.textContent = txt;
    }
    // The Jumbo tile's "Sun 02:00 UTC" label moves a week at a time; refresh it only when the model re-renders.
  }

  // ---- data ------------------------------------------------------------------------------------------------------------------

  async function fetchModel() {
    if (S.fetching) return;
    S.fetching = true;
    try {
      const r = await fetch(S.ctx.withToken("/api/dailies"), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      S.model = await r.json();
      S.version = S.model.version;
      S.error = "";
      render();
    } catch (e) {
      S.error = e.message || String(e);
      S.retryAt = Date.now() + 5000;
      if (!S.model) render();
    } finally {
      S.fetching = false;
      S.retryAt = Math.max(S.retryAt, Date.now() + 1000); // never faster than 1 Hz
    }
  }

  async function saveSettings(body) {
    try {
      const r = await fetch(S.ctx.withToken("/api/dailies/settings"), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      S.error = e.message || String(e);
    }
    S.version = null; // reconcile with whatever the plugin ended up with
    S.retryAt = 0;
    fetchModel();
  }

  function onClick(e) {
    const t = e.target.closest("[data-act],[data-sw],[data-region]");
    if (!t || !S) return;
    if (t.dataset.act === "settings") { S.settings = true; render(); return; }
    if (t.dataset.act === "close") { S.settings = false; render(); return; }
    if (t.dataset.sw === "@sort") {
      S.sortDone = !S.sortDone;
      store.set("ss.dailies.sortDone", S.sortDone ? "1" : "0");
      render();
      return;
    }
    if (t.dataset.sw && S.model) {
      const it = S.model.items.find((i) => i.id === t.dataset.sw);
      if (!it) return;
      it.enabled = !it.enabled; // optimistic; the fetch after the PUT reconciles
      t.setAttribute("aria-checked", String(it.enabled));
      saveSettings({ items: { [it.id]: it.enabled } });
      return;
    }
    if (t.dataset.region && S.model && t.dataset.region !== S.model.jumboRegion) {
      S.model.jumboRegion = t.dataset.region;
      for (const b of S.root.querySelectorAll("[data-region]")) b.setAttribute("aria-pressed", String(b.dataset.region === S.model.jumboRegion));
      saveSettings({ jumboRegion: S.model.jumboRegion });
    }
  }

  // ---- widget contract -------------------------------------------------------------------------------------------------------

  function mount(el, ctx) {
    if (!document.getElementById("dly-style")) {
      const st = document.createElement("style");
      st.id = "dly-style";
      st.textContent = CSS;
      document.head.append(st);
    }
    el.innerHTML = "<div class=\"dly\"></div>";
    const root = el.querySelector(".dly");
    S = {
      ctx, el, root, model: null, version: null, fetching: false, retryAt: 0, error: "", noFeed: false, skew: 0,
      settings: false, sortDone: store.get("ss.dailies.sortDone", "1") !== "0", timer: 0,
    };
    root.addEventListener("click", onClick);
    // A game icon that fails to load (404) falls back to the item's glyph.
    root.addEventListener("error", (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.dataset.glyph) return;
      const span = document.createElement("span");
      span.className = "dly-ico g";
      span.innerHTML = icon(img.dataset.glyph);
      img.replaceWith(span);
    }, true);
    S.timer = setInterval(tick, 1000);
    render();
  }

  function update(payload) {
    if (!S) return;
    const ts = payload.snapshot && payload.snapshot.timestamp;
    if (ts) S.skew = ts - Date.now();

    const v = payload.dailiesVersion;
    if (v === undefined) {
      if (!S.model && !S.noFeed) { S.noFeed = true; fetchModel(); } // older plugin build: try the endpoint once
      return;
    }
    if (v !== S.version && !S.fetching && Date.now() >= S.retryAt) fetchModel();
  }

  function unmount() {
    if (!S) return;
    clearInterval(S.timer);
    S = null;
  }

  return { mount, update, unmount };
}
