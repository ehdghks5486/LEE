'use strict';

const FRAME_COLORS = [
  { code: 'white', name: '화이트' },
  { code: 'black', name: '블랙' },
];

const FABRIC_COLORS = [
  { code: 'white', name: '화이트' },
  { code: 'gray', name: '그레이' },
  { code: 'black', name: '블랙' },
];

function toInt(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * Validate a spec and compute a quote.
 * Returns { ok, errors, quote }.
 */
function computeQuote(input, { settings, productTypes, vendor }) {
  const errors = [];
  const widthMm = toInt(input.width_mm);
  const heightMm = toInt(input.height_mm);
  const quantity = input.quantity === undefined ? 1 : toInt(input.quantity);
  const minSize = Number(settings.min_size_mm);
  const maxSize = Number(settings.max_size_mm);

  const type = productTypes.find((t) => t.code === input.product_type && t.active);
  if (!type) errors.push('제품 형태를 선택해 주세요.');

  if (!Number.isInteger(widthMm)) errors.push('가로 치수는 mm 단위 정수로 입력해 주세요.');
  else if (widthMm < minSize || widthMm > maxSize) errors.push(`가로 치수는 ${minSize}~${maxSize}mm 범위여야 합니다.`);

  if (!Number.isInteger(heightMm)) errors.push('세로 치수는 mm 단위 정수로 입력해 주세요.');
  else if (heightMm < minSize || heightMm > maxSize) errors.push(`세로 치수는 ${minSize}~${maxSize}mm 범위여야 합니다.`);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) errors.push('수량은 1~100 사이여야 합니다.');

  if (!FRAME_COLORS.some((c) => c.code === input.frame_color)) errors.push('프레임 색상을 선택해 주세요.');
  if (!FABRIC_COLORS.some((c) => c.code === input.fabric_color)) errors.push('허니콤 원단 색상을 선택해 주세요.');

  if (errors.length) return { ok: false, errors, quote: null };

  const unitPrice =
    vendor && vendor.unit_price_per_sqm != null && vendor.unit_price_per_sqm !== ''
      ? Number(vendor.unit_price_per_sqm)
      : Number(settings.default_unit_price_per_sqm);
  const minArea = Number(settings.min_billable_area_sqm);
  const shippingFee = Number(settings.shipping_fee);
  const factoryCostPerSqm = Number(settings.factory_cost_per_sqm);

  const areaSqm = round4((widthMm * heightMm) / 1_000_000);
  const billedAreaSqm = Math.max(areaSqm, minArea);
  const productAmountEach = Math.round(billedAreaSqm * unitPrice);
  const surchargeEach = Number(type.surcharge) || 0;
  const productAmount = productAmountEach * quantity;
  const surcharge = surchargeEach * quantity;
  const totalAmount = productAmount + surcharge + shippingFee;
  const factoryCost = (Math.round(billedAreaSqm * factoryCostPerSqm) + (Number(type.factory_surcharge) || 0)) * quantity;

  return {
    ok: true,
    errors: [],
    quote: {
      product_type: type.code,
      product_type_name: type.name,
      width_mm: widthMm,
      height_mm: heightMm,
      quantity,
      frame_color: input.frame_color,
      fabric_color: input.fabric_color,
      area_sqm: areaSqm,
      billed_area_sqm: billedAreaSqm,
      min_billable_area_sqm: minArea,
      unit_price: unitPrice,
      product_amount: productAmount,
      surcharge,
      shipping_fee: shippingFee,
      total_amount: totalAmount,
      factory_cost: factoryCost,
    },
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = { computeQuote, FRAME_COLORS, FABRIC_COLORS };
