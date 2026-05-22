const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
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
  return ['dashboard', 'orders', 'kds', 'products', 'categories', 'reports', 'settings', 'audit', 'users'].includes(key) ? key : 'dashboard';
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
  $('#productsSection').innerHTML = `
    <div class="product-admin-grid">
      <form class="panel form-grid" id="productForm" style="grid-template-columns:1fr">
        <h2 id="productFormTitle">Nuevo producto</h2>
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
        <label>Variantes<textarea class="textarea" name="variants" placeholder="Tamano: 16 oz, 22 oz&#10;Azucar: 0%, 50%, 100%"></textarea></label>
        <div>
          <strong>Extras</strong>
          <div class="checks">${catalog.extras.map((extra) => `<label><input type="checkbox" name="extraIds" value="${extra.id}">${escapeHtml(extra.name)} ${money(extra.priceCents)}</label>`).join('')}</div>
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
      <div class="panel">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Producto</th><th>Categoria</th><th>Precio</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              ${catalog.products.map((product) => `
                <tr>
                  <td><strong>${escapeHtml(product.name)}</strong><div class="muted">${escapeHtml(product.description)}</div></td>
                  <td>${escapeHtml(product.categoryName)}</td>
                  <td>${money(product.basePriceCents)}</td>
                  <td>${product.available ? 'Disponible' : 'Agotado'} · ${product.active ? 'Activo' : 'Inactivo'}</td>
                  <td class="actions-row">
                    <button class="btn btn--soft btn--small" type="button" data-edit-product="${product.id}">Editar</button>
                    <button class="btn btn--danger btn--small" type="button" data-delete-product="${product.id}">Eliminar</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  $('#productForm').addEventListener('submit', saveProductForm);
  $('#uploadImageBtn').addEventListener('click', uploadProductImage);
  $('#newProductBtn').addEventListener('click', resetProductForm);
  $('#productsSection').addEventListener('click', productTableClick, { once: true });
}

async function uploadProductImage() {
  const form = $('#productForm');
  const file = form.imageFile.files[0];
  if (!file) {
    showToast('Selecciona una imagen PNG, JPG o WebP');
    return;
  }
  const payload = new FormData();
  payload.append('image', file);
  try {
    const result = await api('/api/admin/uploads/images', { method: 'POST', body: payload });
    form.imageUrl.value = result.upload.url;
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

function fillProductForm(product) {
  const form = $('#productForm');
  form.elements.id.value = product.id;
  form.categoryId.value = product.categoryId;
  form.name.value = product.name;
  form.price.value = (product.basePriceCents / 100).toFixed(2);
  form.imageUrl.value = product.imageUrl || '';
  form.description.value = product.description || '';
  form.variants.value = variantsToText(product.variants);
  form.featured.checked = product.featured;
  form.active.checked = product.active;
  form.available.checked = product.available;
  $$('input[name="extraIds"]', form).forEach((input) => {
    input.checked = product.extras.some((extra) => extra.id === Number(input.value));
  });
  $('#productFormTitle').textContent = `Editar ${product.name}`;
}

function resetProductForm() {
  $('#productForm').reset();
  $('#productForm').elements.id.value = '';
  $('#productFormTitle').textContent = 'Nuevo producto';
}

async function saveProductForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    categoryId: Number(form.categoryId.value),
    name: form.name.value,
    price: Number(form.price.value),
    imageUrl: form.imageUrl.value,
    description: form.description.value,
    variants: parseVariants(form.variants.value),
    extraIds: $$('input[name="extraIds"]:checked', form).map((input) => Number(input.value)),
    featured: form.featured.checked,
    active: form.active.checked,
    available: form.available.checked
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
  const edit = event.target.closest('[data-edit-product]');
  if (edit) {
    const product = state.catalog.products.find((item) => item.id === Number(edit.dataset.editProduct));
    fillProductForm(product);
  }
  const del = event.target.closest('[data-delete-product]');
  if (del && confirm('Eliminar producto?')) {
    api(`/api/admin/products/${del.dataset.deleteProduct}`, { method: 'DELETE' })
      .then(() => renderProductsAdmin())
      .catch((error) => showToast(error.message));
  }
  $('#productsSection').addEventListener('click', productTableClick, { once: true });
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
      name: form.name.value,
      description: form.description.value,
      sortOrder: Number(form.sortOrder.value),
      active: form.active.checked
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
  $('#categoriesSection').onclick = async (event) => {
    const edit = event.target.closest('[data-edit-category]');
    const del = event.target.closest('[data-delete-category]');
    if (edit) {
      const category = data.categories.find((item) => item.id === Number(edit.dataset.editCategory));
      const form = $('#categoryForm');
      form.elements.id.value = category.id;
      form.name.value = category.name;
      form.description.value = category.description;
      form.sortOrder.value = category.sortOrder;
      form.active.checked = category.active;
    }
    if (del && confirm('Eliminar categoria?')) {
      await api(`/api/admin/categories/${del.dataset.deleteCategory}`, { method: 'DELETE' });
      renderCategoriesAdmin();
    }
  };
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
    <div class="page-grid">
      <form class="panel form-grid" id="settingsForm">
        <label>Nombre<input class="field" name="name" value="${escapeHtml(business.name)}"></label>
        <label>Logo URL<input class="field" name="logoUrl" value="${escapeHtml(business.logoUrl)}"></label>
        <label>Telefono<input class="field" name="phone" value="${escapeHtml(business.phone)}"></label>
        <label>WhatsApp<input class="field" name="whatsappPhone" value="${escapeHtml(business.whatsappPhone)}"></label>
        <label class="wide">Direccion<textarea class="textarea" name="address">${escapeHtml(business.address)}</textarea></label>
        <label class="wide">Mensaje cerrado<textarea class="textarea" name="closedMessage">${escapeHtml(business.closedMessage)}</textarea></label>
        <label><input type="checkbox" name="isOpenManual" ${business.isOpenManual ? 'checked' : ''}> Abierto manualmente</label>
        <label><input type="checkbox" name="allowOrdersOutsideHours" ${business.allowOrdersOutsideHours ? 'checked' : ''}> Permitir fuera de horario</label>
        <label class="wide">Horarios JSON<textarea class="textarea" name="hours" style="min-height:180px">${escapeHtml(JSON.stringify(business.hours, null, 2))}</textarea></label>
        <button class="btn btn--brand wide" type="submit">Guardar configuracion</button>
      </form>
      <aside class="panel">
        <h2>Codigo QR</h2>
        <p class="muted">${escapeHtml(menuUrl)}</p>
        <div class="qr-box"><img src="/qr.svg?data=${encodeURIComponent(menuUrl)}" alt="QR del menu"></div>
        <div class="nav-actions" style="justify-content:flex-start;margin-top:14px">
          <a class="btn btn--soft" href="/qr.svg?data=${encodeURIComponent(menuUrl)}" target="_blank" rel="noreferrer">Abrir QR</a>
          <button class="btn btn--ghost" type="button" id="copyMenuUrl">Copiar enlace</button>
        </div>
      </aside>
    </div>
  `;
  $('#settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    let hours;
    try {
      hours = JSON.parse(form.hours.value || '[]');
    } catch {
      showToast('Horarios JSON invalido');
      return;
    }
    const payload = {
      name: form.name.value,
      logoUrl: form.logoUrl.value,
      phone: form.phone.value,
      whatsappPhone: form.whatsappPhone.value,
      address: form.address.value,
      closedMessage: form.closedMessage.value,
      isOpenManual: form.isOpenManual.checked,
      allowOrdersOutsideHours: form.allowOrdersOutsideHours.checked,
      hours
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
        <label>Nombre<input class="field" name="name" required></label>
        <label>Email<input class="field" name="email" type="email" required></label>
        <label>Rol<select class="select" name="roleId">${data.roles.map((role) => `<option value="${role.id}">${escapeHtml(role.name)}</option>`).join('')}</select></label>
        <label>Password<input class="field" name="password" type="password" required></label>
        <label><input type="checkbox" name="active" checked> Activo</label>
        <button class="btn btn--brand wide" type="submit">Crear usuario</button>
      </form>
      <div class="panel table-wrap">
        <table class="table"><thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th></tr></thead><tbody>
          ${data.users.map((user) => `<tr><td><strong>${escapeHtml(user.name)}</strong><div class="muted">${escapeHtml(user.email)}</div></td><td>${escapeHtml(user.roleName)}</td><td>${user.active ? 'Activo' : 'Inactivo'}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>
  `;
  $('#userForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        name: form.name.value,
        email: form.email.value,
        roleId: Number(form.roleId.value),
        password: form.password.value,
        active: form.active.checked
      })
    });
    showToast('Usuario creado');
    renderUsers();
  });
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
