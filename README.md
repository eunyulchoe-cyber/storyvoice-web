# StoryVoice 웹 · M2 (녹음 → 받아쓰기 → 8장 그림책)

휴대폰 브라우저용 정적 웹앱. 빌드 없이 이 폴더를 HTTPS로 올리면 동작합니다. 서버 없음, 운영자 키 없음.

## M1 · 녹음 + 받아쓰기
- 녹음: `getUserMedia` + `MediaRecorder`(3분 상한), 음량 막대, 다시 듣기, 음성 파일 올리기
- 무료: 기기 안 Whisper(transformers.js, `onnx-community/whisper-base|small`), Web Speech 실시간(앱에서는 꺼짐)
- 무료 내 키: Groq `whisper-large-v3-turbo` / `whisper-large-v3` (verbose_json, 구간 시간) — 무료 등급 하루 28,800초
- 유료 내 키: OpenAI `whisper-1`, xAI `grok-voice-transcribe-2.0`

## M2 · 그림책 (`story.js`, `imagegen.js`, `book.js`, `books.js`)
- 장면 나누기: Groq `openai/gpt-oss-120b`(JSON: 장면 글·영어 그림 설명·옷 변화·주인공 설명). 키가 없으면 규칙 기반(문장 분리 + 글자 수 균형 묶기, 동적 계획법). 부모가 장면 글·그림 설명·옷을 고칠 수 있음
- 그림: FLUX.2 [klein] 4B(Apache-2.0)를 Black Forest Labs의 Hugging Face 공개 데모(ZeroGPU)로 호출. 부모의 무료 HF 토큰을 `x-hf-authorization`으로 보내 그 계정의 무료 GPU 시간 사용. Gradio 큐 API(`/gradio_api/queue/join` + SSE)
  - 주인공 기준 그림 1장 → 부모 승인 → 8장 모두 기준 그림(512px)을 image 1로 넣어 같은 캐릭터 유지
  - 옷이 바뀌는 장면은 "같은 얼굴·털색, 이번엔 ○○ 입음"으로 프롬프트를 바꿈
  - 사용량 초과면 75초 기다렸다 최대 3번 자동 재시도, 그래도 실패하면 그 장면만 ‘실패’ 표시 + 다시 시도. 자리 채움 그림이나 예전 그림으로 대신하지 않음
- 보기: 좌우로 넘기기, 쪽마다 그 장면의 낭독 구간 재생, 자동 넘기기. 구간은 받아쓰기 시간 정보로 계산(없으면 글자 수 비율)
- 저장: IndexedDB `storyvoice-books`(그림 webp + 낭독 WAV) → 인터넷 없이 다시 열림
- 아이 모드: 완성된 책 보기만, 나가려면 부모 PIN

로컬 실행: `python3 -m http.server 8787` 후 `http://localhost:8787`. 반드시 최상위 창에서 열기(iframe 안에서는 마이크가 막힘).
