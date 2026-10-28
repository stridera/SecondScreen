// Party widget: one card per member with HP / MP bars. Cards are keyed by name and updated in place
// (no innerHTML rebuild), so bars animate and nothing jumps when numbers change.
// Narrow columns switch to a tight layout through CSS: .wbody[data-size="compact"] .pm { ... }

import { pct } from "../js/util.js";
import { icon } from "../js/icons.js";

const ROLES = {
  tank: ["PLD", "WAR", "DRK", "GNB", "GLA", "MRD"],
  heal: ["WHM", "SCH", "AST", "SGE", "CNJ"],
  craft: ["CRP", "BSM", "ARM", "GSM", "LTW", "WVR", "ALC", "CUL"],
  gather: ["MIN", "BTN", "FSH"],
};
const roleOf = (job) => Object.keys(ROLES).find((r) => ROLES[r].includes(job)) || "dps";
const fmtN = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "-");

let S = null;

export function mount(el) {
  el.innerHTML = `
    <div class="party">
      <div class="party-list"></div>
      <div class="empty party-empty" hidden>${icon("users", "big")}<div>Not logged in to a character.</div></div>
      <p class="note party-solo" hidden>Solo - no party.</p>
    </div>`;
  const root = el.querySelector(".party");
  S = { root, list: root.querySelector(".party-list"), empty: root.querySelector(".party-empty"), solo: root.querySelector(".party-solo"), cards: new Map() };
}

function makeCard() {
  const c = document.createElement("article");
  c.className = "pm card";
  c.innerHTML = `
    <div class="pm-head"><span class="pm-job"></span><span class="pm-name"></span><span class="pm-lvl"></span></div>
    <div class="bar hp"><i></i><span></span></div>
    <div class="bar mp"><i></i><span></span></div>`;
  const q = (s) => c.querySelector(s);
  return {
    el: c, job: q(".pm-job"), name: q(".pm-name"), lvl: q(".pm-lvl"),
    hpBar: q(".bar.hp"), hpFill: q(".bar.hp > i"), hpText: q(".bar.hp > span"),
    mpFill: q(".bar.mp > i"), mpText: q(".bar.mp > span"),
    v: {},
  };
}

function setText(node, cache, key, value) {
  if (cache[key] !== value) { cache[key] = value; node.textContent = value; }
}

function fill(card, m, local) {
  const v = card.v;
  setText(card.job, v, "job", m.job || "");
  if (v.role !== roleOf(m.job)) { v.role = roleOf(m.job); card.el.dataset.role = v.role; }
  setText(card.name, v, "name", m.name || "");
  setText(card.lvl, v, "lvl", m.level != null ? `Lv ${m.level}` : "");
  const hp = pct(m.hp, m.maxHp), mp = pct(m.mp, m.maxMp);
  const hpW = `${hp.toFixed(1)}%`, mpW = `${mp.toFixed(1)}%`;
  if (v.hpW !== hpW) { v.hpW = hpW; card.hpFill.style.width = hpW; }
  if (v.mpW !== mpW) { v.mpW = mpW; card.mpFill.style.width = mpW; }
  setText(card.hpText, v, "hpT", `${fmtN(m.hp)} / ${fmtN(m.maxHp)}`);
  setText(card.mpText, v, "mpT", `${fmtN(m.mp)} / ${fmtN(m.maxMp)}`);
  const low = hp < 25 && m.maxHp > 0, dead = m.maxHp > 0 && m.hp <= 0;
  if (v.low !== low) { v.low = low; card.hpBar.classList.toggle("low", low); }
  if (v.dead !== dead) { v.dead = dead; card.el.classList.toggle("dead", dead); }
  if (v.local !== local) { v.local = local; card.el.classList.toggle("local", local); }
}

export function update({ snapshot }) {
  if (!S) return;
  const live = snapshot && snapshot.loggedIn && snapshot.player;
  S.empty.hidden = !!live;
  S.list.hidden = !live;
  if (!live) { S.solo.hidden = true; return; }

  const party = snapshot.party || [];
  const members = party.length ? party.map((m) => [m, !!m.isLocal]) : [[snapshot.player, true]];
  S.solo.hidden = party.length > 0;

  const wanted = [];
  const seen = new Set();
  for (const [m, local] of members) {
    let key = m.name || "?";
    while (seen.has(key)) key += "'";
    seen.add(key);
    let card = S.cards.get(key);
    if (!card) { card = makeCard(); S.cards.set(key, card); }
    fill(card, m, local);
    wanted.push(card);
  }
  for (const [key, card] of S.cards) if (!seen.has(key)) { card.el.remove(); S.cards.delete(key); }
  // Only touch the DOM order if it actually differs.
  const cur = S.list.children;
  if (wanted.length !== cur.length || wanted.some((c, i) => cur[i] !== c.el)) S.list.append(...wanted.map((c) => c.el));
}
