// VaultVoice UI + Jarvis Playwright E2E Tests
// Run: NODE_PATH=C:/Users/jsh86/AppData/Roaming/npm/node_modules node e2e/ui-jarvis.spec.js

const { chromium } = require('playwright');

const BASE = 'http://localhost:9097';
const API_KEY = '78ffbf5be7b254c4ef50ec8a85a4ffe2';

let browser, page;
const results = [];

function log(id, name, pass, detail) {
  const status = pass ? 'PASS' : 'FAIL';
  results.push({ id, name, status, detail: detail || '' });
  console.log(`[${status}] ${id}: ${name}${detail ? ' — ' + detail : ''}`);
}

async function setup() {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await ctx.newPage();
  // Login via URL key param
  await page.goto(`${BASE}?key=${API_KEY}`);
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(500);
}

async function teardown() {
  if (browser) await browser.close();
  console.log('\n========== RESULTS ==========');
  let pass = 0, fail = 0;
  results.forEach(r => {
    if (r.status === 'PASS') pass++;
    else fail++;
  });
  console.log(`PASS: ${pass}, FAIL: ${fail}, TOTAL: ${results.length}`);
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  FAIL: ${r.id} ${r.name} — ${r.detail}`);
  });
}

// === T1: Feed tab — no old AI buttons ===
async function testT1() {
  await page.click('.tab-btn[data-tab="feed"]');
  await page.waitForTimeout(1000);
  const aiResult = await page.$('#ai-result');
  const aiButtons = await page.$$('.ai-btn');
  log('T1', 'Feed tab: no old AI buttons', !aiResult && aiButtons.length === 0,
    aiResult ? 'ai-result exists' : aiButtons.length > 0 ? 'ai-btn found' : '');
}

// === T5: Card Jarvis button → AI tab switch ===
async function testT5() {
  await page.click('.tab-btn[data-tab="feed"]');
  await page.waitForTimeout(1500);
  const jarvisBtn = await page.$('.card-action-btn[data-action="jarvis"]');
  if (!jarvisBtn) { log('T5', 'Card Jarvis button → AI tab', false, 'No jarvis button found'); return; }
  await jarvisBtn.click();
  await page.waitForTimeout(500);
  const aiPanel = await page.$('#p-ai.active');
  const inputVal = await page.$eval('#jarvis-input', el => el.value);
  log('T5', 'Card Jarvis button → AI tab', !!aiPanel && inputVal.includes('노트'),
    `panel=${!!aiPanel}, input="${inputVal.substring(0, 50)}"`);
}

// === T14: Jarvis onboarding buttons displayed ===
async function testT14() {
  // Reset Jarvis state first
  await page.click('.tab-btn[data-tab="input"]');
  await page.waitForTimeout(300);
  await page.click('.tab-btn[data-tab="ai"]');
  await page.waitForTimeout(500);
  // Check if onboarding is visible (depends on chat history)
  const resetBtn = await page.$('#jarvis-reset');
  if (resetBtn) { await resetBtn.click(); await page.waitForTimeout(500); }
  const onboarding = await page.$('#jarvis-onboarding');
  const display = onboarding ? await onboarding.evaluate(el => getComputedStyle(el).display) : 'none';
  const buttons = await page.$$('.onboarding-btn');
  log('T14', 'Jarvis onboarding buttons', display !== 'none' && buttons.length === 5,
    `display=${display}, buttons=${buttons.length}`);
}

// === T15: Onboarding button click → sends prompt ===
async function testT15() {
  // Reset first
  const resetBtn = await page.$('#jarvis-reset');
  if (resetBtn) { await resetBtn.click(); await page.waitForTimeout(500); }
  await page.click('.tab-btn[data-tab="input"]');
  await page.waitForTimeout(200);
  await page.click('.tab-btn[data-tab="ai"]');
  await page.waitForTimeout(500);

  const firstBtn = await page.$('.onboarding-btn:not([data-prompt$=": "])');
  if (!firstBtn) { log('T15', 'Onboarding click → Jarvis', false, 'No non-URL onboarding btn'); return; }
  const prompt = await firstBtn.evaluate(el => el.getAttribute('data-prompt'));
  await firstBtn.click();
  await page.waitForTimeout(1000);
  // Check that onboarding is hidden and a user bubble appeared
  const onboarding = await page.$('#jarvis-onboarding');
  const onboardingDisplay = onboarding ? await onboarding.evaluate(el => getComputedStyle(el).display) : 'none';
  const userBubbles = await page.$$('.jarvis-bubble-user');
  log('T15', 'Onboarding click → Jarvis sends', onboardingDisplay === 'none' && userBubbles.length > 0,
    `hidden=${onboardingDisplay === 'none'}, bubbles=${userBubbles.length}`);
}

// === T26: Settings — feed tab help text updated ===
async function testT26() {
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(500);
  const feedHelp = await page.$$eval('.help-item', items => {
    const feed = items.find(el => el.querySelector('strong')?.textContent?.includes('피드'));
    return feed ? feed.textContent : '';
  });
  const hasNew = feedHelp.includes('코멘트') || feedHelp.includes('요약');
  const hasOld = feedHelp.includes('태그 추천') && feedHelp.includes('분류');
  log('T26', 'Settings: feed help text', hasNew && !hasOld,
    `new=${hasNew}, oldRemoved=${!hasOld}`);
}

// === T27: Settings — Jarvis help text updated ===
async function testT27() {
  const jarvisHelp = await page.$$eval('.help-item', items => {
    const ai = items.find(el => el.querySelector('strong')?.textContent?.includes('AI'));
    return ai ? ai.textContent : '';
  });
  const hasNewFeatures = jarvisHelp.includes('URL') || jarvisHelp.includes('요약') || jarvisHelp.includes('코멘트');
  log('T27', 'Settings: Jarvis help text', hasNewFeatures,
    `text contains new features: ${hasNewFeatures}`);
}

// === T28: Feature test button runs ===
async function testT28() {
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(1000);
  const testBtn = await page.$('#run-test');
  if (!testBtn) { log('T28', 'Feature test button', false, 'No test button'); return; }
  await testBtn.click();
  await page.waitForTimeout(10000);
  const resultsDiv = await page.$('#test-results');
  const html = resultsDiv ? await resultsDiv.innerHTML() : '';
  const hasContent = html.length > 50;
  log('T28', 'Feature test button runs', hasContent,
    `results html length=${html.length}`);
}

// === Card actions UI tests ===
async function testCardSummarize() {
  await page.click('.tab-btn[data-tab="feed"]');
  await page.waitForTimeout(1500);
  const summarizeBtn = await page.$('.card-action-btn[data-action="summarize"]');
  if (!summarizeBtn) { log('T2-UI', 'Card summarize button', false, 'No summarize button'); return; }
  await summarizeBtn.click();
  // Wait for summary to load (AI Pro call, can take 30s+)
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    const card2 = await summarizeBtn.evaluateHandle(el => el.closest('.feed-card'));
    const sd = await card2.$('.card-summary');
    const t = sd ? await sd.textContent() : '';
    if (t && !t.includes('요약 중')) break;
  }
  const card = await summarizeBtn.evaluateHandle(el => el.closest('.feed-card'));
  const summaryDiv = await card.$('.card-summary');
  const display = summaryDiv ? await summaryDiv.evaluate(el => el.style.display) : 'none';
  const text = summaryDiv ? await summaryDiv.textContent() : '';
  log('T2-UI', 'Card summarize via UI', display !== 'none' && text.length > 10 && !text.includes('실패') && !text.includes('요약 중'),
    `display=${display}, text="${text.substring(0, 60)}"`);
}

async function testCardComment() {
  await page.click('.tab-btn[data-tab="feed"]');
  await page.waitForTimeout(1500);
  const commentBtn = await page.$('.card-action-btn[data-action="comment"]');
  if (!commentBtn) { log('T6-UI', 'Card comment button', false, 'No comment button'); return; }
  await commentBtn.click();
  await page.waitForTimeout(300);
  const card = await commentBtn.evaluateHandle(el => el.closest('.feed-card'));
  const inputDiv = await card.$('.card-comment-input');
  const display = inputDiv ? await inputDiv.evaluate(el => el.style.display) : 'none';
  log('T6-UI', 'Card comment toggle', display !== 'none',
    `commentInput display=${display}`);

  // Actually submit a comment
  if (display !== 'none') {
    const textarea = await card.$('.card-comment-input textarea');
    if (textarea) {
      await textarea.fill('Playwright E2E test comment');
      const submitBtn = await card.$('[data-action="comment-submit"]');
      if (submitBtn) {
        await submitBtn.click();
        // Wait for AI refine + file write (Gemini Lite, ~5-15s)
        let toastFound = false;
        for (let i = 0; i < 10; i++) {
          await page.waitForTimeout(2000);
          const toast = await page.$('.vv-toast');
          if (toast) { toastFound = true; break; }
        }
        // Also check: comment input hidden = success
        const inputHidden = await card.$eval('.card-comment-input', el => el.style.display === 'none').catch(() => false);
        log('T6-UI-submit', 'Card comment submit', toastFound || inputHidden,
          `toast=${toastFound}, inputHidden=${inputHidden}`);
      }
    }
  }
}

// === T11-UI: Jarvis summarize_note via chat ===
async function testJarvisSummarize() {
  await page.click('.tab-btn[data-tab="ai"]');
  await page.waitForTimeout(500);
  const resetBtn = await page.$('#jarvis-reset');
  if (resetBtn) { await resetBtn.click(); await page.waitForTimeout(500); }

  const input = await page.$('#jarvis-input');
  await input.fill('TEST_voice.md 요약해줘');
  await page.click('#jarvis-send');
  // Wait for AI response (Pro model, can take time)
  await page.waitForTimeout(30000);
  const botBubbles = await page.$$('.jarvis-bubble-bot');
  const lastBubble = botBubbles.length > 0 ? botBubbles[botBubbles.length - 1] : null;
  const text = lastBubble ? await lastBubble.textContent() : '';
  log('T11-UI', 'Jarvis summarize_note', text.length > 20 && !text.includes('오류'),
    `response length=${text.length}, start="${text.substring(0, 80)}"`);
}

// === Search filter UI test ===
async function testSearchFilter() {
  await page.click('.tab-btn[data-tab="search"]');
  await page.waitForTimeout(500);
  // Set filter to voice type
  await page.selectOption('#filterType', 'voice');
  const searchInput = await page.$('#searchInput');
  await searchInput.fill('회의');
  await page.click('#btnSearch');
  await page.waitForTimeout(3000);
  const resultsHtml = await page.$eval('#searchResults', el => el.innerHTML);
  log('T17-UI', 'Search filter type=voice via UI', resultsHtml.length > 50,
    `results html length=${resultsHtml.length}`);
  // Reset filter
  await page.selectOption('#filterType', '');
}

// === Main ===
(async () => {
  try {
    await setup();
    console.log('--- UI Tests (no AI wait) ---');
    await testT1();
    await testT5();
    await testT14();
    await testT15();
    await testT26();
    await testT27();
    await testCardComment();
    await testSearchFilter();

    console.log('\n--- AI-dependent Tests (longer timeout) ---');
    await testCardSummarize();
    await testJarvisSummarize();
    await testT28();
  } catch (e) {
    console.error('Test error:', e.message);
  } finally {
    await teardown();
  }
})();
