'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');
const { MockNaverClient } = require('../server/smartstore/mock');
const { parseResults } = require('../server/carriers/daesin');

// 대신택배 「고객정보로 조회하기」 결과 표와 같은 구조의 가짜 화면 (값은 전부 지어낸 것)
const fakePage = (rows) => `<div id="printarea"><table class="depth02 tmar_10"><tr><th>접수일자</th><th>송장번호</th><th>품명</th><th>받는사람</th><th>전화번호</th><th>도착 영업소</th><th>수량</th><th class="th2">운송상태</th></tr>
${rows.map((r) => `<tr><td>${r.at}</td><td><a href="javascript:srpDelail('${r.no}','1234');">${r.no}</a></td><td><a href="javascript:srpDelail('${r.no}','1234');">블라인드</a></td><td>${r.name}</td><td>0101*******</td><td>${r.branch}</td><td>1</td><td class="td2">배송중</td></tr>`).join('\n')}
</table></div>`;

test('대신택배 조회 화면 → 송장 목록', () => {
  const rows = parseResults(fakePage([
    { at: '26.10.27 15:02', no: '4001234567890', name: '김***', branch: '창원' },
    { at: '26.10.27 16:10', no: '4001234567891', name: '이**', branch: '서울강남' },
  ]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { received_at: '26.10.27 15:02', tracking_no: '4001234567890', item: '블라인드', receiver: '김***', branch: '창원', quantity: 1, status: '배송중' });
  assert.deepEqual(parseResults(fakePage([])), []); // 결과 없음: 머리글만
  assert.throws(() => parseResults('<html>점검 중</html>'), /화면 형식/);
});

let server;
let baseUrl;
let mock;
let searchResults = [];
let searchCalls = [];
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
  server = createApp({
    dbPath: ':memory:', smartstore: { client: mock }, trackingDelayMs: 0,
    trackingSearch: async (q) => { searchCalls.push(q); return searchResults; },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function shippedReady(admin, factory, { name = '김고객', phone = '010-1234-5678' } = {}) {
  const vendor = client();
  await vendor('POST', '/api/auth/login', { username: 'vendor', password: 'vendor1234' });
  const created = await vendor('POST', '/api/orders', {
    product_type: 'single', width_mm: 1000, height_mm: 2000, frame_color: 'black', fabric_color: 'gray',
    recipient_name: name, recipient_phone: phone, address: '경남 창원시 성산구 1',
  });
  const id = created.data.order.id;
  await admin('POST', `/api/orders/${id}/status`, { status: 'approved' });
  await factory('POST', `/api/orders/${id}/status`, { status: 'in_production' });
  return id;
}

test('기본 택배사는 대신택배, 13자리 확인', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });
  const meta = await factory('GET', '/api/meta');
  assert.equal(meta.data.default_carrier, '대신택배');

  const id = await shippedReady(admin, factory);
  const short = await factory('POST', `/api/orders/${id}/status`, { status: 'shipped', tracking_carrier: '대신택배', tracking_no: '400-123-45678' });
  assert.equal(short.status, 400);
  assert.match(short.data.error, /13자리.*11자리/);
  const ok = await factory('POST', `/api/orders/${id}/status`, { status: 'shipped', tracking_carrier: '대신택배', tracking_no: '4001-234-567890' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.order.tracking_no, '4001234567890'); // 하이픈 제거

  // 다른 택배사는 송장 없이 출고 불가
  const id2 = await shippedReady(admin, factory);
  assert.equal((await factory('POST', `/api/orders/${id2}/status`, { status: 'shipped', tracking_carrier: 'CJ대한통운' })).status, 400);

  // 기본 택배사 변경 (목록에 없는 값은 거절)
  assert.equal((await admin('PUT', '/api/settings', { settings: { default_carrier: '없는택배' } })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { settings: { default_carrier: '로젠택배' } })).status, 200);
  assert.equal((await factory('GET', '/api/meta')).data.default_carrier, '로젠택배');
  await admin('PUT', '/api/settings', { settings: { default_carrier: '대신택배' } });
});

test('송장 없이 출고 → 대신택배에서 1건 찾으면 자동 등록', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });
  const id = await shippedReady(admin, factory, { name: '박고객', phone: '010-5555-6666' });

  const ship = await factory('POST', `/api/orders/${id}/status`, { status: 'shipped', tracking_carrier: '대신택배', tracking_no: '' });
  assert.equal(ship.status, 200, JSON.stringify(ship.data));
  assert.equal(ship.data.order.tracking_no, null);
  assert.equal((await factory('GET', `/api/orders/${id}`)).data.tracking_lookup.status, 'pending');

  // 아직 접수 전: 그대로 대기
  searchResults = [];
  await server.tracking.runOnce();
  assert.equal(server.tracking.get(id).status, 'pending');

  // 다른 사람(성이 다름)과 이미 쓴 송장은 걸러지고 1건만 남음
  searchCalls = [];
  searchResults = [
    { received_at: '26.10.27 15:02', tracking_no: '4009999999991', receiver: '박**', branch: '창원', status: '배송중' },
    { received_at: '26.10.27 15:03', tracking_no: '4009999999992', receiver: '최**', branch: '창원', status: '배송중' },
    { received_at: '26.10.27 15:04', tracking_no: '4001234567890', receiver: '박**', branch: '창원', status: '배송중' }, // 앞 테스트 주문에 이미 등록된 번호
  ];
  await server.tracking.runOnce();
  assert.ok(searchCalls.some((c) => c.phone === '010-5555-6666'));
  const o = await factory('GET', `/api/orders/${id}`);
  assert.equal(o.data.order.tracking_no, '4009999999991');
  assert.equal(o.data.tracking_lookup.status, 'found');
  const ao = await admin('GET', `/api/orders/${id}`); // 공장에는 관리자 쪽 메모가 가려진다
  assert.ok(ao.data.history.some((h) => (h.note || '').includes('자동 등록')));
});

test('후보가 여러 건이면 골라서 등록, 스마트스토어 주문은 네이버 발송처리까지', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });

  const pid = mock.addSampleOrder({ option: '편개형 / 화이트 프레임 / 화이트 원단 / 가로 1000 / 세로 2000', productAmount: 200000, name: '정고객' });
  await admin('POST', '/api/smartstore/sync', {});
  const row = (await admin('GET', '/api/smartstore/orders')).data.rows.find((r) => r.product_order_id === pid);
  const id = row.order_id;
  await admin('POST', `/api/orders/${id}/status`, { status: 'approved' });
  await factory('POST', `/api/orders/${id}/status`, { status: 'in_production' });
  await factory('POST', `/api/orders/${id}/status`, { status: 'shipped', tracking_carrier: '대신택배' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!mock.dispatched.has(pid), '송장 없이 네이버 발송처리를 보내면 안 됨');

  searchResults = [
    { received_at: '26.10.27 15:02', tracking_no: '4007777777771', receiver: '정**', branch: '창원', status: '배송중' },
    { received_at: '26.10.27 15:05', tracking_no: '4007777777772', receiver: '정**', branch: '창원', status: '배송중' },
  ];
  await server.tracking.runOnce();
  const tl = (await admin('GET', `/api/orders/${id}`)).data.tracking_lookup;
  assert.equal(tl.status, 'multiple');
  assert.equal(tl.candidates.length, 2);

  assert.equal((await factory('POST', `/api/orders/${id}/tracking-lookup`, { action: 'choose', tracking_no: '4000000000000' })).status, 400);
  const pick = await factory('POST', `/api/orders/${id}/tracking-lookup`, { action: 'choose', tracking_no: '4007777777772' });
  assert.equal(pick.status, 200, JSON.stringify(pick.data));
  assert.equal(pick.data.order.tracking_no, '4007777777772');
  await new Promise((r) => setTimeout(r, 30));
  const d = mock.dispatched.get(pid);
  assert.ok(d, '네이버 발송처리 미전송');
  assert.equal(d.deliveryCompanyCode, 'DAESIN');
  assert.equal(d.trackingNumber, '4007777777772');
});

test('직접 입력하면 자동 찾기 중단, 업체에는 자동 찾기 정보 비노출', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });
  const vendor = client();
  await vendor('POST', '/api/auth/login', { username: 'vendor', password: 'vendor1234' });
  const id = await shippedReady(admin, factory, { name: '한고객', phone: '010-2222-3333' });
  await factory('POST', `/api/orders/${id}/status`, { status: 'shipped', tracking_carrier: '대신택배' });
  assert.equal((await vendor('GET', `/api/orders/${id}`)).data.tracking_lookup, undefined);

  const manual = await factory('POST', `/api/orders/${id}/tracking`, { tracking_carrier: '대신택배', tracking_no: '4005555555555' });
  assert.equal(manual.status, 200, JSON.stringify(manual.data));
  assert.equal(server.tracking.get(id).status, 'manual');
  searchCalls = [];
  await server.tracking.runOnce();
  assert.ok(!searchCalls.some((q) => q.phone === '010-2222-3333'), '직접 입력 뒤에도 조회함');
});

test('공장이 출고를 안 눌러도: 승인된 주문 송장을 찾아 두고, 관리자가 승인하면 출고 완료', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });
  const vendor = client();
  await vendor('POST', '/api/auth/login', { username: 'vendor', password: 'vendor1234' });
  const created = await vendor('POST', '/api/orders', {
    product_type: 'single', width_mm: 1000, height_mm: 2000, frame_color: 'black', fabric_color: 'gray',
    recipient_name: '박선발', recipient_phone: '010-2222-3333', address: '경남 창원시 1',
  });
  const id = created.data.order.id;
  await admin('POST', `/api/orders/${id}/status`, { status: 'approved' });

  searchResults = [];
  await server.tracking.runOnce();
  assert.equal(server.tracking.get(id).status, 'pending', '승인된 주문이 조회 줄에 올라가야 함');

  searchResults = [{ received_at: '26.10.29 13:39', tracking_no: '7400000000001', item: '블라인드', receiver: '박**', branch: '망우리', quantity: 1, status: '발송' }];
  await server.tracking.runOnce();
  let d = (await admin('GET', `/api/orders/${id}`)).data;
  assert.equal(d.tracking_lookup.status, 'awaiting');
  assert.equal(d.order.status, 'approved', '승인 전에는 출고로 바꾸지 않음');
  assert.equal(d.order.tracking_no, null);

  assert.equal((await factory('POST', `/api/orders/${id}/tracking-lookup`, { action: 'choose', tracking_no: '7400000000001' })).status, 403);
  const r = await admin('POST', `/api/orders/${id}/tracking-lookup`, { action: 'choose', tracking_no: '7400000000001' });
  assert.equal(r.status, 200);
  assert.equal(r.data.order.status, 'shipped');
  assert.equal(r.data.order.tracking_no, '7400000000001');
  assert.equal(r.data.tracking_lookup.status, 'found');
});
