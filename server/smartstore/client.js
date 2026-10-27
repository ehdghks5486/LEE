'use strict';
/**
 * 네이버 커머스 API 클라이언트 (판매자 본인 스토어용, type=SELF).
 *
 * 사전 준비: 커머스API센터(https://apicenter.commerce.naver.com)에서 API 이용 신청 → 애플리케이션 등록
 *            → 클라이언트 ID/시크릿 발급, 서버 호출 IP 등록.
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 *
 * 엔드포인트 경로는 아래 PATHS 한 곳에 모아두었습니다. 네이버 API 문서 버전이 바뀌면 여기만 수정하면 됩니다.
 */
const BASE_URL = 'https://api.commerce.naver.com/external';

const PATHS = {
  token: '/v1/oauth2/token',
  lastChanged: '/v1/pay-order/seller/product-orders/last-changed-statuses',
  productOrders: '/v1/pay-order/seller/product-orders/query',
  confirm: '/v1/pay-order/seller/product-orders/confirm',
  dispatch: '/v1/pay-order/seller/product-orders/dispatch',
  cancelApprove: (id) => `/v1/pay-order/seller/product-orders/${encodeURIComponent(id)}/claim/cancel/approve`,
};

// 앱 내 택배사 이름 → 네이버 택배사 코드
const DELIVERY_COMPANY_CODES = {
  'CJ대한통운': 'CJGLS',
  '롯데택배': 'HYUNDAI',
  '한진택배': 'HANJIN',
  '로젠택배': 'KGB',
  '우체국택배': 'EPOST',
  '경동택배': 'KDEXP',
  '대신택배': 'DAESIN',
};

class NaverApiError extends Error {
  constructor(status, body, path) {
    const msg = (body && (body.message || body.error_description || body.error)) || `HTTP ${status}`;
    super(`네이버 API 오류 (${path}): ${msg}`);
    this.status = status;
    this.body = body;
  }
}

class NaverCommerceClient {
  constructor({ clientId, clientSecret, baseUrl = BASE_URL, fetchImpl = fetch } = {}) {
    if (!clientId || !clientSecret) throw new Error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 가 필요합니다.');
    this.mode = 'live';
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.tokenInfo = null;
  }

  // 전자서명: bcrypt(client_id + "_" + timestamp, salt = client_secret) → base64
  signature(timestamp) {
    const bcrypt = require('bcryptjs');
    const hashed = bcrypt.hashSync(`${this.clientId}_${timestamp}`, this.clientSecret);
    return Buffer.from(hashed).toString('base64');
  }

  async getToken() {
    if (this.tokenInfo && this.tokenInfo.expiresAt - Date.now() > 60_000) return this.tokenInfo.token;
    const timestamp = Date.now();
    const form = new URLSearchParams({
      client_id: this.clientId,
      timestamp: String(timestamp),
      client_secret_sign: this.signature(timestamp),
      grant_type: 'client_credentials',
      type: 'SELF',
    });
    const res = await this.fetch(this.baseUrl + PATHS.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new NaverApiError(res.status, body, PATHS.token);
    this.tokenInfo = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 10800) * 1000 };
    return this.tokenInfo.token;
  }

  async request(method, path, { query, body } = {}) {
    const token = await this.getToken();
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const res = await this.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) this.tokenInfo = null;
    if (!res.ok) throw new NaverApiError(res.status, data, path);
    return data;
  }

  /** 변경 상품주문 조회. type: PAYED | CANCEL_REQUEST | CANCELED | ... 결과: 배열 (페이지 자동 병합) */
  async getLastChanged({ from, type }) {
    const out = [];
    let moreSequence;
    let moreFrom = from;
    for (let i = 0; i < 20; i++) {
      const data = await this.request('GET', PATHS.lastChanged, {
        query: { lastChangedFrom: toNaverTime(moreFrom), lastChangedType: type, moreSequence },
      });
      const d = data.data || {};
      out.push(...(d.lastChangeStatuses || []));
      if (!d.more) break;
      moreSequence = d.more.moreSequence;
      moreFrom = d.more.moreFrom;
    }
    return out;
  }

  /** 상품주문 상세 조회 (100건씩) */
  async getProductOrders(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const data = await this.request('POST', PATHS.productOrders, { body: { productOrderIds: ids.slice(i, i + 100) } });
      out.push(...(data.data || []));
    }
    return out;
  }

  async confirm(ids) {
    const data = await this.request('POST', PATHS.confirm, { body: { productOrderIds: ids } });
    return normalizeResult(data);
  }

  /** items: [{ productOrderId, deliveryMethod, deliveryCompanyCode, trackingNumber, dispatchDate }] */
  async dispatch(items) {
    const data = await this.request('POST', PATHS.dispatch, { body: { dispatchProductOrders: items } });
    return normalizeResult(data);
  }

  async approveCancel(productOrderId) {
    const data = await this.request('POST', PATHS.cancelApprove(productOrderId), { body: {} });
    return normalizeResult(data, productOrderId);
  }
}

function normalizeResult(data, fallbackId) {
  const d = data.data || data || {};
  return {
    success: d.successProductOrderIds || (fallbackId ? [fallbackId] : []),
    fail: d.failProductOrderInfos || [],
  };
}

/** Date → ISO8601 (KST, 밀리초 포함) 예: 2026-10-27T09:00:00.000+09:00 */
function toNaverTime(input) {
  const d = new Date(input);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())}T${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}:${p(kst.getUTCSeconds())}.${p(kst.getUTCMilliseconds(), 3)}+09:00`;
}

module.exports = { NaverCommerceClient, NaverApiError, DELIVERY_COMPANY_CODES, PATHS, toNaverTime };
