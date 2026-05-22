const CART_KEY = 'qr-food-pos-cart-v1';
const LAST_ORDER_KEY = 'qr-food-pos-last-order';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
const page = document.body.dataset.page;

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
  return (Number(item.basePriceCents || 0) + extras) * Number(item.quantity || 1);
}

function cartTotalCents(cart = getCart()) {
  return cart.reduce((sum, item) => sum + lineTotalCents(item), 0);
}

function updateBusinessHeader(menu) {
  if (!menu?.business) return;
  $$('[data-business-name]').forEach((node) => { node.textContent = menu.business.name; });
  $$('[data-business-heading]').forEach((node) => { node.textContent = menu.business.name; });
  $$('[data-business-logo]').forEach((node) => {
    node.src = menu.business.logoUrl || '/api/public/art/logo.svg';
  });
  const openState = $('[data-open-state]');
  if (openState) openState.textContent = menu.openState.open ? 'Abierto para pedidos' : 'Cerrado ahora';
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
  const state = {
    menu: await api('/api/public/menu'),
    category: 'all',
    search: ''
  };
  updateBusinessHeader(state.menu);
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
  return `
    <article class="product-card ${product.soldOut ? 'is-sold-out' : ''}">
      <img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">
      <div class="product-card__body">
        <div>
          <div class="price-row">
            <h3>${escapeHtml(product.name)}</h3>
            ${product.featured ? '<span class="badge badge--hot">Destacado</span>' : ''}
          </div>
          <p>${escapeHtml(product.description)}</p>
        </div>
        <div class="price-row">
          <span class="price">${money(product.basePriceCents)}</span>
          ${product.soldOut
            ? '<span class="badge badge--danger">Agotado</span>'
            : `<button class="btn btn--brand btn--small" type="button" data-add-product="${product.id}" ${disabled}>Agregar</button>`}
        </div>
      </div>
    </article>
  `;
}

function openProductDialog(product) {
  const dialog = $('#productDialog');
  dialog.innerHTML = `
    <form method="dialog" class="dialog__body" id="productForm">
      <div class="dialog__head">
        <div>
          <h2>${escapeHtml(product.name)}</h2>
          <p class="muted">${escapeHtml(product.description)}</p>
        </div>
        <button class="btn btn--ghost btn--small" type="button" data-close-dialog>Cerrar</button>
      </div>
      <img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" style="height:180px;width:100%;object-fit:cover;border-radius:8px">
      ${product.variants.map((variant) => `
        <label>${escapeHtml(variant.name)}
          <select class="select" name="variant:${escapeHtml(variant.name)}" ${variant.required ? 'required' : ''}>
            ${variant.options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}
          </select>
        </label>
      `).join('')}
      ${product.extras.length ? `
        <div>
          <strong>Extras</strong>
          <div class="option-list">
            ${product.extras.map((extra) => `
              <label>
                <input type="checkbox" name="extra" value="${extra.id}">
                <span>${escapeHtml(extra.name)} +${money(extra.priceCents)}</span>
              </label>
            `).join('')}
          </div>
        </div>
      ` : ''}
      <label>Notas especiales<textarea class="textarea" name="notes" placeholder="Sin cebolla, menos azucar, separar salsa..."></textarea></label>
      <label>Cantidad<input class="field" name="quantity" type="number" min="1" max="99" value="1"></label>
      <div class="price-row">
        <strong>${money(product.basePriceCents)}</strong>
        <button class="btn btn--brand" type="submit">Agregar al carrito</button>
      </div>
    </form>
  `;
  $('[data-close-dialog]', dialog).addEventListener('click', () => dialog.close());
  $('#productForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const variants = {};
    for (const [key, value] of form.entries()) {
      if (key.startsWith('variant:')) variants[key.replace('variant:', '')] = value;
    }
    const extraIds = form.getAll('extra').map(Number);
    const selectedExtras = product.extras.filter((extra) => extraIds.includes(extra.id));
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
      notes: String(form.get('notes') || '').trim()
    });
    saveCart(cart);
    dialog.close();
    openCartDialog();
  });
  dialog.showModal();
}

function cartLine(item) {
  const variants = Object.entries(item.variants || {}).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join(', ');
  const extras = (item.extrasData || []).map((extra) => `${escapeHtml(extra.name)} +${money(extra.priceCents)}`).join(', ');
  return `
    <div class="cart-line">
      <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}">
      <div>
        <strong>${item.quantity}x ${escapeHtml(item.name)}</strong>
        ${variants ? `<div class="muted">${variants}</div>` : ''}
        ${extras ? `<div class="muted">${extras}</div>` : ''}
        ${item.notes ? `<div class="muted">${escapeHtml(item.notes)}</div>` : ''}
      </div>
      <div style="text-align:right">
        <strong>${money(lineTotalCents(item))}</strong><br>
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
      <div class="cart-lines">
        ${cart.length ? cart.map(cartLine).join('') : '<div class="empty-state">Tu carrito esta vacio.</div>'}
      </div>
      <div class="price-row"><strong>Total</strong><strong>${money(cartTotalCents(cart))}</strong></div>
      <div class="nav-actions" style="justify-content:flex-start">
        <a class="btn btn--brand" href="/checkout">Confirmar pedido</a>
        <button class="btn btn--ghost" type="button" data-close-dialog>Seguir viendo menu</button>
      </div>
    </div>
  `;
  dialog.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-cart]');
    if (remove) {
      saveCart(getCart().filter((item) => item.cartId !== remove.dataset.removeCart));
      dialog.close();
      openCartDialog();
    }
    if (event.target.closest('[data-close-dialog]')) dialog.close();
  }, { once: true });
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

  deliverySelect.innerHTML = options.deliveryMethods.map((method) => `<option value="${method.id}" data-slug="${method.slug}">${escapeHtml(method.name)}</option>`).join('');
  paymentSelect.innerHTML = options.paymentMethods.map((method) => `<option value="${method.id}">${escapeHtml(method.name)}</option>`).join('');
  zoneSelect.innerHTML = options.deliveryZones.map((zone) => `<option value="${zone.id}" data-fee="${zone.feeCents}">${escapeHtml(zone.name)} - ${money(zone.feeCents)}</option>`).join('');

  function renderSummary() {
    const currentCart = getCart();
    const deliveryMethod = options.deliveryMethods.find((method) => method.id === Number(deliverySelect.value));
    const isDelivery = deliveryMethod?.slug === 'delivery';
    const zone = options.deliveryZones.find((item) => item.id === Number(zoneSelect.value));
    const fee = isDelivery && zone ? zone.feeCents : 0;
    $('#addressWrap').hidden = !isDelivery;
    $('#referenceWrap').hidden = !isDelivery;
    $('#zoneWrap').hidden = !isDelivery;
    $('#checkoutCart').innerHTML = currentCart.length ? currentCart.map(cartLine).join('') : '<div class="empty-state">Tu carrito esta vacio.</div>';
    $('#checkoutSubtotal').textContent = money(cartTotalCents(currentCart));
    $('#checkoutDelivery').textContent = money(fee);
    $('#checkoutTotal').textContent = money(cartTotalCents(currentCart) + fee);
  }

  deliverySelect.addEventListener('change', renderSummary);
  zoneSelect.addEventListener('change', renderSummary);
  $('#checkoutCart').addEventListener('click', (event) => {
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
      notes: data.get('notes'),
      items: currentCart.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        variants: item.variants,
        extras: item.extras,
        notes: item.notes
      }))
    };
    try {
      const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
      localStorage.setItem(LAST_ORDER_KEY, result.order.orderNumber);
      localStorage.removeItem(CART_KEY);
      form.hidden = true;
      $('#orderSuccess').hidden = false;
      $('#orderSuccess').innerHTML = `
        <div class="empty-state" style="text-align:left">
          <h2>Pedido enviado</h2>
          <p>Numero de orden: <strong>${escapeHtml(result.order.orderNumber)}</strong></p>
          <p>Total: <strong>${money(result.order.totalCents)}</strong></p>
          <div class="nav-actions" style="justify-content:flex-start">
            <a class="btn btn--brand" href="/status?order=${encodeURIComponent(result.order.orderNumber)}">Ver estado</a>
            ${result.whatsappUrl ? `<a class="btn btn--soft" href="${result.whatsappUrl}" target="_blank" rel="noreferrer">Confirmar por WhatsApp</a>` : ''}
          </div>
        </div>
      `;
      renderSummary();
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
    loadStatus(input.value);
  });
  if (input.value) loadStatus(input.value);
}

async function loadStatus(orderNumber) {
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

if (page === 'home') initHome().catch(console.error);
if (page === 'menu') initMenu().catch((error) => alert(error.message));
if (page === 'checkout') initCheckout().catch((error) => alert(error.message));
if (page === 'status') initStatus().catch(console.error);
