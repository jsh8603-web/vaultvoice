# VaultVoice 성능 최적화 계획

> **최우선 원칙**: 기존 기능의 안정성을 절대 해치지 않는다. 모든 변경은 기존 동작을 보존하며, 캐시/병렬화/조건부 실행 등 비파괴적 기법만 사용한다. 변경 후 반드시 기존 E2E 테스트를 ��과해야 한다.

---

## Phase 1: 체감 지연 핵심 해소 (서버 I/O + 클라이언트)

### P1-1. `getVVNotesForDate` 동기 I/O → 캐시 + 비동기화
- **파일**: `server.js:3630~3661`
- **문제**: 피드/투두/검색 등 모든 핫패스에서 매 요청마다 `readdirSync` + `readFileSync` 전체 실행
- **해결**: 날짜별 파싱 결과 인메모��� 캐시 (TTL 30초). `createAtomicNote`/삭제 시 해당 날짜 캐시만 무효화
- **영향 범위**: `/api/feed/:date`, `/api/daily/:date`, `/api/daily/:date/todos`, `executeGetRecentNotes`

### P1-2. `/api/tags` 매 요청 100파일 readFileSync → 인메모리 태그 카운트 캐시
- **파일**: `server.js:2691~2715`
- **문제**: 최대 100개 파일을 동기 읽기하여 태그 카운트
- **해결**: `_tagCountCache` (TTL 60초) 유지, `createAtomicNote` 시 증분 갱신

### P1-3. 클라이언트 feed + todos 직렬 → `Promise.all` 병렬
- **파일**: `app.js:568~647`
- **���제**: `loadFeed()`가 `/api/feed/:date` 완료 후 `loadTodosForFeed()` 호출 — 직렬 2요청
- **해결**: `Promise.all([fetchFeed(), fetchTodos()])` 병렬 발행

### P1-4. `/api/notes/recent` 7일치 `getNotesForDate` 반복 호출 → 단일 스캔
- **파일**: `server.js:2720~2755`
- **문제**: 7일 루프 × `getNotesForDate` = 최대 7회 파일 스캔
- **해결**: NOTES_DIR 한 번 readdirSync → 파일명 prefix로 날짜 필터

### P1-5. `loadTitleCache()` 서버 시작 시 전체 파일 동기 읽기 → lazy + 증분
- **파일**: `server.js:169~182`
- **문제**: 서버 시작 시 모든 .md 파일을 readFileSync로 읽어 titleCache 구축
- **해결**: setImmediate 비동기 초기화 + createAtomicNote/generateMeta 시 증분 추가

---

## Phase 2: AI 파이프라인 최적화 (Gemini 호출 병렬화)

### P2-1. 노트 저장 파이프라인 7단계 순차 → 독립 단계 병렬화
- **파일**: `server.js:2877~2947`
- **문제**: 7단계 순차 Gemini 호출. 단계당 1~5초 × 7 = 7~35초
- **해결**:
  - Group A (순차): `generateMeta` → `nerStage` → `contextStage`
  - Group B (A 후 병렬): `perspectiveStage`, `actionItemsStage`, `consistencyStage`
  - Group C (B 후): `tldrStage` → `ragStage`
- **주의**: 파일 쓰기 경쟁 조건 — Group B 각 단계는 파일을 읽고 쓰므로 섹션별 append 방식으로 충돌 회피

### P2-2. Jarvis pre-search 조건부 실행
- **파일**: `server.js:1857~1866`
- **문제**: 매 Jarvis 메시지마다 `executeSearch()` 사전 실행 (Gemini Pro + vault 스캔)
- **해결**: 인사/간단 지시에는 pre-search 생략. 키워드 패턴 매칭으로 판별 (보수적)

### P2-3. `expandKeywords` Gemini Pro → Flash/Lite + LRU 캐시
- **파일**: `server.js:1557~1578`
- **문제**: 검색 키워드 확장에 Gemini Pro 사용, 동일 쿼리 매번 호출
- **해결**: Flash/Lite 다운그레이드 + 50개 LRU 캐시 (TTL 10���)

### P2-4. entityIndexer `backgroundScan` 병렬화 + 증분 스캔
- **파일**: `entityIndexer.js:304~335`
- **문제**: 노트 100개 시 순차 Gemini NER 호출 = 25~50초
- **해결**: `p-limit(3)` 병렬 + last_updated 이후 파일만 증분 스캔

---

## Phase 3: 캐시/RegExp/벡터 최적화

### P3-1. `applyPrivacyShield` RegExp 매번 생성 → 사전 컴파일
- **파일**: `server.js:3083~3093`
- **문제**: 정적 PRIVACY_KEYWORDS로 매 호출마다 `new RegExp` 생성 (8곳+ 호출)
- **해결**: 모듈 로드 시 `PRIVACY_REGEXES` 배열로 사�� 컴파일

### P3-2. `updateVectorIndex` — `_vectorCache` 활용하여 파일 재읽기 제거
- **파일**: `server.js:3063~3076`
- **해결**: `_vectorCache`가 유효하면 메모리에서 직접 수정, 비동기 flush

### P3-3. `/api/search/ai` 동기 readFileSync → `Promise.allSettled` 배치
- **파일**: `server.js:2650~2658`
- **해결**: `/api/search`와 동일한 배치(20개 병렬) 패턴 적용

### P3-4. `insertWikiLinks` titleCache O(n) → 길이 내림차순 정렬
- **파일**: `server.js:184~195`
- **해결**: 타이틀 길이 내림차순 정렬 → 긴 것 우선 매칭으로 오탐 방지

### P3-5. `checkConsistency` vectors.json `JSON.parse` → `_vectorCache` 우선
- **파일**: `server.js:3095~3120`
- **해결**: `_vectorCache` null일 때만 파일에서 읽기

### P3-6. `levenshtein` O(n) 탐색 → 길이 사전 필터
- **파일**: `server.js:1387`, `entityIndexer.js`
- **해결**: 이름 길이 차이 > 2 항목 사전 필터

---

## Phase 4: 클라이언트 + 서비스워�� 최적화

### P4-1. `esc()` DOM 기반 → 문자열 치환
- **파일**: `app.js:37~41`
- **해결**: `str.replace(/[&<>"']/g, fn)` — DOM 생성 비용 제거

### P4-2. `checkCalendarStatus` 중복 호출 제거 + 서버 캐시
- **파일**: `app.js:126, 179, 1492` / `server.js:2274~2295`
- **해결**: 서버 `_calStatusCache` (TTL 5분), 클라이언트 중복 방지

### P4-3. sw.js 정적 자산 cache-first 전환
- **파일**: `sw.js:82~97`
- **해결**: 정적 자산 cache-first + CACHE_NAME 버전 갱신. API만 network-first

### P4-4. 검색 debounce 1500ms → 500ms + AbortController
- **파일**: `app.js:2308~2311`
- **해결**: 300~500ms debounce + AbortController

### P4-5. `/api/vm/recent` vault 전체 재귀 스캔 → `getAllMdFilesCached`
- **파일**: `server.js:3854~3882`
- **해결**: 캐시된 파일 목록 + mtime 정렬

### P4-6. `require('./package.json').version` → 시작 시 상수화
- **파일**: `server.js:418`

### P4-7. request logger 조건부 실행
- **��일**: `server.js:227~232`
- **해결**: `NODE_ENV !== 'production'` 또는 debug 환경변수 기반

---

## Phase 5: 추가 발견 사항

### P5-1. `getActivitySummary` N일치 전체 동기 읽기 → 메타 캐시
- **파일**: `server.js:1265~1321`
- **해결**: P1-1 날짜별 캐시 또는 별도 메타데이터 캐시 활용

### P5-2. `summarizeTopic` 동일 패턴
- **파일**: `server.js:1324~1377`
- **해결**: P1-1 ��시 공유

### P5-3. `getPersonContext` + `prepMeeting` NOTES_DIR 전체 순차 스캔
- **파일**: `server.js:1495~1555`, `server.js:1380~1464`
- **해결**: entity_map의 interaction 목록에서 파일명 직접 조회 (인덱스 기반)

### P5-4. `buildContents` history에 `applyPrivacyShield` 매 요��� 반복
- **파일**: `server.js:1827~1842`
- **해결**: 마스킹된 history 세션 캐시 또는 중복 마스킹 생���

### P5-5. `buildDateIndexFromVault` stale 시 전체 재빌드 블로킹
- **파일**: `server.js:3194~3237`
- **해결**: 비동기 백그라운드 재빌드 + 기존 캐시 유지

---

## 실행 우선순위 요약

| # | 항목 | 효과 | 난이도 |
|---|------|------|--------|
| 1 | P1-1 getVVNotesForDate 캐시 | ★★★★★ | M |
| 2 | P2-1 파이��라인 병렬화 | ★★��★★ | M |
| 3 | P1-3 클라이언트 병렬 호출 | ★★★★ | S |
| 4 | P2-2 Jarvis pre-search 조건부 | ★★★★ | S |
| 5 | P2-3 expandKeywords 캐시 | ���★★★ | S |
| 6 | P1-2 태그 캐시 | ★★★ | S |
| 7 | P3-1 RegExp 사전 컴파일 | ★★★ | S |
| 8 | P3-2 벡터 캐시 활용 | ���★★ | S |
| 9 | P3-3 AI검색 배치 비동기 | ★★★ | S |
| 10 | P4-3 sw.js cache-first | ★★★ | S |
| 11 | P2-4 entityIndexer 병렬+증분 | ★���★ | M |
| 12 | P1-4 recent notes 단일 스캔 | ★★ | S |
| 13 | P4-1 esc 문자열 치환 | ★★ | S |
| 14 | P4-2 calendar 중복 제거 | ★★ | S |
| 15 | P4-4 검색 debounce | ★★ | S |
| 16 | P4-5 vm/recent 캐시 | ★★ | S |
| 17 | P4-6 version 상수화 | ★ | S |
| 18 | P4-7 logger 조건부 | ★ | S |
| 19 | P3-4~P3-6 순회 최적화 | ★★ | S |
| 20 | P5-1~P5-5 추가 최적화 | ★★ | S~M |
| 21 | P1-5 titleCache lazy | ★★ | S |

**총 22개 항목**, 5 Phase 구성

<!-- PHASE-1-COMPLETE: 2026-04-05T06:30:00Z -->

---

## 아키텍처 검증 결과 (Phase 1 — TA/DA/Cost Agent Team)

### 필수 수정 (MUST FIX — plan 반영 완료)

| # | 항목 | 위험도 | 출처 | 대응 |
|---|------|--------|------|------|
| 1 | **P2-1** Group B 파일 쓰기 경쟁 — "섹션별 append" 불충분 | 상 | TA+DA+Cost | perspectiveStage/actionItemsStage는 전체 body 교체 패턴이므로 병렬 불가. **수정**: Group B 내부는 직렬 유지, Group A→B→C 간만 병렬화. 또는 메모리 상태 객체 통합 후 단일 flush |
| 2 | **P2-4** p-limit(3)이 15req/min 7배 초과 | 상 | TA+Cost | **수정**: p-limit(1) + 4초 간격. 증분 스캔만 우선 구현, 병렬화 보류 |
| 3 | **P1-1** todo/toggle·파이프라인 완료 시 캐시 무효화 누락 | 상 | DA | **수정**: todo/toggle, todo/delete, runPipeline 완료 시점에 invalidateDateCache 추가 |
| 4 | **P1-5** lazy 초기화 시 wikilink 영구 누락 | 상 | DA | **수정**: titleCache 비어있으면 동기 1회 로딩 fallback 유지 |
| 5 | **P4-3** sw.js 구버전 고착 | 상 | DA+Cost | **수정**: CACHE_NAME에 빌드 타임스탬프 연동 + skipWaiting()+clients.claim() |

### 설계 변경 (SHOULD FIX — plan 반영 완료)

| # | 항목 | 위험도 | 출처 | 대응 |
|---|------|--------|------|------|
| 6 | 캐시 무효화 분산 → NoteCache 통합 | 중 | Cost | P1-1/P1-2/P1-4/P4-5/P5-1~2의 개별 캐시 대신 NoteCache 단일 모듈로 통합. `invalidate(filename)` 단일 메서드 |
| 7 | insertWikiLinks RegExp 매번 생성 (신규 발견) | 중 | TA | `_compiledRegexMap: Map<filename, RegExp>` 추가, titleCache 갱신 시 동시 재빌드 |
| 8 | executeSearch content 무캐시 (신규 발견) | 중 | TA | content LRU 캐시(200항목, TTL 60초) — Jarvis pre-search 매 요청 전파일 readFileSync 제거 |
| 9 | P2-2 whitelist 방식 권장 | 중 | DA | 인사/감사 패턴만 명시 스킵, 나머지는 모두 pre-search 실행 |
| 10 | P1-1+P2-1 캐시 무효화 타이밍 | 중 | TA | runPipeline 완료 후 단일 무효화 (진행 중에는 이전 캐시 유지) |

### 제거 항목 (과잉 설계 판정)

| 항목 | 근거 | 출처 |
|------|------|------|
| **P4-6** version 상수화 | Node require 캐시가 이미 O(1) | Cost |
| **P3-6** levenshtein 길이 필터 | 수백~수천 규모에서 O(n) 무시 가능, 실측 근거 없음 | Cost |
| **P5-4** buildContents Privacy Shield 중복 | P3-1 구현 후 추가 최적화 여지 없음 | Cost |
| **P3-4** titleCache 정렬 (성능 목적) | 성능이 아닌 정확도 개선. 별도 기능 버그로 분리 | Cost |

### 최종 우선순위 (검증 후 재조정)

| 순서 | 항목 | 효과 | 난이도 |
|------|------|------|--------|
| 1 | P1-3 클라이언트 Promise.all | ★★★★ | S (3줄) |
| 2 | P3-1 RegExp 사전 컴파일 | ★★★ | S (3줄) |
| 3 | P4-4 debounce 500ms + AbortController | ★★★★ | S |
| 4 | NoteCache 통합 모듈 신규 | ★★★★★ | M (~50줄) |
| 5 | P1-1 getVVNotesForDate → NoteCache 연동 | ★★★★★ | M |
| 6 | P1-2 태그 → NoteCache 연동 | ★★★ | S |
| 7 | P2-2 Jarvis pre-search 조건부 (whitelist) | ★★★★ | S |
| 8 | P2-3 expandKeywords Flash + LRU | ★★★★ | S |
| 9 | P2-1 파이프라인 병렬화 (Group간만) | ★★★★★ | M |
| 10 | insertWikiLinks RegExp 캐시 (신규) | ★★★ | S |
| 11 | executeSearch content LRU (신규) | ★★★ | S |
| 12 | P4-3 sw.js cache-first + 버전 연동 | ★★★ | S |
| 13 | P2-4 entityIndexer 증분 스캔만 | ★★★ | S |
| 14 | P1-4 recent notes 단일 스캔 | ★★ | S |
| 15 | P4-2 calendar 클라이언트 중복 방지 | ★★ | S |
| 16 | P4-5 vm/recent → NoteCache 연동 | ★★ | S |
| 17 | P4-7 logger 조건부 | ★ | S |
| 18 | P1-5 titleCache lazy (동기 fallback 포함) | ★★ | S |
| 19 | P3-2 벡터 캐시 활용 | ★★ | S |
| 20 | P3-3 AI검색 배치 비동기 | ★★ | S |
| 21 | P3-5 checkConsistency _vectorCache 우선 | ★★ | S |
| 22 | P5-1~P5-3 Jarvis 도구 캐시 | ★★ | S |
| 23 | P5-5 dateIndex 비동기 재빌드 | ★★ | S |

<!-- PHASE-3-COMPLETE: 2026-04-05T06:35:00Z -->

---

## 구현 상세 (Phase 3 보완)

### NoteCache 모듈 명세

```javascript
// noteCache.js — 단일 인메모리 캐시 모듈
const TTL = parseInt(process.env.CACHE_TTL_NOTES) || 60000; // ms

class NoteCache {
  constructor() {
    this._byDate = new Map();    // date → Note[]
    this._tagCount = null;       // { tag: count } | null
    this._allFiles = null;       // string[] | null
    this._timestamps = new Map(); // key → lastUpdated
  }

  getNotesForDate(date)          // → Note[] | null (null=miss)
  setNotesForDate(date, notes)   // 캐시 저장
  getTagCount()                  // → {tag:count} | null
  setTagCount(data)
  getAllFiles()                   // → string[] | null
  setAllFiles(files)

  invalidate(filename)           // filename에서 날짜 추출 → 해당 date 캐시 삭제 + tagCount 리셋
  invalidateAll()                // 전체 리셋
  isStale(key)                   // TTL 만료 여부
}

module.exports = new NoteCache(); // 싱글턴
```

호출 지점:
- `createAtomicNote` 완료 후: `noteCache.invalidate(filename)`
- `deleteNote` 완료 후: `noteCache.invalidate(filename)`
- `todo/toggle`, `todo/delete` 완료 후: `noteCache.invalidate(filename)`
- `runPipeline` 완료 후 (ragStage 끝): `noteCache.invalidate(filename)`

### P2-2 Jarvis pre-search whitelist 패턴

생략 조건 (AND 조합):
1. 메시지 길이 < 10자
2. 명사 없음 (한글 2음절+ 단어 없음)
3. 의문사 없음 (뭐/어떻게/왜/언제/어디/누구/몇)

whitelist (무조건 스킵):
```javascript
const SKIP_PATTERNS = [
  /^(안녕|하이|ㅎㅇ|반가워|고마워|감사|ㅇㅋ|ㅎㅎ|넵|응|좋아|알겠어|오키|ㄱㄱ|ㅇㅇ)[\s!?.]*$/i
];
```

### P2-1 파이프라인 병렬화 구조 (수정안)

```
Group A (순차): generateMeta → nerStage → contextStage
  ↓ (A 완료 대기)
Group B (순차 — 파일 R/W 경쟁 회피): perspectiveStage → actionItemsStage → consistencyStage
  ↓ (B 완료 대기)
Group C (순차): tldrStage → ragStage
```

**변경점**: Group A와 Group B를 `Promise.all`이 아닌, A 완료 → B 시작으로 직렬 유지.
**실제 병렬화 대상**: Group A 내 nerStage+contextStage는 이미 순차 의존이므로 변경 없음.
**대안 최적화**: 각 stage의 불필요한 readFileSync 제거 — 이전 stage 결과를 클로저/인자로 전달.

### 환경변수 추가

| 변수명 | 용도 | 기본값 |
|--------|------|--------|
| `CACHE_TTL_NOTES` | NoteCache TTL (ms) | 60000 |

<!-- PHASE-4-COMPLETE: 2026-04-05T06:40:00Z -->

---

## 실행 계획 (Phase 4)

### 1단계: 단순 독립 최적화 (경량화)
| 항목 | 파일 | 변경량 |
|------|------|--------|
| P1-3 클라이언트 Promise.all | app.js:568~647 | ~5줄 |
| P3-1 RegExp 사전 컴파일 | server.js:3083~3093 | ~5줄 |
| P4-4 debounce 500ms + AbortController | app.js:2308~2311 | ~15줄 |
| P4-3 sw.js cache-first + skipWaiting | sw.js:82~97 | ~20줄 |
| P4-7 logger 조건부 | server.js:227~232 | ~3줄 |
| P4-2 calendar 클라이언트 중복 방지 | app.js:126,179,1492 | ~10줄 |
| P1-5 titleCache lazy + 동기 fallback | server.js:169~182 | ~10줄 |
| P4-5 vm/recent getAllMdFilesCached | server.js:3854~3882 | ~5줄 |

### 2단계: NoteCache 핵심 (Harness)
| 항목 | 파일 | 변경량 |
|------|------|--------|
| NoteCache 모듈 신규 | noteCache.js (신규) | ~50줄 |
| P1-1 getVVNotesForDate → NoteCache | server.js:3630~3661 + 호출지점 | ~30줄 |
| P1-2 태그 → NoteCache | server.js:2691~2715 | ~15줄 |
| P1-4 recent notes 단일 스캔 | server.js:2720~2755 | ~20줄 |
| insertWikiLinks RegExp 캐시 | server.js:184~195 | ~15줄 |
| executeSearch content LRU | server.js:1595 부근 | ~20줄 |
| 무효화 통합 (create/delete/toggle/pipeline) | server.js 5+ 지점 | ~15줄 |

### 3단계: AI 파이프라인 최적화 (경량화)
| 항목 | 파일 | 변경량 |
|------|------|--------|
| P2-2 Jarvis pre-search whitelist | server.js:1857~1866 | ~15줄 |
| P2-3 expandKeywords Flash + LRU | server.js:1557~1578 | ~20줄 |
| P2-1 파이프라인 readFileSync 최소화 | server.js:2877~2947 | ~30줄 |
| P2-4 entityIndexer 증분 스캔 | entityIndexer.js:304~335 | ~15줄 |
| P3-2 벡터 캐시 활용 | server.js:3063~3076 | ~10줄 |
| P3-3 AI검색 배치 비동기 | server.js:2650~2658 | ~10줄 |
| P3-5 checkConsistency _vectorCache | server.js:3095~3120 | ~5줄 |
| P5-1~P5-3 Jarvis 도구 NoteCache 연동 | server.js:1265~1555 | ~20줄 |
| P5-5 dateIndex 비동기 재빌드 | server.js:3194~3237 | ~15줄 |
