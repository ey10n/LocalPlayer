// アプリ本体をキャッシュしてオフラインでも起動できるようにする
// （MP3 データは IndexedDB に保存されるため、ここでは扱わない）
//
// 更新方針：
// - __BUILD__ はデプロイ時にコミットIDへ置き換わる（.github/workflows/pages.yml）。
//   push のたびにこのファイルの中身が変わるので、ブラウザが新しい版を検出する。
//   また各ファイルの URL も ?v=<コミットID> で変わるため、古いコピーが使い回されない。
// - オンライン時は常にサーバーから取得し（ネットワーク優先）、
//   オフライン・応答が遅いときだけキャッシュを使う。
// - GitHub Pages は max-age=600 で配信するため、HTTP キャッシュを経由せずサーバーに確認する。
const BUILD = '__BUILD__';
const CACHE = `local-player-${BUILD}`;
const TIMEOUT_MS = 4000;
const ASSETS = [
  './',
  './index.html',
  `./style.css?v=${BUILD}`,
  `./js/app.js?v=${BUILD}`,
  `./js/db.js?v=${BUILD}`,
  `./js/id3.js?v=${BUILD}`,
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  if (!cached) return network;
  // キャッシュがあるときは、通信できない・遅いときにキャッシュで起動する
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), TIMEOUT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}
