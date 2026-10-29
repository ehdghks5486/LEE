'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');

let server;
let baseUrl;
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
  server = createApp({ dbPath: ':memory:', smartstore: { mode: 'off' }, pushSend: async () => {}, trackingSearch: async () => [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// 이전 앱 문서 모양 그대로 (값은 지어낸 것)
const entries = [
  { id: 'a1', date: '2026-10-19', channel: '온라인', paid: true, name: '김가상', phone: '010-0000-1111', addr: '창원시 1', w: 238, h: 118, frame: '블랙', fabric: '블랙', type: '편개형', kind: '암막', price: 330600, cost: 222400, ship: 9680, fee: 0, memo: '' },
  { id: 'a2', date: '2026-10-02', channel: '업체', paid: false, name: '(주)가상건설', w: 147, h: 137, frame: '화이트', fabric: '화이트', type: '양개형', kind: '프리', price: 180000, cost: 158400, ship: 0, fee: 0, memo: '후불' },
  { id: 'a3', date: '2026-09-15', channel: '업체', paid: true, name: '가상인테리어', w: 100.5, h: 200, price: 176000, cost: 154000, ship: 0 },
  { id: 'bad', channel: '온라인' }, // 날짜 없음 → 건너뜀
];
const sendImport = (key, body) => fetch(`${baseUrl}/api/ledger/import?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body });

test('이전 앱에서 일회용 키로 옮기기 → 장부 조회·합계·입금 토글', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });

  assert.equal((await sendImport('nope', JSON.stringify({ entries }))).status, 403);
  assert.equal((await factory('POST', '/api/ledger/import-key', {})).status, 403);
  const { key } = (await admin('POST', '/api/ledger/import-key', {})).data;
  const r = await sendImport(key, JSON.stringify({ entries }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).imported, 3);
  assert.equal((await sendImport(key, JSON.stringify({ entries }))).status, 403, '키를 두 번 쓸 수 있음');

  // 다시 옮겨도 중복 없음
  const k2 = (await admin('POST', '/api/ledger/import-key', {})).data.key;
  await sendImport(k2, JSON.stringify({ entries }));

  const all = (await admin('GET', '/api/ledger?month=all')).data;
  assert.equal(all.totals.count, 3);
  assert.deepEqual(all.months, ['2026-10', '2026-09']);
  assert.equal(all.totals.sales, 330600 + 180000 + 176000);
  assert.equal(all.totals.profit, (330600 - 222400 - 9680) + (180000 - 158400) + (176000 - 154000));
  assert.equal(all.totals.unpaid_count, 1);
  assert.equal(all.rows[0].id, 'a1'); // 최근 날짜부터
  assert.equal(all.rows.find((e) => e.id === 'a3').width_cm, 100.5);

  const oct = (await admin('GET', '/api/ledger')).data; // 기본: 가장 최근 달
  assert.equal(oct.month, '2026-10');
  assert.equal(oct.rows.length, 2);
  assert.equal((await admin('GET', '/api/ledger?month=all&unpaid=1')).data.rows.length, 1);

  assert.equal((await admin('PATCH', '/api/ledger/a2', { paid: true })).status, 200);
  assert.equal((await admin('GET', '/api/ledger?month=all')).data.totals.unpaid_count, 0);

  // 관리자 외에는 장부 접근 불가
  assert.equal((await factory('GET', '/api/ledger')).status, 403);
  assert.equal((await factory('PATCH', '/api/ledger/a2', { paid: false })).status, 403);
  // 다른 API 는 여전히 JSON 만 받는다
  const plain = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 415);
});

test('장부에 새 앱 주문도 함께 (취소 제외, 입금은 승인 여부)', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const vendor = client();
  await vendor('POST', '/api/auth/login', { username: 'vendor', password: 'vendor1234' });
  const mk = () => vendor('POST', '/api/orders', {
    product_type: 'free', width_mm: 1470, height_mm: 1370, frame_color: 'white', fabric_color: 'gray',
    recipient_name: '최가상', recipient_phone: '010-3333-4444', address: '경남 창원시 1',
  });
  const a = (await mk()).data.order;
  const b = (await mk()).data.order;
  await admin('POST', `/api/orders/${b.id}/status`, { status: 'cancelled' });

  const all = (await admin('GET', '/api/ledger?month=all')).data;
  const row = all.rows.find((r) => r.order_id === a.id);
  assert.ok(row);
  assert.equal(all.rows.some((r) => r.order_id === b.id), false, '취소 주문은 빠져야 함');
  assert.equal(row.channel, '업체');
  assert.equal(row.width_cm, 147);
  assert.equal(row.fabric, '그레이');
  assert.equal(row.kind, '프리');
  assert.equal(row.paid, false);
  assert.equal(row.profit, row.price - row.cost);
  assert.equal(all.totals.count, 4);

  await admin('POST', `/api/orders/${a.id}/status`, { status: 'approved' });
  assert.equal((await admin('GET', '/api/ledger?month=all')).data.rows.find((r) => r.order_id === a.id).paid, true);
});
