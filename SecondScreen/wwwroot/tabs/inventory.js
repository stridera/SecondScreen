export function render(el) {
  if (el.dataset.done) return;
  el.dataset.done = "1";
  el.innerHTML = `<div class="empty">Inventory view coming soon.</div>`;
}
