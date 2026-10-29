/* BLACKOUT 주문관리 PWA 서비스워커
   - 앱 셸(정적 파일)은 캐시 우선
   - API 요청은 항상 네트워크 (주문 데이터는 캐시하지 않음) */
const CACHE = 'blackout-shell-v5';
const SHELL = [
  '/', '/index.html', '/core.js', '/app.js', '/styles.css', '/manifest.webmanifest',
  '/vendor/', '/vendor/index.html', '/vendor.js', '/vendor/manifest.webmanifest',
  '/icons/logo-white.png', '/icons/logo-dark.png', '/icons/favicon-64.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 네트워크 전용

  // 정적 자원: 네트워크 우선, 실패 시 캐시 (배포 후 최신 파일 반영)
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match(url.pathname.startsWith('/vendor') ? '/vendor/index.html' : '/index.html')))
  );
});

// 휴대폰 알림: 서버가 보낸 { title, body, url, tag } 를 띄우고, 누르면 그 주문 화면을 연다
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'BLACKOUT', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'BLACKOUT', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, data: { url: d.url || '/' },
    icon: '/icons/icon-192.png', badge: '/icons/favicon-64.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const w = wins.find((c) => c.url.startsWith(self.location.origin));
      if (w) return w.focus().then(() => w.navigate(url)).catch(() => self.clients.openWindow(url));
      return self.clients.openWindow(url);
    })
  );
});
