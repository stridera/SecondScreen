// Dashboard layout model: presets, validation, pure edit operations and per-device persistence.
//
//   Layout = { tabs?: boolean, columns: [ { widthFr: number, panels: [ { widget: <id>, heightFr: number } ] } ] }
//
// Column widths and panel heights are flex "fr" weights. `tabs: true` is the phone layout (one widget at a time).
// A widget id appears at most once per layout. The layout is stored per orientation slot (landscape / portrait)
// in localStorage; until the user picks or edits something, nothing is stored and the preset is auto-picked.

export const WIDGET_IDS = ["party", "map", "tracker", "inventory", "plugins"];
export const BREAKPOINT = 700;     // viewport width below which the tab UI is always used
export const MIN_COL_PX = 220;
export const MIN_PANEL_PX = 110;
export const MAX_COLUMNS = 6;
export const SPLIT_PX = 10;        // splitter / gap thickness

const P = (widget, heightFr = 1) => ({ widget, heightFr });
const C = (widthFr, ...panels) => ({ widthFr, panels });

export const PRESETS = [
  { id: "tabs", name: "Tabs (phone)", hint: "One panel at a time", layout: { tabs: true, columns: [] } },
  { id: "ipad-landscape", name: "iPad landscape", hint: "Party | Map | Tracker",
    layout: { columns: [C(1, P("party")), C(2, P("map")), C(1, P("tracker"))] } },
  { id: "ipad-portrait", name: "iPad portrait", hint: "Map and Party stacked | Tracker",
    layout: { columns: [C(3, P("map", 3), P("party", 2)), C(2, P("tracker"))] } },
  { id: "desktop", name: "Desktop 4-col", hint: "Party | Map | Tracker | Inventory + Plugins",
    layout: { columns: [C(1, P("party")), C(2.2, P("map")), C(1.1, P("tracker")), C(1, P("inventory"), P("plugins"))] } },
];

export const presetById = (id) => PRESETS.find((p) => p.id === id) || null;
export const clone = (l) => JSON.parse(JSON.stringify(l));

export function orientationOf(w, h) { return w >= h ? "landscape" : "portrait"; }

export function autoPresetId(w, h) {
  if (w < BREAKPOINT) return "tabs";
  if (w < h || w < 900) return "ipad-portrait";
  return w >= 1700 ? "desktop" : "ipad-landscape";
}

// ---- validation -------------------------------------------------------------------------------

const fr = (v) => (typeof v === "number" && isFinite(v) ? Math.round(Math.min(20, Math.max(0.1, v)) * 1000) / 1000 : 1);

/** Parse + normalise a layout (or an exported `{secondscreen:"layout", layout}` wrapper). Throws Error with a readable message. */
export function normalizeLayout(raw) {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { throw new Error("That is not valid JSON."); }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A layout must be a JSON object.");
  if (raw.secondscreen === "layout" && raw.layout) raw = raw.layout;
  if (raw.columns !== undefined && !Array.isArray(raw.columns)) throw new Error('"columns" must be an array.');
  const tabs = raw.tabs === true;
  const seen = new Set();
  const columns = [];
  for (const c of raw.columns || []) {
    if (!c || typeof c !== "object" || !Array.isArray(c.panels)) throw new Error('Each column needs a "panels" array.');
    const panels = [];
    for (const p of c.panels) {
      const id = typeof p === "string" ? p : p && p.widget;
      if (!WIDGET_IDS.includes(id)) throw new Error(`Unknown panel "${id}". Known: ${WIDGET_IDS.join(", ")}.`);
      if (seen.has(id)) continue; // a widget may appear only once
      seen.add(id);
      panels.push({ widget: id, heightFr: fr(p && p.heightFr) });
    }
    if (panels.length) columns.push({ widthFr: fr(c.widthFr), panels });
  }
  if (!tabs && columns.length === 0) throw new Error("The layout needs at least one column with a panel.");
  if (columns.length > MAX_COLUMNS) throw new Error(`At most ${MAX_COLUMNS} columns are supported.`);
  return { tabs, columns: tabs ? [] : columns };
}

export function exportLayout(layout) {
  return JSON.stringify({ secondscreen: "layout", version: 1, layout }, null, 2);
}

// ---- queries / pure edit operations (every op returns a new layout) ------------------------------

export const placedIds = (l) => new Set(l.columns.flatMap((c) => c.panels.map((p) => p.widget)));

function locate(l, id) {
  for (let ci = 0; ci < l.columns.length; ci++) {
    const pi = l.columns[ci].panels.findIndex((p) => p.widget === id);
    if (pi >= 0) return { ci, pi };
  }
  return null;
}

const avg = (xs, key) => (xs.length ? xs.reduce((a, x) => a + x[key], 0) / xs.length : 1);
const pruneCol = (l, col) => { if (col.panels.length === 0) l.columns = l.columns.filter((c) => c !== col); };

/** Remove a panel; its column disappears if that leaves it empty (but never the last column). */
export function removePanel(layout, id) {
  const l = clone(layout);
  const at = locate(l, id);
  if (!at) return l;
  const col = l.columns[at.ci];
  col.panels.splice(at.pi, 1);
  if (l.columns.length > 1) pruneCol(l, col);
  return l;
}

/** target = { ci, index } (insert into column ci before position `index`) or { newCol: index } (new column at index). */
export function movePanel(layout, id, target) {
  const l = clone(layout);
  const at = locate(l, id);
  if (!at) return l;
  const src = l.columns[at.ci];
  let dest, idx;
  if (target.newCol !== undefined) {
    dest = { widthFr: Math.round(avg(l.columns, "widthFr") * 1000) / 1000, panels: [] };
    l.columns.splice(clamp(target.newCol, 0, l.columns.length), 0, dest);
    idx = 0;
  } else {
    dest = l.columns[target.ci];
    idx = target.index;
    if (dest === src && at.pi < idx) idx -= 1;
  }
  const [panel] = src.panels.splice(at.pi, 1);
  if (dest !== src) panel.heightFr = Math.round(avg(dest.panels, "heightFr") * 1000) / 1000 || 1;
  dest.panels.splice(clamp(idx, 0, dest.panels.length), 0, panel);
  if (src !== dest) pruneCol(l, src);
  return l;
}

export function addPanel(layout, id, ci) {
  const l = clone(layout);
  if (placedIds(l).has(id)) return l;
  const col = l.columns[ci] || l.columns[l.columns.length - 1];
  if (!col) { l.columns.push({ widthFr: 1, panels: [{ widget: id, heightFr: 1 }] }); return l; }
  col.panels.push({ widget: id, heightFr: Math.round(avg(col.panels, "heightFr") * 1000) / 1000 || 1 });
  return l;
}

/** Insert an empty column at `index` (pruned again on leaving edit mode if it is still empty). */
export function addColumn(layout, index) {
  const l = clone(layout);
  l.columns.splice(clamp(index, 0, l.columns.length), 0, { widthFr: Math.round(avg(l.columns, "widthFr") * 1000) / 1000 || 1, panels: [] });
  return l;
}

export function removeColumn(layout, ci) {
  const l = clone(layout);
  if (l.columns.length > 1) l.columns.splice(ci, 1);
  return l;
}

export function pruneEmpty(layout) {
  const l = clone(layout);
  const kept = l.columns.filter((c) => c.panels.length);
  l.columns = kept.length ? kept : l.columns.slice(0, 1);
  return l;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- persistence (per device, per orientation slot) -------------------------------------------------

const key = (slot) => `ss.layout.${slot}`;

/** @returns {{preset: string, layout: object} | null} */
export function loadSlot(slot) {
  try {
    const raw = JSON.parse(localStorage.getItem(key(slot)) || "null");
    if (!raw) return null;
    const layout = normalizeLayout(raw.layout);
    return { preset: typeof raw.preset === "string" ? raw.preset : "custom", layout };
  } catch { return null; }
}

export function saveSlot(slot, state) {
  try { localStorage.setItem(key(slot), JSON.stringify({ preset: state.preset, layout: state.layout })); } catch { /* storage full / private mode */ }
}

export function clearSlot(slot) {
  try { localStorage.removeItem(key(slot)); } catch { /* ignore */ }
}
