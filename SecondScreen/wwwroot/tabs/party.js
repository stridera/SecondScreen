import { esc, pct } from "../js/util.js";

function bar(kind, cur, max) {
  const p = pct(cur, max);
  const low = kind === "hp" && p < 25 ? " low" : "";
  return `<div class="bar ${kind}${low}"><i style="width:${p}%"></i><span>${cur} / ${max}</span></div>`;
}

function card(m, local) {
  return `<div class="card${local ? " local" : ""}">
    <div class="head"><span class="name"><span class="job">${esc(m.job)}</span>${esc(m.name)}</span><span class="lvl">Lv ${m.level}</span></div>
    ${bar("hp", m.hp, m.maxHp)}${bar("mp", m.mp, m.maxMp)}</div>`;
}

export function render(el, { snapshot }) {
  if (!snapshot || !snapshot.loggedIn || !snapshot.player) {
    el.innerHTML = `<div class="empty">Not logged in to a character.</div>`;
    return;
  }
  const p = snapshot.player;
  const party = snapshot.party || [];
  if (party.length === 0) {
    el.innerHTML = `<div class="grid">${card(p, true)}</div><p class="note">Solo - no party.</p>`;
    return;
  }
  el.innerHTML = `<div class="grid">${party.map((m) => card(m, m.isLocal)).join("")}</div>`;
}
