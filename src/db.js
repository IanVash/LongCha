import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
mkdirSync(dataDir, { recursive: true });

export const databasePath = path.join(dataDir, 'restaurant_mvp.sqlite');
export const db = new DatabaseSync(databasePath);

export const ORDER_STATUSES = [
  'Nuevo',
  'Aceptado',
  'En preparacion',
  'Listo',
  'En camino',
  'Entregado',
  'Cancelado'
];

const ROLE_PERMISSIONS = {
  Administrador: ['*'],
  Cajero: ['orders:view', 'orders:update', 'orders:charge', 'reports:view'],
  Cocina: ['orders:view', 'orders:kds', 'orders:update-ready'],
  Repartidor: ['orders:view-assigned', 'orders:update-delivered'],
  Supervisor: ['orders:view', 'reports:view', 'catalog:view']
};

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const nowIso = () => new Date().toISOString();
const cents = (value) => Math.round(Number(value || 0) * 100);
const money = (value) => Number((Number(value || 0) / 100).toFixed(2));
const clean = (value, max = 255) => String(value ?? '').trim().slice(0, max);
const boolInt = (value) => (value ? 1 : 0);

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function slugify(value) {
  return clean(value, 120)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || crypto.randomBytes(4).toString('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, originalHash] = String(stored || '').split(':');
  if (!salt || !originalHash) return false;
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
}

export function initDatabase() {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      permissions_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      last_rotated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS business (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      logo_url TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      whatsapp_phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'USD',
      timezone TEXT NOT NULL DEFAULT 'America/El_Salvador',
      is_open_manual INTEGER NOT NULL DEFAULT 1,
      allow_orders_outside_hours INTEGER NOT NULL DEFAULT 0,
      closed_message TEXT DEFAULT 'Estamos cerrados en este momento.',
      hours_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      base_price_cents INTEGER NOT NULL DEFAULT 0,
      image_url TEXT DEFAULT '',
      featured INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      available INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      required INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS extras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      price_cents INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_extras (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      extra_id INTEGER NOT NULL REFERENCES extras(id) ON DELETE CASCADE,
      PRIMARY KEY (product_id, extra_id)
    );

    CREATE TABLE IF NOT EXISTS payment_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      instructions TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS delivery_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      requires_address INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS delivery_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      fee_cents INTEGER NOT NULL DEFAULT 0,
      minimum_order_cents INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT DEFAULT '',
      reference TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      delivery_method_id INTEGER NOT NULL REFERENCES delivery_methods(id),
      payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
      delivery_zone_id INTEGER REFERENCES delivery_zones(id),
      assigned_delivery_user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      extras_total_cents INTEGER NOT NULL DEFAULT 0,
      line_total_cents INTEGER NOT NULL,
      variants_json TEXT NOT NULL DEFAULT '{}',
      extras_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS order_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      changed_by_user_id INTEGER REFERENCES users(id),
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      discount_type TEXT DEFAULT 'percent',
      discount_value INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      starts_at TEXT,
      ends_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT DEFAULT '',
      entity_id TEXT DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
  `);

  runMigrations();
  seedDatabase();
}

function runMigrations() {
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
  if (!sessionColumns.includes('last_rotated_at')) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_rotated_at TEXT NOT NULL DEFAULT ''");
    db.prepare("UPDATE sessions SET last_rotated_at = created_at WHERE last_rotated_at = ''").run();
  }
}

function seedDatabase() {
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'seeded'").get();
  if (seeded?.value === '1') return;

  const createdAt = nowIso();
  const roleStmt = db.prepare(
    'INSERT OR IGNORE INTO roles (name, description, permissions_json) VALUES (?, ?, ?)'
  );
  for (const [name, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    roleStmt.run(name, `${name} del sistema`, JSON.stringify(permissions));
  }

  db.prepare(`
    INSERT OR IGNORE INTO business (
      id, name, slug, logo_url, phone, whatsapp_phone, address, currency, timezone,
      is_open_manual, allow_orders_outside_hours, closed_message, hours_json, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Boba Central',
    'boba-central',
    '/api/public/art/logo.svg',
    '+503 2222-0000',
    '50370000000',
    'Colonia Escalon, San Salvador',
    'USD',
    'America/El_Salvador',
    1,
    0,
    'Gracias por visitarnos. Volvemos a abrir pronto.',
    JSON.stringify([
      { day: 1, name: 'Lunes', active: true, open: '08:00', close: '21:00' },
      { day: 2, name: 'Martes', active: true, open: '08:00', close: '21:00' },
      { day: 3, name: 'Miercoles', active: true, open: '08:00', close: '21:00' },
      { day: 4, name: 'Jueves', active: true, open: '08:00', close: '21:00' },
      { day: 5, name: 'Viernes', active: true, open: '08:00', close: '22:00' },
      { day: 6, name: 'Sabado', active: true, open: '09:00', close: '22:00' },
      { day: 0, name: 'Domingo', active: true, open: '10:00', close: '20:00' }
    ]),
    createdAt,
    createdAt
  );

  const adminRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('Administrador');
  const kitchenRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('Cocina');
  const cashierRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('Cajero');
  const userStmt = db.prepare(`
    INSERT OR IGNORE INTO users (role_id, name, email, password_hash, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  userStmt.run(adminRole.id, 'Administrador', 'admin@demo.com', hashPassword('Admin123!'), createdAt, createdAt);
  userStmt.run(cashierRole.id, 'Caja Principal', 'caja@demo.com', hashPassword('Caja123!'), createdAt, createdAt);
  userStmt.run(kitchenRole.id, 'Cocina', 'cocina@demo.com', hashPassword('Cocina123!'), createdAt, createdAt);

  const categoryStmt = db.prepare(`
    INSERT OR IGNORE INTO categories (name, slug, description, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `);
  const categories = [
    ['Milk tea', 'milk-tea', 'Teas con leche y toppings', 10],
    ['Smoothies', 'smoothies', 'Bebidas frutales cremosas', 20],
    ['Iced coffee', 'iced-coffee', 'Cafe frio y especialidades', 30],
    ['Refreshers', 'refreshers', 'Bebidas frescas y ligeras', 40],
    ['Comida rapida', 'comida-rapida', 'Snacks y platos rapidos', 50],
    ['Postres', 'postres', 'Dulces para acompanar', 60],
    ['Combos', 'combos', 'Paquetes promocionales', 70]
  ];
  for (const category of categories) categoryStmt.run(...category, createdAt, createdAt);

  const extraStmt = db.prepare(`
    INSERT OR IGNORE INTO extras (name, price_cents, active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `);
  const extras = [
    ['Perlas tapioca', 75],
    ['Popping boba mango', 90],
    ['Jelly de coco', 80],
    ['Cream cheese foam', 125],
    ['Shot de espresso', 100],
    ['Extra queso', 90],
    ['Papas pequenas', 150],
    ['Salsa especial', 50]
  ];
  for (const [name, price] of extras) extraStmt.run(name, price, createdAt, createdAt);

  const payments = [
    ['Efectivo', 'efectivo', 'Pago en caja o contra entrega.'],
    ['Transferencia', 'transferencia', 'Enviar comprobante al WhatsApp del negocio.'],
    ['Tarjeta', 'tarjeta', 'Preparado para pasarela o POS fisico.'],
    ['Pago contra entrega', 'pago-contra-entrega', 'Disponible para delivery.']
  ];
  const paymentStmt = db.prepare(
    'INSERT OR IGNORE INTO payment_methods (name, slug, active, instructions) VALUES (?, ?, 1, ?)'
  );
  for (const payment of payments) paymentStmt.run(...payment);

  const deliveryMethods = [
    ['Retiro en tienda', 'retiro', 0],
    ['Delivery', 'delivery', 1],
    ['Comer en local', 'local', 0]
  ];
  const deliveryStmt = db.prepare(
    'INSERT OR IGNORE INTO delivery_methods (name, slug, active, requires_address) VALUES (?, ?, 1, ?)'
  );
  for (const method of deliveryMethods) deliveryStmt.run(...method);

  const zoneStmt = db.prepare(
    'INSERT OR IGNORE INTO delivery_zones (name, fee_cents, minimum_order_cents, active) VALUES (?, ?, ?, 1)'
  );
  zoneStmt.run('Zona cercana', 200, 800);
  zoneStmt.run('Zona media', 350, 1200);
  zoneStmt.run('Zona extendida', 500, 1800);

  seedProducts(createdAt);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('seeded', '1')").run();
}

function seedProducts(createdAt) {
  const productStmt = db.prepare(`
    INSERT OR IGNORE INTO products (
      category_id, name, slug, description, base_price_cents, image_url,
      featured, active, available, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `);
  const variantStmt = db.prepare(`
    INSERT INTO product_variants (product_id, name, options_json, required, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  const productExtraStmt = db.prepare('INSERT OR IGNORE INTO product_extras (product_id, extra_id) VALUES (?, ?)');

  const products = [
    {
      category: 'milk-tea',
      name: 'Taro Milk Tea',
      slug: 'taro-milk-tea',
      description: 'Te negro con leche, taro cremoso y acabado suave.',
      price: 425,
      image: '/api/public/art/taro-milk-tea.svg',
      featured: 1,
      variants: [
        ['Tamano', ['16 oz', '22 oz', '24 oz']],
        ['Azucar', ['0%', '25%', '50%', '75%', '100%']],
        ['Hielo', ['Sin hielo', 'Poco', 'Normal']],
        ['Leche', ['Entera', 'Deslactosada', 'Avena']]
      ],
      extras: ['Perlas tapioca', 'Popping boba mango', 'Jelly de coco', 'Cream cheese foam']
    },
    {
      category: 'milk-tea',
      name: 'Brown Sugar Boba',
      slug: 'brown-sugar-boba',
      description: 'Leche fria con jarabe de azucar morena y tapioca.',
      price: 475,
      image: '/api/public/art/brown-sugar-boba.svg',
      featured: 1,
      variants: [
        ['Tamano', ['16 oz', '22 oz', '24 oz']],
        ['Azucar', ['50%', '75%', '100%']],
        ['Hielo', ['Poco', 'Normal']]
      ],
      extras: ['Perlas tapioca', 'Cream cheese foam']
    },
    {
      category: 'smoothies',
      name: 'Mango Smoothie',
      slug: 'mango-smoothie',
      description: 'Mango natural, yogurt y textura cremosa.',
      price: 450,
      image: '/api/public/art/mango-smoothie.svg',
      featured: 1,
      variants: [
        ['Tamano', ['16 oz', '22 oz']],
        ['Azucar', ['0%', '25%', '50%', '75%', '100%']],
        ['Base', ['Agua', 'Leche', 'Yogurt']]
      ],
      extras: ['Popping boba mango', 'Jelly de coco']
    },
    {
      category: 'iced-coffee',
      name: 'Iced Caramel Latte',
      slug: 'iced-caramel-latte',
      description: 'Espresso, leche fria y caramelo.',
      price: 390,
      image: '/api/public/art/iced-caramel-latte.svg',
      featured: 0,
      variants: [
        ['Tamano', ['12 oz', '16 oz', '22 oz']],
        ['Leche', ['Entera', 'Deslactosada', 'Avena']],
        ['Dulzor', ['Sin azucar', 'Normal', 'Extra']]
      ],
      extras: ['Shot de espresso', 'Cream cheese foam']
    },
    {
      category: 'refreshers',
      name: 'Strawberry Refresher',
      slug: 'strawberry-refresher',
      description: 'Fresa, limon y notas herbales.',
      price: 350,
      image: '/api/public/art/strawberry-refresher.svg',
      featured: 0,
      variants: [
        ['Tamano', ['16 oz', '22 oz', '24 oz']],
        ['Hielo', ['Poco', 'Normal', 'Extra']]
      ],
      extras: ['Popping boba mango', 'Jelly de coco']
    },
    {
      category: 'comida-rapida',
      name: 'Crispy Chicken Sandwich',
      slug: 'crispy-chicken-sandwich',
      description: 'Pollo crispy, queso, lechuga y salsa de la casa.',
      price: 625,
      image: '/api/public/art/crispy-chicken-sandwich.svg',
      featured: 1,
      variants: [
        ['Picante', ['No picante', 'Medio', 'Picante']],
        ['Pan', ['Brioche', 'Integral']]
      ],
      extras: ['Extra queso', 'Papas pequenas', 'Salsa especial']
    },
    {
      category: 'postres',
      name: 'Cheesecake Cup',
      slug: 'cheesecake-cup',
      description: 'Cheesecake en vaso con topping frutal.',
      price: 325,
      image: '/api/public/art/cheesecake-cup.svg',
      featured: 0,
      variants: [
        ['Sabor', ['Fresa', 'Mango', 'Chocolate']]
      ],
      extras: ['Cream cheese foam']
    },
    {
      category: 'combos',
      name: 'Combo Boba Snack',
      slug: 'combo-boba-snack',
      description: 'Milk tea 16 oz, sandwich crispy y papas pequenas.',
      price: 925,
      image: '/api/public/art/combo-boba-snack.svg',
      featured: 1,
      variants: [
        ['Bebida', ['Taro Milk Tea', 'Brown Sugar Boba', 'Mango Smoothie']],
        ['Snack', ['Sandwich crispy', 'Papas grandes']]
      ],
      extras: ['Perlas tapioca', 'Salsa especial']
    }
  ];

  for (const product of products) {
    const category = db.prepare('SELECT id FROM categories WHERE slug = ?').get(product.category);
    if (!category) continue;
    productStmt.run(
      category.id,
      product.name,
      product.slug,
      product.description,
      product.price,
      product.image,
      product.featured,
      1,
      products.indexOf(product) + 1,
      createdAt,
      createdAt
    );
    const saved = db.prepare('SELECT id FROM products WHERE slug = ?').get(product.slug);
    if (!saved) continue;
    const currentVariants = db.prepare('SELECT COUNT(*) AS total FROM product_variants WHERE product_id = ?').get(saved.id);
    if (currentVariants.total === 0) {
      product.variants.forEach(([name, options], index) => {
        variantStmt.run(saved.id, name, JSON.stringify(options), 1, index + 1);
      });
    }
    for (const extraName of product.extras) {
      const extra = db.prepare('SELECT id FROM extras WHERE name = ?').get(extraName);
      if (extra) productExtraStmt.run(saved.id, extra.id);
    }
  }
}

function mapBusiness(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logo_url,
    phone: row.phone,
    whatsappPhone: row.whatsapp_phone,
    address: row.address,
    currency: row.currency,
    timezone: row.timezone,
    isOpenManual: Boolean(row.is_open_manual),
    allowOrdersOutsideHours: Boolean(row.allow_orders_outside_hours),
    closedMessage: row.closed_message,
    hours: parseJson(row.hours_json, [])
  };
}

export function getBusiness() {
  return mapBusiness(db.prepare('SELECT * FROM business WHERE id = 1').get());
}

export function updateBusiness(input) {
  const current = getBusiness();
  const hours = Array.isArray(input.hours) ? input.hours : current.hours;
  db.prepare(`
    UPDATE business SET
      name = ?, logo_url = ?, phone = ?, whatsapp_phone = ?, address = ?,
      is_open_manual = ?, allow_orders_outside_hours = ?, closed_message = ?,
      hours_json = ?, updated_at = ?
    WHERE id = 1
  `).run(
    clean(input.name || current.name, 120),
    clean(input.logoUrl ?? current.logoUrl, 500),
    clean(input.phone ?? current.phone, 60),
    clean(input.whatsappPhone ?? current.whatsappPhone, 60),
    clean(input.address ?? current.address, 300),
    boolInt(input.isOpenManual ?? current.isOpenManual),
    boolInt(input.allowOrdersOutsideHours ?? current.allowOrdersOutsideHours),
    clean(input.closedMessage ?? current.closedMessage, 500),
    JSON.stringify(hours),
    nowIso()
  );
  return getBusiness();
}

export function isBusinessOpen() {
  const business = getBusiness();
  if (business.isOpenManual) return { open: true, message: '' };
  if (business.allowOrdersOutsideHours) return { open: true, message: '' };

  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const today = business.hours.find((item) => Number(item.day) === now.getDay());
  if (!today?.active) return { open: false, message: business.closedMessage };
  const [openHour, openMinute] = today.open.split(':').map(Number);
  const [closeHour, closeMinute] = today.close.split(':').map(Number);
  const openMinutes = openHour * 60 + openMinute;
  const closeMinutes = closeHour * 60 + closeMinute;
  return {
    open: minutes >= openMinutes && minutes <= closeMinutes,
    message: business.closedMessage
  };
}

function mapCategory(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    active: Boolean(row.active),
    sortOrder: row.sort_order
  };
}

function mapExtra(row) {
  return {
    id: row.id,
    name: row.name,
    priceCents: row.price_cents,
    price: money(row.price_cents),
    active: Boolean(row.active)
  };
}

function mapProduct(row, includeInactive = false) {
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categorySlug: row.category_slug,
    name: row.name,
    slug: row.slug,
    description: row.description,
    basePriceCents: row.base_price_cents,
    price: money(row.base_price_cents),
    imageUrl: row.image_url,
    featured: Boolean(row.featured),
    active: Boolean(row.active),
    available: Boolean(row.available),
    soldOut: !row.available,
    sortOrder: row.sort_order,
    variants: getProductVariants(row.id),
    extras: getProductExtras(row.id, includeInactive)
  };
}

function getProductVariants(productId) {
  return db.prepare(`
    SELECT id, name, options_json, required, sort_order
    FROM product_variants
    WHERE product_id = ?
    ORDER BY sort_order, id
  `).all(productId).map((row) => ({
    id: row.id,
    name: row.name,
    options: parseJson(row.options_json, []),
    required: Boolean(row.required),
    sortOrder: row.sort_order
  }));
}

function getProductExtras(productId, includeInactive = false) {
  const sql = `
    SELECT e.*
    FROM extras e
    JOIN product_extras pe ON pe.extra_id = e.id
    WHERE pe.product_id = ? ${includeInactive ? '' : 'AND e.active = 1'}
    ORDER BY e.name
  `;
  return db.prepare(sql).all(productId).map(mapExtra);
}

export function getMenu({ search = '', category = '' } = {}) {
  const clauses = ['p.active = 1', 'c.active = 1'];
  const params = [];
  if (search) {
    clauses.push('(p.name LIKE ? OR p.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    clauses.push('c.slug = ?');
    params.push(category);
  }
  const products = db.prepare(`
    SELECT p.*, c.name AS category_name, c.slug AS category_slug
    FROM products p
    JOIN categories c ON c.id = p.category_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY c.sort_order, p.sort_order, p.name
  `).all(...params).map((row) => mapProduct(row));

  return {
    business: getBusiness(),
    openState: isBusinessOpen(),
    categories: db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order, name').all().map(mapCategory),
    products,
    featured: products.filter((product) => product.featured)
  };
}

export function getCheckoutOptions() {
  return {
    business: getBusiness(),
    openState: isBusinessOpen(),
    paymentMethods: db.prepare('SELECT * FROM payment_methods WHERE active = 1 ORDER BY id').all(),
    deliveryMethods: db.prepare('SELECT * FROM delivery_methods WHERE active = 1 ORDER BY id').all().map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      requiresAddress: Boolean(row.requires_address)
    })),
    deliveryZones: db.prepare('SELECT * FROM delivery_zones WHERE active = 1 ORDER BY fee_cents, name').all().map((row) => ({
      id: row.id,
      name: row.name,
      feeCents: row.fee_cents,
      fee: money(row.fee_cents),
      minimumOrderCents: row.minimum_order_cents,
      minimumOrder: money(row.minimum_order_cents)
    }))
  };
}

function getActiveMethod(table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? AND active = 1`).get(id);
}

function enrichOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('Agrega al menos un producto al carrito.');
  }

  return items.map((item) => {
    const productId = Number(item.productId);
    const quantity = Math.max(1, Math.min(99, Number(item.quantity || 1)));
    const product = db.prepare(`
      SELECT p.*, c.active AS category_active
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.id = ?
    `).get(productId);
    if (!product || !product.active || !product.category_active) {
      throw new ValidationError('Uno de los productos ya no esta disponible.');
    }
    if (!product.available) {
      throw new ValidationError(`${product.name} esta agotado.`);
    }

    const selectedExtraIds = Array.isArray(item.extras) ? item.extras.map(Number).filter(Boolean) : [];
    let selectedExtras = [];
    if (selectedExtraIds.length) {
      const placeholders = selectedExtraIds.map(() => '?').join(',');
      selectedExtras = db.prepare(`
        SELECT e.*
        FROM extras e
        JOIN product_extras pe ON pe.extra_id = e.id
        WHERE pe.product_id = ? AND e.active = 1 AND e.id IN (${placeholders})
      `).all(productId, ...selectedExtraIds).map(mapExtra);
    }

    const extrasTotalCents = selectedExtras.reduce((sum, extra) => sum + extra.priceCents, 0);
    const lineTotalCents = (product.base_price_cents + extrasTotalCents) * quantity;
    return {
      productId,
      productName: product.name,
      quantity,
      unitPriceCents: product.base_price_cents,
      extrasTotalCents,
      lineTotalCents,
      variants: item.variants && typeof item.variants === 'object' ? item.variants : {},
      extras: selectedExtras,
      notes: clean(item.notes, 500)
    };
  });
}

function createOrderNumber() {
  const d = new Date();
  const prefix = `BC${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = db.prepare('SELECT COUNT(*) AS total FROM orders WHERE order_number LIKE ?').get(`${prefix}-%`);
  return `${prefix}-${String(row.total + 1).padStart(4, '0')}`;
}

export function createOrder(payload) {
  const openState = isBusinessOpen();
  if (!openState.open) {
    throw new ValidationError(openState.message || 'El negocio esta cerrado.', 409);
  }

  const customer = payload.customer || {};
  const name = clean(customer.name, 120);
  const phone = clean(customer.phone, 60);
  const address = clean(customer.address, 300);
  const reference = clean(customer.reference, 300);
  if (!name || !phone) throw new ValidationError('Nombre y telefono son obligatorios.');

  const deliveryMethod = getActiveMethod('delivery_methods', Number(payload.deliveryMethodId));
  const paymentMethod = getActiveMethod('payment_methods', Number(payload.paymentMethodId));
  if (!deliveryMethod) throw new ValidationError('Selecciona un metodo de entrega valido.');
  if (!paymentMethod) throw new ValidationError('Selecciona un metodo de pago valido.');
  if (deliveryMethod.requires_address && !address) {
    throw new ValidationError('La direccion es obligatoria para delivery.');
  }

  const items = enrichOrderItems(payload.items);
  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  let deliveryZone = null;
  let deliveryFeeCents = 0;
  if (deliveryMethod.slug === 'delivery') {
    deliveryZone = getActiveMethod('delivery_zones', Number(payload.deliveryZoneId));
    if (deliveryZone) {
      if (subtotalCents < deliveryZone.minimum_order_cents) {
        throw new ValidationError(`El pedido minimo para ${deliveryZone.name} es $${money(deliveryZone.minimum_order_cents).toFixed(2)}.`);
      }
      deliveryFeeCents = deliveryZone.fee_cents;
    }
  }

  const totalCents = subtotalCents + deliveryFeeCents;
  const orderNumber = createOrderNumber();
  const createdAt = nowIso();

  db.exec('BEGIN');
  try {
    let savedCustomer = db.prepare('SELECT id FROM customers WHERE phone = ? ORDER BY id DESC LIMIT 1').get(phone);
    if (savedCustomer) {
      db.prepare('UPDATE customers SET name = ?, address = ?, reference = ?, updated_at = ? WHERE id = ?')
        .run(name, address, reference, createdAt, savedCustomer.id);
    } else {
      const customerResult = db.prepare(`
        INSERT INTO customers (name, phone, address, reference, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, phone, address, reference, createdAt, createdAt);
      savedCustomer = { id: Number(customerResult.lastInsertRowid) };
    }

    const orderResult = db.prepare(`
      INSERT INTO orders (
        order_number, customer_id, delivery_method_id, payment_method_id, delivery_zone_id,
        status, subtotal_cents, delivery_fee_cents, total_cents, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Nuevo', ?, ?, ?, ?, ?, ?)
    `).run(
      orderNumber,
      savedCustomer.id,
      deliveryMethod.id,
      paymentMethod.id,
      deliveryZone?.id || null,
      subtotalCents,
      deliveryFeeCents,
      totalCents,
      clean(payload.notes, 800),
      createdAt,
      createdAt
    );
    const orderId = Number(orderResult.lastInsertRowid);

    const itemStmt = db.prepare(`
      INSERT INTO order_items (
        order_id, product_id, product_name, quantity, unit_price_cents, extras_total_cents,
        line_total_cents, variants_json, extras_json, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      itemStmt.run(
        orderId,
        item.productId,
        item.productName,
        item.quantity,
        item.unitPriceCents,
        item.extrasTotalCents,
        item.lineTotalCents,
        JSON.stringify(item.variants),
        JSON.stringify(item.extras),
        item.notes
      );
    }
    db.prepare(`
      INSERT INTO order_status_history (order_id, status, changed_by_user_id, note, created_at)
      VALUES (?, 'Nuevo', NULL, 'Pedido creado por cliente', ?)
    `).run(orderId, createdAt);
    db.exec('COMMIT');
    return getOrderById(orderId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function hydrateOrder(row) {
  if (!row) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(row.id).map((item) => ({
    id: item.id,
    productId: item.product_id,
    productName: item.product_name,
    quantity: item.quantity,
    unitPriceCents: item.unit_price_cents,
    unitPrice: money(item.unit_price_cents),
    extrasTotalCents: item.extras_total_cents,
    lineTotalCents: item.line_total_cents,
    lineTotal: money(item.line_total_cents),
    variants: parseJson(item.variants_json, {}),
    extras: parseJson(item.extras_json, []),
    notes: item.notes
  }));
  const history = db.prepare(`
    SELECT h.*, u.name AS user_name
    FROM order_status_history h
    LEFT JOIN users u ON u.id = h.changed_by_user_id
    WHERE h.order_id = ?
    ORDER BY h.created_at
  `).all(row.id).map((entry) => ({
    id: entry.id,
    status: entry.status,
    note: entry.note,
    userName: entry.user_name,
    createdAt: entry.created_at
  }));

  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    customer: {
      id: row.customer_id,
      name: row.customer_name,
      phone: row.customer_phone,
      address: row.customer_address,
      reference: row.customer_reference
    },
    deliveryMethod: {
      id: row.delivery_method_id,
      name: row.delivery_method,
      slug: row.delivery_slug
    },
    paymentMethod: {
      id: row.payment_method_id,
      name: row.payment_method,
      slug: row.payment_slug
    },
    deliveryZone: row.delivery_zone_id ? {
      id: row.delivery_zone_id,
      name: row.delivery_zone,
      feeCents: row.delivery_fee_cents
    } : null,
    assignedDeliveryUserId: row.assigned_delivery_user_id,
    subtotalCents: row.subtotal_cents,
    subtotal: money(row.subtotal_cents),
    deliveryFeeCents: row.delivery_fee_cents,
    deliveryFee: money(row.delivery_fee_cents),
    totalCents: row.total_cents,
    total: money(row.total_cents),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
    history
  };
}

function orderBaseQuery(where) {
  return `
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
      c.reference AS customer_reference, dm.name AS delivery_method, dm.slug AS delivery_slug,
      pm.name AS payment_method, pm.slug AS payment_slug, dz.name AS delivery_zone
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    JOIN delivery_methods dm ON dm.id = o.delivery_method_id
    JOIN payment_methods pm ON pm.id = o.payment_method_id
    LEFT JOIN delivery_zones dz ON dz.id = o.delivery_zone_id
    ${where}
  `;
}

export function getOrderById(id) {
  return hydrateOrder(db.prepare(orderBaseQuery('WHERE o.id = ?')).get(Number(id)));
}

export function getOrderByNumber(orderNumber) {
  return hydrateOrder(db.prepare(orderBaseQuery('WHERE o.order_number = ?')).get(clean(orderNumber, 60)));
}

export function listOrders({ status = 'all', search = '', limit = 80, kds = false } = {}) {
  const clauses = [];
  const params = [];
  if (status && status !== 'all') {
    clauses.push('o.status = ?');
    params.push(status);
  }
  if (kds) {
    clauses.push("o.status IN ('Aceptado', 'En preparacion')");
  }
  if (search) {
    clauses.push('(o.order_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`${orderBaseQuery(where)} ORDER BY o.created_at DESC LIMIT ?`).all(...params, Number(limit));
  return rows.map((row) => hydrateOrder(row));
}

export function updateOrderStatus(orderId, status, userId, note = '') {
  if (!ORDER_STATUSES.includes(status)) throw new ValidationError('Estado de pedido no valido.');
  const order = getOrderById(orderId);
  if (!order) throw new ValidationError('Pedido no encontrado.', 404);
  const updatedAt = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, order.id);
    db.prepare(`
      INSERT INTO order_status_history (order_id, status, changed_by_user_id, note, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(order.id, status, userId || null, clean(note, 400), updatedAt);
    db.exec('COMMIT');
    return getOrderById(order.id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getAdminCatalog() {
  const products = db.prepare(`
    SELECT p.*, c.name AS category_name, c.slug AS category_slug
    FROM products p
    JOIN categories c ON c.id = p.category_id
    ORDER BY c.sort_order, p.sort_order, p.name
  `).all().map((row) => mapProduct(row, true));
  return {
    categories: listCategories(true),
    extras: db.prepare('SELECT * FROM extras ORDER BY name').all().map(mapExtra),
    products
  };
}

export function listCategories(includeInactive = false) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db.prepare(`SELECT * FROM categories ${where} ORDER BY sort_order, name`).all().map(mapCategory);
}

export function saveCategory(input) {
  const name = clean(input.name, 100);
  if (!name) throw new ValidationError('El nombre de categoria es obligatorio.');
  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO categories (name, slug, description, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    slugify(input.slug || name),
    clean(input.description, 300),
    boolInt(input.active ?? true),
    Number(input.sortOrder || 0),
    createdAt,
    createdAt
  );
  return listCategories(true).find((category) => category.id === Number(result.lastInsertRowid));
}

export function updateCategory(id, input) {
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id));
  if (!existing) throw new ValidationError('Categoria no encontrada.', 404);
  const name = clean(input.name ?? existing.name, 100);
  db.prepare(`
    UPDATE categories SET name = ?, slug = ?, description = ?, active = ?, sort_order = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name,
    slugify(input.slug || existing.slug || name),
    clean(input.description ?? existing.description, 300),
    boolInt(input.active ?? Boolean(existing.active)),
    Number(input.sortOrder ?? existing.sort_order),
    nowIso(),
    Number(id)
  );
  return listCategories(true).find((category) => category.id === Number(id));
}

export function deleteCategory(id) {
  const inUse = db.prepare('SELECT COUNT(*) AS total FROM products WHERE category_id = ?').get(Number(id));
  if (inUse.total > 0) throw new ValidationError('No se puede eliminar una categoria con productos.');
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(id));
}

function normalizeVariants(variants) {
  if (!Array.isArray(variants)) return [];
  return variants
    .map((variant, index) => ({
      name: clean(variant.name, 80),
      options: Array.isArray(variant.options)
        ? variant.options.map((option) => clean(option, 80)).filter(Boolean)
        : String(variant.options || '').split(',').map((option) => clean(option, 80)).filter(Boolean),
      required: variant.required !== false,
      sortOrder: Number(variant.sortOrder || index + 1)
    }))
    .filter((variant) => variant.name && variant.options.length);
}

function setProductRelations(productId, variants, extraIds) {
  db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(productId);
  db.prepare('DELETE FROM product_extras WHERE product_id = ?').run(productId);
  const variantStmt = db.prepare(`
    INSERT INTO product_variants (product_id, name, options_json, required, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const variant of normalizeVariants(variants)) {
    variantStmt.run(productId, variant.name, JSON.stringify(variant.options), boolInt(variant.required), variant.sortOrder);
  }
  const extraStmt = db.prepare('INSERT OR IGNORE INTO product_extras (product_id, extra_id) VALUES (?, ?)');
  for (const extraId of Array.isArray(extraIds) ? extraIds : []) {
    if (Number(extraId)) extraStmt.run(productId, Number(extraId));
  }
}

export function saveProduct(input) {
  const name = clean(input.name, 140);
  const categoryId = Number(input.categoryId);
  if (!name) throw new ValidationError('El nombre del producto es obligatorio.');
  if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) {
    throw new ValidationError('Selecciona una categoria valida.');
  }
  const createdAt = nowIso();
  db.exec('BEGIN');
  try {
    const result = db.prepare(`
      INSERT INTO products (
        category_id, name, slug, description, base_price_cents, image_url, featured,
        active, available, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      categoryId,
      name,
      slugify(input.slug || name),
      clean(input.description, 800),
      cents(input.price),
      clean(input.imageUrl, 700),
      boolInt(input.featured),
      boolInt(input.active ?? true),
      boolInt(input.available ?? true),
      Number(input.sortOrder || 0),
      createdAt,
      createdAt
    );
    const productId = Number(result.lastInsertRowid);
    setProductRelations(productId, input.variants, input.extraIds);
    db.exec('COMMIT');
    return getAdminCatalog().products.find((product) => product.id === productId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function updateProduct(id, input) {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
  if (!existing) throw new ValidationError('Producto no encontrado.', 404);
  const name = clean(input.name ?? existing.name, 140);
  const categoryId = Number(input.categoryId ?? existing.category_id);
  if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) {
    throw new ValidationError('Selecciona una categoria valida.');
  }
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE products SET
        category_id = ?, name = ?, slug = ?, description = ?, base_price_cents = ?,
        image_url = ?, featured = ?, active = ?, available = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `).run(
      categoryId,
      name,
      slugify(input.slug || existing.slug || name),
      clean(input.description ?? existing.description, 800),
      cents(input.price ?? money(existing.base_price_cents)),
      clean(input.imageUrl ?? existing.image_url, 700),
      boolInt(input.featured ?? Boolean(existing.featured)),
      boolInt(input.active ?? Boolean(existing.active)),
      boolInt(input.available ?? Boolean(existing.available)),
      Number(input.sortOrder ?? existing.sort_order),
      nowIso(),
      Number(id)
    );
    if ('variants' in input || 'extraIds' in input) {
      const currentVariants = getProductVariants(Number(id));
      const currentExtraIds = getProductExtras(Number(id), true).map((extra) => extra.id);
      setProductRelations(Number(id), input.variants ?? currentVariants, input.extraIds ?? currentExtraIds);
    }
    db.exec('COMMIT');
    return getAdminCatalog().products.find((product) => product.id === Number(id));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function deleteProduct(id) {
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(id));
}

export function listRoles() {
  return db.prepare('SELECT * FROM roles ORDER BY id').all().map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: parseJson(role.permissions_json, [])
  }));
}

export function listUsers() {
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.active, u.created_at, u.updated_at, r.name AS role_name, r.id AS role_id
    FROM users u
    JOIN roles r ON r.id = u.role_id
    ORDER BY u.name
  `).all().map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    active: Boolean(user.active),
    roleId: user.role_id,
    roleName: user.role_name,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  }));
}

export function saveUser(input) {
  const name = clean(input.name, 120);
  const email = clean(input.email, 160).toLowerCase();
  const roleId = Number(input.roleId);
  const password = String(input.password || '');
  if (!name || !email || !password) throw new ValidationError('Nombre, email y password son obligatorios.');
  if (password.length < 8) throw new ValidationError('La contrasena debe tener al menos 8 caracteres.');
  if (!db.prepare('SELECT id FROM roles WHERE id = ?').get(roleId)) throw new ValidationError('Rol no valido.');
  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO users (role_id, name, email, password_hash, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(roleId, name, email, hashPassword(password), boolInt(input.active ?? true), createdAt, createdAt);
  return listUsers().find((user) => user.id === Number(result.lastInsertRowid));
}

export function login(email, password) {
  const user = db.prepare(`
    SELECT u.*, r.name AS role_name, r.permissions_json
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE lower(u.email) = lower(?) AND u.active = 1
  `).get(clean(email, 160));
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new ValidationError('Credenciales invalidas.', 401);
  }
  return mapUser(user);
}

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    roleId: row.role_id,
    roleName: row.role_name,
    permissions: parseJson(row.permissions_json, [])
  };
}

export function createSession(userId) {
  const sessionDays = Number(process.env.SESSION_DAYS || 7);
  const id = crypto.randomBytes(32).toString('base64url');
  const createdAt = nowIso();
  const expires = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, last_rotated_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, createdAt, createdAt, expires);
  return { id, expiresAt: expires };
}

export function getUserBySession(sessionId) {
  if (!sessionId) return null;
  const row = db.prepare(`
    SELECT u.*, r.name AS role_name, r.permissions_json
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN roles r ON r.id = u.role_id
    WHERE s.id = ? AND s.expires_at > ? AND u.active = 1
  `).get(sessionId, nowIso());
  return row ? mapUser(row) : null;
}

export function getSessionContext(sessionId) {
  if (!sessionId) return null;
  const row = db.prepare(`
    SELECT s.id AS session_id, s.created_at AS session_created_at,
      s.last_rotated_at AS session_last_rotated_at, s.expires_at AS session_expires_at,
      u.*, r.name AS role_name, r.permissions_json
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN roles r ON r.id = u.role_id
    WHERE s.id = ? AND s.expires_at > ? AND u.active = 1
  `).get(sessionId, nowIso());
  if (!row) return null;
  return {
    user: mapUser(row),
    session: {
      id: row.session_id,
      createdAt: row.session_created_at,
      lastRotatedAt: row.session_last_rotated_at || row.session_created_at,
      expiresAt: row.session_expires_at
    }
  };
}

export function rotateSession(sessionId) {
  const context = getSessionContext(sessionId);
  if (!context) return null;
  const nextId = crypto.randomBytes(32).toString('base64url');
  const rotatedAt = nowIso();
  db.prepare('UPDATE sessions SET id = ?, last_rotated_at = ? WHERE id = ?')
    .run(nextId, rotatedAt, sessionId);
  return {
    id: nextId,
    expiresAt: context.session.expiresAt,
    user: context.user
  };
}

export function deleteSession(sessionId) {
  if (sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function userCan(user, permission) {
  if (!user) return false;
  if (user.permissions.includes('*')) return true;
  return user.permissions.includes(permission);
}

export function auditLog({ userId = null, action, entityType = '', entityId = '', details = {}, ipAddress = '', userAgent = '' }) {
  if (!action) return;
  db.prepare(`
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json, ip_address, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId || null,
    clean(action, 120),
    clean(entityType, 80),
    clean(entityId, 120),
    JSON.stringify(details || {}),
    clean(ipAddress, 80),
    clean(userAgent, 300),
    nowIso()
  );
}

export function listAuditLogs({ limit = 120, action = '', userId = null } = {}) {
  const clauses = [];
  const params = [];
  if (action) {
    clauses.push('a.action LIKE ?');
    params.push(`%${clean(action, 120)}%`);
  }
  if (userId) {
    clauses.push('a.user_id = ?');
    params.push(Number(userId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT a.*, u.name AS user_name, u.email AS user_email
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(...params, Number(limit)).map((row) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: parseJson(row.details_json, {}),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at
  }));
}

export function getReports() {
  const notCancelled = "status != 'Cancelado'";
  const scalar = (sql, ...params) => db.prepare(sql).get(...params);
  const today = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales
    FROM orders
    WHERE ${notCancelled} AND date(created_at) = date('now', 'localtime')
  `);
  const week = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales
    FROM orders
    WHERE ${notCancelled} AND date(created_at) >= date('now', '-6 day', 'localtime')
  `);
  const month = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales
    FROM orders
    WHERE ${notCancelled} AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
  `);
  const all = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales,
      COALESCE(AVG(total_cents), 0) AS average_ticket
    FROM orders
    WHERE ${notCancelled}
  `);
  const cancelled = scalar("SELECT COUNT(*) AS total FROM orders WHERE status = 'Cancelado'");

  const topProducts = db.prepare(`
    SELECT oi.product_name AS name, SUM(oi.quantity) AS quantity, SUM(oi.line_total_cents) AS sales_cents
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status != 'Cancelado'
    GROUP BY oi.product_name
    ORDER BY quantity DESC, sales_cents DESC
    LIMIT 8
  `).all().map((row) => ({
    name: row.name,
    quantity: row.quantity,
    salesCents: row.sales_cents,
    sales: money(row.sales_cents)
  }));

  const byPayment = db.prepare(`
    SELECT pm.name, COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS sales_cents
    FROM orders o
    JOIN payment_methods pm ON pm.id = o.payment_method_id
    WHERE o.status != 'Cancelado'
    GROUP BY pm.name
    ORDER BY sales_cents DESC
  `).all().map((row) => ({
    name: row.name,
    orders: row.orders,
    salesCents: row.sales_cents,
    sales: money(row.sales_cents)
  }));

  const byDelivery = db.prepare(`
    SELECT dm.name, COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS sales_cents
    FROM orders o
    JOIN delivery_methods dm ON dm.id = o.delivery_method_id
    WHERE o.status != 'Cancelado'
    GROUP BY dm.name
    ORDER BY orders DESC
  `).all().map((row) => ({
    name: row.name,
    orders: row.orders,
    salesCents: row.sales_cents,
    sales: money(row.sales_cents)
  }));

  const byDay = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales_cents
    FROM orders
    WHERE status != 'Cancelado'
    GROUP BY date(created_at)
    ORDER BY day DESC
    LIMIT 14
  `).all().reverse().map((row) => ({
    day: row.day,
    orders: row.orders,
    salesCents: row.sales_cents,
    sales: money(row.sales_cents)
  }));

  return {
    today: { orders: today.orders, salesCents: today.sales, sales: money(today.sales) },
    week: { orders: week.orders, salesCents: week.sales, sales: money(week.sales) },
    month: { orders: month.orders, salesCents: month.sales, sales: money(month.sales) },
    all: {
      orders: all.orders,
      salesCents: all.sales,
      sales: money(all.sales),
      averageTicketCents: Math.round(all.average_ticket),
      averageTicket: money(all.average_ticket)
    },
    cancelledOrders: cancelled.total,
    topProducts,
    byPayment,
    byDelivery,
    byDay
  };
}

export function formatOrderForWhatsApp(order) {
  const lines = [
    `Pedido ${order.orderNumber}`,
    `Cliente: ${order.customer.name}`,
    `Telefono: ${order.customer.phone}`,
    `Entrega: ${order.deliveryMethod.name}`,
    order.customer.address ? `Direccion: ${order.customer.address}` : '',
    order.customer.reference ? `Referencia: ${order.customer.reference}` : '',
    `Pago: ${order.paymentMethod.name}`,
    '',
    'Productos:'
  ].filter(Boolean);

  for (const item of order.items) {
    lines.push(`- ${item.quantity}x ${item.productName} $${item.lineTotal.toFixed(2)}`);
    const variants = Object.entries(item.variants || {});
    if (variants.length) lines.push(`  Opciones: ${variants.map(([key, value]) => `${key}: ${value}`).join(', ')}`);
    if (item.extras.length) lines.push(`  Extras: ${item.extras.map((extra) => `${extra.name} (+$${extra.price.toFixed(2)})`).join(', ')}`);
    if (item.notes) lines.push(`  Nota: ${item.notes}`);
  }
  if (order.notes) lines.push('', `Notas: ${order.notes}`);
  lines.push('', `Total: $${order.total.toFixed(2)}`);
  return lines.join('\n');
}
