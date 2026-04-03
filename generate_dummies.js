const fs = require('fs');
const path = require('path');

const VAULT_DIR = path.join(__dirname, 'test-vault', '99_vaultvoice');

// 폴더가 없으면 생성
if (!fs.existsSync(VAULT_DIR)) {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
}

// 1. 시나리오 복선(Context)을 위한 핵심 메모들
const coreMemos = [
  {
    filename: '2026-03-10_100000_memo.md',
    date: '2026-03-10',
    category: '업무',
    topic: ['김이사', '보고서', '선호도'],
    body: '## 🧠 PIE Perspective\n(과거 기록) 김 이사님은 장황한 서술을 극도로 혐오하심. 무조건 3줄 요약(Executive Summary)이 장표 맨 앞에 와야 하며, 숫자는 % 기호와 함께 증감 여부만 굵게 표시할 것.'
  },
  {
    filename: '2026-03-25_143000_memo.md',
    date: '2026-03-25',
    category: '회의',
    topic: ['채용', 'HR', '예산'],
    body: '오늘 HR 및 재무 통합 회의 결과, Q2 신규 채용은 전면 중단하기로 결정함. 현재 인력 리소스를 최적화하여 버티는 방향으로 확정.'
  },
  {
    filename: '2026-03-28_220000_memo.md',
    date: '2026-03-28',
    category: '개인',
    topic: ['게임', '발더스게이트3', '전략'],
    body: '발더스 게이트 3 플레이 메모: 주문 슬롯(Spell Slot) 등 주요 리소스는 긴 휴식 전까지 한정되어 있다. 따라서 잡몹전에서는 캔트립 위주로 아끼고, 보스전에서 모든 리소스를 폭발시키는 "선택과 집중"이 필수적이다.'
  },
  {
    filename: '2026-04-01_183000_memo.md',
    date: '2026-04-01',
    category: '육아',
    topic: ['식단', '아이', '건강'],
    body: '아이가 요즘 매운 것을 전혀 못 먹음. 어제 살짝 매콤한 떡볶이 먹고 배탈남. 당분간 맵지 않은 간장 베이스나 생선구이, 맑은 국 위주로 먹여야 함.'
  },
  {
    filename: '2026-03-15_090000_memo.md',
    date: '2026-03-15',
    category: '업무',
    topic: ['마진율', 'CM1', '목표'],
    body: '전사 타운홀 미팅. 올해 핵심 KPI는 외형 성장(GMV)보다 수익성 개선임. 특히 CM1 15% 방어는 어떤 프로젝트에서도 양보할 수 없는 마지노선임.'
  }
];

// 2. 노이즈 생성을 위한 일반 메모들 (25개)
const noiseMemos = [];
for (let i = 1; i <= 25; i++) {
  const day = String(i).padStart(2, '0');
  noiseMemos.push({
    filename: `2026-03-${day}_110000_memo.md`,
    date: `2026-03-${day}`,
    category: i % 3 === 0 ? '개인' : '업무',
    topic: ['일상', `노이즈${i}`],
    body: `이것은 ${i}번째 일상적인 기록입니다. 오늘 커피를 마셨고, 뉴스 기사를 하나 스크랩했습니다. 업무 마감이 다가오고 있습니다.`
  });
}

const allMemos = [...coreMemos, ...noiseMemos];

// 파일 생성 로직
allMemos.forEach(memo => {
  const content = `---
날짜: ${memo.date}
시간: "12:00:00"
source_type: memo
유형: memo
category: "${memo.category}"
status: "archived"
tags:
  - vaultvoice
topic:
${memo.topic.map(t => `  - ${t}`).join('\n')}
summary: "과거 기록 시뮬레이션 데이터"
---

${memo.body}
`;
  
  fs.writeFileSync(path.join(VAULT_DIR, memo.filename), content, 'utf-8');
});

console.log(`[Supervisor] 총 ${allMemos.length}개의 E2E 실전 더미 메모가 생성되었습니다.`);
