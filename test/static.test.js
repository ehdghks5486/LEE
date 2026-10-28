'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');

let server;
let baseUrl;
test.before(async () => {
  server = createApp({ dbPath: ':memory:', smartstore: { mode: 'off' }, pushSend: async () => {}, trackingSearch: async () => [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const get = (p) => fetch(baseUrl + p, { redirect: 'manual' });

test('관리자·공장 앱(/)과 업체 앱(/vendor/)은 서로 다른 화면 묶음을 받는다', async () => {
  const root = await (await get('/')).text();
  assert.ok(root.includes('/core.js') && root.includes('/app.js'), '/ 에 core.js + app.js');
  assert.ok(!root.includes('vendor.js'), '/ 에 업체 묶음이 섞임');

  const vendor = await (await get('/vendor/')).text();
  assert.ok(vendor.includes('/core.js') && vendor.includes('/vendor.js'), '/vendor/ 에 core.js + vendor.js');
  assert.ok(!vendor.includes('/app.js'), '/vendor/ 에 관리자·공장 묶음이 섞임');
  assert.ok(vendor.includes('/vendor/manifest.webmanifest'), '업체 앱 매니페스트');

  // 업체 묶음 자체에 관리자·공장 화면 코드가 없다
  const vendorJs = await (await get('/vendor.js')).text();
  for (const s of ['viewStats', 'viewVendors', 'viewUsers', 'viewSettings', 'viewSmartstore', 'factory_cost', 'admin_memo', 'tracking-lookup', '발주 승인 (공장 전달)']) {
    assert.ok(!vendorJs.includes(s), `vendor.js 에 관리자·공장 코드: ${s}`);
  }

  const r = await get('/vendor');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/vendor/');
  // 앱 안 경로는 각자 자기 화면으로
  assert.ok((await (await get('/vendor/orders')).text()).includes('/vendor.js'));
  assert.ok((await (await get('/orders')).text()).includes('/app.js'));
  const m = await (await get('/vendor/manifest.webmanifest')).json();
  assert.equal(m.start_url, '/vendor/');
  assert.equal(m.scope, '/vendor/');
});
