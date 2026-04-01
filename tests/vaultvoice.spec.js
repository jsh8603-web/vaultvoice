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
    await page.reload();
    await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });
  });

  test('URL key param auto-login', async ({ page }) => {
    await page.goto(`/?key=${API_KEY}`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });
  });
});

// ============================================================
// 3. Tab Navigation (v3: input/feed/search/settings/vault)
// ============================================================
test.describe('Tab Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('shows input tab by default', async ({ page }) => {
    await expect(page.locator('#p-input')).toBeVisible();
    await expect(page.locator('#p-feed')).toBeHidden();
    await expect(page.locator('#p-search')).toBeHidden();
    await expect(page.locator('#p-settings')).toBeHidden();
  });

  test('can switch to feed tab', async ({ page }) => {
    await page.click('[data-tab="feed"]');
    await expect(page.locator('#p-feed')).toBeVisible();
    await expect(page.locator('#p-input')).toBeHidden();
  });

  test('can switch to search tab', async ({ page }) => {
    await page.click('[data-tab="search"]');
    await expect(page.locator('#p-search')).toBeVisible();
    await expect(page.locator('#p-input')).toBeHidden();
  });

  test('can switch to settings tab', async ({ page }) => {
    await page.click('[data-tab="settings"]');
    await expect(page.locator('#p-settings')).toBeVisible();
    await expect(page.locator('#p-input')).toBeHidden();
  });

  test('can switch to vault tab', async ({ page }) => {
    await page.click('[data-tab="vault"]');
    await expect(page.locator('#p-vault')).toBeVisible();
    await expect(page.locator('#p-input')).toBeHidden();
  });

  test('active tab button gets active class', async ({ page }) => {
    await page.click('[data-tab="feed"]');
    await expect(page.locator('[data-tab="feed"]')).toHaveClass(/active/);
    await expect(page.locator('[data-tab="input"]')).not.toHaveClass(/active/);
  });
});

// ============================================================
// 4. Input Tab (v3: unified input hub)
// ============================================================
test.describe('Input Tab', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('has main textarea', async ({ page }) => {
    await expect(page.locator('#mainInput')).toBeVisible();
  });

  test('has action buttons (photo, record, file, url)', async ({ page }) => {
    await expect(page.locator('#btnPhoto')).toBeVisible();
    await expect(page.locator('#btnRecord')).toBeVisible();
    await expect(page.locator('#btnFile')).toBeVisible();
    await expect(page.locator('#btnUrl')).toBeVisible();
  });

  test('has hidden file inputs', async ({ page }) => {
    await expect(page.locator('#photoInput')).toBeAttached();
    await expect(page.locator('#fileInput')).toBeAttached();
  });

  test('has tag input', async ({ page }) => {
    await expect(page.locator('#tagInput')).toBeVisible();
  });

  test('has save button', async ({ page }) => {
    await expect(page.locator('#btnSave')).toBeVisible();
    await expect(page.locator('#btnSave')).toContainText('저장');
  });

  test('save button requires content', async ({ page }) => {
    await page.fill('#mainInput', '');
    await page.click('#btnSave');
    await page.waitForTimeout(300);
    const isFocused = await page.locator('#mainInput').evaluate(el => document.activeElement === el);
    expect(isFocused).toBeTruthy();
  });

  test('has quick todo input', async ({ page }) => {
    await expect(page.locator('#todoInput')).toBeVisible();
    await expect(page.locator('#btnAddTodo')).toBeVisible();
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
    await page.fill('#mainInput', testText);
    await page.click('#btnSave');
    await page.waitForTimeout(2000);
    const textValue = await page.locator('#mainInput').inputValue();
    expect(textValue).toBe('');
  });

  test('API: save text note (atomic)', async ({ request }) => {
    const res = await request.post('/api/process/text', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        content: `Playwright test memo ${Date.now()}`,
        tags: ['test'],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.filename).toBeTruthy();
  });

  test('API: feed returns notes for date', async ({ request }) => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request.get(`/api/feed/${today}`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('notes');
    expect(Array.isArray(body.notes)).toBeTruthy();
  });

  test('API: legacy daily note still works', async ({ request }) => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request.get(`/api/daily/${today}`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    expect([200, 404]).toContain(res.status());
  });

  test('API: rejects invalid date format', async ({ request }) => {
    const res = await request.get('/api/daily/not-a-date', {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    expect(res.status()).toBe(400);
  });

  test('API: create todo note', async ({ request }) => {
    const res = await request.post('/api/todo', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: { text: `Test todo ${Date.now()}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// ============================================================
// 6. Feed Tab
// ============================================================
test.describe('Feed Tab', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await page.click('[data-tab="feed"]');
  });

  test('shows feed tab content', async ({ page }) => {
    await expect(page.locator('#p-feed')).toBeVisible();
    await expect(page.locator('#feedDate')).toBeVisible();
  });

  test('has AI action buttons', async ({ page }) => {
    await expect(page.locator('[data-action="summarize"]')).toBeVisible();
    await expect(page.locator('[data-action="suggest-tags"]')).toBeVisible();
    await expect(page.locator('[data-action="categorize"]')).toBeVisible();
  });

  test('date navigation works', async ({ page }) => {
    const initialText = await page.locator('#feedDate').textContent();
    await page.click('#feedPrev');
    const newText = await page.locator('#feedDate').textContent();
    expect(newText).not.toBe(initialText);
  });
});

// ============================================================
// 7. Search Tab
// ============================================================
test.describe('Search Tab', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await page.click('[data-tab="search"]');
  });

  test('shows search input and buttons', async ({ page }) => {
    await expect(page.locator('#searchInput')).toBeVisible();
    await expect(page.locator('#btnSearch')).toBeVisible();
    await expect(page.locator('#btnAiSearch')).toBeVisible();
  });

  test('has vault-wide search checkbox', async ({ page }) => {
    await expect(page.locator('#search-all-vault')).toBeAttached();
  });

  test('has filter selects', async ({ page }) => {
    await expect(page.locator('#filterType')).toBeVisible();
    await expect(page.locator('#filterDate')).toBeVisible();
  });
});

// ============================================================
// 8. Settings Tab
// ============================================================
test.describe('Settings Tab', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await page.click('[data-tab="settings"]');
  });

  test('shows server connection status', async ({ page }) => {
    await expect(page.locator('#st-conn')).toBeVisible();
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
    const writeRes = await request.post('/api/clipboard', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: { text: 'playwright test clipboard' },
    });
    expect(writeRes.ok()).toBeTruthy();
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
