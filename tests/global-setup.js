/**
 * Playwright global setup — starts mock Gemini server before any worker launches.
 * Ensures port 3941 is bound once, preventing EADDRINUSE race conditions.
 */
const http = require('http');

const MOCK_PORT = 3941;

const MOCK_PIE_TEXT = [
  '## 🧠 PIE Perspective',
  '',
  '**이해관계자 (#stakeholder)**: 숨은 의도 분석 — KPI 충돌 지점 파악 필요.',
  '',
  '**미래 시그널 (#forecast)**: 연쇄 리스크 예측 — 조기 대응 권고.',
].join('\n');

const MOCK_TASKS_RESPONSE = {
  tasks: [{ title: '보고서 제출', due: '2026-01-20', priority: 'P2' }],
};

module.exports = async function globalSetup() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}

      const isJsonMode =
        parsed.generationConfig?.responseMimeType === 'application/json';
      const promptText =
        parsed.contents?.[0]?.parts?.[0]?.text || '';

      let response;
      if (isJsonMode) {
        response = MOCK_TASKS_RESPONSE;
      } else if (
        promptText.includes('PIE Engine') ||
        promptText.includes('PIE Perspective')
      ) {
        response = {
          candidates: [{ content: { parts: [{ text: MOCK_PIE_TEXT }] } }],
        };
      } else {
        response = {
          candidates: [{ content: { parts: [{ text: '테스트 노트 제목' }] } }],
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });

  await new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Another process already holds port 3941 — that's fine
        console.log(`[MockGemini] Port ${MOCK_PORT} already in use, skipping`);
        resolve();
      } else {
        reject(err);
      }
    });
    server.listen(MOCK_PORT, () => {
      console.log(`[MockGemini] Global server listening on port ${MOCK_PORT}`);
      resolve();
    });
  });

  // Attach to global so teardown can close it
  global.__mockGeminiServer = server;
};
