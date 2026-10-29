'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./password');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS product_types (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  surcharge INTEGER NOT NULL DEFAULT 0,
  factory_surcharge INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  unit_price_per_sqm INTEGER,
  memo TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','vendor','factory')),
  name TEXT NOT NULL,
  vendor_id INTEGER REFERENCES vendors(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'vendor',
  external_ref TEXT,
  vendor_id INTEGER REFERENCES vendors(id),
  product_type TEXT NOT NULL REFERENCES product_types(code),
  width_mm INTEGER NOT NULL,
  height_mm INTEGER NOT NULL,
  frame_color TEXT NOT NULL,
  fabric_color TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  area_sqm REAL NOT NULL,
  billed_area_sqm REAL NOT NULL,
  unit_price INTEGER NOT NULL,
  product_amount INTEGER NOT NULL,
  surcharge INTEGER NOT NULL,
  shipping_fee INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  factory_cost INTEGER NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  zip_code TEXT,
  address TEXT NOT NULL,
  address_detail TEXT,
  install_note TEXT,
  admin_memo TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  tracking_carrier TEXT,
  tracking_no TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  approved_at TEXT,
  production_started_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_vendor ON orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id),
  actor_role TEXT,
  actor_name TEXT,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_history_order ON order_history(order_id);

-- 네이버 스마트스토어 연동
CREATE TABLE IF NOT EXISTS smartstore_orders (
  product_order_id TEXT PRIMARY KEY,
  naver_order_id TEXT,
  order_id INTEGER REFERENCES orders(id),
  import_status TEXT NOT NULL DEFAULT 'needs_review',   -- imported | needs_review | ignored
  naver_status TEXT,
  claim_status TEXT,
  place_order_status TEXT,
  confirmed_at TEXT,
  dispatch_synced INTEGER NOT NULL DEFAULT 0,
  dispatch_error TEXT,
  cancel_requested_at TEXT,
  product_name TEXT,
  product_option TEXT,
  shipping_memo TEXT,
  parsed_spec TEXT,
  parse_missing TEXT,
  orderer_name TEXT,
  payment_amount INTEGER,
  delivery_fee INTEGER,
  quantity INTEGER,
  paid_at TEXT,
  raw TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS smartstore_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  message TEXT,
  details TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 장부: 이전 「블랙아웃」 앱에서 옮겨 온 주문 장부 (그 앱 필드 그대로, 치수는 cm)
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  channel TEXT,
  paid INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  phone TEXT,
  address TEXT,
  width_cm REAL,
  height_cm REAL,
  frame TEXT,
  fabric TEXT,
  open_type TEXT,
  kind TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  ship INTEGER NOT NULL DEFAULT 0,
  fee INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  source TEXT NOT NULL DEFAULT 'blackout-app',
  raw TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger_entries(date);

-- 휴대폰 알림 구독 (기기마다 1행)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  last_ok_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 송장 자동 찾기 (송장 없이 출고된 대신택배 주문)
CREATE TABLE IF NOT EXISTS tracking_lookups (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | multiple | not_found | found | manual
  candidates TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_tried_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

const DEFAULT_SETTINGS = [
  ['company_name', 'BLACKOUT', '회사명'],
  ['default_unit_price_per_sqm', '90000', '기본 업체 납품단가 (원/㎡)'],
  ['min_billable_area_sqm', '2', '최소 주문면적 (㎡)'],
  ['shipping_fee', '8800', '택배비 (원, 업체 부담)'],
  ['factory_cost_per_sqm', '60000', '공장 제작원가 (원/㎡) - 마진 계산용'],
  ['min_size_mm', '300', '최소 제작 치수 (mm)'],
  ['max_size_mm', '3000', '최대 제작 치수 (mm)'],
  ['default_carrier', '대신택배', '기본 택배사 (공장 출고 시 처음 선택)'],
  ['factory_small_area_sqm', '1', '이 면적(㎡) 미만은 공장가 고정'],
  ['factory_small_price', '110000', '작은 블라인드 공장가 (원/장, 부가세 포함)'],
  ['factory_area_step_sqm', '0.1', '공장 면적 반올림 단위 (㎡)'],
  ['smartstore_delivery_cost', '9680', '스마트스토어 주문 택배비 (원, 우리 부담 → 마진에서 뺌)'],
  ['smartstore_qty_unit_sqm', '0.1', '스마트스토어 수량 1개 = 몇 ㎡ (면적 단위 판매. 0이면 수량 = 장수)'],
];

const DEFAULT_PRODUCT_TYPES = [
  ['single', '편개형', 0, 0, 1],
  ['double', '양개형', 50000, 44000, 2],
  ['free', '프리형', 50000, 44000, 3],
];

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // 나중에 생긴 칸: 이미 있는 DB 에 없으면 붙인다
  const addColumn = (table, col, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  addColumn('smartstore_orders', 'merged_into', 'TEXT'); // 추가상품이 합산된 블라인드 상품주문번호
  addColumn('orders', 'delivery_cost', 'INTEGER NOT NULL DEFAULT 0'); // 우리가 내는 택배비 (스마트스토어 주문)
  seed(db);
  return db;
}

function seed(db) {
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value, label) VALUES (?, ?, ?)');
  for (const row of DEFAULT_SETTINGS) insSetting.run(...row);

  const insType = db.prepare(
    'INSERT OR IGNORE INTO product_types (code, name, surcharge, factory_surcharge, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of DEFAULT_PRODUCT_TYPES) insType.run(...row);

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    const adminPw = process.env.ADMIN_PASSWORD || 'admin1234';
    db.prepare('INSERT INTO users (username, password_hash, role, name) VALUES (?, ?, ?, ?)').run(
      'admin', hashPassword(adminPw), 'admin', 'BLACKOUT 관리자'
    );
    db.prepare('INSERT INTO users (username, password_hash, role, name) VALUES (?, ?, ?, ?)').run(
      'factory', hashPassword(process.env.FACTORY_PASSWORD || 'factory1234'), 'factory', '제조공장'
    );
    if (process.env.SEED_DEMO !== '0') {
      const v = db
        .prepare('INSERT INTO vendors (name, contact_name, phone, unit_price_per_sqm, memo) VALUES (?, ?, ?, ?, ?)')
        .run('데모 시공업체', '홍길동', '010-0000-0000', null, '데모 계정 (삭제 가능)');
      db.prepare('INSERT INTO users (username, password_hash, role, name, vendor_id) VALUES (?, ?, ?, ?, ?)').run(
        'vendor', hashPassword('vendor1234'), 'vendor', '데모 시공업체', v.lastInsertRowid
      );
    }
  }
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value, label FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function getSettingRows(db) {
  return db.prepare('SELECT key, value, label, updated_at FROM settings ORDER BY rowid').all();
}

function getProductTypes(db, { includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM product_types ORDER BY sort_order, code'
    : 'SELECT * FROM product_types WHERE active = 1 ORDER BY sort_order, code';
  return db.prepare(sql).all();
}

module.exports = { openDatabase, getSettings, getSettingRows, getProductTypes };
