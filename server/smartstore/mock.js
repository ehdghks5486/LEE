'use strict';
/**
 * 네이버 커머스 API 모의 클라이언트.
 * 실제 API와 같은 메서드/응답 형태를 흉내 내어, API 승인 전에도 연동 흐름을 시험할 수 있습니다.
 */
const SAMPLE_OPTIONS = [
  { option: '제품형태: 양개형 / 프레임: 블랙 / 원단: 그레이 / 가로(mm): 1200 / 세로(mm): 1800', memo: '오전 설치 희망' },
  { option: '편개형 / 화이트 프레임 / 화이트 원단', memo: '가로 90cm 세로 150cm' },
  { option: '프리형 / 블랙 프레임 / 블랙 원단', memo: '' }, // 치수 누락 → 확인 필요
];

let seq = 1;

class MockNaverClient {
  constructor() {
    this.mode = 'mock';
    this.orders = new Map(); // productOrderId → { productOrder, order, changes[] }
    this.confirmed = new Set();
    this.dispatched = new Map();
    this.cancelApproved = new Set();
  }

  addSampleOrder(overrides = {}) {
    const n = seq++;
    const sample = SAMPLE_OPTIONS[(n - 1) % SAMPLE_OPTIONS.length];
    const now = new Date();
    const productOrderId = `${now.getFullYear()}${String(n).padStart(10, '0')}`;
    const orderId = overrides.orderId ?? `${now.getFullYear()}${String(n).padStart(8, '0')}`;
    const productAmount = overrides.productAmount ?? 260000;
    const deliveryFee = overrides.deliveryFee ?? 0;
    const entry = {
      productOrder: {
        productOrderId,
        productOrderStatus: 'PAYED',
        placeOrderStatus: 'NOT_YET',
        productName: 'BLACKOUT 허니콤 블라인드 맞춤제작',
        productOption: overrides.option ?? sample.option,
        quantity: overrides.quantity ?? 1,
        unitPrice: productAmount,
        totalPaymentAmount: productAmount + deliveryFee,
        deliveryFeeAmount: deliveryFee,
        shippingMemo: overrides.memo ?? sample.memo,
        shippingAddress: {
          name: overrides.name ?? `고객${n}`,
          tel1: '010-9999-0000',
          zipCode: '06236',
          baseAddress: '서울특별시 강남구 테헤란로 1',
          detailedAddress: `${n}층`,
        },
        claimType: null,
        claimStatus: null,
      },
      order: { orderId, ordererName: overrides.name ?? `고객${n}`, ordererTel: '010-9999-0000', paymentDate: now.toISOString() },
      changes: [{ type: 'PAYED', at: now.toISOString() }],
    };
    this.orders.set(productOrderId, entry);
    return productOrderId;
  }

  requestCancel(productOrderId) {
    const e = this.orders.get(productOrderId);
    if (!e) throw new Error('not found');
    e.productOrder.claimType = 'CANCEL';
    e.productOrder.claimStatus = 'CANCEL_REQUEST';
    e.changes.push({ type: 'CLAIM_REQUESTED', at: new Date().toISOString() });
  }

  /** 구매자 취소가 바로 완료되는 경우(발주확인 전) 또는 반품 등 다른 클레임 */
  completeClaim(productOrderId, claimType = 'CANCEL') {
    const e = this.orders.get(productOrderId);
    if (!e) throw new Error('not found');
    e.productOrder.claimType = claimType;
    e.productOrder.claimStatus = claimType === 'CANCEL' ? 'CANCEL_DONE' : `${claimType}_DONE`;
    if (claimType === 'CANCEL') e.productOrder.productOrderStatus = 'CANCELED';
    e.changes.push({ type: 'CLAIM_COMPLETED', at: new Date().toISOString() });
  }

  async getLastChanged({ from, type }) {
    const fromMs = new Date(from).getTime();
    const out = [];
    for (const e of this.orders.values()) {
      for (const c of e.changes) {
        if (c.type === type && new Date(c.at).getTime() >= fromMs) {
          out.push({
            productOrderId: e.productOrder.productOrderId,
            orderId: e.order.orderId,
            productOrderStatus: e.productOrder.productOrderStatus,
            claimType: e.productOrder.claimType,
            claimStatus: e.productOrder.claimStatus,
            lastChangedType: c.type,
            lastChangedDate: c.at,
            paymentDate: e.order.paymentDate,
          });
        }
      }
    }
    return out;
  }

  async getProductOrders(ids) {
    return ids.filter((id) => this.orders.has(id)).map((id) => {
      const e = this.orders.get(id);
      return { productOrder: { ...e.productOrder }, order: { ...e.order } };
    });
  }

  async confirm(ids) {
    const success = [];
    const fail = [];
    for (const id of ids) {
      const e = this.orders.get(id);
      if (!e) { fail.push({ productOrderId: id, code: 'NOT_FOUND', message: '상품주문을 찾을 수 없습니다.' }); continue; }
      e.productOrder.placeOrderStatus = 'OK';
      this.confirmed.add(id);
      success.push(id);
    }
    return { success, fail };
  }

  async dispatch(items) {
    const success = [];
    const fail = [];
    for (const it of items) {
      const e = this.orders.get(it.productOrderId);
      if (!e) { fail.push({ productOrderId: it.productOrderId, code: 'NOT_FOUND', message: '상품주문을 찾을 수 없습니다.' }); continue; }
      if (!it.trackingNumber && it.deliveryMethod === 'DELIVERY') { fail.push({ productOrderId: it.productOrderId, code: 'INVALID', message: '송장번호 누락' }); continue; }
      e.productOrder.productOrderStatus = 'DELIVERING';
      this.dispatched.set(it.productOrderId, it);
      success.push(it.productOrderId);
    }
    return { success, fail };
  }

  async approveCancel(productOrderId) {
    const e = this.orders.get(productOrderId);
    if (!e) throw new Error('상품주문을 찾을 수 없습니다.');
    e.productOrder.productOrderStatus = 'CANCELED';
    e.productOrder.claimStatus = 'CANCEL_DONE';
    this.cancelApproved.add(productOrderId);
    return { success: [productOrderId], fail: [] };
  }
}

module.exports = { MockNaverClient };
