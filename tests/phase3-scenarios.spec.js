/**
 * Phase 3: AI Integration Scenarios (non-deterministic, real Gemini API)
 *
 * Skipped automatically when GEMINI_BASE_URL points to mock (localhost)
 * or GEMINI_API_KEY is missing. Run selectively:
 *   npx playwright test --project=ai-integration
 *
 * Scenarios:
 *  S1  KPI 충돌 감지         — 부서 간 KPI 갈등 → PIE #stakeholder 태그
 *  S4  상대 날짜 계산         — 동적 due 날짜 형식 검증
 *  S5  의사결정 번복 감지      — 이전 결정 번복 패턴 → PIE 분석
 *  S6  재무 시그널 감지        — 재무 예측 키워드 → #forecast 태그
 *  S7  노이즈 STT 처리        — 음성 노이즈 포함 → Tasks 추출
 *  S10 복합 일정 충돌         — 복수 일정 동시 언급 → Tasks 복수 기록
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { pollFile, parseFrontmatter } = require('./helpers');

// ============================================================
// Environment
// ============================================================
function readEnvVar(key) {
  for (const envFile of ['.env.test', '.env']) {
    const envPath = path.join(__dirname, '..', envFile);
    if (fs.existsSync(envPath)) {
      const m = fs.readFileSync(envPath, 'utf-8').match(new RegExp(`^${key}=(.+)$`, 'm'));
      if (m) return m[1].trim();
    }
  }
  return '';
}

const API_KEY = readEnvVar('API_KEY') || 'test-key-12345';
const GEMINI_API_KEY = readEnvVar('GEMINI_API_KEY') || 'your-gemini-api-key';
const GEMINI_BASE_URL = readEnvVar('GEMINI_BASE_URL');

const IS_AI_ENABLED = GEMINI_API_KEY && GEMINI_API_KEY !== 'your-gemini-api-key'
  && !GEMINI_BASE_URL.includes('localhost');

const NOTES_DIR = path.join(__dirname, '..', 'test-vault', '99_vaultvoice');

// ============================================================
// Helpers
// ============================================================
async function authenticate(page) {
  await page.addInitScript((key) => {
    localStorage.setItem('vv_apiKey', key);
  }, API_KEY);
  await page.goto('/');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });
}

/** POST a memo and return the created file path via polling */
async function postMemoAndGetFile(request, content) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await request.post(`/api/daily/${today}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    data: { content },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.filename).toBeTruthy();
  return path.join(NOTES_DIR, body.filename);
}

// ============================================================
// Setup
// ============================================================
test.beforeAll(() => {
  if (fs.existsSync(NOTES_DIR)) {
    fs.readdirSync(NOTES_DIR)
      .filter((f) => f.endsWith('.md'))
      .forEach((f) => fs.unlinkSync(path.join(NOTES_DIR, f)));
  }
});

// ============================================================
// S1: KPI 충돌 감지
// ============================================================
test('S1: KPI 충돌 — 부서 간 갈등 PIE #stakeholder 감지', async ({ request }) => {
  test.skip(!IS_AI_ENABLED, 'Real Gemini API required');

  const filePath = await postMemoAndGetFile(
    request,
    '마케팅팀은 GMV 성장을 위해 예산 20% 증액을 요구하고, 재무팀은 마진율 방어를 위해 동결을 주장함.'
  );

  const content = await pollFile(
    filePath,
    (c) => c.includes('## 🧠 PIE Perspective'),
    20000
  );

  expect(content).not.toBeNull();
  expect(content).toContain('## 🧠 PIE Perspective');
  // Loose: any conflict-related keyword is acceptable
  expect(content).toMatch(/성장|수익|마진|충돌|GMV|갈등|예산/);
  const fm = parseFrontmatter(content);
  expect(fm).toMatch(/stakeholder|forecast|decision/);
});

// ============================================================
// S4: 상대 날짜 계산
// ============================================================
test('S4: 상대 날짜 — due 날짜 형식 YYYY-MM-DD 검증', async ({ request }) => {
  test.skip(!IS_AI_ENABLED, 'Real Gemini API required');

  const filePath = await postMemoAndGetFile(
    request,
    '이번 주 금요일 퇴근 전까지 보고서 제출하고, 다음 주 수요일에 팔로업 미팅 잡자.'
  );

  const content = await pollFile(filePath, (c) => c.includes('## Tasks'), 20000);

  expect(content).not.toBeNull();
  expect(content).toContain('## Tasks');
  // Due date format check — loose: at least one valid due date present
  expect(content).toMatch(/\[due:: \d{4}-\d{2}-\d{2}\]/);
});

// ============================================================
// S5: 의사결정 번복 감지
// ============================================================
test('S5: 의사결정 번복 — PIE #decision 감지', async ({ request }) => {
  test.skip(!IS_AI_ENABLED, 'Real Gemini API required');

  const filePath = await postMemoAndGetFile(
    request,
    '지난 주에 A 벤더로 결정했는데, 오늘 회의에서 B 벤더로 바꾸기로 했다. 이유는 가격 문제.'
  );

  const content = await pollFile(
    filePath,
    (c) => c.includes('## 🧠 PIE Perspective'),
    20000
  );

  expect(content).not.toBeNull();
  expect(content).toContain('## 🧠 PIE Perspective');
  // Loose: any reversal/decision-related keyword
  expect(content).toMatch(/번복|변경|결정|전환|리스크|벤더/);
  const fm = parseFrontmatter(content);
  expect(fm).toMatch(/decision|stakeholder/);
});

// ============================================================
// S6: 재무 시그널 감지
// ============================================================
test('S6: 재무 시그널 — #forecast 태그 + 재무 키워드', async ({ request }) => {
  test.skip(!IS_AI_ENABLED, 'Real Gemini API required');

  const filePath = await postMemoAndGetFile(
    request,
    'Q3 매출이 목표 대비 15% 미달. 원가 상승과 환율 변동이 주요 원인. 내년 예산 재조정 필요.'
  );

  const content = await pollFile(
    filePath,
    (c) => c.includes('## 🧠 PIE Perspective'),
    20000
  );

  expect(content).not.toBeNull();
  expect(content).toContain('## 🧠 PIE Perspective');
  // Loose: any financial forecast keyword
  expect(content).toMatch(/매출|예산|원가|환율|전망|리스크|forecast/);
  const fm = parseFrontmatter(content);
  expect(fm).toContain('forecast');
});

// ============================================================
// S7: 노이즈 STT 처리
// ============================================================
test('S7: 노이즈 STT — 음성 노이즈에도 Tasks 추출', async ({ request }) => {
  test.skip(!IS_AI_ENABLED, 'Real Gemini API required');

  const filePath = await postMemoAndGetFile(
    request,
    '음... 저기... 그러니까 내일까지 에음 보고서를... 네 제출해야 하고요, 그리고 뭐랬더라... 아 맞다 목요일에 클라이언트 미팅 있어요.'
  );

  const content = await pollFile(filePath, (c) => c.includes('## Tasks'), 20000);

  expect(content).not.toBeNull();
  expect(content).toContain('## Tasks');
  expect(content).toContain('- [ ]');
  // At least one due date extracted despite noise
  expect(content).toMatch(/\[due:: \d{4}-\d{2}-\d{2}\]/);
});

// ============================================================
// S10: 복합 일정 충돌
// ============================================================
test('S10: 복합 일정 충돌 — 복수 Tasks 모두 기록', async ({ request }) => {
  test.skip(!IS_AI_ENABLED, 'Real Gemini API required');

  const filePath = await postMemoAndGetFile(
    request,
    '월요일 오전 10시 팀 스탠드업, 같은 날 오전 11시 임원 보고, 화요일 오후 3시 고객사 PT.'
  );

  const content = await pollFile(filePath, (c) => c.includes('## Tasks'), 20000);

  expect(content).not.toBeNull();
  expect(content).toContain('## Tasks');
  // Loose: at least 2 task entries recorded
  const taskMatches = content.match(/- \[ \]/g) || [];
  expect(taskMatches.length).toBeGreaterThanOrEqual(2);
});
