'use strict';
/**
 * 장부: 이전 「블랙아웃」 앱(Vercel + Supabase blackout_docs)에서 쓰던 주문 장부를 그대로 옮겨 둔 것.
 * 그 앱의 필드(날짜·채널·입금·수취인·cm 치수·색상·판매가·공장가·배송비·수수료·메모)를 바꾸지 않고 담는다.
 * 차익 = 판매가 − 공장가 − 배송비 − 수수료 (그 앱과 같은 계산).
 *
 * 옮기기는 그 앱 화면에서 직접 보낸다: 관리자가 만든 10분짜리 일회용 키를 붙여 POST /api/ledger/import.
 */
const crypto = require('node:crypto');

const KEY_TTL_MS = 10 * 60 * 1000;
const importKeys = new Map(); // key → 만료 시각

function createImportKey() {
  const key = crypto.randomBytes(24).toString('base64url');
  importKeys.set(key, Date.now() + KEY_TTL_MS);
  return { key, expires_in: KEY_TTL_MS / 1000 };
}
function useImportKey(key) {
  const exp = importKeys.get(String(key || ''));
  importKeys.delete(String(key || ''));
  for (const [k, t] of importKeys) if (t < Date.now()) importKeys.delete(k);
  return !!exp && exp > Date.now();
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v, max = 500) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

/** 그 앱의 주문 문서들 → 장부 행. 같은 id 는 덮어쓴다(다시 옮겨도 중복 없음). */
function importEntries(db, entries) {
  if (!Array.isArray(entries)) throw Object.assign(new Error('entries 배열이 필요합니다.'), { status: 400 });
  const up = db.prepare(
    `INSERT INTO ledger_entries (id, date, channel, paid, name, phone, address, width_cm, height_cm, frame, fabric, open_type, kind,
       price, cost, ship, fee, memo, source, raw, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blackout-app', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET date = excluded.date, channel = excluded.channel, paid = excluded.paid, name = excluded.name,
       phone = excluded.phone, address = excluded.address, width_cm = excluded.width_cm, height_cm = excluded.height_cm,
       frame = excluded.frame, fabric = excluded.fabric, open_type = excluded.open_type, kind = excluded.kind, price = excluded.price,
       cost = excluded.cost, ship = excluded.ship, fee = excluded.fee, memo = excluded.memo, raw = excluded.raw,
       created_at = excluded.created_at, updated_at = excluded.updated_at`
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      const id = str(e.id, 100);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) ? e.date : null;
      if (!id || !date) continue;
      up.run(
        id, date, str(e.channel, 20), e.paid ? 1 : 0, str(e.name, 100), str(e.phone, 30), str(e.addr, 300),
        num(e.w) || null, num(e.h) || null, str(e.frame, 30), str(e.fabric, 30), str(e.type, 20), str(e.kind, 20),
        Math.round(num(e.price)), Math.round(num(e.cost)), Math.round(num(e.ship)), Math.round(num(e.fee)), str(e.memo, 1000),
        JSON.stringify(e).slice(0, 10000), str(e.createdAt, 40), str(e.updatedAt || e.updated_at, 40)
      );
      n += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

const profitOf = (r) => r.price - r.cost - r.ship - r.fee;

/** month: 'YYYY-MM' 또는 'all'(기본: 가장 최근 달) */
function listLedger(db, { month, unpaid } = {}) {
  const months = db.prepare("SELECT DISTINCT substr(date, 1, 7) AS m FROM ledger_entries ORDER BY m DESC").all().map((r) => r.m);
  const m = month === 'all' || months.includes(month) ? month : months[0] || 'all';
  const rows = db
    .prepare(`SELECT * FROM ledger_entries ${m === 'all' ? '' : 'WHERE date LIKE ?'} ORDER BY date DESC, created_at DESC`)
    .all(...(m === 'all' ? [] : [`${m}%`]))
    .map(({ raw, ...r }) => ({ ...r, paid: !!r.paid, profit: profitOf(r) }));
  const unpaidRows = rows.filter((r) => !r.paid);
  const totals = {
    count: rows.length,
    sales: rows.reduce((s, r) => s + r.price, 0),
    profit: rows.reduce((s, r) => s + r.profit, 0),
    unpaid_count: unpaidRows.length,
    unpaid_amount: unpaidRows.reduce((s, r) => s + r.price, 0),
  };
  return { month: m, months, totals, rows: unpaid ? unpaidRows : rows };
}

function setPaid(db, id, paid) {
  const r = db.prepare("UPDATE ledger_entries SET paid = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(paid ? 1 : 0, String(id));
  return r.changes > 0;
}

module.exports = { createImportKey, useImportKey, importEntries, listLedger, setPaid };
