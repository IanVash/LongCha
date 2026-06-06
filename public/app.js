const CART_KEY = 'qr-food-pos-cart-v1';
const KIOSK_CART_KEY = 'qr-food-pos-kiosk-cart-v1';
const LAST_ORDER_KEY = 'qr-food-pos-last-order';
const LAST_WHATSAPP_KEY = 'qr-food-pos-last-whatsapp-url';
const CUSTOMER_ORDERS_KEY = 'qr-food-pos-customer-orders';
const TABLE_KEY = 'qr-food-pos-table';
const DEFAULT_KIOSK_IDLE_SECONDS = 75;
const DEFAULT_KIOSK_CART_TIMEOUT_SECONDS = 300;
const DEFAULT_PRINTER_CONFIG = {
  printers: {
    caja: {
      enabled: true,
      name: 'Caja',
      type: 'thermal',
      ticketWidthMm: 80,
      fontSizePt: 13,
      connectionMode: 'browser',
      systemPrinterName: '',
      networkHost: '',
      networkPort: 9100
    },
    cocina: {
      enabled: true,
      name: 'Cocina',
      type: 'thermal',
      ticketWidthMm: 80,
      fontSizePt: 13,
      connectionMode: 'browser',
      systemPrinterName: '',
      networkHost: '',
      networkPort: 9100
    },
    kiosk: {
      enabled: true,
      name: 'Kiosko',
      type: 'thermal',
      ticketWidthMm: 80,
      fontSizePt: 14,
      connectionMode: 'browser',
      systemPrinterName: '',
      networkHost: '',
      networkPort: 9100,
      printOrderNumberOnly: true
    },
    etiquetas: {
      enabled: true,
      name: 'Zebra vasos',
      type: 'zebra-label',
      labelWidthIn: 2,
      labelHeightIn: 1,
      copiesPerDrink: 1,
      connectionMode: 'browser',
      systemPrinterName: '',
      networkHost: '',
      networkPort: 9100,
      includePrice: false,
      autoPrintFromKiosk: false
    }
  },
  labelDrinkCategorySlugs: ['milk-tea', 'smoothies', 'iced-coffee', 'refreshers']
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
const page = document.body.dataset.page;
let statusEvents = null;
let statusPollTimer = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud.');
  return data;
}

function showToast(message) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-visible');
  setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function cartStorageKey() {
  return page === 'kiosk' ? KIOSK_CART_KEY : CART_KEY;
}

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(cartStorageKey()) || '[]');
  } catch {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(cartStorageKey(), JSON.stringify(cart));
  updateCartBar();
}

function lineTotalCents(item) {
  const extras = (item.extrasData || []).reduce((sum, extra) => sum + Number(extra.priceCents || 0), 0);
  const options = (item.optionSelections || [])
    .flatMap((selection) => selection.options || [])
    .reduce((sum, option) => sum + Number(option.priceCents || 0), 0);
  return (Number(item.basePriceCents || 0) + extras + options) * Number(item.quantity || 1);
}

function cartTotalCents(cart = getCart()) {
  return cart.reduce((sum, item) => sum + lineTotalCents(item), 0);
}

function normalizedName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function publicOptionalGroups(product) {
  return product.optionalGroups || [];
}

function publicVariants(product) {
  const groupNames = new Set(publicOptionalGroups(product).map((group) => normalizedName(group.name)));
  return (product.variants || []).filter((variant) => !groupNames.has(normalizedName(variant.name)));
}

function hasAddonGroup(product) {
  const addonNames = new Set(['extras', 'extra', 'toppings', 'topping', 'boba', 'adicionales', 'agregados']);
  return publicOptionalGroups(product).some((group) => addonNames.has(normalizedName(group.name)));
}

function publicExtras(product) {
  return hasAddonGroup(product) ? [] : (product.extras || []);
}

function shouldPreselectCustomization(groupName, optionName) {
  const group = normalizedName(groupName);
  const option = normalizedName(optionName);
  const isSugar = group.includes('azucar') || group.includes('sugar');
  const isIce = group.includes('hielo') || group.includes('ice');
  const isMilk = group.includes('leche') || group.includes('milk');
  const isAddon = ['boba', 'topping', 'toppings', 'extra', 'extras', 'adicional', 'adicionales', 'agregado', 'agregados'].some((word) => group.includes(word));

  if (isSugar) return option.includes('100');
  if (isIce) return option.includes('normal') || option.includes('regular');
  if (isMilk) return option.includes('entera') || option.includes('whole') || option.includes('standard');
  if (isAddon) return option.includes('tapioca') || option.includes('perla');
  return false;
}

function updateCartItemQuantity(cartId, nextQuantity) {
  const quantity = Math.max(1, Math.min(99, Number(nextQuantity || 1)));
  const cart = getCart().map((item) => (
    item.cartId === cartId ? { ...item, quantity } : item
  ));
  saveCart(cart);
  return cart;
}

function updateBusinessHeader(menu) {
  if (!menu?.business) return;
  $$('[data-business-name]').forEach((node) => { node.textContent = menu.business.name; });
  $$('[data-business-heading]').forEach((node) => { node.textContent = menu.business.name; });
  $$('[data-business-logo]').forEach((node) => {
    node.src = menu.business.logoUrl || '/assets/brand/longcha-mark.png';
  });
  const openState = $('[data-open-state]');
  if (openState) {
    openState.textContent = menu.openState.open ? 'Abierto para pedidos' : 'Cerrado ahora';
    openState.classList.toggle('is-open', Boolean(menu.openState.open));
    openState.classList.toggle('is-closed', !menu.openState.open);
  }
  const table = getTableLabel();
  $$('[data-table-label]').forEach((node) => {
    node.textContent = table ? `Mesa: ${table}` : '';
    node.hidden = !table;
  });
}

function ordersAreOpen(source) {
  return Boolean(source?.openState?.open);
}

function closedOrderMessage(source) {
  return source?.openState?.message || source?.business?.closedMessage || 'Estamos cerrados en este momento.';
}

function notifyOrdersClosed(source) {
  const message = closedOrderMessage(source);
  if ($('#toast')) showToast(message);
  else alert(message);
}

function closedOrderNotice(source) {
  if (ordersAreOpen(source)) return '';
  return `
    <div class="order-closed-note">
      <span>Pedidos cerrados</span>
      <strong>${escapeHtml(closedOrderMessage(source))}</strong>
    </div>
  `;
}

function getTableLabel() {
  return localStorage.getItem(TABLE_KEY) || '';
}

function whatsappStorageKey(orderNumber) {
  return `${LAST_WHATSAPP_KEY}:${orderNumber}`;
}

function rememberCustomerOrder(orderNumber) {
  let orders = [];
  try {
    orders = JSON.parse(localStorage.getItem(CUSTOMER_ORDERS_KEY) || '[]');
  } catch {
    orders = [];
  }
  orders = orders.filter((item) => item && item !== orderNumber);
  orders.unshift(orderNumber);
  localStorage.setItem(CUSTOMER_ORDERS_KEY, JSON.stringify(orders.slice(0, 12)));
}

function captureTableFromUrl() {
  const table = new URLSearchParams(location.search).get('table');
  if (table) localStorage.setItem(TABLE_KEY, table.trim().slice(0, 80));
}

function updateCartBar() {
  const bar = $('#cartBar');
  if (!bar) return;
  const cart = getCart();
  const count = cart.reduce((sum, item) => sum + Number(item.quantity || 1), 0);
  bar.hidden = count === 0;
  $('#cartBarCount').textContent = `${count} producto${count === 1 ? '' : 's'}`;
  $('#cartBarTotal').textContent = money(cartTotalCents(cart));
}

async function initHome() {
  const menu = await api('/api/public/menu');
  updateBusinessHeader(menu);
}

async function initMenu() {
  captureTableFromUrl();
  const state = {
    menu: await api('/api/public/menu'),
    category: 'all',
    search: ''
  };
  updateBusinessHeader(state.menu);
  const heroCount = $('#heroProductCount');
  if (heroCount) heroCount.textContent = `${state.menu.products.length} productos`;
  renderTableNotice();
  if (!ordersAreOpen(state.menu)) {
    const noticeWrap = document.createElement('div');
    noticeWrap.className = 'shell';
    noticeWrap.innerHTML = closedOrderNotice(state.menu);
    document.querySelector('.menu-toolbar')?.after(noticeWrap);
  }
  renderCategoryChips(state);
  renderProducts(state);
  updateCartBar();

  $('#productSearch').addEventListener('input', (event) => {
    state.search = event.target.value.toLowerCase();
    renderProducts(state);
  });
  $('#categoryChips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    state.category = button.dataset.category;
    renderCategoryChips(state);
    renderProducts(state);
  });
  document.addEventListener('click', (event) => {
    const addButton = event.target.closest('[data-add-product]');
    if (addButton) {
      if (!ordersAreOpen(state.menu)) {
        notifyOrdersClosed(state.menu);
        return;
      }
      const product = state.menu.products.find((item) => item.id === Number(addButton.dataset.addProduct));
      if (product) openProductDialog(product);
    }
    if (event.target.closest('[data-open-cart]')) openCartDialog(state.menu);
  });
}

function renderTableNotice() {
  const table = getTableLabel();
  if (!table || $('#tableNotice')) return;
  const notice = document.createElement('div');
  notice.className = 'shell table-notice';
  notice.id = 'tableNotice';
  notice.innerHTML = `<strong>${escapeHtml(table)}</strong><span class="muted">Tu pedido se enviara con esta mesa.</span>`;
  document.querySelector('.menu-toolbar')?.after(notice);
}

function renderCategoryChips(state) {
  $('#categoryChips').innerHTML = [
    `<button class="chip ${state.category === 'all' ? 'is-active' : ''}" type="button" data-category="all">Todo</button>`,
    ...state.menu.categories.map((category) => `
      <button class="chip ${state.category === category.slug ? 'is-active' : ''}" type="button" data-category="${category.slug}">
        ${escapeHtml(category.name)}
      </button>
    `)
  ].join('');
}

function productMatches(product, state) {
  const term = state.search.trim();
  const categoryOk = state.category === 'all' || product.categorySlug === state.category;
  const searchOk = !term || `${product.name} ${product.description}`.toLowerCase().includes(term);
  return categoryOk && searchOk;
}

function renderProducts(state) {
  const products = state.menu.products.filter((product) => productMatches(product, state));
  const featured = state.menu.featured.filter((product) => productMatches(product, state));
  $('#productCount').textContent = `${products.length} productos`;
  $('#featuredSection').hidden = featured.length === 0;
  $('#featuredProducts').innerHTML = featured.map((product) => productCard(product, ordersAreOpen(state.menu))).join('');
  $('#productGrid').innerHTML = products.length
    ? products.map((product) => productCard(product, ordersAreOpen(state.menu))).join('')
    : '<div class="empty-state">No encontramos productos con ese filtro.</div>';
}

function productCard(product, openForOrders = true) {
  const disabled = product.soldOut || !openForOrders ? 'disabled' : '';
  const optionCount = publicOptionalGroups(product).length + publicVariants(product).length + (publicExtras(product).length ? 1 : 0);
  return `
    <article class="product-card ${product.soldOut || !openForOrders ? 'is-sold-out' : ''}">
      <div class="product-card__media">
        <img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">
        <div class="product-card__badges">
          ${product.featured ? '<span class="badge badge--hot">Popular</span>' : ''}
          ${product.soldOut ? '<span class="badge badge--danger">Agotado</span>' : ''}
        </div>
      </div>
      <div class="product-card__body">
        <div>
          <div class="price-row">
            <h3>${escapeHtml(product.name)}</h3>
          </div>
          <p>${escapeHtml(product.description)}</p>
          <div class="product-meta">
            <span>${escapeHtml(product.categoryName || 'Menu')}</span>
            ${optionCount ? `<span>${optionCount} opciones</span>` : ''}
          </div>
        </div>
        <div class="price-row">
          <span class="price">${money(product.basePriceCents)}</span>
          ${product.soldOut
            ? '<span class="badge badge--danger">Agotado</span>'
            : !openForOrders
              ? '<button class="btn btn--ghost btn--small product-add-cta" type="button" disabled>Cerrado</button>'
            : `<button class="btn btn--brand btn--small product-add-cta" type="button" data-add-product="${product.id}" ${disabled}>Agregar</button>`}
        </div>
      </div>
    </article>
  `;
}

function productFormTotalCents(product, formElement) {
  if (!formElement) return product.basePriceCents;
  const form = new FormData(formElement);
  const quantity = Math.max(1, Math.min(99, Number(form.get('quantity') || 1)));
  const extraIds = form.getAll('extra').map(Number);
  const extrasTotal = publicExtras(product)
    .filter((extra) => extraIds.includes(extra.id))
    .reduce((sum, extra) => sum + Number(extra.priceCents || 0), 0);
  const optionTotal = publicOptionalGroups(product).reduce((sum, group) => {
    const optionIds = form.getAll(`optional:${group.id}`).map(Number);
    return sum + group.options
      .filter((option) => optionIds.includes(option.id))
      .reduce((optionSum, option) => optionSum + Number(option.priceCents || 0), 0);
  }, 0);
  return (Number(product.basePriceCents || 0) + extrasTotal + optionTotal) * quantity;
}

function openProductDialog(product, options = {}) {
  const dialog = $('#productDialog');
  dialog.className = 'dialog dialog--customizer';
  const variants = publicVariants(product);
  const optionGroups = publicOptionalGroups(product);
  const extras = publicExtras(product);
  dialog.innerHTML = `
    <form method="dialog" class="dialog__body product-dialog-form product-customizer" id="productForm">
      <div class="customizer-topbar">
        <button class="icon-btn customizer-close" type="button" data-close-dialog aria-label="Cerrar">&times;</button>
        <div>
          <span class="eyebrow">Personaliza tu pedido</span>
          <h2>${escapeHtml(product.name)}</h2>
        </div>
      </div>
      ${product.featured ? '<div class="customizer-ribbon">Favorito Long Cha</div>' : ''}
      <section class="customizer-product-summary">
        <img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}">
        <div>
          <p>${escapeHtml(product.description || 'Bebida preparada al momento con el sello de Long Cha.')}</p>
          <span>Personaliza tamano, azucar, hielo, leche y toppings.</span>
        </div>
      </section>
      <div class="product-dialog-content">
        ${variants.map((variant, index) => variantGroupControl(variant, index)).join('')}
        ${optionGroups.map((group) => optionalGroupControl(group)).join('')}
      ${extras.length ? `
        <section class="customizer-group">
          <legend>Toppings y extras</legend>
          <div class="customizer-option-grid">
            ${extras.map((extra) => extraOptionTile(extra)).join('')}
          </div>
        </section>
      ` : ''}
      </div>
      <div class="product-dialog-action">
        <div class="customizer-qty" aria-label="Cantidad">
          <button type="button" data-dialog-qty="-1">-</button>
          <input name="quantity" type="number" min="1" max="99" value="1" aria-label="Cantidad">
          <button type="button" data-dialog-qty="1">+</button>
        </div>
        <button class="btn btn--brand customizer-submit" type="submit">
          <span>Agregar al carrito</span>
          <strong id="productDialogTotal">${money(product.basePriceCents)}</strong>
        </button>
      </div>
    </form>
  `;
  $('[data-close-dialog]', dialog).addEventListener('click', () => dialog.close());
  const productForm = $('#productForm');
  const updateTotal = () => {
    $('#productDialogTotal').textContent = money(productFormTotalCents(product, productForm));
  };
  productForm.addEventListener('input', updateTotal);
  productForm.addEventListener('change', updateTotal);
  productForm.addEventListener('click', (event) => {
    const qty = event.target.closest('[data-dialog-qty]');
    if (!qty) return;
    const input = productForm.elements.quantity;
    input.value = Math.max(1, Math.min(99, Number(input.value || 1) + Number(qty.dataset.dialogQty || 0)));
    updateTotal();
  });
  productForm.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-max-select]');
    if (!checkbox || !checkbox.checked) return;
    const max = Number(checkbox.dataset.maxSelect || 0);
    if (!max) return;
    const checked = $$(`input[name="${checkbox.name}"]:checked`, productForm);
    if (checked.length > max) {
      checkbox.checked = false;
      alert(`Solo puedes seleccionar ${max} opcion(es) en este grupo.`);
      updateTotal();
    }
  });
  productForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const variants = {};
    for (const [key, value] of form.entries()) {
      if (key.startsWith('variant:')) variants[key.replace('variant:', '')] = value;
    }
    const extraIds = form.getAll('extra').map(Number);
    const selectedExtras = extras.filter((extra) => extraIds.includes(extra.id));
    const optionSelections = collectOptionSelections(product, form);
    const optionError = validateOptionSelections(product, optionSelections);
    if (optionError) {
      alert(optionError);
      return;
    }
    const cart = getCart();
    cart.push({
      cartId: crypto.randomUUID(),
      productId: product.id,
      name: product.name,
      imageUrl: product.imageUrl,
      basePriceCents: product.basePriceCents,
      quantity: Number(form.get('quantity') || 1),
      variants,
      extras: extraIds,
      extrasData: selectedExtras,
      optionSelections,
      notes: ''
    });
    saveCart(cart);
    dialog.close();
    if (typeof options.afterAdd === 'function') options.afterAdd(cart.at(-1));
    else openCartDialog();
  });
  updateTotal();
  dialog.showModal();
}

function variantGroupControl(variant, index) {
  const defaultIndex = variant.options.findIndex((option) => shouldPreselectCustomization(variant.name, option));
  return `
    <fieldset class="customizer-group">
      <legend>${escapeHtml(variant.name)}${variant.required ? ' *' : ''}</legend>
      <div class="customizer-option-grid">
        ${variant.options.map((option, optionIndex) => `
          <label class="customizer-option-tile">
            <input type="radio" name="variant:${escapeHtml(variant.name)}" value="${escapeHtml(option)}" ${variant.required ? 'required' : ''} ${(defaultIndex >= 0 ? optionIndex === defaultIndex : optionIndex === 0) ? 'checked' : ''}>
            <span class="customizer-option-icon">${optionIcon(variant.name, option)}</span>
            <span class="customizer-option-label">${escapeHtml(option)}</span>
          </label>
        `).join('')}
      </div>
    </fieldset>
  `;
}

function optionalGroupControl(group) {
  const inputType = group.maxSelect === 1 ? 'radio' : 'checkbox';
  const defaultIndex = group.options.findIndex((option) => shouldPreselectCustomization(group.name, option.name));
  return `
    <fieldset class="customizer-group">
      <legend>${escapeHtml(group.name)}${group.required ? ' *' : ''}</legend>
      <div class="customizer-option-grid">
      ${group.options.map((option, optionIndex) => `
        <label class="customizer-option-tile">
          <input type="${inputType}" name="optional:${group.id}" value="${option.id}" ${group.required && inputType === 'radio' ? 'required' : ''} ${(inputType === 'radio' ? (defaultIndex >= 0 ? optionIndex === defaultIndex : group.required && optionIndex === 0) : optionIndex === defaultIndex) ? 'checked' : ''} ${inputType === 'checkbox' ? `data-max-select="${group.maxSelect || 0}"` : ''}>
          <span class="customizer-option-icon">${optionIcon(group.name, option.name)}</span>
          <span class="customizer-option-label">${escapeHtml(option.name)}</span>
          ${option.priceCents ? `<span class="customizer-option-price">+${money(option.priceCents)}</span>` : ''}
        </label>
      `).join('')}
      </div>
      ${group.maxSelect > 1 ? `<div class="muted">Maximo ${group.maxSelect} opciones</div>` : ''}
    </fieldset>
  `;
}

function extraOptionTile(extra) {
  return `
    <label class="customizer-option-tile">
      <input type="checkbox" name="extra" value="${extra.id}" ${shouldPreselectCustomization('extras', extra.name) ? 'checked' : ''}>
      <span class="customizer-option-icon">${optionIcon('extras', extra.name)}</span>
      <span class="customizer-option-label">${escapeHtml(extra.name)}</span>
      <span class="customizer-option-price">+${money(extra.priceCents)}</span>
    </label>
  `;
}

function optionIcon(groupName, optionName = '') {
  const text = normalizedName(`${groupName} ${optionName}`);
  if (text.includes('azucar') || text.includes('sugar')) {
    if (text.includes('no ') || text.includes('0%')) return iconSvg('none');
    if (text.includes('extra')) return iconSvg('sugar-cubes');
    return iconSvg('sugar');
  }
  if (text.includes('hielo') || text.includes('ice')) {
    if (text.includes('sin') || text.includes('no ice')) return iconSvg('snow');
    if (text.includes('hot') || text.includes('warm') || text.includes('caliente')) return iconSvg('hot');
    return iconSvg('ice');
  }
  if (text.includes('caliente') || text.includes('hot') || text.includes('warm')) return iconSvg('hot');
  if (text.includes('tamano') || text.includes('size') || text.includes('oz') || text.includes(' m') || text.includes(' l')) return iconSvg('cup');
  if (text.includes('leche') || text.includes('milk') || text.includes('avena') || text.includes('oat')) return iconSvg(text.includes('oat') || text.includes('avena') ? 'oat' : 'milk');
  if (text.includes('boba') || text.includes('topping') || text.includes('extra') || text.includes('jelly')) return iconSvg('boba');
  return iconSvg('plus');
}

function iconSvg(type) {
  const icons = {
    milk: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M11 3h10l-1 6 3 5v14H9V14l3-5-1-6z"/><path d="M12 14h8"/><path d="M16 19c2 2 3 3.5 3 5a3 3 0 0 1-6 0c0-1.5 1-3 3-5z"/></svg>',
    oat: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M11 4h10l-1 6 3 5v13H9V15l3-5-1-6z"/><path d="M20 23c5-5 8-2 8-2s-2 5-8 4"/><path d="M18 25c-3-5-7-4-7-4s1 5 7 5"/></svg>',
    cup: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 5h14l-2 23H11L9 5z"/><path d="M12 18c3 2 6 2 9 0"/></svg>',
    ice: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 8l7-2 3 7-7 2-3-7z"/><path d="M17 9l7 2-2 7-7-2 2-7z"/><path d="M11 18l7-2 3 7-7 2-3-7z"/></svg>',
    snow: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 5v22"/><path d="M7 10l18 12"/><path d="M25 10L7 22"/><path d="M12 7l4 4 4-4"/><path d="M12 25l4-4 4 4"/></svg>',
    hot: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M10 25c-2-4 2-5 0-9"/><path d="M16 25c-2-4 2-5 0-9"/><path d="M22 25c-2-4 2-5 0-9"/><path d="M9 9c5-3 9-3 14 0"/></svg>',
    sugar: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="21" cy="12" r="2"/><circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/><circle cx="21" cy="20" r="2"/></svg>',
    'sugar-cubes': '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 18l6-3 6 3-6 4-6-4z"/><path d="M14 12l6-3 6 3-6 4-6-4z"/><path d="M13 22l6-3 6 3-6 4-6-4z"/></svg>',
    none: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 8h16v16H8z"/><path d="M8 24L24 8"/></svg>',
    boba: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M10 5h12l-2 22h-8L10 5z"/><circle cx="14" cy="20" r="2"/><circle cx="19" cy="22" r="2"/><circle cx="16" cy="26" r="2"/></svg>',
    plus: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 7v18"/><path d="M7 16h18"/></svg>'
  };
  return icons[type] || icons.plus;
}

function collectOptionSelections(product, form) {
  return publicOptionalGroups(product).map((group) => {
    const optionIds = form.getAll(`optional:${group.id}`).map(Number);
    const options = group.options.filter((option) => optionIds.includes(option.id));
    return {
      groupId: group.id,
      groupName: group.name,
      required: group.required,
      maxSelect: group.maxSelect,
      optionIds,
      options
    };
  }).filter((selection) => selection.optionIds.length || selection.required);
}

function validateOptionSelections(product, selections) {
  const byGroup = new Map(selections.map((selection) => [selection.groupId, selection]));
  for (const group of publicOptionalGroups(product)) {
    const selection = byGroup.get(group.id);
    const total = selection?.optionIds.length || 0;
    if (group.required && total === 0) return `Selecciona al menos una opcion para ${group.name}.`;
    if (group.maxSelect > 0 && total > group.maxSelect) return `${group.name} permite maximo ${group.maxSelect} opcion(es).`;
  }
  return '';
}

function cartLine(item) {
  const variants = Object.entries(item.variants || {}).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join(', ');
  const extras = (item.extrasData || []).map((extra) => `${escapeHtml(extra.name)} +${money(extra.priceCents)}`).join(', ');
  const optionText = (item.optionSelections || [])
    .flatMap((selection) => (selection.options || []).map((option) => `${escapeHtml(selection.groupName)}: ${escapeHtml(option.name)}${option.priceCents ? ` +${money(option.priceCents)}` : ''}`))
    .join(', ');
  return `
    <div class="cart-line">
      <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}">
      <div>
        <strong>${item.quantity}x ${escapeHtml(item.name)}</strong>
        ${variants ? `<div class="muted">${variants}</div>` : ''}
        ${optionText ? `<div class="muted">${optionText}</div>` : ''}
        ${extras ? `<div class="muted">${extras}</div>` : ''}
        ${item.notes ? `<div class="muted">${escapeHtml(item.notes)}</div>` : ''}
      </div>
      <div class="cart-line-actions">
        <strong>${money(lineTotalCents(item))}</strong><br>
        <div class="qty-control">
          <button type="button" data-qty-cart="${item.cartId}" data-qty-delta="-1">-</button>
          <span>${item.quantity}</span>
          <button type="button" data-qty-cart="${item.cartId}" data-qty-delta="1">+</button>
        </div>
        <button class="btn btn--ghost btn--small" type="button" data-remove-cart="${item.cartId}">Quitar</button>
      </div>
    </div>
  `;
}

function cartLineReadonly(item) {
  const variants = Object.entries(item.variants || {}).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join(', ');
  const extras = (item.extrasData || []).map((extra) => `${escapeHtml(extra.name)} +${money(extra.priceCents)}`).join(', ');
  const optionText = (item.optionSelections || [])
    .flatMap((selection) => (selection.options || []).map((option) => `${escapeHtml(selection.groupName)}: ${escapeHtml(option.name)}${option.priceCents ? ` +${money(option.priceCents)}` : ''}`))
    .join(', ');
  return `
    <div class="cart-line cart-line--readonly">
      <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}">
      <div>
        <strong>${item.quantity}x ${escapeHtml(item.name)}</strong>
        ${variants ? `<div class="muted">${variants}</div>` : ''}
        ${optionText ? `<div class="muted">${optionText}</div>` : ''}
        ${extras ? `<div class="muted">${extras}</div>` : ''}
        ${item.notes ? `<div class="muted">${escapeHtml(item.notes)}</div>` : ''}
      </div>
      <strong>${money(lineTotalCents(item))}</strong>
    </div>
  `;
}

function openCartDialog(source = {}) {
  const dialog = $('#cartDialog');
  const cart = getCart();
  const openForOrders = !source.openState || ordersAreOpen(source);
  dialog.innerHTML = `
    <div class="dialog__body">
      <div class="dialog__head">
        <div>
          <h2>Carrito</h2>
          <p class="muted">${cart.length} linea${cart.length === 1 ? '' : 's'} en tu pedido</p>
        </div>
        <button class="btn btn--ghost btn--small" type="button" data-close-dialog>Cerrar</button>
      </div>
      ${openForOrders ? '' : closedOrderNotice(source)}
      <div class="cart-lines" id="cartDialogLines">
        ${cart.length ? cart.map(cartLine).join('') : '<div class="empty-state">Tu carrito esta vacio.</div>'}
      </div>
      <div class="price-row"><strong>Total</strong><strong>${money(cartTotalCents(cart))}</strong></div>
      <div class="nav-actions" style="justify-content:flex-start">
        ${openForOrders
          ? '<a class="btn btn--brand" href="/checkout">Confirmar pedido</a>'
          : '<button class="btn btn--brand" type="button" disabled>Pedidos cerrados</button>'}
        <button class="btn btn--ghost" type="button" data-close-dialog>Seguir viendo menu</button>
      </div>
    </div>
  `;
  dialog.onclick = (event) => {
    const qty = event.target.closest('[data-qty-cart]');
    if (qty) {
      const item = getCart().find((cartItem) => cartItem.cartId === qty.dataset.qtyCart);
      if (!item) return;
      updateCartItemQuantity(item.cartId, Number(item.quantity || 1) + Number(qty.dataset.qtyDelta || 0));
      dialog.close();
      openCartDialog();
      return;
    }
    const remove = event.target.closest('[data-remove-cart]');
    if (remove) {
      saveCart(getCart().filter((item) => item.cartId !== remove.dataset.removeCart));
      dialog.close();
      openCartDialog();
    }
    if (event.target.closest('[data-close-dialog]')) dialog.close();
  };
  dialog.showModal();
}

async function initCheckout() {
  const options = await api('/api/public/checkout-options');
  updateBusinessHeader(options);
  const cart = getCart();
  const form = $('#checkoutForm');
  const deliverySelect = $('#deliveryMethod');
  const paymentSelect = $('#paymentMethod');
  const zoneSelect = $('#deliveryZone');
  const couponInput = $('#couponCode');
  const applyCouponBtn = $('#applyCouponBtn');
  const submitButton = form.querySelector('button[type="submit"]');
  if (!ordersAreOpen(options)) {
    form.insertAdjacentHTML('beforebegin', closedOrderNotice(options));
    submitButton.disabled = true;
    submitButton.textContent = 'Pedidos cerrados';
  }

  deliverySelect.innerHTML = options.deliveryMethods.map((method) => `<option value="${method.id}" data-slug="${method.slug}">${escapeHtml(method.name)}</option>`).join('');
  paymentSelect.innerHTML = options.paymentMethods.map((method) => `<option value="${method.id}">${escapeHtml(method.name)}</option>`).join('');
  zoneSelect.innerHTML = options.deliveryZones.map((zone) => `<option value="${zone.id}" data-fee="${zone.feeCents}">${escapeHtml(zone.name)} - ${money(zone.feeCents)}</option>`).join('');

  function renderSummary() {
    const currentCart = getCart();
    const deliveryMethod = options.deliveryMethods.find((method) => method.id === Number(deliverySelect.value));
    const isDelivery = deliveryMethod?.slug === 'delivery';
    const zone = options.deliveryZones.find((item) => item.id === Number(zoneSelect.value));
    const coupon = (options.promotions || []).find((promo) => promo.code && promo.code.toLowerCase() === String(couponInput?.value || '').trim().toLowerCase() && promo.active);
    const fee = isDelivery && zone ? zone.feeCents : 0;
    const subtotal = cartTotalCents(currentCart);
    let discount = 0;
    if (coupon && subtotal >= coupon.minOrderCents) {
      discount = coupon.discountType === 'fixed'
        ? coupon.discountValue
        : Math.round(subtotal * (Number(coupon.discountValue || 0) / 100));
      if (coupon.maxDiscountCents > 0) discount = Math.min(discount, coupon.maxDiscountCents);
      discount = Math.min(discount, subtotal);
    }
    $('#addressWrap').hidden = !isDelivery;
    $('#referenceWrap').hidden = !isDelivery;
    $('#zoneWrap').hidden = !isDelivery;
    $('#checkoutCart').innerHTML = currentCart.length ? currentCart.map(cartLine).join('') : '<div class="empty-state">Tu carrito esta vacio.</div>';
    $('#checkoutSubtotal').textContent = money(subtotal);
    $('#checkoutDelivery').textContent = money(fee);
    $('#checkoutDiscount').textContent = `-${money(discount)}`;
    $('#checkoutDiscountRow').hidden = discount === 0;
    $('#checkoutTotal').textContent = money(subtotal + fee - discount);
  }

  deliverySelect.addEventListener('change', renderSummary);
  zoneSelect.addEventListener('change', renderSummary);
  couponInput?.addEventListener('input', renderSummary);
  applyCouponBtn?.addEventListener('click', renderSummary);
  $('#checkoutCart').addEventListener('click', (event) => {
    const qty = event.target.closest('[data-qty-cart]');
    if (qty) {
      const item = getCart().find((cartItem) => cartItem.cartId === qty.dataset.qtyCart);
      if (!item) return;
      updateCartItemQuantity(item.cartId, Number(item.quantity || 1) + Number(qty.dataset.qtyDelta || 0));
      renderSummary();
      return;
    }
    const remove = event.target.closest('[data-remove-cart]');
    if (!remove) return;
    saveCart(getCart().filter((item) => item.cartId !== remove.dataset.removeCart));
    renderSummary();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ordersAreOpen(options)) {
      notifyOrdersClosed(options);
      return;
    }
    const currentCart = getCart();
    if (!currentCart.length) {
      alert('Agrega productos antes de enviar el pedido.');
      return;
    }
    const data = new FormData(form);
    const payload = {
      customer: {
        name: data.get('name'),
        phone: data.get('phone'),
        address: data.get('address'),
        reference: data.get('reference')
      },
      deliveryMethodId: Number(data.get('deliveryMethodId')),
      paymentMethodId: Number(data.get('paymentMethodId')),
      deliveryZoneId: data.get('deliveryZoneId') ? Number(data.get('deliveryZoneId')) : null,
      tableLabel: getTableLabel(),
      couponCode: data.get('couponCode'),
      paymentReference: data.get('paymentReference'),
      notes: data.get('notes'),
      items: currentCart.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        variants: item.variants,
        extras: item.extras,
        optionSelections: item.optionSelections,
        notes: item.notes
      }))
    };
    try {
      const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
      localStorage.setItem(LAST_ORDER_KEY, result.order.orderNumber);
      rememberCustomerOrder(result.order.orderNumber);
      if (result.whatsappUrl) {
        localStorage.setItem(whatsappStorageKey(result.order.orderNumber), result.whatsappUrl);
      }
      localStorage.removeItem(CART_KEY);
      updateCartBar();
      location.href = `/status?order=${encodeURIComponent(result.order.orderNumber)}`;
    } catch (error) {
      alert(error.message);
    }
  });
  renderSummary();
}

function kioskDeliveryMethods(options) {
  const localMethods = (options.deliveryMethods || []).filter((method) => method.slug !== 'delivery');
  return localMethods.length ? localMethods : (options.deliveryMethods || []);
}

function kioskPaymentMethods(options) {
  const filtered = (options.paymentMethods || []).filter((method) => {
    const slug = normalizedName(method.slug);
    const name = normalizedName(method.name);
    return slug !== 'pago-contra-entrega' && !name.includes('contra entrega');
  });
  return filtered.length ? filtered : (options.paymentMethods || []);
}

function kioskMethodButton(method, activeId, dataName, helperText = '') {
  return `
    <button class="kiosk-segment ${Number(activeId) === Number(method.id) ? 'is-active' : ''}" type="button" data-${dataName}="${method.id}">
      <strong>${escapeHtml(method.name)}</strong>
      ${helperText ? `<span>${escapeHtml(helperText)}</span>` : ''}
    </button>
  `;
}

function kioskPaymentHelper(method) {
  const slug = normalizedName(method.slug);
  if (slug === 'efectivo') return 'Pago en caja';
  if (slug === 'tarjeta') return 'Caja / POS';
  if (slug === 'transferencia') return 'Mostrar comprobante';
  return String(method.instructions || 'Pago en caja').replace(/o contra entrega\.?/i, '').trim();
}

function kioskMethodForServiceMode(state, mode) {
  const methods = state.deliveryMethods || [];
  const matcher = mode === 'local'
    ? (method) => {
      const slug = normalizedName(method.slug);
      const name = normalizedName(method.name);
      return ['local', 'comer-en-local', 'comer-aqui'].includes(slug) || name.includes('local') || name.includes('comer');
    }
    : (method) => {
      const slug = normalizedName(method.slug);
      const name = normalizedName(method.name);
      return ['retiro', 'takeaway', 'para-llevar', 'retiro-en-tienda'].includes(slug) || name.includes('retiro') || name.includes('llevar');
    };
  return methods.find(matcher) || methods[0];
}

function kioskServiceLabel(state) {
  const method = (state.deliveryMethods || []).find((item) => Number(item.id) === Number(state.deliveryMethodId));
  const mode = state.serviceMode || (normalizedName(method?.slug) === 'local' ? 'local' : 'takeaway');
  return {
    title: mode === 'local' ? 'Comer aqui' : 'Para llevar',
    detail: method?.name || (mode === 'local' ? 'Comer en local' : 'Retiro en tienda')
  };
}

function renderKioskStartState(state) {
  const start = $('#kioskStart');
  if (!start) return;
  const openForOrders = ordersAreOpen(state.menu);
  $$('[data-kiosk-service-mode]', start).forEach((button) => {
    button.disabled = !openForOrders;
    button.classList.toggle('is-disabled', !openForOrders);
  });
  let note = $('#kioskClosedNotice');
  if (!openForOrders) {
    if (!note) {
      note = document.createElement('div');
      note.id = 'kioskClosedNotice';
      note.className = 'order-closed-note kiosk-closed-note';
      $('.kiosk-start__options', start)?.after(note);
    }
    note.innerHTML = `<span>Pedidos cerrados</span><strong>${escapeHtml(closedOrderMessage(state.menu))}</strong>`;
  } else if (note) {
    note.remove();
  }
}

function showKioskStart(state, reset = false) {
  const start = $('#kioskStart');
  const main = $('#kioskMain');
  if (!start || !main) return;
  if (reset) {
    state.serviceMode = '';
    state.deliveryMethodId = null;
    state.customerName = '';
    state.tableLabel = getTableLabel() || 'Kiosko';
  }
  renderKioskStartState(state);
  start.hidden = false;
  main.hidden = true;
  const actionBar = $('#kioskActionBar');
  if (actionBar) actionBar.hidden = true;
  window.scrollTo(0, 0);
}

function enterKioskMenu(state, mode) {
  if (!ordersAreOpen(state.menu)) {
    notifyOrdersClosed(state.menu);
    showKioskStart(state);
    return;
  }
  const method = kioskMethodForServiceMode(state, mode);
  state.serviceMode = mode;
  state.deliveryMethodId = method?.id || state.deliveryMethodId;
  const start = $('#kioskStart');
  const main = $('#kioskMain');
  if (start) start.hidden = true;
  if (main) main.hidden = false;
  renderKioskOrder(state);
  window.scrollTo(0, 0);
}

function kioskIdleMilliseconds() {
  const rawSeconds = Number(new URLSearchParams(location.search).get('idle'));
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : DEFAULT_KIOSK_IDLE_SECONDS;
  return Math.max(10, Math.min(600, seconds)) * 1000;
}

function kioskCartTimeoutMilliseconds() {
  const rawSeconds = Number(new URLSearchParams(location.search).get('cartTimeout'));
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : DEFAULT_KIOSK_CART_TIMEOUT_SECONDS;
  return Math.max(30, Math.min(1800, seconds)) * 1000;
}

function setKioskScreensaverVisible(visible) {
  const screensaver = $('#kioskScreensaver');
  if (screensaver) screensaver.hidden = !visible;
}

function isKioskBusy() {
  return getCart().length > 0 || Boolean(document.querySelector('dialog[open]'));
}

function setupKioskScreensaver() {
  const screensaver = $('#kioskScreensaver');
  if (!screensaver) return;
  const idleMs = kioskIdleMilliseconds();
  let idleTimer = null;

  const hideScreensaver = () => {
    setKioskScreensaverVisible(false);
    resetIdleTimer();
  };
  const showScreensaver = () => {
    if (isKioskBusy()) {
      resetIdleTimer();
      return;
    }
    setKioskScreensaverVisible(true);
  };
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(showScreensaver, idleMs);
  }

  ['pointerdown', 'touchstart'].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      if (screensaver.hidden) resetIdleTimer();
    }, { passive: true });
  });
  document.addEventListener('keydown', () => {
    if (screensaver.hidden) resetIdleTimer();
    else hideScreensaver();
  });
  ['scroll', 'input', 'change'].forEach((eventName) => {
    document.addEventListener(eventName, resetIdleTimer, { passive: true });
  });
  screensaver.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideScreensaver();
  });
  resetIdleTimer();
}

function closeKioskDialogs() {
  $$('dialog[open]').forEach((dialog) => {
    try {
      dialog.close();
    } catch {
      /* dialog already closing */
    }
  });
}

function resetKioskOrderSession(state, { showScreensaver = false, message = '' } = {}) {
  localStorage.removeItem(cartStorageKey());
  state.serviceMode = '';
  state.deliveryMethodId = null;
  state.customerName = '';
  state.tableLabel = getTableLabel() || 'Kiosko';
  closeKioskDialogs();
  renderKioskOrder(state);
  showKioskStart(state, true);
  if (message) showToast(message);
  if (showScreensaver) setKioskScreensaverVisible(true);
}

function setupKioskCartAbandonment(state) {
  const timeoutMs = kioskCartTimeoutMilliseconds();
  let cartTimer = null;
  const resetTimer = () => {
    if (cartTimer) clearTimeout(cartTimer);
    cartTimer = setTimeout(() => {
      if (!getCart().length) {
        resetTimer();
        return;
      }
      resetKioskOrderSession(state, {
        showScreensaver: true,
        message: 'Pedido cancelado por inactividad.'
      });
      resetTimer();
    }, timeoutMs);
  };

  ['pointerdown', 'touchstart', 'keydown', 'input', 'change', 'scroll'].forEach((eventName) => {
    document.addEventListener(eventName, resetTimer, { passive: true });
  });
  resetTimer();
}

function kioskCategoryChips(state) {
  return [
    `<button class="chip ${state.category === 'all' ? 'is-active' : ''}" type="button" data-category="all">Todo</button>`,
    ...state.menu.categories.map((category) => `
      <button class="chip ${state.category === category.slug ? 'is-active' : ''}" type="button" data-category="${category.slug}">
        ${escapeHtml(category.name)}
      </button>
    `)
  ].join('');
}

function kioskProductCard(product) {
  const disabled = product.soldOut ? 'disabled' : '';
  return `
    <article class="kiosk-product-card ${product.soldOut ? 'is-sold-out' : ''}">
      <button type="button" data-add-product="${product.id}" ${disabled}>
        <span class="kiosk-product-card__image">
          <img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">
          ${product.featured ? '<em>Popular</em>' : ''}
        </span>
        <span class="kiosk-product-card__body">
          <strong>${escapeHtml(product.name)}</strong>
          <small>${escapeHtml(product.description || product.categoryName || 'Long Cha')}</small>
          <span>${product.soldOut ? 'Agotado' : money(product.basePriceCents)}</span>
        </span>
      </button>
    </article>
  `;
}

function renderKioskProducts(state) {
  const products = state.menu.products.filter((product) => productMatches(product, state));
  $('#kioskProductCount').textContent = `${products.length} productos`;
  $('#kioskProducts').innerHTML = products.length
    ? products.map(kioskProductCard).join('')
    : '<div class="empty-state">No encontramos productos con ese filtro.</div>';
}

function renderKioskCategories(state) {
  $('#kioskCategoryChips').innerHTML = kioskCategoryChips(state);
}

function renderKioskOrder(state) {
  const cart = getCart();
  const openForOrders = ordersAreOpen(state.menu);
  const count = cart.reduce((sum, item) => sum + Number(item.quantity || 1), 0);
  const actionBar = $('#kioskActionBar');
  const reviewButton = $('#kioskReviewOrder');
  if (!actionBar) return;
  actionBar.hidden = !state.serviceMode || cart.length === 0;
  $('#kioskBarCount').textContent = `${count} producto${count === 1 ? '' : 's'}`;
  $('#kioskBarTotal').textContent = money(cartTotalCents(cart));
  if (reviewButton) {
    reviewButton.disabled = cart.length === 0 || !openForOrders;
    reviewButton.textContent = openForOrders ? 'Revisar pedido' : 'Pedidos cerrados';
  }
}

function kioskPaymentLabel(state) {
  return (state.paymentMethods || []).find((method) => Number(method.id) === Number(state.paymentMethodId))?.name || 'Pago en caja';
}

function kioskDetailsValid(state) {
  return Boolean(String(state.customerName || '').trim() && String(state.tableLabel || '').trim());
}

function kioskKeyboardHtml() {
  const rows = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
    ['Espacio', 'Borrar', 'Limpiar']
  ];
  return `
    <div class="kiosk-keyboard" aria-label="Teclado del kiosko">
      ${rows.map((row) => `
        <div class="kiosk-keyboard__row">
          ${row.map((key) => `
            <button class="kiosk-key" type="button" data-kiosk-key="${escapeHtml(key)}">${escapeHtml(key)}</button>
          `).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function focusKioskKeyboardInput(input) {
  if (!input) return;
  const dialog = $('#kioskDetailsDialog');
  $$('[data-kiosk-keyboard-field]', dialog).forEach((field) => field.classList.toggle('is-active', field === input));
  dialog.dataset.keyboardTarget = input.id;
  input.focus({ preventScroll: true });
}

function updateKioskDetailsCart(state, dialog = $('#kioskDetailsDialog')) {
  const cart = getCart();
  const lines = $('#kioskDetailsLines', dialog);
  const total = $('#kioskDetailsTotal', dialog);
  const next = $('[data-kiosk-details-next]', dialog);
  if (lines) lines.innerHTML = cart.length ? cart.map(cartLine).join('') : '<div class="empty-state">Agrega productos para continuar.</div>';
  if (total) total.textContent = money(cartTotalCents(cart));
  if (next) next.disabled = cart.length === 0;
  renderKioskOrder(state);
}

function openKioskDetails(state) {
  if (!ordersAreOpen(state.menu)) {
    notifyOrdersClosed(state.menu);
    showKioskStart(state);
    return;
  }
  const cart = getCart();
  if (!cart.length) {
    showToast('Agrega productos antes de enviar.');
    return;
  }
  if (!state.deliveryMethodId || !state.serviceMode) {
    showToast('Selecciona si es para llevar o comer aqui.');
    showKioskStart(state);
    return;
  }

  const dialog = $('#kioskDetailsDialog');
  const service = kioskServiceLabel(state);
  dialog.innerHTML = `
    <form class="dialog__body kiosk-details" id="kioskDetailsForm">
      <div class="dialog__head">
        <div>
          <span class="eyebrow">Datos del pedido</span>
          <h2>Como llamamos tu orden?</h2>
          <p class="muted">Toca un campo y usa el teclado en pantalla.</p>
        </div>
        <button class="btn btn--ghost btn--small" type="button" data-kiosk-details-close>Cerrar</button>
      </div>

      <div class="kiosk-details__grid">
        <label>Nombre para llamar
          <input class="field" id="kioskCustomerName" name="name" value="${escapeHtml(state.customerName || '')}" placeholder="Ej. Carlos" required autocomplete="off" inputmode="none" readonly data-kiosk-keyboard-field>
        </label>
        <label>Mesa o referencia
          <input class="field" id="kioskTableLabel" name="tableLabel" value="${escapeHtml(state.tableLabel || getTableLabel() || 'Kiosko')}" placeholder="Kiosko / Mesa 1" required autocomplete="off" inputmode="none" readonly data-kiosk-keyboard-field>
        </label>
      </div>

      <div class="kiosk-details__summary">
        <div>
          <span>Tipo de pedido</span>
          <strong>${escapeHtml(service.title)}</strong>
          <small>${escapeHtml(service.detail)}</small>
        </div>
        <button class="btn btn--ghost btn--small" type="button" data-kiosk-change-service>Cambiar</button>
      </div>

      <div class="kiosk-option-block">
        <strong>Pago</strong>
        <div class="kiosk-segmented" id="kioskPaymentOptions">
          ${state.paymentMethods.map((method) => kioskMethodButton(method, state.paymentMethodId, 'kiosk-payment', kioskPaymentHelper(method))).join('')}
        </div>
      </div>

      <div class="kiosk-details__cart-head">
        <strong>Productos agregados</strong>
        <strong id="kioskDetailsTotal">${money(cartTotalCents(cart))}</strong>
      </div>
      <div class="kiosk-details__lines" id="kioskDetailsLines">
        ${cart.map(cartLine).join('')}
      </div>

      ${kioskKeyboardHtml()}

      <div class="kiosk-details__actions">
        <button class="btn btn--ghost" type="button" data-kiosk-details-close>Seguir comprando</button>
        <button class="btn btn--brand" type="submit" data-kiosk-details-next>Ver resumen</button>
      </div>
    </form>
  `;

  const firstInput = $('#kioskCustomerName', dialog);
  const tableInput = $('#kioskTableLabel', dialog);
  [firstInput, tableInput].forEach((input) => {
    input.addEventListener('focus', () => focusKioskKeyboardInput(input));
    input.addEventListener('click', () => focusKioskKeyboardInput(input));
    input.addEventListener('input', () => {
      state.customerName = firstInput.value.trim();
      state.tableLabel = tableInput.value.trim();
    });
  });
  const initialKeyboardInput = firstInput.value.trim() ? tableInput : firstInput;

  dialog.onclick = (event) => {
    if (event.target.closest('[data-kiosk-details-close]')) {
      state.customerName = firstInput.value.trim();
      state.tableLabel = tableInput.value.trim();
      dialog.close();
      return;
    }
    if (event.target.closest('[data-kiosk-change-service]')) {
      state.customerName = firstInput.value.trim();
      state.tableLabel = tableInput.value.trim();
      dialog.close();
      showKioskStart(state);
      return;
    }
    const payment = event.target.closest('[data-kiosk-payment]');
    if (payment) {
      state.paymentMethodId = Number(payment.dataset.kioskPayment);
      $$('[data-kiosk-payment]', dialog).forEach((button) => {
        button.classList.toggle('is-active', Number(button.dataset.kioskPayment) === Number(state.paymentMethodId));
      });
      return;
    }
    const key = event.target.closest('[data-kiosk-key]');
    if (key) {
      const target = document.getElementById(dialog.dataset.keyboardTarget) || firstInput;
      const value = key.dataset.kioskKey;
      if (value === 'Borrar') target.value = target.value.slice(0, -1);
      else if (value === 'Limpiar') target.value = '';
      else if (value === 'Espacio') target.value = `${target.value} `;
      else target.value = `${target.value}${value}`;
      target.value = target.value.replace(/\s{2,}/g, ' ').slice(0, 80);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      focusKioskKeyboardInput(target);
      return;
    }
    const qty = event.target.closest('[data-qty-cart]');
    if (qty) {
      const item = getCart().find((cartItem) => cartItem.cartId === qty.dataset.qtyCart);
      if (!item) return;
      updateCartItemQuantity(item.cartId, Number(item.quantity || 1) + Number(qty.dataset.qtyDelta || 0));
      updateKioskDetailsCart(state, dialog);
      return;
    }
    const remove = event.target.closest('[data-remove-cart]');
    if (remove) {
      saveCart(getCart().filter((item) => item.cartId !== remove.dataset.removeCart));
      updateKioskDetailsCart(state, dialog);
    }
  };

  $('#kioskDetailsForm', dialog).addEventListener('submit', (event) => {
    event.preventDefault();
    state.customerName = firstInput.value.trim();
    state.tableLabel = tableInput.value.trim();
    if (!kioskDetailsValid(state)) {
      showToast('Completa nombre y referencia.');
      focusKioskKeyboardInput(state.customerName ? tableInput : firstInput);
      return;
    }
    dialog.close();
    openKioskConfirm(state);
  });

  dialog.showModal();
  focusKioskKeyboardInput(initialKeyboardInput);
}

function openKioskConfirm(state) {
  if (!ordersAreOpen(state.menu)) {
    notifyOrdersClosed(state.menu);
    showKioskStart(state);
    return;
  }
  const cart = getCart();
  if (!cart.length) {
    showToast('Agrega productos antes de enviar.');
    return;
  }
  if (!state.deliveryMethodId || !state.serviceMode) {
    showToast('Selecciona si es para llevar o comer aqui.');
    showKioskStart(state);
    return;
  }
  if (!kioskDetailsValid(state)) {
    openKioskDetails(state);
    return;
  }

  const dialog = $('#kioskConfirmDialog');
  const service = kioskServiceLabel(state);
  const customerName = String(state.customerName || '').trim();
  const tableLabel = String(state.tableLabel || '').trim();
  dialog.innerHTML = `
    <div class="dialog__body kiosk-confirm">
      <div class="dialog__head">
        <div>
          <span class="eyebrow">Revisar pedido</span>
          <h2>Confirma tu orden</h2>
          <p class="muted">Verifica los productos antes de enviarlos a cocina.</p>
        </div>
        <button class="btn btn--ghost btn--small" type="button" data-kiosk-confirm-close>Editar</button>
      </div>
      <div class="kiosk-confirm__meta">
        <div><span>Cliente</span><strong>${escapeHtml(customerName)}</strong></div>
        <div><span>Tipo</span><strong>${escapeHtml(service.title)}</strong></div>
        <div><span>Referencia</span><strong>${escapeHtml(tableLabel || service.detail)}</strong></div>
        <div><span>Pago</span><strong>${escapeHtml(kioskPaymentLabel(state))}</strong></div>
      </div>
      <div class="kiosk-confirm__lines">
        ${cart.map(cartLineReadonly).join('')}
      </div>
      <div class="kiosk-confirm__total">
        <span>Total a pagar</span>
        <strong>${money(cartTotalCents(cart))}</strong>
      </div>
      <div class="kiosk-confirm__actions">
        <button class="btn btn--ghost" type="button" data-kiosk-confirm-close>Volver a editar</button>
        <button class="btn btn--brand" type="button" data-kiosk-confirm-send>Confirmar pedido</button>
      </div>
    </div>
  `;
  dialog.onclick = async (event) => {
    if (event.target.closest('[data-kiosk-confirm-close]')) {
      dialog.close();
      return;
    }
    const sendButton = event.target.closest('[data-kiosk-confirm-send]');
    if (!sendButton) return;
    sendButton.disabled = true;
    sendButton.textContent = 'Enviando...';
    dialog.close();
    await submitKioskOrder(state);
  };
  dialog.showModal();
}

function updateKioskClock() {
  const clock = $('#kioskClock');
  if (!clock) return;
  clock.textContent = new Intl.DateTimeFormat('es-SV', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date());
}

function printerTicketWidth(value, fallback = 80) {
  const width = Number(value);
  return [58, 80].includes(width) ? width : fallback;
}

function printerConnectionMode(value, fallback = 'browser') {
  return ['browser', 'system', 'network'].includes(value) ? value : fallback;
}

function printerPort(value, fallback = 9100) {
  const port = Math.round(Number(value));
  return port >= 1 && port <= 65535 ? port : fallback;
}

function printerRange(value, min, max, fallback, round = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  return round ? Math.round(clamped) : clamped;
}

function normalizeFrontendThermalPrinter(input, defaults, legacy = {}) {
  const config = input && typeof input === 'object' ? input : {};
  return {
    ...defaults,
    ...config,
    enabled: Boolean(config.enabled ?? legacy.enabled ?? defaults.enabled),
    type: 'thermal',
    ticketWidthMm: printerTicketWidth(config.ticketWidthMm ?? legacy.ticketWidthMm, defaults.ticketWidthMm),
    fontSizePt: printerRange(config.fontSizePt ?? legacy.fontSizePt, 9, 18, defaults.fontSizePt),
    connectionMode: printerConnectionMode(config.connectionMode ?? legacy.connectionMode, defaults.connectionMode),
    systemPrinterName: String(config.systemPrinterName ?? legacy.systemPrinterName ?? defaults.systemPrinterName ?? ''),
    networkHost: String(config.networkHost ?? legacy.networkHost ?? defaults.networkHost ?? ''),
    networkPort: printerPort(config.networkPort ?? legacy.networkPort, defaults.networkPort)
  };
}

function normalizeFrontendLabelPrinter(input, defaults, legacy = {}) {
  const config = input && typeof input === 'object' ? input : {};
  return {
    ...defaults,
    ...config,
    enabled: Boolean(config.enabled ?? legacy.enabled ?? defaults.enabled),
    type: 'zebra-label',
    labelWidthIn: printerRange(config.labelWidthIn ?? legacy.labelWidthIn, 1, 4, defaults.labelWidthIn),
    labelHeightIn: printerRange(config.labelHeightIn ?? legacy.labelHeightIn, 0.5, 3, defaults.labelHeightIn),
    copiesPerDrink: printerRange(config.copiesPerDrink ?? legacy.copiesPerDrink, 1, 5, defaults.copiesPerDrink, true),
    connectionMode: printerConnectionMode(config.connectionMode ?? legacy.connectionMode, defaults.connectionMode),
    systemPrinterName: String(config.systemPrinterName ?? legacy.systemPrinterName ?? defaults.systemPrinterName ?? ''),
    networkHost: String(config.networkHost ?? legacy.networkHost ?? defaults.networkHost ?? ''),
    networkPort: printerPort(config.networkPort ?? legacy.networkPort, defaults.networkPort),
    includePrice: Boolean(config.includePrice ?? legacy.includePrice ?? defaults.includePrice),
    autoPrintFromKiosk: Boolean(config.autoPrintFromKiosk ?? legacy.autoPrintFromKiosk ?? defaults.autoPrintFromKiosk)
  };
}

function normalizeFrontendPrinterConfig(input = {}) {
  const config = input && typeof input === 'object' ? input : {};
  const printers = config.printers && typeof config.printers === 'object' ? config.printers : {};
  return {
    printers: {
      caja: normalizeFrontendThermalPrinter(printers.caja, DEFAULT_PRINTER_CONFIG.printers.caja, {
        enabled: config.ticketPrinterEnabled,
        ticketWidthMm: config.ticketWidthMm
      }),
      cocina: normalizeFrontendThermalPrinter(printers.cocina, DEFAULT_PRINTER_CONFIG.printers.cocina, {
        enabled: config.ticketPrinterEnabled,
        ticketWidthMm: config.ticketWidthMm
      }),
      kiosk: normalizeFrontendThermalPrinter(printers.kiosk, DEFAULT_PRINTER_CONFIG.printers.kiosk, {
        enabled: config.ticketPrinterEnabled,
        ticketWidthMm: config.ticketWidthMm
      }),
      etiquetas: normalizeFrontendLabelPrinter(printers.etiquetas, DEFAULT_PRINTER_CONFIG.printers.etiquetas, {
        enabled: config.labelPrinterEnabled,
        labelWidthIn: config.labelWidthIn,
        labelHeightIn: config.labelHeightIn,
        copiesPerDrink: config.labelCopiesPerDrink,
        includePrice: config.labelIncludePrice,
        autoPrintFromKiosk: config.labelAutoPrintFromKiosk
      })
    },
    labelDrinkCategorySlugs: Array.isArray(config.labelDrinkCategorySlugs)
      ? config.labelDrinkCategorySlugs
      : DEFAULT_PRINTER_CONFIG.labelDrinkCategorySlugs
  };
}

function kioskPrinterConfig(stateOrMenu) {
  const business = stateOrMenu?.menu?.business || stateOrMenu?.business || {};
  return normalizeFrontendPrinterConfig(business.printerConfig || {});
}

function cartItemCustomizationParts(item) {
  const variants = Object.entries(item.variants || {}).map(([key, value]) => `${key}: ${value}`);
  const options = (item.optionSelections || [])
    .flatMap((selection) => (selection.options || []).map((option) => `${selection.groupName}: ${option.name}`));
  const extras = (item.extrasData || []).map((extra) => `Extra: ${extra.name}`);
  return [...variants, ...options, ...extras].filter(Boolean);
}

function orderItemModifierParts(item, includePrices = true) {
  const variants = Object.entries(item.variants || {}).map(([key, value]) => `${key}: ${value}`);
  const extras = (item.extras || []).map((extra) => {
    const group = extra.groupName ? `${extra.groupName}: ` : '+ ';
    const price = includePrices && extra.priceCents ? ` ${money(extra.priceCents)}` : '';
    return `${group}${extra.name}${price}`;
  });
  return [...variants, ...extras].filter(Boolean);
}

function printModifierLines(parts) {
  return parts.map((part) => escapeHtml(part)).join('<br>');
}

function preparePrintTarget(layout, config = {}) {
  const target = $('#ticketPrint');
  if (!target) return null;
  target.dataset.printLayout = layout;
  target.style.setProperty('--ticket-width', `${Number(config.ticketWidthMm || 80)}mm`);
  target.style.setProperty('--ticket-font-size', `${Number(config.fontSizePt || 13)}pt`);
  target.style.setProperty('--label-width', `${Number(config.labelWidthIn || 2)}in`);
  target.style.setProperty('--label-height', `${Number(config.labelHeightIn || 1)}in`);
  target.innerHTML = '';
  return target;
}

function kioskDrinkLabelItems(cart, state) {
  const config = kioskPrinterConfig(state);
  const drinkSlugs = new Set((config.labelDrinkCategorySlugs || []).map(normalizedName));
  return cart
    .map((item) => {
      const product = state.menu.products.find((productItem) => Number(productItem.id) === Number(item.productId));
      return { item, product };
    })
    .filter(({ product }) => product && drinkSlugs.has(normalizedName(product.categorySlug)))
    .map(({ item, product }) => ({
      productId: item.productId,
      productName: item.name,
      categoryName: product.categoryName,
      categorySlug: product.categorySlug,
      quantity: Number(item.quantity || 1),
      lineTotalCents: lineTotalCents(item),
      modifiers: cartItemCustomizationParts(item)
    }));
}

function printKioskTicket(order, ticket = {}, type = 'payment') {
  const config = normalizeFrontendPrinterConfig(ticket.printerConfig || {});
  const printer = type === 'kitchen' ? config.printers.cocina : config.printers.caja;
  const target = preparePrintTarget('ticket', printer);
  if (!target) return;
  const businessName = $('[data-business-name]')?.textContent || 'Long Cha';
  const customerName = ticket.customerName || order.customer?.name || 'Cliente local';
  const tableLabel = ticket.tableLabel || order.tableLabel || '';
  const isKitchen = type === 'kitchen';
  target.innerHTML = `
    <div style="text-align:center">
      <strong>${escapeHtml(isKitchen ? 'PEDIDO KIOSKO' : businessName)}</strong><br>
      Pedido ${escapeHtml(order.orderNumber)}<br>
      ${new Date(order.createdAt || Date.now()).toLocaleString()}
    </div>
    <hr>
    Cliente: ${escapeHtml(customerName)}<br>
    ${tableLabel ? `Mesa/ref: ${escapeHtml(tableLabel)}<br>` : ''}
    Entrega: ${escapeHtml(order.deliveryMethod?.name || '')}<br>
    ${isKitchen ? '' : `Pago: ${escapeHtml(order.paymentMethod?.name || '')}<br>`}
    <hr>
    ${(order.items || []).map((item) => `
      <strong>${item.quantity} x ${escapeHtml(item.productName)}</strong>${isKitchen ? '' : ` ${escapeHtml(item.lineTotal || '')}`}<br>
      ${printModifierLines(orderItemModifierParts(item, !isKitchen))}
    `).join('<br>')}
    <hr>
    ${isKitchen ? '' : `<strong>Total: ${money(order.totalCents)}</strong><br>`}
    Estado: ${escapeHtml(order.status || 'Nuevo')}
  `;
  window.print();
}

function printKioskOrderNumber(order, ticket = {}) {
  const config = normalizeFrontendPrinterConfig(ticket.printerConfig || {});
  const target = preparePrintTarget('ticket', config.printers.kiosk);
  if (!target) return;
  const businessName = $('[data-business-name]')?.textContent || 'Long Cha';
  const customerName = ticket.customerName || order.customer?.name || 'Cliente local';
  const tableLabel = ticket.tableLabel || order.tableLabel || '';
  target.innerHTML = `
    <div style="text-align:center">
      <strong>${escapeHtml(businessName)}</strong><br>
      <span>NUMERO DE ORDEN</span>
    </div>
    <div style="text-align:center;font-size:28px;font-weight:900;line-height:1.1;margin:8px 0 10px">
      ${escapeHtml(order.orderNumber)}
    </div>
    <div style="text-align:center">
      ${escapeHtml(customerName)}<br>
      ${tableLabel ? `Mesa/ref: ${escapeHtml(tableLabel)}<br>` : ''}
      ${new Date(order.createdAt || Date.now()).toLocaleString()}
    </div>
    <hr>
    <div style="text-align:center">
      Conserva este numero para retirar tu pedido.
    </div>
  `;
  window.print();
}

function expandDrinkLabels(order, ticket = {}) {
  const config = normalizeFrontendPrinterConfig(ticket.printerConfig || {});
  const labelPrinter = config.printers.etiquetas;
  const copies = Math.max(1, Number(labelPrinter.copiesPerDrink || 1));
  const labels = [];
  for (const item of ticket.labelItems || []) {
    for (let quantityIndex = 0; quantityIndex < Number(item.quantity || 1); quantityIndex += 1) {
      for (let copyIndex = 0; copyIndex < copies; copyIndex += 1) {
        labels.push({
          ...item,
          orderNumber: order.orderNumber,
          unitIndex: quantityIndex + 1,
          copyIndex: copyIndex + 1
        });
      }
    }
  }
  return labels;
}

function printKioskDrinkLabels(order, ticket = {}) {
  const config = normalizeFrontendPrinterConfig(ticket.printerConfig || {});
  const labelPrinter = config.printers.etiquetas;
  const labels = expandDrinkLabels(order, ticket);
  if (!labels.length) {
    showToast('Este pedido no tiene bebidas para etiquetar.');
    return;
  }
  const target = preparePrintTarget('labels-2x1', labelPrinter);
  if (!target) return;
  const customerName = ticket.customerName || 'Cliente local';
  const tableLabel = ticket.tableLabel || '';
  target.innerHTML = `
    <div class="label-sheet">
      ${labels.map((label, index) => `
        <section class="drink-label">
          <header>
            <strong>${escapeHtml(order.orderNumber)}</strong>
            <span>${index + 1}/${labels.length}</span>
          </header>
          <h2>${escapeHtml(label.productName)}</h2>
          <div class="drink-label__meta">
            ${escapeHtml(customerName)}${tableLabel ? ` - ${escapeHtml(tableLabel)}` : ''}${label.quantity > 1 ? ` - ${label.unitIndex}/${label.quantity}` : ''}
          </div>
          <div class="drink-label__mods">
            ${label.modifiers.length ? label.modifiers.map((part) => `<span>${escapeHtml(part)}</span>`).join('') : '<span>Sin modificaciones</span>'}
          </div>
          <footer>
            <span>${escapeHtml(label.categoryName || 'Bebida')}</span>
            ${labelPrinter.includePrice ? `<strong>${money(label.lineTotalCents / Number(label.quantity || 1))}</strong>` : ''}
          </footer>
        </section>
      `).join('')}
    </div>
  `;
  window.print();
}

function openKioskSuccess(order, ticket = {}) {
  const dialog = $('#kioskSuccessDialog');
  const config = normalizeFrontendPrinterConfig(ticket.printerConfig || {});
  dialog.innerHTML = `
    <div class="dialog__body kiosk-success">
      <img src="/assets/brand/longcha-mark.png" alt="Long Cha">
      <span class="eyebrow">Pedido enviado</span>
      <h2>${escapeHtml(order.orderNumber)}</h2>
      <p>Tu orden ya fue enviada a cocina. Conserva este numero y puedes pasar a caja a cancelar tu pedido.</p>
      <div class="kiosk-success-actions">
        ${config.printers.kiosk.enabled ? '<button class="btn btn--brand" type="button" data-kiosk-print-order-number>Imprimir numero de orden</button>' : ''}
        <button class="btn btn--ghost" type="button" data-kiosk-new-order>Hacer otro pedido</button>
      </div>
    </div>
  `;
  dialog.onclick = (event) => {
    if (event.target.closest('[data-kiosk-print-order-number]')) {
      printKioskOrderNumber(order, ticket);
      return;
    }
    if (!event.target.closest('[data-kiosk-new-order]')) return;
    dialog.close();
    if (typeof ticket.onNewOrder === 'function') ticket.onNewOrder();
    showToast('Listo para un nuevo pedido');
  };
  dialog.showModal();
}

async function submitKioskOrder(state) {
  if (!ordersAreOpen(state.menu)) {
    notifyOrdersClosed(state.menu);
    showKioskStart(state);
    return false;
  }
  const cart = getCart();
  if (!cart.length) {
    showToast('Agrega productos antes de enviar.');
    return false;
  }
  if (!state.deliveryMethodId || !state.serviceMode) {
    showToast('Selecciona si es para llevar o comer aqui.');
    showKioskStart(state);
    return false;
  }
  if (!kioskDetailsValid(state)) {
    openKioskDetails(state);
    return false;
  }
  const submit = $('#kioskReviewOrder');
  const tableLabel = String(state.tableLabel || '').trim();
  const customerName = String(state.customerName || '').trim();
  const printerConfig = kioskPrinterConfig(state);
  const labelItems = kioskDrinkLabelItems(cart, state);
  if (tableLabel) localStorage.setItem(TABLE_KEY, tableLabel);
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Enviando pedido...';
  }
  const payload = {
    customer: {
      name: customerName,
      phone: `kiosko-${Date.now()}`,
      address: '',
      reference: tableLabel
    },
    deliveryMethodId: Number(state.deliveryMethodId),
    paymentMethodId: Number(state.paymentMethodId),
    deliveryZoneId: null,
    tableLabel,
    paymentStatus: 'Pendiente',
    notes: 'Pedido creado en kiosko de autoservicio.',
    items: cart.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      variants: item.variants,
      extras: item.extras,
      optionSelections: item.optionSelections,
      notes: item.notes
    }))
  };
  try {
    const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
    localStorage.setItem(LAST_ORDER_KEY, result.order.orderNumber);
    localStorage.removeItem(cartStorageKey());
    renderKioskOrder(state);
    openKioskSuccess(result.order, {
      customerName,
      tableLabel,
      printerConfig,
      labelItems,
      onNewOrder: () => showKioskStart(state, true)
    });
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  } finally {
    if (submit) {
      submit.textContent = ordersAreOpen(state.menu) ? 'Revisar pedido' : 'Pedidos cerrados';
      submit.disabled = getCart().length === 0 || !ordersAreOpen(state.menu);
    }
    renderKioskOrder(state);
  }
}

async function initKiosk() {
  captureTableFromUrl();
  const [menu, options] = await Promise.all([
    api('/api/public/menu'),
    api('/api/public/checkout-options')
  ]);
  const deliveryMethods = kioskDeliveryMethods(options);
  const paymentMethods = kioskPaymentMethods(options);
  const state = {
    menu,
    deliveryMethods,
    paymentMethods,
    category: 'all',
    search: '',
    customerName: '',
    tableLabel: getTableLabel() || 'Kiosko',
    serviceMode: '',
    deliveryMethodId: null,
    paymentMethodId: (paymentMethods.find((method) => method.slug === 'efectivo') || paymentMethods[0])?.id
  };

  updateBusinessHeader(menu);
  renderKioskCategories(state);
  renderKioskProducts(state);
  renderKioskOrder(state);
  showKioskStart(state);
  updateKioskClock();
  setInterval(updateKioskClock, 30000);
  setupKioskScreensaver();
  setupKioskCartAbandonment(state);

  $('#kioskStart').addEventListener('click', (event) => {
    const button = event.target.closest('[data-kiosk-service-mode]');
    if (!button) return;
    enterKioskMenu(state, button.dataset.kioskServiceMode);
  });
  $('#kioskSearch').addEventListener('input', (event) => {
    state.search = event.target.value.toLowerCase();
    renderKioskProducts(state);
  });
  $('#kioskCategoryChips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    state.category = button.dataset.category;
    renderKioskCategories(state);
    renderKioskProducts(state);
  });
  $('#kioskProducts').addEventListener('click', (event) => {
    const addButton = event.target.closest('[data-add-product]');
    if (!addButton) return;
    if (!ordersAreOpen(state.menu)) {
      notifyOrdersClosed(state.menu);
      showKioskStart(state);
      return;
    }
    const product = state.menu.products.find((item) => item.id === Number(addButton.dataset.addProduct));
    if (!product) return;
    openProductDialog(product, {
      afterAdd: () => {
        renderKioskOrder(state);
        showToast('Producto agregado al pedido');
      }
    });
  });
  $('#kioskClearCart').addEventListener('click', () => {
    localStorage.removeItem(cartStorageKey());
    renderKioskOrder(state);
    showToast('Pedido vaciado');
  });
  $('#kioskReviewOrder').addEventListener('click', () => openKioskDetails(state));
}

async function initStatus() {
  const params = new URLSearchParams(location.search);
  const input = $('#orderNumber');
  input.value = params.get('order') || localStorage.getItem(LAST_ORDER_KEY) || '';
  $('#statusForm').addEventListener('submit', (event) => {
    event.preventDefault();
    loadStatus(input.value, true);
  });
  if (input.value) loadStatus(input.value, true);
}

async function legacyLoadStatus(orderNumber) {
  try {
    const order = await api(`/api/public/order-status?order=${encodeURIComponent(orderNumber)}`);
    $('#statusResult').innerHTML = `
      <div class="panel" style="margin-top:0">
        <div class="price-row">
          <div>
            <strong>${escapeHtml(order.orderNumber)}</strong>
            <div class="muted">${escapeHtml(order.deliveryMethod.name)} · ${escapeHtml(order.paymentMethod.name)}</div>
          </div>
          <span class="status-badge status-${order.status.replaceAll(' ', '-')}">${escapeHtml(order.status)}</span>
        </div>
        <div class="cart-lines" style="margin-top:14px">
          ${order.items.map((item) => `
            <div class="price-row">
              <span>${item.quantity}x ${escapeHtml(item.productName)}</span>
              <strong>${money(Math.round(item.lineTotal * 100))}</strong>
            </div>
          `).join('')}
        </div>
        <div class="price-row" style="margin-top:14px"><strong>Total</strong><strong>${money(order.totalCents)}</strong></div>
      </div>
    `;
    $('#statusTimeline').innerHTML = order.history.map((entry) => `
      <div class="timeline__item">
        <strong>${escapeHtml(entry.status)}</strong>
        <span class="muted">${new Date(entry.createdAt).toLocaleString()}</span>
      </div>
    `).join('');
    if (!['Entregado', 'Cancelado'].includes(order.status)) {
      setTimeout(() => loadStatus(orderNumber), 7000);
    }
  } catch (error) {
    $('#statusResult').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    $('#statusTimeline').innerHTML = '';
  }
}

function isFinalStatus(status) {
  return ['Entregado', 'Cancelado'].includes(status);
}

function closeStatusEvents() {
  if (statusEvents) {
    statusEvents.close();
    statusEvents = null;
  }
  if (statusPollTimer) {
    clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }
}

function renderStatus(order) {
  const allTrackedOrders = trackedStatusOrders(order);
  const relatedOrders = visibleStatusOrders(order);
  const whatsappUrl = order.whatsappUrl || localStorage.getItem(whatsappStorageKey(order.orderNumber)) || '';
  $('#statusResult').innerHTML = `
    <div class="status-actions status-actions--top">
      ${whatsappUrl ? `<a class="btn btn--brand" href="${escapeHtml(whatsappUrl)}" target="_blank" rel="noreferrer">Confirmar por WhatsApp</a>` : ''}
      <a class="btn btn--soft" href="/menu">Hacer otro pedido</a>
    </div>
    ${relatedOrders.length > 1 ? `
      <div class="status-family-note">
        <strong>${relatedOrders.length} pedidos encontrados para este cliente</strong>
        <span>Se muestran solo los pedidos activos para que puedas seguirlos sin cambiar de pantalla.</span>
      </div>
    ` : ''}
    ${relatedOrders.length ? `
      <div class="status-orders-stack">
        ${relatedOrders.map((item, index) => statusOrderCard(item, index === 0)).join('')}
      </div>
    ` : `
      <div class="order-closed-note">
        <strong>No hay pedidos activos para mostrar</strong>
        <span>${allTrackedOrders.some((item) => item.status === 'Entregado')
          ? 'Los pedidos entregados se archivan automaticamente en esta ventana.'
          : 'Cuando hagas un pedido nuevo, aparecera aqui para darle seguimiento.'}</span>
      </div>
    `}
  `;
  $('#statusTimeline').innerHTML = order.history.map((entry) => `
    <div class="timeline__item">
      <strong>${escapeHtml(entry.status)}</strong>
      <span class="muted">${new Date(entry.createdAt).toLocaleString()}</span>
    </div>
  `).join('');
}

function statusOrderCard(order, isPrimary = false) {
  const progress = ['Nuevo', 'Aceptado', 'En preparacion', 'Listo', order.deliveryMethod?.slug === 'delivery' ? 'En camino' : '', 'Entregado']
    .filter(Boolean);
  const currentIndex = progress.indexOf(order.status);
  const isDelivered = order.status === 'Entregado';
  return `
    <div class="status-card ${isPrimary ? 'is-primary' : ''}">
      <div class="status-card__head">
        <div>
          <span class="eyebrow">Pedido ${escapeHtml(order.orderNumber)}</span>
          <h2>${escapeHtml(order.status)}</h2>
          <div class="muted">${escapeHtml(order.deliveryMethod.name)} - ${escapeHtml(order.paymentMethod.name)}</div>
          ${order.tableLabel ? `<div class="muted">Mesa: ${escapeHtml(order.tableLabel)}</div>` : ''}
          <div class="muted">Tiempo estimado: ${order.etaMinutes || 0} min · Pago: ${escapeHtml(order.paymentStatus || 'Pendiente')}</div>
          <div class="muted">${isFinalStatus(order.status) ? 'Pedido finalizado' : 'Actualizando en tiempo real'}</div>
        </div>
        <div class="eta-pill">
          <strong>${order.etaMinutes || 0}</strong>
          <span>min ETA</span>
        </div>
      </div>
      <div class="status-payment">Pago: <strong>${escapeHtml(order.paymentStatus || 'Pendiente')}</strong></div>
      <div class="status-progress">
        ${progress.map((step, index) => `
          <div class="status-step ${currentIndex >= index ? 'is-done' : ''}">
            <span>${index + 1}</span>
            <strong>${escapeHtml(step)}</strong>
          </div>
        `).join('')}
      </div>
      ${isDelivered ? `
        <div class="order-closed-note">
          <strong>Pedido entregado</strong>
          <span>El detalle de productos ya no se muestra en esta ventana.</span>
        </div>
      ` : `
        <div class="cart-lines" style="margin-top:14px">
          ${order.items.map((item) => `
            <div class="price-row">
              <span>${item.quantity}x ${escapeHtml(item.productName)}</span>
              <strong>${money(Math.round(item.lineTotal * 100))}</strong>
            </div>
          `).join('')}
        </div>
      `}
      ${order.discountCents ? `<div class="price-row"><span>Descuento ${escapeHtml(order.couponCode || '')}</span><span>-${money(order.discountCents)}</span></div>` : ''}
      <div class="price-row" style="margin-top:14px"><strong>Total</strong><strong>${money(order.totalCents)}</strong></div>
    </div>
  `;
}

function scheduleStatusFallback(orderNumber) {
  if (statusPollTimer) clearTimeout(statusPollTimer);
  statusPollTimer = setTimeout(() => loadStatus(orderNumber, false), 7000);
}

function trackedStatusOrders(order) {
  const seen = new Set();
  return [order, ...((order && order.relatedOrders) || [])].filter((item) => {
    if (!item?.orderNumber || seen.has(item.orderNumber)) return false;
    seen.add(item.orderNumber);
    return true;
  });
}

function visibleStatusOrders(order) {
  return trackedStatusOrders(order).filter((item) => item.status !== 'Entregado');
}

function hasOpenTrackedOrders(order) {
  return trackedStatusOrders(order).some((item) => !isFinalStatus(item.status));
}

function hasRelatedTrackedOrders(order) {
  return visibleStatusOrders(order).length > 1;
}

function connectOrderStatusEvents(orderNumber, orderSnapshot) {
  const currentStatus = orderSnapshot?.status || '';
  closeStatusEvents();
  if (!('EventSource' in window) || isFinalStatus(currentStatus)) {
    if (hasOpenTrackedOrders(orderSnapshot)) scheduleStatusFallback(orderNumber);
    return;
  }
  statusEvents = new EventSource(`/api/public/order-events?order=${encodeURIComponent(orderNumber)}`);
  const handleEvent = (event) => {
    const data = JSON.parse(event.data);
    if (!data.order) return;
    renderStatus(data.order);
    if (hasOpenTrackedOrders(data.order) && hasRelatedTrackedOrders(data.order)) {
      scheduleStatusFallback(orderNumber);
    }
    if (isFinalStatus(data.order.status) && !hasOpenTrackedOrders(data.order)) closeStatusEvents();
  };
  statusEvents.addEventListener('order.snapshot', handleEvent);
  statusEvents.addEventListener('order.created', handleEvent);
  statusEvents.addEventListener('order.updated', handleEvent);
  statusEvents.onerror = () => {
    closeStatusEvents();
    scheduleStatusFallback(orderNumber);
  };
}

async function loadStatus(orderNumber, connectRealtime = true) {
  try {
    const order = await api(`/api/public/order-status?order=${encodeURIComponent(orderNumber)}`);
    rememberCustomerOrder(order.orderNumber);
    renderStatus(order);
    if (connectRealtime) connectOrderStatusEvents(orderNumber, order);
    if (hasOpenTrackedOrders(order) && (!connectRealtime || hasRelatedTrackedOrders(order))) {
      scheduleStatusFallback(orderNumber);
    }
  } catch (error) {
    closeStatusEvents();
    $('#statusResult').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    $('#statusTimeline').innerHTML = '';
  }
}

if (page === 'home') initHome().catch(console.error);
if (page === 'menu') initMenu().catch((error) => alert(error.message));
if (page === 'kiosk') initKiosk().catch((error) => alert(error.message));
if (page === 'checkout') initCheckout().catch((error) => alert(error.message));
if (page === 'status') initStatus().catch(console.error);
