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

import { esc, pct } from "../js/util.js";

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

function msqCardHtml(t) {
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
    ${iconHtml(t.iconId)}
    <div class="trk-main">
      ${titleHtml(t)}
      <div class="trk-kind">${esc(KINDS.msq.label)}</div>
      ${overall}${curBar}${nextLine}${off}${more}${list}
    </div>
    ${actionsHtml()}
  </div>`;
}

function questCardHtml(t) {
  const q = t.quest;
  const facts = q
    ? [`Lv ${q.level}`, q.expansion, q.genre].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")
    : `<span>${esc(t.detail)}</span>`;
  const place = q && q.placeName ? `<span>${esc(q.placeName)}</span>` : "";
  const off = t.live ? "" : `<span class="trk-off">${esc(t.detail)}</span>`;
  return `<div class="card trk-card${t.complete ? " complete" : ""}${t.live ? "" : " stale"}" data-id="${esc(t.id)}" title="${esc(t.detail)}">
    ${iconHtml(t.iconId)}
    <div class="trk-main">
      ${titleHtml(t)}
      <div class="trk-kind">${esc(KINDS.quest.label)}</div>
      <div class="trk-count${t.complete ? " done" : ""}">${t.complete ? "Done" : "Not done"}</div>
      <div class="trk-meta">${facts}${place}${off}</div>
    </div>
    ${actionsHtml()}
  </div>`;
}

function cardHtml(t) {
  if (t.kind === "msq") return msqCardHtml(t);
  if (t.kind === "quest") return questCardHtml(t);
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

  const refresh = t.kind === "achievement"
    ? `<button type="button" data-act="refresh" title="Refresh progress" aria-label="Refresh"${t.pending ? " disabled" : ""}>&#8635;</button>` : "";
  return `<div class="card trk-card${t.complete ? " complete" : ""}${t.live ? "" : " stale"}" data-id="${esc(t.id)}" title="${esc(t.detail)}">
    ${iconHtml(t.iconId)}
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

function mount(el) {
  el.dataset.done = "1";
  ensureStyle();
  el.innerHTML = `
    <div class="trk">
      <div class="trk-head"><h2>Trackers</h2><button type="button" class="trk-addbtn">+ Add</button></div>
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
    else if (b.dataset.act === "expand") {
      if (!S.expanded.delete(t.id)) S.expanded.add(t.id);
      S.lastHtml = null;
      paint();
    }
  });
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
      S.trackers = rows;
      paint();
    } catch { /* the WebSocket push will catch up */ }
  }, 350);
}

// ---- list ------------------------------------------------------------------------------------------------

function paint() {
  const html = S.trackers.length
    ? S.trackers.map(cardHtml).join("")
    : `<div class="empty">No trackers yet. Tap <b>+ Add</b> to track an item, a currency, an achievement, a quest or your Main Scenario progress.</div>`;
  if (html === S.lastHtml) return;
  S.lastHtml = html;
  S.list.innerHTML = html;
}

export function render(el, data) {
  if (!el.dataset.done || !S || !el.contains(S.root)) mount(el);
  if (data !== S.lastData) {
    S.lastData = data;
    if (data && Array.isArray(data.trackers)) S.trackers = data.trackers;
  }
  paint();
}
