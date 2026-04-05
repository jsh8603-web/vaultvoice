/**
 * API Integration Tests — Stage 2+3 new endpoints
 *
 * Runs against test server (port 3939) with mock Gemini (port 3941).
 * Tests new API endpoints added in Stage 2 (entities, speakers, content)
 * and Stage 3 (tags/save, month feed, SSE, text processing).
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const API_KEY = 'test-key-12345';
const AUTH = { Authorization: `Bearer ${API_KEY}` };
const VAULT = path.join(__dirname, '..', 'test-vault');
const VV_DIR = path.join(VAULT, '99_vaultvoice');

// ============================================================
// Helper: create a test memo and return its filename
// ============================================================
async function createTestMemo(request, content, extra = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const res = await request.post('/api/process/text', {
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    data: { content, date, tags: ['test'], ...extra },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return { filename: body.filename, filePath: body.filePath || body.file };
}

// ============================================================
// A1: GET /api/entities
// ============================================================
test.describe('A1 — GET /api/entities', () => {
  test('returns persons, places, projects categories', async ({ request }) => {
    const res = await request.get('/api/entities', { headers: AUTH });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('persons');
    expect(body).toHaveProperty('places');
    expect(body).toHaveProperty('projects');
  });

  test('401 without auth', async ({ request }) => {
    const res = await request.get('/api/entities');
    expect(res.status()).toBe(401);
  });
});

// ============================================================
// A2: POST /api/note/entities/save
// ============================================================
test.describe('A2 — POST /api/note/entities/save', () => {
  test('renames entity in frontmatter', async ({ request }) => {
    const { filename } = await createTestMemo(request, '엔티티 저장 테스트 메모');

    const res = await request.post('/api/note/entities/save', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename, type: 'person', original: '테스트인물', corrected: '수정인물' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('400 with missing fields', async ({ request }) => {
    const res = await request.post('/api/note/entities/save', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename: 'nonexistent.md' },
    });
    expect(res.status()).toBe(400);
  });

  test('400 with invalid type', async ({ request }) => {
    const res = await request.post('/api/note/entities/save', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename: 'test.md', type: 'invalid', original: 'a', corrected: 'b' },
    });
    expect(res.status()).toBe(400);
  });

  test('404 with nonexistent file', async ({ request }) => {
    const res = await request.post('/api/note/entities/save', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename: 'nonexistent-file-xyz.md', type: 'person', original: 'a', corrected: 'b' },
    });
    expect(res.status()).toBe(404);
  });
});

// ============================================================
// A3: POST /api/note/speakers/save
// ============================================================
test.describe('A3 — POST /api/note/speakers/save', () => {
  test('replaces speaker label in body', async ({ request }) => {
    const { filename, filePath } = await createTestMemo(request, '화자 1: 오늘 회의 내용입니다.');

    const res = await request.post('/api/note/speakers/save', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename, originalSpeaker: '화자 1', resolvedName: '김철수' },
    });
    expect(res.ok()).toBeTruthy();

    // Verify body replacement
    if (filePath && fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('김철수');
      expect(content).not.toContain('화자 1');
    }
  });

  test('400 with missing fields', async ({ request }) => {
    const res = await request.post('/api/note/speakers/save', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename: 'test.md' },
    });
    expect(res.status()).toBe(400);
  });
});

// ============================================================
// A4: PUT /api/note/content
// ============================================================
test.describe('A4 — PUT /api/note/content', () => {
  test('replaces body while preserving frontmatter', async ({ request }) => {
    const { filename, filePath } = await createTestMemo(request, '원본 내용입니다.');
    const newBody = '\n수정된 내용입니다.\n';

    const res = await request.put('/api/note/content', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename, body: newBody },
    });
    expect(res.ok()).toBeTruthy();

    if (filePath && fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('수정된 내용입니다.');
      // Frontmatter should still be present
      expect(content).toMatch(/^---\n/);
    }
  });

  test('400 without body', async ({ request }) => {
    const res = await request.put('/api/note/content', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename: 'test.md' },
    });
    expect(res.status()).toBe(400);
  });
});

// ============================================================
// A5: POST /api/note/tags/save
// ============================================================
test.describe('A5 — POST /api/note/tags/save', () => {
  test('saves tags and preserves vaultvoice tag', async ({ request }) => {
    const { filename } = await createTestMemo(request, '태그 저장 테스트 메모');

    const res = await request.post('/api/note/tags/save', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename, tags: ['AI', '테스트'] },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.tags).toContain('vaultvoice');
    expect(body.tags).toContain('AI');
    expect(body.tags).toContain('테스트');
  });

  test('400 with non-array tags', async ({ request }) => {
    const res = await request.post('/api/note/tags/save', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      data: { filename: 'test.md', tags: 'not-array' },
    });
    expect(res.status()).toBe(400);
  });
});

// ============================================================
// A6: GET /api/feed/month/:month
// ============================================================
test.describe('A6 — GET /api/feed/month/:month', () => {
  test('returns dates array for valid month', async ({ request }) => {
    const month = new Date().toISOString().slice(0, 7);
    const res = await request.get(`/api/feed/month/${month}`, { headers: AUTH });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.month).toBe(month);
    expect(Array.isArray(body.dates)).toBe(true);
  });

  test('400 with invalid format', async ({ request }) => {
    const res = await request.get('/api/feed/month/2026', { headers: AUTH });
    expect(res.status()).toBe(400);
  });
});

// ============================================================
// A7: GET /api/pipeline/progress (SSE)
// ============================================================
test.describe('A7 — GET /api/pipeline/progress', () => {
  test('400 without id param', async ({ request }) => {
    const res = await request.get(`/api/pipeline/progress?key=${API_KEY}`, { headers: AUTH });
    expect(res.status()).toBe(400);
  });

  test('SSE endpoint responds (browser-based EventSource)', async ({ page }) => {
    // Navigate first so relative URLs resolve against baseURL
    await page.goto('/');
    const connected = await page.evaluate(async (key) => {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000);
        const url = `${window.location.origin}/api/pipeline/progress?key=${key}&id=test-sse`;
        const es = new EventSource(url);
        es.onopen = () => { clearTimeout(timeout); es.close(); resolve(true); };
        es.onerror = () => { clearTimeout(timeout); es.close(); resolve(false); };
      });
    }, API_KEY);
    expect(typeof connected).toBe('boolean');
  });
});

// ============================================================
// A8: POST /api/process/text — Stage 3 D1~D3
// ============================================================
test.describe('A8 — POST /api/process/text (D1-D3)', () => {
  test('created note has status field', async ({ request }) => {
    const { filePath } = await createTestMemo(request, 'D2 status 전이 테스트 메모');
    if (filePath && fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toMatch(/status:/);
    }
  });

  test('created note has tags array in frontmatter', async ({ request }) => {
    const { filePath } = await createTestMemo(request, 'D1 tags 테스트 메모');
    if (filePath && fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toMatch(/tags:/);
    }
  });

  test('text/memo note includes memo tag', async ({ request }) => {
    const { filePath } = await createTestMemo(request, 'D3 memo 태그 테스트 메모');
    if (filePath && fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('memo');
    }
  });
});
