import { connect } from "./socket.js";
import * as party from "../tabs/party.js";
import * as map from "../tabs/map.js";
import * as inventory from "../tabs/inventory.js";
import * as plugins from "../tabs/plugins.js";

const TABS = { party, map, inventory, plugins };
const view = document.getElementById("view");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");

let current = localStorage.getItem("ss.tab") || "party";
if (!TABS[current]) current = "party";
let data = { snapshot: null, ipc: {} };
let dirty = true;

// Token: URL query wins and is persisted; strip it from the address bar afterwards.
const url = new URL(location.href);
const urlToken = url.searchParams.get("token");
if (urlToken) {
  localStorage.setItem("ss.token", urlToken);
  url.searchParams.delete("token");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}
const token = localStorage.getItem("ss.token");

function setStatus(s) {
  statusEl.className = `status ${s}`;
  statusText.textContent = s === "online" ? "Live" : s === "connecting" ? "Connecting" : "Offline";
}

function selectTab(name) {
  current = name;
  localStorage.setItem("ss.tab", name);
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  view.innerHTML = "";
  delete view.dataset.done;
  dirty = true;
}

document.getElementById("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) selectTab(b.dataset.tab);
});

// Render at most once per animation frame, only when data changed.
function frame() {
  if (dirty) {
    dirty = false;
    try { TABS[current].render(view, data); } catch (e) { console.error(e); }
  }
  requestAnimationFrame(frame);
}

if (!token) {
  const dlg = document.getElementById("token-dialog");
  document.getElementById("token-form").addEventListener("submit", () => {
    const v = document.getElementById("token-input").value.trim();
    if (v) { localStorage.setItem("ss.token", v); location.reload(); }
  });
  dlg.showModal();
  setStatus("offline");
} else {
  connect(token, {
    onStatus: setStatus,
    onMessage: (msg) => { data = msg; dirty = true; },
  });
}

selectTab(current);
requestAnimationFrame(frame);
// Keep "x s ago" labels fresh on the Plugins tab.
setInterval(() => { if (current === "plugins") dirty = true; }, 1000);
