import http from 'node:http';
import https from 'node:https';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ValidationError,
  auditLog,
  createOrder,
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
  listPromotions,
  listRoles,
  listUsers,
  login,
  notificationLog,
  saveCashClosing,
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

function canChangeStatus(user, status) {
  return (
    userCan(user, 'orders:update') ||
    (status === 'Listo' && userCan(user, 'orders:update-ready')) ||
    (status === 'Entregado' && userCan(user, 'orders:update-delivered'))
  );
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

  if (pathname.startsWith('/api/admin')) {
    return handleAdminApi(req, res, url);
  }

  throw new ValidationError('Ruta no encontrada.', 404);
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

  if (req.method === 'GET' && pathname === '/api/admin/reports') {
    requirePermission(user, 'reports:view');
    return json(res, 200, getReports());
  }

  if (req.method === 'GET' && pathname === '/api/admin/accounting') {
    if (!userCan(user, 'reports:view')) requirePermission(user, '*');
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
  if (req.method === 'POST' && pathname === '/api/admin/accounting/cash-closings') {
    requirePermission(user, '*');
    const closing = saveCashClosing(await readJson(req), user.id);
    audit(req, 'accounting.cash_closed', 'cash_closing', closing.id, {
      businessDate: closing.businessDate,
      differenceCents: closing.differenceCents
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
    requirePermission(user, '*');
    return json(res, 200, { business: getBusiness(), options: getCheckoutOptions(), branches: listBranches() });
  }
  if (req.method === 'PATCH' && pathname === '/api/admin/settings') {
    requirePermission(user, '*');
    const business = updateBusiness(await readJson(req));
    audit(req, 'settings.business_updated', 'business', business.id, { name: business.name }, user.id);
    return json(res, 200, { business });
  }

  if (req.method === 'GET' && pathname === '/api/admin/users') {
    requirePermission(user, '*');
    return json(res, 200, { users: listUsers(), roles: listRoles() });
  }
  if (req.method === 'POST' && pathname === '/api/admin/users') {
    requirePermission(user, '*');
    const savedUser = saveUser(await readJson(req));
    audit(req, 'users.created', 'user', savedUser.id, { email: savedUser.email, roleName: savedUser.roleName }, user.id);
    return json(res, 201, { user: savedUser });
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (req.method === 'PATCH' && userMatch) {
    requirePermission(user, '*');
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
    requirePermission(user, '*');
    const role = updateRole(Number(roleMatch[1]), await readJson(req));
    audit(req, 'roles.updated', 'role', role.id, { name: role.name, permissions: role.permissions }, user.id);
    return json(res, 200, { role });
  }

  if (req.method === 'GET' && pathname === '/api/admin/audit') {
    requirePermission(user, '*');
    return json(res, 200, {
      auditLogs: listAuditLogs({
        action: searchParams.get('action') || '',
        userId: searchParams.get('userId') || null,
        limit: Number(searchParams.get('limit') || 120)
      })
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/backups') {
    requirePermission(user, '*');
    return json(res, 200, { backups: listBackups(), notifications: listNotificationLogs() });
  }

  const backupDownloadMatch = pathname.match(/^\/api\/admin\/backups\/([^/]+)$/);
  if (req.method === 'GET' && backupDownloadMatch) {
    requirePermission(user, '*');
    const fileName = path.basename(backupDownloadMatch[1]);
    const backup = listBackups().find((item) => item.fileName === fileName);
    if (!backup) throw new ValidationError('Backup no encontrado.', 404);
    return sendFile(res, path.join(backupDir, fileName), 'application/octet-stream', {
      'Content-Disposition': `attachment; filename="${fileName}"`
    });
  }

  if (req.method === 'POST' && pathname === '/api/admin/backups') {
    requirePermission(user, '*');
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
