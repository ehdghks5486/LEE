'use strict';
/**
 * 휴대폰 알림 (Web Push). 홈 화면에 추가한 앱이 서버 알림을 받는다. 아이폰은 iOS 16.4 이상 + 홈 화면 앱에서만.
 * - 서버 키(VAPID)는 처음 실행 때 만들어 sync_state 에 둔다
 * - 알림 내용은 받는 역할에 맞게 만들어서 보낸다 (공장에는 가격·업체명 금지)
 * - 푸시 서비스가 404/410 을 돌려준 구독(앱 삭제·권한 해제)은 지운다
 */
const webpush = require('web-push');

function createPush({ db, sendImpl, logger = console }) {
  const getState = (k) => db.prepare('SELECT value FROM sync_state WHERE key = ?').get(k)?.value;
  const setState = (k, v) => db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

  let publicKey = getState('vapid_public');
  let privateKey = getState('vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setState('vapid_public', publicKey);
    setState('vapid_private', privateKey);
  }
  const send = sendImpl || ((sub, payload, options) => webpush.sendNotification(sub, payload, options));

  /** 푸시 서비스에 알리는 연락처: 이 앱 주소 (처음 구독할 때 요청 주소로 정한다) */
  function rememberSite(host) {
    if (host && !getState('push_subject')) setState('push_subject', `https://${host}`);
  }

  function subscribe(user, sub, userAgent) {
    const endpoint = String(sub?.endpoint || '');
    const { p256dh, auth } = sub?.keys || {};
    if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw Object.assign(new Error('알림 구독 정보가 올바르지 않습니다.'), { status: 400 });
    // 같은 휴대폰에 다른 계정이 로그인하면 그 계정으로 옮긴다
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, created_at = datetime('now','localtime')`
    ).run(user.id, endpoint, p256dh, auth, String(userAgent || '').slice(0, 200));
  }
  function unsubscribe(user, endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(endpoint || ''), user.id);
  }
  const countFor = (user) => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(user.id).n;

  async function deliver(rows, msg) {
    const payload = JSON.stringify({ title: msg.title, body: msg.body || '', url: msg.url || '/', tag: msg.tag || undefined });
    const options = {
      TTL: 24 * 60 * 60,
      urgency: 'high',
      vapidDetails: { subject: getState('push_subject') || 'https://localhost', publicKey, privateKey },
    };
    let sent = 0;
    for (const r of rows) {
      try {
        await send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, options);
        db.prepare("UPDATE push_subscriptions SET last_ok_at = datetime('now','localtime') WHERE id = ?").run(r.id);
        sent += 1;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(r.id);
        else logger.error('[push]', e.statusCode || '', e.message);
      }
    }
    return sent;
  }

  /** roles: ['admin'] 등. vendorId 를 주면 그 업체 계정에게만. 실패해도 주문 처리는 막지 않는다. */
  function notify(roles, msg, { vendorId } = {}) {
    const where = [`u.active = 1`, `u.role IN (${roles.map(() => '?').join(',')})`];
    const params = [...roles];
    if (vendorId !== undefined) {
      where.push('u.vendor_id = ?');
      params.push(vendorId);
    }
    const rows = db.prepare(`SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE ${where.join(' AND ')}`).all(...params);
    if (!rows.length) return Promise.resolve(0);
    return deliver(rows, msg).catch((e) => { logger.error('[push]', e.message); return 0; });
  }
  function notifyUser(user, msg) {
    return deliver(db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(user.id), msg);
  }

  return { publicKey, rememberSite, subscribe, unsubscribe, countFor, notify, notifyUser };
}

module.exports = { createPush };
