// 완성한 그림책을 이 기기(IndexedDB)에 저장 — 인터넷 없이 다시 열 수 있음
const DB = "storyvoice-books", STORE = "books";
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: "id" }); s.createIndex("createdAt", "createdAt"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode); const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("저장 공간이 부족해요."));
  });
}
export const saveBook = (b) => tx("readwrite", (s) => s.put(b));
export const getBook = (id) => tx("readonly", (s) => s.get(id));
export const deleteBook = (id) => tx("readwrite", (s) => s.delete(id));
export async function listBooks() {
  const all = (await tx("readonly", (s) => s.getAll())) || [];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
// 브라우저가 저장 공간을 마음대로 비우지 않도록 요청(지원할 때만)
export async function persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; } }

// 녹음(webm/m4a 등)을 WAV로 바꿔 저장: 장면 구간으로 정확히 건너뛰기(seek) 위해
export async function toWav(blob, rate = 22050) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const arr = await blob.arrayBuffer();
  const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(arr, res, rej); if (p && p.then) p.then(res, rej); });
  ctx.close && ctx.close();
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(ab.duration * rate)), rate);
  const src = off.createBufferSource(); src.buffer = ab; src.connect(off.destination); src.start();
  const data = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + data.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + data.length * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) { const x = Math.max(-1, Math.min(1, data[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return { wav: new Blob([buf], { type: "audio/wav" }), duration: ab.duration };
}
