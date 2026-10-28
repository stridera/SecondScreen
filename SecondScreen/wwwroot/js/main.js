import { connect } from "./socket.js";
import { createWidgets } from "./widgets.js";
import { Dashboard } from "./dashboard.js";
import { initShell } from "./shell.js";

const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");

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

const dash = new Dashboard({
  stage: document.getElementById("stage"),
  nav: document.getElementById("tabs"),
  widgets: createWidgets(),
});
initShell(dash);
window.__dash = dash; // handy for debugging in the console

// Push data to the visible widgets at most once per animation frame.
function frame() {
  try { dash.tick(); } catch (e) { console.error(e); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

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
    onMessage: (msg) => dash.setPayload(msg),
  });
}
