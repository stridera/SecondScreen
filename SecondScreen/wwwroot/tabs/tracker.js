// Tracker tab: "have X / need Y" cards for items/currencies, achievement progress, single quests and Main Scenario progress.
//
// Data flow: the plugin evaluates trackers on the game thread (~1 Hz) and pushes the list as `trackers` in the
// WebSocket payload. Mutations go through the REST API (/api/trackers, /api/search, /api/icon); the list
// re-renders from the next push.
//
// Extending: add an entry to KINDS (label + how the add sheet picks a target), and a branch in cardHtml() if the card
// needs a different layout. Kinds: item, achievement, quest (one quest, done / not done) and msq (Main Scenario, no
// target; added with the one-tap button in the add sheet, `quick: true` keeps it out of the search tabs).
// Planned kind: "goal" (shop/recipe cost trees).
//
// Reordering: each card has a left rail with up / grip / down. The grip drags with Pointer Events (mouse, pen, iPad
// touch: touch-action:none on the grip only, so the list still scrolls elsewhere); up/down buttons and the arrow keys
// on the grip are the precise / accessible alternative. A change is applied optimistically, POSTed to
// /api/trackers/reorder {ids} and reverted with a short message if the plugin refuses. While a drag is active (or a
// reorder is still unconfirmed) incoming pushes are held back so the DOM is never rebuilt under the user's finger.

import { esc, pct } from "../js/util.js";
import * as market from "../js/market.js";

const KINDS = {
  item: { label: "Item", placeholder: "Search items and currencies...", askCount: true, countLabel: "How many do you need?" },
  achievement: { label: "Achievement", placeholder: "Search achievements...", askCount: false },
  quest: { label: "Quest", placeholder: "Search quests...", askCount: false },
  msq: { label: "Main Scenario", quick: true },
  // goal:  { label: "Goal",  ... }   (later: shop / recipe cost trees)
};

// Styles for the msq / quest cards and the add-sheet quick button live here (not style.css) so this tab stays self-contained.
const STYLE_ID = "trk-msq-style";
const CSS = `
.trk-card.msq .trk-main { min-width: 0; }
.trk-bar.msq-cur { height: 24px; margin-top: 8px; box-shadow: 0 0 0 1px #f0b42988 inset; }
.trk-bar.msq-cur > i { background: #f0b429; }
.trk-bar.msq-cur > span { color: #fff; font-weight: 600; font-size: .85rem; }
.trk-next { margin-top: 10px; font-size: .93rem; line-height: 1.35; overflow-wrap: anywhere; }
.trk-next b { font-weight: 600; }
.trk-next-label { color: var(--muted); margin-right: 4px; }
.trk-next-place { display: block; color: var(--muted); font-size: .8rem; }
.trk-more { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-height: 44px; margin-top: 8px;
  padding: 8px 12px; background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 10px;
  font-size: .9rem; cursor: pointer; touch-action: manipulation; }
.trk-chev { color: var(--muted); transition: transform .15s; }
.trk-more[aria-expanded="true"] .trk-chev { transform: rotate(180deg); }
.trk-exps { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.trk-exp { display: grid; grid-template-columns: minmax(92px, 36%) 1fr auto; align-items: center; gap: 10px; min-height: 32px; font-size: .85rem; }
.trk-exp .bar { margin-top: 0; height: 10px; }
.trk-exp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trk-exp-n { color: var(--muted); font-variant-numeric: tabular-nums; }
.trk-exp.cur .trk-exp-name { color: #f0b429; font-weight: 600; }
.trk-exp.cur .bar > i { background: #f0b429; }
.trk-sheet button.trk-quick { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; min-height: 56px; margin-bottom: 10px;
  text-align: left; background: var(--panel2); color: var(--text); border: 1px solid var(--accent); border-radius: 10px; }
.trk-quick > span { color: var(--muted); font-size: .8rem; }
.trk-rail { display: flex; flex-direction: column; align-self: stretch; flex: none; width: 28px; gap: 2px; margin: -4px 0 -4px -6px; }
.trk-rail button { flex: 1 1 0; min-height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 7px;
  background: transparent; color: var(--muted); font-size: 11px; line-height: 1; cursor: pointer; touch-action: manipulation; }
.trk-rail button:hover:not(:disabled) { background: var(--panel2); color: var(--text); }
.trk-rail button:focus-visible { outline: 2px solid var(--accent-line); outline-offset: -1px; }
.trk-rail button:disabled { opacity: .22; cursor: default; }
.trk-rail button.trk-grip { flex-grow: 1.4; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.trk-dots { width: 10px; height: 16px; background: radial-gradient(circle at center, currentColor 1.3px, transparent 1.7px) 0 0 / 5px 5.34px; }
.trk-list.dragging { user-select: none; -webkit-user-select: none; }
.trk-card.trk-src { border-style: dashed; border-color: var(--accent-line); background: var(--accent-soft); }
.trk-card.trk-src > * { visibility: hidden; }
.trk-ghost { position: fixed; left: 0; top: 0; z-index: 100; margin: 0; box-sizing: border-box; pointer-events: none; opacity: .96;
  border-color: var(--accent-line); box-shadow: 0 14px 34px rgba(0, 0, 0, .55); will-change: transform; }
body.trk-dragging, body.trk-dragging * { cursor: grabbing !important; }
.trk-toast { margin: 0 0 8px; padding: 8px 12px; border-radius: 10px; font-size: .88rem; color: var(--hp-low);
  background: var(--panel2); border: 1px solid var(--hp-low); }
.trk-toast[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) { .trk-card { transition: none !important; } }
`;
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const token = () => localStorage.getItem("ss.token") || "";
const withToken = (path) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token())}`;

async function api(method, path, body) {
  const res = await fetch(withToken(`/api${path}`), {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    if (res.status === 401) msg = "Unauthorized (check the access token)";
    if (res.status === 404) msg = "Not found (is the plugin up to date?)";
    throw new Error(msg);
  }
  return res.json();
}

const iconUrl = (id) => withToken(`/api/icon/${id}.png`);
const num = (n) => Number(n).toLocaleString();

function agoCoarse(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function iconHtml(id) {
  return id ? `<img class="trk-icon" src="${iconUrl(id)}" alt="" width="44" height="44" draggable="false">` : `<div class="trk-icon"></div>`;
}

const DOT = " \u00B7 ";

function actionsHtml(refresh = "") {
  return `<div class="trk-actions">${refresh}<button type="button" data-act="edit" title="Edit" aria-label="Edit">&#9998;</button><button type="button" data-act="delete" class="danger" title="Delete" aria-label="Delete">&#10005;</button></div>`;
}

// Reorder rail: up / drag grip / down. Omitted when there is nothing to reorder.
function railHtml(i, n) {
  if (n < 2) return "";
  return `<div class="trk-rail"><button type="button" data-act="up" title="Move up" aria-label="Move up"${i === 0 ? " disabled" : ""}>&#9650;</button>`
    + `<button type="button" class="trk-grip" data-act="grip" title="Drag to reorder (or press the up / down arrow keys)" aria-label="Reorder: drag, or press the up and down arrow keys"><span class="trk-dots" aria-hidden="true"></span></button>`
    + `<button type="button" data-act="down" title="Move down" aria-label="Move down"${i === n - 1 ? " disabled" : ""}>&#9660;</button></div>`;
}

function titleHtml(t) {
  return `<div class="trk-title"><span class="trk-name">${esc(t.title)}</span>${t.complete ? `<span class="trk-check" aria-label="complete">&#10003;</span>` : ""}</div>`;
}

// "MSQ 812/1004 · Dawntrail 20/40 · Next: Name (Lv 100)" - the one-line summary, used as the card tooltip.
function msqSummary(t) {
  const m = t.msq || {};
  const parts = [`MSQ ${t.current ?? 0}/${t.max ?? 0}`];
  if (m.current) parts.push(`${m.current.expansion} ${m.current.done}/${m.current.total}`);
  if (m.next) parts.push(`Next: ${m.next.name} (Lv ${m.next.level})`);
  return parts.join(DOT);
}

function msqCardHtml(t, rail) {
  const m = t.msq || {};
  const exps = m.expansions || [];
  const cur = m.current;
  const next = m.next;
  const open = S.expanded.has(t.id);
  const hasMax = t.max != null && t.max > 0;
  const c = t.current ?? 0;
  const overall = hasMax
    ? `<div class="bar trk-bar${t.complete ? " done" : ""}"><i style="width:${pct(c, t.max)}%"></i><span>MSQ ${num(c)} / ${num(t.max)}</span></div>`
    : `<div class="trk-count">-</div>`;
  const curBar = cur && cur.total > 0
    ? `<div class="bar trk-bar msq-cur"><i style="width:${pct(cur.done, cur.total)}%"></i><span>${esc(cur.expansion)} ${num(cur.done)} / ${num(cur.total)}</span></div>` : "";
  let nextLine = "";
  if (next) {
    nextLine = `<div class="trk-next"><span class="trk-next-label">Next:</span><b>${esc(next.name)}</b> (Lv ${esc(next.level)})${next.placeName ? `<span class="trk-next-place">${esc(next.placeName)}</span>` : ""}</div>`;
  } else if (t.complete) {
    nextLine = `<div class="trk-next trk-ok">Every Main Scenario quest is complete.</div>`;
  }
  const more = exps.length > 1
    ? `<button type="button" class="trk-more" data-act="expand" aria-expanded="${open}"><span>${open ? "Hide expansions" : "All expansions"}</span><span class="trk-chev" aria-hidden="true">&#9662;</span></button>` : "";
  const list = open ? `<div class="trk-exps">${exps.map((e) =>
    `<div class="trk-exp${cur && e.expansion === cur.expansion ? " cur" : ""}"><span class="trk-exp-name">${esc(e.expansion)}</span><div class="bar trk-bar${e.done >= e.total ? " done" : ""}"><i style="width:${pct(e.done, e.total)}%"></i></div><span class="trk-exp-n">${num(e.done)}/${num(e.total)}</span></div>`).join("")}</div>` : "";
  const off = t.live ? "" : `<div class="trk-meta"><span class="trk-off">${esc(t.detail)}</span></div>`;
  return `<div class="card trk-card msq${t.complete ? " complete" : ""}${t.live ? "" : " stale"}" data-id="${esc(t.id)}" title="${esc(msqSummary(t))}">
    ${rail}${iconHtml(t.iconId)}
    <div class="trk-main">
      ${titleHtml(t)}
      <div class="trk-kind">${esc(KINDS.msq.label)}</div>
      ${overall}${curBar}${nextLine}${off}${more}${list}
    </div>
    ${actionsHtml()}
  </div>`;
}

function questCardHtml(t, rail) {
  const q = t.quest;
  const facts = q
    ? [`Lv ${q.level}`, q.expansion, q.genre].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")
    : `<span>${esc(t.detail)}</span>`;
  const place = q && q.placeName ? `<span>${esc(q.placeName)}</span>` : "";
  const off = t.live ? "" : `<span class="trk-off">${esc(t.detail)}</span>`;
  return `<div class="card trk-card${t.complete ? " complete" : ""}${t.live ? "" : " stale"}" data-id="${esc(t.id)}" title="${esc(t.detail)}">
    ${rail}${iconHtml(t.iconId)}
    <div class="trk-main">
      ${titleHtml(t)}
      <div class="trk-kind">${esc(KINDS.quest.label)}</div>
      <div class="trk-count${t.complete ? " done" : ""}">${t.complete ? "Done" : "Not done"}</div>
      <div class="trk-meta">${facts}${place}${off}</div>
    </div>
    ${actionsHtml()}
  </div>`;
}

function cardHtml(t, rail = "") {
  if (t.kind === "msq") return msqCardHtml(t, rail);
  if (t.kind === "quest") return questCardHtml(t, rail);
  const kind = KINDS[t.kind];
  const hasMax = t.max != null && t.max > 0;
  const cur = t.current;
  let progress;
  if (hasMax) {
    const c = cur ?? 0;
    progress = `<div class="bar trk-bar${t.complete ? " done" : ""}"><i style="width:${pct(c, t.max)}%"></i><span>${num(c)} / ${num(t.max)}</span></div>`;
  } else {
    // Achievements without a counter only have a done / not done state; items show the raw count.
    const label = t.kind === "achievement" ? (t.complete ? "Done" : "In progress") : cur == null ? "-" : num(cur);
    progress = `<div class="trk-count${t.complete ? " done" : ""}">${esc(label)}</div>`;
  }

  const bits = [];
  if (t.complete) bits.push(`<span class="trk-ok">Complete</span>`);
  else if (hasMax && cur != null) bits.push(`<span>${num(Math.max(0, t.max - cur))} to go</span>`);
  else if (t.kind === "achievement" && !hasMax) bits.push(`<span>No progress counter</span>`);
  if (t.kind === "achievement") {
    bits.push(`<span class="trk-upd">${t.pending ? "Updating..." : t.updatedMs ? `Updated ${agoCoarse(t.updatedMs)}` : "Not fetched yet"}</span>`);
  }
  if (!t.live) bits.push(`<span class="trk-off">${esc(t.detail)}</span>`);
  if (t.kind === "item" && t.targetId) bits.push(market.priceLineHtml(t.targetId)); // "≈ 1,234g ea · DC min" once fetched (tradable items only)

  const refresh = t.kind === "achievement"
    ? `<button type="button" data-act="refresh" title="Refresh progress" aria-label="Refresh"${t.pending ? " disabled" : ""}>&#8635;</button>` : "";
  return `<div class="card trk-card${t.complete ? " complete" : ""}${t.live ? "" : " stale"}" data-id="${esc(t.id)}" title="${esc(t.detail)}">
    ${rail}${iconHtml(t.iconId)}
    <div class="trk-main">
      <div class="trk-title"><span class="trk-name">${esc(t.title)}</span>${t.complete ? `<span class="trk-check" aria-label="complete">&#10003;</span>` : ""}</div>
      <div class="trk-kind">${esc(kind ? kind.label : t.kind)}</div>
      ${progress}
      <div class="trk-meta">${bits.join("")}</div>
    </div>
    <div class="trk-actions">${refresh}<button type="button" data-act="edit" title="Edit" aria-label="Edit">&#9998;</button><button type="button" data-act="delete" class="danger" title="Delete" aria-label="Delete">&#10005;</button></div>
  </div>`;
}

let S = null; // state of the mounted tab instance
let offMarket = null;

function mount(el) {
  el.dataset.done = "1";
  if (!offMarket) offMarket = market.onChange(repaint); // scope toggled in the inventory sheet / player became known
  ensureStyle();
  el.innerHTML = `
    <div class="trk">
      <div class="trk-head"><h2>Trackers</h2><button type="button" class="trk-addbtn">+ Add</button></div>
      <div class="trk-toast" role="alert" hidden></div>
      <div class="trk-list"></div>

      <dialog class="trk-sheet trk-add">
        <div class="trk-sheet-head"><h3>Add tracker</h3><button type="button" class="trk-x" data-close aria-label="Close">&#10005;</button></div>
        <div class="trk-quickrow"></div>
        <div class="trk-kinds" role="tablist"></div>
        <div class="trk-step1">
          <input type="search" class="trk-q" autocomplete="off" autocapitalize="off" spellcheck="false">
          <div class="trk-results"></div>
        </div>
        <div class="trk-step2" hidden>
          <div class="trk-picked"></div>
          <label class="trk-field"><span class="trk-countlabel"></span>
            <input type="number" inputmode="numeric" min="1" step="1" class="trk-countin" placeholder="Optional"></label>
          <div class="trk-row"><button type="button" class="trk-secondary" data-back>Back</button><button type="button" class="trk-primary" data-confirm>Add</button></div>
        </div>
        <div class="trk-err" hidden></div>
      </dialog>

      <dialog class="trk-sheet trk-edit">
        <div class="trk-sheet-head"><h3>Edit tracker</h3><button type="button" class="trk-x" data-close aria-label="Close">&#10005;</button></div>
        <label class="trk-field"><span>Title</span><input type="text" class="trk-edit-title" autocomplete="off"></label>
        <label class="trk-field trk-edit-countwrap"><span>Target count (empty = just show the count)</span>
          <input type="number" inputmode="numeric" min="1" step="1" class="trk-edit-count"></label>
        <div class="trk-row"><button type="button" class="trk-secondary" data-close>Cancel</button><button type="button" class="trk-primary" data-save>Save</button></div>
        <div class="trk-err" hidden></div>
      </dialog>
    </div>`;
  const root = el.querySelector(".trk");
  S = {
    root,
    list: root.querySelector(".trk-list"),
    toastEl: root.querySelector(".trk-toast"),
    toastTimer: 0,
    drag: null, // active grip drag (also set between pointerdown and the first move)
    pending: null, // { ids, until }: our own unconfirmed order, re-applied over incoming pushes
    rs: { timer: 0, timerActive: false, busy: false, again: false, confirmed: null }, // reorder sender
    addDlg: root.querySelector(".trk-add"),
    editDlg: root.querySelector(".trk-edit"),
    trackers: [],
    expanded: new Set(), // msq card ids showing the per-expansion list
    lastData: null,
    lastHtml: null,
    kind: "item",
    picked: null,
    searchSeq: 0,
    timer: 0,
    editId: null,
    busy: false,
  };
  bind();
  setKind("item");
}

function bind() {
  const { root, list, addDlg, editDlg } = S;

  root.querySelector(".trk-addbtn").addEventListener("click", () => openAdd());

  list.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    const card = e.target.closest(".trk-card");
    if (!b || !card || b.disabled) return;
    const t = S.trackers.find((x) => x.id === card.dataset.id);
    if (!t) return;
    if (b.dataset.act === "edit") openEdit(t);
    else if (b.dataset.act === "delete") del(t);
    else if (b.dataset.act === "refresh") refresh(t, b);
    else if (b.dataset.act === "up") moveBy(t.id, -1, "up");
    else if (b.dataset.act === "down") moveBy(t.id, 1, "down");
    else if (b.dataset.act === "expand") {
      if (!S.expanded.delete(t.id)) S.expanded.add(t.id);
      S.lastHtml = null;
      paint();
    }
  });
  list.addEventListener("pointerdown", onGripDown);
  list.addEventListener("keydown", (e) => {
    const g = e.target.closest(".trk-grip");
    const card = g && g.closest(".trk-card");
    if (!card || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    moveBy(card.dataset.id, e.key === "ArrowUp" ? -1 : 1, "grip");
  });
  list.addEventListener("contextmenu", (e) => { if (e.target.closest(".trk-grip")) e.preventDefault(); });
  // Hide the img on 404 (icon missing); error events do not bubble, so capture.
  list.addEventListener("error", (e) => { if (e.target.tagName === "IMG") e.target.style.visibility = "hidden"; }, true);

  for (const dlg of [addDlg, editDlg]) {
    dlg.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) { dlg.close(); return; }
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect(); // a click on the backdrop lands on the dialog element, outside its box
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
  }

  // add sheet
  addDlg.querySelector(".trk-quickrow").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-quick]");
    if (b) createMsq();
  });
  addDlg.querySelector(".trk-kinds").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kind]");
    if (b) setKind(b.dataset.kind);
  });
  const q = addDlg.querySelector(".trk-q");
  q.addEventListener("input", () => { clearTimeout(S.timer); S.timer = setTimeout(runSearch, 250); });
  addDlg.querySelector(".trk-results").addEventListener("click", (e) => {
    const r = e.target.closest(".trk-result");
    if (!r) return;
    pick({ id: Number(r.dataset.id), name: r.dataset.name, iconId: Number(r.dataset.icon), subtitle: r.dataset.sub });
  });
  addDlg.querySelector("[data-back]").addEventListener("click", () => showStep(1));
  addDlg.querySelector("[data-confirm]").addEventListener("click", () => {
    const v = parseInt(addDlg.querySelector(".trk-countin").value, 10);
    create(S.picked, v > 0 ? v : null);
  });
  addDlg.querySelector(".trk-countin").addEventListener("keydown", (e) => { if (e.key === "Enter") addDlg.querySelector("[data-confirm]").click(); });

  // edit sheet
  editDlg.querySelector("[data-save]").addEventListener("click", saveEdit);
  editDlg.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") saveEdit(); });
}

function showErr(dlg, msg) {
  const el = dlg.querySelector(".trk-err");
  el.textContent = msg || "";
  el.hidden = !msg;
}

// ---- add sheet -------------------------------------------------------------------------------------------

function openAdd() {
  showErr(S.addDlg, "");
  S.addDlg.querySelector(".trk-q").value = "";
  showStep(1);
  setKind(S.kind);
  S.addDlg.showModal();
  S.addDlg.querySelector(".trk-q").focus();
}

function setKind(kind) {
  S.kind = kind;
  const box = S.addDlg.querySelector(".trk-kinds");
  renderQuick();
  box.innerHTML = Object.entries(KINDS).filter(([, v]) => !v.quick)
    .map(([k, v]) => `<button type="button" role="tab" data-kind="${k}" class="${k === kind ? "on" : ""}" aria-selected="${k === kind}">${esc(v.label)}</button>`).join("");
  S.addDlg.querySelector(".trk-q").placeholder = KINDS[kind].placeholder;
  S.addDlg.querySelector(".trk-results").innerHTML = `<div class="trk-hint">Type at least 2 letters of the name.</div>`;
  showErr(S.addDlg, "");
  showStep(1);
  if (S.addDlg.querySelector(".trk-q").value.trim().length >= 2) runSearch();
}

// One-tap "Main Scenario" option; hidden once a Main Scenario tracker exists (the plugin also refuses a second one).
function renderQuick() {
  const row = S.addDlg.querySelector(".trk-quickrow");
  row.innerHTML = S.trackers.some((t) => t.kind === "msq") ? ""
    : `<button type="button" class="trk-quick" data-quick="msq"><b>Main Scenario</b><span>Track your overall story progress, the current expansion and the next quest</span></button>`;
}

function showStep(n) {
  S.addDlg.querySelector(".trk-step1").hidden = n !== 1;
  S.addDlg.querySelector(".trk-step2").hidden = n !== 2;
}

async function runSearch() {
  const box = S.addDlg.querySelector(".trk-results");
  const text = S.addDlg.querySelector(".trk-q").value.trim();
  const seq = ++S.searchSeq;
  if (text.length < 2) { box.innerHTML = `<div class="trk-hint">Type at least 2 letters of the name.</div>`; return; }
  box.innerHTML = `<div class="trk-hint">Searching...</div>`;
  try {
    const rows = await api("GET", `/search?kind=${encodeURIComponent(S.kind)}&q=${encodeURIComponent(text)}`);
    if (seq !== S.searchSeq) return; // a newer search superseded this one
    if (!rows.length) { box.innerHTML = `<div class="trk-hint">No matches.</div>`; return; }
    box.innerHTML = rows.map((r) => `<button type="button" class="trk-result" data-id="${r.id}" data-name="${esc(r.name)}" data-icon="${r.iconId}" data-sub="${esc(r.subtitle)}">
      ${iconHtml(r.iconId)}<span class="trk-rtext"><span class="trk-rname">${esc(r.name)}</span><span class="trk-rsub">${esc(r.subtitle)}</span></span></button>`).join("");
  } catch (err) {
    if (seq === S.searchSeq) box.innerHTML = `<div class="trk-hint err">Search failed: ${esc(err.message)}</div>`;
  }
}

function pick(r) {
  S.picked = r;
  if (!KINDS[S.kind].askCount) { create(r, null); return; }
  S.addDlg.querySelector(".trk-picked").innerHTML = `${iconHtml(r.iconId)}<div class="trk-rtext"><span class="trk-rname">${esc(r.name)}</span><span class="trk-rsub">${esc(r.subtitle)}</span></div>`;
  S.addDlg.querySelector(".trk-countlabel").textContent = KINDS[S.kind].countLabel;
  S.addDlg.querySelector(".trk-countin").value = "";
  showErr(S.addDlg, "");
  showStep(2);
  S.addDlg.querySelector(".trk-countin").focus();
}

async function create(r, count) {
  if (S.busy) return;
  S.busy = true;
  try {
    const body = { kind: S.kind, targetId: r.id, title: r.name };
    if (count != null) body.targetCount = count;
    await api("POST", "/trackers", body);
    S.addDlg.close();
    reloadSoon();
  } catch (err) {
    showErr(S.addDlg, `Could not add: ${err.message}`);
  } finally {
    S.busy = false;
  }
}

async function createMsq() {
  if (S.busy) return;
  S.busy = true;
  try {
    await api("POST", "/trackers", { kind: "msq" });
    S.addDlg.close();
    reloadSoon();
  } catch (err) {
    showErr(S.addDlg, `Could not add: ${err.message}`);
  } finally {
    S.busy = false;
  }
}

// ---- edit / delete / refresh -----------------------------------------------------------------------------

function openEdit(t) {
  S.editId = t.id;
  S.editKind = t.kind;
  const d = S.editDlg;
  d.querySelector(".trk-edit-title").value = t.title;
  d.querySelector(".trk-edit-count").value = t.targetCount ?? "";
  d.querySelector(".trk-edit-countwrap").hidden = t.kind !== "item";
  showErr(d, "");
  d.showModal();
}

async function saveEdit() {
  if (S.busy) return;
  const d = S.editDlg;
  const body = { title: d.querySelector(".trk-edit-title").value.trim() };
  if (S.editKind === "item") {
    const v = parseInt(d.querySelector(".trk-edit-count").value, 10);
    body.targetCount = v > 0 ? v : null; // null clears the target
  }
  S.busy = true;
  try {
    await api("PATCH", `/trackers/${encodeURIComponent(S.editId)}`, body);
    d.close();
    reloadSoon();
  } catch (err) {
    showErr(d, `Could not save: ${err.message}`);
  } finally {
    S.busy = false;
  }
}

async function del(t) {
  if (!confirm(`Delete tracker "${t.title}"?`)) return;
  try {
    await api("DELETE", `/trackers/${encodeURIComponent(t.id)}`);
    S.trackers = S.trackers.filter((x) => x.id !== t.id);
    S.expanded.delete(t.id);
    S.lastHtml = null;
    paint();
    reloadSoon();
  } catch (err) {
    alert(`Could not delete: ${err.message}`);
  }
}

async function refresh(t, btn) {
  btn.disabled = true;
  try {
    await api("POST", `/trackers/${encodeURIComponent(t.id)}/refresh`);
    reloadSoon();
  } catch (err) {
    btn.disabled = false;
    alert(`Could not refresh: ${err.message}`);
  }
}

// After a mutation, fetch the list directly (the next WebSocket push also carries it).
function reloadSoon() {
  const inst = S;
  setTimeout(async () => {
    try {
      const rows = await api("GET", "/trackers");
      if (S !== inst) return;
      adopt(rows);
      paint();
    } catch { /* the WebSocket push will catch up */ }
  }, 350);
}

// ---- list ------------------------------------------------------------------------------------------------

function paint() {
  if (S.drag) return; // held back until the drop (endDrag repaints)
  const n = S.trackers.length;
  market.warm(S.trackers.filter((t) => t.kind === "item" && t.targetId).map((t) => t.targetId), repaint);
  const html = n
    ? S.trackers.map((t, i) => cardHtml(t, railHtml(i, n))).join("")
    : `<div class="empty">No trackers yet. Tap <b>+ Add</b> to track an item, a currency, an achievement, a quest or your Main Scenario progress.</div>`;
  if (html === S.lastHtml) return;
  S.lastHtml = html;
  S.list.innerHTML = html;
}

function repaint() { if (S) { S.lastHtml = ""; paint(); } }

// Takes a fresh list from the plugin. While one of our own reorders is unconfirmed (or the server has not caught up
// yet) the local order wins, so the list does not jump back and forth.
function adopt(rows) {
  const p = S.pending;
  if (p) {
    const have = rows.map((t) => t.id).filter((id) => p.ids.includes(id));
    const want = p.ids.filter((id) => have.includes(id));
    if (have.length === want.length && have.every((id, i) => id === want[i]) || Date.now() > p.until) {
      S.pending = null;
    } else {
      const pos = new Map(p.ids.map((id, i) => [id, i]));
      rows = rows.map((t, i) => [t, pos.has(t.id) ? pos.get(t.id) : p.ids.length + i]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    }
  }
  S.trackers = rows;
}

export function render(el, data) {
  market.setPlayer(data && data.snapshot && data.snapshot.player);
  if (!el.dataset.done || !S || !el.contains(S.root)) mount(el);
  if (data !== S.lastData) {
    S.lastData = data;
    if (data && Array.isArray(data.trackers)) adopt(data.trackers);
  }
  paint();
}

// ---- reorder ---------------------------------------------------------------------------------------------

const reduceMotion = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
const ids_ = () => S.trackers.map((t) => t.id);
const cardEls = () => [...S.list.querySelectorAll(":scope > .trk-card")];

function toast(msg) {
  S.toastEl.textContent = msg;
  S.toastEl.hidden = false;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { S.toastEl.hidden = true; }, 4000);
}

// FLIP: run `mutate` (which changes the cards' order / DOM) and slide every card from its old spot to its new one.
function flip(mutate) {
  const first = new Map(cardEls().map((c) => [c.dataset.id, c.getBoundingClientRect()]));
  mutate();
  if (reduceMotion()) return;
  const moved = [];
  for (const c of cardEls()) {
    const a = first.get(c.dataset.id);
    if (!a) continue;
    const b = c.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    c.style.transition = "none";
    c.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(c);
  }
  if (!moved.length) return;
  void S.list.offsetWidth; // commit the start positions
  for (const c of moved) { c.style.transition = "transform 160ms cubic-bezier(.2, .8, .2, 1)"; c.style.transform = ""; }
  setTimeout(() => { for (const c of moved) c.style.transition = ""; }, 220);
}

// Listed ids first (in that order), anything else (e.g. added by another device meanwhile) after, in current order.
function applyOrder(ids) {
  const pos = new Map(ids.map((id, i) => [id, i]));
  const cur = S.trackers;
  return [...cur.filter((t) => pos.has(t.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id)), ...cur.filter((t) => !pos.has(t.id))];
}

// Optimistic: reorder locally now, tell the plugin shortly after (debounced so repeated taps send one request).
function commitOrder(ids, delay, animate) {
  const rs = S.rs;
  if (rs.confirmed == null) rs.confirmed = ids_();
  S.trackers = applyOrder(ids);
  S.pending = { ids: ids_(), until: Infinity };
  const draw = () => { S.lastHtml = null; paint(); };
  if (animate) flip(draw); else draw();
  clearTimeout(rs.timer);
  rs.timerActive = true;
  rs.timer = setTimeout(flushReorder, delay);
}

async function flushReorder() {
  const rs = S.rs;
  rs.timerActive = false;
  if (rs.busy) { rs.again = true; return; }
  rs.busy = true;
  const inst = S;
  try {
    do {
      rs.again = false;
      const ids = ids_();
      await api("POST", "/trackers/reorder", { ids });
      rs.confirmed = ids;
    } while (rs.again);
    if (!rs.timerActive) {
      rs.confirmed = null;
      if (S.pending) S.pending.until = Date.now() + 4000; // give the plugin a moment to publish the new order
      reloadSoon();
    }
  } catch (err) {
    if (S !== inst) return;
    const base = rs.confirmed;
    clearTimeout(rs.timer);
    rs.timerActive = false; rs.again = false; rs.confirmed = null;
    S.pending = null;
    if (base) S.trackers = applyOrder(base);
    S.lastHtml = null;
    paint();
    toast(`Could not save the new order: ${err.message}`);
  } finally {
    rs.busy = false;
  }
}

function moveBy(id, delta, focusAct) {
  if (S.drag) return;
  const ids = ids_();
  const i = ids.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  commitOrder(ids, 350, true);
  const card = cardEls().find((c) => c.dataset.id === id);
  if (!card) return;
  const want = card.querySelector(`[data-act="${focusAct}"]`);
  (want && !want.disabled ? want : card.querySelector('[data-act="grip"]'))?.focus({ preventScroll: true });
  card.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
}

// ---- drag by the grip (Pointer Events) ----

function scrollParent(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

function onGripDown(e) {
  const grip = e.target.closest(".trk-grip");
  if (!grip || S.drag) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const card = grip.closest(".trk-card");
  if (!card) return;
  e.preventDefault();
  const d = S.drag = {
    id: card.dataset.id, card, pid: e.pointerId, touch: e.pointerType !== "mouse",
    sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY,
    started: false, ending: false, ghost: null, raf: 0, last: 0, lock: 0, scroller: null,
    gx: 0, gy: 0, ox: 0, oy: 0, before: cardEls().map((c) => c.dataset.id),
  };
  // Capture on the list, not the grip: the card (and its grip) is moved around in the DOM while dragging.
  try { S.list.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  d.move = (ev) => {
    if (ev.pointerId !== d.pid || d.ending) return;
    d.x = ev.clientX; d.y = ev.clientY;
    if (!d.started) {
      if (Math.hypot(d.x - d.sx, d.y - d.sy) < (d.touch ? 6 : 4)) return;
      startDrag(d);
    }
    placeGhost(d);
  };
  d.up = (ev) => { if (ev.pointerId === d.pid) endDrag(d, true); };
  d.cancel = (ev) => { if (ev.pointerId === d.pid) endDrag(d, false); };
  d.key = (ev) => { if (ev.key === "Escape") endDrag(d, false); };
  S.list.addEventListener("pointermove", d.move);
  S.list.addEventListener("pointerup", d.up);
  S.list.addEventListener("pointercancel", d.cancel);
  document.addEventListener("keydown", d.key);
}

function startDrag(d) {
  d.started = true;
  const r = d.card.getBoundingClientRect();
  d.gx = d.sx - r.left; d.gy = d.sy - r.top;
  const g = d.ghost = d.card.cloneNode(true);
  g.classList.add("trk-ghost");
  g.removeAttribute("data-id"); g.removeAttribute("title"); g.setAttribute("aria-hidden", "true");
  for (const el of g.querySelectorAll("button")) el.tabIndex = -1;
  g.style.width = `${r.width}px`; g.style.height = `${r.height}px`;
  S.root.append(g);
  const o = g.getBoundingClientRect(); // origin of the fixed-position containing block (0,0 unless an ancestor transforms)
  d.ox = o.left; d.oy = o.top;
  d.scroller = scrollParent(S.list);
  d.card.classList.add("trk-src");
  S.list.classList.add("dragging");
  document.body.classList.add("trk-dragging");
  d.raf = requestAnimationFrame(tick);
}

function placeGhost(d) {
  if (!d.ghost) return;
  d.ghost.style.transform = `translate(${d.x - d.gx - d.ox}px, ${d.y - d.gy - d.oy}px)`;
}

function tick(ts) {
  const d = S.drag;
  if (!d || !d.started || d.ending) return;
  const dt = d.last ? Math.min(50, ts - d.last) : 16;
  d.last = ts;
  autoScroll(d, dt);
  reorderStep(d, ts);
  placeGhost(d);
  d.raf = requestAnimationFrame(tick);
}

// Scroll the list's scroll container when the pointer is within ~70px of its top / bottom edge (up to ~900 px/s).
function autoScroll(d, dt) {
  const sp = d.scroller;
  if (!sp) return;
  const r = sp.getBoundingClientRect();
  const zone = Math.min(70, r.height / 3);
  let v = 0;
  if (d.y < r.top + zone) v = -Math.min(1, (r.top + zone - d.y) / zone);
  else if (d.y > r.bottom - zone) v = Math.min(1, (d.y - (r.bottom - zone)) / zone);
  if (v) sp.scrollTop += Math.sign(v) * Math.max(1, Math.round(Math.abs(v) * 0.9 * dt));
}

// Moves the placeholder (the dragged card itself) to where the pointer is. Single column: swap past a neighbour once
// the pointer crosses its midline (stable even with cards of different heights); grid: swap when entering it.
function reorderStep(d, ts) {
  if (ts < d.lock) return; // let the previous slide finish: mid-animation rects would mislead the hit test
  const cards = cardEls();
  const others = cards.filter((c) => c !== d.card);
  if (!others.length) return;
  const pi = cards.indexOf(d.card);
  const pr = d.card.getBoundingClientRect();
  let before = null; // insert the placeholder before this node (null = at the end)
  let go = false;
  const hit = others.find((c) => {
    const r = c.getBoundingClientRect();
    return d.x >= r.left && d.x <= r.right && d.y >= r.top && d.y <= r.bottom;
  });
  if (hit) {
    const r = hit.getBoundingClientRect();
    const down = cards.indexOf(hit) > pi;
    const sameCol = Math.abs(r.left - pr.left) < 8;
    go = sameCol ? (down ? d.y > r.top + r.height / 2 : d.y < r.top + r.height / 2) : true;
    before = down ? hit.nextElementSibling : hit;
  } else {
    const rects = others.map((c) => c.getBoundingClientRect());
    if (d.y > Math.max(...rects.map((r) => r.bottom)) && d.card.nextElementSibling) { go = true; before = null; }
    else if (d.y < Math.min(...rects.map((r) => r.top)) && pi > 0) { go = true; before = others[0]; }
  }
  if (!go) return;
  // `before` may be the .empty/other non-card sibling or the placeholder itself: only act on a real change
  if (before === d.card || before === d.card.nextElementSibling) return;
  flip(() => S.list.insertBefore(d.card, before));
  d.lock = ts + 170;
}

function endDrag(d, apply) {
  if (d.ending) return;
  d.ending = true;
  S.list.removeEventListener("pointermove", d.move);
  S.list.removeEventListener("pointerup", d.up);
  S.list.removeEventListener("pointercancel", d.cancel);
  document.removeEventListener("keydown", d.key);
  try { S.list.releasePointerCapture(d.pid); } catch { /* ignore */ }
  cancelAnimationFrame(d.raf);
  if (!d.started) { S.drag = null; S.lastHtml = null; paint(); return; }
  const ids = cardEls().map((c) => c.dataset.id);
  const changed = apply && ids.join("|") !== d.before.join("|");
  const done = () => {
    d.ghost.remove();
    document.body.classList.remove("trk-dragging");
    S.list.classList.remove("dragging");
    for (const c of cardEls()) { c.style.transition = ""; c.style.transform = ""; }
    d.card.classList.remove("trk-src");
    S.drag = null; // paints below are no longer held back
    if (changed) commitOrder(ids, 0, false);
    else { S.lastHtml = null; paint(); }
  };
  if (apply && !reduceMotion()) { // glide the ghost into the gap, then swap it for the real card
    const r = d.card.getBoundingClientRect();
    d.ghost.style.transition = "transform 130ms ease-out";
    d.ghost.style.transform = `translate(${r.left - d.ox}px, ${r.top - d.oy}px)`;
    setTimeout(done, 140);
  } else {
    done();
  }
}
