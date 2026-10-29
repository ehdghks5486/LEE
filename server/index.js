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
const { createSync } = require('./smartstore/sync');
const { MockNaverClient } = require('./smartstore/mock');
const { NaverCommerceClient } = require('./smartstore/client');
const { createTrackingLookup } = require('./tracking-lookup');
const daesin = require('./carriers/daesin');
const { createPush } = require('./push');
const ledger = require('./ledger');

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

function resolveSmartstore(opt = {}) {
  if (opt.client) return { mode: opt.mode || opt.client.mode || 'mock', client: opt.client };
  const mode = opt.mode || process.env.SMARTSTORE_MODE || (process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET ? 'live' : 'off');
  if (mode === 'live') {
    return { mode, client: new NaverCommerceClient({ clientId: process.env.NAVER_CLIENT_ID, clientSecret: process.env.NAVER_CLIENT_SECRET }) };
  }
  if (mode === 'mock') return { mode, client: new MockNaverClient() };
  return { mode: 'off', client: null };
}

/**
 * 한 번만: 이전 블랙아웃 앱 가격 규칙(1㎡ 미만 고정가·0.1㎡ 반올림)으로 공장가를 다시 계산하고,
 * 이미 들어온 스마트스토어 주문에 우리 부담 택배비를 채운다. 취소된 주문은 그대로 둔다.
 */
function repriceOnce(db) {
  const KEY = 'reprice_old_app_rules';
  if (db.prepare('SELECT 1 FROM sync_state WHERE key = ?').get(KEY)) return;
  const delivery = Number(getSettings(db).smartstore_delivery_cost) || 0;
  const rows = db.prepare("SELECT * FROM orders WHERE status <> 'cancelled'").all();
  const upd = db.prepare('UPDATE orders SET factory_cost = ?, delivery_cost = ? WHERE id = ?');
  for (const o of rows) {
    const q = orders.quoteFor(db, o, null);
    upd.run(q.ok ? q.quote.factory_cost : o.factory_cost, o.source === 'smartstore' && !o.delivery_cost ? delivery : o.delivery_cost, o.id);
  }
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(KEY, new Date().toISOString());
}

function createApp({ dbPath, secureCookies = false, smartstore = {}, autoStart = false, trackingSearch = daesin.searchByReceiverPhone, trackingDelayMs, pushSend } = {}) {
  const db = openDatabase(dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'blackout.db'));
  auth.purgeExpired(db);
  repriceOnce(db);
  const router = createRouter();

  // ----- 휴대폰 알림: 누구에게 무엇을 (공장 알림에는 가격·업체명을 넣지 않는다) -----
  const push = createPush({ db, sendImpl: pushSend });
  const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
  const specOf = (o) => `${o.product_type_name || o.product_type} ${o.width_mm}×${o.height_mm}mm${o.quantity > 1 ? ` ×${o.quantity}` : ''}`;
  // 알림을 누르면 열 화면: 업체는 업체 앱(/vendor/)으로
  const orderUrl = (o, role) => `${role === 'vendor' ? '/vendor/' : '/'}#/orders/${o.id}`;
  const notifyEvent = {
    created(o, user) {
      if (user.role !== 'vendor') return;
      push.notify(['admin'], { title: `새 주문 · ${o.vendor_name || '업체'}`, body: `${o.order_no} · ${specOf(o)} · ${won(o.total_amount)}\n입금 확인 후 승인해 주세요.`, url: orderUrl(o), tag: `order-${o.id}` });
    },
    status(o, from, to, user) {
      if (to === 'approved') {
        push.notify(['factory'], { title: '새 제작 주문서', body: `${o.order_no} · ${specOf(o)}`, url: orderUrl(o), tag: `order-${o.id}` });
        if (o.vendor_id) push.notify(['vendor'], { title: '발주 승인', body: `${o.order_no} 제작에 들어갑니다.`, url: orderUrl(o, 'vendor'), tag: `order-${o.id}` }, { vendorId: o.vendor_id });
      }
      if (to === 'shipped' && o.vendor_id) {
        push.notify(['vendor'], { title: '출고되었습니다', body: `${o.order_no} · ${o.tracking_carrier} ${o.tracking_no || '(송장번호 등록 중)'}`, url: orderUrl(o, 'vendor'), tag: `order-${o.id}` }, { vendorId: o.vendor_id });
      }
      if (to === 'cancelled' && user.role === 'vendor') {
        push.notify(['admin'], { title: `업체 주문 취소 · ${o.vendor_name || ''}`, body: o.order_no, url: orderUrl(o), tag: `order-${o.id}` });
      }
    },
    trackingFound(o) {
      if (o.vendor_id) push.notify(['vendor'], { title: '송장번호 등록', body: `${o.order_no} · ${o.tracking_carrier} ${o.tracking_no}`, url: orderUrl(o, 'vendor'), tag: `order-${o.id}` }, { vendorId: o.vendor_id });
    },
    trackingAwaiting(o, cands) {
      const c = cands[0];
      const body = cands.length === 1
        ? `${o.order_no} · ${o.recipient_name} · 대신택배 ${c.tracking_no} (${c.received_at} 접수)
맞으면 승인해 주세요 → 출고 완료`
        : `${o.order_no} · ${o.recipient_name} · 송장 후보 ${cands.length}건, 맞는 것을 골라 승인해 주세요.`;
      push.notify(['admin'], { title: '송장 찾음 · 승인하면 출고', body, url: orderUrl(o), tag: `order-${o.id}` });
    },
    trackingAttention(o, kind, n) {
      const body = kind === 'multiple' ? `${o.order_no} · 대신택배 송장 후보 ${n}건, 맞는 것을 골라 주세요.` : `${o.order_no} · 대신택배에서 송장을 찾지 못했습니다. 직접 입력해 주세요.`;
      push.notify(['admin', 'factory'], { title: '송장 확인 필요', body, url: orderUrl(o), tag: `order-${o.id}` });
    },
    smartstore(kind, data) {
      if (kind === 'paid') {
        const parts = [data.imported ? `자동 등록 ${data.imported}건` : null, data.review ? `확인 필요 ${data.review}건 (치수 보완)` : null].filter(Boolean);
        push.notify(['admin'], { title: `스마트스토어 새 주문 ${data.imported + data.review}건`, body: parts.join(' · '), url: data.review ? '/#/smartstore?filter=needs_review' : '/#/orders', tag: 'smartstore-paid' });
      }
      if (kind === 'cancel_request') {
        push.notify(['admin'], { title: '스마트스토어 취소 요청', body: `${data.row.product_name || ''} · 상품주문 ${data.row.product_order_id}`, url: '/#/smartstore?filter=cancel', tag: `ss-cancel-${data.row.product_order_id}` });
      }
    },
  };

  const ss = resolveSmartstore(smartstore);
  const sync = createSync({ db, client: ss.client, mode: ss.mode, pollMinutes: Number(smartstore.pollMinutes || process.env.SMARTSTORE_POLL_MINUTES) || 5, onEvent: notifyEvent.smartstore });
  const tracking = createTrackingLookup({
    db, search: trackingSearch, delayMs: trackingDelayMs,
    onFound: (order) => { sync.dispatchOrder(order).catch(() => {}); notifyEvent.trackingFound(order); },
    onAttention: notifyEvent.trackingAttention,
    onAwaiting: notifyEvent.trackingAwaiting,
  });
  orders.setHooks({
    afterShipped: (order) => {
      if (order.tracking_no) sync.dispatchOrder(order).catch(() => {});
      else if (order.tracking_carrier === orders.AUTO_LOOKUP_CARRIER) tracking.request(order);
    },
    afterCreated: notifyEvent.created,
    afterStatus: notifyEvent.status,
  });
  if (autoStart) {
    sync.start();
    tracking.start();
  }

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

  // ----- 휴대폰 알림 -----
  router.add('GET', '/api/push/key', async (ctx) => {
    requireRole(ctx.user);
    json(ctx.res, 200, { key: push.publicKey, devices: push.countFor(ctx.user) });
  });
  router.add('POST', '/api/push/subscribe', async (ctx) => {
    requireRole(ctx.user);
    try { push.subscribe(ctx.user, ctx.body.subscription, ctx.req.headers['user-agent']); }
    catch (e) { throw new HttpError(e.status || 400, e.message); }
    push.rememberSite(ctx.req.headers.host);
    json(ctx.res, 200, { ok: true, devices: push.countFor(ctx.user) });
  });
  router.add('POST', '/api/push/unsubscribe', async (ctx) => {
    requireRole(ctx.user);
    push.unsubscribe(ctx.user, ctx.body.endpoint);
    json(ctx.res, 200, { ok: true, devices: push.countFor(ctx.user) });
  });
  router.add('POST', '/api/push/test', async (ctx) => {
    requireRole(ctx.user);
    const sent = await push.notifyUser(ctx.user, { title: 'BLACKOUT 알림 시험', body: '이 휴대폰으로 주문 알림이 옵니다.', url: '/#/notifications', tag: 'push-test' });
    json(ctx.res, 200, { sent });
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
      default_carrier: CARRIERS.includes(settings.default_carrier) ? settings.default_carrier : CARRIERS[0],
      auto_lookup_carrier: orders.AUTO_LOOKUP_CARRIER,
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
      meta.smartstore = { mode: ss.mode, enabled: sync.enabled() };
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
    const data = orders.getOrder(db, ctx.user, Number(ctx.params.id));
    if (ctx.user.role !== 'vendor') data.tracking_lookup = tracking.get(data.order.id);
    if (ctx.user.role === 'admin' && data.order.source === 'smartstore') {
      const row = sync.getRowByOrder(data.order.id);
      if (row) {
        data.smartstore = {
          product_order_id: row.product_order_id, naver_order_id: row.naver_order_id, naver_status: row.naver_status, claim_status: row.claim_status,
          confirmed_at: row.confirmed_at, dispatch_synced: !!row.dispatch_synced, dispatch_error: row.dispatch_error, orderer_name: row.orderer_name,
          product_option: row.product_option, shipping_memo: row.shipping_memo, settlement: sync.settlementFor(row.product_order_id),
        };
      }
    }
    json(ctx.res, 200, data);
  });
  router.add('PATCH', '/api/orders/:id', async (ctx) => {
    requireRole(ctx.user, 'vendor', 'admin');
    json(ctx.res, 200, { order: orders.updateOrder(db, ctx.user, Number(ctx.params.id), ctx.body) });
  });
  router.add('POST', '/api/orders/:id/status', async (ctx) => {
    requireRole(ctx.user);
    const id = Number(ctx.params.id);
    const body = { ...ctx.body };
    if (body.status === 'approved' && ctx.user.role === 'admin') {
      // 스마트스토어 주문은 승인 전에 네이버 발주확인을 먼저 전송 (실패하면 승인하지 않음)
      const current = orders.getOrderRow(db, id);
      if (current && current.status !== 'approved') {
        const hookNote = await sync.confirmOrder(current);
        if (hookNote) body.note = [body.note, hookNote].filter(Boolean).join(' · ');
      }
    }
    json(ctx.res, 200, { order: orders.changeStatus(db, ctx.user, id, body) });
  });

  // ----- admin: smartstore -----
  router.add('GET', '/api/smartstore/status', async (ctx) => {
    requireRole(ctx.user, 'admin');
    json(ctx.res, 200, { status: sync.status(), logs: sync.logs() });
  });
  router.add('POST', '/api/smartstore/sync', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const summary = await sync.pull({ reason: 'manual' });
    json(ctx.res, 200, { summary, status: sync.status() });
  });
  router.add('GET', '/api/smartstore/orders', async (ctx) => {
    requireRole(ctx.user, 'admin');
    json(ctx.res, 200, { rows: sync.listRows({ filter: ctx.query.filter }) });
  });
  router.add('POST', '/api/smartstore/orders/:pid/import', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const spec = {};
    for (const k of ['product_type', 'width_mm', 'height_mm', 'frame_color', 'fabric_color']) if (ctx.body[k] !== undefined && ctx.body[k] !== '') spec[k] = ctx.body[k];
    const order = sync.tryImport(ctx.params.pid, spec, ctx.user);
    json(ctx.res, 201, { order: orders.serializeOrder(order, 'admin') });
  });
  router.add('POST', '/api/smartstore/orders/:pid/ignore', async (ctx) => {
    requireRole(ctx.user, 'admin');
    json(ctx.res, 200, { row: sync.ignore(ctx.params.pid) });
  });
  router.add('POST', '/api/smartstore/orders/:pid/cancel-approve', async (ctx) => {
    requireRole(ctx.user, 'admin');
    json(ctx.res, 200, { row: await sync.approveCancel(ctx.params.pid, ctx.user) });
  });
  router.add('POST', '/api/smartstore/orders/:pid/dispatch-retry', async (ctx) => {
    requireRole(ctx.user, 'admin');
    const row = sync.getRow(ctx.params.pid);
    if (!row || !row.order_id) throw new HttpError(404, '연결된 주문이 없습니다.');
    const order = orders.getOrderRow(db, row.order_id);
    if (!order.tracking_no) throw new HttpError(409, '송장이 등록되지 않은 주문입니다.');
    await sync.dispatchOrder(order);
    json(ctx.res, 200, { row: sync.getRow(ctx.params.pid) });
  });
  // 모의 모드 전용: 가짜 스마트스토어 주문/취소요청 생성
  router.add('POST', '/api/smartstore/mock/order', async (ctx) => {
    requireRole(ctx.user, 'admin');
    if (ss.mode !== 'mock') throw new HttpError(400, '모의 모드에서만 사용할 수 있습니다.');
    const pid = ss.client.addSampleOrder(ctx.body || {});
    json(ctx.res, 201, { product_order_id: pid });
  });
  router.add('POST', '/api/smartstore/mock/cancel/:pid', async (ctx) => {
    requireRole(ctx.user, 'admin');
    if (ss.mode !== 'mock') throw new HttpError(400, '모의 모드에서만 사용할 수 있습니다.');
    ss.client.requestCancel(ctx.params.pid);
    json(ctx.res, 200, { ok: true });
  });
  router.add('POST', '/api/orders/:id/tracking', async (ctx) => {
    requireRole(ctx.user, 'factory', 'admin');
    const id = Number(ctx.params.id);
    const order = orders.updateTracking(db, ctx.user, id, ctx.body);
    tracking.markManual(id);
    json(ctx.res, 200, { order });
  });
  // 송장 자동 찾기: { action: 'retry' } 지금 다시 찾기 · { action: 'choose', tracking_no } 후보 고르기
  router.add('POST', '/api/orders/:id/tracking-lookup', async (ctx) => {
    requireRole(ctx.user, 'factory', 'admin');
    const id = Number(ctx.params.id);
    orders.getOrder(db, ctx.user, id); // 볼 수 있는 주문인지 확인
    if (ctx.body.action === 'choose') tracking.choose(id, String(ctx.body.tracking_no || ''), ctx.user);
    else if (ctx.body.action === 'retry') await tracking.retry(id);
    else throw new HttpError(400, 'action 은 retry 또는 choose 입니다.');
    json(ctx.res, 200, { tracking_lookup: tracking.get(id), order: orders.getOrder(db, ctx.user, id).order });
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
    const numericKeys = ['default_unit_price_per_sqm', 'min_billable_area_sqm', 'shipping_fee', 'factory_cost_per_sqm', 'min_size_mm', 'max_size_mm', 'smartstore_qty_unit_sqm',
      'factory_small_area_sqm', 'factory_small_price', 'factory_area_step_sqm', 'smartstore_delivery_cost'];
    const known = new Set(['company_name', 'default_carrier', ...numericKeys]);
    if (ctx.body.settings?.default_carrier !== undefined && !CARRIERS.includes(String(ctx.body.settings.default_carrier))) {
      throw new HttpError(400, '기본 택배사를 목록에서 골라 주세요.');
    }
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

  // ----- admin: 장부 (이전 블랙아웃 앱에서 옮긴 기록) -----
  router.add('GET', '/api/ledger', async (ctx) => {
    requireRole(ctx.user, 'admin');
    json(ctx.res, 200, ledger.listLedger(db, { month: ctx.query.month, unpaid: ctx.query.unpaid === '1' }));
  });
  router.add('PATCH', '/api/ledger/:id', async (ctx) => {
    requireRole(ctx.user, 'admin');
    if (!ledger.setPaid(db, ctx.params.id, !!ctx.body.paid)) throw new HttpError(404, '장부 기록을 찾을 수 없습니다.');
    json(ctx.res, 200, { ok: true });
  });
  router.add('POST', '/api/ledger/import-key', async (ctx) => {
    requireRole(ctx.user, 'admin');
    json(ctx.res, 200, ledger.createImportKey());
  });
  // 이전 앱 화면에서 직접 보내는 옮기기: 로그인 대신 일회용 키(10분, 한 번만)로 확인한다
  router.add('POST', '/api/ledger/import', async (ctx) => {
    if (!ledger.useImportKey(ctx.query.key)) throw new HttpError(403, '옮기기 키가 없거나 만료됐습니다. 관리 앱에서 새로 받으세요.');
    try {
      json(ctx.res, 200, { imported: ledger.importEntries(db, ctx.body.entries) });
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(e.status || 400, e.message);
    }
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
          // 장부 옮기기만 예외: 다른 주소(이전 앱)에서 보내므로 text/plain 으로 온다. 대신 일회용 키가 있어야 한다.
          const isLedgerImport = req.method === 'POST' && pathname === '/api/ledger/import';
          if (!ct.includes('application/json') && !(isLedgerImport && ct.startsWith('text/plain'))) throw new HttpError(415, 'application/json 요청만 허용됩니다.');
          body = await readBody(req, isLedgerImport ? 2 * 1024 * 1024 : undefined);
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
  server.sync = sync;
  server.tracking = tracking;
  server.push = push;
  server.naverClient = ss.client;
  const origClose = server.close.bind(server);
  server.close = (cb) => { sync.stop(); tracking.stop(); return origClose(cb); };
  return server;
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  if (pathname === '/vendor') { res.writeHead(302, { Location: '/vendor/' }); return res.end(); } // 업체 앱은 /vendor/ (별도 홈 화면 앱)
  let rel = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback (업체 앱 경로는 업체 앱 화면으로)
      if (!path.extname(rel)) return sendFile(res, path.join(PUBLIC_DIR, pathname.startsWith('/vendor/') ? 'vendor/index.html' : 'index.html'), '.html');
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
  const server = createApp({ secureCookies: process.env.SECURE_COOKIES === '1', autoStart: true });
  server.listen(port, host, () => {
    console.log(`BLACKOUT 주문관리 서버 실행 중: http://localhost:${port}`);
    const st = server.sync.status();
    console.log(`스마트스토어 연동: ${st.mode === 'off' ? '미설정 (NAVER_CLIENT_ID/SECRET 또는 SMARTSTORE_MODE=mock)' : st.mode + ' 모드, ' + st.poll_minutes + '분 간격 수집'}`);
  });
}
