// Widget registry + the Widget host that wraps each feature module in a persistent "panel" element.
//
// WIDGET CONTRACT (a module under tabs/ implements as many of these as it needs):
//
//   mount(el, ctx)      once, the first time the widget is shown. `el` is the widget body (a persistent element:
//                       the dashboard re-parents it between columns / tabs, so keep your DOM and state alive).
//   update(payload)     on every data push while visible, and once right after (re)attach. payload = {snapshot, ipc, trackers, live, chatSeq, characterVersion} (live = map markers, see map.js; the last two are change counters for chat.js / character.js).
//                       Keep it cheap and layout-stable (diff, do not rebuild).
//   resize({width,height,size})  optional; the body size changed. `size` is "compact" (<340px), "regular" or "wide"
//                       (>=640px). The same value is on `el.dataset.size`, so most widgets just use CSS:
//                       .wbody[data-size="compact"] { ... }.
//   unmount()           optional; the instance is being thrown away (a floating window closed). Docked widgets stay mounted
//                       while they are merely off screen, so this is also the page teardown hook. Clear timers / listeners.
//
//   ctx = { id, token(), withToken(path), setBadge(text) }   setBadge puts a small chip in the panel header.
//
// MULTIPLE INSTANCES: the same widget can be docked AND open in a floating window, so a tabs/ module does not export the
// contract directly. It exports create(), a factory returning a fresh { mount, update, resize?, unmount? } with its own
// closure state, and the registry below calls it once per Widget (def.make). Caches that are fine to share (market.js)
// stay module-level. A def marked `single: true` cannot be instanced twice (map.js keeps module-level DOM state);
// the dashboard then only ever shows one copy of it: docked, or floating while it is not docked.
//
// Registration below (id, title, icon, options). Older modules that only export `render(el, data)` (map, tracker) are
// wrapped by legacy(), so they need no changes: they mount lazily on first render and are re-rendered on resize.

import * as party from "../tabs/party.js";
import * as map from "../tabs/map.js";
import * as tracker from "../tabs/tracker.js";
import * as inventory from "../tabs/inventory.js";
import * as plugins from "../tabs/plugins.js";
import * as dailies from "../tabs/dailies.js";
import * as chat from "../tabs/chat.js";
import * as character from "../tabs/character.js";
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
    unmount() { mod.unmount?.(); },
  };
}

export const DEFS = [
  { id: "party", title: "Party", icon: "users", make: () => party.create(),
    badge: (p) => { const s = p.snapshot; return s && s.loggedIn ? String((s.party || []).length || 1) : ""; } },
  { id: "map", title: "Map", icon: "map", make: () => legacy(map, { rerenderOnResize: true }), fill: true, single: true },
  { id: "tracker", title: "Tracker", icon: "tracker", make: () => legacy(tracker.create()),
    badge: (p) => { const t = p.trackers || []; return t.length ? `${t.filter((x) => x.complete).length}/${t.length}` : ""; } },
  { id: "inventory", title: "Inventory", icon: "inventory", make: () => inventory.create() },
  { id: "dailies", title: "Dailies", icon: "dailies", make: () => dailies.create() },
  { id: "chat", title: "Chat", icon: "chat", make: () => chat.create(), fill: true },
  { id: "character", title: "Character", icon: "character", make: () => character.create() },
  { id: "plugins", title: "Plugins", icon: "plugins", make: () => plugins.create(),
    badge: (p) => { const n = Object.keys(p.ipc || {}).length; return n ? String(n) : ""; } },
];

export class Widget {
  /** @param {object} def a DEFS entry. @param {{floating?: boolean}} [o] floating = hosted by a floating window, not a column / tab. */
  constructor(def, { floating = false } = {}) {
    this.def = def;
    this.mod = def.make();
    this.floating = floating;
    this.mounted = false;
    this.badgeText = "";

    this.panel = h("section", "panel");
    this.panel.dataset.widget = def.id;
    if (floating) this.panel.classList.add("in-float");
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
    this.mounted = false;
    try { this.mod.unmount?.(); } catch (e) { console.error(`[${this.def.id}] unmount`, e); }
    this.ro.disconnect();
  }
}

export function createWidgets() {
  return new Map(DEFS.map((d) => [d.id, new Widget(d)]));
}
