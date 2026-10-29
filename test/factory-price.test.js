'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeQuote } = require('../server/pricing');

// 이전 블랙아웃 앱 규칙: 1㎡ 미만 고정가, 0.1㎡ 반올림, 최소 2㎡, 100원 단위
const settings = {
  min_size_mm: 300, max_size_mm: 3000, default_unit_price_per_sqm: 90000, min_billable_area_sqm: 2, shipping_fee: 8800,
  factory_cost_per_sqm: 79200, factory_small_area_sqm: 1, factory_small_price: 110000, factory_area_step_sqm: 0.1,
};
const productTypes = [
  { code: 'single', name: '편개형', surcharge: 0, factory_surcharge: 0, active: 1 },
  { code: 'free', name: '프리형', surcharge: 50000, factory_surcharge: 44000, active: 1 },
];
const cost = (w, h, type = 'single', quantity = 1) =>
  computeQuote({ product_type: type, width_mm: w, height_mm: h, frame_color: 'white', fabric_color: 'white', quantity }, { settings, productTypes, vendor: null }).quote.factory_cost;

test('공장가: 이전 앱과 같은 규칙', () => {
  assert.equal(cost(900, 1000), 110000); // 0.9㎡ → 고정가
  assert.equal(cost(1000, 1000), 158400); // 1㎡ → 최소 2㎡
  assert.equal(cost(2380, 1180), 221800); // 2.8084 → 2.8㎡ × 79,200 = 221,760 → 100원 단위
  assert.equal(cost(2380, 1180, 'free'), 265800); // + 프리 44,000
  assert.equal(cost(900, 1000, 'single', 2), 220000);
});
