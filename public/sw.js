// 앱 셸과 ffmpeg 코어를 캐시해서 두 번째 실행부터 빠르게 뜨게 한다.
const CACHE = 'hq-twitter-v1';
const SHELL = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  './vendor/ffmpeg/index.js', './vendor/ffmpeg/classes.js', './vendor/ffmpeg/const.js',
  './vendor/ffmpeg/errors.js', './vendor/ffmpeg/types.js', './vendor/ffmpeg/utils.js',
  './vendor/ffmpeg/worker.js', './vendor/util/index.js', './vendor/util/const.js',
  './vendor/util/errors.js', './vendor/util/types.js',
];
const CORE_HOST = 'unpkg.com';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // ffmpeg 코어(약 30MB)는 버전 고정 URL이라 캐시 우선
  if (url.host === CORE_HOST) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      }))
    );
    return;
  }

  // 같은 출처 파일: 네트워크 우선, 실패하면 캐시 (공유로 열릴 때 ?text=... 쿼리는 무시하고 매칭)
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok && !url.search) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
  }
});
