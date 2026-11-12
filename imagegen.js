// FLUX.2 [klein] 4B (Apache-2.0) — Black Forest Labs가 Hugging Face에 올린 공개 데모(ZeroGPU)를 부모의 무료 HF 토큰으로 호출.
// 토큰은 x-hf-authorization 헤더로 HF 프록시에만 전달되고, 사용량은 그 토큰 주인의 무료 GPU 시간에서 빠집니다.
export const SPACE = "https://black-forest-labs-flux-2-klein-4b.hf.space";

export class QuotaError extends Error { constructor(m) { super(m); this.name = "QuotaError"; } }
export class GenError extends Error { constructor(m) { super(m); this.name = "GenError"; } }

const hdr = (token) => (token ? { "x-hf-authorization": "Bearer " + token } : {});

export async function checkHfToken(token) {
  const r = await fetch("https://huggingface.co/api/whoami-v2", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error(r.status === 401 ? "토큰이 맞지 않아요." : "확인 실패 " + r.status);
  const j = await r.json();
  return j.name || "확인됨";
}

async function upload(blob, token, signal) {
  const fd = new FormData();
  fd.append("files", blob, "ref." + ((blob.type || "").includes("png") ? "png" : (blob.type || "").includes("jpeg") ? "jpg" : "webp"));
  const r = await fetch(SPACE + "/gradio_api/upload", { method: "POST", headers: hdr(token), body: fd, signal });
  if (!r.ok) throw new GenError(`그림 서버에 기준 그림을 올리지 못했어요 (${r.status}).`);
  const j = await r.json();
  return j[0];
}

function classify(msg) {
  const m = String(msg || "");
  if (/zerogpu|quota|exceeded|gpu.*limit|runs limit|too many/i.test(m)) {
    return new QuotaError("무료 그림 사용량(Hugging Face GPU 시간)을 잠시 다 썼어요. 1~2분 뒤 자동으로 다시 시도해요. 계속 실패하면 내일 다시 하거나, 부모 설정에 HF 토큰이 들어 있는지 확인해 주세요.");
  }
  if (/sleeping|building|paused|not running|503|502/i.test(m)) return new GenError("그림 서버가 깨어나는 중이거나 잠시 멈췄어요. 잠시 뒤 다시 해 주세요.");
  return new GenError("그림을 만들지 못했어요: " + (m || "알 수 없는 오류"));
}

let fnIndex = null;
async function inferFn(token, signal) {
  if (fnIndex != null) return fnIndex;
  try {
    const r = await fetch(SPACE + "/config", { headers: hdr(token), signal });
    const c = await r.json();
    const i = (c.dependencies || []).findIndex((d) => d.api_name === "infer");
    if (i >= 0) { const d = c.dependencies[i]; fnIndex = { fn: d.id ?? i, trigger: (d.targets && d.targets[0] && d.targets[0][0]) ?? null }; return fnIndex; }
  } catch (e) { if (e.name === "AbortError") throw e; }
  throw new GenError("그림 서버(Hugging Face 데모)에 연결하지 못했어요. 서버가 잠들어 있거나 주소가 바뀌었을 수 있어요.");
}

// 큐 SSE(data: {msg:...})를 읽어 완료 메시지 하나를 돌려줌
async function readQueue(resp, eventId, signal, onStatus) {
  const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.event_id && m.event_id !== eventId) continue;
        if (m.msg === "estimation" && onStatus) onStatus(m.rank > 0 ? `대기 ${m.rank + 1}번째` : "곧 시작");
        else if (m.msg === "process_starts" && onStatus) onStatus("그리는 중");
        else if (m.msg === "process_completed") return m;
        else if (m.msg === "unexpected_error") return { success: false, output: { error: m.message || "unexpected" } };
      }
      if (done) return { success: false, output: { error: "연결이 끊겼어요" } };
    }
  } finally { try { reader.cancel(); } catch {} }
}

/**
 * 그림 한 장 생성. refBlob이 있으면 기준 그림(image 1)으로 넣음.
 * 반환: Blob(webp)
 */
export async function generate({ prompt, refBlob = null, seed = 0, width = 768, height = 768, token = "", signal, onStatus } = {}) {
  let r, sh, f;
  try {
    f = await inferFn(token, signal);
    const images = [];
    if (refBlob) { const path = await upload(refBlob, token, signal); images.push({ image: { path, meta: { _type: "gradio.FileData" } }, caption: null }); }
    sh = "sv" + Math.random().toString(36).slice(2, 12);
    const body = { data: [prompt, images, "Distilled (4 steps)", seed, false, width, height, 4, 1.0, false], fn_index: f.fn, trigger_id: f.trigger, session_hash: sh, event_data: null };
    r = await fetch(SPACE + "/gradio_api/queue/join", { method: "POST", headers: { ...hdr(token), "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === "AbortError" || e instanceof GenError) throw e;
    throw new GenError("그림 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
  if (r.status === 429) throw classify("too many");
  if (!r.ok) throw classify(String(r.status));
  const { event_id } = await r.json();
  const sse = await fetch(`${SPACE}/gradio_api/queue/data?session_hash=${sh}`, { headers: hdr(token), signal });
  if (!sse.ok) throw classify(String(sse.status));
  const m = await readQueue(sse, event_id, signal, onStatus);
  if (!m.success) {
    const o = m.output || {};
    throw classify(o.error || m.title || "그림 서버 오류");
  }
  const file = m.output && m.output.data && m.output.data[0];
  const url = file && (file.url || (file.path && `${SPACE}/gradio_api/file=${file.path}`));
  if (!url) throw new GenError("그림 서버가 그림을 돌려주지 않았어요.");
  const img = await fetch(url, { headers: hdr(token), signal });
  if (!img.ok) throw new GenError("완성된 그림을 받지 못했어요 (" + img.status + ").");
  const blob = await img.blob();
  if (!blob.size || !/^image\//.test(blob.type || "image/webp")) throw new GenError("받은 파일이 그림이 아니에요.");
  return blob;
}

// 기준 그림은 클수록 업로드가 느려 512px로 줄여 보냄
export async function shrink(blob, max = 512) {
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (s === 1) return blob;
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || blob), "image/png"));
  } catch { return blob; }
}

/** 사용량 초과면 기다렸다가 다시(최대 tries번). onWait(sec, attempt) 로 남은 시간 표시 */
export async function generateWithRetry(opts, { tries = 3, waitSec = 75, onWait, signal } = {}) {
  for (let a = 1; ; a++) {
    try { return await generate({ ...opts, signal }); }
    catch (e) {
      if (!(e instanceof QuotaError) || a >= tries || (signal && signal.aborted)) throw e;
      for (let s = waitSec; s > 0; s--) {
        if (signal && signal.aborted) throw new DOMException("취소", "AbortError");
        onWait && onWait(s, a); await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
