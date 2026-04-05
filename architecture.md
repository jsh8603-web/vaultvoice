# VaultVoice v3 — AI 노트 허브 아키텍처

> **최종 갱신**: 2026-04-04 (인프라 이력 추가 + 통합 계획 수립)

## 핵심 철학
> **어떤 asset이든 텍스트와 쌍이 되어(변환) 저장되어야 한다.**
> 99_vaultvoice는 임시 수신함. Obsidian에서 태깅 → 주제별 폴더로 이동.

---

## 인프라 이력

### 구 아키텍처 (~ 2026-04-04, Pi 기반)

```
iPhone / 브라우저
    ↓ HTTPS
jsh-valutvoice.duckdns.org (DuckDNS → 125.248.17.75 ← 가정용 공인 IP)
    ↓ 포트 포워딩 (공유기)
Raspberry Pi (192.168.219.125)
└── vaultvoice (Node.js, /home/pi/vaultvoice/) — 포트 직접 서빙
    └── Obsidian Vault (/home/pi/gdrive/) — Google Drive Mount
```

- **DuckDNS**: `jsh-valutvoice.duckdns.org` → 가정용 공인 IP `125.248.17.75`
- **Pi 앱 경로**: `/home/pi/vaultvoice/` (git 비관리, 독립 버전)
- **Pi 버전 특징**: 탭 레이블 `브라우저`, SVG 카드 액션 5개 (요약/코멘트/태그/Jarvis/삭제)
- **전환 이유**: Pi가 꺼지면 외부 접근 불가 → GCP 고정 IP 기반 24시간 서버로 이전

### 현재 아키텍처 (2026-04-04~, GCP 기반)

```
iPhone / 브라우저
    ↓ HTTPS
jsh-valutvoice.duckdns.org (DuckDNS → 35.233.232.24)
    ↓
GCP VM (e2-micro, asia-northeast3, 고정 IP: 35.233.232.24)
├── Caddy (systemd) — 포트 80/443, 자동 SSL (Let's Encrypt http-01)
│   └── reverse_proxy localhost:3939
├── PM2 — server.js (vaultvoice 프로세스)
└── gcsfuse — /home/jsh86/vault/ (Google Cloud Storage 마운트)
```

- **GCP VM**: `jsh86@35.233.232.24`, SSH 키: `~/.ssh/google_compute_engine`
- **Caddyfile**: `/etc/caddy/Caddyfile`
- **볼트**: `/home/jsh86/vault/` (gcsfuse 마운트)
- **DuckDNS 주의**: GCP cron이 주기적으로 `35.233.232.24`로 덮어씀 (가정 IP로 변경 시 자동 복구됨)

### 참조 UI 버전 (Pi 앱 — 통합 목표 기준)

Pi의 `/home/pi/vaultvoice/public/app.js` (2551줄)가 목표 UI 기준:

| 항목 | Pi 버전 (목표) | git HEAD (현재) |
|------|---------------|-----------------|
| Vault 탭 레이블 | `브라우저` | `관리` |
| 카드 액션 버튼 수 | 5개 (SVG 아이콘) | 4개 (이모지) |
| 태그 편집 버튼 | ✅ (`tags` 액션) | ❌ 없음 |
| `handleCardTags()` | ✅ (Pi line 844) | ❌ 없음 |
| `card-tag-editor` DOM | ✅ (Pi line 726) | ❌ 없음 |
| 카드 SVG 스타일 | `svgAttr` 패턴 | 이모지 텍스트 |

SVG 변수 (Pi 참조):
```javascript
const svgAttr = 'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
// svgSummarize — <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
// svgComment   — <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
// svgTag       — <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/> + <line x1="7" y1="7" x2="7.01" y2="7"/>
// svgJarvis    — <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1..."/> + 눈 circle 2개
// svgDelete    — <path d="M3 6h18"/> + <path d="M8 6V4h8v2"/> + <path d="M19 6v14a2 2 0 0 1-2 2H7..."/>
```

---

## 시스템 개요

| 구성 | 기술 |
|------|------|
| **Backend** | Node.js + Express (`server.js` 단일 파일, ~4717줄) |
| **Frontend** | Vanilla JS SPA (`public/app.js` + `app.css` + `index.html`) |
| **AI** | Google Gemini API (4-Tier) + OpenAI Whisper (폴백) |
| **Storage** | Obsidian Vault 파일시스템 (`99_vaultvoice/`) |
| **배포** | GCP VM (PM2) + Caddy (SSL) + gcsfuse (Vault) |
| **인증** | Bearer Token (`API_KEY` 환경변수) |

---

## Gemini 4-Tier 모델 시스템

### 모델 배정표

| Tier | Model ID | 특성 | 용도 |
|------|----------|------|------|
| **Lite** | `gemini-2.5-flash-lite` | 최저 비용, 초고속 | 단순 분류/추출 |
| **Flash** | `gemini-2.5-flash` | 저비용, 빠름, 멀티모달 | STT, Vision, 일반 요약 |
| **Pro** | `gemini-2.5-pro` | 고품질 추론 | 복잡한 요약, Jarvis 대화, 검색 확장 |
| **Max** | `gemini-3.1-pro-preview` | 최신 최고 성능 (예비) | 미래 고난도 작업용 |

### Tier별 호출 매핑 (현재 구현)

| Tier | 호출 위치 | 기능 |
|------|----------|------|
| **Lite** | `detect-event` (L684) | 음성 메모 → 일정 감지 |
| **Lite** | `search/ai keyword expand` (L1977) | 검색 키워드 확장 (간단) |
| **Lite** | `refineComment` (L3444) | 코멘트 맞춤법 교정 |
| **Lite** | `extractKeywords` (L3505) | 관련 노트용 키워드 추출 |
| **Lite** | `generateNoteTitle` (L3562) | 노트 제목 자동 생성 |
| **Flash** | `/api/test` (L244) | Gemini 연결 테스트 |
| **Flash** | `/api/ai/summarize` (L621) | 피드 날짜 요약 |
| **Flash** | `/api/ai/analyze-image` (L756) | 이미지 분석 (레거시) |
| **Flash** | `POST /api/process/audio` (L2642) | Gemini STT 전사 (SDK) |
| **Flash** | `POST /api/process/image` (L3099) | 이미지 분석 (SDK) |
| **Pro** | `/api/test` (L269) | Gemini Pro 연결 테스트 |
| **Pro** | `executeSummarizeNote` (L1040) | Jarvis 개별 노트 요약 |
| **Pro** | `expandKeywords` (L1087) | Jarvis pre-search 키워드 확장 |
| **Pro** | `/api/ai/chat` (L1443) | Jarvis 대화 (function calling) |
| **Pro** | `summarizeWithGemini` (L3288) | URL 컨텐츠 요약 (SDK) |
| **Pro** | `/api/note/summarize` (L3385) | 카드 개별 노트 요약 |

### 헬퍼 함수

```javascript
const GEMINI_TIERS = {
  lite:  'gemini-2.5-flash-lite',   // 단순 분류/추출
  flash: 'gemini-2.5-flash',        // STT, Vision, 일반 요약
  pro:   'gemini-2.5-pro',          // Jarvis 대화, 복잡 요약
  max:   'gemini-3.1-pro-preview'   // 미래 고난도 작업
};

getGeminiModel(tier)    // SDK 방식 (generateContent)
getGeminiApiUrl(tier)   // REST 방식 (fetch)
```

### Gemini 리서치 결과 (2026-04-01 API 조회)

| 모델 | Context Window | 주요 특징 |
|------|---------------|----------|
| **2.5 Flash Lite** | 1M tokens | 최저 지연, 분류/추출 최적 |
| **2.5 Flash** | 1M tokens | 멀티모달, STT/Vision 우수, 비용 효율 |
| **2.5 Pro** | 1M tokens | 복잡 추론, function calling 최적 |
| **3.1 Pro Preview** | 미확인 | 최신 모델, Preview 상태 |

---

## 현재 기능 상태

### 탭 구조

```
입력 | 피드 | 검색 | AI(Jarvis) | 설정 | 관리(Vault)
```

| 탭 | 기능 | 상태 |
|---|---|---|
| **입력** | 텍스트/음성/이미지/URL/파일 통합 입력 허브 | ✅ 구현 |
| **피드** | 날짜별 노트 카드 + 카드별 액션 (요약/삭제/코멘트/Jarvis) | ✅ 구현 |
| **검색** | 텍스트+AI 검색 + 유형/날짜 필터 | ✅ 구현 |
| **AI** | Jarvis 챗봇 (17 도구) + 온보딩 버튼 | ✅ 구현 |
| **설정** | 테스트/RAG/캘린더/클립보드 + 기능 테스트 확장 | ✅ 구현 |
| **관리** | Obsidian 파일 브라우저/편집 | ✅ 유지 |

---

## 3축 업그레이드 (2026-04-01 구현 완료)

### 축 1: 피드 탭 리디자인

| 변경 | 상세 |
|------|------|
| **제거** | 날짜 AI 버튼 3개 (요약/태그추천/분류), `doAI()`, `.ai-btn` |
| **추가** | 카드별 액션 4개: 요약(✦), 삭제(🗑), 코멘트(💬), Jarvis(🤖) |
| **코멘트** | 사용자 입력 → Gemini Lite 교정 → `## 코멘트` 섹션 append |
| **관련 노트** | 노트 열람 시 키워드 추출 → 유사 노트 3건 추천 |

### 축 2: Jarvis 도구 확장 (11 → 17개)

| 기존 (11) | 신규 (+6) |
|-----------|-----------|
| search, read_daily_note, read_note | **delete_note** — VV 노트 삭제 |
| add_todo, add_memo, create_note | **delete_todo** — 할일 삭제 |
| get_calendar_events, add_calendar_event | **toggle_todo** — 할일 토글 |
| list_folder, get_tags, get_recent_notes | **summarize_note** — 개별 노트 AI 요약 (Pro) |
| | **process_url** — URL 가져오기+요약+노트 저장 |
| | **add_comment** — 노트 코멘트 추가 (Lite 교정) |

### 축 3: 경쟁앱 기반 신규 기능

| 기능 | 설명 | 상태 |
|------|------|------|
| **Jarvis 온보딩** | AI 탭 진입 시 능력 버튼 5개 표시 | ✅ |
| **관련 노트 추천** | 키워드 기반 유사 노트 3건 | ✅ |
| **검색 필터** | 유형(전체/메모/음성/이미지/URL) + 날짜(7일/30일/전체) | ✅ |
| **노트 제목 자동생성** | Gemini Lite → frontmatter `title` + `aliases` | ✅ |
| **위키링크 삽입** | titleCache + 본문 매칭 → `[[filename\|title]]` | ✅ |
| **일정 자동감지** | 음성 전사 후 날짜/시간 키워드 → 캘린더 연동 | ✅ |
| **액션 아이템 추출** | 음성/메모에서 할일 자동 감지 | ✅ |
| **주간 리뷰** | 미구현 (향후) | ⬜ |
| **스마트 검색 필터** | 미구현 (향후) | ⬜ |

---

## API 엔드포인트 목록

### 핵심 처리 파이프라인

| 메서드 | 경로 | 인증 | Gemini Tier | 기능 |
|--------|------|------|-------------|------|
| `POST` | `/api/process/audio` | ✅ | Flash (SDK) | 음성 → STT+요약 → atomic note |
| `POST` | `/api/process/image` | ✅ | Flash (SDK) | 이미지 → Vision 분석 → atomic note |
| `POST` | `/api/process/url` | ✅ | Pro (SDK) | URL → fetch+요약 → atomic note |
| `POST` | `/api/process/text` | ✅ | — | 텍스트 → atomic note |

### 피드 & 노트 관리

| 메서드 | 경로 | 인증 | Gemini Tier | 기능 |
|--------|------|------|-------------|------|
| `GET` | `/api/feed/:date` | ✅ | — | 날짜별 노트 목록 |
| `GET` | `/api/note/:filename` | ✅ | — | 개별 노트 읽기 |
| `POST` | `/api/note/summarize` | ✅ | Pro | 개별 노트 AI 요약 |
| `POST` | `/api/note/delete` | ✅ | — | 노트 파일 삭제 |
| `POST` | `/api/note/comment` | ✅ | Lite | 노트에 코멘트 추가 |
| `POST` | `/api/note/related` | ✅ | Lite | 관련 노트 추천 |
| `POST` | `/api/notes/backfill-titles` | ✅ | Lite | 제목 미생성 노트 일괄 제목 생성 |

### AI 기능

| 메서드 | 경로 | 인증 | Gemini Tier | 기능 |
|--------|------|------|-------------|------|
| `POST` | `/api/ai/summarize` | — | Flash | 날짜별 요약 (레거시) |
| `POST` | `/api/ai/detect-event` | — | Lite | 일정 자동 감지 |
| `POST` | `/api/ai/analyze-image` | — | Flash | 이미지 분석 (레거시) |
| `POST` | `/api/ai/chat` | — | Pro | Jarvis 대화 (function calling) |

### 검색

| 메서드 | 경로 | 인증 | Gemini Tier | 기능 |
|--------|------|------|-------------|------|
| `GET` | `/api/search` | — | — | 텍스트 검색 (+ filterType, filterDate) |
| `GET` | `/api/search/ai` | — | Lite | AI 키워드 확장 검색 |
| `GET` | `/api/tags` | — | — | 전체 태그 목록 |
| `GET` | `/api/notes/recent` | — | — | 최근 노트 목록 |

### 할일

| 메서드 | 경로 | 인증 | 기능 |
|--------|------|------|------|
| `POST` | `/api/todo` | ✅ | 할일 추가 |
| `POST` | `/api/todo/toggle` | — | 할일 토글 |
| `POST` | `/api/todo/delete` | ✅ | 할일 삭제 |
| `GET` | `/api/daily/:date/todos` | — | 날짜별 할일 |

### Vault 관리 (Obsidian 브라우저)

| 메서드 | 경로 | 기능 |
|--------|------|------|
| `GET` | `/api/vm/browse` | 폴더 탐색 |
| `GET` | `/api/vm/read` | 파일 읽기 |
| `PUT` | `/api/vm/write` | 파일 쓰기 |
| `DELETE` | `/api/vm/delete` | 파일 삭제 |
| `POST` | `/api/vm/move` | 파일 이동 |
| `GET` | `/api/vm/search` | Vault 검색 |
| `GET` | `/api/vm/backlinks` | 백링크 |
| `GET` | `/api/vm/recent` | 최근 파일 |
| `GET/PUT` | `/api/vm/tags` | 태그 관리 |

### 캘린더 (Google Calendar OAuth)

| 메서드 | 경로 | 기능 |
|--------|------|------|
| `GET` | `/api/calendar/status` | OAuth 상태 확인 |
| `GET` | `/api/auth/google` | OAuth 시작 |
| `GET` | `/api/auth/google/callback` | OAuth 콜백 |
| `GET` | `/api/calendar/events` | 일정 조회 |
| `POST` | `/api/calendar/add` | 일정 추가 |

### 시스템

| 메서드 | 경로 | 기능 |
|--------|------|------|
| `GET` | `/api/health` | 헬스체크 |
| `GET` | `/api/test` | Gemini Flash+Pro 연결 테스트 |
| `GET` | `/api/reset` | 캐시 리셋 |
| `GET/POST` | `/api/clipboard` | 클립보드 |
| `POST` | `/api/rag/reindex` | RAG 재인덱싱 |
| `GET` | `/api/rag/search` | RAG 검색 |

---

## Phase 1: 아키텍처 설계

### 1.1 입력 유형 (Asset Types)

모든 입력은 **asset + 텍스트 쌍**으로 저장:

| 입력 유형 | 원본 asset | 텍스트 변환 방법 | 저장 |
|-----------|-----------|-----------------|------|
| **텍스트 메모** | (없음) | 직접 입력 | `*.md` |
| **음성** | `.webm/.m4a` | Gemini STT → (품질 낮으면 Whisper 폴백) → 요약 | `*.md` + 원본 음성 링크 |
| **이미지** | `.jpg/.png` | Gemini Vision (OCR + 장면 설명 + 데이터 추출) | `*.md` + 원본 이미지 링크 |
| **URL** | URL 문자열 | Gemini 요약 (fetch → 텍스트 추출 → 요약) | `*.md` + 원본 URL |
| **파일 업로드 (음성)** | `.m4a/.mp3/.wav` | 위 음성과 동일 파이프라인 | 동일 |

### 1.2 음성 처리 파이프라인

**기술 스택**:
- Gemini 2.0 Flash: ~$0.08/h, 최대 2GB 업로드(GoogleAIFileManager), 11시간 분량 처리 가능
- Whisper API (whisper-1): $0.36/h, m4a 네이티브 지원, 25MB 제한(→ ffmpeg 청크 분할)
- Structured Output: `responseMimeType: "application/json"` + `responseSchema`로 JSON 강제

```
음성 (녹음 or 파일 업로드)
  │
  ▼
① Gemini 2.0 Flash (GoogleAIFileManager로 오디오 업로드)
  → 전사 + 화자 구분 + 요약 + 품질 판정 — 단일 프롬프트
  → responseSchema로 JSON 강제 (transcript[], quality_check, summary)
  → 화자 힌트: "화자 N명, 진행자 특성" 프롬프트 추가 시 정확도 향상
  │
  ▼
② 품질 자동 판정 (Gemini 응답의 quality_check 필드)
  a. broken_sentences: 끊긴 문장 목록 (3개+ 시 fail)
  b. unclear_ratio: 0~1 (0.2+ 시 fail)
  c. repetition_detected: 무의미 반복 boolean
  d. insufficient_content: 오디오 길이 대비 텍스트 20% 미만
  + 코드 검증: 분당 50자 미만 (전사 텍스트 길이 / 오디오 초 * 60)
  → 2개+ 해당 시 Whisper 폴백
  │
  ├─ PASS → 저장
  │
  └─ FAIL → Whisper STT → Gemini 합성
      Whisper: verbose_json (segments + words 타임스탬프)
      25MB 초과 시: ffmpeg -f segment -segment_time 600 분할
      청크별 타임스탬프 오프셋 보정 (currentOffset += duration)
      합성: Temporal Overlap Algorithm (Gemini 화자 + Whisper 텍스트)
  │
  ▼
③ atomic note 생성
  - frontmatter: 전사방식(gemini/gemini+whisper), 화자수, 녹음시간, status
  - body: 화자별 전사 + 요약
  - 원본 음성 파일 링크 ([[assets/audio/파일명]])
```

**iOS 녹음 대응**:
- MediaRecorder: `audio/mp4`(AAC) 사용 (iOS 안정)
- `timeslice` 옵션으로 1~5초 단위 데이터 수신 → IndexedDB 즉시 저장 (메모리 관리)
- 파일 업로드: `accept="audio/mp4, audio/x-m4a, .m4a"` 명시 필수
- iPhone Voice Memo: "파일에 저장" 선행 필요 (PWA에서 직접 접근 불가)

### 1.3 이미지 처리 파이프라인

**기술 스택**: Gemini 2.0 Flash Vision — $0.00007/image (매우 저렴)
- 화이트보드/차트/스크린샷: 매우 높은 정확도
- 명함/영수증: 중-상 (구조화 추출은 프롬프트 품질 의존, MVP에서 충분)
- 단일 호출로 유형 판별 + OCR + 구조화 동시 수행 (이중 호출 방지)

```
이미지 (카메라/갤러리/파일)
  │  iOS: capture="camera" 대신 accept="image/*" 사용 (갤러리+촬영 선택)
  │
  ▼
① Gemini Vision 단일 호출 (structured output)
  프롬프트 + responseSchema:
  {
    type: "명함|영수증|화이트보드|손글씨|도표|사진|스크린샷",
    ocr_text: "추출된 원문",
    structured_data: { /* 유형별 키-값 */ },
    summary: "한줄 설명",
    suggested_tags: ["tag1", "tag2"]
  }
  │
  ▼
② 유형별 후처리 (structured_data 기반)
  - 명함 → 이름/회사/전화/이메일 구조화
  - 영수증 → 날짜/금액/항목 테이블
  - 화이트보드/손글씨 → 텍스트 전사 + 정리
  - 도표/차트 → 데이터 설명 + 수치 추출
  - 일반 사진 → 장면 설명 + 핵심 객체
  - 스크린샷 → UI 설명 + 텍스트 추출
  │
  ▼
③ atomic note 생성
  - frontmatter: 이미지유형, tags
  - body: 추출 텍스트 + 구조화 데이터
  - 원본 이미지 링크 ([[assets/images/파일명]])
```

### 1.4 URL 처리 파이프라인

**기술 스택**:
- `@mozilla/readability` + `jsdom`: 본문 추출 (브런치/미디엄 95%+, 네이버/티스토리는 전처리 필요)
- `youtube-captions-scraper`: YouTube 자막 추출
- jsdom 최적화: VirtualConsole, scripts:false, 대형 페이지는 cheerio 선행
- OG 메타데이터 동시 추출 (og:title, og:image, og:description)

```
URL 입력
  │
  ├─ YouTube? → youtube-captions-scraper (ko → en 폴백)
  │
  └─ 일반 URL
      │
      ▼
  ① got으로 HTML fetch (5초 timeout)
     실패 시 → Playwright headless 폴백 (SPA 대응, 최후 수단)
      │
      ▼
  ② jsdom + Readability 본문 추출
     + extractMetadata() → OG 메타데이터
     + 불필요 태그(nav, footer, aside, ads) 사전 제거
      │
      ▼
③ Gemini 요약
  프롬프트: "다음 웹페이지 내용을 한국어로 요약:
  - 제목, 핵심 내용 3줄 요약
  - 주요 키워드/태그 2~3개
  - 유용한 인사이트"
  (본문 10,000자 제한 → 토큰 효율)
  │
  ▼
④ atomic note 생성
  - frontmatter: url, 도메인, og_title, og_image, tags
  - body: 제목 + 요약 + 원본 URL 링크 + (YouTube면 자막 전문)
```

**필요 패키지**: `@mozilla/readability`, `jsdom`, `youtube-captions-scraper`, `got`

### 1.5 Obsidian 폴더 구조

```
99_vaultvoice/                    # 임시 수신함 (모든 asset 도착지)
├── {date}_{time}_메모.md         # 텍스트 메모
├── {date}_{time}_음성.md         # 음성 전사+요약 (원본 링크 포함)
├── {date}_{time}_이미지.md       # 이미지 분석 (원본 링크 포함)
├── {date}_{time}_URL.md          # URL 요약
├── assets/                       # 원본 바이너리 파일
│   ├── audio/                    # 음성 원본 (.webm, .m4a, .mp3)
│   ├── images/                   # 이미지 원본 (.jpg, .png)
│   └── files/                    # 기타 파일
```

**변경점**: photos/screenshots/voice/meetings/attachments 5개 폴더 → `assets/` 하위 2~3개로 단순화.
모든 `.md` 파일은 99_vaultvoice/ 루트에 flat하게 저장 (Obsidian에서 태그 필터링 → 이동이 쉬움).

### 1.6 검색 기능 재설계

**기술 스택**:
- **flexsearch**: 전문 검색 (한국어 자모 분리 encoder + forward tokenize, 초성 검색 지원)
- **hnswlib-node**: 벡터 검색 (Gemini text-embedding-004, 한국어 성능 ≈ OpenAI text-embedding-3-small)
- **chokidar**: 파일 변경 감지 → 증분 인덱싱 (1000개+ 파일에서 수십ms 검색)
- 인덱스 영속화: flexsearch export/import로 서버 재시작 시 재인덱싱 방지

| 현재 | 개선 |
|------|------|
| 텍스트 검색 (파일 내용 매칭) | **flexsearch** (자모 분리 + 초성 검색) |
| AI 검색 (Gemini 키워드 확장) | 유지 + 개선 |
| RAG (임베딩 기반) | **hnswlib-node** + Gemini embedding (전사 텍스트 자동 인덱싱) |
| (없음) | **태그 기반 필터** 추가 (frontmatter 메타데이터 인덱스) |
| (없음) | **유형 필터** 추가 (메모/음성/이미지/URL) |
| (없음) | **날짜 범위 필터** 추가 |

### 1.7 추가 기능 제안

| 기능 | 설명 | 우선순위 |
|------|------|---------|
| **할일 인라인 인식** | 메모 중 `- [ ]` 패턴 또는 "해야할 것" 키워드 → 자동 할일 추적 | P1 |
| **오디오 파일 업로드** | .m4a/.mp3 직접 업로드 → 동일 전사 파이프라인 | P1 |
| **AI 자동 태깅** | 입력 내용 분석 → 태그 자동 추천 (회의/아이디어/할일/회고 등) | P1 |
| **일일 다이제스트** | 하루 끝에 모든 노트 자동 요약 (Gemini) | P2 |
| **시간 기반 프롬프트** | 저녁 시간대 입력 시 "오늘 하루 어땠나요?" 가벼운 넛지 (회고 유도) | P2 |
| **위키링크 자동 감지** | 노트 내용에서 기존 노트와 연결 가능한 키워드 감지 | P2 |
| **PWA 오프라인 큐** | IndexedDB에 임시 저장 → 온라인 복귀 시 자동 업로드 (Resumable Chunked) | P1 |
| **PWA 설치 가이드** | iOS "공유 → 홈 화면 추가" 안내 UI (IndexedDB 영구성 + 푸시 전제조건) | P1 |

### 1.8 iOS PWA 제약 대응

| 제약 | 대응 |
|------|------|
| Background Fetch/Sync 미지원 | Resumable Chunked Upload + Page Visibility API |
| IndexedDB 7일 삭제 | PWA 설치(홈화면 추가) 시 제외됨 → 설치 가이드 필수 |
| MediaRecorder 메모리 | timeslice 1~5초 + IndexedDB 즉시 저장 |
| Wake Lock PWA 버그 | iOS 18.4+ 해결됨, 이전 버전은 1x1 비디오 우회 |
| Voice Memo 직접 접근 불가 | "파일에 저장" 안내 + accept="audio/mp4, .m4a" |
| 카메라 Black Screen 버그 | capture 속성 제거, accept="image/*"만 사용 |
| Web Push | iOS 16.4+ PWA 전용, 사용자 클릭으로만 권한 요청 |

### 1.9 Obsidian Dataview 연동

Dataview 쿼리 예시 (사용자가 Obsidian에서 활용):
```sql
-- 주간 요약
TABLE 시간, 유형, tags FROM "99_vaultvoice"
WHERE 날짜 >= date(today) - dur(7 days) SORT 날짜 DESC

-- 유형별 필터
TABLE 날짜, 시간 FROM "99_vaultvoice"
WHERE 유형 = "음성" SORT 날짜 DESC

-- 미처리 노트
TABLE 날짜, 유형 FROM "99_vaultvoice"
WHERE !contains(tags, "정리완료") SORT 날짜 ASC
```

---

## Phase 2: UI/UX 설계

### 2.1 디자인 시스템 (button 프로젝트 참조)

| 속성 | 값 |
|------|-----|
| **배경** | `#0a0a0a` (다크) |
| **텍스트** | `#ededed` (밝은 회색) |
| **Primary** | `#007AFF` (iOS 블루, 현재 유지) |
| **Success** | `#34C759` (녹색) |
| **Warning** | `#FF9500` (앰버) |
| **Danger** | `#FF3B30` (빨강) |
| **카드 배경** | `#1c1c1e` |
| **구분선** | `#38383a` |
| **폰트** | -apple-system, SF Pro |
| **둥근 모서리** | 12px (카드), 8px (입력), 24px (칩) |
| **글로우 효과** | 상태 표시에 pulse 애니메이션 (button 스타일) |

### 2.2 탭 구조 변경

```
현재: 메모 | 오늘 | 기록 | 설정 | 관리
  ↓
변경: 입력 | 피드 | 검색 | 설정 | 관리
```

### 2.3 입력 탭 와이어프레임

```
┌─────────────────────────────────┐
│         VaultVoice              │
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ 무엇이든 입력하세요...      │ │  ← 텍스트 (URL 감지 시 자동 요약)
│ │                             │ │
│ │                        🎤 ↵│ │  ← 음성 인식 / 줄바꿈
│ └─────────────────────────────┘ │
│                                 │
│  📷  🖼️  🎙️  📎  🔗           │  ← 카메라/갤러리/녹음/파일/URL
│                                 │
│  [미리보기 영역]                │  ← 첨부된 asset 미리보기
│                                 │
│  태그: #회의 #프로젝트 ×        │
│  ┌───────────────────────────┐  │
│  │ 태그 추가 (Enter)          │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌─────────────────────────┐    │
│  │         저장             │    │
│  └─────────────────────────┘    │
│                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  □ 빨래하기          ＋할일     │  ← 할일 퀵바
│  ☑ 장보기 (완료)               │
│  □ 보고서 작성                  │
├─────────────────────────────────┤
│  입력  │  피드  │  검색  │ ··· │
└─────────────────────────────────┘
```

### 2.4 피드 탭 (구 "오늘" 탭)

```
┌─────────────────────────────────┐
│  ◁  2026-04-01 (화)  ▷         │
│                                 │
│  ┌────────────────────────────┐ │
│  │ 🎙️ 09:30  음성 (3분)      │ │  ← 음성 노트 카드
│  │ 화자1: 진행 상황 공유...    │ │
│  │ ▶ 원본 재생  [gemini+whisper]│ │  ← 전사 방식 태그
│  │ #회의 #프로젝트             │ │
│  └────────────────────────────┘ │
│                                 │
│  ┌────────────────────────────┐ │
│  │ 📷 10:15  이미지 (명함)    │ │  ← 이미지 노트 카드
│  │ 홍길동 | ABC Corp           │ │
│  │ 📱 010-1234-5678           │ │
│  │ [이미지 썸네일]             │ │
│  │ #명함 #네트워킹             │ │
│  └────────────────────────────┘ │
│                                 │
│  ┌────────────────────────────┐ │
│  │ 🔗 11:00  URL              │ │  ← URL 노트 카드
│  │ "AI 노트앱 트렌드 2026"    │ │
│  │ 핵심: 멀티모달 입력이 ...   │ │
│  │ #AI #트렌드                 │ │
│  └────────────────────────────┘ │
│                                 │
│  ┌────────────────────────────┐ │
│  │ ✏️ 14:30  메모              │ │  ← 텍스트 노트 카드
│  │ 점심 미팅 결과 정리...      │ │
│  │ #회의                       │ │
│  └────────────────────────────┘ │
├─────────────────────────────────┤
│  입력  │  피드  │  검색  │ ··· │
└─────────────────────────────────┘
```

### 2.5 검색 탭

```
┌─────────────────────────────────┐
│  🔍 검색어 입력...              │
│                                 │
│  유형: [전체▾] 날짜: [최근 7일▾]│  ← 필터 드롭다운
│  [검색]  [AI 검색]              │
│                                 │
│  검색 결과...                   │
├─────────────────────────────────┤
│  입력  │  피드  │  검색  │ ··· │
└─────────────────────────────────┘
```

---

## Phase 3: 구현 상세

### 3.1 환경변수

| 변수 | 용도 | 필수 |
|------|------|------|
| `VAULT_PATH` | Obsidian 볼트 경로 | Y |
| `API_KEY` | VaultVoice 인증 | Y |
| `GEMINI_API_KEY` | Gemini API (STT, Vision, 요약) | Y |
| `OPENAI_API_KEY` | Whisper 폴백 STT | N (없으면 Gemini 단독) |
| `PORT` | 서버 포트 | N (기본 3939) |
| `MAX_UPLOAD_SIZE` | 업로드 제한 MB | N (기본 100, Gemini 2GB/Whisper 25MB 별도 처리) |
| `GOOGLE_CLIENT_ID` | 캘린더 OAuth | N |
| `GOOGLE_CLIENT_SECRET` | 캘린더 OAuth | N |
| `GOOGLE_REDIRECT_URI` | OAuth 리다이렉트 | N |

### 3.2 API Route 변경

#### 새 엔드포인트

| 메서드 | 경로 | 기능 |
|--------|------|------|
| `POST` | `/api/process/audio` | 음성 업로드 → 전사+요약 → atomic note |
| `POST` | `/api/process/image` | 이미지 업로드 → 분석 → atomic note |
| `POST` | `/api/process/url` | URL → fetch+요약 → atomic note |
| `POST` | `/api/process/text` | 텍스트 → atomic note (기존 POST /daily 대체) |
| `GET`  | `/api/feed/:date` | 날짜별 모든 노트 (피드 뷰) |
| `POST` | `/api/todo` | 할일 추가 |
| `GET`  | `/api/todo` | 할일 목록 (미완료) |
| `POST` | `/api/todo/toggle` | 할일 토글 (유지) |

#### 제거/변경

| 기존 | 변경 |
|------|------|
| `POST /api/daily/:date` | → `/api/process/text` |
| `GET /api/daily/:date` | → `/api/feed/:date` |
| `GET /api/daily/:date/todos` | → `/api/todo?date=` |
| `POST /api/upload` | → `/api/process/audio` 또는 `/api/process/image` (type별 분기) |
| `POST /api/ai/analyze-image` | → `/api/process/image`에 통합 |
| `POST /api/ai/summarize` | 유지 (피드 뷰에서 호출) |

### 3.3 Atomic Note 파일명 규칙

```
{date}_{HHmmss}_{type}.md

예:
2026-04-01_093000_음성.md
2026-04-01_101500_이미지.md
2026-04-01_110000_URL.md
2026-04-01_143000_메모.md
2026-04-01_150000_할일.md
```

### 3.4 Frontmatter 표준 (Dataview 호환)

```yaml
---
날짜: 2026-04-01
시간: "09:30"
유형: voice|image|url|memo|todo
status: captured|transcribed|processed  # Obsidian 워크플로우용
tags: [회의, AI, vaultvoice]
summary: "한줄 요약..."
# 음성 전용
전사방식: gemini|gemini+whisper
화자수: 3
녹음시간: "3:42"
speakers: [Speaker 1, Speaker 2]
source: "[[assets/audio/파일명.m4a]]"
# 이미지 전용
이미지유형: 명함|영수증|화이트보드|손글씨|도표|사진|스크린샷
source: "[[assets/images/파일명.jpg]]"
# URL 전용
url: "https://..."
도메인: "example.com"
og_title: "원본 제목"
og_image: "https://..."
---
```

**status 워크플로우**: captured(입력됨) → transcribed(전사/분석됨) → processed(사용자 확인/태깅 완료)

### 3.5 신규 패키지

| 패키지 | 용도 | 모듈 |
|--------|------|------|
| `@google/generative-ai` | Gemini API (STT, Vision, 요약, 임베딩) | Audio/Image/URL/Search |
| `openai` | Whisper API 폴백 | Audio |
| `fluent-ffmpeg` | 오디오 청크 분할, 포맷 변환 | Audio |
| `@mozilla/readability` | URL 본문 추출 | URL |
| `jsdom` | HTML DOM 파싱 | URL |
| `youtube-captions-scraper` | YouTube 자막 추출 | URL |
| `got` | HTTP 클라이언트 (URL fetch) | URL |
| `flexsearch` | 전문 검색 (한국어 자모) | Search |
| `hnswlib-node` | 벡터 검색 | Search |
| `chokidar` | 파일 변경 감지 → 증분 인덱싱 | Search |

---

## Phase 4: 구현 이력

### v3.0 초기 리디자인 (이전)

6개 모듈 (Core/Audio/Image/URL/Frontend/Search) → L 규모 오케스트레이션으로 구현 완료.

### v3.1 피드 리디자인 + Jarvis 확장 (2026-04-01)

2 Coder 병렬 실행:
- **Coder-1** (server.js): Gemini 4-Tier, 신규 엔드포인트 6개, Jarvis 도구 6개 추가, titleCache, wiki-link
- **Coder-2** (app.js/css/html): 카드 액션 UI, 온보딩, 검색 필터, 설정 테스트 확장

Guardian 보안 리뷰 수정:
- auth 미들웨어 누락 4건 수정 (summarize, comment, related, backfill-titles)
- path traversal 검사 통일 (`..`, `/`, `\\` 3중 체크)

### 향후 개선 사항 (품질 리뷰 기반)

| 우선순위 | 항목 | 상세 |
|---------|------|------|
| P1 | 중복 로직 헬퍼 추출 | summarize/delete/comment 엔드포인트 ↔ Jarvis 도구 로직 통합 |
| P1 | titleCache 뮤테이션 집중 | `setTitleCache`/`removeTitleCache` 헬퍼 추출 |
| P2 | audio 핸들러 분할 | 474줄 → 단계별 함수 분리 |
| P2 | 응답 형식 통일 | `{ ok, data }` 또는 `{ success, ... }` 하나로 |
| P3 | genAI null 체크 | `getGeminiModel` 내 null safety 강화 |
