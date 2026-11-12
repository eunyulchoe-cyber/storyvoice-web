// 오프라인에서도 앱 화면과 저장한 그림책을 열 수 있게: 같은 출처 파일은 '네트워크 먼저, 안 되면 저장본'
const CACHE = "sv-shell-v2";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./keystore.js", "./story.js", "./imagegen.js", "./books.js", "./book.js", "./worker.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const fonts = /fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net\/gh\/orioncactus/.test(u.host + u.pathname);
  if (u.origin !== location.origin && !fonts) return; // AI 호출 등은 건드리지 않음
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error()))));
});
