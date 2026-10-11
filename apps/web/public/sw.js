/* 红薯运营工作台 —— Service Worker
 *
 * 目的：装到手机主屏后能离线打开外壳。
 *
 * 策略与 Sales-order 旧版一致：同源资源一律「网络优先、带协商校验」，
 * 拿不到再用缓存。Vite 的入口 HTML 必须和它引用的 hashed assets 来自同一次
 * 发布 —— 如果 HTML 是新的而 JS 还是缓存里的旧版，界面会直接出错。
 * 所以不能对 JS/CSS 用「缓存优先」，每次都向服务器确认（未变化时只回 304，
 * 开销很小），只有断网时才退回缓存。
 *
 * 数据接口一律不经过这里：
 * - Supabase 的订单请求必须实时，缓存了会看到旧账；
 *   离线时的数据展示由订单模块自己用 localStorage 处理（见 src/orders/client.ts）。
 * - 后端 /api/xhs/* 是动态接口，同理不缓存。
 */

const VERSION = 'v1';
const CACHE = 'xhs-workbench-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 单个文件取不到不应导致整个安装失败
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 接口请求交给页面自己处理，不进缓存
  if (url.hostname.endsWith('.supabase.co')) return;
  if (url.pathname.startsWith('/api/')) return;
  // 跨域资源不接管
  if (url.origin !== self.location.origin) return;

  // 导航请求统一存成 index.html，离线时不管带什么查询参数都能打开
  const cacheKey = req.mode === 'navigate' ? './index.html' : req;

  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(cacheKey, copy));
        }
        return res;
      })
      .catch(() => caches.match(cacheKey).then((r) => r || caches.match('./index.html'))),
  );
});
