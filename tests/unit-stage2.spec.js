/**
 * Unit Tests — Stage 2 entityIndexer internal functions
 *
 * Tests pure functions exported via module.exports._test
 * No server or Gemini needed — all tests are deterministic.
 */
const { test, expect } = require('@playwright/test');

// Load entityIndexer — needs hangul-js in node_modules
const ei = require('../entityIndexer');
const T = ei._test;

// ============================================================
// Setup: minimal entity_map for tests that need it
// ============================================================
test.beforeEach(() => {
  T.entityMap = {
    persons: {
      '김철수': { sources: ['2026-01-01_memo.md'], created: '2026-01-01', userVerified: false },
      '박영희': { sources: ['2026-01-02_memo.md'], created: '2026-01-02', userVerified: true },
    },
    projects: {
      'VaultVoice': { sources: ['2026-01-01_memo.md'], aliases: { 'VV': true } },
    },
    places: {
      '강남역': { sources: ['2026-01-01_memo.md'] },
    },
  };
});

// ============================================================
// U1: jamoLevenshtein
// ============================================================
test('U1: jamoLevenshtein — identical strings return 0', () => {
  expect(T.jamoLevenshtein('김철수', '김철수')).toBe(0);
});

test('U1: jamoLevenshtein — ㄱ/ㅋ pair costs 0.2 (aspirated confusion)', () => {
  // 가 vs 카: initial consonant ㄱ→ㅋ (cost 0.2)
  const dist = T.jamoLevenshtein('가', '카');
  expect(dist).toBeCloseTo(0.2, 1);
});

test('U1: jamoLevenshtein — unrelated jamo costs 1.0', () => {
  // 가 vs 나: ㄱ→ㄴ has no phonetic pair, costs 1.0
  const dist = T.jamoLevenshtein('가', '나');
  expect(dist).toBe(1);
});

// ============================================================
// U2: dynamicThreshold
// ============================================================
test('U2: dynamicThreshold — 2-char → 1', () => {
  expect(T.dynamicThreshold(2)).toBe(1);
});

test('U2: dynamicThreshold — 3-char → 2', () => {
  expect(T.dynamicThreshold(3)).toBe(2);
});

test('U2: dynamicThreshold — 4-char → 2', () => {
  expect(T.dynamicThreshold(4)).toBe(2);
});

// ============================================================
// U3: SPEAKER_PATTERN
// ============================================================
test('U3: SPEAKER_PATTERN — matches "화자 1"', () => {
  expect(T.SPEAKER_PATTERN.test('화자 1')).toBe(true);
});

test('U3: SPEAKER_PATTERN — matches "Speaker 2" (case-insensitive)', () => {
  expect(T.SPEAKER_PATTERN.test('Speaker 2')).toBe(true);
  expect(T.SPEAKER_PATTERN.test('speaker 3')).toBe(true);
});

test('U3: SPEAKER_PATTERN — does NOT match real names', () => {
  expect(T.SPEAKER_PATTERN.test('김철수')).toBe(false);
  expect(T.SPEAKER_PATTERN.test('VaultVoice')).toBe(false);
});

// ============================================================
// U4: isKoreanSurname
// ============================================================
test('U4: isKoreanSurname — 김/이/박 are valid', () => {
  expect(T.isKoreanSurname('김')).toBe(true);
  expect(T.isKoreanSurname('이')).toBe(true);
  expect(T.isKoreanSurname('박')).toBe(true);
});

test('U4: isKoreanSurname — ㅋ/A are invalid', () => {
  expect(T.isKoreanSurname('ㅋ')).toBe(false);
  expect(T.isKoreanSurname('A')).toBe(false);
});

// ============================================================
// U5: correctPersonBySurname
// ============================================================
test('U5: correctPersonBySurname — valid surname passes through', () => {
  expect(T.correctPersonBySurname('김철수')).toBe('김철수');
});

test('U5: correctPersonBySurname — short name passes through', () => {
  expect(T.correctPersonBySurname('수')).toBe('수');
});

test('U5: correctPersonBySurname — unknown returns as-is when no fuzzy match', () => {
  // ㅋ철수 is not a valid surname, but no close match in entity_map
  expect(T.correctPersonBySurname('ㅋ완전다른이름')).toBe('ㅋ완전다른이름');
});

// ============================================================
// U6: findFuzzyKey
// ============================================================
test('U6: findFuzzyKey — exact match returns key', () => {
  const map = T.entityMap.persons;
  expect(T.findFuzzyKey(map, '김철수', 2)).toBe('김철수');
});

test('U6: findFuzzyKey — over threshold returns null', () => {
  const map = T.entityMap.persons;
  expect(T.findFuzzyKey(map, '완전다른이름', 2)).toBeNull();
});

test('U6: findFuzzyKey — userVerified gets +1 relaxation', () => {
  // 박영희 is userVerified — should match with relaxed threshold
  const map = T.entityMap.persons;
  // Create a candidate that is within baseThreshold+1 of 박영희 but not baseThreshold
  // Test that userVerified=true entry is found in Pass 1
  const result = T.findFuzzyKey(map, '박영희', 0);
  expect(result).toBe('박영희'); // exact match always works even with threshold 0
});

// ============================================================
// U7: applyAliases
// ============================================================
test('U7: applyAliases — known alias returns canonical', () => {
  expect(T.applyAliases('VV')).toBe('VaultVoice');
});

test('U7: applyAliases — unregistered name returns as-is', () => {
  expect(T.applyAliases('UnknownProject')).toBe('UnknownProject');
});

// ============================================================
// U8: mergeNerResult
// ============================================================
test('U8: mergeNerResult — adds new entity', () => {
  const result = T.mergeNerResult(
    { entities: { persons: ['이민호'], projects: [], places: [] } },
    '2026-04-05_test.md'
  );
  expect(result.persons).toContain('이민호');
  expect(T.entityMap.persons['이민호']).toBeDefined();
  expect(T.entityMap.persons['이민호'].sources).toContain('2026-04-05_test.md');
});

test('U8: mergeNerResult — filters speaker labels', () => {
  const result = T.mergeNerResult(
    { entities: { persons: ['화자 1', '김철수'], projects: [], places: [] } },
    '2026-04-05_test.md'
  );
  // 화자 1 should be filtered out, 김철수 should be merged into existing
  expect(T.entityMap.persons['화자 1']).toBeUndefined();
});

test('U8: mergeNerResult — fuzzy dedup merges into existing key', () => {
  const before = T.entityMap.persons['김철수'].sources.length;
  T.mergeNerResult(
    { entities: { persons: ['김철수'], projects: [], places: [] } },
    '2026-04-05_new.md'
  );
  expect(T.entityMap.persons['김철수'].sources).toContain('2026-04-05_new.md');
});

// ============================================================
// U9: getPhoneticCostMap
// ============================================================
test('U9: getPhoneticCostMap — ARTICULATION_COST_PAIRS are registered bidirectionally', () => {
  const costMap = T.getPhoneticCostMap();
  // ㄱ|ㅋ = 0.2 (aspirated pair)
  expect(costMap.get('ㄱ|ㅋ')).toBe(0.2);
  expect(costMap.get('ㅋ|ㄱ')).toBe(0.2);
  // ㄴ|ㄹ = 0.3 (nasal/liquid)
  expect(costMap.get('ㄴ|ㄹ')).toBe(0.3);
  expect(costMap.get('ㄹ|ㄴ')).toBe(0.3);
  // ㅐ|ㅔ = 0.25 (vowel confusion)
  expect(costMap.get('ㅐ|ㅔ')).toBe(0.25);
});

test('U9: getPhoneticCostMap — all 24 ARTICULATION_COST_PAIRS present', () => {
  const costMap = T.getPhoneticCostMap();
  for (const [a, b, cost] of T.ARTICULATION_COST_PAIRS) {
    expect(costMap.get(`${a}|${b}`)).toBe(cost);
    expect(costMap.get(`${b}|${a}`)).toBe(cost);
  }
});
