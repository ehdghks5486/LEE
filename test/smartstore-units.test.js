'use strict';
/**
 * 실제로 들어온 주문(10-28) 그대로: 이 스토어는 0.1㎡ 단위로 팔아서 2.38×1.18m 한 장이 「수량 28」로 오고,
 * 면적 올림분(0.1㎡ = 11,400원)은 같은 네이버 주문의 「맞춤제작 추가금액」 상품으로 따로 온다.
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

const REAL_OPTION = '최종제작 사이즈 / 예(가로cm x 세로cm): 238*118 / 프레임 색상: 블랙 / 원단 색상: 블랙 / 개폐 방식: 편개형';
const ADDON_OPTION = '맞춤제작 추가금액: 상세페이지 견적 계산기 확인해 주세요!';
const rowOf = async (admin, pid) => (await admin('GET', '/api/smartstore/orders?filter=')).data.rows.find((r) => r.product_order_id === pid);

test('수량 28(0.1㎡ 단위) = 블라인드 1장, 같은 주문의 추가금액 상품은 합산 → 발주확인·발송처리도 함께', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });

  const pid = mock.addSampleOrder({ orderId: 'N-REAL-1', option: REAL_OPTION, memo: '문 앞에 놓아주세요', quantity: 28, productAmount: 316200 });
  const addon = mock.addSampleOrder({ orderId: 'N-REAL-1', option: ADDON_OPTION, memo: '문 앞에 놓아주세요', quantity: 1, productAmount: 11400 });
  const s = await admin('POST', '/api/smartstore/sync', {});
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.summary.paid.imported, 1);
  assert.equal(s.data.summary.paid.review, 0, '추가금액 상품이 「확인 필요」로 남음');
  assert.equal(s.data.summary.paid.merged, 1);

  const main = await rowOf(admin, pid);
  const o = (await admin('GET', `/api/orders/${main.order_id}`)).data;
  assert.equal(o.order.quantity, 1, `블라인드 ${o.order.quantity}장으로 들어감`);
  assert.equal(o.order.width_mm, 2380);
  assert.equal(o.order.height_mm, 1180);
  assert.equal(o.order.total_amount, 316200 + 11400, '추가금액이 매출에 합산되지 않음');
  assert.ok(o.order.factory_cost < 300000, `제작원가가 ${o.order.factory_cost}원 (장수 오류)`);
  assert.ok(o.history.some((h) => (h.note || '').includes('추가상품')));
  assert.equal(o.smartstore.product_order_id, pid, '주문 화면이 추가상품 행을 잡음');
  assert.equal((await rowOf(admin, addon)).import_status, 'merged');
  assert.equal((await admin('GET', '/api/smartstore/status')).data.status.counts.needs_review, 0);
  // 공장 화면도 1장
  await admin('POST', `/api/orders/${main.order_id}/status`, { status: 'approved' });
  assert.equal((await factory('GET', `/api/orders/${main.order_id}`)).data.order.quantity, 1);

  // 승인 → 두 상품주문 모두 발주확인, 출고 → 두 상품주문 모두 발송처리
  assert.ok(mock.confirmed.has(pid) && mock.confirmed.has(addon), '추가상품 발주확인 누락');
  await factory('POST', `/api/orders/${main.order_id}/status`, { status: 'in_production' });
  await factory('POST', `/api/orders/${main.order_id}/status`, { status: 'shipped', tracking_carrier: '대신택배', tracking_no: '4001234567890' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.dispatched.get(pid)?.trackingNumber, '4001234567890');
  assert.equal(mock.dispatched.get(addon)?.trackingNumber, '4001234567890', '추가상품 발송처리 누락');
});

test('같은 크기 2장이면 수량 58 → 2장, 설정 0이면 네이버 수량 그대로', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const two = mock.addSampleOrder({ option: REAL_OPTION, quantity: 58, productAmount: 661200 });
  await admin('POST', '/api/smartstore/sync', {});
  const o2 = (await admin('GET', `/api/orders/${(await rowOf(admin, two)).order_id}`)).data.order;
  assert.equal(o2.quantity, 2);

  // 1㎡ 미만 작은 블라인드는 최소 2㎡(20단위)로 팔림
  const small = mock.addSampleOrder({ option: '편개형 / 블랙 프레임 / 블랙 원단 / 가로 60cm 세로 90cm', quantity: 20, productAmount: 228000 });
  await admin('POST', '/api/smartstore/sync', {});
  assert.equal((await admin('GET', `/api/orders/${(await rowOf(admin, small)).order_id}`)).data.order.quantity, 1);

  assert.equal((await admin('PUT', '/api/settings', { settings: { smartstore_qty_unit_sqm: 0 } })).status, 200);
  const pieces = mock.addSampleOrder({ option: REAL_OPTION, quantity: 3, productAmount: 900000 });
  await admin('POST', '/api/smartstore/sync', {});
  assert.equal((await admin('GET', `/api/orders/${(await rowOf(admin, pieces)).order_id}`)).data.order.quantity, 3);
});

test('이미 잘못 들어온 주문(수량 28장)은 다음 동기화 때 1장으로 바로잡힘', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  // 예전 동작 재현: 단위 0 으로 받아 28장이 된 주문
  await admin('PUT', '/api/settings', { settings: { smartstore_qty_unit_sqm: 0 } });
  const pid = mock.addSampleOrder({ option: REAL_OPTION, quantity: 28, productAmount: 316200 });
  await admin('POST', '/api/smartstore/sync', {});
  const id = (await rowOf(admin, pid)).order_id;
  assert.equal((await admin('GET', `/api/orders/${id}`)).data.order.quantity, 28);
  const before = (await admin('GET', `/api/orders/${id}`)).data.order;

  await admin('PUT', '/api/settings', { settings: { smartstore_qty_unit_sqm: 0.1 } });
  await admin('POST', '/api/smartstore/sync', {});
  const after = (await admin('GET', `/api/orders/${id}`)).data;
  assert.equal(after.order.quantity, 1);
  assert.equal(after.order.total_amount, before.total_amount, '결제금액이 바뀌면 안 됨');
  assert.ok(after.order.factory_cost < before.factory_cost / 10);
  assert.ok(after.history.some((h) => (h.note || '').includes('수량 바로잡음')));
});
