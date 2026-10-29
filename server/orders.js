'use strict';
const { computeQuote } = require('./pricing');
const { getSettings, getProductTypes } = require('./db');

const STATUSES = {
  received: '주문 접수',
  on_hold: '보류 (확인 필요)',
  approved: '발주 승인 · 공장 전달',
  in_production: '제작 중',
  shipped: '출고 완료 (송장 등록)',
  delivered: '배송 완료',
  cancelled: '취소',
};

// 역할별 허용 상태 전환
const TRANSITIONS = {
  admin: {
    received: ['approved', 'on_hold', 'cancelled'],
    on_hold: ['approved', 'received', 'cancelled'],
    approved: ['on_hold', 'cancelled'],
    in_production: [],
    shipped: ['delivered'],
    delivered: [],
    cancelled: [],
  },
  vendor: {
    received: ['cancelled'],
    on_hold: ['cancelled'],
    shipped: ['delivered'],
  },
  factory: {
    approved: ['in_production'],
    in_production: ['shipped'],
  },
};

const FACTORY_VISIBLE_SQL = `(o.status IN ('approved','in_production','shipped','delivered') OR (o.status = 'cancelled' AND o.approved_at IS NOT NULL))`;

const FACTORY_FIELDS = [
  'id', 'order_no', 'product_type', 'product_type_name', 'width_mm', 'height_mm', 'frame_color', 'fabric_color',
  'quantity', 'area_sqm', 'recipient_name', 'recipient_phone', 'zip_code', 'address', 'address_detail',
  'install_note', 'status', 'status_name', 'tracking_carrier', 'tracking_no', 'created_at', 'updated_at',
  'approved_at', 'production_started_at', 'shipped_at', 'delivered_at', 'source',
];

const VENDOR_HIDDEN = new Set(['factory_cost', 'delivery_cost', 'admin_memo', 'created_by']);

// 외부 연동 훅 (스마트스토어·알림 등). beforeApprove 는 throw 로 승인을 막을 수 있고, 나머지는 실패해도 처리를 막지 않음.
const hooks = { beforeApprove: null, afterShipped: null, afterCancelled: null, afterCreated: null, afterStatus: null };
function setHooks(h) { Object.assign(hooks, h); }

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function serializeOrder(row, role) {
  if (!row) return null;
  const out = { ...row, status_name: STATUSES[row.status] || row.status };
  if (role === 'factory') {
    const picked = {};
    for (const k of FACTORY_FIELDS) picked[k] = out[k] === undefined ? null : out[k];
    return picked;
  }
  if (role === 'vendor') {
    for (const k of VENDOR_HIDDEN) delete out[k];
  }
  return out;
}

function serializeHistory(rows, role) {
  return rows.map((h) => {
    const out = {
      id: h.id,
      event: h.event,
      from_status: h.from_status,
      to_status: h.to_status,
      from_status_name: h.from_status ? STATUSES[h.from_status] : null,
      to_status_name: h.to_status ? STATUSES[h.to_status] : null,
      actor_role: h.actor_role,
      actor_name: h.actor_name,
      note: h.note,
      details: h.details ? safeJson(h.details) : null,
      created_at: h.created_at,
    };
    if (role === 'factory') {
      // 공장에는 관리자/업체 간 메모를 노출하지 않음
      if (h.actor_role !== 'factory' && h.event !== 'status') out.note = null;
      if (out.details) {
        const d = {};
        for (const k of Object.keys(out.details)) {
          if (!/price|amount|surcharge|fee|cost|memo|vendor/.test(k)) d[k] = out.details[k];
        }
        out.details = d;
      }
      if (h.actor_role === 'vendor') out.actor_name = '업체';
    }
    if (role === 'vendor' && out.details) {
      const d = {};
      for (const k of Object.keys(out.details)) if (!/factory_cost|admin_memo/.test(k)) d[k] = out.details[k];
      out.details = d;
    }
    return out;
  });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const BASE_SELECT = `
  SELECT o.*, v.name AS vendor_name, pt.name AS product_type_name
  FROM orders o
  LEFT JOIN vendors v ON v.id = o.vendor_id
  LEFT JOIN product_types pt ON pt.code = o.product_type
`;

function addHistory(db, orderId, user, event, { fromStatus = null, toStatus = null, note = null, details = null } = {}) {
  db.prepare(
    `INSERT INTO order_history (order_id, actor_id, actor_role, actor_name, event, from_status, to_status, note, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    orderId,
    user ? user.id : null,
    user ? user.role : 'system',
    user ? user.name : 'system',
    event,
    fromStatus,
    toStatus,
    note,
    details ? JSON.stringify(details) : null
  );
}

function nextOrderNo(db, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const prefix = `BO-${y}${m}${d}-`;
  const row = db.prepare('SELECT order_no FROM orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1').get(`${prefix}%`);
  let seq = 1;
  if (row) seq = Number(row.order_no.slice(prefix.length)) + 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

function requireText(body, key, label, { max = 200, required = true } = {}) {
  const v = body[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new HttpError(400, `${label}을(를) 입력해 주세요.`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, `${label}은(는) ${max}자 이내로 입력해 주세요.`);
  return s;
}

// 이 택배사는 송장 없이 출고하면 tracking-lookup 이 받는 분 전화번호로 송장번호를 찾아 채운다.
const AUTO_LOOKUP_CARRIER = '대신택배';
const TRACKING_DIGITS = { 대신택배: 13 };

/** 송장번호 정리·검증. 자릿수가 정해진 택배사는 하이픈·띄어쓰기를 지우고 자릿수를 확인한다. */
function normalizeTrackingNo(carrier, raw, { required = true } = {}) {
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!v) {
    if (required) throw new HttpError(400, '송장번호를 입력해 주세요.');
    return null;
  }
  const digits = TRACKING_DIGITS[carrier];
  if (digits) {
    const d = v.replace(/[\s-]/g, '');
    if (!/^\d+$/.test(d) || d.length !== digits) throw new HttpError(400, `${carrier} 송장번호는 숫자 ${digits}자리입니다. (입력한 값: ${d.length}자리)`);
    return d;
  }
  if (!/^[0-9A-Za-z-]{6,40}$/.test(v)) throw new HttpError(400, '송장번호 형식을 확인해 주세요.');
  return v;
}

function getOrderRow(db, id) {
  return db.prepare(`${BASE_SELECT} WHERE o.id = ?`).get(id);
}

function assertCanView(order, user) {
  if (!order) throw new HttpError(404, '주문을 찾을 수 없습니다.');
  if (user.role === 'vendor' && order.vendor_id !== user.vendor_id) throw new HttpError(404, '주문을 찾을 수 없습니다.');
  if (user.role === 'factory') {
    const visible =
      ['approved', 'in_production', 'shipped', 'delivered'].includes(order.status) ||
      (order.status === 'cancelled' && order.approved_at);
    if (!visible) throw new HttpError(404, '주문을 찾을 수 없습니다.');
  }
}

function listOrders(db, user, query) {
  const where = [];
  const params = [];
  if (user.role === 'vendor') {
    where.push('o.vendor_id = ?');
    params.push(user.vendor_id);
  } else if (user.role === 'factory') {
    where.push(FACTORY_VISIBLE_SQL);
  }
  if (query.status) {
    const list = String(query.status).split(',').filter((s) => STATUSES[s]);
    if (list.length) {
      where.push(`o.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (query.vendor_id && user.role === 'admin') {
    where.push('o.vendor_id = ?');
    params.push(Number(query.vendor_id));
  }
  if (query.q) {
    const q = `%${String(query.q).trim()}%`;
    if (user.role === 'factory') {
      where.push('(o.order_no LIKE ? OR o.recipient_name LIKE ? OR o.tracking_no LIKE ?)');
      params.push(q, q, q);
    } else {
      where.push('(o.order_no LIKE ? OR o.recipient_name LIKE ? OR o.tracking_no LIKE ? OR v.name LIKE ?)');
      params.push(q, q, q, q);
    }
  }
  if (query.from) {
    where.push('o.created_at >= ?');
    params.push(`${query.from} 00:00:00`);
  }
  if (query.to) {
    where.push('o.created_at <= ?');
    params.push(`${query.to} 23:59:59`);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
  const sql = `${BASE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit}`;
  return db.prepare(sql).all(...params).map((r) => serializeOrder(r, user.role));
}

function resolveVendorForOrder(db, user, body) {
  if (user.role === 'vendor') {
    const v = db.prepare('SELECT * FROM vendors WHERE id = ? AND active = 1').get(user.vendor_id);
    if (!v) throw new HttpError(403, '업체 정보가 비활성화되어 주문할 수 없습니다. 관리자에게 문의하세요.');
    return v;
  }
  if (user.role === 'admin') {
    if (!body.vendor_id) throw new HttpError(400, '업체를 선택해 주세요.');
    const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(body.vendor_id));
    if (!v) throw new HttpError(400, '존재하지 않는 업체입니다.');
    return v;
  }
  throw new HttpError(403, '주문을 생성할 권한이 없습니다.');
}

function quoteFor(db, body, vendor) {
  const settings = getSettings(db);
  const productTypes = getProductTypes(db);
  return computeQuote(body, { settings, productTypes, vendor });
}

function createOrder(db, user, body) {
  const vendor = resolveVendorForOrder(db, user, body);
  const result = quoteFor(db, body, vendor);
  if (!result.ok) throw new HttpError(400, result.errors.join(' '), { errors: result.errors });
  const q = result.quote;

  const recipient_name = requireText(body, 'recipient_name', '수령인', { max: 50 });
  const recipient_phone = requireText(body, 'recipient_phone', '수령인 연락처', { max: 30 });
  if (!/^[0-9+\-() ]{8,30}$/.test(recipient_phone)) throw new HttpError(400, '수령인 연락처 형식을 확인해 주세요.');
  const address = requireText(body, 'address', '배송지 주소', { max: 200 });
  const address_detail = requireText(body, 'address_detail', '상세 주소', { max: 200, required: false });
  const zip_code = requireText(body, 'zip_code', '우편번호', { max: 10, required: false });
  const install_note = requireText(body, 'install_note', '설치 요청사항', { max: 1000, required: false });
  const admin_memo = user.role === 'admin' ? requireText(body, 'admin_memo', '관리자 메모', { max: 1000, required: false }) : null;
  const source = user.role === 'admin' && body.source === 'smartstore' ? 'smartstore' : 'vendor';
  const external_ref = user.role === 'admin' ? requireText(body, 'external_ref', '외부 주문번호', { max: 50, required: false }) : null;

  const orderId = insertOrder(db, {
    source, external_ref, vendor_id: vendor.id, quote: q,
    recipient_name, recipient_phone, zip_code, address, address_detail, install_note, admin_memo,
    created_by: user.id,
  }, user, '주문 접수 (규격·옵션 자동 검증 통과)');
  const created = getOrderRow(db, orderId);
  if (hooks.afterCreated) hooks.afterCreated(created, user);
  return serializeOrder(created, user.role);
}

function insertOrder(db, f, actor, note) {
  const q = f.quote;
  let orderId;
  db.exec('BEGIN');
  try {
    const order_no = nextOrderNo(db);
    const info = db
      .prepare(
        `INSERT INTO orders (order_no, source, external_ref, vendor_id, product_type, width_mm, height_mm, frame_color, fabric_color, quantity,
           area_sqm, billed_area_sqm, unit_price, product_amount, surcharge, shipping_fee, total_amount, factory_cost, delivery_cost,
           recipient_name, recipient_phone, zip_code, address, address_detail, install_note, admin_memo, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
      )
      .run(
        order_no, f.source, f.external_ref ?? null, f.vendor_id ?? null, q.product_type, q.width_mm, q.height_mm, q.frame_color, q.fabric_color, q.quantity,
        q.area_sqm, q.billed_area_sqm, q.unit_price, q.product_amount, q.surcharge, q.shipping_fee, q.total_amount, q.factory_cost, f.delivery_cost || 0,
        f.recipient_name, f.recipient_phone, f.zip_code ?? null, f.address, f.address_detail ?? null, f.install_note ?? null, f.admin_memo ?? null, f.created_by ?? null
      );
    orderId = Number(info.lastInsertRowid);
    addHistory(db, orderId, actor, 'created', { toStatus: 'received', note });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return orderId;
}

const SYSTEM_ACTOR = { id: null, role: 'admin', name: '스마트스토어 연동', system: true };

/**
 * 스마트스토어 주문 → 내부 주문 생성.
 * 금액은 네이버 결제 금액을 그대로 쓰고(업체 단가 미적용), 제작원가만 내부 기준으로 계산합니다.
 */
function createSmartstoreOrder(db, { spec, recipient, amounts, external_ref, install_note, admin_memo, actor }) {
  const result = quoteFor(db, spec, null);
  if (!result.ok) throw new HttpError(400, result.errors.join(' '), { errors: result.errors });
  const q = { ...result.quote };
  const productAmount = Math.round(Number(amounts.product_amount) || 0);
  const shippingFee = Math.round(Number(amounts.shipping_fee) || 0);
  q.product_amount = productAmount;
  q.surcharge = 0;
  q.shipping_fee = shippingFee;
  q.total_amount = productAmount + shippingFee;
  q.unit_price = q.billed_area_sqm * q.quantity > 0 ? Math.round(productAmount / (q.billed_area_sqm * q.quantity)) : 0;
  const orderId = insertOrder(db, {
    source: 'smartstore', external_ref, vendor_id: null, quote: q, delivery_cost: Number(getSettings(db).smartstore_delivery_cost) || 0,
    recipient_name: recipient.name, recipient_phone: recipient.phone, zip_code: recipient.zip_code ?? null,
    address: recipient.address, address_detail: recipient.address_detail ?? null, install_note: install_note ?? null,
    admin_memo: admin_memo ?? null, created_by: actor && actor.id ? actor.id : null,
  }, actor || SYSTEM_ACTOR, `스마트스토어 주문 수집 (상품주문번호 ${external_ref})`);
  return getOrderRow(db, orderId);
}

const SPEC_FIELDS = ['product_type', 'width_mm', 'height_mm', 'frame_color', 'fabric_color', 'quantity'];
const SHIP_FIELDS = ['recipient_name', 'recipient_phone', 'zip_code', 'address', 'address_detail', 'install_note'];

function updateOrder(db, user, id, body) {
  const order = getOrderRow(db, id);
  assertCanView(order, user);
  if (user.role === 'factory') throw new HttpError(403, '공장 계정은 주문 내용을 수정할 수 없습니다.');

  const editableStatuses = user.role === 'admin' ? ['received', 'on_hold', 'approved'] : ['received', 'on_hold'];
  const wantsSpecOrShip = [...SPEC_FIELDS, ...SHIP_FIELDS].some((k) => body[k] !== undefined);
  if (wantsSpecOrShip && !editableStatuses.includes(order.status)) {
    throw new HttpError(409, `현재 상태(${STATUSES[order.status]})에서는 주문 내용을 수정할 수 없습니다.`);
  }

  const changes = {};
  const sets = [];
  const params = [];

  const specChanged = SPEC_FIELDS.some((k) => body[k] !== undefined && String(body[k]) !== String(order[k]));
  if (specChanged) {
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(order.vendor_id);
    const merged = {};
    for (const k of SPEC_FIELDS) merged[k] = body[k] !== undefined ? body[k] : order[k];
    const result = quoteFor(db, merged, vendor);
    if (!result.ok) throw new HttpError(400, result.errors.join(' '), { errors: result.errors });
    const q = result.quote;
    const map = {
      product_type: q.product_type, width_mm: q.width_mm, height_mm: q.height_mm, frame_color: q.frame_color,
      fabric_color: q.fabric_color, quantity: q.quantity, area_sqm: q.area_sqm, billed_area_sqm: q.billed_area_sqm,
      unit_price: q.unit_price, product_amount: q.product_amount, surcharge: q.surcharge, shipping_fee: q.shipping_fee,
      total_amount: q.total_amount, factory_cost: q.factory_cost,
    };
    for (const [k, v] of Object.entries(map)) {
      if (v !== order[k]) {
        changes[k] = { from: order[k], to: v };
        sets.push(`${k} = ?`);
        params.push(v);
      }
    }
  }

  for (const k of SHIP_FIELDS) {
    if (body[k] === undefined) continue;
    const labels = {
      recipient_name: '수령인', recipient_phone: '수령인 연락처', zip_code: '우편번호', address: '배송지 주소',
      address_detail: '상세 주소', install_note: '설치 요청사항',
    };
    const required = ['recipient_name', 'recipient_phone', 'address'].includes(k);
    const max = k === 'install_note' ? 1000 : k === 'zip_code' ? 10 : k === 'recipient_phone' ? 30 : 200;
    const v = requireText(body, k, labels[k], { max, required });
    if (k === 'recipient_phone' && !/^[0-9+\-() ]{8,30}$/.test(v)) throw new HttpError(400, '수령인 연락처 형식을 확인해 주세요.');
    if ((v ?? null) !== (order[k] ?? null)) {
      changes[k] = { from: order[k], to: v };
      sets.push(`${k} = ?`);
      params.push(v);
    }
  }

  if (user.role === 'admin' && body.admin_memo !== undefined) {
    const v = requireText(body, 'admin_memo', '관리자 메모', { max: 1000, required: false });
    if ((v ?? null) !== (order.admin_memo ?? null)) {
      changes.admin_memo = { from: order.admin_memo, to: v };
      sets.push('admin_memo = ?');
      params.push(v);
    }
  }

  if (!sets.length) return serializeOrder(order, user.role);

  sets.push("updated_at = datetime('now','localtime')");
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    addHistory(db, id, user, 'updated', { note: body.note ? String(body.note).slice(0, 500) : null, details: changes });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return serializeOrder(getOrderRow(db, id), user.role);
}

function changeStatus(db, user, id, body) {
  const order = getOrderRow(db, id);
  assertCanView(order, user);
  const to = body.status;
  if (!STATUSES[to]) throw new HttpError(400, '알 수 없는 상태입니다.');
  const allowed = (TRANSITIONS[user.role] || {})[order.status] || [];
  if (!allowed.includes(to)) {
    throw new HttpError(409, `${STATUSES[order.status]} → ${STATUSES[to]} 전환은 현재 계정에서 허용되지 않습니다.`);
  }

  const sets = ['status = ?', "updated_at = datetime('now','localtime')"];
  const params = [to];
  let tracking = null;

  if (to === 'approved') sets.push("approved_at = datetime('now','localtime')");
  if (to === 'in_production') sets.push("production_started_at = datetime('now','localtime')");
  if (to === 'delivered') sets.push("delivered_at = datetime('now','localtime')");
  if (to === 'shipped') {
    const carrier = requireText(body, 'tracking_carrier', '택배사', { max: 30 });
    const trackingNo = normalizeTrackingNo(carrier, body.tracking_no, { required: carrier !== AUTO_LOOKUP_CARRIER });
    sets.push('tracking_carrier = ?', 'tracking_no = ?', "shipped_at = datetime('now','localtime')");
    params.push(carrier, trackingNo);
    tracking = { tracking_carrier: carrier, tracking_no: trackingNo };
  }
  let note = body.note ? String(body.note).slice(0, 500) : null;
  if (tracking && !tracking.tracking_no) note = [note, `송장번호는 ${AUTO_LOOKUP_CARRIER}에서 자동으로 찾습니다.`].filter(Boolean).join(' · ');

  // 외부 연동: 승인 전 발주확인 (실패 시 승인 중단)
  let hookNote = null;
  if (to === 'approved' && hooks.beforeApprove) hookNote = hooks.beforeApprove(order, user);

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    addHistory(db, id, user, 'status', { fromStatus: order.status, toStatus: to, note: [note, hookNote].filter(Boolean).join(' · ') || null, details: tracking });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const updated = getOrderRow(db, id);
  if (to === 'shipped' && hooks.afterShipped) hooks.afterShipped(updated, user);
  if (to === 'cancelled' && hooks.afterCancelled) hooks.afterCancelled(updated, user);
  if (hooks.afterStatus) hooks.afterStatus(updated, order.status, to, user);
  return serializeOrder(updated, user.role);
}

/** 시스템(연동)에 의한 상태 변경·메모. 관리자 전환 규칙을 따름. */
function systemChangeStatus(db, id, to, note) {
  return changeStatus(db, SYSTEM_ACTOR, id, { status: to, note });
}
function systemNote(db, id, note, details) {
  addHistory(db, id, SYSTEM_ACTOR, 'note', { note, details });
}

const LOOKUP_ACTOR = { id: null, role: 'admin', name: '송장 자동 찾기', system: true };
/** 송장 자동 찾기가 찾은 번호를 등록. 이미 송장이 있으면 덮어쓰지 않는다. */
function systemSetTracking(db, id, trackingNo, note) {
  const order = getOrderRow(db, id);
  if (!order || order.tracking_no) return order;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE orders SET tracking_no = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(trackingNo, id);
    addHistory(db, id, LOOKUP_ACTOR, 'tracking', { note, details: { tracking_no: { from: null, to: trackingNo } } });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getOrderRow(db, id);
}

function updateTracking(db, user, id, body) {
  // 출고 후 송장 정정 (공장/관리자)
  const order = getOrderRow(db, id);
  assertCanView(order, user);
  if (!['factory', 'admin'].includes(user.role)) throw new HttpError(403, '권한이 없습니다.');
  if (!['shipped', 'delivered'].includes(order.status)) throw new HttpError(409, '출고된 주문만 송장을 수정할 수 있습니다.');
  const carrier = requireText(body, 'tracking_carrier', '택배사', { max: 30 });
  const trackingNo = normalizeTrackingNo(carrier, body.tracking_no);
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE orders SET tracking_carrier = ?, tracking_no = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(carrier, trackingNo, id);
    addHistory(db, id, user, 'tracking', {
      details: {
        tracking_carrier: { from: order.tracking_carrier, to: carrier },
        tracking_no: { from: order.tracking_no, to: trackingNo },
      },
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return serializeOrder(getOrderRow(db, id), user.role);
}

function getOrder(db, user, id) {
  const order = getOrderRow(db, id);
  assertCanView(order, user);
  const history = db.prepare('SELECT * FROM order_history WHERE order_id = ? ORDER BY id ASC').all(id);
  const allowed = (TRANSITIONS[user.role] || {})[order.status] || [];
  return {
    order: serializeOrder(order, user.role),
    history: serializeHistory(history, user.role),
    allowed_transitions: allowed.map((s) => ({ code: s, name: STATUSES[s] })),
  };
}

function stats(db, { from, to } = {}) {
  const where = ["o.status != 'cancelled'"];
  const params = [];
  if (from) {
    where.push('o.created_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('o.created_at <= ?');
    params.push(`${to} 23:59:59`);
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(product_amount + surcharge),0) AS revenue,
              COALESCE(SUM(shipping_fee),0) AS shipping, COALESCE(SUM(factory_cost),0) AS factory_cost, COALESCE(SUM(delivery_cost),0) AS delivery_cost,
              COALESCE(SUM(product_amount + surcharge - factory_cost - delivery_cost),0) AS margin,
              COALESCE(SUM(billed_area_sqm * quantity),0) AS billed_area
       FROM orders o ${w}`
    )
    .get(...params);
  const byMonth = db
    .prepare(
      `SELECT substr(o.created_at,1,7) AS month, COUNT(*) AS orders,
              SUM(product_amount + surcharge) AS revenue, SUM(factory_cost) AS factory_cost,
              SUM(product_amount + surcharge - factory_cost - delivery_cost) AS margin
       FROM orders o ${w} GROUP BY month ORDER BY month DESC LIMIT 24`
    )
    .all(...params);
  const byVendor = db
    .prepare(
      `SELECT o.vendor_id, COALESCE(v.name,'(미지정)') AS vendor_name, COUNT(*) AS orders,
              SUM(product_amount + surcharge) AS revenue, SUM(factory_cost) AS factory_cost,
              SUM(product_amount + surcharge - factory_cost - delivery_cost) AS margin
       FROM orders o LEFT JOIN vendors v ON v.id = o.vendor_id ${w}
       GROUP BY o.vendor_id ORDER BY revenue DESC`
    )
    .all(...params);
  const bySource = db
    .prepare(
      `SELECT o.source, COUNT(*) AS orders, SUM(product_amount + surcharge) AS revenue, SUM(factory_cost) AS factory_cost,
              SUM(product_amount + surcharge - factory_cost - delivery_cost) AS margin
       FROM orders o ${w} GROUP BY o.source ORDER BY o.source`
    )
    .all(...params);
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
  const statusCounts = {};
  for (const s of Object.keys(STATUSES)) statusCounts[s] = 0;
  for (const r of byStatus) statusCounts[r.status] = r.n;
  return { totals, by_month: byMonth, by_vendor: byVendor, by_source: bySource, status_counts: statusCounts };
}

module.exports = {
  STATUSES, TRANSITIONS, HttpError, listOrders, createOrder, updateOrder, changeStatus, updateTracking, getOrder, stats,
  quoteFor, resolveVendorForOrder, serializeOrder, setHooks, createSmartstoreOrder, systemChangeStatus, systemNote, getOrderRow,
  SYSTEM_ACTOR, AUTO_LOOKUP_CARRIER, normalizeTrackingNo, systemSetTracking,
};
