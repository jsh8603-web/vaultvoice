/**
 * API Unit Tests — PIE Pipeline (Gemini mock, deterministic)
 *
 * Gemini API is intercepted by a local mock server on port 3941.
 * GEMINI_BASE_URL=http://localhost:3941 is set in .env.test so the test
 * server (server.js) routes all Gemini calls to the mock.
 *
 * Coverage:
 *  T1  YAML 완전성       — frontmatter 5개 필수 필드
 *  T2  sanitize fallback — 초기 파일 기본값 확인
 *  T3  serialize 배열    — tags YAML 리스트 형식
 *  T4  Privacy Shield    — PRIVACY_KEYWORDS 미설정 시 no-op
 *  T5  Task 문법         — [due:: YYYY-MM-DD] 형식
 *  T6  Calendar Draft    — 태스크 존재 시 Tasks 섹션 생성
 *  T7  PIE 태그 추출     — #forecast #stakeholder → frontmatter
 *  T8  파이프라인 순서   — PIE 섹션 < Tasks 섹션
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { pollFile, parseFrontmatter } = require('./helpers');

// ============================================================
// Constants
// ============================================================
const API_KEY = 'test-key-12345';
const TEST_DATE = '2026-01-15';
const NOTES_DIR = path.join(__dirname, '..', 'test-vault', '99_vaultvoice');

// Mock Gemini server is started globally in tests/global-setup.js
// (runs once before all workers — no per-spec start needed)

test.beforeAll(async () => {
  if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
});

// ============================================================
// Helpers
// ============================================================

/** POST a memo to /api/daily/:date and return { filename, filePath } */
async function postMemo(request, content, extra = {}) {
  const res = await request.post(`/api/daily/${TEST_DATE}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    data: { content, ...extra },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.filename).toBeTruthy();
  return {
    filename: body.filename,
    filePath: path.join(NOTES_DIR, body.filename),
  };
}


// ============================================================
// T1: YAML 완전성
// ============================================================
test('T1: YAML 완전성 — frontmatter 5개 필수 필드 존재', async ({ request }) => {
  const { filePath } = await postMemo(request, 'YAML 완전성 테스트 메모');

  expect(fs.existsSync(filePath)).toBeTruthy();
  const content = fs.readFileSync(filePath, 'utf-8');

  expect(content).toContain('source_type:');
  expect(content).toContain('category:');
  expect(content).toContain('status:');
  expect(content).toContain('topic:');
  expect(content).toContain('tags:');
});

// ============================================================
// T2: sanitizeMetadata fallback
// ============================================================
test('T2: sanitizeMetadata fallback — 초기 파일에 안전한 기본값', async ({ request }) => {
  const { filePath } = await postMemo(request, 'fallback 기본값 확인 메모');

  const content = fs.readFileSync(filePath, 'utf-8');
  // createAtomicNote sets these synchronously (AI-independent defaults)
  expect(content).toContain('status: captured');
  expect(content).toContain('topic: []');
});

// ============================================================
// T3: serializeFrontmatter 배열 직렬화
// ============================================================
test('T3: serializeFrontmatter — 태그 배열 YAML 리스트 형식', async ({ request }) => {
  const { filePath } = await postMemo(request, '배열 직렬화 테스트', {
    tags: ['태그A', '태그B'],
  });

  const content = fs.readFileSync(filePath, 'utf-8');
  // Each tag on its own line: "  - tagname"
  expect(content).toMatch(/tags:\n(\s+- .+\n)+/);
  expect(content).toContain('  - vaultvoice');
  expect(content).toContain('  - 태그A');
  expect(content).toContain('  - 태그B');
});

// ============================================================
// T4: Privacy Shield — no-op when keywords not configured
// ============================================================
test('T4: Privacy Shield — PRIVACY_KEYWORDS 미설정 시 본문 보존', async ({ request }) => {
  const sensitiveContent = '극비내용 프로젝트 알파 비밀코드';
  const { filePath } = await postMemo(request, sensitiveContent);

  const content = fs.readFileSync(filePath, 'utf-8');
  // When PRIVACY_KEYWORDS env is empty, body is passed through unchanged
  expect(content).toContain('극비내용 프로젝트 알파 비밀코드');
});

// ============================================================
// T5: Obsidian Task 문법
// ============================================================
test('T5: Task 문법 — [due:: YYYY-MM-DD] 형식 체크박스', async ({ request }) => {
  const { filePath } = await postMemo(
    request,
    '다음 주 화요일까지 보고서를 제출해야 한다'
  );

  // Wait for async extractActionItems to write Tasks section
  const content = await pollFile(filePath, (c) => c.includes('## Tasks'));

  expect(content).not.toBeNull();
  expect(content).toContain('## Tasks');
  // Format: - [ ] 제목 [due:: YYYY-MM-DD]
  expect(content).toMatch(/- \[ \] .+ \[due:: \d{4}-\d{2}-\d{2}\]/);
});

// ============================================================
// T6: Calendar Draft — tasks 존재 시 Tasks 섹션 생성
// ============================================================
test('T6: Calendar Draft — 태스크 존재 시 Tasks 섹션 기록', async ({ request }) => {
  const { filePath } = await postMemo(
    request,
    '월요일 오전 10시에 팀 미팅 예정'
  );

  // syncToCalendarDraft runs after task extraction; calendar may fail (no OAuth)
  // but Tasks section should be written regardless
  const content = await pollFile(filePath, (c) => c.includes('## Tasks'));

  expect(content).not.toBeNull();
  expect(content).toContain('## Tasks');
  expect(content).toContain('- [ ]');
});

// ============================================================
// T7: PIE 태그 자동 추출
// ============================================================
test('T7: PIE 태그 추출 — #forecast #stakeholder → frontmatter tags', async ({ request }) => {
  const { filePath } = await postMemo(
    request,
    'Q4 매출 전망과 이해관계자 협상 전략 수립 필요'
  );

  // Wait for PIE section + tag injection (our 1-1 implementation)
  const content = await pollFile(
    filePath,
    (c) => c.includes('## 🧠 PIE Perspective') && c.includes('forecast'),
    12000
  );

  expect(content).not.toBeNull();
  expect(content).toContain('## 🧠 PIE Perspective');

  // Tags must appear inside frontmatter (before closing ---)
  const fm = parseFrontmatter(content);
  expect(fm).toContain('forecast');
  expect(fm).toContain('stakeholder');
});

// ============================================================
// T8: 파이프라인 순서
// ============================================================
test('T8: 파이프라인 순서 — PIE 섹션이 Tasks 섹션보다 앞에 위치', async ({ request }) => {
  const { filePath } = await postMemo(
    request,
    '파이프라인 순서 확인: 내일까지 리포트 완료 및 재무 전략 검토'
  );

  // Wait for both sections
  const content = await pollFile(
    filePath,
    (c) => c.includes('## 🧠 PIE Perspective') && c.includes('## Tasks'),
    14000
  );

  expect(content).not.toBeNull();
  const pieIdx = content.indexOf('## 🧠 PIE Perspective');
  const tasksIdx = content.indexOf('## Tasks');
  expect(pieIdx).toBeGreaterThan(-1);
  expect(tasksIdx).toBeGreaterThan(-1);
  // Title (async) → PIE → Tasks is the expected pipeline order
  expect(pieIdx).toBeLessThan(tasksIdx);
});
