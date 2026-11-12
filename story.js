// 받아쓴 글 → 그림책 8장면. Groq LLM(사용자 키, 무료 등급) 우선, 키가 없으면 규칙 기반.
export const SCENES = 8;
export const STYLE_EN = "soft warm watercolor children's picture book illustration, gentle paper texture, warm pastel colors, cozy, hand-painted, no text, no letters, no watermark";

const OUTFIT_WORDS = [
  [/잠옷|파자마/, "cozy pajamas"], [/수영복/, "a swimsuit"], [/한복/, "a colorful hanbok"], [/드레스/, "a pretty dress"],
  [/우주복/, "a spacesuit"], [/교복/, "a school uniform"], [/잠바|패딩|외투|코트/, "a warm winter coat"], [/목욕/, "nothing but a bath towel"],
];
export function guessOutfit(ko) {
  for (const [re, en] of OUTFIT_WORDS) if (re.test(ko)) return en;
  return null;
}

// ---------- 규칙 기반 ----------
export function sentences(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  // 1) 문장부호 뒤 2) 한국어 종결 어미(…어요/…다 등) 뒤 공백에서 자르기. '다람쥐'처럼 단어 중간은 자르지 않음.
  const re = /([.!?。…]+["”’']?)\s+|((?:어요|아요|에요|예요|해요|여요|지요|네요|래요|세요|죠|었다|았다|였다|했다|한다|니다|단다|란다)[.!?]?["”’']?)\s+(?=["“‘']?[가-힣])/g;
  const out = []; let last = 0, m;
  while ((m = re.exec(t))) {
    const end = m.index + (m[1] || m[2]).length;
    out.push(t.slice(last, end).trim()); last = re.lastIndex;
  }
  if (last < t.length) out.push(t.slice(last).trim());
  return out.filter(Boolean);
}
const clen = (s) => String(s).replace(/[\s.,!?"“”'‘’…~·]/g, "").length;

export function toN(list, n = SCENES) {
  let a = list.slice();
  // 너무 적으면 가장 긴 문장을 낱말 경계 가운데서 둘로 나눔
  while (a.length < n) {
    let bi = -1, bl = 0;
    a.forEach((s, i) => { const w = s.split(" ").length; if (w >= 2 && clen(s) > bl) { bl = clen(s); bi = i; } });
    if (bi < 0) break;
    const w = a[bi].split(" "), h = Math.ceil(w.length / 2);
    a.splice(bi, 1, w.slice(0, h).join(" "), w.slice(h).join(" "));
  }
  if (a.length <= n) return a;
  // 많으면 문장을 자르지 않고 순서대로 묶되, 묶음 글자 수가 최대한 고르게(동적 계획법)
  const L = a.map(clen), m = a.length, target = L.reduce((x, y) => x + y, 0) / n;
  const pre = [0]; L.forEach((l, i) => pre.push(pre[i] + l));
  const cost = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  cost[0][0] = 0;
  for (let g = 1; g <= n; g++) for (let j = g; j <= m; j++) for (let i = g - 1; i < j; i++) {
    const c = cost[g - 1][i] + (pre[j] - pre[i] - target) ** 2;
    if (c < cost[g][j]) { cost[g][j] = c; back[g][j] = i; }
  }
  const out = []; let j = m;
  for (let g = n; g >= 1; g--) { const i = back[g][j]; out.unshift(a.slice(i, j).join(" ")); j = i; }
  return out;
}

export function splitRule(text) {
  const parts = toN(sentences(text));
  return {
    engine: "rule",
    title: (parts[0] || "우리 그림책").slice(0, 20),
    character_ko: "", character_en: "",
    scenes: parts.map((ko) => ({ ko, en: "", outfit: guessOutfit(ko) })),
  };
}

// ---------- Groq LLM ----------
const SYS = `You turn a Korean children's story, transcribed from a parent's voice recording (it may contain speech-recognition mistakes), into exactly ${SCENES} picture-book scenes.
Rules:
- Keep the original Korean sentences in their original order. Copy them verbatim; only fix obvious recognition typos. Every sentence goes into exactly one scene. Never drop, repeat, summarize or invent story text. Scenes should be roughly balanced in length.
- For each scene write "en": an English image prompt (1-2 sentences) describing only what is visible: setting, action, other characters, mood, time of day. Refer to the main character as "the main character". Do NOT describe the main character's looks there. No text or letters in the image.
- Identify the single main character and write "character_en": a fixed, concrete English visual description (species or human, age, body, colors, hair/fur, eyes, default clothing with colors, one distinctive feature). If the story does not say, invent consistent cute details suitable for a toddler picture book. Also give "character_ko" (the same in Korean, short).
- "outfit": if in that scene the main character clearly wears something different from the default clothing (pajamas, swimsuit, ...), write it in English, else null.
- "title": a short Korean title.
Return ONLY JSON: {"title":"...","character_ko":"...","character_en":"...","scenes":[{"ko":"...","en":"...","outfit":null}]}`;

export class GroqError extends Error {}
async function groqFetch(key, body) {
  let r;
  try {
    r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { throw new GroqError("Groq에 연결하지 못했어요. 인터넷 연결을 확인해 주세요."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || "";
    if (r.status === 401) throw new GroqError("Groq 키가 맞지 않아요. 부모 설정에서 gsk_로 시작하는 키를 다시 넣어 주세요.");
    if (r.status === 429) throw new GroqError("Groq 무료 사용량을 잠시 다 썼어요. 1~2분 뒤 다시 해 주세요.");
    const e = new GroqError(`Groq 오류 ${r.status}: ${msg}`); e.status = r.status; throw e;
  }
  return j;
}
function parseJson(s) {
  s = String(s || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return JSON.parse(a >= 0 ? s.slice(a, b + 1) : s);
}
export async function splitWithGroq(text, key, model = "openai/gpt-oss-120b") {
  const base = { model, temperature: 0.3, messages: [{ role: "system", content: SYS }, { role: "user", content: String(text).trim() }] };
  let j;
  try { j = await groqFetch(key, { ...base, response_format: { type: "json_object" }, reasoning_effort: "low" }); }
  catch (e) { if (e.status === 400) j = await groqFetch(key, base); else throw e; } // 일부 옵션을 모르는 모델 대비
  const raw = parseJson(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
  let scenes = (raw.scenes || []).filter((s) => s && s.ko).map((s) => ({ ko: String(s.ko).trim(), en: String(s.en || "").trim(), outfit: s.outfit ? String(s.outfit) : null }));
  if (!scenes.length) throw new GroqError("Groq가 장면을 만들지 못했어요.");
  // 정확히 8개로 맞추기(드물게 개수가 틀릴 때)
  while (scenes.length > SCENES) { // 가장 짧은 이웃끼리 합치기
    let bi = 0, bl = Infinity;
    for (let i = 0; i < scenes.length - 1; i++) { const l = clen(scenes[i].ko) + clen(scenes[i + 1].ko); if (l < bl) { bl = l; bi = i; } }
    const a = scenes[bi], b = scenes[bi + 1];
    scenes.splice(bi, 2, { ko: a.ko + " " + b.ko, en: a.en + " " + b.en, outfit: a.outfit || b.outfit });
  }
  if (scenes.length < SCENES) {
    const parts = toN(scenes.map((s) => s.ko));
    scenes = parts.map((ko) => { const src = scenes.find((s) => s.ko.includes(ko) || ko.includes(s.ko)) || {}; return { ko, en: src.en || "", outfit: src.outfit || guessOutfit(ko) }; });
  }
  return { engine: "groq", title: String(raw.title || "우리 그림책").slice(0, 30), character_ko: String(raw.character_ko || ""), character_en: String(raw.character_en || ""), scenes };
}

// ---------- 그림 프롬프트 ----------
export function characterPrompt(charDesc) {
  return `Character reference sheet: one single full-body front view of the main character, standing, friendly smile, plain light cream background, nothing else in the picture. Main character: ${charDesc}. Style: ${STYLE_EN}.`;
}
export function panelPrompt(scene, charDesc, useRef) {
  const what = scene.en ? scene.en : `An illustration of this moment of a Korean children's story: "${scene.ko}"`;
  const who = useRef
    ? (scene.outfit
      ? `The main character is the same character as in image 1 (same face, species, fur/hair colors, ears and body proportions) but in this scene wearing ${scene.outfit} instead of the usual clothes.`
      : `The main character is exactly the same character as in image 1: identical face, colors, clothing and accessories.`)
    : `The main character: ${charDesc}${scene.outfit ? `, but in this scene wearing ${scene.outfit}` : ""}.`;
  return `${what} ${who} ${useRef ? `(Description of the main character: ${charDesc}${scene.outfit ? ", outfit changed as stated" : ""}.)` : ""} Style: ${STYLE_EN}.`.replace(/\s+/g, " ").trim();
}

// ---------- 장면별 소리 구간 ----------
// segs: [{text,start,end}] (받아쓰기 시간 정보), duration: 전체 길이(초)
export function computeTiming(scenes, segs, duration) {
  const lens = scenes.map((s) => Math.max(1, clen(s.ko)));
  const total = lens.reduce((a, b) => a + b, 0);
  const fr = [0]; lens.forEach((l, i) => fr.push(fr[i] + l / total));
  const good = (segs || []).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start && clen(s.text) > 0);
  let mode = "proportional", map;
  if (good.length >= 2) {
    mode = "timestamps";
    const T = good.reduce((a, s) => a + clen(s.text), 0);
    map = (f) => {
      if (f <= 0) return 0;
      if (f >= 1) return duration;
      let c = f * T;
      for (const s of good) { const l = clen(s.text); if (c <= l) return s.start + (s.end - s.start) * (c / l); c -= l; }
      return duration;
    };
  } else map = (f) => f * duration;
  const out = scenes.map((s, i) => ({ ...s, start: +map(fr[i]).toFixed(2), end: +map(fr[i + 1]).toFixed(2) }));
  // 경계는 다음 장면 시작과 이어지게, 마지막은 끝까지
  for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start;
  if (out.length) { out[0].start = 0; out[out.length - 1].end = duration; }
  return { scenes: out, mode };
}
