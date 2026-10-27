'use strict';
/**
 * 스마트스토어 동기화 서비스
 *  - pull():      결제완료 주문 수집 → 규격 변환 → 내부 주문 생성 (변환 실패 시 '확인 필요')
 *                 취소 요청 수집 → 제작 전이면 보류 처리, 제작 중이면 관리자에게 표시
 *                 발송처리 실패분 재시도
 *  - 승인 훅:     관리자 승인 시 네이버 발주확인 호출 (실패하면 승인 중단)
 *  - 출고 훅:     공장 송장 등록 시 네이버 발송처리 호출 (실패해도 출고는 유지, 이후 재시도)
 */
const orders = require('../orders');
const { parseSpec } = require('./parse');
const { DELIVERY_COMPANY_CODES } = require('./client');

const { HttpError } = orders;
const DAY = 24 * 3600 * 1000;

function createSync({ db, client, mode, pollMinutes = 5, logger = console }) {
  const getState = (k) => db.prepare('SELECT value FROM sync_state WHERE key = ?').get(k)?.value ?? null;
  const setState = (k, v) => db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  const log = (kind, ok, message, details) => {
    db.prepare('INSERT INTO smartstore_sync_log (kind, ok, message, details) VALUES (?, ?, ?, ?)').run(kind, ok ? 1 : 0, message, details ? JSON.stringify(details) : null);
    db.prepare('DELETE FROM smartstore_sync_log WHERE id NOT IN (SELECT id FROM smartstore_sync_log ORDER BY id DESC LIMIT 300)').run();
  };
  const getRow = (pid) => db.prepare('SELECT * FROM smartstore_orders WHERE product_order_id = ?').get(pid);
  const getRowByOrder = (orderId) => db.prepare('SELECT * FROM smartstore_orders WHERE order_id = ?').get(orderId);
  const enabled = () => mode !== 'off' && !!client;

  let timer = null;
  let running = false;

  // ---------- 수집 ----------
  async function fetchChanges(type, stateKey) {
    const now = Date.now();
    let from = getState(stateKey) ? new Date(getState(stateKey)).getTime() : now - DAY;
    if (from < now - 30 * DAY) from = now - 30 * DAY;
    const all = [];
    // 네이버 조회 구간 제한을 고려해 24시간 단위로 나눠 조회
    for (let s = from; s <= now; s += DAY) {
      const list = await client.getLastChanged({ from: new Date(s).toISOString(), type });
      all.push(...list);
    }
    let maxChanged = from;
    for (const c of all) {
      const t = new Date(c.lastChangedDate).getTime();
      if (t > maxChanged) maxChanged = t;
    }
    return { list: dedupe(all), cursor: new Date(Math.max(maxChanged, now - 60_000)).toISOString() };
  }

  function dedupe(list) {
    const seen = new Set();
    return list.filter((c) => (seen.has(c.productOrderId) ? false : seen.add(c.productOrderId)));
  }

  function upsertRow(detail, extra = {}) {
    const po = detail.productOrder || {};
    const od = detail.order || {};
    const addr = po.shippingAddress || {};
    const { spec, missing } = parseSpec(po.productOption, po.shippingMemo);
    const existing = getRow(po.productOrderId);
    const payment = Number(po.totalPaymentAmount ?? 0);
    const deliveryFee = Number(po.deliveryFeeAmount ?? 0);
    const params = {
      product_order_id: po.productOrderId,
      naver_order_id: od.orderId ?? po.orderId ?? null,
      naver_status: po.productOrderStatus ?? null,
      claim_status: po.claimStatus ?? null,
      place_order_status: po.placeOrderStatus ?? null,
      product_name: po.productName ?? null,
      product_option: po.productOption ?? null,
      shipping_memo: po.shippingMemo ?? null,
      parsed_spec: JSON.stringify(spec),
      parse_missing: JSON.stringify(missing),
      orderer_name: od.ordererName ?? null,
      payment_amount: payment - deliveryFee,
      delivery_fee: deliveryFee,
      quantity: Number(po.quantity ?? 1),
      paid_at: od.paymentDate ?? null,
      raw: JSON.stringify({ productOrder: po, order: od, shippingAddress: addr }),
      ...extra,
    };
    if (existing) {
      db.prepare(
        `UPDATE smartstore_orders SET naver_status = ?, claim_status = ?, place_order_status = ?, product_name = ?, product_option = ?, shipping_memo = ?,
           parsed_spec = ?, parse_missing = ?, orderer_name = ?, payment_amount = ?, delivery_fee = ?, quantity = ?, paid_at = ?, raw = ?,
           updated_at = datetime('now','localtime') WHERE product_order_id = ?`
      ).run(
        params.naver_status, params.claim_status, params.place_order_status, params.product_name, params.product_option, params.shipping_memo,
        params.parsed_spec, params.parse_missing, params.orderer_name, params.payment_amount, params.delivery_fee, params.quantity, params.paid_at, params.raw,
        params.product_order_id
      );
    } else {
      db.prepare(
        `INSERT INTO smartstore_orders (product_order_id, naver_order_id, naver_status, claim_status, place_order_status, product_name, product_option, shipping_memo,
           parsed_spec, parse_missing, orderer_name, payment_amount, delivery_fee, quantity, paid_at, raw, import_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_review')`
      ).run(
        params.product_order_id, params.naver_order_id, params.naver_status, params.claim_status, params.place_order_status, params.product_name, params.product_option, params.shipping_memo,
        params.parsed_spec, params.parse_missing, params.orderer_name, params.payment_amount, params.delivery_fee, params.quantity, params.paid_at, params.raw
      );
    }
    return { spec, missing, addr, po, od };
  }

  function recipientFrom(addr, od, po) {
    return {
      name: addr.name || od.ordererName || '수령인',
      phone: addr.tel1 || addr.tel2 || od.ordererTel || '000-0000-0000',
      zip_code: addr.zipCode || null,
      address: addr.baseAddress || '주소 미확인',
      address_detail: addr.detailedAddress || null,
    };
  }

  function tryImport(pid, specOverride, actor) {
    const row = getRow(pid);
    if (!row) throw new HttpError(404, '스마트스토어 주문을 찾을 수 없습니다.');
    if (row.order_id) throw new HttpError(409, '이미 내부 주문으로 등록된 상품주문입니다.');
    const raw = JSON.parse(row.raw || '{}');
    const spec = { ...JSON.parse(row.parsed_spec || '{}'), ...(specOverride || {}), quantity: row.quantity || 1 };
    const po = raw.productOrder || {};
    const recipient = recipientFrom(raw.shippingAddress || {}, raw.order || {}, po);
    const installNote = [po.shippingMemo, po.productOption ? `옵션: ${po.productOption}` : null].filter(Boolean).join('\n');
    const order = orders.createSmartstoreOrder(db, {
      spec, recipient,
      amounts: { product_amount: row.payment_amount, shipping_fee: row.delivery_fee },
      external_ref: pid,
      install_note: installNote,
      admin_memo: row.orderer_name ? `스마트스토어 주문자: ${row.orderer_name}` : null,
      actor,
    });
    db.prepare("UPDATE smartstore_orders SET order_id = ?, import_status = 'imported', updated_at = datetime('now','localtime') WHERE product_order_id = ?").run(order.id, pid);
    return order;
  }

  async function pullPaid() {
    const { list, cursor } = await fetchChanges('PAYED', 'cursor_payed');
    const newIds = list.map((c) => c.productOrderId).filter((id) => !getRow(id));
    let imported = 0;
    let review = 0;
    if (newIds.length) {
      const details = await client.getProductOrders(newIds);
      for (const d of details) {
        const { missing } = upsertRow(d);
        const pid = d.productOrder.productOrderId;
        if (!missing.length) {
          try {
            tryImport(pid, null, null);
            imported += 1;
            continue;
          } catch (e) {
            db.prepare('UPDATE smartstore_orders SET parse_missing = ? WHERE product_order_id = ?').run(JSON.stringify([...missing, e.message]), pid);
          }
        }
        review += 1;
      }
    }
    setState('cursor_payed', cursor);
    return { fetched: list.length, new: newIds.length, imported, review };
  }

  async function pullCancels() {
    const results = { requests: 0, held: 0, cancelled: 0 };
    for (const type of ['CANCEL_REQUEST', 'CANCELED']) {
      const { list, cursor } = await fetchChanges(type, `cursor_${type.toLowerCase()}`);
      for (const c of list) {
        const row = getRow(c.productOrderId);
        if (!row) continue;
        results.requests += 1;
        db.prepare("UPDATE smartstore_orders SET claim_status = ?, naver_status = ?, cancel_requested_at = COALESCE(cancel_requested_at, datetime('now','localtime')), updated_at = datetime('now','localtime') WHERE product_order_id = ?")
          .run(type === 'CANCELED' ? 'CANCEL_DONE' : 'CANCEL_REQUEST', c.productOrderStatus || row.naver_status, c.productOrderId);
        if (!row.order_id) continue;
        const o = orders.getOrderRow(db, row.order_id);
        if (!o) continue;
        if (type === 'CANCELED') {
          if (['received', 'on_hold', 'approved'].includes(o.status)) {
            orders.systemChangeStatus(db, o.id, 'cancelled', '스마트스토어에서 주문이 취소되었습니다.');
            results.cancelled += 1;
          } else if (o.status !== 'cancelled') {
            orders.systemNote(db, o.id, '스마트스토어 주문이 취소 처리되었으나 이미 제작/출고가 진행된 주문입니다. 관리자 확인 필요.');
          }
        } else if (['received', 'approved'].includes(o.status)) {
          orders.systemChangeStatus(db, o.id, 'on_hold', '스마트스토어 구매자 취소 요청 수신. 제작 전이므로 보류 처리했습니다. 네이버에서 취소 승인 후 주문을 취소하세요.');
          results.held += 1;
        } else if (o.status === 'on_hold') {
          orders.systemNote(db, o.id, '스마트스토어 구매자 취소 요청 수신.');
        } else {
          orders.systemNote(db, o.id, '스마트스토어 구매자 취소 요청 수신. 이미 제작 중/출고된 주문이므로 관리자가 네이버에서 거부 또는 승인을 결정해야 합니다.');
        }
      }
      setState(`cursor_${type.toLowerCase()}`, cursor);
    }
    return results;
  }

  async function retryDispatch() {
    const rows = db
      .prepare(
        `SELECT s.product_order_id, o.* FROM smartstore_orders s JOIN orders o ON o.id = s.order_id
         WHERE s.dispatch_synced = 0 AND o.status IN ('shipped','delivered') AND o.tracking_no IS NOT NULL`
      )
      .all();
    let ok = 0;
    for (const o of rows) {
      try { await dispatchOrder(o); ok += 1; } catch { /* 오류는 행에 기록됨 */ }
    }
    return { pending: rows.length, synced: ok };
  }

  async function pull({ reason = 'scheduled' } = {}) {
    if (!enabled()) throw new HttpError(400, '스마트스토어 연동이 설정되지 않았습니다.');
    if (running) throw new HttpError(409, '동기화가 이미 진행 중입니다.');
    running = true;
    const started = Date.now();
    try {
      const paid = await pullPaid();
      const cancels = await pullCancels();
      const dispatch = await retryDispatch();
      const summary = { reason, paid, cancels, dispatch, ms: Date.now() - started };
      log('pull', true, `수집 ${paid.new}건 (자동 등록 ${paid.imported}, 확인 필요 ${paid.review}) · 취소요청 ${cancels.requests}건 · 발송 재전송 ${dispatch.synced}/${dispatch.pending}`, summary);
      setState('last_pull_at', new Date().toISOString());
      setState('last_pull_ok', '1');
      return summary;
    } catch (e) {
      logger.error('[smartstore] pull 실패:', e.message);
      log('pull', false, e.message, { reason });
      setState('last_pull_at', new Date().toISOString());
      setState('last_pull_ok', '0');
      throw e;
    } finally {
      running = false;
    }
  }

  // ---------- 훅 ----------
  async function confirmOrder(order) {
    if (order.source !== 'smartstore' || !order.external_ref || !enabled()) return null;
    const row = getRow(order.external_ref);
    if (row && row.confirmed_at) return null;
    const r = await client.confirm([order.external_ref]);
    const fail = r.fail.find((f) => f.productOrderId === order.external_ref);
    if (fail && !/이미|already/i.test(fail.message || '')) {
      log('confirm', false, `${order.order_no} 발주확인 실패: ${fail.message}`, fail);
      throw new HttpError(502, `네이버 발주확인 실패: ${fail.message || fail.code}`);
    }
    db.prepare("UPDATE smartstore_orders SET confirmed_at = datetime('now','localtime'), place_order_status = 'OK', updated_at = datetime('now','localtime') WHERE product_order_id = ?").run(order.external_ref);
    log('confirm', true, `${order.order_no} 발주확인 완료`);
    return '네이버 발주확인 전송';
  }

  async function dispatchOrder(order) {
    if (order.source !== 'smartstore' || !order.external_ref || !enabled()) return null;
    const pid = order.external_ref;
    const item = { productOrderId: pid, dispatchDate: new Date().toISOString() };
    if (order.tracking_carrier === '직접배송') {
      item.deliveryMethod = 'DIRECT_DELIVERY';
    } else {
      const code = DELIVERY_COMPANY_CODES[order.tracking_carrier];
      if (!code) {
        const msg = `택배사 '${order.tracking_carrier}'의 네이버 코드가 없어 발송처리를 전송하지 못했습니다. 스마트스토어에서 직접 처리하거나 택배사를 수정하세요.`;
        db.prepare("UPDATE smartstore_orders SET dispatch_error = ?, updated_at = datetime('now','localtime') WHERE product_order_id = ?").run(msg, pid);
        log('dispatch', false, `${order.order_no} ${msg}`);
        throw new HttpError(400, msg);
      }
      item.deliveryMethod = 'DELIVERY';
      item.deliveryCompanyCode = code;
      item.trackingNumber = order.tracking_no;
    }
    try {
      const r = await client.dispatch([item]);
      const fail = r.fail.find((f) => f.productOrderId === pid);
      if (fail) throw new Error(fail.message || fail.code);
      db.prepare("UPDATE smartstore_orders SET dispatch_synced = 1, dispatch_error = NULL, naver_status = 'DELIVERING', updated_at = datetime('now','localtime') WHERE product_order_id = ?").run(pid);
      orders.systemNote(db, order.id, `스마트스토어 발송처리 전송 완료 (${order.tracking_carrier} ${order.tracking_no})`);
      log('dispatch', true, `${order.order_no} 발송처리 전송`);
      return true;
    } catch (e) {
      db.prepare("UPDATE smartstore_orders SET dispatch_error = ?, updated_at = datetime('now','localtime') WHERE product_order_id = ?").run(e.message, pid);
      log('dispatch', false, `${order.order_no} 발송처리 실패: ${e.message}`);
      throw e;
    }
  }

  async function approveCancel(pid, user) {
    const row = getRow(pid);
    if (!row) throw new HttpError(404, '스마트스토어 주문을 찾을 수 없습니다.');
    const r = await client.approveCancel(pid);
    const fail = r.fail && r.fail[0];
    if (fail) throw new HttpError(502, `네이버 취소 승인 실패: ${fail.message || fail.code}`);
    db.prepare("UPDATE smartstore_orders SET claim_status = 'CANCEL_DONE', naver_status = 'CANCELED', updated_at = datetime('now','localtime') WHERE product_order_id = ?").run(pid);
    if (row.order_id) {
      const o = orders.getOrderRow(db, row.order_id);
      if (o && ['received', 'on_hold', 'approved'].includes(o.status)) {
        orders.changeStatus(db, user, o.id, { status: 'cancelled', note: '스마트스토어 취소 승인' });
      }
    }
    log('cancel', true, `${pid} 취소 승인`);
    return getRow(pid);
  }

  // ---------- 조회 ----------
  function status() {
    const counts = db.prepare('SELECT import_status, COUNT(*) AS n FROM smartstore_orders GROUP BY import_status').all();
    const c = {};
    for (const r of counts) c[r.import_status] = r.n;
    return {
      enabled: enabled(),
      mode,
      poll_minutes: pollMinutes,
      polling: !!timer,
      running,
      last_pull_at: getState('last_pull_at'),
      last_pull_ok: getState('last_pull_ok') === '1',
      cursor_payed: getState('cursor_payed'),
      counts: {
        imported: c.imported || 0,
        needs_review: c.needs_review || 0,
        ignored: c.ignored || 0,
        cancel_requests: db.prepare("SELECT COUNT(*) AS n FROM smartstore_orders WHERE claim_status = 'CANCEL_REQUEST'").get().n,
        dispatch_errors: db.prepare('SELECT COUNT(*) AS n FROM smartstore_orders WHERE dispatch_error IS NOT NULL AND dispatch_synced = 0').get().n,
      },
    };
  }

  function listRows({ filter } = {}) {
    const where = [];
    if (filter === 'needs_review') where.push("s.import_status = 'needs_review'");
    else if (filter === 'imported') where.push("s.import_status = 'imported'");
    else if (filter === 'cancel') where.push("s.claim_status = 'CANCEL_REQUEST'");
    else if (filter === 'errors') where.push('s.dispatch_error IS NOT NULL AND s.dispatch_synced = 0');
    return db
      .prepare(
        `SELECT s.*, o.order_no, o.status AS order_status FROM smartstore_orders s LEFT JOIN orders o ON o.id = s.order_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.created_at DESC LIMIT 300`
      )
      .all()
      .map((r) => ({
        ...r,
        parsed_spec: JSON.parse(r.parsed_spec || '{}'),
        parse_missing: JSON.parse(r.parse_missing || '[]'),
        shipping_address: JSON.parse(r.raw || '{}').shippingAddress || null,
        raw: undefined,
      }));
  }

  function logs() {
    return db.prepare('SELECT * FROM smartstore_sync_log ORDER BY id DESC LIMIT 50').all();
  }

  function ignore(pid) {
    const row = getRow(pid);
    if (!row) throw new HttpError(404, '스마트스토어 주문을 찾을 수 없습니다.');
    if (row.order_id) throw new HttpError(409, '이미 등록된 주문은 무시할 수 없습니다.');
    db.prepare("UPDATE smartstore_orders SET import_status = 'ignored', updated_at = datetime('now','localtime') WHERE product_order_id = ?").run(pid);
    return getRow(pid);
  }

  function start() {
    if (!enabled() || timer) return;
    timer = setInterval(() => pull().catch(() => {}), pollMinutes * 60 * 1000);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    enabled, pull, status, listRows, logs, tryImport, ignore, confirmOrder, dispatchOrder, approveCancel, getRow, getRowByOrder, start, stop,
  };
}

module.exports = { createSync };
