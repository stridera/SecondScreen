// Map tab: zone map image + live player/party markers + configurable marker layers, with touch/mouse pan and zoom.
//
// Coordinates (see MapData.cs): with c = sizeFactor / 100 and the 2048px map texture,
//   px = (worldX + offsetX) * c + 1024        py = (worldZ + offsetY) * c + 1024
//   in-game display coordinate = 41 / c * (px / 2048) + 1
//
// Rotation: FFXIV rotation 0 faces +Z (south, DOWN on the map); the facing vector in (x, z) is
// (sin r, cos r), so +PI/2 faces +X (east, right). Screen space is x right / y down, and the arrow
// glyph points UP (screen vector (0,-1)) at CSS rotate(0). CSS rotate(phi) is clockwise and turns
// (0,-1) into (sin phi, -cos phi). Matching (sin r, cos r) gives phi = PI - r.
//
// Marker layers
//   static  GET /api/map/{id}/markers -> [{x, y, iconId, label, category}] in texture px, once per map.
//           category aetheryte | label | service | transition map 1:1 to a layer; "other" is not drawn.
//   live    `live` field of the WebSocket payload (~1 Hz, WORLD coordinates, converted here):
//           fates, gathering, quests, flag. The server repeats it in a few consecutive pushes and then omits
//           it, so the last one is cached by `seq`.
// Markers are DOM nodes inside the scaled stage (reused between updates, never rebuilt per snapshot) and are
// counter-scaled with --inv so they keep a constant screen size. Layer visibility is a class on the stage.
//
// Declutter (see declutter()): the map's on-screen size `eff` = TEX * scale (px) decides which detail tiers exist at all
// (a small panel at the same zoom has a smaller eff, so it shows less). Label boxes are measured once in screen px and
// placed greedily by priority on a bucket grid; icons of the same service / gathering category that overlap are merged
// into one clustered icon with a count badge. All of it is translation invariant, so it only re-runs when the scale,
// the viewport size, the marker set or the layer toggles change (rAF throttled, debounced while zooming), never per
// 10 Hz snapshot and never while panning.

const TEX = 2048;
const MIN_ZOOM_FACTOR = 0.9;   // relative to the "fit whole map" scale
const MAX_ZOOM = 3;            // CSS px per texture px
const DEFAULT_ZOOM_FACTOR = 1.8;
// Minimum on-screen size (px) of the whole 2048 map at which a detail tier appears.
const DETAIL_MIN = { areaLabel: 560, aetheryteLabel: 900, gather: 700, transition: 800, service: 1000, smallLabel: 1300, exitLabel: 1600 };
const CLUSTER_PX = 22;         // same-category icons closer than this (screen px) merge into one
const LABEL_GAP = 3;           // px kept free around every label box
const GRID_CELL = 64;          // bucket size of the collision grid
const SETTLE_MS = 140;         // zoom must rest this long before collisions are recomputed
const COMPACT_W = 480, COMPACT_H = 340; // viewports smaller than this get the compact label style
const ICON_HALF = 13;          // half of the 26px icon box
const PARTY_COLORS = ["#e0a93d", "#4cc46a", "#c06bff", "#ff7a59", "#37c8c8", "#ff6fb1", "#a3d65c"];
const TAP_SLOP = 4;            // px of movement that turns a tap into a drag
const HIT_RADIUS = 22;         // css px around a marker that counts as a tap on it
const STATIC_LAYERS = new Set(["aetheryte", "label", "service", "transition"]);

// key, button label, default on
const LAYERS = [
  ["aetheryte", "Aetherytes", true],
  ["label", "Labels", true],
  ["service", "Services", false],
  ["transition", "Zone exits", true],
  ["quest", "Quests", true],
  ["fate", "FATEs", true],
  ["gather", "Gathering", true],
  ["flag", "Flag", true],
  ["party", "Party", true],
];
const LAYER_STORE = "ss.map.layers"; // per-device (localStorage) toggle state
const KIND_NAMES = {
  aetheryte: "Aetheryte", label: "Location", service: "Service", transition: "Zone exit",
  quest: "Quest objective", fate: "FATE", gather: "Gathering node", flag: "Map flag", party: "Party member", me: "You",
};
const KIND_COLORS = { quest: "#ffd24a", fate: "#ff7a59", gather: "#4cc46a", flag: "#e0524d", aetheryte: "#5aa2ff" };

const metaCache = new Map();   // mapId -> Promise<meta | null>
const staticCache = new Map(); // mapId -> Promise<{markers: []} | null>
let S = null;                  // state for the currently mounted tab instance
let observer = null;           // ResizeObserver for the mounted instance

const token = () => localStorage.getItem("ss.token") || "";

function cachedFetch(cache, mapId, url) {
  if (!cache.has(mapId)) {
    const p = fetch(`${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token())}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    cache.set(mapId, p);
    p.then((m) => { if (!m) cache.delete(mapId); });
  }
  return cache.get(mapId);
}
const fetchMeta = (mapId) => cachedFetch(metaCache, mapId, `/api/map/${mapId}`);
const fetchStatic = (mapId) => cachedFetch(staticCache, mapId, `/api/map/${mapId}/markers`);

const toPx = (world, offset, sf) => (world + offset) * (sf / 100) + TEX / 2;
const toDisplay = (world, offset, sf) => (41 / (sf / 100)) * (toPx(world, offset, sf) / TEX) + 1;
const pxToDisplay = (px, sf) => (41 / (sf / 100)) * (px / TEX) + 1;
const iconUrl = (id) => `/api/icon/${id}.png?token=${encodeURIComponent(token())}`;

function loadLayers() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LAYER_STORE) || "{}") || {}; } catch { /* corrupt: use defaults */ }
  const out = {};
  for (const [key, , def] of LAYERS) out[key] = typeof saved[key] === "boolean" ? saved[key] : def;
  return out;
}
const layerOn = (kind) => kind === "me" || S.layers[kind] !== false;

function mount(el) {
  el.dataset.done = "1";
  el.innerHTML = `
    <div class="mapwrap">
      <div class="maphead">
        <div class="mapname">-</div>
        <div class="mapcoords"></div>
        <button type="button" class="maplayersbtn" aria-expanded="false" aria-haspopup="true">Layers</button>
        <button type="button" class="mapfollow on" aria-pressed="true">Follow me</button>
      </div>
      <div class="maplayers" hidden></div>
      <div class="mapvp">
        <div class="mapstage">
          <img class="mapimg" alt="" draggable="false">
          <div class="mapmarkers"></div>
        </div>
        <div class="mapmsg"></div>
      </div>
    </div>`;
  const root = el.querySelector(".mapwrap");
  S = {
    host: el,
    root,
    head: root.querySelector(".maphead"),
    vp: root.querySelector(".mapvp"),
    stage: root.querySelector(".mapstage"),
    img: root.querySelector(".mapimg"),
    markers: root.querySelector(".mapmarkers"),
    msg: root.querySelector(".mapmsg"),
    nameEl: root.querySelector(".mapname"),
    coordsEl: root.querySelector(".mapcoords"),
    followBtn: root.querySelector(".mapfollow"),
    layersBtn: root.querySelector(".maplayersbtn"),
    layersPanel: root.querySelector(".maplayers"),
    layers: loadLayers(),
    mapId: 0,
    meta: null,
    imgOk: false,
    follow: true,
    scale: 0.3, tx: 0, ty: 0,
    vw: 0, vh: 0,
    compact: false,
    vScale: 0, dTimer: 0, dRaf: 0, dFont: "", // declutter bookkeeping (last applied scale, timers, label font key)
    clPool: [],             // cluster nodes {el, badge, item}
    clItems: [],            // active cluster items
    player: null,           // marker px position {x, y}
    els: new Map(),         // party/self marker key -> element
    pitems: new Map(),      // party/self key -> tappable item
    stItems: [],            // static marker items
    lvItems: new Map(),     // live marker key -> item
    live: null, liveSeq: null, liveRecv: 0, liveDirty: false,
    pop: null,              // {el, item}
    pointers: new Map(),    // pointerId -> {x, y}
    gesture: null,
    tap: null,
  };
  S.img.addEventListener("load", () => { S.imgOk = true; S.msg.textContent = ""; S.msg.hidden = true; updateMarkersVisibility(); scheduleDeclutter(); });
  S.img.addEventListener("error", () => { S.imgOk = false; showMsg("Map image unavailable."); });
  S.followBtn.addEventListener("click", () => setFollow(!S.follow, true));
  buildLayersPanel();
  applyLayerClasses();
  bindGestures(S);

  // The container may be resized without the window changing (resizable panels): observe it directly.
  if (observer) observer.disconnect();
  observer = new ResizeObserver(() => { if (S && S.root.isConnected) layout(); });
  observer.observe(root);
  observer.observe(el);
}

function setFollow(on, recenter) {
  S.follow = on;
  S.followBtn.classList.toggle("on", on);
  S.followBtn.setAttribute("aria-pressed", String(on));
  if (on && recenter) { centerOnPlayer(false); applyView(); }
}

function showMsg(text) {
  S.msg.textContent = text;
  S.msg.hidden = !text;
}

// ---- layers panel -----------------------------------------------------------------------------

function buildLayersPanel() {
  const panel = S.layersPanel;
  for (const [key, label] of LAYERS) {
    const row = document.createElement("label");
    row.className = "maplayer";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.layer = key;
    cb.checked = S.layers[key];
    row.append(cb, document.createTextNode(label));
    panel.appendChild(row);
  }
  panel.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-layer]");
    if (!cb) return;
    S.layers[cb.dataset.layer] = cb.checked;
    try { localStorage.setItem(LAYER_STORE, JSON.stringify(S.layers)); } catch { /* storage full / disabled */ }
    applyLayerClasses();
    if (S.pop && !layerOn(S.pop.item.kind)) closePopover();
    scheduleDeclutter();
  });
  S.layersBtn.addEventListener("click", () => toggleLayers());
}

function toggleLayers(force) {
  const open = force ?? S.layersPanel.hidden;
  S.layersPanel.hidden = !open;
  S.layersBtn.setAttribute("aria-expanded", String(open));
  S.layersBtn.classList.toggle("on", open);
  if (open) S.layersPanel.style.top = `${S.head.offsetHeight + 4}px`;
}

function applyLayerClasses() {
  for (const [key] of LAYERS) S.stage.classList.toggle(`hl-${key}`, !S.layers[key]);
}

// ---- view transform -------------------------------------------------------------------------

const fitScale = () => Math.max(0.05, Math.min(S.vw, S.vh) / TEX);
const minScale = () => fitScale() * MIN_ZOOM_FACTOR;

function clampView() {
  S.scale = Math.min(MAX_ZOOM, Math.max(minScale(), S.scale));
  const size = TEX * S.scale;
  // The map point under the viewport centre must stay on the map, so centring on any point is possible.
  S.tx = Math.min(S.vw / 2, Math.max(S.vw / 2 - size, S.tx));
  S.ty = Math.min(S.vh / 2, Math.max(S.vh / 2 - size, S.ty));
}

function applyView(smooth) {
  clampView();
  S.stage.style.transition = smooth ? "transform .15s linear" : "none";
  S.stage.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.scale})`;
  S.stage.style.setProperty("--inv", String(1 / S.scale));
  if (S.scale !== S.vScale) { S.vScale = S.scale; scheduleDeclutter(SETTLE_MS); } // zoom (not pan) changed what fits
}

function centerOnPlayer() {
  if (!S.player) return;
  S.tx = S.vw / 2 - S.player.x * S.scale;
  S.ty = S.vh / 2 - S.player.y * S.scale;
}

function resetView() {
  S.scale = fitScale() * DEFAULT_ZOOM_FACTOR;
  S.tx = S.vw / 2 - (TEX / 2) * S.scale;
  S.ty = S.vh / 2 - (TEX / 2) * S.scale;
  setFollow(true, false);
  centerOnPlayer();
  applyView();
}

function zoomAt(cx, cy, newScale) {
  newScale = Math.min(MAX_ZOOM, Math.max(minScale(), newScale));
  // keep the map point under (cx, cy) fixed
  const mx = (cx - S.tx) / S.scale;
  const my = (cy - S.ty) / S.scale;
  S.scale = newScale;
  S.tx = cx - mx * newScale;
  S.ty = cy - my * newScale;
}

// Size the viewport. If the host (the element the tab is mounted into) has a height of its own (panel in a
// resizable column), fill the space left under the header. Otherwise (host grows with its content, as in the
// single-column page) fall back to "the rest of the browser window". Called from the ResizeObserver, on
// window resize and on first render, never per snapshot (it forces layout).
function layout() {
  if (!S) return;
  const vp = S.vp;
  const host = S.host;
  vp.style.height = "0px"; // collapse so the host's own height shows through
  const cs = getComputedStyle(host);
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const free = host.clientHeight - pad - S.root.offsetHeight;
  const h = free > 160
    ? Math.floor(free)
    : Math.max(260, Math.floor(window.innerHeight - vp.getBoundingClientRect().top - 16));
  vp.style.height = `${h}px`;

  const w = vp.clientWidth, vh = vp.clientHeight;
  if (w && vh && (w !== S.vw || vh !== S.vh)) {
    const first = S.vw === 0;
    const oldFit = first ? 0 : fitScale();
    S.vw = w; S.vh = vh;
    S.root.classList.toggle("compact", (S.compact = w < COMPACT_W || vh < COMPACT_H));
    scheduleDeclutter();
    if (first) resetView();
    else {
      S.scale *= fitScale() / oldFit;
      if (S.follow) centerOnPlayer();
      applyView();
    }
  }
}

// ---- gestures (Pointer Events; works for touch, pen and mouse) ----------------------------

function bindGestures(s) {
  const vp = s.vp;
  const rectXY = (e) => { const r = vp.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  vp.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    vp.setPointerCapture(e.pointerId);
    s.pointers.set(e.pointerId, rectXY(e));
    s.gesture = null;
    s.stage.style.transition = "none";
    if (!s.layersPanel.hidden) toggleLayers(false);
    // A tap is one finger that goes down and up quickly without moving and without a second finger.
    if (s.pointers.size === 1) s.tap = { ...rectXY(e), t: performance.now() };
    else if (s.tap) s.tap = null;
  });

  vp.addEventListener("pointermove", (e) => {
    if (!s.pointers.has(e.pointerId)) return;
    const prev = s.pointers.get(e.pointerId);
    const cur = rectXY(e);
    s.pointers.set(e.pointerId, cur);

    if (s.pointers.size === 1) {
      const dx = cur.x - prev.x, dy = cur.y - prev.y;
      s.gesture = s.gesture || { moved: 0 };
      s.gesture.moved += Math.abs(dx) + Math.abs(dy);
      if (s.gesture.moved < TAP_SLOP) return; // ignore taps / jitter
      s.tap = null;
      s.tx += dx; s.ty += dy;
      if (s.follow) setFollow(false);
      applyView();
    } else if (s.pointers.size === 2) {
      s.tap = null;
      const [a, b] = [...s.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (!s.gesture || s.gesture.dist === undefined) {
        s.gesture = { dist, mid, start: mid, moved: 0 };
        return;
      }
      const g = s.gesture;
      if (g.dist > 0) zoomAt(mid.x, mid.y, s.scale * (dist / g.dist));
      s.tx += mid.x - g.mid.x; s.ty += mid.y - g.mid.y;
      if (s.follow && Math.hypot(mid.x - g.start.x, mid.y - g.start.y) > 12) setFollow(false);
      g.dist = dist; g.mid = mid;
      if (s.follow) centerOnPlayer();
      applyView();
    }
  });

  const end = (e) => {
    const tap = e.type === "pointerup" && s.pointers.size === 1 && s.tap && performance.now() - s.tap.t < 600 ? s.tap : null;
    s.pointers.delete(e.pointerId);
    s.gesture = null; // remaining finger (if any) restarts as a single-pointer drag
    s.tap = null;
    try { vp.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (tap) handleTap(tap.x, tap.y);
  };
  vp.addEventListener("pointerup", end);
  vp.addEventListener("pointercancel", end);
  vp.addEventListener("lostpointercapture", (e) => s.pointers.delete(e.pointerId));

  vp.addEventListener("wheel", (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : 1;
    const factor = Math.exp(-e.deltaY * unit * 0.0015);
    const p = rectXY(e);
    s.stage.style.transition = "none";
    if (s.follow) { zoomAt(s.vw / 2, s.vh / 2, s.scale * factor); centerOnPlayer(); }
    else zoomAt(p.x, p.y, s.scale * factor);
    applyView();
  }, { passive: false });

  // Stop Safari's page-level pinch-zoom from fighting our own.
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) vp.addEventListener(t, (e) => e.preventDefault());
  vp.addEventListener("dragstart", (e) => e.preventDefault());
}

// ---- marker nodes ---------------------------------------------------------------------------

// Own party member / self marker (unchanged look).
function markerEl(key, kind, color, name) {
  let m = S.els.get(key);
  if (m) return m;
  m = document.createElement("div");
  m.className = `mk ${kind}${kind === "pm" ? " k-party" : ""}`;
  m.innerHTML = kind === "me"
    ? `<div class="mk-s"><svg class="mk-arrow" viewBox="-12 -12 24 24" aria-hidden="true">
         <path d="M0 -11 L7 6 L0 2.5 L-7 6 Z" fill="#fff" stroke="#05101f" stroke-width="1.5" stroke-linejoin="round"/></svg>
       <span class="mk-dot"></span></div>`
    : `<div class="mk-s"><span class="mk-dot" style="background:${color}"></span><span class="mk-label"></span></div>`;
  const label = m.querySelector(".mk-label");
  if (label) label.textContent = name;
  S.markers.appendChild(m);
  S.els.set(key, m);
  return m;
}

function placeMarker(m, x, y) {
  m.style.transform = `translate(${x}px, ${y}px)`;
}

// Icon marker node: .mk > [.mk-circle] + .mk-s(counter-scaled) > .mk-ico(img) [+ .mk-badge] [+ .mk-label]
function iconNode(cls, kind, iconId, label, opts = {}) {
  const m = document.createElement("div");
  m.className = `mk ${cls} k-${kind}`;
  const s = document.createElement("div");
  s.className = "mk-s";
  if (iconId || opts.dot) {
    const ico = document.createElement("span");
    ico.className = "mk-ico";
    ico.style.setProperty("--c", KIND_COLORS[kind] || "#fff");
    if (iconId) {
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.decoding = "async";
      img.addEventListener("error", () => ico.classList.add("fb"));
      img.src = iconUrl(iconId);
      ico.appendChild(img);
    } else ico.classList.add("fb");
    s.appendChild(ico);
  }
  if (label) {
    const l = document.createElement("span");
    l.className = "mk-label";
    l.textContent = label;
    s.appendChild(l);
  }
  m.appendChild(s);
  return m;
}

function clearMarkers() {
  for (const m of S.els.values()) m.remove();
  S.els.clear();
  S.pitems.clear();
  for (const it of S.stItems) it.el.remove();
  S.stItems = [];
  for (const n of S.clPool) n.el.remove();
  S.clPool = [];
  S.clItems = [];
  clearLive();
  closePopover();
  S.player = null;
}

function clearLive() {
  for (const it of S.lvItems.values()) it.el.remove();
  S.lvItems.clear();
  if (S.meta) scheduleDeclutter();
}

function updateMarkersVisibility() {
  S.markers.hidden = !(S.imgOk && S.meta);
}

// ---- static markers ---------------------------------------------------------------------------

const normName = (t) => String(t || "").trim().toLowerCase();

// Label priority (lower wins a collision): 0 region / zone name, 1 text-only area name (large), 2 landmark pin
// (small), 3 aetheryte name, 4 zone exit name. The server sends no area size, so "large vs small" is text-only
// names vs icon pins.
function buildStatic(set) {
  const meta = S.meta || {};
  const big = new Set([meta.zone, meta.region, meta.name, meta.subArea].filter(Boolean).map(normName));
  const frag = document.createDocumentFragment();
  for (const m of set.markers || []) {
    if (!STATIC_LAYERS.has(m.category)) continue;
    const textOnly = !m.iconId;
    const el = iconNode(`st${textOnly ? " txt" : ""}`, m.category, m.iconId, m.label);
    placeMarker(el, m.x, m.y);
    frag.appendChild(el);
    const pri = m.category === "label" ? (big.has(normName(m.label)) ? 0 : textOnly ? 1 : 2)
      : m.category === "aetheryte" ? 3 : m.category === "transition" ? 4 : 9;
    S.stItems.push({
      key: `s:${S.stItems.length}`, kind: m.category, x: m.x, y: m.y, el, textOnly, iconId: m.iconId, pri,
      lab: el.querySelector(".mk-label"),
      title: m.label || KIND_NAMES[m.category],
      lines: () => (m.label ? [KIND_NAMES[m.category]] : []),
    });
  }
  S.markers.insertBefore(frag, S.markers.firstChild); // below live / party / self markers
  scheduleDeclutter();
}

// ---- declutter ----------------------------------------------------------------------------------

// rAF throttled; `settle` > 0 waits for the zoom to rest first (a newer immediate request overrides it).
function scheduleDeclutter(settle = 0) {
  const s = S;
  if (!s) return;
  const kick = () => {
    s.dTimer = 0;
    if (!s.dRaf) s.dRaf = requestAnimationFrame(() => { s.dRaf = 0; if (S === s) declutter(); });
  };
  if (!settle) { clearTimeout(s.dTimer); kick(); }
  else if (!s.dRaf) { clearTimeout(s.dTimer); s.dTimer = setTimeout(kick, settle); }
}

const CLUSTER_NAMES = { service: "Services", gather: "Gathering nodes" };

function clusterNode(i) {
  let n = S.clPool[i];
  if (n) return n;
  const el = iconNode("lv cl", "gather", 0, "", { dot: true });
  const badge = document.createElement("span");
  badge.className = "mk-badge cl-n";
  el.querySelector(".mk-s").appendChild(badge);
  const item = { key: `c:${i}`, isCluster: true, el, x: 0, y: 0, members: [], kind: "gather", title: "", lines: () => [] };
  n = { el, badge, item, kind: "", iconId: -1 };
  S.markers.appendChild(el);
  S.clPool[i] = n;
  return n;
}

function setClass(el, cls, on) {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

// Recompute which detail tiers, clusters and labels are shown at the current scale. Reads (label measurement)
// happen once, batched, before any write; everything else is arithmetic on cached numbers.
function declutter() {
  if (!S || !S.meta || !S.imgOk || !S.vw) return;
  const sc = S.scale;
  const eff = TEX * sc;                       // on-screen px of the whole 2048 map
  const items = [...S.stItems, ...S.lvItems.values()];
  const fontKey = S.compact ? "c" : "n";
  if (S.dFont !== fontKey) { S.dFont = fontKey; for (const it of items) it.lw = undefined; }

  // 1. detail tiers (by on-screen map size, not raw zoom)
  const D = DETAIL_MIN;
  for (const it of items) {
    let ok = true;
    switch (it.kind) {
      case "label": ok = it.pri === 0 || (it.pri === 1 ? eff >= D.areaLabel : eff >= D.smallLabel); break;
      case "transition": ok = eff >= D.transition; break;
      case "service": ok = eff >= D.service; break;
      case "gather": ok = eff >= D.gather; break;
      default: break; // aetheryte, quest, fate, flag: always
    }
    it.nh = !ok;
    it.skip = !ok || !layerOn(it.kind);
    it.nn = false;
  }

  // 2. clusters of overlapping same-category icons (services, gathering nodes)
  const clusters = [];
  for (const kind of ["service", "gather"]) {
    const grid = new Map();
    const mine = [];
    for (const it of items) {
      if (it.kind !== kind || it.skip) continue;
      const sx = it.x * sc, sy = it.y * sc;
      const cx = Math.floor(sx / CLUSTER_PX), cy = Math.floor(sy / CLUSTER_PX);
      let hit = null;
      for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++) {
        for (let gy = cy - 1; gy <= cy + 1 && !hit; gy++) {
          for (const c of grid.get(gx * 100003 + gy) || []) {
            if (Math.hypot(c.sx - sx, c.sy - sy) <= CLUSTER_PX) { hit = c; break; }
          }
        }
      }
      if (hit) {
        hit.members.push(it);
        hit.sx += (sx - hit.sx) / hit.members.length;
        hit.sy += (sy - hit.sy) / hit.members.length;
      } else {
        hit = { kind, sx, sy, members: [it] };
        mine.push(hit);
        const k = cx * 100003 + cy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(hit);
      }
    }
    for (const c of mine) {
      if (c.members.length < 2) continue;
      for (const m of c.members) m.nn = true;
      clusters.push(c);
    }
  }

  // 3. label candidates: [priority, item]; the nearest quest / FATE ("frontmost") keeps its label at top priority
  const cands = [];
  for (const it of items) {
    if (it.skip || it.nn || !it.lab || !it.lab.textContent) continue;
    if (it.kind === "label") cands.push([it.pri, it]);
    else if (it.kind === "aetheryte" && eff >= D.aetheryteLabel) cands.push([3, it]);
    else if (it.kind === "transition" && eff >= D.exitLabel) cands.push([4, it]);
  }
  if (S.player) {
    let front = null, best = Infinity;
    for (const it of items) {
      if ((it.kind !== "quest" && it.kind !== "fate") || it.skip || !it.lab || !it.lab.textContent) continue;
      const d = (it.x - S.player.x) ** 2 + (it.y - S.player.y) ** 2;
      if (d < best) { best = d; front = it; }
    }
    if (front) cands.push([-1, front]);
  }

  // measure label boxes once per font size (screen px; labels are counter-scaled so this never changes with zoom)
  const need = cands.filter(([, it]) => it.lw === undefined).map(([, it]) => it);
  for (const it of need) {
    if (it.dh) { it.el.classList.remove("dh"); it.dh = false; }
    if (it.dc) { it.el.classList.remove("dc"); it.dc = false; }
  }
  for (const it of need) { it.lw = it.lab.offsetWidth || undefined; it.lh = it.lab.offsetHeight; }

  // 4. greedy placement on a bucket grid
  const grid = new Map();
  const cellKeys = (r, fn) => {
    for (let gx = Math.floor(r[0] / GRID_CELL); gx <= Math.floor(r[2] / GRID_CELL); gx++) {
      for (let gy = Math.floor(r[1] / GRID_CELL); gy <= Math.floor(r[3] / GRID_CELL); gy++) if (fn(gx * 100003 + gy)) return true;
    }
    return false;
  };
  const blocked = (r, withIcons) => cellKeys(r, (k) => {
    for (const o of grid.get(k) || []) {
      if (!withIcons && o.ico) continue;
      if (r[0] < o[2] + LABEL_GAP && o[0] < r[2] + LABEL_GAP && r[1] < o[3] + LABEL_GAP && o[1] < r[3] + LABEL_GAP) return true;
    }
    return false;
  });
  const put = (r) => cellKeys(r, (k) => { (grid.get(k) || grid.set(k, []).get(k)).push(r); return false; });
  const iconBoxes = () => {
    const add = (x, y, below = 0) => { const r = [x - ICON_HALF, y - ICON_HALF, x + ICON_HALF, y + ICON_HALF + below]; r.ico = true; put(r); };
    for (const it of items) if (!it.skip && !it.nn && !it.textOnly) add(it.x * sc, it.y * sc, it.kind === "fate" ? 16 : 0); // FATE: progress badge below
    for (const c of clusters) add(c.sx, c.sy);
  };
  const on = new Set();
  cands.sort((a, b) => a[0] - b[0]);
  iconBoxes();
  for (const [pri, it] of cands) {
    if (!it.lw) continue;
    const sx = it.x * sc, sy = it.y * sc;
    const r = it.textOnly
      ? [sx - it.lw / 2, sy - it.lh / 2, sx + it.lw / 2, sy + it.lh / 2]
      : [sx + 17, sy - 9, sx + 17 + it.lw, sy - 9 + it.lh];
    // Zone names and the frontmost marker's label may sit over icons if there is nowhere else; everything else avoids them.
    if (blocked(r, true) && (pri > 0 || blocked(r, false))) continue;
    put(r);
    on.add(it);
  }

  // 5. apply (writes only, and only where something changed)
  S.clItems = [];
  clusters.forEach((c, i) => {
    const n = clusterNode(i);
    const it = n.item;
    const first = c.members[0];
    if (n.kind !== c.kind) { n.kind = c.kind; n.el.className = `mk lv cl k-${c.kind}`; }
    if (n.iconId !== first.iconId) {
      n.iconId = first.iconId;
      const ico = n.el.querySelector(".mk-ico");
      const img = ico.querySelector("img") || ico.appendChild(document.createElement("img"));
      img.alt = ""; img.draggable = false;
      ico.classList.remove("fb");
      if (first.iconId) img.src = iconUrl(first.iconId); else ico.classList.add("fb");
    }
    it.kind = c.kind;
    it.members = c.members;
    it.x = c.sx / sc; it.y = c.sy / sc;
    it.title = `${CLUSTER_NAMES[c.kind]} (${c.members.length})`;
    const names = c.members.map((m) => m.title).filter(Boolean);
    it.lines = () => [...names.slice(0, 8), ...(names.length > 8 ? [`+${names.length - 8} more`] : [])];
    placeMarker(n.el, it.x, it.y);
    const txt = String(c.members.length);
    if (n.badge.textContent !== txt) n.badge.textContent = txt;
    setClass(n.el, "dh", false);
    S.clItems.push(it);
  });
  for (let i = clusters.length; i < S.clPool.length; i++) { S.clPool[i].item.members = []; setClass(S.clPool[i].el, "dh", true); }

  for (const it of items) {
    if (it.dh !== it.nh) { it.dh = it.nh; setClass(it.el, "dh", it.nh); }
    if (!!it.dc !== it.nn) { it.dc = it.nn; setClass(it.el, "dc", it.nn); }
    it.nc = it.nn;
    const lbl = on.has(it);
    if (!!it.lblOn !== lbl) { it.lblOn = lbl; setClass(it.el, "lbl", lbl); }
  }
  if (S.pop && (S.pop.item.nc || S.pop.item.dh || S.pop.item.isCluster)) closePopover();
}

// ---- live markers -----------------------------------------------------------------------------

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function liveItem(key, kind, build) {
  let it = S.lvItems.get(key);
  if (!it) {
    it = build();
    it.key = key;
    it.kind = kind;
    it.lab = it.el.querySelector(".mk-label");
    S.markers.appendChild(it.el);
    S.lvItems.set(key, it);
    S.setChanged = true;
  }
  return it;
}

function applyLive() {
  S.liveDirty = false;
  const live = S.live;
  const meta = S.meta;
  if (!meta || !live || live.mapId !== S.mapId) { clearLive(); closePopover(); return; }
  const { offsetX: ox, offsetY: oy, sizeFactor: sf } = meta;
  const c = sf / 100;
  const seen = new Set();
  const place = (it, wx, wz) => {
    it.x = toPx(wx, ox, sf);
    it.y = toPx(wz, oy, sf);
    placeMarker(it.el, it.x, it.y);
  };

  for (const f of live.fates || []) {
    const key = `f:${f.id}`;
    seen.add(key);
    const it = liveItem(key, "fate", () => {
      const el = iconNode("lv fate", "fate", f.iconId, f.name, { dot: true });
      const circle = document.createElement("div");
      circle.className = "mk-circle";
      el.insertBefore(circle, el.firstChild);
      const badge = document.createElement("span");
      badge.className = "mk-badge";
      el.querySelector(".mk-s").appendChild(badge);
      return { el, circle, badge, radius: -1 };
    });
    place(it, f.x, f.z);
    it.fate = f;
    const r = Math.max(0, f.radius) * c;
    if (r !== it.radius) {
      it.radius = r;
      it.circle.style.cssText = `width:${2 * r}px;height:${2 * r}px;left:${-r}px;top:${-r}px`;
    }
    const prog = `${Math.round(f.progress)}%`;
    if (it.badge.textContent !== prog) it.badge.textContent = prog;
    it.title = f.name || "FATE";
    it.lines = () => {
      const left = f.timeRemaining > 0 ? f.timeRemaining - (Date.now() - S.liveRecv) / 1000 : 0;
      const out = [`Lv ${f.level}${f.maxLevel && f.maxLevel !== f.level ? `-${f.maxLevel}` : ""}  ·  ${prog}`];
      if (f.timeRemaining > 0) out.push(`Time left ${fmtTime(left)}`);
      if (f.state && f.state !== "Running") out.push(f.state);
      return out;
    };
  }

  for (const g of live.gathering || []) {
    const key = `g:${g.id}`;
    seen.add(key);
    const it = liveItem(key, "gather", () => ({ el: iconNode("lv", "gather", g.iconId, g.name, { dot: true }) }));
    place(it, g.x, g.z);
    it.iconId = g.iconId;
    it.title = g.name || KIND_NAMES.gather;
    it.lines = () => [g.level > 0 ? `${KIND_NAMES.gather}  ·  Lv ${g.level}` : KIND_NAMES.gather];
  }

  for (const q of live.quests || []) {
    const key = `q:${q.questId}:${Math.round(q.x)}:${Math.round(q.z)}`;
    seen.add(key);
    const it = liveItem(key, "quest", () => ({ el: iconNode("lv", "quest", q.iconId, q.name, { dot: true }) }));
    place(it, q.x, q.z);
    it.title = q.name || KIND_NAMES.quest;
    it.lines = () => [q.level > 0 ? `${KIND_NAMES.quest}  ·  Lv ${q.level}` : KIND_NAMES.quest];
  }

  if (live.flag) {
    seen.add("flag");
    const it = liveItem("flag", "flag", () => ({ el: iconNode("lv", "flag", live.flag.iconId || 60561, "", { dot: true }) }));
    place(it, live.flag.x, live.flag.z);
    it.title = KIND_NAMES.flag;
    it.lines = () => [];
  }

  for (const [key, it] of S.lvItems) {
    if (seen.has(key)) continue;
    if (S.pop && S.pop.item === it) closePopover();
    it.el.remove();
    S.lvItems.delete(key);
    S.setChanged = true;
  }
  if (S.setChanged) { S.setChanged = false; scheduleDeclutter(); }
  refreshPopover();
}

// ---- tap popover ------------------------------------------------------------------------------

function* allItems() {
  yield* S.stItems;
  yield* S.lvItems.values();
  yield* S.clItems;
  yield* S.pitems.values();
}

function handleTap(sx, sy) {
  if (!S.meta || !S.imgOk) return;
  let best = null;
  let bestD = HIT_RADIUS * HIT_RADIUS;
  for (const it of allItems()) {
    if (!layerOn(it.kind) || it.dh || it.nc || (it.textOnly && !it.lblOn)) continue;
    const dx = S.tx + it.x * S.scale - sx;
    const dy = S.ty + it.y * S.scale - sy;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = it; } // later items (live, party, self) win ties
  }
  if (!best || (S.pop && S.pop.item === best)) closePopover();
  else if (best.isCluster) expandCluster(best);
  else openPopover(best);
}

// Tapping a cluster zooms in on it until its closest pair would split; if the zoom is exhausted (or members sit
// on top of each other) the members are listed in the popover instead.
function expandCluster(cl) {
  const sc = S.scale;
  let dmin = Infinity;
  const ms = cl.members;
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      const d = Math.hypot(ms[i].x - ms[j].x, ms[i].y - ms[j].y) * sc;
      if (d > 0.5 && d < dmin) dmin = d;
    }
  }
  const factor = Number.isFinite(dmin) ? Math.min(6, Math.max(1.8, (CLUSTER_PX * 1.3) / dmin)) : 1;
  const target = Math.min(MAX_ZOOM, sc * factor);
  if (target < sc * 1.08) { openPopover(cl); return; }
  closePopover();
  setFollow(false);
  S.scale = target;
  S.tx = S.vw / 2 - cl.x * target;
  S.ty = S.vh / 2 - cl.y * target;
  applyView(true);
}

function openPopover(item) {
  closePopover();
  const el = document.createElement("div");
  el.className = "mk pop";
  el.innerHTML = `<div class="mk-s"><div class="mappop"><div class="mappop-t"></div><div class="mappop-b"></div><div class="mappop-c"></div></div></div>`;
  S.markers.appendChild(el);
  S.pop = { el, item };
  refreshPopover();
}

function closePopover() {
  if (S && S.pop) { S.pop.el.remove(); S.pop = null; }
}

function refreshPopover() {
  if (!S.pop || !S.meta) return;
  const { el, item } = S.pop;
  placeMarker(el, item.x, item.y);
  const set = (sel, text) => { const n = el.querySelector(sel); if (n.textContent !== text) n.textContent = text; };
  set(".mappop-t", item.title || KIND_NAMES[item.kind] || "");
  set(".mappop-b", (item.lines ? item.lines() : []).join("\n"));
  set(".mappop-c", `X: ${pxToDisplay(item.x, S.meta.sizeFactor).toFixed(1)} Y: ${pxToDisplay(item.y, S.meta.sizeFactor).toFixed(1)}`);
}

// ---- map + snapshot ---------------------------------------------------------------------------

function setMap(mapId) {
  S.mapId = mapId;
  S.meta = null;
  S.imgOk = false;
  clearMarkers();
  updateMarkersVisibility();
  if (!mapId) { S.img.removeAttribute("src"); S.nameEl.textContent = "-"; return; }
  showMsg("Loading map...");
  S.img.removeAttribute("src");
  fetchMeta(mapId).then((meta) => {
    if (!S || S.mapId !== mapId) return; // superseded
    if (!meta) { showMsg("No map data for this area."); return; }
    S.meta = meta;
    S.img.src = `/api/map/${mapId}.png?token=${encodeURIComponent(token())}`;
    resetView();
    updateMarkersVisibility();
    if (S.last) updateMarkers(S.last);
    S.liveDirty = true;
    fetchStatic(mapId).then((set) => {
      if (!S || S.mapId !== mapId || !set || S.stItems.length) return;
      buildStatic(set);
    });
  });
}

function updateMarkers(snap) {
  const meta = S.meta;
  if (!meta) return;
  const p = snap.player;
  const seen = new Set();
  const track = (key, kind, x, y, title, lines) => {
    let it = S.pitems.get(key);
    if (!it) { it = { key, kind }; S.pitems.set(key, it); }
    it.x = x; it.y = y; it.title = title; it.lines = lines;
  };

  if (p) {
    const x = toPx(p.x, meta.offsetX, meta.sizeFactor);
    const y = toPx(p.z, meta.offsetY, meta.sizeFactor);
    S.player = { x, y };
    const m = markerEl("me", "me");
    placeMarker(m, x, y);
    m.querySelector(".mk-arrow").style.transform = `rotate(${180 - (p.rotation * 180) / Math.PI}deg)`;
    seen.add("me");
    track("me", "me", x, y, p.name || KIND_NAMES.me, () => [`${p.job} Lv ${p.level}`]);
    S.coordsEl.textContent =
      `X: ${toDisplay(p.x, meta.offsetX, meta.sizeFactor).toFixed(1)} Y: ${toDisplay(p.z, meta.offsetY, meta.sizeFactor).toFixed(1)}`;
  }

  (snap.party || []).forEach((pm, i) => {
    if (pm.isLocal || pm.territoryId !== snap.territoryId) return;
    const key = `p:${pm.name}`;
    const m = markerEl(key, "pm", PARTY_COLORS[i % PARTY_COLORS.length], pm.name);
    const x = toPx(pm.x, meta.offsetX, meta.sizeFactor);
    const y = toPx(pm.z, meta.offsetY, meta.sizeFactor);
    placeMarker(m, x, y);
    seen.add(key);
    track(key, "party", x, y, pm.name, () => [`${pm.job} Lv ${pm.level}`, `HP ${pm.hp} / ${pm.maxHp}`]);
  });

  for (const [key, m] of S.els) {
    if (!seen.has(key)) {
      m.remove();
      S.els.delete(key);
      if (S.pop && S.pop.item === S.pitems.get(key)) closePopover();
      S.pitems.delete(key);
    }
  }
  refreshPopover();

  if (S.follow && !S.pointers.size) { centerOnPlayer(); applyView(true); }
}

// ---- entry point (called by main.js on every data change) ------------------------------

export function render(el, { snapshot, live }) {
  if (!el.dataset.done || !S || !el.contains(S.root)) mount(el);
  if (!S.vw) layout();

  // Live markers arrive ~1 Hz and only in some pushes; remember the newest by sequence number.
  if (live && live.seq !== S.liveSeq) {
    S.live = live;
    S.liveSeq = live.seq;
    S.liveRecv = Date.now();
    S.liveDirty = true;
  }

  const snap = snapshot;
  S.last = snap;
  const isLive = !!(snap && snap.loggedIn && snap.player);

  if (!isLive) {
    S.markers.hidden = true;
    S.coordsEl.textContent = "";
    S.nameEl.textContent = snap && snap.loggedIn === false ? "Not logged in" : "-";
    if (!S.meta) showMsg("Not logged in to a character.");
    return;
  }
  if (snap.mapId !== S.mapId) setMap(snap.mapId);
  else if (!S.mapId) showMsg("Waiting for map...");
  else if (S.meta) {
    S.msg.hidden = S.imgOk;
    updateMarkersVisibility();
  }

  if (S.meta) {
    S.nameEl.textContent = S.meta.zone || S.meta.name || `Map ${S.mapId}`;
    S.nameEl.title = [S.meta.region, S.meta.zone, S.meta.subArea].filter(Boolean).join(" > ");
    updateMarkers(snap);
    if (S.liveDirty) applyLive();
  }
}

window.addEventListener("resize", () => { if (S && S.root.isConnected) layout(); });
