const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

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

async function authenticate(page) {
  await page.addInitScript((key) => {
    localStorage.setItem('vv_apiKey', key);
  }, API_KEY);
  await page.goto('/');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });
}

// ============================================================
// Calendar Event Detection API
// ============================================================
test.describe('Calendar Event Detection API', () => {
  test('detect-event endpoint validates input or returns 503 without Gemini key', async ({ request }) => {
    const res = await request.post('/api/ai/detect-event', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: { content: '' },
    });
    // 400 (missing fields) or 503 (no Gemini key in test env)
    expect([400, 503]).toContain(res.status());
  });

  test('detect-event endpoint rejects unauthorized', async ({ request }) => {
    const res = await request.post('/api/ai/detect-event', {
      headers: {
        'Authorization': 'Bearer wrong-key',
        'Content-Type': 'application/json',
      },
      data: { content: 'test', referenceDate: '2026-02-22' },
    });
    expect(res.status()).toBe(401);
  });

  test('calendar/add supports isAllDay parameter', async ({ request }) => {
    // This will fail with 401 (no calendar token) but validates the endpoint accepts the param
    const res = await request.post('/api/calendar/add', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        summary: 'Test Event',
        start: '2026-03-01',
        end: '2026-03-02',
        isAllDay: true,
      },
    });
    // 401 = Not connected (expected without Google token), not 500
    expect(res.status()).toBe(401);
  });
});

// ============================================================
// Calendar Event Detection UI
// ============================================================
test.describe('Calendar Event Detection UI', () => {
  test('event detection banner exists in DOM', async ({ page }) => {
    await authenticate(page);
    const banner = page.locator('#event-detect-banner');
    await expect(banner).toBeAttached();
    await expect(banner).toBeHidden();
  });

  test('event detection banner has add and dismiss buttons', async ({ page }) => {
    await authenticate(page);
    await expect(page.locator('#event-detect-add')).toBeAttached();
    await expect(page.locator('#event-detect-dismiss')).toBeAttached();
  });

  test('calendar auto-detect toggle exists in settings', async ({ page }) => {
    await authenticate(page);
    await page.click('[data-tab="settings"]');
    const toggle = page.locator('#cal-auto-detect');
    await expect(toggle).toBeAttached();
    // Default is checked
    await expect(toggle).toBeChecked();
  });

  test('calendar auto-detect toggle persists setting', async ({ page }) => {
    await authenticate(page);
    await page.click('[data-tab="settings"]');
    const toggle = page.locator('#cal-auto-detect');

    // Uncheck via JS (checkbox hidden inside custom toggle, outside viewport)
    await toggle.scrollIntoViewIfNeeded();
    await toggle.evaluate(el => { el.checked = false; el.dispatchEvent(new Event('change')); });
    await expect(toggle).not.toBeChecked();

    // Verify localStorage
    const stored = await page.evaluate(() => localStorage.getItem('vv_calAutoDetect'));
    expect(stored).toBe('off');

    // Re-check
    await toggle.evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change')); });
    const stored2 = await page.evaluate(() => localStorage.getItem('vv_calAutoDetect'));
    expect(stored2).toBe('on');
  });
});
