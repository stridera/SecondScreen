// Map tab: zone map image + live player/party markers with touch/mouse pan and zoom.
//
// Coordinates (see MapData.cs): with c = sizeFactor / 100 and the 2048px map texture,
//   px = (worldX + offsetX) * c + 1024        py = (worldZ + offsetY) * c + 1024
//   in-game display coordinate = 41 / c * (px / 2048) + 1
//
// Rotation: FFXIV rotation 0 faces +Z (south, DOWN on the map); the facing vector in (x, z) is
// (sin r, cos r), so +PI/2 faces +X (east, right). Screen space is x right / y down, and the arrow
// glyph points UP (screen vector (0,-1)) at CSS rotate(0). CSS rotate(phi) is clockwise and turns
// (0,-1) into (sin phi, -cos phi). Matching (sin r, cos r) gives phi = PI - r.

const TEX = 2048;
const MIN_ZOOM_FACTOR = 0.9;   // relative to the "fit whole map" scale
const MAX_ZOOM = 3;            // CSS px per texture px
const DEFAULT_ZOOM_FACTOR = 1.8;
const LABEL_ZOOM_FACTOR = 1.6; // party name labels appear once zoomed in this far past "fit"
const PARTY_COLORS = ["#e0a93d", "#4cc46a", "#c06bff", "#ff7a59", "#37c8c8", "#ff6fb1", "#a3d65c"];

const metaCache = new Map(); // mapId -> Promise<meta | null>
let S = null;                // state for the currently mounted tab instance

const token = () => localStorage.getItem("ss.token") || "";

function fetchMeta(mapId) {
  if (!metaCache.has(mapId)) {
    const p = fetch(`/api/map/${mapId}?token=${encodeURIComponent(token())}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    metaCache.set(mapId, p);
    p.then((m) => { if (!m) metaCache.delete(mapId); });
  }
  return metaCache.get(mapId);
}

const toPx = (world, offset, sf) => (world + offset) * (sf / 100) + TEX / 2;
const toDisplay = (world, offset, sf) => (41 / (sf / 100)) * (toPx(world, offset, sf) / TEX) + 1;

function mount(el) {
  el.dataset.done = "1";
  el.innerHTML = `
    <div class="mapwrap">
      <div class="maphead">
        <div class="mapname">-</div>
        <div class="mapcoords"></div>
        <button type="button" class="mapfollow on" aria-pressed="true">Follow me</button>
      </div>
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
    root,
    vp: root.querySelector(".mapvp"),
    stage: root.querySelector(".mapstage"),
    img: root.querySelector(".mapimg"),
    markers: root.querySelector(".mapmarkers"),
    msg: root.querySelector(".mapmsg"),
    nameEl: root.querySelector(".mapname"),
    coordsEl: root.querySelector(".mapcoords"),
    followBtn: root.querySelector(".mapfollow"),
    mapId: 0,
    meta: null,
    imgOk: false,
    follow: true,
    scale: 0.3, tx: 0, ty: 0,
    vw: 0, vh: 0,
    player: null,           // marker px position {x, y}
    els: new Map(),         // marker key -> element
    pointers: new Map(),    // pointerId -> {x, y}
    gesture: null,
  };
  S.img.addEventListener("load", () => { S.imgOk = true; S.msg.textContent = ""; S.msg.hidden = true; updateMarkersVisibility(); });
  S.img.addEventListener("error", () => { S.imgOk = false; showMsg("Map image unavailable."); });
  S.followBtn.addEventListener("click", () => setFollow(!S.follow, true));
  bindGestures(S);
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
  S.stage.classList.toggle("labels", S.scale >= fitScale() * LABEL_ZOOM_FACTOR);
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

function layout() {
  const rect = S.vp.getBoundingClientRect();
  const h = Math.max(260, Math.floor(window.innerHeight - rect.top - 16));
  if (S.vp.style.height !== `${h}px`) S.vp.style.height = `${h}px`;
  const w = S.vp.clientWidth, vh = S.vp.clientHeight;
  if (w && vh && (w !== S.vw || vh !== S.vh)) {
    const first = S.vw === 0;
    const oldFit = first ? 0 : fitScale();
    S.vw = w; S.vh = vh;
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
      if (s.gesture.moved < 4) return; // ignore taps / jitter
      s.tx += dx; s.ty += dy;
      if (s.follow) setFollow(false);
      applyView();
    } else if (s.pointers.size === 2) {
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
    s.pointers.delete(e.pointerId);
    s.gesture = null; // remaining finger (if any) restarts as a single-pointer drag
    try { vp.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
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

// ---- markers ------------------------------------------------------------------------------

function markerEl(key, kind, color, name) {
  let m = S.els.get(key);
  if (m) return m;
  m = document.createElement("div");
  m.className = `mk ${kind}`;
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

function updateMarkersVisibility() {
  S.markers.hidden = !(S.imgOk && S.meta);
}

function clearMarkers() {
  for (const m of S.els.values()) m.remove();
  S.els.clear();
  S.player = null;
}

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
  });
}

function updateMarkers(snap) {
  const meta = S.meta;
  if (!meta) return;
  const p = snap.player;
  const seen = new Set();

  if (p) {
    const x = toPx(p.x, meta.offsetX, meta.sizeFactor);
    const y = toPx(p.z, meta.offsetY, meta.sizeFactor);
    S.player = { x, y };
    const m = markerEl("me", "me");
    placeMarker(m, x, y);
    m.querySelector(".mk-arrow").style.transform = `rotate(${180 - (p.rotation * 180) / Math.PI}deg)`;
    seen.add("me");
    S.coordsEl.textContent =
      `X: ${toDisplay(p.x, meta.offsetX, meta.sizeFactor).toFixed(1)} Y: ${toDisplay(p.z, meta.offsetY, meta.sizeFactor).toFixed(1)}`;
  }

  (snap.party || []).forEach((pm, i) => {
    if (pm.isLocal || pm.territoryId !== snap.territoryId) return;
    const key = `p:${pm.name}`;
    const m = markerEl(key, "pm", PARTY_COLORS[i % PARTY_COLORS.length], pm.name);
    placeMarker(m, toPx(pm.x, meta.offsetX, meta.sizeFactor), toPx(pm.z, meta.offsetY, meta.sizeFactor));
    seen.add(key);
  });

  for (const [key, m] of S.els) {
    if (!seen.has(key)) { m.remove(); S.els.delete(key); }
  }

  if (S.follow && !S.pointers.size) { centerOnPlayer(); applyView(true); }
}

// ---- entry point (called by main.js on every data change) ------------------------------

export function render(el, { snapshot }) {
  if (!el.dataset.done || !S || !el.contains(S.root)) mount(el);
  layout();

  const snap = snapshot;
  S.last = snap;
  const live = !!(snap && snap.loggedIn && snap.player);

  if (!live) {
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
  }
}

window.addEventListener("resize", () => { if (S && S.root.isConnected) layout(); });
