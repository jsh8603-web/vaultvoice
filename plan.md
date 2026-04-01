# VaultVoice 피드 리디자인 + Jarvis 업그레이드 계획

## 배경

피드 탭 AI 버튼 3개(요약/태그추천/분류)의 문제:
- 날짜 단위 동작 → 비중 큰 노트 1개가 결과 지배
- 태그 추천: 적용 버튼 없음, Obsidian에서 태깅이 더 효율적
- 요약 vs 분류: 입력 동일, 결과 중복
- Jarvis가 동일 기능을 더 유연하게 수행 가능

## 수정 범위 (3개 축)

### 축 1. 피드 탭 리디자인
### 축 2. Jarvis 도구 확장
### 축 3. 경쟁앱 기반 신규 기능

---

## 축 1: 피드 탭 리디자인

### 1-1. 날짜 AI 버튼 3개 제거

**삭제 대상**:
- `index.html`: AI 요약/태그추천/분류 버튼 + `#ai-result` 영역
- `app.js`: `doAI()` 함수 + `.ai-btn` 이벤트 리스너
- `app.css`: `.ai-btn`, `.ai-result`, `.ai-tag-chip` 스타일
- `server.js`: `/api/ai/summarize`의 `suggest-tags`, `categorize` 액션 제거 (summarize는 유지)

### 1-2. 카드별 액션 버튼 추가

각 피드 카드 하단에 아이콘 버튼 3개:

| 액션 | 아이콘 | 동작 |
|------|--------|------|
| **요약** | ✦ (sparkle) | 해당 노트 1개를 Gemini 요약 → 카드 하단에 인라인 표시 |
| **삭제** | 🗑 (trash) | 해당 노트 파일 삭제 (confirm 다이얼로그) |
| **Jarvis** | 💬 (chat) | AI 탭으로 전환 + 해당 노트 컨텍스트로 Jarvis 시작 |

**구현 상세**:
- `renderFeedCards()`에서 각 카드에 `.card-actions` 영역 추가
- 요약: `POST /api/note/summarize` → 결과를 `.card-summary` div에 삽입
- 삭제: `POST /api/note/delete` → confirm 후 카드 제거 + loadFeed()
- Jarvis: `switchTab('ai')` + `sendJarvis("다음 노트 내용에 대해 답변해줘: " + filename)` 

### 1-3. 서버 엔드포인트 추가

```
POST /api/note/summarize  { filename } → { summary }
POST /api/note/delete     { filename } → { success }
```

- summarize: 해당 파일 읽기 → 기존 Gemini summarize 프롬프트 재활용
- delete: 99_vaultvoice/ 내 파일만 삭제 허용 (보안)

---

## 축 2: Jarvis 도구 확장

### 현재 Jarvis 도구 (11개)
search, read_daily_note, read_note, add_todo, add_memo,
get_calendar_events, add_calendar_event, create_note,
list_folder, get_tags, get_recent_notes

### 추가할 도구 (6개)

| 도구 | 설명 | 재활용 대상 |
|------|------|------------|
| **delete_note** | VV 노트 파일 삭제 | 신규 /api/note/delete |
| **delete_todo** | 할일 항목 삭제 | 기존 /api/todo/delete 로직 |
| **toggle_todo** | 할일 완료/미완료 토글 | 기존 /api/todo/toggle 로직 |
| **summarize_note** | 개별 노트 AI 요약 | 신규 /api/note/summarize |
| **process_url** | URL 가져와서 요약+노트 저장 | 기존 extractUrlContent + summarizeWithGemini |
| **add_comment** | 노트에 코멘트 추가 (Gemini 정리 후 append) | 신규 /api/note/comment |

### 도구 정의

```javascript
// delete_note
{ name: 'delete_note',
  description: 'Delete a VaultVoice note by filename. Only 99_vaultvoice/ notes.',
  parameters: { type: 'OBJECT', properties: {
    filename: { type: 'STRING', description: 'Note filename (e.g. 2026-04-01_093000_memo.md)' }
  }, required: ['filename'] } }

// delete_todo  
{ name: 'delete_todo',
  description: 'Delete a todo item by date and line index.',
  parameters: { type: 'OBJECT', properties: {
    date: { type: 'STRING' }, lineIndex: { type: 'NUMBER' }
  }, required: ['date', 'lineIndex'] } }

// toggle_todo
{ name: 'toggle_todo',
  description: 'Toggle a todo item done/undone by date and line index.',
  parameters: { type: 'OBJECT', properties: {
    date: { type: 'STRING' }, lineIndex: { type: 'NUMBER' }
  }, required: ['date', 'lineIndex'] } }

// summarize_note
{ name: 'summarize_note',
  description: 'Generate AI summary of a specific note.',
  parameters: { type: 'OBJECT', properties: {
    filename: { type: 'STRING' }
  }, required: ['filename'] } }

// process_url
{ name: 'process_url',
  description: 'Fetch a URL, extract content, summarize with AI, and save as a new note.',
  parameters: { type: 'OBJECT', properties: {
    url: { type: 'STRING', description: 'The URL to process' }
  }, required: ['url'] } }

// add_comment
{ name: 'add_comment',
  description: 'Add a user comment to an existing note. The comment is refined by AI before appending.',
  parameters: { type: 'OBJECT', properties: {
    filename: { type: 'STRING', description: 'Target note filename' },
    comment: { type: 'STRING', description: 'User comment in natural language' }
  }, required: ['filename', 'comment'] } }
```

### executeToolCall 확장

```javascript
case 'delete_note': return executeDeleteNote(args.filename);
case 'delete_todo': return executeDeleteTodo(args);
case 'toggle_todo': return executeToggleTodo(args);
case 'summarize_note': return executeSummarizeNote(args.filename);
case 'process_url': return executeProcessUrl(args.url);
case 'add_comment': return executeAddComment(args.filename, args.comment);
```

### 노트 코멘트 기능 상세

**사용 시나리오**:
- 피드 카드에서 💬 코멘트 버튼 → 입력창 → 자연어 소감 입력
- Jarvis에서 "이 노트에 대해 ~라고 코멘트" → add_comment 도구 호출

**처리 흐름**:
1. 사용자 자연어 코멘트 수신
2. Gemini Flash로 정리 (맞춤법, 문장 다듬기 — 의미 변경 없이)
3. 노트 파일 끝에 `## 코멘트` 섹션 append (타임스탬프 포함)

**형식**:
```markdown
## 코멘트
- 2026-04-01 15:30 — {정리된 코멘트 내용}
- 2026-04-02 09:00 — {추가 코멘트}
```

**엔드포인트**: `POST /api/note/comment { filename, comment }` → Gemini 정리 → 파일 append → `{ success, refined }`

### Gemini 모델 티어링

**현재 문제**: 모든 Gemini 호출이 `gemini-2.0-flash` 하드코딩 (12곳+). 복잡도에 관계없이 동일 모델 사용.

**티어링 기준**:

| 티어 | 모델 | 용도 | 예시 |
|------|------|------|------|
| **Flash** | `gemini-2.0-flash` | 단순 변환, 짧은 분류, 키워드 추출, 코멘트 정리 | 태그 추천, 일정 감지, 코멘트 다듬기, 제목 생성 |
| **Pro** | `gemini-2.5-pro` | 복잡한 추론, 긴 문서 요약, 멀티스텝 분석 | Jarvis 대화, URL 요약, 회의록 액션아이템 추출, 주간 리뷰, 위키링크 매칭 |

**구현**:
- `getGeminiModel(tier)` 헬퍼 함수 도입: `tier = 'flash' | 'pro'`
- 기존 12곳+ 하드코딩을 `getGeminiModel('flash')` 또는 `getGeminiModel('pro')`로 교체
- REST API 호출도 URL 내 모델명을 변수화
- fallback: Pro 실패 시 Flash로 재시도

```javascript
function getGeminiModel(tier = 'flash') {
  const modelId = tier === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.0-flash';
  try { return genAI.getGenerativeModel({ model: modelId }); }
  catch (e) { return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }); }
}

function getGeminiApiUrl(tier = 'flash') {
  const modelId = tier === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.0-flash';
  return `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;
}
```

### 시스템 프롬프트 업데이트

Rules에 추가:
```
- You can now delete notes, toggle/delete todos, summarize individual notes, process URLs, and add comments to notes.
- When the user says "이거 삭제해줘" about a note, use delete_note.
- When the user shares a URL, use process_url to save and summarize it.
- When asked "이 노트 요약해줘", use summarize_note.
- When the user wants to add a thought/comment about a note, use add_comment. The comment will be AI-refined and appended.
```

---

## 축 3: 경쟁앱 기반 신규 기능

경쟁앱 리서치(Mem, Reflect, AudioPen, Cleft, Notion, Otter, Granola, Fireflies)에서 도출.
VaultVoice 핵심 가치: "빠른 캡처 → AI 정리 → Obsidian 연동"에 부합하는지 기준.

### A. 관련 노트 자동 추천 (Mem 방식) — 가치:높음 / 난이도:낮음
- 노트 상세 보기 시 하단에 "관련 노트 3개" 자동 표시
- 구현: 해당 노트 키워드로 executeSearch → 상위 3개 (본인 제외)
- Jarvis: "이 노트와 관련된 메모 찾아줘" → search로 이미 가능

### B. 회의록 액션아이템 자동 추출 (Otter/Fireflies) — 가치:높음 / 난이도:중간
- voice/meeting 노트 저장 시 → Gemini에 액션아이템 추출 → 할일 자동 제안
- Jarvis: "이 회의록에서 할일 뽑아줘" → read_note + add_todo 체인

### C. 주간 리뷰 자동 생성 (Notion) — 가치:높음 / 난이도:낮음
- "이번 주 요약" → get_recent_notes 합산 → Gemini 주간 요약 → create_note
- Jarvis에서 바로 실행 가능 (기존 도구 조합)

### D. 일정 감지 자동화 강화 — 가치:중간 / 난이도:낮음 ✅ 실현 가능
- 현재: `detectCalendarEvent()`가 텍스트 메모 저장 시에만 호출 (app.js:433,457)
- 음성 전사 완료 후에는 미호출 → 서버 `/api/ai/detect-event`는 이미 동작 중
- 구현: 음성 전사 저장 성공 콜백에 `detectCalendarEvent(text)` 1줄 추가
- 파일: `app.js` 1줄 수정

### E. 스마트 검색 필터 — 가치:중간 / 난이도:낮음 ✅ 실현 가능
- 현재: HTML에 `filterType`(voice/image/url/memo/todo), `filterDate`(7/30/90일) 셀렉트 존재
- 그러나 `doSearch()`가 이 값을 사용하지 않음 — `q`와 `scope`만 전달
- 구현: doSearch()에서 filter 값 읽기 → /api/search에 전달 → 서버에서 파일명 패턴+날짜 필터링
- 파일: `app.js` + `server.js` 각 10줄 내외

### F. 노트 제목 자동생성 + 위키링크 — 가치:중간 / 난이도:중간 ✅ 2단계 구현
- **문제**: 현재 파일명 `2026-04-01_004746_voice.md`, frontmatter에 title 없음 → 위키링크 무의미
- **1단계: 제목 자동생성** (선행)
  - 노트 저장 시 Gemini에 본문 전달 → 한줄 제목 생성 → frontmatter `title` 필드 추가
  - 기존 노트 일괄 보정: 서버에 `/api/notes/backfill-titles` 엔드포인트 (title 없는 노트 스캔 → Gemini 제목 생성)
  - 파일: `server.js` (저장 파이프라인 수정 + backfill 엔드포인트)
- **2단계: 위키링크 삽입**
  - 노트 저장 시 기존 노트 title 목록 캐시 → 본문에서 매칭 → `[[filename|title]]` 형태로 변환
  - Obsidian alias 활용: frontmatter `aliases: [title]` 추가 → Obsidian에서 제목으로 검색 가능
  - 파일: `server.js` (title 캐시 + 링크 삽입 로직)

### G. Jarvis 기능 안내 버튼 (온보딩 UX) — 가치:높음 / 난이도:낮음
- AI 탭 진입 시 대화 시작 전 "이런 걸 할 수 있어요" 버튼 목록 표시
- 기본 CRUD(삭제/추가 등)는 제외, AI 특화 기능만 노출
- 버튼 누르면 Jarvis가 해당 기능 설명 + 사용 예시를 채팅으로 안내
- 대화 시작 후에는 버튼 영역 자동 숨김

**버튼 후보** (AI 특화만):
| 버튼 텍스트 | Jarvis 응답 내용 |
|------------|-----------------|
| 📋 회의록 할일 추출 | "회의록에서 액션아이템을 뽑아 할일로 등록해드려요" + 예시 |
| 🔍 노트 검색·분석 | "볼트에서 특정 주제의 노트를 찾고 분석해드려요" + 예시 |
| 📝 주간 리뷰 | "이번 주 노트를 종합해 주간 요약을 만들어드려요" + 예시 |
| 🔗 URL 저장·요약 | "URL을 주시면 내용을 가져와서 요약+노트로 저장해드려요" + 예시 |
| ✦ 노트 요약 | "특정 노트를 AI로 요약해드려요" + 예시 |

**구현**:
- `index.html`: AI탭 채팅 영역 상단에 `.jarvis-onboarding` 영역 추가
- `app.js`: 버튼 클릭 → `sendJarvis("기능명에 대해 설명해줘")` 또는 하드코딩 응답
- `app.css`: 온보딩 버튼 그리드 스타일
- `server.js`: 시스템 프롬프트에 "사용자가 기능 설명을 요청하면 예시와 함께 안내" 규칙 추가

### 설정탭 연동 수정

구현 기능 변경에 따라 설정 탭에서 같이 수정해야 하는 항목:

**1. 기능 안내 텍스트 업데이트** (`index.html:232~271`)
| 항목 | 현재 (구) | 수정 (신) |
|------|----------|----------|
| 피드 탭 | "AI 요약·태그 추천·분류 기능 제공" | "카드별 AI 요약·삭제·코멘트·Jarvis 연동, 관련 노트 추천" |
| AI (Jarvis) | "할일·메모 추가, 일정 관리" | "노트 요약·삭제·코멘트, URL 처리, 주간 리뷰, 회의록 할일 추출 등" |
| 검색 탭 | "유형·날짜 필터로 범위를 좁힐 수 있고" | 유지 (E 구현으로 실제 작동하게 됨) |

**2. 기능 테스트 확장** (`server.js:/api/test`, `app.js:runFeatureTest`)
현재 테스트: 서버/볼트/폴더/Gemini/Obsidian API/노트 수 (6항목)
추가 필요:
- Gemini Pro 모델 연결 테스트 (티어링 검증)
- `/api/note/summarize` 엔드포인트 응답 확인
- `/api/note/comment` 엔드포인트 응답 확인
- Google Calendar 연결 상태 (기존 `cal-status`와 연동)

**3. Gemini 테스트 모델명 변경**
`/api/test` 내 Gemini 테스트 (server.js:184)가 `gemini-2.0-flash` 하드코딩 → `getGeminiApiUrl('flash')` 헬퍼 사용으로 변경

### H. 빠른 캡처 (Web Share Target) — 가치:중간 / 난이도:높음
- 다른 앱에서 공유 → VaultVoice로 직접 저장

### I. 자동 일일 다이제스트 — 가치:중간 / 난이도:높음
- 매일 특정 시간 푸시 알림 (할일 현황 + 메모 요약 + 내일 일정)

### J. 대화형 노트 편집 (AudioPen) — 가치:낮음 / 난이도:중간
- "이 메모를 보고서 형태로 바꿔줘" → edit_note 도구

### K. 음성 메모 하이라이트 (Granola) — 가치:낮음 / 난이도:높음
- 전사 중 특정 구간 "중요" 마킹

---

## 우선순위 + 실행 순서

| 순위 | 항목 | Phase | 파일 |
|------|------|-------|------|
| 1 | **Gemini 모델 티어링** (Flash/Pro 헬퍼) | 인프라 | server.js |
| 2 | 피드 AI 버튼 제거 | 축1-1 | index.html, app.js, app.css |
| 3 | 카드별 액션 추가 (요약/삭제/코멘트/Jarvis) | 축1-2 | app.js, app.css, index.html |
| 4 | 서버 엔드포인트 (note/summarize, note/delete, note/comment) | 축1-3 | server.js |
| 5 | Jarvis 도구 6개 추가 (+ add_comment) | 축2 | server.js |
| 6 | Jarvis 시스템 프롬프트 업데이트 | 축2 | server.js |
| 7 | G. Jarvis 기능 안내 버튼 (온보딩) | 축3 | index.html, app.js, app.css, server.js |
| 8 | A. 관련 노트 추천 (카드 상세 하단) | 축3 | app.js, server.js |
| 9 | C. 주간 리뷰 (Jarvis 명령) | 축3 | server.js |
| 10 | D. 음성 전사 일정 감지 | 축3 | app.js (1줄) |
| 11 | E. 검색 필터 연결 | 축3 | app.js, server.js |
| 12 | B. 액션아이템 추출 (전사 파이프라인) | 축3 | server.js |
| 13 | F-1. 노트 제목 자동생성 + backfill | 축3 | server.js |
| 14 | F-2. 위키링크 자동 삽입 | 축3 | server.js |
| 15 | 설정탭 연동 업데이트 | 정합성 | index.html, app.js, server.js |
| 16 | **테스트: DUMMY NOTE로 기능 검증** | 검증 | 전체 (아래 상세) |
| 17+ | H~K | 후속 | - |

## 테스트 계획 (E2E — DUMMY NOTE 기반)

### 사전 준비
- DUMMY NOTE 3개 생성: `99_vaultvoice/` 에 voice/memo/url 유형 각 1개
  - `TEST_voice.md` — 회의록 스타일 (일정 키워드 포함: "다음 수요일 3시 회의")
  - `TEST_memo.md` — 짧은 메모 (코멘트 테스트용)
  - `TEST_url.md` — URL 요약 노트 (위키링크 매칭 테스트용)
- 서버 재시작 후 테스트 실행

### 축1 테스트: 피드 탭 리디자인

| # | 테스트 | 검증 기준 | 커버 기능 |
|---|--------|----------|----------|
| T1 | 피드 탭 진입 | AI 요약/태그추천/분류 버튼 **미표시**, `#ai-result` 영역 없음 | 1-1 버튼 제거 | ✅ API | ✅ UI |
| T2 | 카드 요약 버튼 (✦) 클릭 | DUMMY 카드에 `.card-summary` 인라인 표시, Gemini 응답 포함 | 1-2 요약 + 1-3 /api/note/summarize | ✅ API | ✅ UI |
| T3 | 카드 삭제 버튼 (🗑) 클릭 | confirm 다이얼로그 → 확인 → 카드 사라짐 + 파일 삭제됨 | 1-2 삭제 + 1-3 /api/note/delete | ✅ API |
| T4 | 카드 삭제 — 취소 | confirm에서 취소 → 카드 유지, 파일 존재 | 1-2 삭제 안전장치 | ✅ API |
| T5 | 카드 Jarvis 버튼 (💬) 클릭 | AI 탭으로 전환 + 해당 노트 컨텍스트가 Jarvis 입력에 반영 | 1-2 Jarvis 연동 | ✅ UI |
| T6 | 카드 코멘트 버튼 클릭 | 입력창 표시 → 자연어 입력 → 노트 파일에 `## 코멘트` 섹션 append | 코멘트 기능 | ✅ API | ✅ UI |
| T7 | 삭제 보안: 99_vaultvoice 외 파일 | `/api/note/delete`에 다른 경로 파일명 전달 → 거부 | 보안 | ✅ API |

### 축2 테스트: Jarvis 도구

| # | 테스트 | 검증 기준 | 커버 도구 |
|---|--------|----------|----------|
| T8 | Jarvis: "TEST_memo 삭제해줘" | delete_note 호출 → 파일 삭제 확인 | delete_note | ⬜ UI |
| T9 | Jarvis: "오늘 할일 중 첫번째 완료 처리" | toggle_todo 호출 → 체크박스 토글 | toggle_todo | ⬜ UI |
| T10 | Jarvis: "오늘 할일 중 두번째 삭제" | delete_todo 호출 → 해당 라인 제거 | delete_todo | ⬜ UI |
| T11 | Jarvis: "TEST_voice 요약해줘" | summarize_note 호출 → AI 요약 응답 | summarize_note | ✅ UI |
| T12 | Jarvis: URL 전달 | process_url 호출 → 새 노트 생성 + 요약 포함 | process_url | ⬜ UI |
| T13 | Jarvis: "이 노트에 '좋은 내용이다'라고 코멘트" | add_comment 호출 → 정리된 코멘트 append | add_comment | ⬜ UI |

### 축3 테스트: 신규 기능

| # | 테스트 | 검증 기준 | 커버 기능 |
|---|--------|----------|----------|
| T14 | Jarvis 온보딩 버튼 표시 | AI 탭 진입 시 기능 안내 버튼 5개 표시, 대화 시작 후 숨김 | G. 온보딩 | ✅ UI |
| T15 | 온보딩 버튼 클릭 | 버튼 클릭 → Jarvis가 예시+설명 응답 | G. 온보딩 | ✅ UI |
| T16 | 관련 노트 추천 | DUMMY 카드 상세 시 하단에 관련 노트 최대 3개 표시 | A. 관련 노트 | ✅ API |
| T17 | 검색 필터: 유형 | 검색어 입력 + filterType=voice → voice 노트만 결과 | E. 검색 필터 | ✅ API | ✅ UI |
| T18 | 검색 필터: 기간 | 검색어 입력 + filterDate=7 → 최근 7일 노트만 결과 | E. 검색 필터 | ✅ API |
| T19 | 음성 전사 → 일정 감지 | "다음 수요일 3시 회의" 포함 전사 저장 → 일정 감지 팝업 | D. 일정 감지 | ⬜ UI |
| T20 | 노트 제목 자동생성 | 새 노트 저장 시 frontmatter에 `title` 필드 자동 추가 | F-1. 제목 생성 | ✅ API |
| T21 | 기존 노트 backfill | `/api/notes/backfill-titles` 호출 → DUMMY 노트에 title 추가됨 | F-1. backfill | ✅ API |
| T22 | 위키링크 삽입 | title이 있는 노트 본문에 다른 노트 title 언급 시 `[[링크]]` 변환 | F-2. 위키링크 | ⬜ UI |

### 인프라 테스트: Gemini 모델 티어링

| # | 테스트 | 검증 기준 | 커버 기능 |
|---|--------|----------|----------|
| T23 | Flash 호출 확인 | 코멘트 정리/태그 추출 시 서버 로그에 `gemini-2.0-flash` 표시 | 티어링 | ✅ API |
| T24 | Pro 호출 확인 | Jarvis 대화/URL 요약 시 서버 로그에 `gemini-2.5-pro` 표시 | 티어링 | ✅ API |
| T25 | Pro fallback | Pro 모델 장애 시뮬레이션 → Flash로 자동 재시도 | 티어링 fallback | ⬜ 수동 |

### 설정탭 연동 테스트

| # | 테스트 | 검증 기준 | 커버 기능 |
|---|--------|----------|----------|
| T26 | 기능 안내: 피드 탭 설명 | "카드별 AI 요약·삭제·코멘트" 문구 포함, 구 "AI 요약·태그 추천·분류" 미포함 | 안내 텍스트 | ✅ UI |
| T27 | 기능 안내: Jarvis 설명 | "노트 요약·삭제·코멘트, URL 처리" 등 신규 기능 반영 | 안내 텍스트 | ✅ UI |
| T28 | 전체 기능 점검 버튼 | Gemini Flash + Pro 연결 OK, 신규 엔드포인트 OK 표시 | 기능 테스트 확장 | ✅ UI |
| T29 | 코멘트 보안: path traversal | `/api/note/comment`에 `../` 포함 파일명 → 거부 | 보안 | ✅ API |

### 크로스 기능 E2E 테스트 (기능 간 연계)

| # | 테스트 | 검증 기준 | 커버 기능 |
|---|--------|----------|----------|
| T30 | 피드 카드 Jarvis → 코멘트 | 카드에서 💬 Jarvis → AI탭 전환 → "이 노트에 코멘트해줘" → add_comment 작동 | 축1↔축2 연계 | ⬜ UI |
| T31 | process_url → 제목 자동생성 | Jarvis로 URL 처리 → 새 노트에 title 자동 포함 | process_url + F-1 | ✅ API |
| T32 | 제목 backfill → 관련 노트 추천 | backfill로 title 추가된 DUMMY → 관련 노트에 title 표시 | F-1 + A | ⬜ UI |
| T33 | 코멘트 2회 연속 추가 | 같은 노트에 코멘트 2번 → `## 코멘트` 섹션에 2줄 모두 타임스탬프 포함 | 코멘트 중복 | ✅ API |
| T34 | 온보딩 → 실제 기능 실행 | 온보딩 "URL 저장·요약" 클릭 → 설명 확인 → 실제 URL 전달 → 정상 처리 | G → process_url | ⬜ UI |
| T35 | 검색 필터 + Jarvis search 정합성 | 동일 키워드로 검색탭 필터 결과 vs Jarvis search 결과 비교 | E + Jarvis search | ⬜ UI |

### Playwright UI 테스트 결과 (E2E)

실행 파일: `e2e/ui-jarvis.spec.js`
실행 환경: Playwright + Chromium headless, viewport 390×844

| # | 테스트 | 결과 | 비고 |
|---|--------|------|------|
| T1-UI | 피드 탭 구 AI 버튼 없음 | ✅ PASS | |
| T2-UI | 카드 요약 버튼 → AI 요약 인라인 | ✅ PASS | Pro 응답 ~25초 |
| T5-UI | 카드 Jarvis 버튼 → AI탭 전환 + 노트 컨텍스트 | ✅ PASS | |
| T6-UI | 카드 코멘트 토글 + 제출 | ✅ PASS | Lite 응답 ~10초 |
| T11-UI | Jarvis 노트 요약 채팅 | ✅ PASS | 응답 수신 확인 |
| T14-UI | 온보딩 버튼 5개 표시 | ✅ PASS | |
| T15-UI | 온보딩 클릭 → Jarvis 전송 + 숨김 | ✅ PASS | |
| T17-UI | 검색 필터 type=voice | ✅ PASS | |
| T26-UI | 설정 피드탭 안내 텍스트 | ✅ PASS | |
| T27-UI | 설정 Jarvis 안내 텍스트 | ✅ PASS | |
| T28-UI | 전체 기능 점검 버튼 | ✅ PASS | |

**결과: 12 PASS / 0 FAIL**

### 테스트 후 정리
- 테스트 결과 보고 (PASS/FAIL 테이블)
- DUMMY NOTE는 사용자 삭제 지시 전까지 유지 (추가 요청 대비)
- FAIL 항목 수정 후 재테스트

## 변경 파일 총 목록

| 파일 | 변경 |
|------|------|
| `server.js` | Gemini 티어링 헬퍼 + 엔드포인트 3개(summarize/delete/comment) + Jarvis 도구 6개 + 시스템 프롬프트 + 관련노트 API + 검색 필터 + 제목 자동생성 + backfill + 위키링크 |
| `public/app.js` | 피드 카드 액션(요약/삭제/코멘트/Jarvis) + doAI 제거 + Jarvis 연동 + 관련노트 UI + 온보딩 버튼 + 검색 필터 연결 + 음성 일정감지 |
| `public/app.css` | 카드 액션 스타일 + 코멘트 입력 스타일 + AI 버튼 스타일 제거 + 온보딩 버튼 스타일 |
| `public/index.html` | AI 버튼 영역 제거 + Jarvis 온보딩 영역 추가 |

규모: L (4파일, 독립 모듈 5개+) → `코딩 wf` 스킬 실행 대상
