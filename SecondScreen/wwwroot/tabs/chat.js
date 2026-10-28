// Chat widget: a read-only view of the game's chat.
//
// Data flow: the plugin keeps the last ~500 lines in memory (never on disk) and puts only a high-water mark, `chatSeq`, in every
// WebSocket payload. When that number moves we fetch GET /api/chat?since=<last seq> and append just the new lines. If the plugin was
// restarted (`epoch` changes, or chatSeq goes backwards) the local list is thrown away and refetched. The widget only runs while it is
// visible; when it comes back it simply catches up from the last seq it saw.
//
// Read-only on purpose. Replying from the dashboard is a possible future feature (it would need a send path in the plugin).
//
// Layout is CSS driven: .wbody[data-size="compact"] switches rows to a two-line form for narrow panels.

import { esc } from "../js/util.js";
import { icon } from "../js/icons.js";

const MAX_LINES = 500;

// Approximate in-game chat colours.
const COLORS = {
  say: "#f4f4f4", shout: "#ffa666", yell: "#ffff4d", party: "#66e5ff", alliance: "#ff8f2e", fc: "#abdbe5",
  tellin: "#ff7de6", tellout: "#ff7de6", novice: "#d4ff7d", emote: "#bafff0", echo: "#cfcfcf", system: "#b9b9ff", other: "#9aa0b2",
  ls: "#d9a441", cwls: "#d9a441",
};
const colorOf = (ch) => COLORS[ch] || COLORS[ch.replace(/\d+$/, "")] || COLORS.other;

const SHORT = { say: "Say", shout: "Shout", yell: "Yell", party: "Party", alliance: "Alliance", fc: "FC", tellin: "Tell", tellout: "Tell", novice: "NN", emote: "Emote", echo: "Echo", system: "System", other: "Other" };
const shortOf = (ch) => SHORT[ch] || (/^ls\d$/.test(ch) ? `LS${ch.slice(2)}` : /^cwls\d$/.test(ch) ? `CWLS${ch.slice(4)}` : ch);

const range = (p) => Array.from({ length: 8 }, (_, i) => `${p}${i + 1}`);
const FILTERS = [
  { id: "say", label: "Say", members: ["say"] },
  { id: "shout", label: "Shout", members: ["shout"] },
  { id: "yell", label: "Yell", members: ["yell"] },
  { id: "tell", label: "Tells", members: ["tellin", "tellout"], color: COLORS.tellin },
  { id: "party", label: "Party", members: ["party"] },
  { id: "alliance", label: "Alliance", members: ["alliance"] },
  { id: "fc", label: "FC", members: ["fc"] },
  { id: "ls", label: "LS", members: range("ls"), color: COLORS.ls },
  { id: "cwls", label: "CWLS", members: range("cwls"), color: COLORS.cwls },
  { id: "novice", label: "NN", members: ["novice"] },
  { id: "emote", label: "Emote", members: ["emote"] },
  { id: "echo", label: "Echo", members: ["echo"] },
  { id: "system", label: "System", members: ["system"] },
  { id: "other", label: "Other", members: ["other"] },
];
const FILTER_OF = new Map();
for (const f of FILTERS) for (const m of f.members) FILTER_OF.set(m, f.id);
const filterOf = (ch) => FILTER_OF.get(ch) || "other";

const CSS = `
.chat { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.chat button, .chat input { font: inherit; color: inherit; touch-action: manipulation; }
.chat-top { flex: none; position: relative; }
.chat-top input { width: 100%; height: 38px; padding: 0 36px 0 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel2);
  color: var(--text); font-size: 1rem; -webkit-appearance: none; appearance: none; margin: 0; }
.chat-top input::-webkit-search-cancel-button { display: none; }
.chat-top input:focus { outline: 2px solid var(--accent-line); outline-offset: 1px; }
.chat-clear { position: absolute; right: 2px; top: 2px; width: 34px; height: 34px; border: 0; background: none; color: var(--muted); font-size: 1.3rem; cursor: pointer; }
.chat-chips { flex: none; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; margin: 0 -8px; padding: 0 8px 2px; }
.chat-chips::-webkit-scrollbar { display: none; }
.chat-chip { --c: var(--accent); flex: none; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px 0 9px; border-radius: 99px;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); font-size: .78rem; font-weight: 600; cursor: pointer; white-space: nowrap; }
.chat-chip i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; opacity: .75; }
.chat-chip[aria-pressed="true"] { color: var(--text); border-color: var(--c); background: color-mix(in srgb, var(--c) 18%, transparent); }
.chat-chip[aria-pressed="true"] i { opacity: 1; }
.chat-chip.all { padding: 0 12px; }
.chat-chip.all[aria-pressed="true"] { --c: var(--accent); }
@media (pointer: coarse) { .chat-chip { height: 36px; } .chat-top input { height: 42px; } }

.chat-wrap { position: relative; flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
.chat-log { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 2px 2px 4px;
  scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .18) transparent; }
.cm { --c: #fff; display: block; padding: 2px 6px 2px 8px; border-left: 3px solid transparent; font-size: .86rem; line-height: 1.38; overflow-wrap: anywhere; border-radius: 4px; }
.cm + .cm { margin-top: 1px; }
.cm:nth-child(even) { background: rgba(255, 255, 255, .02); }
.cm-t { color: var(--faint); font-size: .72rem; margin-right: 6px; font-variant-numeric: tabular-nums; }
.cm-ch { display: inline-block; min-width: 2.2em; margin-right: 6px; padding: 0 5px; border-radius: 5px; font-size: .66rem; font-weight: 700; letter-spacing: .03em;
  text-transform: uppercase; text-align: center; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); vertical-align: 1px; }
.cm-s { color: var(--c); font-weight: 650; }
.cm-s small { font-weight: 500; opacity: .6; font-size: .8em; }
.cm-s::after { content: ": "; font-weight: 400; }
.cm-x { color: var(--c); white-space: pre-wrap; }
.cm mark { background: rgba(224, 169, 61, .35); color: inherit; border-radius: 3px; padding: 0 1px; }
.cm.emote .cm-s::after, .cm.nosender .cm-s::after { content: " "; }
.cm.system .cm-x, .cm.other .cm-x { opacity: .88; }
.cm.tell { border-left-color: var(--c); background: color-mix(in srgb, var(--c) 9%, transparent) !important; }
.cm.tell .cm-ch { background: var(--c); color: #1a0716; }
.cm.tell .cm-x { color: #ffd5f6; }
.chat-empty { margin: auto; text-align: center; color: var(--muted); padding: 24px 12px; font-size: .88rem; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.chat-pill { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); display: none; align-items: center; gap: 6px; height: 34px; padding: 0 14px;
  border-radius: 99px; border: 1px solid var(--accent-line); background: var(--panel2); color: var(--accent); font-size: .82rem; font-weight: 650;
  box-shadow: 0 8px 22px rgba(0, 0, 0, .5); cursor: pointer; z-index: 3; }
.chat-pill.show { display: inline-flex; }
@media (pointer: coarse) { .chat-pill { height: 40px; } }

/* compact: two-line rows, no pill-width tags */
.wbody[data-size="compact"] .cm { padding: 3px 4px 3px 7px; font-size: .84rem; }
.wbody[data-size="compact"] .cm-t { margin-right: 4px; }
.wbody[data-size="compact"] .cm-ch { min-width: 0; margin-right: 4px; padding: 0 4px; font-size: .62rem; }
.wbody[data-size="compact"] .cm-x { display: block; }
.wbody[data-size="compact"] .cm-s::after { content: ""; }
.wbody[data-size="compact"] .cm.nosender .cm-x, .wbody[data-size="compact"] .cm.emote .cm-x { display: inline; }
.wbody[data-size="compact"] .chat-chip { height: 28px; padding: 0 9px 0 8px; font-size: .74rem; }
`;

/** One independent widget instance (docked panel or floating window): every instance gets its own state `S` and timers. Shared
 *  caches (market.js) stay module-level. The body below only moved into this closure (review with `git diff -w`). */
export function create() {
  let S = null;

  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  function loadFilter() {
    try {
      const a = JSON.parse(store.get("ss.chat.filter", "[]"));
      return new Set(Array.isArray(a) ? a.filter((id) => FILTERS.some((f) => f.id === id)) : []);
    } catch { return new Set(); }
  }

  const pad = (n) => String(n).padStart(2, "0");
  const timeText = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  // ---- model -> DOM ----------------------------------------------------------------------------------------------------------------

  function matches(m) {
    if (S.filter.size && !S.filter.has(filterOf(m.ch))) return false;
    if (S.query && !m.lower.includes(S.query)) return false;
    return true;
  }

  function highlight(text) {
    if (!S.query) return esc(text);
    const lower = text.toLowerCase();
    let out = "", i = 0;
    for (;;) {
      const j = lower.indexOf(S.query, i);
      if (j < 0 || !S.query) break;
      out += esc(text.slice(i, j)) + "<mark>" + esc(text.slice(j, j + S.query.length)) + "</mark>";
      i = j + S.query.length;
    }
    return out + esc(text.slice(i));
  }

  function rowEl(m) {
    const el = document.createElement("div");
    const kind = m.ch === "tellin" || m.ch === "tellout" ? "tell" : m.ch === "emote" ? "emote" : m.ch === "system" || m.ch === "other" ? m.ch : "";
    const speaker = m.sender && m.ch !== "system" && m.ch !== "other" && m.ch !== "echo";
    el.className = `cm${kind ? " " + kind : ""}${speaker ? "" : " nosender"}`;
    el.style.setProperty("--c", colorOf(m.ch));
    let who = "";
    if (speaker) {
      const name = esc(m.sender) + (m.world ? `<small>@${esc(m.world)}</small>` : "");
      who = `<span class="cm-s">${m.ch === "tellin" ? "" : m.ch === "tellout" ? "To " : ""}${name}</span>`;
    }
    let tag = esc(shortOf(m.ch));
    if (m.ch === "tellin") tag = "Tell ←";
    else if (m.ch === "tellout") tag = "Tell →";
    el.innerHTML = `<span class="cm-t">${timeText(m.ts)}</span><span class="cm-ch">${tag}</span>${who}<span class="cm-x">${highlight(m.text)}</span>`;
    return el;
  }

  function showPill() {
    S.pill.classList.toggle("show", S.unseen > 0);
    S.pill.textContent = `New messages ↓${S.unseen > 1 ? ` (${S.unseen})` : ""}`;
    S.ctx.setBadge(S.unseen > 0 ? String(S.unseen > 99 ? "99+" : S.unseen) : "");
  }

  const atBottom = () => S.log.scrollHeight - S.log.scrollTop - S.log.clientHeight < 28;

  function pin() {
    S.log.scrollTop = S.log.scrollHeight;
    S.unseen = 0;
    showPill();
  }

  function emptyHtml() {
    if (S.error && !S.loaded) return `${icon("chat", "big")}<div>${S.noEndpoint ? "This plugin build has no chat support yet.<br>Update SecondScreen to see the game chat here." : `Couldn't load the chat (${esc(S.error)}). Retrying...`}</div>`;
    if (!S.loaded) return `${icon("chat", "big")}<div>Loading chat...</div>`;
    if (!S.msgs.length) return `${icon("chat", "big")}<div>No chat yet.<br>New messages show up here as they arrive in game.</div>`;
    return `${icon("chat", "big")}<div>No messages match the current filter.</div>`;
  }

  /** Rebuild the visible list from the model (filter / search changes, first load). */
  function renderAll() {
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const m of S.msgs) if (matches(m)) { frag.append(rowEl(m)); n++; }
    S.shown = n;
    if (n === 0) {
      const e = document.createElement("div");
      e.className = "chat-empty";
      e.innerHTML = emptyHtml();
      frag.append(e);
    }
    S.log.replaceChildren(frag);
    S.stick = true;
    pin();
  }

  /** Append freshly fetched lines without touching the rest of the DOM. */
  function appendNew(fresh) {
    const vis = fresh.filter(matches);
    if (S.shown === 0) { // the empty-state node (if any) goes away on the first visible line
      if (vis.length) { S.log.replaceChildren(); } else { return; }
    }
    const wasBottom = S.stick;
    const frag = document.createDocumentFragment();
    for (const m of vis) frag.append(rowEl(m));
    S.log.append(frag);
    S.shown += vis.length;
    while (S.shown > MAX_LINES && S.log.firstElementChild) { S.log.firstElementChild.remove(); S.shown--; }
    if (wasBottom) pin();
    else { S.unseen += vis.length; showPill(); }
  }

  function renderChips() {
    const all = S.filter.size === 0;
    S.chips.querySelectorAll("[data-f]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === "all" ? all : S.filter.has(b.dataset.f))));
  }

  // ---- data ----------------------------------------------------------------------------------------------------------------------------

  async function fetchChat() {
    if (S.fetching) return;
    S.fetching = true;
    try {
      const since = S.lastSeq > 0 ? S.lastSeq : 0;
      const r = await fetch(S.ctx.withToken(`/api/chat?since=${since}`), { cache: "no-store" });
      if (r.status === 404) S.noEndpoint = true;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      S.error = ""; S.noEndpoint = false;
      const first = !S.loaded;
      S.loaded = true;
      let reset = false;
      if (S.epoch !== null && d.epoch !== S.epoch) { S.msgs = []; S.lastSeq = 0; reset = true; } // plugin restarted: start over
      S.epoch = d.epoch;
      const fresh = [];
      for (const m of d.messages || []) {
        if (m.seq <= S.lastSeq) continue;
        m.lower = `${m.text} ${m.sender || ""}`.toLowerCase();
        S.msgs.push(m);
        fresh.push(m);
      }
      S.lastSeq = d.seq;
      if (S.msgs.length > MAX_LINES) S.msgs.splice(0, S.msgs.length - MAX_LINES);
      if (first || reset) renderAll();
      else if (fresh.length) appendNew(fresh);
    } catch (e) {
      S.error = e.message || String(e);
      S.retryAt = Date.now() + 5000;
      if (!S.loaded) { S.log.innerHTML = `<div class="chat-empty">${emptyHtml()}</div>`; }
    } finally {
      S.fetching = false;
      S.retryAt = Math.max(S.retryAt, Date.now() + 250);
    }
  }

  // ---- widget contract -------------------------------------------------------------------------------------------------------------------

  function mount(el, ctx) {
    if (!document.getElementById("chat-style")) {
      const st = document.createElement("style");
      st.id = "chat-style";
      st.textContent = CSS;
      document.head.append(st);
    }
    el.innerHTML = `
    <div class="chat">
      <div class="chat-top"><input type="search" placeholder="Search chat" aria-label="Search chat" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button" class="chat-clear" aria-label="Clear search" hidden>×</button></div>
      <div class="chat-chips" role="group" aria-label="Channels"><button type="button" class="chat-chip all" data-f="all" aria-pressed="true">All</button>${FILTERS.map((f) =>
        `<button type="button" class="chat-chip" data-f="${f.id}" aria-pressed="false" style="--c:${f.color || COLORS[f.id] || COLORS.other}"><i></i>${f.label}</button>`).join("")}</div>
      <div class="chat-wrap"><div class="chat-log" role="log" aria-live="off" aria-label="Chat"></div><button type="button" class="chat-pill" aria-label="Jump to the newest messages"></button></div>
    </div>`;
    const root = el.querySelector(".chat");
    S = {
      ctx, root,
      input: root.querySelector("input"), clear: root.querySelector(".chat-clear"), chips: root.querySelector(".chat-chips"),
      log: root.querySelector(".chat-log"), pill: root.querySelector(".chat-pill"),
      filter: loadFilter(), query: "", msgs: [], shown: 0, unseen: 0, stick: true,
      lastSeq: -1, epoch: null, loaded: false, fetching: false, retryAt: 0, error: "", noEndpoint: false, searchTimer: 0,
    };

    root.addEventListener("click", (e) => {
      const chip = e.target.closest(".chat-chip");
      if (chip) {
        const id = chip.dataset.f;
        if (id === "all") S.filter.clear();
        else if (S.filter.has(id)) S.filter.delete(id);
        else S.filter.add(id);
        store.set("ss.chat.filter", JSON.stringify([...S.filter]));
        renderChips();
        renderAll();
      } else if (e.target.closest(".chat-clear")) {
        S.input.value = ""; S.query = ""; S.clear.hidden = true; renderAll(); S.input.focus();
      } else if (e.target.closest(".chat-pill")) {
        pin();
      }
    });
    S.input.addEventListener("input", () => {
      S.clear.hidden = !S.input.value;
      clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(() => { S.query = S.input.value.trim().toLowerCase(); renderAll(); }, 140);
    });
    S.input.addEventListener("keydown", (e) => { if (e.key === "Enter") S.input.blur(); });
    S.log.addEventListener("scroll", () => {
      S.stick = atBottom();
      if (S.stick && S.unseen) { S.unseen = 0; showPill(); }
    }, { passive: true });

    renderChips();
    S.log.innerHTML = `<div class="chat-empty">${emptyHtml()}</div>`;
  }

  function update(payload) {
    if (!S) return;
    const seq = payload.chatSeq;
    if (seq === undefined) { // older plugin build without the chat feed: probe the endpoint once
      if (!S.loaded && !S.noEndpoint && !S.fetching && Date.now() >= S.retryAt) fetchChat();
      return;
    }
    if (S.stick && S.log.scrollHeight - S.log.clientHeight > 0 && !atBottom()) pin(); // re-attached panels lose their scroll position
    if (seq !== S.lastSeq && !S.fetching && Date.now() >= S.retryAt) {
      if (seq < S.lastSeq) { S.lastSeq = 0; S.epoch = null; S.msgs = []; S.loaded = false; } // server restarted
      fetchChat();
    }
  }

  function resize() {
    if (S && S.stick) pin();
  }

  function unmount() {
    if (!S) return;
    clearTimeout(S.searchTimer);
    S = null;
  }

  return { mount, update, resize, unmount };
}
