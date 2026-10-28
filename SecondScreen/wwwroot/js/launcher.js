// "Panels" launcher: a top bar button whose menu lists every widget with its state, and opens it in a floating window
// (or a full-screen sheet on phones). Separate from the Layouts menu on purpose: Layouts changes the dashboard, this only
// shows things on top of it.

import { DEFS } from "./widgets.js";
import { h, openPopover, closePopover, isPopoverOpen } from "./ui.js";
import { icon } from "./icons.js";

export function initLauncher(dash) {
  const btn = document.getElementById("btn-panels");
  btn.innerHTML = `${icon("apps")}<span>Panels</span>`;
  dash.floats.opener = btn;
  btn.addEventListener("click", () => {
    if (isPopoverOpen() && btn.getAttribute("aria-expanded") === "true") { closePopover(); return; }
    openMenu(btn, dash);
  });
}

function hintFor(dash, d) {
  const docked = dash.isDocked(d.id), open = dash.floats.has(d.id);
  const tabs = dash.cur.tabs;
  const parts = [];
  if (docked) parts.push(tabs ? "Tab" : "Docked");
  if (open) parts.push("Open");
  if (!parts.length) return tabs ? "" : "Floating window";
  if (d.single && docked && !open) parts.push("jump to it");
  return parts.join(" - ");
}

function openMenu(anchor, dash) {
  const box = h("div", "menu");
  box.append(h("div", "menu-title", dash.cur.tabs ? "Panels - open as a sheet" : "Panels - open in a window"));
  for (const d of DEFS) {
    const open = dash.floats.has(d.id);
    const b = h("button", `menu-item${open ? " on" : ""}`,
      `<span class="mi-check">${icon(d.icon)}</span><span class="mi-text"><span>${d.title}</span><small>${hintFor(dash, d)}</small></span>`);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.dataset.panel = d.id;
    b.addEventListener("click", () => { closePopover(); dash.openFloating(d.id); });
    box.append(b);
  }
  openPopover(anchor, box);
}
