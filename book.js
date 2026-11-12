// M2: 받아쓴 글 → 장면 → 주인공 → 8컷 → 그림책(저장·보기·아이 모드)
import { makeMovie, shareMovie, movieSupport } from "./movie.js";
import { splitWithGroq, splitRule, computeTiming, characterPrompt, panelPrompt, SCENES } from "./story.js";
import { generateWithRetry, shrink, QuotaError } from "./imagegen.js";
import { saveBook, listBooks, getBook, deleteBook, toWav, persist } from "./books.js";

const $ = (id) => document.getElementById(id);
let ctx = null; // { askPin, getTake, getResult, loadKey }
const mk = { draft: null, ref: null, refSeed: 0, panels: [], abort: null, running: false, baseSeed: 0 };
const urls = new Set();
const url = (b) => { const u = URL.createObjectURL(b); urls.add(u); return u; };
const rnd = () => Math.floor(Math.random() * 2_000_000_000);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function err(t) { $("bookErr").textContent = t || ""; $("bookErr").hidden = !t; }

// ---------- 1) 장면 나누기 ----------
async function doSplit() {
  err("");
  const text = $("transcript").value.trim();
  if (!text) { err("먼저 2단계에서 받아쓰기를 해 주세요."); return; }
  const key = await ctx.loadKey("groq").catch(() => "");
  $("btnSplit").disabled = true;
  try {
    let d;
    if (key) {
      $("splitNote").textContent = "Groq로 장면을 나누는 중… (몇 초)";
      try { d = await splitWithGroq(text, key); }
      catch (e) { d = splitRule(text); d.warn = e.message + " → 대신 문장 기준으로 나눴어요."; }
    } else d = splitRule(text);
    if (!d.scenes.length) throw new Error("나눌 문장이 없어요.");
    mk.draft = d;
    renderScenes();
    const n = d.scenes.length;
    $("splitNote").textContent = (d.engine === "groq" ? "Groq가 장면과 그림 설명을 만들었어요." : d.warn ? "" : "문장 기준으로 나눴어요(무료·기기 안). 부모 설정에 Groq 키를 넣으면 그림 설명까지 자동으로 써 줘요.")
      + (n < SCENES ? ` 이야기가 짧아서 ${n}장면이 됐어요.` : "") + (d.warn ? (d.engine === "groq" ? "\n" : "") + d.warn : "");
    $("sceneWrap").hidden = false; $("charWrap").hidden = true; $("panelWrap").hidden = true;
    $("sceneWrap").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { err(e.message); $("splitNote").textContent = ""; }
  finally { $("btnSplit").disabled = false; }
}
function renderScenes() {
  const d = mk.draft;
  $("bookTitleIn").value = d.title || "";
  $("charIn").value = d.character_en || "";
  $("charKo").textContent = d.character_ko ? "한국어로: " + d.character_ko : "";
  const ol = $("sceneList"); ol.innerHTML = "";
  d.scenes.forEach((s, i) => {
    const li = document.createElement("li"); li.className = "scene";
    li.innerHTML = `<div class="scene-head"><span class="num">${i + 1}</span><span class="muted small">장면 ${i + 1}</span></div>
      <textarea class="s-ko" rows="2" aria-label="장면 ${i + 1} 글">${esc(s.ko)}</textarea>
      <details><summary>그림 설명 <small class="muted">(영어가 가장 잘 돼요)</small></summary>
        <textarea class="s-en" rows="2" placeholder="비워 두면 위 글로 그려요. 예: the main character jumping into a puddle in a rainy forest" aria-label="장면 ${i + 1} 그림 설명">${esc(s.en)}</textarea>
        <label class="mini">옷이 바뀌는 장면이면 적어 주세요 <small class="muted">(예: pajamas)</small></label>
        <input class="s-outfit" type="text" value="${esc(s.outfit || "")}" placeholder="평소 옷이면 비워 두기" aria-label="장면 ${i + 1} 옷">
      </details>`;
    ol.append(li);
  });
}
function readScenes() {
  const d = mk.draft;
  d.title = $("bookTitleIn").value.trim() || "우리 그림책";
  d.character_en = $("charIn").value.trim();
  [...$("sceneList").children].forEach((li, i) => {
    const s = d.scenes[i];
    s.ko = li.querySelector(".s-ko").value.trim();
    s.en = li.querySelector(".s-en").value.trim();
    s.outfit = li.querySelector(".s-outfit").value.trim() || null;
  });
  return d;
}

// ---------- 2) 주인공 ----------
async function token() { return (await ctx.loadKey("hf").catch(() => "")) || ""; }
function tokenNote(t) { return t ? "" : "\n(부모 설정에 Hugging Face 토큰이 없어서 하루 사용량이 아주 적어요. 무료 토큰을 넣으면 훨씬 많이 그릴 수 있어요.)"; }

async function drawCharacter() {
  err("");
  const d = readScenes();
  if (!d.character_en) { err("‘주인공 모습’을 적어 주세요. 예: 노란 우비와 빨간 장화를 신은 하얀 아기 토끼 여자아이"); $("charIn").focus(); return; }
  if (d.scenes.some((s) => !s.ko)) { err("빈 장면이 있어요. 글을 채워 주세요."); return; }
  const t = await token();
  $("charWrap").hidden = false; $("panelWrap").hidden = true;
  $("btnCharOk").disabled = true; $("btnCharAgain").disabled = true; $("btnChar").disabled = true;
  $("charImg").hidden = true; $("charState").className = "slot-state run";
  $("charState").textContent = "주인공을 그리는 중… (보통 10~40초)" + tokenNote(t);
  $("charWrap").scrollIntoView({ behavior: "smooth", block: "start" });
  mk.refSeed = rnd(); mk.abort = new AbortController();
  try {
    const blob = await generateWithRetry({ prompt: characterPrompt(d.character_en), seed: mk.refSeed, width: 768, height: 768, token: t },
      { signal: mk.abort.signal, onWait: (s, a) => { $("charState").textContent = `무료 사용량을 잠시 다 썼어요. ${s}초 뒤 다시 시도해요 (${a}번째 실패).`; } });
    mk.charBlob = blob;
    $("charImg").src = url(blob); $("charImg").hidden = false;
    $("charState").className = "slot-state ok"; $("charState").textContent = "마음에 들면 ‘이 주인공으로 정하기’, 아니면 ‘다시 그리기’를 눌러 주세요.";
    $("btnCharOk").disabled = false;
  } catch (e) {
    $("charState").className = "slot-state bad";
    $("charState").textContent = (e.name === "AbortError" ? "멈췄어요." : e.message) + " ‘다시 그리기’를 눌러 주세요.";
  } finally { $("btnCharAgain").disabled = false; $("btnChar").disabled = false; }
}

// ---------- 3) 8컷 ----------
async function approveCharacter() {
  mk.ref = await shrink(mk.charBlob, 512);
  mk.baseSeed = rnd();
  mk.panels = mk.draft.scenes.map(() => ({ status: "queue", blob: null, msg: "", seedBump: 0 }));
  $("panelWrap").hidden = false;
  renderPanels();
  $("panelWrap").scrollIntoView({ behavior: "smooth", block: "start" });
  runPanels();
}
function renderPanels() {
  const ol = $("panelGrid"); ol.innerHTML = "";
  mk.panels.forEach((p, i) => {
    const li = document.createElement("li"); li.className = "panel " + p.status; li.dataset.i = i;
    const label = { queue: "기다리는 중", run: "그리는 중…", wait: p.msg, ok: "완성", fail: p.msg || "실패" }[p.status] || "";
    const short = { queue: "대기", run: "그리는 중", wait: "다시 시도 대기", ok: "완성", fail: "실패" }[p.status] || "";
    li.innerHTML = `<div class="ph">${p.blob && p.status === "ok" ? `<img alt="장면 ${i + 1} 그림" src="${url(p.blob)}">` : `<span class="ph-label">${esc(label)}</span>`}</div>
      <div class="pmeta"><b>${i + 1}</b><span class="small ${p.status === "fail" ? "bad" : "muted"}">${esc(short)}</span>
      ${p.status === "ok" ? `<button class="ghost tiny redo" data-i="${i}">다시 그리기</button>` : ""}
      ${p.status === "fail" ? `<button class="primary tiny redo" data-i="${i}">다시 시도</button>` : ""}</div>`;
    ol.append(li);
  });
  const done = mk.panels.filter((p) => p.status === "ok").length, failed = mk.panels.filter((p) => p.status === "fail").length;
  $("panelProg").max = mk.panels.length; $("panelProg").value = done;
  $("panelProgText").textContent = `${done} / ${mk.panels.length} 완성` + (failed ? ` · 실패 ${failed}` : "");
  $("btnSaveBook").disabled = done !== mk.panels.length || mk.running;
  $("btnStop").hidden = !mk.running;
  $("btnRetryAll").hidden = mk.running || !failed;
  $("saveHint").textContent = failed && !mk.running ? "실패한 장면은 ‘다시 시도’를 눌러 주세요. 모든 장면이 완성되어야 저장할 수 있어요." : "";
}
async function drawPanel(i, t) {
  const p = mk.panels[i], s = mk.draft.scenes[i];
  p.status = "run"; p.msg = ""; renderPanels();
  try {
    p.blob = await generateWithRetry(
      { prompt: panelPrompt(s, mk.draft.character_en, true), refBlob: mk.ref, seed: mk.baseSeed + i + p.seedBump * 1000, width: 768, height: 768, token: t },
      { signal: mk.abort.signal, onWait: (sec) => { p.status = "wait"; p.msg = `사용량 초과 · ${sec}초 뒤 다시`; renderPanels(); } });
    p.status = "ok"; p.msg = "";
  } catch (e) {
    p.status = "fail"; p.blob = null;
    p.msg = e.name === "AbortError" ? "멈췄어요" : e instanceof QuotaError ? "무료 그림 사용량을 다 썼어요" : e.message;
    renderPanels();
    return e instanceof QuotaError ? "quota" : "fail";
  }
  renderPanels();
  return "ok";
}
async function runPanels(only = null) {
  if (mk.running) return;
  mk.running = true; mk.abort = new AbortController();
  const t = await token();
  $("panelNote").textContent = "한 장에 보통 10~40초 걸려요. 화면을 켜 둔 채로 기다려 주세요." + tokenNote(t);
  try {
    const list = only != null ? [only] : mk.panels.map((_, i) => i).filter((i) => mk.panels[i].status !== "ok");
    for (const i of list) {
      if (mk.abort.signal.aborted) break;
      if ((await drawPanel(i, t)) === "quota") { // 계속 시도해도 실패만 쌓이므로 멈춤
        $("panelNote").textContent = "무료 그림 사용량(Hugging Face GPU 시간)을 다 써서 멈췄어요. 완성된 장면은 그대로 두고, 나중에(보통 몇 시간~하루 뒤) ‘실패한 장면 모두 다시 그리기’를 눌러 주세요." + tokenNote(t);
        for (const p of mk.panels) if (p.status === "queue") { p.status = "fail"; p.msg = "사용량 초과로 멈춤"; }
        break;
      }
    }
    for (const p of mk.panels) if (p.status === "queue" || p.status === "run" || p.status === "wait") { p.status = "fail"; p.msg = "멈췄어요"; }
  } finally { mk.running = false; renderPanels(); }
}

// ---------- 4) 저장 ----------
async function saveCurrent() {
  const take = ctx.getTake();
  if (!take) { err("녹음이 없어요. 먼저 녹음하거나 파일을 올려 주세요."); return; }
  $("btnSaveBook").disabled = true; $("saveHint").textContent = "그림책을 저장하는 중…";
  try {
    const { wav, duration } = await toWav(take);
    const res = ctx.getResult() || {};
    // 그림을 그리는 동안 부모가 고친 제목·장면 글도 반영(그림 설명·옷은 그린 그대로 둠)
    mk.draft.title = $("bookTitleIn").value.trim() || mk.draft.title || "우리 그림책";
    [...$("sceneList").children].forEach((li, i) => { const v = li.querySelector(".s-ko").value.trim(); if (v && mk.draft.scenes[i]) mk.draft.scenes[i].ko = v; });
    const { scenes, mode } = computeTiming(mk.draft.scenes, res.segs || [], duration);
    const book = {
      id: "b" + Date.now(), createdAt: Date.now(), title: mk.draft.title, audio: wav, duration, timingMode: mode, engine: res.engine || "",
      character: { desc: mk.draft.character_en, ref: mk.ref },
      scenes: scenes.map((s, i) => ({ ko: s.ko, en: s.en, outfit: s.outfit, start: s.start, end: s.end, image: mk.panels[i].blob })),
    };
    await saveBook(book); persist();
    $("saveHint").textContent = "저장했어요! 인터넷이 없어도 ‘내 그림책’에서 다시 볼 수 있어요.";
    await renderLibrary();
    openViewer(book.id);
  } catch (e) {
    $("saveHint").textContent = "저장하지 못했어요: " + (e.message || e);
    $("btnSaveBook").disabled = false;
  }
}

// ---------- 내 그림책 ----------
export async function renderLibrary() {
  let books = [];
  try { books = await listBooks(); } catch {}
  const ul = $("bookList"); ul.innerHTML = "";
  $("libEmpty").hidden = books.length > 0;
  for (const b of books) {
    const li = document.createElement("li"); li.className = "book";
    const cover = b.scenes[0] && b.scenes[0].image;
    li.innerHTML = `<button class="book-open" data-id="${b.id}" aria-label="${esc(b.title)} 보기">
        ${cover ? `<img alt="" src="${url(cover)}">` : `<span class="noimg">그림 없음</span>`}
        <span class="book-title">${esc(b.title)}</span>
        <span class="muted tiny-t">${new Date(b.createdAt).toLocaleDateString("ko-KR")} · ${b.scenes.length}장면 · ${Math.round(b.duration)}초</span>
      </button>
      ${b.movie ? `<button class="ghost tiny mv" data-id="${b.id}" aria-label="${esc(b.title)} 영상 보기">영상 보기</button>` : ""}
      <button class="ghost tiny del parent-only" data-id="${b.id}" aria-label="${esc(b.title)} 지우기">지우기</button>`;
    ul.append(li);
  }
}

// ---------- 보기(뷰어) ----------
const V = { book: null, i: 0, auto: false, audio: null, raf: 0, stopAt: 0, playing: false, scrollT: 0 };
export async function openViewer(id) {
  const b = await getBook(id);
  if (!b) return;
  V.book = b; V.i = 0; V.auto = false;
  V.audio = $("vAudio"); V.audio.src = url(b.audio);
  $("vTitle").textContent = b.title;
  const tr = $("vTrack"); tr.innerHTML = "";
  b.scenes.forEach((s, i) => {
    const sec = document.createElement("section"); sec.className = "vpage"; sec.dataset.i = i;
    sec.setAttribute("aria-label", `${i + 1}쪽`);
    sec.innerHTML = `<div class="vimg">${s.image ? `<img alt="${i + 1}쪽 그림" src="${url(s.image)}">` : `<span class="noimg">그림 없음</span>`}</div>
      <p class="vtext">${esc(s.ko)}</p>`;
    tr.append(sec);
  });
  $("vTiming").textContent = b.timingMode === "timestamps" ? "" : "소리 구간은 글자 수 비율로 나눈 대략치예요.";
  $("vMovie").hidden = document.body.classList.contains("child") && !b.movie;
  $("viewer").hidden = false; document.body.classList.add("noscroll");
  tr.scrollLeft = 0; setPage(0, false); updateAutoBtn();
}
function closeViewer() { stopAudio(); V.auto = false; $("viewer").hidden = true; document.body.classList.remove("noscroll"); }
function setPage(i, scroll = true) {
  const n = V.book.scenes.length; i = Math.max(0, Math.min(n - 1, i)); V.i = i;
  $("vPage").textContent = `${i + 1} / ${n}`;
  $("vPrev").disabled = i === 0; $("vNext").disabled = i === n - 1;
  if (scroll) { const tr = $("vTrack"); tr.scrollTo({ left: i * tr.clientWidth, behavior: "smooth" }); }
  [...$("vTrack").children].forEach((p, k) => p.classList.toggle("on", k === i));
  updateSeg(0);
}
function updateSeg(frac) { $("vSeg").style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + "%"; }
function stopAudio() { cancelAnimationFrame(V.raf); if (V.audio) V.audio.pause(); V.playing = false; $("vPlay").classList.remove("on"); $("vPlay").setAttribute("aria-label", "이 쪽 듣기"); }
function playPage(i) {
  const s = V.book.scenes[i]; if (!s) return;
  stopAudio();
  const a = V.audio; a.currentTime = s.start; V.playing = true;
  $("vPlay").classList.add("on"); $("vPlay").setAttribute("aria-label", "멈추기");
  a.play().catch(() => stopAudio());
  const tick = () => {
    if (!V.playing) return;
    const len = Math.max(0.1, s.end - s.start);
    updateSeg((a.currentTime - s.start) / len);
    if (a.currentTime >= s.end - 0.03 || a.ended) {
      stopAudio(); updateSeg(1);
      if (V.auto && i < V.book.scenes.length - 1) setTimeout(() => { if (V.auto) { setPage(i + 1); playPage(i + 1); } }, 700);
      else if (V.auto) { V.auto = false; updateAutoBtn(); }
      return;
    }
    V.raf = requestAnimationFrame(tick);
  };
  V.raf = requestAnimationFrame(tick);
}
function updateAutoBtn() { $("vAuto").classList.toggle("on", V.auto); $("vAuto").setAttribute("aria-pressed", String(V.auto)); $("vAutoLabel").textContent = V.auto ? "자동 넘기기 켜짐" : "자동 넘기기"; }

// ---------- 짧은 영상(M3) ----------
const M = { abort: null, url: "" };
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.round(n / 1024) + "KB"; }
function showMovie() {
  const mv = V.book && V.book.movie, vid = $("mVideo");
  if (M.url) { URL.revokeObjectURL(M.url); M.url = ""; }
  if (mv) {
    M.url = URL.createObjectURL(mv.blob); vid.src = M.url + "#t=0.8"; /* 첫 화면이 어둡지 않게 */ vid.hidden = false; $("mEmpty").hidden = true;
    $("mInfo").textContent = `${mv.ext.toUpperCase()} · ${fmtSize(mv.blob.size)}`;
    $("mMake").textContent = "다시 만들기"; $("mShare").hidden = false; $("mSubs").checked = mv.subtitles !== false;
  } else {
    vid.removeAttribute("src"); vid.hidden = true; $("mEmpty").hidden = false; $("mInfo").textContent = "";
    $("mEmpty").textContent = document.body.classList.contains("child") ? "아직 영상이 없어요." : "아직 영상이 없어요. 아래 ‘영상 만들기’를 눌러 주세요.";
    $("mMake").textContent = "영상 만들기"; $("mShare").hidden = true;
  }
}
export function openMovie() {
  if (!V.book) return;
  stopAudio(); V.auto = false; updateAutoBtn();
  $("mTitle").textContent = V.book.title + " · 영상";
  const sup = movieSupport();
  if (!sup.webcodecs && !sup.recorder) $("mNote").textContent = "이 브라우저는 영상 만들기를 지원하지 않아요. 최신 Chrome에서 해 주세요.";
  showMovie(); $("movie").hidden = false;
}
function closeMovie() { if (M.abort) M.abort.abort(); const v = $("mVideo"); v.pause(); $("movie").hidden = true; }
async function doMakeMovie() {
  if (!V.book || M.abort) return;
  const book = V.book; M.abort = new AbortController();
  $("mMake").disabled = true; $("mShare").disabled = true; $("mCancel").hidden = false; $("mProg").hidden = false; $("mProg").value = 0;
  $("mNote").textContent = "영상을 만드는 중… 화면을 켜 둔 채로 기다려 주세요.";
  const t0 = performance.now();
  try {
    const res = await makeMovie(book, { subtitles: $("mSubs").checked, night: document.documentElement.dataset.theme === "night" },
      (f) => { $("mProg").value = f; $("mNote").textContent = `영상을 만드는 중… ${Math.round(f * 100)}%`; }, M.abort.signal);
    book.movie = { blob: res.blob, mime: res.mime, ext: res.ext, engine: res.engine, subtitles: $("mSubs").checked, createdAt: Date.now() };
    await saveBook(book); persist();
    showMovie(); renderLibrary();
    $("mNote").textContent = `다 만들었어요! (${((performance.now() - t0) / 1000).toFixed(0)}초 · ${res.ext.toUpperCase()}) 이 기기에 저장돼서 아이 모드에서도 볼 수 있어요. ‘저장·공유’로 갤러리·카톡 등에 보낼 수 있어요.`;
  } catch (e) {
    $("mNote").textContent = e.name === "AbortError" ? "멈췄어요." : "영상을 만들지 못했어요: " + (e.message || e);
  } finally {
    M.abort = null; $("mMake").disabled = false; $("mShare").disabled = false; $("mCancel").hidden = true; $("mProg").hidden = true;
  }
}
async function doShareMovie() {
  if (!V.book || !V.book.movie) return;
  try {
    const r = await shareMovie(V.book, V.book.movie);
    $("mNote").textContent = r === "downloaded" ? "영상 파일을 내려받았어요." : r === "shared" ? "공유 창을 열었어요." : "";
  } catch (e) { $("mNote").textContent = "저장·공유하지 못했어요: " + (e.message || e); }
}

// ---------- 아이 모드 ----------
export function applyChild(on) {
  document.body.classList.toggle("child", on);
  localStorage.setItem("sv-child", on ? "1" : "0");
  $("btnChild").textContent = on ? "부모 모드로" : "아이 모드";
  $("btnChild").setAttribute("aria-label", on ? "부모 모드로 돌아가기(PIN 필요)" : "아이 모드 켜기");
}

export function initBook(c) {
  ctx = c;
  $("btnSplit").onclick = doSplit;
  $("btnChar").onclick = drawCharacter;
  $("btnCharAgain").onclick = drawCharacter;
  $("btnCharOk").onclick = approveCharacter;
  $("btnStop").onclick = () => mk.abort && mk.abort.abort();
  $("btnRetryAll").onclick = () => runPanels();
  $("btnSaveBook").onclick = saveCurrent;
  $("panelGrid").onclick = (e) => {
    const b = e.target.closest(".redo"); if (!b || mk.running) return;
    const i = +b.dataset.i; if (mk.panels[i].status === "ok") mk.panels[i].seedBump++;
    runPanels(i);
  };
  $("bookList").onclick = async (e) => {
    const o = e.target.closest(".book-open"); if (o) return openViewer(o.dataset.id);
    const mvb = e.target.closest(".mv"); if (mvb) { await openViewer(mvb.dataset.id); return openMovie(); }
    const d = e.target.closest(".del");
    if (d && !document.body.classList.contains("child") && confirm("이 그림책을 지울까요? 되돌릴 수 없어요.")) { await deleteBook(d.dataset.id); renderLibrary(); }
  };
  $("vClose").onclick = closeViewer;
  $("vMovie").onclick = openMovie;
  $("mClose").onclick = closeMovie;
  $("mMake").onclick = doMakeMovie;
  $("mShare").onclick = doShareMovie;
  $("mCancel").onclick = () => M.abort && M.abort.abort();
  $("vPrev").onclick = () => { V.auto = false; updateAutoBtn(); stopAudio(); setPage(V.i - 1); };
  $("vNext").onclick = () => { V.auto = false; updateAutoBtn(); stopAudio(); setPage(V.i + 1); };
  $("vPlay").onclick = () => { if (V.playing) { stopAudio(); V.auto = false; updateAutoBtn(); } else playPage(V.i); };
  $("vAuto").onclick = () => { V.auto = !V.auto; updateAutoBtn(); if (V.auto) playPage(V.i); else stopAudio(); };
  $("vTrack").addEventListener("scroll", () => {
    clearTimeout(V.scrollT);
    V.scrollT = setTimeout(() => {
      const tr = $("vTrack"); const i = Math.round(tr.scrollLeft / tr.clientWidth);
      if (i !== V.i) { const wasAuto = V.auto; stopAudio(); setPage(i, false); if (wasAuto) playPage(i); }
    }, 120);
  });
  document.addEventListener("keydown", (e) => {
    if (!$("movie").hidden) { if (e.key === "Escape") closeMovie(); return; }
    if ($("viewer").hidden) return;
    if (e.key === "ArrowRight") $("vNext").click(); else if (e.key === "ArrowLeft") $("vPrev").click(); else if (e.key === "Escape") closeViewer();
  });
  $("btnChild").onclick = async () => {
    const on = document.body.classList.contains("child");
    if (!on) { applyChild(true); window.scrollTo(0, 0); }
    else if (await ctx.askPin()) applyChild(false);
  };
  applyChild(localStorage.getItem("sv-child") === "1");
  renderLibrary();
}
window.__svBook = { mk, V, openViewer, renderLibrary, renderPanels, openMovie }; // 자동 점검용
