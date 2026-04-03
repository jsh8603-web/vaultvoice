# VaultVoice

iPhone Voice Memo → Obsidian Daily Note PWA (Node.js/Express + Vanilla JS)

## Commands

```bash
npm run dev          # 개발 서버 (--watch, port from .env)
npm start            # 프로덕션 서버
npx playwright test  # E2E 테스트 (.env.test 환경)
```

## Deploy (commit/push 후 필수 — 서버 + 터널 검증까지)

GCP VM (`jsh86@35.233.232.24`, port 3939):
```bash
# 1. 코드 배포 + 서버 재시작
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/google_compute_engine jsh86@35.233.232.24 'PATH=$PATH:/usr/local/bin; cd ~/vaultvoice-app && git pull && npm install --production && pm2 restart vaultvoice && sleep 2 && curl -s http://localhost:3939/api/health'
# 2. 터널 URL 확인 (없으면 재시작)
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/google_compute_engine jsh86@35.233.232.24 'grep -oP "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/cloudflared.log 2>/dev/null | tail -1'
# 3. 외부 검증: curl -s https://{터널URL}/api/health
# 4. 터널 URL 변경 시: 서버 .env GOOGLE_REDIRECT_URI + Google Cloud Console 리디렉션 URI 업데이트
```
절차/에러 상세: `memory/deployment.md` 참조

## Architecture

상세 구조: `.claude/rules/architecture.md` 참조

- 단일 `server.js` (4,273줄) + `public/` SPA
- AI 파이프라인: 메모 저장 → Title → PIE Perspective → Action Items → Consistency Audit → RAG 인덱싱
- Gemini 4-tier: lite/flash/pro/max
- Jarvis: Function Calling 기반 16개 도구 (검색, CRUD, Calendar, 코멘트)
- 입력 프로세서: text, audio (STT), image (Vision), URL (요약)
- 인증: `Authorization: Bearer {API_KEY}` (health/reset/google-auth 제외)
- 배포: GCP VM (PM2) + Cloudflare Tunnel (동적 URL)

## Key Paths

| 파일 | 역할 |
|------|------|
| `server.js` | Express API 서버 (모든 백엔드 로직, 4,273줄) |
| `public/app.js` | 클라이언트 SPA (단일 파일) |
| `public/index.html` | 메인 HTML |
| `public/sw.js` | Service Worker (오프라인 캐시) |

## Rules

- `.env` 민감 정보 → 커밋 시 제외 (`.gitignore` 등록됨)
- `server.js` 수정 시 rate limiter 설정 확인 (`server.js:77-91`)
- 테스트 시 `.env.test` + `test-vault/` 디렉토리만 사용 (실제 vault 대신)
- 아키텍처/테스트 상세: `.claude/rules/` 참조
