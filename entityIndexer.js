'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

// ============================================================
// State
// ============================================================
let _vaultPath = null;
let _entityMap = { persons: {}, projects: {}, places: {}, last_updated: null };
let _entityMapReady = false;
let _geminiApiKey = '';
let _geminiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';

const ENTITY_MAP_SUBDIR = '.vaultvoice';
const ENTITY_MAP_FILENAME = 'entity_map.json';
const NER_MODEL = 'gemini-2.5-flash';
const MAX_RETRY = 3;

// ============================================================
// Disk Cache Helpers
// ============================================================
function getEntityMapPath() {
  return path.join(__dirname, ENTITY_MAP_SUBDIR, ENTITY_MAP_FILENAME);
}

function loadEntityMapFromDisk() {
  try {
    const mapPath = getEntityMapPath();
    if (fs.existsSync(mapPath)) {
      return JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
    }
  } catch (e) {
    console.warn('[EntityIndexer] Failed to load entity_map.json:', e.message);
  }
  return { persons: {}, projects: {}, places: {}, last_updated: null };
}

function saveEntityMapToDisk() {
  try {
    const mapPath = getEntityMapPath();
    const dir = path.dirname(mapPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _entityMap.last_updated = new Date().toISOString();
    fs.writeFileSync(mapPath, JSON.stringify(_entityMap, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[EntityIndexer] Failed to save entity_map.json:', e.message);
  }
}

// ============================================================
// NER Helpers (Sub 1-3)
// ============================================================
// Strip AI-appended sections so NER receives original body only
function stripAiSections(body) {
  return body
    .replace(/\n##\s+🧠[\s\S]*$/, '')
    .replace(/\n##\s+⚠️[\s\S]*$/, '')
    .trim();
}

function buildNerPrompt(content, existingMap) {
  const existingHints = [
    ...Object.keys(existingMap.persons  || {}),
    ...Object.keys(existingMap.projects || {}),
    ...Object.keys(existingMap.places   || {})
  ].slice(0, 30).join(', ');

  return `다음 메모에서 개체명을 추출하라. 동일 인물/프로젝트/장소는 정규화된 단일 표기로 반환하라 (예: "박 차장님"/"박차장"/"차장님" → "박 차장님").
기존 엔티티 참고 (중복 방지): ${existingHints || '없음'}

메모:
${content}

JSON 형식으로만 응답하라:
{
  "entities": {
    "persons":  ["이름1", "이름2"],
    "projects": ["프로젝트1"],
    "places":   ["장소1"]
  },
  "cross_links": [
    { "from": "프로젝트명", "relation": "담당자", "to": "이름" }
  ]
}`;
}

async function callGeminiNer(content) {
  const url = `${_geminiBaseUrl}/models/${NER_MODEL}:generateContent?key=${_geminiApiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: buildNerPrompt(content, _entityMap) }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
  });

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = JSON.parse(text);
      if (parsed?.entities) return parsed;
      throw new Error('Invalid NER shape');
    } catch (e) {
      if (attempt < MAX_RETRY - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
      } else {
        console.warn('[EntityIndexer] NER failed after retries:', e.message);
      }
    }
  }
  return { entities: { persons: [], projects: [], places: [] }, cross_links: [] };
}

// ============================================================
// Fuzzy matching helpers (hangul-js Jamo-aware)
// ============================================================
let _Hangul;
try { _Hangul = require('hangul-js'); } catch (e) {}

// Sub 1-5/1-6: Load name-rules for phonetic weights + surname validation
let _nameRules = null;
let _phoneticCostMap = null; // MUST FIX: module-level cache (not per-call)
function getNameRules() {
  if (_nameRules) return _nameRules;
  try {
    const rulesPath = path.join(__dirname, 'name-rules.json');
    _nameRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
  } catch (e) {
    _nameRules = { surnames: [], phonetic_pairs: [], common_syllables: [] };
  }
  return _nameRules;
}

// SR Directive 1: Articulation-position-based cost matrix (replaces flat cost=0.3)
// Costs represent phonetic similarity: lower = more confusable by STT
// Grouped by articulation position / manner
const ARTICULATION_COST_PAIRS = [
  // Aspirated/tense/lax triples — most common STT confusion (cost 0.2)
  ['ㄱ','ㅋ',0.2], ['ㄱ','ㄲ',0.2], ['ㅋ','ㄲ',0.2],
  ['ㄷ','ㅌ',0.2], ['ㄷ','ㄸ',0.2], ['ㅌ','ㄸ',0.2],
  ['ㅂ','ㅍ',0.2], ['ㅂ','ㅃ',0.2], ['ㅍ','ㅃ',0.2],
  ['ㅈ','ㅊ',0.2], ['ㅈ','ㅉ',0.2], ['ㅊ','ㅉ',0.2],
  ['ㅅ','ㅆ',0.2],
  // Coda neutralization: ㄱ/ㄷ/ㅂ all become ㄱ-coda sound (cost 0.3)
  ['ㄱ','ㄷ',0.3], ['ㄱ','ㅂ',0.3], ['ㄷ','ㅂ',0.3],
  // Nasal/liquid — very common Korean STT error (cost 0.3)
  ['ㄴ','ㄹ',0.3], ['ㄴ','ㅁ',0.4], ['ㄹ','ㅁ',0.4],
  // Vowel confusion (cost 0.25)
  ['ㅐ','ㅔ',0.25], ['ㅒ','ㅖ',0.25], ['ㅓ','ㅗ',0.35],
  ['ㅏ','ㅑ',0.4], ['ㅜ','ㅡ',0.35], ['ㅣ','ㅢ',0.4],
  // Laryngeal (cost 0.4)
  ['ㅇ','ㅎ',0.4]
];

// Build phonetic cost map once at module level
function getPhoneticCostMap() {
  if (_phoneticCostMap) return _phoneticCostMap;
  _phoneticCostMap = new Map();
  // Load from name-rules.json phonetic_pairs as baseline (cost 0.3)
  for (const [a, b] of (getNameRules().phonetic_pairs || [])) {
    _phoneticCostMap.set(`${a}|${b}`, 0.3);
    _phoneticCostMap.set(`${b}|${a}`, 0.3);
  }
  // SR Directive 1: override with articulation-based costs
  for (const [a, b, cost] of ARTICULATION_COST_PAIRS) {
    _phoneticCostMap.set(`${a}|${b}`, cost);
    _phoneticCostMap.set(`${b}|${a}`, cost);
  }
  return _phoneticCostMap;
}

// SR Directive 2: Length-proportional threshold (replaces hardcoded 2)
// 2-char names: threshold 1 (strict — too many false positives otherwise)
// 3-char names: threshold 2 (standard)
// 4+ char names: threshold 2 (names rarely exceed 4 chars in Korean)
function dynamicThreshold(nameLength) {
  if (nameLength <= 2) return 1;
  if (nameLength === 3) return 2;
  return 2;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function toJamo(str) {
  if (!_Hangul) return str;
  try { return _Hangul.disassemble(str).join(''); } catch (e) { return str; }
}

// Sub 1-6: Weighted jamo Levenshtein — phonetically similar jamo pairs cost 0.3 instead of 1
function jamoLevenshtein(a, b) {
  const jamoA = toJamo(a);
  const jamoB = toJamo(b);
  const costMap = getPhoneticCostMap();

  const m = jamoA.length, n = jamoB.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (jamoA[i - 1] === jamoB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        const substituteCost = costMap.get(`${jamoA[i-1]}|${jamoB[j-1]}`) ?? 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + substituteCost
        );
      }
    }
  }
  return dp[m][n];
}

// Sub 1-7: Surname validation — check if first char is a known Korean surname
function isKoreanSurname(char) {
  return getNameRules().surnames.includes(char);
}

// Sub 1-7: If NER extracted a person name whose first syllable is NOT a valid surname,
// attempt fuzzy correction against entity_map persons
function correctPersonBySurname(name) {
  if (!name || name.length < 2) return name;
  const firstChar = name[0];
  if (isKoreanSurname(firstChar)) return name; // surname valid, no correction needed

  // Try fuzzy match against known persons — if close match found, return it
  const personMap = _entityMap.persons || {};
  const matched = findFuzzyKey(personMap, name, 2);
  if (matched) {
    console.log(`[EntityIndexer] Surname correction: "${name}" → "${matched}"`);
    return matched;
  }
  return name; // no better candidate found
}

// Find existing key within Jamo Levenshtein distance ≤ threshold; returns key or null
// SR Directive 2: apply length-proportional threshold; userVerified entries get +1 relaxation
function findFuzzyKey(map, candidate, threshold = null) {
  // SR Directive 2: use dynamic threshold if none provided
  const baseThreshold = threshold !== null ? threshold : dynamicThreshold(candidate.length);
  // Pass 1: userVerified entries with relaxed threshold (+1)
  for (const existing of Object.keys(map)) {
    if (map[existing].userVerified && jamoLevenshtein(candidate, existing) <= baseThreshold + 1) return existing;
  }
  // Pass 2: all entries with base threshold
  for (const existing of Object.keys(map)) {
    if (jamoLevenshtein(candidate, existing) <= baseThreshold) return existing;
  }
  return null;
}

// Apply aliases substitution to a name using entity_map aliases across all types
function applyAliases(name) {
  for (const type of ['persons', 'projects', 'places']) {
    const typeMap = _entityMap[type] || {};
    for (const [canonical, entry] of Object.entries(typeMap)) {
      const aliases = entry.aliases || {};
      if (aliases[name]) return canonical;
    }
  }
  return name;
}

// ============================================================
// Sub 1-8: Place name correction via Gemini Flash
// ============================================================
async function correctPlaceWithGemini(placeName) {
  if (!_geminiApiKey || _geminiApiKey === 'your_key_here') return placeName;
  const url = `${_geminiBaseUrl}/models/gemini-2.5-flash:generateContent?key=${_geminiApiKey}`;
  const prompt = `다음 장소명이 실존 지명인지 판단하고, 음성인식 오류로 잘못된 경우 올바른 지명을 반환하라.
장소명: "${placeName}"
JSON 형식으로만 응답하라: {"is_valid": true/false, "corrected": "올바른 지명 또는 원본"}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    });
    if (!res.ok) {
      console.warn(`[EntityIndexer] Place correction HTTP ${res.status} for "${placeName}"`);
      if (res.status === 429) await new Promise(r => setTimeout(r, 2000));
      return placeName;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      console.warn(`[EntityIndexer] Place correction JSON parse failed for "${placeName}":`, parseErr.message);
      return placeName;
    }
    if (parsed?.is_valid === true) return placeName;
    if (parsed?.is_valid === false) {
      const corrected = (parsed?.corrected || '').trim() || placeName;
      if (corrected !== placeName) {
        console.log(`[EntityIndexer] Place correction: "${placeName}" → "${corrected}"`);
      }
      return corrected;
    }
    return placeName; // unexpected shape (missing is_valid field)
  } catch (e) {
    console.warn(`[EntityIndexer] Place Gemini correction failed for "${placeName}":`, e.message);
    return placeName;
  }
}

// ============================================================
// Entity Map Merge
// ============================================================
const SPEAKER_PATTERN = /^(화자|Speaker)\s*\d+$/i;

function mergeNerResult(nerResult, sourceFile) {
  const { entities } = nerResult;
  const changed = { persons: [], projects: [], places: [] };

  for (const type of ['persons', 'projects', 'places']) {
    for (const name of (entities[type] || [])) {
      const rawKey = (name || '').trim();
      if (!rawKey) continue;
      if (type === 'persons' && SPEAKER_PATTERN.test(rawKey)) continue;
      // Sub 1-7: surname validation + fuzzy correction for persons
      const correctedKey = type === 'persons' ? correctPersonBySurname(rawKey) : rawKey;
      const key = applyAliases(correctedKey);
      if (!_entityMap[type]) _entityMap[type] = {};
      // Fuzzy dedup: only apply to persons (typos/nicknames common there)
      const fuzzyThreshold = type === 'persons' ? 2 : 0;
      const existingKey = fuzzyThreshold > 0
        ? findFuzzyKey(_entityMap[type], key, fuzzyThreshold)
        : (_entityMap[type][key] ? key : null);
      if (existingKey) {
        // Merge into existing canonical key
        const entry = _entityMap[type][existingKey];
        if (!entry.sources.includes(sourceFile)) {
          entry.sources.push(sourceFile);
          // CRM fields: update lastContact + interactionCount for persons only
          if (type === 'persons') {
            const fileDate = (sourceFile.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
            if (fileDate && (!entry.lastContact || fileDate > entry.lastContact)) {
              entry.lastContact = fileDate;
            }
            entry.interactionCount = (entry.interactionCount || 0) + 1;
          }
        }
        if (existingKey !== key) {
          console.log(`[EntityIndexer] Fuzzy merge: "${key}" → "${existingKey}" (distance=${levenshtein(key, existingKey)})`);
        }
      } else {
        const fileDate = type === 'persons' ? ((sourceFile.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '') : undefined;
        const entry = { sources: [sourceFile], created: new Date().toISOString() };
        if (type === 'persons') { entry.lastContact = fileDate; entry.interactionCount = 1; }
        _entityMap[type][key] = entry;
        changed[type].push(key);
      }
    }
  }
  return changed;
}

// ============================================================
// Sub 1-5: Entity Notes + Cross Links + WikiLink substitution
// ============================================================
const ENTITY_NOTE_DIR = '99_vaultvoice';

function entityNoteFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_') + '.md';
}

function createEntityNotes(nerResult) {
  if (!_vaultPath) return;
  const vvDir = path.join(_vaultPath, ENTITY_NOTE_DIR);
  if (!fs.existsSync(vvDir)) return;

  const specs = [
    { type: 'person',  keys: nerResult.entities.persons  || [], tags: ['person'],  extra: { role: '' } },
    { type: 'project', keys: nerResult.entities.projects || [], tags: ['project'], extra: { status: 'active' } },
    { type: 'place',   keys: nerResult.entities.places   || [], tags: ['place'],   extra: {} }
  ];

  for (const { type, keys, tags, extra } of specs) {
    for (const name of keys) {
      const key = (name || '').trim();
      if (!key) continue;
      const fp = path.join(vvDir, entityNoteFilename(key));
      if (fs.existsSync(fp)) continue; // skip if exists — SR 지시
      try {
        const fm = { type, name: key, aliases: [key], tags, related: [], ...extra };
        let body = `\n# ${key}\n`;
        if (type === 'person') {
          body += `\n## 상호작용 타임라인\n\n\`\`\`dataview\nTABLE 날짜, summary\nFROM #crm/interaction\nWHERE contains(attendees, "[[${key}]]")\nSORT 날짜 DESC\n\`\`\`\n`;
        }
        fs.writeFileSync(fp, matter.stringify(body, fm), 'utf-8');
        console.log(`[EntityIndexer] Created entity note: ${entityNoteFilename(key)}`);
      } catch (e) {
        console.warn(`[EntityIndexer] Failed to create entity note ${key}:`, e.message);
      }
    }
  }
}

function addToRelated(filePath, wikiLink) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const file = matter(raw);
    if (!Array.isArray(file.data.related)) file.data.related = [];
    if (file.data.related.includes(wikiLink)) return;
    file.data.related.push(wikiLink);
    fs.writeFileSync(filePath, matter.stringify(file.content, file.data), 'utf-8');
  } catch (e) {
    console.warn('[EntityIndexer] addToRelated failed:', e.message);
  }
}

function applyRelatedFrontmatter(crossLinks) {
  if (!_vaultPath || !crossLinks || !crossLinks.length) return;
  const vvDir = path.join(_vaultPath, ENTITY_NOTE_DIR);
  for (const { from, to } of crossLinks) {
    if (!from || !to) continue;
    const fromFp = path.join(vvDir, entityNoteFilename(from));
    const toFp   = path.join(vvDir, entityNoteFilename(to));
    if (fs.existsSync(fromFp)) addToRelated(fromFp, `[[${to}]]`);
    if (fs.existsSync(toFp))   addToRelated(toFp,   `[[${from}]]`);
  }
}

function applyWikiLinksToFile(noteFilePath, entities) {
  try {
    const raw = fs.readFileSync(noteFilePath, 'utf-8');
    const file = matter(raw);
    let body = file.content;

    const allNames = [
      ...(entities.persons  || []),
      ...(entities.projects || []),
      ...(entities.places   || [])
    ].filter(n => n && n.length >= 2);

    let changed = false;
    for (const name of allNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // split-token: [[...]] 구간은 건드리지 않고, 나머지 텍스트에만 치환 적용
      const parts = body.split(/(\[\[[^\]]*?\]\])/g);
      const newBody = parts.map((part, i) => {
        if (i % 2 === 1) return part; // [[...]] 토큰 — 그대로 유지
        return part.replace(new RegExp(escaped, 'g'), `[[${name}]]`);
      }).join('');
      if (newBody !== body) { body = newBody; changed = true; }
    }

    if (changed) {
      fs.writeFileSync(noteFilePath, matter.stringify(body, file.data), 'utf-8');
    }
  } catch (e) {
    console.warn('[EntityIndexer] applyWikiLinksToFile failed:', e.message);
  }
}

// ============================================================
// Background Vault Scan (chokidar 미사용 — gcsfuse inotify 유실)
// ============================================================
async function backgroundScan() {
  try {
    const vvDir = path.join(_vaultPath, '99_vaultvoice');
    if (!fs.existsSync(vvDir)) { _entityMapReady = true; return; }

    const lastUpdated = _entityMap.last_updated ? new Date(_entityMap.last_updated).getTime() : 0;
    const allFiles = fs.readdirSync(vvDir).filter(f => f.endsWith('.md'));
    const files = lastUpdated > 0
      ? allFiles.filter(f => { try { return fs.statSync(path.join(vvDir, f)).mtimeMs > lastUpdated; } catch { return true; } })
      : allFiles;
    console.log(`[EntityIndexer] Background scan: ${files.length}/${allFiles.length} notes (incremental)`);

    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(vvDir, f), 'utf-8');
        const { content } = matter(raw);
        const body = stripAiSections(content);
        if (body.length < 20) continue;
        if (_geminiApiKey && _geminiApiKey !== 'your_key_here') {
          const ner = await callGeminiNer(body);
          mergeNerResult(ner, f);
          await new Promise(r => setTimeout(r, 200)); // rate-limit buffer
        }
      } catch (e) {
        console.warn(`[EntityIndexer] Scan skip ${f}:`, e.message);
      }
    }

    saveEntityMapToDisk();
  } catch (e) {
    console.warn('[EntityIndexer] Background scan error:', e.message);
  } finally {
    _entityMapReady = true;
    console.log('[EntityIndexer] entity_map_ready = true');
  }
}

// ============================================================
// Public API
// ============================================================
function initEntityIndexer(vaultPath, options = {}) {
  _vaultPath = vaultPath;
  _geminiApiKey   = options.geminiApiKey   || process.env.GEMINI_API_KEY   || '';
  _geminiBaseUrl  = options.geminiBaseUrl  || process.env.GEMINI_BASE_URL  ||
    'https://generativelanguage.googleapis.com/v1beta';

  // Fast recovery from disk cache on restart
  _entityMap = loadEntityMapFromDisk();
  if (_entityMap.last_updated) {
    _entityMapReady = true;
    console.log('[EntityIndexer] Loaded from disk cache. Ready.');
  }

  // Non-blocking background full scan — skip if cache is fresh (< 6h)
  const cacheAge = _entityMap.last_updated
    ? Date.now() - new Date(_entityMap.last_updated).getTime()
    : Infinity;
  if (cacheAge > 6 * 3600 * 1000) {
    setImmediate(() => backgroundScan());
  } else {
    _entityMapReady = true;
    console.log('[EntityIndexer] Cache fresh — skipping full scan.');
  }
}

function getEntityMap() {
  return _entityMapReady ? _entityMap : null;
}

// rawContent: original body captured at createAtomicNote time (no file re-read)
async function indexNote(filePath, rawContent) {
  if (!_entityMapReady) return null;
  if (!_geminiApiKey || _geminiApiKey === 'your_key_here') return null;

  const body = stripAiSections(rawContent);
  if (!body || body.length < 20) return null;

  try {
    const nerResult = await callGeminiNer(body);
    // Sub 1-8: correct new place names via Gemini fallback (skip if already in entity_map)
    const rawPlaces = nerResult.entities.places || [];
    const correctedPlaces = [];
    const placeAliasMap = {}; // { corrected: originalName } for alias accumulation after merge
    for (const place of rawPlaces) {
      const trimmed = (place || '').trim();
      if (!trimmed) continue;
      const existingKey = findFuzzyKey(_entityMap.places || {}, trimmed, 2);
      if (existingKey) {
        correctedPlaces.push(trimmed); // already known — no Gemini call
      } else {
        const corrected = await correctPlaceWithGemini(trimmed);
        correctedPlaces.push(corrected);
        if (corrected !== trimmed) placeAliasMap[corrected] = trimmed;
      }
    }
    nerResult.entities.places = correctedPlaces;

    const changed = mergeNerResult(nerResult, path.basename(filePath));
    // Sub 1-8 CRITICAL FIX: accumulate aliases AFTER mergeNerResult has created canonical entries
    for (const [corrected, original] of Object.entries(placeAliasMap)) {
      if (_entityMap.places && _entityMap.places[corrected]) {
        _entityMap.places[corrected].aliases = _entityMap.places[corrected].aliases || {};
        _entityMap.places[corrected].aliases[original] = true;
      }
    }
    saveEntityMapToDisk();
    // Sub 1-5: entity notes → cross links → WikiLinks
    createEntityNotes(nerResult);
    applyRelatedFrontmatter(nerResult.cross_links || []);
    applyWikiLinksToFile(filePath, nerResult.entities);
    return { nerResult, changed };
  } catch (e) {
    console.warn('[EntityIndexer] indexNote error:', e.message);
    return null;
  }
}

async function resyncEntityMap() {
  if (!_vaultPath) return { status: 'error', message: 'not initialized' };
  _entityMapReady = false;
  _entityMap = { persons: {}, projects: {}, places: {}, last_updated: null };
  await backgroundScan();
  return {
    status: 'ok',
    counts: {
      persons:  Object.keys(_entityMap.persons  || {}).length,
      projects: Object.keys(_entityMap.projects || {}).length,
      places:   Object.keys(_entityMap.places   || {}).length
    }
  };
}

module.exports = { initEntityIndexer, getEntityMap, indexNote, resyncEntityMap, saveEntityMapToDisk };

// Test-only exports — internal functions for unit testing
module.exports._test = {
  jamoLevenshtein, dynamicThreshold, isKoreanSurname, correctPersonBySurname,
  findFuzzyKey, applyAliases, mergeNerResult, getPhoneticCostMap,
  SPEAKER_PATTERN, ARTICULATION_COST_PAIRS,
  get entityMap() { return _entityMap; },
  set entityMap(v) { _entityMap = v; },
};
