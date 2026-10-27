'use strict';
/**
 * 대신택배 홈페이지 「화물조회 → 고객정보로 조회하기」(받는 분 전화번호 + 기간)로 송장번호를 찾는다.
 * 정식 API가 아니라 고객용 조회 화면을 그대로 쓰므로, 화면 형식이 바뀌면 오류를 던져 직접 입력으로 돌아가게 한다.
 * 응답의 받는 사람·전화번호는 대신택배가 이미 가려서(이***, 0101*******) 내려준다.
 */
const SEARCH_URL = 'https://www.ds3211.co.kr/freight/userInfoFreightSearch.ht';
const REFERER = 'https://www.ds3211.co.kr/freight/GuestSearch.jsp';
const TRACKING_LENGTH = 13;

const cellText = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** 조회 결과 표 → [{ received_at, tracking_no, item, receiver, branch, quantity, status }] */
function parseResults(html) {
  if (!html.includes('접수일자')) throw new Error('대신택배 조회 화면을 읽지 못했습니다. 화면 형식이 바뀌었을 수 있습니다.');
  const out = [];
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (cells.length < 8) continue;
    const trackingNo = cells[1].replace(/\D/g, '');
    if (trackingNo.length !== TRACKING_LENGTH) continue;
    out.push({
      received_at: cells[0], tracking_no: trackingNo, item: cells[2], receiver: cells[3],
      branch: cells[5], quantity: Number(cells[6]) || null, status: cells[7],
    });
  }
  return out;
}

/** from/to: 'YYYY-MM-DD' (최대 3개월) */
async function searchByReceiverPhone({ phone, from, to, fetchImpl = fetch }) {
  const tel = String(phone || '').replace(/\D/g, '');
  if (tel.length < 9) return [];
  const body = new URLSearchParams({ division: '2', name: '', tel, startDt: from, closeDt: to, accept: 'Y' });
  const res = await fetchImpl(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: REFERER },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`대신택배 조회 실패 (HTTP ${res.status})`);
  const html = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
  return parseResults(html);
}

module.exports = { searchByReceiverPhone, parseResults, TRACKING_LENGTH };
