// 오프라인에서도 앱 화면과 저장한 그림책을 열 수 있게: 같은 출처 파일은 '네트워크 먼저, 안 되면 저장본'
const CACHE = "sv-shell-v4";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./keystore.js", "./story.js", "./imagegen.js", "./books.js", "./book.js", "./movie.js", "./mp4-muxer.mjs", "./worker.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const fonts = /fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net\/gh\/orioncactus/.test(u.host + u.pathname);
  if (u.origin !== location.origin && !fonts) return; // AI 호출 등은 건드리지 않음
  // 같은 출처 파일은 HTTP 캐시를 거치지 않고 서버에 확인(ETag) → 새 버전 배포 직후 옛 파일이 섞이지 않게
  const req = u.origin === location.origin ? new Request(e.request, { cache: "no-cache" }) : e.request;
  e.respondWith(fetch(req).then((r) => {
    if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error()))));
});
