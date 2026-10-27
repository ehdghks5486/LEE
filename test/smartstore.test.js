'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');
const { MockNaverClient } = require('../server/smartstore/mock');
const { parseSpec } = require('../server/smartstore/parse');
const { NaverCommerceClient, toNaverTime } = require('../server/smartstore/client');

test('옵션 문자열 → 제작 규격 변환', () => {
  const r = parseSpec('제품형태: 양개형 / 프레임: 블랙 / 원단: 그레이 / 가로(mm): 1200 / 세로(mm): 1800', '');
  assert.deepEqual(r.spec, { product_type: 'double', width_mm: 1200, height_mm: 1800, frame_color: 'black', fabric_color: 'gray' });
  assert.deepEqual(r.missing, []);
  const cm = parseSpec('편개형 / 화이트 프레임 / 화이트 원단', '가로 90cm 세로 150cm');
  assert.equal(cm.spec.width_mm, 900);
  assert.equal(cm.spec.height_mm, 1500);
  const bad = parseSpec('프리형 / 블랙 프레임 / 블랙 원단', '');
  assert.deepEqual(bad.missing, ['가로', '세로']);
});

test('네이버 토큰 서명: bcrypt(client_id_timestamp, secret) base64', () => {
  const c = new NaverCommerceClient({ clientId: 'abc', clientSecret: '$2a$04$abcdefghijklmnopqrstuu' });
  const sig = c.signature(1700000000000);
  const decoded = Buffer.from(sig, 'base64').toString();
  assert.ok(decoded.startsWith('$2a$04$abcdefghijklmnopqrstu'));
  assert.equal(toNaverTime('2026-10-27T00:00:00Z'), '2026-10-27T09:00:00.000+09:00');
});

let server;
let baseUrl;
let mock;
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
}

test.before(async () => {
  mock = new MockNaverClient();
  server = createApp({ dbPath: ':memory:', smartstore: { client: mock } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('스마트스토어 수집 → 자동 등록/확인 필요 → 승인 시 발주확인 → 출고 시 발송처리', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });

  const pidOk = mock.addSampleOrder({ option: '제품형태: 양개형 / 프레임: 블랙 / 원단: 그레이 / 가로(mm): 1200 / 세로(mm): 1800', memo: '오전 설치', productAmount: 300000, deliveryFee: 0 });
  const pidBad = mock.addSampleOrder({ option: '프리형 / 블랙 프레임 / 블랙 원단', memo: '', productAmount: 250000 });

  const st0 = await admin('GET', '/api/smartstore/status');
  assert.equal(st0.data.status.mode, 'mock');

  const sync1 = await admin('POST', '/api/smartstore/sync', {});
  assert.equal(sync1.status, 200, JSON.stringify(sync1.data));
  assert.equal(sync1.data.summary.paid.new, 2);
  assert.equal(sync1.data.summary.paid.imported, 1);
  assert.equal(sync1.data.summary.paid.review, 1);

  // 중복 수집 없음
  const sync2 = await admin('POST', '/api/smartstore/sync', {});
  assert.equal(sync2.data.summary.paid.new, 0);

  const rows = await admin('GET', '/api/smartstore/orders');
  const ok = rows.data.rows.find((r) => r.product_order_id === pidOk);
  const bad = rows.data.rows.find((r) => r.product_order_id === pidBad);
  assert.equal(ok.import_status, 'imported');
  assert.ok(ok.order_no);
  assert.equal(bad.import_status, 'needs_review');
  assert.deepEqual(bad.parse_missing, ['가로', '세로']);

  // 자동 등록된 주문 확인: 금액은 네이버 결제금액, 업체 없음, 공장 비노출 유지
  const o = await admin('GET', `/api/orders/${ok.order_id}`);
  assert.equal(o.data.order.source, 'smartstore');
  assert.equal(o.data.order.external_ref, pidOk);
  assert.equal(o.data.order.total_amount, 300000);
  assert.equal(o.data.order.width_mm, 1200);
  assert.equal(o.data.order.vendor_id, null);
  assert.equal(o.data.smartstore.confirmed_at, null);
  assert.equal((await factory('GET', `/api/orders/${ok.order_id}`)).status, 404);

  // 확인 필요 건: 관리자가 치수 보완 후 등록
  const imp = await admin('POST', `/api/smartstore/orders/${pidBad}/import`, { width_mm: 1000, height_mm: 2000 });
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  assert.equal(imp.data.order.product_type, 'free');
  assert.equal(imp.data.order.total_amount, 250000);
  assert.equal((await admin('POST', `/api/smartstore/orders/${pidBad}/import`, {})).status, 409);

  // 승인 → 네이버 발주확인
  const appr = await admin('POST', `/api/orders/${ok.order_id}/status`, { status: 'approved', note: '입금 확인' });
  assert.equal(appr.status, 200, JSON.stringify(appr.data));
  assert.ok(mock.confirmed.has(pidOk), '발주확인 미전송');
  const o2 = await admin('GET', `/api/orders/${ok.order_id}`);
  assert.ok(o2.data.smartstore.confirmed_at);
  assert.ok(o2.data.history.some((h) => (h.note || '').includes('발주확인')));

  // 공장 제작·출고 → 네이버 발송처리 (택배사 코드 변환)
  assert.equal((await factory('POST', `/api/orders/${ok.order_id}/status`, { status: 'in_production' })).status, 200);
  const ship = await factory('POST', `/api/orders/${ok.order_id}/status`, { status: 'shipped', tracking_carrier: '롯데택배', tracking_no: '987654321098' });
  assert.equal(ship.status, 200, JSON.stringify(ship.data));
  await new Promise((r) => setTimeout(r, 50));
  const d = mock.dispatched.get(pidOk);
  assert.ok(d, '발송처리 미전송');
  assert.equal(d.deliveryCompanyCode, 'HYUNDAI');
  assert.equal(d.trackingNumber, '987654321098');
  const o3 = await admin('GET', `/api/orders/${ok.order_id}`);
  assert.equal(o3.data.smartstore.dispatch_synced, true);

  // 통계: 출처별 분리
  const st = await admin('GET', '/api/stats');
  const src = st.data.by_source.find((s) => s.source === 'smartstore');
  assert.equal(src.orders, 2);
  assert.equal(src.revenue, 550000);
});

test('취소 요청: 제작 전이면 보류, 취소 승인 시 내부 주문 취소', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const pid = mock.addSampleOrder({ option: '편개형 / 화이트 프레임 / 화이트 원단 / 가로 1000 / 세로 2000', productAmount: 200000 });
  await admin('POST', '/api/smartstore/sync', {});
  const row = (await admin('GET', '/api/smartstore/orders')).data.rows.find((r) => r.product_order_id === pid);
  assert.equal(row.import_status, 'imported');

  mock.requestCancel(pid);
  const s = await admin('POST', '/api/smartstore/sync', {});
  assert.equal(s.data.summary.cancels.held, 1);
  const o = await admin('GET', `/api/orders/${row.order_id}`);
  assert.equal(o.data.order.status, 'on_hold');

  const ap = await admin('POST', `/api/smartstore/orders/${pid}/cancel-approve`, {});
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.ok(mock.cancelApproved.has(pid));
  const o2 = await admin('GET', `/api/orders/${row.order_id}`);
  assert.equal(o2.data.order.status, 'cancelled');
});

test('연동 미설정 서버에서는 수집 API가 안내 오류를 반환', async () => {
  const s2 = createApp({ dbPath: ':memory:', smartstore: { mode: 'off' } });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s2.address().port}`;
  const login = await fetch(`${b}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = await fetch(`${b}/api/smartstore/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
  assert.equal(r.status, 400);
  s2.close();
});
