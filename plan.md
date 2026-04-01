# VaultVoice 피드 리디자인 + Jarvis 업그레이드 계획

## 현재 작업: 파일 탐색 통합

### 핵심 원칙
VaultVoice 노트의 위치가 바뀌어도 모든 기능이 동일하게 동작한다.

### Phase 1: 공통 함수 도입
- [ ] `findVVNote(filename)` — 볼트 전체에서 VV 노트 찾기 (3-tier)
- [ ] `getVVNotesForDate(date)` — 날짜별 VV 노트 전체 수집 (3-tier)

### Phase 2: 적용 (5곳)
- [ ] 피드 `getNotesForDate()` → `getVVNotesForDate()`
- [ ] 카드 요약 `/api/note/summarize` → `findVVNote()`
- [ ] 카드 삭제 `/api/note/delete` → `findVVNote()`
- [ ] 카드 코멘트 `/api/note/comment` → `findVVNote()`
- [ ] 관련 노트 `/api/note/related` → `findVVNote()`

### Phase 3: 검증
- [ ] 이동된 노트 피드 표시
- [ ] 이동된 노트 카드 액션 동작
- [ ] 기존 노트 정상 동작
