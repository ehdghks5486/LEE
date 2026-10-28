'use strict';
/**
 * 역할 분리 전수 검사: 업체·공장 계정이 받을 수 있는 모든 응답을 뒤져서
 * 다른 역할의 정보(관리자 메모, 제작원가, 다른 업체 이름·주문, 가격)가 한 글자도 섞이지 않는지 확인한다.
 * 화면이 아니라 서버 응답을 검사하므로, 업체 앱을 따로 만들어도 이 보장이 그대로 간다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');
const { MockNaverClient } = require('../server/smartstore/mock');

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
  server = createApp({ dbPath: ':memory:', smartstore: { client: mock }, trackingDelayMs: 0, pushSend: async () => {}, trackingSearch: async () => [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

/** 응답 JSON 전체를 훑어 금지된 키·문자열을 찾는다 */
function scan(obj, { keys, strings }, path = '') {
  const found = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (keys.test(k) && x !== null && x !== undefined) found.push(`${p}.${k}`); // 빈 값은 새는 게 없다
        walk(x, `${p}.${k}`);
      }
    } else if (typeof v === 'string') {
      for (const s of strings) if (s && v.includes(s)) found.push(`${p} 에 "${s}"`);
    }
  };
  walk(obj, path);
  return found;
}

const SECRET_MEMO = '관리자메모_비밀_7781';
const OTHER_VENDOR = '다른업체_비밀_9920';

test('업체·공장이 받는 모든 응답에 다른 역할의 정보가 없다', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });
  const vendorA = client();
  await vendorA('POST', '/api/auth/login', { username: 'vendor', password: 'vendor1234' });

  // 다른 업체 B 와 그 계정
  const vb = await admin('POST', '/api/vendors', { name: OTHER_VENDOR, unit_price_per_sqm: 88000 });
  assert.equal(vb.status, 201, JSON.stringify(vb.data));
  await admin('POST', '/api/users', { username: 'vendorb', password: 'vendorb1234', role: 'vendor', name: 'B담당', vendor_id: vb.data.vendor.id });
  const vendorB = client();
  await vendorB('POST', '/api/auth/login', { username: 'vendorb', password: 'vendorb1234' });

  const spec = { product_type: 'double', width_mm: 1200, height_mm: 1800, frame_color: 'black', fabric_color: 'gray', recipient_name: '김고객', recipient_phone: '010-1111-2222', address: '경남 창원시 1' };
  const oa = (await vendorA('POST', '/api/orders', spec)).data.order;
  const ob = (await vendorB('POST', '/api/orders', { ...spec, recipient_name: '이고객' })).data.order;
  await admin('PATCH', `/api/orders/${oa.id}`, { admin_memo: SECRET_MEMO });
  await admin('PATCH', `/api/orders/${ob.id}`, { admin_memo: SECRET_MEMO });
  await admin('POST', `/api/orders/${oa.id}/status`, { status: 'approved', note: '입금 확인' });
  await admin('POST', `/api/orders/${ob.id}/status`, { status: 'approved' });
  // 승인 뒤 관리자가 규격을 고치면 금액·원가 변경이 이력에 남는다 → 공장·업체 이력에서 가격이 새는지 본다
  await admin('PATCH', `/api/orders/${oa.id}`, { width_mm: 1300, note: '실측 반영' });
  await factory('POST', `/api/orders/${oa.id}/status`, { status: 'in_production' });
  await factory('POST', `/api/orders/${oa.id}/status`, { status: 'shipped', tracking_carrier: '대신택배' });
  // 스마트스토어 주문 하나 (공장에 결제금액·주문자가 새는지)
  mock.addSampleOrder({ option: '제품형태: 양개형 / 프레임: 블랙 / 원단: 그레이 / 가로(mm): 1200 / 세로(mm): 1800', productAmount: 333000, name: '네이버주문자_비밀' });
  await admin('POST', '/api/smartstore/sync', {});
  const ss = (await admin('GET', '/api/orders?status=received')).data.orders.find((o) => o.source === 'smartstore');
  await admin('POST', `/api/orders/${ss.id}/status`, { status: 'approved' });

  const adminView = (await admin('GET', `/api/orders/${oa.id}`)).data.order;
  const factoryCost = String(adminView.factory_cost);

  // ----- 업체 A -----
  const vendorRules = { keys: /factory_cost|admin_memo|created_by|naver|orderer|tracking_lookup/i, strings: [SECRET_MEMO, OTHER_VENDOR, factoryCost, '네이버주문자_비밀'] };
  const vendorGets = ['/api/auth/me', '/api/meta', '/api/push/key', '/api/orders', '/api/orders?status=', `/api/orders/${oa.id}`, `/api/orders?q=${encodeURIComponent('이고객')}`];
  for (const p of vendorGets) {
    const r = await vendorA('GET', p);
    assert.equal(r.status, 200, `${p} → ${r.status}`);
    assert.deepEqual(scan(r.data, vendorRules, p), [], `업체 응답에 새는 정보: ${p}`);
  }
  // 다른 업체 주문·스마트스토어 주문은 아예 없는 것처럼
  assert.equal((await vendorA('GET', `/api/orders/${ob.id}`)).status, 404);
  assert.equal((await vendorA('GET', `/api/orders/${ss.id}`)).status, 404);
  assert.equal((await vendorA('PATCH', `/api/orders/${ob.id}`, { width_mm: 999 })).status, 404);
  assert.equal((await vendorA('POST', `/api/orders/${ob.id}/status`, { status: 'cancelled', note: 'x' })).status, 404);
  const listA = (await vendorA('GET', '/api/orders')).data.orders;
  assert.ok(listA.every((o) => o.vendor_id === oa.vendor_id), '업체 목록에 남의 주문이 섞임');
  // 관리자·공장 전용 API 는 전부 막힘
  for (const p of ['/api/vendors', '/api/users', '/api/settings', '/api/stats', '/api/smartstore/status', '/api/smartstore/orders']) {
    assert.equal((await vendorA('GET', p)).status, 403, `업체가 ${p} 에 접근 가능`);
  }
  for (const [m, p] of [['POST', `/api/orders/${oa.id}/tracking`], ['POST', `/api/orders/${oa.id}/tracking-lookup`], ['PUT', '/api/settings'], ['POST', '/api/vendors'], ['POST', '/api/users'], ['POST', '/api/smartstore/sync']]) {
    assert.equal((await vendorA(m, p, {})).status, 403, `업체가 ${m} ${p} 가능`);
  }

  // ----- 공장 -----
  const factoryRules = { keys: /price|amount|surcharge|fee|cost|memo|vendor|naver|orderer|pricing|external_ref/i, strings: [SECRET_MEMO, OTHER_VENDOR, '데모 시공업체', factoryCost, String(adminView.total_amount), '스마트스토어 주문자', '333000', '333,000'] }; // 수령인 이름은 송장에 필요하니 허용
  const factoryGets = ['/api/auth/me', '/api/meta', '/api/push/key', '/api/orders', '/api/orders?status=shipped', `/api/orders/${oa.id}`, `/api/orders/${ob.id}`, `/api/orders/${ss.id}`, `/api/orders?q=${encodeURIComponent(OTHER_VENDOR)}`];
  for (const p of factoryGets) {
    const r = await factory('GET', p);
    assert.equal(r.status, 200, `${p} → ${r.status}`);
    assert.deepEqual(scan(r.data, factoryRules, p), [], `공장 응답에 새는 정보: ${p}`);
  }
  // 승인 전 주문은 공장에 없는 것처럼
  const oc = (await vendorA('POST', '/api/orders', spec)).data.order;
  assert.equal((await factory('GET', `/api/orders/${oc.id}`)).status, 404);
  assert.ok(!(await factory('GET', '/api/orders?status=')).data.orders.some((o) => o.id === oc.id));
  for (const p of ['/api/vendors', '/api/users', '/api/settings', '/api/stats', '/api/smartstore/status', '/api/smartstore/orders']) {
    assert.equal((await factory('GET', p)).status, 403, `공장이 ${p} 에 접근 가능`);
  }
  assert.equal((await factory('POST', '/api/orders', spec)).status, 403);
  assert.equal((await factory('POST', `/api/orders/${ob.id}/status`, { status: 'approved' })).status, 409);
});
