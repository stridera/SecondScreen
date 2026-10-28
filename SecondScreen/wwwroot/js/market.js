// Universalis market board prices, fetched by the browser straight from universalis.app (it answers with
// `access-control-allow-origin: *`, so no plugin proxy is needed).
//
// Used by: the Inventory item sheet ("Market" section), the Inventory "Est. value" tile and Tracker item cards.
//
//   getPrices(ids, scope?)  -> Promise<Map(id -> {min,minNQ,minHQ,listings,upload} | null | {error})>
//                              null = not on the market board (untradable / unknown); {error} = network or HTTP failure.
//                              Calls made within ~50 ms are merged into one request (max 100 ids), identical in-flight
//                              requests are shared, results are cached 5 min in memory + sessionStorage. Never rejects.
//   getMarket(id, scope?)   -> same, but the detailed record (cheapest NQ/HQ listing with world, recent sales, velocity...).
//
// Scope = which Universalis "world" to ask about: the home world, the home data center (default) or the home region.
// The player's home world / DC / region come from the snapshot (setPlayer); the choice is persisted per device.

import { esc } from "./util.js";

const API = "https://universalis.app/api/v2";
const TTL = 5 * 60 * 1000;
const ERR_TTL = 20 * 1000;
const BATCH_MS = 50;
const MAX_IDS = 100;
const DETAIL_CHUNK = 20;
const MAX_INFLIGHT = 2;
const TIMEOUT_MS = 15000;
const LISTINGS = 30;
const SALES = 5;
const SS_KEY = "ss.market.cache.v1";
const SS_MAX = 400;
const SCOPE_KEY = "ss.market.scope";
const REGIONS = new Set(["Japan", "North America", "Europe", "Oceania"]); // the regions Universalis knows about

const LIGHT = ["itemID", "minPrice", "minPriceNQ", "minPriceHQ", "listingsCount", "lastUploadTime"];
const DETAIL = [...LIGHT, "averagePrice", "regularSaleVelocity", "unitsForSale", "worldName",
  "listings.pricePerUnit", "listings.quantity", "listings.hq", "listings.worldName",
  "recentHistory.pricePerUnit", "recentHistory.quantity", "recentHistory.hq", "recentHistory.timestamp", "recentHistory.worldName"];

// ---- scope -----------------------------------------------------------------------------------------------------------------

const SCOPE_IDS = ["world", "dc", "region"];
let player = null; // {world, dataCenter, region}
let scopeId = (() => { try { const s = localStorage.getItem(SCOPE_KEY); return SCOPE_IDS.includes(s) ? s : "dc"; } catch { return "dc"; } })();
const listeners = new Set();

function resolve(id) {
  if (!player) return null;
  if (id === "world" && player.world) return { id, name: player.world, label: player.world, tag: player.world };
  if (id === "dc" && player.dataCenter) return { id, name: player.dataCenter, label: player.dataCenter, tag: "DC" };
  if (id === "region" && REGIONS.has(player.region)) return { id, name: player.region.replace(/ /g, "-"), label: player.region, tag: player.region };
  return null;
}

/** Scopes the toggle offers, in world / DC / region order (empty until the snapshot carries the home world). */
export function scopes() { return SCOPE_IDS.map(resolve).filter(Boolean); }

/** The active scope {id, name (Universalis path segment), label, tag}; falls back to the DC; null when unknown. */
export function getScope() { return resolve(scopeId) || resolve("dc") || resolve("world"); }

export function setScope(id) {
  if (!SCOPE_IDS.includes(id) || id === scopeId) return;
  scopeId = id;
  try { localStorage.setItem(SCOPE_KEY, id); } catch { /* private mode */ }
  emit();
}

/** Feed the snapshot's player (world = HOME world, dataCenter, region). Cheap; call on every push. */
export function setPlayer(p) {
  const next = p && p.world ? { world: p.world, dataCenter: p.dataCenter || "", region: p.region || "" } : null;
  const same = (!player && !next) || (player && next && player.world === next.world && player.dataCenter === next.dataCenter && player.region === next.region);
  if (same) return;
  player = next;
  emit();
}

/** Subscribe to scope / player changes. Returns the unsubscribe function. */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error("[market]", e); } } }

function asScope(s) {
  if (s && typeof s === "object" && s.name) return s;
  return (typeof s === "string" ? resolve(s) : null) || getScope();
}

// ---- cache -----------------------------------------------------------------------------------------------------------------

const cache = new Map(); // key -> {t, v}   v = value | null | {error}
const inflight = new Map(); // key -> Promise
const key = (kind, scope, id) => `${kind}|${scope}|${id}`;
const fresh = (e) => !!e && Date.now() - e.t < (e.v && e.v.error ? ERR_TTL : TTL);

try {
  const raw = JSON.parse(sessionStorage.getItem(SS_KEY) || "null");
  if (raw && raw.v === 1) for (const [k, t, v] of raw.e) if (Date.now() - t < TTL) cache.set(k, { t, v });
} catch { /* no sessionStorage / corrupt */ }

let persistTimer = 0;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    try {
      const rows = [];
      for (const [k, e] of cache) if (fresh(e) && !(e.v && e.v.error)) rows.push([k, e.t, e.v]);
      rows.sort((a, b) => b[1] - a[1]);
      sessionStorage.setItem(SS_KEY, JSON.stringify({ v: 1, e: rows.slice(0, SS_MAX) }));
    } catch { /* quota / private mode: the memory cache still works */ }
  }, 400);
}

// ---- batching + fetching -------------------------------------------------------------------------------------------------

let queue = [];
let timer = 0;
const jobs = [];
let running = 0;

function request(kind, scope, id) {
  const k = key(kind, scope.name, id);
  const hit = cache.get(k);
  if (fresh(hit)) return Promise.resolve(hit.v);
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = new Promise((res) => queue.push({ k, kind, scope: scope.name, id, res }));
  inflight.set(k, p);
  if (!timer) timer = setTimeout(flush, BATCH_MS);
  return p;
}

function flush() {
  timer = 0;
  const groups = new Map();
  for (const q of queue) {
    const g = `${q.kind}|${q.scope}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(q);
  }
  queue = [];
  for (const items of groups.values()) {
    const size = items[0].kind === "d" ? DETAIL_CHUNK : MAX_IDS;
    for (let i = 0; i < items.length; i += size) jobs.push(items.slice(i, i + size));
  }
  pump();
}

function pump() {
  while (running < MAX_INFLIGHT && jobs.length) {
    const job = jobs.shift();
    running++;
    runJob(job).finally(() => { running--; pump(); });
  }
}

async function runJob(job) {
  const { kind, scope } = job[0];
  let results = null, err = "";
  try {
    results = await fetchChunk(kind, scope, job.map((q) => q.id));
  } catch (e) {
    err = e && e.name === "AbortError" ? "timed out" : (e && e.message) || "network error";
  }
  const now = Date.now();
  for (const q of job) {
    const v = results ? (results.get(q.id) ?? null) : { error: err };
    cache.set(q.k, { t: now, v });
    inflight.delete(q.k);
    q.res(v);
  }
  persist();
}

async function fetchChunk(kind, scope, ids) {
  const multi = ids.length > 1; // a single id answers with the bare item instead of {items: {...}}
  const fields = (kind === "d" ? DETAIL : LIGHT).map((f) => (multi ? "items." + f : f)).join(",") + (multi ? ",unresolvedItems" : "");
  const url = `${API}/${encodeURIComponent(scope)}/${ids.join(",")}?listings=${kind === "d" ? LISTINGS : 0}&entries=${kind === "d" ? SALES : 0}&fields=${fields}`;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    const out = new Map();
    if (r.status === 404 && !multi) { out.set(ids[0], null); return out; } // unknown / untradable item
    if (r.status === 429) throw new Error("rate limited, try again shortly");
    if (!r.ok) throw new Error(`Universalis HTTP ${r.status}`);
    const j = await r.json();
    const items = multi ? j.items || {} : { [ids[0]]: j };
    for (const id of ids) out.set(id, items[id] ? (kind === "d" ? normDetail(items[id]) : normLight(items[id])) : null);
    return out;
  } finally {
    clearTimeout(to);
  }
}

function minPos(a, b) { return a && b ? Math.min(a, b) : a || b || 0; }

function normLight(o) {
  const nq = o.minPriceNQ || 0, hq = o.minPriceHQ || 0;
  return { min: o.minPrice || minPos(nq, hq), minNQ: nq, minHQ: hq, listings: o.listingsCount || 0, upload: o.lastUploadTime || 0 };
}

function normDetail(o) {
  const base = normLight(o);
  const ls = o.listings || [];
  const low = (hq) => {
    const l = ls.find((x) => !!x.hq === hq); // listings arrive cheapest first
    return l ? { price: l.pricePerUnit, qty: l.quantity, world: l.worldName || o.worldName || "" } : null;
  };
  return {
    ...base,
    avg: o.averagePrice || 0,
    velocity: o.regularSaleVelocity || 0,
    units: o.unitsForSale || 0,
    lowNQ: low(false),
    lowHQ: low(true),
    sales: (o.recentHistory || []).slice(0, SALES).map((s) => ({
      price: s.pricePerUnit, qty: s.quantity, hq: !!s.hq, world: s.worldName || o.worldName || "", ts: (s.timestamp || 0) * 1000,
    })),
  };
}

// ---- public data API -------------------------------------------------------------------------------------------------------

export async function getPrices(itemIds, scope) {
  const sc = asScope(scope);
  const ids = [...new Set((itemIds || []).map(Number).filter((n) => n > 0))];
  const out = new Map();
  if (!sc) { for (const id of ids) out.set(id, { error: "data center unknown (update the SecondScreen plugin)" }); return out; }
  const vals = await Promise.all(ids.map((id) => request("p", sc, id)));
  ids.forEach((id, i) => out.set(id, vals[i]));
  return out;
}

export function getMarket(itemId, scope) {
  const sc = asScope(scope);
  if (!sc) return Promise.resolve({ error: "data center unknown (update the SecondScreen plugin)" });
  return request("d", sc, Number(itemId));
}

/** Synchronous cache reads. `undefined` = nothing cached (or expired, unless `stale`). */
export function peekPrice(id, scope, stale = false) { return peek("p", id, scope, stale); }
export function peekMarket(id, scope, stale = false) { return peek("d", id, scope, stale); }
function peek(kind, id, scope, stale) {
  const sc = asScope(scope);
  const e = sc && cache.get(key(kind, sc.name, id));
  return e && (stale || fresh(e)) ? e.v : undefined;
}

// ---- formatting ----------------------------------------------------------------------------------------------------------

const n0 = (n) => Math.round(n).toLocaleString("en-US");
const gil = (n) => `${n0(n)}g`;
function gilShort(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n0(n);
}
function agoMs(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const perDay = (v) => (v >= 100 ? n0(v) : v >= 10 ? v.toFixed(1) : String(Math.round(v * 100) / 100));

// ---- styles ----------------------------------------------------------------------------------------------------------------

const CSS = `
.mkt { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.mkt-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.mkt-h b { font-size: .74rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
.mkt-seg { display: flex; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-width: 100%; }
.mkt-seg button { min-height: 0; height: 36px; padding: 0 11px; border: 0; border-radius: 0; background: var(--panel2); color: var(--muted);
  font: inherit; font-size: .8rem; font-weight: 600; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; touch-action: manipulation; }
.mkt-seg button + button { border-left: 1px solid var(--border); }
.mkt-seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
@media (pointer: coarse) { .mkt-seg button { height: 42px; } }
.mkt-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.mkt-k { padding: 7px 10px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); min-width: 0; }
.mkt-k span { display: block; font-size: .66rem; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.mkt-k b { display: block; font-size: 1.02rem; font-weight: 650; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mkt-k small { display: block; font-size: .74rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 1.1em; }
.mkt-sub { margin: 12px 0 4px; font-size: .74rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
.mkt-sales { list-style: none; margin: 0; padding: 0; }
.mkt-sales li { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: .88rem; }
.mkt-sales .l { min-width: 0; overflow-wrap: anywhere; }
.mkt-sales b { font-variant-numeric: tabular-nums; }
.mkt-sales em { font-style: normal; color: var(--muted); font-size: .78rem; }
.mkt-sales time { flex: none; color: var(--muted); font-size: .78rem; white-space: nowrap; }
.mkt-hq { font-style: normal; color: #e0a93d; font-weight: 700; font-size: .7rem; }
.mkt-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 8px; font-size: .78rem; color: var(--muted); }
.mkt-foot a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 4px; color: var(--accent); text-decoration: none; font-weight: 600; font-size: .88rem; }
.mkt-note { color: var(--muted); font-size: .9rem; padding: 4px 0 2px; }
.mkt-note.err { color: var(--hp-low); }
.mkt-btn { min-height: 36px; margin-left: 8px; padding: 0 12px; border-radius: 9px; border: 1px solid var(--border); background: var(--panel2); color: var(--text); font: inherit; font-size: .82rem; cursor: pointer; touch-action: manipulation; }
.mkt-sk { height: 50px; border-radius: 10px; background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: mkt-sh 1.2s linear infinite; }
.mkt-sk.s { height: 26px; grid-column: 1 / -1; }
@keyframes mkt-sh { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .mkt-sk { animation: none; } }
.mkt-line { color: var(--muted); font-size: .76rem; }

.mkt-est .s { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mkt-est .mkt-btn { margin: 4px 6px 0 0; min-height: 34px; padding: 0 12px; }
.mkt-est .mkt-btn.primary { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent); font-weight: 650; }
.mkt-est.err .v { color: var(--hp-low); }
dialog.mkt-dlg { width: min(460px, 94vw); max-height: 86vh; max-height: 86dvh; padding: 0; overflow: auto; -webkit-overflow-scrolling: touch; }
.mkt-dlg .md { padding: 14px; }
.mkt-dlg .md-h { display: flex; align-items: center; gap: 12px; }
.mkt-dlg .md-h > div { flex: 1 1 auto; min-width: 0; }
.mkt-dlg .md-t { font-size: 1.05rem; font-weight: 650; }
.mkt-dlg .md-s { color: var(--muted); font-size: .84rem; }
.mkt-dlg .md-x { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 10px; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); font-size: 1.3rem; }
.mkt-top { list-style: none; margin: 4px 0 0; padding: 0; }
.mkt-top button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px; padding: 5px 4px; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: none; color: var(--text); text-align: left; font: inherit; font-weight: 400; cursor: pointer; }
.mkt-top button:active { background: var(--surface-2); }
.mkt-top img, .mkt-top .ph { width: 36px; height: 36px; flex: none; border-radius: 7px; background: var(--surface-2); object-fit: contain; }
.mkt-top .t { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.mkt-top .t span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.mkt-top .t small { color: var(--muted); font-size: .76rem; }
.mkt-top b { flex: none; font-variant-numeric: tabular-nums; }
@media (max-width: 600px) { dialog.mkt-dlg { margin: auto auto 0; width: 100vw; max-width: 100vw; border-radius: 18px 18px 0 0; padding-bottom: env(safe-area-inset-bottom); } }
`;

function ensureStyle() {
  if (document.getElementById("mkt-style")) return;
  const st = document.createElement("style");
  st.id = "mkt-style";
  st.textContent = CSS;
  document.head.append(st);
}

// ---- Tracker price line --------------------------------------------------------------------------------------------------

/** "≈ 1,234g ea · DC min" from the cache ("" when nothing is cached or the item is not sold). Stale data keeps showing. */
export function priceLineHtml(id) {
  const sc = getScope();
  const p = sc && peekPrice(id, sc, true);
  if (!p || p.error) return "";
  ensureStyle();
  const tip = `Lowest current listing on ${sc.label}${p.upload ? ", data uploaded " + agoMs(p.upload) : ""}`;
  if (!p.min) return `<span class="mkt-line" title="${esc(tip)}">No listings · ${esc(sc.tag)}</span>`;
  return `<span class="mkt-line" title="${esc(tip)}">≈ ${gil(p.min)} ea · ${esc(sc.tag)} min</span>`;
}

/** Fetch prices for ids we have nothing fresh for; `onUpdate` fires once they arrive (so the caller can repaint). */
export function warm(ids, onUpdate) {
  const sc = getScope();
  if (!sc) return;
  const need = ids.filter((id) => { const k = key("p", sc.name, id); return !fresh(cache.get(k)) && !inflight.has(k); });
  if (need.length) getPrices(need, sc).then(() => onUpdate && onUpdate());
}

// ---- item sheet "Market" section -----------------------------------------------------------------------------------------

function segHtml(active) {
  const list = scopes();
  if (list.length < 2) return "";
  return `<div class="mkt-seg" role="group" aria-label="Price scope">${list.map((s) =>
    `<button type="button" data-mscope="${s.id}" aria-pressed="${s.id === active}" title="${esc(s.label)}">${esc(s.label)}</button>`).join("")}</div>`;
}

function sectionBody(id, m, sc) {
  if (m === undefined) {
    return `<div class="mkt-grid" aria-busy="true" aria-label="Loading prices">${`<div class="mkt-sk"></div>`.repeat(4)}<div class="mkt-sk s"></div></div>`;
  }
  if (m && m.error) return `<div class="mkt-note err">Couldn't load prices (${esc(m.error)}).<button type="button" class="mkt-btn" data-mretry>Retry</button></div>`;
  if (m === null) return `<div class="mkt-note">Not sold on the market board.</div>`;
  const link = `<a href="https://universalis.app/market/${id}" target="_blank" rel="noopener noreferrer">View on Universalis ↗</a>`;
  if (!m.listings && !m.sales.length) {
    return `<div class="mkt-note">No listings or sales on ${esc(sc.label)}.</div><div class="mkt-foot"><span></span>${link}</div>`;
  }
  const low = (l, fallback) => l
    ? [gil(l.price), [l.world, l.qty > 1 ? `×${n0(l.qty)}` : ""].filter(Boolean).join(" · ")]
    : fallback ? [gil(fallback), ""] : ["-", "none listed"];
  const [nq, nqw] = low(m.lowNQ, m.minNQ), [hq, hqw] = low(m.lowHQ, m.minHQ);
  const sales = m.sales.map((s) => `<li><span class="l"><b>${gil(s.price)}</b> <em>×${n0(s.qty)}</em>${s.hq ? ` <i class="mkt-hq">HQ</i>` : ""}`
    + `${s.world ? ` <em>· ${esc(s.world)}</em>` : ""}</span><time>${esc(agoMs(s.ts))}</time></li>`).join("");
  return `<div class="mkt-grid">`
    + `<div class="mkt-k"><span>Lowest NQ</span><b>${nq}</b><small>${esc(nqw)}</small></div>`
    + `<div class="mkt-k"><span>Lowest HQ</span><b>${hq}</b><small>${esc(hqw)}</small></div>`
    + `<div class="mkt-k"><span>Avg sale price</span><b>${m.avg ? gil(m.avg) : "-"}</b><small>recent sales</small></div>`
    + `<div class="mkt-k"><span>Sold per day</span><b>${m.velocity ? perDay(m.velocity) : "0"}</b><small>units</small></div>`
    + `<div class="mkt-k"><span>Listings</span><b>${n0(m.listings)}</b><small>${m.units ? n0(m.units) + " units" : ""}</small></div>`
    + `<div class="mkt-k"><span>Last upload</span><b>${esc(agoMs(m.upload))}</b><small>&nbsp;</small></div>`
    + `</div>`
    + (sales ? `<div class="mkt-sub">Recent sales</div><ul class="mkt-sales">${sales}</ul>` : "")
    + `<div class="mkt-foot"><span>Prices on ${esc(sc.label)}</span>${link}</div>`;
}

/**
 * Renders the Market section into `host` (an empty element the caller owns) and keeps it fresh: instant when cached,
 * a skeleton while loading, re-rendered when the scope toggle changes. Safe to call again with a new host (the old one,
 * once detached from the document, stops listening by itself).
 */
export function mountMarketSection(host, itemId, { untradable = false } = {}) {
  ensureStyle();
  host.classList.add("mkt");
  let seq = 0;

  const draw = () => {
    if (!host.isConnected) { off(); return; }
    if (untradable) {
      host.innerHTML = `<div class="mkt-h"><b>Market</b></div><div class="mkt-note">Untradable</div>`;
      return;
    }
    const sc = getScope();
    if (!sc) {
      host.innerHTML = `<div class="mkt-h"><b>Market</b></div><div class="mkt-note">Waiting for your home world... (the plugin may need updating)</div>`;
      return;
    }
    const cached = peekMarket(itemId, sc);
    host.innerHTML = `<div class="mkt-h"><b>Market</b>${segHtml(sc.id)}</div><div class="mkt-body">${sectionBody(itemId, cached, sc)}</div>`;
    if (cached !== undefined) return;
    const mine = ++seq;
    getMarket(itemId, sc).then((m) => {
      if (mine !== seq || !host.isConnected) return;
      const body = host.querySelector(".mkt-body");
      if (body) body.innerHTML = sectionBody(itemId, m, sc);
    });
  };

  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mscope],[data-mretry]");
    if (!b) return;
    if (b.dataset.mscope) setScope(b.dataset.mscope);
    else { const sc = getScope(); if (sc) cache.delete(key("d", sc.name, itemId)); draw(); }
  });
  const off = onChange(draw);
  draw();
}

// ---- inventory value estimate --------------------------------------------------------------------------------------------

/**
 * "Est. value" tile for the Inventory summary. Lazy: nothing is fetched until the user taps Estimate.
 *   stacks()    -> [{id, qty, hq}]  tradable items only (hq = how many of qty are HQ)
 *   describe(id)-> {name, icon (url or "")}
 *   onOpen(id)  -> open that item (called after the top-10 dialog closes)
 * Returns {el, destroy}: append `el` to the summary row (re-append it after the summary is re-rendered).
 */
export function createEstimate({ stacks, describe, onOpen }) {
  ensureStyle();
  const el = document.createElement("div");
  el.className = "inv-tile mkt-est";
  let st = { phase: "idle" }; // idle | loading {done,total} | done {res} | error {msg}
  let dlg = null;

  const draw = () => {
    el.classList.toggle("err", st.phase === "error");
    if (st.phase === "idle") {
      el.innerHTML = `<div class="k">Est. value</div><div class="v">-</div><div class="s"><button type="button" class="mkt-btn primary" data-est="go">Estimate</button></div>`;
    } else if (st.phase === "loading") {
      el.innerHTML = `<div class="k">Est. value</div><div class="v">...</div><div class="s">Pricing ${st.done}/${st.total} items</div>`;
    } else if (st.phase === "error") {
      el.innerHTML = `<div class="k">Est. value</div><div class="v">Failed</div><div class="s">${esc(st.msg)}<button type="button" class="mkt-btn" data-est="go">Retry</button></div>`;
    } else {
      const r = st.res;
      el.innerHTML = `<div class="k">Est. value</div><div class="v" title="${esc(n0(r.total))} gil">${gilShort(r.total)}</div>`
        + `<div class="s">${esc(r.scope.tag === "DC" ? "DC" : r.scope.tag)} min · ${r.rows.length} item${r.rows.length === 1 ? "" : "s"}`
        + `<button type="button" class="mkt-btn primary" data-est="top">Top 10</button><button type="button" class="mkt-btn" data-est="go">Redo</button></div>`;
    }
  };

  async function run() {
    if (st.phase === "loading") return;
    const sc = getScope();
    if (!sc) { st = { phase: "error", msg: "Home world unknown (update the plugin). " }; draw(); return; }
    const list = stacks();
    if (!list.length) { st = { phase: "error", msg: "No tradable items. " }; draw(); return; }
    const ids = list.map((s) => s.id);
    st = { phase: "loading", done: 0, total: ids.length };
    draw();
    const prices = new Map();
    let failed = 0, firstErr = "";
    for (let i = 0; i < ids.length; i += MAX_IDS) {
      const part = ids.slice(i, i + MAX_IDS);
      const got = await getPrices(part, sc);
      for (const [id, p] of got) { if (p && p.error) { failed++; firstErr ||= p.error; } else prices.set(id, p); }
      st.done = Math.min(ids.length, i + part.length);
      draw();
    }
    if (failed === ids.length) { st = { phase: "error", msg: `${firstErr}. ` }; draw(); return; }
    const rows = [];
    let total = 0;
    for (const s of list) {
      const p = prices.get(s.id);
      if (!p) continue;
      const nqUnit = p.minNQ || p.minHQ, hqUnit = p.minHQ || p.minNQ;
      const value = Math.max(0, s.qty - s.hq) * nqUnit + s.hq * hqUnit;
      if (!value) continue;
      total += value;
      rows.push({ id: s.id, qty: s.qty, value, unit: value / s.qty });
    }
    rows.sort((a, b) => b.value - a.value);
    st = { phase: "done", res: { total, rows, scope: sc, failed, at: Date.now() } };
    draw();
  }

  function openTop() {
    if (st.phase !== "done") return;
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.className = "mkt-dlg";
      dlg.setAttribute("aria-label", "Inventory value");
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest(".md-x")) { dlg.close(); return; }
        const b = e.target.closest("[data-mid]");
        if (b) { const id = Number(b.dataset.mid); dlg.close(); if (onOpen) onOpen(id); }
      });
      document.body.append(dlg);
    }
    const r = st.res;
    const top = r.rows.slice(0, 10).map((row) => {
      const d = describe(row.id) || {};
      return `<li><button type="button" data-mid="${row.id}">${d.icon ? `<img src="${esc(d.icon)}" alt="" loading="lazy" draggable="false">` : `<span class="ph"></span>`}`
        + `<span class="t"><span>${esc(d.name || "Item #" + row.id)}</span><small>×${n0(row.qty)} · ${gil(row.unit)} ea</small></span><b>${gil(row.value)}</b></button></li>`;
    }).join("");
    dlg.innerHTML = `<div class="md"><div class="md-h"><div><div class="md-t">Est. value: ${n0(r.total)}g</div>`
      + `<div class="md-s">${esc(r.scope.label)} lowest listings · ${esc(agoMs(r.at))}${r.failed ? ` · ${r.failed} item${r.failed === 1 ? "" : "s"} failed to load` : ""}</div></div>`
      + `<button type="button" class="md-x" aria-label="Close">×</button></div>`
      + `<div class="mkt-sub">Top ${Math.min(10, r.rows.length)} most valuable</div><ul class="mkt-top">${top}</ul>`
      + `<p class="mkt-note">Uses the cheapest current listing (HQ units at the HQ listing when there is one). Excludes equipped gear and untradable items. Real sale prices are usually lower.</p></div>`;
    if (!dlg.open) dlg.showModal();
  }

  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-est]");
    if (!b) return;
    if (b.dataset.est === "go") run(); else openTop();
  });
  draw();
  return { el, destroy() { dlg?.remove(); } };
}
