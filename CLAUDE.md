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

## Rules

- `.env` 민감 정보 → 커밋 시 제외 (`.gitignore` 등록됨)
- `server.js` 수정 시 rate limiter 설정 확인 (`server.js:77-91`)
- 테스트 시 `.env.test` + `test-vault/` 디렉토리만 사용 (실제 vault 대신)
- 아키텍처/API/테스트 상세: `.claude/rules/` 참조
