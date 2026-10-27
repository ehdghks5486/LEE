'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');
const { MockNaverClient } = require('../server/smartstore/mock');

// 푸시 서비스 대신: 보낸 알림을 모아 두고, 끊긴 기기(endpoint 에 gone)는 410 을 돌려준다
let sent = [];
const fakeSend = async (sub, payload) => {
  if (sub.endpoint.includes('gone')) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
  sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
};
const subFor = (name) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: 'p', auth: 'a' } });
const titlesTo = (who) => sent.filter((s) => s.endpoint.endsWith('/' + who)).map((s) => s.title);
const tick = () => new Promise((r) => setTimeout(r, 30));

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
  server = createApp({ dbPath: ':memory:', smartstore: { client: mock }, trackingDelayMs: 0, pushSend: fakeSend, trackingSearch: async () => [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('알림 구독·시험·해제, 끊긴 기기는 자동 삭제', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const key = await admin('GET', '/api/push/key');
  assert.equal(key.status, 200);
  assert.ok(key.data.key.length > 60);
  assert.equal(key.data.devices, 0);

  assert.equal((await admin('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://insecure' } })).status, 400);
  assert.equal((await admin('POST', '/api/push/subscribe', { subscription: subFor('admin') })).data.devices, 1);
  assert.equal((await admin('POST', '/api/push/subscribe', { subscription: subFor('gone') })).data.devices, 2);

  sent = [];
  const t = await admin('POST', '/api/push/test', {});
  assert.equal(t.data.sent, 1); // gone 은 실패
  assert.deepEqual(titlesTo('admin'), ['BLACKOUT 알림 시험']);
  assert.equal((await admin('GET', '/api/push/key')).data.devices, 1, '410 기기가 지워지지 않음');

  assert.equal((await admin('POST', '/api/push/unsubscribe', { endpoint: subFor('admin').endpoint })).data.devices, 0);
});

test('주문 흐름대로 역할별 알림, 공장 알림엔 가격·업체명 없음', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  const factory = client();
  await factory('POST', '/api/auth/login', { username: 'factory', password: 'factory1234' });
  const vendor = client();
  await vendor('POST', '/api/auth/login', { username: 'vendor', password: 'vendor1234' });
  await admin('POST', '/api/push/subscribe', { subscription: subFor('admin') });
  await factory('POST', '/api/push/subscribe', { subscription: subFor('factory') });
  await vendor('POST', '/api/push/subscribe', { subscription: subFor('vendor') });

  sent = [];
  const created = await vendor('POST', '/api/orders', {
    product_type: 'single', width_mm: 1000, height_mm: 2000, frame_color: 'black', fabric_color: 'gray',
    recipient_name: '김고객', recipient_phone: '010-1234-5678', address: '경남 창원시 1',
  });
  const id = created.data.order.id;
  await tick();
  assert.deepEqual(titlesTo('admin'), ['새 주문 · 데모 시공업체']);
  assert.match(sent[0].body, /188,800원/);
  assert.equal(sent[0].url, `/#/orders/${id}`);
  assert.deepEqual(titlesTo('factory'), []);
  assert.deepEqual(titlesTo('vendor'), []);

  sent = [];
  await admin('POST', `/api/orders/${id}/status`, { status: 'approved' });
  await tick();
  assert.deepEqual(titlesTo('factory'), ['새 제작 주문서']);
  const f = sent.find((s) => s.endpoint.endsWith('/factory'));
  assert.ok(!/원|데모 시공업체/.test(f.title + f.body), '공장 알림에 가격·업체명 노출: ' + f.body);
  assert.deepEqual(titlesTo('vendor'), ['발주 승인']);
  assert.deepEqual(titlesTo('admin'), []);

  sent = [];
  await factory('POST', `/api/orders/${id}/status`, { status: 'in_production' });
  await factory('POST', `/api/orders/${id}/status`, { status: 'shipped', tracking_carrier: '대신택배' });
  await tick();
  assert.deepEqual(titlesTo('vendor'), ['출고되었습니다']);
  assert.match(sent.find((s) => s.endpoint.endsWith('/vendor')).body, /송장번호 등록 중/);

  // 송장 자동 찾기 후보 여러 건 → 관리자·공장에 「송장 확인 필요」
  sent = [];
  server.db.prepare("UPDATE tracking_lookups SET status = 'multiple', candidates = ? WHERE order_id = ?")
    .run(JSON.stringify([{ tracking_no: '4001111111111' }, { tracking_no: '4002222222222' }]), id);
  const pick = await factory('POST', `/api/orders/${id}/tracking-lookup`, { action: 'choose', tracking_no: '4002222222222' });
  assert.equal(pick.status, 200, JSON.stringify(pick.data));
  await tick();
  assert.deepEqual(titlesTo('vendor'), ['송장번호 등록']);
  assert.match(sent.find((s) => s.endpoint.endsWith('/vendor')).body, /4002222222222/);
});

test('스마트스토어 수집·취소 요청은 관리자에게만', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  await admin('POST', '/api/push/subscribe', { subscription: subFor('admin') });
  sent = [];
  const pid = mock.addSampleOrder({ option: '제품형태: 양개형 / 프레임: 블랙 / 원단: 그레이 / 가로(mm): 1200 / 세로(mm): 1800', productAmount: 300000 });
  mock.addSampleOrder({ option: '프리형 / 블랙 프레임 / 블랙 원단', memo: '' });
  await admin('POST', '/api/smartstore/sync', {});
  await tick();
  assert.deepEqual(titlesTo('admin'), ['스마트스토어 새 주문 2건']);
  assert.match(sent[0].body, /자동 등록 1건 · 확인 필요 1건/);
  assert.equal(sent[0].url, '/#/smartstore?filter=needs_review');
  assert.deepEqual(titlesTo('factory'), []);

  sent = [];
  mock.requestCancel(pid);
  await admin('POST', '/api/smartstore/sync', {});
  await tick();
  assert.deepEqual(titlesTo('admin'), ['스마트스토어 취소 요청']);
});
