# StoryVoice 웹 · M3 (녹음 → 받아쓰기 → 8장 그림책 → 짧은 영상)

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
  - 옷이 바뀌는 장면은 "같은 얼굴·털색, 이번엔 ○○만 입음, 기준 그림의 옷·장화는 그리지 않음"으로 프롬프트를 바꿈(잠옷 장면 등)
  - 사용량 초과면 75초 기다렸다 최대 3번 자동 재시도, 그래도 실패하면 그 장면만 ‘실패’ 표시 + 다시 시도. 자리 채움 그림이나 예전 그림으로 대신하지 않음
- 보기: 좌우로 넘기기, 쪽마다 그 장면의 낭독 구간 재생, 자동 넘기기. 구간은 받아쓰기 시간 정보로 계산(없으면 글자 수 비율)
- 저장: IndexedDB `storyvoice-books`(그림 webp + 낭독 WAV) → 인터넷 없이 다시 열림
- 아이 모드: 완성된 책 보기만, 나가려면 부모 PIN

## M3 · 짧은 영상 (`movie.js`, `mp4-muxer.mjs` MIT)
- 보기 화면의 ‘영상’ → 세로 720×1280, 30fps. 장면마다 천천히 확대·이동(켄 번스), 장면 사이 0.7초 교차 전환, 장면 글 자막(끄기 가능), 소리는 저장된 낭독 그대로라 장면 구간과 맞음
- 1순위: WebCodecs(H.264 + AAC, AAC가 없으면 Opus) + mp4-muxer → MP4. 실시간보다 빠름(데스크톱 Chrome에서 50초 영상 약 20초)
- 2순위: MediaRecorder(캔버스 + 오디오 실시간 녹화) → 브라우저가 되면 MP4, 아니면 WebM
- 만든 영상은 그 책과 함께 IndexedDB에 저장 → 아이 모드에서도 ‘영상 보기’로 볼 수 있음(만들기·공유는 부모만)
- 저장·공유: 웹은 공유 창(Web Share) 또는 내려받기, 앱(APK)은 `@capacitor/filesystem`으로 캐시에 쓰고 `@capacitor/share`로 안드로이드 공유 창

로컬 실행: `python3 -m http.server 8787` 후 `http://localhost:8787`. 반드시 최상위 창에서 열기(iframe 안에서는 마이크가 막힘).
