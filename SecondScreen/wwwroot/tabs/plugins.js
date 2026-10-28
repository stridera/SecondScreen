import { esc, ago } from "../js/util.js";

export function render(el, { ipc }) {
  const plugins = Object.keys(ipc || {}).sort();
  if (plugins.length === 0) {
    el.innerHTML = `<div class="empty">No plugins have published data via <code>SecondScreen.Publish</code> yet.</div>`;
    return;
  }
  el.innerHTML = plugins.map((name) => {
    const entries = ipc[name];
    const body = Object.keys(entries).sort().map((k) => {
      const e = entries[k];
      return `<div class="entry"><span class="key">${esc(k)}</span><span class="age">${ago(e.updated)}</span>
        <pre>${esc(JSON.stringify(e.value, null, 2))}</pre></div>`;
    }).join("");
    return `<section class="card plugin"><h3>${esc(name)}</h3>${body}</section>`;
  }).join("");
}
