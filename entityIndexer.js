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
  return path.join(_vaultPath, ENTITY_MAP_SUBDIR, ENTITY_MAP_FILENAME);
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
// Entity Map Merge
// ============================================================
function mergeNerResult(nerResult, sourceFile) {
  const { entities } = nerResult;
  const changed = { persons: [], projects: [], places: [] };

  for (const type of ['persons', 'projects', 'places']) {
    for (const name of (entities[type] || [])) {
      const key = (name || '').trim();
      if (!key) continue;
      if (!_entityMap[type]) _entityMap[type] = {};
      if (!_entityMap[type][key]) {
        _entityMap[type][key] = { sources: [sourceFile], created: new Date().toISOString() };
        changed[type].push(key);
      } else if (!_entityMap[type][key].sources.includes(sourceFile)) {
        _entityMap[type][key].sources.push(sourceFile);
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
        const fm = { type, name: key, tags, related: [], ...extra };
        fs.writeFileSync(fp, matter.stringify(`\n# ${key}\n`, fm), 'utf-8');
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
      const regex = new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`, 'g');
      const newBody = body.replace(regex, `[[${name}]]`);
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

    const files = fs.readdirSync(vvDir).filter(f => f.endsWith('.md'));
    console.log(`[EntityIndexer] Background scan: ${files.length} notes`);

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

  // Non-blocking background full scan
  setImmediate(() => backgroundScan());
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
    const changed = mergeNerResult(nerResult, path.basename(filePath));
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

module.exports = { initEntityIndexer, getEntityMap, indexNote, resyncEntityMap };
