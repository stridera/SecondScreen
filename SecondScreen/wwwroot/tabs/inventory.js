// Inventory widget: placeholder until the inventory feed exists.
import { icon } from "../js/icons.js";

export function mount(el) {
  el.innerHTML = `<div class="empty">${icon("inventory", "big")}<div>Inventory view coming soon.</div></div>`;
}
