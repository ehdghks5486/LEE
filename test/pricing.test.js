'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeQuote } = require('../server/pricing');

const settings = {
  default_unit_price_per_sqm: '90000',
  min_billable_area_sqm: '2',
  shipping_fee: '8800',
  factory_cost_per_sqm: '60000',
  min_size_mm: '300',
  max_size_mm: '3000',
};
const productTypes = [
  { code: 'single', name: '편개형', surcharge: 0, factory_surcharge: 0, active: 1 },
  { code: 'double', name: '양개형', surcharge: 20000, factory_surcharge: 10000, active: 1 },
  { code: 'old', name: '단종', surcharge: 0, factory_surcharge: 0, active: 0 },
];
const base = { product_type: 'single', frame_color: 'white', fabric_color: 'gray' };

test('기획안 예시: 2㎡ 기본 제품 180,000 + 택배비 8,800 = 188,800', () => {
  const r = computeQuote({ ...base, width_mm: 1000, height_mm: 2000 }, { settings, productTypes, vendor: null });
  assert.equal(r.ok, true);
  assert.equal(r.quote.area_sqm, 2);
  assert.equal(r.quote.product_amount, 180000);
  assert.equal(r.quote.shipping_fee, 8800);
  assert.equal(r.quote.total_amount, 188800);
});

test('최소 주문면적 2㎡ 미만은 2㎡로 과금', () => {
  const r = computeQuote({ ...base, width_mm: 600, height_mm: 800 }, { settings, productTypes, vendor: null });
  assert.equal(r.quote.area_sqm, 0.48);
  assert.equal(r.quote.billed_area_sqm, 2);
  assert.equal(r.quote.product_amount, 180000);
});

test('2㎡ 초과 시 실제 면적으로 과금 + 유형별 추가금', () => {
  const r = computeQuote({ ...base, product_type: 'double', width_mm: 1200, height_mm: 1800 }, { settings, productTypes, vendor: null });
  assert.equal(r.quote.area_sqm, 2.16);
  assert.equal(r.quote.product_amount, 194400);
  assert.equal(r.quote.surcharge, 20000);
  assert.equal(r.quote.total_amount, 194400 + 20000 + 8800);
  assert.equal(r.quote.factory_cost, Math.round(2.16 * 60000) + 10000);
});

test('업체별 단가가 설정되면 기본 단가 대신 적용', () => {
  const r = computeQuote({ ...base, width_mm: 1000, height_mm: 2000 }, { settings, productTypes, vendor: { unit_price_per_sqm: 85000 } });
  assert.equal(r.quote.unit_price, 85000);
  assert.equal(r.quote.product_amount, 170000);
});

test('수량은 제품금액·추가금에만 곱하고 택배비는 1회', () => {
  const r = computeQuote({ ...base, product_type: 'double', width_mm: 1000, height_mm: 2000, quantity: 3 }, { settings, productTypes, vendor: null });
  assert.equal(r.quote.product_amount, 540000);
  assert.equal(r.quote.surcharge, 60000);
  assert.equal(r.quote.total_amount, 540000 + 60000 + 8800);
});

test('규격 범위·옵션 검증 오류', () => {
  const r = computeQuote({ product_type: 'old', width_mm: 100, height_mm: 5000, frame_color: 'red', fabric_color: 'gray' }, { settings, productTypes, vendor: null });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('제품 형태')));
  assert.ok(r.errors.some((e) => e.includes('가로')));
  assert.ok(r.errors.some((e) => e.includes('세로')));
  assert.ok(r.errors.some((e) => e.includes('프레임')));
});
