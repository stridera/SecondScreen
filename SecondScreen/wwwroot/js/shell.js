// Top bar controls: Edit layout / Done, + Column, the Layouts menu (presets, share, reset) and the share dialog.

import { PRESETS, exportLayout } from "./layout.js";
import { h, openPopover, closePopover, toast, isPopoverOpen } from "./ui.js";
import { icon } from "./icons.js";
import { initScreenControls, showFullscreenHint } from "./screen.js";

export function initShell(dash) {
  const $ = (id) => document.getElementById(id);
  const btnEdit = $("btn-edit"), btnAddCol = $("btn-addcol"), btnMenu = $("btn-layouts");

  btnEdit.addEventListener("click", () => dash.setEdit(!dash.edit));
  btnAddCol.addEventListener("click", () => dash.addColumnEnd());
  btnMenu.addEventListener("click", () => {
    if (isPopoverOpen() && btnMenu.getAttribute("aria-expanded") === "true") { closePopover(); return; }
    openMenu(btnMenu, dash);
  });

  const sync = () => {
    const tabs = dash.cur.tabs;
    btnEdit.hidden = tabs;
    btnAddCol.hidden = tabs || !dash.edit;
    btnEdit.classList.toggle("primary", dash.edit);
    btnEdit.setAttribute("aria-pressed", String(dash.edit));
    btnEdit.innerHTML = dash.edit ? `${icon("check")}<span>Done</span>` : `${icon("edit")}<span>Edit layout</span>`;
  };
  dash.onState(sync);
  sync(); // the dashboard rendered once before this listener existed

  initShareDialog(dash);
  initScreenControls();
}

function openMenu(anchor, dash) {
  const c = dash.cur;
  const box = h("div", "menu");
  box.append(h("div", "menu-title", `Layout - ${c.slot}${c.auto ? " (auto)" : ""}`));
  for (const p of PRESETS) {
    const on = c.preset === p.id;
    const b = h("button", `menu-item${on ? " on" : ""}`,
      `<span class="mi-check">${on ? icon("check") : ""}</span><span class="mi-text"><span>${p.name}</span><small>${p.hint}</small></span>`);
    b.type = "button";
    b.addEventListener("click", () => dash.applyPreset(p.id));
    box.append(b);
  }
  if (c.forced) box.append(h("div", "menu-note", "This screen is narrow, so tabs are shown. Widen the window to use columns."));
  box.append(h("div", "menu-sep"));
  const share = h("button", "menu-item", `<span class="mi-check">${icon("share")}</span><span class="mi-text"><span>Export / import layout</span></span>`);
  share.type = "button";
  share.addEventListener("click", () => { closePopover(); document.dispatchEvent(new CustomEvent("ss:share")); });
  const reset = h("button", "menu-item", `<span class="mi-check">${icon("reset")}</span><span class="mi-text"><span>Reset to automatic</span><small>Forget the saved ${c.slot} layout</small></span>`);
  reset.type = "button";
  reset.addEventListener("click", () => { closePopover(); dash.resetSlot(); toast("Layout reset."); });
  box.append(share, reset);
  if (showFullscreenHint()) box.append(h("div", "menu-sep"), h("div", "menu-note", "Add to Home Screen for fullscreen."));
  openPopover(anchor, box);
}

function initShareDialog(dash) {
  const dlg = document.getElementById("share-dialog");
  const ta = dlg.querySelector("textarea");
  const err = dlg.querySelector(".share-err");
  const setErr = (m) => { err.textContent = m || ""; err.hidden = !m; };

  document.addEventListener("ss:share", () => {
    ta.value = exportLayout(dash.currentLayout());
    setErr("");
    dlg.showModal();
    ta.focus(); ta.select();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) { dlg.close(); return; }
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    }
  });
  dlg.querySelector("[data-copy]").addEventListener("click", async () => {
    try {
      // navigator.clipboard needs a secure context; the plugin is usually served over plain http.
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(ta.value);
      else { ta.focus(); ta.select(); if (!document.execCommand("copy")) throw new Error("copy blocked"); }
      toast("Layout copied.");
    } catch { setErr("Could not copy automatically. Select the text and copy it manually."); ta.focus(); ta.select(); }
  });
  dlg.querySelector("[data-apply]").addEventListener("click", () => {
    try {
      dash.applyImported(ta.value);
      dlg.close();
      toast("Layout applied.");
    } catch (e) { setErr(e.message); }
  });
}
