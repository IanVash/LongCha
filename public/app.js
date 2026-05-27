const CART_KEY = 'qr-food-pos-cart-v1';
const LAST_ORDER_KEY = 'qr-food-pos-last-order';
const LAST_WHATSAPP_KEY = 'qr-food-pos-last-whatsapp-url';
const CUSTOMER_ORDERS_KEY = 'qr-food-pos-customer-orders';
const TABLE_KEY = 'qr-food-pos-table';

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

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
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
  return String(value || '').trim().toLowerCase();
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
      const product = state.menu.products.find((item) => item.id === Number(addButton.dataset.addProduct));
      if (product) openProductDialog(product);
    }
    if (event.target.closest('[data-open-cart]')) openCartDialog();
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
  $('#featuredProducts').innerHTML = featured.map(productCard).join('');
  $('#productGrid').innerHTML = products.length
    ? products.map(productCard).join('')
    : '<div class="empty-state">No encontramos productos con ese filtro.</div>';
}

function productCard(product) {
  const disabled = product.soldOut ? 'disabled' : '';
  const optionCount = publicOptionalGroups(product).length + publicVariants(product).length + (publicExtras(product).length ? 1 : 0);
  return `
    <article class="product-card ${product.soldOut ? 'is-sold-out' : ''}">
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

function openProductDialog(product) {
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
        <label class="dialog-section customizer-notes">
          <strong>Notas especiales</strong>
          <textarea class="textarea" name="notes" placeholder="Menos azucar, sin hielo, separar topping..."></textarea>
        </label>
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
      notes: String(form.get('notes') || '').trim()
    });
    saveCart(cart);
    dialog.close();
    openCartDialog();
  });
  updateTotal();
  dialog.showModal();
}

function variantGroupControl(variant, index) {
  return `
    <fieldset class="customizer-group">
      <legend>${escapeHtml(variant.name)}${variant.required ? ' *' : ''}</legend>
      <div class="customizer-option-grid">
        ${variant.options.map((option, optionIndex) => `
          <label class="customizer-option-tile">
            <input type="radio" name="variant:${escapeHtml(variant.name)}" value="${escapeHtml(option)}" ${variant.required ? 'required' : ''} ${optionIndex === 0 ? 'checked' : ''}>
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
  return `
    <fieldset class="customizer-group">
      <legend>${escapeHtml(group.name)}${group.required ? ' *' : ''}</legend>
      <div class="customizer-option-grid">
      ${group.options.map((option, optionIndex) => `
        <label class="customizer-option-tile">
          <input type="${inputType}" name="optional:${group.id}" value="${option.id}" ${group.required && inputType === 'radio' ? 'required' : ''} ${group.required && inputType === 'radio' && optionIndex === 0 ? 'checked' : ''} ${inputType === 'checkbox' ? `data-max-select="${group.maxSelect || 0}"` : ''}>
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
      <input type="checkbox" name="extra" value="${extra.id}">
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

function openCartDialog() {
  const dialog = $('#cartDialog');
  const cart = getCart();
  dialog.innerHTML = `
    <div class="dialog__body">
      <div class="dialog__head">
        <div>
          <h2>Carrito</h2>
          <p class="muted">${cart.length} linea${cart.length === 1 ? '' : 's'} en tu pedido</p>
        </div>
        <button class="btn btn--ghost btn--small" type="button" data-close-dialog>Cerrar</button>
      </div>
      <div class="cart-lines" id="cartDialogLines">
        ${cart.length ? cart.map(cartLine).join('') : '<div class="empty-state">Tu carrito esta vacio.</div>'}
      </div>
      <div class="price-row"><strong>Total</strong><strong>${money(cartTotalCents(cart))}</strong></div>
      <div class="nav-actions" style="justify-content:flex-start">
        <a class="btn btn--brand" href="/checkout">Confirmar pedido</a>
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
if (page === 'checkout') initCheckout().catch((error) => alert(error.message));
if (page === 'status') initStatus().catch(console.error);
