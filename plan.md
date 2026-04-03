# VaultVoice 사용성 강화 프로젝트

> **상태**: 🔄 2단계 진행 중 (1단계 완료 2026-04-04)
> **목표**: Obsidian UX 극대화 + 개인 맥락 AI 엔진 추가
> **검증**: 계획 wf Phase 1 완료 (3-Agent + Gemini G3/G5 + Codex C3 + Round 2)

## 배경 리서치

- Obsidian UX: `~/.claude/memory/research/obsidian-ux-vaultvoice.md`
- Entity/Briefing: `~/.claude/docs/archive/research-raw/entity-relationship-phase1-2026-04-03.txt`
- 검증 원본: `~/.claude/docs/archive/research-raw/vaultvoice-f1f7-review-*-2026-04-04.md`

---

## 선결 조건 (구현 전 필수)

### 0. js-yaml + gray-matter 도입

**이유**: 커스텀 `parseFrontmatter()`의 구조적 한계
- Node.js `\w`는 ASCII only → 한국어 키(`날짜`, `시간`) 파싱 실패
- 다중 줄 YAML 배열(`- item` 형식) 처리 불가 — F5/F6 `participants`, `projects`, `places` 배열에서 직접 영향
- Obsidian 내부가 js-yaml 사용 → 완벽 호환 보장

```bash
npm install js-yaml gray-matter
```

커스텀 `parseFrontmatter()` / `serializeFrontmatter()` 전면 교체:
```javascript
const matter = require('gray-matter');
const yaml = require('js-yaml');

// 읽기
const file = matter(raw);  // file.data = frontmatter, file.content = body

// 쓰기
const output = matter.stringify(file.content, file.data);
```

### 파이프라인 리팩터링 (선결)

현재 `.then()` 중첩 체인 → `runPipeline(filePath, stages[])` 교체:
- 단계별 독립 `try/catch` (실패해도 다음 단계 계속)
- catch 블록 파이프라인 재실행 **완전 제거** (rate limit 연쇄 소진 방지)
- `Map<filePath, PQueue({concurrency:1}))` 도입 + `q.on('idle', () => map.delete(filePath))` GC

```javascript
const _queues = new Map();
function getPipelineQueue(filePath) {
  if (!_queues.has(filePath)) {
    const q = new PQueue({ concurrency: 1 });
    q.on('idle', () => _queues.delete(filePath));
    _queues.set(filePath, q);
  }
  return _queues.get(filePath);
}

async function runPipeline(filePath, stages) {
  return getPipelineQueue(filePath).add(async () => {
    for (const stage of stages) {
      try { await stage(filePath); }
      catch (e) { console.warn(`[Pipeline] ${stage.name} failed:`, e.message); }
    }
  });
}
```

`proper-lockfile` 불필요 — PM2 단일 인스턴스 환경에서 cross-process lock 없어도 됨.

---

## 구현 대상 기능

### 실행 순서

```
0. js-yaml + gray-matter 도입 + 파이프라인 리팩터링
1단계: F4 Frontmatter 확장 (generateNoteMeta JSON화)
       → F2 Tasks 이모지 형식 (7개 지점 단일 커밋)
       → F1 Multi-Lens Perspective (F4 완료 후)
2단계: F6 participants/projects/places frontmatter
       → F5 Entity Index + NER 파이프라인
3단계: F3 TL;DR Callout
       → F7 Daily Briefing + Web Push
```

---

### 1단계 — Low (프롬프트/템플릿 변경)

#### F4. Frontmatter 자동 확장 (F1 전 선행 필수)

**파일**: `server.js` → `generateNoteTitle()` (~4188줄)
**변경**: `generateNoteTitle()` → `generateNoteMeta()` 래퍼 분리 (반환타입 변경으로 기존 호출부 파괴 방지)

**구현 전 필수**: `grep -n "generateNoteTitle" server.js` 전수 확인 후 일괄 패치 (backfill 엔드포인트, titleCache, Jarvis 간접 호출 포함)

JSON 응답 스키마 (responseSchema 강제 — lite 모델 JSON 안정성 보장):
```json
{
  "title": "10~30자 제목",
  "summary": "3줄 요약",
  "type": "meeting-note|idea|task-list|quote|voice-memo",
  "mood": "Positive|Neutral|Negative",
  "priority": "High|Medium|Low",
  "area": "Career|Health|Finance|Family|Personal|null",
  "project": "프로젝트명 또는 null"
}
```

`area`는 단일값 (배열 아님). 혼합 컨텍스트 오분류 허용 — 필요 시 `/api/note/reanalyze`로 수동 재분석.

Privacy Shield 적용: JSON 파싱 후 **필드 단위**로 마스킹 (JSON 문자열 전체 regex 금지 — 구조 파괴 위험).

`createAtomicNote()` frontmatter에 반영:
```yaml
status: fleeting
type: meeting-note
priority: High
area: Career
project: V-Project
mood: Neutral
summary: ""   # F4에서 채움
analyzed_lenses: []  # F1에서 채움
```

#### F1. Multi-Lens Perspective Transformer

**파일**: `server.js` → `applyPerspectiveFilters()` (~2592줄)
**전제**: F4 완료 후 실행 (area 필드가 frontmatter에 있어야 렌즈 선택 가능)

렌즈 맵:
```js
const PERSPECTIVE_LENSES = {
  'fpa':       { trigger: 'Career', name: 'FP&A 분석',
                 sections: ['💰 Budget Impact', '⚡ KPI Conflict', '🎯 Executive Intent', '✅ 재무 Action Items'] },
  'parenting': { trigger: 'Family', name: '육아 맥락',
                 sections: ['👶 발달/건강 시그널', '📅 일정 영향', '💡 부모 액션'] },
  'risk':      { trigger: 'Finance', name: '리스크 관점',
                 sections: ['⚠️ 위험 요인', '🛡️ 완화 방안', '📊 시나리오'] },
  'default':   { trigger: null, name: 'PIE 분석',
                 sections: ['#stakeholder', '#forecast', '#decision', '#devils_advocates', '#lifework'] },
};
```

**Skip check 교체**: `body.includes('## 🧠 PIE Perspective')` → `analyzed_lenses` frontmatter 배열 확인
- 렌즈 실행 후 `analyzed_lenses: ['Career']` 추가
- 재분석 필요 시 `/api/note/reanalyze` 엔드포인트로 `analyzed_lenses` 초기화

**모델 변경**: `pro` → `flash` (월 $5,748 → $191 절감)

Jarvis 도구 추가: `reanalyze_perspective(noteId, lens)` → on-demand 재분석

#### F2. Tasks 플러그인 호환 형식

**파일**: `server.js` → `extractActionItems()` (~2508줄)
**변경**: 출력 형식을 Obsidian Tasks 이모지 문법으로 교체

```markdown
- [ ] 할일 내용 📅YYYY-MM-DD ⏫
- [ ] 할일 내용 ⏳YYYY-MM-DD 🔼
```

이모지 규칙:
- 우선순위: ⏫높음 🔼중간 🔽낮음
- 날짜: 📅due ⏳scheduled 🛫start ✅done 🔁recur

**필수**: 아래 7개 지점 **단일 커밋**으로 동시 변경 (부분 변경 시 두 형식 공존 → Tasks 쿼리 결과 반쪽 누락)
- `server.js:2576` (extractActionItems 출력)
- `server.js:3547`, `3671`, `3907`, `3961` (기타 task 생성)
- `server.js:1199` (Jarvis add_todo)
- `server.js:400` (VaultVoice UI todo 생성)

**연동 수정**: `syncToCalendarDraft()` (~2321줄) 파서 — 이모지 형식 우선 + `[due:: date]` 레거시 fallback 병렬 지원

#### F3. TL;DR 자동 요약 Callout

**파일**: `server.js` → F4 `generateNoteMeta()` 결과의 `summary` 필드 활용
**조건**: **AI 섹션 제외 원본 본문 기준 100자 이상**만 삽입 (PIE/Consistency 섹션이 삽입된 후 100자 계산 시 재삽입 루프 방지)
**타이밍**: F1(PIE), F5(NER) 완료 후 삽입 (AI 섹션 삽입 위치 충돌 방지)

```markdown
> [!abstract] 요약
> 3줄 이내 핵심 요약
```

---

### 2단계 — Medium (새 로직 추가)

#### F6. Relationship Memory (participants / projects / places frontmatter)

**파일**: `server.js` → `createAtomicNote()` (~2229줄)
**변경**: F5 NER 결과를 frontmatter 3종 배열에 반영 (F6 필드가 먼저 존재해야 F5 NER 결과 저장처 확보)

```yaml
participants:
  - "[[박 차장님]]"
  - "[[김 이사님]]"
projects:
  - "[[V-Project]]"
places:
  - "[[서울 사무소]]"
```

#### F5. Entity Index + 3종 엔티티 노트 + 크로스-도메인 링킹

**신규 모듈**: `entityIndexer.js`

**공개 API** (server.js에서 require하여 사용):
```javascript
const { initEntityIndexer, getEntityMap, indexNote, resyncEntityMap } = require('./entityIndexer');
// initEntityIndexer(vaultPath)  — 서버 시작 시 비동기 백그라운드 scan 시작
// getEntityMap()                — entity_map 반환 (ready 아니면 null)
// indexNote(filePath, rawContent) — 단일 노트 NER + entity_map 업데이트
// resyncEntityMap()             — /api/entity/resync 핸들러에서 호출
```

**서버 시작 시 (비동기 백그라운드)**:
- chokidar **제거** (gcsfuse에서 inotify 이벤트 유실 — 의도된 동작)
- 대신: 서버 시작 후 비동기 백그라운드로 vault full scan
- `entity_map_ready = false` 플래그 → scan 완료 후 `true`
- scan 완료 전 NER 단계 skip (큐에 적재했다가 완료 후 처리)
- `entity_map.json` 디스크 캐시로 재시작 시 빠른 복구

**역방향 동기화**: Obsidian 직접 편집 시 entity_map stale 방지
- `entity_map.json`에 `last_updated` 타임스탬프
- `/api/entity/resync` 엔드포인트 — 수동 또는 주기적 호출로 incremental resync

**Gemini NER 스키마** (AI 파이프라인에 추가):
- NER은 **Privacy Shield 마스킹 전 원문** 기준 실행 (마스킹 후 실행 시 persons 배열이 `***`로 채워짐)

```json
{
  "entities": {
    "persons":  ["박 차장님", "김 이사님"],
    "projects": ["V-Project", "Q3 보고서"],
    "places":   ["서울 사무소", "강남 스타벅스"]
  },
  "cross_links": [
    { "from": "V-Project", "relation": "담당자", "to": "박 차장님" }
  ]
}
```

**NER 키 정규화** (entity_map 오염 방지):
- NER 프롬프트에 "정규화된 단일 표기 반환" 명시: "박 차장님", "박차장", "차장님" → `"박 차장님"` 단일 표기
- 기존 entity_map의 유사 항목 참조 제공 → 중복 생성 방지

**NER 실패 처리**: 3회 retry + exponential backoff + 실패 시 `{entities:{persons:[],projects:[],places:[]}, cross_links:[]}` fallback

**엔티티 노트 템플릿 3종** (신규 → 자동 생성):
```yaml
# person
type: person | name: 박 차장님 | role: 차장 | tags: [person, 직장동료]

# project
type: project | name: V-Project | status: active | tags: [project, Career]

# place
type: place | name: 강남 스타벅스 | tags: [place]
```

**크로스-도메인 링킹** (`resolveEntityLinks()`):
- cross_links 파싱 → 양방향 `related:` frontmatter 추가
- 노트 본문의 엔티티 언급 → `[[WikiLink]]` 자동 치환

---

### 3단계 — High (신규 엔드포인트 + 스케줄러)

#### F7. Daily Briefing + Web Push

**신규**: `GET /api/daily/briefing` + node-schedule (07:30)

**데이터 파이프라인** (각 단계 독립 try/catch — 하나 실패해도 부분 브리핑 발송):
1. Google Calendar API → 오늘 이벤트 + 참석자
2. 참석자명으로 Vault 인물 노트 검색
3. Obsidian Tasks 형식 미완료 항목 추출 (마감 임박)
4. Gemini **flash** (pro 불필요 — summarization 작업) → 자연어 한국어 브리핑 생성
5. Obsidian Daily Note 상단에 prepend (filePath별 PQueue 사용 — PIE 파이프라인 충돌 방지)
6. Web Push (VAPID) → iPhone 알림

**구독 영속성**:
- `subscriptions.json` 파일로 PushSubscription 저장
- `POST /api/push/subscribe`, `DELETE /api/push/unsubscribe` API
- 브라우저/PWA 재설치 시 재구독 유도 UI

**cron 재시작 복구**:
- `.briefing-sent-YYYY-MM-DD` 파일로 발송 여부 영속화
- 서버 시작 시 오늘 날짜 파일 없으면 즉시 브리핑 발송 (PM2 재시작 후 누락 방지)
- 발송 결과를 `briefing-log.json`에 기록

**VAPID 키 고정**:
- 최초 1회 생성 후 `.env`에 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` 영속화
- 재시작마다 키 재생성 금지 (기존 구독 무효화 방지)

**iOS 요건**: PWA 홈화면 설치 + iOS 16.4+

---

## 구현 파일 목록

| 파일 | 변경 | 단계 |
|------|------|------|
| `server.js` | js-yaml + gray-matter 교체, 파이프라인 리팩터링(`runPipeline`), p-queue Map | 0 |
| `server.js` | `generateNoteTitle()` → `generateNoteMeta()` JSON 확장 (responseSchema 강제) | 1 |
| `server.js` | `extractActionItems()` Tasks 이모지 형식 (7개 지점 동시) | 1 |
| `server.js` | `syncToCalendarDraft()` 이모지+레거시 파서 | 1 |
| `server.js` | `applyPerspectiveFilters()` Multi-Lens (area 기반, analyzed_lenses, flash 모델) | 1 |
| `server.js` | `checkConsistency()` flash 모델로 변경 | 1 |
| `server.js` | `/api/note/reanalyze` 엔드포인트 | 1 |
| `server.js` | `createAtomicNote()` participants/projects/places frontmatter | 2 |
| `entityIndexer.js` | Entity Index (비동기 scan, entity_map_ready 플래그, NER, 크로스 링킹, resync) | 2 |
| `server.js` | `/api/entity/resync` 엔드포인트 | 2 |
| `server.js` | `/api/daily/briefing` + node-schedule + PushSubscription 관리 | 3 |
| `public/sw.js` | Web Push 수신 핸들러 | 3 |
| `public/app.js` | Push 구독 등록/해제 UI | 3 |

---

## 신규 의존성

| 패키지 | 용도 |
|--------|------|
| `js-yaml` | YAML 파싱/직렬화 (커스텀 파서 교체) |
| `gray-matter` | frontmatter + body 분리/결합 |
| `p-queue` | filePath별 파이프라인 직렬화 큐 |
| `node-schedule` | Daily Briefing 07:30 cron |
| `web-push` | VAPID Web Push 발송 |

제거: `proper-lockfile` (PM2 단일 인스턴스에서 불필요)

---

## 환경 변수

| 변수명 | 용도 | 발급처 |
|--------|------|--------|
| `VAPID_PUBLIC_KEY` | Web Push 공개 키 (최초 1회 생성 후 고정) | `web-push.generateVAPIDKeys()` |
| `VAPID_PRIVATE_KEY` | Web Push 비공개 키 | 위 동일 |
| `VAPID_EMAIL` | Web Push 발신자 이메일 | 직접 설정 |

---

## E2E 테스트 계획 (Stage 2+3)

### 테스트 환경
- **Playwright** + `test-vault/` 디렉토리 (실제 vault 대신)
- **더미 데이터**: `generate_dummies.js` 실행으로 30개 시나리오 메모 사전 생성
  - 핵심 메모 5개 (김이사/보고서/채용/게임/KPI 컨텍스트)
  - 노이즈 메모 25개
- **AI 통합 테스트**: `IS_AI_ENABLED` 플래그 — Gemini API 키 있을 때만 실행

### 테스트 파일: `tests/stage2-3.spec.js`

#### S-F6: participants/projects/places frontmatter 자동 삽입
- 더미 메모 저장 후 `parseFrontmatter()` → `participants`/`projects`/`places` 배열 존재 확인
- 빈 배열이 아닌 값이 채워졌는지 (AI 통합 테스트)
- gray-matter YAML multiline 배열 직렬화 확인 (`- "[[이름]]"` 형식)

#### S-F5: entityIndexer 모듈
- `/api/entity/resync` GET → 200 응답 + `{status: "ok"}` 반환
- `entity_map.json` 디스크 캐시 파일 생성 확인 (서버 시작 후 폴링)
- AI 통합: 더미 메모 저장 → `entity_map.json`에 엔티티 추가됨
- 엔티티 노트 자동 생성: `test-vault/` 내 person/project/place 타입 노트 확인
- WikiLink 치환: 저장된 메모 본문에 `[[엔티티명]]` 형식 존재

#### S-F3: TL;DR callout
- 100자 이상 메모 저장 → `> [!abstract]` callout 섹션 존재 (AI 통합)
- 50자 이하 단문 메모 → callout 없음 확인 (skip 조건 검증)
- AI 섹션(PIE/Consistency) 포함 후에도 callout 재삽입 루프 없음

#### S-F7: Daily Briefing + Web Push
- `POST /api/push/subscribe` → 201 + subscriptions.json 파일에 저장됨
- `DELETE /api/push/unsubscribe` → 200 + subscriptions.json에서 제거됨
- `GET /api/daily/briefing` → 200 응답 + `{briefing, pushedCount}` 반환
- `.briefing-sent-{오늘날짜}` 파일 존재 확인 (재발송 방지)
- 서버 재시작 시뮬레이션: `.briefing-sent-*` 파일 삭제 후 `GET /api/daily/briefing` → 즉시 발송

### 실행 명령
```bash
node generate_dummies.js          # 더미 데이터 생성
npx playwright test tests/stage2-3.spec.js  # E2E 실행
npx playwright test tests/stage2-3.spec.js --grep "AI" --project=ai-integration  # AI 통합 테스트만
```
