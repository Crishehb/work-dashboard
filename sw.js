// ============================================================
//  Service Worker：PWA 离线缓存
//  策略：网络优先（保证每次打开都是最新版本），失败时回退缓存（离线可用）
// ============================================================
const CACHE = 'workboard-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

// 激活时清理旧版本缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return; // POST（云同步推送等）不拦截

  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  e.respondWith(
    fetch(e.request).then(res => {
      // 只缓存本站资源；云端接口不写缓存，避免旧数据干扰
      if (sameOrigin && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() =>
      caches.match(e.request).then(hit => hit || (sameOrigin ? caches.match('./index.html') : Response.error()))
    )
  );
});
