const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
const adminPrice = (cents) => `${((Number(cents) || 0) / 100).toFixed(2).replace('.', ',')} US$`;
const statuses = ['Nuevo', 'Aceptado', 'En preparacion', 'Listo', 'En camino', 'Entregado', 'Cancelado'];

const state = {
  user: null,
  section: 'dashboard',
  orders: [],
  selectedOrderId: null,
  knownNewOrders: new Set(),
  catalog: null
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(path, {
    headers: { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && document.body.dataset.page !== 'admin-login') {
    location.href = '/admin/login';
    return {};
  }
  if (!response.ok) throw new Error(data.error || 'Solicitud no completada.');
  return data;
}

function showToast(message) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-visible');
  setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function statusClass(status) {
  return `status-badge status-${status.replaceAll(' ', '-')}`;
}

function elapsed(iso) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'Ahora';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function can(permission) {
  return state.user?.permissions?.includes('*') || state.user?.permissions?.includes(permission);
}

async function initLogin() {
  const form = $('#loginForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: data.get('email'), password: data.get('password') })
      });
      location.href = '/admin';
    } catch (error) {
      showToast(error.message);
    }
  });
}

async function initAdmin() {
  const me = await api('/api/auth/me');
  if (!me.user) {
    location.href = '/admin/login';
    return;
  }
  state.user = me.user;
  $('#adminUserRole').textContent = `${state.user.name} · ${state.user.roleName}`;
  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/admin/login';
  });

  $('#adminNav').addEventListener('click', (event) => {
    const link = event.target.closest('a[data-section]');
    if (!link) return;
    event.preventDefault();
    history.pushState({}, '', link.href);
    setSection(link.dataset.section);
  });
  window.addEventListener('popstate', () => setSection(sectionFromPath()));
  setSection(sectionFromPath());
  setInterval(pollOrders, 5000);
}

function sectionFromPath() {
  const key = location.pathname.replace('/admin/', '').replace('/admin', '') || 'dashboard';
  return ['dashboard', 'orders', 'kds', 'products', 'categories', 'extras', 'reports', 'settings', 'audit', 'users'].includes(key) ? key : 'dashboard';
}

function setSection(section) {
  state.section = section;
  $$('.admin-section').forEach((node) => node.classList.remove('is-active'));
  $(`#${section}Section`).classList.add('is-active');
  $$('#adminNav a').forEach((link) => link.classList.toggle('is-active', link.dataset.section === section));
  const titles = {
    dashboard: ['Dashboard', 'Operacion del dia'],
    orders: ['Pedidos', 'Recepcion, caja y seguimiento'],
    kds: ['Cocina/KDS', 'Preparacion en cocina'],
    products: ['Productos', 'Menu, precios, imagenes y disponibilidad'],
    categories: ['Categorias', 'Orden y filtros del menu'],
    extras: ['Opcionales', 'Grupos, reglas, precios y vinculos a productos'],
    reports: ['Reportes', 'Ventas y productos'],
    settings: ['Configuracion', 'Negocio, horario y QR'],
    audit: ['Auditoria', 'Eventos de seguridad y operacion'],
    users: ['Usuarios', 'Roles y permisos']
  };
  $('#sectionTitle').textContent = titles[section][0];
  $('#sectionSubtitle').textContent = titles[section][1];
  renderCurrentSection().catch((error) => {
    $(`#${section}Section`).innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  });
}

async function renderCurrentSection() {
  if (state.section === 'dashboard') return renderDashboard();
  if (state.section === 'orders') return renderOrders();
  if (state.section === 'kds') return renderKds();
  if (state.section === 'products') return renderProductsAdmin();
  if (state.section === 'categories') return renderCategoriesAdmin();
  if (state.section === 'extras') return renderExtrasAdmin();
  if (state.section === 'reports') return renderReports();
  if (state.section === 'settings') return renderSettings();
  if (state.section === 'audit') return renderAudit();
  if (state.section === 'users') return renderUsers();
}

async function pollOrders() {
  if (!['dashboard', 'orders', 'kds'].includes(state.section)) return;
  try {
    const data = await api('/api/admin/orders');
    const currentNew = new Set(data.orders.filter((order) => order.status === 'Nuevo').map((order) => order.orderNumber));
    const hasNew = [...currentNew].some((orderNumber) => !state.knownNewOrders.has(orderNumber));
    if (state.knownNewOrders.size && hasNew) {
      showToast('Nuevo pedido recibido');
      beep();
    }
    state.knownNewOrders = currentNew;
    if (state.section === 'orders') renderOrders(data.orders);
    if (state.section === 'kds') renderKds();
    if (state.section === 'dashboard') renderDashboard();
  } catch {
    /* polling silencioso */
  }
}

function beep() {
  try {
    const context = new AudioContext();
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      context.close();
    }, 180);
  } catch {
    /* audio puede requerir gesto del usuario */
  }
}

async function renderDashboard() {
  const [reports, ordersData, settings] = await Promise.all([
    api('/api/admin/reports'),
    api('/api/admin/orders'),
    api('/api/admin/settings').catch(() => ({ business: null }))
  ]);
  if (settings.business) $('#adminBusinessName').textContent = settings.business.name;
  const recent = ordersData.orders.slice(0, 6);
  $('#dashboardSection').innerHTML = `
    <div class="metrics">
      ${metric('Ventas hoy', money(reports.today.salesCents), `${reports.today.orders} pedidos`)}
      ${metric('Ventas semana', money(reports.week.salesCents), `${reports.week.orders} pedidos`)}
      ${metric('Ticket promedio', money(reports.all.averageTicketCents), 'Historico')}
      ${metric('Cancelados', reports.cancelledOrders, 'Pedidos')}
    </div>
    <div class="panel" style="margin-top:14px">
      <div class="section-title"><h2>Pedidos recientes</h2><a class="btn btn--soft btn--small" href="/admin/orders" data-go="orders">Ver pedidos</a></div>
      <div class="order-list">${recent.length ? recent.map(orderCard).join('') : '<div class="empty-state">Sin pedidos todavia.</div>'}</div>
    </div>
  `;
  $('[data-go="orders"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    history.pushState({}, '', '/admin/orders');
    setSection('orders');
  });
}

function metric(label, value, detail) {
  return `<div class="metric"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><span class="muted">${escapeHtml(detail)}</span></div>`;
}

async function renderOrders(existingOrders = null) {
  const section = $('#ordersSection');
  const currentStatus = $('#orderStatusFilter')?.value || 'all';
  const currentSearch = $('#orderSearch')?.value || '';
  if (!existingOrders) {
    const data = await api(`/api/admin/orders?status=${encodeURIComponent(currentStatus)}&search=${encodeURIComponent(currentSearch)}`);
    state.orders = data.orders;
  } else {
    state.orders = existingOrders;
  }
  if (!state.selectedOrderId && state.orders.length) state.selectedOrderId = state.orders[0].id;
  const selected = state.orders.find((order) => order.id === state.selectedOrderId) || state.orders[0];
  section.innerHTML = `
    <div class="toolbar">
      <div class="nav-actions">
        <select class="select" id="orderStatusFilter" style="width:180px">
          <option value="all" ${currentStatus === 'all' ? 'selected' : ''}>Todos</option>
          ${statuses.map((status) => `<option value="${status}" ${currentStatus === status ? 'selected' : ''}>${status}</option>`).join('')}
        </select>
        <input class="field" id="orderSearch" style="width:260px" placeholder="Buscar numero o cliente" value="${escapeHtml(currentSearch)}">
      </div>
      <button class="btn btn--soft" type="button" id="refreshOrders">Actualizar</button>
    </div>
    <div class="split-view">
      <div class="order-list">${state.orders.length ? state.orders.map(orderCard).join('') : '<div class="empty-state">No hay pedidos con esos filtros.</div>'}</div>
      <aside class="panel order-detail" id="orderDetail">${selected ? orderDetail(selected) : '<div class="empty-state">Selecciona un pedido.</div>'}</aside>
    </div>
  `;
  $('#ordersSection').addEventListener('click', handleOrdersClick, { once: true });
  $('#orderStatusFilter').addEventListener('change', () => renderOrders());
  $('#orderSearch').addEventListener('input', debounce(() => renderOrders(), 250));
  $('#refreshOrders').addEventListener('click', () => renderOrders());
}

function orderCard(order) {
  return `
    <article class="order-row ${order.status === 'Nuevo' ? 'is-new' : ''}" data-select-order="${order.id}">
      <header>
        <strong>${escapeHtml(order.orderNumber)}</strong>
        <span class="${statusClass(order.status)}">${escapeHtml(order.status)}</span>
      </header>
      <div class="price-row">
        <span>${escapeHtml(order.customer.name)} · ${escapeHtml(order.deliveryMethod.name)}</span>
        <strong>${money(order.totalCents)}</strong>
      </div>
      <div class="muted">${elapsed(order.createdAt)} · ${order.items.length} lineas</div>
    </article>
  `;
}

function orderDetail(order) {
  return `
    <div class="price-row">
      <div>
        <h2>${escapeHtml(order.orderNumber)}</h2>
        <span class="muted">${new Date(order.createdAt).toLocaleString()}</span>
      </div>
      <span class="${statusClass(order.status)}">${escapeHtml(order.status)}</span>
    </div>
    <div style="margin:12px 0 0;padding:12px;border:1px solid var(--line);border-radius:8px;background:#f9fbfa">
      <strong>${escapeHtml(order.customer.name)}</strong>
      <div class="muted">${escapeHtml(order.customer.phone)}</div>
      ${order.customer.address ? `<div class="muted">${escapeHtml(order.customer.address)}</div>` : ''}
      ${order.customer.reference ? `<div class="muted">${escapeHtml(order.customer.reference)}</div>` : ''}
    </div>
    <div class="cart-lines" style="margin-top:12px">
      ${order.items.map(orderItemLine).join('')}
    </div>
    ${order.notes ? `<p><strong>Notas:</strong> ${escapeHtml(order.notes)}</p>` : ''}
    <div class="price-row"><span>Subtotal</span><span>${money(order.subtotalCents)}</span></div>
    <div class="price-row"><span>Delivery</span><span>${money(order.deliveryFeeCents)}</span></div>
    <div class="price-row"><strong>Total</strong><strong>${money(order.totalCents)}</strong></div>
    <div class="actions-row" style="margin-top:12px">
      ${statuses.filter((status) => status !== 'Nuevo' && status !== order.status).map((status) => `
        <button class="btn btn--small ${status === 'Cancelado' ? 'btn--danger' : 'btn--soft'}" type="button" data-status="${status}" data-order-id="${order.id}">${status}</button>
      `).join('')}
      <button class="btn btn--ghost btn--small" type="button" data-print-ticket="${order.id}">Imprimir ticket</button>
    </div>
    <div class="timeline">
      ${order.history.map((entry) => `<div class="timeline__item"><strong>${escapeHtml(entry.status)}</strong><span class="muted">${new Date(entry.createdAt).toLocaleTimeString()}</span></div>`).join('')}
    </div>
  `;
}

function orderItemLine(item) {
  const variants = Object.entries(item.variants || {}).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join(', ');
  const extras = (item.extras || []).map((extra) => `${escapeHtml(extra.name)} +${money(extra.priceCents)}`).join(', ');
  return `
    <div>
      <div class="price-row"><strong>${item.quantity}x ${escapeHtml(item.productName)}</strong><strong>${money(item.lineTotalCents)}</strong></div>
      ${variants ? `<div class="muted">${variants}</div>` : ''}
      ${extras ? `<div class="muted">${extras}</div>` : ''}
      ${item.notes ? `<div class="muted">${escapeHtml(item.notes)}</div>` : ''}
    </div>
  `;
}

function handleOrdersClick(event) {
  const selected = event.target.closest('[data-select-order]');
  if (selected) {
    state.selectedOrderId = Number(selected.dataset.selectOrder);
    const order = state.orders.find((item) => item.id === state.selectedOrderId);
    $('#orderDetail').innerHTML = orderDetail(order);
  }
  const statusButton = event.target.closest('[data-status]');
  if (statusButton) updateStatus(Number(statusButton.dataset.orderId), statusButton.dataset.status);
  const printButton = event.target.closest('[data-print-ticket]');
  if (printButton) {
    const order = state.orders.find((item) => item.id === Number(printButton.dataset.printTicket));
    printTicket(order);
  }
  $('#ordersSection').addEventListener('click', handleOrdersClick, { once: true });
}

async function updateStatus(orderId, status) {
  try {
    const result = await api(`/api/admin/orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    showToast(`Pedido ${result.order.orderNumber}: ${status}`);
    state.selectedOrderId = result.order.id;
    await renderCurrentSection();
  } catch (error) {
    showToast(error.message);
  }
}

async function renderKds() {
  const data = await api('/api/admin/orders?kds=1');
  $('#kdsSection').innerHTML = `
    <div class="kds-grid">
      ${data.orders.length ? data.orders.map((order) => `
        <article class="kds-card">
          <header class="price-row">
            <strong>${escapeHtml(order.orderNumber)}</strong>
            <span>${elapsed(order.createdAt)}</span>
          </header>
          <ul>${order.items.map((item) => `<li>${item.quantity}x ${escapeHtml(item.productName)}</li>`).join('')}</ul>
          ${order.notes ? `<p>${escapeHtml(order.notes)}</p>` : ''}
          <div class="actions-row">
            <button class="btn btn--soft btn--small" type="button" data-kds-status="En preparacion" data-order-id="${order.id}">Preparar</button>
            <button class="btn btn--brand btn--small" type="button" data-kds-status="Listo" data-order-id="${order.id}">Listo</button>
          </div>
        </article>
      `).join('') : '<div class="empty-state">No hay pedidos en cocina.</div>'}
    </div>
  `;
  $('#kdsSection').onclick = (event) => {
    const button = event.target.closest('[data-kds-status]');
    if (button) updateStatus(Number(button.dataset.orderId), button.dataset.kdsStatus);
  };
}

async function loadCatalog() {
  state.catalog = await api('/api/admin/catalog');
  return state.catalog;
}

async function renderProductsAdmin() {
  const catalog = await loadCatalog();
  const productBoard = renderProductCatalogBoard(catalog);
  $('#productsSection').innerHTML = `
    <div class="catalog-top">
      <div class="segmented" style="max-width:320px">
        <strong>Productos</strong>
        <a href="/admin/extras" data-go-optionals>Opcionales</a>
      </div>
      <input class="field" id="productAdminSearch" placeholder="Buscar producto..." style="max-width:420px">
    </div>
    <div class="product-workspace">
      ${productBoard}
    </div>
    <dialog class="admin-drawer" id="productEditorDrawer">
      <form class="drawer-form product-editor-form" id="productForm">
        <div class="drawer-head">
          <h2 id="productFormTitle">Nuevo producto</h2>
          <button class="icon-btn" type="button" data-close-product-editor>&times;</button>
        </div>
        <input type="hidden" name="id">
        <label>Categoria<select class="select" name="categoryId" required>
          ${catalog.categories.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('')}
        </select></label>
        <label>Nombre<input class="field" name="name" required></label>
        <label>Precio<input class="field" name="price" type="number" min="0" step="0.01" required></label>
        <label>Imagen URL<input class="field" name="imageUrl" placeholder="/api/public/art/taro-milk-tea.svg"></label>
        <label>Subir imagen<input class="field" name="imageFile" type="file" accept="image/png,image/jpeg,image/webp"></label>
        <button class="btn btn--soft" type="button" id="uploadImageBtn">Subir imagen</button>
        <label>Descripcion<textarea class="textarea" name="description"></textarea></label>
        <div>
          <div class="price-row">
            <strong>Grupos de opcionales</strong>
            <button class="btn btn--ghost btn--small" type="button" id="goOptionalGroupsBtn">Crear grupo</button>
          </div>
          <div class="checks">
            ${catalog.optionalGroups.map((group) => `
              <label>
                <input type="checkbox" name="optionalGroupIds" value="${group.id}">
                ${escapeHtml(group.name)} <span class="muted">(${group.options.length})</span>
              </label>
            `).join('')}
          </div>
        </div>
        <div>
          <div class="price-row">
            <strong>Variantes rapidas</strong>
            <button class="btn btn--ghost btn--small" type="button" id="addVariantBtn">Agregar variante</button>
          </div>
          <div class="variant-builder" id="variantBuilder"></div>
        </div>
        <div>
          <strong>Extras</strong>
          <div class="checks">${catalog.extras.map((extra) => `<label><input type="checkbox" name="extraIds" value="${extra.id}">${escapeHtml(extra.name)} ${money(extra.priceCents)}${extra.active ? '' : ' (inactivo)'}</label>`).join('')}</div>
        </div>
        <div class="checks">
          <label><input type="checkbox" name="featured">Destacado</label>
          <label><input type="checkbox" name="active" checked>Activo</label>
          <label><input type="checkbox" name="available" checked>Disponible</label>
        </div>
        <div class="actions-row">
          <button class="btn btn--brand" type="submit">Guardar</button>
          <button class="btn btn--ghost" type="button" id="newProductBtn">Nuevo</button>
        </div>
      </form>
    </dialog>
  `;
  $('[data-go-optionals]').addEventListener('click', (event) => {
    event.preventDefault();
    history.pushState({}, '', '/admin/extras');
    setSection('extras');
  });
  renderVariantRows([]);
  $('#productForm').addEventListener('submit', saveProductForm);
  $('#uploadImageBtn').addEventListener('click', uploadProductImage);
  $('#goOptionalGroupsBtn').addEventListener('click', () => {
    history.pushState({}, '', '/admin/extras');
    setSection('extras');
  });
  $('#addVariantBtn').addEventListener('click', () => addVariantRow());
  $('#variantBuilder').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-variant]');
    if (button) button.closest('.variant-row').remove();
  });
  $('#newProductBtn').addEventListener('click', resetProductForm);
  $('[data-close-product-editor]').addEventListener('click', () => $('#productEditorDrawer').close());
  $('#productsSection').onclick = productTableClick;
  $('#productAdminSearch').addEventListener('input', (event) => {
    const term = event.target.value.toLowerCase();
    $$('[data-product-section]').forEach((section) => {
      const categoryMatch = (section.dataset.search || '').includes(term);
      const rows = $$('[data-product-row]', section);
      rows.forEach((row) => {
        row.hidden = Boolean(term) && !categoryMatch && !(row.dataset.search || '').includes(term);
      });
      section.hidden = Boolean(term) && !categoryMatch && rows.every((row) => row.hidden);
    });
  });
}

function renderProductCatalogBoard(catalog) {
  const productsByCategory = catalog.categories.map((category) => ({
    category,
    products: catalog.products.filter((product) => Number(product.categoryId) === Number(category.id))
  }));
  const uncategorized = catalog.products.filter((product) => !catalog.categories.some((category) => Number(category.id) === Number(product.categoryId)));
  const sections = productsByCategory.filter((group) => group.products.length || group.category.active);
  if (uncategorized.length) {
    sections.push({ category: { id: 0, name: 'Sin categoria', active: false }, products: uncategorized, locked: true });
  }
  return `
    <div class="catalog-board" id="productBoard">
      ${sections.length ? sections.map(productSectionCard).join('') : '<div class="empty-state">Crea una categoria para empezar a agregar productos.</div>'}
    </div>
  `;
}

function productSectionCard(group) {
  const { category, products, locked } = group;
  const activeCount = products.filter((product) => product.active && product.available).length;
  return `
    <section class="product-section-card" data-product-section="${category.id}" data-search="${escapeHtml(category.name.toLowerCase())}">
      <header class="product-section-head">
        <div class="product-section-title">
          <h2>${escapeHtml(category.name)}</h2>
          ${locked ? '' : `<button class="icon-btn" type="button" data-edit-category-from-products="${category.id}" aria-label="Editar categoria">&#9998;</button>`}
        </div>
        ${locked ? '' : `
          <div class="add-product-wrap">
            <span class="new-badge">Nuevo</span>
            <button class="btn btn--ghost btn--small product-add-btn" type="button" data-add-product-category="${category.id}">
              <span aria-hidden="true">+</span>
              Agregar Producto
            </button>
          </div>
        `}
      </header>
      <div class="product-section-meta">
        <span>${products.length} productos</span>
        <span>${activeCount} disponibles</span>
      </div>
      <div class="product-list">
        ${products.length ? products.map(productAdminRow).join('') : '<div class="empty-state product-empty-state">Esta seccion todavia no tiene productos.</div>'}
      </div>
    </section>
  `;
}

function productAdminRow(product) {
  const image = product.imageUrl || '/api/public/art/logo.svg';
  const searchText = [product.name, product.description, product.categoryName].join(' ').toLowerCase();
  const optionCount = (product.variants || []).length + (product.extras || []).length + (product.optionalGroups || []).length;
  return `
    <article class="product-list-row ${product.active ? '' : 'is-inactive'}" data-product-row data-search="${escapeHtml(searchText)}">
      <img class="product-thumb" src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" loading="lazy">
      <div class="product-row-main">
        <strong>${escapeHtml(product.name)}</strong>
        <p>${escapeHtml(product.description || 'Sin descripcion.')}</p>
        <div class="product-row-actions">
          <button class="btn btn--ghost btn--small product-options-btn" type="button" data-view-product-options="${product.id}">
            Ver opciones
          </button>
          <button class="btn btn--soft btn--small" type="button" data-edit-product="${product.id}">Editar</button>
        </div>
      </div>
      <div class="product-row-side">
        <button class="toggle ${product.available ? 'is-on' : ''}" type="button" data-toggle-product="${product.id}" aria-label="Cambiar disponibilidad"></button>
        <span class="product-option-count">${optionCount ? `${optionCount} configuraciones` : 'Sin opciones'}</span>
        <strong>${adminPrice(product.basePriceCents)}</strong>
      </div>
    </article>
  `;
}

async function uploadProductImage() {
  const form = $('#productForm');
  const file = form.elements.imageFile.files[0];
  if (!file) {
    showToast('Selecciona una imagen PNG, JPG o WebP');
    return;
  }
  const payload = new FormData();
  payload.append('image', file);
  try {
    const result = await api('/api/admin/uploads/images', { method: 'POST', body: payload });
    form.elements.imageUrl.value = result.upload.url;
    showToast('Imagen subida');
  } catch (error) {
    showToast(error.message);
  }
}

function variantsToText(variants) {
  return (variants || []).map((variant) => `${variant.name}: ${(variant.options || []).join(', ')}`).join('\n');
}

function parseVariants(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const [name, rest] = line.split(':');
    return { name: name?.trim(), options: rest ? rest.split(',').map((item) => item.trim()).filter(Boolean) : [] };
  }).filter((variant) => variant.name && variant.options.length);
}

function renderVariantRows(variants = []) {
  const builder = $('#variantBuilder');
  if (!builder) return;
  builder.innerHTML = '';
  if (!variants.length) {
    addVariantRow({ name: 'Tamano', options: ['16 oz', '22 oz'], required: true });
    addVariantRow({ name: 'Azucar', options: ['0%', '50%', '100%'], required: true });
    return;
  }
  variants.forEach((variant) => addVariantRow(variant));
}

function addVariantRow(variant = {}) {
  const builder = $('#variantBuilder');
  if (!builder) return;
  const row = document.createElement('div');
  row.className = 'variant-row';
  row.innerHTML = `
    <div class="variant-row__grid">
      <input class="field" data-variant-name placeholder="Nombre, ej. Tamano" value="${escapeHtml(variant.name || '')}">
      <input class="field" data-variant-options placeholder="Opciones separadas por coma" value="${escapeHtml((variant.options || []).join(', '))}">
      <label><input type="checkbox" data-variant-required ${variant.required === false ? '' : 'checked'}> Requerido</label>
      <button class="btn btn--ghost btn--small" type="button" data-remove-variant>Quitar</button>
    </div>
  `;
  builder.appendChild(row);
}

function collectVariants() {
  return $$('.variant-row').map((row, index) => ({
    name: $('[data-variant-name]', row).value.trim(),
    options: $('[data-variant-options]', row).value.split(',').map((option) => option.trim()).filter(Boolean),
    required: $('[data-variant-required]', row).checked,
    sortOrder: index + 1
  })).filter((variant) => variant.name && variant.options.length);
}

function fillProductForm(product) {
  const form = $('#productForm');
  form.elements.id.value = product.id;
  form.elements.categoryId.value = product.categoryId;
  form.elements.name.value = product.name;
  form.elements.price.value = (product.basePriceCents / 100).toFixed(2);
  form.elements.imageUrl.value = product.imageUrl || '';
  form.elements.description.value = product.description || '';
  renderVariantRows(product.variants);
  form.elements.featured.checked = product.featured;
  form.elements.active.checked = product.active;
  form.elements.available.checked = product.available;
  $$('input[name="extraIds"]', form).forEach((input) => {
    input.checked = product.extras.some((extra) => extra.id === Number(input.value));
  });
  $$('input[name="optionalGroupIds"]', form).forEach((input) => {
    input.checked = (product.optionalGroups || []).some((group) => group.id === Number(input.value));
  });
  $('#productFormTitle').textContent = `Editar ${product.name}`;
  openProductEditor();
}

function resetProductForm() {
  $('#productForm').reset();
  $('#productForm').elements.id.value = '';
  renderVariantRows([]);
  $('#productFormTitle').textContent = 'Nuevo producto';
}

function openProductEditor() {
  const dialog = $('#productEditorDrawer');
  if (dialog && !dialog.open) dialog.showModal();
}

function startProductForCategory(categoryId) {
  resetProductForm();
  const form = $('#productForm');
  form.elements.categoryId.value = String(categoryId);
  $('#productFormTitle').textContent = 'Nuevo producto';
  openProductEditor();
  form.elements.name.focus();
}

async function saveProductForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    categoryId: Number(form.elements.categoryId.value),
    name: form.elements.name.value,
    price: Number(form.elements.price.value),
    imageUrl: form.elements.imageUrl.value,
    description: form.elements.description.value,
    variants: collectVariants(),
    extraIds: $$('input[name="extraIds"]:checked', form).map((input) => Number(input.value)),
    optionalGroupIds: $$('input[name="optionalGroupIds"]:checked', form).map((input) => Number(input.value)),
    featured: form.elements.featured.checked,
    active: form.elements.active.checked,
    available: form.elements.available.checked
  };
  const id = form.elements.id.value;
  try {
    await api(id ? `/api/admin/products/${id}` : '/api/admin/products', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    showToast('Producto guardado');
    renderProductsAdmin();
  } catch (error) {
    showToast(error.message);
  }
}

function productTableClick(event) {
  const add = event.target.closest('[data-add-product-category]');
  if (add) {
    startProductForCategory(Number(add.dataset.addProductCategory));
    return;
  }

  const categoryEdit = event.target.closest('[data-edit-category-from-products]');
  if (categoryEdit) {
    sessionStorage.setItem('selectedCategoryId', categoryEdit.dataset.editCategoryFromProducts);
    history.pushState({}, '', '/admin/categories');
    setSection('categories');
    return;
  }

  const optionButton = event.target.closest('[data-view-product-options]');
  if (optionButton) {
    const product = state.catalog.products.find((item) => item.id === Number(optionButton.dataset.viewProductOptions));
    fillProductForm(product);
    $('#variantBuilder').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const edit = event.target.closest('[data-edit-product]');
  if (edit) {
    const product = state.catalog.products.find((item) => item.id === Number(edit.dataset.editProduct));
    fillProductForm(product);
    return;
  }

  const toggle = event.target.closest('[data-toggle-product]');
  if (toggle) {
    toggleProductAvailability(Number(toggle.dataset.toggleProduct));
    return;
  }

  const del = event.target.closest('[data-delete-product]');
  if (del && confirm('Eliminar producto?')) {
    api(`/api/admin/products/${del.dataset.deleteProduct}`, { method: 'DELETE' })
      .then(() => renderProductsAdmin())
      .catch((error) => showToast(error.message));
  }
}

async function toggleProductAvailability(productId) {
  const product = state.catalog.products.find((item) => item.id === Number(productId));
  if (!product) return;
  const payload = {
    categoryId: product.categoryId,
    name: product.name,
    price: product.basePriceCents / 100,
    imageUrl: product.imageUrl || '',
    description: product.description || '',
    variants: product.variants || [],
    extraIds: (product.extras || []).map((extra) => extra.id),
    optionalGroupIds: (product.optionalGroups || []).map((group) => group.id),
    featured: product.featured,
    active: product.active,
    available: !product.available,
    sortOrder: product.sortOrder || 0
  };
  try {
    await api(`/api/admin/products/${productId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    showToast(payload.available ? 'Producto disponible' : 'Producto agotado');
    renderProductsAdmin();
  } catch (error) {
    showToast(error.message);
  }
}

async function renderCategoriesAdmin() {
  const data = await api('/api/admin/categories');
  $('#categoriesSection').innerHTML = `
    <div class="split-view">
      <form class="panel form-grid" id="categoryForm">
        <input type="hidden" name="id">
        <label>Nombre<input class="field" name="name" required></label>
        <label>Orden<input class="field" name="sortOrder" type="number" value="0"></label>
        <label class="wide">Descripcion<textarea class="textarea" name="description"></textarea></label>
        <label><input type="checkbox" name="active" checked> Activa</label>
        <div class="wide actions-row">
          <button class="btn btn--brand" type="submit">Guardar</button>
          <button class="btn btn--ghost" type="button" id="newCategoryBtn">Nueva</button>
        </div>
      </form>
      <div class="panel table-wrap">
        <table class="table">
          <thead><tr><th>Categoria</th><th>Orden</th><th>Estado</th><th></th></tr></thead>
          <tbody>${data.categories.map((category) => `
            <tr>
              <td><strong>${escapeHtml(category.name)}</strong><div class="muted">${escapeHtml(category.description)}</div></td>
              <td>${category.sortOrder}</td>
              <td>${category.active ? 'Activa' : 'Inactiva'}</td>
              <td class="actions-row">
                <button class="btn btn--soft btn--small" type="button" data-edit-category="${category.id}">Editar</button>
                <button class="btn btn--danger btn--small" type="button" data-delete-category="${category.id}">Eliminar</button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    </div>
  `;
  $('#categoryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      name: form.elements.name.value,
      description: form.description.value,
      sortOrder: Number(form.sortOrder.value),
      active: form.elements.active.checked
    };
    const id = form.elements.id.value;
    await api(id ? `/api/admin/categories/${id}` : '/api/admin/categories', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    showToast('Categoria guardada');
    renderCategoriesAdmin();
  });
  $('#newCategoryBtn').addEventListener('click', () => $('#categoryForm').reset());
  const fillCategoryForm = (category) => {
    const form = $('#categoryForm');
    form.elements.id.value = category.id;
    form.elements.name.value = category.name;
    form.description.value = category.description;
    form.sortOrder.value = category.sortOrder;
    form.elements.active.checked = category.active;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const selectedCategoryId = Number(sessionStorage.getItem('selectedCategoryId'));
  const selectedCategory = data.categories.find((item) => item.id === selectedCategoryId);
  if (selectedCategory) {
    fillCategoryForm(selectedCategory);
    sessionStorage.removeItem('selectedCategoryId');
  }
  $('#categoriesSection').onclick = async (event) => {
    const edit = event.target.closest('[data-edit-category]');
    const del = event.target.closest('[data-delete-category]');
    if (edit) {
      const category = data.categories.find((item) => item.id === Number(edit.dataset.editCategory));
      fillCategoryForm(category);
    }
    if (del && confirm('Eliminar categoria?')) {
      await api(`/api/admin/categories/${del.dataset.deleteCategory}`, { method: 'DELETE' });
      renderCategoriesAdmin();
    }
  };
}

async function renderExtrasAdmin() {
  const data = await api('/api/admin/extras');
  const groups = data.optionalGroups || [];
  const selectedId = Number(sessionStorage.getItem('selectedOptionalGroupId')) || groups[0]?.id || 0;
  const selected = groups.find((group) => group.id === selectedId) || groups[0] || null;
  $('#extrasSection').innerHTML = `
    <div class="optional-layout">
      <aside class="optional-sidebar">
        <div class="segmented">
          <a href="/admin/products">Productos</a>
          <strong>Opcionales</strong>
        </div>
        <button class="btn btn--ghost optional-create" type="button" id="newGroupBtn">+ Crear grupo de opcionales</button>
        <div class="config-list" id="groupList">${renderOptionalGroupCards(groups, selected?.id)}</div>
      </aside>
      <section class="optional-detail">
        ${selected ? renderOptionalGroupDetail(selected) : `
          <div class="empty-state">
            <h2>Ningun grupo agregado</h2>
            <p>Crea grupos como Leche, Toppings, Boba o Extras para vincularlos a productos.</p>
          </div>
        `}
      </section>
    </div>
    <dialog class="admin-drawer" id="groupDialog"></dialog>
    <dialog class="admin-drawer" id="optionDialog"></dialog>
  `;
  $('#newGroupBtn').addEventListener('click', () => openGroupDialog());
  $('#groupList').addEventListener('click', (event) => {
    const card = event.target.closest('[data-select-group]');
    if (!card) return;
    sessionStorage.setItem('selectedOptionalGroupId', card.dataset.selectGroup);
    renderExtrasAdmin();
  });
  $('#extrasSection').addEventListener('click', async (event) => {
    const createOption = event.target.closest('[data-create-option]');
    const editGroup = event.target.closest('[data-edit-group]');
    const deleteGroup = event.target.closest('[data-delete-group]');
    const editOption = event.target.closest('[data-edit-option]');
    const toggleOption = event.target.closest('[data-toggle-option]');
    const deleteOption = event.target.closest('[data-delete-option]');

    if (createOption) openOptionDialog({ groupId: Number(createOption.dataset.createOption) });
    if (editGroup) openGroupDialog(groups.find((group) => group.id === Number(editGroup.dataset.editGroup)));
    if (deleteGroup && confirm('Eliminar grupo de opcionales? Se desvinculara de los productos.')) {
      await api(`/api/admin/optional-groups/${deleteGroup.dataset.deleteGroup}`, { method: 'DELETE' });
      sessionStorage.removeItem('selectedOptionalGroupId');
      showToast('Grupo eliminado');
      renderExtrasAdmin();
    }
    if (editOption) {
      const option = (selected?.options || []).find((item) => item.id === Number(editOption.dataset.editOption));
      openOptionDialog(option);
    }
    if (toggleOption) {
      const option = (selected?.options || []).find((item) => item.id === Number(toggleOption.dataset.toggleOption));
      await api(`/api/admin/optional-options/${option.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: option.name, price: option.price, active: !option.active, sortOrder: option.sortOrder })
      });
      renderExtrasAdmin();
    }
    if (deleteOption && confirm('Eliminar opcional?')) {
      await api(`/api/admin/optional-options/${deleteOption.dataset.deleteOption}`, { method: 'DELETE' });
      showToast('Opcional eliminado');
      renderExtrasAdmin();
    }
  });
}

function renderOptionalGroupCards(groups, selectedId) {
  return groups.length ? groups.map((group) => `
    <article class="config-item optional-group-card ${group.id === selectedId ? 'is-active' : ''}" data-select-group="${group.id}">
      <header>
        <div>
          <strong>${escapeHtml(group.name)}</strong>
          <div class="muted">${group.options.length} opcionales</div>
        </div>
        ${group.required ? '<span class="badge">Req.</span>' : ''}
      </header>
    </article>
  `).join('') : '<div class="empty-state">Sin grupos.</div>';
}

function renderOptionalGroupDetail(group) {
  return `
    <div class="optional-header">
      <div>
        <div class="actions-row">
          <h2>${escapeHtml(group.name)}</h2>
          <button class="icon-btn" type="button" data-edit-group="${group.id}" title="Editar grupo">✎</button>
        </div>
        <div class="muted">${group.linkedProducts.length ? group.linkedProducts.slice(0, 6).join(', ') : 'Sin productos vinculados'}</div>
      </div>
      <div class="actions-row">
        <button class="btn btn--brand btn--small" type="button" data-create-option="${group.id}">+ Crear opcional</button>
        <button class="btn btn--danger btn--small" type="button" data-delete-group="${group.id}">Eliminar grupo</button>
      </div>
    </div>
    <div class="optional-rules">
      <span>${group.required ? 'Seleccion obligatoria' : 'Seleccion opcional'}</span>
      <span>${group.maxSelect ? `Maximo ${group.maxSelect}` : 'Sin limite maximo'}</span>
      <span>${group.productCount} productos vinculados</span>
    </div>
    <div class="optional-table">
      ${group.options.length ? group.options.map((option) => `
        <div class="optional-option-row">
          <strong>${escapeHtml(option.name)}</strong>
          <span class="muted">${money(option.priceCents)}</span>
          <button class="toggle ${option.active ? 'is-on' : ''}" type="button" data-toggle-option="${option.id}" title="Activar o desactivar"></button>
          <button class="btn btn--soft btn--small" type="button" data-edit-option="${option.id}">Editar</button>
          <button class="btn btn--ghost btn--small" type="button" data-delete-option="${option.id}">Eliminar</button>
        </div>
      `).join('') : '<div class="empty-state">Ningun opcional agregado.</div>'}
    </div>
  `;
}

function openGroupDialog(group = null) {
  const dialog = $('#groupDialog');
  dialog.innerHTML = `
    <form method="dialog" class="drawer-form" id="groupForm">
      <div class="drawer-head">
        <h2>${group ? 'Editar grupo de opcionales' : 'Agregar grupo de opcionales'}</h2>
        <button class="icon-btn" type="button" data-close-dialog>×</button>
      </div>
      <input type="hidden" name="id" value="${group?.id || ''}">
      <input class="field" name="name" placeholder="Agregar nombre del grupo de opcionales *" value="${escapeHtml(group?.name || '')}" required>
      <section>
        <h3>Reglas</h3>
        <div class="drawer-rule">
          <span>¿La seleccion es <strong>obligatoria</strong> para los clientes?</span>
          <label class="toggle-label"><input type="checkbox" name="required" ${group?.required ? 'checked' : ''}></label>
        </div>
        <div class="drawer-rule">
          <span>Numero maximo de opcionales que puede seleccionar el cliente</span>
          <input class="field" name="maxSelect" type="number" min="0" value="${group?.maxSelect ?? 0}" style="width:72px">
        </div>
      </section>
      <button class="btn btn--brand drawer-confirm" type="submit">Confirmar</button>
    </form>
  `;
  $('[data-close-dialog]', dialog).addEventListener('click', () => dialog.close());
  $('#groupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    const result = await api(id ? `/api/admin/optional-groups/${id}` : '/api/admin/optional-groups', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify({
        name: form.elements.name.value,
        required: form.elements.required.checked,
        maxSelect: Number(form.elements.maxSelect.value || 0),
        active: true
      })
    });
    sessionStorage.setItem('selectedOptionalGroupId', result.group.id);
    dialog.close();
    showToast(id ? 'Grupo actualizado' : 'Grupo creado');
    renderExtrasAdmin();
  });
  dialog.showModal();
}

function openOptionDialog(option = {}) {
  const dialog = $('#optionDialog');
  dialog.innerHTML = `
    <form method="dialog" class="drawer-form drawer-form--compact" id="optionForm">
      <div class="drawer-head">
        <h2>${option.id ? 'Editar opcional' : 'Agregar opcional'}</h2>
        <button class="icon-btn" type="button" data-close-dialog>×</button>
      </div>
      <input type="hidden" name="id" value="${option.id || ''}">
      <input type="hidden" name="groupId" value="${option.groupId || ''}">
      <input class="field" name="name" placeholder="Nombre *" value="${escapeHtml(option.name || '')}" required>
      <label>Precio<input class="field" name="price" type="number" min="0" step="0.01" value="${((option.priceCents || 0) / 100).toFixed(2)}"></label>
      <label><input type="checkbox" name="active" ${option.active === false ? '' : 'checked'}> Disponible</label>
      <button class="btn btn--brand drawer-confirm" type="submit">Confirmar</button>
    </form>
  `;
  $('[data-close-dialog]', dialog).addEventListener('click', () => dialog.close());
  $('#optionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    await api(id ? `/api/admin/optional-options/${id}` : '/api/admin/optional-options', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify({
        groupId: Number(form.elements.groupId.value),
        name: form.elements.name.value,
        price: Number(form.elements.price.value || 0),
        active: form.elements.active.checked
      })
    });
    dialog.close();
    showToast(id ? 'Opcional actualizado' : 'Opcional creado');
    renderExtrasAdmin();
  });
  dialog.showModal();
}

async function renderReports() {
  const reports = await api('/api/admin/reports');
  $('#reportsSection').innerHTML = `
    <div class="metrics">
      ${metric('Hoy', money(reports.today.salesCents), `${reports.today.orders} pedidos`)}
      ${metric('Semana', money(reports.week.salesCents), `${reports.week.orders} pedidos`)}
      ${metric('Mes', money(reports.month.salesCents), `${reports.month.orders} pedidos`)}
      ${metric('Promedio', money(reports.all.averageTicketCents), 'Por pedido')}
    </div>
    <div class="page-grid">
      <section class="panel">
        <h2>Productos mas vendidos</h2>
        ${barChart(reports.topProducts, 'quantity', 'quantity')}
      </section>
      <section class="panel">
        <h2>Ventas por dia</h2>
        ${barChart(reports.byDay, 'salesCents', 'sales')}
      </section>
    </div>
    <div class="page-grid">
      <section class="panel"><h2>Metodo de pago</h2>${simpleTable(reports.byPayment)}</section>
      <section class="panel"><h2>Metodo de entrega</h2>${simpleTable(reports.byDelivery)}</section>
    </div>
  `;
}

function barChart(rows, valueKey, labelKey) {
  const max = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  return `<div class="bar-chart" style="margin-top:14px">${rows.length ? rows.map((row) => `
    <div class="bar-row">
      <strong>${escapeHtml(row.name || row.day)}</strong>
      <div class="bar"><span style="width:${Math.max(4, (Number(row[valueKey] || 0) / max) * 100)}%"></span></div>
      <span>${labelKey === 'sales' ? money(row.salesCents) : escapeHtml(row[labelKey])}</span>
    </div>
  `).join('') : '<div class="empty-state">Sin datos.</div>'}</div>`;
}

function simpleTable(rows) {
  return `<div class="table-wrap" style="margin-top:14px"><table class="table"><thead><tr><th>Nombre</th><th>Pedidos</th><th>Ventas</th></tr></thead><tbody>
    ${rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${row.orders}</td><td>${money(row.salesCents)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

async function renderSettings() {
  const data = await api('/api/admin/settings');
  const business = data.business;
  const menuUrl = `${location.origin}/menu`;
  $('#adminBusinessName').textContent = business.name;
  $('#settingsSection').innerHTML = `
    <div class="settings-layout">
      <aside class="settings-rail">
        <div class="settings-preview">
          <img id="settingsLogoPreview" src="${escapeHtml(business.logoUrl || '/api/public/art/logo.svg')}" alt="Logo">
          <div>
            <strong id="settingsNamePreview">${escapeHtml(business.name)}</strong>
            <div class="muted">${business.isOpenManual ? 'Abierto' : 'Horario automatico'}</div>
          </div>
        </div>
        <div class="qr-box"><img src="/qr.svg?data=${encodeURIComponent(menuUrl)}" alt="QR del menu"></div>
        <div>
          <strong>Menu QR</strong>
          <div class="muted">${escapeHtml(menuUrl)}</div>
        </div>
        <div class="actions-row">
          <a class="btn btn--soft btn--small" href="/qr.svg?data=${encodeURIComponent(menuUrl)}" target="_blank" rel="noreferrer">Abrir QR</a>
          <button class="btn btn--ghost btn--small" type="button" id="copyMenuUrl">Copiar enlace</button>
        </div>
      </aside>

      <form class="settings-main" id="settingsForm">
        <section class="settings-block">
          <header>
            <h2>Identidad</h2>
            <span class="badge">${escapeHtml(business.currency)}</span>
          </header>
          <div class="form-grid">
            <label>Nombre del negocio<input class="field" name="name" value="${escapeHtml(business.name)}"></label>
            <label>Logo URL<input class="field" name="logoUrl" value="${escapeHtml(business.logoUrl)}"></label>
            <label class="wide">Direccion<textarea class="textarea" name="address">${escapeHtml(business.address)}</textarea></label>
          </div>
        </section>

        <section class="settings-block">
          <header><h2>Canales</h2></header>
          <div class="form-grid">
            <label>Telefono<input class="field" name="phone" value="${escapeHtml(business.phone)}"></label>
            <label>WhatsApp<input class="field" name="whatsappPhone" value="${escapeHtml(business.whatsappPhone)}"></label>
          </div>
        </section>

        <section class="settings-block">
          <header><h2>Operacion</h2></header>
          <div class="switch-row">
            <div><strong>Estado manual</strong><div class="muted">Abierto / cerrado</div></div>
            <label><input type="checkbox" name="isOpenManual" ${business.isOpenManual ? 'checked' : ''}> Abierto</label>
          </div>
          <div class="switch-row">
            <div><strong>Pedidos fuera de horario</strong><div class="muted">Horario flexible</div></div>
            <label><input type="checkbox" name="allowOrdersOutsideHours" ${business.allowOrdersOutsideHours ? 'checked' : ''}> Permitir</label>
          </div>
          <label style="display:block;margin-top:12px">Mensaje cuando este cerrado<textarea class="textarea" name="closedMessage">${escapeHtml(business.closedMessage)}</textarea></label>
        </section>

        <section class="settings-block">
          <header><h2>Horarios</h2></header>
          <div class="schedule-grid" id="hoursEditor">${renderHoursEditor(business.hours)}</div>
        </section>

        <div class="actions-row">
          <button class="btn btn--brand" type="submit">Guardar configuracion</button>
          <a class="btn btn--ghost" href="/menu" target="_blank" rel="noreferrer">Ver menu</a>
        </div>
      </form>
    </div>
  `;
  $('#settingsForm').elements.name.addEventListener('input', (event) => {
    $('#settingsNamePreview').textContent = event.target.value || business.name;
  });
  $('#settingsForm').elements.logoUrl.addEventListener('input', (event) => {
    $('#settingsLogoPreview').src = event.target.value || '/api/public/art/logo.svg';
  });
  $('#settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      name: form.elements.name.value,
      logoUrl: form.elements.logoUrl.value,
      phone: form.elements.phone.value,
      whatsappPhone: form.elements.whatsappPhone.value,
      address: form.elements.address.value,
      closedMessage: form.elements.closedMessage.value,
      isOpenManual: form.elements.isOpenManual.checked,
      allowOrdersOutsideHours: form.elements.allowOrdersOutsideHours.checked,
      hours: collectHours()
    };
    const result = await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(payload) });
    $('#adminBusinessName').textContent = result.business.name;
    showToast('Configuracion guardada');
  });
  $('#copyMenuUrl').addEventListener('click', async () => {
    await navigator.clipboard.writeText(menuUrl);
    showToast('Enlace copiado');
  });
}

function renderHoursEditor(hours) {
  const byDay = new Map((hours || []).map((item) => [Number(item.day), item]));
  const days = [
    [1, 'Lunes'],
    [2, 'Martes'],
    [3, 'Miercoles'],
    [4, 'Jueves'],
    [5, 'Viernes'],
    [6, 'Sabado'],
    [0, 'Domingo']
  ];
  return days.map(([day, name]) => {
    const item = byDay.get(day) || { day, name, active: false, open: '08:00', close: '20:00' };
    return `
      <div class="schedule-row" data-day="${day}" data-name="${escapeHtml(name)}">
        <strong>${escapeHtml(name)}</strong>
        <label>Apertura<input class="field" type="time" data-open value="${escapeHtml(item.open || '08:00')}"></label>
        <label>Cierre<input class="field" type="time" data-close value="${escapeHtml(item.close || '20:00')}"></label>
        <label><input type="checkbox" data-active ${item.active ? 'checked' : ''}> Activo</label>
      </div>
    `;
  }).join('');
}

function collectHours() {
  return $$('.schedule-row').map((row) => ({
    day: Number(row.dataset.day),
    name: row.dataset.name,
    active: $('[data-active]', row).checked,
    open: $('[data-open]', row).value || '08:00',
    close: $('[data-close]', row).value || '20:00'
  }));
}

async function renderAudit() {
  const [auditData, backupData] = await Promise.all([
    api('/api/admin/audit'),
    api('/api/admin/backups')
  ]);
  $('#auditSection').innerHTML = `
    <div class="page-grid">
      <section class="panel">
        <div class="toolbar">
          <div>
            <h2>Auditoria</h2>
            <p class="muted">Acciones sensibles, accesos y cambios administrativos.</p>
          </div>
          <input class="field" id="auditSearch" style="width:240px" placeholder="Filtrar accion">
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Fecha</th><th>Usuario</th><th>Accion</th><th>Entidad</th><th>IP</th></tr></thead>
            <tbody id="auditRows">${auditRows(auditData.auditLogs)}</tbody>
          </table>
        </div>
      </section>
      <aside class="panel">
        <div class="price-row">
          <h2>Backups</h2>
          <button class="btn btn--brand btn--small" type="button" id="createBackupBtn">Crear backup</button>
        </div>
        <div class="table-wrap" style="margin-top:14px">
          <table class="table">
            <thead><tr><th>Archivo</th><th>Tamano</th><th>Fecha</th></tr></thead>
            <tbody id="backupRows">${backupRows(backupData.backups)}</tbody>
          </table>
        </div>
      </aside>
    </div>
  `;
  $('#auditSearch').addEventListener('input', debounce(async (event) => {
    const data = await api(`/api/admin/audit?action=${encodeURIComponent(event.target.value)}`);
    $('#auditRows').innerHTML = auditRows(data.auditLogs);
  }, 250));
  $('#createBackupBtn').addEventListener('click', async () => {
    const result = await api('/api/admin/backups', { method: 'POST' });
    showToast(`Backup creado: ${result.backup.fileName}`);
    renderAudit();
  });
}

function auditRows(rows) {
  return rows.length ? rows.map((row) => `
    <tr>
      <td>${new Date(row.createdAt).toLocaleString()}</td>
      <td>${escapeHtml(row.userName || 'Sistema')}</td>
      <td><strong>${escapeHtml(row.action)}</strong><div class="muted">${escapeHtml(JSON.stringify(row.details || {}))}</div></td>
      <td>${escapeHtml(row.entityType || '')}${row.entityId ? ` #${escapeHtml(row.entityId)}` : ''}</td>
      <td>${escapeHtml(row.ipAddress || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="5">Sin eventos.</td></tr>';
}

function backupRows(rows) {
  return rows.length ? rows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.fileName)}</strong></td>
      <td>${Math.round(row.bytes / 1024)} KB</td>
      <td>${new Date(row.updatedAt).toLocaleString()}</td>
    </tr>
  `).join('') : '<tr><td colspan="3">Sin backups todavia.</td></tr>';
}

async function renderUsers() {
  const data = await api('/api/admin/users');
  $('#usersSection').innerHTML = `
    <div class="split-view">
      <form class="panel form-grid" id="userForm">
        <h2 class="wide" id="userFormTitle">Nuevo usuario</h2>
        <input type="hidden" name="id">
        <label>Nombre<input class="field" name="name" required></label>
        <label>Email<input class="field" name="email" type="email" required></label>
        <label>Rol<select class="select" name="roleId">${data.roles.map((role) => `<option value="${role.id}">${escapeHtml(role.name)}</option>`).join('')}</select></label>
        <label>Password<input class="field" name="password" type="password" placeholder="Opcional al editar"></label>
        <label><input type="checkbox" name="active" checked> Activo</label>
        <div class="wide actions-row">
          <button class="btn btn--brand" type="submit">Guardar usuario</button>
          <button class="btn btn--ghost" type="button" id="newUserBtn">Nuevo</button>
        </div>
      </form>
      <div class="panel">
        <div class="toolbar">
          <div><h2>Equipo</h2><span class="muted">${data.users.length} usuarios</span></div>
          <input class="field" id="userSearch" style="width:240px" placeholder="Buscar usuario">
        </div>
        <div class="order-list" id="userList">
          ${renderUserCards(data.users)}
        </div>
      </div>
    </div>
  `;
  $('#userForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    const payload = {
      name: form.elements.name.value,
      email: form.elements.email.value,
      roleId: Number(form.elements.roleId.value),
      password: form.elements.password.value,
      active: form.elements.active.checked
    };
    if (!id && !payload.password) {
      showToast('Agrega una contrasena para el nuevo usuario');
      return;
    }
    await api(id ? `/api/admin/users/${id}` : '/api/admin/users', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify({
        ...payload,
        password: payload.password || undefined
      })
    });
    showToast(id ? 'Usuario actualizado' : 'Usuario creado');
    renderUsers();
  });
  $('#newUserBtn').addEventListener('click', resetUserForm);
  $('#userList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-user]');
    if (!button) return;
    const user = data.users.find((item) => item.id === Number(button.dataset.editUser));
    if (user) fillUserForm(user);
  });
  $('#userSearch').addEventListener('input', (event) => {
    const term = event.target.value.toLowerCase();
    $('#userList').innerHTML = renderUserCards(data.users.filter((user) => `${user.name} ${user.email} ${user.roleName}`.toLowerCase().includes(term)));
  });
}

function renderUserCards(users) {
  return users.length ? users.map((user) => `
    <article class="user-card">
      <header>
        <div>
          <strong>${escapeHtml(user.name)}</strong>
          <div class="muted">${escapeHtml(user.email)}</div>
        </div>
        <span class="status-badge ${user.active ? 'status-Listo' : 'status-Cancelado'}">${user.active ? 'Activo' : 'Inactivo'}</span>
      </header>
      <div class="price-row">
        <span>${escapeHtml(user.roleName)}</span>
        <button class="btn btn--soft btn--small" type="button" data-edit-user="${user.id}">Editar</button>
      </div>
    </article>
  `).join('') : '<div class="empty-state">Sin usuarios.</div>';
}

function fillUserForm(user) {
  const form = $('#userForm');
  form.elements.id.value = user.id;
  form.elements.name.value = user.name;
  form.elements.email.value = user.email;
  form.elements.roleId.value = user.roleId;
  form.elements.password.value = '';
  form.elements.active.checked = user.active;
  $('#userFormTitle').textContent = `Editar ${user.name}`;
}

function resetUserForm() {
  const form = $('#userForm');
  form.reset();
  form.elements.id.value = '';
  form.elements.active.checked = true;
  $('#userFormTitle').textContent = 'Nuevo usuario';
}

function printTicket(order) {
  $('#ticketPrint').innerHTML = `
    <div style="text-align:center">
      <strong>Boba Central</strong><br>
      Pedido ${escapeHtml(order.orderNumber)}<br>
      ${new Date(order.createdAt).toLocaleString()}
    </div>
    <hr>
    Cliente: ${escapeHtml(order.customer.name)}<br>
    Tel: ${escapeHtml(order.customer.phone)}<br>
    Entrega: ${escapeHtml(order.deliveryMethod.name)}<br>
    Pago: ${escapeHtml(order.paymentMethod.name)}<br>
    <hr>
    ${order.items.map((item) => `
      ${item.quantity} x ${escapeHtml(item.productName)} ${money(item.lineTotalCents)}<br>
      ${Object.entries(item.variants || {}).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join('<br>')}
      ${(item.extras || []).map((extra) => `<br>+ ${escapeHtml(extra.name)} ${money(extra.priceCents)}`).join('')}
      ${item.notes ? `<br>Nota: ${escapeHtml(item.notes)}` : ''}<br>
    `).join('<br>')}
    <hr>
    Subtotal: ${money(order.subtotalCents)}<br>
    Delivery: ${money(order.deliveryFeeCents)}<br>
    <strong>Total: ${money(order.totalCents)}</strong><br>
    Estado: ${escapeHtml(order.status)}
  `;
  window.print();
}

function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

if (document.body.dataset.page === 'admin-login') initLogin();
if (document.body.dataset.page === 'admin') initAdmin().catch((error) => showToast(error.message));
