// Character widget: name / world / job / average item level, equipped gear (paper-doll style two columns), every job's level with a
// thin EXP bar grouped by role, gil, tomestones against the caps (plus the weekly cap for the limited one) and other currencies.
//
// Data flow: the plugin rebuilds the sheet on the game thread (~1 Hz) and bumps `characterVersion` (a small int in the WebSocket
// payload) only when something changed. We refetch GET /api/character when that number moves and re-render each section only when
// its HTML actually changed, so EXP ticks do not reload the gear icons. Icons are /api/icon/{iconId}.png (job icons are 62100 + id).
// Tapping a gear piece opens a small item sheet (own <dialog>; the inventory widget's sheet is private to that module).
//
// Layout is CSS driven: .wbody[data-size="compact|regular|wide"] picks column counts, so resize() has nothing to do.

import { esc } from "../js/util.js";
import { icon } from "../js/icons.js";

const GIL_ICON = 65002;
const GROUPS = [
  ["tank", "Tanks"], ["healer", "Healers"], ["melee", "Melee DPS"], ["ranged", "Physical Ranged"],
  ["caster", "Magical Ranged"], ["crafter", "Crafters"], ["gatherer", "Gatherers"],
];
const LEFT = ["main", "head", "body", "hands", "legs", "feet"];
const RIGHT = ["off", "ears", "neck", "wrists", "ring1", "ring2"];
const RARITY_COLOR = { 2: "#7fd47f", 3: "#6aa8ff", 4: "#c08cff", 7: "#ff8fc7" };
const GROUP_TITLE = { tomestone: "Tomestones", gc: "Grand Company", seal: "Seals", gold: "Gold Saucer", pvp: "PvP & Bicolor", scrip: "Scrips" };
const CUR_ORDER = ["gc", "seal", "gold", "pvp", "scrip"];

const CSS = `
.chr { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.chr button { font: inherit; color: inherit; touch-action: manipulation; }
.chr img, .chr .ph { -webkit-user-drag: none; }
.chr-h { font-size: .7rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; color: var(--faint); margin: 0 0 6px 2px; }
.chr-cols { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.chr-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.wbody[data-size="wide"] .chr-cols { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(300px, 1fr); gap: 16px; align-items: start; }

.chr-head { display: flex; align-items: center; gap: 12px; padding: 10px 12px; }
.chr-head > img, .chr-head > .ph { width: 48px; height: 48px; flex: none; border-radius: 10px; background: var(--panel2); object-fit: contain; }
.chr-id { flex: 1 1 auto; min-width: 0; }
.chr-nm { font-size: 1.05rem; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chr-sub { color: var(--muted); font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chr-il { flex: none; text-align: right; line-height: 1.05; }
.chr-il b { display: block; font-size: 1.7rem; font-weight: 700; color: var(--accent); }
.chr-il small { color: var(--faint); font-size: .62rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; }
.wbody[data-size="compact"] .chr-head { gap: 9px; padding: 8px 9px; }
.wbody[data-size="compact"] .chr-head > img, .wbody[data-size="compact"] .chr-head > .ph { width: 38px; height: 38px; }
.wbody[data-size="compact"] .chr-nm { font-size: .95rem; }
.wbody[data-size="compact"] .chr-il b { font-size: 1.35rem; }
.wbody[data-size="compact"] .chr-sub { white-space: normal; overflow-wrap: anywhere; }
.wbody[data-size="compact"] .chr-cur.gil .v small { display: none; }
.wbody[data-size="compact"] .chr-cur { column-gap: 7px; padding: 4px 7px; }

.chr-gear { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.chr-gear .soul { grid-column: 1 / -1; }
.chr-slot { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 50px; padding: 5px 8px 5px 5px; border-radius: 10px; border: 1px solid var(--border-strong);
  background: var(--surface-2); text-align: left; cursor: pointer; }
.chr-slot:active { background: var(--surface-3); }
.chr-slot img, .chr-slot .ph { width: 38px; height: 38px; flex: none; border-radius: 8px; background: rgba(0, 0, 0, .25); object-fit: contain; }
.chr-slot .t { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.chr-slot .n { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; font-size: .82rem; font-weight: 550; line-height: 1.2; }
.chr-slot .s { color: var(--muted); font-size: .72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chr-slot .s b { color: var(--text); font-weight: 650; }
.chr-slot .hq { color: #e0a93d; font-weight: 700; font-size: .66rem; }
.chr-slot .low { color: var(--hp-low); font-weight: 700; }
.chr-slot.vacant { border-style: dashed; border-color: var(--border); background: transparent; cursor: default; }
.chr-slot.vacant .n { color: var(--faint); }
.chr-slot.vacant .ph { background: transparent; border: 1px dashed var(--border); }
.wbody[data-size="compact"] .chr-gear { gap: 4px; }
.wbody[data-size="compact"] .chr-slot { gap: 6px; min-height: 44px; padding: 4px 5px 4px 4px; }
.wbody[data-size="compact"] .chr-slot img, .wbody[data-size="compact"] .chr-slot .ph { width: 32px; height: 32px; }
.wbody[data-size="compact"] .chr-slot .n { font-size: .72rem; }
.wbody[data-size="compact"] .chr-slot .s { font-size: .66rem; }

.chr-jg + .chr-jg { margin-top: 10px; }
.chr-jobs { display: grid; grid-template-columns: repeat(auto-fill, minmax(60px, 1fr)); gap: 5px; }
.wbody[data-size="compact"] .chr-jobs { grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); gap: 4px; }
.chr-job { position: relative; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 5px 2px 6px; border-radius: 9px;
  border: 1px solid var(--border); background: var(--surface); min-width: 0; }
.chr-job .ic { position: relative; width: 30px; height: 30px; }
.chr-job .ic img { width: 30px; height: 30px; display: block; object-fit: contain; }
.chr-job .lv { position: absolute; right: -9px; bottom: -4px; min-width: 21px; padding: 0 4px; border-radius: 6px; background: #0b0d12e6; border: 1px solid var(--border-strong);
  font-size: .68rem; font-weight: 700; line-height: 1.35; text-align: center; font-style: normal; }
.chr-job .ab { margin-top: 5px; font-size: .64rem; font-weight: 650; letter-spacing: .04em; color: var(--muted); }
.chr-job .xp { display: block; width: calc(100% - 10px); height: 3px; margin-top: 3px; border-radius: 3px; background: rgba(255, 255, 255, .09); overflow: hidden; }
.chr-job .xp u { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
.chr-job.max { border-color: rgba(224, 169, 61, .6); background: rgba(224, 169, 61, .09); }
.chr-job.max .lv { color: #f0c15a; border-color: rgba(224, 169, 61, .7); }
.chr-job.max .xp u { background: #e0a93d; }
.chr-job.cur { box-shadow: 0 0 0 2px var(--accent-line); }
.chr-job.none .xp { visibility: hidden; }

.chr-curs { display: flex; flex-direction: column; gap: 4px; }
.chr-cg { margin: 6px 0 2px 2px; color: var(--faint); font-size: .66rem; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
.chr-cur { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; column-gap: 9px; align-items: center; padding: 5px 8px; border-radius: 9px; background: var(--surface); border: 1px solid var(--border); }
.chr-cur img, .chr-cur .ph { width: 26px; height: 26px; grid-row: 1 / span 2; object-fit: contain; }
.chr-cur .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .82rem; }
.chr-cur .v { font-weight: 650; font-size: .86rem; white-space: nowrap; }
.chr-cur .v small { color: var(--faint); font-weight: 500; font-size: .74rem; }
.chr-cur .bar2 { grid-column: 2 / -1; height: 5px; border-radius: 4px; background: rgba(255, 255, 255, .08); overflow: hidden; margin-top: 3px; }
.chr-cur .bar2 u { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
.chr-cur.full .bar2 u { background: #e0a93d; }
.chr-cur.full .v { color: #f0c15a; }
.chr-cur .wk { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; margin-top: 5px; font-size: .74rem; color: var(--muted); }
.chr-cur .wk .bar2 { flex: 1 1 auto; margin: 0; background: rgba(255, 255, 255, .08); }
.chr-cur .wk .bar2 u { background: var(--mp); }
.chr-cur .wk.done .bar2 u { background: #e0a93d; }
.chr-cur .wk b { color: var(--text); font-weight: 650; white-space: nowrap; }
.chr-empty { margin: auto; text-align: center; color: var(--muted); padding: 28px 10px; display: flex; flex-direction: column; align-items: center; gap: 10px; }

dialog.chr-sheet { width: min(420px, 94vw); max-height: 86vh; max-height: 86dvh; padding: 0; overflow: auto; }
.chr-sheet .sh { padding: 14px; }
.chr-sheet .sh-head { display: flex; align-items: center; gap: 12px; }
.chr-sheet .sh-head img, .chr-sheet .sh-head .ph { width: 52px; height: 52px; flex: none; border-radius: 10px; background: var(--panel2); object-fit: contain; }
.chr-sheet .sh-t { flex: 1 1 auto; min-width: 0; }
.chr-sheet .sh-name { font-size: 1.05rem; font-weight: 650; overflow-wrap: anywhere; }
.chr-sheet .sh-sub { color: var(--muted); font-size: .84rem; }
.chr-sheet .sh-x { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 10px; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); font-size: 1.3rem; }
.chr-sheet .sh-rows { list-style: none; margin: 12px 0 0; padding: 0; border-top: 1px solid var(--border); }
.chr-sheet .sh-rows li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: .9rem; }
.chr-sheet .sh-rows li span:first-child { color: var(--muted); flex: none; }
.chr-sheet .sh-rows li span:last-child { text-align: right; overflow-wrap: anywhere; }
@media (max-width: 600px) { dialog.chr-sheet { margin: auto auto 0; width: 100vw; max-width: 100vw; border-radius: 18px 18px 0 0; padding-bottom: env(safe-area-inset-bottom); } }
`;

/** One independent widget instance (docked panel or floating window): every instance gets its own state `S` and timers. Shared
 *  caches (market.js) stay module-level. The body below only moved into this closure (review with `git diff -w`). */
export function create() {
  let S = null;

  const fmtN = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "-");
  const pctOf = (v, max) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);

  function img(ctx, id, cls = "") {
    if (!id) return `<span class="ph"></span>`;
    return `<img${cls ? ` class="${cls}"` : ""} src="${esc(ctx.withToken(`/api/icon/${id}.png`))}" loading="lazy" decoding="async" alt="" draggable="false">`;
  }

  // ---- pieces ------------------------------------------------------------------------------------------------------------------------------

  function headerHtml(d) {
    const cur = d.jobs.find((j) => j.id === d.classJobId);
    const where = d.homeWorld && d.homeWorld !== d.world ? `${d.world} (home ${d.homeWorld})` : d.world;
    const job = cur ? `${cur.name} Lv ${cur.level}` : d.level ? `Lv ${d.level}` : "";
    return `${cur ? img(S.ctx, cur.iconId) : `<span class="ph"></span>`}`
      + `<div class="chr-id"><div class="chr-nm">${esc(d.name)}</div><div class="chr-sub">${esc([where, job].filter(Boolean).join(" · "))}</div>`
      + `<div class="chr-sub">${fmtN(d.gil)} gil${d.grandCompany ? ` · ${esc(d.grandCompany.name)} rank ${d.grandCompany.rank}` : ""}</div></div>`
      + `<div class="chr-il" title="Average item level"><b>${d.itemLevel || "-"}</b><small>Item Level</small></div>`;
  }

  function slotHtml(g) {
    if (!g || !g.itemId) {
      return `<div class="chr-slot vacant${g && g.slot === "soul" ? " soul" : ""}"><span class="ph"></span><span class="t"><span class="n">${esc(g ? g.label : "")}</span><span class="s">Empty</span></span></div>`;
    }
    const color = RARITY_COLOR[g.rarity];
    const bits = [`<b>i${g.ilvl || "?"}</b>`];
    if (g.hq) bits.push(`<span class="hq">HQ</span>`);
    if (g.condition != null && g.condition < 30) bits.push(`<span class="low">${g.condition}%</span>`);
    if (g.materia && g.materia.length) bits.push(`◆${g.materia.length}`);
    return `<button type="button" class="chr-slot${g.slot === "soul" ? " soul" : ""}" data-slot="${esc(g.slot)}" aria-label="${esc(g.name)}">${img(S.ctx, g.iconId)}`
      + `<span class="t"><span class="n"${color ? ` style="color:${color}"` : ""}>${esc(g.name)}</span><span class="s">${bits.join(" · ")}</span></span></button>`;
  }

  function gearHtml(d) {
    const by = new Map(d.gear.map((g) => [g.slot, g]));
    const cells = [];
    for (let i = 0; i < LEFT.length; i++) { cells.push(slotHtml(by.get(LEFT[i]))); cells.push(slotHtml(by.get(RIGHT[i]))); }
    const soul = by.get("soul");
    if (soul) cells.push(slotHtml(soul));
    return cells.join("");
  }

  function jobsHtml(d) {
    const out = [];
    for (const [gid, title] of GROUPS) {
      const list = d.jobs.filter((j) => j.group === gid);
      if (!list.length) continue;
      out.push(`<div class="chr-jg"><div class="chr-h">${title}</div><div class="chr-jobs">${list.map((j) => jobHtml(j, j.id === d.classJobId)).join("")}</div></div>`);
    }
    return out.join("") || `<div class="chr-sub">No jobs unlocked yet.</div>`;
  }

  function jobHtml(j, current) {
    const max = j.max > 0 && j.level >= j.max;
    const none = j.max === 0 || max;
    const p = max ? 100 : pctOf(j.exp, j.expToNext);
    const tip = max ? `${j.name} ${j.level} (max level)` : j.expToNext ? `${j.name} ${j.level} – ${fmtN(j.exp)} / ${fmtN(j.expToNext)} EXP` : `${j.name} ${j.level}`;
    return `<div class="chr-job${max ? " max" : ""}${current ? " cur" : ""}${j.max === 0 ? " none" : ""}" title="${esc(tip)}"><span class="ic">${img(S.ctx, j.iconId)}<i class="lv">${j.level}</i></span>`
      + `<span class="ab">${esc(j.abbr)}</span><i class="xp"${none && !max ? " hidden" : ""}><u style="width:${p.toFixed(1)}%"></u></i></div>`;
  }

  function curRow(c, extra = "", cls = "") {
    const full = c.cap > 0 && c.count >= c.cap;
    const label = c.name.replace(/^Allagan Tomestone of /, ""); // the "Tomestones" heading already says it; keeps the names distinct when narrow
    return `<div class="chr-cur${full ? " full" : ""}${cls ? " " + cls : ""}" title="${esc(c.name)}">${img(S.ctx, c.iconId)}<span class="n">${esc(label)}</span>`
      + `<span class="v">${fmtN(c.count)}${c.cap ? ` <small>/ ${fmtN(c.cap)}</small>` : ""}</span>`
      + `<i class="bar2"><u style="width:${pctOf(c.count, c.cap).toFixed(1)}%"></u></i>${extra}</div>`;
  }

  function weeklyHtml(w) {
    if (!w) return "";
    const done = w.limit > 0 && w.acquired >= w.limit;
    return `<div class="wk${done ? " done" : ""}"><span>Weekly</span><i class="bar2"><u style="width:${pctOf(w.acquired, w.limit).toFixed(1)}%"></u></i><b>${fmtN(w.acquired)} / ${fmtN(w.limit)}</b></div>`;
  }

  function currenciesHtml(d) {
    const out = [];
    out.push(curRow({ name: "Gil", iconId: GIL_ICON, count: d.gil, cap: d.gilCap }, "", "gil"));
    if (d.tomestones.length) {
      out.push(`<div class="chr-cg">${GROUP_TITLE.tomestone}</div>`);
      for (const t of d.tomestones) out.push(curRow(t, weeklyHtml(t.weekly)));
    }
    for (const g of CUR_ORDER) {
      const list = d.currencies.filter((c) => c.group === g);
      if (!list.length) continue;
      out.push(`<div class="chr-cg">${GROUP_TITLE[g] || g}</div>`);
      for (const c of list) out.push(curRow(c));
    }
    return out.join("");
  }

  function setHtml(el, html) {
    if (el.__html === html) return;
    el.__html = html;
    el.innerHTML = html;
  }

  function render() {
    const d = S.data;
    if (!d || !d.loggedIn) {
      S.main.hidden = true;
      S.empty.hidden = false;
      S.empty.innerHTML = `${icon("character", "big")}<div>${S.error && !d ? (S.noFeed ? "This plugin build has no character support yet.<br>Update SecondScreen to see it here." : `Couldn't load the character (${esc(S.error)}). Retrying...`) : d ? "Not logged in to a character." : "Loading character..."}</div>`;
      return;
    }
    S.main.hidden = false;
    S.empty.hidden = true;
    setHtml(S.head, headerHtml(d));
    setHtml(S.gear, gearHtml(d));
    setHtml(S.jobs, jobsHtml(d));
    setHtml(S.curs, currenciesHtml(d));
    const cur = d.jobs.find((j) => j.id === d.classJobId);
    S.ctx.setBadge(cur ? `${cur.abbr} ${cur.level}` : "");
    if (S.sheet && S.sheet.open && S.sheetSlot) fillSheet(S.sheetSlot);
  }

  // ---- item sheet ----------------------------------------------------------------------------------------------------------------------------

  function ensureSheet() {
    if (S.sheet) return S.sheet;
    const dlg = document.createElement("dialog");
    dlg.className = "chr-sheet";
    dlg.setAttribute("aria-label", "Item details");
    dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest(".sh-x")) dlg.close(); });
    dlg.addEventListener("close", () => { S.sheetSlot = null; });
    document.body.append(dlg);
    S.sheet = dlg;
    return dlg;
  }

  function fillSheet(slot) {
    const g = S.data && S.data.gear.find((x) => x.slot === slot);
    if (!g || !g.itemId) { S.sheet.close(); return; }
    const color = RARITY_COLOR[g.rarity];
    const rows = [["Slot", esc(g.label)], ["Item level", String(g.ilvl || "?")], ["Quality", g.hq ? "High quality" : "Normal"]];
    if (g.condition != null) rows.push(["Condition", `${g.condition}%`]);
    if (g.spiritbond != null) rows.push(["Spiritbond", `${g.spiritbond}%`]);
    if (g.materia && g.materia.length) rows.push(["Materia", g.materia.map(esc).join("<br>")]);
    if (g.glamour) rows.push(["Glamoured as", esc(g.glamour.name)]);
    S.sheet.innerHTML = `<div class="sh"><div class="sh-head">${img(S.ctx, g.iconId)}<div class="sh-t"><div class="sh-name"${color ? ` style="color:${color}"` : ""}>${esc(g.name)}</div>`
      + `<div class="sh-sub">${esc([g.ilvl ? `Item Level ${g.ilvl}` : "", g.category].filter(Boolean).join(" · "))}</div></div><button type="button" class="sh-x" aria-label="Close">×</button></div>`
      + `<ul class="sh-rows">${rows.map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join("")}</ul></div>`;
  }

  function openSheet(slot) {
    const dlg = ensureSheet();
    S.sheetSlot = slot;
    fillSheet(slot);
    if (!dlg.open && S.sheetSlot) dlg.showModal();
  }

  // ---- data fetching -------------------------------------------------------------------------------------------------------------------------

  async function fetchCharacter() {
    if (S.fetching) return;
    S.fetching = true;
    try {
      const r = await fetch(S.ctx.withToken("/api/character"), { cache: "no-store" });
      if (r.status === 404) S.noFeed = true;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      S.error = ""; S.noFeed = false;
      S.version = d.version;
      S.data = d;
      render();
    } catch (e) {
      S.error = e.message || String(e);
      S.retryAt = Date.now() + 5000;
      if (!S.data) render();
    } finally {
      S.fetching = false;
      S.retryAt = Math.max(S.retryAt, Date.now() + 1000); // EXP moves the version often; never refetch faster than 1 Hz
    }
  }

  // ---- widget contract -------------------------------------------------------------------------------------------------------------------------

  function mount(el, ctx) {
    if (!document.getElementById("chr-style")) {
      const st = document.createElement("style");
      st.id = "chr-style";
      st.textContent = CSS;
      document.head.append(st);
    }
    el.innerHTML = `
    <div class="chr">
      <div class="chr-empty"></div>
      <div class="chr-main" hidden>
        <div class="chr-head card"></div>
        <div class="chr-cols" style="margin-top:12px">
          <div class="chr-col"><section><div class="chr-h">Gear</div><div class="chr-gear"></div></section>
            <section><div class="chr-h">Currencies</div><div class="chr-curs"></div></section></div>
          <div class="chr-col"><section><div class="chr-h">Jobs</div><div class="chr-jobsw"></div></section></div>
        </div>
      </div>
    </div>`;
    const root = el.querySelector(".chr");
    S = {
      ctx, root,
      empty: root.querySelector(".chr-empty"), main: root.querySelector(".chr-main"),
      head: root.querySelector(".chr-head"), gear: root.querySelector(".chr-gear"), jobs: root.querySelector(".chr-jobsw"), curs: root.querySelector(".chr-curs"),
      data: null, version: null, fetching: false, retryAt: 0, error: "", noFeed: false,
      sheet: null, sheetSlot: null,
    };
    root.addEventListener("click", (e) => {
      const b = e.target.closest(".chr-slot[data-slot]");
      if (b) openSheet(b.dataset.slot);
    });
    render();
  }

  function update(payload) {
    if (!S) return;
    const v = payload.characterVersion;
    if (v === undefined) { // older plugin build: try the endpoint once
      if (!S.data && !S.noFeed) { S.noFeed = true; fetchCharacter(); }
      return;
    }
    if (v !== S.version && !S.fetching && Date.now() >= S.retryAt) fetchCharacter();
  }

  function unmount() {
    if (!S) return;
    S.sheet?.remove();
    S = null;
  }

  return { mount, update, unmount };
}
