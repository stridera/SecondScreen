// Dashboard: renders the layout (columns of stacked panels) or the tab UI, and implements edit mode
// (add / remove columns and panels, pointer-based drag and drop, splitters).
//
// Panels (Widget.panel) are persistent elements: every re-render only rebuilds the column / splitter scaffolding
// and re-parents the panels, so widget DOM and state survive layout changes.

import {
  BREAKPOINT, MIN_COL_PX, MIN_PANEL_PX, MAX_COLUMNS, SPLIT_PX, PRESETS, presetById, clone, orientationOf, autoPresetId,
  normalizeLayout, placedIds, removePanel, movePanel, addPanel, addColumn, removeColumn, pruneEmpty, loadSlot, saveSlot, clearSlot,
} from "./layout.js";
import { DEFS } from "./widgets.js";
import { h, clamp, openPopover, closePopover, toast } from "./ui.js";
import { icon } from "./icons.js";

const DEF_BY_ID = new Map(DEFS.map((d) => [d.id, d]));

export class Dashboard {
  /**
   * @param {{stage: HTMLElement, nav: HTMLElement, widgets: Map<string, import("./widgets.js").Widget>}} o
   */
  constructor({ stage, nav, widgets }) {
    this.stage = stage;
    this.nav = nav;
    this.widgets = widgets;
    this.payload = { snapshot: null, ipc: {}, trackers: [] };
    this.edit = false;
    this.cur = null;                 // { slot, preset, layout, auto, tabs, forced, key }
    this.visible = new Set();
    this.dash = null;
    this.tab = localStorage.getItem("ss.tab");
    if (!widgets.has(this.tab)) this.tab = "party";
    this.listeners = new Set();
    this.dirty = true;
    this.relayoutQueued = false;

    this.buildNav();
    this.bindStage();
    const queue = () => {
      if (this.relayoutQueued) return;
      this.relayoutQueued = true;
      requestAnimationFrame(() => { this.relayoutQueued = false; this.refresh(); });
    };
    window.addEventListener("resize", queue);
    window.addEventListener("orientationchange", queue);
    this.refresh(true);
  }

  onState(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  // ---- state resolution ------------------------------------------------------------------------

  resolve() {
    const w = window.innerWidth, hh = window.innerHeight;
    const slot = orientationOf(w, hh);
    const forced = w < BREAKPOINT;
    const stored = loadSlot(slot);
    let preset, layout;
    if (stored) { preset = stored.preset; layout = stored.layout; }
    else { preset = autoPresetId(w, hh); layout = normalizeLayout(presetById(preset).layout); }
    const tabs = forced || layout.tabs;
    return { slot, preset, layout, auto: !stored, tabs, forced, key: `${slot}|${forced}|${stored ? "s" : preset}` };
  }

  /** Re-evaluate responsive state (rotation, breakpoint). Cheap no-op when nothing relevant changed. */
  refresh(force = false) {
    const next = this.resolve();
    if (!force && this.cur && next.key === this.cur.key) return;
    if (this.edit && next.tabs) this.edit = false;
    // While editing we own the working copy; keep it unless the slot changed.
    if (!force && this.cur && this.edit && next.slot === this.cur.slot && !next.tabs) { this.cur.key = next.key; return; }
    this.cur = next;
    this.render();
  }

  persist() {
    const c = this.cur;
    saveSlot(c.slot, { preset: c.preset, layout: c.layout });
    c.auto = false;
    c.key = `${c.slot}|${c.forced}|s`;
  }

  commit(layout, preset = "custom") {
    this.cur.layout = layout;
    this.cur.preset = preset;
    this.cur.tabs = this.cur.forced || layout.tabs;
    this.persist();
    this.render();
  }

  // ---- public actions --------------------------------------------------------------------------

  setPayload(p) { this.payload = p; this.dirty = true; }

  /** Called once per animation frame by main. */
  tick() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const w of this.visible) w.update(this.payload);
  }

  setEdit(on) {
    if (on === this.edit) return;
    if (on && this.cur.tabs) return;
    closePopover();
    this.edit = on;
    if (!on) {
      this.cur.layout = pruneEmpty(this.cur.layout);
      this.persist(); // leaving edit mode saves
    }
    this.render();
  }

  applyPreset(id) {
    const p = presetById(id);
    if (!p) return;
    closePopover();
    this.edit = false;
    this.commit(normalizeLayout(p.layout), id);
  }

  applyImported(raw) {
    const layout = normalizeLayout(raw); // throws with a readable message
    this.edit = false;
    this.commit(layout, "custom");
  }

  resetSlot() {
    clearSlot(this.cur.slot);
    this.edit = false;
    this.refresh(true);
  }

  currentLayout() { return this.cur.layout; }

  // ---- rendering -------------------------------------------------------------------------------

  render() {
    closePopover();
    this.stage.replaceChildren();
    this.visible.clear();
    this.dash = null;
    const tabs = this.cur.tabs;
    document.body.classList.toggle("is-tabs", tabs);
    document.body.classList.toggle("is-editing", this.edit);
    this.nav.hidden = !tabs;
    if (tabs) this.renderTabs(); else this.renderGrid();
    for (const w of this.visible) w.show(this.payload);
    this.emit();
  }

  buildNav() {
    this.nav.innerHTML = DEFS.map((d) =>
      `<button type="button" role="tab" data-tab="${d.id}">${icon(d.icon)}<span>${d.title}</span></button>`).join("");
    this.nav.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-tab]");
      if (!b || b.dataset.tab === this.tab) return;
      this.tab = b.dataset.tab;
      localStorage.setItem("ss.tab", this.tab);
      this.render();
    });
  }

  renderTabs() {
    for (const b of this.nav.querySelectorAll("button")) {
      const on = b.dataset.tab === this.tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    }
    const w = this.widgets.get(this.tab);
    w.panel.style.flex = "";
    const pane = h("div", "tabpane");
    pane.append(w.panel);
    this.stage.append(pane);
    this.visible.add(w);
  }

  renderGrid() {
    const L = this.cur.layout;
    const dash = h("div", `dash${this.edit ? " editing" : ""}`);
    this.dash = dash;
    this.colSum = L.columns.reduce((a, c) => a + c.widthFr, 0) || 1;
    L.columns.forEach((col, ci) => {
      dash.append(this.makeVSplit(ci, ci === 0));
      dash.append(this.makeColumn(col, ci));
    });
    dash.append(this.makeVSplit(L.columns.length, true));
    this.stage.append(dash);
  }

  makeVSplit(i, edge) {
    const s = h("div", `vsplit${edge ? ` edge ${i === 0 ? "first" : "last"}` : ""}`);
    s.dataset.i = String(i);
    s.innerHTML = `<span class="s-grip"></span><button type="button" class="s-add" data-act="add-col" data-i="${i}" title="Add a column here" aria-label="Add column">${icon("plus")}</button>`;
    return s;
  }

  makeColumn(col, ci) {
    const el = h("div", "col");
    el.dataset.ci = String(ci);
    // flex-grow values must sum to >= 1 or the row would not fill; weights are normalised at render time only.
    el.style.flex = `${col.widthFr / this.colSum} 1 0px`;
    const panelSum = col.panels.reduce((a, p) => a + p.heightFr, 0) || 1;
    if (this.edit) {
      const n = this.cur.layout.columns.length;
      const strip = h("div", "col-strip");
      strip.innerHTML = `<span class="cs-label">Column ${ci + 1}</span><span class="ph-sp"></span>
        <button type="button" class="chip" data-act="add-panel" data-ci="${ci}">${icon("plus")}<span>Panel</span></button>
        <button type="button" class="chip danger" data-act="del-col" data-ci="${ci}" title="Remove column"${n < 2 ? " disabled" : ""} aria-label="Remove column">${icon("x")}</button>`;
      el.append(strip);
    }
    if (col.panels.length === 0) el.append(h("div", "col-empty", "Empty column.<br>Drop a panel here or tap + Panel."));
    col.panels.forEach((p, pi) => {
      if (pi) {
        const s = h("div", "hsplit");
        s.dataset.ci = String(ci); s.dataset.pi = String(pi);
        s.innerHTML = `<span class="s-grip"></span>`;
        el.append(s);
      }
      const w = this.widgets.get(p.widget);
      w.panel.style.flex = `${p.heightFr / panelSum} 1 0px`;
      el.append(w.panel);
      this.visible.add(w);
    });
    return el;
  }

  // ---- edit-mode interactions --------------------------------------------------------------------

  bindStage() {
    this.stage.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || !this.edit || b.disabled) return;
      const act = b.dataset.act;
      if (act === "remove") this.commit(removePanel(this.cur.layout, b.closest(".panel").dataset.widget));
      else if (act === "del-col") this.commit(removeColumn(this.cur.layout, Number(b.dataset.ci)));
      else if (act === "add-col") this.addColumnAt(Number(b.dataset.i));
      else if (act === "add-panel") this.pickPanel(b, Number(b.dataset.ci));
    });
    this.stage.addEventListener("pointerdown", (e) => {
      if (!this.edit || !this.dash) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const split = e.target.closest(".vsplit:not(.edge), .hsplit");
      if (split && !e.target.closest("button")) { this.startSplit(e, split); return; }
      const head = e.target.closest(".panel-head");
      if (head && !e.target.closest("button")) this.startDrag(e, head);
    });
  }

  addColumnAt(index) {
    const L = this.cur.layout;
    const room = Math.floor((this.stage.clientWidth - SPLIT_PX) / (MIN_COL_PX + SPLIT_PX));
    if (L.columns.length >= MAX_COLUMNS || L.columns.length + 1 > room) { toast("No room for another column on this screen."); return; }
    this.commit(addColumn(L, index));
  }

  /** Toolbar entry point: append a column on the right. */
  addColumnEnd() { if (this.edit) this.addColumnAt(this.cur.layout.columns.length); }

  pickPanel(anchor, ci) {
    const placed = placedIds(this.cur.layout);
    const list = h("div", "menu");
    const free = DEFS.filter((d) => !placed.has(d.id));
    if (!free.length) list.append(h("div", "menu-note", "Every panel is already on screen."));
    for (const d of free) {
      const b = h("button", "menu-item", `${icon(d.icon)}<span>${d.title}</span>`);
      b.type = "button";
      b.addEventListener("click", () => { closePopover(); this.commit(addPanel(this.cur.layout, d.id, ci)); });
      list.append(b);
    }
    openPopover(anchor, list, { align: "start" });
  }

  // Splitters: resize the two neighbours, conserving their combined fr weight.
  startSplit(e, split) {
    const horiz = split.classList.contains("vsplit");   // vertical bar => columns change width
    const a = split.previousElementSibling, b = split.nextElementSibling;
    if (!a || !b) return;
    e.preventDefault();
    const dim = horiz ? "width" : "height";
    const sa = a.getBoundingClientRect()[dim], sb = b.getBoundingClientRect()[dim];
    const total = sa + sb;
    const min = Math.min(horiz ? MIN_COL_PX : MIN_PANEL_PX, total / 2);
    // Work in model units (fr weights); the rendered flex-grow is weight / sibling sum.
    const L0 = this.cur.layout;
    const ci0 = Number(split.dataset.ci), pi0 = Number(split.dataset.pi), i0 = Number(split.dataset.i);
    const items = horiz ? L0.columns : L0.columns[ci0].panels;
    const key = horiz ? "widthFr" : "heightFr";
    const ia = horiz ? i0 - 1 : pi0 - 1;
    const frTotal = items[ia][key] + items[ia + 1][key];
    const S = items.reduce((acc, x) => acc + x[key], 0) || 1;
    const fa = items[ia][key];
    const start = horiz ? e.clientX : e.clientY;
    const id = e.pointerId;
    split.setPointerCapture(id);
    split.classList.add("active");
    document.body.classList.add("resizing", horiz ? "rs-col" : "rs-row");
    let nfa = fa;
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      const d = clamp((horiz ? ev.clientX : ev.clientY) - start, min - sa, sb - min);
      nfa = frTotal * (sa + d) / total;
      a.style.flexGrow = String(nfa / S);
      b.style.flexGrow = String((frTotal - nfa) / S);
    };
    const end = () => {
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", end);
      split.removeEventListener("pointercancel", end);
      split.classList.remove("active");
      document.body.classList.remove("resizing", "rs-col", "rs-row");
      const L = clone(this.cur.layout);
      const r3 = (v) => Math.round(v * 1000) / 1000;
      if (horiz) {
        const i = Number(split.dataset.i);
        L.columns[i - 1].widthFr = r3(nfa); L.columns[i].widthFr = r3(frTotal - nfa);
      } else {
        const col = L.columns[Number(split.dataset.ci)], pi = Number(split.dataset.pi);
        col.panels[pi - 1].heightFr = r3(nfa); col.panels[pi].heightFr = r3(frTotal - nfa);
      }
      this.cur.layout = L;
      this.cur.preset = "custom";
      this.persist();
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", end);
    split.addEventListener("pointercancel", end);
  }

  // Drag a panel by its header. Pointer Events + capture => works with mouse, pen and iPad touch.
  startDrag(e, head) {
    const panel = head.closest(".panel");
    const id = panel.dataset.widget;
    const id_ = e.pointerId, sx = e.clientX, sy = e.clientY;
    let dragging = false, ghost = null, target = null, line = null;
    try { head.setPointerCapture(id_); } catch { /* ignore */ }

    const clear = () => {
      line?.remove(); line = null;
      this.dash?.querySelectorAll(".drop-hot").forEach((n) => n.classList.remove("drop-hot"));
    };
    const show = (t) => {
      clear();
      if (!t) return;
      const dr = this.dash.getBoundingClientRect();
      line = h("div", "drop-line");
      if (t.kind === "newcol") {
        const r = t.el.getBoundingClientRect();
        t.el.classList.add("drop-hot");
        line.classList.add("v");
        line.style.cssText = `left:${r.left + r.width / 2 - 2 - dr.left}px;top:0;height:${dr.height}px`;
      } else {
        t.el.classList.add("drop-hot");
        const cr = t.el.getBoundingClientRect();
        let y;
        if (!t.panels.length) y = null;
        else if (t.index < t.panels.length) y = t.panels[t.index].getBoundingClientRect().top - SPLIT_PX / 2;
        else y = t.panels[t.panels.length - 1].getBoundingClientRect().bottom + SPLIT_PX / 2;
        if (y === null) { line = null; return; }
        line.style.cssText = `left:${cr.left + 6 - dr.left}px;width:${cr.width - 12}px;top:${y - 2 - dr.top}px`;
      }
      this.dash.append(line);
    };

    const move = (ev) => {
      if (ev.pointerId !== id_) return;
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true;
        panel.classList.add("drag-src");
        document.body.classList.add("dragging");
        ghost = h("div", "drag-ghost", `${icon(DEF_BY_ID.get(id).icon)}<span>${DEF_BY_ID.get(id).title}</span>`);
        document.body.append(ghost);
      }
      ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
      target = this.hitTest(ev.clientX, ev.clientY);
      show(target);
    };
    const finish = (apply) => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", cancel);
      try { head.releasePointerCapture(id_); } catch { /* ignore */ }
      clear();
      ghost?.remove();
      panel.classList.remove("drag-src");
      document.body.classList.remove("dragging");
      if (dragging && apply && target) this.applyDrop(id, target);
    };
    const up = (ev) => { if (ev.pointerId === id_) finish(true); };
    const cancel = (ev) => { if (ev.pointerId === id_) finish(false); };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", cancel);
  }

  hitTest(x, y) {
    const dash = this.dash;
    if (!dash) return null;
    const dr = dash.getBoundingClientRect();
    if (y < dr.top || y > dr.bottom || x < dr.left || x > dr.right) return null;
    const maxed = this.cur.layout.columns.length >= MAX_COLUMNS;
    if (!maxed) {
      for (const s of dash.querySelectorAll(":scope > .vsplit")) {
        const r = s.getBoundingClientRect();
        if (x >= r.left - 6 && x <= r.right + 6) return { kind: "newcol", index: Number(s.dataset.i), el: s };
      }
    }
    for (const col of dash.querySelectorAll(":scope > .col")) {
      const r = col.getBoundingClientRect();
      if (x < r.left || x > r.right) continue;
      const panels = [...col.querySelectorAll(":scope > .panel")];
      let index = panels.length;
      for (let i = 0; i < panels.length; i++) {
        const pr = panels[i].getBoundingClientRect();
        if (y < pr.top + pr.height / 2) { index = i; break; }
      }
      return { kind: "insert", ci: Number(col.dataset.ci), index, el: col, panels };
    }
    return null;
  }

  applyDrop(id, t) {
    const before = JSON.stringify(this.cur.layout);
    const next = movePanel(this.cur.layout, id, t.kind === "newcol" ? { newCol: t.index } : { ci: t.ci, index: t.index });
    if (JSON.stringify(next) === before) return;
    this.commit(next);
  }
}
