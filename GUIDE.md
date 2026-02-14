# VaultVoice v2.0 사용 안내

## 새로 추가된 5대 기능

| 기능 | 설명 | 비고 |
|------|------|------|
| 음성 인식 | Chrome에서 마이크 버튼으로 한국어 음성 입력 | iOS는 키보드 마이크 사용 |
| 이미지 첨부 | 카메라/갤러리에서 사진 첨부 → 일일노트에 이미지 링크 삽입 | `99.Attachments/`에 저장 |
| 할일 관리 | 우선순위/마감일 설정, 체크박스 토글, Dataview 호환 | `[priority::높음]` 형식 |
| AI 요약 | Gemini 2.0 Flash로 요약/태그추천/분류 | API 키 필요 |
| 인앱 알림 | 할일에 알림 시간 설정 → 배너+소리로 알림 | localStorage 저장 |

---

## 시작 전 설정

### 1. Gemini API 키 (AI 기능 사용 시)

1. https://aistudio.google.com/apikey 접속
2. API 키 생성
3. `VaultVoice/.env` 파일 열기
4. `GEMINI_API_KEY=your_key_here` → 실제 키로 변경

```
GEMINI_API_KEY=AIzaSy실제키값여기에입력
```

> AI 기능을 안 쓸 거면 이 단계는 건너뛰어도 됩니다. 나머지 4개 기능은 키 없이 동작합니다.

### 2. 서버 실행

```bash
cd VaultVoice
node server.js
```

정상 실행 시 출력:
```
VaultVoice v2.0 server running
Local:   http://localhost:9097
Vault:   G:\내 드라이브\Obsidian\...
Gemini:  configured (또는 not configured)
```

### 3. 아이폰 접속 (Cloudflare Tunnel)

```bash
tunnel.bat
```

터널 URL로 아이폰 Safari에서 접속합니다.

---

## 기능별 테스트 방법

### 1. 음성 인식 테스트
- **PC Chrome**: 메모탭 → 텍스트 입력창 오른쪽 하단 🎤 버튼 클릭 → 한국어로 말하기 → 텍스트 자동 입력 확인
- **아이폰**: 🎤 버튼 안 보임 (정상) → 키보드의 마이크 아이콘 사용

### 2. 이미지 첨부 테스트
1. 메모탭 → 📷 (카메라) 또는 🖼️ (갤러리) 버튼 클릭
2. 사진 촬영/선택 → 72x72 썸네일 미리보기 표시
3. ✕ 버튼으로 삭제 가능
4. 메모 내용 입력 + 이미지 선택 → 저장
5. 오늘탭에서 확인:
```markdown
- 점심 사진 *(오후 12:30)*
  - ![[99.Attachments/vv-1707500000-a1b2c3d4.jpg]]
```
6. Obsidian에서 해당 일일노트 열면 이미지가 보입니다

### 3. 할일 관리 테스트
1. 메모탭 → 섹션에서 "오늘할일" 선택
2. 우선순위 (🔴높음 / 🔵보통 / 🟢낮음) 선택
3. 마감일 설정 (선택사항)
4. 내용 입력 → 저장
5. 오늘탭 → "할일 목록"에 표시:
   - 좌측 색상 보더 (빨강/파랑/초록)
   - 체크박스 클릭 → 완료/미완료 토글
   - 완료 시 취소선 표시
6. Obsidian 일일노트 확인:
```markdown
## 오늘할일
- [ ] 회의 자료 준비 [priority::높음] [due::2026-02-10]
- [x] npm 설정 완료 [priority::보통]
```

### 4. AI 요약 테스트
> `.env`에 Gemini API 키 설정 필요

1. 오늘탭 → 날짜에 메모가 있는 날 선택
2. 상단 3개 버튼:
   - **AI 요약**: 3~5문장 한국어 요약
   - **태그 추천**: 5~10개 태그 → 클릭하면 태그로 추가
   - **분류**: 주제별 그룹핑
3. 파란 테두리 패널에 결과 표시

### 5. 인앱 알림 테스트
1. 오늘탭 → 할일 항목 옆 🔔 아이콘 클릭
2. 알림 시간 설정 (테스트: 1~2분 후로 설정)
3. 설정 완료 → 🔔 아이콘이 주황색으로 변경
4. 설정한 시간 도착 시:
   - 상단 파란 배너 슬라이드
   - 비프음 재생
   - 진동 (Android/지원 기기)
   - 10초 후 자동 닫힘 또는 ✕ 수동 닫기
5. 설정탭 → "알림 목록"에서 전체 확인/삭제 가능

---

## .env 설정값 전체

```env
PORT=9097                    # 서버 포트
VAULT_PATH=볼트경로           # Obsidian 볼트 루트 경로
API_KEY=vaultvoice-2026      # 인증 키
GEMINI_API_KEY=your_key_here # Google Gemini API 키
ATTACHMENT_DIR=99.Attachments # 이미지 저장 폴더명
MAX_UPLOAD_SIZE=10           # 최대 업로드 크기 (MB)
```

## 폴더 구조

```
VaultVoice/
├── server.js          ← 서버 (API 5개 추가)
├── .env               ← 환경변수
├── package.json       ← 의존성 (multer, uuid, node-fetch 추가)
├── public/
│   ├── index.html     ← HTML (외부 파일 참조)
│   ├── app.js         ← 클라이언트 JS (5개 기능 모듈)
│   ├── app.css        ← 스타일
│   ├── manifest.json  ← PWA 매니페스트
│   ├── sw.js          ← 서비스워커
│   └── icons/         ← 앱 아이콘
└── node_modules/      ← npm 패키지
```

## 새 API 엔드포인트

| 메서드 | 경로 | 용도 |
|--------|------|------|
| POST | `/api/upload` | 이미지 업로드 |
| GET | `/api/attachments/:filename` | 이미지 미리보기 |
| GET | `/api/daily/:date/todos` | 할일 목록 조회 |
| POST | `/api/todo/toggle` | 체크박스 토글 |
| POST | `/api/ai/summarize` | AI 요약/태그/분류 |

## 문제 해결

- **서버 안 뜸**: `node_modules` 폴더가 Google Drive 동기화로 깨질 수 있음 → 삭제 후 `npm install` 재실행
- **AI 503 에러**: `.env`의 `GEMINI_API_KEY`가 `your_key_here`인 상태 → 실제 키로 변경
- **이미지 안 보임**: `99.Attachments` 폴더가 볼트 루트에 있는지 확인
- **마이크 버튼 안 보임 (Chrome)**: HTTPS 또는 localhost에서만 Web Speech API 작동
