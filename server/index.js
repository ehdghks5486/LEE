'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { openDatabase, getSettings, getSettingRows, getProductTypes } = require('./db');
const { hashPassword, verifyPassword } = require('./password');
const auth = require('./auth');
const orders = require('./orders');
const { FRAME_COLORS, FABRIC_COLORS } = require('./pricing');

const { HttpError, STATUSES } = orders;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CARRIERS = ['CJ대한통운', '롯데택배', '한진택배', '로젠택배', '우체국택배', '경동택배', '대신택배', '직접배송', '기타'];

// ---------- helpers ----------
function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '요청 본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON 형식이 올바르지 않습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function requireRole(user, ...roles) {
  if (!user) throw new HttpError(401, '로그인이 필요합니다.');
  if (roles.length && !roles.includes(user.role)) throw new HttpError(403, '접근 권한이 없습니다.');
}

// 간단한 로그인 실패 제한 (아이디 기준 10분간 10회)
const loginFailures = new Map();
function checkLoginThrottle(username) {
  const rec = loginFailures.get(username);
  if (rec && rec.count >= 10 && Date.now() - rec.first < 10 * 60 * 1000) {
    throw new HttpError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  }
}
function recordLoginFailure(username) {
  const rec = loginFailures.get(username);
  if (!rec || Date.now() - rec.first > 10 * 60 * 1000) loginFailures.set(username, { count: 1, first: Date.now() });
  else rec.count += 1;
}

// ---------- router ----------
function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return '([^\\/]+)';
      }) + '$'
    );
    routes.push({ method, re, keys, handler });
  };
  const match = (method, pathname) => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return null;
  };
  return { add, match };
}

function createApp({ dbPath, secureCookies = false } = {}) {
  const db = openDatabase(dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'blackout.db'));
  auth.purgeExpired(db);
  const router = createRouter();

  // ----- auth -----
  router.add('POST', '/api/auth/login', async (ctx) => {
    const { username, password } = ctx.body;
    const uname = String(username || '').trim().toLowerCase();
    if (!uname || !password) throw new HttpError(400, '아이디와 비밀번호를 입력해 주세요.');
    checkLoginThrottle(uname);
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      recordLoginFailure(uname);
      throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    loginFailures.delete(uname);
    const { token, expires } = auth.createSession(db, user.id);
    json(ctx.res, 200, { user: publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(token, expires, { secure: secureCookies }) });
  });

  router.add('POST', '/api/auth/logout', async (ctx) => {
    if (ctx.user) auth.destroySession(db, ctx.user.token);
    json(ctx.res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  });

  router.add('GET', '/api/auth/me', async (ctx) => {
    requireRole(ctx.user);
    json(ctx.res, 200, { user: publicUser(ctx.user) });
  });

  router.add('POST', '/api/auth/password', async (ctx) => {
    requireRole(ctx.user);
    const { current_password, new_password } = ctx.body;
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id);
    if (!verifyPassword(current_password || '', row.password_hash)) throw new HttpError(400, '현재 비밀번호가 올바르지 않습니다.');
    validatePassword(new_password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), ctx.user.id);
    json(ctx.res, 200, { ok: true });
  });

  // ----- meta -----
  router.add('GET', '/api/meta', async (ctx) => {
    requireRole(ctx.user);
    const settings = getSettings(db);
    const types = getProductTypes(db).map((t) => {
      const base = { code: t.code, name: t.name };
      if (ctx.user.role === 'admin') return { ...base, surcharge: t.surcharge, factory_surcharge: t.factory_surcharge };
      if (ctx.user.role === 'vendor') return { ...base, surcharge: t.surcharge };
      return base;
    });
    const meta = {
      company_name: settings.company_name,
      product_types: types,
      frame_colors: FRAME_COLORS,
      fabric_colors: FABRIC_COLORS,
      statuses: Object.entries(STATUSES).map(([code, name]) => ({ code, name })),
      carriers: CARRIERS,
      limits: { min_size_mm: Number(settings.min_size_mm), max_size_mm: Number(settings.max_size_mm) },
    };
    if (ctx.user.role !== 'factory') {
      meta.pricing = {
        min_billable_area_sqm: Number(settings.min_billable_area_sqm),
        shipping_fee: Number(settings.shipping_fee),
        default_unit_price_per_sqm: Number(settings.default_unit_price_per_sqm),
      };
    }
    if (ctx.user.role === 'vendor') {
      const v = db.prepare('SELECT id, name, unit_price_per_sqm, contact_name, phone FROM vendors WHERE id = ?').get(ctx.user.vendor_id);
      meta.vendor = v
        ? { ...v, unit_price_per_sqm: v.unit_price_per_sqm ?? Number(settings.default_unit_price_per_sqm) }
        : null;
    }
    if (ctx.user.role === 'admin') {
      meta.vendors = db.prepare('SELECT id, name, unit_price_per_sqm, active FROM vendors ORDER BY active DESC, name').all();
    }
    json(ctx.res, 200, meta);
  });

  // ----- quote -----
  router.add('POST', '/api/quote', async (ctx) => {
    requireRole(ctx.user, 'vendor', 'admin');
    const vendor = orders.resolveVendorForOrder(db, ctx.user, ctx.body);
    const result = orders.quoteFor(db, ctx.body, vendor);
    if (result.ok && ctx.user.role !== 'admin') delete result.quote.factory_cost;
    json(ctx.res, 200, result);
  });

  // ----- orders -----
  router.add('GET', '/api/orders', async (ctx) => {
    requireRole(ctx.user);
    json(ctx.res, 200, { orders: orders.listOrders(db, ctx.user, ctx.query) });
  });
  router.add('POST', '/api/orders', async (ctx) => {
    requireRole(ctx.user, 'vendor', 'admin');
    json(ctx.res, 201, { order: orders.createOrder(db, ctx.user, ctx.body) });
  });
  router.add('GET', '/api/orders/:id', async (ctx) => {
    requireRole(ctx.user);
    json(ctx.res, 200, orders.getOrder(db, ctx.user, Number(ctx.params.id)));
  });
  router.add('PATCH', '/api/orders/:id', async (ctx) => {
    requireRole(ctx.user, 'vendor', 'admin');
    json(ctx.res, 200, { order: orders.updateOrder(db, ctx.user, Number(ctx.params.id), ctx.body) });
  });
  router.add('POST', '/api/orders/:id/status', async (ctx) => {
    requireRole(ctx.user);
    json(ctx.res, 200, { order: orders.changeStatus(db, ctx.user, Number(ctx.params.id), ctx.body) });
  });
  router.add('POST', '/api/orders/:id/tracking', async (ctx) => {
    requireRole(ctx.user, 'factory', 'admin');
    json(ctx.res, 200, { order: orders.updateTracking(db, ctx.user, Number(ctx.params.id), ctx.body) });
  });

  // ----- admin: vendors -----
  router.add('GET', '/api/vendors', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const rows = db
      .prepare(
        `SELECT v.*, (SELECT COUNT(*) FROM orders o WHERE o.vendor_id = v.id) AS order_count,
                (SELECT COUNT(*) FROM users u WHERE u.vendor_id = v.id AND u.active = 1) AS user_count
         FROM vendors v ORDER BY v.active DESC, v.name`
      )
      .all();
    json(ctx.res, 200, { vendors: rows });
  });
  router.add('POST', '/api/vendors', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const v = vendorInput(ctx.body);
    const info = db
      .prepare('INSERT INTO vendors (name, contact_name, phone, email, unit_price_per_sqm, memo) VALUES (?, ?, ?, ?, ?, ?)')
      .run(v.name, v.contact_name, v.phone, v.email, v.unit_price_per_sqm, v.memo);
    json(ctx.res, 201, { vendor: db.prepare('SELECT * FROM vendors WHERE id = ?').get(info.lastInsertRowid) });
  });
  router.add('PATCH', '/api/vendors/:id', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const id = Number(ctx.params.id);
    const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, '업체를 찾을 수 없습니다.');
    const v = vendorInput({ ...existing, ...ctx.body });
    const active = ctx.body.active === undefined ? existing.active : ctx.body.active ? 1 : 0;
    db.prepare(
      'UPDATE vendors SET name = ?, contact_name = ?, phone = ?, email = ?, unit_price_per_sqm = ?, memo = ?, active = ? WHERE id = ?'
    ).run(v.name, v.contact_name, v.phone, v.email, v.unit_price_per_sqm, v.memo, active, id);
    json(ctx.res, 200, { vendor: db.prepare('SELECT * FROM vendors WHERE id = ?').get(id) });
  });

  // ----- admin: users -----
  router.add('GET', '/api/users', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.name, u.vendor_id, u.active, u.created_at, v.name AS vendor_name
         FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id ORDER BY u.role, u.username`
      )
      .all();
    json(ctx.res, 200, { users: rows });
  });
  router.add('POST', '/api/users', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const b = ctx.body;
    const username = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) throw new HttpError(400, '아이디는 영문 소문자/숫자 3~30자로 입력해 주세요.');
    if (!['admin', 'vendor', 'factory'].includes(b.role)) throw new HttpError(400, '역할을 선택해 주세요.');
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, '이름을 입력해 주세요.');
    validatePassword(b.password);
    let vendorId = null;
    if (b.role === 'vendor') {
      vendorId = Number(b.vendor_id);
      if (!vendorId || !db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendorId)) throw new HttpError(400, '업체 계정은 소속 업체를 선택해야 합니다.');
    }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw new HttpError(409, '이미 사용 중인 아이디입니다.');
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role, name, vendor_id) VALUES (?, ?, ?, ?, ?)')
      .run(username, hashPassword(b.password), b.role, name, vendorId);
    json(ctx.res, 201, { user: db.prepare('SELECT id, username, role, name, vendor_id, active, created_at FROM users WHERE id = ?').get(info.lastInsertRowid) });
  });
  router.add('PATCH', '/api/users/:id', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const id = Number(ctx.params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
    const b = ctx.body;
    const name = b.name !== undefined ? String(b.name).trim() || existing.name : existing.name;
    let active = existing.active;
    if (b.active !== undefined) {
      if (id === ctx.user.id && !b.active) throw new HttpError(400, '본인 계정은 비활성화할 수 없습니다.');
      active = b.active ? 1 : 0;
    }
    let vendorId = existing.vendor_id;
    if (b.vendor_id !== undefined && existing.role === 'vendor') {
      vendorId = Number(b.vendor_id);
      if (!db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendorId)) throw new HttpError(400, '존재하지 않는 업체입니다.');
    }
    db.prepare('UPDATE users SET name = ?, active = ?, vendor_id = ? WHERE id = ?').run(name, active, vendorId, id);
    if (b.password) {
      validatePassword(b.password);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(id, ctx.user.token);
    }
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    json(ctx.res, 200, { user: db.prepare('SELECT id, username, role, name, vendor_id, active, created_at FROM users WHERE id = ?').get(id) });
  });

  // ----- admin: settings & product types -----
  router.add('GET', '/api/settings', async (ctx) => {
    requireRole(ctx.user, 'admin');
    json(ctx.res, 200, { settings: getSettingRows(db), product_types: getProductTypes(db, { includeInactive: true }) });
  });
  router.add('PUT', '/api/settings', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const numericKeys = ['default_unit_price_per_sqm', 'min_billable_area_sqm', 'shipping_fee', 'factory_cost_per_sqm', 'min_size_mm', 'max_size_mm'];
    const known = new Set(['company_name', ...numericKeys]);
    const upd = db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now','localtime') WHERE key = ?");
    db.exec('BEGIN');
    try {
      for (const [k, raw] of Object.entries(ctx.body.settings || {})) {
        if (!known.has(k)) continue;
        let value = String(raw).trim();
        if (numericKeys.includes(k)) {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${k} 값은 0 이상의 숫자여야 합니다.`);
          value = String(n);
        } else if (!value) throw new HttpError(400, `${k} 값을 입력해 주세요.`);
        upd.run(value, k);
      }
      const s = getSettings(db);
      if (Number(s.min_size_mm) >= Number(s.max_size_mm)) throw new HttpError(400, '최소 치수는 최대 치수보다 작아야 합니다.');
      if (Array.isArray(ctx.body.product_types)) {
        const upsert = db.prepare(
          `INSERT INTO product_types (code, name, surcharge, factory_surcharge, sort_order, active) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(code) DO UPDATE SET name = excluded.name, surcharge = excluded.surcharge,
             factory_surcharge = excluded.factory_surcharge, sort_order = excluded.sort_order, active = excluded.active`
        );
        for (const t of ctx.body.product_types) {
          const code = String(t.code || '').trim().toLowerCase();
          if (!/^[a-z0-9_]{1,20}$/.test(code)) throw new HttpError(400, '제품 형태 코드는 영문 소문자/숫자 1~20자여야 합니다.');
          const name = String(t.name || '').trim();
          if (!name) throw new HttpError(400, '제품 형태 이름을 입력해 주세요.');
          const surcharge = Math.round(Number(t.surcharge) || 0);
          const fsur = Math.round(Number(t.factory_surcharge) || 0);
          if (surcharge < 0 || fsur < 0) throw new HttpError(400, '추가금은 0 이상이어야 합니다.');
          upsert.run(code, name, surcharge, fsur, Number(t.sort_order) || 0, t.active === false || t.active === 0 ? 0 : 1);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    json(ctx.res, 200, { settings: getSettingRows(db), product_types: getProductTypes(db, { includeInactive: true }) });
  });

  router.add('GET', '/api/stats', async (ctx) => {
    requireRole(ctx.user, 'admin');
    json(ctx.res, 200, orders.stats(db, { from: ctx.query.from, to: ctx.query.to }));
  });

  router.add('GET', '/api/health', async (ctx) => json(ctx.res, 200, { ok: true, time: new Date().toISOString() }));

  // ----- request handling -----
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (pathname.startsWith('/api/')) {
      try {
        const m = router.match(req.method, pathname);
        if (!m) throw new HttpError(404, 'API 경로를 찾을 수 없습니다.');
        const user = auth.getSessionUser(db, req);
        // CSRF 완화: 상태 변경 요청은 same-origin fetch(JSON)만 허용
        let body = {};
        if (!['GET', 'HEAD'].includes(req.method)) {
          const ct = String(req.headers['content-type'] || '');
          if (!ct.includes('application/json')) throw new HttpError(415, 'application/json 요청만 허용됩니다.');
          body = await readBody(req);
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'JSON 객체가 필요합니다.');
        }
        const query = Object.fromEntries(url.searchParams.entries());
        await m.handler({ req, res, user, body, query, params: m.params });
      } catch (e) {
        if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...(e.extra || {}) });
        console.error(e);
        return json(res, 500, { error: '서버 오류가 발생했습니다.' });
      }
      return;
    }
    serveStatic(req, res, pathname);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: '서버 오류가 발생했습니다.' });
    });
  });
  server.db = db;
  return server;
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback
      if (!path.extname(rel)) return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), '.html');
      res.writeHead(404);
      return res.end('Not found');
    }
    sendFile(res, filePath, path.extname(filePath));
  });
}

function sendFile(res, filePath, ext) {
  const type = MIME[ext] || 'application/octet-stream';
  const cache = ext === '.html' || ext === '.webmanifest' || filePath.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  fs.createReadStream(filePath).pipe(res);
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, name: u.name, vendor_id: u.vendor_id ?? null };
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 72) throw new HttpError(400, '비밀번호는 8자 이상 72자 이하로 입력해 주세요.');
}

function vendorInput(b) {
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, '업체명을 입력해 주세요.');
  let unit = b.unit_price_per_sqm;
  if (unit === '' || unit === undefined || unit === null) unit = null;
  else {
    unit = Number(unit);
    if (!Number.isFinite(unit) || unit < 0) throw new HttpError(400, '업체 단가는 0 이상의 숫자여야 합니다.');
    unit = Math.round(unit);
  }
  const str = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
  return {
    name: name.slice(0, 100),
    contact_name: str(b.contact_name, 50),
    phone: str(b.phone, 30),
    email: str(b.email, 100),
    unit_price_per_sqm: unit,
    memo: str(b.memo, 500),
  };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const server = createApp({ secureCookies: process.env.SECURE_COOKIES === '1' });
  server.listen(port, host, () => {
    console.log(`BLACKOUT 주문관리 서버 실행 중: http://localhost:${port}`);
  });
}
