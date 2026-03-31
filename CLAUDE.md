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

- 단일 `server.js`에 모든 API 엔드포인트 (40+ routes), 프론트는 `public/` SPA
- 인증: `Authorization: Bearer {API_KEY}` 헤더 (health/reset/google-auth 제외)
- AI: Gemini API 연동 (요약, 이미지 분석, 채팅, 일정 감지)
- 외부 연동: Obsidian REST API, Google Calendar
- 배포: GCP VM (PM2) + Cloudflare Tunnel (동적 URL)

### Vault 저장 구조 (`99_vaultvoice/`)

VaultVoice가 기록하는 모든 파일은 `{VAULT_PATH}/99_vaultvoice/` 하위에 저장된다.
Obsidian에서 태깅 후 주제별 폴더로 이동하는 워크플로우 (임시 수신함 역할).

```
99_vaultvoice/
├── daily-notes/       # 일일 메모 (YYYY-MM-DD.md)
├── photos/            # 사진 업로드
├── screenshots/       # 스크린샷
├── voice/             # 음성 메모
├── meetings/          # 회의 녹음
└── attachments/       # 기타 첨부파일
```

## Key Paths

| 파일 | 역할 |
|------|------|
| `server.js` | Express API 서버 (모든 백엔드 로직) |
| `public/app.js` | 클라이언트 전체 (단일 파일) |
| `public/index.html` | 메인 SPA |
| `public/sw.js` | Service Worker (오프라인 캐시) |

## Rules

- `.env` 민감 정보 → 커밋 시 제외 (`.gitignore` 등록됨)
- `server.js` 수정 시 rate limiter 설정 확인 (`server.js:77-91`)
- 테스트 시 `.env.test` + `test-vault/` 디렉토리만 사용 (실제 vault 대신)
- 아키텍처/API/테스트 상세: `.claude/rules/` 참조
