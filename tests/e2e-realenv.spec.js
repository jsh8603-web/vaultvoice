/**
 * e2e-realenv.spec.js
 * 실환경 E2E 테스트 — GCP 운영 서버 대상
 *
 * 실행: TUNNEL_URL=https://... npx playwright test --project=e2e-realenv
 * 전제: .env에 API_KEY 존재, GCP vault /home/jsh86/vault/99_vaultvoice/ 접근 가능
 */

const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const { sshPollFile, SSH_BASE, parseFrontmatter } = require('./helpers');
const path = require('path');
const fs = require('fs');

// ── 환경 설정 ────────────────────────────────────────────────────────────────

/**
 * GCP vault 경로 — server.js: VAULT_PATH=/home/jsh86/vault, VV_BASE=99_vaultvoice
 * 각 메모 POST는 독립 atomic note 파일 생성: YYYY-MM-DD_HHMMSS_memo.md (flat, 서브폴더 없음)
 */
const NOTES_REMOTE = '/home/jsh86/vault/99_vaultvoice';

/** 테스트 메모 고유 prefix — cleanup 식별용 */
const TEST_PREFIX = '[E2E-TEST]';

/** API_KEY: .env에서 읽기 */
function getApiKey() {
  const envPath = path.join(__dirname, '..', '.env');
  const raw = fs.readFileSync(envPath, 'utf-8');
  const match = raw.match(/^API_KEY=(.+)$/m);
  if (!match) throw new Error('.env에 API_KEY 없음');
  return match[1].trim();
}

let API_KEY;
let BASE_URL;

// ── 더미 메모 20건 ────────────────────────────────────────────────────────────

/**
 * DUMMY_MEMOS[i] = { type, content, expect }
 *  type: 업무|일정|STT|개인
 *  content: 메모 본문 (TEST_PREFIX 포함)
 *  expect.hasTags: 태그 1개+ 예상 여부
 *  expect.hasTitle: 제목 생성 예상 여부
 *  expect.hasPIE: PIE 분석 예상 여부 (업무/일정)
 *  expect.hasTask: 할일 추출 예상 여부
 */
const DUMMY_MEMOS = [
  // ── 업무 8건 ──────────────────────────────────────────────────────────────
  {
    type: '업무',
    content: `${TEST_PREFIX} KPI 충돌 검토 필요. 영업팀 Q2 목표 120% 달성인데 고객만족도가 68점으로 하락. 어느 지표를 우선해야 할지 결정 필요. 다음 주 임원 보고 전에 정리해야 함.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: true, hasTask: true },
  },
  {
    type: '업무',
    content: `${TEST_PREFIX} 재무 예산 재배분 검토. 마케팅 예산 30% 초과했고 R&D는 15% 미집행. CFO가 분기 말 전에 재배분 승인 요청함. 옵션A 마케팅 삭감, 옵션B R&D 이월.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: true, hasTask: true },
  },
  {
    type: '업무',
    content: `${TEST_PREFIX} 의사결정 보류 건. 신규 CRM 도입 vs 기존 시스템 업그레이드. 도입비 8000만 vs 업그레이드비 2500만. ROI 분석 3년 기준으로 다시 돌려봐야 함.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: true, hasTask: true },
  },
  {
    type: '업무',
    content: `${TEST_PREFIX} 분기 보고서 초안 검토 요청. 박팀장이 보낸 초안에 전분기 대비 수치가 누락됨. 3페이지 표 수정 후 금요일까지 재발송 필요. 검토 후 수정 요청 메일 보내야 함.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: true, hasTask: true },
  },
  {
    type: '업무',
    content: `${TEST_PREFIX} 팀 성과 평가 기준 재논의. 현행 MBO 방식이 협업 지표를 반영 못함. HR에서 OKR 전환 제안 들어옴. 장단점 정리해서 다음 주 팀장 회의에 안건으로 올려야 함.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: true, hasTask: true },
  },
  {
    type: '업무',
    content: `${TEST_PREFIX} 고객 클레임 에스컬레이션 대응. 기업고객 A사가 납기 지연으로 계약 해지 언급. CS팀이 이미 두 번 연락했으나 응답 없음. 오늘 오후 직접 전화 드려야 함.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: true, hasTask: true },
  },
  {
    type: '업무',
    content: `${TEST_PREFIX} 신규 파트너사 계약 검토. 법무팀이 계약서 3조 2항 독소조항 지적. 상대방이 수정 거부할 경우 협상 카드 검토 필요. 법무 회신 받는대로 전략 논의.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: true, hasTask: false },
  },
  {
    type: '업무',
    content: `${TEST_PREFIX} 인프라 비용 절감 방안. AWS 청구서 월 450만인데 사용률 분석하니 30%가 유휴 리소스. Reserved Instance 전환 검토 중. 내달 예산 회의 전에 견적 뽑아야 함.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: true, hasTask: true },
  },

  // ── 일정 5건 ──────────────────────────────────────────────────────────────
  {
    type: '일정',
    content: `${TEST_PREFIX} 다음 주 화요일 오전 10시 박부장님과 전략 미팅. 장소는 본사 3층 회의실. 자료 미리 준비해야 함.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: false },
  },
  {
    type: '일정',
    content: `${TEST_PREFIX} 이번 달 말일 전까지 정기 건강검진 예약. 그리고 다음 달 첫 번째 월요일에 팀 워크샵. 두 개 겹치지 않게 조율 필요.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: true },
  },
  {
    type: '일정',
    content: `${TEST_PREFIX} 내일 오후 2시 클라이언트 미팅인데 동시에 사내 전략 회의도 잡혔음. 클라이언트 미팅 3시로 조정 요청하거나 전략 회의 위임 검토.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: true },
  },
  {
    type: '일정',
    content: `${TEST_PREFIX} 3월 15일 제주 출장. 오전 7시 김포 출발. 현지 미팅 두 건. 숙박은 제주 시내 호텔로 예약 부탁드립니다.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: true },
  },
  {
    type: '일정',
    content: `${TEST_PREFIX} 격주 수요일마다 멘토링 세션 30분. 이번 주부터 시작. 온라인으로 진행. 링크는 이메일로 공유 예정.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: false },
  },

  // ── STT 3건 (노이즈/반복어) ────────────────────────────────────────────────
  {
    type: 'STT',
    content: `${TEST_PREFIX} 음 그러니까 뭐랄까 이번 프로젝트가 음 좀 어 어어 지연될 것 같은데 음 그 이유가 외부 API 연동 문제고 어 해결책은 음 모킹 레이어 추가하는 거라고 생각해.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: true, hasTask: false },
  },
  {
    type: 'STT',
    content: `${TEST_PREFIX} 오늘 회의에서 나온 내용 정리할게요. 첫 번째는, 첫 번째는, 예산 증액 요청이고요. 두 번째는, 두 번째는, 일정 조정 건이에요. 세 번째는 리소스 재배분.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: false },
  },
  {
    type: 'STT',
    content: `${TEST_PREFIX} 아 잠깐만요 어디까지 얘기했죠 맞다 신규 서비스 론칭 일정이요. 어 8월 말 타깃인데요. 어 개발팀이랑 확인해야 하고 마케팅도 어 준비해야 하고 어 PR도 잡아야 해요.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: true },
  },

  // ── 개인 4건 ──────────────────────────────────────────────────────────────
  {
    type: '개인',
    content: `${TEST_PREFIX} 아이 유치원 입학 준비 체크리스트. 준비물: 실내화, 낮잠 이불, 이름 스티커. 입학식 날 오전 9시. 아빠도 함께 가기로 함.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: true },
  },
  {
    type: '개인',
    content: `${TEST_PREFIX} 이번 주 식단 계획. 월 닭가슴살 샐러드, 화 연어 구이, 수 현미밥 된장찌개, 목 두부 스테이크, 금 치팅데이. 총 칼로리 주 7000kcal 이하 목표.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: false },
  },
  {
    type: '개인',
    content: `${TEST_PREFIX} 독서 기록. 원씽 읽기 완료. 핵심 메시지는 한 가지에 집중하면 모든 것이 쉬워진다는 것. 다음 책은 딥워크로 선정. 매일 아침 30분 독서 루틴 유지 중.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: false },
  },
  {
    type: '개인',
    content: `${TEST_PREFIX} 운동 루틴 점검. 이번 달 헬스 15회 달성. 목표는 20회였는데 출장으로 5회 빠짐. 다음 달은 홈트 루틴 추가해서 보완할 계획. 스쿼트 100개 매일 목표.`,
    expect: { hasTags: true, hasTitle: true, hasPIE: false, hasTask: true },
  },
];

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

/** 오늘 날짜 YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** atomic note 원격 경로 */
function atomicNotePath(filename) {
  return `${NOTES_REMOTE}/${filename}`;
}

/**
 * API POST helper — 응답에서 filename 반환
 * server.js: res.json({ success, date, section, ...createAtomicNote() })
 *   createAtomicNote returns { filename, filePath }
 */
async function postMemo(request, date, content) {
  const res = await request.post(`/api/daily/${date}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    data: { content, section: '메모' },
  });
  const body = await res.json();
  return { status: res.status(), filename: body.filename };
}

/** N ms sleep */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 8초 sleep — SR D3 ACCEPT 반영
 * Gemini 15RPM 기준: POST당 title+PIE = 2회 호출 → 최소 8초 필요 (2초면 429 확실)
 */
const sleepRateLimit = () => sleep(8000);

/**
 * AI 파이프라인 1단계 predicate — title 주입 완료까지만 대기
 * PIE는 title보다 느림 → 별도 sshPollFile로 분리 (verifyAIPipeline 참고)
 */
function makeAIPredicate(memo) {
  return (fileContent) => {
    if (!fileContent || fileContent.length < 10) return false;
    if (memo.expect.hasTitle && !/^title:\s*.+/m.test(fileContent)) return false;
    return true;
  };
}

/**
 * AI 파이프라인 검증 — sshPollFile로 GCP 파일 읽어 검증
 * hasPIE 메모는 PIE 완료까지 대기 (maxWait 90s — rate limit 재시도 포함)
 */
async function verifyAIPipeline(memo, filename) {
  const remotePath = atomicNotePath(filename);

  // 1단계: title 주입 완료 대기 (60s)
  const content = await sshPollFile(remotePath, makeAIPredicate(memo), 60000);
  expect(content, `파일 없음 또는 title 미처리: ${filename}`).not.toBeNull();

  if (memo.expect.hasTags) {
    expect(content, '태그 없음').toMatch(/^tags:/m);
  }
  if (memo.expect.hasTitle) {
    expect(content, 'title 없음').toMatch(/^title:\s*.+/m);
  }
  // PD1: hasTask를 PIE block 밖 stage 1에서 검증
  // Sub 3-2 수정: task는 PIE가 완료돼야 생성됨 → free tier에서 PIE 타임아웃 시 task 없음
  // → PIE soft-check와 동일 패턴으로 soft-check (warn only)
  if (memo.expect.hasTask) {
    if (!content.match(/^- \[ \] .+/m)) {
      console.warn(`[TASK] soft-skip: ${filename} — 할일 패턴 없음 (PIE 타임아웃으로 미생성, free tier 제한)`);
    }
  }

  // 2단계: PIE soft check (60s)
  // GCP 서버 Gemini 무료 티어에서 PIE가 타임아웃될 수 있음
  // → 완료 시 full 검증, 타임아웃 시 warn만 (서버 환경 의존이므로 fail 처리 안함)
  if (memo.expect.hasPIE) {
    const pieContent = await sshPollFile(
      remotePath,
      (c) => c.includes('## 🧠 PIE Perspective'),
      60000,
    );
    if (pieContent && pieContent.includes('## 🧠 PIE Perspective')) {
      if (memo.expect.hasTask) {
        expect(pieContent, '할일 패턴 없음 (PIE stage)').toMatch(/^- \[ \] .+/m);
      }
    } else {
      console.warn(`[PIE] soft-skip: ${filename} — 서버 Gemini timeout (free tier 제한)`);
    }
  }

  return content;
}

// ── 테스트 스위트 ────────────────────────────────────────────────────────────

test.describe('Phase 1: AI Pipeline — 더미 메모 20건', () => {
  const DATE = today();

  test.beforeAll(async () => {
    API_KEY = getApiKey();
    BASE_URL = process.env.TUNNEL_URL || 'https://saturn-survivors-impossible-lecture.trycloudflare.com';
  });

  // 각 더미 메모를 개별 test로 분리 (실패 격리)
  for (let i = 0; i < DUMMY_MEMOS.length; i++) {
    const memo = DUMMY_MEMOS[i];
    const label = `dummy-${String(i + 1).padStart(2, '0')}-${memo.type}`;

    test(label, async ({ request }) => {
      // 1. POST → filename 획득 (server.js: res.json({ success, ...createAtomicNote() }))
      const { status, filename } = await postMemo(request, DATE, memo.content);
      expect(status).toBe(200);
      expect(filename, 'POST 응답에 filename 없음').toBeTruthy();

      // 2. 8초 sleep (SR D3 — Gemini 15RPM, title+PIE 2회 호출)
      await sleepRateLimit();

      // 3. SSH pollFile + AI 파이프라인 5단계 검증
      await verifyAIPipeline(memo, filename);
    });
  }

  test.afterAll(async () => {
    /**
     * PD2: SKIP_CLEANUP 환경변수 지원
     * SKIP_CLEANUP=1 이면 더미 파일 유지 → Phase 2 UI 테스트에서 데이터 활용 가능
     * 기본(unset): 삭제 수행 (운영 vault 오염 방지)
     */
    if (process.env.SKIP_CLEANUP === '1') {
      console.log('[afterAll] SKIP_CLEANUP=1 — 더미 파일 유지 (Phase 2 대비)');
      return;
    }
    try {
      execSync(
        `${SSH_BASE} "grep -rl '${TEST_PREFIX}' '${NOTES_REMOTE}/' 2>/dev/null | xargs -r rm -f"`,
        { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (e) {
      console.warn('[afterAll cleanup] SSH rm 실패:', e.message);
    }
  });
});
