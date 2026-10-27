'use strict';
/**
 * 스마트스토어 구매 옵션/배송 메모 문자열을 공장 제작 규격으로 변환합니다.
 *
 * 예) "제품형태: 양개형 / 프레임: 블랙 / 원단: 그레이 / 가로(mm): 1200 / 세로(mm): 1800"
 *     "편개형 블랙프레임 그레이원단 1200x1800"
 *     배송메모: "가로 120cm 세로 180cm"
 */

const TYPE_WORDS = [
  [/양개/, 'double'],
  [/편개/, 'single'],
  [/프리/, 'free'],
];
const COLOR_RE = '(화이트|흰색|흰|white|그레이|회색|gray|grey|블랙|검정|검은|black)';
const COLOR_CODE = (w) => (/화이트|흰|white/i.test(w) ? 'white' : /그레이|회색|gr[ae]y/i.test(w) ? 'gray' : 'black');
const DIM_LABELS = { width: '(?:가로|폭|너비|W)', height: '(?:세로|높이|H)' };

function normalize(s) {
  return String(s || '')
    .replace(/[：]/g, ':')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[×Ｘｘ]/g, 'x')
    .replace(/[＊]/g, '*')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function toMm(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (unit && /^cm$/i.test(unit)) return Math.round(n * 10);
  if (unit && /^m$/i.test(unit)) return Math.round(n * 1000);
  if (!unit && n > 0 && n < 300) return Math.round(n * 10); // 단위 없이 작은 값은 cm로 간주 (예: 가로 120)
  return Math.round(n);
}

function findDim(text, label) {
  // "가로(mm): 1200", "가로 120cm", "가로:1200mm", "W1200"
  const re = new RegExp(`${label}\\s*(?:\\((mm|cm|m)\\))?\\s*[:=]?\\s*(\\d+(?:\\.\\d+)?)\\s*(mm|cm|m)?(?![\\d])`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  return toMm(m[2], m[3] || m[1]);
}

function findColor(segments, label) {
  const labelRe = `(?:${label})`;
  for (const seg of segments) {
    if (!new RegExp(labelRe, 'i').test(seg)) continue;
    // 1) "프레임: 블랙" (구분자 있음)
    let m = new RegExp(`${labelRe}\\s*(?:색상|컬러)?\\s*[:=]\\s*${COLOR_RE}`, 'i').exec(seg);
    if (m) return COLOR_CODE(m[1]);
    // 2) "블랙프레임", "화이트 프레임"
    m = new RegExp(`${COLOR_RE}\\s*${labelRe}`, 'i').exec(seg);
    if (m) return COLOR_CODE(m[1]);
    // 3) "프레임 블랙"
    m = new RegExp(`${labelRe}\\s*(?:색상|컬러)?\\s*${COLOR_RE}`, 'i').exec(seg);
    if (m) return COLOR_CODE(m[1]);
  }
  return null;
}

function parseSpec(optionText, memoText) {
  const option = normalize(optionText);
  const memo = normalize(memoText);
  const text = `${option} ${memo}`.trim();
  const segments = text.split(/\s*[/,|]\s*/).filter(Boolean);
  const spec = {};
  const missing = [];

  for (const [w, code] of TYPE_WORDS) if (w.test(text)) { spec.product_type = code; break; }
  if (!spec.product_type) missing.push('제품 형태');

  let width = findDim(text, DIM_LABELS.width);
  let height = findDim(text, DIM_LABELS.height);
  if (width == null || height == null) {
    const m = /(\d+(?:\.\d+)?)\s*(mm|cm)?\s*[x*]\s*(\d+(?:\.\d+)?)\s*(mm|cm)?/i.exec(text);
    if (m) {
      width = width ?? toMm(m[1], m[2] || m[4]);
      height = height ?? toMm(m[3], m[4] || m[2]);
    }
  }
  if (width != null) spec.width_mm = width; else missing.push('가로');
  if (height != null) spec.height_mm = height; else missing.push('세로');

  const frame = findColor(segments, '프레임|틀');
  const fabric = findColor(segments, '원단|허니콤|패브릭');
  if (frame) spec.frame_color = frame; else missing.push('프레임 색상');
  if (fabric) spec.fabric_color = fabric; else missing.push('원단 색상');

  return { spec, missing };
}

module.exports = { parseSpec, normalize };
