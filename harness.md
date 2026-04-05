# Harness Checklist — VaultVoice 2단계 Core Features

## Pipeline Goal
> 음성 전사의 화자를 실명 매칭하고, 모든 엔티티(인명/장소/프로젝트)를 사용자가 편집할 수 있으며, 노트 본문을 수정할 수 있는 상태를 달성한다.

---

## Phase 1: 데이터 무결성 기반 (NER 정제 + 신뢰도 시스템)

### Final Objective
> NER 결과에서 화자 레이블이 제거되고, 사용자 수정이 고신뢰 소스로 반영되며, 한국인 이름/장소 음운 보정이 작동하는 상태

### Sub-objectives
- [ ] 1-1: entityIndexer.js mergeNerResult에서 `화자\d+`/`Speaker\d+` 패턴 persons 필터링 — grep으로 필터 코드 존재 확인 + 테스트 입력에 "화자1" 포함 시 persons 결과에서 제외 확인
- [ ] 1-2: entity_map.json 스키마에 userVerified:boolean + aliases:{} 지원 — entityIndexer.js에서 userVerified 필드 읽기/쓰기 코드 존재 확인
- [ ] 1-3: mergeNerResult에서 userVerified=true 엔트리 fuzzy match 우선 매칭 (threshold 2→3 완화) — 테스트: userVerified person과 distance 3인 입력이 매칭되는지 확인
- [ ] 1-4: NER 후처리에서 aliases 맵 치환 적용 — 테스트: aliases에 "강남력":"강남역" 등록 후 "강남력" 입력이 "강남역"으로 치환 확인
- [ ] 1-5: name-rules.json 생성 (한국 성씨 286개 + 빈출 음절) — 파일 존재 + JSON 파싱 가능 확인
- [ ] 1-6: jamoLevenshtein에 음운 유사 자모 가중치 적용 (ㅓ↔ㅗ cost=0.3 등) — 기존 distance 계산과 비교하여 유사 자모 쌍이 낮은 cost 반환 확인
- [ ] 1-7: NER persons에서 성씨 검증 + fuzzy 보정 로직 — 테스트: "김철쑤" 입력 시 "김철수" 후보 매칭 확인
- [ ] 1-8: NER places에서 entity_map fuzzy match + Gemini fallback 장소 보정 — 코드 존재 + entity_map에 없는 신규 place에만 Gemini 호출 조건 확인

### Sufficiency Check (Supervisor 기입)
- 세부→최종 커버리지:
- 통합 정합성:

---

## Phase 2: 파이프라인 통합 (화자 자동 매칭)

### Final Objective
> runPipeline에 speakerResolveStage가 통합되어, 음성 전사 시 화자가 자동으로 실명 후보와 매칭되는 상태

### Sub-objectives
- [ ] 2-1: server.js runPipeline에 speakerResolveStage 추가 (nerStage 직후) — grep으로 stage 함수 존재 + runPipeline 호출 순서 확인
- [ ] 2-2: Gemini Flash 프롬프트로 화자-실명 매핑 (entity_map persons 상위 20명 참조) — 프롬프트 코드에 persons 목록 주입 + JSON 반환 파싱 로직 확인
- [ ] 2-3: confidence ≥ 0.7 시 frontmatter.speakers 자동 치환, < 0.7 시 speaker_candidates 저장 — 분기 로직 코드 존재 확인

### Sufficiency Check (Supervisor 기입)
- 세부→최종 커버리지:
- 통합 정합성:

---

## Phase 3: UI (화자 수동 매칭 + 엔티티 편집 + 노트 편집)

### Final Objective
> 사용자가 피드 카드에서 화자/엔티티를 편집하고, 노트 본문을 수정할 수 있는 상태

### Sub-objectives
- [ ] 3-1: 피드 카드에 엔티티 칩 표시 (participants/places/projects from frontmatter) — app.js renderFeedCards에 칩 렌더링 코드 존재 확인
- [ ] 3-2: voice 카드에 화자 배지 표시 (speakers from frontmatter) — 코드 존재 확인
- [ ] 3-3: 엔티티 칩 클릭 시 인라인 편집 + entity_map 자동완성 — 편집 UI 코드 + fetch('/api/entities') 호출 확인
- [ ] 3-4: POST /api/note/entities/save 엔드포인트 — 서버에 route 존재 + frontmatter/body/entity_map 연쇄 업데이트 로직 확인
- [ ] 3-5: POST /api/note/speakers/save 엔드포인트 — 서버에 route 존재 + speakers 업데이트 + body 화자명 치환 확인
- [ ] 3-6: openNoteDetail에 편집 버튼 + textarea 전환 (auto-resize) — 코드 존재 확인
- [ ] 3-7: PUT /api/note/content 엔드포인트 (frontmatter 파싱 + body 분리 저장) — route 존재 + 파일 쓰기 확인
- [ ] 3-8: debounce(1000ms) 자동저장 + noteCache.invalidate — 코드 존재 확인
- [ ] 3-9: 마크다운 미리보기 탭 (marked.js) — 편집/미리보기 전환 코드 확인

### Sufficiency Check (Supervisor 기입)
- 세부→최종 커버리지:
- 통합 정합성:
