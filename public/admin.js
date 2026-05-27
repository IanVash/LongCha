const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
const adminPrice = (cents) => `${((Number(cents) || 0) / 100).toFixed(2).replace('.', ',')} US$`;
const statuses = ['Nuevo', 'Aceptado', 'En preparacion', 'Listo', 'En camino', 'Entregado', 'Cancelado'];
const availablePermissions = ['*', 'orders:view', 'orders:update', 'orders:kds', 'orders:update-ready', 'orders:view-assigned', 'orders:update-delivered', 'orders:charge', 'payments:update', 'catalog:view', 'reports:view', 'delivery:view', 'audit:view'];
const ORDER_ALERT_SOUND_URL = '/assets/sounds/new-order-alert.mp3';
const detectedPrintersState = {
  loaded: false,
  printers: [],
  message: ''
};

const DEFAULT_PRINTER_CONFIG = {
  printers: {
    caja: {
      enabled: true,
      name: 'Caja',
      type: 'thermal',
      ticketWidthMm: 80,
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

const state = {
  user: null,
  section: 'dashboard',
  orders: [],
  selectedOrderId: null,
  knownNewOrders: new Set(),
  catalog: null,
  deliveryConfig: null,
  business: null,
  orderEvents: null,
  realtimeConnected: false,
  orderAlert: {
    audio: null,
    active: false
  }
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

function applyAdminBrand(business) {
  if (!business) return;
  state.business = business;
  $('#adminBusinessName').textContent = business.name || 'Long Cha';
  const logo = $('.brand-lockup img');
  if (logo) logo.src = business.logoUrl || '/assets/brand/longcha-mark.png';
}

function applyBusinessStatus(openState) {
  const status = $('#businessStatus');
  if (!status || !openState) return;
  status.classList.toggle('is-open', Boolean(openState.open));
  status.classList.toggle('is-closed', !openState.open);
  $('strong', status).textContent = openState.open ? 'Abierto' : 'Cerrado';
  $('small', status).textContent = openState.message || 'Estado del negocio';
}

async function loadAdminBrand() {
  try {
    const data = await api('/api/public/menu');
    applyAdminBrand(data.business);
    applyBusinessStatus(data.openState);
  } catch {
    /* El panel puede seguir funcionando aunque el branding publico no cargue. */
  }
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
  await loadAdminBrand();
  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/admin/login';
  });
  setupOrderAlertUnlock();

  $('#adminNav').addEventListener('click', (event) => {
    const link = event.target.closest('a[data-section]');
    if (!link) return;
    event.preventDefault();
    history.pushState({}, '', link.href);
    setSection(link.dataset.section);
  });
  window.addEventListener('popstate', () => setSection(sectionFromPath()));
  setSection(sectionFromPath());
  connectAdminEvents();
  setInterval(pollOrders, 30000);
}

function sectionFromPath() {
  const key = location.pathname.replace('/admin/', '').replace('/admin', '') || 'dashboard';
  return ['dashboard', 'orders', 'kds', 'products', 'categories', 'extras', 'inventory', 'promotions', 'delivery', 'reports', 'accounting', 'settings', 'audit', 'users'].includes(key) ? key : 'dashboard';
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
    inventory: ['Inventario', 'Stock, alertas y agotados automaticos'],
    promotions: ['Promociones', 'Cupones, combos y descuentos'],
    delivery: ['Delivery', 'Zonas, costos y repartidores'],
    reports: ['Reportes', 'Ventas y productos'],
    accounting: ['Contabilidad', 'Ingresos, gastos y utilidad'],
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
  if (state.section === 'inventory') return renderInventoryAdmin();
  if (state.section === 'promotions') return renderPromotionsAdmin();
  if (state.section === 'delivery') return renderDeliveryAdmin();
  if (state.section === 'reports') return renderReports();
  if (state.section === 'accounting') return renderAccountingAdmin();
  if (state.section === 'settings') return renderSettings();
  if (state.section === 'audit') return renderAudit();
  if (state.section === 'users') return renderUsers();
}

async function pollOrders() {
  if (state.realtimeConnected) return;
  if (!['dashboard', 'orders', 'kds'].includes(state.section)) return;
  try {
    const data = await api('/api/admin/orders');
    const currentNew = new Set(data.orders.filter((order) => order.status === 'Nuevo').map((order) => order.orderNumber));
    const hasNew = [...currentNew].some((orderNumber) => !state.knownNewOrders.has(orderNumber));
    if (state.knownNewOrders.size && hasNew) {
      showToast('Nuevo pedido recibido');
    }
    syncNewOrderAlert(currentNew);
    if (state.section === 'orders') renderOrders(data.orders);
    if (state.section === 'kds') renderKds();
    if (state.section === 'dashboard') renderDashboard();
  } catch {
    /* polling silencioso */
  }
}

function connectAdminEvents() {
  if (!('EventSource' in window) || state.orderEvents) return;
  state.orderEvents = new EventSource('/api/admin/events');
  state.orderEvents.addEventListener('orders.snapshot', (event) => {
    state.realtimeConnected = true;
    const data = JSON.parse(event.data);
    syncNewOrderAlert(new Set((data.orders || []).filter((order) => order.status === 'Nuevo').map((order) => order.orderNumber)));
  });
  state.orderEvents.addEventListener('order.created', (event) => handleRealtimeOrderEvent(event, true));
  state.orderEvents.addEventListener('order.updated', (event) => handleRealtimeOrderEvent(event, false));
  state.orderEvents.onerror = () => {
    state.realtimeConnected = false;
  };
}

async function handleRealtimeOrderEvent(event, isNewOrder) {
  const data = JSON.parse(event.data);
  const order = data.order;
  if (!order) return;
  const wasKnown = state.knownNewOrders.has(order.orderNumber);
  if (order.status === 'Nuevo') state.knownNewOrders.add(order.orderNumber);
  else state.knownNewOrders.delete(order.orderNumber);
  if (isNewOrder || (order.status === 'Nuevo' && !wasKnown)) {
    showToast('Nuevo pedido recibido');
  } else {
    showToast(`Pedido ${order.orderNumber}: ${order.status}`);
  }
  syncNewOrderAlert(state.knownNewOrders);
  if (['dashboard', 'orders', 'kds'].includes(state.section)) {
    await renderCurrentSection();
  }
}

function setupOrderAlertUnlock() {
  const unlock = () => {
    if (state.orderAlert.active) playOrderAlertAudio();
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

function syncNewOrderAlert(currentNewOrders) {
  state.knownNewOrders = new Set(currentNewOrders || []);
  if (state.knownNewOrders.size) startOrderAlert();
  else stopOrderAlert();
}

function getOrderAlertAudio() {
  if (!state.orderAlert.audio) {
    const audio = new Audio(ORDER_ALERT_SOUND_URL);
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 1;
    state.orderAlert.audio = audio;
  }
  return state.orderAlert.audio;
}

function startOrderAlert() {
  if (state.orderAlert.active) return;
  state.orderAlert.active = true;
  playOrderAlertAudio();
}

function stopOrderAlert() {
  state.orderAlert.active = false;
  const audio = state.orderAlert.audio;
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
}

function playOrderAlertAudio() {
  if (!state.orderAlert.active) return;
  try {
    const audio = getOrderAlertAudio();
    audio.play().catch(() => {
      /* El navegador puede requerir una interaccion antes de reproducir audio. */
    });
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
  if (settings.business) applyAdminBrand(settings.business);
  const recent = ordersData.orders.slice(0, 6);
  const activeOrders = ordersData.orders.filter((order) => !['Entregado', 'Cancelado'].includes(order.status));
  const newOrders = ordersData.orders.filter((order) => order.status === 'Nuevo');
  const readyOrders = ordersData.orders.filter((order) => order.status === 'Listo');
  const openState = settings.options?.openState;
  const business = settings.business || state.business || {};
  applyBusinessStatus(openState);
  syncNewOrderAlert(new Set(ordersData.orders.filter((order) => order.status === 'Nuevo').map((order) => order.orderNumber)));
  $('#dashboardSection').innerHTML = `
    <section class="ops-hero">
      <div>
        <span class="eyebrow">Operacion en vivo</span>
        <h2>${escapeHtml(business.name || 'Long Cha')}</h2>
        <p>${escapeHtml(openState?.message || (openState?.open ? 'Abierto y recibiendo pedidos.' : 'Pedidos pausados por horario o cierre temporal.'))}</p>
      </div>
      <div class="ops-hero__stats">
        <div><span>${activeOrders.length}</span><strong>Activos</strong></div>
        <div><span>${newOrders.length}</span><strong>Nuevos</strong></div>
        <div><span>${readyOrders.length}</span><strong>Listos</strong></div>
      </div>
    </section>
    <div class="metrics metrics--pro">
      ${metric('Ventas hoy', money(reports.today.salesCents), `${reports.today.orders} pedidos`, 'sales')}
      ${metric('Ventas semana', money(reports.week.salesCents), `${reports.week.orders} pedidos`, 'week')}
      ${metric('Ticket promedio', money(reports.all.averageTicketCents), 'Historico', 'ticket')}
      ${metric('Cancelados', reports.cancelledOrders, 'Pedidos', 'danger')}
    </div>
    <div class="dashboard-grid">
      <section class="panel panel--flush">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Recepcion</span>
            <h2>Pedidos recientes</h2>
          </div>
          <a class="btn btn--soft btn--small" href="/admin/orders" data-go="orders">Ver pedidos</a>
        </div>
        <div class="order-list order-list--compact">${recent.length ? recent.map(orderCard).join('') : '<div class="empty-state">Sin pedidos todavia.</div>'}</div>
      </section>
      <aside class="panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Cocina</span>
            <h2>Cola activa</h2>
          </div>
          <span class="badge">${activeOrders.length}</span>
        </div>
        <div class="status-stack">
          ${statusSummary('Nuevo', newOrders.length)}
          ${statusSummary('Aceptado', ordersData.orders.filter((order) => order.status === 'Aceptado').length)}
          ${statusSummary('En preparacion', ordersData.orders.filter((order) => order.status === 'En preparacion').length)}
          ${statusSummary('Listo', readyOrders.length)}
        </div>
      </aside>
    </div>
  `;
  $('[data-go="orders"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    history.pushState({}, '', '/admin/orders');
    setSection('orders');
  });
}

function metric(label, value, detail, tone = '') {
  return `
    <div class="metric ${tone ? `metric--${tone}` : ''}">
      <div class="metric__top"><span>${escapeHtml(label)}</span><i></i></div>
      <strong>${escapeHtml(value)}</strong>
      <span class="muted">${escapeHtml(detail)}</span>
    </div>
  `;
}

function statusSummary(status, count) {
  return `
    <div class="status-summary">
      <span class="${statusClass(status)}">${escapeHtml(status)}</span>
      <strong>${count}</strong>
    </div>
  `;
}

async function renderOrders(existingOrders = null) {
  const section = $('#ordersSection');
  const currentStatus = $('#orderStatusFilter')?.value || 'all';
  const currentSearch = $('#orderSearch')?.value || '';
  state.deliveryConfig = state.deliveryConfig || await api('/api/admin/delivery').catch(() => ({ drivers: [] }));
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
    <div class="orders-board-layout">
      ${ordersKanban(state.orders, currentStatus)}
      <aside class="panel order-detail" id="orderDetail">${selected ? orderDetail(selected) : '<div class="empty-state">Selecciona un pedido.</div>'}</aside>
    </div>
  `;
  $('#ordersSection').addEventListener('click', handleOrdersClick, { once: true });
  $('#orderStatusFilter').addEventListener('change', () => renderOrders());
  $('#orderSearch').addEventListener('input', debounce(() => renderOrders(), 250));
  $('#refreshOrders').addEventListener('click', () => renderOrders());
}

function ordersKanban(orders, currentStatus = 'all') {
  const groups = [
    { title: 'Nuevo', statuses: ['Nuevo'] },
    { title: 'Preparacion', statuses: ['Aceptado', 'En preparacion'] },
    { title: 'Listo', statuses: ['Listo'] },
    { title: 'Delivery / cierre', statuses: ['En camino', 'Entregado'] },
    { title: 'Cancelado', statuses: ['Cancelado'] }
  ];
  const columns = groups.map((group) => ({
    ...group,
    orders: orders.filter((order) => group.statuses.includes(order.status))
  })).filter((group) => group.orders.length || orders.length === 0 || currentStatus === 'all');

  return `
    <div class="orders-kanban">
      ${columns.map((group) => `
        <section class="order-column">
          <header>
            <div>
              <strong>${escapeHtml(group.title)}</strong>
              <span>${group.statuses.map(escapeHtml).join(' / ')}</span>
            </div>
            <b>${group.orders.length}</b>
          </header>
          <div class="order-column-list">
            ${group.orders.length ? group.orders.map(orderCard).join('') : '<div class="empty-state">Sin pedidos.</div>'}
          </div>
        </section>
      `).join('')}
    </div>
  `;
}

function orderCard(order) {
  const isSelected = order.id === state.selectedOrderId;
  return `
    <article class="order-row ${order.status === 'Nuevo' ? 'is-new' : ''} ${isSelected ? 'is-selected' : ''}" data-select-order="${order.id}">
      <header>
        <div>
          <strong>${escapeHtml(order.orderNumber)}</strong>
          <div class="muted">${elapsed(order.createdAt)}</div>
        </div>
        <span class="${statusClass(order.status)}">${escapeHtml(order.status)}</span>
      </header>
      <div class="price-row">
        <span>${escapeHtml(order.customer.name)} · ${escapeHtml(order.deliveryMethod.name)}</span>
        <strong>${money(order.totalCents)}</strong>
      </div>
      <div class="muted">${elapsed(order.createdAt)} · ${order.items.length} lineas${order.tableLabel ? ` · ${escapeHtml(order.tableLabel)}` : ''} · ${escapeHtml(order.paymentStatus || 'Pendiente')}</div>
    </article>
  `;
}

function orderDetail(order) {
  const statusWhatsappUrl = order.whatsappStatusUrl || customerStatusWhatsAppUrl(order);
  const drivers = state.deliveryConfig?.drivers || [];
  const isDelivered = order.status === 'Entregado';
  return `
    <div class="order-detail-head">
      <div>
        <h2>${escapeHtml(order.orderNumber)}</h2>
        <span class="muted">${new Date(order.createdAt).toLocaleString()}</span>
      </div>
      <span class="${statusClass(order.status)}">${escapeHtml(order.status)}</span>
    </div>
    <div class="detail-card">
      <strong>${escapeHtml(order.customer.name)}</strong>
      <div class="muted">${escapeHtml(order.customer.phone)}</div>
      ${order.tableLabel ? `<div class="muted">Mesa: ${escapeHtml(order.tableLabel)}</div>` : ''}
      ${order.customer.address ? `<div class="muted">${escapeHtml(order.customer.address)}</div>` : ''}
      ${order.customer.reference ? `<div class="muted">${escapeHtml(order.customer.reference)}</div>` : ''}
    </div>
    ${isDelivered ? `
      <div class="order-closed-note">
        <strong>Pedido entregado</strong>
        <span>El detalle de productos queda oculto en esta vista. Puedes consultar el historial o reimprimir el ticket si necesitas respaldo.</span>
      </div>
    ` : `
      <div class="cart-lines cart-lines--detail">
        ${order.items.map(orderItemLine).join('')}
      </div>
    `}
    ${order.notes ? `<p><strong>Notas:</strong> ${escapeHtml(order.notes)}</p>` : ''}
    <div class="total-box">
      <div class="price-row"><span>Subtotal</span><span>${money(order.subtotalCents)}</span></div>
      ${order.discountCents ? `<div class="price-row"><span>Descuento ${escapeHtml(order.couponCode || '')}</span><span>-${money(order.discountCents)}</span></div>` : ''}
      <div class="price-row"><span>Delivery</span><span>${money(order.deliveryFeeCents)}</span></div>
      <div class="price-row"><strong>Total</strong><strong>${money(order.totalCents)}</strong></div>
    </div>
    <div class="config-list" style="margin-top:12px">
      <div class="config-item">
        <header><strong>Pago</strong><span class="badge">${escapeHtml(order.paymentStatus || 'Pendiente')}</span></header>
        <div class="actions-row">
          ${['Pendiente', 'Pagado', 'Parcial', 'Reembolsado'].map((status) => `
            <button class="btn btn--small ${order.paymentStatus === status ? 'btn--brand' : 'btn--soft'}" type="button" data-payment-status="${status}" data-order-id="${order.id}">${status}</button>
          `).join('')}
        </div>
        ${order.paymentReference ? `<div class="muted">Ref: ${escapeHtml(order.paymentReference)}</div>` : ''}
      </div>
      ${order.deliveryMethod.slug === 'delivery' ? `
        <div class="config-item">
          <header><strong>Repartidor</strong><span class="muted">${escapeHtml(order.assignedDeliveryUserName || 'Sin asignar')}</span></header>
          <div class="actions-row">
            <select class="select" id="driverSelect-${order.id}" style="max-width:220px">
              <option value="">Sin asignar</option>
              ${drivers.map((driver) => `<option value="${driver.id}" ${order.assignedDeliveryUserId === driver.id ? 'selected' : ''}>${escapeHtml(driver.name)}</option>`).join('')}
            </select>
            <button class="btn btn--soft btn--small" type="button" data-assign-driver="${order.id}">Asignar</button>
          </div>
        </div>
      ` : ''}
      <div class="config-item">
        <header><strong>Tiempo estimado</strong><span>${order.etaMinutes || 0} min</span></header>
      </div>
    </div>
    <div class="actions-row" style="margin-top:12px">
      ${statuses.filter((status) => status !== 'Nuevo' && status !== order.status).map((status) => `
        <button class="btn btn--small ${status === 'Cancelado' ? 'btn--danger' : 'btn--soft'}" type="button" data-status="${status}" data-order-id="${order.id}">${status}</button>
      `).join('')}
      ${statusWhatsappUrl ? `<a class="btn btn--soft btn--small" href="${statusWhatsappUrl}" target="_blank" rel="noreferrer">Enviar WhatsApp</a>` : ''}
      <button class="btn btn--ghost btn--small" type="button" data-print-ticket="${order.id}">Imprimir ticket</button>
      <button class="btn btn--ghost btn--small" type="button" data-print-kitchen="${order.id}">Ticket cocina</button>
    </div>
    <div class="timeline">
      ${order.history.map((entry) => `<div class="timeline__item"><strong>${escapeHtml(entry.status)}</strong><span class="muted">${new Date(entry.createdAt).toLocaleTimeString()}</span></div>`).join('')}
    </div>
  `;
}

function customerStatusWhatsAppUrl(order) {
  const phone = String(order.customer?.phone || '').replace(/\D/g, '');
  if (!phone) return '';
  const statusText = {
    Aceptado: 'fue aceptado y pronto empezaremos a prepararlo.',
    'En preparacion': 'esta en preparacion.',
    Listo: order.deliveryMethod?.slug === 'delivery' ? 'esta listo y pronto saldra a delivery.' : 'esta listo para retirar o entregar en local.',
    'En camino': 'va en camino.',
    Entregado: 'fue entregado. Gracias por tu compra.',
    Cancelado: 'fue cancelado. Si tienes dudas, escribenos.'
  }[order.status] || `cambio a estado: ${order.status}.`;
  const message = `Hola ${order.customer.name}, tu pedido ${order.orderNumber} ${statusText}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function orderItemLine(item) {
  const modifiers = itemModifiers(item, { showPrices: true });
  return `
    <div>
      <div class="price-row"><strong>${item.quantity}x ${escapeHtml(item.productName)}</strong><strong>${money(item.lineTotalCents)}</strong></div>
      ${modifiers.length ? `<div class="order-modifiers">${modifiers.map((modifier) => `<span>${escapeHtml(modifier)}</span>`).join('')}</div>` : ''}
    </div>
  `;
}

function itemModifiers(item, { showPrices = false } = {}) {
  const modifiers = [];
  const groupedExtras = (item.extras || []).filter((extra) => extra.groupName);
  const plainExtras = (item.extras || []).filter((extra) => !extra.groupName);
  const selectedGroupNames = new Set(groupedExtras
    .map((extra) => normalizedModifierName(extra.groupName || ''))
    .filter(Boolean));
  const selectedOptionNames = new Set(groupedExtras
    .map((extra) => normalizedModifierName(extra.name || ''))
    .filter(Boolean));
  Object.entries(item.variants || {}).forEach(([key, value]) => {
    if (value && !selectedGroupNames.has(normalizedModifierName(key))) modifiers.push(`${key}: ${value}`);
  });
  const addExtraModifier = (extra) => {
    const price = showPrices && Number(extra.priceCents || 0) > 0 ? ` +${money(extra.priceCents)}` : '';
    modifiers.push(`${extra.groupName ? `${extra.groupName}: ` : 'Extra: '}${extra.name}${price}`);
  };
  groupedExtras.forEach(addExtraModifier);
  plainExtras
    .filter((extra) => !selectedOptionNames.has(normalizedModifierName(extra.name)))
    .forEach(addExtraModifier);
  if (item.notes) modifiers.push(`Nota: ${item.notes}`);
  return modifiers;
}

function normalizedModifierName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
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
  const paymentButton = event.target.closest('[data-payment-status]');
  if (paymentButton) updatePaymentStatus(Number(paymentButton.dataset.orderId), paymentButton.dataset.paymentStatus);
  const assignButton = event.target.closest('[data-assign-driver]');
  if (assignButton) {
    const orderId = Number(assignButton.dataset.assignDriver);
    const driverId = $(`#driverSelect-${orderId}`)?.value || '';
    updateDriver(orderId, driverId);
  }
  const printButton = event.target.closest('[data-print-ticket]');
  if (printButton) {
    const order = state.orders.find((item) => item.id === Number(printButton.dataset.printTicket));
    if (order) printTicket(order).catch((error) => showToast(error.message));
  }
  const kitchenButton = event.target.closest('[data-print-kitchen]');
  if (kitchenButton) {
    const order = state.orders.find((item) => item.id === Number(kitchenButton.dataset.printKitchen));
    if (order) printKitchenTicket(order).catch((error) => showToast(error.message));
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
    if (result.order.status === 'Nuevo') state.knownNewOrders.add(result.order.orderNumber);
    else state.knownNewOrders.delete(result.order.orderNumber);
    syncNewOrderAlert(state.knownNewOrders);
    state.selectedOrderId = result.order.id;
    await renderCurrentSection();
  } catch (error) {
    showToast(error.message);
  }
}

async function updatePaymentStatus(orderId, paymentStatus) {
  try {
    const result = await api(`/api/admin/orders/${orderId}/payment`, {
      method: 'PATCH',
      body: JSON.stringify({ paymentStatus })
    });
    showToast(`Pago ${result.order.orderNumber}: ${paymentStatus}`);
    state.selectedOrderId = result.order.id;
    await renderCurrentSection();
  } catch (error) {
    showToast(error.message);
  }
}

async function updateDriver(orderId, assignedDeliveryUserId) {
  try {
    const result = await api(`/api/admin/orders/${orderId}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ assignedDeliveryUserId: assignedDeliveryUserId ? Number(assignedDeliveryUserId) : null })
    });
    showToast(`Repartidor actualizado: ${result.order.orderNumber}`);
    state.selectedOrderId = result.order.id;
    await renderCurrentSection();
  } catch (error) {
    showToast(error.message);
  }
}

async function renderKds() {
  const data = await api('/api/admin/orders?kds=1');
  const columns = [
    ['Aceptado', data.orders.filter((order) => order.status === 'Aceptado')],
    ['En preparacion', data.orders.filter((order) => order.status === 'En preparacion')],
    ['Listo', data.orders.filter((order) => order.status === 'Listo')]
  ];
  $('#kdsSection').innerHTML = `
    <div class="kds-board">
      ${columns.map(([status, orders]) => `
        <section class="kds-column">
          <header>
            <h2>${escapeHtml(status)}</h2>
            <span class="badge">${orders.length}</span>
          </header>
          <div class="kds-column-list">
            ${orders.length ? orders.map(kdsCard).join('') : '<div class="empty-state">Sin pedidos.</div>'}
          </div>
        </section>
      `).join('')}
    </div>
  `;
  $('#kdsSection').onclick = (event) => {
    const button = event.target.closest('[data-kds-status]');
    if (button) updateStatus(Number(button.dataset.orderId), button.dataset.kdsStatus);
  };
}

function kdsCard(order) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(order.createdAt).getTime()) / 60000));
  const urgent = minutes >= Number(order.etaMinutes || 20);
  return `
    <article class="kds-card ${urgent ? 'is-urgent' : ''}">
      <header class="price-row">
        <div>
          <strong>${escapeHtml(order.orderNumber)}</strong>
          <div class="muted">${order.tableLabel ? `Mesa ${escapeHtml(order.tableLabel)} · ` : ''}${elapsed(order.createdAt)}</div>
        </div>
        <span class="badge">${minutes} min</span>
      </header>
      <div class="kds-items">${order.items.map(kdsItemLine).join('')}</div>
      ${order.notes ? `<p class="kds-order-note"><strong>Notas generales:</strong> ${escapeHtml(order.notes)}</p>` : ''}
      <div class="actions-row">
        ${order.status !== 'En preparacion' ? `<button class="btn btn--soft btn--small" type="button" data-kds-status="En preparacion" data-order-id="${order.id}">Preparar</button>` : ''}
        ${order.status !== 'Listo' ? `<button class="btn btn--brand btn--small" type="button" data-kds-status="Listo" data-order-id="${order.id}">Listo</button>` : ''}
      </div>
    </article>
  `;
}

function kdsItemLine(item) {
  const modifiers = itemModifiers(item);
  return `
    <div class="kds-item">
      <div class="kds-item__head">
        <strong>${item.quantity}x ${escapeHtml(item.productName)}</strong>
        ${modifiers.length ? `<span>${modifiers.length} opciones</span>` : ''}
      </div>
      ${modifiers.length ? `<div class="kds-modifiers">${modifiers.map((modifier) => `<span>${escapeHtml(modifier)}</span>`).join('')}</div>` : ''}
    </div>
  `;
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
        <section class="product-image-panel">
          <div class="product-image-frame">
            <img id="productImagePreview" src="/assets/brand/longcha-mark.png" alt="Vista previa del producto">
          </div>
          <div class="product-image-copy">
            <span class="eyebrow">Imagen del menu</span>
            <strong>Vista previa antes de guardar</strong>
            <p class="muted">Usa una foto clara, cuadrada o vertical. Formatos permitidos: PNG, JPG y WebP.</p>
            <label>Imagen URL<input class="field" name="imageUrl" placeholder="/api/public/art/taro-milk-tea.svg"></label>
            <label>Subir imagen<input class="field" name="imageFile" type="file" accept="image/png,image/jpeg,image/webp"></label>
            <button class="btn btn--soft" type="button" id="uploadImageBtn">Subir imagen</button>
          </div>
        </section>
        <section class="product-form-section">
          <div class="form-grid">
            <label>Categoria<select class="select" name="categoryId" required>
              ${catalog.categories.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('')}
            </select></label>
            <label>Precio<input class="field" name="price" type="number" min="0" step="0.01" required></label>
            <label class="wide">Nombre<input class="field" name="name" required></label>
            <label class="wide">Descripcion<textarea class="textarea" name="description"></textarea></label>
          </div>
        </section>
        <section class="product-form-section">
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
        </section>
        <div class="variant-builder" id="variantBuilder" hidden></div>
        <section class="product-form-section">
          <strong>Extras</strong>
          <div class="checks">${catalog.extras.map((extra) => `<label><input type="checkbox" name="extraIds" value="${extra.id}">${escapeHtml(extra.name)} ${money(extra.priceCents)}${extra.active ? '' : ' (inactivo)'}</label>`).join('')}</div>
        </section>
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
  const productForm = $('#productForm');
  productForm.addEventListener('submit', saveProductForm);
  productForm.elements.imageUrl.addEventListener('input', updateProductImagePreview);
  productForm.elements.imageFile.addEventListener('change', previewSelectedProductImage);
  $('#uploadImageBtn').addEventListener('click', uploadProductImage);
  $('#goOptionalGroupsBtn').addEventListener('click', () => {
    history.pushState({}, '', '/admin/extras');
    setSection('extras');
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
  const image = product.imageUrl || '/assets/brand/longcha-mark.png';
  const searchText = [product.name, product.description, product.categoryName].join(' ').toLowerCase();
  const optionCount = (product.extras || []).length + (product.optionalGroups || []).length;
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
          <button class="btn btn--danger btn--small" type="button" data-delete-product="${product.id}">Eliminar</button>
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
    updateProductImagePreview();
    showToast('Imagen subida');
  } catch (error) {
    showToast(error.message);
  }
}

function updateProductImagePreview() {
  const form = $('#productForm');
  const preview = $('#productImagePreview');
  if (!form || !preview) return;
  preview.src = form.elements.imageUrl.value || '/assets/brand/longcha-mark.png';
}

function previewSelectedProductImage() {
  const form = $('#productForm');
  const preview = $('#productImagePreview');
  const file = form?.elements.imageFile.files[0];
  if (!file || !preview) {
    updateProductImagePreview();
    return;
  }
  preview.src = URL.createObjectURL(file);
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
  renderVariantRows([]);
  updateProductImagePreview();
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
  updateProductImagePreview();
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
    variants: [],
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
    $('#goOptionalGroupsBtn').scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  if (del && confirm('Eliminar producto? El historial de pedidos se conservara.')) {
    api(`/api/admin/products/${del.dataset.deleteProduct}`, { method: 'DELETE' })
      .then(() => {
        showToast('Producto eliminado');
        renderProductsAdmin();
      })
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
    variants: [],
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
    if (del && confirm('Eliminar categoria? Tambien se eliminaran sus productos del catalogo y se conservara el historial de pedidos.')) {
      try {
        await api(`/api/admin/categories/${del.dataset.deleteCategory}`, { method: 'DELETE' });
        showToast('Categoria eliminada');
        renderCategoriesAdmin();
      } catch (error) {
        showToast(error.message);
      }
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
      try {
        await api(`/api/admin/optional-groups/${deleteGroup.dataset.deleteGroup}`, { method: 'DELETE' });
        sessionStorage.removeItem('selectedOptionalGroupId');
        showToast('Grupo eliminado');
        renderExtrasAdmin();
      } catch (error) {
        showToast(error.message);
      }
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
      try {
        await api(`/api/admin/optional-options/${deleteOption.dataset.deleteOption}`, { method: 'DELETE' });
        showToast('Opcional eliminado');
        renderExtrasAdmin();
      } catch (error) {
        showToast(error.message);
      }
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

async function renderInventoryAdmin() {
  const data = await api('/api/admin/inventory');
  const selectedRecipeProductId = Number(sessionStorage.getItem('recipeProductId')) || data.products[0]?.id || 0;
  $('#inventorySection').innerHTML = `
    <div class="metrics metrics--pro">
      ${metric('Productos', data.products.length, 'Menu con control', 'sales')}
      ${metric('Insumos', data.items.length, 'Ingredientes y materiales', 'week')}
      ${metric('Alertas bajas', data.items.filter((item) => item.lowStock).length, 'Revisar stock', 'danger')}
      ${metric('Recetas', new Set(data.recipes.map((item) => item.productId)).size, 'Productos vinculados', 'ticket')}
    </div>
    <div class="inventory-layout">
      <section class="panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Stock por producto</span>
            <h2>Disponibilidad del menu</h2>
          </div>
          <input class="field" id="inventorySearch" style="max-width:260px" placeholder="Buscar producto">
        </div>
        <div class="config-list" id="inventoryList">
          ${inventoryRows(data.products)}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Insumos</span>
            <h2>Ingredientes y materiales</h2>
          </div>
        </div>
        <form class="inventory-item-form" id="inventoryItemForm">
          <input type="hidden" name="id">
          <div class="form-grid">
            <label class="wide">Nombre<input class="field" name="name" placeholder="Leche, tapioca, vaso..." required></label>
            <label>Unidad<input class="field" name="unit" placeholder="litro, porcion, unidad" value="unidad"></label>
            <label>Costo unitario<input class="field" name="cost" type="number" min="0" step="0.01" value="0"></label>
            <label>Stock<input class="field" name="stockQuantity" type="number" min="0" step="0.01" value="0"></label>
            <label>Alerta bajo<input class="field" name="lowStockThreshold" type="number" min="0" step="0.01" value="0"></label>
            <label><input type="checkbox" name="active" checked> Activo</label>
          </div>
          <div class="actions-row">
            <button class="btn btn--brand btn--small" type="submit">Guardar insumo</button>
            <button class="btn btn--ghost btn--small" type="button" id="newInventoryItemBtn">Nuevo</button>
          </div>
        </form>
        <div class="inventory-items-list" id="inventoryItemList">
          ${inventoryItemCards(data.items)}
        </div>
      </section>

      <section class="panel inventory-recipe-panel">
        ${recipeEditor(data.products, data.items, data.recipes, selectedRecipeProductId)}
      </section>
    </div>
  `;
  $('#inventorySearch').addEventListener('input', (event) => {
    const term = event.target.value.toLowerCase();
    $('#inventoryList').innerHTML = inventoryRows(data.products.filter((product) => `${product.name} ${product.categoryName}`.toLowerCase().includes(term)));
  });
  $('#inventoryList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-save-inventory]');
    if (!button) return;
    const productId = Number(button.dataset.saveInventory);
    const row = button.closest('[data-inventory-row]');
    await api(`/api/admin/inventory/products/${productId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        stockEnabled: $('[data-stock-enabled]', row).checked,
        stockQuantity: Number($('[data-stock-quantity]', row).value || 0),
        lowStockThreshold: Number($('[data-stock-threshold]', row).value || 0),
        available: $('[data-stock-available]', row).checked
      })
    });
    showToast('Inventario actualizado');
    renderInventoryAdmin();
  });
  $('#inventoryItemForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    await api(id ? `/api/admin/inventory/items/${id}` : '/api/admin/inventory/items', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify({
        name: form.elements.name.value,
        unit: form.elements.unit.value,
        cost: Number(form.elements.cost.value || 0),
        stockQuantity: Number(form.elements.stockQuantity.value || 0),
        lowStockThreshold: Number(form.elements.lowStockThreshold.value || 0),
        active: form.elements.active.checked
      })
    });
    showToast('Insumo guardado');
    renderInventoryAdmin();
  });
  $('#newInventoryItemBtn').addEventListener('click', () => $('#inventoryItemForm').reset());
  $('#inventoryItemList').addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit-inventory-item]');
    const del = event.target.closest('[data-delete-inventory-item]');
    if (edit) {
      const item = data.items.find((entry) => entry.id === Number(edit.dataset.editInventoryItem));
      fillInventoryItemForm(item);
    }
    if (del && confirm('Eliminar insumo? Tambien se quitara de las recetas vinculadas.')) {
      await api(`/api/admin/inventory/items/${del.dataset.deleteInventoryItem}`, { method: 'DELETE' });
      showToast('Insumo eliminado');
      renderInventoryAdmin();
    }
  });
  $('#recipeProductSelect')?.addEventListener('change', (event) => {
    sessionStorage.setItem('recipeProductId', event.target.value);
    renderInventoryAdmin();
  });
  $('#saveRecipeBtn')?.addEventListener('click', async () => {
    const productId = Number($('#recipeProductSelect')?.value || 0);
    const items = $$('[data-recipe-item]').map((row) => ({
      inventoryItemId: Number(row.dataset.recipeItem),
      quantity: Number($('[data-recipe-quantity]', row).value || 0),
      selected: $('[data-recipe-selected]', row).checked
    })).filter((item) => item.selected && item.quantity > 0)
      .map(({ inventoryItemId, quantity }) => ({ inventoryItemId, quantity }));
    await api(`/api/admin/inventory/products/${productId}/recipe`, {
      method: 'PATCH',
      body: JSON.stringify({ items })
    });
    showToast('Receta actualizada');
    renderInventoryAdmin();
  });
}

function inventoryRows(products) {
  return products.length ? products.map((product) => `
    <article class="config-item" data-inventory-row>
      <header>
        <div>
          <strong>${escapeHtml(product.name)}</strong>
          <div class="muted">${escapeHtml(product.categoryName)} · ${product.stockEnabled ? `${product.stockQuantity} unidades` : 'Sin control de stock'}</div>
        </div>
        <span class="status-badge ${product.lowStock ? 'status-Cancelado' : product.available ? 'status-Listo' : 'status-Nuevo'}">
          ${product.lowStock ? 'Bajo' : product.available ? 'Disponible' : 'Agotado'}
        </span>
      </header>
      <div class="form-grid">
        <label><input type="checkbox" data-stock-enabled ${product.stockEnabled ? 'checked' : ''}> Controlar stock</label>
        <label><input type="checkbox" data-stock-available ${product.available ? 'checked' : ''}> Disponible</label>
        <label>Stock<input class="field" type="number" min="0" data-stock-quantity value="${product.stockQuantity}"></label>
        <label>Alerta bajo<input class="field" type="number" min="0" data-stock-threshold value="${product.lowStockThreshold}"></label>
      </div>
      <button class="btn btn--soft btn--small" type="button" data-save-inventory="${product.id}">Guardar stock</button>
    </article>
  `).join('') : '<div class="empty-state">Sin productos.</div>';
}

function inventoryItemCards(items) {
  return items.length ? items.map((item) => `
    <article class="inventory-item-card ${item.active ? '' : 'is-inactive'}">
      <header>
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <div class="muted">${item.stockQuantity} ${escapeHtml(item.unit)} disponibles</div>
        </div>
        <span class="status-badge ${item.lowStock ? 'status-Cancelado' : item.active ? 'status-Listo' : 'status-Nuevo'}">
          ${item.lowStock ? 'Bajo' : item.active ? 'Activo' : 'Inactivo'}
        </span>
      </header>
      <div class="price-row"><span>Costo unitario</span><strong>${money(item.costCents)}</strong></div>
      <div class="price-row"><span>Alerta</span><span>${item.lowStockThreshold} ${escapeHtml(item.unit)}</span></div>
      <div class="actions-row">
        <button class="btn btn--soft btn--small" type="button" data-edit-inventory-item="${item.id}">Editar</button>
        <button class="btn btn--ghost btn--small" type="button" data-delete-inventory-item="${item.id}">Eliminar</button>
      </div>
    </article>
  `).join('') : '<div class="empty-state">Agrega leche, vasos, toppings, cafe u otros insumos.</div>';
}

function fillInventoryItemForm(item) {
  if (!item) return;
  const form = $('#inventoryItemForm');
  form.elements.id.value = item.id;
  form.elements.name.value = item.name;
  form.elements.unit.value = item.unit;
  form.elements.cost.value = (item.costCents / 100).toFixed(2);
  form.elements.stockQuantity.value = item.stockQuantity;
  form.elements.lowStockThreshold.value = item.lowStockThreshold;
  form.elements.active.checked = item.active;
}

function recipeEditor(products, items, recipes, selectedProductId) {
  if (!products.length) return '<div class="empty-state">Crea productos para configurar recetas.</div>';
  if (!items.length) return '<div class="empty-state">Crea insumos para vincularlos a tus productos.</div>';
  const productId = products.some((product) => product.id === Number(selectedProductId)) ? Number(selectedProductId) : products[0].id;
  const linked = new Map(recipes.filter((recipe) => recipe.productId === productId).map((recipe) => [recipe.inventoryItemId, recipe]));
  return `
    <div class="panel-head">
      <div>
        <span class="eyebrow">Receta por producto</span>
        <h2>Insumos que se descuentan</h2>
      </div>
      <button class="btn btn--brand btn--small" type="button" id="saveRecipeBtn">Guardar receta</button>
    </div>
    <label>Producto
      <select class="select" id="recipeProductSelect">
        ${products.map((product) => `<option value="${product.id}" ${product.id === productId ? 'selected' : ''}>${escapeHtml(product.name)}</option>`).join('')}
      </select>
    </label>
    <div class="recipe-grid">
      ${items.map((item) => {
        const recipe = linked.get(item.id);
        return `
          <label class="recipe-row" data-recipe-item="${item.id}">
            <input type="checkbox" data-recipe-selected ${recipe ? 'checked' : ''}>
            <span>
              <strong>${escapeHtml(item.name)}</strong>
              <small>${item.stockQuantity} ${escapeHtml(item.unit)} en stock</small>
            </span>
            <input class="field" type="number" min="0" step="0.01" data-recipe-quantity value="${recipe?.quantity || 1}">
            <em>${escapeHtml(item.unit)}</em>
          </label>
        `;
      }).join('')}
    </div>
  `;
}

async function renderPromotionsAdmin() {
  const data = await api('/api/admin/promotions');
  $('#promotionsSection').innerHTML = `
    <div class="split-view">
      <form class="panel form-grid" id="promotionForm">
        <h2 class="wide" id="promotionFormTitle">Nueva promocion</h2>
        <input type="hidden" name="id">
        <label>Nombre<input class="field" name="name" required></label>
        <label>Codigo<input class="field" name="code" placeholder="LONGCHA10"></label>
        <label>Tipo<select class="select" name="discountType"><option value="percent">Porcentaje</option><option value="fixed">Monto fijo</option></select></label>
        <label>Descuento<input class="field" name="discountValue" type="number" min="0" step="0.01"></label>
        <label>Compra minima<input class="field" name="minOrder" type="number" min="0" step="0.01" value="0"></label>
        <label>Tope descuento<input class="field" name="maxDiscount" type="number" min="0" step="0.01" value="0"></label>
        <label>Inicio<input class="field" name="startsAt" type="datetime-local"></label>
        <label>Fin<input class="field" name="endsAt" type="datetime-local"></label>
        <label class="wide">Descripcion<textarea class="textarea" name="description"></textarea></label>
        <label><input type="checkbox" name="active" checked> Activa</label>
        <div class="wide actions-row">
          <button class="btn btn--brand" type="submit">Guardar promocion</button>
          <button class="btn btn--ghost" type="button" id="newPromotionBtn">Nueva</button>
        </div>
      </form>
      <div class="panel">
        <div class="toolbar"><h2>Cupones y promos</h2><span class="muted">${data.promotions.length} configuradas</span></div>
        <div class="config-list" id="promotionList">${promotionCards(data.promotions)}</div>
      </div>
    </div>
  `;
  $('#promotionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    const payload = {
      name: form.elements.name.value,
      code: form.elements.code.value,
      discountType: form.elements.discountType.value,
      discountValue: Number(form.elements.discountValue.value || 0),
      minOrder: Number(form.elements.minOrder.value || 0),
      maxDiscount: Number(form.elements.maxDiscount.value || 0),
      startsAt: form.elements.startsAt.value,
      endsAt: form.elements.endsAt.value,
      description: form.elements.description.value,
      active: form.elements.active.checked
    };
    await api(id ? `/api/admin/promotions/${id}` : '/api/admin/promotions', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    showToast('Promocion guardada');
    renderPromotionsAdmin();
  });
  $('#newPromotionBtn').addEventListener('click', () => $('#promotionForm').reset());
  $('#promotionList').addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit-promotion]');
    const del = event.target.closest('[data-delete-promotion]');
    if (edit) fillPromotionForm(data.promotions.find((promo) => promo.id === Number(edit.dataset.editPromotion)));
    if (del && confirm('Eliminar promocion?')) {
      await api(`/api/admin/promotions/${del.dataset.deletePromotion}`, { method: 'DELETE' });
      renderPromotionsAdmin();
    }
  });
}

function promotionCards(promotions) {
  return promotions.length ? promotions.map((promo) => `
    <article class="config-item">
      <header>
        <div><strong>${escapeHtml(promo.name)}</strong><div class="muted">${escapeHtml(promo.code || 'Sin codigo')} · ${promo.discountType === 'fixed' ? money(promo.discountValue) : `${promo.discountValue}%`}</div></div>
        <span class="status-badge ${promo.active ? 'status-Listo' : 'status-Cancelado'}">${promo.active ? 'Activa' : 'Inactiva'}</span>
      </header>
      <p class="muted">${escapeHtml(promo.description || '')}</p>
      <div class="actions-row">
        <button class="btn btn--soft btn--small" type="button" data-edit-promotion="${promo.id}">Editar</button>
        <button class="btn btn--ghost btn--small" type="button" data-delete-promotion="${promo.id}">Eliminar</button>
      </div>
    </article>
  `).join('') : '<div class="empty-state">Sin promociones.</div>';
}

function fillPromotionForm(promo) {
  if (!promo) return;
  const form = $('#promotionForm');
  form.elements.id.value = promo.id;
  form.elements.name.value = promo.name;
  form.elements.code.value = promo.code;
  form.elements.discountType.value = promo.discountType;
  form.elements.discountValue.value = promo.discountType === 'fixed' ? (promo.discountValue / 100).toFixed(2) : promo.discountValue;
  form.elements.minOrder.value = (promo.minOrderCents / 100).toFixed(2);
  form.elements.maxDiscount.value = (promo.maxDiscountCents / 100).toFixed(2);
  form.elements.startsAt.value = promo.startsAt ? promo.startsAt.slice(0, 16) : '';
  form.elements.endsAt.value = promo.endsAt ? promo.endsAt.slice(0, 16) : '';
  form.elements.description.value = promo.description || '';
  form.elements.active.checked = promo.active;
  $('#promotionFormTitle').textContent = `Editar ${promo.name}`;
}

async function renderDeliveryAdmin() {
  const data = await api('/api/admin/delivery');
  $('#deliverySection').innerHTML = `
    <div class="page-grid">
      <section class="panel">
        <h2>Metodos de entrega</h2>
        <div class="config-list" style="margin-top:14px">${data.methods.map((method) => `
          <article class="config-item" data-method-row="${method.id}">
            <header><strong>${escapeHtml(method.name)}</strong><span>${escapeHtml(method.slug)}</span></header>
            <div class="actions-row">
              <label><input type="checkbox" data-method-active ${method.active ? 'checked' : ''}> Activo</label>
              <label><input type="checkbox" data-method-address ${method.requiresAddress ? 'checked' : ''}> Solicita direccion</label>
              <button class="btn btn--soft btn--small" type="button" data-save-method="${method.id}">Guardar</button>
            </div>
          </article>
        `).join('')}</div>
      </section>
      <section class="panel">
        <h2>Zonas de delivery</h2>
        <form class="form-grid" id="deliveryZoneForm" style="margin-top:14px">
          <input type="hidden" name="id">
          <label>Zona<input class="field" name="name" required></label>
          <label>Costo<input class="field" name="fee" type="number" min="0" step="0.01"></label>
          <label>Pedido minimo<input class="field" name="minimumOrder" type="number" min="0" step="0.01"></label>
          <label><input type="checkbox" name="active" checked> Activa</label>
          <button class="btn btn--brand" type="submit">Guardar zona</button>
        </form>
        <div class="config-list" id="deliveryZoneList" style="margin-top:14px">${deliveryZoneCards(data.zones)}</div>
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <h2>Repartidores</h2>
      <div class="order-list" style="margin-top:14px">${data.drivers.map((driver) => `<article class="user-card"><strong>${escapeHtml(driver.name)}</strong><span class="muted">${escapeHtml(driver.email)} · ${escapeHtml(driver.roleName)}</span></article>`).join('') || '<div class="empty-state">Crea usuarios con rol Repartidor.</div>'}</div>
    </section>
  `;
  $('#deliverySection').addEventListener('click', async (event) => {
    const saveMethod = event.target.closest('[data-save-method]');
    const editZone = event.target.closest('[data-edit-zone]');
    if (saveMethod) {
      const row = saveMethod.closest('[data-method-row]');
      await api(`/api/admin/delivery/methods/${saveMethod.dataset.saveMethod}`, {
        method: 'PATCH',
        body: JSON.stringify({
          active: $('[data-method-active]', row).checked,
          requiresAddress: $('[data-method-address]', row).checked
        })
      });
      showToast('Metodo actualizado');
      renderDeliveryAdmin();
    }
    if (editZone) {
      const zone = data.zones.find((item) => item.id === Number(editZone.dataset.editZone));
      const form = $('#deliveryZoneForm');
      form.elements.id.value = zone.id;
      form.elements.name.value = zone.name;
      form.elements.fee.value = (zone.feeCents / 100).toFixed(2);
      form.elements.minimumOrder.value = (zone.minimumOrderCents / 100).toFixed(2);
      form.elements.active.checked = zone.active;
    }
  });
  $('#deliveryZoneForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    await api(id ? `/api/admin/delivery/zones/${id}` : '/api/admin/delivery/zones', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify({
        name: form.elements.name.value,
        fee: Number(form.elements.fee.value || 0),
        minimumOrder: Number(form.elements.minimumOrder.value || 0),
        active: form.elements.active.checked
      })
    });
    showToast('Zona guardada');
    renderDeliveryAdmin();
  });
}

function deliveryZoneCards(zones) {
  return zones.length ? zones.map((zone) => `
    <article class="config-item">
      <header><strong>${escapeHtml(zone.name)}</strong><span class="status-badge ${zone.active ? 'status-Listo' : 'status-Cancelado'}">${zone.active ? 'Activa' : 'Inactiva'}</span></header>
      <div class="price-row"><span>Costo</span><strong>${money(zone.feeCents)}</strong></div>
      <div class="price-row"><span>Minimo</span><span>${money(zone.minimumOrderCents)}</span></div>
      <button class="btn btn--soft btn--small" type="button" data-edit-zone="${zone.id}">Editar</button>
    </article>
  `).join('') : '<div class="empty-state">Sin zonas.</div>';
}

async function renderReports() {
  const reports = await api('/api/admin/reports');
  $('#reportsSection').innerHTML = `
    <div class="metrics metrics--pro">
      ${metric('Hoy', money(reports.today.salesCents), `${reports.today.orders} pedidos`, 'sales')}
      ${metric('Semana', money(reports.week.salesCents), `${reports.week.orders} pedidos`, 'week')}
      ${metric('Mes', money(reports.month.salesCents), `${reports.month.orders} pedidos`, 'ticket')}
      ${metric('Promedio', money(reports.all.averageTicketCents), 'Por pedido')}
    </div>
    <div class="reports-grid">
      <section class="panel report-card report-card--wide">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Tendencia</span>
            <h2>Ventas por dia</h2>
          </div>
          <span class="badge">${money(reports.week.salesCents)}</span>
        </div>
        ${barChart(reports.byDay, 'salesCents', 'sales')}
      </section>
      <section class="panel report-card">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Pago</span>
            <h2>Metodos</h2>
          </div>
        </div>
        ${donutChart(reports.byPayment)}
      </section>
      <section class="panel report-card">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Ranking</span>
            <h2>Productos top</h2>
          </div>
        </div>
        ${barChart(reports.topProducts, 'quantity', 'quantity')}
      </section>
      <section class="panel report-card">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Demanda</span>
            <h2>Ventas por hora</h2>
          </div>
        </div>
        ${barChart(reports.byHour, 'salesCents', 'sales')}
      </section>
      <section class="panel report-card">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Menu</span>
            <h2>Categorias</h2>
          </div>
        </div>
        ${barChart(reports.byCategory, 'salesCents', 'sales')}
      </section>
    </div>
    <div class="page-grid">
      <section class="panel"><h2>Metodo de entrega</h2>${simpleTable(reports.byDelivery)}</section>
      <section class="panel"><h2>Reporte por cajero/usuario</h2>${simpleTable(reports.byCashier)}</section>
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

function donutChart(rows) {
  const colors = ['#159a75', '#2f7ca8', '#f3b536', '#ee5d3f', '#6d5bd0'];
  const total = rows.reduce((sum, row) => sum + Number(row.salesCents || 0), 0);
  if (!rows.length || !total) return '<div class="empty-state">Sin datos.</div>';
  let start = 0;
  const segments = rows.map((row, index) => {
    const end = start + (Number(row.salesCents || 0) / total) * 360;
    const segment = `${colors[index % colors.length]} ${start}deg ${end}deg`;
    start = end;
    return segment;
  }).join(', ');
  return `
    <div class="donut-wrap">
      <div class="donut" style="background: conic-gradient(${segments})"><span>${money(total)}</span></div>
      <div class="donut-list">
        ${rows.map((row, index) => `
          <div><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(row.name)}</span><strong>${money(row.salesCents)}</strong></div>
        `).join('')}
      </div>
    </div>
  `;
}

function simpleTable(rows) {
  return `<div class="table-wrap" style="margin-top:14px"><table class="table"><thead><tr><th>Nombre</th><th>Pedidos</th><th>Ventas</th></tr></thead><tbody>
    ${rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${row.orders}</td><td>${money(row.salesCents)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

async function renderAccountingAdmin() {
  const data = await api('/api/admin/accounting');
  const summary = data.summary;
  const today = data.cashContext?.businessDate || new Date().toISOString().slice(0, 10);
  $('#accountingSection').innerHTML = `
    <div class="metrics metrics--pro">
      ${metric('Ventas mes', money(summary.monthSalesCents), 'Pedidos no cancelados', 'sales')}
      ${metric('Costo receta', money(summary.monthCogsCents), 'Ingredientes vendidos', 'week')}
      ${metric('Utilidad bruta', money(summary.grossProfitCents), 'Antes de gastos', 'ticket')}
      ${metric('Utilidad estimada', money(summary.netCents), 'Despues de gastos y merma', 'danger')}
    </div>

    <div class="accounting-pro-layout">
      <section class="panel cash-close-panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Caja diaria</span>
            <h2>Cierre de turno</h2>
          </div>
          <span class="badge">${escapeHtml(today)}</span>
        </div>
        <div class="cash-summary-grid">
          ${cashSummaryItem('Efectivo ventas', data.cashContext.cashSalesCents)}
          ${cashSummaryItem('Tarjeta', data.cashContext.cardSalesCents)}
          ${cashSummaryItem('Transferencia', data.cashContext.transferSalesCents)}
          ${cashSummaryItem('Delivery', data.cashContext.deliverySalesCents)}
          ${cashSummaryItem('Ingresos efectivo', data.cashContext.manualCashIncomeCents)}
          ${cashSummaryItem('Gastos efectivo', data.cashContext.cashExpenseCents)}
        </div>
        <form class="form-grid" id="cashClosingForm">
          <label>Fecha<input class="field" name="businessDate" type="date" value="${escapeHtml(today)}"></label>
          <label>Fondo inicial<input class="field" name="openingCash" type="number" min="0" step="0.01" value="0"></label>
          <label>Efectivo contado<input class="field" name="countedCash" type="number" min="0" step="0.01" required></label>
          <label>Retiros de caja<input class="field" name="withdrawals" type="number" min="0" step="0.01" value="0"></label>
          <label class="wide">Notas<textarea class="textarea" name="notes" placeholder="Diferencias, retiros, observaciones del turno"></textarea></label>
          <div class="wide actions-row">
            <button class="btn btn--brand" type="submit">Cerrar caja</button>
          </div>
        </form>
        ${cashClosingsTable(data.cashClosings)}
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Compras</span>
            <h2>Proveedor e inventario</h2>
          </div>
          <button class="btn btn--soft btn--small" type="button" id="addPurchaseLineBtn">Agregar insumo</button>
        </div>
        <form class="supplier-purchase-form" id="supplierPurchaseForm">
          <div class="form-grid">
            <label>Proveedor<input class="field" name="supplierName" placeholder="Distribuidora, mercado, proveedor..." required></label>
            <label>Factura<input class="field" name="invoiceNumber" placeholder="Opcional"></label>
            <label>Fecha<input class="field" name="purchaseDate" type="date" value="${escapeHtml(today)}"></label>
            <label>Metodo<input class="field" name="paymentMethod" placeholder="Efectivo, transferencia, tarjeta"></label>
            <label class="wide">Notas<textarea class="textarea" name="notes"></textarea></label>
          </div>
          <div class="purchase-lines" id="purchaseLines">
            ${purchaseLine(data.inventoryItems)}
          </div>
          <div class="actions-row">
            <button class="btn btn--brand btn--small" type="submit">Guardar compra</button>
          </div>
        </form>
        ${purchasesTable(data.purchases)}
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Merma</span>
            <h2>Desperdicio y reposiciones</h2>
          </div>
        </div>
        <form class="form-grid" id="wasteForm">
          <label>Insumo<select class="select" name="inventoryItemId" required>${inventoryOptions(data.inventoryItems)}</select></label>
          <label>Producto relacionado<select class="select" name="productId"><option value="">Ninguno</option>${productOptions(data.products)}</select></label>
          <label>Cantidad<input class="field" name="quantity" type="number" min="0" step="0.01" required></label>
          <label>Motivo<select class="select" name="reason">
            <option>Tapioca vencida</option>
            <option>Bebida mal preparada</option>
            <option>Reposicion a cliente</option>
            <option>Producto vencido</option>
            <option>Derrame o accidente</option>
            <option>Merma operativa</option>
          </select></label>
          <label class="wide">Notas<textarea class="textarea" name="notes"></textarea></label>
          <div class="wide actions-row">
            <button class="btn btn--brand" type="submit">Registrar merma</button>
          </div>
        </form>
        ${wasteTable(data.wasteLogs)}
      </section>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Rentabilidad bubble tea</span>
          <h2>Costeo por receta</h2>
        </div>
        <span class="badge">${money(summary.monthWasteCents)} merma mes</span>
      </div>
      ${productCostingTable(data.productCosting)}
    </section>

    <div class="accounting-layout">
      <section class="panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Movimientos</span>
            <h2>Ingreso o gasto manual</h2>
          </div>
        </div>
        <form class="form-grid" id="accountingForm">
          <label>Tipo<select class="select" name="type">
            <option value="expense">Gasto</option>
            <option value="income">Ingreso</option>
          </select></label>
          <label>Monto<input class="field" name="amount" type="number" min="0" step="0.01" required></label>
          <label>Categoria<input class="field" name="category" placeholder="Renta, nomina, compra de insumos..." required></label>
          <label>Metodo<input class="field" name="paymentMethod" placeholder="Efectivo, transferencia, tarjeta"></label>
          <label class="wide">Descripcion<textarea class="textarea" name="description" placeholder="Detalle interno del movimiento"></textarea></label>
          <label>Fecha<input class="field" name="entryDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
          <div class="wide actions-row">
            <button class="btn btn--brand" type="submit">Guardar movimiento</button>
          </div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Resumen</span>
            <h2>Categorias</h2>
          </div>
        </div>
        ${accountingCategoryRows(data.byCategory)}
      </section>
    </div>
    <section class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Historial</span>
          <h2>Movimientos recientes</h2>
        </div>
      </div>
      ${accountingEntriesTable(data.entries)}
    </section>
  `;
  $('#accountingForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await api('/api/admin/accounting/entries', {
      method: 'POST',
      body: JSON.stringify({
        type: form.elements.type.value,
        amount: Number(form.elements.amount.value || 0),
        category: form.elements.category.value,
        paymentMethod: form.elements.paymentMethod.value,
        description: form.elements.description.value,
        entryDate: form.elements.entryDate.value
      })
    });
    showToast('Movimiento guardado');
    renderAccountingAdmin();
  });
  $('#cashClosingForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await api('/api/admin/accounting/cash-closings', {
      method: 'POST',
      body: JSON.stringify({
        businessDate: form.elements.businessDate.value,
        openingCash: Number(form.elements.openingCash.value || 0),
        countedCash: Number(form.elements.countedCash.value || 0),
        withdrawals: Number(form.elements.withdrawals.value || 0),
        notes: form.elements.notes.value
      })
    });
    showToast('Caja cerrada');
    renderAccountingAdmin();
  });
  $('#supplierPurchaseForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const items = $$('[data-purchase-line]').map((line) => ({
      inventoryItemId: Number($('[data-purchase-item]', line).value),
      quantity: Number($('[data-purchase-quantity]', line).value || 0),
      unitCost: Number($('[data-purchase-cost]', line).value || 0)
    })).filter((item) => item.inventoryItemId && item.quantity > 0);
    await api('/api/admin/accounting/purchases', {
      method: 'POST',
      body: JSON.stringify({
        supplierName: form.elements.supplierName.value,
        invoiceNumber: form.elements.invoiceNumber.value,
        purchaseDate: form.elements.purchaseDate.value,
        paymentMethod: form.elements.paymentMethod.value,
        notes: form.elements.notes.value,
        items
      })
    });
    showToast('Compra registrada e inventario actualizado');
    renderAccountingAdmin();
  });
  $('#wasteForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await api('/api/admin/accounting/waste', {
      method: 'POST',
      body: JSON.stringify({
        inventoryItemId: Number(form.elements.inventoryItemId.value),
        productId: form.elements.productId.value ? Number(form.elements.productId.value) : null,
        quantity: Number(form.elements.quantity.value || 0),
        reason: form.elements.reason.value,
        notes: form.elements.notes.value
      })
    });
    showToast('Merma registrada e inventario descontado');
    renderAccountingAdmin();
  });
  $('#addPurchaseLineBtn').addEventListener('click', () => {
    $('#purchaseLines').insertAdjacentHTML('beforeend', purchaseLine(data.inventoryItems, true));
  });
  $('#accountingSection').onclick = async (event) => {
    const removeLine = event.target.closest('[data-remove-purchase-line]');
    if (removeLine) {
      const line = removeLine.closest('[data-purchase-line]');
      if ($$('[data-purchase-line]').length > 1) line.remove();
      return;
    }
    const del = event.target.closest('[data-delete-accounting-entry]');
    if (!del || !confirm('Eliminar movimiento contable?')) return;
    await api(`/api/admin/accounting/entries/${del.dataset.deleteAccountingEntry}`, { method: 'DELETE' });
    showToast('Movimiento eliminado');
    renderAccountingAdmin();
  };
}

function cashSummaryItem(label, cents) {
  return `<div><span>${escapeHtml(label)}</span><strong>${money(cents)}</strong></div>`;
}

function inventoryOptions(items) {
  return items.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} (${escapeHtml(item.unit)})</option>`).join('');
}

function productOptions(products) {
  return products.map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join('');
}

function purchaseLine(items, removable = false) {
  return `
    <div class="purchase-line" data-purchase-line>
      <label>Insumo<select class="select" data-purchase-item>${inventoryOptions(items)}</select></label>
      <label>Cantidad<input class="field" data-purchase-quantity type="number" min="0" step="0.01" value="1"></label>
      <label>Costo unitario<input class="field" data-purchase-cost type="number" min="0" step="0.01" value="0"></label>
      <button class="btn btn--ghost btn--small" type="button" data-remove-purchase-line ${removable ? '' : 'disabled'}>Quitar</button>
    </div>
  `;
}

function cashClosingsTable(rows) {
  if (!rows.length) return '<div class="empty-state">Aun no hay cierres de caja.</div>';
  return `
    <div class="mini-table">
      ${rows.slice(0, 5).map((row) => `
        <div>
          <strong>${escapeHtml(row.businessDate)}</strong>
          <span>Esperado ${money(row.expectedCashCents)}</span>
          <span>Contado ${money(row.countedCashCents)}</span>
          <b class="${row.differenceCents === 0 ? '' : 'is-warning'}">${money(row.differenceCents)}</b>
        </div>
      `).join('')}
    </div>
  `;
}

function purchasesTable(rows) {
  if (!rows.length) return '<div class="empty-state">Sin compras registradas.</div>';
  return `
    <div class="mini-table">
      ${rows.slice(0, 5).map((purchase) => `
        <div>
          <strong>${escapeHtml(purchase.supplierName)}</strong>
          <span>${escapeHtml(purchase.purchaseDate)} · ${purchase.items.length} insumos</span>
          <span>${escapeHtml(purchase.paymentMethod || 'Sin metodo')}</span>
          <b>${money(purchase.totalCents)}</b>
        </div>
      `).join('')}
    </div>
  `;
}

function wasteTable(rows) {
  if (!rows.length) return '<div class="empty-state">Sin merma registrada.</div>';
  return `
    <div class="mini-table">
      ${rows.slice(0, 6).map((waste) => `
        <div>
          <strong>${escapeHtml(waste.itemName)}</strong>
          <span>${waste.quantity} ${escapeHtml(waste.unit)} · ${escapeHtml(waste.reason)}</span>
          <span>${escapeHtml(waste.productName || 'Operacion')}</span>
          <b>${money(waste.costCents)}</b>
        </div>
      `).join('')}
    </div>
  `;
}

function productCostingTable(rows) {
  if (!rows.length) return '<div class="empty-state">Configura productos y recetas para ver rentabilidad.</div>';
  return `
    <div class="table-wrap">
      <table class="table product-cost-table">
        <thead><tr><th>Producto</th><th>Venta</th><th>Costo receta</th><th>Ganancia</th><th>Margen</th><th>Vendido mes</th></tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td><strong>${escapeHtml(row.productName)}</strong><div class="muted">${escapeHtml(row.categoryName)} · ${row.lines.length || 0} insumos</div></td>
              <td>${money(row.priceCents)}</td>
              <td>${money(row.recipeCostCents)}</td>
              <td><strong>${money(row.grossProfitCents)}</strong></td>
              <td><span class="status-badge ${row.marginPct >= 65 ? 'status-Listo' : row.marginPct >= 45 ? 'status-Nuevo' : 'status-Cancelado'}">${row.marginPct}%</span></td>
              <td>${row.soldThisMonth}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function accountingCategoryRows(rows) {
  if (!rows.length) return '<div class="empty-state">Aun no hay movimientos manuales.</div>';
  return `
    <div class="config-list">
      ${rows.map((row) => `
        <article class="accounting-category">
          <span class="status-badge ${row.type === 'expense' ? 'status-Cancelado' : 'status-Listo'}">${row.type === 'expense' ? 'Gasto' : 'Ingreso'}</span>
          <strong>${escapeHtml(row.name)}</strong>
          <span>${money(row.amountCents)}</span>
          <small>${row.entries} movimientos</small>
        </article>
      `).join('')}
    </div>
  `;
}

function accountingEntriesTable(entries) {
  if (!entries.length) return '<div class="empty-state">Sin movimientos contables.</div>';
  return `
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Categoria</th><th>Descripcion</th><th>Monto</th><th></th></tr></thead>
        <tbody>
          ${entries.map((entry) => `
            <tr>
              <td>${escapeHtml(entry.entryDate)}</td>
              <td><span class="status-badge ${entry.type === 'expense' ? 'status-Cancelado' : 'status-Listo'}">${entry.type === 'expense' ? 'Gasto' : 'Ingreso'}</span></td>
              <td><strong>${escapeHtml(entry.category)}</strong><div class="muted">${escapeHtml(entry.paymentMethod || 'Sin metodo')}</div></td>
              <td>${escapeHtml(entry.description || '')}<div class="muted">${escapeHtml(entry.createdByUserName || '')}</div></td>
              <td><strong>${money(entry.amountCents)}</strong></td>
              <td><button class="btn btn--ghost btn--small" type="button" data-delete-accounting-entry="${entry.id}">Eliminar</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
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

function normalizeAdminThermalPrinter(input, defaults, legacy = {}) {
  const config = input && typeof input === 'object' ? input : {};
  return {
    ...defaults,
    ...config,
    enabled: Boolean(config.enabled ?? legacy.enabled ?? defaults.enabled),
    type: 'thermal',
    ticketWidthMm: printerTicketWidth(config.ticketWidthMm ?? legacy.ticketWidthMm, defaults.ticketWidthMm),
    connectionMode: printerConnectionMode(config.connectionMode ?? legacy.connectionMode, defaults.connectionMode),
    systemPrinterName: String(config.systemPrinterName ?? legacy.systemPrinterName ?? defaults.systemPrinterName ?? ''),
    networkHost: String(config.networkHost ?? legacy.networkHost ?? defaults.networkHost ?? ''),
    networkPort: printerPort(config.networkPort ?? legacy.networkPort, defaults.networkPort)
  };
}

function normalizeAdminLabelPrinter(input, defaults, legacy = {}) {
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

function normalizeAdminPrinterConfig(input = {}) {
  const config = input && typeof input === 'object' ? input : {};
  const printers = config.printers && typeof config.printers === 'object' ? config.printers : {};
  return {
    printers: {
      caja: normalizeAdminThermalPrinter(printers.caja, DEFAULT_PRINTER_CONFIG.printers.caja, {
        enabled: config.ticketPrinterEnabled,
        ticketWidthMm: config.ticketWidthMm
      }),
      cocina: normalizeAdminThermalPrinter(printers.cocina, DEFAULT_PRINTER_CONFIG.printers.cocina, {
        enabled: config.ticketPrinterEnabled,
        ticketWidthMm: config.ticketWidthMm
      }),
      kiosk: normalizeAdminThermalPrinter(printers.kiosk, DEFAULT_PRINTER_CONFIG.printers.kiosk, {
        enabled: config.ticketPrinterEnabled,
        ticketWidthMm: config.ticketWidthMm
      }),
      etiquetas: normalizeAdminLabelPrinter(printers.etiquetas, DEFAULT_PRINTER_CONFIG.printers.etiquetas, {
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

function ticketWidthOptions(current) {
  return `
    <option value="80" ${Number(current) === 80 ? 'selected' : ''}>80 mm</option>
    <option value="58" ${Number(current) === 58 ? 'selected' : ''}>58 mm</option>
  `;
}

function printerConnectionOptions(current) {
  const selected = printerConnectionMode(current);
  return `
    <option value="browser" ${selected === 'browser' ? 'selected' : ''}>Navegador / elegir al imprimir</option>
    <option value="system" ${selected === 'system' ? 'selected' : ''}>PC / impresora instalada</option>
    <option value="network" ${selected === 'network' ? 'selected' : ''}>Red / IP directa</option>
  `;
}

function detectedPrinterOptions(current) {
  const selected = String(current || '');
  const detected = detectedPrintersState.printers || [];
  const includesSelected = detected.some((printer) => printer.name === selected);
  return `
    <option value="">Seleccionar impresora detectada</option>
    ${selected && !includesSelected ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (guardada)</option>` : ''}
    ${detected.map((printer) => `
      <option value="${escapeHtml(printer.name)}" ${printer.name === selected ? 'selected' : ''}>
        ${escapeHtml(printer.name)}${printer.isDefault ? ' - predeterminada' : ''}${printer.connection ? ` - ${escapeHtml(printer.connection)}` : ''}
      </option>
    `).join('')}
  `;
}

function renderThermalPrinterSettings(role, title, description, printer) {
  const prefix = `printer${role}`;
  return `
    <article class="printer-role">
      <header>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span class="muted">${escapeHtml(description)}</span>
        </div>
        <label class="inline-check"><input type="checkbox" name="${prefix}Enabled" ${printer.enabled ? 'checked' : ''}> Activa</label>
      </header>
      <div class="form-grid">
        <label>Nombre de impresora<input class="field" name="${prefix}Name" value="${escapeHtml(printer.name || title)}"></label>
        <label>Ancho de ticket
          <select class="select" name="${prefix}WidthMm">${ticketWidthOptions(printer.ticketWidthMm)}</select>
        </label>
        <label>Conexion
          <select class="select" name="${prefix}ConnectionMode">${printerConnectionOptions(printer.connectionMode)}</select>
        </label>
        <label>Impresora conectada al PC
          <select class="select" name="${prefix}SystemPrinterName" data-detected-printer-select>${detectedPrinterOptions(printer.systemPrinterName)}</select>
        </label>
        <label>IP o host de red<input class="field" name="${prefix}NetworkHost" value="${escapeHtml(printer.networkHost || '')}" placeholder="192.168.1.50"></label>
        <label>Puerto red<input class="field" name="${prefix}NetworkPort" type="number" min="1" max="65535" value="${printer.networkPort || 9100}"></label>
      </div>
    </article>
  `;
}

function renderLabelPrinterSettings(printer, slugs) {
  return `
    <article class="printer-role">
      <header>
        <div>
          <strong>Zebra etiquetas</strong>
          <span class="muted">Etiquetas 2 x 1 para vasos; una por bebida.</span>
        </div>
        <label class="inline-check"><input type="checkbox" name="printerEtiquetasEnabled" ${printer.enabled ? 'checked' : ''}> Activa</label>
      </header>
      <div class="form-grid">
        <label>Nombre de impresora<input class="field" name="printerEtiquetasName" value="${escapeHtml(printer.name || 'Zebra vasos')}"></label>
        <label>Copias por bebida<input class="field" name="printerEtiquetasCopies" type="number" min="1" max="5" value="${printer.copiesPerDrink}"></label>
        <label>Ancho etiqueta (pulg.)<input class="field" name="printerEtiquetasWidthIn" type="number" min="1" max="4" step="0.1" value="${printer.labelWidthIn}"></label>
        <label>Alto etiqueta (pulg.)<input class="field" name="printerEtiquetasHeightIn" type="number" min="0.5" max="3" step="0.1" value="${printer.labelHeightIn}"></label>
        <label>Conexion
          <select class="select" name="printerEtiquetasConnectionMode">${printerConnectionOptions(printer.connectionMode)}</select>
        </label>
        <label>Impresora conectada al PC
          <select class="select" name="printerEtiquetasSystemPrinterName" data-detected-printer-select>${detectedPrinterOptions(printer.systemPrinterName)}</select>
        </label>
        <label>IP o host de red<input class="field" name="printerEtiquetasNetworkHost" value="${escapeHtml(printer.networkHost || '')}" placeholder="192.168.1.60"></label>
        <label>Puerto red<input class="field" name="printerEtiquetasNetworkPort" type="number" min="1" max="65535" value="${printer.networkPort || 9100}"></label>
        <label><input type="checkbox" name="printerEtiquetasIncludePrice" ${printer.includePrice ? 'checked' : ''}> Mostrar precio en etiqueta</label>
        <label class="wide">Categorias de bebidas para etiquetas
          <input class="field" name="labelDrinkCategorySlugs" value="${escapeHtml((slugs || []).join(', '))}" placeholder="milk-tea, smoothies, iced-coffee, refreshers">
        </label>
      </div>
    </article>
  `;
}

function updateDetectedPrinterSelects() {
  $$('[data-detected-printer-select]').forEach((select) => {
    const current = select.value;
    select.innerHTML = detectedPrinterOptions(current);
  });
  const status = $('#printerDetectionStatus');
  if (!status) return;
  if (!detectedPrintersState.loaded) {
    status.textContent = 'Puedes seleccionar una impresora instalada en esta PC o configurar una impresora de red por IP.';
    return;
  }
  const count = detectedPrintersState.printers.length;
  status.textContent = count
    ? `${count} impresora${count === 1 ? '' : 's'} detectada${count === 1 ? '' : 's'} en esta PC.`
    : detectedPrintersState.message || 'No se encontraron impresoras instaladas en esta PC.';
}

async function detectConnectedPrinters() {
  const button = $('#detectPrinters');
  const status = $('#printerDetectionStatus');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Buscando impresoras conectadas...';
  try {
    const data = await api('/api/admin/printers/detected');
    detectedPrintersState.loaded = true;
    detectedPrintersState.printers = data.printers || [];
    detectedPrintersState.message = data.message || '';
    updateDetectedPrinterSelects();
    showToast(detectedPrintersState.printers.length ? 'Impresoras detectadas' : 'No se encontraron impresoras');
  } catch (error) {
    if (status) status.textContent = error.message;
    showToast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function renderSettings() {
  const data = await api('/api/admin/settings');
  const business = data.business;
  const printerConfig = normalizeAdminPrinterConfig(business.printerConfig || {});
  const printers = printerConfig.printers;
  applyAdminBrand(business);
  const menuUrl = `${location.origin}/menu`;
  const tableExampleUrl = `${location.origin}/menu?table=Mesa%201`;
  $('#settingsSection').innerHTML = `
    <div class="settings-layout">
      <aside class="settings-rail">
        <div class="settings-preview">
          <img id="settingsLogoPreview" src="${escapeHtml(business.logoUrl || '/assets/brand/longcha-mark.png')}" alt="Logo">
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
        <label>Mesa para QR<input class="field" id="tableQrInput" value="Mesa 1"></label>
        <div class="qr-box"><img id="tableQrPreview" src="/qr.svg?data=${encodeURIComponent(tableExampleUrl)}" alt="QR por mesa"></div>
        <div class="actions-row">
          <a class="btn btn--soft btn--small" href="/qr.svg?data=${encodeURIComponent(menuUrl)}" target="_blank" rel="noreferrer">Abrir QR</a>
          <button class="btn btn--ghost btn--small" type="button" id="copyMenuUrl">Copiar enlace</button>
          <a class="btn btn--ghost btn--small" id="openTableQr" href="/qr.svg?data=${encodeURIComponent(tableExampleUrl)}" target="_blank" rel="noreferrer">QR mesa</a>
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
          <label style="display:block;margin-top:12px">Cierre temporal hasta<input class="field" name="temporaryClosedUntil" type="datetime-local" value="${business.temporaryClosedUntil ? escapeHtml(business.temporaryClosedUntil.slice(0, 16)) : ''}"></label>
          <label style="display:block;margin-top:12px">Mensaje cuando este cerrado<textarea class="textarea" name="closedMessage">${escapeHtml(business.closedMessage)}</textarea></label>
        </section>

        <section class="settings-block">
          <header><h2>Tiempos estimados</h2></header>
          <div class="form-grid">
            <label>Retiro en tienda (min)<input class="field" name="prepPickupMinutes" type="number" min="0" value="${business.prepPickupMinutes}"></label>
            <label>Delivery (min)<input class="field" name="prepDeliveryMinutes" type="number" min="0" value="${business.prepDeliveryMinutes}"></label>
            <label>Comer en local (min)<input class="field" name="prepDineinMinutes" type="number" min="0" value="${business.prepDineinMinutes}"></label>
            <label><input type="checkbox" name="tableQrEnabled" ${business.tableQrEnabled ? 'checked' : ''}> Activar QR por mesa</label>
          </div>
        </section>

        <section class="settings-block">
          <header>
            <h2>Impresoras</h2>
            <div class="actions-row">
              <button class="btn btn--ghost btn--small" type="button" id="detectPrinters">Detectar impresoras</button>
              <span class="badge">Caja, cocina y kiosk</span>
            </div>
          </header>
          <div class="printer-detection-status" id="printerDetectionStatus">
            ${detectedPrintersState.loaded
              ? `${detectedPrintersState.printers.length} impresora${detectedPrintersState.printers.length === 1 ? '' : 's'} detectada${detectedPrintersState.printers.length === 1 ? '' : 's'}.`
              : 'Puedes seleccionar una impresora instalada en esta PC o configurar una impresora de red por IP.'}
          </div>
          <div class="printer-grid">
            ${renderThermalPrinterSettings('Caja', 'Impresora caja', 'Ticket de pago, recibo y cobro.', printers.caja)}
            ${renderThermalPrinterSettings('Cocina', 'Impresora cocina', 'Comandas internas para preparacion.', printers.cocina)}
            ${renderThermalPrinterSettings('Kiosk', 'Impresora kiosk', 'Solo imprime el numero de orden del autoservicio.', printers.kiosk)}
            ${renderLabelPrinterSettings(printers.etiquetas, printerConfig.labelDrinkCategorySlugs)}
          </div>
          <p class="muted" style="margin:12px 0 0">En kiosk no se imprimen tickets detallados ni etiquetas desde la pantalla del cliente; solo el numero de orden. Las etiquetas Zebra quedan configuradas para flujo interno.</p>
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
    $('#settingsLogoPreview').src = event.target.value || '/assets/brand/longcha-mark.png';
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
      temporaryClosedUntil: form.elements.temporaryClosedUntil.value,
      prepPickupMinutes: Number(form.elements.prepPickupMinutes.value || 0),
      prepDeliveryMinutes: Number(form.elements.prepDeliveryMinutes.value || 0),
      prepDineinMinutes: Number(form.elements.prepDineinMinutes.value || 0),
      tableQrEnabled: form.elements.tableQrEnabled.checked,
      printerConfig: {
        printers: {
          caja: {
            enabled: form.elements.printerCajaEnabled.checked,
            name: form.elements.printerCajaName.value,
            type: 'thermal',
            ticketWidthMm: Number(form.elements.printerCajaWidthMm.value || 80),
            connectionMode: form.elements.printerCajaConnectionMode.value,
            systemPrinterName: form.elements.printerCajaSystemPrinterName.value,
            networkHost: form.elements.printerCajaNetworkHost.value,
            networkPort: Number(form.elements.printerCajaNetworkPort.value || 9100)
          },
          cocina: {
            enabled: form.elements.printerCocinaEnabled.checked,
            name: form.elements.printerCocinaName.value,
            type: 'thermal',
            ticketWidthMm: Number(form.elements.printerCocinaWidthMm.value || 80),
            connectionMode: form.elements.printerCocinaConnectionMode.value,
            systemPrinterName: form.elements.printerCocinaSystemPrinterName.value,
            networkHost: form.elements.printerCocinaNetworkHost.value,
            networkPort: Number(form.elements.printerCocinaNetworkPort.value || 9100)
          },
          kiosk: {
            enabled: form.elements.printerKioskEnabled.checked,
            name: form.elements.printerKioskName.value,
            type: 'thermal',
            ticketWidthMm: Number(form.elements.printerKioskWidthMm.value || 80),
            connectionMode: form.elements.printerKioskConnectionMode.value,
            systemPrinterName: form.elements.printerKioskSystemPrinterName.value,
            networkHost: form.elements.printerKioskNetworkHost.value,
            networkPort: Number(form.elements.printerKioskNetworkPort.value || 9100),
            printOrderNumberOnly: true
          },
          etiquetas: {
            enabled: form.elements.printerEtiquetasEnabled.checked,
            name: form.elements.printerEtiquetasName.value,
            type: 'zebra-label',
            labelWidthIn: Number(form.elements.printerEtiquetasWidthIn.value || 2),
            labelHeightIn: Number(form.elements.printerEtiquetasHeightIn.value || 1),
            copiesPerDrink: Number(form.elements.printerEtiquetasCopies.value || 1),
            connectionMode: form.elements.printerEtiquetasConnectionMode.value,
            systemPrinterName: form.elements.printerEtiquetasSystemPrinterName.value,
            networkHost: form.elements.printerEtiquetasNetworkHost.value,
            networkPort: Number(form.elements.printerEtiquetasNetworkPort.value || 9100),
            includePrice: form.elements.printerEtiquetasIncludePrice.checked,
            autoPrintFromKiosk: false
          }
        },
        labelDrinkCategorySlugs: form.elements.labelDrinkCategorySlugs.value.split(',').map((item) => item.trim()).filter(Boolean)
      },
      hours: collectHours()
    };
    const result = await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(payload) });
    applyAdminBrand(result.business);
    showToast('Configuracion guardada');
  });
  $('#detectPrinters').addEventListener('click', detectConnectedPrinters);
  $('#copyMenuUrl').addEventListener('click', async () => {
    await navigator.clipboard.writeText(menuUrl);
    showToast('Enlace copiado');
  });
  $('#tableQrInput').addEventListener('input', (event) => {
    const url = `${location.origin}/menu?table=${encodeURIComponent(event.target.value || 'Mesa 1')}`;
    $('#tableQrPreview').src = `/qr.svg?data=${encodeURIComponent(url)}`;
    $('#openTableQr').href = `/qr.svg?data=${encodeURIComponent(url)}`;
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
            <thead><tr><th>Archivo</th><th>Tamano</th><th>Fecha</th><th></th></tr></thead>
            <tbody id="backupRows">${backupRows(backupData.backups)}</tbody>
          </table>
        </div>
      </aside>
    </div>
    <section class="panel" style="margin-top:14px">
      <h2>Notificaciones</h2>
      <div class="table-wrap" style="margin-top:14px">
        <table class="table">
          <thead><tr><th>Fecha</th><th>Pedido</th><th>Canal</th><th>Estado</th><th>Detalle</th></tr></thead>
          <tbody>${notificationRows(backupData.notifications || [])}</tbody>
        </table>
      </div>
    </section>
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
      <td><a class="btn btn--soft btn--small" href="/api/admin/backups/${encodeURIComponent(row.fileName)}">Descargar</a></td>
    </tr>
  `).join('') : '<tr><td colspan="4">Sin backups todavia.</td></tr>';
}

function notificationRows(rows) {
  return rows.length ? rows.map((row) => `
    <tr>
      <td>${new Date(row.createdAt).toLocaleString()}</td>
      <td>${escapeHtml(row.orderNumber || '')}</td>
      <td>${escapeHtml(row.channel)}</td>
      <td>${escapeHtml(row.status)}</td>
      <td>${escapeHtml(row.template || row.message || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="5">Sin notificaciones registradas.</td></tr>';
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
    <section class="panel" style="margin-top:14px">
      <h2>Roles y permisos</h2>
      <div class="config-list" id="roleList" style="margin-top:14px">
        ${roleCards(data.roles)}
      </div>
    </section>
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
  $('#roleList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-save-role]');
    if (!button) return;
    const card = button.closest('[data-role-card]');
    await api(`/api/admin/roles/${button.dataset.saveRole}`, {
      method: 'PATCH',
      body: JSON.stringify({
        description: $('[data-role-description]', card).value,
        permissions: $$('[data-role-permission]:checked', card).map((input) => input.value)
      })
    });
    showToast('Rol actualizado');
    renderUsers();
  });
}

function roleCards(roles) {
  return roles.map((role) => `
    <article class="config-item" data-role-card>
      <header><strong>${escapeHtml(role.name)}</strong><span>${role.permissions.length} permisos</span></header>
      <textarea class="textarea" data-role-description>${escapeHtml(role.description || '')}</textarea>
      <div class="checks">
        ${availablePermissions.map((permission) => `
          <label><input type="checkbox" data-role-permission value="${permission}" ${role.permissions.includes(permission) ? 'checked' : ''}> ${escapeHtml(permission)}</label>
        `).join('')}
      </div>
      <button class="btn btn--soft btn--small" type="button" data-save-role="${role.id}">Guardar rol</button>
    </article>
  `).join('');
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

function printerUsesAgent(printer) {
  if (!printer?.enabled) return false;
  if (printer.connectionMode === 'system') return Boolean(printer.systemPrinterName);
  if (printer.connectionMode === 'network') return Boolean(printer.networkHost);
  return false;
}

async function queueAgentPrint(order, role) {
  const config = normalizeAdminPrinterConfig(state.business?.printerConfig || {});
  const printer = config.printers[role];
  if (!['system', 'network'].includes(printer?.connectionMode)) return false;
  if (!printerUsesAgent(printer)) {
    showToast('Configura la impresora local o de red antes de enviar al agente.');
    return true;
  }
  const result = await api(`/api/admin/orders/${order.id}/print-jobs`, {
    method: 'POST',
    body: JSON.stringify({ roles: [role] })
  });
  showToast(result.jobs?.length ? 'Trabajo enviado al agente de impresion' : 'No se creo ningun trabajo de impresion');
  return true;
}

function prepareAdminPrint(layout = 'ticket', role = 'caja') {
  const target = $('#ticketPrint');
  const config = normalizeAdminPrinterConfig(state.business?.printerConfig || {});
  const printer = config.printers[role] || config.printers.caja;
  target.dataset.printLayout = layout;
  target.style.setProperty('--ticket-width', `${Number(printer.ticketWidthMm || 80)}mm`);
  target.style.setProperty('--label-width', `${Number(config.printers.etiquetas.labelWidthIn || 2)}in`);
  target.style.setProperty('--label-height', `${Number(config.printers.etiquetas.labelHeightIn || 1)}in`);
  target.innerHTML = '';
  return target;
}

async function printTicket(order) {
  if (await queueAgentPrint(order, 'caja')) return;
  const businessName = state.business?.name || 'Long Cha';
  prepareAdminPrint('ticket', 'caja').innerHTML = `
    <div style="text-align:center">
      <strong>${escapeHtml(businessName)}</strong><br>
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

async function printKitchenTicket(order) {
  if (await queueAgentPrint(order, 'cocina')) return;
  prepareAdminPrint('ticket', 'cocina').innerHTML = `
    <div style="text-align:center">
      <strong>COCINA</strong><br>
      Pedido ${escapeHtml(order.orderNumber)}<br>
      ${order.tableLabel ? `Mesa: ${escapeHtml(order.tableLabel)}<br>` : ''}
      ${new Date(order.createdAt).toLocaleString()}
    </div>
    <hr>
    ${order.items.map((item) => `
      <strong>${item.quantity} x ${escapeHtml(item.productName)}</strong><br>
      ${Object.entries(item.variants || {}).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join('<br>')}
      ${(item.extras || []).map((extra) => `<br>+ ${escapeHtml(extra.name)}`).join('')}
      ${item.notes ? `<br>Nota: ${escapeHtml(item.notes)}` : ''}<br>
    `).join('<br>')}
    ${order.notes ? `<hr>Notas generales:<br>${escapeHtml(order.notes)}` : ''}
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
