// 키를 이 기기의 IndexedDB에 AES-GCM으로 암호화해 저장. 암호화 키는 내보낼 수 없는(non-extractable) CryptoKey.
const DB = "storyvoice", STORE = "kv";
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const get = (k) => idb("readonly", (s) => s.get(k));
const put = (k, v) => idb("readwrite", (s) => s.put(v, k));
const del = (k) => idb("readwrite", (s) => s.delete(k));

async function masterKey() {
  let k = await get("master");
  if (!k) {
    k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await put("master", k);
  }
  return k;
}
export async function saveKey(name, value) {
  if (!value) return del("key:" + name);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await masterKey(), new TextEncoder().encode(value));
  return put("key:" + name, { iv, data });
}
export async function loadKey(name) {
  const rec = await get("key:" + name);
  if (!rec) return "";
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, await masterKey(), rec.data);
  return new TextDecoder().decode(buf);
}
export async function clearKeys() { await del("key:openai"); await del("key:xai"); }

// 부모 PIN (해시만 저장)
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sv-pin:" + s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
export const hasPin = async () => !!(await get("pin"));
export const setPin = async (p) => put("pin", await sha(p));
export const checkPin = async (p) => (await get("pin")) === (await sha(p));
