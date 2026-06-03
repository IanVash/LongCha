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
  Cajero: [
    'orders:view', 'orders:update', 'orders:charge', 'payments:update',
    'cash:view', 'cash:open', 'cash:close',
    'reports:view', 'reports:export', 'delivery:view'
  ],
  Cocina: ['orders:view', 'orders:kds', 'orders:update-ready'],
  Repartidor: ['orders:view-assigned', 'orders:update-delivered'],
  Supervisor: [
    'orders:view', 'reports:view', 'reports:export', 'catalog:view',
    'accounting:view', 'cash:view', 'audit:view', 'settings:view',
    'backups:view', 'backups:download'
  ]
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
const BUSINESS_TIMEZONE = 'America/El_Salvador';
const BUSINESS_SQL_TIME = "'-6 hours'";
const businessDateSql = (column = 'created_at') => `date(${column}, ${BUSINESS_SQL_TIME})`;
const businessMonthSql = (column = 'created_at') => `strftime('%Y-%m', ${column}, ${BUSINESS_SQL_TIME})`;
const businessHourSql = (column = 'created_at') => `strftime('%H', ${column}, ${BUSINESS_SQL_TIME})`;

function businessDateTimeMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) return new Date(text).getTime();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return new Date(text).getTime();
  const [, year, month, day, hour, minute] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour + 6, minute);
}

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

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizePrinterConfig(input = {}) {
  const config = input && typeof input === 'object' ? input : {};
  const printers = config.printers && typeof config.printers === 'object' ? config.printers : {};
  const slugs = Array.isArray(config.labelDrinkCategorySlugs)
    ? config.labelDrinkCategorySlugs
    : DEFAULT_PRINTER_CONFIG.labelDrinkCategorySlugs;

  return {
    printers: {
      caja: normalizeThermalPrinter(printers.caja, DEFAULT_PRINTER_CONFIG.printers.caja, {
        enabled: config.ticketPrinterEnabled,
        ticketWidthMm: config.ticketWidthMm
      }),
      cocina: normalizeThermalPrinter(printers.cocina, DEFAULT_PRINTER_CONFIG.printers.cocina, {
        enabled: config.ticketPrinterEnabled,
        ticketWidthMm: config.ticketWidthMm
      }),
      kiosk: normalizeThermalPrinter(printers.kiosk, DEFAULT_PRINTER_CONFIG.printers.kiosk, {
        enabled: config.ticketPrinterEnabled,
        ticketWidthMm: config.ticketWidthMm,
        printOrderNumberOnly: true
      }),
      etiquetas: normalizeLabelPrinter(printers.etiquetas, DEFAULT_PRINTER_CONFIG.printers.etiquetas, {
        enabled: config.labelPrinterEnabled,
        labelWidthIn: config.labelWidthIn,
        labelHeightIn: config.labelHeightIn,
        copiesPerDrink: config.labelCopiesPerDrink,
        includePrice: config.labelIncludePrice,
        autoPrintFromKiosk: config.labelAutoPrintFromKiosk
      })
    },
    labelDrinkCategorySlugs: slugs.map((slug) => slugify(slug)).filter(Boolean).slice(0, 40)
  };
}

function normalizeTicketWidth(value, fallback) {
  const width = Number(value);
  return [58, 80].includes(width) ? width : fallback;
}

function normalizeConnectionMode(value, fallback = 'browser') {
  const mode = clean(value, 30);
  return ['browser', 'system', 'network'].includes(mode) ? mode : fallback;
}

function normalizePrinterPort(value, fallback = 9100) {
  const port = Math.round(Number(value));
  return port >= 1 && port <= 65535 ? port : fallback;
}

function normalizeRange(value, min, max, fallback, round = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  return round ? Math.round(clamped) : clamped;
}

function normalizeThermalPrinter(input, defaults, legacy = {}) {
  const config = input && typeof input === 'object' ? input : {};
  return {
    enabled: Boolean(config.enabled ?? legacy.enabled ?? defaults.enabled),
    name: clean(config.name ?? defaults.name, 80),
    type: 'thermal',
    ticketWidthMm: normalizeTicketWidth(config.ticketWidthMm ?? legacy.ticketWidthMm, defaults.ticketWidthMm),
    fontSizePt: normalizeRange(config.fontSizePt ?? legacy.fontSizePt, 9, 18, defaults.fontSizePt),
    connectionMode: normalizeConnectionMode(config.connectionMode ?? legacy.connectionMode, defaults.connectionMode),
    systemPrinterName: clean(config.systemPrinterName ?? legacy.systemPrinterName ?? defaults.systemPrinterName, 160),
    networkHost: clean(config.networkHost ?? legacy.networkHost ?? defaults.networkHost, 160),
    networkPort: normalizePrinterPort(config.networkPort ?? legacy.networkPort, defaults.networkPort),
    ...(defaults.printOrderNumberOnly || legacy.printOrderNumberOnly || config.printOrderNumberOnly
      ? { printOrderNumberOnly: true }
      : {})
  };
}

function normalizeLabelPrinter(input, defaults, legacy = {}) {
  const config = input && typeof input === 'object' ? input : {};
  return {
    enabled: Boolean(config.enabled ?? legacy.enabled ?? defaults.enabled),
    name: clean(config.name ?? defaults.name, 80),
    type: 'zebra-label',
    labelWidthIn: normalizeRange(config.labelWidthIn ?? legacy.labelWidthIn, 1, 4, defaults.labelWidthIn),
    labelHeightIn: normalizeRange(config.labelHeightIn ?? legacy.labelHeightIn, 0.5, 3, defaults.labelHeightIn),
    copiesPerDrink: normalizeRange(config.copiesPerDrink ?? legacy.copiesPerDrink, 1, 5, defaults.copiesPerDrink, true),
    connectionMode: normalizeConnectionMode(config.connectionMode ?? legacy.connectionMode, defaults.connectionMode),
    systemPrinterName: clean(config.systemPrinterName ?? legacy.systemPrinterName ?? defaults.systemPrinterName, 160),
    networkHost: clean(config.networkHost ?? legacy.networkHost ?? defaults.networkHost, 160),
    networkPort: normalizePrinterPort(config.networkPort ?? legacy.networkPort, defaults.networkPort),
    includePrice: Boolean(config.includePrice ?? legacy.includePrice ?? defaults.includePrice),
    autoPrintFromKiosk: Boolean(config.autoPrintFromKiosk ?? legacy.autoPrintFromKiosk ?? defaults.autoPrintFromKiosk)
  };
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
      prep_pickup_minutes INTEGER NOT NULL DEFAULT 15,
      prep_delivery_minutes INTEGER NOT NULL DEFAULT 35,
      prep_dinein_minutes INTEGER NOT NULL DEFAULT 20,
      table_qr_enabled INTEGER NOT NULL DEFAULT 1,
      temporary_closed_until TEXT DEFAULT '',
      printer_config_json TEXT NOT NULL DEFAULT '{}',
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
      stock_enabled INTEGER NOT NULL DEFAULT 0,
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      low_stock_threshold INTEGER NOT NULL DEFAULT 5,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL DEFAULT 'unidad',
      stock_quantity REAL NOT NULL DEFAULT 0,
      low_stock_threshold REAL NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_inventory_items (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (product_id, inventory_item_id)
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

    CREATE TABLE IF NOT EXISTS optional_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      required INTEGER NOT NULL DEFAULT 0,
      max_select INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS optional_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES optional_groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_optional_groups (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES optional_groups(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (product_id, group_id)
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
      table_label TEXT DEFAULT '',
      payment_status TEXT NOT NULL DEFAULT 'Pendiente',
      payment_reference TEXT DEFAULT '',
      subtotal_cents INTEGER NOT NULL,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT DEFAULT '',
      delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL,
      notes TEXT DEFAULT '',
      archived_at TEXT DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS print_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      order_number TEXT DEFAULT '',
      role TEXT NOT NULL,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT DEFAULT '',
      printer_config_json TEXT NOT NULL DEFAULT '{}',
      payload_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      printed_at TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_print_jobs_status_created ON print_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs(order_id);

    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      discount_type TEXT DEFAULT 'percent',
      discount_value INTEGER NOT NULL DEFAULT 0,
      code TEXT DEFAULT '',
      min_order_cents INTEGER NOT NULL DEFAULT 0,
      max_discount_cents INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      starts_at TEXT,
      ends_at TEXT
    );

    CREATE TABLE IF NOT EXISTS accounting_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      category TEXT NOT NULL,
      description TEXT DEFAULT '',
      amount_cents INTEGER NOT NULL,
      payment_method TEXT DEFAULT '',
      entry_date TEXT NOT NULL,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_closings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL,
      opening_cash_cents INTEGER NOT NULL DEFAULT 0,
      counted_cash_cents INTEGER NOT NULL DEFAULT 0,
      cash_sales_cents INTEGER NOT NULL DEFAULT 0,
      card_sales_cents INTEGER NOT NULL DEFAULT 0,
      transfer_sales_cents INTEGER NOT NULL DEFAULT 0,
      delivery_sales_cents INTEGER NOT NULL DEFAULT 0,
      manual_cash_income_cents INTEGER NOT NULL DEFAULT 0,
      cash_expense_cents INTEGER NOT NULL DEFAULT 0,
      withdrawals_cents INTEGER NOT NULL DEFAULT 0,
      expected_cash_cents INTEGER NOT NULL DEFAULT 0,
      difference_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_register_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      opening_cash_cents INTEGER NOT NULL DEFAULT 0,
      opened_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      opened_at TEXT NOT NULL,
      closing_id INTEGER REFERENCES cash_closings(id) ON DELETE SET NULL,
      closing_cash_cents INTEGER NOT NULL DEFAULT 0,
      closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      closed_at TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cash_register_sessions_status ON cash_register_sessions(status, business_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_register_sessions_one_open ON cash_register_sessions(status) WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS supplier_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_name TEXT NOT NULL,
      invoice_number TEXT DEFAULT '',
      purchase_date TEXT NOT NULL,
      payment_method TEXT DEFAULT '',
      total_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL REFERENCES supplier_purchases(id) ON DELETE CASCADE,
      inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'unidad',
      quantity REAL NOT NULL DEFAULT 0,
      unit_cost_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS waste_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      item_name TEXT NOT NULL,
      product_name TEXT DEFAULT '',
      quantity REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'unidad',
      reason TEXT NOT NULL,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      recipient TEXT DEFAULT '',
      template TEXT DEFAULT '',
      status TEXT NOT NULL,
      message TEXT DEFAULT '',
      response_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
  ensureOperationalDefaults();
}

function runMigrations() {
  const addColumn = (table, column, ddl) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };

  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
  if (!sessionColumns.includes('last_rotated_at')) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_rotated_at TEXT NOT NULL DEFAULT ''");
    db.prepare("UPDATE sessions SET last_rotated_at = created_at WHERE last_rotated_at = ''").run();
  }
  addColumn('business', 'prep_pickup_minutes', 'prep_pickup_minutes INTEGER NOT NULL DEFAULT 15');
  addColumn('business', 'prep_delivery_minutes', 'prep_delivery_minutes INTEGER NOT NULL DEFAULT 35');
  addColumn('business', 'prep_dinein_minutes', 'prep_dinein_minutes INTEGER NOT NULL DEFAULT 20');
  addColumn('business', 'table_qr_enabled', 'table_qr_enabled INTEGER NOT NULL DEFAULT 1');
  addColumn('business', 'temporary_closed_until', "temporary_closed_until TEXT DEFAULT ''");
  addColumn('business', 'printer_config_json', "printer_config_json TEXT NOT NULL DEFAULT '{}'");
  addColumn('products', 'stock_enabled', 'stock_enabled INTEGER NOT NULL DEFAULT 0');
  addColumn('products', 'stock_quantity', 'stock_quantity INTEGER NOT NULL DEFAULT 0');
  addColumn('products', 'low_stock_threshold', 'low_stock_threshold INTEGER NOT NULL DEFAULT 5');
  addColumn('orders', 'table_label', "table_label TEXT DEFAULT ''");
  addColumn('orders', 'payment_status', "payment_status TEXT NOT NULL DEFAULT 'Pendiente'");
  addColumn('orders', 'payment_reference', "payment_reference TEXT DEFAULT ''");
  addColumn('orders', 'discount_cents', 'discount_cents INTEGER NOT NULL DEFAULT 0');
  addColumn('orders', 'coupon_code', "coupon_code TEXT DEFAULT ''");
  addColumn('orders', 'archived_at', "archived_at TEXT DEFAULT ''");
  addColumn('promotions', 'code', "code TEXT DEFAULT ''");
  addColumn('promotions', 'min_order_cents', 'min_order_cents INTEGER NOT NULL DEFAULT 0');
  addColumn('promotions', 'max_discount_cents', 'max_discount_cents INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      recipient TEXT DEFAULT '',
      template TEXT DEFAULT '',
      status TEXT NOT NULL,
      message TEXT DEFAULT '',
      response_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL DEFAULT 'unidad',
      stock_quantity REAL NOT NULL DEFAULT 0,
      low_stock_threshold REAL NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_inventory_items (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (product_id, inventory_item_id)
    );
    CREATE TABLE IF NOT EXISTS accounting_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      category TEXT NOT NULL,
      description TEXT DEFAULT '',
      amount_cents INTEGER NOT NULL,
      payment_method TEXT DEFAULT '',
      entry_date TEXT NOT NULL,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cash_closings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL,
      opening_cash_cents INTEGER NOT NULL DEFAULT 0,
      counted_cash_cents INTEGER NOT NULL DEFAULT 0,
      cash_sales_cents INTEGER NOT NULL DEFAULT 0,
      card_sales_cents INTEGER NOT NULL DEFAULT 0,
      transfer_sales_cents INTEGER NOT NULL DEFAULT 0,
      delivery_sales_cents INTEGER NOT NULL DEFAULT 0,
      manual_cash_income_cents INTEGER NOT NULL DEFAULT 0,
      cash_expense_cents INTEGER NOT NULL DEFAULT 0,
      withdrawals_cents INTEGER NOT NULL DEFAULT 0,
      expected_cash_cents INTEGER NOT NULL DEFAULT 0,
      difference_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_register_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      opening_cash_cents INTEGER NOT NULL DEFAULT 0,
      opened_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      opened_at TEXT NOT NULL,
      closing_id INTEGER REFERENCES cash_closings(id) ON DELETE SET NULL,
      closing_cash_cents INTEGER NOT NULL DEFAULT 0,
      closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      closed_at TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cash_register_sessions_status ON cash_register_sessions(status, business_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_register_sessions_one_open ON cash_register_sessions(status) WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS supplier_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_name TEXT NOT NULL,
      invoice_number TEXT DEFAULT '',
      purchase_date TEXT NOT NULL,
      payment_method TEXT DEFAULT '',
      total_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supplier_purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL REFERENCES supplier_purchases(id) ON DELETE CASCADE,
      inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'unidad',
      quantity REAL NOT NULL DEFAULT 0,
      unit_cost_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS waste_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      item_name TEXT NOT NULL,
      product_name TEXT DEFAULT '',
      quantity REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'unidad',
      reason TEXT NOT NULL,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
  `);
  migrateOptionalGroups();
}

function migrateOptionalGroups() {
  const existing = db.prepare('SELECT COUNT(*) AS total FROM optional_groups').get();
  if (existing.total > 0) return;
  const createdAt = nowIso();
  const groupStmt = db.prepare(`
    INSERT INTO optional_groups (name, required, max_select, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `);
  const optionStmt = db.prepare(`
    INSERT INTO optional_options (group_id, name, price_cents, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const linkStmt = db.prepare(`
    INSERT OR IGNORE INTO product_optional_groups (product_id, group_id, sort_order)
    VALUES (?, ?, ?)
  `);

  const variantGroups = db.prepare(`
    SELECT name, MIN(sort_order) AS sort_order
    FROM product_variants
    GROUP BY name
    ORDER BY sort_order, name
  `).all();

  for (const group of variantGroups) {
    const result = groupStmt.run(group.name, 1, 1, Number(group.sort_order || 0), createdAt, createdAt);
    const groupId = Number(result.lastInsertRowid);
    const options = new Set();
    db.prepare('SELECT options_json FROM product_variants WHERE name = ?').all(group.name).forEach((row) => {
      parseJson(row.options_json, []).forEach((option) => options.add(String(option)));
    });
    [...options].forEach((option, index) => optionStmt.run(groupId, option, 0, 1, index + 1, createdAt, createdAt));
    db.prepare('SELECT product_id, sort_order FROM product_variants WHERE name = ?').all(group.name)
      .forEach((row) => linkStmt.run(row.product_id, groupId, row.sort_order || 0));
  }

  const extras = db.prepare('SELECT * FROM extras ORDER BY name').all();
  if (extras.length) {
    const result = groupStmt.run('Extras', 0, 0, 1000, createdAt, createdAt);
    const extrasGroupId = Number(result.lastInsertRowid);
    extras.forEach((extra, index) => {
      optionStmt.run(extrasGroupId, extra.name, extra.price_cents, extra.active, index + 1, createdAt, createdAt);
    });
    db.prepare('SELECT DISTINCT product_id FROM product_extras').all()
      .forEach((row) => linkStmt.run(row.product_id, extrasGroupId, 1000));
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
      is_open_manual, allow_orders_outside_hours, closed_message, hours_json,
      prep_pickup_minutes, prep_delivery_minutes, prep_dinein_minutes, table_qr_enabled,
      temporary_closed_until, printer_config_json, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 15, 35, 20, 1, '', ?, ?, ?)
  `).run(
    'Long Cha',
    'long-cha',
    '/assets/brand/longcha-mark.png',
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
    JSON.stringify(DEFAULT_PRINTER_CONFIG),
    createdAt,
    createdAt
  );

  db.prepare(`
    INSERT OR IGNORE INTO branches (id, name, slug, address, phone, active, created_at, updated_at)
    VALUES (1, ?, 'principal', ?, ?, 1, ?, ?)
  `).run('Sucursal principal', 'Colonia Escalon, San Salvador', '+503 2222-0000', createdAt, createdAt);

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
  migrateOptionalGroups();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('seeded', '1')").run();
}

function ensureOperationalDefaults() {
  const createdAt = nowIso();
  const business = db.prepare('SELECT * FROM business WHERE id = 1').get();

  const branchCount = db.prepare('SELECT COUNT(*) AS total FROM branches').get();
  if (branchCount.total === 0) {
    db.prepare(`
      INSERT OR IGNORE INTO branches (id, name, slug, address, phone, active, created_at, updated_at)
      VALUES (1, ?, 'principal', ?, ?, 1, ?, ?)
    `).run(
      'Sucursal principal',
      business?.address || '',
      business?.phone || '',
      createdAt,
      createdAt
    );
  }

  const driverRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('Repartidor');
  if (driverRole) {
    const driverCount = db.prepare('SELECT COUNT(*) AS total FROM users WHERE role_id = ?').get(driverRole.id);
    if (driverCount.total === 0) {
      db.prepare(`
        INSERT OR IGNORE INTO users (role_id, name, email, password_hash, active, created_at, updated_at)
        VALUES (?, 'Repartidor Demo', 'delivery@demo.com', ?, 1, ?, ?)
      `).run(driverRole.id, hashPassword('Delivery123!'), createdAt, createdAt);
    }
  }

  const promoCount = db.prepare('SELECT COUNT(*) AS total FROM promotions').get();
  if (promoCount.total === 0) {
    db.prepare(`
      INSERT INTO promotions (
        name, description, discount_type, discount_value, code,
        min_order_cents, max_discount_cents, active, starts_at, ends_at
      ) VALUES (?, ?, 'percent', 10, 'LONGCHA10', 500, 0, 1, '', '')
    `).run('Promo lanzamiento', '10% de descuento para pedidos web desde $5.00');
  }

  const inventoryCount = db.prepare('SELECT COUNT(*) AS total FROM inventory_items').get();
  if (inventoryCount.total === 0) {
    const itemStmt = db.prepare(`
      INSERT OR IGNORE INTO inventory_items (
        name, unit, stock_quantity, low_stock_threshold, cost_cents, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    [
      ['Leche entera', 'litro', 20, 5, 180],
      ['Perlas tapioca', 'porcion', 80, 15, 35],
      ['Vaso 16 oz', 'unidad', 120, 25, 12],
      ['Tapa plastica', 'unidad', 120, 25, 8],
      ['Shot espresso', 'shot', 60, 12, 30],
      ['Cream cheese foam', 'porcion', 50, 10, 55]
    ].forEach((item) => itemStmt.run(...item, createdAt, createdAt));
  }

  const recipeCount = db.prepare('SELECT COUNT(*) AS total FROM product_inventory_items').get();
  if (recipeCount.total === 0) {
    seedProductRecipes();
  }

  const permissionMigration = db.prepare("SELECT value FROM settings WHERE key = 'role_permissions_migrated_20260525'").get();
  if (permissionMigration?.value !== '1') {
    const updateRoleStmt = db.prepare('UPDATE roles SET permissions_json = ? WHERE name = ?');
    for (const [name, baseline] of Object.entries(ROLE_PERMISSIONS)) {
      const role = db.prepare('SELECT permissions_json FROM roles WHERE name = ?').get(name);
      if (!role) continue;
      const current = parseJson(role.permissions_json, []);
      const merged = current.includes('*') ? current : [...new Set([...current, ...baseline])];
      updateRoleStmt.run(JSON.stringify(merged), name);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('role_permissions_migrated_20260525', '1')").run();
  }

  const granularPermissionMigration = db.prepare("SELECT value FROM settings WHERE key = 'role_permissions_migrated_20260601'").get();
  if (granularPermissionMigration?.value !== '1') {
    const updateRoleStmt = db.prepare('UPDATE roles SET permissions_json = ? WHERE name = ?');
    for (const [name, baseline] of Object.entries(ROLE_PERMISSIONS)) {
      const role = db.prepare('SELECT permissions_json FROM roles WHERE name = ?').get(name);
      if (!role) continue;
      const current = parseJson(role.permissions_json, []);
      const merged = current.includes('*') ? current : [...new Set([...current, ...baseline])];
      updateRoleStmt.run(JSON.stringify(merged), name);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('role_permissions_migrated_20260601', '1')").run();
  }
}

function seedProductRecipes() {
  const linkStmt = db.prepare(`
    INSERT OR IGNORE INTO product_inventory_items (product_id, inventory_item_id, quantity)
    VALUES (?, ?, ?)
  `);
  const itemId = (name) => db.prepare('SELECT id FROM inventory_items WHERE name = ?').get(name)?.id;
  const productId = (slug) => db.prepare('SELECT id FROM products WHERE slug = ?').get(slug)?.id;
  const recipes = {
    'taro-milk-tea': [
      ['Leche entera', 0.25],
      ['Perlas tapioca', 1],
      ['Vaso 16 oz', 1],
      ['Tapa plastica', 1]
    ],
    'brown-sugar-boba': [
      ['Leche entera', 0.25],
      ['Perlas tapioca', 1],
      ['Vaso 16 oz', 1],
      ['Tapa plastica', 1]
    ],
    'iced-caramel-latte': [
      ['Shot espresso', 1],
      ['Leche entera', 0.2],
      ['Vaso 16 oz', 1],
      ['Tapa plastica', 1]
    ],
    'combo-bubble': [
      ['Leche entera', 0.25],
      ['Perlas tapioca', 1],
      ['Vaso 16 oz', 1],
      ['Tapa plastica', 1]
    ]
  };
  Object.entries(recipes).forEach(([slug, lines]) => {
    const product = productId(slug);
    if (!product) return;
    lines.forEach(([name, quantity]) => {
      const ingredient = itemId(name);
      if (ingredient) linkStmt.run(product, ingredient, quantity);
    });
  });
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
    hours: parseJson(row.hours_json, []),
    prepPickupMinutes: Number(row.prep_pickup_minutes || 15),
    prepDeliveryMinutes: Number(row.prep_delivery_minutes || 35),
    prepDineinMinutes: Number(row.prep_dinein_minutes || 20),
    tableQrEnabled: Boolean(row.table_qr_enabled ?? true),
    temporaryClosedUntil: row.temporary_closed_until || '',
    printerConfig: normalizePrinterConfig(parseJson(row.printer_config_json, {}))
  };
}

export function getBusiness() {
  return mapBusiness(db.prepare('SELECT * FROM business WHERE id = 1').get());
}

export function updateBusiness(input) {
  const current = getBusiness();
  const hours = Array.isArray(input.hours) ? input.hours : current.hours;
  const printerConfig = normalizePrinterConfig(input.printerConfig ?? current.printerConfig);
  db.prepare(`
    UPDATE business SET
      name = ?, logo_url = ?, phone = ?, whatsapp_phone = ?, address = ?,
      is_open_manual = ?, allow_orders_outside_hours = ?, closed_message = ?,
      hours_json = ?, prep_pickup_minutes = ?, prep_delivery_minutes = ?,
      prep_dinein_minutes = ?, table_qr_enabled = ?, temporary_closed_until = ?,
      printer_config_json = ?, updated_at = ?
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
    Math.max(0, Number(input.prepPickupMinutes ?? current.prepPickupMinutes)),
    Math.max(0, Number(input.prepDeliveryMinutes ?? current.prepDeliveryMinutes)),
    Math.max(0, Number(input.prepDineinMinutes ?? current.prepDineinMinutes)),
    boolInt(input.tableQrEnabled ?? current.tableQrEnabled),
    clean(input.temporaryClosedUntil ?? current.temporaryClosedUntil, 80),
    JSON.stringify(printerConfig),
    nowIso()
  );
  return getBusiness();
}

function businessNowParts() {
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    day: weekdayMap[parts.weekday] ?? new Date().getDay(),
    minutes: Number(parts.hour || 0) * 60 + Number(parts.minute || 0)
  };
}

export function isBusinessOpen() {
  const business = getBusiness();
  if (business.temporaryClosedUntil && businessDateTimeMs(business.temporaryClosedUntil) > Date.now()) {
    return { open: false, message: business.closedMessage, reason: 'temporary_closed' };
  }
  const cashRegister = getCashRegisterState();
  if (!cashRegister.open) {
    return {
      open: false,
      message: 'Caja cerrada. Abre caja para recibir pedidos.',
      reason: 'cash_closed',
      cashRegisterOpen: false
    };
  }
  if (business.allowOrdersOutsideHours) return { open: true, message: '', cashRegisterOpen: true };

  const nowParts = businessNowParts();
  const minutes = nowParts.minutes;
  const activeHours = (business.hours || []).filter((item) => item?.active);
  if (activeHours.length) {
    const dayIsOpen = (schedule, currentMinutes, overnightFromPreviousDay = false) => {
      if (!schedule) return false;
      const [openHour, openMinute] = String(schedule.open || '00:00').split(':').map(Number);
      const [closeHour, closeMinute] = String(schedule.close || '00:00').split(':').map(Number);
      const openMinutes = openHour * 60 + openMinute;
      const closeMinutes = closeHour * 60 + closeMinute;
      if (closeMinutes < openMinutes) {
        return overnightFromPreviousDay ? currentMinutes <= closeMinutes : currentMinutes >= openMinutes;
      }
      return !overnightFromPreviousDay && currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
    };
    const today = activeHours.find((item) => Number(item.day) === nowParts.day);
    const yesterday = activeHours.find((item) => Number(item.day) === ((nowParts.day + 6) % 7));
    return {
      open: dayIsOpen(today, minutes) || dayIsOpen(yesterday, minutes, true),
      message: business.closedMessage,
      reason: 'schedule',
      cashRegisterOpen: true
    };
  }

  if (business.isOpenManual) return { open: true, message: '', cashRegisterOpen: true };
  return { open: false, message: business.closedMessage, reason: 'manual_closed', cashRegisterOpen: true };
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

function mapOptionalOption(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    priceCents: row.price_cents,
    price: money(row.price_cents),
    active: Boolean(row.active),
    sortOrder: row.sort_order
  };
}

function mapOptionalGroup(row, includeInactive = false) {
  return {
    id: row.id,
    name: row.name,
    required: Boolean(row.required),
    maxSelect: row.max_select,
    active: Boolean(row.active),
    sortOrder: row.sort_order,
    productCount: row.product_count ?? 0,
    linkedProducts: row.linked_products ? row.linked_products.split('|').filter(Boolean) : [],
    options: getOptionalOptions(row.id, includeInactive)
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
    stockEnabled: Boolean(row.stock_enabled),
    stockQuantity: Number(row.stock_quantity || 0),
    lowStockThreshold: Number(row.low_stock_threshold || 5),
    lowStock: Boolean(row.stock_enabled) && Number(row.stock_quantity || 0) <= Number(row.low_stock_threshold || 5),
    sortOrder: row.sort_order,
    variants: getProductVariants(row.id),
    extras: getProductExtras(row.id, includeInactive),
    optionalGroups: getProductOptionalGroups(row.id, includeInactive)
  };
}

function mapInventoryItem(row) {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    stockQuantity: Number(row.stock_quantity || 0),
    lowStockThreshold: Number(row.low_stock_threshold || 0),
    costCents: Number(row.cost_cents || 0),
    cost: money(row.cost_cents),
    active: Boolean(row.active),
    lowStock: Boolean(row.active) && Number(row.stock_quantity || 0) <= Number(row.low_stock_threshold || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProductRecipe(row) {
  return {
    productId: row.product_id,
    inventoryItemId: row.inventory_item_id,
    name: row.name,
    unit: row.unit,
    quantity: Number(row.quantity || 0),
    costCents: Number(row.cost_cents || 0),
    active: Boolean(row.active)
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

function getOptionalOptions(groupId, includeInactive = false) {
  const where = includeInactive ? 'WHERE group_id = ?' : 'WHERE group_id = ? AND active = 1';
  return db.prepare(`
    SELECT *
    FROM optional_options
    ${where}
    ORDER BY sort_order, name
  `).all(groupId).map(mapOptionalOption);
}

function getProductOptionalGroups(productId, includeInactive = false) {
  const sql = `
    SELECT og.*, pog.sort_order AS product_sort_order
    FROM optional_groups og
    JOIN product_optional_groups pog ON pog.group_id = og.id
    WHERE pog.product_id = ? ${includeInactive ? '' : 'AND og.active = 1'}
    ORDER BY pog.sort_order, og.sort_order, og.name
  `;
  return db.prepare(sql).all(productId).map((row) => mapOptionalGroup(row, includeInactive));
}

export function listOptionalGroups(includeInactive = false) {
  const where = includeInactive ? '' : 'WHERE og.active = 1';
  return db.prepare(`
    SELECT og.*,
      COUNT(DISTINCT pog.product_id) AS product_count,
      GROUP_CONCAT(DISTINCT p.name) AS linked_products_csv
    FROM optional_groups og
    LEFT JOIN product_optional_groups pog ON pog.group_id = og.id
    LEFT JOIN products p ON p.id = pog.product_id
    ${where}
    GROUP BY og.id
    ORDER BY og.active DESC, og.sort_order, og.name
  `).all().map((row) => mapOptionalGroup({
    ...row,
    linked_products: row.linked_products_csv ? row.linked_products_csv.replaceAll(',', '|') : ''
  }, includeInactive));
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
  const currentTime = nowIso();
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
    })),
    promotions: listPromotions().filter((promo) => (
      promo.active &&
      promo.code &&
      (!promo.startsAt || promo.startsAt <= currentTime) &&
      (!promo.endsAt || promo.endsAt >= currentTime)
    ))
  };
}

function getActiveMethod(table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? AND active = 1`).get(id);
}

function validateOptionalSelections(productId, selections) {
  const groups = getProductOptionalGroups(productId, false);
  if (!groups.length) return [];
  const incoming = Array.isArray(selections) ? selections : [];
  const byGroup = new Map(incoming.map((selection) => [Number(selection.groupId), selection]));
  const selected = [];

  for (const group of groups) {
    const selection = byGroup.get(group.id);
    const optionIds = Array.isArray(selection?.optionIds)
      ? selection.optionIds.map(Number).filter(Boolean)
      : Array.isArray(selection?.options)
        ? selection.options.map((option) => Number(option.id)).filter(Boolean)
        : [];
    const uniqueOptionIds = [...new Set(optionIds)];

    if (group.required && uniqueOptionIds.length === 0) {
      throw new ValidationError(`Selecciona al menos una opcion para ${group.name}.`);
    }
    if (group.maxSelect > 0 && uniqueOptionIds.length > group.maxSelect) {
      throw new ValidationError(`${group.name} permite maximo ${group.maxSelect} opcion(es).`);
    }
    if (!uniqueOptionIds.length) continue;

    const allowedOptions = new Map(group.options.map((option) => [option.id, option]));
    for (const optionId of uniqueOptionIds) {
      const option = allowedOptions.get(optionId);
      if (!option || !option.active) throw new ValidationError('Una opcion seleccionada ya no esta disponible.');
      selected.push({
        id: option.id,
        groupId: group.id,
        groupName: group.name,
        name: option.name,
        priceCents: option.priceCents,
        price: option.price
      });
    }
  }

  return selected;
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
    if (product.stock_enabled && product.stock_quantity < quantity) {
      throw new ValidationError(`${product.name} no tiene suficiente inventario.`);
    }

    const selectedOptions = validateOptionalSelections(productId, item.optionSelections);
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

    const extrasTotalCents =
      selectedExtras.reduce((sum, extra) => sum + extra.priceCents, 0) +
      selectedOptions.reduce((sum, option) => sum + option.priceCents, 0);
    const lineTotalCents = (product.base_price_cents + extrasTotalCents) * quantity;
    return {
      productId,
      productName: product.name,
      quantity,
      unitPriceCents: product.base_price_cents,
      extrasTotalCents,
      lineTotalCents,
      variants: item.variants && typeof item.variants === 'object' ? item.variants : {},
      extras: [...selectedExtras, ...selectedOptions],
      notes: clean(item.notes, 500)
    };
  });
}

function applyPromotion(code, subtotalCents) {
  const couponCode = clean(code, 60).toUpperCase();
  if (!couponCode) return { code: '', discountCents: 0, promotion: null };
  const now = nowIso();
  const promo = db.prepare(`
    SELECT * FROM promotions
    WHERE upper(code) = ? AND active = 1
      AND (starts_at IS NULL OR starts_at = '' OR starts_at <= ?)
      AND (ends_at IS NULL OR ends_at = '' OR ends_at >= ?)
    ORDER BY id DESC
    LIMIT 1
  `).get(couponCode, now, now);
  if (!promo) throw new ValidationError('Cupon no valido o expirado.');
  if (subtotalCents < Number(promo.min_order_cents || 0)) {
    throw new ValidationError(`El cupon requiere compra minima de $${money(promo.min_order_cents).toFixed(2)}.`);
  }
  let discountCents = promo.discount_type === 'fixed'
    ? Number(promo.discount_value || 0)
    : Math.round(subtotalCents * (Number(promo.discount_value || 0) / 100));
  if (promo.max_discount_cents > 0) discountCents = Math.min(discountCents, promo.max_discount_cents);
  discountCents = Math.max(0, Math.min(subtotalCents, discountCents));
  return { code: couponCode, discountCents, promotion: mapPromotion(promo) };
}

function deductInventory(items) {
  const updateProductStock = db.prepare(`
    UPDATE products
    SET stock_quantity = MAX(0, stock_quantity - ?),
        available = CASE WHEN stock_enabled = 1 AND stock_quantity - ? <= 0 THEN 0 ELSE available END,
        updated_at = ?
    WHERE id = ? AND stock_enabled = 1
  `);
  const recipeRows = db.prepare(`
    SELECT inventory_item_id, quantity
    FROM product_inventory_items
    WHERE product_id = ?
  `);
  const updateIngredientStock = db.prepare(`
    UPDATE inventory_items
    SET stock_quantity = MAX(0, stock_quantity - ?),
        updated_at = ?
    WHERE id = ? AND active = 1
  `);
  for (const item of items) {
    const changedAt = nowIso();
    updateProductStock.run(item.quantity, item.quantity, changedAt, item.productId);
    recipeRows.all(item.productId).forEach((recipe) => {
      updateIngredientStock.run(Number(recipe.quantity || 0) * Number(item.quantity || 0), changedAt, recipe.inventory_item_id);
    });
  }
}

function createOrderNumber() {
  const date = localBusinessDate().replaceAll('-', '');
  const prefix = `BC${date.slice(2)}`;
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

  const promotion = applyPromotion(payload.couponCode, subtotalCents);
  const totalCents = Math.max(0, subtotalCents + deliveryFeeCents - promotion.discountCents);
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
        status, table_label, payment_status, payment_reference, subtotal_cents, discount_cents,
        coupon_code, delivery_fee_cents, total_cents, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Nuevo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderNumber,
      savedCustomer.id,
      deliveryMethod.id,
      paymentMethod.id,
      deliveryZone?.id || null,
      clean(payload.tableLabel, 80),
      clean(payload.paymentStatus || 'Pendiente', 40),
      clean(payload.paymentReference, 160),
      subtotalCents,
      promotion.discountCents,
      promotion.code,
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
    deductInventory(items);
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
    assignedDeliveryUserName: row.assigned_delivery_user_name || '',
    tableLabel: row.table_label || '',
    paymentStatus: row.payment_status || 'Pendiente',
    paymentReference: row.payment_reference || '',
    subtotalCents: row.subtotal_cents,
    subtotal: money(row.subtotal_cents),
    discountCents: row.discount_cents || 0,
    discount: money(row.discount_cents || 0),
    couponCode: row.coupon_code || '',
    deliveryFeeCents: row.delivery_fee_cents,
    deliveryFee: money(row.delivery_fee_cents),
    totalCents: row.total_cents,
    total: money(row.total_cents),
    notes: row.notes,
    archivedAt: row.archived_at || '',
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
      , du.name AS assigned_delivery_user_name
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    JOIN delivery_methods dm ON dm.id = o.delivery_method_id
    JOIN payment_methods pm ON pm.id = o.payment_method_id
    LEFT JOIN delivery_zones dz ON dz.id = o.delivery_zone_id
    LEFT JOIN users du ON du.id = o.assigned_delivery_user_id
    ${where}
  `;
}

export function getOrderById(id) {
  return hydrateOrder(db.prepare(orderBaseQuery('WHERE o.id = ?')).get(Number(id)));
}

export function getOrderByNumber(orderNumber) {
  return hydrateOrder(db.prepare(orderBaseQuery('WHERE o.order_number = ?')).get(clean(orderNumber, 60)));
}

export function listOrders({ status = 'all', search = '', limit = 80, kds = false, includeArchived = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeArchived) {
    clauses.push("IFNULL(o.archived_at, '') = ''");
  }
  if (status && status !== 'all') {
    clauses.push('o.status = ?');
    params.push(status);
  }
  if (kds) {
    clauses.push("o.status IN ('Aceptado', 'En preparacion', 'Listo')");
  }
  if (search) {
    clauses.push('(o.order_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`${orderBaseQuery(where)} ORDER BY o.created_at DESC LIMIT ?`).all(...params, Number(limit));
  return rows.map((row) => hydrateOrder(row));
}

export function listOrdersByCustomerPhone(phone, { limit = 8 } = {}) {
  const customerPhone = clean(phone, 60);
  if (!customerPhone) return [];
  const rows = db.prepare(`${orderBaseQuery('WHERE c.phone = ?')} ORDER BY o.created_at DESC LIMIT ?`)
    .all(customerPhone, Number(limit));
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

function hydratePrintJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number || '',
    role: row.role,
    jobType: row.job_type,
    status: row.status,
    attempts: row.attempts,
    claimedBy: row.claimed_by || '',
    printerConfig: parseJson(row.printer_config_json, {}),
    payload: parseJson(row.payload_json, {}),
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    printedAt: row.printed_at || ''
  };
}

function validatePrintRole(role) {
  const value = clean(role, 40);
  if (!['caja', 'cocina', 'kiosk', 'etiquetas'].includes(value)) {
    throw new ValidationError('Rol de impresora no valido.');
  }
  return value;
}

export function createPrintJob(input) {
  return createPrintJobs([input])[0];
}

export function createPrintJobs(inputs = []) {
  const jobs = Array.isArray(inputs) ? inputs.filter(Boolean) : [];
  if (!jobs.length) return [];
  const createdAt = nowIso();
  const stmt = db.prepare(`
    INSERT INTO print_jobs (
      order_id, order_number, role, job_type, status, attempts, claimed_by,
      printer_config_json, payload_json, last_error, created_at, updated_at, printed_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, '', ?, ?, '', ?, ?, '')
  `);
  const ids = [];
  db.exec('BEGIN');
  try {
    for (const job of jobs) {
      const result = stmt.run(
        job.orderId || null,
        clean(job.orderNumber, 80),
        validatePrintRole(job.role),
        clean(job.jobType || 'ticket', 60),
        JSON.stringify(job.printerConfig || {}),
        JSON.stringify(job.payload || {}),
        createdAt,
        createdAt
      );
      ids.push(Number(result.lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return ids.map((id) => getPrintJobById(id));
}

export function getPrintJobById(jobId) {
  return hydratePrintJob(db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(Number(jobId)));
}

export function claimPrintJobs({ agentId = '', limit = 5 } = {}) {
  const claimedBy = clean(agentId || 'print-agent', 120);
  const max = Math.max(1, Math.min(20, Number(limit || 5)));
  const updatedAt = nowIso();
  const rows = db.prepare(`
    SELECT * FROM print_jobs
    WHERE status IN ('pending', 'failed') AND attempts < 5
    ORDER BY created_at ASC
    LIMIT ?
  `).all(max);
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const update = db.prepare(`
    UPDATE print_jobs
    SET status = 'claimed', attempts = attempts + 1, claimed_by = ?, updated_at = ?
    WHERE id = ?
  `);
  db.exec('BEGIN');
  try {
    ids.forEach((id) => update.run(claimedBy, updatedAt, id));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return ids.map((id) => getPrintJobById(id));
}

export function completePrintJob(jobId, agentId = '') {
  const printedAt = nowIso();
  db.prepare(`
    UPDATE print_jobs
    SET status = 'printed', claimed_by = ?, updated_at = ?, printed_at = ?, last_error = ''
    WHERE id = ?
  `).run(clean(agentId || 'print-agent', 120), printedAt, printedAt, Number(jobId));
  return getPrintJobById(jobId);
}

export function failPrintJob(jobId, agentId = '', error = '') {
  const current = getPrintJobById(jobId);
  if (!current) throw new ValidationError('Trabajo de impresion no encontrado.', 404);
  const status = Number(current.attempts || 0) >= 5 ? 'cancelled' : 'failed';
  db.prepare(`
    UPDATE print_jobs
    SET status = ?, claimed_by = ?, updated_at = ?, last_error = ?
    WHERE id = ?
  `).run(status, clean(agentId || 'print-agent', 120), nowIso(), clean(error, 800), Number(jobId));
  return getPrintJobById(jobId);
}

export function listPrintJobs({ status = '', limit = 80 } = {}) {
  const max = Math.max(1, Math.min(300, Number(limit || 80)));
  const wanted = clean(status, 40);
  const rows = wanted
    ? db.prepare('SELECT * FROM print_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(wanted, max)
    : db.prepare('SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT ?').all(max);
  return rows.map((row) => hydratePrintJob(row));
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
    extras: listExtras(true),
    optionalGroups: listOptionalGroups(true),
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

function deleteProductInternal(productId) {
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(Number(productId));
  if (!existing) throw new ValidationError('Producto no encontrado.', 404);
  db.prepare('UPDATE order_items SET product_id = NULL WHERE product_id = ?').run(Number(productId));
  db.prepare('UPDATE waste_logs SET product_id = NULL WHERE product_id = ?').run(Number(productId));
  db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(Number(productId));
  db.prepare('DELETE FROM product_extras WHERE product_id = ?').run(Number(productId));
  db.prepare('DELETE FROM product_optional_groups WHERE product_id = ?').run(Number(productId));
  db.prepare('DELETE FROM product_inventory_items WHERE product_id = ?').run(Number(productId));
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(productId));
}

export function deleteCategory(id) {
  const categoryId = Number(id);
  const existing = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!existing) throw new ValidationError('Categoria no encontrada.', 404);
  db.exec('BEGIN');
  try {
    const products = db.prepare('SELECT id FROM products WHERE category_id = ?').all(categoryId);
    products.forEach((product) => deleteProductInternal(product.id));
    db.prepare('DELETE FROM categories WHERE id = ?').run(categoryId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listExtras(includeInactive = false) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db.prepare(`SELECT * FROM extras ${where} ORDER BY active DESC, name`).all().map(mapExtra);
}

export function saveExtra(input) {
  const name = clean(input.name, 100);
  if (!name) throw new ValidationError('El nombre del extra es obligatorio.');
  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO extras (name, price_cents, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name,
    cents(input.price),
    boolInt(input.active ?? true),
    createdAt,
    createdAt
  );
  return listExtras(true).find((extra) => extra.id === Number(result.lastInsertRowid));
}

export function updateExtra(id, input) {
  const extraId = Number(id);
  const existing = db.prepare('SELECT * FROM extras WHERE id = ?').get(extraId);
  if (!existing) throw new ValidationError('Extra no encontrado.', 404);
  const name = clean(input.name ?? existing.name, 100);
  if (!name) throw new ValidationError('El nombre del extra es obligatorio.');
  db.prepare(`
    UPDATE extras SET name = ?, price_cents = ?, active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name,
    cents(input.price ?? money(existing.price_cents)),
    boolInt(input.active ?? Boolean(existing.active)),
    nowIso(),
    extraId
  );
  return listExtras(true).find((extra) => extra.id === extraId);
}

export function deleteExtra(id) {
  db.prepare('DELETE FROM extras WHERE id = ?').run(Number(id));
}

export function saveOptionalGroup(input) {
  const name = clean(input.name, 120);
  if (!name) throw new ValidationError('El nombre del grupo de opcionales es obligatorio.');
  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO optional_groups (name, required, max_select, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    boolInt(input.required),
    Math.max(0, Number(input.maxSelect || 0)),
    boolInt(input.active ?? true),
    Number(input.sortOrder || 0),
    createdAt,
    createdAt
  );
  return listOptionalGroups(true).find((group) => group.id === Number(result.lastInsertRowid));
}

export function updateOptionalGroup(id, input) {
  const groupId = Number(id);
  const existing = db.prepare('SELECT * FROM optional_groups WHERE id = ?').get(groupId);
  if (!existing) throw new ValidationError('Grupo de opcionales no encontrado.', 404);
  const name = clean(input.name ?? existing.name, 120);
  if (!name) throw new ValidationError('El nombre del grupo de opcionales es obligatorio.');
  db.prepare(`
    UPDATE optional_groups SET name = ?, required = ?, max_select = ?, active = ?, sort_order = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name,
    boolInt(input.required ?? Boolean(existing.required)),
    Math.max(0, Number(input.maxSelect ?? existing.max_select)),
    boolInt(input.active ?? Boolean(existing.active)),
    Number(input.sortOrder ?? existing.sort_order),
    nowIso(),
    groupId
  );
  return listOptionalGroups(true).find((group) => group.id === groupId);
}

export function deleteOptionalGroup(id) {
  const groupId = Number(id);
  const existing = db.prepare('SELECT id FROM optional_groups WHERE id = ?').get(groupId);
  if (!existing) throw new ValidationError('Grupo de opcionales no encontrado.', 404);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM product_optional_groups WHERE group_id = ?').run(groupId);
    db.prepare('DELETE FROM optional_options WHERE group_id = ?').run(groupId);
    db.prepare('DELETE FROM optional_groups WHERE id = ?').run(groupId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function saveOptionalOption(input) {
  const groupId = Number(input.groupId);
  if (!db.prepare('SELECT id FROM optional_groups WHERE id = ?').get(groupId)) {
    throw new ValidationError('Selecciona un grupo valido.');
  }
  const name = clean(input.name, 120);
  if (!name) throw new ValidationError('El nombre del opcional es obligatorio.');
  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO optional_options (group_id, name, price_cents, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    groupId,
    name,
    cents(input.price),
    boolInt(input.active ?? true),
    Number(input.sortOrder || 0),
    createdAt,
    createdAt
  );
  return getOptionalOptions(groupId, true).find((option) => option.id === Number(result.lastInsertRowid));
}

export function updateOptionalOption(id, input) {
  const optionId = Number(id);
  const existing = db.prepare('SELECT * FROM optional_options WHERE id = ?').get(optionId);
  if (!existing) throw new ValidationError('Opcional no encontrado.', 404);
  const name = clean(input.name ?? existing.name, 120);
  if (!name) throw new ValidationError('El nombre del opcional es obligatorio.');
  db.prepare(`
    UPDATE optional_options SET name = ?, price_cents = ?, active = ?, sort_order = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name,
    cents(input.price ?? money(existing.price_cents)),
    boolInt(input.active ?? Boolean(existing.active)),
    Number(input.sortOrder ?? existing.sort_order),
    nowIso(),
    optionId
  );
  return getOptionalOptions(existing.group_id, true).find((option) => option.id === optionId);
}

export function deleteOptionalOption(id) {
  const optionId = Number(id);
  const existing = db.prepare('SELECT id FROM optional_options WHERE id = ?').get(optionId);
  if (!existing) throw new ValidationError('Opcional no encontrado.', 404);
  db.prepare('DELETE FROM optional_options WHERE id = ?').run(optionId);
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

function setProductRelations(productId, variants, extraIds, optionalGroupIds) {
  db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(productId);
  db.prepare('DELETE FROM product_extras WHERE product_id = ?').run(productId);
  db.prepare('DELETE FROM product_optional_groups WHERE product_id = ?').run(productId);
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
  const groupStmt = db.prepare('INSERT OR IGNORE INTO product_optional_groups (product_id, group_id, sort_order) VALUES (?, ?, ?)');
  (Array.isArray(optionalGroupIds) ? optionalGroupIds : []).forEach((groupId, index) => {
    if (Number(groupId)) groupStmt.run(productId, Number(groupId), index + 1);
  });
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
        active, available, stock_enabled, stock_quantity, low_stock_threshold,
        sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      boolInt(input.stockEnabled),
      Math.max(0, Number(input.stockQuantity || 0)),
      Math.max(0, Number(input.lowStockThreshold || 5)),
      Number(input.sortOrder || 0),
      createdAt,
      createdAt
    );
    const productId = Number(result.lastInsertRowid);
    setProductRelations(productId, input.variants, input.extraIds, input.optionalGroupIds);
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
        image_url = ?, featured = ?, active = ?, available = ?, stock_enabled = ?,
        stock_quantity = ?, low_stock_threshold = ?, sort_order = ?, updated_at = ?
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
      boolInt(input.stockEnabled ?? Boolean(existing.stock_enabled)),
      Math.max(0, Number(input.stockQuantity ?? existing.stock_quantity)),
      Math.max(0, Number(input.lowStockThreshold ?? existing.low_stock_threshold)),
      Number(input.sortOrder ?? existing.sort_order),
      nowIso(),
      Number(id)
    );
    if ('variants' in input || 'extraIds' in input || 'optionalGroupIds' in input) {
      const currentVariants = getProductVariants(Number(id));
      const currentExtraIds = getProductExtras(Number(id), true).map((extra) => extra.id);
      const currentGroupIds = getProductOptionalGroups(Number(id), true).map((group) => group.id);
      setProductRelations(
        Number(id),
        input.variants ?? currentVariants,
        input.extraIds ?? currentExtraIds,
        input.optionalGroupIds ?? currentGroupIds
      );
    }
    db.exec('COMMIT');
    return getAdminCatalog().products.find((product) => product.id === Number(id));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function deleteProduct(id) {
  db.exec('BEGIN');
  try {
    deleteProductInternal(Number(id));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function mapPromotion(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    code: row.code || '',
    discountType: row.discount_type,
    discountValue: row.discount_value,
    minOrderCents: row.min_order_cents || 0,
    maxDiscountCents: row.max_discount_cents || 0,
    active: Boolean(row.active),
    startsAt: row.starts_at || '',
    endsAt: row.ends_at || ''
  };
}

export function listPromotions() {
  return db.prepare('SELECT * FROM promotions ORDER BY active DESC, id DESC').all().map(mapPromotion);
}

export function savePromotion(input) {
  const name = clean(input.name, 140);
  if (!name) throw new ValidationError('El nombre de la promocion es obligatorio.');
  const code = clean(input.code || slugify(name), 60).toUpperCase();
  const result = db.prepare(`
    INSERT INTO promotions (
      name, description, discount_type, discount_value, code, min_order_cents,
      max_discount_cents, active, starts_at, ends_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    clean(input.description, 400),
    input.discountType === 'fixed' ? 'fixed' : 'percent',
    input.discountType === 'fixed' ? cents(input.discountValue) : Math.max(0, Number(input.discountValue || 0)),
    code,
    cents(input.minOrder || 0),
    cents(input.maxDiscount || 0),
    boolInt(input.active ?? true),
    clean(input.startsAt, 80),
    clean(input.endsAt, 80)
  );
  return listPromotions().find((promo) => promo.id === Number(result.lastInsertRowid));
}

export function updatePromotion(id, input) {
  const promoId = Number(id);
  const existing = db.prepare('SELECT * FROM promotions WHERE id = ?').get(promoId);
  if (!existing) throw new ValidationError('Promocion no encontrada.', 404);
  const discountType = input.discountType || existing.discount_type;
  db.prepare(`
    UPDATE promotions SET name = ?, description = ?, discount_type = ?, discount_value = ?,
      code = ?, min_order_cents = ?, max_discount_cents = ?, active = ?, starts_at = ?, ends_at = ?
    WHERE id = ?
  `).run(
    clean(input.name ?? existing.name, 140),
    clean(input.description ?? existing.description, 400),
    discountType === 'fixed' ? 'fixed' : 'percent',
    discountType === 'fixed' ? cents(input.discountValue ?? money(existing.discount_value)) : Math.max(0, Number(input.discountValue ?? existing.discount_value)),
    clean(input.code ?? existing.code, 60).toUpperCase(),
    cents(input.minOrder ?? money(existing.min_order_cents)),
    cents(input.maxDiscount ?? money(existing.max_discount_cents)),
    boolInt(input.active ?? Boolean(existing.active)),
    clean(input.startsAt ?? existing.starts_at, 80),
    clean(input.endsAt ?? existing.ends_at, 80),
    promoId
  );
  return listPromotions().find((promo) => promo.id === promoId);
}

export function deletePromotion(id) {
  db.prepare('DELETE FROM promotions WHERE id = ?').run(Number(id));
}

function mapDeliveryZone(row) {
  return {
    id: row.id,
    name: row.name,
    feeCents: row.fee_cents,
    fee: money(row.fee_cents),
    minimumOrderCents: row.minimum_order_cents,
    minimumOrder: money(row.minimum_order_cents),
    active: Boolean(row.active)
  };
}

function mapDeliveryMethod(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    active: Boolean(row.active),
    requiresAddress: Boolean(row.requires_address)
  };
}

export function getDeliveryAdmin() {
  return {
    methods: db.prepare('SELECT * FROM delivery_methods ORDER BY id').all().map(mapDeliveryMethod),
    zones: db.prepare('SELECT * FROM delivery_zones ORDER BY active DESC, fee_cents, name').all().map(mapDeliveryZone),
    drivers: listUsers().filter((user) => user.roleName === 'Repartidor' || user.roleName === 'Administrador')
  };
}

export function saveDeliveryZone(input) {
  const name = clean(input.name, 120);
  if (!name) throw new ValidationError('El nombre de la zona es obligatorio.');
  const result = db.prepare(`
    INSERT INTO delivery_zones (name, fee_cents, minimum_order_cents, active)
    VALUES (?, ?, ?, ?)
  `).run(name, cents(input.fee), cents(input.minimumOrder), boolInt(input.active ?? true));
  return getDeliveryAdmin().zones.find((zone) => zone.id === Number(result.lastInsertRowid));
}

export function updateDeliveryZone(id, input) {
  const zoneId = Number(id);
  const existing = db.prepare('SELECT * FROM delivery_zones WHERE id = ?').get(zoneId);
  if (!existing) throw new ValidationError('Zona no encontrada.', 404);
  db.prepare('UPDATE delivery_zones SET name = ?, fee_cents = ?, minimum_order_cents = ?, active = ? WHERE id = ?')
    .run(
      clean(input.name ?? existing.name, 120),
      cents(input.fee ?? money(existing.fee_cents)),
      cents(input.minimumOrder ?? money(existing.minimum_order_cents)),
      boolInt(input.active ?? Boolean(existing.active)),
      zoneId
    );
  return getDeliveryAdmin().zones.find((zone) => zone.id === zoneId);
}

export function updateDeliveryMethod(id, input) {
  const methodId = Number(id);
  const existing = db.prepare('SELECT * FROM delivery_methods WHERE id = ?').get(methodId);
  if (!existing) throw new ValidationError('Metodo de entrega no encontrado.', 404);
  db.prepare('UPDATE delivery_methods SET name = ?, active = ?, requires_address = ? WHERE id = ?')
    .run(
      clean(input.name ?? existing.name, 120),
      boolInt(input.active ?? Boolean(existing.active)),
      boolInt(input.requiresAddress ?? Boolean(existing.requires_address)),
      methodId
    );
  return getDeliveryAdmin().methods.find((method) => method.id === methodId);
}

export function updateOrderAssignment(orderId, assignedDeliveryUserId) {
  const order = getOrderById(Number(orderId));
  if (!order) throw new ValidationError('Pedido no encontrado.', 404);
  const driverId = Number(assignedDeliveryUserId || 0);
  if (driverId && !db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(driverId)) {
    throw new ValidationError('Repartidor no valido.');
  }
  db.prepare('UPDATE orders SET assigned_delivery_user_id = ?, updated_at = ? WHERE id = ?')
    .run(driverId || null, nowIso(), order.id);
  return getOrderById(order.id);
}

export function updateOrderPayment(orderId, input) {
  const order = getOrderById(Number(orderId));
  if (!order) throw new ValidationError('Pedido no encontrado.', 404);
  const allowed = ['Pendiente', 'Pagado', 'Parcial', 'Reembolsado'];
  const status = allowed.includes(input.paymentStatus) ? input.paymentStatus : 'Pendiente';
  db.prepare('UPDATE orders SET payment_status = ?, payment_reference = ?, updated_at = ? WHERE id = ?')
    .run(status, clean(input.paymentReference ?? order.paymentReference, 160), nowIso(), order.id);
  return getOrderById(order.id);
}

export function listInventoryItems(includeInactive = true) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db.prepare(`
    SELECT *
    FROM inventory_items
    ${where}
    ORDER BY active DESC, name
  `).all().map(mapInventoryItem);
}

export function listProductRecipes(productId = null) {
  const params = [];
  const where = productId ? 'WHERE pii.product_id = ?' : '';
  if (productId) params.push(Number(productId));
  return db.prepare(`
    SELECT pii.product_id, pii.inventory_item_id, pii.quantity,
      ii.name, ii.unit, ii.cost_cents, ii.active
    FROM product_inventory_items pii
    JOIN inventory_items ii ON ii.id = pii.inventory_item_id
    ${where}
    ORDER BY pii.product_id, ii.name
  `).all(...params).map(mapProductRecipe);
}

export function getInventoryAdmin() {
  return {
    products: getAdminCatalog().products,
    items: listInventoryItems(true),
    recipes: listProductRecipes()
  };
}

export function saveInventoryItem(input) {
  const name = clean(input.name, 120);
  if (!name) throw new ValidationError('El nombre del insumo es obligatorio.');
  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO inventory_items (
      name, unit, stock_quantity, low_stock_threshold, cost_cents, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    clean(input.unit || 'unidad', 40),
    Math.max(0, Number(input.stockQuantity || 0)),
    Math.max(0, Number(input.lowStockThreshold || 0)),
    cents(input.cost),
    boolInt(input.active ?? true),
    createdAt,
    createdAt
  );
  return listInventoryItems(true).find((item) => item.id === Number(result.lastInsertRowid));
}

export function updateInventoryItem(id, input) {
  const itemId = Number(id);
  const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
  if (!existing) throw new ValidationError('Insumo no encontrado.', 404);
  const name = clean(input.name ?? existing.name, 120);
  if (!name) throw new ValidationError('El nombre del insumo es obligatorio.');
  db.prepare(`
    UPDATE inventory_items
    SET name = ?, unit = ?, stock_quantity = ?, low_stock_threshold = ?, cost_cents = ?,
      active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name,
    clean(input.unit ?? existing.unit, 40),
    Math.max(0, Number(input.stockQuantity ?? existing.stock_quantity)),
    Math.max(0, Number(input.lowStockThreshold ?? existing.low_stock_threshold)),
    cents(input.cost ?? money(existing.cost_cents)),
    boolInt(input.active ?? Boolean(existing.active)),
    nowIso(),
    itemId
  );
  return listInventoryItems(true).find((item) => item.id === itemId);
}

export function deleteInventoryItem(id) {
  db.prepare('DELETE FROM inventory_items WHERE id = ?').run(Number(id));
}

export function updateProductRecipe(productId, input) {
  const id = Number(productId);
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) {
    throw new ValidationError('Producto no encontrado.', 404);
  }
  const items = Array.isArray(input.items) ? input.items : [];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM product_inventory_items WHERE product_id = ?').run(id);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO product_inventory_items (product_id, inventory_item_id, quantity)
      VALUES (?, ?, ?)
    `);
    items.forEach((item) => {
      const inventoryItemId = Number(item.inventoryItemId);
      const quantity = Number(item.quantity || 0);
      if (!inventoryItemId || quantity <= 0) return;
      if (db.prepare('SELECT id FROM inventory_items WHERE id = ?').get(inventoryItemId)) {
        insert.run(id, inventoryItemId, quantity);
      }
    });
    db.exec('COMMIT');
    return listProductRecipes(id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function updateProductInventory(id, input) {
  const productId = Number(id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!existing) throw new ValidationError('Producto no encontrado.', 404);
  db.prepare(`
    UPDATE products SET stock_enabled = ?, stock_quantity = ?, low_stock_threshold = ?,
      available = ?, updated_at = ?
    WHERE id = ?
  `).run(
    boolInt(input.stockEnabled ?? Boolean(existing.stock_enabled)),
    Math.max(0, Number(input.stockQuantity ?? existing.stock_quantity)),
    Math.max(0, Number(input.lowStockThreshold ?? existing.low_stock_threshold)),
    boolInt(input.available ?? Boolean(existing.available)),
    nowIso(),
    productId
  );
  return getAdminCatalog().products.find((product) => product.id === productId);
}

function mapAccountingEntry(row) {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    description: row.description,
    amountCents: Number(row.amount_cents || 0),
    amount: money(row.amount_cents),
    paymentMethod: row.payment_method,
    entryDate: row.entry_date,
    createdByUserId: row.created_by_user_id,
    createdByUserName: row.created_by_user_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listAccountingEntries({ limit = 140 } = {}) {
  return db.prepare(`
    SELECT ae.*, u.name AS created_by_user_name
    FROM accounting_entries ae
    LEFT JOIN users u ON u.id = ae.created_by_user_id
    ORDER BY ae.entry_date DESC, ae.id DESC
    LIMIT ?
  `).all(Number(limit)).map(mapAccountingEntry);
}

function localBusinessDate() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  } catch {
    return nowIso().slice(0, 10);
  }
}

function paymentBucketsForDate(date = localBusinessDate()) {
  const rows = db.prepare(`
    SELECT lower(pm.slug) AS slug, pm.name, COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS sales_cents
    FROM orders o
    JOIN payment_methods pm ON pm.id = o.payment_method_id
    WHERE o.status != 'Cancelado' AND ${businessDateSql('o.created_at')} = ?
    GROUP BY pm.id
    ORDER BY sales_cents DESC
  `).all(date);
  const byDelivery = db.prepare(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS sales_cents
    FROM orders o
    JOIN delivery_methods dm ON dm.id = o.delivery_method_id
    WHERE o.status != 'Cancelado' AND dm.slug = 'delivery' AND ${businessDateSql('o.created_at')} = ?
  `).get(date);
  const classified = rows.reduce((acc, row) => {
    const slug = row.slug || '';
    if (slug.includes('efectivo') || slug.includes('contra')) acc.cash += Number(row.sales_cents || 0);
    else if (slug.includes('tarjeta')) acc.card += Number(row.sales_cents || 0);
    else if (slug.includes('transfer')) acc.transfer += Number(row.sales_cents || 0);
    else acc.other += Number(row.sales_cents || 0);
    return acc;
  }, { cash: 0, card: 0, transfer: 0, other: 0 });
  return {
    rows: rows.map((row) => ({
      name: row.name,
      slug: row.slug,
      orders: row.orders,
      salesCents: Number(row.sales_cents || 0),
      sales: money(row.sales_cents)
    })),
    cashSalesCents: classified.cash,
    cardSalesCents: classified.card,
    transferSalesCents: classified.transfer,
    otherSalesCents: classified.other,
    deliverySalesCents: Number(byDelivery.sales_cents || 0),
    deliveryOrders: Number(byDelivery.orders || 0)
  };
}

function cashMovementsForDate(date = localBusinessDate()) {
  const manualCashIncome = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total
    FROM accounting_entries
    WHERE type = 'income'
      AND lower(payment_method) LIKE '%efectivo%'
      AND date(entry_date) = date(?)
  `).get(date).total;
  const cashExpense = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total
    FROM accounting_entries
    WHERE type = 'expense'
      AND lower(payment_method) LIKE '%efectivo%'
      AND date(entry_date) = date(?)
  `).get(date).total;
  return {
    manualCashIncomeCents: Number(manualCashIncome || 0),
    cashExpenseCents: Number(cashExpense || 0)
  };
}

function mapCashClosing(row) {
  return {
    id: row.id,
    businessDate: row.business_date,
    openingCashCents: row.opening_cash_cents,
    openingCash: money(row.opening_cash_cents),
    countedCashCents: row.counted_cash_cents,
    countedCash: money(row.counted_cash_cents),
    cashSalesCents: row.cash_sales_cents,
    cardSalesCents: row.card_sales_cents,
    transferSalesCents: row.transfer_sales_cents,
    deliverySalesCents: row.delivery_sales_cents,
    manualCashIncomeCents: row.manual_cash_income_cents,
    cashExpenseCents: row.cash_expense_cents,
    withdrawalsCents: row.withdrawals_cents,
    expectedCashCents: row.expected_cash_cents,
    expectedCash: money(row.expected_cash_cents),
    differenceCents: row.difference_cents,
    difference: money(row.difference_cents),
    notes: row.notes,
    closedByUserName: row.closed_by_user_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCashRegisterSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    businessDate: row.business_date,
    status: row.status,
    open: row.status === 'open',
    openingCashCents: Number(row.opening_cash_cents || 0),
    openingCash: money(row.opening_cash_cents),
    openedByUserId: row.opened_by_user_id,
    openedByUserName: row.opened_by_user_name || '',
    openedAt: row.opened_at,
    closingId: row.closing_id,
    closingCashCents: Number(row.closing_cash_cents || 0),
    closingCash: money(row.closing_cash_cents),
    closedByUserId: row.closed_by_user_id,
    closedByUserName: row.closed_by_user_name || '',
    closedAt: row.closed_at || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getOpenCashRegisterSession() {
  return mapCashRegisterSession(db.prepare(`
    SELECT crs.*, opened.name AS opened_by_user_name, closed.name AS closed_by_user_name
    FROM cash_register_sessions crs
    LEFT JOIN users opened ON opened.id = crs.opened_by_user_id
    LEFT JOIN users closed ON closed.id = crs.closed_by_user_id
    WHERE crs.status = 'open'
    ORDER BY crs.opened_at DESC, crs.id DESC
    LIMIT 1
  `).get());
}

export function getCashRegisterState() {
  const session = getOpenCashRegisterSession();
  return {
    open: Boolean(session),
    businessDate: session?.businessDate || localBusinessDate(),
    session
  };
}

export function listCashClosings({ limit = 20 } = {}) {
  return db.prepare(`
    SELECT cc.*, u.name AS closed_by_user_name
    FROM cash_closings cc
    LEFT JOIN users u ON u.id = cc.closed_by_user_id
    ORDER BY cc.business_date DESC, cc.id DESC
    LIMIT ?
  `).all(Number(limit)).map(mapCashClosing);
}

export function getCashCloseContext(date = null) {
  const cashRegister = getCashRegisterState();
  const businessDate = clean(date || cashRegister.businessDate || localBusinessDate(), 20);
  const payment = paymentBucketsForDate(businessDate);
  const movements = cashMovementsForDate(businessDate);
  return {
    businessDate,
    cashRegister,
    paymentSummary: payment.rows,
    cashSalesCents: payment.cashSalesCents,
    cardSalesCents: payment.cardSalesCents,
    transferSalesCents: payment.transferSalesCents,
    deliverySalesCents: payment.deliverySalesCents,
    manualCashIncomeCents: movements.manualCashIncomeCents,
    cashExpenseCents: movements.cashExpenseCents
  };
}

export function saveCashOpening(input, userId = null) {
  const existing = getOpenCashRegisterSession();
  if (existing) {
    throw new ValidationError('Ya hay una caja abierta. Cierra la caja actual antes de abrir otra.', 409);
  }
  const businessDate = clean(input.businessDate || localBusinessDate(), 20);
  const openingCashCents = cents(input.openingCash);
  if (openingCashCents < 0) throw new ValidationError('El fondo inicial no puede ser negativo.');
  const createdAt = nowIso();
  try {
    db.prepare(`
      INSERT INTO cash_register_sessions (
        business_date, status, opening_cash_cents, opened_by_user_id, opened_at,
        notes, created_at, updated_at
      ) VALUES (?, 'open', ?, ?, ?, ?, ?, ?)
    `).run(
      businessDate,
      openingCashCents,
      userId || null,
      createdAt,
      clean(input.notes, 600),
      createdAt,
      createdAt
    );
  } catch (error) {
    if (String(error.message || '').includes('idx_cash_register_sessions_one_open')) {
      throw new ValidationError('Ya hay una caja abierta. Cierra la caja actual antes de abrir otra.', 409);
    }
    throw error;
  }
  return getCashRegisterState();
}

function archiveOrdersBeforeBusinessDate(date) {
  const archivedAt = nowIso();
  const result = db.prepare(`
    UPDATE orders
    SET archived_at = ?, updated_at = ?
    WHERE IFNULL(archived_at, '') = ''
      AND ${businessDateSql('created_at')} < ?
  `).run(archivedAt, archivedAt, date);
  return Number(result.changes || 0);
}

export function saveCashClosing(input, userId = null) {
  const openSession = getOpenCashRegisterSession();
  if (!openSession) throw new ValidationError('No hay caja abierta para cerrar.', 409);
  const businessDate = openSession.businessDate;
  const context = getCashCloseContext(businessDate);
  const openingCashCents = openSession.openingCashCents;
  const countedCashCents = cents(input.countedCash);
  const withdrawalsCents = cents(input.withdrawals);
  const expectedCashCents = openingCashCents + context.cashSalesCents + context.manualCashIncomeCents - context.cashExpenseCents - withdrawalsCents;
  const differenceCents = countedCashCents - expectedCashCents;
  const createdAt = nowIso();
  db.exec('BEGIN');
  try {
    const result = db.prepare(`
      INSERT INTO cash_closings (
        business_date, opening_cash_cents, counted_cash_cents, cash_sales_cents,
        card_sales_cents, transfer_sales_cents, delivery_sales_cents, manual_cash_income_cents,
        cash_expense_cents, withdrawals_cents, expected_cash_cents, difference_cents,
        notes, closed_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      businessDate,
      openingCashCents,
      countedCashCents,
      context.cashSalesCents,
      context.cardSalesCents,
      context.transferSalesCents,
      context.deliverySalesCents,
      context.manualCashIncomeCents,
      context.cashExpenseCents,
      withdrawalsCents,
      expectedCashCents,
      differenceCents,
      clean(input.notes, 600),
      userId || null,
      createdAt,
      createdAt
    );
    db.prepare(`
      UPDATE cash_register_sessions
      SET status = 'closed', closing_id = ?, closing_cash_cents = ?, closed_by_user_id = ?,
        closed_at = ?, notes = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(
      Number(result.lastInsertRowid),
      countedCashCents,
      userId || null,
      createdAt,
      clean(input.notes, 600),
      createdAt,
      openSession.id
    );
    const archivedOrders = archiveOrdersBeforeBusinessDate(businessDate);
    db.exec('COMMIT');
    const closing = listCashClosings({ limit: 60 }).find((item) => item.id === Number(result.lastInsertRowid));
    return { ...closing, archivedOrders };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function mapSupplierPurchase(row) {
  const items = db.prepare(`
    SELECT *
    FROM supplier_purchase_items
    WHERE purchase_id = ?
    ORDER BY id
  `).all(row.id).map((item) => ({
    id: item.id,
    inventoryItemId: item.inventory_item_id,
    itemName: item.item_name,
    unit: item.unit,
    quantity: Number(item.quantity || 0),
    unitCostCents: item.unit_cost_cents,
    unitCost: money(item.unit_cost_cents),
    totalCents: item.total_cents,
    total: money(item.total_cents)
  }));
  return {
    id: row.id,
    supplierName: row.supplier_name,
    invoiceNumber: row.invoice_number,
    purchaseDate: row.purchase_date,
    paymentMethod: row.payment_method,
    totalCents: row.total_cents,
    total: money(row.total_cents),
    notes: row.notes,
    createdByUserName: row.created_by_user_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items
  };
}

export function listSupplierPurchases({ limit = 40 } = {}) {
  return db.prepare(`
    SELECT sp.*, u.name AS created_by_user_name
    FROM supplier_purchases sp
    LEFT JOIN users u ON u.id = sp.created_by_user_id
    ORDER BY sp.purchase_date DESC, sp.id DESC
    LIMIT ?
  `).all(Number(limit)).map(mapSupplierPurchase);
}

export function saveSupplierPurchase(input, userId = null) {
  const supplierName = clean(input.supplierName, 160);
  const purchaseDate = clean(input.purchaseDate || localBusinessDate(), 20);
  const lines = Array.isArray(input.items) ? input.items : [];
  if (!supplierName) throw new ValidationError('El proveedor es obligatorio.');
  if (!lines.length) throw new ValidationError('Agrega al menos un insumo a la compra.');

  const preparedLines = lines.map((line) => {
    const inventoryItemId = Number(line.inventoryItemId);
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(inventoryItemId);
    const quantity = Number(line.quantity || 0);
    const unitCostCents = cents(line.unitCost);
    if (!item || quantity <= 0 || unitCostCents < 0) return null;
    return {
      inventoryItemId,
      item,
      quantity,
      unitCostCents,
      totalCents: Math.round(quantity * unitCostCents)
    };
  }).filter(Boolean);
  if (!preparedLines.length) throw new ValidationError('Selecciona insumos validos para la compra.');
  const totalCents = preparedLines.reduce((sum, line) => sum + line.totalCents, 0);
  const createdAt = nowIso();

  db.exec('BEGIN');
  try {
    const result = db.prepare(`
      INSERT INTO supplier_purchases (
        supplier_name, invoice_number, purchase_date, payment_method, total_cents,
        notes, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      supplierName,
      clean(input.invoiceNumber, 80),
      purchaseDate,
      clean(input.paymentMethod, 80),
      totalCents,
      clean(input.notes, 600),
      userId || null,
      createdAt,
      createdAt
    );
    const purchaseId = Number(result.lastInsertRowid);
    const itemStmt = db.prepare(`
      INSERT INTO supplier_purchase_items (
        purchase_id, inventory_item_id, item_name, unit, quantity, unit_cost_cents, total_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateInventory = db.prepare(`
      UPDATE inventory_items
      SET stock_quantity = ?, cost_cents = ?, updated_at = ?
      WHERE id = ?
    `);
    preparedLines.forEach((line) => {
      itemStmt.run(
        purchaseId,
        line.inventoryItemId,
        line.item.name,
        line.item.unit,
        line.quantity,
        line.unitCostCents,
        line.totalCents
      );
      const currentStock = Number(line.item.stock_quantity || 0);
      const nextStock = currentStock + line.quantity;
      const currentValue = currentStock * Number(line.item.cost_cents || 0);
      const nextCost = nextStock > 0
        ? Math.round((currentValue + line.totalCents) / nextStock)
        : line.unitCostCents;
      updateInventory.run(nextStock, nextCost, createdAt, line.inventoryItemId);
    });
    db.prepare(`
      INSERT INTO accounting_entries (
        type, category, description, amount_cents, payment_method, entry_date,
        created_by_user_id, created_at, updated_at
      ) VALUES ('expense', 'Compra de insumos', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `Proveedor: ${supplierName}${input.invoiceNumber ? ` / Factura: ${clean(input.invoiceNumber, 80)}` : ''}`,
      totalCents,
      clean(input.paymentMethod, 80),
      purchaseDate,
      userId || null,
      createdAt,
      createdAt
    );
    db.exec('COMMIT');
    return listSupplierPurchases({ limit: 80 }).find((purchase) => purchase.id === purchaseId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function mapWasteLog(row) {
  return {
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    productId: row.product_id,
    itemName: row.item_name,
    productName: row.product_name,
    quantity: Number(row.quantity || 0),
    unit: row.unit,
    reason: row.reason,
    costCents: row.cost_cents,
    cost: money(row.cost_cents),
    notes: row.notes,
    createdByUserName: row.created_by_user_name || '',
    createdAt: row.created_at
  };
}

export function listWasteLogs({ limit = 50 } = {}) {
  return db.prepare(`
    SELECT wl.*, u.name AS created_by_user_name
    FROM waste_logs wl
    LEFT JOIN users u ON u.id = wl.created_by_user_id
    ORDER BY wl.created_at DESC
    LIMIT ?
  `).all(Number(limit)).map(mapWasteLog);
}

export function saveWasteLog(input, userId = null) {
  const inventoryItemId = Number(input.inventoryItemId);
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(inventoryItemId);
  if (!item) throw new ValidationError('Selecciona un insumo valido.');
  const quantity = Number(input.quantity || 0);
  if (quantity <= 0) throw new ValidationError('La cantidad de merma debe ser mayor a cero.');
  const productId = Number(input.productId || 0) || null;
  const product = productId ? db.prepare('SELECT name FROM products WHERE id = ?').get(productId) : null;
  const reason = clean(input.reason || 'Merma operativa', 120);
  const costCents = Math.round(quantity * Number(item.cost_cents || 0));
  const createdAt = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE inventory_items
      SET stock_quantity = MAX(0, stock_quantity - ?), updated_at = ?
      WHERE id = ?
    `).run(quantity, createdAt, inventoryItemId);
    const result = db.prepare(`
      INSERT INTO waste_logs (
        inventory_item_id, product_id, item_name, product_name, quantity, unit,
        reason, cost_cents, notes, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inventoryItemId,
      productId,
      item.name,
      product?.name || '',
      quantity,
      item.unit,
      reason,
      costCents,
      clean(input.notes, 600),
      userId || null,
      createdAt
    );
    db.exec('COMMIT');
    return listWasteLogs({ limit: 80 }).find((entry) => entry.id === Number(result.lastInsertRowid));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function estimatedCogsForMonth() {
  const currentMonth = localBusinessDate().slice(0, 7);
  const row = db.prepare(`
    SELECT COALESCE(SUM(oi.quantity * pii.quantity * ii.cost_cents), 0) AS total
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN product_inventory_items pii ON pii.product_id = oi.product_id
    JOIN inventory_items ii ON ii.id = pii.inventory_item_id
    WHERE o.status != 'Cancelado'
      AND ${businessMonthSql('o.created_at')} = ?
  `).get(currentMonth);
  return Math.round(Number(row.total || 0));
}

function getProductCosting() {
  const recipes = listProductRecipes();
  const currentMonth = localBusinessDate().slice(0, 7);
  const monthlySales = db.prepare(`
    SELECT oi.product_id, SUM(oi.quantity) AS quantity, SUM(oi.line_total_cents) AS sales_cents
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status != 'Cancelado'
      AND ${businessMonthSql('o.created_at')} = ?
    GROUP BY oi.product_id
  `).all(currentMonth);
  const salesByProduct = new Map(monthlySales.map((row) => [row.product_id, row]));
  return getAdminCatalog().products.map((product) => {
    const lines = recipes.filter((recipe) => recipe.productId === product.id).map((recipe) => ({
      ...recipe,
      lineCostCents: Math.round(Number(recipe.quantity || 0) * Number(recipe.costCents || 0))
    }));
    const recipeCostCents = lines.reduce((sum, line) => sum + line.lineCostCents, 0);
    const grossProfitCents = Number(product.basePriceCents || 0) - recipeCostCents;
    const marginPct = product.basePriceCents > 0 ? Math.round((grossProfitCents / product.basePriceCents) * 1000) / 10 : 0;
    const sales = salesByProduct.get(product.id);
    return {
      productId: product.id,
      productName: product.name,
      categoryName: product.categoryName,
      priceCents: product.basePriceCents,
      price: money(product.basePriceCents),
      recipeCostCents,
      recipeCost: money(recipeCostCents),
      grossProfitCents,
      grossProfit: money(grossProfitCents),
      marginPct,
      soldThisMonth: Number(sales?.quantity || 0),
      salesThisMonthCents: Number(sales?.sales_cents || 0),
      salesThisMonth: money(sales?.sales_cents || 0),
      lines
    };
  }).sort((a, b) => b.soldThisMonth - a.soldThisMonth || b.grossProfitCents - a.grossProfitCents);
}

export function getAccounting() {
  const notCancelled = "status != 'Cancelado'";
  const scalar = (sql, ...params) => db.prepare(sql).get(...params);
  const todayDate = localBusinessDate();
  const currentMonth = todayDate.slice(0, 7);
  const todaySales = scalar(`
    SELECT COALESCE(SUM(total_cents), 0) AS total
    FROM orders
    WHERE ${notCancelled} AND ${businessDateSql()} = ?
  `, todayDate).total;
  const monthSales = scalar(`
    SELECT COALESCE(SUM(total_cents), 0) AS total
    FROM orders
    WHERE ${notCancelled} AND ${businessMonthSql()} = ?
  `, currentMonth).total;
  const manualMonth = scalar(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents ELSE 0 END), 0) AS expenses
    FROM accounting_entries
    WHERE strftime('%Y-%m', entry_date) = ?
  `, currentMonth);
  const todayExpenses = scalar(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total
    FROM accounting_entries
    WHERE type = 'expense' AND date(entry_date) = date(?)
  `, todayDate).total;
  const monthPurchases = scalar(`
    SELECT COALESCE(SUM(total_cents), 0) AS total
    FROM supplier_purchases
    WHERE strftime('%Y-%m', purchase_date) = ?
  `, currentMonth).total;
  const monthWaste = scalar(`
    SELECT COALESCE(SUM(cost_cents), 0) AS total
    FROM waste_logs
    WHERE ${businessMonthSql('created_at')} = ?
  `, currentMonth).total;
  const byCategory = db.prepare(`
    SELECT category AS name, type, COUNT(*) AS entries, COALESCE(SUM(amount_cents), 0) AS amount_cents
    FROM accounting_entries
    GROUP BY type, category
    ORDER BY type, amount_cents DESC
  `).all().map((row) => ({
    name: row.name,
    type: row.type,
    entries: row.entries,
    amountCents: row.amount_cents,
    amount: money(row.amount_cents)
  }));

  const monthCogsCents = estimatedCogsForMonth();
  const monthIncomeCents = Number(monthSales || 0) + Number(manualMonth.income || 0);
  const monthExpenseCents = Number(manualMonth.expenses || 0);
  const operatingExpenseCents = Math.max(0, monthExpenseCents - Number(monthPurchases || 0));
  const grossProfitCents = Number(monthSales || 0) - monthCogsCents;
  return {
    summary: {
      todaySalesCents: Number(todaySales || 0),
      todaySales: money(todaySales),
      todayExpensesCents: Number(todayExpenses || 0),
      todayExpenses: money(todayExpenses),
      monthSalesCents: Number(monthSales || 0),
      monthSales: money(monthSales),
      manualIncomeCents: Number(manualMonth.income || 0),
      manualIncome: money(manualMonth.income),
      monthExpenseCents,
      monthExpenses: money(monthExpenseCents),
      purchasesMonthCents: Number(monthPurchases || 0),
      purchasesMonth: money(monthPurchases),
      monthCogsCents,
      monthCogs: money(monthCogsCents),
      monthWasteCents: Number(monthWaste || 0),
      monthWaste: money(monthWaste),
      grossProfitCents,
      grossProfit: money(grossProfitCents),
      operatingExpenseCents,
      operatingExpenses: money(operatingExpenseCents),
      netCents: monthIncomeCents - monthCogsCents - operatingExpenseCents - Number(monthWaste || 0),
      net: money(monthIncomeCents - monthCogsCents - operatingExpenseCents - Number(monthWaste || 0))
    },
    cashContext: getCashCloseContext(),
    cashClosings: listCashClosings(),
    purchases: listSupplierPurchases(),
    wasteLogs: listWasteLogs(),
    productCosting: getProductCosting(),
    inventoryItems: listInventoryItems(true),
    products: getAdminCatalog().products.map((product) => ({
      id: product.id,
      name: product.name,
      categoryName: product.categoryName
    })),
    byCategory,
    entries: listAccountingEntries()
  };
}

export function saveAccountingEntry(input, userId = null) {
  const type = input.type === 'expense' ? 'expense' : 'income';
  const category = clean(input.category || (type === 'expense' ? 'Gasto general' : 'Ingreso general'), 120);
  const amountCents = cents(input.amount);
  if (!category) throw new ValidationError('La categoria es obligatoria.');
  if (amountCents <= 0) throw new ValidationError('El monto debe ser mayor a cero.');
  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO accounting_entries (
      type, category, description, amount_cents, payment_method, entry_date,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    type,
    category,
    clean(input.description, 500),
    amountCents,
    clean(input.paymentMethod, 80),
    clean(input.entryDate || createdAt.slice(0, 10), 20),
    userId || null,
    createdAt,
    createdAt
  );
  return listAccountingEntries().find((entry) => entry.id === Number(result.lastInsertRowid));
}

export function deleteAccountingEntry(id) {
  db.prepare('DELETE FROM accounting_entries WHERE id = ?').run(Number(id));
}

export function listRoles() {
  return db.prepare('SELECT * FROM roles ORDER BY id').all().map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: parseJson(role.permissions_json, [])
  }));
}

export function updateRole(id, input) {
  const roleId = Number(id);
  const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!existing) throw new ValidationError('Rol no encontrado.', 404);
  const permissions = Array.isArray(input.permissions)
    ? input.permissions.map((permission) => clean(permission, 80)).filter(Boolean)
    : parseJson(existing.permissions_json, []);
  db.prepare('UPDATE roles SET description = ?, permissions_json = ? WHERE id = ?')
    .run(clean(input.description ?? existing.description, 300), JSON.stringify([...new Set(permissions)]), roleId);
  return listRoles().find((role) => role.id === roleId);
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

export function updateUser(id, input) {
  const userId = Number(id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!existing) throw new ValidationError('Usuario no encontrado.', 404);

  const name = clean(input.name ?? existing.name, 120);
  const email = clean(input.email ?? existing.email, 160).toLowerCase();
  const roleId = Number(input.roleId ?? existing.role_id);
  const active = boolInt(input.active ?? Boolean(existing.active));
  const password = String(input.password || '');

  if (!name || !email) throw new ValidationError('Nombre y email son obligatorios.');
  if (!db.prepare('SELECT id FROM roles WHERE id = ?').get(roleId)) throw new ValidationError('Rol no valido.');
  if (password && password.length < 8) throw new ValidationError('La contrasena debe tener al menos 8 caracteres.');

  if (password) {
    db.prepare(`
      UPDATE users SET role_id = ?, name = ?, email = ?, password_hash = ?, active = ?, updated_at = ?
      WHERE id = ?
    `).run(roleId, name, email, hashPassword(password), active, nowIso(), userId);
  } else {
    db.prepare(`
      UPDATE users SET role_id = ?, name = ?, email = ?, active = ?, updated_at = ?
      WHERE id = ?
    `).run(roleId, name, email, active, nowIso(), userId);
  }

  return listUsers().find((user) => user.id === userId);
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

export function notificationLog({ orderId = null, channel, recipient = '', template = '', status, message = '', response = {} }) {
  db.prepare(`
    INSERT INTO notification_logs (order_id, channel, recipient, template, status, message, response_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId || null,
    clean(channel, 40),
    clean(recipient, 120),
    clean(template, 120),
    clean(status, 40),
    clean(message, 1200),
    JSON.stringify(response || {}),
    nowIso()
  );
}

export function listNotificationLogs(limit = 80) {
  return db.prepare(`
    SELECT n.*, o.order_number
    FROM notification_logs n
    LEFT JOIN orders o ON o.id = n.order_id
    ORDER BY n.created_at DESC
    LIMIT ?
  `).all(Number(limit)).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    channel: row.channel,
    recipient: row.recipient,
    template: row.template,
    status: row.status,
    message: row.message,
    response: parseJson(row.response_json, {}),
    createdAt: row.created_at
  }));
}

export function listBranches() {
  return db.prepare('SELECT * FROM branches ORDER BY active DESC, name').all().map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    address: row.address,
    phone: row.phone,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
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

function percent(value, total, decimals = 1) {
  const denominator = Number(total || 0);
  if (!denominator) return 0;
  return Number(((Number(value || 0) / denominator) * 100).toFixed(decimals));
}

function percentChange(current, previous, decimals = 1) {
  const base = Number(previous || 0);
  if (!base) return Number(current || 0) > 0 ? 100 : 0;
  return Number((((Number(current || 0) - base) / base) * 100).toFixed(decimals));
}

function reportMoneyRow(row, nameKey = 'name') {
  return {
    name: row[nameKey],
    orders: Number(row.orders || 0),
    salesCents: Number(row.sales_cents || 0),
    sales: money(row.sales_cents)
  };
}

function metricSummary(row) {
  return {
    orders: Number(row?.orders || 0),
    salesCents: Number(row?.sales || row?.sales_cents || 0),
    sales: money(row?.sales || row?.sales_cents || 0)
  };
}

function averageMinutes(value) {
  const minutes = Number(value || 0);
  return Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
}

function getOperationalMetrics() {
  const accepted = `
    SELECT order_id, MIN(created_at) AS created_at
    FROM order_status_history
    WHERE status = 'Aceptado'
    GROUP BY order_id
  `;
  const ready = `
    SELECT order_id, MIN(created_at) AS created_at
    FROM order_status_history
    WHERE status = 'Listo'
    GROUP BY order_id
  `;
  const delivered = `
    SELECT order_id, MIN(created_at) AS created_at
    FROM order_status_history
    WHERE status = 'Entregado'
    GROUP BY order_id
  `;
  const row = db.prepare(`
    SELECT
      AVG((julianday(a.created_at) - julianday(o.created_at)) * 1440) AS accept_minutes,
      AVG((julianday(r.created_at) - julianday(a.created_at)) * 1440) AS prep_minutes,
      AVG((julianday(r.created_at) - julianday(o.created_at)) * 1440) AS ready_minutes,
      AVG((julianday(d.created_at) - julianday(o.created_at)) * 1440) AS delivered_minutes
    FROM orders o
    LEFT JOIN (${accepted}) a ON a.order_id = o.id
    LEFT JOIN (${ready}) r ON r.order_id = o.id
    LEFT JOIN (${delivered}) d ON d.order_id = o.id
    WHERE o.status != 'Cancelado'
  `).get();
  const byDelivery = db.prepare(`
    SELECT dm.name,
      COUNT(o.id) AS orders,
      AVG((julianday(r.created_at) - julianday(o.created_at)) * 1440) AS ready_minutes,
      AVG((julianday(d.created_at) - julianday(o.created_at)) * 1440) AS delivered_minutes
    FROM orders o
    JOIN delivery_methods dm ON dm.id = o.delivery_method_id
    LEFT JOIN (${ready}) r ON r.order_id = o.id
    LEFT JOIN (${delivered}) d ON d.order_id = o.id
    WHERE o.status != 'Cancelado'
    GROUP BY dm.name
    ORDER BY orders DESC
  `).all().map((item) => ({
    name: item.name,
    orders: Number(item.orders || 0),
    readyMinutes: averageMinutes(item.ready_minutes),
    deliveredMinutes: averageMinutes(item.delivered_minutes)
  }));
  return {
    averageAcceptMinutes: averageMinutes(row.accept_minutes),
    averagePrepMinutes: averageMinutes(row.prep_minutes),
    averageReadyMinutes: averageMinutes(row.ready_minutes),
    averageDeliveredMinutes: averageMinutes(row.delivered_minutes),
    byDelivery
  };
}

function getModifierMetrics() {
  const rows = db.prepare(`
    SELECT oi.quantity, oi.extras_json, oi.variants_json
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status != 'Cancelado'
  `).all();
  const optionMap = new Map();
  const variantMap = new Map();
  for (const row of rows) {
    const quantity = Number(row.quantity || 1);
    const extras = parseJson(row.extras_json, []);
    for (const extra of Array.isArray(extras) ? extras : []) {
      const name = clean(extra.name, 120);
      if (!name) continue;
      const groupName = clean(extra.groupName || 'Extras', 120);
      const key = `${groupName}::${name}`;
      const current = optionMap.get(key) || {
        name,
        groupName,
        quantity: 0,
        salesCents: 0
      };
      current.quantity += quantity;
      current.salesCents += Number(extra.priceCents || 0) * quantity;
      optionMap.set(key, current);
    }
    const variants = parseJson(row.variants_json, {});
    for (const [groupName, selected] of Object.entries(variants || {})) {
      if (selected === null || selected === undefined || selected === '') continue;
      const values = Array.isArray(selected) ? selected : [selected];
      for (const value of values) {
        const name = clean(value, 120);
        if (!name) continue;
        const key = `${clean(groupName, 120)}::${name}`;
        const current = variantMap.get(key) || {
          name,
          groupName: clean(groupName, 120),
          quantity: 0
        };
        current.quantity += quantity;
        variantMap.set(key, current);
      }
    }
  }
  const options = [...optionMap.values()]
    .map((item) => ({ ...item, sales: money(item.salesCents) }))
    .sort((a, b) => b.quantity - a.quantity || b.salesCents - a.salesCents);
  const variants = [...variantMap.values()].sort((a, b) => b.quantity - a.quantity);
  const toppingPattern = /(topping|boba|extra|jelly|popping|perla|tapioca|crema|leche|milk)/i;
  return {
    topOptions: options.slice(0, 12),
    topToppings: options.filter((item) => toppingPattern.test(`${item.groupName} ${item.name}`)).slice(0, 10),
    topVariants: variants.slice(0, 12)
  };
}

function getCustomerMetrics() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_customers,
      SUM(CASE WHEN orders_count > 1 THEN 1 ELSE 0 END) AS repeat_customers,
      AVG(orders_count) AS average_orders
    FROM (
      SELECT customer_id, COUNT(*) AS orders_count
      FROM orders
      WHERE status != 'Cancelado'
      GROUP BY customer_id
    )
  `).get();
  const topCustomers = db.prepare(`
    SELECT c.name, c.phone, COUNT(o.id) AS orders, COALESCE(SUM(o.total_cents), 0) AS sales_cents,
      MAX(o.created_at) AS last_order_at
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.status != 'Cancelado'
    GROUP BY c.id
    ORDER BY sales_cents DESC, orders DESC
    LIMIT 10
  `).all().map((row) => ({
    name: row.name,
    phone: row.phone,
    orders: Number(row.orders || 0),
    salesCents: Number(row.sales_cents || 0),
    sales: money(row.sales_cents),
    lastOrderAt: row.last_order_at
  }));
  return {
    totalCustomers: Number(totals.total_customers || 0),
    repeatCustomers: Number(totals.repeat_customers || 0),
    repeatRatePct: percent(totals.repeat_customers, totals.total_customers),
    averageOrdersPerCustomer: Number(Number(totals.average_orders || 0).toFixed(2)),
    topCustomers
  };
}

function getInventoryAlertsForReports() {
  const products = db.prepare(`
    SELECT p.id, p.name, c.name AS category_name, p.stock_quantity, p.low_stock_threshold
    FROM products p
    JOIN categories c ON c.id = p.category_id
    WHERE p.stock_enabled = 1 AND p.stock_quantity <= p.low_stock_threshold
    ORDER BY p.stock_quantity ASC, p.name
    LIMIT 12
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    categoryName: row.category_name,
    stockQuantity: Number(row.stock_quantity || 0),
    lowStockThreshold: Number(row.low_stock_threshold || 0)
  }));
  const ingredients = db.prepare(`
    SELECT id, name, unit, stock_quantity, low_stock_threshold
    FROM inventory_items
    WHERE active = 1 AND low_stock_threshold > 0 AND stock_quantity <= low_stock_threshold
    ORDER BY stock_quantity ASC, name
    LIMIT 12
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    unit: row.unit,
    stockQuantity: Number(row.stock_quantity || 0),
    lowStockThreshold: Number(row.low_stock_threshold || 0)
  }));
  return {
    products,
    ingredients,
    totalAlerts: products.length + ingredients.length
  };
}

function getProfitabilityMetrics() {
  const costing = getProductCosting().filter((item) => Number(item.soldThisMonth || 0) > 0);
  const toProfitRow = (item) => ({
    productId: item.productId,
    productName: item.productName,
    categoryName: item.categoryName,
    soldThisMonth: item.soldThisMonth,
    priceCents: item.priceCents,
    recipeCostCents: item.recipeCostCents,
    grossProfitCents: item.grossProfitCents,
    marginPct: item.marginPct
  });
  return {
    leaders: [...costing].sort((a, b) => b.grossProfitCents - a.grossProfitCents).slice(0, 8).map(toProfitRow),
    lowMargin: [...costing].sort((a, b) => a.marginPct - b.marginPct).slice(0, 8).map(toProfitRow)
  };
}

export function getReports() {
  const notCancelled = "status != 'Cancelado'";
  const scalar = (sql, ...params) => db.prepare(sql).get(...params);
  const todayDate = localBusinessDate();
  const currentMonth = todayDate.slice(0, 7);
  const previousMonth = scalar("SELECT strftime('%Y-%m', date(?, 'start of month', '-1 month')) AS month", todayDate).month;
  const today = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales
    FROM orders
    WHERE ${notCancelled} AND ${businessDateSql()} = ?
  `, todayDate);
  const week = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales
    FROM orders
    WHERE ${notCancelled} AND ${businessDateSql()} BETWEEN date(?, '-6 day') AND ?
  `, todayDate, todayDate);
  const previousWeek = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales
    FROM orders
    WHERE ${notCancelled}
      AND ${businessDateSql()} >= date(?, '-13 day')
      AND ${businessDateSql()} < date(?, '-6 day')
  `, todayDate, todayDate);
  const month = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales
    FROM orders
    WHERE ${notCancelled} AND ${businessMonthSql()} = ?
  `, currentMonth);
  const previousMonthSummary = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales
    FROM orders
    WHERE ${notCancelled} AND ${businessMonthSql()} = ?
  `, previousMonth);
  const all = scalar(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales,
      COALESCE(AVG(total_cents), 0) AS average_ticket
    FROM orders
    WHERE ${notCancelled}
  `);
  const cancelled = scalar("SELECT COUNT(*) AS total FROM orders WHERE status = 'Cancelado'");
  const monthStatusTotals = scalar(`
    SELECT COUNT(*) AS total_orders,
      SUM(CASE WHEN status = 'Cancelado' THEN 1 ELSE 0 END) AS cancelled_orders
    FROM orders
    WHERE ${businessMonthSql()} = ?
  `, currentMonth);

  const topProducts = db.prepare(`
    SELECT oi.product_id, oi.product_name AS name, COALESCE(c.name, 'Sin categoria') AS category_name,
      SUM(oi.quantity) AS quantity, SUM(oi.line_total_cents) AS sales_cents
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE o.status != 'Cancelado'
    GROUP BY oi.product_id, oi.product_name, c.name
    ORDER BY quantity DESC, sales_cents DESC
    LIMIT 10
  `).all().map((row) => ({
    productId: row.product_id,
    name: row.name,
    categoryName: row.category_name,
    quantity: Number(row.quantity || 0),
    salesCents: Number(row.sales_cents || 0),
    sales: money(row.sales_cents)
  }));

  const byPayment = db.prepare(`
    SELECT pm.name, COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS sales_cents,
      COALESCE(AVG(o.total_cents), 0) AS average_ticket_cents
    FROM orders o
    JOIN payment_methods pm ON pm.id = o.payment_method_id
    WHERE o.status != 'Cancelado'
    GROUP BY pm.name
    ORDER BY sales_cents DESC
  `).all().map((row) => ({
    ...reportMoneyRow(row),
    averageTicketCents: Math.round(Number(row.average_ticket_cents || 0)),
    averageTicket: money(row.average_ticket_cents)
  }));

  const byDelivery = db.prepare(`
    SELECT dm.name, COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS sales_cents,
      COALESCE(AVG(o.total_cents), 0) AS average_ticket_cents
    FROM orders o
    JOIN delivery_methods dm ON dm.id = o.delivery_method_id
    WHERE o.status != 'Cancelado'
    GROUP BY dm.name
    ORDER BY orders DESC
  `).all().map((row) => ({
    ...reportMoneyRow(row),
    averageTicketCents: Math.round(Number(row.average_ticket_cents || 0)),
    averageTicket: money(row.average_ticket_cents)
  }));

  const byDay = db.prepare(`
    SELECT ${businessDateSql()} AS day, COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales_cents
    FROM orders
    WHERE status != 'Cancelado'
    GROUP BY ${businessDateSql()}
    ORDER BY day DESC
    LIMIT 14
  `).all().reverse().map((row) => ({
    day: row.day,
    orders: Number(row.orders || 0),
    salesCents: Number(row.sales_cents || 0),
    sales: money(row.sales_cents)
  }));

  const byHour = db.prepare(`
    SELECT ${businessHourSql()} || ':00' AS name,
      COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales_cents
    FROM orders
    WHERE status != 'Cancelado' AND ${businessDateSql()} = ?
    GROUP BY ${businessHourSql()}
    ORDER BY name
  `).all(todayDate).map(reportMoneyRow);

  const byCategory = db.prepare(`
    SELECT c.name, SUM(oi.quantity) AS orders, COALESCE(SUM(oi.line_total_cents), 0) AS sales_cents
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    JOIN categories c ON c.id = p.category_id
    WHERE o.status != 'Cancelado'
    GROUP BY c.name
    ORDER BY sales_cents DESC
    LIMIT 8
  `).all().map(reportMoneyRow);

  const byCashier = db.prepare(`
    SELECT COALESCE(u.name, 'Sin usuario') AS name, COUNT(DISTINCT o.id) AS orders,
      COALESCE(SUM(o.total_cents), 0) AS sales_cents
    FROM orders o
    LEFT JOIN order_status_history h ON h.order_id = o.id AND h.status = 'Aceptado'
    LEFT JOIN users u ON u.id = h.changed_by_user_id
    WHERE o.status != 'Cancelado'
    GROUP BY COALESCE(u.name, 'Sin usuario')
    ORDER BY sales_cents DESC
    LIMIT 8
  `).all().map(reportMoneyRow);

  const statusFunnel = db.prepare(`
    SELECT status AS name, COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales_cents
    FROM orders
    WHERE ${businessMonthSql()} = ?
    GROUP BY status
    ORDER BY CASE status
      WHEN 'Nuevo' THEN 1
      WHEN 'Aceptado' THEN 2
      WHEN 'En preparacion' THEN 3
      WHEN 'Listo' THEN 4
      WHEN 'En camino' THEN 5
      WHEN 'Entregado' THEN 6
      WHEN 'Cancelado' THEN 7
      ELSE 8
    END
  `).all(currentMonth).map(reportMoneyRow);

  const hourExpr = `CAST(${businessHourSql()} AS INTEGER)`;
  const byDayPart = db.prepare(`
    SELECT CASE
      WHEN ${hourExpr} BETWEEN 5 AND 10 THEN 'Manana'
      WHEN ${hourExpr} BETWEEN 11 AND 13 THEN 'Almuerzo'
      WHEN ${hourExpr} BETWEEN 14 AND 17 THEN 'Tarde'
      WHEN ${hourExpr} BETWEEN 18 AND 22 THEN 'Noche'
      ELSE 'Madrugada'
    END AS name,
    COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales_cents
    FROM orders
    WHERE status != 'Cancelado'
      AND ${businessDateSql()} >= date(?, '-29 day')
    GROUP BY name
    ORDER BY sales_cents DESC
  `).all(todayDate).map(reportMoneyRow);

  const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
  const hourlyHeatmap = db.prepare(`
    SELECT strftime('%w', created_at, ${BUSINESS_SQL_TIME}) AS day_index,
      CAST(${businessHourSql()} AS INTEGER) AS hour,
      COUNT(*) AS orders,
      COALESCE(SUM(total_cents), 0) AS sales_cents
    FROM orders
    WHERE status != 'Cancelado'
      AND ${businessDateSql()} >= date(?, '-29 day')
    GROUP BY day_index, hour
    ORDER BY day_index, hour
  `).all(todayDate).map((row) => ({
    dayIndex: Number(row.day_index || 0),
    dayName: dayNames[Number(row.day_index || 0)] || 'Dia',
    hour: Number(row.hour || 0),
    name: `${dayNames[Number(row.day_index || 0)] || 'Dia'} ${String(row.hour || 0).padStart(2, '0')}:00`,
    orders: Number(row.orders || 0),
    salesCents: Number(row.sales_cents || 0),
    sales: money(row.sales_cents)
  }));

  const promotions = db.prepare(`
    SELECT coupon_code AS name, COUNT(*) AS orders,
      COALESCE(SUM(total_cents), 0) AS sales_cents,
      COALESCE(SUM(discount_cents), 0) AS discount_cents
    FROM orders
    WHERE status != 'Cancelado' AND IFNULL(coupon_code, '') != ''
    GROUP BY coupon_code
    ORDER BY discount_cents DESC, orders DESC
    LIMIT 10
  `).all().map((row) => ({
    name: row.name,
    orders: Number(row.orders || 0),
    salesCents: Number(row.sales_cents || 0),
    sales: money(row.sales_cents),
    discountCents: Number(row.discount_cents || 0),
    discount: money(row.discount_cents)
  }));

  const operations = getOperationalMetrics();
  const customers = getCustomerMetrics();
  const modifiers = getModifierMetrics();
  const inventoryAlerts = getInventoryAlertsForReports();
  const profitability = getProfitabilityMetrics();
  const monthCancellationRatePct = percent(monthStatusTotals.cancelled_orders, monthStatusTotals.total_orders);

  return {
    today: metricSummary(today),
    week: metricSummary(week),
    month: metricSummary(month),
    all: {
      orders: Number(all.orders || 0),
      salesCents: Number(all.sales || 0),
      sales: money(all.sales),
      averageTicketCents: Math.round(all.average_ticket),
      averageTicket: money(all.average_ticket)
    },
    cancelledOrders: Number(cancelled.total || 0),
    topProducts,
    byPayment,
    byDelivery,
    byDay,
    byHour,
    byCategory,
    byCashier,
    advanced: {
      generatedAt: nowIso(),
      businessDate: todayDate,
      currentMonth,
      previousMonth,
      growth: {
        weekSalesDeltaPct: percentChange(week.sales, previousWeek.sales),
        weekOrdersDeltaPct: percentChange(week.orders, previousWeek.orders),
        monthSalesDeltaPct: percentChange(month.sales, previousMonthSummary.sales),
        monthOrdersDeltaPct: percentChange(month.orders, previousMonthSummary.orders),
        previousWeek: metricSummary(previousWeek),
        previousMonth: metricSummary(previousMonthSummary)
      },
      operations,
      customers,
      modifiers,
      profitability,
      inventoryAlerts,
      statusFunnel,
      byDayPart,
      hourlyHeatmap,
      promotions,
      health: {
        monthCancellationRatePct,
        repeatCustomerRatePct: customers.repeatRatePct,
        lowStockAlerts: inventoryAlerts.totalAlerts,
        averageAcceptMinutes: operations.averageAcceptMinutes,
        averagePrepMinutes: operations.averagePrepMinutes
      }
    }
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
