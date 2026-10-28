// Widget registry + the Widget host that wraps each feature module in a persistent "panel" element.
//
// WIDGET CONTRACT (a module under tabs/ implements as many of these as it needs):
//
//   mount(el, ctx)      once, the first time the widget is shown. `el` is the widget body (a persistent element:
//                       the dashboard re-parents it between columns / tabs, so keep your DOM and state alive).
//   update(payload)     on every data push while visible, and once right after (re)attach. payload = {snapshot, ipc, trackers}.
//                       Keep it cheap and layout-stable (diff, do not rebuild).
//   resize({width,height,size})  optional; the body size changed. `size` is "compact" (<340px), "regular" or "wide"
//                       (>=640px). The same value is on `el.dataset.size`, so most widgets just use CSS:
//                       .wbody[data-size="compact"] { ... }.
//   unmount()           optional; page teardown only (widgets stay mounted while they are merely off screen).
//
//   ctx = { id, token(), withToken(path), setBadge(text) }   setBadge puts a small chip in the panel header.
//
// Registration below (id, title, icon, options). Older modules that only export `render(el, data)` (map, tracker) are
// wrapped by legacy(), so they need no changes: they mount lazily on first render and are re-rendered on resize.

import * as party from "../tabs/party.js";
import * as map from "../tabs/map.js";
import * as tracker from "../tabs/tracker.js";
import * as inventory from "../tabs/inventory.js";
import * as plugins from "../tabs/plugins.js";
import { icon } from "./icons.js";
import { h } from "./ui.js";

const token = () => localStorage.getItem("ss.token") || "";

/** Adapter for modules exposing the old `render(el, data)` contract. */
function legacy(mod, { rerenderOnResize = false } = {}) {
  let el = null;
  let last = null;
  return {
    mount(e) { el = e; },
    update(payload) { last = payload; mod.render(el, payload); },
    resize() { if (rerenderOnResize && last) mod.render(el, last); },
  };
}

export const DEFS = [
  { id: "party", title: "Party", icon: "users", mod: party,
    badge: (p) => { const s = p.snapshot; return s && s.loggedIn ? String((s.party || []).length || 1) : ""; } },
  { id: "map", title: "Map", icon: "map", mod: legacy(map, { rerenderOnResize: true }), fill: true },
  { id: "tracker", title: "Tracker", icon: "tracker", mod: legacy(tracker),
    badge: (p) => { const t = p.trackers || []; return t.length ? `${t.filter((x) => x.complete).length}/${t.length}` : ""; } },
  { id: "inventory", title: "Inventory", icon: "inventory", mod: inventory },
  { id: "plugins", title: "Plugins", icon: "plugins", mod: plugins,
    badge: (p) => { const n = Object.keys(p.ipc || {}).length; return n ? String(n) : ""; } },
];

export class Widget {
  constructor(def) {
    this.def = def;
    this.mod = def.mod;
    this.mounted = false;
    this.badgeText = "";

    this.panel = h("section", "panel");
    this.panel.dataset.widget = def.id;
    this.panel.innerHTML =
      `<header class="panel-head">
         <span class="ph-grip" aria-hidden="true">${icon("grip")}</span>
         <span class="ph-ico" aria-hidden="true">${icon(def.icon)}</span>
         <h2 class="ph-title">${def.title}</h2>
         <span class="ph-badge" hidden></span>
         <span class="ph-sp"></span>
         <button type="button" class="ph-x" data-act="remove" title="Remove panel" aria-label="Remove ${def.title} panel">${icon("x")}</button>
       </header>
       <div class="wbody${def.fill ? " fill" : ""}"></div>`;
    this.head = this.panel.querySelector(".panel-head");
    this.body = this.panel.querySelector(".wbody");
    this.badgeEl = this.panel.querySelector(".ph-badge");

    this.ctx = {
      id: def.id,
      token,
      withToken: (path) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token())}`,
      setBadge: (text) => this.setBadge(text),
    };

    this.ro = new ResizeObserver(() => this.onSize());
    this.ro.observe(this.body);
  }

  setBadge(text) {
    text = text || "";
    if (text === this.badgeText) return;
    this.badgeText = text;
    this.badgeEl.textContent = text;
    this.badgeEl.hidden = !text;
  }

  onSize() {
    const w = Math.round(this.body.clientWidth), hh = Math.round(this.body.clientHeight);
    if (!w || !hh || !this.mounted) return;
    const size = w < 340 ? "compact" : w < 640 ? "regular" : "wide";
    if (this.body.dataset.size !== size) this.body.dataset.size = size;
    try { this.mod.resize?.({ width: w, height: hh, size }); } catch (e) { console.error(`[${this.def.id}] resize`, e); }
  }

  /** Call after the panel is in the document. Mounts on first use, then pushes the latest payload. */
  show(payload) {
    if (!this.mounted) {
      this.mounted = true;
      const w = this.body.clientWidth;
      this.body.dataset.size = w && w < 340 ? "compact" : w < 640 ? "regular" : "wide";
      try { this.mod.mount?.(this.body, this.ctx); } catch (e) { console.error(`[${this.def.id}] mount`, e); }
    }
    this.update(payload);
    this.onSize();
  }

  update(payload) {
    try { this.mod.update?.(payload); } catch (e) { console.error(`[${this.def.id}] update`, e); }
    if (this.def.badge) this.setBadge(this.def.badge(payload));
  }

  unmount() {
    try { this.mod.unmount?.(); } catch (e) { console.error(`[${this.def.id}] unmount`, e); }
    this.ro.disconnect();
  }
}

export function createWidgets() {
  return new Map(DEFS.map((d) => [d.id, new Widget(d)]));
}
