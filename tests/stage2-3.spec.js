'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ============================================================
// Config
// ============================================================
const IS_AI_ENABLED = !!process.env.GEMINI_API_KEY &&
  process.env.GEMINI_API_KEY !== 'your_key_here';

const VAULT = path.join(__dirname, '..', 'test-vault');
const VV_DIR = path.join(VAULT, '99_vaultvoice');

function getApiKey() {
  const envFiles = [
    path.join(__dirname, '..', '.env.test'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const f of envFiles) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, 'utf-8').match(/^API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  return 'test-key-12345';
}

const API_KEY = getApiKey();
const AUTH = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

// ============================================================
// Helpers
// ============================================================
async function pollFile(filePath, maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function pollFileContains(filePath, pattern, maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (pattern instanceof RegExp ? pattern.test(content) : content.includes(pattern)) return content;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function fakeSubscription(tag = 'test') {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/fake-${tag}-${Date.now()}`,
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlTiEDKqITDq2EXa_KY4e8d1e3z3v3', auth: 'tBHItJI5svbpez7KI4CCXg' }
  };
}

// ============================================================
// Sub 3-1: Environment setup (run generate_dummies.js first)
// ============================================================
test.describe('Sub 3-1 — Test Environment', () => {
  test('test-vault/99_vaultvoice has ≥30 dummy memos', () => {
    if (!fs.existsSync(VV_DIR)) {
      throw new Error('test-vault/99_vaultvoice missing — run: node generate_dummies.js');
    }
    const memos = fs.readdirSync(VV_DIR).filter(f => f.endsWith('.md'));
    expect(memos.length).toBeGreaterThanOrEqual(30);
  });

  test('server health check passes', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});

// ============================================================
// Sub 3-2: F5 Entity Indexer + F6 Frontmatter
// ============================================================
test.describe('Sub 3-2 — F5/F6 Entity Indexer + Frontmatter', () => {
  test('GET /api/entity/resync → 200 + {status:"ok"}', async ({ request }) => {
    const res = await request.get('/api/entity/resync', { headers: AUTH });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.counts).toBeDefined();
  });

  test('entity_map.json created in .vaultvoice/ after server start (30s poll)', async () => {
    const mapPath = path.join(VAULT, '.vaultvoice', 'entity_map.json');
    const found = await pollFile(mapPath, 30000);
    expect(found).toBe(true);
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
    expect(map).toHaveProperty('persons');
    expect(map).toHaveProperty('projects');
    expect(map).toHaveProperty('places');
  });

  test('saved memo frontmatter has participants/projects/places arrays', async ({ request }) => {
    const today = getTodayKey();
    const res = await request.post('/api/process/text', {
      headers: AUTH,
      data: { content: '프론트매터 배열 테스트 메모입니다.', date: today, tags: ['test'] }
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.filePath || body.file || body.filename).toBeTruthy();

    const savedPath = body.filePath || body.file || path.join(VV_DIR, body.filename || '');
    const found = await pollFile(savedPath, 10000);
    expect(found).toBe(true);

    const content = fs.readFileSync(savedPath, 'utf-8');
    expect(content).toMatch(/^participants:/m);
    expect(content).toMatch(/^projects:/m);
    expect(content).toMatch(/^places:/m);
  });

  test('[AI] NER populates entity arrays with named values from rich memo', async ({ request }) => {
    test.skip(!IS_AI_ENABLED, 'IS_AI_ENABLED=false — GEMINI_API_KEY not set');

    const today = getTodayKey();
    const res = await request.post('/api/process/text', {
      headers: AUTH,
      data: {
        content: '오늘 김 이사님과 V-Project 킥오프 미팅을 강남 스타벅스에서 진행했습니다. 다음 주 월요일까지 CM1 보고서를 제출하기로 했습니다.',
        date: today,
        tags: ['test', 'ai-integration']
      }
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const savedPath = body.filePath || body.file;
    expect(savedPath).toBeTruthy();

    // AI pipeline runs async — poll up to 30s for entity fill
    const content = await pollFileContains(savedPath, /participants:|projects:|places:/, 30000);
    expect(content).not.toBeNull();

    // At least one of the arrays should be non-empty (has items under the key)
    const hasEntities = /participants:\n\s+-/.test(content) ||
      /projects:\n\s+-/.test(content) ||
      /places:\n\s+-/.test(content);
    expect(hasEntities).toBe(true);
  });
});

// ============================================================
// Sub 3-3: F3 TL;DR Callout
// ============================================================
test.describe('Sub 3-3 — F3 TL;DR Callout', () => {
  test('short memo (≤50 chars) has no [!abstract] callout', async ({ request }) => {
    const today = getTodayKey();
    const res = await request.post('/api/process/text', {
      headers: AUTH,
      data: { content: '짧은 메모입니다.', date: today, tags: ['test'] }
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const savedPath = body.filePath || body.file;
    expect(savedPath).toBeTruthy();

    const found = await pollFile(savedPath, 10000);
    expect(found).toBe(true);
    // Give pipeline 3s to run (should NOT insert callout for short memo)
    await new Promise(r => setTimeout(r, 3000));
    const content = fs.readFileSync(savedPath, 'utf-8');
    expect(content).not.toContain('[!abstract]');
  });

  test('[AI] long memo (≥200 chars) gets [!abstract] callout inserted', async ({ request }) => {
    test.skip(!IS_AI_ENABLED, 'IS_AI_ENABLED=false — GEMINI_API_KEY not set');

    const today = getTodayKey();
    const longContent = '오늘 전사 회의에서 Q2 전략 방향을 논의했습니다. 핵심 KPI는 수익성 개선으로 CM1 15% 방어가 최우선 과제입니다. ' +
      '신규 채용은 전면 중단하고 현 인력을 최적화하기로 결정했습니다. 각 팀장은 다음 주까지 비용 절감 계획을 제출해야 합니다. ' +
      '특히 마케팅 예산 30% 감축과 외주 용역 재검토가 포함되어야 합니다. 김 이사님이 직접 챙기신다고 하셨습니다.';

    const res = await request.post('/api/process/text', {
      headers: AUTH,
      data: { content: longContent, date: today, tags: ['test', 'ai-integration'] }
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const savedPath = body.filePath || body.file;
    expect(savedPath).toBeTruthy();

    const content = await pollFileContains(savedPath, '[!abstract]', 30000);
    expect(content).not.toBeNull();
    expect(content).toContain('> [!abstract]');
  });

  test('[AI] callout not duplicated on second pipeline run', async ({ request }) => {
    test.skip(!IS_AI_ENABLED, 'IS_AI_ENABLED=false — GEMINI_API_KEY not set');

    const today = getTodayKey();
    const longContent = '중복 방지 테스트용 긴 메모입니다. 오늘 팀 스탠드업에서 세 가지 중요한 결정이 내려졌습니다. ' +
      '첫째, 스프린트 주기를 2주로 단축합니다. 둘째, 코드 리뷰 기준을 강화합니다. 셋째, 배포 자동화 파이프라인을 구축합니다. ' +
      '이 세 가지 변경사항은 다음 분기부터 적용될 예정입니다.';

    const res = await request.post('/api/process/text', {
      headers: AUTH,
      data: { content: longContent, date: today, tags: ['test', 'ai-integration'] }
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const savedPath = body.filePath || body.file;

    const content = await pollFileContains(savedPath, '[!abstract]', 30000);
    expect(content).not.toBeNull();

    // Count occurrences — must be exactly 1
    const matches = (content.match(/\[!abstract\]/g) || []).length;
    expect(matches).toBe(1);
  });
});

// ============================================================
// Sub 3-4: F7 Web Push + Daily Briefing
// ============================================================
test.describe('Sub 3-4 — F7 Web Push + Daily Briefing', () => {
  const SUBSCRIPTIONS_PATH = path.join(__dirname, '..', 'subscriptions.json');

  test.beforeEach(() => {
    // Clean slate for subscription tests
    if (fs.existsSync(SUBSCRIPTIONS_PATH)) {
      fs.writeFileSync(SUBSCRIPTIONS_PATH, '[]', 'utf-8');
    }
  });

  test('GET /api/push/vapid-public-key → publicKey string', async ({ request }) => {
    const res = await request.get('/api/push/vapid-public-key', { headers: AUTH });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.publicKey).toBe('string');
    expect(body.publicKey.length).toBeGreaterThan(20);
  });

  test('POST /api/push/subscribe → 201 + saved in subscriptions.json', async ({ request }) => {
    const sub = fakeSubscription('subscribe');
    const res = await request.post('/api/push/subscribe', { headers: AUTH, data: sub });
    expect(res.status()).toBe(201);

    const subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_PATH, 'utf-8'));
    const saved = subs.find(s => s.endpoint === sub.endpoint);
    expect(saved).toBeDefined();
  });

  test('duplicate subscribe does not create duplicate entry', async ({ request }) => {
    const sub = fakeSubscription('dup');
    await request.post('/api/push/subscribe', { headers: AUTH, data: sub });
    await request.post('/api/push/subscribe', { headers: AUTH, data: sub });

    const subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_PATH, 'utf-8'));
    const count = subs.filter(s => s.endpoint === sub.endpoint).length;
    expect(count).toBe(1);
  });

  test('DELETE /api/push/unsubscribe → 200 + removed from subscriptions.json', async ({ request }) => {
    const sub = fakeSubscription('unsub');
    await request.post('/api/push/subscribe', { headers: AUTH, data: sub });

    const res = await request.delete('/api/push/unsubscribe', {
      headers: AUTH,
      data: { endpoint: sub.endpoint }
    });
    expect(res.status()).toBe(200);

    const subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_PATH, 'utf-8'));
    expect(subs.find(s => s.endpoint === sub.endpoint)).toBeUndefined();
  });

  test('GET /api/daily/briefing → 200 + {briefing, pushedCount, dateKey}', async ({ request }) => {
    // Remove sent flag so briefing runs fresh
    const sentPath = path.join(__dirname, '..', `.briefing-sent-${getTodayKey()}`);
    if (fs.existsSync(sentPath)) fs.unlinkSync(sentPath);

    const res = await request.get('/api/daily/briefing', { headers: AUTH });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('dateKey');
    // Either fresh run or alreadySent
    const isFresh = 'pushedCount' in body && 'briefing' in body;
    const isAlreadySent = body.alreadySent === true;
    expect(isFresh || isAlreadySent).toBe(true);
  });

  test('.briefing-sent-{date} file created after successful briefing', async ({ request }) => {
    const sentPath = path.join(__dirname, '..', `.briefing-sent-${getTodayKey()}`);
    if (fs.existsSync(sentPath)) fs.unlinkSync(sentPath);

    const res = await request.get('/api/daily/briefing', { headers: AUTH });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    if (!body.alreadySent && body.briefing) {
      // briefing was generated — sent file must exist
      expect(fs.existsSync(sentPath)).toBe(true);
    }
  });

  test('second GET /api/daily/briefing → {alreadySent: true}', async ({ request }) => {
    const sentPath = path.join(__dirname, '..', `.briefing-sent-${getTodayKey()}`);
    // Ensure sent flag exists
    fs.writeFileSync(sentPath, new Date().toISOString(), 'utf-8');

    const res = await request.get('/api/daily/briefing', { headers: AUTH });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.alreadySent).toBe(true);
  });

  test('401 without auth header', async ({ request }) => {
    const res = await request.get('/api/daily/briefing');
    expect(res.status()).toBe(401);
  });
});
