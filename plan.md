# VaultVoice 3단계: Uniformity + UX (경량화)

## 실행 엔진 확정
- **3단계 (현재)**: 경량화 — Opus Supervisor + Sonnet Worker
- 범위: D1~D3 데이터소스 균등화 + B2 오프라인 큐 + A3 Push + E1~E12 UX 개선 + E8 캐시

---

## Step 1: D1 — generateNoteMeta에 tags 필드 추가 (S, server.js)

- **파일**: server.js L5279 (NOTE_META_SCHEMA), L5296 (prompt), L5338 (injectMetaToFrontmatter)
- **변경**:
  1. NOTE_META_SCHEMA L5288 뒤에 `tags: { type: 'array', items: { type: 'string' }, description: '관련 한국어 태그 3-5개' }` 추가
  2. prompt L5296에 `- tags: 관련 한국어 태그 3-5개 (예: 회의, AI, 리서치)` 추가
  3. injectMetaToFrontmatter L5338: `if (meta.tags) { fm.tags = [...new Set([...(fm.tags||[]), ...meta.tags])]; }` 추가
- **제약**: 기존 tags 보존 (merge, 중복 제거)

## Step 2: D2 — status 필드 통일 (S, server.js)

- **파일**: server.js createAtomicNote (~L2953 부근)
- **변경**:
  1. 모든 소스(voice/image/url/text/memo/todo)의 초기 status를 `'raw'`로 통일
  2. generateNoteMeta 완료 후 `'processed'`로 변경
  3. perspectiveStage 완료 후 `'analyzed'`로 변경
- **제약**: 기존 frontmatter에 이미 status가 있는 노트는 변경하지 않음 (신규 노트만)

## Step 3: D3 — text/memo 사전 태그 보강 (S, server.js)

- **파일**: server.js /api/process/text 엔드포인트 (~L4956 부근)
- **변경**: 기본 태그 배열에 `'memo'` 추가 (voice='voice', image='image', url='url' 패턴 통일)
- **제약**: 기존 text/memo 처리 로직 변경 최소화

## Step 4: B2 — 오프라인 쓰기 큐 (M, 신규 파일 + sw.js + app.js)

- **파일**: public/offline-db.js (신규), sw.js, app.js
- **변경**:
  1. `offline-db.js`: IndexedDB 'vaultvoice-offline' DB, 'post-queue' 스토어 (url, fields, file blob, fileName, timestamp)
  2. `app.js`: apiUpload 실패 시 → addToQueue + showOfflineBanner('메모가 저장 대기열에 추가되었습니다.')
  3. `sw.js`: sync 이벤트 리스너 'sync-vaultvoice-queue' → processQueue (큐 순차 재전송)
  4. iOS fallback: `online` 이벤트 + `visibilitychange`에서 큐 처리
  5. UI: 오프라인 배너 + 대기 메모 수 뱃지
- **참조**: `~/.claude/docs/archive/research-raw/vaultvoice-offline-queue-2026-04-05.txt`
- **제약**: FormData는 IndexedDB 저장 불가 → Blob+fields 분리 저장, 재전송 시 FormData 재구성

## Step 5: A3 — Push Notification 토큰 저장 (M, server.js + app.js)

- **파일**: server.js (신규 엔드포인트), app.js (sw registration 후 subscribe)
- **변경**:
  1. `POST /api/push/subscribe`: subscription JSON을 .vaultvoice/push-subscriptions.json에 저장
  2. `POST /api/push/unsubscribe`: 구독 해제
  3. `GET /api/push/vapid-public-key`: VAPID 공개키 반환
  4. app.js: 기존 apiFetch→api 치환 완료 상태, subscribe 로직 연결 확인
- **제약**: VAPID 키는 .env에서 로드 (미설정 시 push 비활성)

## Step 6: E1+E2+E9+E12 — 피드 카드 UX 4건 (S~M, app.js)

- **파일**: app.js renderFeedCards (~L688)
- **변경**:
  1. **E1**: frontmatter.original_image → 썸네일 `<img>` 표시 (image 소스 카드)
  2. **E2**: 300자 절삭 → 첫 문장 종결 부호(.!?。)까지 확장, 최대 400자
  3. **E9**: 검색 결과 matches에서 검색어 위치 `<mark>` 래핑
  4. **E12**: URL 소스 카드에 원본 URL 링크 버튼 추가
- **제약**: renderFeedCards 기존 구조 유지, 추가만

## Step 7: E3+E4+E11 — 네비게이션 + 필터 UX 3건 (M, app.js + index.html)

- **파일**: app.js, index.html
- **변경**:
  1. **E3**: 상단 날짜 클릭 → 캘린더 피커 (기존 datepicker 재활용)
  2. **E4**: 태그 클릭 토글 방식 다중 선택 → AND 필터
  3. **E11**: 캘린더 뷰 메모 존재 날짜에 도트 표시
- **제약**: 기존 캘린더/필터 로직과 충돌 방지

## Step 8: E5+E7 — 녹음 UX 2건 (M, app.js)

- **파일**: app.js (녹음 UI)
- **변경**:
  1. **E5**: 파형 시각화 (AnalyserNode + Canvas) + 경과 시간 표시
  2. **E7**: XMLHttpRequest.upload.onprogress → 프로그레스 바 (apiUpload 교체)
- **제약**: 기존 녹음 로직 유지, UI 추가만

## Step 9: E6+E10 — 에러 + 진행 상태 UX 2건 (M, app.js + server.js)

- **파일**: app.js, server.js
- **변경**:
  1. **E6**: API 실패 시 상황별 한국어 에러 메시지 + 재시도 버튼
  2. **E10**: Server-Sent Events로 파이프라인 단계별 진행 알림 (runPipeline 내)
- **제약**: SSE는 GET /api/pipeline/progress?id={} 엔드포인트 신규

## Step 10: E8 — sw.js cache-first 전략 (S, sw.js)

- **파일**: sw.js
- **변경**:
  1. 정적 자원 (CSS/JS/이미지/폰트) → cache-first (캐시 히트 시 네트워크 스킵)
  2. API 요청 → network-first (실패 시 캐시 fallback)
  3. 캐시 버전 관리: `CACHE_VERSION` 상수로 갱신 시 이전 캐시 삭제
- **제약**: /api/* 경로는 반드시 network-first 유지

---

## 검증 기준

| Step | 검증 항목 |
|------|----------|
| 1 | generateNoteMeta 반환에 tags 포함, 기존 tags와 merge 확인 |
| 2 | 신규 노트 status: raw→processed→analyzed 전이 확인 |
| 3 | text/memo 노트에 'memo' 태그 자동 추가 확인 |
| 4 | 오프라인 시 큐 저장 → 온라인 복귀 시 자동 재전송 |
| 5 | Push 구독 저장/해제 동작, VAPID 키 반환 |
| 6 | 이미지 썸네일, 문장 완성 절삭, 검색 하이라이트, URL 링크 |
| 7 | 날짜 피커, 태그 다중 필터, 캘린더 도트 |
| 8 | 파형 시각화, 업로드 프로그레스 |
| 9 | 한국어 에러 메시지, SSE 파이프라인 진행 표시 |
| 10 | 정적 자원 cache-first, API network-first |

---

## 테스트 계획 (Stage 2+3 검증)

### 목표
- Stage 2 (Harness): entityIndexer 핵심 함수 단위 테스트 + 신규 API 엔드포인트 통합 테스트
- Stage 3 (Lightweight): 신규 API + UX 기능 통합 테스트
- 기존 `api-unit.spec.js`, `stage2-3.spec.js` 테스트와 병행 실행

### Unit Tests — `tests/unit-stage2.spec.js` (Gemini mock 환경)

| # | 대상 | 테스트 내용 |
|---|------|-----------|
| U1 | `jamoLevenshtein` | 동일 문자열→0, ㄱ/ㅋ(cost 0.2) vs ㄱ/ㄴ(cost 1.0) 비교 |
| U2 | `dynamicThreshold` | 2자→1, 3자→2, 4자→2 |
| U3 | `SPEAKER_PATTERN` | "화자 1", "Speaker 2" 매치 + "김철수" 비매치 |
| U4 | `isKoreanSurname` | 김/이/박→true, ㅋ/A→false |
| U5 | `correctPersonBySurname` | 유효 성씨→그대로, 무효+fuzzy매치→교정 |
| U6 | `findFuzzyKey` | 거리 내→매치, 초과→null, userVerified +1 완화 |
| U7 | `applyAliases` | aliases 치환 확인, 미등록→원본 |
| U8 | `mergeNerResult` | 신규 엔티티 추가 + SPEAKER_PATTERN 필터 + fuzzy dedup |
| U9 | `getPhoneticCostMap` | ARTICULATION_COST_PAIRS 24쌍 양방향 등록 확인 |

### API Integration Tests — `tests/api-stage2-3.spec.js` (Mock Gemini)

| # | 엔드포인트 | 테스트 내용 |
|---|-----------|-----------|
| A1 | `GET /api/entities` | entity_map 3 카테고리 반환 |
| A2 | `POST /api/note/entities/save` | frontmatter 수정 + entity_map 갱신 + same-key 무변경 + collision merge |
| A3 | `POST /api/note/speakers/save` | 화자 라벨 → 실명 치환 (fm + body) |
| A4 | `PUT /api/note/content` | body 교체 + frontmatter 보존 |
| A5 | `POST /api/note/tags/save` | 태그 저장 + vaultvoice 태그 보존 |
| A6 | `GET /api/feed/month/:month` | 날짜 목록 반환 |
| A7 | `GET /api/pipeline/progress` | SSE 연결 + 이벤트 수신 |
| A8 | `POST /api/process/text` | status raw→processed 전이 + tags 배열 포함 + memo 태그 |

### E2E UI Tests — `tests/e2e-stage2-3.spec.js` (브라우저)

| # | 기능 | 테스트 내용 |
|---|------|-----------|
| E1 | 피드 카드 렌더링 | 이미지 소스 카드에 썸네일, URL 카드에 원본 링크 버튼 |
| E2 | 검색 하이라이트 | 검색어가 `<mark>` 태그로 래핑 |
| E3 | 녹음 UI | 녹음 버튼 클릭 시 waveform canvas + 경과 시간 표시 |
| E4 | 오프라인 배너 | navigator.onLine=false 시 오프라인 배너 표시 |

### 실행 전략
1. entityIndexer 함수들을 테스트하기 위해 모듈 내부 함수를 `module.exports`에 노출 (테스트 전용)
2. Mock Gemini 서버(port 3941) 활용 — 기존 global-setup.js 재사용
3. test-vault에 더미 노트 생성하여 API 테스트
4. playwright config의 `api-unit` 프로젝트에 신규 spec 파일 매칭 추가
