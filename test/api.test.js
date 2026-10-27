'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');

let server;
let baseUrl;

function client() {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}

test.before(async () => {
  process.env.SEED_DEMO = '1';
  server = createApp({ dbPath: ':memory:' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('전체 주문 흐름: 업체 주문 → 관리자 승인 → 공장 제작·송장 → 배송 완료', async () => {
  const vendor = client();
  const admin = client();
  const factory = client();

  assert.equal((await vendor('POST', '/api/auth/login', { username: 'vendor', password: 'vendor1234' })).status, 200);
  assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' })).status, 200);
  assert.equal((await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' })).status, 200);

  // 견적
  const quote = await vendor('POST', '/api/quote', { product_type: 'single', width_mm: 1000, height_mm: 2000, frame_color: 'black', fabric_color: 'gray' });
  assert.equal(quote.status, 200);
  assert.equal(quote.data.quote.total_amount, 188800);
  assert.equal(quote.data.quote.factory_cost, undefined, '업체에는 제작원가 비노출');

  // 주문 생성
  const created = await vendor('POST', '/api/orders', {
    product_type: 'single', width_mm: 1000, height_mm: 2000, frame_color: 'black', fabric_color: 'gray',
    recipient_name: '김고객', recipient_phone: '010-1234-5678', address: '서울시 강남구 테헤란로 1', address_detail: '101호',
    install_note: '오전 설치 희망',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const order = created.data.order;
  assert.match(order.order_no, /^BO-\d{8}-001$/);
  assert.equal(order.status, 'received');
  assert.equal(order.total_amount, 188800);
  assert.equal(order.factory_cost, undefined);

  // 공장에는 승인 전 주문이 보이지 않음
  assert.equal((await factory('GET', `/api/orders/${order.id}`)).status, 404);
  assert.equal((await factory('GET', '/api/orders')).data.orders.length, 0);

  // 공장은 승인 불가
  assert.equal((await factory('POST', `/api/orders/${order.id}/status`, { status: 'approved' })).status, 404);
  // 업체는 승인 불가
  assert.equal((await vendor('POST', `/api/orders/${order.id}/status`, { status: 'approved' })).status, 409);

  // 업체 규격 수정 (접수 상태) → 금액 재계산 + 이력
  const edited = await vendor('PATCH', `/api/orders/${order.id}`, { width_mm: 1200, height_mm: 1800, note: '현장 실측 반영' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.order.area_sqm, 2.16);
  assert.equal(edited.data.order.total_amount, 194400 + 8800);

  // 관리자 승인 (결제 확인·발주)
  const approved = await admin('POST', `/api/orders/${order.id}/status`, { status: 'approved', note: '입금 확인' });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.order.status, 'approved');

  // 승인 후 업체 수정 불가
  assert.equal((await vendor('PATCH', `/api/orders/${order.id}`, { width_mm: 1300 })).status, 409);

  // 공장 조회: 가격·업체 정보 비노출
  const fo = await factory('GET', `/api/orders/${order.id}`);
  assert.equal(fo.status, 200);
  const f = fo.data.order;
  assert.equal(f.width_mm, 1200);
  assert.equal(f.recipient_name, '김고객');
  for (const k of ['total_amount', 'unit_price', 'product_amount', 'surcharge', 'shipping_fee', 'factory_cost', 'vendor_id', 'vendor_name', 'admin_memo']) {
    assert.equal(f[k], undefined, `공장 응답에 ${k} 노출됨`);
  }
  assert.ok(fo.data.history.every((h) => !JSON.stringify(h).includes('unit_price')), '공장 이력에 가격 변경 노출됨');
  assert.deepEqual(fo.data.allowed_transitions.map((t) => t.code), ['in_production']);

  // 공장 제작 시작 → 송장 없이 출고 시도 → 송장 등록 출고
  assert.equal((await factory('POST', `/api/orders/${order.id}/status`, { status: 'in_production' })).status, 200);
  assert.equal((await factory('POST', `/api/orders/${order.id}/status`, { status: 'shipped' })).status, 400);
  const shipped = await factory('POST', `/api/orders/${order.id}/status`, { status: 'shipped', tracking_carrier: 'CJ대한통운', tracking_no: '123456789012' });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.data));
  assert.equal(shipped.data.order.tracking_no, '123456789012');

  // 업체에 송장 공유 확인 → 배송 완료
  const vo = await vendor('GET', `/api/orders/${order.id}`);
  assert.equal(vo.data.order.tracking_carrier, 'CJ대한통운');
  assert.equal((await vendor('POST', `/api/orders/${order.id}/status`, { status: 'delivered' })).status, 200);

  // 이력 확인
  const ao = await admin('GET', `/api/orders/${order.id}`);
  const events = ao.data.history.map((h) => h.event);
  assert.deepEqual(events, ['created', 'updated', 'status', 'status', 'status', 'status']);
  assert.equal(ao.data.order.factory_cost > 0, true);

  // 관리자 통계
  const st = await admin('GET', '/api/stats');
  assert.equal(st.status, 200);
  assert.equal(st.data.totals.orders, 1);
  assert.equal(st.data.totals.revenue, 194400);
  assert.equal(st.data.totals.margin, 194400 - ao.data.order.factory_cost);
});

test('권한: 공장·업체는 관리자 API 접근 불가, 비로그인 401', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/orders')).status, 401);
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });
  assert.equal((await factory('GET', '/api/vendors')).status, 403);
  assert.equal((await factory('GET', '/api/stats')).status, 403);
  assert.equal((await factory('POST', '/api/orders', {})).status, 403);
  const meta = await factory('GET', '/api/meta');
  assert.equal(meta.data.pricing, undefined);
  assert.equal(meta.data.vendors, undefined);
  assert.equal(meta.data.product_types[0].surcharge, undefined);
});

test('관리자: 업체 생성·단가 설정 → 해당 업체 계정 견적에 반영', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const v = await admin('POST', '/api/vendors', { name: '테스트 시공', unit_price_per_sqm: 85000, phone: '02-000-0000' });
  assert.equal(v.status, 201);
  const u = await admin('POST', '/api/users', { username: 'test_vendor', password: 'pass12345', role: 'vendor', name: '테스트 담당자', vendor_id: v.data.vendor.id });
  assert.equal(u.status, 201, JSON.stringify(u.data));

  const vc = client();
  assert.equal((await vc('POST', '/api/auth/login', { username: 'test_vendor', password: 'pass12345' })).status, 200);
  const q = await vc('POST', '/api/quote', { product_type: 'single', width_mm: 1000, height_mm: 2000, frame_color: 'white', fabric_color: 'white' });
  assert.equal(q.data.quote.unit_price, 85000);
  assert.equal(q.data.quote.total_amount, 170000 + 8800);

  // 업체 비활성화 시 로그인 세션 차단 (계정 비활성화)
  const deact = await admin('PATCH', `/api/users/${u.data.user.id}`, { active: false });
  assert.equal(deact.status, 200);
  assert.equal((await vc('GET', '/api/auth/me')).status, 401);
});

test('관리자: 가격 설정 변경이 견적에 반영되고 잘못된 값은 거부', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const bad = await admin('PUT', '/api/settings', { settings: { shipping_fee: -1 } });
  assert.equal(bad.status, 400);
  const ok = await admin('PUT', '/api/settings', { settings: { shipping_fee: 9900 }, product_types: [{ code: 'free', name: '프리형', surcharge: 35000, factory_surcharge: 15000, sort_order: 3, active: true }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const q = await admin('POST', '/api/quote', { vendor_id: 1, product_type: 'free', width_mm: 1000, height_mm: 2000, frame_color: 'white', fabric_color: 'white' });
  assert.equal(q.data.quote.shipping_fee, 9900);
  assert.equal(q.data.quote.surcharge, 35000);
  // 원복
  await admin('PUT', '/api/settings', { settings: { shipping_fee: 8800 } });
});

test('업체는 다른 업체 주문을 볼 수 없음', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const v2 = await admin('POST', '/api/vendors', { name: '다른 업체' });
  await admin('POST', '/api/users', { username: 'other_vendor', password: 'pass12345', role: 'vendor', name: '다른 담당', vendor_id: v2.data.vendor.id });
  const o = await admin('POST', '/api/orders', {
    vendor_id: v2.data.vendor.id, product_type: 'single', width_mm: 1000, height_mm: 1000, frame_color: 'white', fabric_color: 'white',
    recipient_name: '수령인', recipient_phone: '01000000000', address: '주소',
  });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  const v1 = client();
  await v1('POST', '/api/auth/login', { username: 'vendor', password: 'vendor1234' });
  assert.equal((await v1('GET', `/api/orders/${o.data.order.id}`)).status, 404);
  const list = await v1('GET', '/api/orders');
  assert.ok(list.data.orders.every((x) => x.vendor_id === 1));
});
