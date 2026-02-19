# VaultVoice

iPhone Voice Memo → Obsidian Daily Note PWA (Node.js/Express + Vanilla JS)

## Commands

```bash
npm run dev          # 개발 서버 (--watch, port from .env)
npm start            # 프로덕션 서버
npx playwright test  # E2E 테스트 (.env.test 환경)
```

## Key Paths

| 파일 | 역할 |
|------|------|
| `server.js` | Express API 서버 (모든 백엔드 로직) |
| `public/app.js` | 클라이언트 전체 (단일 파일) |
| `public/index.html` | 메인 SPA |
| `public/sw.js` | Service Worker (오프라인 캐시) |
| `.env` | 환경 설정 (`.env.example` 참고) |
| `.env.test` | 테스트 환경 (PORT=3939, test-vault) |

## Architecture

- 단일 `server.js`에 모든 API 엔드포인트 (40+ routes)
- 인증: `Authorization: Bearer {API_KEY}` 헤더
- Vault 경로: `VAULT_PATH` 환경변수 → Obsidian vault 디렉토리
- Daily Notes: `{VAULT_PATH}/02. Areas/Daily Notes/{YYYY-MM-DD}.md`
- 미디어 업로드: photo, screenshot, voice, meeting 타입별 디렉토리 분리
- AI: Gemini API 연동 (요약, 이미지 분석, 채팅)
- 외부 연동: Obsidian REST API, Google Calendar

## Rules

- `.env`에 민감 정보 포함 — 커밋 금지 (`.gitignore` 등록됨)
- `server.js` 수정 시 rate limiter 설정 확인 (`server.js:77-91`)
- 테스트는 `.env.test` + `test-vault/` 사용 — 실제 vault 접근 금지
- 상세: `.claude/rules/` 참조
