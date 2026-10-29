'use strict';
/**
 * 송장 자동 찾기: 송장 없이 출고된 대신택배 주문을 받는 분 전화번호로 대신택배에 조회해 송장번호를 채운다.
 * - 후보가 1건이면 자동 등록(스마트스토어 주문은 onFound 로 네이버 발송처리까지)
 * - 여러 건이면 후보를 남겨 관리자·공장이 고른다
 * - giveUpDays 안에 못 찾으면 not_found → 직접 입력
 * 공장이 앱에서 출고를 누르지 않아도: 승인·제작중 주문을 승인일부터 조회해, 찾으면 awaiting 으로 남기고
 * 관리자에게 알린다. 관리자가 승인하면 출고 완료 + 송장 등록(→ 네이버 발송처리).
 */
const orders = require('./orders');
const { HttpError } = orders;

const DAY = 24 * 60 * 60 * 1000;
const PRE_SHIP = ['approved', 'in_production'];
const toMs = (s) => Date.parse(String(s).replace(' ', 'T'));
const kstDate = (ms) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

function createTrackingLookup({ db, search, onFound = () => {}, onAttention = () => {}, onAwaiting = () => {}, intervalMinutes = 30, giveUpDays = 3, preShipGiveUpDays = 21, delayMs = 1500, logger = console, now = () => Date.now() }) {
  let timer = null;
  let running = false;

  const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;

  function get(orderId) {
    const r = db.prepare('SELECT * FROM tracking_lookups WHERE order_id = ?').get(orderId);
    return r ? { ...r, candidates: JSON.parse(r.candidates || '[]') } : null;
  }
  function setRow(orderId, fields) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE tracking_lookups SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now','localtime') WHERE order_id = ?`)
      .run(...keys.map((k) => fields[k]), orderId);
  }

  function request(order) {
    db.prepare(
      `INSERT INTO tracking_lookups (order_id, status) VALUES (?, 'pending')
       ON CONFLICT(order_id) DO UPDATE SET status = 'pending', candidates = NULL, last_error = NULL, updated_at = datetime('now','localtime')`
    ).run(order.id);
  }

  function apply(order, trackingNo, note) {
    const updated = orders.systemSetTracking(db, order.id, trackingNo, note);
    setRow(order.id, { status: 'found' });
    if (updated && updated.tracking_no) onFound(updated);
    return updated;
  }

  /** 공장이 출고를 누르기 전: 찾아도 바로 등록하지 않고 관리자 승인을 기다린다 */
  async function lookupPreShip(order, row) {
    const sinceMs = order.approved_at ? toMs(order.approved_at) : now();
    try {
      const cands = await findCandidates(order, sinceMs);
      const base = { attempts: row.attempts + 1, last_tried_at: new Date(now()).toISOString(), last_error: null };
      if (cands.length) {
        setRow(order.id, { ...base, status: 'awaiting', candidates: JSON.stringify(cands) });
        const list = cands.map((c) => `${c.tracking_no} (${c.received_at} 접수, ${c.branch || '영업소 미상'})`).join(', ');
        orders.systemNote(db, order.id, `대신택배에서 송장을 찾았습니다: ${list}. 맞으면 승인해 주세요 → 출고 완료로 바뀝니다.`);
        onAwaiting(order, cands);
      } else if (now() - sinceMs > preShipGiveUpDays * DAY) {
        setRow(order.id, { ...base, status: 'manual' });
      } else {
        setRow(order.id, base);
      }
    } catch (e) {
      logger.error('[tracking-lookup]', order.order_no, e.message);
      setRow(order.id, { attempts: row.attempts + 1, last_tried_at: new Date(now()).toISOString(), last_error: e.message });
    }
    return get(order.id);
  }

  async function findCandidates(order, sinceMs) {
    // 서버 시간대와 대신택배(한국 시간) 차이를 넉넉히 덮도록 전날부터 조회
    const results = await search({ phone: order.recipient_phone, from: kstDate(sinceMs - DAY), to: kstDate(now()) });
    const used = new Set(db.prepare('SELECT tracking_no FROM orders WHERE tracking_no IS NOT NULL').all().map((r) => r.tracking_no));
    const cands = results.filter((r) => !used.has(r.tracking_no));
    // 대신택배는 받는 사람을 「이***」로 가려 준다: 성(첫 글자)이 같은 것만 남기되, 하나도 없으면 전부 둔다
    const first = String(order.recipient_name || '').trim()[0];
    const sameName = first ? cands.filter((r) => String(r.receiver || '').startsWith(first)) : [];
    return sameName.length ? sameName : cands;
  }

  async function lookupOne(orderId) {
    const order = orders.getOrderRow(db, orderId);
    if (order && !order.tracking_no && PRE_SHIP.includes(order.status)) return lookupPreShip(order, get(orderId));
    if (!order || order.tracking_no || !['shipped', 'delivered'].includes(order.status)) {
      setRow(orderId, { status: order && order.tracking_no ? 'found' : 'manual' });
      return get(orderId);
    }
    const shippedMs = order.shipped_at ? Date.parse(order.shipped_at.replace(' ', 'T')) : now();
    const row = get(orderId);
    try {
      const cands = await findCandidates(order, shippedMs);

      const base = { attempts: row.attempts + 1, last_tried_at: new Date(now()).toISOString(), last_error: null };
      if (cands.length === 1) {
        setRow(orderId, { ...base, candidates: JSON.stringify(cands) });
        apply(order, cands[0].tracking_no, `대신택배 조회로 송장번호 자동 등록 (${cands[0].received_at} 접수, ${cands[0].branch || '영업소 미상'})`);
      } else if (cands.length > 1) {
        setRow(orderId, { ...base, status: 'multiple', candidates: JSON.stringify(cands) });
        orders.systemNote(db, orderId, `대신택배에서 송장 후보 ${cands.length}건을 찾았습니다. 주문 화면에서 맞는 송장을 골라 주세요.`);
        onAttention(order, 'multiple', cands.length);
      } else if (now() - shippedMs > giveUpDays * DAY) {
        setRow(orderId, { ...base, status: 'not_found' });
        orders.systemNote(db, orderId, `출고 후 ${giveUpDays}일 동안 대신택배에서 송장을 찾지 못했습니다. 송장번호를 직접 입력해 주세요.`);
        onAttention(order, 'not_found');
      } else {
        setRow(orderId, base);
      }
    } catch (e) {
      logger.error('[tracking-lookup]', order.order_no, e.message);
      const giveUp = now() - shippedMs > giveUpDays * DAY;
      setRow(orderId, { attempts: row.attempts + 1, last_tried_at: new Date(now()).toISOString(), last_error: e.message, ...(giveUp ? { status: 'not_found' } : {}) });
    }
    return get(orderId);
  }

  async function runOnce() {
    if (running) return { checked: 0 };
    running = true;
    try {
      // 승인·제작중인데 아직 조회 줄에 없는 주문을 올린다 (기본 택배사가 대신택배일 때만)
      if (getSetting('default_carrier') === orders.AUTO_LOOKUP_CARRIER) {
        db.prepare(
          `INSERT INTO tracking_lookups (order_id, status)
           SELECT id, 'pending' FROM orders WHERE status IN ('approved', 'in_production') AND tracking_no IS NULL
             AND id NOT IN (SELECT order_id FROM tracking_lookups)`
        ).run();
      }
      const ids = db.prepare("SELECT order_id FROM tracking_lookups WHERE status = 'pending' ORDER BY order_id").all().map((r) => r.order_id);
      for (let i = 0; i < ids.length; i++) {
        if (i && delayMs) await new Promise((r) => setTimeout(r, delayMs)); // 대신택배에 몰아서 조회하지 않기
        await lookupOne(ids[i]);
      }
      return { checked: ids.length };
    } finally {
      running = false;
    }
  }

  /** 관리자·공장: 지금 다시 찾기 */
  async function retry(orderId) {
    const order = orders.getOrderRow(db, orderId);
    if (!order) throw new HttpError(404, '주문을 찾을 수 없습니다.');
    if (order.tracking_no) throw new HttpError(409, '이미 송장번호가 등록된 주문입니다.');
    if (!PRE_SHIP.includes(order.status) && order.tracking_carrier !== orders.AUTO_LOOKUP_CARRIER) throw new HttpError(400, `${orders.AUTO_LOOKUP_CARRIER} 주문만 자동으로 찾을 수 있습니다.`);
    request(order);
    return lookupOne(orderId);
  }

  /** 관리자·공장: 후보 중 하나 고르기 */
  function choose(orderId, trackingNo, user) {
    const row = get(orderId);
    if (!row || !row.candidates.some((c) => c.tracking_no === trackingNo)) throw new HttpError(400, '후보에 없는 송장번호입니다.');
    const order = orders.getOrderRow(db, orderId);
    if (!order || order.tracking_no) throw new HttpError(409, '이미 송장번호가 등록된 주문입니다.');
    if (PRE_SHIP.includes(order.status)) {
      // 관리자 승인 → 출고 완료 + 송장 등록 (출고 훅이 네이버 발송처리를 보낸다)
      if (user.role !== 'admin') throw new HttpError(403, '출고 전 주문의 송장 승인은 관리자만 할 수 있습니다.');
      const updated = orders.changeStatus(db, user, orderId, {
        status: 'shipped', tracking_carrier: orders.AUTO_LOOKUP_CARRIER, tracking_no: trackingNo,
        note: `대신택배 조회로 찾은 송장 승인 → 출고 완료 (${user.name})`,
      });
      setRow(orderId, { status: 'found' });
      return updated;
    }
    return apply(order, trackingNo, `대신택배 송장 후보 중 선택 (${user.name})`);
  }

  /** 직접 입력으로 송장이 들어오면 자동 찾기를 멈춘다 */
  function markManual(orderId) {
    if (get(orderId)) setRow(orderId, { status: 'manual' });
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => runOnce().catch((e) => logger.error('[tracking-lookup]', e.message)), intervalMinutes * 60 * 1000);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { get, request, runOnce, lookupOne, retry, choose, markManual, start, stop };
}

module.exports = { createTrackingLookup };
