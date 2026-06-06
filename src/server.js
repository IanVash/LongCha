import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  ValidationError,
  auditLog,
  claimPrintJobs,
  completePrintJob,
  createOrder,
  createPrintJobs,
  createSession,
  db,
  databasePath,
  deleteAccountingEntry,
  deleteCategory,
  deleteExtra,
  deleteInventoryItem,
  deleteOptionalGroup,
  deleteOptionalOption,
  deleteProduct,
  deleteSession,
  failPrintJob,
  formatOrderForWhatsApp,
  getAdminCatalog,
  getAccounting,
  getBusiness,
  getCheckoutOptions,
  getInventoryAdmin,
  getMenu,
  getDeliveryAdmin,
  getOrderById,
  getOrderByNumber,
  getReports,
  getSessionContext,
  getUserBySession,
  initDatabase,
  listAuditLogs,
  listBranches,
  listCategories,
  listExtras,
  listNotificationLogs,
  listOptionalGroups,
  listOrders,
  listOrdersByCustomerPhone,
  listPrintJobs,
  listPromotions,
  listRoles,
  listUsers,
  login,
  notificationLog,
  saveCashClosing,
  saveCashOpening,
  saveCategory,
  saveAccountingEntry,
  saveDeliveryZone,
  saveExtra,
  saveInventoryItem,
  saveOptionalGroup,
  saveOptionalOption,
  saveProduct,
  savePromotion,
  saveSupplierPurchase,
  saveUser,
  saveWasteLog,
  updateBusiness,
  updateCategory,
  updateDeliveryMethod,
  updateDeliveryZone,
  updateExtra,
  updateInventoryItem,
  updateOptionalGroup,
  updateOptionalOption,
  updateOrderAssignment,
  updateOrderPayment,
  updateOrderStatus,
  updateProduct,
  updateProductInventory,
  updateProductRecipe,
  updatePromotion,
  updateRole,
  updateUser,
  deletePromotion,
  rotateSession,
  userCan
} from './db.js';
import { qrSvg } from './qr.js';
import { sendWhatsAppStatus, whatsappStatusUrl } from './whatsapp.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(rootDir, 'public');
const execFileAsync = promisify(execFile);

loadEnv();
initDatabase();

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
const uploadRoot = path.resolve(process.env.IMAGE_UPLOAD_DIR || path.join(dataDir, 'uploads'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
const maxImageBytes = Number(process.env.MAX_IMAGE_BYTES || 2 * 1024 * 1024);
const jsonBodyLimitBytes = Number(process.env.JSON_BODY_LIMIT_BYTES || 512 * 1024);
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 300);
const loginRateLimitMax = Number(process.env.LOGIN_RATE_LIMIT_MAX || 10);
const mutationRateLimitMax = Number(process.env.MUTATION_RATE_LIMIT_MAX || 120);
const sessionDays = Number(process.env.SESSION_DAYS || 7);
const sessionRotateMinutes = Number(process.env.SESSION_ROTATE_MINUTES || 30);
const backupIntervalHours = Number(process.env.BACKUP_INTERVAL_HOURS || 24);
const enforceHttps = String(process.env.ENFORCE_HTTPS || '').toLowerCase() === 'true';
const trustProxy = String(process.env.TRUST_PROXY || 'true').toLowerCase() !== 'false';
const printAgentToken = process.env.PRINT_AGENT_TOKEN || (process.env.NODE_ENV === 'production' ? '' : 'dev-print-agent-token');

mkdirSync(uploadRoot, { recursive: true });
mkdirSync(backupDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon'
};

const adminEventClients = new Set();
const orderEventClients = new Map();

function loadEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...headers
  });
  res.end(body);
}

function json(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': conectado\n\n');
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function closeSseClient(collection, res) {
  collection.delete(res);
  try {
    res.end();
  } catch {
    /* cliente cerrado */
  }
}

function addAdminEventClient(req, res, user) {
  sseHeaders(res);
  adminEventClients.add(res);
  writeSse(res, 'orders.snapshot', {
    orders: listOrders({ limit: 80 }).map(withAdminOrderLinks),
    userId: user.id
  });
  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(': ping\n\n');
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    closeSseClient(adminEventClients, res);
  });
}

function addOrderEventClient(req, res, order) {
  sseHeaders(res);
  const orderNumber = order.orderNumber;
  if (!orderEventClients.has(orderNumber)) orderEventClients.set(orderNumber, new Set());
  const clients = orderEventClients.get(orderNumber);
  clients.add(res);
  writeSse(res, 'order.snapshot', { order: cleanOrderForPublic(order) });
  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(': ping\n\n');
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    if (!clients.size) orderEventClients.delete(orderNumber);
    try {
      res.end();
    } catch {
      /* cliente cerrado */
    }
  });
}

function broadcastAdminOrder(event, order) {
  const payload = { order: withAdminOrderLinks(order) };
  for (const client of [...adminEventClients]) {
    if (client.destroyed) {
      adminEventClients.delete(client);
    } else {
      writeSse(client, event, payload);
    }
  }
}

function broadcastPublicOrder(event, order) {
  const clients = orderEventClients.get(order.orderNumber);
  if (!clients?.size) return;
  const payload = { order: cleanOrderForPublic(order) };
  for (const client of [...clients]) {
    if (client.destroyed) {
      clients.delete(client);
    } else {
      writeSse(client, event, payload);
    }
  }
  if (!clients.size) orderEventClients.delete(order.orderNumber);
}

function emitOrderEvent(event, order) {
  broadcastAdminOrder(event, order);
  broadcastPublicOrder(event, order);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function getClientIp(req) {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function isSecureRequest(req) {
  if (req.socket.encrypted) return true;
  if (trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  return false;
}

function shouldUseSecureCookie(req) {
  return isSecureRequest(req) || process.env.NODE_ENV === 'production' || String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
}

function setCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  if (!current) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, cookie]);
  } else {
    res.setHeader('Set-Cookie', [current, cookie]);
  }
}

function sessionCookie(req, sessionId, maxAgeSeconds = sessionDays * 24 * 60 * 60) {
  const secure = shouldUseSecureCookie(req) ? '; Secure' : '';
  return `pos_session=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function shouldRedirectToHttps(req) {
  return enforceHttps && !isSecureRequest(req);
}

function redirectToHttps(req, res) {
  const host = req.headers.host || `localhost:${port}`;
  res.writeHead(308, {
    Location: `https://${host}${req.url || '/'}`,
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains'
  });
  res.end();
}

const rateBuckets = new Map();

function enforceRateLimit(req, res, url) {
  const bucketName = url.pathname === '/api/auth/login'
    ? 'login'
    : ['POST', 'PATCH', 'DELETE'].includes(req.method || '')
      ? 'mutation'
      : 'general';
  const max = bucketName === 'login' ? loginRateLimitMax : bucketName === 'mutation' ? mutationRateLimitMax : rateLimitMax;
  const key = `${getClientIp(req)}:${bucketName}`;
  const now = Date.now();
  const current = rateBuckets.get(key);
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + rateLimitWindowMs };
  bucket.count += 1;
  rateBuckets.set(key, bucket);

  const remaining = Math.max(0, max - bucket.count);
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > max) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    throw new ValidationError('Demasiadas solicitudes. Intenta nuevamente en unos minutos.', 429);
  }

  if (rateBuckets.size > 10000) {
    for (const [entryKey, entry] of rateBuckets.entries()) {
      if (entry.resetAt <= now) rateBuckets.delete(entryKey);
    }
  }
}

async function readRaw(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new ValidationError('El cuerpo de la solicitud excede el limite permitido.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = (await readRaw(req, jsonBodyLimitBytes)).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('El cuerpo de la solicitud no es JSON valido.');
  }
}

function parseMultipart(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(marker);
  while (cursor !== -1) {
    const next = buffer.indexOf(marker, cursor + marker.length);
    if (next === -1) break;
    let part = buffer.subarray(cursor + marker.length, next);
    if (part.subarray(0, 2).toString() === '--') break;
    if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2);
    if (part.subarray(-2).toString() === '\r\n') part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('latin1');
      const content = part.subarray(headerEnd + 4);
      const headers = Object.fromEntries(headerText.split('\r\n').map((line) => {
        const index = line.indexOf(':');
        return index === -1 ? ['', ''] : [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
      }).filter(([key]) => key));
      const disposition = headers['content-disposition'] || '';
      const name = disposition.match(/name="([^"]+)"/)?.[1] || '';
      const filename = disposition.match(/filename="([^"]*)"/)?.[1] || '';
      parts.push({ name, filename, contentType: headers['content-type'] || '', content });
    }
    cursor = next;
  }
  return parts;
}

async function saveUploadedImage(req) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary || !contentType.includes('multipart/form-data')) {
    throw new ValidationError('La subida debe enviarse como multipart/form-data.');
  }
  const body = await readRaw(req, maxImageBytes + 64 * 1024);
  const image = parseMultipart(body, boundary).find((part) => part.name === 'image' && part.filename);
  if (!image) throw new ValidationError('Selecciona una imagen para subir.');
  if (image.content.length > maxImageBytes) throw new ValidationError('La imagen excede el tamano maximo permitido.', 413);

  const allowed = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp'
  };
  const ext = allowed[image.contentType.toLowerCase()];
  if (!ext) throw new ValidationError('Formato no permitido. Usa PNG, JPG o WebP.');
  if (!looksLikeImage(image.content, ext)) throw new ValidationError('El archivo no parece ser una imagen valida.');

  const safeBase = path.basename(image.filename).replace(/[^a-z0-9._-]/gi, '-').replace(/\.+/g, '.').slice(0, 80) || 'image';
  const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${safeBase.replace(/\.[^.]+$/, '')}${ext}`;
  const imageDir = path.join(uploadRoot, 'images');
  mkdirSync(imageDir, { recursive: true });
  const destination = path.join(imageDir, fileName);
  writeFileSync(destination, image.content);
  return {
    url: `/uploads/images/${fileName}`,
    fileName,
    bytes: image.content.length,
    contentType: image.contentType
  };
}

function looksLikeImage(buffer, ext) {
  if (ext === '.png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (ext === '.webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return false;
}

function serveUploadedImage(res, urlPath) {
  const relative = urlPath.replace(/^\/uploads\//, '');
  const resolved = path.resolve(uploadRoot, relative);
  if (!resolved.startsWith(uploadRoot) || !existsSync(resolved)) throw new ValidationError('Imagen no encontrada.', 404);
  const ext = path.extname(resolved).toLowerCase();
  sendFile(res, resolved, mimeTypes[ext] || 'application/octet-stream', {
    'Cache-Control': 'public, max-age=31536000, immutable'
  });
}

function createBackup(reason = 'scheduled') {
  mkdirSync(backupDir, { recursive: true });
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDir, `restaurant-${stamp}-${reason}.sqlite`);
  copyFileSync(databasePath, destination);
  return {
    fileName: path.basename(destination),
    path: destination,
    bytes: statSync(destination).size,
    createdAt: new Date().toISOString()
  };
}

function listBackups() {
  mkdirSync(backupDir, { recursive: true });
  return readdirSync(backupDir)
    .filter((file) => file.endsWith('.sqlite'))
    .map((file) => {
      const fullPath = path.join(backupDir, file);
      const stats = statSync(fullPath);
      return {
        fileName: file,
        bytes: stats.size,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvFromRows(headers, rows) {
  return [
    headers.map((header) => csvCell(header.label)).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header.key])).join(','))
  ].join('\r\n');
}

function sendCsv(res, fileName, headers, rows) {
  return send(res, 200, csvFromRows(headers, rows), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`
  });
}

function reportExport(type = 'sales-by-day') {
  const reports = getReports();
  const advanced = reports.advanced || {};
  const exporters = {
    'sales-by-day': {
      fileName: 'ventas-por-dia.csv',
      headers: [
        { key: 'day', label: 'Fecha' },
        { key: 'orders', label: 'Pedidos' },
        { key: 'salesCents', label: 'Ventas centavos' }
      ],
      rows: reports.byDay
    },
    'top-products': {
      fileName: 'productos-top.csv',
      headers: [
        { key: 'name', label: 'Producto' },
        { key: 'categoryName', label: 'Categoria' },
        { key: 'quantity', label: 'Cantidad' },
        { key: 'salesCents', label: 'Ventas centavos' }
      ],
      rows: reports.topProducts
    },
    categories: {
      fileName: 'ventas-por-categoria.csv',
      headers: [
        { key: 'name', label: 'Categoria' },
        { key: 'orders', label: 'Cantidad' },
        { key: 'salesCents', label: 'Ventas centavos' }
      ],
      rows: reports.byCategory
    },
    payments: {
      fileName: 'ventas-por-metodo-pago.csv',
      headers: [
        { key: 'name', label: 'Metodo' },
        { key: 'orders', label: 'Pedidos' },
        { key: 'salesCents', label: 'Ventas centavos' },
        { key: 'averageTicketCents', label: 'Ticket promedio centavos' }
      ],
      rows: reports.byPayment
    },
    customers: {
      fileName: 'mejores-clientes.csv',
      headers: [
        { key: 'name', label: 'Cliente' },
        { key: 'phone', label: 'Telefono' },
        { key: 'orders', label: 'Pedidos' },
        { key: 'salesCents', label: 'Ventas centavos' },
        { key: 'lastOrderAt', label: 'Ultimo pedido' }
      ],
      rows: advanced.customers?.topCustomers || []
    },
    profitability: {
      fileName: 'rentabilidad-productos.csv',
      headers: [
        { key: 'productName', label: 'Producto' },
        { key: 'categoryName', label: 'Categoria' },
        { key: 'soldThisMonth', label: 'Vendidos mes' },
        { key: 'priceCents', label: 'Precio centavos' },
        { key: 'recipeCostCents', label: 'Costo receta centavos' },
        { key: 'grossProfitCents', label: 'Utilidad centavos' },
        { key: 'marginPct', label: 'Margen %' }
      ],
      rows: advanced.profitability?.leaders || []
    }
  };
  return exporters[type] || exporters['sales-by-day'];
}

function productionChecklist(req) {
  const backups = listBackups();
  const latestBackup = backups[0] || null;
  const latestBackupMs = latestBackup ? new Date(latestBackup.updatedAt).getTime() : 0;
  const backupMaxAgeMs = Math.max(backupIntervalHours || 24, 1) * 60 * 60 * 1000 * 1.5;
  const backupFresh = Boolean(latestBackupMs && Date.now() - latestBackupMs <= backupMaxAgeMs);
  const users = listUsers();
  const demoUsers = users.filter((user) => user.active && /@demo\.com$/i.test(user.email));
  const business = getBusiness();
  const checkout = getCheckoutOptions();
  const failedPrintJobs = listPrintJobs({ status: 'failed', limit: 20 });
  const notifications = listNotificationLogs(80);
  const failedNotifications = notifications.filter((item) => item.status === 'failed');
  const reports = getReports();
  const checklist = [
    {
      id: 'node-production',
      label: 'Modo produccion activo',
      ok: process.env.NODE_ENV === 'production',
      detail: process.env.NODE_ENV === 'production' ? 'NODE_ENV=production' : 'Configura NODE_ENV=production en Render.'
    },
    {
      id: 'https',
      label: 'HTTPS forzado',
      ok: enforceHttps || isSecureRequest(req),
      detail: enforceHttps ? 'ENFORCE_HTTPS=true' : 'Activa ENFORCE_HTTPS=true detras del proxy HTTPS.'
    },
    {
      id: 'secure-cookie',
      label: 'Cookie segura',
      ok: process.env.NODE_ENV === 'production' || String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true',
      detail: 'Usa COOKIE_SECURE=true en produccion.'
    },
    {
      id: 'session-rotation',
      label: 'Rotacion de sesiones',
      ok: sessionRotateMinutes > 0,
      detail: `Rotacion cada ${sessionRotateMinutes || 0} min.`
    },
    {
      id: 'rate-limit',
      label: 'Rate limiting',
      ok: rateLimitMax > 0 && loginRateLimitMax > 0 && mutationRateLimitMax > 0,
      detail: `${rateLimitMax}/ventana general, ${loginRateLimitMax} login, ${mutationRateLimitMax} mutaciones.`
    },
    {
      id: 'backup',
      label: 'Backups recientes',
      ok: backupFresh,
      detail: latestBackup ? `Ultimo backup: ${latestBackup.updatedAt}` : 'Crea un backup inicial.'
    },
    {
      id: 'demo-users',
      label: 'Usuarios demo desactivados',
      ok: demoUsers.length === 0,
      detail: demoUsers.length ? `${demoUsers.length} usuario(s) demo activo(s).` : 'No hay usuarios demo activos.'
    },
    {
      id: 'print-agent-token',
      label: 'Token de impresion no demo',
      ok: process.env.NODE_ENV !== 'production' || Boolean(process.env.PRINT_AGENT_TOKEN),
      detail: process.env.PRINT_AGENT_TOKEN ? 'PRINT_AGENT_TOKEN configurado.' : 'Configura PRINT_AGENT_TOKEN en produccion.'
    },
    {
      id: 'image-limit',
      label: 'Limite formal de imagenes',
      ok: maxImageBytes > 0 && maxImageBytes <= 5 * 1024 * 1024,
      detail: `Maximo actual: ${Math.round(maxImageBytes / 1024 / 1024 * 10) / 10} MB.`
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp del negocio',
      ok: Boolean(String(business.whatsappPhone || '').replace(/\D/g, '')),
      detail: business.whatsappPhone ? 'Numero configurado.' : 'Agrega WhatsApp para confirmaciones.'
    }
  ];
  const alerts = [
    !checkout.openState?.open ? {
      severity: 'warning',
      title: 'Pedidos pausados',
      detail: checkout.openState?.message || 'El negocio no esta recibiendo pedidos.'
    } : null,
    !backupFresh ? {
      severity: 'danger',
      title: 'Backup pendiente',
      detail: latestBackup ? 'El ultimo backup ya esta viejo.' : 'Todavia no hay backups creados.'
    } : null,
    failedPrintJobs.length ? {
      severity: 'danger',
      title: 'Impresion con fallos',
      detail: `${failedPrintJobs.length} trabajo(s) fallidos recientes.`
    } : null,
    failedNotifications.length ? {
      severity: 'warning',
      title: 'Notificaciones fallidas',
      detail: `${failedNotifications.length} intento(s) fallidos recientes.`
    } : null,
    reports.advanced?.inventoryAlerts?.totalAlerts ? {
      severity: 'warning',
      title: 'Inventario bajo',
      detail: `${reports.advanced.inventoryAlerts.totalAlerts} producto(s) o insumo(s) requieren revision.`
    } : null,
    demoUsers.length ? {
      severity: 'danger',
      title: 'Usuarios demo activos',
      detail: 'Desactiva credenciales demo antes de produccion.'
    } : null
  ].filter(Boolean);
  return {
    generatedAt: new Date().toISOString(),
    appUrl: originFromRequest(req),
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      enforceHttps,
      trustProxy,
      backupIntervalHours,
      sessionRotateMinutes,
      maxImageBytes,
      dataDir,
      backupDir
    },
    summary: {
      ok: checklist.every((item) => item.ok) && alerts.every((alert) => alert.severity !== 'danger'),
      passed: checklist.filter((item) => item.ok).length,
      total: checklist.length,
      alerts: alerts.length,
      criticalAlerts: alerts.filter((alert) => alert.severity === 'danger').length
    },
    checklist,
    alerts,
    latestBackup,
    failedPrintJobs,
    failedNotifications: failedNotifications.slice(0, 12)
  };
}

function scheduleBackups() {
  if (!backupIntervalHours || backupIntervalHours < 1) return;
  setInterval(() => {
    try {
      const backup = createBackup('auto');
      auditLog({
        action: 'system.backup_created',
        entityType: 'backup',
        entityId: backup.fileName,
        details: { bytes: backup.bytes, automatic: true }
      });
      console.log(`Backup creado: ${backup.fileName}`);
    } catch (error) {
      console.error('No se pudo crear backup programado:', error);
    }
  }, backupIntervalHours * 60 * 60 * 1000).unref();
}

function getRequestUser(req, res = null) {
  if (req.authResolved) return req.authUser;
  const cookies = parseCookies(req.headers.cookie || '');
  const context = getSessionContext(cookies.pos_session);
  req.authResolved = true;
  req.authUser = context?.user || null;
  req.authSession = context?.session || null;

  if (context && res && shouldRotateSession(context.session)) {
    const rotated = rotateSession(context.session.id);
    if (rotated) {
      req.authSession = { ...context.session, id: rotated.id, lastRotatedAt: new Date().toISOString() };
      setCookie(res, sessionCookie(req, rotated.id));
      audit(req, 'auth.session_rotated', 'session', rotated.id, { userId: context.user.id }, context.user.id);
    }
  }
  return req.authUser;
}

function shouldRotateSession(session) {
  if (!sessionRotateMinutes || sessionRotateMinutes <= 0) return false;
  const rotatedAt = new Date(session.lastRotatedAt || session.createdAt).getTime();
  return Number.isFinite(rotatedAt) && Date.now() - rotatedAt >= sessionRotateMinutes * 60 * 1000;
}

function audit(req, action, entityType = '', entityId = '', details = {}, userId = null) {
  auditLog({
    userId,
    action,
    entityType,
    entityId: String(entityId ?? ''),
    details,
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'] || ''
  });
}

function requireAuth(req, res = null) {
  const user = getRequestUser(req, res);
  if (!user) throw new ValidationError('Sesion requerida.', 401);
  return user;
}

function requirePermission(user, permission) {
  if (!userCan(user, permission)) throw new ValidationError('No tienes permisos para esta accion.', 403);
}

function userCanAny(user, permissions = []) {
  return permissions.some((permission) => userCan(user, permission));
}

function requireAnyPermission(user, permissions = []) {
  if (!userCanAny(user, permissions)) throw new ValidationError('No tienes permisos para esta accion.', 403);
}

function canChangeStatus(user, status) {
  return (
    userCan(user, 'orders:update') ||
    (status === 'Listo' && userCan(user, 'orders:update-ready')) ||
    (status === 'Entregado' && userCan(user, 'orders:update-delivered'))
  );
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeDetectedPrinter(printer, platform, defaultPrinter = '') {
  const name = String(printer.Name || printer.name || '').trim();
  if (!name) return null;
  const port = String(printer.PortName || printer.port || printer.DeviceUri || '').trim();
  const isNetwork = Boolean(printer.Network) || /network/i.test(name) || /^IP_|^TCP|^WSD|^\d{1,3}(\.\d{1,3}){3}|socket:|ipp:|lpd:/i.test(port);
  return {
    id: name,
    name,
    driver: String(printer.DriverName || printer.driver || '').trim(),
    port,
    source: platform,
    connection: isNetwork ? 'red' : 'pc',
    isDefault: Boolean(printer.Default) || name === defaultPrinter,
    isShared: Boolean(printer.Shared)
  };
}

async function detectConnectedPrinters() {
  if (process.platform === 'win32') return detectWindowsPrinters();
  if (process.platform === 'darwin' || process.platform === 'linux') return detectCupsPrinters();
  return {
    platform: process.platform,
    source: 'unsupported',
    printers: [],
    message: 'Este sistema operativo no tiene deteccion automatica de impresoras configurada.'
  };
}

async function detectWindowsPrinters() {
  const script = `
    $printers = @()
    $defaultPrinter = ''
    try {
      $printers = Get-Printer | Select-Object Name,DriverName,PortName,Shared,PrinterStatus
    } catch {
      try {
        $printers = Get-CimInstance Win32_Printer | Select-Object Name,DriverName,PortName,Network,Local,Shared,Default
      } catch {
        $printers = @()
      }
    }
    try {
      $defaultPrinter = (Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1 -ExpandProperty Name)
    } catch {
      $defaultPrinter = ''
    }
    [PSCustomObject]@{
      platform = 'windows'
      source = 'windows-print-spooler'
      defaultPrinter = $defaultPrinter
      printers = @($printers)
    } | ConvertTo-Json -Compress -Depth 5
  `;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 512 * 1024
    });
    const payload = JSON.parse(stdout || '{}');
    const printers = asArray(payload.printers)
      .map((printer) => normalizeDetectedPrinter(printer, 'windows', payload.defaultPrinter || ''))
      .filter(Boolean)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
    return {
      platform: 'windows',
      source: payload.source || 'windows-print-spooler',
      printers,
      message: printers.length ? '' : 'No se encontraron impresoras instaladas en esta PC.'
    };
  } catch (error) {
    return {
      platform: 'windows',
      source: 'windows-print-spooler',
      printers: [],
      message: `No se pudieron detectar impresoras en esta PC: ${error.message}`
    };
  }
}

async function detectCupsPrinters() {
  try {
    const { stdout } = await execFileAsync('lpstat', ['-v'], {
      timeout: 5000,
      maxBuffer: 256 * 1024
    });
    const printers = stdout
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^device for\s+(.+?):\s+(.+)$/i);
        if (!match) return null;
        return normalizeDetectedPrinter({ Name: match[1], DeviceUri: match[2], PortName: match[2] }, process.platform);
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      platform: process.platform,
      source: 'cups',
      printers,
      message: printers.length ? '' : 'No se encontraron impresoras configuradas en CUPS.'
    };
  } catch (error) {
    const missingLpstat = error.code === 'ENOENT' || /ENOENT|lpstat/i.test(error.message);
    const message = missingLpstat
      ? 'No se pueden detectar impresoras locales desde este servidor. Si la plataforma esta en Render, configura las impresoras manualmente por IP o por nombre en la PC donde corre el agente local.'
      : `No se pudieron detectar impresoras en CUPS: ${error.message}`;
    return {
      platform: process.platform,
      source: 'cups',
      printers: [],
      message
    };
  }
}

function moneyText(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function cleanTicketText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ticketTextWidth(printer = {}) {
  const paperWidth = Number(printer.ticketWidthMm || 80);
  const isWindowsDriver = printer.connectionMode === 'system';
  if (paperWidth === 58) return isWindowsDriver ? 31 : 32;
  return isWindowsDriver ? 38 : 42;
}

function ticketDate(value) {
  return new Intl.DateTimeFormat('es-SV', {
    timeZone: 'America/El_Salvador',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(new Date(value || Date.now()));
}

function orderModifierLines(item, includePrices = true) {
  const variants = Object.entries(item.variants || {}).map(([key, value]) => `${key}: ${value}`);
  const extras = (item.extras || []).map((extra) => {
    const group = extra.groupName ? `${extra.groupName}: ` : '+ ';
    const price = includePrices && extra.priceCents ? ` ${moneyText(extra.priceCents)}` : '';
    return `${group}${extra.name}${price}`;
  });
  const notes = item.notes ? [`Nota: ${item.notes}`] : [];
  return [...variants, ...extras, ...notes].filter(Boolean);
}

function textLine(char = '-', width = 42) {
  return char.repeat(width);
}

function centerTicketText(value, width) {
  const text = cleanTicketText(value).slice(0, width);
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  return `${' '.repeat(left)}${text}`;
}

function wrapTicketText(value, width, indent = 0) {
  const text = cleanTicketText(value);
  if (!text) return [];
  const prefix = ' '.repeat(indent);
  const available = Math.max(8, width - indent);
  const lines = [];
  let current = '';

  for (const word of text.split(' ')) {
    if (!word) continue;
    if (word.length > available) {
      if (current) {
        lines.push(`${prefix}${current}`);
        current = '';
      }
      for (let index = 0; index < word.length; index += available) {
        lines.push(`${prefix}${word.slice(index, index + available)}`);
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > available) {
      lines.push(`${prefix}${current}`);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(`${prefix}${current}`);
  return lines;
}

function pushWrappedTicketText(lines, value, width, indent = 0) {
  lines.push(...wrapTicketText(value, width, indent));
}

function ticketAmountLines(label, amount, width) {
  const left = cleanTicketText(label);
  const right = cleanTicketText(amount);
  if (!right) return wrapTicketText(left, width);
  if (left.length + right.length + 1 <= width) {
    return [`${left}${' '.repeat(width - left.length - right.length)}${right}`];
  }
  const leftWidth = Math.max(8, width - right.length - 1);
  const lines = wrapTicketText(left, leftWidth);
  const last = lines.pop() || '';
  const gap = Math.max(1, width - last.length - right.length);
  return [...lines, `${last}${' '.repeat(gap)}${right}`];
}

function pushTicketAmount(lines, label, amount, width) {
  lines.push(...ticketAmountLines(label, amount, width));
}

function customerVisibleNotes(order) {
  const notes = cleanTicketText(order.notes);
  if (!notes || /^Pedido creado en kiosko de autoservicio\.?$/i.test(notes)) return '';
  return notes;
}

function buildTicketText(order, { type = 'payment', printer = {} } = {}) {
  const business = getBusiness();
  const isKitchen = type === 'kitchen';
  const width = ticketTextWidth(printer);
  const lines = [
    centerTicketText(isKitchen ? 'PEDIDO COCINA' : business.name, width),
    centerTicketText(isKitchen ? `COMANDA ${order.orderNumber}` : `TICKET ${order.orderNumber}`, width),
    centerTicketText(ticketDate(order.createdAt), width),
    textLine('=', width)
  ];

  pushWrappedTicketText(lines, `Cliente: ${order.customer.name}`, width);
  if (!isKitchen) pushWrappedTicketText(lines, `Telefono: ${order.customer.phone}`, width);
  if (order.tableLabel) pushWrappedTicketText(lines, `Mesa/ref: ${order.tableLabel}`, width);
  pushWrappedTicketText(lines, `Entrega: ${order.deliveryMethod.name}`, width);
  if (!isKitchen) pushWrappedTicketText(lines, `Pago: ${order.paymentMethod.name}`, width);
  lines.push(textLine('-', width));

  for (const item of order.items || []) {
    if (isKitchen) {
      pushWrappedTicketText(lines, `${item.quantity} x ${item.productName}`, width);
    } else {
      pushTicketAmount(lines, `${item.quantity} x ${item.productName}`, moneyText(item.lineTotalCents), width);
    }
    for (const modifier of orderModifierLines(item, !isKitchen)) {
      pushWrappedTicketText(lines, `- ${modifier}`, width, 2);
    }
    lines.push('');
  }

  const visibleNotes = customerVisibleNotes(order);
  if (visibleNotes) {
    lines.push(textLine('-', width), 'Notas generales:');
    pushWrappedTicketText(lines, visibleNotes, width, 2);
  }

  if (!isKitchen) {
    lines.push(textLine('=', width));
    pushTicketAmount(lines, 'Subtotal', moneyText(order.subtotalCents), width);
    if (order.discountCents) pushTicketAmount(lines, 'Descuento', `-${moneyText(order.discountCents)}`, width);
    pushTicketAmount(lines, 'Delivery', moneyText(order.deliveryFeeCents), width);
    lines.push(textLine('-', width));
    pushTicketAmount(lines, 'TOTAL', moneyText(order.totalCents), width);
  }

  lines.push(textLine('=', width), centerTicketText(`Estado: ${order.status}`, width));
  return `${lines.filter((line) => line !== '').join('\n')}\n\n`;
}

function buildOrderNumberText(order, printer = {}) {
  const business = getBusiness();
  const width = ticketTextWidth(printer);
  return [
    centerTicketText(business.name, width),
    centerTicketText('NUMERO DE ORDEN', width),
    textLine('=', width),
    '',
    centerTicketText(order.orderNumber, width),
    '',
    ...wrapTicketText(`Cliente: ${order.customer.name}`, width),
    ...(order.tableLabel ? wrapTicketText(`Mesa/ref: ${order.tableLabel}`, width) : []),
    centerTicketText(ticketDate(order.createdAt), width),
    textLine('-', width),
    '',
    ...wrapTicketText('Conserva este numero para retirar tu pedido.', width),
    ''
  ].filter(Boolean).join('\n');
}

function escposBase64(text) {
  return Buffer.concat([
    Buffer.from([0x1b, 0x40, 0x1b, 0x61, 0x00, 0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x00]),
    Buffer.from(text, 'utf8'),
    Buffer.from('\n\n\n', 'utf8'),
    Buffer.from([0x1d, 0x56, 0x00])
  ]).toString('base64');
}

function zplSafe(value) {
  return String(value ?? '')
    .replace(/\^/g, ' ')
    .replace(/~/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .slice(0, 90);
}

function labelItemsForOrder(order, business) {
  const slugs = new Set((business.printerConfig.labelDrinkCategorySlugs || []).map((slug) => String(slug).toLowerCase()));
  const products = new Map(getMenu({}).products.map((product) => [Number(product.id), product]));
  return (order.items || [])
    .map((item) => {
      const product = products.get(Number(item.productId));
      return { item, product };
    })
    .filter(({ product }) => product && slugs.has(String(product.categorySlug || '').toLowerCase()))
    .flatMap(({ item, product }) => {
      const labels = [];
      for (let index = 0; index < Number(item.quantity || 1); index += 1) {
        labels.push({
          orderNumber: order.orderNumber,
          customerName: order.customer.name,
          tableLabel: order.tableLabel,
          productName: item.productName,
          categoryName: product.categoryName || 'Bebida',
          unitIndex: index + 1,
          quantity: Number(item.quantity || 1),
          modifiers: orderModifierLines(item, false)
        });
      }
      return labels;
    });
}

function buildLabelsText(labels) {
  return labels.map((label, index) => [
    `Etiqueta ${index + 1}/${labels.length}`,
    `Pedido ${label.orderNumber}`,
    label.productName,
    `${label.customerName}${label.tableLabel ? ` - ${label.tableLabel}` : ''}`,
    label.quantity > 1 ? `Unidad ${label.unitIndex}/${label.quantity}` : '',
    ...(label.modifiers.length ? label.modifiers.map((modifier) => `- ${modifier}`) : ['Sin modificaciones']),
    ''
  ].filter(Boolean).join('\n')).join('\n');
}

function buildLabelsZpl(labels) {
  return labels.map((label, index) => {
    const modifiers = (label.modifiers.length ? label.modifiers : ['Sin modificaciones']).slice(0, 5);
    return `^XA
^PW406
^LL203
^FO18,12^A0N,22,22^FD${zplSafe(label.orderNumber)}^FS
^FO300,12^A0N,18,18^FD${index + 1}/${labels.length}^FS
^FO18,42^A0N,25,25^FD${zplSafe(label.productName)}^FS
^FO18,72^A0N,16,16^FD${zplSafe(label.customerName)}${label.tableLabel ? ` - ${zplSafe(label.tableLabel)}` : ''}^FS
${modifiers.map((modifier, modifierIndex) => `^FO18,${96 + modifierIndex * 18}^A0N,15,15^FD${zplSafe(modifier)}^FS`).join('\n')}
^FO18,184^A0N,13,13^FD${zplSafe(label.categoryName)}${label.quantity > 1 ? ` ${label.unitIndex}/${label.quantity}` : ''}^FS
^XZ`;
  }).join('\n');
}

function printerUsesAgent(printer) {
  if (!printer?.enabled) return false;
  if (printer.connectionMode === 'system') return Boolean(printer.systemPrinterName);
  if (printer.connectionMode === 'network') return Boolean(printer.networkHost);
  return false;
}

function isKioskOrder(order) {
  return /kiosko|autoservicio/i.test(`${order.notes || ''} ${order.customer?.phone || ''}`);
}

function buildPrintJobPayload(order, role, printer, business) {
  if (role === 'cocina') {
    const plainText = buildTicketText(order, { type: 'kitchen', printer });
    return { title: `Cocina ${order.orderNumber}`, plainText, rawFormat: 'escpos', rawBase64: escposBase64(plainText) };
  }
  if (role === 'kiosk') {
    const plainText = buildOrderNumberText(order, printer);
    return { title: `Numero ${order.orderNumber}`, plainText, rawFormat: 'escpos', rawBase64: escposBase64(plainText) };
  }
  if (role === 'etiquetas') {
    const labels = labelItemsForOrder(order, business);
    if (!labels.length) return null;
    const zpl = buildLabelsZpl(labels);
    return {
      title: `Etiquetas ${order.orderNumber}`,
      plainText: buildLabelsText(labels),
      rawFormat: 'zpl',
      rawBase64: Buffer.from(zpl, 'utf8').toString('base64'),
      labels
    };
  }
  const plainText = buildTicketText(order, { type: 'payment', printer });
  return { title: `Ticket ${order.orderNumber}`, plainText, rawFormat: 'escpos', rawBase64: escposBase64(plainText) };
}

function enqueuePrintJobsForOrder(order, { roles = null, trigger = 'order.created' } = {}) {
  const business = getBusiness();
  const printers = business.printerConfig?.printers || {};
  const wantedRoles = roles || ['cocina', 'etiquetas', ...(isKioskOrder(order) ? ['kiosk'] : [])];
  const jobs = [];
  for (const role of wantedRoles) {
    const printer = printers[role];
    if (!printerUsesAgent(printer)) continue;
    if (role === 'kiosk' && !isKioskOrder(order) && !roles) continue;
    const payload = buildPrintJobPayload(order, role, printer, business);
    if (!payload) continue;
    jobs.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      role,
      jobType: role === 'etiquetas' ? 'labels' : 'ticket',
      printerConfig: printer,
      payload: { ...payload, trigger }
    });
  }
  return createPrintJobs(jobs);
}

function readBearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
}

function requirePrintAgent(req) {
  if (!printAgentToken) throw new ValidationError('PRINT_AGENT_TOKEN no esta configurado en el servidor.', 503);
  const token = String(req.headers['x-print-agent-token'] || readBearerToken(req) || '');
  if (token !== printAgentToken) throw new ValidationError('Token de agente de impresion invalido.', 401);
}

function cleanOrderForPublic(order, { includeRelated = true } = {}) {
  if (!order) return null;
  const business = getBusiness();
  const etaMinutes = order.deliveryMethod.slug === 'delivery'
    ? business.prepDeliveryMinutes
    : order.deliveryMethod.slug === 'comer-en-local'
      ? business.prepDineinMinutes
      : business.prepPickupMinutes;
  const whatsappPhone = business.whatsappPhone.replace(/\D/g, '');
  const whatsappMessage = formatOrderForWhatsApp(order);
  const publicOrder = {
    orderNumber: order.orderNumber,
    status: order.status,
    etaMinutes,
    whatsappUrl: whatsappPhone ? `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(whatsappMessage)}` : '',
    tableLabel: order.tableLabel,
    paymentStatus: order.paymentStatus,
    discountCents: order.discountCents,
    couponCode: order.couponCode,
    total: order.total,
    totalCents: order.totalCents,
    deliveryMethod: order.deliveryMethod,
    paymentMethod: order.paymentMethod,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    history: order.history.map((entry) => ({
      status: entry.status,
      createdAt: entry.createdAt
    })),
    items: order.items.map((item) => ({
      productName: item.productName,
      quantity: item.quantity,
      variants: item.variants,
      extras: item.extras,
      lineTotal: item.lineTotal
    }))
  };
  if (includeRelated) {
    publicOrder.relatedOrders = listOrdersByCustomerPhone(order.customer.phone, { limit: 8 })
      .map((relatedOrder) => cleanOrderForPublic(relatedOrder, { includeRelated: false }));
  }
  return publicOrder;
}

function withAdminOrderLinks(order) {
  if (!order) return order;
  const business = getBusiness();
  const etaMinutes = order.deliveryMethod.slug === 'delivery'
    ? business.prepDeliveryMinutes
    : order.deliveryMethod.slug === 'comer-en-local'
      ? business.prepDineinMinutes
      : business.prepPickupMinutes;
  return {
    ...order,
    etaMinutes,
    whatsappStatusUrl: whatsappStatusUrl(order, getBusiness())
  };
}

function queueWhatsAppStatusNotification(req, order, userId) {
  const business = getBusiness();
  sendWhatsAppStatus(order, business)
    .then((result) => {
      if (result.skipped) return;
      audit(
        req,
        result.sent ? 'notifications.whatsapp_status_sent' : 'notifications.whatsapp_status_failed',
        'order',
        order.id,
        { orderNumber: order.orderNumber, status: order.status, reason: result.reason || '' },
        userId
      );
      if (!result.sent) {
        console.warn('WhatsApp status notification failed:', result.reason);
      }
      notificationLog({
        orderId: order.id,
        channel: 'whatsapp',
        recipient: order.customer.phone,
        template: `status.${order.status}`,
        status: result.sent ? 'sent' : 'failed',
        message: result.reason || '',
        response: result.response || {}
      });
    })
    .catch((error) => {
      audit(req, 'notifications.whatsapp_status_failed', 'order', order.id, {
        orderNumber: order.orderNumber,
        status: order.status,
        reason: error.message
      }, userId);
      console.warn('WhatsApp status notification failed:', error.message);
    });
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, app: 'QR Food POS MVP' });
  }

  if (req.method === 'GET' && pathname === '/api/public/menu') {
    return json(res, 200, getMenu({
      search: searchParams.get('search') || '',
      category: searchParams.get('category') || ''
    }));
  }

  if (req.method === 'GET' && pathname === '/api/public/checkout-options') {
    return json(res, 200, getCheckoutOptions());
  }

  if (req.method === 'GET' && pathname === '/api/public/order-status') {
    const order = getOrderByNumber(searchParams.get('order') || '');
    if (!order) throw new ValidationError('Pedido no encontrado.', 404);
    return json(res, 200, cleanOrderForPublic(order));
  }

  if (req.method === 'GET' && pathname === '/api/public/order-events') {
    const order = getOrderByNumber(searchParams.get('order') || '');
    if (!order) throw new ValidationError('Pedido no encontrado.', 404);
    return addOrderEventClient(req, res, order);
  }

  if (req.method === 'GET' && pathname.startsWith('/api/public/art/')) {
    const slug = path.basename(pathname).replace(/\.svg$/i, '');
    return send(res, 200, productArtSvg(slug), {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400'
    });
  }

  if (req.method === 'GET' && pathname === '/qr.svg') {
    const data = searchParams.get('data') || `${originFromRequest(req)}/menu`;
    return send(res, 200, qrSvg(data), {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    const order = createOrder(await readJson(req));
    audit(req, 'orders.created_public', 'order', order.id, { orderNumber: order.orderNumber, totalCents: order.totalCents });
    const printJobs = enqueuePrintJobsForOrder(order);
    if (printJobs.length) {
      audit(req, 'print.jobs_created_auto', 'order', order.id, {
        orderNumber: order.orderNumber,
        count: printJobs.length,
        roles: printJobs.map((job) => job.role)
      });
    }
    emitOrderEvent('order.created', order);
    const business = getBusiness();
    const message = formatOrderForWhatsApp(order);
    const phone = business.whatsappPhone.replace(/\D/g, '');
    return json(res, 201, {
      order: cleanOrderForPublic(order),
      whatsappUrl: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : ''
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req);
    let user;
    try {
      user = login(body.email, body.password);
    } catch (error) {
      audit(req, 'auth.login_failed', 'user', '', { email: body.email || '' });
      throw error;
    }
    const session = createSession(user.id);
    setCookie(res, sessionCookie(req, session.id));
    audit(req, 'auth.login_success', 'user', user.id, { email: user.email }, user.id);
    return json(res, 200, { user });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const cookies = parseCookies(req.headers.cookie || '');
    const context = getSessionContext(cookies.pos_session);
    deleteSession(cookies.pos_session);
    setCookie(res, sessionCookie(req, '', 0));
    audit(req, 'auth.logout', 'user', context?.user?.id || '', {}, context?.user?.id || null);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    return json(res, 200, { user: getRequestUser(req, res) });
  }

  if (pathname.startsWith('/api/print-agent')) {
    return handlePrintAgentApi(req, res, url);
  }

  if (pathname.startsWith('/api/admin')) {
    return handleAdminApi(req, res, url);
  }

  throw new ValidationError('Ruta no encontrada.', 404);
}

async function handlePrintAgentApi(req, res, url) {
  const { pathname } = url;
  requirePrintAgent(req);

  if (req.method === 'GET' && pathname === '/api/print-agent/health') {
    return json(res, 200, { ok: true, app: 'QR Food POS Print Agent API' });
  }

  if (req.method === 'POST' && pathname === '/api/print-agent/jobs/claim') {
    const body = await readJson(req);
    const jobs = claimPrintJobs({
      agentId: body.agentId || req.headers['x-print-agent-id'] || 'print-agent',
      limit: body.limit || 5
    });
    return json(res, 200, { jobs });
  }

  const completeMatch = pathname.match(/^\/api\/print-agent\/jobs\/(\d+)\/complete$/);
  if (req.method === 'POST' && completeMatch) {
    const body = await readJson(req);
    const job = completePrintJob(Number(completeMatch[1]), body.agentId || req.headers['x-print-agent-id'] || 'print-agent');
    return json(res, 200, { job });
  }

  const failMatch = pathname.match(/^\/api\/print-agent\/jobs\/(\d+)\/fail$/);
  if (req.method === 'POST' && failMatch) {
    const body = await readJson(req);
    const job = failPrintJob(
      Number(failMatch[1]),
      body.agentId || req.headers['x-print-agent-id'] || 'print-agent',
      body.error || 'Error de impresion'
    );
    return json(res, 200, { job });
  }

  throw new ValidationError('Ruta de agente no encontrada.', 404);
}

async function handleAdminApi(req, res, url) {
  const { pathname, searchParams } = url;
  const user = requireAuth(req, res);

  if (req.method === 'GET' && pathname === '/api/admin/events') {
    if (!userCan(user, 'orders:view') && !userCan(user, 'orders:kds') && !userCan(user, 'orders:view-assigned')) {
      throw new ValidationError('No tienes permisos para ver pedidos.', 403);
    }
    return addAdminEventClient(req, res, user);
  }

  if (req.method === 'GET' && pathname === '/api/admin/orders') {
    if (!userCan(user, 'orders:view') && !userCan(user, 'orders:kds') && !userCan(user, 'orders:view-assigned')) {
      throw new ValidationError('No tienes permisos para ver pedidos.', 403);
    }
    const orders = listOrders({
        status: searchParams.get('status') || 'all',
        search: searchParams.get('search') || '',
        kds: searchParams.get('kds') === '1'
      }).map(withAdminOrderLinks);
    return json(res, 200, { orders });
  }

  const orderMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (req.method === 'GET' && orderMatch) {
    requirePermission(user, 'orders:view');
    const order = getOrderById(Number(orderMatch[1]));
    if (!order) throw new ValidationError('Pedido no encontrado.', 404);
    return json(res, 200, { order: withAdminOrderLinks(order) });
  }

  const orderStatusMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
  if (req.method === 'PATCH' && orderStatusMatch) {
    const body = await readJson(req);
    if (!canChangeStatus(user, body.status)) throw new ValidationError('No puedes cambiar a ese estado.', 403);
    const order = updateOrderStatus(Number(orderStatusMatch[1]), body.status, user.id, body.note || '');
    audit(req, 'orders.status_updated', 'order', order.id, { orderNumber: order.orderNumber, status: body.status }, user.id);
    emitOrderEvent('order.updated', order);
    queueWhatsAppStatusNotification(req, order, user.id);
    return json(res, 200, {
      order: withAdminOrderLinks(order),
      whatsappUrl: whatsappStatusUrl(order, getBusiness())
    });
  }

  const orderAssignMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/assign$/);
  if (req.method === 'PATCH' && orderAssignMatch) {
    requirePermission(user, 'orders:update');
    const body = await readJson(req);
    const order = updateOrderAssignment(Number(orderAssignMatch[1]), body.assignedDeliveryUserId);
    audit(req, 'orders.delivery_assigned', 'order', order.id, { orderNumber: order.orderNumber, driverId: body.assignedDeliveryUserId }, user.id);
    emitOrderEvent('order.updated', order);
    return json(res, 200, { order: withAdminOrderLinks(order) });
  }

  const orderPaymentMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/payment$/);
  if (req.method === 'PATCH' && orderPaymentMatch) {
    if (!userCan(user, 'payments:update') && !userCan(user, 'orders:update')) requirePermission(user, '*');
    const order = updateOrderPayment(Number(orderPaymentMatch[1]), await readJson(req));
    audit(req, 'orders.payment_updated', 'order', order.id, { orderNumber: order.orderNumber, paymentStatus: order.paymentStatus }, user.id);
    emitOrderEvent('order.updated', order);
    return json(res, 200, { order: withAdminOrderLinks(order) });
  }

  const orderPrintMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/print-jobs$/);
  if (req.method === 'POST' && orderPrintMatch) {
    requirePermission(user, 'orders:view');
    const order = getOrderById(Number(orderPrintMatch[1]));
    if (!order) throw new ValidationError('Pedido no encontrado.', 404);
    const body = await readJson(req);
    const roles = Array.isArray(body.roles) && body.roles.length ? body.roles : ['caja'];
    const jobs = enqueuePrintJobsForOrder(order, { roles, trigger: 'manual.admin' });
    audit(req, 'print.jobs_created_manual', 'order', order.id, {
      orderNumber: order.orderNumber,
      count: jobs.length,
      roles
    }, user.id);
    return json(res, 201, { jobs });
  }

  if (req.method === 'GET' && pathname === '/api/admin/catalog') {
    if (!userCan(user, 'catalog:view')) requirePermission(user, '*');
    return json(res, 200, getAdminCatalog());
  }

  if (req.method === 'GET' && pathname === '/api/admin/inventory') {
    if (!userCan(user, 'catalog:view')) requirePermission(user, '*');
    return json(res, 200, getInventoryAdmin());
  }

  const inventoryMatch = pathname.match(/^\/api\/admin\/inventory\/products\/(\d+)$/);
  if (req.method === 'PATCH' && inventoryMatch) {
    requirePermission(user, '*');
    const product = updateProductInventory(Number(inventoryMatch[1]), await readJson(req));
    audit(req, 'catalog.inventory_updated', 'product', product.id, {
      name: product.name,
      stockQuantity: product.stockQuantity,
      stockEnabled: product.stockEnabled
    }, user.id);
    return json(res, 200, { product });
  }

  const recipeMatch = pathname.match(/^\/api\/admin\/inventory\/products\/(\d+)\/recipe$/);
  if (req.method === 'PATCH' && recipeMatch) {
    requirePermission(user, '*');
    const recipe = updateProductRecipe(Number(recipeMatch[1]), await readJson(req));
    audit(req, 'catalog.recipe_updated', 'product', recipeMatch[1], { items: recipe.length }, user.id);
    return json(res, 200, { recipe });
  }

  if (req.method === 'POST' && pathname === '/api/admin/inventory/items') {
    requirePermission(user, '*');
    const item = saveInventoryItem(await readJson(req));
    audit(req, 'inventory.item_created', 'inventory_item', item.id, { name: item.name }, user.id);
    return json(res, 201, { item });
  }

  const inventoryItemMatch = pathname.match(/^\/api\/admin\/inventory\/items\/(\d+)$/);
  if (req.method === 'PATCH' && inventoryItemMatch) {
    requirePermission(user, '*');
    const item = updateInventoryItem(Number(inventoryItemMatch[1]), await readJson(req));
    audit(req, 'inventory.item_updated', 'inventory_item', item.id, {
      name: item.name,
      stockQuantity: item.stockQuantity
    }, user.id);
    return json(res, 200, { item });
  }
  if (req.method === 'DELETE' && inventoryItemMatch) {
    requirePermission(user, '*');
    deleteInventoryItem(Number(inventoryItemMatch[1]));
    audit(req, 'inventory.item_deleted', 'inventory_item', inventoryItemMatch[1], {}, user.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/admin/products') {
    requirePermission(user, '*');
    const product = saveProduct(await readJson(req));
    audit(req, 'catalog.product_created', 'product', product.id, { name: product.name }, user.id);
    return json(res, 201, { product });
  }

  const productMatch = pathname.match(/^\/api\/admin\/products\/(\d+)$/);
  if (req.method === 'PATCH' && productMatch) {
    requirePermission(user, '*');
    const product = updateProduct(Number(productMatch[1]), await readJson(req));
    audit(req, 'catalog.product_updated', 'product', product.id, { name: product.name }, user.id);
    return json(res, 200, { product });
  }
  if (req.method === 'DELETE' && productMatch) {
    requirePermission(user, '*');
    deleteProduct(Number(productMatch[1]));
    audit(req, 'catalog.product_deleted', 'product', productMatch[1], {}, user.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/admin/uploads/images') {
    requirePermission(user, '*');
    const upload = await saveUploadedImage(req);
    audit(req, 'media.image_uploaded', 'image', upload.fileName, { bytes: upload.bytes, contentType: upload.contentType }, user.id);
    return json(res, 201, { upload });
  }

  if (req.method === 'GET' && pathname === '/api/admin/categories') {
    if (!userCan(user, 'catalog:view')) requirePermission(user, '*');
    return json(res, 200, { categories: listCategories(true) });
  }
  if (req.method === 'POST' && pathname === '/api/admin/categories') {
    requirePermission(user, '*');
    const category = saveCategory(await readJson(req));
    audit(req, 'catalog.category_created', 'category', category.id, { name: category.name }, user.id);
    return json(res, 201, { category });
  }

  const categoryMatch = pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (req.method === 'PATCH' && categoryMatch) {
    requirePermission(user, '*');
    const category = updateCategory(Number(categoryMatch[1]), await readJson(req));
    audit(req, 'catalog.category_updated', 'category', category.id, { name: category.name }, user.id);
    return json(res, 200, { category });
  }
  if (req.method === 'DELETE' && categoryMatch) {
    requirePermission(user, '*');
    deleteCategory(Number(categoryMatch[1]));
    audit(req, 'catalog.category_deleted', 'category', categoryMatch[1], {}, user.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/admin/extras') {
    if (!userCan(user, 'catalog:view')) requirePermission(user, '*');
    return json(res, 200, { extras: listExtras(true), optionalGroups: listOptionalGroups(true) });
  }
  if (req.method === 'POST' && pathname === '/api/admin/extras') {
    requirePermission(user, '*');
    const extra = saveExtra(await readJson(req));
    audit(req, 'catalog.extra_created', 'extra', extra.id, { name: extra.name, priceCents: extra.priceCents }, user.id);
    return json(res, 201, { extra });
  }

  const extraMatch = pathname.match(/^\/api\/admin\/extras\/(\d+)$/);
  if (req.method === 'PATCH' && extraMatch) {
    requirePermission(user, '*');
    const extra = updateExtra(Number(extraMatch[1]), await readJson(req));
    audit(req, 'catalog.extra_updated', 'extra', extra.id, { name: extra.name, priceCents: extra.priceCents, active: extra.active }, user.id);
    return json(res, 200, { extra });
  }
  if (req.method === 'DELETE' && extraMatch) {
    requirePermission(user, '*');
    deleteExtra(Number(extraMatch[1]));
    audit(req, 'catalog.extra_deleted', 'extra', extraMatch[1], {}, user.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/admin/optional-groups') {
    if (!userCan(user, 'catalog:view')) requirePermission(user, '*');
    return json(res, 200, { optionalGroups: listOptionalGroups(true) });
  }
  if (req.method === 'POST' && pathname === '/api/admin/optional-groups') {
    requirePermission(user, '*');
    const group = saveOptionalGroup(await readJson(req));
    audit(req, 'catalog.optional_group_created', 'optional_group', group.id, { name: group.name }, user.id);
    return json(res, 201, { group });
  }

  const optionalGroupMatch = pathname.match(/^\/api\/admin\/optional-groups\/(\d+)$/);
  if (req.method === 'PATCH' && optionalGroupMatch) {
    requirePermission(user, '*');
    const group = updateOptionalGroup(Number(optionalGroupMatch[1]), await readJson(req));
    audit(req, 'catalog.optional_group_updated', 'optional_group', group.id, { name: group.name }, user.id);
    return json(res, 200, { group });
  }
  if (req.method === 'DELETE' && optionalGroupMatch) {
    requirePermission(user, '*');
    deleteOptionalGroup(Number(optionalGroupMatch[1]));
    audit(req, 'catalog.optional_group_deleted', 'optional_group', optionalGroupMatch[1], {}, user.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/admin/optional-options') {
    requirePermission(user, '*');
    const option = saveOptionalOption(await readJson(req));
    audit(req, 'catalog.optional_option_created', 'optional_option', option.id, { name: option.name, groupId: option.groupId }, user.id);
    return json(res, 201, { option });
  }

  const optionalOptionMatch = pathname.match(/^\/api\/admin\/optional-options\/(\d+)$/);
  if (req.method === 'PATCH' && optionalOptionMatch) {
    requirePermission(user, '*');
    const option = updateOptionalOption(Number(optionalOptionMatch[1]), await readJson(req));
    audit(req, 'catalog.optional_option_updated', 'optional_option', option.id, { name: option.name, groupId: option.groupId }, user.id);
    return json(res, 200, { option });
  }
  if (req.method === 'DELETE' && optionalOptionMatch) {
    requirePermission(user, '*');
    deleteOptionalOption(Number(optionalOptionMatch[1]));
    audit(req, 'catalog.optional_option_deleted', 'optional_option', optionalOptionMatch[1], {}, user.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/admin/reports/export.csv') {
    requireAnyPermission(user, ['reports:export', 'reports:view']);
    const exportData = reportExport(searchParams.get('type') || 'sales-by-day');
    audit(req, 'reports.exported', 'report', searchParams.get('type') || 'sales-by-day', {}, user.id);
    return sendCsv(res, exportData.fileName, exportData.headers, exportData.rows);
  }

  if (req.method === 'GET' && pathname === '/api/admin/reports') {
    requirePermission(user, 'reports:view');
    return json(res, 200, getReports());
  }

  if (req.method === 'GET' && pathname === '/api/admin/accounting') {
    if (!userCanAny(user, ['accounting:view', 'cash:view', 'reports:view'])) requirePermission(user, '*');
    return json(res, 200, getAccounting());
  }
  if (req.method === 'POST' && pathname === '/api/admin/accounting/entries') {
    requirePermission(user, '*');
    const entry = saveAccountingEntry(await readJson(req), user.id);
    audit(req, 'accounting.entry_created', 'accounting_entry', entry.id, {
      type: entry.type,
      category: entry.category,
      amountCents: entry.amountCents
    }, user.id);
    return json(res, 201, { entry });
  }
  if (req.method === 'POST' && pathname === '/api/admin/accounting/cash-openings') {
    requireAnyPermission(user, ['cash:open', 'orders:update']);
    const cashRegister = saveCashOpening(await readJson(req), user.id);
    audit(req, 'accounting.cash_opened', 'cash_register_session', cashRegister.session?.id || '', {
      businessDate: cashRegister.businessDate,
      openingCashCents: cashRegister.session?.openingCashCents || 0
    }, user.id);
    return json(res, 201, { cashRegister });
  }
  if (req.method === 'POST' && pathname === '/api/admin/accounting/cash-closings') {
    requireAnyPermission(user, ['cash:close', 'orders:update']);
    const closing = saveCashClosing(await readJson(req), user.id);
    audit(req, 'accounting.cash_closed', 'cash_closing', closing.id, {
      businessDate: closing.businessDate,
      differenceCents: closing.differenceCents,
      archivedOrders: closing.archivedOrders || 0
    }, user.id);
    return json(res, 201, { closing });
  }
  if (req.method === 'POST' && pathname === '/api/admin/accounting/purchases') {
    requirePermission(user, '*');
    const purchase = saveSupplierPurchase(await readJson(req), user.id);
    audit(req, 'accounting.purchase_created', 'supplier_purchase', purchase.id, {
      supplierName: purchase.supplierName,
      totalCents: purchase.totalCents,
      items: purchase.items.length
    }, user.id);
    return json(res, 201, { purchase });
  }
  if (req.method === 'POST' && pathname === '/api/admin/accounting/waste') {
    requirePermission(user, '*');
    const waste = saveWasteLog(await readJson(req), user.id);
    audit(req, 'accounting.waste_logged', 'waste_log', waste.id, {
      itemName: waste.itemName,
      quantity: waste.quantity,
      costCents: waste.costCents
    }, user.id);
    return json(res, 201, { waste });
  }
  const accountingEntryMatch = pathname.match(/^\/api\/admin\/accounting\/entries\/(\d+)$/);
  if (req.method === 'DELETE' && accountingEntryMatch) {
    requirePermission(user, '*');
    deleteAccountingEntry(Number(accountingEntryMatch[1]));
    audit(req, 'accounting.entry_deleted', 'accounting_entry', accountingEntryMatch[1], {}, user.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/admin/promotions') {
    if (!userCan(user, 'catalog:view')) requirePermission(user, '*');
    return json(res, 200, { promotions: listPromotions() });
  }
  if (req.method === 'POST' && pathname === '/api/admin/promotions') {
    requirePermission(user, '*');
    const promotion = savePromotion(await readJson(req));
    audit(req, 'sales.promotion_created', 'promotion', promotion.id, { code: promotion.code }, user.id);
    return json(res, 201, { promotion });
  }
  const promotionMatch = pathname.match(/^\/api\/admin\/promotions\/(\d+)$/);
  if (req.method === 'PATCH' && promotionMatch) {
    requirePermission(user, '*');
    const promotion = updatePromotion(Number(promotionMatch[1]), await readJson(req));
    audit(req, 'sales.promotion_updated', 'promotion', promotion.id, { code: promotion.code, active: promotion.active }, user.id);
    return json(res, 200, { promotion });
  }
  if (req.method === 'DELETE' && promotionMatch) {
    requirePermission(user, '*');
    deletePromotion(Number(promotionMatch[1]));
    audit(req, 'sales.promotion_deleted', 'promotion', promotionMatch[1], {}, user.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/admin/delivery') {
    if (!userCan(user, 'delivery:view') && !userCan(user, 'orders:view')) requirePermission(user, '*');
    return json(res, 200, getDeliveryAdmin());
  }
  if (req.method === 'POST' && pathname === '/api/admin/delivery/zones') {
    requirePermission(user, '*');
    const zone = saveDeliveryZone(await readJson(req));
    audit(req, 'delivery.zone_created', 'delivery_zone', zone.id, { name: zone.name }, user.id);
    return json(res, 201, { zone });
  }
  const deliveryZoneMatch = pathname.match(/^\/api\/admin\/delivery\/zones\/(\d+)$/);
  if (req.method === 'PATCH' && deliveryZoneMatch) {
    requirePermission(user, '*');
    const zone = updateDeliveryZone(Number(deliveryZoneMatch[1]), await readJson(req));
    audit(req, 'delivery.zone_updated', 'delivery_zone', zone.id, { name: zone.name, active: zone.active }, user.id);
    return json(res, 200, { zone });
  }
  const deliveryMethodMatch = pathname.match(/^\/api\/admin\/delivery\/methods\/(\d+)$/);
  if (req.method === 'PATCH' && deliveryMethodMatch) {
    requirePermission(user, '*');
    const method = updateDeliveryMethod(Number(deliveryMethodMatch[1]), await readJson(req));
    audit(req, 'delivery.method_updated', 'delivery_method', method.id, { name: method.name, active: method.active }, user.id);
    return json(res, 200, { method });
  }

  if (req.method === 'GET' && pathname === '/api/admin/settings') {
    requireAnyPermission(user, ['settings:view', 'settings:update']);
    return json(res, 200, { business: getBusiness(), options: getCheckoutOptions(), branches: listBranches() });
  }
  if (req.method === 'GET' && pathname === '/api/admin/system-health') {
    requireAnyPermission(user, ['settings:view', 'audit:view', 'reports:view']);
    return json(res, 200, productionChecklist(req));
  }
  if (req.method === 'GET' && pathname === '/api/admin/printers/detected') {
    requireAnyPermission(user, ['settings:update']);
    const result = await detectConnectedPrinters();
    audit(req, 'settings.printers_detected', 'business', 1, {
      platform: result.platform,
      source: result.source,
      count: result.printers.length
    }, user.id);
    return json(res, 200, result);
  }
  if (req.method === 'GET' && pathname === '/api/admin/print-jobs') {
    requireAnyPermission(user, ['settings:view', 'audit:view']);
    return json(res, 200, {
      jobs: listPrintJobs({
        status: searchParams.get('status') || '',
        limit: Number(searchParams.get('limit') || 80)
      })
    });
  }
  if (req.method === 'PATCH' && pathname === '/api/admin/settings') {
    requireAnyPermission(user, ['settings:update']);
    const business = updateBusiness(await readJson(req));
    audit(req, 'settings.business_updated', 'business', business.id, { name: business.name }, user.id);
    return json(res, 200, { business });
  }

  if (req.method === 'GET' && pathname === '/api/admin/users') {
    requireAnyPermission(user, ['users:manage']);
    return json(res, 200, { users: listUsers(), roles: listRoles() });
  }
  if (req.method === 'POST' && pathname === '/api/admin/users') {
    requireAnyPermission(user, ['users:manage']);
    const savedUser = saveUser(await readJson(req));
    audit(req, 'users.created', 'user', savedUser.id, { email: savedUser.email, roleName: savedUser.roleName }, user.id);
    return json(res, 201, { user: savedUser });
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (req.method === 'PATCH' && userMatch) {
    requireAnyPermission(user, ['users:manage']);
    const userId = Number(userMatch[1]);
    const body = await readJson(req);
    if (userId === user.id && body.active === false) {
      throw new ValidationError('No puedes desactivar tu propio usuario.', 400);
    }
    const savedUser = updateUser(userId, body);
    audit(req, 'users.updated', 'user', savedUser.id, { email: savedUser.email, roleName: savedUser.roleName, active: savedUser.active }, user.id);
    return json(res, 200, { user: savedUser });
  }

  const roleMatch = pathname.match(/^\/api\/admin\/roles\/(\d+)$/);
  if (req.method === 'PATCH' && roleMatch) {
    requireAnyPermission(user, ['roles:manage', 'users:manage']);
    const role = updateRole(Number(roleMatch[1]), await readJson(req));
    audit(req, 'roles.updated', 'role', role.id, { name: role.name, permissions: role.permissions }, user.id);
    return json(res, 200, { role });
  }

  if (req.method === 'GET' && pathname === '/api/admin/audit/export.csv') {
    requireAnyPermission(user, ['audit:view']);
    const rows = listAuditLogs({ action: searchParams.get('action') || '', limit: 1000 });
    audit(req, 'audit.exported', 'audit_log', '', { rows: rows.length }, user.id);
    return sendCsv(res, 'auditoria.csv', [
      { key: 'createdAt', label: 'Fecha' },
      { key: 'userName', label: 'Usuario' },
      { key: 'userEmail', label: 'Email' },
      { key: 'action', label: 'Accion' },
      { key: 'entityType', label: 'Entidad' },
      { key: 'entityId', label: 'ID entidad' },
      { key: 'ipAddress', label: 'IP' },
      { key: 'userAgent', label: 'Navegador' }
    ], rows);
  }

  if (req.method === 'GET' && pathname === '/api/admin/audit') {
    requireAnyPermission(user, ['audit:view']);
    return json(res, 200, {
      auditLogs: listAuditLogs({
        action: searchParams.get('action') || '',
        userId: searchParams.get('userId') || null,
        limit: Number(searchParams.get('limit') || 120)
      })
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/backups') {
    requireAnyPermission(user, ['backups:view', 'audit:view']);
    return json(res, 200, { backups: listBackups(), notifications: listNotificationLogs() });
  }

  const backupDownloadMatch = pathname.match(/^\/api\/admin\/backups\/([^/]+)$/);
  if (req.method === 'GET' && backupDownloadMatch) {
    requireAnyPermission(user, ['backups:download', 'backups:view']);
    const fileName = path.basename(backupDownloadMatch[1]);
    const backup = listBackups().find((item) => item.fileName === fileName);
    if (!backup) throw new ValidationError('Backup no encontrado.', 404);
    return sendFile(res, path.join(backupDir, fileName), 'application/octet-stream', {
      'Content-Disposition': `attachment; filename="${fileName}"`
    });
  }

  if (req.method === 'POST' && pathname === '/api/admin/backups') {
    requireAnyPermission(user, ['backups:create']);
    const backup = createBackup('manual');
    audit(req, 'system.backup_created', 'backup', backup.fileName, { bytes: backup.bytes, automatic: false }, user.id);
    return json(res, 201, { backup });
  }

  throw new ValidationError('Ruta administrativa no encontrada.', 404);
}

function originFromRequest(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `localhost:${port}`;
  return process.env.APP_URL || `${protocol}://${host}`;
}

function serveStatic(req, res, url) {
  const routeMap = {
    '/': 'index.html',
    '/menu': 'menu.html',
    '/kiosk': 'kiosk.html',
    '/checkout': 'checkout.html',
    '/status': 'status.html',
    '/closed': 'closed.html',
    '/admin': 'admin/index.html',
    '/admin/orders': 'admin/index.html',
    '/admin/kds': 'admin/index.html',
    '/admin/products': 'admin/index.html',
    '/admin/categories': 'admin/index.html',
    '/admin/extras': 'admin/index.html',
    '/admin/inventory': 'admin/index.html',
    '/admin/promotions': 'admin/index.html',
    '/admin/delivery': 'admin/index.html',
    '/admin/reports': 'admin/index.html',
    '/admin/accounting': 'admin/index.html',
    '/admin/settings': 'admin/index.html',
    '/admin/audit': 'admin/index.html',
    '/admin/users': 'admin/index.html',
    '/admin/login': 'admin/login.html'
  };
  const requested = routeMap[url.pathname] || decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const resolved = path.resolve(publicDir, requested);
  if (!resolved.startsWith(publicDir)) throw new ValidationError('Ruta invalida.', 400);
  if (!existsSync(resolved)) throw new ValidationError('Archivo no encontrado.', 404);
  const ext = path.extname(resolved).toLowerCase();
  sendFile(res, resolved, mimeTypes[ext] || 'application/octet-stream');
}

function sendFile(res, filePath, contentType, headers = {}) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...headers
  });
  createReadStream(filePath).pipe(res);
}

function productArtSvg(slug) {
  const palettes = {
    'taro-milk-tea': ['#7651a8', '#f5d7ff', '#2f2640'],
    'brown-sugar-boba': ['#8f4c20', '#ffd8a8', '#3b2316'],
    'mango-smoothie': ['#f6a21a', '#fff0b8', '#2f5f3f'],
    'iced-caramel-latte': ['#c77a3b', '#f6ead8', '#3a2619'],
    'strawberry-refresher': ['#ef4e67', '#ffd6de', '#294d43'],
    'crispy-chicken-sandwich': ['#d85a33', '#ffe2a8', '#4d2b17'],
    'cheesecake-cup': ['#e7b84d', '#fff2c8', '#593f2a'],
    'combo-boba-snack': ['#146e43', '#fce9c0', '#2b2b2b'],
    logo: ['#146e43', '#fce9c0', '#2b2b2b']
  };
  const [primary, light, dark] = palettes[slug] || ['#146e43', '#fff8e8', '#2b2b2b'];
  if (slug === 'logo') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
      <rect width="320" height="320" rx="72" fill="${dark}"/>
      <circle cx="160" cy="142" r="86" fill="${primary}"/>
      <path d="M100 143c24 42 92 42 120 0v74c0 25-20 45-45 45h-30c-25 0-45-20-45-45z" fill="${light}"/>
      <circle cx="132" cy="170" r="13" fill="${dark}"/><circle cx="184" cy="170" r="13" fill="${dark}"/>
      <path d="M196 56h40" stroke="${light}" stroke-width="18" stroke-linecap="round"/>
      <text x="160" y="292" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" font-weight="800" fill="${light}">LONG CHA</text>
    </svg>`;
  }
  const food = slug.includes('sandwich') || slug.includes('combo');
  const dessert = slug.includes('cheesecake');
  const mainShape = food
    ? `<path d="M56 178c18-54 190-55 208 0 6 19-11 35-34 35H90c-23 0-40-16-34-35z" fill="${light}"/>
       <path d="M74 192h172v32c0 21-18 38-40 38h-92c-22 0-40-17-40-38z" fill="${primary}"/>
       <path d="M90 158c28-36 111-53 144-5" stroke="${dark}" stroke-width="16" stroke-linecap="round" fill="none"/>`
    : dessert
      ? `<path d="M92 116h136l-17 142H109z" fill="${light}"/><path d="M102 156h116l-12 93h-92z" fill="${primary}"/><path d="M95 112c20-38 104-38 130 0" fill="${primary}"/>`
      : `<path d="M104 88h112l-15 178h-82z" fill="${light}"/><path d="M115 142h90l-10 107h-70z" fill="${primary}"/><path d="M130 72h96" stroke="${dark}" stroke-width="14" stroke-linecap="round"/><path d="M195 72l30-40" stroke="${dark}" stroke-width="12" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
    <defs><linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${light}"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>
    <rect width="320" height="320" rx="34" fill="url(#bg)"/>
    <circle cx="248" cy="72" r="34" fill="${primary}" opacity=".18"/>
    <circle cx="78" cy="250" r="42" fill="${primary}" opacity=".14"/>
    ${mainShape}
    <g fill="${dark}" opacity=".9">
      <circle cx="130" cy="228" r="9"/><circle cx="158" cy="246" r="9"/><circle cx="184" cy="225" r="9"/>
    </g>
  </svg>`;
}

async function appHandler(req, res) {
  try {
    const url = new URL(req.url || '/', originFromRequest(req));
    if (shouldRedirectToHttps(req)) {
      redirectToHttps(req, res);
      return;
    }
    if (url.pathname.startsWith('/api/')) enforceRateLimit(req, res, url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/qr.svg') {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/uploads/')) {
      serveUploadedImage(res, url.pathname);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    if (error instanceof ValidationError) {
      json(res, error.status, { error: error.message });
      return;
    }
    console.error(error);
    json(res, 500, { error: 'Error interno del servidor.' });
  }
}

function getHttpsOptions() {
  const keyPath = process.env.HTTPS_KEY_PATH;
  const certPath = process.env.HTTPS_CERT_PATH;
  if (!keyPath || !certPath) return null;
  return {
    key: readFileSync(path.resolve(keyPath)),
    cert: readFileSync(path.resolve(certPath))
  };
}

const httpsOptions = getHttpsOptions();
const server = httpsOptions ? https.createServer(httpsOptions, appHandler) : http.createServer(appHandler);

server.listen(port, () => {
  scheduleBackups();
  const protocol = httpsOptions ? 'https' : 'http';
  console.log(`QR Food POS MVP listo en ${protocol}://localhost:${port}`);
});
