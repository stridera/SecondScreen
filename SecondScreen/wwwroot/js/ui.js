// Tiny DOM helpers shared by the dashboard shell: element factory, popover menu, toast.

export function h(tag, cls = "", html = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- popover ---------------------------------------------------------------------------------
// One popover at a time, anchored under (or above) an element, closed by outside press / Escape.
let pop = null;

export function closePopover() {
  if (!pop) return;
  const p = pop;
  pop = null;
  document.removeEventListener("pointerdown", p.onDown, true);
  document.removeEventListener("keydown", p.onKey, true);
  p.el.remove();
  p.anchor?.setAttribute("aria-expanded", "false");
}

export function isPopoverOpen() { return !!pop; }

export function openPopover(anchor, content, { align = "end" } = {}) {
  closePopover();
  const el = h("div", "popover");
  el.setAttribute("role", "menu");
  el.append(content);
  document.body.append(el);
  const place = () => {
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth, hh = el.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let left = align === "end" ? a.right - w : a.left;
    left = clamp(left, 8, Math.max(8, vw - w - 8));
    let top = a.bottom + 6;
    if (top + hh > vh - 8) top = Math.max(8, a.top - hh - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  place();
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === "Escape") closePopover(); };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  anchor.setAttribute("aria-expanded", "true");
  pop = { el, anchor, onDown, onKey };
  return el;
}

// ---- toast -----------------------------------------------------------------------------------
let toastTimer = 0;
export function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = h("div", "toast"); t.id = "toast"; t.setAttribute("role", "status"); document.body.append(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
