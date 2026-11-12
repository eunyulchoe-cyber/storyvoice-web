// M3 · 그림책 → 짧은 영상(세로 720×1280). 서버 없이 기기 안에서 만듦.
// 1순위: WebCodecs(H.264 + AAC/Opus) + mp4-muxer → MP4 (실시간보다 빠름)
// 2순위: MediaRecorder(캔버스 + 오디오 실시간 녹화) → MP4 또는 WebM (영상 길이만큼 걸림)
import { Muxer, ArrayBufferTarget } from "./mp4-muxer.mjs";

export const W = 720, H = 1280, FPS = 30;
const XF = 0.7;        // 장면 사이 교차 전환(초)
const TAIL = 1.2;      // 끝에 그림을 잠깐 더 보여 줌(초)
const AR = 48000;      // 영상 소리 샘플레이트

export function movieSupport() {
  return {
    webcodecs: typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined" && typeof VideoFrame !== "undefined",
    recorder: typeof MediaRecorder !== "undefined" && !!HTMLCanvasElement.prototype.captureStream,
  };
}

const ease = (x) => (x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x));

// ---------- 그리기 ----------
async function prepare(book, opt) {
  const imgs = await Promise.all(book.scenes.map((s) => (s.image ? createImageBitmap(s.image) : null)));
  // 장면별 흐린 배경을 미리 한 장씩 만들어 둠(매 프레임 blur는 무거움)
  const bgs = imgs.map((im) => {
    const c = document.createElement("canvas"); c.width = W / 4; c.height = H / 4;
    const g = c.getContext("2d");
    g.fillStyle = opt.night ? "#1E2240" : "#FBEFD9"; g.fillRect(0, 0, c.width, c.height);
    if (im) { g.filter = "blur(10px)"; const s = Math.max(c.width / im.width, c.height / im.height) * 1.15; g.drawImage(im, (c.width - im.width * s) / 2, (c.height - im.height * s) / 2, im.width * s, im.height * s); g.filter = "none"; }
    g.fillStyle = opt.night ? "rgba(20,22,50,.45)" : "rgba(255,248,238,.45)"; g.fillRect(0, 0, c.width, c.height);
    return c;
  });
  const font = opt.font || "\"Gowun Dodum\", \"Pretendard Variable\", \"Noto Sans KR\", sans-serif";
  const titleFont = opt.titleFont || "\"Jua\", \"Pretendard Variable\", \"Noto Sans KR\", sans-serif";
  try { await document.fonts.ready; } catch {}
  const n = book.scenes.length;
  const sc = book.scenes.map((s, i) => ({ ...s, a: i === 0 ? 0 : s.start - XF / 2, b: i === n - 1 ? book.duration + TAIL : s.end + XF / 2 }));
  return { imgs, bgs, sc, font, titleFont, total: book.duration + TAIL };
}

function wrapLines(g, text, maxW) {
  const words = String(text || "").split(/\s+/); const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (g.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

function drawScene(g, P, i, t, alpha, opt) {
  const s = P.sc[i], im = P.imgs[i];
  const p = ease((t - s.a) / Math.max(0.1, s.b - s.a));
  g.globalAlpha = alpha;
  g.drawImage(P.bgs[i], 0, 0, W, H);
  // 그림 칸: 가운데 정사각형, 둥근 모서리, 안에서 천천히 확대·이동(켄 번스)
  const box = 660, bx = (W - box) / 2, by = 190;
  g.save();
  g.shadowColor = "rgba(80,50,30,.25)"; g.shadowBlur = 30; g.shadowOffsetY = 10;
  g.fillStyle = opt.night ? "#262B52" : "#FFFFFF"; rrect(g, bx - 10, by - 10, box + 20, box + 20, 34); g.fill();
  g.restore();
  g.save(); rrect(g, bx, by, box, box, 26); g.clip();
  if (im) {
    const zin = i % 2 === 0;                       // 짝수 장면은 확대, 홀수 장면은 축소
    const z = zin ? 1.0 + 0.14 * p : 1.14 - 0.14 * p;
    const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][i % 4];
    const pan = (p - 0.5) * 0.06 * box;
    const sz = box * z, cx = bx + box / 2 + dir[0] * pan, cy = by + box / 2 + dir[1] * pan;
    g.drawImage(im, cx - sz / 2, cy - sz / 2, sz, sz);
  } else { g.fillStyle = "#ddd"; g.fillRect(bx, by, box, box); }
  g.restore();
  // 자막
  if (opt.subtitles && s.ko) {
    g.font = `34px ${P.font}`; g.textAlign = "center"; g.textBaseline = "top";
    const lines = wrapLines(g, s.ko, W - 120).slice(0, 4);
    const lh = 50, top = by + box + 60, hgt = lines.length * lh + 36;
    g.fillStyle = opt.night ? "rgba(38,43,82,.82)" : "rgba(255,255,255,.82)"; rrect(g, 40, top - 18, W - 80, hgt, 24); g.fill();
    g.fillStyle = opt.night ? "#EDE9F7" : "#3B2F2A";
    lines.forEach((l, k) => g.fillText(l, W / 2, top + k * lh));
  }
  g.globalAlpha = 1;
}

export function drawFrame(g, P, t, opt, book) {
  g.fillStyle = opt.night ? "#1E2240" : "#FFF8EE"; g.fillRect(0, 0, W, H);
  const on = []; P.sc.forEach((s, i) => { if (t >= s.a && t < s.b) on.push(i); });
  if (!on.length) on.push(t < 0 ? 0 : P.sc.length - 1);
  on.forEach((i, k) => {
    const s = P.sc[i];
    const a = k === 0 ? 1 : ease((t - s.a) / XF);
    drawScene(g, P, i, t, a, opt);
  });
  // 제목(위)과 쪽수
  g.textAlign = "center"; g.textBaseline = "middle";
  let fs = 44; g.font = `${fs}px ${P.titleFont}`;
  while (fs > 26 && g.measureText(book.title || "").width > W - 80) { fs -= 2; g.font = `${fs}px ${P.titleFont}`; }
  g.fillStyle = opt.night ? "#EDE9F7" : "#3B2F2A";
  g.fillText(book.title || "", W / 2, 110, W - 60);
  let cur = P.sc.findIndex((s) => t >= s.start && t < s.end); if (cur < 0) cur = t <= 0 ? 0 : P.sc.length - 1;
  g.font = `26px ${P.font}`; g.fillStyle = opt.night ? "#B9B4DA" : "#7A6458";
  g.fillText(`${cur + 1} / ${P.sc.length}`, W / 2, H - 70);
  // 처음·끝 살짝 어둡게 열고 닫기
  const fade = Math.min(1, t / 0.5, (P.total - t) / 0.6);
  if (fade < 1) { g.fillStyle = `rgba(0,0,0,${(1 - Math.max(0, fade)) * 0.9})`; g.fillRect(0, 0, W, H); }
}

// ---------- 소리 ----------
async function decodeAudio(blob, rate) {
  const buf = await blob.arrayBuffer();
  const tmp = new (window.AudioContext || window.webkitAudioContext)();
  const src = await tmp.decodeAudioData(buf.slice(0));
  tmp.close && tmp.close();
  const len = Math.ceil(src.duration * rate);
  const off = new OfflineAudioContext(1, len, rate);
  const node = off.createBufferSource(); node.buffer = src; node.connect(off.destination); node.start();
  return await off.startRendering();
}

// ---------- 1순위: WebCodecs → MP4 ----------
async function pickVideoCodec() {
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42e028", "avc1.42001f"]) {
    const cfg = { codec, width: W, height: H, bitrate: 2_000_000, framerate: FPS, avc: { format: "avc" } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch {}
  }
  return null;
}
async function pickAudioCodec() {
  for (const [codec, mux] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
    const cfg = { codec, sampleRate: AR, numberOfChannels: 1, bitrate: 96000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux }; } catch {}
  }
  return null;
}

async function encodeMp4(book, opt, onProgress, signal) {
  const vcfg = await pickVideoCodec(), acfg = await pickAudioCodec();
  if (!vcfg || !acfg) throw new Error("no-webcodecs-codec");
  const P = await prepare(book, opt);
  const audio = await decodeAudio(book.audio, AR);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, fastStart: "in-memory", firstTimestampBehavior: "offset",
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    audio: { codec: acfg.mux, sampleRate: AR, numberOfChannels: 1 } });
  let fail = null;
  const ve = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { fail = e; } });
  ve.configure(vcfg);
  const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { fail = e; } });
  ae.configure(acfg.cfg);
  // 소리: 전체 길이(+꼬리 무음)를 0.1초 조각으로
  const totalSamples = Math.ceil(P.total * AR), pcm = audio.getChannelData(0), CH = 4800;
  for (let off = 0; off < totalSamples; off += CH) {
    const nF = Math.min(CH, totalSamples - off), data = new Float32Array(nF);
    if (off < pcm.length) data.set(pcm.subarray(off, Math.min(pcm.length, off + nF)));
    const ad = new AudioData({ format: "f32-planar", sampleRate: AR, numberOfFrames: nF, numberOfChannels: 1, timestamp: Math.round(off / AR * 1e6), data });
    ae.encode(ad); ad.close();
  }
  // 그림: 한 프레임씩 그려서 인코딩
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d", { alpha: false });
  const frames = Math.ceil(P.total * FPS);
  for (let f = 0; f < frames; f++) {
    if (signal && signal.aborted) { try { ve.close(); ae.close(); } catch {} throw new DOMException("취소", "AbortError"); }
    if (fail) throw fail;
    drawFrame(g, P, f / FPS, opt, book);
    const vf = new VideoFrame(cv, { timestamp: Math.round(f * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    ve.encode(vf, { keyFrame: f % (FPS * 2) === 0 }); vf.close();
    while (ve.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
    if (f % 15 === 0) { onProgress && onProgress(f / frames); await new Promise((r) => setTimeout(r, 0)); }
  }
  await ve.flush(); await ae.flush();
  if (fail) throw fail;
  muxer.finalize(); ve.close(); ae.close();
  onProgress && onProgress(1);
  return { blob: new Blob([target.buffer], { type: "video/mp4" }), mime: "video/mp4", ext: "mp4",
    engine: `WebCodecs ${vcfg.codec} + ${acfg.cfg.codec}` };
}

// ---------- 2순위: MediaRecorder(실시간) ----------
function pickRecMime() {
  for (const m of ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return "";
}
async function recordRealtime(book, opt, onProgress, signal) {
  const P = await prepare(book, opt);
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await ac.decodeAudioData(await book.audio.arrayBuffer());
  const dest = ac.createMediaStreamDestination();
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d", { alpha: false });
  drawFrame(g, P, 0, opt, book);
  const stream = new MediaStream([...cv.captureStream(FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = pickRecMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 3_000_000 } : undefined);
  const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  await ac.resume();
  rec.start(1000);
  const node = ac.createBufferSource(); node.buffer = audio; node.connect(dest);
  const t0 = ac.currentTime + 0.05; node.start(t0);
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (signal && signal.aborted) { reject(new DOMException("취소", "AbortError")); return; }
      const t = ac.currentTime - t0;
      drawFrame(g, P, Math.max(0, t), opt, book);
      onProgress && onProgress(Math.min(1, t / P.total));
      if (t >= P.total) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }).finally(() => { try { rec.stop(); } catch {} });
  await done; ac.close();
  const type = (rec.mimeType || mime || "video/webm").split(";")[0];
  return { blob: new Blob(chunks, { type }), mime: type, ext: type.includes("mp4") ? "mp4" : "webm", engine: `MediaRecorder ${rec.mimeType || mime}` };
}

/** 그림책 → 영상. opt: {subtitles, night, force:'recorder'} */
export async function makeMovie(book, opt = {}, onProgress, signal) {
  const sup = movieSupport();
  if (sup.webcodecs && opt.force !== "recorder") {
    try { return await encodeMp4(book, opt, onProgress, signal); }
    catch (e) { if (e.name === "AbortError") throw e; console.warn("WebCodecs 실패, 실시간 녹화로 바꿈:", e); }
  }
  if (sup.recorder) return await recordRealtime(book, opt, onProgress, signal);
  throw new Error("이 기기 브라우저는 영상 만들기를 지원하지 않아요. 최신 Chrome에서 해 주세요.");
}

// ---------- 저장·공유 ----------
const isApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
function plugin(name) { const C = window.Capacitor; return (C && C.Plugins && C.Plugins[name]) || (C && C.registerPlugin ? C.registerPlugin(name) : null); }
function b64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
export function movieFileName(book, movie) { return `${(book.title || "그림책").replace(/[\\/:*?"<>|]+/g, " ").trim()}.${movie.ext}`; }

/** 공유(또는 내려받기). 반환: 'shared' | 'downloaded' | 'saved-app' */
export async function shareMovie(book, movie) {
  const name = movieFileName(book, movie);
  if (isApp()) {
    // 앱: 캐시 폴더에 파일로 쓰고 안드로이드 공유 창 열기(갤러리·드라이브·카톡 등에 저장/보내기)
    const FS = plugin("Filesystem"), SH = plugin("Share");
    if (!FS || !SH) throw new Error("앱에 공유 기능이 없어요. 앱을 최신 버전으로 업데이트해 주세요.");
    const u8 = new Uint8Array(await movie.blob.arrayBuffer()), path = "movies/" + name, STEP = 3 * 1024 * 1024;
    for (let i = 0; i < u8.length; i += STEP) {
      const part = b64(u8.subarray(i, i + STEP));
      if (i === 0) await FS.writeFile({ path, data: part, directory: "CACHE", recursive: true });
      else await FS.appendFile({ path, data: part, directory: "CACHE" });
    }
    const { uri } = await FS.getUri({ path, directory: "CACHE" });
    await SH.share({ title: book.title, files: [uri], dialogTitle: "영상 저장하거나 보내기" });
    return "shared";
  }
  const file = new File([movie.blob], name, { type: movie.mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: book.title }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return "downloaded";
}
