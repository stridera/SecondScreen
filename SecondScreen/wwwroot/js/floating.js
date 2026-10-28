// Floating windows: any widget can be opened on top of the dashboard without touching the layout.
//
//   wide screens   a movable, resizable window (title bar: icon, title, Dock, maximize / restore, close)
//   tab mode       the same element is restyled (float.css, body.is-tabs) into a full-screen sheet that slides up;
//                  Back / the close button dismiss it (a history entry is pushed per sheet)
//
// Instances: a floating window hosts its OWN Widget (own mounted module instance, see the MULTIPLE INSTANCES note in
// widgets.js), so a widget can be docked and floating at once. A `single` widget (map) cannot, so its window borrows the
// dashboard's one Widget and is only allowed while that widget is not docked (Dashboard.openFloating enforces it, sync()
// closes the window if the widget gets docked later).
//
// Windows live in #float-layer (z-index 50): above the dashboard, below popovers (60), toasts (80) and every notification
// layer (150+), so a duty pop always covers them. Window state is plain DOM + this class; nothing re-renders on a layout change.

import { Widget, DEFS } from "./widgets.js";
import { h, clamp, isPopoverOpen } from "./ui.js";
import { icon } from "./icons.js";

const DEF_BY_ID = new Map(DEFS.map((d) => [d.id, d]));
const GEOM_KEY = "ss.float.geom";       // { [widgetId]: {x, y, w, h} }, per device (localStorage)
const MIN_W = 280, MIN_H = 200;
const SIZES = {                          // default window size per widget (w x h, px)
  party: { w: 380, h: 420 }, map: { w: 600, h: 500 }, tracker: { w: 440, h: 540 }, inventory: { w: 480, h: 580 },
  dailies: { w: 460, h: 580 }, chat: { w: 440, h: 500 }, character: { w: 600, h: 640 }, plugins: { w: 460, h: 460 },
};

function loadGeom() {
  try {
    const raw = JSON.parse(localStorage.getItem(GEOM_KEY) || "{}");
    const out = {};
    for (const [id, g] of Object.entries(raw || {})) {
      if (g && [g.x, g.y, g.w, g.h].every((n) => typeof n === "number" && isFinite(n))) out[id] = { x: g.x, y: g.y, w: g.w, h: g.h };
    }
    return out;
  } catch { return {}; }
}

const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

export class Floating {
  /** @param {import("./dashboard.js").Dashboard} dash */
  constructor(dash) {
    this.dash = dash;
    this.wins = new Map();     // widget id -> window record
    this.order = [];           // widget ids, back to front
    this.opener = null;        // the launcher button: focus returns to it when the last window closes
    this.geom = loadGeom();
    this.ignorePop = false;
    this.layer = h("div", "float-layer");
    this.layer.id = "float-layer";
    document.body.append(this.layer);

    const relayout = () => this.layoutAll();
    window.addEventListener("resize", relayout);
    window.addEventListener("orientationchange", relayout);
    document.addEventListener("keydown", (e) => this.onKey(e), true);
    window.addEventListener("popstate", () => this.onPop());
  }

  get tabs() { return !!(this.dash.cur && this.dash.cur.tabs); }
  has(id) { return this.wins.has(id); }
  get frontId() { return this.order[this.order.length - 1] || null; }
  /** Every Widget currently hosted by a window (the dashboard pushes data to these as well as to the docked ones). */
  widgets() { return [...this.wins.values()].map((w) => w.widget); }

  // ---- geometry --------------------------------------------------------------------------------

  /** The area windows must stay in: the viewport below the top bar. */
  bounds() {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const bar = document.querySelector(".topbar");
    const top = bar ? Math.min(Math.max(0, Math.ceil(bar.getBoundingClientRect().bottom)), Math.round(vh / 2)) : 0;
    return { x: 0, y: top, w: vw, h: Math.max(0, vh - top) };
  }

  clampRect(g, b = this.bounds()) {
    const w = clamp(g.w, Math.min(MIN_W, b.w), b.w), hh = clamp(g.h, Math.min(MIN_H, b.h), b.h);
    return { x: clamp(g.x, b.x, b.x + b.w - w), y: clamp(g.y, b.y, b.y + b.h - hh), w, h: hh };
  }

  defaultRect(id) {
    const b = this.bounds();
    const s = SIZES[id] || { w: 440, h: 540 };
    const n = this.wins.size;                      // cascade a little so stacked windows do not hide each other
    return { x: b.x + 72 + n * 32, y: b.y + 24 + n * 32, w: Math.min(s.w, b.w), h: Math.min(s.h, b.h) };
  }

  place(win) {
    const r = win.max ? this.bounds() : this.clampRect(win.rect);
    const st = win.el.style;
    st.left = `${r.x}px`; st.top = `${r.y}px`; st.width = `${r.w}px`; st.height = `${r.h}px`;
    win.el.classList.toggle("max", win.max);
  }

  layoutAll() {
    for (const win of this.wins.values()) { this.place(win); win.widget.onSize(); }
  }

  saveGeom(win) {
    this.geom[win.id] = round(this.clampRect(win.rect));
    try { localStorage.setItem(GEOM_KEY, JSON.stringify(this.geom)); } catch { /* storage full / private mode */ }
  }

  // ---- open / focus / close ------------------------------------------------------------------------

  open(id) {
    const def = DEF_BY_ID.get(id);
    if (!def) return null;
    const have = this.wins.get(id);
    if (have) { this.focus(id, true); return have; }

    const shared = !!def.single;
    const widget = shared ? this.dash.widgets.get(id) : new Widget(def, { floating: true });
    const el = h("div", "fwin");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", def.title);
    el.setAttribute("aria-modal", String(this.tabs));
    el.tabIndex = -1;
    el.dataset.widget = id;
    el.innerHTML =
      `<header class="fwin-head">
         <span class="ph-ico" aria-hidden="true">${icon(def.icon)}</span>
         <h2 class="ph-title">${def.title}</h2>
         <span class="ph-sp"></span>
         <button type="button" class="fwin-btn" data-fact="dock" title="Dock into the layout" aria-label="Dock ${def.title} into the layout">${icon("dock")}</button>
         <button type="button" class="fwin-btn" data-fact="max" title="Maximize" aria-label="Maximize ${def.title}">${icon("maximize")}</button>
         <button type="button" class="fwin-btn" data-fact="close" title="Close" aria-label="Close ${def.title}">${icon("x")}</button>
       </header>
       <div class="fwin-main"></div>
       ${["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => `<i class="fwin-rz" data-dir="${d}" aria-hidden="true"></i>`).join("")}`;

    const win = { id, def, widget, shared, el, max: false, hist: false, rect: this.geom[id] || this.defaultRect(id),
      maxBtn: el.querySelector('[data-fact="max"]') };
    this.wins.set(id, win);
    this.order.push(id);

    el.querySelector(".ph-title").after(widget.badgeEl); // the widget's header (hidden in a window) lends us its badge chip
    if (shared) widget.panel.style.flex = "";
    el.querySelector(".fwin-main").append(widget.panel);
    this.layer.append(el);
    this.bind(win);
    this.place(win);
    this.zorder();
    widget.show(this.dash.payload);   // after layout, so the widget measures a real size
    if (this.tabs) this.pushHist(win);
    el.focus({ preventScroll: true });
    return win;
  }

  /** Bring to front. `grab` also moves keyboard focus into the window. */
  focus(id, grab = false) {
    const win = this.wins.get(id);
    if (!win) return;
    if (this.frontId !== id) { this.order = this.order.filter((x) => x !== id); this.order.push(id); this.zorder(); }
    if (grab && !win.el.contains(document.activeElement)) win.el.focus({ preventScroll: true });
  }

  zorder() {
    this.order.forEach((id, i) => {
      const w = this.wins.get(id);
      w.el.style.zIndex = String(i + 1);
      w.el.classList.toggle("front", i === this.order.length - 1);
    });
  }

  close(id, { fromPop = false, refocus = true } = {}) {
    const win = this.wins.get(id);
    if (!win) return;
    this.wins.delete(id);
    this.order = this.order.filter((x) => x !== id);
    const { widget } = win;
    // Give the badge chip back to the widget's own header.
    widget.head.insertBefore(widget.badgeEl, widget.head.querySelector(".ph-sp"));
    if (win.shared) {
      // The one shared Widget lives on (mounted, off screen). If the dashboard already re-parented its panel into a column
      // (it just got docked), leave it there.
      if (win.el.contains(widget.panel)) widget.panel.remove();
    } else {
      widget.unmount();
    }
    win.el.remove();
    if (win.hist && !fromPop) {
      win.hist = false;
      if (history.state && history.state.ssFloat === id) { this.ignorePop = true; history.back(); }
    }
    this.zorder();
    if (!refocus) return;
    const next = this.frontId;
    if (next) this.focus(next, true);
    else if (this.opener && this.opener.isConnected && !this.opener.hidden) this.opener.focus({ preventScroll: true });
  }

  closeFront() { const id = this.frontId; if (id) this.close(id); }

  /** After every dashboard render: windows that can no longer exist (single widget now docked / tab mode) go away, modes sync. */
  sync() {
    const tabs = this.tabs;
    for (const win of [...this.wins.values()]) {
      if (win.shared && this.dash.isDocked(win.id)) this.close(win.id, { refocus: false });
    }
    for (const win of this.wins.values()) win.el.setAttribute("aria-modal", String(tabs));
    const front = this.wins.get(this.frontId);
    if (tabs && front) this.pushHist(front);
    this.layoutAll();
  }

  // ---- phone sheets: Back dismisses ----------------------------------------------------------------

  pushHist(win) {
    if (win.hist) return;
    win.hist = true;
    try { history.pushState({ ssFloat: win.id }, ""); } catch { win.hist = false; }
  }

  onPop() {
    if (this.ignorePop) { this.ignorePop = false; return; }
    if (!this.tabs) return;
    const win = this.wins.get(this.frontId);
    if (win && win.hist) { win.hist = false; this.close(win.id, { fromPop: true }); }
  }

  onKey(e) {
    if (e.key !== "Escape" || e.defaultPrevented || !this.order.length) return;
    // Anything more modal than a window gets the key first: menus, native dialogs, notification overlays and sheets.
    if (isPopoverOpen() || document.querySelector("dialog[open], .n-overlay, .n-sheet-wrap")) return;
    e.preventDefault();
    this.closeFront();
  }

  // ---- interaction -----------------------------------------------------------------------------

  bind(win) {
    const { el, id } = win;
    el.addEventListener("pointerdown", (e) => {
      this.focus(id);
      if (this.tabs || win.max || (e.pointerType === "mouse" && e.button !== 0)) return;
      const rz = e.target.closest(".fwin-rz");
      if (rz) { this.gesture(win, e, "resize", rz.dataset.dir, rz); return; }
      const head = e.target.closest(".fwin-head");
      if (head && !e.target.closest("button")) this.gesture(win, e, "move", "", head);
    }, true);
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-fact]");
      if (!b) return;
      const act = b.dataset.fact;
      if (act === "close") this.close(id);
      else if (act === "max") this.toggleMax(win);
      else if (act === "dock") this.dash.dock(id);
    });
    el.addEventListener("dblclick", (e) => {
      if (!this.tabs && e.target.closest(".fwin-head") && !e.target.closest("button")) this.toggleMax(win);
    });
  }

  toggleMax(win) {
    win.max = !win.max;
    const t = win.max ? "Restore" : "Maximize";
    win.maxBtn.innerHTML = icon(win.max ? "restore" : "maximize");
    win.maxBtn.title = t;
    win.maxBtn.setAttribute("aria-label", `${t} ${win.def.title}`);
    this.place(win);
    win.widget.onSize();
  }

  /** Pointer-event drag (mouse, pen, touch). kind: "move" | "resize" (dir = n|s|e|w|ne|nw|se|sw). */
  gesture(win, e, kind, dir, target) {
    e.preventDefault();
    const pid = e.pointerId, sx = e.clientX, sy = e.clientY;
    const b = this.bounds();
    const r0 = this.clampRect(win.rect, b);
    let moved = false;
    try { target.setPointerCapture(pid); } catch { /* ignore */ }
    document.body.classList.add("resizing", "fwin-gesture");
    win.el.classList.add("moving");

    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      if (kind === "move") {
        win.rect = { ...r0, x: clamp(r0.x + dx, b.x, b.x + b.w - r0.w), y: clamp(r0.y + dy, b.y, b.y + b.h - r0.h) };
      } else {
        const minW = Math.min(MIN_W, b.w), minH = Math.min(MIN_H, b.h);
        const r = { ...r0 };
        if (dir.includes("e")) r.w = clamp(r0.w + dx, minW, b.x + b.w - r0.x);
        if (dir.includes("s")) r.h = clamp(r0.h + dy, minH, b.y + b.h - r0.y);
        if (dir.includes("w")) { r.x = clamp(r0.x + dx, b.x, r0.x + r0.w - minW); r.w = r0.x + r0.w - r.x; }
        if (dir.includes("n")) { r.y = clamp(r0.y + dy, b.y, r0.y + r0.h - minH); r.h = r0.y + r0.h - r.y; }
        win.rect = r;
      }
      this.place(win);
    };
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      try { target.releasePointerCapture(pid); } catch { /* ignore */ }
      document.body.classList.remove("resizing", "fwin-gesture");
      win.el.classList.remove("moving");
      if (moved) { this.saveGeom(win); win.widget.onSize(); } // onSize => widget.resize({width,height,size})
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }
}
