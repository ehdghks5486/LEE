'use strict';
// SQLite 온라인 백업: VACUUM INTO 로 일관된 복사본 생성, 14일 지난 파일 삭제
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'blackout.db');
const outDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const keepDays = Number(process.env.BACKUP_KEEP_DAYS) || 14;

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const out = path.join(outDir, `blackout-${stamp}.db`);
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`[${new Date().toISOString()}] 백업 완료: ${out}`);

const cutoff = Date.now() - keepDays * 86400 * 1000;
for (const f of fs.readdirSync(outDir)) {
  if (!/^blackout-.*\.db$/.test(f)) continue;
  const p = path.join(outDir, f);
  if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); console.log(`오래된 백업 삭제: ${f}`); }
}
