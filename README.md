# StoryVoice 웹 · M1 (녹음 + 한국어 받아쓰기)

휴대폰 브라우저용 정적 웹앱. 빌드 없이 이 폴더를 HTTPS로 올리면 동작합니다.

- 녹음: `getUserMedia` + `MediaRecorder`, 권한 상태 안내(요청/거부/미지원), 타이머(90초 상한), 음량 막대, 다시 듣기, 음성 파일 올리기
- 받아쓰기(무료): 기기 안 Whisper(transformers.js 4.3.2, WASM, `onnx-community/whisper-base|small`, q8) — 구간별 시간
- 받아쓰기(무료): 브라우저 Web Speech API 실시간(ko-KR, 지원 브라우저만) — 대략 시간
- 받아쓰기(내 키): OpenAI `whisper-1`(구간·단어 시간), xAI `grok-voice-transcribe-2.0`(단어 시간). 브라우저에서 직접 호출(두 API 모두 CORS 허용 확인, 2026-11-12)
- 키: 부모 PIN 뒤 설정 화면, IndexedDB에 AES-GCM 암호화(내보낼 수 없는 CryptoKey). 서버 없음

로컬 실행: `python3 -m http.server 8787` 후 `http://localhost:8787` (localhost는 보안 컨텍스트로 취급)

반드시 최상위 창에서 열기(iframe 안에서는 마이크가 막힘).
