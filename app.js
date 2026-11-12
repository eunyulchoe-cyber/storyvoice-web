import { saveKey, loadKey, clearKeys, hasPin, setPin, checkPin } from "./keystore.js";

const $ = (id) => document.getElementById(id);
const MAX_MS = 90_000;
const state = { blob: null, name: "", live: { final: [], interim: "", startedAt: 0 }, keys: { openai: "", xai: "" } };

// ---------- 환경 점검 ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const warn = [];
let inFrame = false;
try { inFrame = window.top !== window.self; } catch { inFrame = true; }
if (inFrame) warn.push("이 화면이 다른 페이지 안(미리보기 창)에 들어 있어 마이크가 막힐 수 있어요. 주소를 Safari나 Chrome에서 직접 열어 주세요.");
if (!window.isSecureContext) warn.push("보안 연결(https)이 아니라서 마이크를 쓸 수 없어요. https 주소로 열어 주세요.");
if (warn.length) { $("envWarn").textContent = warn.join("\n"); $("envWarn").hidden = false; }

const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

function setMic(text, cls) {
  const el = $("micState");
  el.textContent = text;
  el.className = "state " + (cls || "");
}
const deniedHelp = isIOS
  ? "마이크가 거부되어 있어요.\n아이폰: 주소창 왼쪽 'ㄱㄱ(aA)' → 웹사이트 설정 → 마이크 → 허용. 또는 설정 앱 → Safari → 마이크 → 허용 후 새로고침."
  : "마이크가 거부되어 있어요.\n안드로이드 Chrome: 주소창 왼쪽 자물쇠(또는 설정) 아이콘 → 권한 → 마이크 → 허용 후 새로고침.";

async function checkMic() {
  if (!canRecord) {
    setMic("이 브라우저는 녹음을 지원하지 않아요. 최신 Safari나 Chrome을 쓰거나, 아래 '음성 파일 올리기'를 써 주세요.", "bad");
    $("btnRec").disabled = true;
    return;
  }
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    const show = () => {
      if (p.state === "granted") setMic("마이크 허용됨. 녹음 시작을 누르세요.", "ok");
      else if (p.state === "denied") setMic(deniedHelp, "bad");
      else setMic("녹음 시작을 누르면 마이크 허용 창이 떠요. '허용'을 눌러 주세요.");
    };
    show();
    p.onchange = show;
  } catch {
    setMic("녹음 시작을 누르면 마이크 허용 창이 떠요. '허용'을 눌러 주세요.");
  }
}
checkMic();

if (!SR) {
  $("liveStt").disabled = true;
  $("liveStt").parentElement.append(" — 이 브라우저는 지원 안 함");
  $("method").querySelector('option[value="live"]').disabled = true;
}

// ---------- 녹음 ----------
let rec = null, stream = null, chunks = [], t0 = 0, tick = null, actx = null, analyser = null, raf = null, recog = null;

function fmt(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function pickMime() {
  const c = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return c.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || "";
}
function extFor(type) { return type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") ? "mp3" : "webm"; }

function drawMeter() {
  const cv = $("meter"), g = cv.getContext("2d");
  cv.width = cv.clientWidth * devicePixelRatio; cv.height = 36 * devicePixelRatio;
  const buf = new Uint8Array(analyser.fftSize);
  const loop = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = lvl > 0.85 ? "#c0392b" : "#2f5bd3";
    g.fillRect(0, 0, cv.width * lvl, cv.height);
    raf = requestAnimationFrame(loop);
  };
  loop();
}

async function startRec() {
  $("sttErr").hidden = true;
  setMic("마이크 허용을 기다리는 중…");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") setMic(deniedHelp, "bad");
    else if (err.name === "NotFoundError") setMic("마이크를 찾지 못했어요. 이어폰 마이크를 빼거나 다른 기기에서 해 보세요. 또는 '음성 파일 올리기'.", "bad");
    else setMic("마이크를 켜지 못했어요: " + err.name + "\n다른 앱이 마이크를 쓰고 있는지 확인해 주세요.", "bad");
    return;
  }
  const mime = pickMime();
  rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = onRecStop;
  rec.start(250);
  t0 = Date.now();
  setMic("● 녹음 중입니다. 다 읽으면 정지를 누르세요.", "bad");
  $("btnRec").textContent = "■ 정지";
  $("btnRec").classList.add("recording");
  tick = setInterval(() => {
    const ms = Date.now() - t0;
    $("timer").textContent = fmt(ms);
    if (ms >= MAX_MS) stopRec();
  }, 200);
  actx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = actx.createAnalyser(); analyser.fftSize = 1024;
  actx.createMediaStreamSource(stream).connect(analyser);
  drawMeter();
  if ($("liveStt").checked && SR) startLive();
}

function stopRec() {
  if (!rec || rec.state === "inactive") return;
  rec.stop();
  clearInterval(tick); cancelAnimationFrame(raf);
  stream.getTracks().forEach((t) => t.stop());
  actx && actx.close();
  if (recog) { try { recog.stop(); } catch {} }
  $("btnRec").textContent = "● 다시 녹음";
  $("btnRec").classList.remove("recording");
}

function onRecStop() {
  const type = rec.mimeType || (chunks[0] && chunks[0].type) || "audio/webm";
  const blob = new Blob(chunks, { type });
  const ms = Date.now() - t0;
  setTake(blob, `녹음-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${extFor(type)}`, `내 녹음 · ${fmt(ms)} · ${(blob.size / 1024).toFixed(0)}KB · ${type}`);
  setMic("녹음 완료. 아래에서 다시 들어 보고 받아쓰기를 하세요.", "ok");
}

function setTake(blob, name, info) {
  state.blob = blob; state.name = name;
  const p = $("player");
  if (p.src) URL.revokeObjectURL(p.src);
  p.src = URL.createObjectURL(blob);
  $("takeInfo").textContent = info;
  $("playWrap").hidden = false;
  $("btnStt").disabled = false;
}

$("btnRec").onclick = () => (rec && rec.state === "recording" ? stopRec() : startRec());

$("fileIn").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 25 * 1024 * 1024) { showErr("파일이 25MB보다 커요. 90초 이내로 잘라서 올려 주세요."); return; }
  setTake(f, f.name, `올린 파일 · ${f.name} · ${(f.size / 1024).toFixed(0)}KB`);
};

// ---------- 실시간 받아쓰기 (Web Speech API) ----------
function startLive() {
  state.live = { final: [], interim: "", startedAt: Date.now() };
  const box = $("liveText"); box.hidden = false; box.textContent = "듣는 중…";
  recog = new SR();
  recog.lang = "ko-KR"; recog.continuous = true; recog.interimResults = true;
  let segStart = 0;
  recog.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) {
        const now = Date.now() - state.live.startedAt;
        state.live.final.push({ text: r[0].transcript.trim(), start: segStart / 1000, end: now / 1000 });
        segStart = now;
      } else interim += r[0].transcript;
    }
    state.live.interim = interim;
    box.textContent = state.live.final.map((s) => s.text).join(" ") + (interim ? " " + interim : "");
  };
  recog.onerror = (ev) => {
    const msg = { "not-allowed": "실시간 받아쓰기 권한이 거부됐어요.", "network": "실시간 받아쓰기는 인터넷 연결이 필요해요.", "no-speech": "말소리가 들리지 않았어요.", "audio-capture": "이 기기에서는 녹음과 실시간 받아쓰기를 동시에 못 해요. 녹음 후 '기기 안에서' 방식을 쓰세요." }[ev.error];
    box.textContent = (box.textContent === "듣는 중…" ? "" : box.textContent + "\n") + "(" + (msg || "실시간 받아쓰기 오류: " + ev.error) + ")";
  };
  recog.onend = () => { if (rec && rec.state === "recording") { try { recog.start(); } catch {} } };
  try { recog.start(); } catch (e) { box.textContent = "실시간 받아쓰기를 시작하지 못했어요."; }
}

// ---------- 받아쓰기 ----------
const notes = {
  "whisper-base": "음성이 기기 밖으로 나가지 않아요. 처음 한 번 약 80MB를 내려받아요(와이파이 권장). 한국어 정확도는 보통.",
  "whisper-small": "더 정확하지만 처음 약 250MB를 내려받고 느려요. 휴대폰 메모리가 적으면 실패할 수 있어요.",
  live: "녹음할 때 '실시간 받아쓰기'를 켜 두어야 해요. 올린 파일에는 쓸 수 없어요. 시간 정보는 대략치예요.",
  openai: "부모 설정에 OpenAI 키가 필요해요. 단어·구간별 시간을 줘요. 요금은 키 주인에게 청구돼요(분당 $0.006).",
  xai: "부모 설정에 xAI 키가 필요해요. 단어별 시간을 줘요. 요금은 키 주인에게 청구돼요(시간당 $0.10).",
};
$("method").onchange = () => { $("methodNote").textContent = notes[$("method").value]; };
$("method").onchange();

function showErr(t) { $("sttErr").textContent = t; $("sttErr").hidden = false; }
function prog(on, pct, text) {
  $("progWrap").hidden = !on;
  if (pct != null) $("prog").value = pct; else $("prog").removeAttribute("value");
  if (text != null) $("progText").textContent = text;
}
function fmtS(s) { if (s == null || isNaN(s)) return "?"; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; }

function showResult(text, segs, note) {
  $("transcript").value = text.trim();
  $("timingNote").textContent = note;
  const ol = $("segments"); ol.innerHTML = "";
  for (const s of segs) {
    const li = document.createElement("li");
    const t = document.createElement("span"); t.className = "t"; t.textContent = `${fmtS(s.start)}–${fmtS(s.end)}`;
    li.append(t, document.createTextNode(s.text));
    ol.append(li);
  }
  $("resultWrap").hidden = false;
  $("resultWrap").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function decode16k(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new Ctx({ sampleRate: 16000 }); } catch { ctx = new Ctx(); }
  const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
  ctx.close && ctx.close();
  let data;
  if (ab.numberOfChannels > 1) {
    const a = ab.getChannelData(0), b = ab.getChannelData(1); data = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) data[i] = (a[i] + b[i]) / 2;
  } else data = ab.getChannelData(0);
  if (ab.sampleRate !== 16000) { // 리샘플
    const off = new OfflineAudioContext(1, Math.ceil(ab.duration * 16000), 16000);
    const src = off.createBufferSource(); const mono = off.createBuffer(1, data.length, ab.sampleRate);
    mono.copyToChannel(data, 0); src.buffer = mono; src.connect(off.destination); src.start();
    data = (await off.startRendering()).getChannelData(0);
  }
  return { data, duration: ab.duration };
}

let worker = null;
function runWhisper(model, audio) {
  return new Promise((resolve, reject) => {
    if (!worker) worker = new Worker("./worker.js", { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") prog(true, m.pct, `모델 내려받는 중 ${m.pct}% (약 ${m.mb}MB)`);
      else if (m.type === "status") prog(true, null, m.text);
      else if (m.type === "result") resolve(m);
      else if (m.type === "error") reject(new Error(m.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || "작업자 오류"));
    worker.postMessage({ type: "transcribe", model, audio }, [audio.buffer]);
  });
}

async function callOpenAI(key) {
  const fd = new FormData();
  fd.append("file", state.blob, state.name || "audio.webm");
  fd.append("model", "whisper-1");
  fd.append("language", "ko");
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "segment");
  fd.append("timestamp_granularities[]", "word");
  let r;
  try {
    r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd });
  } catch {
    // OpenAI는 오류 응답(401 등)에 CORS 헤더를 붙이지 않아 브라우저에는 네트워크 오류로만 보입니다.
    throw new Error("OpenAI에 연결하지 못했어요. 키가 틀렸거나 크레딧이 없거나 인터넷 문제일 수 있어요. 부모 설정에서 키를 확인해 주세요.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI 오류 ${r.status}: ${(j.error && j.error.message) || ""}`);
  const segs = (j.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
  return { text: j.text || "", segs, note: `OpenAI whisper-1 · 구간 ${segs.length}개, 단어 ${(j.words || []).length}개의 시간 정보` };
}
async function callXai(key) {
  const fd = new FormData();
  fd.append("model", "grok-voice-transcribe-2.0");
  fd.append("language", "ko");
  fd.append("file", state.blob, state.name || "audio.webm"); // file은 마지막 필드
  const r = await fetch("https://api.x.ai/v1/stt", { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`xAI 오류 ${r.status}: ${(j.error && (j.error.message || j.error)) || j.message || ""}`);
  const words = j.words || [];
  const segs = []; let cur = null;
  for (const w of words) { // 문장부호 기준으로 구간 묶기
    if (!cur) cur = { start: w.start, end: w.end, text: "" };
    cur.text += (cur.text ? " " : "") + w.text; cur.end = w.end;
    if (/[.!?。…]$/.test(w.text)) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  return { text: j.text || "", segs, note: `xAI · 단어 ${words.length}개의 시간 정보(문장 단위로 묶어 표시)` };
}

$("btnStt").onclick = async () => {
  const m = $("method").value;
  $("sttErr").hidden = true;
  $("btnStt").disabled = true;
  try {
    if (m === "live") {
      const L = state.live;
      if (!L.final.length && !L.interim) throw new Error("실시간 받아쓰기 결과가 없어요. '녹음하면서 실시간 받아쓰기'를 켜고 다시 녹음하세요.");
      const segs = L.final.length ? L.final : [{ text: L.interim, start: 0, end: null }];
      showResult(segs.map((s) => s.text).join(" "), segs, "브라우저 실시간 받아쓰기 · 시간은 결과가 도착한 시각 기준의 대략치");
    } else if (m === "openai" || m === "xai") {
      if (!state.blob) throw new Error("먼저 녹음하거나 파일을 올려 주세요.");
      const key = await loadKey(m);
      if (!key) throw new Error("부모 설정에서 키를 먼저 넣어 주세요.");
      prog(true, null, "보내는 중…");
      const r = m === "openai" ? await callOpenAI(key) : await callXai(key);
      showResult(r.text, r.segs, r.note);
    } else {
      if (!state.blob) throw new Error("먼저 녹음하거나 파일을 올려 주세요.");
      prog(true, null, "소리 파일 읽는 중…");
      const { data, duration } = await decode16k(state.blob);
      if (duration > 95) throw new Error("90초 이내로 녹음해 주세요.");
      const res = await runWhisper("onnx-community/" + m, data);
      const chunks = res.out.chunks || [];
      const segs = chunks.map((c) => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] }));
      showResult(res.out.text || "", segs, `기기 안 Whisper(${m.replace("whisper-", "")}) · 구간 ${segs.length}개 · ${(res.ms / 1000).toFixed(1)}초 걸림`);
    }
  } catch (err) {
    showErr(err.message || String(err));
  } finally {
    prog(false);
    $("btnStt").disabled = !state.blob && $("method").value !== "live";
  }
};

// ---------- 부모 설정 (PIN + 키) ----------
function askPin() {
  return new Promise(async (resolve) => {
    const first = !(await hasPin());
    $("pinTitle").textContent = first ? "부모 PIN 만들기" : "부모 확인";
    $("pinHelp").textContent = first ? "아이가 설정을 바꾸지 못하게 숫자 4자리 이상을 정해 주세요. 이 기기에만 저장돼요." : "부모 PIN을 입력하세요.";
    $("pinIn").value = ""; $("pinErr").hidden = true;
    const d = $("dlgPin"); d.showModal(); $("pinIn").focus();
    const done = (v) => { d.close(); $("pinOk").onclick = $("pinCancel").onclick = null; resolve(v); };
    $("pinCancel").onclick = () => done(false);
    $("pinOk").onclick = async () => {
      const p = $("pinIn").value.trim();
      if (!/^\d{4,8}$/.test(p)) { $("pinErr").textContent = "숫자 4~8자리로 입력하세요."; $("pinErr").hidden = false; return; }
      if (first) { await setPin(p); done(true); }
      else if (await checkPin(p)) done(true);
      else { $("pinErr").textContent = "PIN이 맞지 않아요."; $("pinErr").hidden = false; }
    };
  });
}
$("btnParent").onclick = async () => {
  if (!(await askPin())) return;
  const [o, x] = await Promise.all([loadKey("openai").catch(() => ""), loadKey("xai").catch(() => "")]);
  $("keyOpenai").value = o; $("keyXai").value = x;
  $("keyMsg").textContent = (o || x) ? "저장된 키가 있어요." : "저장된 키가 없어요. 무료 방식은 키 없이 쓸 수 있어요.";
  $("dlgParent").showModal();
};
$("keySave").onclick = async () => {
  await saveKey("openai", $("keyOpenai").value.trim());
  await saveKey("xai", $("keyXai").value.trim());
  $("keyMsg").textContent = "이 기기에 저장했어요.";
};
$("keyDelete").onclick = async () => { await clearKeys(); $("keyOpenai").value = $("keyXai").value = ""; $("keyMsg").textContent = "키를 모두 지웠어요."; };
$("keyClose").onclick = () => $("dlgParent").close();

window.__sv = { state, setTake }; // 자동 점검용
