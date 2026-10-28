// Inventory widget: bags, armoury, equipped, crystals, currency, saddlebag and cached retainers, with "where is item X" search,
// free slots / gil, retainer venture countdowns and a one-tap "Track this" for any item.
//
// Data flow: the plugin builds the inventory on the game thread and bumps `inventoryVersion` (a small int in the WebSocket
// payload) when anything changes. We refetch GET /api/inventory only when that number changes, rebuild one index
// (item id -> total + places) and re-render. Static item info (name, icon, ilvl, category) comes inline in `items`.
// Everything below the version check is DOM work on a cached model, so a 500-item inventory stays cheap; icons are
// <img loading="lazy"> served by /api/icon/{iconId}.png.
//
// Layout is CSS driven: .wbody[data-size="compact|regular|wide"] picks the grid column count, so resize() has nothing to do.

import { esc } from "../js/util.js";
import { icon } from "../js/icons.js";
import * as market from "../js/market.js";

const GROUPS = [
  { id: "all", label: "All" },
  { id: "bags", label: "Bags" },
  { id: "armoury", label: "Armoury" },
  { id: "equipped", label: "Equipped" },
  { id: "crystals", label: "Crystals" },
  { id: "currency", label: "Currency" },
  { id: "saddlebag", label: "Saddlebag" },
  { id: "retainers", label: "Retainers" },
];
const SECTION_ORDER = ["bags", "equipped", "armoury", "saddlebag", "crystals", "currency", "retainers"];
const SECTION_TITLE = { bags: "Bags", equipped: "Equipped", armoury: "Armoury", saddlebag: "Saddlebag", crystals: "Crystals", currency: "Currency", retainers: "Retainers" };
const EQUIP_SLOTS = ["Main", "Off", "Head", "Body", "Hands", "Waist", "Legs", "Feet", "Ears", "Neck", "Wrist", "Ring", "Ring", "Soul"];
const RARITY_COLOR = { 2: "#7fd47f", 3: "#6aa8ff", 4: "#c08cff", 7: "#ff8fc7" };
const MAX_RESULTS = 120;

const CSS = `
.inv { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.inv button { font: inherit; color: inherit; touch-action: manipulation; }
.inv-sticky { position: sticky; top: -10px; z-index: 5; margin: -10px -10px 0; padding: 10px 10px 6px; background: #12151d;
  border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.inv-top { display: flex; gap: 8px; align-items: center; }
.inv-search { position: relative; flex: 1 1 auto; min-width: 0; }
.inv-search input { width: 100%; height: 40px; padding: 0 38px 0 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel2);
  color: var(--text); font-size: 1rem; -webkit-appearance: none; appearance: none; }
.inv-search input::-webkit-search-cancel-button { display: none; }
.inv-search input:focus { outline: 2px solid var(--accent-line); outline-offset: 1px; }
.inv-clear { position: absolute; right: 2px; top: 2px; width: 36px; height: 36px; border: 0; background: none; color: var(--muted); font-size: 1.3rem; cursor: pointer; }
.inv-seg { flex: none; display: flex; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.inv-seg button { height: 38px; min-width: 52px; padding: 0 12px; border: 0; background: var(--panel2); color: var(--muted); font-size: .86rem; font-weight: 600; cursor: pointer; }
.inv-seg button + button { border-left: 1px solid var(--border); }
.inv-seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
.inv-chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; margin: 0 -10px; padding: 0 10px; }
.inv-chips::-webkit-scrollbar { display: none; }
.inv-chip { flex: none; height: 34px; padding: 0 13px; border-radius: 99px; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted);
  font-size: .82rem; font-weight: 600; cursor: pointer; white-space: nowrap; }
.inv-chip[aria-pressed="true"] { color: var(--text); border-color: var(--accent); background: var(--accent-soft); }
@media (pointer: coarse) { .inv-chip { height: 40px; } .inv-seg button { height: 42px; } .inv-search input { height: 44px; } }

.inv-sum { display: flex; flex-wrap: wrap; gap: 8px; }
.inv-tile { flex: 1 1 110px; min-width: 0; padding: 8px 11px; border-radius: 11px; background: var(--surface-2); border: 1px solid var(--border); }
.inv-tile .k { font-size: .68rem; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.inv-tile .v { font-size: 1.15rem; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inv-tile .s { font-size: .74rem; line-height: 1.25; color: var(--muted); overflow-wrap: anywhere; }
.inv-tile.warn .v { color: #e0a93d; }
.inv-tile.full .v { color: var(--hp-low); }
.wbody[data-size="compact"] .inv-tile { flex-basis: 45%; }
.wbody[data-size="compact"] .inv-tile .v { font-size: 1rem; }

.inv-sec-h { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 4px 4px; border: 0; background: none; text-align: left; cursor: pointer; }
.inv-sec-h b { font-size: .74rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
.inv-sec-h small { color: var(--faint); font-size: .76rem; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inv-sec-h .ico { transition: transform .15s; color: var(--faint); }
.inv-sec-h[aria-expanded="false"] .ico { transform: rotate(-90deg); }
.inv-sec.solo > .inv-sec-h { cursor: default; }
.inv-sec.solo > .inv-sec-h .ico { display: none; }
.inv-pages { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 420px)); gap: 10px; align-items: start; }
.inv-page-h { display: flex; justify-content: space-between; gap: 8px; font-size: .8rem; color: var(--muted); padding: 0 2px 4px; }
.inv-page-h span:last-child { color: var(--faint); white-space: nowrap; }
.inv-grid { --cols: 7; display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 4px; }
.wbody[data-size="compact"] .inv-grid { --cols: 5; gap: 3px; }
.inv-grid.free { grid-template-columns: repeat(auto-fill, minmax(46px, 1fr)); }
.inv-cell { position: relative; aspect-ratio: 1; min-width: 0; padding: 0; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--surface-2); cursor: pointer; overflow: hidden; }
.inv-cell img { display: block; width: 100%; height: 100%; object-fit: contain; padding: 2px; pointer-events: none; -webkit-user-drag: none; }
.inv-cell:active { background: var(--surface-3); }
.inv-cell.e { border-style: dashed; border-color: var(--border); background: transparent; cursor: default; display: grid; place-items: center; color: var(--faint); font-size: .58rem; }
.inv-cell .q { position: absolute; right: 2px; bottom: 1px; font-style: normal; font-size: .68rem; font-weight: 700; line-height: 1.1; color: #fff; text-shadow: 0 0 2px #000, 0 1px 2px #000, 0 0 4px #000; }
.inv-cell .hq { position: absolute; left: 2px; top: 1px; font-style: normal; font-size: .52rem; font-weight: 800; line-height: 1; padding: 1px 2px; border-radius: 3px; background: #e0a93d; color: #1b1405; }
.inv-cell .nm { display: none; }
.inv-note { color: var(--muted); font-size: .82rem; padding: 4px 4px 8px; }

.inv-row { display: flex; flex-wrap: wrap; align-items: stretch; border-radius: 10px; }
.inv-row + .inv-row { margin-top: 2px; }
.inv-main { flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 4px 6px; border: 0; background: none; text-align: left; cursor: pointer; border-radius: 10px; }
.inv-main:active, .inv-main:hover { background: var(--surface-2); }
.inv-main img, .inv-main .ph { width: 36px; height: 36px; flex: none; border-radius: 7px; background: var(--surface-2); object-fit: contain; }
.inv-txt { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.inv-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.inv-sub { color: var(--muted); font-size: .76rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inv-sub.wrap { white-space: normal; overflow-wrap: anywhere; }
.inv-cnt { flex: none; font-weight: 650; padding-left: 6px; }
.inv-exp { flex: none; width: 44px; border: 0; background: none; color: var(--muted); cursor: pointer; display: grid; place-items: center; border-radius: 10px; }
.inv-exp .ico { transition: transform .15s; }
.inv-row.open .inv-exp .ico { transform: rotate(180deg); }
.inv-bd { display: none; flex: 1 1 100%; margin: 0 0 6px 52px; padding-left: 10px; border-left: 2px solid var(--border); font-size: .82rem; color: var(--muted); }
.inv-row.open .inv-bd { display: block; }
.inv-bd div { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
.inv-bd b { color: var(--text); font-weight: 600; white-space: nowrap; }
.inv-hqtag { color: #e0a93d; font-weight: 700; font-size: .7rem; }
.inv-count { color: var(--muted); font-size: .8rem; padding: 2px 4px 6px; }

.inv-rets { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 8px; align-items: start; }
.inv-ret { padding: 10px 12px; }
.inv-ret-h { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.inv-ret-n { flex: 1 1 auto; min-width: 0; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inv-ret-j { flex: none; font-size: .72rem; font-weight: 700; padding: 1px 6px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); }
.inv-ret-m { color: var(--muted); font-size: .78rem; margin-top: 2px; }
.inv-ven { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; padding: 7px 10px; border-radius: 9px;
  background: rgba(106, 168, 255, .1); border: 1px solid rgba(106, 168, 255, .3); font-size: .86rem; }
.inv-ven .vn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inv-ven .eta { flex: none; font-weight: 700; font-variant-numeric: tabular-nums; }
.inv-ven.none { background: var(--surface); border-color: var(--border); color: var(--faint); }
.inv-ven.done { background: rgba(76, 196, 106, .13); border-color: rgba(76, 196, 106, .5); }
.inv-ven.done .eta { color: var(--hp); }
.inv-ret-t { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 40px; margin-top: 6px; padding: 0 10px; border-radius: 9px;
  border: 1px solid var(--border); background: var(--panel2); cursor: pointer; font-size: .86rem; }
.inv-ret-t .ico { transition: transform .15s; }
.inv-ret-t[aria-expanded="true"] .ico { transform: rotate(180deg); }
.inv-ret-items { margin-top: 8px; }

.inv-sr { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 54px; padding: 6px 8px; border: 0; border-radius: 10px; background: none; text-align: left; cursor: pointer; }
.inv-sr:hover, .inv-sr:active { background: var(--surface-2); }
.inv-sr img, .inv-sr .ph { width: 40px; height: 40px; flex: none; border-radius: 8px; background: var(--surface-2); object-fit: contain; }

dialog.inv-sheet { width: min(460px, 94vw); max-height: 86vh; max-height: 86dvh; padding: 0; overflow: auto; -webkit-overflow-scrolling: touch; }
.inv-sheet .sh { padding: 14px; }
.inv-sheet .sh-head { display: flex; align-items: center; gap: 12px; }
.inv-sheet .sh-head img, .inv-sheet .sh-head .ph { width: 52px; height: 52px; flex: none; border-radius: 10px; background: var(--panel2); object-fit: contain; }
.inv-sheet .sh-t { flex: 1 1 auto; min-width: 0; }
.inv-sheet .sh-name { font-size: 1.05rem; font-weight: 650; overflow-wrap: anywhere; }
.inv-sheet .sh-sub { color: var(--muted); font-size: .84rem; }
.inv-sheet .sh-x { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 10px; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); font-size: 1.3rem; }
.inv-sheet .sh-tot { margin: 12px 0 6px; font-size: .95rem; }
.inv-sheet .sh-tot small { color: var(--muted); }
.inv-sheet .sh-locs { list-style: none; margin: 0; padding: 0; max-height: 36vh; overflow: auto; border-top: 1px solid var(--border); }
.inv-sheet .sh-locs li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: .9rem; }
.inv-sheet .sh-locs li span small { display: block; color: var(--muted); font-size: .76rem; }
.inv-sheet .sh-locs b { white-space: nowrap; }
.inv-sheet .sh-act { display: flex; align-items: center; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
.inv-sheet .sh-act .btn { height: 44px; padding: 0 20px; font-size: .95rem; }
.inv-sheet .sh-act .btn:disabled { opacity: .55; cursor: default; }
.inv-sheet .sh-msg { color: var(--muted); font-size: .86rem; }
.inv-sheet .sh-msg.ok { color: var(--hp); }
.inv-sheet .sh-msg.err { color: var(--hp-low); }
@media (max-width: 600px) { dialog.inv-sheet { margin: auto auto 0; width: 100vw; max-width: 100vw; border-radius: 18px 18px 0 0; padding-bottom: env(safe-area-inset-bottom); } }
`;

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/** One independent widget instance (docked panel or floating window): every instance gets its own state `S` and timers. Shared
 *  caches (market.js) stay module-level. The body below only moved into this closure (review with `git diff -w`). */
export function create() {
  let S = null;

  // ---- small helpers ------------------------------------------------------------------------------------------------------

  const fmtN = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "-");
  const nowMs = () => Date.now() + (S ? S.skew : 0);

  function qtyShort(n) {
    if (n < 10000) return String(n);
    if (n < 1e6) return `${Math.floor(n / 1000)}k`;
    return `${(n / 1e6).toFixed(1)}M`;
  }

  function ago(ms) {
    if (!ms) return "never";
    const s = Math.max(0, Math.round((nowMs() - ms) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function fmtDur(ms) {
    const s = Math.ceil(ms / 1000);
    const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (d > 0) return `${d}d ${hh}h ${m}m`;
    if (hh > 0) return `${hh}h ${String(m).padStart(2, "0")}m ${String(ss).padStart(2, "0")}s`;
    return `${m}m ${String(ss).padStart(2, "0")}s`;
  }

  const infoOf = (id) => S.info[id];
  const nameOf = (id) => infoOf(id)?.name || `Item #${id}`;

  function imgTag(id, cls = "") {
    const inf = infoOf(id);
    if (!inf || !inf.iconId) return `<span class="ph${cls ? " " + cls : ""}"></span>`;
    return `<img${cls ? ` class="${cls}"` : ""} src="${esc(S.ctx.withToken(`/api/icon/${inf.iconId}.png`))}" loading="lazy" decoding="async" alt="" draggable="false">`;
  }

  function placeLabel(c) {
    return c.group === "armoury" ? `Armoury ${c.label}` : c.label;
  }

  // ---- model -> index -------------------------------------------------------------------------------------------------------

  /** item id -> { id, total, lower, places: Map(key -> place) }. A place is one container (or one retainer) holding the item. */
  function ingest(d) {
    S.data = d;
    S.info = d.items || {};
    const items = new Map();
    const add = (it, key, label, group, order, seen) => {
      let e = items.get(it.itemId);
      if (!e) {
        const inf = S.info[it.itemId];
        e = { id: it.itemId, total: 0, lower: `${inf ? inf.name : "item " + it.itemId} ${inf ? inf.category : ""}`.toLowerCase(), places: new Map() };
        items.set(it.itemId, e);
      }
      let p = e.places.get(key);
      if (!p) { p = { key, label, group, order, seen, qty: 0, hq: 0, stacks: [] }; e.places.set(key, p); }
      p.qty += it.qty;
      if (it.hq) p.hq += it.qty;
      p.stacks.push(it);
      e.total += it.qty;
    };
    let order = 0;
    for (const c of d.containers || []) {
      const seen = c.loaded === false ? c.cachedAt || 0 : 0;
      for (const it of c.items) add(it, c.id, placeLabel(c), c.group, order, seen);
      order++;
    }
    for (const r of d.retainers || []) {
      for (const it of r.items) add(it, `r:${r.id}`, `Retainer ${r.name}`, "retainers", 1000 + (r.order || 0), r.itemsSeen || 0);
    }
    S.items = items;
    S.containers = new Map();
    for (const c of d.containers || []) {
      let list = S.containers.get(c.group);
      if (!list) S.containers.set(c.group, (list = []));
      list.push(c);
    }
  }

  const groupContainers = (g) => S.containers.get(g) || [];

  /** Items of one group merged by item id (list view): [{id, total, places: [place...]}]. */
  function mergedForGroup(g) {
    const out = [];
    for (const e of S.items.values()) {
      const places = [];
      let total = 0;
      for (const p of e.places.values()) if (p.group === g) { places.push(p); total += p.qty; }
      if (places.length) out.push({ id: e.id, total, places });
    }
    out.sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)));
    return out;
  }

  // ---- rendering: pieces ---------------------------------------------------------------------------------------------------

  function cellHtml(it, tag = "") {
    const nm = nameOf(it.itemId);
    const tip = `${nm}${it.hq ? " (HQ)" : ""}${it.qty > 1 ? " x" + fmtN(it.qty) : ""}${tag ? " - " + tag : ""}`;
    return `<button type="button" class="inv-cell" data-id="${it.itemId}" title="${esc(tip)}" aria-label="${esc(tip)}">${imgTag(it.itemId)}`
      + `${it.qty > 1 ? `<i class="q">${qtyShort(it.qty)}</i>` : ""}${it.hq ? `<i class="hq">HQ</i>` : ""}</button>`;
  }

  /** A game-like page: every slot is shown (empty ones faint) when `empties`, otherwise only occupied slots. */
  function pageHtml(c, { empties = true, slotLabels = null, note = "" } = {}) {
    let cells;
    if (empties) {
      const slots = new Array(c.size).fill(null);
      for (const it of c.items) if (it.slot < c.size) slots[it.slot] = it;
      cells = slots.map((it, i) => it ? cellHtml(it) : `<div class="inv-cell e">${slotLabels && slotLabels[i] ? esc(slotLabels[i]) : ""}</div>`).join("");
    } else {
      cells = c.items.map((it) => cellHtml(it)).join("");
    }
    const used = c.size - c.free;
    const right = note || (empties ? `${c.free} free` : `${used}`);
    return `<div class="inv-page"><div class="inv-page-h"><span>${esc(c.label)}</span><span>${esc(right)}</span></div>`
      + `<div class="inv-grid${empties ? "" : " free"}">${cells}</div></div>`;
  }

  function locText(places) {
    return places.map((p) => `${p.label} ×${fmtN(p.qty)}${p.seen ? ` (seen ${ago(p.seen)})` : ""}`).join(" · ");
  }

  function rowHtml(m, key) {
    const inf = infoOf(m.id);
    const open = S.open.has(key);
    const allHq = m.places.every((p) => p.hq === p.qty);
    const bd = m.places.map((p) => {
      const hq = p.hq > 0 && !allHq ? ` <span class="inv-hqtag">HQ ×${fmtN(p.hq)}</span>` : "";
      return `<div><span>${esc(p.label)}${p.seen ? ` <small>(seen ${esc(ago(p.seen))})</small>` : ""}${hq}</span><b>×${fmtN(p.qty)}</b></div>`;
    }).join("");
    return `<div class="inv-row${open ? " open" : ""}"><button type="button" class="inv-main" data-id="${m.id}">${imgTag(m.id)}`
      + `<span class="inv-txt"><span class="inv-nm">${esc(nameOf(m.id))}${allHq ? ` <span class="inv-hqtag">HQ</span>` : ""}</span>`
      + `<span class="inv-sub">${esc(inf?.category || "")}${inf?.ilvl > 1 && inf.gear ? ` · iLv ${inf.ilvl}` : ""}${m.places.length > 1 ? ` · ${m.places.length} locations` : ""}</span></span>`
      + `<span class="inv-cnt">×${fmtN(m.total)}</span></button>`
      + `<button type="button" class="inv-exp" data-exp="${esc(key)}" aria-label="Locations" aria-expanded="${open}">${icon("chevron")}</button>`
      + `<div class="inv-bd">${bd}</div></div>`;
  }

  function listHtml(merged, prefix) {
    if (!merged.length) return `<p class="inv-note">Nothing here.</p>`;
    return merged.map((m) => rowHtml(m, `${prefix}:${m.id}`)).join("");
  }

  function etaState(v) {
    if (!v.completeAt) return { text: "In progress", done: false };
    const left = v.completeAt * 1000 - nowMs();
    return left > 0 ? { text: fmtDur(left), done: false } : { text: "Complete!", done: true };
  }

  function ventureHtml(r) {
    const v = r.venture;
    if (!v) return `<div class="inv-ven none"><span class="vn">No venture</span></div>`;
    const st = etaState(v);
    return `<div class="inv-ven${st.done ? " done" : ""}"><span class="vn" title="${esc(v.name)}">${esc(v.name)}</span><span class="eta" data-at="${v.completeAt}">${st.text}</span></div>`;
  }

  function retainerHtml(r) {
    const open = S.rOpen.has(r.id);
    const n = r.items.length;
    const seenItems = r.itemsSeen ? `${n} item${n === 1 ? "" : "s"}` : r.itemCount ? `${r.itemCount} items (not opened yet)` : "contents not seen";
    let body = "";
    if (open) {
      if (!n) body = `<p class="inv-note">${r.itemsSeen ? "Empty." : "Open this retainer in game once to record their items."}</p>`;
      else if (S.view === "grid") body = `<div class="inv-grid free">${r.items.map((it) => cellHtml(it, it.container || "")).join("")}</div>`;
      else body = listHtml(mergeRetainer(r), `r${r.id}`);
    }
    return `<article class="card inv-ret"><div class="inv-ret-h"><span class="inv-ret-n">${esc(r.name)}</span>`
      + `${r.classJob ? `<span class="inv-ret-j">${esc(r.classJob)}${r.level ? " " + r.level : ""}</span>` : ""}</div>`
      + `<div class="inv-ret-m">${fmtN(r.gil)} gil · ${seenItems}${r.marketItemCount ? ` · ${r.marketItemCount} on market` : ""} · seen ${esc(ago(r.lastSeen))}</div>`
      + ventureHtml(r)
      + `<button type="button" class="inv-ret-t" data-ritems="${esc(r.id)}" aria-expanded="${open}"><span>Items</span>${icon("chevron")}</button>`
      + `${open ? `<div class="inv-ret-items">${body}</div>` : ""}</article>`;
  }

  function mergeRetainer(r) {
    const map = new Map();
    for (const it of r.items) {
      let m = map.get(it.itemId);
      if (!m) { m = { id: it.itemId, total: 0, places: [] , by: new Map() }; map.set(it.itemId, m); }
      const k = it.container || "Inventory";
      let p = m.by.get(k);
      if (!p) { p = { label: k, qty: 0, hq: 0, seen: 0 }; m.by.set(k, p); m.places.push(p); }
      p.qty += it.qty; if (it.hq) p.hq += it.qty; m.total += it.qty;
    }
    return [...map.values()].sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)));
  }

  // ---- rendering: sections --------------------------------------------------------------------------------------------------

  function sectionMeta(g) {
    const d = S.data;
    const cs = groupContainers(g);
    const count = cs.reduce((n, c) => n + c.items.length, 0);
    switch (g) {
      case "bags": return `${d.bags.free}/${d.bags.total} free`;
      case "saddlebag": return d.saddlebag ? `${d.saddlebag.free}/${d.saddlebag.total} free${d.saddlebag.loaded ? "" : " · cached " + ago(d.saddlebag.cachedAt)}` : "not cached";
      case "retainers": return `${(d.retainers || []).length} retainer${(d.retainers || []).length === 1 ? "" : "s"}`;
      default: return `${count} item${count === 1 ? "" : "s"}`;
    }
  }

  function sectionBody(g) {
    const d = S.data;
    const grid = S.view === "grid";
    if (g === "retainers") {
      const rs = d.retainers || [];
      if (!rs.length) return `<p class="inv-note">No retainers cached yet. Open the summoning bell, then each retainer once, to record their items and ventures.</p>`;
      return `<div class="inv-rets">${rs.map(retainerHtml).join("")}</div>`;
    }
    const cs = groupContainers(g);
    if (g === "saddlebag" && !cs.length) return `<p class="inv-note">No saddlebag cached yet. Open your saddlebag in game once and it will show up here.</p>`;
    if (!cs.length) return `<p class="inv-note">Nothing here.</p>`;
    if (!grid) return listHtml(mergedForGroup(g), g);

    if (g === "armoury") {
      const full = cs.filter((c) => c.items.length), empty = cs.filter((c) => !c.items.length);
      return `<div class="inv-pages">${full.map((c) => pageHtml(c)).join("")}</div>`
        + (empty.length ? `<p class="inv-note">Empty: ${esc(empty.map((c) => c.label).join(", "))}</p>` : "");
    }
    if (g === "crystals" || g === "currency") {
      const full = cs.filter((c) => c.items.length);
      return full.length ? `<div class="inv-pages">${full.map((c) => pageHtml(c, { empties: false })).join("")}</div>` : `<p class="inv-note">Nothing here.</p>`;
    }
    return `<div class="inv-pages">${cs.map((c) => pageHtml(c, {
    slotLabels: g === "equipped" ? EQUIP_SLOTS : null,
    note: c.loaded === false ? `${c.free} free · cached ${ago(c.cachedAt)}` : "",
  })).join("")}</div>`;
  }

  function sectionHtml(g, solo) {
    const open = solo || (S.sec.has(g) ? S.sec.get(g) : g !== "armoury");
    return `<section class="inv-sec${solo ? " solo" : ""}"><button type="button" class="inv-sec-h" data-sec="${g}" aria-expanded="${open}">`
      + `<b>${SECTION_TITLE[g]}</b><small>${esc(sectionMeta(g))}</small>${icon("chevron")}</button>${open ? sectionBody(g) : ""}</section>`;
  }

  function browseHtml() {
    const solo = S.group !== "all";
    const groups = solo ? [S.group] : SECTION_ORDER.filter((g) => g === "bags" || g === "retainers" ? true : groupContainers(g).length);
    return groups.map((g) => sectionHtml(g, solo)).join("");
  }

  // ---- rendering: search ----------------------------------------------------------------------------------------------------

  function searchHtml(q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    const results = [];
    for (const e of S.items.values()) {
      if (!tokens.every((t) => e.lower.includes(t))) continue;
      const places = [];
      let total = 0;
      for (const p of e.places.values()) if (S.group === "all" || p.group === S.group) { places.push(p); total += p.qty; }
      if (!places.length) continue;
      const name = nameOf(e.id).toLowerCase();
      const rank = name.startsWith(tokens[0]) ? 0 : name.includes(" " + tokens[0]) ? 1 : 2;
      places.sort((a, b) => a.order - b.order);
      results.push({ id: e.id, total, places, rank, name });
    }
    results.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    if (!results.length) return `<p class="inv-note">Nothing matches "${esc(q)}"${S.group === "all" ? "" : " in " + esc(GROUPS.find((x) => x.id === S.group).label)}.</p>`;
    const shown = results.slice(0, MAX_RESULTS);
    return `<div class="inv-count">${results.length} item${results.length === 1 ? "" : "s"}${results.length > shown.length ? ` (showing ${shown.length})` : ""}</div>`
      + shown.map((r) => {
        const inf = infoOf(r.id);
        return `<button type="button" class="inv-sr" data-id="${r.id}">${imgTag(r.id)}<span class="inv-txt"><span class="inv-nm">${esc(nameOf(r.id))}</span>`
          + `<span class="inv-sub wrap">${esc(locText(r.places))}</span></span><span class="inv-cnt">×${fmtN(r.total)}</span></button>`;
      }).join("");
  }

  // ---- rendering: top level ------------------------------------------------------------------------------------------------

  function renderSummary() {
    const d = S.data;
    if (!d || !d.loggedIn) { S.sum.innerHTML = ""; return; }
    const bagCls = d.bags.free === 0 ? " full" : d.bags.free <= 10 ? " warn" : "";
    const sb = d.saddlebag;
    S.sum.innerHTML =
      `<div class="inv-tile"><div class="k">Gil</div><div class="v">${fmtN(d.gil)}</div><div class="s">${d.retainerGil ? "+" + fmtN(d.retainerGil) + " retainers" : "&nbsp;"}</div></div>`
      + `<div class="inv-tile${bagCls}"><div class="k">Bags</div><div class="v">${d.bags.free}/${d.bags.total}</div><div class="s">free \u00b7 ${d.bags.total - d.bags.free} used</div></div>`
      + `<div class="inv-tile"><div class="k">Saddlebag</div><div class="v">${sb ? `${sb.free}/${sb.total}` : "-"}</div><div class="s">${sb ? (sb.loaded ? "free \u00b7 live" : "cached " + esc(ago(sb.cachedAt))) : "not cached"}</div></div>`;
    S.sum.append(S.est.el); // lazy value estimate (Universalis); the tile keeps its state across re-renders
  }

  /** Tradable items for the value estimate: owned totals (bags, armoury, saddlebag, retainers...), minus what is equipped. */
  function estimateStacks() {
    const out = [];
    for (const e of S.items.values()) {
      if (infoOf(e.id)?.untradable) continue;
      let qty = 0, hq = 0;
      for (const p of e.places.values()) if (p.group !== "equipped") { qty += p.qty; hq += p.hq; }
      if (qty > 0) out.push({ id: e.id, qty, hq });
    }
    return out;
  }

  function statusHtml() {
    if (S.error && !S.data) return `<div class="empty">${icon("inventory", "big")}<div>Couldn't load the inventory (${esc(S.error)}).<br>Retrying... the plugin may need updating.</div></div>`;
    if (!S.data) return `<div class="empty">${icon("inventory", "big")}<div>${S.noFeed ? "Waiting for the inventory feed..." : "Loading inventory..."}</div></div>`;
    if (!S.data.loggedIn) return `<div class="empty">${icon("inventory", "big")}<div>Not logged in to a character.</div></div>`;
    return "";
  }

  function renderBody() {
    if (!S) return;
    const status = statusHtml();
    if (status) { S.body.innerHTML = status; return; }
    const q = S.query.trim().toLowerCase();
    S.body.innerHTML = q ? searchHtml(q) : browseHtml();
    tickEta();
  }

  function renderChrome() {
    S.chips.querySelectorAll("[data-grp]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.grp === S.group)));
    S.seg.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === S.view)));
    S.clear.hidden = !S.query;
  }

  // ---- venture countdown -----------------------------------------------------------------------------------------------------

  function tickEta() {
    if (!S) return;
    for (const el of S.root.querySelectorAll(".eta")) {
      const st = etaState({ completeAt: Number(el.dataset.at) });
      if (el.textContent !== st.text) el.textContent = st.text;
      el.parentElement.classList.toggle("done", st.done);
    }
  }

  // ---- data fetching ---------------------------------------------------------------------------------------------------------

  async function fetchInventory() {
    if (S.fetching) return;
    S.fetching = true;
    try {
      const r = await fetch(S.ctx.withToken("/api/inventory"), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      S.error = "";
      S.version = d.version;
      ingest(d);
      renderSummary();
      renderBody();
      if (S.sheetId != null && S.sheet.open) fillSheet(S.sheetId);
    } catch (e) {
      S.error = e.message || String(e);
      S.retryAt = Date.now() + 5000;
      if (!S.data) renderBody();
    } finally {
      S.fetching = false;
      S.retryAt = Math.max(S.retryAt, Date.now() + 1000); // never faster than 1 Hz, even if the version keeps moving
    }
  }

  // ---- item sheet ------------------------------------------------------------------------------------------------------------

  function ensureSheet() {
    if (S.sheet) return S.sheet;
    const dlg = document.createElement("dialog");
    dlg.className = "inv-sheet";
    dlg.setAttribute("aria-label", "Item details");
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
      else if (e.target.closest(".sh-x")) dlg.close();
      else if (e.target.closest(".sh-track")) trackItem();
    });
    dlg.addEventListener("close", () => { S.sheetId = null; });
    document.body.append(dlg);
    S.sheet = dlg;
    return dlg;
  }

  function openSheet(id) {
    const dlg = ensureSheet();
    S.sheetId = id;
    S.sheetMsg = "";
    S.sheetBusy = false;
    fillSheet(id);
    if (!dlg.open) dlg.showModal();
  }

  function stackLine(p) {
    // Gear stacks one-per-slot, so show wear / spiritbond per piece.
    const extra = [];
    for (const s of p.stacks) {
      if (s.condition != null) extra.push(`${s.condition}% condition`);
      if (s.spiritbond != null) extra.push(`${s.spiritbond}% spiritbond`);
      if (s.collectability != null) extra.push(`collectability ${s.collectability}`);
    }
    return extra.length && p.stacks.length <= 2 ? extra.join(" · ") : "";
  }

  function trackedNow(id) {
    return S.tracked.has(id) || S.justTracked.has(id);
  }

  function fillSheet(id) {
    const e = S.items.get(id);
    const inf = infoOf(id);
    const places = e ? [...e.places.values()].sort((a, b) => a.order - b.order) : [];
    const total = e ? e.total : 0;
    const sub = [inf?.gear && inf.ilvl > 1 ? `Item Level ${inf.ilvl}` : "", inf?.category || ""].filter(Boolean).join(" · ");
    const rows = places.map((p) => {
      const hq = p.hq ? ` <span class="inv-hqtag">${p.hq === p.qty ? "HQ" : "HQ ×" + fmtN(p.hq)}</span>` : "";
      const ex = stackLine(p);
      const seen = p.seen ? `seen ${ago(p.seen)}` : "";
      const small = [ex, seen].filter(Boolean).join(" · ");
      return `<li><span>${esc(p.label)}${hq}${small ? `<small>${esc(small)}</small>` : ""}</span><b>×${fmtN(p.qty)}</b></li>`;
    }).join("");
    const color = RARITY_COLOR[inf?.rarity];
    S.sheet.innerHTML = `<div class="sh"><div class="sh-head">${imgTag(id)}<div class="sh-t"><div class="sh-name"${color ? ` style="color:${color}"` : ""}>${esc(nameOf(id))}</div>`
      + `<div class="sh-sub">${esc(sub || `Item #${id}`)}</div></div><button type="button" class="sh-x" aria-label="Close">×</button></div>`
      + `<div class="sh-tot">Total owned: <b>${fmtN(total)}</b>${inf?.stackSize > 1 ? ` <small>(stacks to ${fmtN(inf.stackSize)})</small>` : ""}${inf?.untradable ? ` <small>· untradable</small>` : ""}</div>`
      + `<ul class="sh-locs">${rows || `<li><span>Not in your inventory right now</span></li>`}</ul>`
      + `<div class="sh-act"><button type="button" class="btn primary sh-track"></button><span class="sh-msg" role="status"></span></div><div class="sh-mkt"></div></div>`;
    syncSheetButton();
    market.mountMarketSection(S.sheet.querySelector(".sh-mkt"), id, { untradable: !!inf?.untradable });
  }

  function syncSheetButton() {
    if (!S.sheet || S.sheetId == null) return;
    const btn = S.sheet.querySelector(".sh-track");
    const msg = S.sheet.querySelector(".sh-msg");
    if (!btn) return;
    const tracked = trackedNow(S.sheetId);
    btn.disabled = tracked || S.sheetBusy;
    btn.textContent = S.sheetBusy ? "Adding..." : tracked ? "Already tracked" : "Track this";
    msg.className = `sh-msg${S.sheetMsgCls ? " " + S.sheetMsgCls : ""}`;
    msg.textContent = S.sheetMsg || (tracked ? "Shown in the Tracker." : "");
  }

  async function trackItem() {
    const id = S.sheetId;
    if (id == null || S.sheetBusy || trackedNow(id)) return;
    S.sheetBusy = true; S.sheetMsg = ""; S.sheetMsgCls = "";
    syncSheetButton();
    try {
      const r = await fetch(S.ctx.withToken("/api/trackers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "item", targetId: id }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 80) || `HTTP ${r.status}`);
      S.justTracked.add(id);
      S.sheetMsg = "Added to Tracker!"; S.sheetMsgCls = "ok";
    } catch (e) {
      S.sheetMsg = `Couldn't add: ${e.message || e}`; S.sheetMsgCls = "err";
    } finally {
      S.sheetBusy = false;
      if (S.sheetId === id) syncSheetButton();
    }
  }

  // ---- widget contract ---------------------------------------------------------------------------------------------------------

  function mount(el, ctx) {
    if (!document.getElementById("inv-style")) {
      const st = document.createElement("style");
      st.id = "inv-style";
      st.textContent = CSS;
      document.head.append(st);
    }
    el.innerHTML = `
    <div class="inv">
      <div class="inv-sticky">
        <div class="inv-top">
          <div class="inv-search"><input type="search" placeholder="Where is...? Search everything" aria-label="Search inventory" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button" class="inv-clear" aria-label="Clear search" hidden>×</button></div>
          <div class="inv-seg" role="group" aria-label="View"><button type="button" data-view="grid">Grid</button><button type="button" data-view="list">List</button></div>
        </div>
        <div class="inv-chips" role="group" aria-label="Filter">${GROUPS.map((g) => `<button type="button" class="inv-chip" data-grp="${g.id}">${g.label}</button>`).join("")}</div>
      </div>
      <div class="inv-sum"></div>
      <div class="inv-body"></div>
    </div>`;
    const root = el.querySelector(".inv");
    S = {
      ctx, el, root,
      input: root.querySelector("input"), clear: root.querySelector(".inv-clear"),
      seg: root.querySelector(".inv-seg"), chips: root.querySelector(".inv-chips"),
      sum: root.querySelector(".inv-sum"), body: root.querySelector(".inv-body"),
      view: store.get("ss.inv.view", "grid") === "list" ? "list" : "grid",
      group: GROUPS.some((g) => g.id === store.get("ss.inv.group", "all")) ? store.get("ss.inv.group", "all") : "all",
      query: "", data: null, info: {}, items: new Map(), containers: new Map(),
      version: null, fetching: false, retryAt: 0, error: "", noFeed: false, skew: 0,
      sec: new Map(), open: new Set(), rOpen: new Set(),
      tracked: new Set(), justTracked: new Set(), trackedRef: null,
      sheet: null, sheetId: null, sheetMsg: "", sheetMsgCls: "", sheetBusy: false,
      timer: 0, searchTimer: 0, est: null,
    };
    S.est = market.createEstimate({
      stacks: estimateStacks,
      describe: (id) => ({ name: nameOf(id), icon: infoOf(id)?.iconId ? S.ctx.withToken(`/api/icon/${infoOf(id).iconId}.png`) : "" }),
      onOpen: (id) => openSheet(id),
    });

    root.addEventListener("click", onClick);
    S.input.addEventListener("input", () => {
      clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(() => { S.query = S.input.value; renderChrome(); renderBody(); }, 140);
      S.clear.hidden = !S.input.value;
    });
    S.input.addEventListener("keydown", (e) => { if (e.key === "Enter") S.input.blur(); });
    S.timer = setInterval(() => { if (!document.hidden) tickEta(); }, 1000);
    renderChrome();
    renderBody();
  }

  function onClick(e) {
    const t = e.target.closest("[data-id],[data-sec],[data-grp],[data-view],[data-exp],[data-ritems],.inv-clear");
    if (!t) return;
    if (t.classList.contains("inv-clear")) {
      S.input.value = ""; S.query = ""; renderChrome(); renderBody(); S.input.focus();
    } else if (t.dataset.id) {
      openSheet(Number(t.dataset.id));
    } else if (t.dataset.grp) {
      S.group = t.dataset.grp; store.set("ss.inv.group", S.group); renderChrome(); renderBody();
    } else if (t.dataset.view) {
      S.view = t.dataset.view; store.set("ss.inv.view", S.view); renderChrome(); renderBody();
    } else if (t.dataset.sec) {
      if (S.group !== "all") return; // a single selected section is always open
      const g = t.dataset.sec;
      const cur = S.sec.has(g) ? S.sec.get(g) : g !== "armoury";
      S.sec.set(g, !cur);
      renderBody();
    } else if (t.dataset.exp) {
      const key = t.dataset.exp;
      const row = t.closest(".inv-row");
      const open = !S.open.has(key);
      if (open) S.open.add(key); else S.open.delete(key);
      row.classList.toggle("open", open);
      t.setAttribute("aria-expanded", String(open));
    } else if (t.dataset.ritems) {
      const id = t.dataset.ritems;
      if (S.rOpen.has(id)) S.rOpen.delete(id); else S.rOpen.add(id);
      renderBody();
    }
  }

  function update(payload) {
    if (!S) return;
    const ts = payload.snapshot && payload.snapshot.timestamp;
    market.setPlayer(payload.snapshot && payload.snapshot.player);
    if (ts) S.skew = ts - Date.now(); // venture times are game-PC epoch seconds; align with that clock, not the phone's

    // Trackers: remember which items are already tracked (for the "Track this" button).
    const trackers = payload.trackers;
    if (trackers !== S.trackedRef) {
      S.trackedRef = trackers;
      const next = new Set();
      for (const t of trackers || []) if (t.kind === "item") next.add(t.targetId);
      const same = next.size === S.tracked.size && [...next].every((x) => S.tracked.has(x));
      if (!same) { S.tracked = next; for (const x of next) S.justTracked.delete(x); syncSheetButton(); }
    }

    const v = payload.inventoryVersion;
    if (v === undefined) {
      if (!S.data && !S.noFeed) { S.noFeed = true; fetchInventory(); } // older plugin build: try the endpoint once
      return;
    }
    if (v !== S.version && !S.fetching && Date.now() >= S.retryAt) fetchInventory();
  }

  function unmount() {
    if (!S) return;
    clearInterval(S.timer);
    clearTimeout(S.searchTimer);
    S.sheet?.remove();
    S.est?.destroy();
    S = null;
  }

  return { mount, update, unmount };
}
