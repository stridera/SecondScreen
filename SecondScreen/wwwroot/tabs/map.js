import { fmt } from "../js/util.js";

export function render(el, { snapshot }) {
  const s = snapshot;
  const p = s?.player;
  el.innerHTML = `<div class="card"><dl class="kv">
    <dt>Territory</dt><dd>${s?.territoryId ?? "-"}</dd>
    <dt>Map</dt><dd>${s?.mapId ?? "-"}</dd>
    <dt>Position</dt><dd>${p ? `${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}` : "-"}</dd>
    <dt>Rotation</dt><dd>${p ? fmt(p.rotation, 3) : "-"}</dd></dl></div>
    <p class="note">Map rendering coming soon (placeholder).</p>`;
}
