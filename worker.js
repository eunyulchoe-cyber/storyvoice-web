// 기기 안 Whisper 받아쓰기 (transformers.js, WASM). 음성은 기기 밖으로 나가지 않습니다.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
env.allowLocalModels = false;

let asr = null;
let current = "";

self.onmessage = async (e) => {
  const { type, model, audio } = e.data;
  if (type !== "transcribe") return;
  try {
    if (!asr || current !== model) {
      self.postMessage({ type: "status", text: "모델 내려받는 중… (처음 한 번만)" });
      const files = {};
      asr = await pipeline("automatic-speech-recognition", model, {
        device: "wasm",
        dtype: "q8",
        progress_callback: (p) => {
          if (p.status === "progress" && p.total) {
            files[p.file] = { loaded: p.loaded, total: p.total };
            let l = 0, t = 0;
            for (const f of Object.values(files)) { l += f.loaded; t += f.total; }
            self.postMessage({ type: "progress", pct: Math.round((l / t) * 100), mb: Math.round(t / 1e6) });
          }
        },
      });
      current = model;
    }
    self.postMessage({ type: "status", text: "받아쓰는 중… (기기 성능에 따라 수십 초)" });
    const t0 = performance.now();
    const out = await asr(audio, {
      language: "korean",
      task: "transcribe",
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    self.postMessage({ type: "result", out, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
};
