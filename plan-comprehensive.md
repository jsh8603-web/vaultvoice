# VaultVoice 종합 개선 계획

## 실행 엔진 확정
- **1단계 (Critical Bugs)**: 직접 수행 — 검색 깨짐 + apiFetch 미정의 즉시 수정
- **2단계 (Core Features)**: harness — 화자 매칭 + 엔티티 편집 + 노트 편집 (비즈니스 로직 핵심)
- **3단계 (Uniformity)**: 경량화 — 태그 균등화 + frontmatter 통일 + 오프라인 큐 (기계적 적용)

---

> **최우선 원칙**: 기존 기능의 안정성을 절대 해치지 않는다.

---

## 리서치 출처 요약

| # | 주제 | 핵심 결론 | 근거 |
|---|------|----------|------|
| R1 | 화자 식별 | LLM 컨텍스트 기반 70-85% 정확도, 후처리 권장 | Gemini CLI 리서치 (화자1/화자2 + entity_map 교차) |
| R2 | 한국 장소 검증 | 카카오 로컬 API 추천 (일 10만건 무료), 3단계 하이브리드 | Gemini CLI 리서치 (카카오 vs 네이버 비교) |
| R3 | 모바일 편집 | textarea > contenteditable (한글 IME 안정성), debounce 1s 자동저장 | Gemini CLI 리서치 (Simplenote/Standard Notes 비교) |
| R4 | 한국어 STT 보정 | Jamo 기반 거리 > 음절 Levenshtein, es-hangul 라이브러리 | Gemini CLI 리서치 (음운변화 패턴 6종) |
| R5 | 오프라인 큐 | IndexedDB + Background Sync API, iOS fallback(online event) | Gemini CLI 리서치 (Workbox backgroundSync 패턴) |

---

## 카테고리 A: 크리티컬 버그 (즉시 수정)

### A1. 검색 API 필드 불일치 (🔴 Critical)
- **현상**: 검색 결과가 화면에 표시 안 됨
- **원인**: server.js:2674 반환 `{ date, path, matches }` ↔ app.js:1296 기대 `{ filename, title, preview, tags, dateStr }`
- **수정**: server.js 검색 응답을 클라이언트 기대 형식으로 변환
- **파일**: server.js (~L2674), app.js (~L1296)

### A2. apiFetch 미정의 (🔴 Critical)
- **현상**: app.js:2413,2421,2442에서 `apiFetch()` 호출하지만 함수 미정의
- **원인**: `api()` (L69) 또는 `apiUpload()` (L79)만 존재
- **수정**: `apiFetch` → `api`로 일괄 치환 (동일 시그니처 확인 후)
- **파일**: app.js (~L2413, L2421, L2442)

### A3. Push Notification 토큰 미전송
- **현상**: subscription 저장 API 없음 → 알림 작동 불가
- **수정**: `/api/push/subscribe` 엔드포인트 + 토큰 저장 구현
- **파일**: server.js (신규 endpoint), app.js (sw registration 후 subscribe)

---

## 카테고리 B: 핵심 누락 기능

### B1. 노트 본문 편집 기능 (📱 MVP)
> **리서치 R3 반영**: textarea 기반이 한글 IME 안정성 최고

- **현상**: openNoteDetail에서 본문 읽기만 가능, 수정 불가
- **해결**:
  1. openNoteDetail에 '편집' 버튼 추가 → textarea 전환 (auto-resize)
  2. `input` 이벤트에 debounce(1000ms) 자동저장
  3. 저장 API: `PUT /api/note/content` → frontmatter 파싱 + body 분리 저장
  4. 저장 후 `noteCache.invalidate(filename)`
  5. 마크다운 미리보기: 별도 '미리보기' 탭 (marked.js, 이미 프로젝트 내 CDN 로드됨)
- **키보드 대응**: 가상 키보드 위 한 줄 툴바 (Bold, List, Checklist)
- **파일**: app.js (openNoteDetail ~L1085), server.js (신규 PUT endpoint)

### B2. 오프라인 쓰기 큐 (📱 PWA 필수)
> **리서치 R5 반영**: IndexedDB + Background Sync + iOS fallback

- **현상**: 네트워크 끊기면 메모 저장 실패, 데이터 유실
- **해결**:
  1. `offline-db.js`: IndexedDB 'post-queue' 스토어 (url, fields, blob, timestamp)
  2. `sw.js`: `sync` 이벤트 리스너 → 큐 순차 재전송
  3. `app.js`: fetch 실패 시 IndexedDB에 저장 + sync 등록
  4. iOS fallback: `online` 이벤트 + `visibilitychange`에서 큐 처리
  5. multipart/form-data: Blob 분리 저장 → 재전송 시 FormData 재구성
- **UI**: 오프라인 배너 표시 + 대기 중 메모 수 뱃지
- **파일**: public/offline-db.js (신규), sw.js, app.js

### B3. 화자 매칭 시스템
> **리서치 R1 반영**: LLM 후처리 + entity_map 교차 매칭 (70-85% 정확도)

#### B3-1. 자동 매칭 (파이프라인 stage)
- `runPipeline` 내 `nerStage` 직후 `speakerResolveStage` 추가
- Gemini Flash 프롬프트: 전사 텍스트 + entity_map persons 상위 20명 → 화자-실명 매핑
- **신뢰도 기준**: confidence ≥ 0.7 → 자동 치환, < 0.7 → `speaker_candidates` 저장
- **가장 신뢰할 수 있는 단서** (리서치 R1 순위): 호칭(님/씨) > 자기소개 > 고유 식별자(프로젝트명) > 시간 맥락 > 역할 특화 언어

#### B3-2. 한국인 이름 음운 보정
> **리서치 R4 반영**: Jamo 기반 거리 + 음운변화 패턴

- **음운 오류 패턴 6종** (STT 빈출):
  - 연음: 박은혜 → 바근혜
  - 비음화: 국민 → 궁민
  - 유음화: 신라 → 실라
  - 경음화: 울산 → 울싼
  - 격음화: 박형준 → 바켱준
  - 모음 혼동: ㅓ/ㅗ, ㅐ/ㅔ
- **구현**: `es-hangul` 라이브러리로 Jamo 분해 → 가중 Levenshtein (음운 유사 자모 쌍 cost=0.2)
- **성씨 DB**: 한국 성씨 286개 (2015 인구조사 기반) → NER 결과 성씨 검증
- **파일**: entityIndexer.js (jamoLevenshtein 강화), name-rules.json (신규)

#### B3-3. 수동 매칭 UI
- voice 카드에 화자 배지 (`👤 화자1 · 화자2`)
- 클릭 → 편집 팝업 (entity_map persons 자동완성 + speaker_candidates 추천)
- 저장 시: frontmatter.speakers 업데이트 + body "화자1:" → "김철수:" 치환
- **API**: `POST /api/note/speakers/save`

### B4. 엔티티 태그 인라인 편집
- 카드/상세에 엔티티 칩 표시 (`👤 김철수` `📍 강남역` `📂 프로젝트A`)
- 클릭 → 인라인 편집 (entity_map 자동완성)
- 저장 시 연쇄 업데이트: frontmatter + body + entity_map + entity note
- **API**: `POST /api/note/entities/save`

### B5. 장소명 검색 보정
> **리서치 R2 반영**: 카카오 로컬 API + 행정구역 로컬 사전

- **3단계 하이브리드**:
  1. LLM 추출: NER places에서 장소 후보 식별
  2. 로컬 사전 매칭: 행정구역 JSON (시/도→시/군/구→읍/면/동) 기반 오타 즉시 보정
  3. API 확정: 카카오 로컬 API keyword 검색 → 정확한 주소 + 위경도 취득
- **비용**: 하루 10건 미만 → 카카오 무료 티어(일 10만건)로 충분
- **로컬 사전 출처**: code.go.kr 행정표준코드 또는 GitHub korea-administrative-district
- **파일**: entityIndexer.js (장소 보정 로직), place-dict.json (신규)

---

## 카테고리 C: 사용자 수정 = 고신뢰 소스 (Cross-cutting)

### C1. userVerified 플래그 시스템
- entity_map.json 스키마 확장: `userVerified: boolean` + `aliases: {}` 필드
- 사용자가 편집 → 자동으로 userVerified: true 설정
- 이후 NER fuzzy match 시 userVerified 엔트리 우선 + threshold 완화
- correctionMap 자동 축적: `{ "강남력": "강남역", "김철쑤": "김철수" }`
- **파일**: entity_map.json (스키마), entityIndexer.js (mergeNerResult), server.js (save endpoints)

---

## 카테고리 D: 데이터소스 균등화

### D1. generateNoteMeta에 tags 필드 추가
- **현상**: NOTE_META_SCHEMA에 tags 없음 → text/memo/todo AI 태그 = 0
- **수정**: schema에 tags array 추가, 프롬프트에 "관련 한국어 태그 3-5개" 지시
- injectMetaToFrontmatter에서 기존 tags와 merge (중복 제거)
- **파일**: server.js:5199 (schema), :5216 (prompt), :5258 (inject)

### D2. status 필드 통일
- 현재: voice=fleeting, image=transcribed, url=summarized → 비일관
- 변경: 생성 시 `'raw'` → generateMeta 후 `'processed'` → perspectiveStage 후 `'analyzed'`
- **파일**: server.js:2953 (createAtomicNote), generateMeta/perspectiveStage

### D3. text/memo 사전 태그 보강
- `/api/process/text`에서 기본 태그에 `'memo'` 추가 (image='image', url='url' 패턴 통일)
- **파일**: server.js (~L4956)

### D4. NER 화자 레이블 필터링
- `화자\d+`, `Speaker\d+` 패턴을 persons에서 필터링
- **파일**: entityIndexer.js (~L164 mergeNerResult)

---

## 카테고리 E: UX 개선

### E1. 피드 카드 이미지 미표시
- **현상**: image 소스 카드에서 원본 이미지 300자 텍스트 미리보기만 표시
- **수정**: frontmatter의 original_image 경로로 썸네일 표시
- **파일**: app.js (renderFeedCards ~L652)

### E2. 카드 미리보기 300자 절삭 불충분
- **현상**: 300자 중간에서 잘려 문장 미완성
- **수정**: 300자 이후 첫 문장 종결 부호(. ! ? 。)까지 확장, 최대 400자
- **파일**: app.js (~L676)

### E3. 날짜 네비게이션 비효율
- **현상**: 한 달 전 메모 접근 시 무한 스크롤만 의존
- **수정**: 상단 날짜 클릭 → 캘린더 피커 (기존 datepicker 재활용)
- **파일**: app.js, index.html

### E4. 태그 필터 다중 선택 불가
- **현상**: 태그 클릭 시 단일 필터만 → "AI" + "리서치" 교집합 불가
- **수정**: 태그 클릭 시 토글 방식 다중 선택 → AND 필터
- **파일**: app.js (filterByTag 로직)

### E5. 음성 녹음 상태 피드백 부족
- **현상**: 녹음 중 시각적 표시 미약 (빨간 점만)
- **수정**: 파형 시각화 (AnalyserNode + Canvas) + 경과 시간 표시
- **파일**: app.js (녹음 UI)

### E6. 에러 메시지 사용자 비친화적
- **현상**: API 실패 시 "Error" 텍스트만 표시, 원인/대응 불명
- **수정**: 상황별 한국어 에러 메시지 + 재시도 버튼
- **파일**: app.js (api, apiUpload 에러 핸들링)

### E7. 대용량 녹음 업로드 프로그레스 없음
- **현상**: 긴 녹음 업로드 시 무반응 → 사용자 중복 제출
- **수정**: XMLHttpRequest.upload.onprogress → 프로그레스 바
- **파일**: app.js (apiUpload)

### E8. sw.js 캐시 전략 네트워크 우선
- **현상**: 매번 네트워크 요청 → 느린 Pi에서 체감 느림
- **수정**: 정적 자원(CSS/JS/이미지) cache-first + API는 network-first
- **파일**: sw.js

### E9. 검색 결과 하이라이트 없음
- **현상**: 검색어와 결과 매칭 부분 식별 어려움
- **수정**: A1 수정 시 함께 — matches 배열에서 검색어 위치 `<mark>` 래핑
- **파일**: app.js (검색 결과 렌더링)

### E10. 파이프라인 진행 상태 미표시
- **현상**: AI 분석 중 "처리중..." 만 표시, 어느 단계인지 불명
- **수정**: Server-Sent Events로 단계별 진행 알림 (meta → NER → context → ...)
- **파일**: server.js (runPipeline), app.js (EventSource)

### E11. 캘린더 뷰 날짜별 메모 유무 미표시
- **현상**: 캘린더에서 어느 날에 메모가 있는지 식별 불가
- **수정**: 메모 존재 날짜에 도트 표시
- **파일**: app.js (캘린더 렌더링)

### E12. URL 메모 원본 링크 접근 어려움
- **현상**: URL 소스 카드에서 원본 URL 클릭 불가
- **수정**: 카드에 원본 URL 링크 버튼 추가
- **파일**: app.js (renderFeedCards)

---

## 실행 우선순위 및 엔진 배정

### 1단계: Critical Bug Fix (직접 수행, 즉시)

| # | 항목 | 난이도 | 파일 |
|---|------|--------|------|
| A1 | 검색 API 필드 불일치 | S (20줄) | server.js, app.js |
| A2 | apiFetch 미정의 | S (3줄 치환) | app.js |

### 2단계: Core Features (Harness — Worker+Verifier+Healer)

비즈니스 로직 핵심, entity 무결성 영향

| # | 항목 | 난이도 | 파일 |
|---|------|--------|------|
| B3 | 화자 매칭 (자동+수동+음운보정) | L | server.js, entityIndexer.js, app.js, name-rules.json |
| B4 | 엔티티 태그 인라인 편집 | M | server.js, app.js |
| B5 | 장소명 검색 보정 | M | entityIndexer.js, place-dict.json |
| C1 | userVerified 플래그 시스템 | M | entity_map.json, entityIndexer.js, server.js |
| D4 | NER 화자 레이블 필터링 | S | entityIndexer.js |
| B1 | 노트 본문 편집 | M | app.js, server.js |

### 3단계: Uniformity + UX (경량화 — Opus Supervisor + Sonnet Worker)

기계적 적용 + UI 개선

| # | 항목 | 난이도 | 파일 |
|---|------|--------|------|
| D1 | generateMeta tags 추가 | S | server.js |
| D2 | status 통일 | S | server.js |
| D3 | text/memo 태그 보강 | S | server.js |
| B2 | 오프라인 쓰기 큐 | M | offline-db.js, sw.js, app.js |
| E1~E12 | UX 개선 12항목 | S~M | app.js, sw.js, index.html |
| A3 | Push Notification | M | server.js, app.js |
| E8 | sw.js cache-first | S | sw.js |

---

## 총 항목 수: 28건

| 카테고리 | 건수 | 핵심 |
|----------|------|------|
| A: Critical Bug | 3 | 검색 깨짐, apiFetch 미정의, Push 미작동 |
| B: Core Feature | 5 | 편집, 오프라인, 화자, 엔티티, 장소 |
| C: Cross-cutting | 1 | userVerified 신뢰도 시스템 |
| D: Uniformity | 4 | 태그, status, NER 필터 |
| E: UX | 12 | 이미지, 검색, 네비게이션, 에러 등 |

---

## 기술 의존성 (신규)

| 패키지/API | 용도 | 비용 |
|------------|------|------|
| es-hangul | Jamo 분해/조합 (STT 보정) | 무료 (npm) |
| marked.js | 마크다운 렌더링 (노트 편집 미리보기) | 무료 (이미 CDN 로드) |
| 카카오 로컬 API | 장소명 검증 + 지오코딩 | 무료 (일 10만건) |
| IndexedDB | 오프라인 큐 저장 | 브라우저 내장 |
| Background Sync API | 오프라인 후 자동 재전송 | 브라우저 내장 (iOS 미지원 → fallback) |

---

## 리서치 원본 저장

- 화자 식별: `~/.claude/docs/archive/research-raw/vaultvoice-speaker-id-2026-04-05.txt`
- 한국 장소 검증: `~/.claude/docs/archive/research-raw/vaultvoice-place-validation-2026-04-05.txt`
- 모바일 편집: `~/.claude/docs/archive/research-raw/vaultvoice-mobile-editing-2026-04-05.txt`
- 한국어 STT 보정: `~/.claude/docs/archive/research-raw/vaultvoice-korean-stt-2026-04-05.txt`
- 오프라인 큐: `~/.claude/docs/archive/research-raw/vaultvoice-offline-queue-2026-04-05.txt`
