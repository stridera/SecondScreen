// Plugins widget: data other plugins published via SecondScreen.Publish. Re-renders only when the data changed;
// the "x s ago" labels are refreshed in place by a 1 s ticker.

import { esc, ago } from "../js/util.js";
import { icon } from "../js/icons.js";

let S = null;

export function mount(el) {
  el.innerHTML = `<div class="plugins"></div>`;
  S = { root: el.querySelector(".plugins"), html: null, timer: setInterval(tick, 1000) };
}

function tick() {
  if (!S || !S.root.isConnected) return;
  for (const n of S.root.querySelectorAll(".age[data-ts]")) n.textContent = ago(Number(n.dataset.ts));
}

export function update({ ipc }) {
  if (!S) return;
  const names = Object.keys(ipc || {}).sort();
  const html = names.length === 0
    ? `<div class="empty">${icon("plugins", "big")}<div>No plugins have published data via <code>SecondScreen.Publish</code> yet.</div></div>`
    : names.map((name) => {
      const entries = ipc[name];
      const body = Object.keys(entries).sort().map((k) => {
        const e = entries[k];
        return `<div class="entry"><div class="entry-head"><span class="key">${esc(k)}</span><span class="age" data-ts="${Number(e.updated) || 0}"></span></div>
          <pre>${esc(JSON.stringify(e.value, null, 2))}</pre></div>`;
      }).join("");
      return `<section class="card plugin"><h3>${esc(name)}</h3>${body}</section>`;
    }).join("");
  if (html === S.html) return;
  S.html = html;
  S.root.innerHTML = html;
  tick();
}

export function unmount() { if (S) clearInterval(S.timer); S = null; }
