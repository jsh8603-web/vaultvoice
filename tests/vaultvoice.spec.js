const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Read API_KEY from .env.test (test environment)
function getApiKey() {
  const paths = [
    path.join(__dirname, '..', '.env.test'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const envPath of paths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(/^API_KEY=(.+)$/m);
      if (match) return match[1].trim();
    }
  }
  return 'test-key-12345';
}

const API_KEY = getApiKey();

// Helper: authenticate by setting localStorage then navigating
async function authenticate(page) {
  await page.addInitScript((key) => {
    localStorage.setItem('vv_apiKey', key);
  }, API_KEY);
  await page.goto('/');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });
}

// ============================================================
// 1. Health & Loading
// ============================================================
test.describe('Health & Loading', () => {
  test('server health endpoint returns ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('2.0.0');
  });

  test('index page loads with auth screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#auth')).toBeVisible();
    await expect(page.locator('#auth h1')).toContainText('VaultVoice');
    await expect(page.locator('#key-input')).toBeVisible();
    await expect(page.locator('#auth-btn')).toBeVisible();
  });

  test('reset page loads', async ({ page }) => {
    const res = await page.goto('/api/reset');
    expect(res.status()).toBe(200);
    await expect(page.locator('h2')).toContainText('Cache Reset');
  });
});

// ============================================================
// 2. Authentication
// ============================================================
test.describe('Authentication', () => {
  test('rejects invalid API key', async ({ page }) => {
    await page.goto('/');
    await page.fill('#key-input', 'wrong-key-12345');
    await page.click('#auth-btn');
    await expect(page.locator('#auth-err')).toBeVisible({ timeout: 5000 });
  });

  test('accepts valid API key and shows app', async ({ page }) => {
    await authenticate(page);
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#auth')).toBeHidden();
  });

  test('persists login via localStorage', async ({ page }) => {
    await authenticate(page);
    // Reload and check still logged in
    await page.reload();
    await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });
  });

  test('URL key param auto-login', async ({ page }) => {
    await page.goto(`/?key=${API_KEY}`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });
  });
});

// ============================================================
// 3. Tab Navigation
// ============================================================
test.describe('Tab Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('shows memo tab by default', async ({ page }) => {
    await expect(page.locator('#p-memo')).toBeVisible();
    await expect(page.locator('#p-today')).toBeHidden();
    await expect(page.locator('#p-hist')).toBeHidden();
    await expect(page.locator('#p-set')).toBeHidden();
  });

  test('can switch to 오늘 tab', async ({ page }) => {
    await page.click('[data-tab="today"]');
    await expect(page.locator('#p-today')).toBeVisible();
    await expect(page.locator('#p-memo')).toBeHidden();
  });

  test('can switch to 기록 tab', async ({ page }) => {
    await page.click('[data-tab="hist"]');
    await expect(page.locator('#p-hist')).toBeVisible();
    await expect(page.locator('#p-memo')).toBeHidden();
  });

  test('can switch to 설정 tab', async ({ page }) => {
    await page.click('[data-tab="set"]');
    await expect(page.locator('#p-set')).toBeVisible();
    await expect(page.locator('#p-memo')).toBeHidden();
  });

  test('active tab button gets active class', async ({ page }) => {
    await page.click('[data-tab="today"]');
    await expect(page.locator('[data-tab="today"]')).toHaveClass(/active/);
    await expect(page.locator('[data-tab="memo"]')).not.toHaveClass(/active/);
  });
});

// ============================================================
// 4. Memo Tab
// ============================================================
test.describe('Memo Tab', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('has date navigation', async ({ page }) => {
    await expect(page.locator('#memo-date')).toBeVisible();
    await expect(page.locator('#memo-prev')).toBeVisible();
    await expect(page.locator('#memo-next')).toBeVisible();
  });

  test('date navigation changes date display', async ({ page }) => {
    const initialText = await page.locator('#memo-date').textContent();
    await page.click('#memo-prev');
    const newText = await page.locator('#memo-date').textContent();
    expect(newText).not.toBe(initialText);
  });

  test('section chips are visible', async ({ page }) => {
    await expect(page.locator('#sec-chips')).toBeVisible();
    await expect(page.locator('[data-s="메모"]')).toBeVisible();
    await expect(page.locator('[data-s="오늘할일"]')).toBeVisible();
    await expect(page.locator('[data-s="오늘 회고"]')).toBeVisible();
  });

  test('clicking section chip changes active state', async ({ page }) => {
    await page.click('[data-s="오늘할일"]');
    await expect(page.locator('[data-s="오늘할일"]')).toHaveClass(/on/);
    await expect(page.locator('[data-s="메모"]')).not.toHaveClass(/on/);
  });

  test('selecting 오늘할일 shows todo options', async ({ page }) => {
    await page.click('[data-s="오늘할일"]');
    await expect(page.locator('#todo-options')).toBeVisible();
    await expect(page.locator('#priority-chips')).toBeVisible();
    await expect(page.locator('#todo-due')).toBeVisible();
  });

  test('has memo textarea', async ({ page }) => {
    await expect(page.locator('#memo-text')).toBeVisible();
    await expect(page.locator('#memo-text')).toHaveAttribute('placeholder', /음성 입력/);
  });

  test('has image and audio attachment areas', async ({ page }) => {
    await expect(page.locator('#image-input')).toBeAttached();
    await expect(page.locator('#gallery-input')).toBeAttached();
    await expect(page.locator('#audio-rec-btn')).toBeVisible();
  });

  test('has tag input', async ({ page }) => {
    await expect(page.locator('#tag-in')).toBeVisible();
  });

  test('has save button', async ({ page }) => {
    await expect(page.locator('#save-btn')).toBeVisible();
    await expect(page.locator('#save-btn')).toContainText('저장');
  });

  test('save button requires content', async ({ page }) => {
    // Clear textarea and try saving
    await page.fill('#memo-text', '');
    await page.click('#save-btn');
    // App focuses the textarea when content is empty (no save occurs)
    await page.waitForTimeout(300);
    const isFocused = await page.locator('#memo-text').evaluate(el => document.activeElement === el);
    expect(isFocused).toBeTruthy();
    // Verify no save happened - textarea should still be empty
    const textValue = await page.locator('#memo-text').inputValue();
    expect(textValue).toBe('');
  });
});

// ============================================================
// 5. Memo Save (API Integration)
// ============================================================
test.describe('Memo Save', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('can save a memo via UI', async ({ page }) => {
    const testText = `테스트 메모 ${Date.now()}`;
    await page.fill('#memo-text', testText);
    await page.click('#save-btn');

    // Wait for save feedback
    await page.waitForTimeout(2000);

    // Check the textarea was cleared (successful save)
    const textValue = await page.locator('#memo-text').inputValue();
    expect(textValue).toBe('');
  });

  test('API: save daily note', async ({ request }) => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request.post(`/api/daily/${today}`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        content: `Playwright test memo ${Date.now()}`,
        section: '메모',
        tags: ['test'],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('API: read daily note', async ({ request }) => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request.get(`/api/daily/${today}`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    // May be 200 or 404 depending on whether a note exists
    expect([200, 404]).toContain(res.status());
  });

  test('API: rejects invalid date format', async ({ request }) => {
    const res = await request.get('/api/daily/not-a-date', {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    expect(res.status()).toBe(400);
  });
});

// ============================================================
// 6. Today Tab
// ============================================================
test.describe('Today Tab', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await page.click('[data-tab="today"]');
  });

  test('shows today tab content', async ({ page }) => {
    await expect(page.locator('#p-today')).toBeVisible();
    await expect(page.locator('#today-date')).toBeVisible();
  });

  test('has AI action buttons', async ({ page }) => {
    await expect(page.locator('[data-action="summarize"]')).toBeVisible();
    await expect(page.locator('[data-action="suggest-tags"]')).toBeVisible();
    await expect(page.locator('[data-action="categorize"]')).toBeVisible();
  });

  test('date navigation works', async ({ page }) => {
    const initialText = await page.locator('#today-date').textContent();
    await page.click('#today-prev');
    const newText = await page.locator('#today-date').textContent();
    expect(newText).not.toBe(initialText);
  });
});

// ============================================================
// 7. History/Search Tab
// ============================================================
test.describe('History Tab', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await page.click('[data-tab="hist"]');
  });

  test('shows search input and buttons', async ({ page }) => {
    await expect(page.locator('#hist-search')).toBeVisible();
    await expect(page.locator('#search-btn')).toBeVisible();
    await expect(page.locator('#search-ai-btn')).toBeVisible();
  });

  test('has vault-wide search checkbox', async ({ page }) => {
    await expect(page.locator('#search-all-vault')).toBeAttached();
  });

  test('shows recent history list', async ({ page }) => {
    await expect(page.locator('#hist-list')).toBeVisible();
  });
});

// ============================================================
// 8. Settings Tab
// ============================================================
test.describe('Settings Tab', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await page.click('[data-tab="set"]');
  });

  test('shows server connection status', async ({ page }) => {
    await expect(page.locator('#st-conn')).toBeVisible();
    // Wait for status check to complete
    await page.waitForTimeout(2000);
    const statusText = await page.locator('#st-conn').textContent();
    expect(statusText).toBeTruthy();
  });

  test('shows QR code section', async ({ page }) => {
    await expect(page.locator('#qr-url-input')).toBeVisible();
    await expect(page.locator('#qr-img')).toBeAttached();
  });

  test('shows clipboard sharing section', async ({ page }) => {
    await expect(page.locator('#clip-text')).toBeVisible();
    await expect(page.locator('#clip-send')).toBeVisible();
    await expect(page.locator('#clip-recv')).toBeVisible();
  });

  test('shows feature test button', async ({ page }) => {
    await expect(page.locator('#run-test')).toBeVisible();
    await expect(page.locator('#run-test')).toContainText('전체 기능 점검');
  });

  test('shows default section selector', async ({ page }) => {
    await expect(page.locator('#def-sec')).toBeVisible();
    const options = page.locator('#def-sec option');
    await expect(options).toHaveCount(3);
  });

  test('has logout button', async ({ page }) => {
    await expect(page.locator('#logout-btn')).toBeVisible();
    await expect(page.locator('#logout-btn')).toContainText('로그아웃');
  });

  test('logout clears auth and shows login screen', async ({ page }) => {
    await page.click('#logout-btn');
    await expect(page.locator('#auth')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#app')).toBeHidden();
  });

  test('shows RAG section', async ({ page }) => {
    await expect(page.locator('#reindex-btn')).toBeVisible();
  });

  test('shows calendar section', async ({ page }) => {
    await expect(page.locator('#cal-connect-btn')).toBeVisible();
    await expect(page.locator('#cal-status')).toBeVisible();
  });
});

// ============================================================
// 9. API Endpoints
// ============================================================
test.describe('API Endpoints', () => {
  test('tags endpoint returns array', async ({ request }) => {
    const res = await request.get('/api/tags', {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('tags');
    expect(Array.isArray(body.tags)).toBeTruthy();
  });

  test('recent notes endpoint returns array', async ({ request }) => {
    const res = await request.get('/api/notes/recent', {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('notes');
    expect(Array.isArray(body.notes)).toBeTruthy();
  });

  test('test endpoint returns feature status', async ({ request }) => {
    const res = await request.get('/api/test', {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('server');
    expect(body.server.ok).toBe(true);
  });

  test('clipboard sync works', async ({ request }) => {
    // Write
    const writeRes = await request.post('/api/clipboard', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: { text: 'playwright test clipboard' },
    });
    expect(writeRes.ok()).toBeTruthy();

    // Read
    const readRes = await request.get('/api/clipboard', {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    expect(readRes.ok()).toBeTruthy();
    const body = await readRes.json();
    expect(body.text).toBe('playwright test clipboard');
  });

  test('search endpoint works', async ({ request }) => {
    const res = await request.get('/api/search?q=test', {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('results');
  });

  test('unauthorized request returns 401', async ({ request }) => {
    const res = await request.get('/api/tags', {
      headers: { 'Authorization': 'Bearer wrong-key' },
    });
    expect(res.status()).toBe(401);
  });
});

// ============================================================
// 10. PWA Elements
// ============================================================
test.describe('PWA', () => {
  test('has manifest link', async ({ page }) => {
    await page.goto('/');
    const manifest = page.locator('link[rel="manifest"]');
    await expect(manifest).toBeAttached();
    await expect(manifest).toHaveAttribute('href', '/manifest.json');
  });

  test('manifest.json is accessible', async ({ request }) => {
    const res = await request.get('/manifest.json');
    expect(res.ok()).toBeTruthy();
  });

  test('service worker file is accessible', async ({ request }) => {
    const res = await request.get('/sw.js');
    expect(res.ok()).toBeTruthy();
  });
});
