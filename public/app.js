const CART_KEY = 'qr-food-pos-cart-v1';
const LAST_ORDER_KEY = 'qr-food-pos-last-order';
const LAST_WHATSAPP_KEY = 'qr-food-pos-last-whatsapp-url';
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
    node.src = menu.business.logoUrl || '/api/public/art/logo.svg';
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
  const variants = publicVariants(product);
  const optionGroups = publicOptionalGroups(product);
  const extras = publicExtras(product);
  dialog.innerHTML = `
    <form method="dialog" class="dialog__body product-dialog-form" id="productForm">
      <div class="product-dialog-hero">
        <img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}">
        <button class="icon-btn product-dialog-close" type="button" data-close-dialog>&times;</button>
        <div>
          ${product.featured ? '<span class="badge badge--hot">Popular</span>' : ''}
          <h2>${escapeHtml(product.name)}</h2>
          <p>${escapeHtml(product.description)}</p>
        </div>
      </div>
      <div class="product-dialog-content">
        ${variants.map((variant) => `
          <label class="option-card">
            <span>${escapeHtml(variant.name)}${variant.required ? ' *' : ''}</span>
            <select class="select" name="variant:${escapeHtml(variant.name)}" ${variant.required ? 'required' : ''}>
              ${variant.options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}
            </select>
          </label>
        `).join('')}
      ${optionGroups.length ? `
        <section class="dialog-section">
          <strong>Personaliza tu pedido</strong>
          <div class="option-list">
            ${optionGroups.map((group) => optionalGroupControl(group)).join('')}
          </div>
        </section>
      ` : ''}
      ${extras.length ? `
        <section class="dialog-section">
          <strong>Toppings y extras</strong>
          <div class="option-list">
            ${extras.map((extra) => `
              <label class="option-row">
                <input type="checkbox" name="extra" value="${extra.id}">
                <span>${escapeHtml(extra.name)}</span>
                <strong>+${money(extra.priceCents)}</strong>
              </label>
            `).join('')}
          </div>
        </section>
      ` : ''}
        <label class="dialog-section">Notas especiales<textarea class="textarea" name="notes" placeholder="Menos azucar, sin hielo, separar topping..."></textarea></label>
        <label class="quantity-field">Cantidad<input class="field" name="quantity" type="number" min="1" max="99" value="1"></label>
      </div>
      <div class="product-dialog-action">
        <div>
          <span class="muted">Total</span>
          <strong id="productDialogTotal">${money(product.basePriceCents)}</strong>
        </div>
        <button class="btn btn--brand" type="submit">Agregar al carrito</button>
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
  dialog.showModal();
}

function optionalGroupControl(group) {
  const inputType = group.maxSelect === 1 ? 'radio' : 'checkbox';
  return `
    <fieldset class="optional-card">
      <legend><strong>${escapeHtml(group.name)}</strong>${group.required ? ' *' : ''}</legend>
      ${group.options.map((option) => `
        <label class="option-row">
          <input type="${inputType}" name="optional:${group.id}" value="${option.id}" ${group.required && inputType === 'radio' ? 'required' : ''}>
          <span>${escapeHtml(option.name)}</span>
          ${option.priceCents ? `<strong>+${money(option.priceCents)}</strong>` : '<strong></strong>'}
        </label>
      `).join('')}
      ${group.maxSelect > 1 ? `<div class="muted">Maximo ${group.maxSelect} opciones</div>` : ''}
    </fieldset>
  `;
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
  const progress = ['Nuevo', 'Aceptado', 'En preparacion', 'Listo', order.deliveryMethod?.slug === 'delivery' ? 'En camino' : '', 'Entregado']
    .filter(Boolean);
  const currentIndex = progress.indexOf(order.status);
  const whatsappUrl = order.whatsappUrl || localStorage.getItem(whatsappStorageKey(order.orderNumber)) || '';
  $('#statusResult').innerHTML = `
    <div class="status-card">
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
      ${whatsappUrl ? `
        <div class="status-actions">
          <a class="btn btn--brand" href="${escapeHtml(whatsappUrl)}" target="_blank" rel="noreferrer">Confirmar por WhatsApp</a>
          <a class="btn btn--soft" href="/menu">Hacer otro pedido</a>
        </div>
      ` : ''}
      <div class="status-progress">
        ${progress.map((step, index) => `
          <div class="status-step ${currentIndex >= index ? 'is-done' : ''}">
            <span>${index + 1}</span>
            <strong>${escapeHtml(step)}</strong>
          </div>
        `).join('')}
      </div>
      <div class="cart-lines" style="margin-top:14px">
        ${order.items.map((item) => `
          <div class="price-row">
            <span>${item.quantity}x ${escapeHtml(item.productName)}</span>
            <strong>${money(Math.round(item.lineTotal * 100))}</strong>
          </div>
        `).join('')}
      </div>
      ${order.discountCents ? `<div class="price-row"><span>Descuento ${escapeHtml(order.couponCode || '')}</span><span>-${money(order.discountCents)}</span></div>` : ''}
      <div class="price-row" style="margin-top:14px"><strong>Total</strong><strong>${money(order.totalCents)}</strong></div>
    </div>
  `;
  $('#statusTimeline').innerHTML = order.history.map((entry) => `
    <div class="timeline__item">
      <strong>${escapeHtml(entry.status)}</strong>
      <span class="muted">${new Date(entry.createdAt).toLocaleString()}</span>
    </div>
  `).join('');
}

function scheduleStatusFallback(orderNumber) {
  if (statusPollTimer) clearTimeout(statusPollTimer);
  statusPollTimer = setTimeout(() => loadStatus(orderNumber, false), 7000);
}

function connectOrderStatusEvents(orderNumber, currentStatus) {
  closeStatusEvents();
  if (!('EventSource' in window) || isFinalStatus(currentStatus)) {
    if (!isFinalStatus(currentStatus)) scheduleStatusFallback(orderNumber);
    return;
  }
  statusEvents = new EventSource(`/api/public/order-events?order=${encodeURIComponent(orderNumber)}`);
  const handleEvent = (event) => {
    const data = JSON.parse(event.data);
    if (!data.order) return;
    renderStatus(data.order);
    if (isFinalStatus(data.order.status)) closeStatusEvents();
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
    renderStatus(order);
    if (connectRealtime) connectOrderStatusEvents(orderNumber, order.status);
    if (!connectRealtime && !isFinalStatus(order.status)) scheduleStatusFallback(orderNumber);
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
