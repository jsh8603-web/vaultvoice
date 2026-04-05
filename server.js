if (!process.env.DOTENV_LOADED) require('dotenv').config({ override: true });
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

// Optional AI SDKs (graceful degradation if not installed)
let GoogleGenerativeAI, GoogleAIFileManager, OpenAI;
try {
  ({ GoogleGenerativeAI } = require('@google/generative-ai'));
  ({ GoogleAIFileManager } = require('@google/generative-ai/server'));
} catch (e) { console.warn('[Audio] Gemini SDK not installed:', e.message); }
try {
  ({ default: OpenAI } = require('openai'));
} catch (e) { console.warn('[Audio] OpenAI SDK not installed:', e.message); }

// YAML/Frontmatter parsing (gray-matter + js-yaml replaces custom parseFrontmatter)
const matter = require('gray-matter');
const yaml = require('js-yaml');

// Pipeline queue (p-queue v7 CJS) — filePath-scoped serialization
const PQueue = require('p-queue').default;

// Entity Indexer — F5 module
const { initEntityIndexer, getEntityMap, indexNote, resyncEntityMap } = require('./entityIndexer');

// NoteCache — in-memory TTL cache for date notes, tag counts, file lists
const noteCache = require('./noteCache');

// Web Push + Scheduler (F7)
let webpush, schedule;
try { webpush  = require('web-push');     } catch (e) { console.warn('[Push] web-push not installed:', e.message); }
try { schedule = require('node-schedule'); } catch (e) { console.warn('[Push] node-schedule not installed:', e.message); }

// Optional URL processing libs (graceful degradation)
let Readability, JSDOM, getSubtitles;
try {
  ({ Readability } = require('@mozilla/readability'));
  ({ JSDOM } = require('jsdom'));
} catch (e) { console.warn('[URL] readability/jsdom not installed:', e.message); }
try {
  ({ getSubtitles } = require('youtube-captions-scraper'));
} catch (e) { console.warn('[URL] youtube-captions-scraper not installed:', e.message); }

const app = express();
const PORT = process.env.PORT || 3939;
const VAULT_PATH = process.env.VAULT_PATH;
const VAULT_NAME = process.env.VAULT_NAME || '';
const API_KEY = process.env.API_KEY;

// Build an obsidian:// deep-link URI for a given filename (relative to vault root)
function buildObsidianURI(filename) {
  if (!VAULT_NAME) return null;
  const clean = String(filename).replace(/^\/+/, '');
  return `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(clean)}`;
}

// All VaultVoice files go under 99_vaultvoice/ (staging inbox)
const VV_BASE = '99_vaultvoice';
// Atomic notes live flat in VV_BASE (no daily-notes subfolder)
const NOTES_DIR = path.join(VAULT_PATH, VV_BASE);
// Legacy alias kept for backward-compat references inside this file
const DAILY_DIR = NOTES_DIR;
// F7 Step 8: Daily Note embed opt-in
const DAILY_NOTE_EMBED = process.env.DAILY_NOTE_EMBED === 'true';
const DAILY_NOTE_PATH  = process.env.DAILY_NOTE_PATH ? path.join(VAULT_PATH, process.env.DAILY_NOTE_PATH) : null;
// New asset directories
const AUDIO_DIR_NAME = VV_BASE + '/assets/audio';
const IMAGES_DIR_NAME = VV_BASE + '/assets/images';
const AUDIO_DIR = path.join(VAULT_PATH, AUDIO_DIR_NAME);
const IMAGES_DIR = path.join(VAULT_PATH, IMAGES_DIR_NAME);

const MEDIA_DIRS = {
  audio: { name: AUDIO_DIR_NAME, path: AUDIO_DIR },
  image: { name: IMAGES_DIR_NAME, path: IMAGES_DIR },
  // Legacy upload types — route to new dirs for backward compat
  photo: { name: IMAGES_DIR_NAME, path: IMAGES_DIR },
  screenshot: { name: IMAGES_DIR_NAME, path: IMAGES_DIR },
  voice: { name: AUDIO_DIR_NAME, path: AUDIO_DIR },
  meeting: { name: AUDIO_DIR_NAME, path: AUDIO_DIR },
  default: { name: IMAGES_DIR_NAME, path: IMAGES_DIR }
};

const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '100') * 1024 * 1024; // MB to bytes
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// ============================================================
// Step 11: Follow-up constants
const FOLLOW_UP_DAYS = parseInt(process.env.FOLLOW_UP_DAYS || '14', 10);

// F7 — VAPID + Subscriptions (Sub 2-2)
// ============================================================
const SUBSCRIPTIONS_PATH = path.join(__dirname, 'subscriptions.json');
const _subQueue = new PQueue({ concurrency: 1 }); // SR #3: 동시쓰기 방지

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBSCRIPTIONS_PATH)) return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_PATH, 'utf-8'));
  } catch (e) { console.warn('[Push] Failed to load subscriptions:', e.message); }
  return [];
}

function saveSubscriptions(subs) {
  // SR #3: atomic write tmp→rename
  const tmp = SUBSCRIPTIONS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(subs, null, 2), 'utf-8');
  fs.renameSync(tmp, SUBSCRIPTIONS_PATH);
}

function initVapid() {
  if (!webpush) return;
  let pub  = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL || 'mailto:admin@vaultvoice.app';

  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub  = keys.publicKey;
    priv = keys.privateKey;
    // 영속화: .env에 추가 (재시작 후에도 유지)
    try {
      const envPath = path.join(__dirname, '.env');
      const envLine = `\nVAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${priv}\nVAPID_EMAIL=${email}\n`;
      fs.appendFileSync(envPath, envLine, 'utf-8');
      process.env.VAPID_PUBLIC_KEY  = pub;
      process.env.VAPID_PRIVATE_KEY = priv;
      process.env.VAPID_EMAIL       = email;
      console.log('[Push] VAPID keys generated and saved to .env');
    } catch (e) { console.warn('[Push] Failed to save VAPID keys:', e.message); }
  }
  webpush.setVapidDetails(email, pub, priv);
  console.log('[Push] VAPID initialized');
}

// ============================================================
// Gemini Model Tiering Helpers
// ============================================================
// 4-tier: lite → 2.5-flash-lite, flash → 2.5-flash, pro → 2.5-pro, max → 3.1-pro-preview
const GEMINI_TIERS = {
  lite:  'gemini-2.5-flash-lite',
  flash: 'gemini-2.5-flash',
  pro:   'gemini-2.5-pro',
  max:   'gemini-3.1-pro-preview'
};
const GEMINI_FALLBACK = 'gemini-2.5-flash';

const genAI = (() => {
  try { return GoogleGenerativeAI ? new GoogleGenerativeAI(GEMINI_API_KEY) : null; } catch(e) { return null; }
})();

function getGeminiModel(tier = 'flash') {
  const modelId = GEMINI_TIERS[tier] || GEMINI_TIERS.flash;
  try { return genAI.getGenerativeModel({ model: modelId }); }
  catch (e) { return genAI.getGenerativeModel({ model: GEMINI_FALLBACK }); }
}

function getGeminiApiUrl(tier = 'flash') {
  const modelId = GEMINI_TIERS[tier] || GEMINI_TIERS.flash;
  const baseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
  return `${baseUrl}/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;
}

// ============================================================
// Title Cache for wiki-link insertion
// ============================================================
let titleCache = {}; // { filename: title }
const _compiledRegexMap = new Map(); // filename -> RegExp

function _buildRegex(title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`, 'g');
}

function loadTitleCache() {
  titleCache = {};
  _compiledRegexMap.clear();
  if (!fs.existsSync(NOTES_DIR)) return;
  try {
    const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
        const { frontmatter } = parseFrontmatter(raw);
        if (frontmatter.title) {
          titleCache[f] = frontmatter.title;
          _compiledRegexMap.set(f, _buildRegex(frontmatter.title));
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { console.warn('[TitleCache] Load failed:', e.message); }
}

function insertWikiLinks(body, currentFilename) {
  if (!Object.keys(titleCache).length) loadTitleCache();
  if (!Object.keys(titleCache).length) return body;
  let result = body;
  for (const [filename, title] of Object.entries(titleCache)) {
    if (filename === currentFilename) continue;
    if (!title || title.length < 2) continue;
    const regex = _compiledRegexMap.get(filename) || _buildRegex(title);
    result = result.replace(regex, `[[${filename.replace(/\.md$/, '')}|${title}]]`);
  }
  return result;
}
const OBSIDIAN_REST_URL = process.env.OBSIDIAN_REST_URL || 'http://localhost:27123';
const OBSIDIAN_REST_API_KEY = process.env.OBSIDIAN_REST_API_KEY || '';

app.set('trust proxy', 1); // Trust first proxy (Cloudflare tunnel)
app.use(compression());
app.use(express.json());

// Cache policy: SW always no-cache; JS/CSS use ETag revalidation; images cache 1h
app.use((req, res, next) => {
  if (req.path === '/sw.js') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  } else if (req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.set('Cache-Control', 'public, max-age=300, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: '5m',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// Request logger (debug only)
app.use((req, res, next) => {
  if (process.env.DEBUG === 'true' && req.path.startsWith('/api')) {
    console.log(`[REQ] ${req.method} ${req.path} from ${req.ip}`);
  }
  next();
});

// Auth middleware
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Apply auth to all /api routes except health
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/reset' || req.path.startsWith('/auth/google') || req.path.startsWith('/attachments/')) return next();
  auth(req, res, next);
});

// ---- Rate Limiting ----
const isTestEnv = process.env.NODE_ENV === 'test' || PORT === '3939';
const rateLimitMsg = { error: 'Too many requests, please try again later' };
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: isTestEnv ? 1000 : 100, message: rateLimitMsg, standardHeaders: true, legacyHeaders: false });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: isTestEnv ? 200 : 20, message: rateLimitMsg, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: isTestEnv ? 100 : 10, message: rateLimitMsg, standardHeaders: true, legacyHeaders: false });
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: isTestEnv ? 300 : 30, message: rateLimitMsg, standardHeaders: true, legacyHeaders: false });

app.use('/api', generalLimiter);
app.use('/api/ai', aiLimiter);
app.use('/api/rag', aiLimiter);
app.use('/api/search/ai', aiLimiter);
app.use('/api/upload', uploadLimiter);
app.use('/api/search', searchLimiter);
app.use('/api/vm/search', searchLimiter);

// ---- Ensure directories exist on startup ----
// Deduplicate paths before creating (legacy types share same dirs as new types)
const _dirsToCreate = [NOTES_DIR, AUDIO_DIR, IMAGES_DIR];
_dirsToCreate.forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ---- Multer setup for file upload ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.query.type || 'default';
    // audio/voice/meeting → AUDIO_DIR; image/photo/screenshot/default → IMAGES_DIR
    const dir = MEDIA_DIRS[type] || MEDIA_DIRS.default;
    cb(null, dir.path);
  },
  filename: (req, file, cb) => {
    const ts = Math.floor(Date.now() / 1000);
    const short = uuidv4().split('-')[0];
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `vv-${ts}-${short}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Only image or audio files allowed'));
  }
});

// ============================================================
// Clipboard sync (PC ↔ iPhone)
// ============================================================
let sharedClipboard = { text: '', updatedAt: 0 };

app.get('/api/clipboard', (req, res) => {
  res.json(sharedClipboard);
});

app.post('/api/clipboard', (req, res) => {
  const { text } = req.body;
  if (text === undefined) return res.status(400).json({ error: 'text required' });
  sharedClipboard = { text, updatedAt: Date.now() };
  res.json({ success: true });
});

// ============================================================
// Feature test endpoint
// ============================================================
app.get('/api/test', async (req, res) => {
  const results = {};

  // 1. Server health
  results.server = { ok: true, port: PORT };

  // 2. Vault access
  results.vault = { ok: fs.existsSync(VAULT_PATH), path: VAULT_PATH };

  // 3. Notes dir
  results.dailyDir = { ok: fs.existsSync(NOTES_DIR) };

  // 4. Audio/images asset dirs
  results.attachmentDir = { ok: fs.existsSync(AUDIO_DIR) && fs.existsSync(IMAGES_DIR), path: NOTES_DIR + '/assets' };

  // 5. Gemini Flash API
  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'your_key_here') {
    try {
      const testRes = await fetch(getGeminiApiUrl('flash'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'hello' }] }],
          generationConfig: { maxOutputTokens: 1024 }
        })
      });
      if (!testRes.ok) {
        const errBody = await testRes.text();
        console.error('Gemini test error:', errBody);
        results.gemini = { ok: false, status: testRes.status, error: errBody.substring(0, 200) };
      } else {
        results.gemini = { ok: true, status: testRes.status };
      }
    } catch (e) {
      results.gemini = { ok: false, error: e.message };
    }
  } else {
    results.gemini = { ok: false, error: 'API key not set' };
  }

  // 5b. Gemini Pro API
  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'your_key_here') {
    try {
      const proRes = await fetch(getGeminiApiUrl('pro'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'hello' }] }],
          generationConfig: { maxOutputTokens: 2048 }
        })
      });
      results.geminiPro = { ok: proRes.ok, status: proRes.status };
    } catch (e) {
      results.geminiPro = { ok: false, error: e.message };
    }
  } else {
    results.geminiPro = { ok: false, error: 'API key not set' };
  }

  // 5c. Endpoint existence checks
  results.noteSummarizeEndpoint = { ok: true };
  results.noteCommentEndpoint = { ok: true };

  // 6. Obsidian REST API
  if (OBSIDIAN_REST_API_KEY) {
    try {
      const obsRes = await fetch(`${OBSIDIAN_REST_URL}/`, {
        headers: { 'Authorization': `Bearer ${OBSIDIAN_REST_API_KEY}` }
      });
      results.obsidianApi = { ok: obsRes.ok, status: obsRes.status };
    } catch (e) {
      results.obsidianApi = { ok: false, error: e.message };
    }
  } else {
    results.obsidianApi = { ok: false, error: 'API key not set' };
  }

  // 7. Recent notes count
  if (fs.existsSync(NOTES_DIR)) {
    const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
    results.notes = { ok: true, count: files.length };
  } else {
    results.notes = { ok: false, count: 0 };
  }

  res.json(results);
});

// ============================================================
// Health check
// ============================================================
const serverStartedAt = Date.now();
app.get('/api/health', (req, res) => {
  const vaultExists = fs.existsSync(VAULT_PATH);
  const notesExists = fs.existsSync(NOTES_DIR);
  res.json({
    status: 'ok',
    vault: vaultExists,
    dailyDir: notesExists,
    vaultPath: VAULT_PATH,
    platform: process.platform,
    uptime: Math.floor(process.uptime()),
    startedAt: new Date(serverStartedAt).toISOString(),
    version: require('./package.json').version
  });
});

// Cache/SW reset page (no auth required)
app.get('/api/reset', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset</title>
<style>body{font-family:-apple-system,sans-serif;max-width:400px;margin:40px auto;padding:20px;text-align:center}
#s{margin:20px 0;padding:15px;border-radius:8px;font-size:16px;background:#fff3cd;color:#856404}
.ok{background:#d4edda!important;color:#155724!important}
button{padding:12px 24px;font-size:18px;border:none;border-radius:8px;background:#007aff;color:#fff;margin:10px}</style>
</head><body><h2>Cache Reset</h2><div id="s">초기화 중...</div>
<script>
var s=document.getElementById('s'),log=[];
(navigator.serviceWorker?navigator.serviceWorker.getRegistrations():Promise.resolve([])).then(function(r){
  return Promise.all(r.map(function(g){return g.unregister().then(function(){log.push('SW 해제 완료')})}));
}).then(function(){
  return caches.keys().then(function(k){return Promise.all(k.map(function(c){return caches.delete(c).then(function(){log.push('캐시 삭제: '+c)})}))});
}).then(function(){
  localStorage.clear();log.push('localStorage 초기화');
  s.className='ok';
  s.innerHTML='<b>완료!</b><br><br>'+log.join('<br>')+'<br><br><button onclick="location.href=\\'/\\'">앱으로 이동</button>';
}).catch(function(e){s.textContent='오류: '+e.message});
</script></body></html>`);
});

// ============================================================
// Daily Briefing — must be BEFORE /api/daily/:date to avoid param match
// ============================================================
app.get('/api/daily/briefing', auth, async (req, res) => {
  try {
    const result = await runDailyBriefing();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Get daily note
// ============================================================
app.get('/api/daily/:date', (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  const notes = getNotesForDate(date);
  if (notes.length === 0) {
    return res.status(404).json({ error: 'Note not found', date });
  }

  const combined = combineNotes(notes);
  // Merge all tags from all notes
  const allTags = [...new Set(notes.flatMap(n => n.frontmatter.tags || []))];
  res.json({ date, frontmatter: { tags: allTags }, body: combined, notes });
});

// ============================================================
// Create or update daily note
// ============================================================
app.post('/api/daily/:date', (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  const { content, tags = [], section = '메모', images = [], audios = [], priority, due } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }

  // Map legacy section names to new type values
  const isTodo = section === '오늘할일';
  const noteType = isTodo ? 'todo' : 'memo';

  let newEntry;
  if (isTodo) {
    newEntry = formatTaskToMarkdown({ title: content.trim(), due: due || null, priority: priority || null });
  } else {
    const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    newEntry = `- ${content.trim()} *(${timestamp})*`;
  }

  // Add image sub-items
  if (images && images.length > 0) {
    for (const img of images) {
      const filename = typeof img === 'string' ? img : img.filename;
      const dir = typeof img === 'string' ? IMAGES_DIR_NAME : (img.dirName || IMAGES_DIR_NAME);
      newEntry += `\n  - ![[${dir}/${filename}]]`;
    }
  }

  // Add audio sub-items
  if (audios && audios.length > 0) {
    for (const aud of audios) {
      const filename = typeof aud === 'string' ? aud : aud.filename;
      const dir = typeof aud === 'string' ? AUDIO_DIR_NAME : (aud.dirName || AUDIO_DIR_NAME);
      newEntry += `\n  - 🎙️ ![[${dir}/${filename}]]`;
    }
  }

  const result = createAtomicNote(date, noteType, newEntry, tags);
  res.json({ success: true, date, section, ...result });
});

// ============================================================
// File upload (image or audio)
// ============================================================
app.post('/api/upload', (req, res, next) => {
  console.log('[UPLOAD] Request received, content-type:', req.headers['content-type']);
  upload.any()(req, res, (err) => {
    if (err) {
      console.error('[UPLOAD] Multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    const file = req.files && req.files[0];
    if (!file) {
      console.error('[UPLOAD] No file in request');
      return res.status(400).json({ error: 'No file provided' });
    }
    const type = req.query.type || 'default';
    const dir = MEDIA_DIRS[type] || MEDIA_DIRS.default;
    console.log('[UPLOAD] Success:', file.filename, file.size, 'bytes', 'dir:', dir.name);
    res.json({
      success: true,
      filename: file.filename,
      dirName: dir.name,
      path: `${dir.name}/${file.filename}`
    });
  });
});

// ============================================================
// Serve attachment images
// ============================================================
app.get('/api/attachments/:filename', (req, res) => {
  const filename = req.params.filename;
  // Security: prevent path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  // Search across all media directories
  for (const dir of Object.values(MEDIA_DIRS)) {
    const filePath = path.join(dir.path, filename);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }
  return res.status(404).json({ error: 'File not found' });
});

// ============================================================
// Get todos from daily note
// ============================================================
app.get('/api/daily/:date/todos', (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }

  const notes = getNotesForDate(date);
  const todos = [];

  for (const note of notes) {
    const lines = note.raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const todoMatch = line.match(/^- \[([ x])\] (.+)$/);
      if (todoMatch) {
        const done = todoMatch[1] === 'x';
        let text = todoMatch[2];

        let priority = null;
        let due = null;
        const priorityMatch = text.match(/\[priority::([^\]]+)\]/);
        const dueMatch = text.match(/\[due::([^\]]+)\]/);
        if (priorityMatch) {
          priority = priorityMatch[1];
          text = text.replace(priorityMatch[0], '').trim();
        }
        if (dueMatch) {
          due = dueMatch[1];
          text = text.replace(dueMatch[0], '').trim();
        }

        todos.push({ filename: note.filename, lineIndex: i, done, text, priority, due });
      }
    }
  }

  res.json({ todos });
});

// ============================================================
// Toggle todo checkbox
// ============================================================
app.post('/api/todo/toggle', (req, res) => {
  const { date, filename, lineIndex } = req.body;
  if (!date || lineIndex === undefined) {
    return res.status(400).json({ error: 'date and lineIndex are required' });
  }

  // Find the target file: use filename if provided, else search todo files for date
  let filePath;
  if (filename) {
    filePath = path.join(DAILY_DIR, filename);
  } else {
    // Legacy fallback: find first todo file matching date
    const notes = getNotesForDate(date);
    const todoNote = notes.find(n => {
      const lines = n.raw.split('\n');
      return lineIndex < lines.length && lines[lineIndex].match(/^- \[([ x])\] /);
    });
    if (!todoNote) return res.status(404).json({ error: 'Todo not found' });
    filePath = path.join(DAILY_DIR, todoNote.filename);
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Note not found' });
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return res.status(400).json({ error: 'Invalid line index' });
  }

  const line = lines[lineIndex];
  if (line.match(/^- \[ \] /)) {
    lines[lineIndex] = line.replace('- [ ] ', '- [x] ');
  } else if (line.match(/^- \[x\] /)) {
    lines[lineIndex] = line.replace('- [x] ', '- [ ] ');
  } else {
    return res.status(400).json({ error: 'Line is not a todo item' });
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  res.json({ success: true, toggled: lineIndex });
});

app.post('/api/todo/delete', auth, (req, res) => {
  const { date, filename, lineIndex } = req.body;
  if (!date || lineIndex === undefined) {
    return res.status(400).json({ error: 'date and lineIndex are required' });
  }

  let filePath;
  if (filename) {
    filePath = path.join(DAILY_DIR, filename);
  } else {
    const notes = getNotesForDate(date);
    const todoNote = notes.find(n => {
      const lines = n.raw.split('\n');
      return lineIndex < lines.length && lines[lineIndex].match(/^- \[([ x])\] /);
    });
    if (!todoNote) return res.status(404).json({ error: 'Todo not found' });
    filePath = path.join(DAILY_DIR, todoNote.filename);
  }

  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Note not found' });

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  if (lineIndex < 0 || lineIndex >= lines.length || !lines[lineIndex].match(/^- \[([ x])\] /)) {
    return res.status(400).json({ error: 'Invalid todo line' });
  }

  lines.splice(lineIndex, 1);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  res.json({ success: true, deleted: lineIndex });
});

// ============================================================
// AI Summarize (Gemini proxy)
// ============================================================
app.post('/api/ai/summarize', async (req, res) => {
  const { action, content, date } = req.body;

  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') {
    return res.status(503).json({ error: 'Gemini API key not configured' });
  }

  if (!content) {
    return res.status(400).json({ error: 'Content is required' });
  }

  // Apply Privacy Shield before sending to external API
  const maskedContent = applyPrivacyShield(content);

  let prompt;
  if (action === 'summarize') {
    prompt = `다음은 ${date || '오늘'}의 일일노트 내용입니다. 3~5문장으로 한국어로 핵심을 요약해주세요. 마크다운 없이 일반 텍스트로 답변하세요.\n\n${maskedContent}`;
  } else if (action === 'auto-tags') {
    prompt = `다음 메모의 주제/카테고리를 나타내는 태그를 정확히 1~2개 추천하세요. 규칙: 1) 메모의 핵심 주제를 대표하는 명사형 태그 2) 구체적이고 의미있는 단어 (예: 회의, 논문, 진료, 코딩, 운동) 3) "작성", "수정" 같은 동작어 금지. JSON 배열로만 답변. 예: ["회의", "AI프로젝트"]\n\n${maskedContent}`;
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    const geminiRes = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
      })
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error('Gemini API error:', err);
      return res.status(502).json({ error: 'Gemini API error' });
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let result = text.trim();

    if (action === 'auto-tags') {
      try {
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) result = JSON.parse(jsonMatch[0]);
      } catch (e) { /* Return as-is */ }
    }

    res.json({ success: true, action, result });
  } catch (e) {
    console.error('Gemini proxy error:', e);
    res.status(500).json({ error: 'AI request failed: ' + e.message });
  }
});

// ============================================================
// AI Calendar Event Detection
// ============================================================
app.post('/api/ai/detect-event', async (req, res) => {
  const { content, referenceDate } = req.body;

  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') {
    return res.status(503).json({ error: 'Gemini API key not configured' });
  }

  if (!content || !referenceDate) {
    return res.status(400).json({ error: 'content and referenceDate are required' });
  }

  // Apply Privacy Shield before sending to external API
  const maskedContent = applyPrivacyShield(content);

  const prompt = `당신은 메모에서 일정을 추출하는 어시스턴트입니다.
오늘 날짜: ${referenceDate}

다음 메모를 읽고 일정/약속/미팅/예약이 포함되어 있으면 추출하세요.

날짜 변환: "오늘"=${referenceDate}, "내일"=+1일, "모레"=+2일, "다음주 X요일"=다음주 해당 요일, "이번주 X요일"=이번주 해당 요일(지났으면 다음주), 월/일만 있으면 가장 가까운 미래 날짜
시간 변환: "아침"=09:00~10:00, "점심"=12:00~13:00, "저녁"=18:00~19:00, "오후"=14:00~15:00, 시간 없으면 isAllDay=true, 종료시간 없으면 시작+1시간

반드시 아래 JSON 형식 중 하나만 출력하세요:
일정 있음: {"detected":true,"event":{"title":"제목","date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM","isAllDay":false}}
종일 일정: {"detected":true,"event":{"title":"제목","date":"YYYY-MM-DD","startTime":"","endTime":"","isAllDay":true}}
일정 없음: {"detected":false}

메모: "${maskedContent}"`;

  try {
    const geminiRes = await fetch(getGeminiApiUrl('lite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 512 }
      })
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error('Gemini detect-event error:', err);
      return res.status(502).json({ error: 'Gemini API error' });
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return res.json({ success: true, detected: !!parsed.detected, event: parsed.event || null });
      }
    } catch (e) {
      // JSON parse failed
    }

    res.json({ success: true, detected: false, event: null });
  } catch (e) {
    console.error('Detect-event error:', e);
    res.status(500).json({ error: 'AI request failed: ' + e.message });
  }
});

// ============================================================
// AI Image Analysis (Smart Scan)
// ============================================================
app.post('/api/ai/analyze-image', async (req, res) => {
  const { filename } = req.body;

  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') {
    return res.status(503).json({ error: 'Gemini API key not configured' });
  }
  if (!filename) return res.status(400).json({ error: 'Filename required' });

  // Read file as base64 (search across all media directories)
  let filePath = null;
  for (const dir of Object.values(MEDIA_DIRS)) {
    const candidate = path.join(dir.path, filename);
    if (fs.existsSync(candidate)) { filePath = candidate; break; }
  }
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const base64Image = fileBuffer.toString('base64');
    const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const prompt = `
이 이미지를 자세히 분석하여 정보를 추출해 주세요.
다음 카테고리 중 하나로 분류하세요: [영수증, 명함, 문서, 화이트보드, 스크린샷, 기타].

형식: JSON으로만 답변하세요. 마크다운 코드블록 없이 순수 JSON만 출력하세요.
{
  "category": "카테고리명",
  "summary": "핵심 내용 1~2문장 요약",
  "data": {
    // 카테고리별 핵심 데이터 (예: 영수증이면 상호명/금액/일시, 명함이면 이름/전화번호, 문서면 제목/요약)
  },
  "text": "이미지에서 추출한 전체 텍스트 (OCR)"
}`;

    const geminiRes = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Image } }
          ]
        }],
        generationConfig: { maxOutputTokens: 2048 }
      })
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      return res.status(502).json({ error: 'Gemini API error: ' + err });
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    
    // Clean JSON output (remove ```json wrappers if present)
    let jsonStr = text.replace(/```json\n?|```/g, '').trim();
    let result = JSON.parse(jsonStr);

    res.json({ success: true, result });
  } catch (e) {
    console.error('Image analysis error:', e);
    res.status(500).json({ error: 'Analysis failed: ' + e.message });
  }
});

// ============================================================
// Jarvis (Voice Assistant) - Phase 2 (Refactored)
// ============================================================

// Tool definitions for Jarvis
const JARVIS_TOOLS = [
  {
    name: 'search',
    description: 'Search notes in the vault. Searches VaultVoice notes first, then expands to other user folders. For coding rules/Claude/hook/guard topics, also searches system config.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'The search query keywords' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_daily_note',
    description: 'Read all notes for a specific date (YYYY-MM-DD). Use "today" for current date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Date in YYYY-MM-DD format, or "today"' }
      },
      required: ['date']
    }
  },
  {
    name: 'read_note',
    description: 'Read a specific note by filename or path. For VaultVoice notes use filename only (e.g. "2026-04-01_093000_memo.md"). For vault notes use relative path.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Filename or path relative to vault root' }
      },
      required: ['path']
    }
  },
  {
    name: 'add_todo',
    description: 'Add a todo item to a specific date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Date in YYYY-MM-DD format, or "today"' },
        task: { type: 'STRING', description: 'The task content' },
        priority: { type: 'STRING', enum: ['높음', '보통', '낮음'], description: 'Priority level' }
      },
      required: ['date', 'task']
    }
  },
  {
    name: 'add_memo',
    description: 'Add a general memo/note to a specific date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Date in YYYY-MM-DD format, or "today"' },
        content: { type: 'STRING', description: 'The memo content' }
      },
      required: ['date', 'content']
    }
  },
  {
    name: 'get_calendar_events',
    description: 'Get Google Calendar events for a specific date range.',
    parameters: {
      type: 'OBJECT',
      properties: {
        startDate: { type: 'STRING', description: 'Start date (YYYY-MM-DD)' },
        endDate: { type: 'STRING', description: 'End date (YYYY-MM-DD)' }
      },
      required: ['startDate']
    }
  },
  {
    name: 'add_calendar_event',
    description: 'Add an event to Google Calendar.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Event title' },
        startTime: { type: 'STRING', description: 'Start time (ISO 8601)' },
        endTime: { type: 'STRING', description: 'End time (ISO 8601)' }
      },
      required: ['title', 'startTime', 'endTime']
    }
  },
  {
    name: 'create_note',
    description: 'Create a new note in VaultVoice (99_vaultvoice/). Content in Markdown with [[wikilink]] for links.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Note title (used as filename)' },
        content: { type: 'STRING', description: 'Markdown content' },
        tags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Tags for the note' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'list_folder',
    description: 'List files in a vault folder. Use "" for root, "99_vaultvoice" for VV notes, etc.',
    parameters: {
      type: 'OBJECT',
      properties: {
        folder: { type: 'STRING', description: 'Folder path relative to vault root. Empty string for root.' }
      },
      required: ['folder']
    }
  },
  {
    name: 'get_tags',
    description: 'Get all tags used in VaultVoice notes, sorted by frequency.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'get_recent_notes',
    description: 'Get the most recent VaultVoice notes (last 7 days).',
    parameters: { type: 'OBJECT', properties: {} }
  },
  { name: 'delete_note', description: 'Delete a VaultVoice note by filename. Only 99_vaultvoice/ notes.', parameters: { type: 'OBJECT', properties: { filename: { type: 'STRING', description: 'Note filename (e.g. 2026-04-01_093000_memo.md)' } }, required: ['filename'] } },
  { name: 'delete_todo', description: 'Delete a todo item by date and line index.', parameters: { type: 'OBJECT', properties: { date: { type: 'STRING' }, lineIndex: { type: 'NUMBER' } }, required: ['date', 'lineIndex'] } },
  { name: 'toggle_todo', description: 'Toggle a todo item done/undone by date and line index.', parameters: { type: 'OBJECT', properties: { date: { type: 'STRING' }, lineIndex: { type: 'NUMBER' } }, required: ['date', 'lineIndex'] } },
  { name: 'summarize_note', description: 'Generate AI summary of a specific note.', parameters: { type: 'OBJECT', properties: { filename: { type: 'STRING' } }, required: ['filename'] } },
  { name: 'process_url', description: 'Fetch a URL, extract content, summarize with AI, and save as a new note.', parameters: { type: 'OBJECT', properties: { url: { type: 'STRING', description: 'The URL to process' } }, required: ['url'] } },
  { name: 'add_comment', description: 'Add a user comment to an existing note. The comment is refined by AI before appending.', parameters: { type: 'OBJECT', properties: { filename: { type: 'STRING', description: 'Target note filename' }, comment: { type: 'STRING', description: 'User comment in natural language' } }, required: ['filename', 'comment'] } },
  { name: 'reanalyze_perspective', description: '노트의 Multi-Lens 분석을 재실행합니다. analyzed_lenses를 초기화하고 area 기반 렌즈를 다시 적용합니다.', parameters: { type: 'OBJECT', properties: { filename: { type: 'STRING', description: 'Note filename (e.g. 2026-04-01_093000_memo.md)' }, lens: { type: 'STRING', description: '렌즈 강제 지정 (Career/Family/Finance). 생략 시 area 기반 자동 선택' } }, required: ['filename'] } },
  {
    name: 'get_person_context',
    description: '특정 인물에 대한 최근 맥락과 관계 정보를 요약합니다. 인물 노트와 함께했던 미팅/메모를 종합하여 핵심 포인트를 제공합니다. 인물 정보, 최근 이야기, 관계 현황을 물어볼 때 사용하세요.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: '인물 이름 (예: "박 차장님", "김 이사")' }
      },
      required: ['name']
    }
  },
  {
    name: 'get_followup_needed',
    description: `팔로우업이 필요한 인물 목록을 반환합니다. ${FOLLOW_UP_DAYS}일 이상 연락이 없었던 인물을 최근 접촉 순으로 정렬합니다. "팔로우업 필요한 사람", "연락 안 한 사람 누구야" 등에 사용하세요.`,
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'get_activity_summary',
    description: '최근 N일간의 메모 활동 패턴을 분석하여 자연어로 요약합니다. 어떤 주제를 많이 메모했는지 파악할 때 사용하세요. 기본 30일, 최대 90일. summarize_topic과 달리 특정 주제가 아닌 전체 활동 패턴 분석에 사용하세요.',
    parameters: {
      type: 'OBJECT',
      properties: {
        days: { type: 'NUMBER', description: '분석할 기간 (일수, 기본값 30, 최대 90)' }
      }
    }
  },
  {
    name: 'summarize_topic',
    description: '특정 주제에 관한 메모들을 검색하여 핵심 포인트를 불릿으로 요약합니다. 시간 표현("이번 달", "지난달", "올해")도 지원합니다. prep_meeting과 달리 인물이 아닌 주제/키워드 중심 요약에 사용하세요.',
    parameters: {
      type: 'OBJECT',
      properties: {
        topic: { type: 'STRING', description: '요약할 주제 (예: "이번 달 CAPEX", "Q3 보고서", "올해 채용")' }
      },
      required: ['topic']
    }
  },
  {
    name: 'prep_meeting',
    description: '특정 인물과의 미팅 전 준비 브리핑을 생성합니다. 인물 맥락, 미완료 액션 아이템, 예정 일정을 종합합니다. "미팅 준비", "미팅 전에 뭐 알아야 해" 등에 사용하세요. get_person_context와 달리 미팅 준비에 특화되어 있습니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        personName: { type: 'STRING', description: '미팅 상대 이름 (예: "박 차장님")' },
        topic: { type: 'STRING', description: '미팅 주제 (선택, 예: "분기 예산 검토")' }
      },
      required: ['personName']
    }
  }
];

// Folders excluded from general search (always)
const SEARCH_EXCLUDE_DIRS = new Set(['.obsidian', '.claude', '90_Attachments', 'node_modules']);
// System config folder — only searched when query matches these keywords
const SYSTEM_FOLDER = '00_Claude_Control';
const SYSTEM_KEYWORDS = /규칙|코딩|hook|guard|claude|패턴|스킬|메모리|설정|config|rule|pattern|agent|workflow|wf|프롬프트|prompt|감사|audit|스크립트|script|도구|tool|인덱스|index|템플릿|template|에이전트|자동화|automation|파이프라인|pipeline/i;

// Resolve "today" to actual date
function resolveDate(dateStr) {
  if (dateStr === 'today' || dateStr === '오늘') return new Date().toISOString().slice(0, 10);
  return dateStr;
}

// Obsidian REST API helper
async function obsidianApi(method, endpoint, body) {
  const url = `${OBSIDIAN_REST_URL}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${OBSIDIAN_REST_API_KEY}`,
      'Content-Type': 'application/json'
    }
  };
  if (body !== undefined && method !== 'GET') {
    if (typeof body === 'string') {
      opts.headers['Content-Type'] = 'text/markdown';
      opts.body = body;
    } else {
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, opts);
  return res;
}

// Execute a single tool call
async function executeToolCall(name, args) {
  switch (name) {
    case 'search': return await executeSearch(args.query);
    case 'read_daily_note': return executeReadDailyNote(args.date);
    case 'read_note': return executeReadNote(args);
    case 'add_todo': return executeAddTodo(args);
    case 'add_memo': return executeAddMemo(args);
    case 'get_calendar_events': return await executeGetCalendarEvents(args);
    case 'add_calendar_event': return await executeAddCalendarEvent(args);
    case 'create_note': return executeCreateNoteV2(args);
    case 'list_folder': return executeListFolderV2(args);
    case 'get_tags': return executeGetTags();
    case 'get_recent_notes': return executeGetRecentNotes();
    case 'delete_note': return executeDeleteNote(args);
    case 'delete_todo': return executeDeleteTodoTool(args);
    case 'toggle_todo': return executeToggleTodoTool(args);
    case 'summarize_note': return await executeSummarizeNote(args);
    case 'process_url': return await executeProcessUrl(args);
    case 'add_comment': return await executeAddComment(args);
    case 'reanalyze_perspective': return await executeReanalyzePerspective(args);
    case 'get_person_context': return await getPersonContext(args.name);
    case 'get_followup_needed': return await getFollowupNeeded();
    case 'prep_meeting': return await prepMeeting(args.personName, args.topic);
    case 'summarize_topic': return await summarizeTopic(args.topic);
    case 'get_activity_summary': return await getActivitySummary(args.days);
    default: return { error: `Unknown tool: ${name}` };
  }
}

function executeDeleteNote(args) {
  if (!args.filename) return { result: 'filename required' };
  if (!args.filename || args.filename.includes('..') || args.filename.includes('/') || args.filename.includes('\\')) return { result: 'Invalid filename' };
  const filePath = path.join(NOTES_DIR, args.filename);
  if (!fs.existsSync(filePath)) return { result: `"${args.filename}" 파일을 찾을 수 없습니다.` };
  try {
    fs.unlinkSync(filePath);
    invalidateFileCache();
    _vectorCache = null;
    delete titleCache[args.filename];
    _compiledRegexMap.delete(args.filename);
    noteCache.invalidate(args.filename);
    return { result: `"${args.filename}" 노트를 삭제했습니다.` };
  } catch (e) {
    return { result: '삭제 실패: ' + e.message };
  }
}

function executeDeleteTodoTool(args) {
  const date = resolveDate(args.date);
  const lineIndex = Number(args.lineIndex);
  const notes = getNotesForDate(date);
  const todoNote = notes.find(n => {
    const lines = n.raw.split('\n');
    return lineIndex < lines.length && lines[lineIndex].match(/^- \[([ x])\] /);
  });
  if (!todoNote) return { result: 'Todo not found' };
  const filePath = path.join(DAILY_DIR, todoNote.filename);
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length || !lines[lineIndex].match(/^- \[([ x])\] /)) return { result: 'Invalid todo line' };
  lines.splice(lineIndex, 1);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  noteCache.invalidate(todoNote.filename);
  return { result: `할일 항목(${lineIndex})을 삭제했습니다.` };
}

function executeToggleTodoTool(args) {
  const date = resolveDate(args.date);
  const lineIndex = Number(args.lineIndex);
  const notes = getNotesForDate(date);
  const todoNote = notes.find(n => {
    const lines = n.raw.split('\n');
    return lineIndex < lines.length && lines[lineIndex].match(/^- \[([ x])\] /);
  });
  if (!todoNote) return { result: 'Todo not found' };
  const filePath = path.join(DAILY_DIR, todoNote.filename);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return { result: 'Invalid line index' };
  const line = lines[lineIndex];
  if (line.match(/^- \[ \] /)) lines[lineIndex] = line.replace('- [ ] ', '- [x] ');
  else if (line.match(/^- \[x\] /)) lines[lineIndex] = line.replace('- [x] ', '- [ ] ');
  else return { result: 'Line is not a todo item' };
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  noteCache.invalidate(todoNote.filename);
  return { result: `할일 항목(${lineIndex}) 토글 완료.` };
}

async function executeSummarizeNote(args) {
  if (!args.filename) return { result: 'filename required' };
  if (!args.filename || args.filename.includes('..') || args.filename.includes('/') || args.filename.includes('\\')) return { result: 'Invalid filename' };
  const filePath = path.join(NOTES_DIR, args.filename);
  if (!fs.existsSync(filePath)) return { result: `"${args.filename}" 파일을 찾을 수 없습니다.` };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { body } = parseFrontmatter(raw);
    const prompt = `다음 노트 내용을 3~5문장으로 한국어로 핵심 요약해주세요. 마크다운 없이 일반 텍스트로 답변하세요.\n\n${body.slice(0, 8000)}`;
    const geminiRes = await fetch(getGeminiApiUrl('pro'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 4096 } })
    });
    if (!geminiRes.ok) return { result: '요약 실패' };
    const data = await geminiRes.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    return { result: summary };
  } catch (e) {
    return { result: '요약 오류: ' + e.message };
  }
}

async function executeProcessUrl(args) {
  if (!args.url) return { result: 'url required' };
  try {
    const { text, meta } = await extractUrlContent(args.url);
    const summary = await summarizeWithGemini(text, args.url, meta);
    const domain = new URL(args.url).hostname.replace(/^www\./, '');
    const tags = ['url', domain, ...(summary.keywords || [])];
    const body = buildUrlNoteBody(summary, meta, args.url);
    const date = new Date().toISOString().slice(0, 10);
    const noteResult = createAtomicNote(date, 'url', body, tags, { url: args.url, domain, status: 'summarized' });
    return { result: `URL 노트 저장 완료: ${noteResult.filename}\n요약: ${summary.summary}` };
  } catch (e) {
    return { result: 'URL 처리 실패: ' + e.message };
  }
}

async function executeAddComment(args) {
  if (!args.filename || !args.comment) return { result: 'filename and comment required' };
  if (!args.filename || args.filename.includes('..') || args.filename.includes('/') || args.filename.includes('\\')) return { result: 'Invalid filename' };
  const filePath = path.join(NOTES_DIR, args.filename);
  if (!fs.existsSync(filePath)) return { result: `"${args.filename}" 파일을 찾을 수 없습니다.` };
  try {
    const refined = await refineComment(args.comment);
    appendCommentToNote(filePath, refined);
    return { result: `코멘트를 "${args.filename}"에 추가했습니다: ${refined}` };
  } catch (e) {
    return { result: '코멘트 추가 실패: ' + e.message };
  }
}

async function executeReanalyzePerspective(args) {
  if (!args.filename) return { result: 'filename required' };
  if (args.filename.includes('..') || args.filename.includes('/') || args.filename.includes('\\')) return { result: 'Invalid filename' };
  const filePath = findVVNote(args.filename);
  if (!filePath) return { result: `"${args.filename}" 파일을 찾을 수 없습니다.` };
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter: fm, body } = parseFrontmatter(raw);
  fm.analyzed_lenses = [];
  if (args.lens) fm.area = args.lens;
  fs.writeFileSync(filePath, serializeFrontmatter(fm) + body, 'utf-8');
  const freshRaw = fs.readFileSync(filePath, 'utf-8');
  await applyPerspectiveFilters(filePath, freshRaw);
  return { result: `"${args.filename}" Multi-Lens 분석을 재실행했습니다.` };
}

// ============================================================
// CRM/Q&A Jarvis tool implementations (Sub 2-1~2-5)
// ============================================================

// Sub 2-5: get_activity_summary — recent N days notes + category/topic dist → Gemini flash
async function getActivitySummary(days = 30) {
  const clampedDays = Math.min(Math.max(1, days), 90);
  const since = new Date(Date.now() - clampedDays * 86400000).toISOString().slice(0, 10);

  const noteMetas = [];
  try {
    // Group by date and leverage noteCache to avoid redundant readFileSync
    const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md') && f >= since);
    const dateSet = new Set(files.map(f => (f.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean));
    for (const date of dateSet) {
      const notes = getNotesForDate(date);
      for (const note of notes) {
        if (note.filename < since) continue;
        const fm = note.frontmatter;
        noteMetas.push({
          date,
          category: fm.category || fm.area || '',
          topic: Array.isArray(fm.topic) ? fm.topic : [],
          type: fm.type || fm['유형'] || '',
          title: fm.title || note.filename
        });
      }
    }
  } catch (_) {}

  if (!noteMetas.length) return { days: clampedDays, summary: '해당 기간에 메모가 없습니다.', noteCount: 0 };

  // Distribution aggregation
  const categoryCount = {};
  const topicCount = {};
  for (const m of noteMetas) {
    if (m.category) categoryCount[m.category] = (categoryCount[m.category] || 0) + 1;
    for (const t of m.topic) topicCount[t] = (topicCount[t] || 0) + 1;
  }
  const topCategories = Object.entries(categoryCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(', ');
  const topTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(', ');

  // Gemini flash summary
  let summary = '';
  try {
    const prompt = [
      `최근 ${clampedDays}일간 ${noteMetas.length}개 메모를 분석한 활동 요약을 한국어로 작성해라.`,
      '어떤 주제에 집중했는지, 패턴이나 변화가 있는지 3~5문장으로.',
      '', `총 메모: ${noteMetas.length}개`, `카테고리 분포: ${topCategories || '없음'}`, `주제 분포: ${topTopics || '없음'}`,
      `기간: ${since} ~ 오늘`,
    ].join('\n');
    const res = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (res.ok) {
      const data = await res.json();
      summary = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
  } catch (e) { console.warn('[getActivitySummary] Gemini failed:', e.message); }

  return { days: clampedDays, noteCount: noteMetas.length, topCategories, topTopics, summary };
}

// Sub 2-4: summarize_topic — vault ask base + time filter + keyword filter → Gemini flash bullets
async function summarizeTopic(topic) {
  if (!topic?.trim()) return { error: 'topic required' };

  // Time expression parsing: "이번 달", "지난달", "올해", YYYY-MM, YYYY년 M월
  let filterYear = null, filterMonth = null;
  const now = new Date();
  if (/이번\s*달|이번달/.test(topic)) {
    filterYear = String(now.getFullYear()); filterMonth = String(now.getMonth() + 1).padStart(2, '0');
  } else if (/지난\s*달|지난달/.test(topic)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    filterYear = String(d.getFullYear()); filterMonth = String(d.getMonth() + 1).padStart(2, '0');
  } else if (/올해/.test(topic)) {
    filterYear = String(now.getFullYear());
  } else {
    const m = topic.match(/(\d{4})[-년]\s*(\d{1,2})[월-]?/);
    if (m) { filterYear = m[1]; filterMonth = m[2].padStart(2, '0'); }
  }

  // Keyword: strip time expressions to get core topic
  const keyword = topic.replace(/이번\s*달|지난\s*달|올해|\d{4}[-년]\s*\d{1,2}[월-]?/g, '').trim();

  // Find relevant notes: keyword match + time filter using noteCache
  const snippets = [];
  try {
    const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md')).sort().reverse();
    const dateSet = new Set(files.map(f => (f.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean));
    const sortedDates = [...dateSet].sort().reverse();
    for (const date of sortedDates) {
      if (snippets.length >= 10) break;
      if (filterYear && !date.startsWith(filterYear)) continue;
      if (filterMonth && !date.startsWith(`${filterYear}-${filterMonth}`)) continue;
      const notes = getNotesForDate(date);
      for (const note of notes) {
        if (snippets.length >= 10) break;
        if (keyword && !note.raw.toLowerCase().includes(keyword.toLowerCase())) continue;
        const fm = note.frontmatter;
        snippets.push(`[${fm['날짜'] || date}] ${note.body.slice(0, 400)}`);
      }
    }
  } catch (_) {}

  if (!snippets.length) return { topic, summary: '관련 메모를 찾을 수 없습니다.', noteCount: 0 };

  // Gemini flash — key bullets
  let summary = '';
  try {
    const prompt = `아래 메모들에서 "${topic}" 관련 핵심 포인트를 불릿 3~7개로 한국어로 정리해라. 사실 위주, 추측 없이.\n\n${applyPrivacyShield(snippets.join('\n\n---\n\n'))}`;
    const res = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (res.ok) {
      const data = await res.json();
      summary = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
  } catch (e) { console.warn('[summarizeTopic] Gemini failed:', e.message); }

  return { topic, summary, noteCount: snippets.length };
}

// Sub 2-3: prep_meeting — entity_map direct + pending tasks + calendar(7d) → Gemini flash 1 call (SR W3)
async function prepMeeting(personName, topic = null) {
  if (!personName?.trim()) return { error: 'personName required' };
  const cleanName = normalizeAttendeeName(personName.trim());

  // 1. entity_map data (SR W3: direct access, no getPersonContext() call)
  const entityMap = getEntityMap();
  const personEntry = entityMap?.persons?.[cleanName]
    || Object.entries(entityMap?.persons || {}).find(([k]) => levenshtein(cleanName, k) <= 1)?.[1]
    || null;

  // 2. Interaction memos (attendees/participants match, Top-10 newest)
  const memoSnippets = [];
  try {
    const files = fs.readdirSync(NOTES_DIR).sort().reverse();
    for (const f of files) {
      if (!f.endsWith('.md') || memoSnippets.length >= 10) continue;
      const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
      const { frontmatter: fm, body } = parseFrontmatter(raw);
      const combined = [...(Array.isArray(fm.attendees) ? fm.attendees : []),
        ...(Array.isArray(fm.participants) ? fm.participants : [])].join(' ');
      if (combined.includes(cleanName) || combined.includes(personName.trim())) {
        memoSnippets.push(`[${fm['날짜'] || f.slice(0, 10)}] ${body.slice(0, 250)}`);
      }
    }
  } catch (_) {}

  // 3. Pending action items containing person's name
  let pendingTasks = [];
  try {
    const all = await gatherPendingTasks();
    pendingTasks = all.filter(t => t.includes(cleanName) || t.includes(personName.trim()));
  } catch (_) {}

  // 4. Calendar events for next 7 days (single API call)
  let upcomingEvents = '없음';
  try {
    const token = await getAccessToken();
    if (token) {
      const start = new Date().toISOString();
      const end = new Date(Date.now() + 7 * 86400000).toISOString();
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&singleEvents=true&orderBy=startTime`;
      const calRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (calRes.ok) {
        const calData = await calRes.json();
        const relevant = (calData.items || []).filter(e => {
          const txt = (e.summary || '') + JSON.stringify(e.attendees || []);
          return txt.includes(cleanName) || txt.includes(personName.trim());
        });
        if (relevant.length) {
          upcomingEvents = relevant.map(e => {
            const t = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            return `- ${t} ${e.summary || '(무제)'}`;
          }).join('\n');
        }
      }
    }
  } catch (_) {}

  // 5. Gemini flash — 1 call (SR W3)
  const crmLine = personEntry
    ? `마지막 연락: ${personEntry.lastContact || '미확인'} / 상호작용 ${personEntry.interactionCount || 0}회`
    : '기록 없음';
  const prompt = [
    `${topic ? `미팅 주제: ${topic}\n` : ''}${personName}과의 미팅 준비 브리핑을 한국어로 작성해라.`,
    '(1) 인물 맥락 요약 (2) 미완료 액션 아이템 (3) 예정 일정 (4) 준비 시 주의사항 4개 섹션으로.',
    '', `[CRM] ${crmLine}`,
    `[관련 메모]\n${applyPrivacyShield(memoSnippets.join('\n\n') || '없음')}`,
    `[미완료 할일]\n${applyPrivacyShield(pendingTasks.join('\n') || '없음')}`,
    `[7일 내 일정]\n${upcomingEvents}`,
  ].join('\n');

  let briefing = '';
  try {
    const res = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (res.ok) {
      const data = await res.json();
      briefing = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
  } catch (e) { console.warn('[prepMeeting] Gemini failed:', e.message); }

  return { personName, topic, briefing, pendingTasks, upcomingEvents };
}

// Sub 2-2: get_followup_needed — entity_map persons + decay calc, Gemini 0 calls (SR W2)
async function getFollowupNeeded() {
  const entityMap = getEntityMap();
  if (!entityMap) return { followUps: [], note: 'entity_map not ready' };

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - FOLLOW_UP_DAYS);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const followUps = [];
  for (const [name, data] of Object.entries(entityMap.persons || {})) {
    const lc = data.lastContact || '';
    if (!lc || lc <= cutoffISO) {
      const daysSince = lc
        ? Math.floor((new Date(today) - new Date(lc)) / 86400000)
        : null;
      followUps.push({ name, lastContact: lc || '기록 없음', daysSince, interactionCount: data.interactionCount || 0 });
    }
  }
  followUps.sort((a, b) => {
    if (!a.lastContact || a.lastContact === '기록 없음') return 1;
    if (!b.lastContact || b.lastContact === '기록 없음') return -1;
    return a.lastContact < b.lastContact ? -1 : 1;
  });
  return { followUps, threshold: FOLLOW_UP_DAYS };
}

// Sub 2-1: get_person_context — entity note + interaction memos → Gemini flash summary
async function getPersonContext(name) {
  if (!name?.trim()) return { error: 'name required' };
  const cleanName = normalizeAttendeeName(name.trim());

  // 1. Find entity note (type:person or topic includes 'person') with levenshtein ≤1
  let entityContent = '';
  try {
    const files = fs.readdirSync(NOTES_DIR);
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
      const { frontmatter: fm } = parseFrontmatter(raw);
      const isPerson = fm.type === 'person' || (Array.isArray(fm.topic) && fm.topic.includes('person'));
      if (!isPerson) continue;
      const noteName = normalizeAttendeeName(fm.name || fm.title || f.replace('.md', ''));
      if (levenshtein(cleanName, noteName) <= 1) { entityContent = raw; break; }
    }
  } catch (_) {}

  // 2. Interaction memos: use entity_map sources for direct file lookups (avoid full scan)
  const interactions = [];
  try {
    const entityMap = getEntityMap();
    const personEntry = entityMap?.persons?.[cleanName]
      || Object.entries(entityMap?.persons || {}).find(([k]) => levenshtein(cleanName, normalizeAttendeeName(k)) <= 1)?.[1]
      || null;
    const sourceFiles = personEntry?.sources
      ? [...personEntry.sources].sort().reverse().slice(0, 10)
      : [];
    if (sourceFiles.length > 0) {
      for (const f of sourceFiles) {
        if (!f.endsWith('.md')) continue;
        try {
          const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
          const { frontmatter: fm, body } = parseFrontmatter(raw);
          interactions.push({ file: f, date: fm['날짜'] || fm.date || f.slice(0, 10), snippet: body.slice(0, 300) });
        } catch (_) {}
      }
    } else {
      // Fallback: full scan if entity_map has no sources
      const files = fs.readdirSync(NOTES_DIR).sort().reverse();
      for (const f of files) {
        if (!f.endsWith('.md') || interactions.length >= 10) continue;
        const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
        const { frontmatter: fm, body } = parseFrontmatter(raw);
        const combined = [
          ...(Array.isArray(fm.attendees) ? fm.attendees : []),
          ...(Array.isArray(fm.participants) ? fm.participants : [])
        ].join(' ');
        if (combined.includes(cleanName) || combined.includes(name.trim())) {
          interactions.push({ file: f, date: fm['날짜'] || fm.date || f.slice(0, 10), snippet: body.slice(0, 300) });
        }
      }
    }
  } catch (_) {}

  if (!entityContent && !interactions.length) {
    return { name, summary: `${name}에 대한 기록을 찾을 수 없습니다.`, recentInteractions: [], entityNote: false };
  }

  // 3. Gemini flash — core points summary
  let summary = '';
  try {
    const contextParts = [];
    if (entityContent) contextParts.push(`[인물 노트]\n${entityContent.slice(0, 800)}`);
    for (const i of interactions) contextParts.push(`[${i.date} 메모]\n${i.snippet}`);
    const safeContext = applyPrivacyShield(contextParts.join('\n\n---\n\n'));
    const prompt = `아래 메모들을 바탕으로 ${name}과의 관계에서 알아야 할 핵심 포인트를 3~5개로 한국어로 요약해라. 중요한 사실, 선호도, 주의사항 위주로.\n\n${safeContext}`;
    const res = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (res.ok) {
      const data = await res.json();
      summary = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
  } catch (e) { console.warn('[getPersonContext] Gemini failed:', e.message); }

  return { name, summary, recentInteractions: interactions.map(i => ({ date: i.date, file: i.file })), entityNote: !!entityContent };
}

// LRU cache for expandKeywords (max 50, TTL 10min)
const _kwCache = new Map(); // query -> { result, ts }
const KW_CACHE_TTL = 600000; // 10min
const KW_CACHE_MAX = 50;

// Expand query keywords using Gemini Flash for synonym/related term matching
async function expandKeywords(query) {
  const cached = _kwCache.get(query);
  if (cached && Date.now() - cached.ts < KW_CACHE_TTL) {
    console.log(`[Search] Keyword expansion cache hit: "${query}"`);
    return cached.result;
  }
  try {
    const res = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `"${query}"와 관련된 검색 키워드를 5개 생성해줘. 유의어, 관련어, 줄임말, 영어 포함. 쉼표로 구분된 키워드만 출력. 설명 없이.` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const expanded = text.split(/[,，\n]+/).map(s => s.trim().toLowerCase()).filter(s => s.length >= 2 && s.length <= 20);
    console.log(`[Search] Keyword expansion: "${query}" → [${expanded.join(', ')}]`);
    if (_kwCache.size >= KW_CACHE_MAX) {
      const firstKey = _kwCache.keys().next().value;
      _kwCache.delete(firstKey);
    }
    _kwCache.set(query, { result: expanded, ts: Date.now() });
    return expanded;
  } catch (e) {
    console.error('[Search] Keyword expansion failed:', e.message);
    return [];
  }
}

// 3-tier search: 1) VaultVoice 2) Other user folders 3) System config (keyword-gated)
// LRU content cache for executeSearch (max 200 entries, TTL 60s)
const _contentCache = new Map(); // filePath -> { content: string, ts: number }
const _CONTENT_CACHE_MAX = 200;
const _CONTENT_CACHE_TTL = 60000;

function _readFileWithCache(filePath) {
  const entry = _contentCache.get(filePath);
  if (entry && Date.now() - entry.ts < _CONTENT_CACHE_TTL) return entry.content;
  const content = fs.readFileSync(filePath, 'utf-8');
  if (_contentCache.size >= _CONTENT_CACHE_MAX) {
    const oldest = _contentCache.keys().next().value;
    _contentCache.delete(oldest);
  }
  _contentCache.set(filePath, { content, ts: Date.now() });
  return content;
}

async function executeSearch(query) {
  if (!query) return { result: 'No query provided.' };

  // Split query into keywords + expand with Gemini synonyms
  const baseKeywords = query.toLowerCase().split(/[\s,;/]+/).filter(k => k.length >= 1);
  const expanded = await expandKeywords(query);
  const keywords = [...new Set([...baseKeywords, ...expanded])];
  console.log(`[Search] Final keywords: [${keywords.join(', ')}]`);
  if (!keywords.length) return { result: 'No query provided.' };

  const scored = []; // { path, score, snippet }

  function scoreFile(filePath) {
    try {
      const content = _readFileWithCache(filePath).toLowerCase();
      let score = 0;

      // Exact full query match (highest weight)
      if (content.includes(query.toLowerCase())) score += 10;

      // Individual keyword matches
      for (const kw of keywords) {
        if (kw.length < 2) continue; // skip single chars
        const regex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        const hits = (content.match(regex) || []).length;
        if (hits > 0) score += Math.min(hits, 5); // cap per keyword
      }

      if (score > 0) {
        const relPath = path.relative(VAULT_PATH, filePath);
        // Extract snippet: prefer content after frontmatter (summary + body start)
        let snippet = '';
        const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
        const bodyStart = fmEnd >= 0 ? fmEnd + 3 : 0;
        const body = content.slice(bodyStart).trim();
        snippet = body.slice(0, 500).replace(/\n/g, ' ').trim();
        if (!snippet) snippet = content.slice(0, 500).replace(/\n/g, ' ');
        scored.push({ path: relPath, score, snippet });
      }
    } catch (e) { /* skip */ }
  }

  // Tier 1: VaultVoice notes
  if (fs.existsSync(NOTES_DIR)) {
    getAllMdFiles(NOTES_DIR).forEach(scoreFile);
  }

  // Tier 2: Other user folders
  try {
    const topDirs = fs.readdirSync(VAULT_PATH);
    for (const d of topDirs) {
      if (SEARCH_EXCLUDE_DIRS.has(d) || d === SYSTEM_FOLDER || d === VV_BASE || d.startsWith('.')) continue;
      const fullDir = path.join(VAULT_PATH, d);
      try { if (!fs.statSync(fullDir).isDirectory()) continue; } catch (e) { continue; }
      getAllMdFiles(fullDir).forEach(scoreFile);
    }
  } catch (e) { /* skip */ }

  // Tier 3: System config (keyword-gated)
  if (SYSTEM_KEYWORDS.test(query)) {
    const sysDir = path.join(VAULT_PATH, SYSTEM_FOLDER);
    if (fs.existsSync(sysDir)) getAllMdFiles(sysDir).forEach(scoreFile);
  }

  // Sort by score descending, take top 8
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 8);

  if (top.length === 0) return { result: '검색 결과가 없습니다.' };
  return { result: top.map(m => `- [${m.path}] (관련도:${m.score}) ${m.snippet}...`).join('\n\n') };
}

function executeReadDailyNote(dateStr) {
  const date = resolveDate(dateStr);
  const notes = getNotesForDate(date);
  if (notes.length > 0) {
    const combined = combineNotes(notes);
    return { result: combined.slice(0, 1500) };
  }
  return { result: `${date} 날짜의 노트가 없습니다.` };
}

function executeAddTodo(args) {
  const date = resolveDate(args.date);
  const priorityMap = { '높음': 'High', '보통': 'Medium', '낮음': 'Low' };
  const entry = formatTaskToMarkdown({ title: args.task, priority: priorityMap[args.priority] || null });
  createAtomicNote(date, 'todo', entry, ['todo']);
  return { result: `"${args.task}" 할일을 ${date}에 추가했습니다.` };
}

function executeAddMemo(args) {
  const date = resolveDate(args.date);
  const entry = `- ${args.content.trim()}`;
  createAtomicNote(date, 'memo', entry, []);
  return { result: `메모를 ${date}에 추가했습니다: "${args.content}"` };
}

async function executeGetCalendarEvents(args) {
  const token = await getAccessToken();
  if (!token) return { result: 'Google Calendar이 연결되지 않았습니다. 설정에서 연결해주세요.' };

  const start = args.startDate ? new Date(args.startDate + 'T00:00:00+09:00').toISOString() : new Date().toISOString();
  const end = args.endDate ? new Date(args.endDate + 'T23:59:59+09:00').toISOString() : new Date(Date.now() + 7 * 86400000).toISOString();
  try {
    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${start}&timeMax=${end}&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (calRes.ok) {
      const data = await calRes.json();
      const events = (data.items || []).map(ev =>
        `- [${ev.start.dateTime || ev.start.date}] ${ev.summary}`
      ).join('\n');
      return { result: events || 'No events found.' };
    }
    return { result: 'Error fetching calendar: ' + await calRes.text() };
  } catch (e) {
    return { result: 'Calendar error: ' + e.message };
  }
}

async function executeAddCalendarEvent(args) {
  const token = await getAccessToken();
  if (!token) return { result: 'Google Calendar이 연결되지 않았습니다.' };

  try {
    const startObj = args.isAllDay ? { date: args.startTime } : { dateTime: args.startTime };
    const endObj = args.isAllDay ? { date: args.endTime } : { dateTime: args.endTime };
    const calRes = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          summary: args.title,
          start: startObj,
          end: endObj
        })
      }
    );
    if (calRes.ok) {
      const data = await calRes.json();
      return { result: `일정 추가 완료: ${data.htmlLink}` };
    }
    return { result: 'Error adding event: ' + await calRes.text() };
  } catch (e) {
    return { result: 'Calendar error: ' + e.message };
  }
}

// ---- read_note (filesystem only) ----
function executeReadNote(args) {
  if (!args.path) return { result: '파일 경로를 입력해주세요.' };
  if (args.path.includes('..')) return { result: '잘못된 경로입니다.' };

  const MAX_READ = 4000;
  // Try as VaultVoice filename first, then as vault-relative path
  const candidates = [
    path.join(NOTES_DIR, args.path),
    path.join(VAULT_PATH, args.path)
  ];
  for (const fullPath of candidates) {
    try {
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const truncated = content.length > MAX_READ
          ? content.slice(0, MAX_READ) + `\n\n... (총 ${content.length}자 중 ${MAX_READ}자만 표시)`
          : content;
        return { result: truncated };
      }
    } catch (e) { /* try next */ }
  }
  return { result: `"${args.path}" 파일을 찾을 수 없습니다.` };
}

// ---- create_note (VaultVoice only, uses createAtomicNote) ----
function executeCreateNoteV2(args) {
  if (!args.title || !args.content) return { result: '제목과 내용이 필요합니다.' };
  const date = new Date().toISOString().slice(0, 10);
  const tags = args.tags || [];
  const filename = createAtomicNote(date, 'memo', args.content, tags);
  return { result: `"${filename}" 노트를 생성했습니다.` };
}

// ---- list_folder (filesystem only) ----
function executeListFolderV2(args) {
  const folder = (args.folder || '').replace(/\.\./g, '');
  const dirPath = path.join(VAULT_PATH, folder);
  try {
    if (!fs.existsSync(dirPath)) return { result: `"${folder}" 폴더를 찾을 수 없습니다.` };
    const items = fs.readdirSync(dirPath)
      .filter(f => !f.startsWith('.') && !SEARCH_EXCLUDE_DIRS.has(f))
      .slice(0, 30);
    if (!items.length) return { result: '폴더가 비어있습니다.' };
    const list = items.map(f => {
      const stat = fs.statSync(path.join(dirPath, f));
      return `- ${stat.isDirectory() ? '📁' : '📄'} ${f}`;
    }).join('\n');
    return { result: list };
  } catch (e) {
    return { result: '폴더 조회 실패: ' + e.message };
  }
}

// ---- get_tags ----
function executeGetTags() {
  const tagCount = {};
  if (!fs.existsSync(NOTES_DIR)) return { result: '태그가 없습니다.' };
  const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
      const { frontmatter } = parseFrontmatter(raw);
      for (const t of (frontmatter.tags || [])) {
        if (t !== 'vaultvoice') tagCount[t] = (tagCount[t] || 0) + 1;
      }
    } catch (e) { /* skip */ }
  }
  const sorted = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (!sorted.length) return { result: '태그가 없습니다.' };
  return { result: sorted.map(([tag, cnt]) => `#${tag} (${cnt})`).join(', ') };
}

// ---- get_recent_notes ----
function executeGetRecentNotes() {
  if (!fs.existsSync(NOTES_DIR)) return { result: '최근 노트가 없습니다.' };
  const now = new Date();
  const notes = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayNotes = getNotesForDate(dateStr);
    for (const n of dayNotes) {
      const type = n.frontmatter['유형'] || 'memo';
      const summary = (n.frontmatter.summary || n.body.slice(0, 80)).replace(/\n/g, ' ');
      notes.push(`- [${dateStr}] (${type}) ${summary}`);
    }
  }
  if (!notes.length) return { result: '최근 7일간 노트가 없습니다.' };
  return { result: notes.slice(0, 20).join('\n') };
}

// Build Gemini conversation history from client history array
function buildContents(history, currentMessage) {
  const contents = [];
  // Include up to 20 recent turns from history
  const trimmed = (history || []).slice(-20); // 20 items = 10 user+model pairs max
  for (const msg of trimmed) {
    if (msg.role === 'user' || msg.role === 'model') {
      // Apply Privacy Shield to history
      const maskedText = applyPrivacyShield(msg.text);
      contents.push({ role: msg.role, parts: [{ text: maskedText }] });
    }
  }
  // Add current user message with Privacy Shield
  const maskedCurrent = applyPrivacyShield(currentMessage);
  contents.push({ role: 'user', parts: [{ text: maskedCurrent }] });
  return contents;
}

app.post('/api/ai/chat', async (req, res) => {
  const { message, history } = req.body;

  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') {
    return res.status(503).json({ error: 'Gemini API key not configured' });
  }

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  // Pre-search: skip for short greetings/acknowledgements only
  const SKIP_PRESEARCH = /^(안녕|하이|반가워|고마워|감사|넵|응|좋아|알겠어|오키|ㅎㅎ|ㅇㅋ|ㅇㅇ|ㄱㄱ)[\s!?.]*$/i;
  const HAS_QUESTION_WORD = /[뭐어떻왜언어디누구몇]/;
  const trimmedMsg = message.trim();
  const skipPresearch = trimmedMsg.length < 10 && SKIP_PRESEARCH.test(trimmedMsg) && !HAS_QUESTION_WORD.test(trimmedMsg);

  let preSearchContext = '';
  if (!skipPresearch) {
    try {
      const preSearchResult = await executeSearch(trimmedMsg);
      if (preSearchResult.result && preSearchResult.result !== '검색 결과가 없습니다.') {
        preSearchContext = `\n\n[Pre-search results for user message]\n${preSearchResult.result}`;
        console.log('[Jarvis] Pre-search found results for:', trimmedMsg);
      }
    } catch (e) {
      console.error('[Jarvis] Pre-search failed:', e.message);
    }
  } else {
    console.log('[Jarvis] Pre-search skipped (greeting/ack):', trimmedMsg);
  }

  const systemPrompt = `You are Jarvis, a concise personal assistant for VaultVoice (Obsidian vault).
Current Date: ${todayStr} (${getDayName(todayStr)})

Vault structure:
- 99_vaultvoice/ — VaultVoice atomic notes (date_time_type.md format)
- 20_FPNA/, 80_Gmail/, gemini-scribe/ — user content folders
- 00_Claude_Control/ — coding rules, hooks, patterns (search ONLY when asked about rules/config/automation)

Available tools:
- search: Search notes (VV first → user folders → system config if topic matches)
- read_daily_note: Read all notes for a date ("today" or YYYY-MM-DD)
- read_note: Read a note by filename or path
- add_todo: Add a todo item
- add_memo: Add a memo
- get_calendar_events / add_calendar_event: Google Calendar
- create_note: Create a new VaultVoice note
- list_folder: List files in a folder
- get_tags: Get all VaultVoice tags
- get_recent_notes: Get recent 7 days of notes
- delete_note: Delete a VaultVoice note
- delete_todo / toggle_todo: Manage todo items
- summarize_note: AI summary of a specific note
- process_url: Fetch, summarize, and save a URL as a note
- add_comment: Add an AI-refined comment to a note
- get_person_context: 특정 인물의 맥락/관계 정보 요약 (인물 노트 + 상호작용 메모 종합)
- get_followup_needed: 오랫동안 연락 없는 인물 목록 (entity_map 기반, 빠른 응답)
- prep_meeting: 특정 인물 미팅 전 종합 브리핑 (인물 맥락 + 미완료 할일 + 7일 일정)
- summarize_topic: 특정 주제/키워드 관련 메모 핵심 불릿 요약 (시간 표현 지원)
- get_activity_summary: 최근 N일 전체 활동 패턴 분석 (카테고리/주제 분포)

CRM routing guide (SR W4):
- 인물 이름 + "정보/최근이야기/어떤사람/뭐좋아/관계" → get_person_context
- "팔로우업/연락 안 한 사람/오래된 사람" → get_followup_needed
- 인물 이름 + "미팅 준비/만나기 전/미팅 전" → prep_meeting (get_person_context 아님)
- 주제/키워드 + "요약/정리/어떻게 됐어" (시간 표현 포함) → summarize_topic
- "이번 주/달 뭐 했어/활동 요약/메모 패턴" → get_activity_summary

Few-shot examples:
- User: "박 차장님 최근 어떻게 지내?" → get_person_context(name="박 차장님")
- User: "김 이사님 미팅 준비해줘" → prep_meeting(personName="김 이사님")
- User: "이번 달 CAPEX 관련 뭐 메모했지?" → summarize_topic(topic="이번 달 CAPEX")

Rules:
- Answer in Korean. Be concise and friendly.
- When the user mentions ANY topic, ALWAYS use the search tool first to check if related notes exist. Use synonyms and related terms too (e.g. "헬스" → also search "운동", "줄넘기", "요가", "gym"; "공부" → also search "학습", "스터디").
- If pre-search results are provided below, use them to answer. Use read_note to get full details if needed.
- If search finds related notes, reference them in your answer. Suggest relevant content, alternatives, or related items from the notes.
- When adding items, default to today's date unless specified.
- Keep responses short — max 3-4 sentences for simple questions.
- You can now delete notes, toggle/delete todos, summarize individual notes, process URLs, and add comments to notes.
- When the user says "이거 삭제해줘" about a note, use delete_note.
- When the user shares a URL, use process_url to save and summarize it.
- When asked "이 노트 요약해줘", use summarize_note.
- When the user wants to add a thought/comment about a note, use add_comment. The comment will be AI-refined and appended.
- When the user asks you to explain a feature or what you can do, provide examples with each feature explanation.${preSearchContext}`;

  const contents = buildContents(history, message);
  const MAX_TOOL_ROUNDS = 3;

  try {
    let currentContents = contents;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      let geminiRes;
      try {
        geminiRes = await fetch(getGeminiApiUrl('pro'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: currentContents,
            tools: [{ function_declarations: JARVIS_TOOLS }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
          })
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!geminiRes.ok) {
        const errBody = await geminiRes.text().catch(() => 'Unknown error');
        console.error('Gemini API error:', geminiRes.status, errBody);
        return res.json({ reply: '죄송합니다. AI 서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.' });
      }

      const data = await geminiRes.json();
      const candidate = data.candidates?.[0];

      if (!candidate || !candidate.content) {
        return res.json({ reply: '죄송합니다. 응답을 생성하지 못했습니다.' });
      }

      const parts = candidate.content.parts || [];
      const fcPart = parts.find(p => p.functionCall);
      const textPart = parts.find(p => p.text);

      // No tool call → return text response
      if (!fcPart) {
        return res.json({ reply: textPart?.text || '죄송합니다. 이해하지 못했습니다.' });
      }

      // Tool call detected → execute and loop
      const fc = fcPart.functionCall;
      console.log(`[Jarvis] Tool call #${round + 1}: ${fc.name}`, JSON.stringify(fc.args));

      let toolResult;
      try {
        toolResult = await executeToolCall(fc.name, fc.args || {});
      } catch (e) {
        console.error(`[Jarvis] Tool execution error (${fc.name}):`, e.message);
        toolResult = { error: `도구 실행 중 오류가 발생했습니다: ${e.message}` };
      }

      // Append model's function call and the function response to contents
      currentContents = [
        ...currentContents,
        { role: 'model', parts: [{ functionCall: fc }] },
        { role: 'user', parts: [{ functionResponse: { name: fc.name, response: toolResult } }] }
      ];

      // Continue loop to get next response (may be another tool call or final text)
    }

    // If we exhausted tool rounds, return a fallback
    return res.json({ reply: '처리에 시간이 너무 오래 걸렸습니다. 질문을 더 간단하게 해주세요.' });

  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('Jarvis timeout');
      return res.json({ reply: '응답 시간이 초과되었습니다. 다시 시도해주세요.' });
    }
    console.error('Jarvis error:', e);
    res.json({ reply: '오류가 발생했습니다: ' + e.message });
  }
});

// ============================================================
// Phase 3: RAG (Knowledge Base)
// ============================================================
const VECTOR_FILE    = path.join(__dirname, '.vaultvoice', 'vectors.json');
const DATE_INDEX_FILE = path.join(__dirname, '.vaultvoice', 'date_index.json');

// V1 — vectors.json 전역 직렬화 큐 (동시 R/W 경쟁 방지)
const _vectorQueue = new PQueue({ concurrency: 1 });
// V2 — 인메모리 벡터 캐시 (readFileSync 매 요청 파싱 방지)
let _vectorCache = null;

async function getEmbedding(text) {
  if (!text || !text.trim()) return null;
  // Apply Privacy Shield before sending to external API
  const maskedText = applyPrivacyShield(text);
  // Limit text size for embedding model
  const chunk = maskedText.slice(0, 8000); 
  
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: chunk }] }
        })
      }
    );
    const data = await res.json();
    return data.embedding?.values || null;
  } catch (e) {
    console.error('Embedding error:', e.message);
    return null;
  }
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Re-index all notes (Heavy operation)
app.post('/api/rag/reindex', async (req, res) => {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') {
    return res.status(503).json({ error: 'Gemini API key not configured' });
  }

  try {
    const allFiles = getAllMdFilesCached();
    const vectors = [];
    let processed = 0;
    
    // Process recent 50 files first to be quick, or all if background job
    // For now, let's do max 50 recent files to avoid timeout
    const recentFiles = allFiles
      .map(f => ({ path: f, mtime: fs.statSync(f).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);

    for (const item of recentFiles) {
      const content = fs.readFileSync(item.path, 'utf-8');
      if (content.length < 10) continue; // Skip too short

      const embedding = await getEmbedding(content);
      if (embedding) {
        vectors.push({
          path: path.relative(VAULT_PATH, item.path),
          mtime: item.mtime,
          vec: embedding
        });
      }
      processed++;
      // Rate limit roughly
      await new Promise(r => setTimeout(r, 200)); 
    }

    await _vectorQueue.add(() => {
      fs.mkdirSync(path.dirname(VECTOR_FILE), { recursive: true });
      fs.writeFileSync(VECTOR_FILE, JSON.stringify(vectors), 'utf-8');
    });
    res.json({ success: true, count: vectors.length, message: `Indexed ${processed} recent notes.` });
  } catch (e) {
    console.error('Reindex error:', e);
    // Fail gracefully - user can still use text search
    res.json({ success: false, message: '지식 베이스 구축 실패 (일반 검색 모드로 동작합니다). 오류: ' + e.message });
  }
});

// Semantic Search API (with Text Fallback)
app.get('/api/rag/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Query required' });
  
  // 1. Try Vector Search
  if (fs.existsSync(VECTOR_FILE)) {
    try {
      const queryVec = await getEmbedding(q);
      if (queryVec) {
        const vectorData = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf-8'));
        const results = vectorData.map(item => ({
          path: item.path,
          score: cosineSimilarity(queryVec, item.vec)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

        const enriched = results.map(r => {
          const fullPath = path.join(VAULT_PATH, r.path);
          let preview = '';
          try { preview = fs.readFileSync(fullPath, 'utf-8').slice(0, 300).replace(/\n/g, ' '); } catch(e) {}
          return { ...r, preview };
        });
        return res.json({ results: enriched, mode: 'vector' });
      }
    } catch (e) { console.error('Vector search failed, falling back to text:', e.message); }
  }

  // 2. Fallback: Simple Text Search
  try {
    const allFiles = getAllMdFiles(VAULT_PATH);
    const matches = [];
    const qLower = q.toLowerCase();
    
    for (const f of allFiles) {
      if (matches.length >= 5) break;
      const content = fs.readFileSync(f, 'utf-8');
      if (content.toLowerCase().includes(qLower)) {
        matches.push({
          path: path.relative(VAULT_PATH, f),
          preview: content.slice(0, 300).replace(/\n/g, ' '),
          score: 1.0
        });
      }
    }
    res.json({ results: matches, mode: 'text' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Vault Q&A — POST /api/vault/ask
// ============================================================
app.post('/api/vault/ask', auth, async (req, res) => {
  const { question } = req.body || {};
  if (!question?.trim()) return res.status(400).json({ error: 'question required' });

  try {
    // 1. RAG Top-7 with keyword boost + time filter
    let sources = [];
    if (fs.existsSync(VECTOR_FILE) && GEMINI_API_KEY) {
      const queryVec = await getEmbedding(question);
      if (queryVec) {
        if (!_vectorCache && fs.existsSync(VECTOR_FILE)) {
          try { _vectorCache = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf-8')); } catch (_) {}
        }
        const vectorData = _vectorCache || [];
        const entityMap = getEntityMap();
        // 사전 필터: question에 실제로 포함된 entity만 추출 (map 내 O(n×k) 순회 방지)
        const matchedEntities = [
          ...Object.keys(entityMap.persons || {}),
          ...Object.keys(entityMap.projects || {})
        ].filter(name => question.includes(name));

        // Time filter: detect YYYY-MM or YYY년 MM월 in question
        const timeMatch = question.match(/(\d{4})[-년](\d{1,2})[월-]?/);
        const filterYear  = timeMatch ? timeMatch[1] : null;
        const filterMonth = timeMatch ? String(timeMatch[2]).padStart(2, '0') : null;

        sources = vectorData
          .map(item => {
            let score = cosineSimilarity(queryVec, item.vec);
            // +0.1 boost when matched entity name appears in source path
            if (matchedEntities.some(name => item.path.includes(name))) score += 0.1;
            return { ...item, score };
          })
          .filter(item => {
            if (!filterYear) return true;
            const m = item.path.match(/^(\d{4})-(\d{2})/);
            if (!m) return true;
            if (m[1] !== filterYear) return false;
            if (filterMonth && m[2] !== filterMonth) return false;
            return true;
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 7);
      }
    }

    // 2. Confidence (Sub 1-4)
    const confidence = sources.length >= 3 ? 'high' : sources.length >= 1 ? 'medium' : 'low';

    // 3. Build context + source metadata (병렬 읽기 — gcsfuse 블로킹 방지)
    const contextParts = [];
    const sourceMeta = [];
    const fileResults = await Promise.all(sources.map(async s => {
      const fullPath = path.resolve(VAULT_PATH, s.path);
      if (!fullPath.startsWith(path.resolve(VAULT_PATH) + path.sep) && fullPath !== path.resolve(VAULT_PATH)) return null;
      try {
        const raw = await fs.promises.readFile(fullPath, 'utf-8');
        return { s, raw };
      } catch (_) { return null; }
    }));
    for (const result of fileResults) {
      if (!result) continue;
      const { s, raw } = result;
      const { frontmatter: fm, body } = parseFrontmatter(raw);
      const title = fm.title || (Array.isArray(fm.aliases) ? fm.aliases[0] : null) || path.basename(s.path, '.md');
      const date  = fm['날짜'] || fm.date || (s.path.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
      const snippet = body.replace(/## [🧠⚠️⚡].*[\s\S]*?(?=##|$)/g, '').slice(0, 500);
      contextParts.push(`[출처: ${title}]\n${snippet}`);
      sourceMeta.push({ title, link: buildObsidianURI(s.path), date });
    }

    if (!contextParts.length) {
      return res.json({ answer: '정보를 찾을 수 없습니다.', sources: [], confidence: 'low' });
    }

    // 4. Gemini pro — anti-hallucination strict prompt
    const context = applyPrivacyShield(contextParts.join('\n\n---\n\n'));
    const safeQuestion = applyPrivacyShield(question);
    const prompt = [
      '다음 볼트 노트들을 기반으로 질문에 답해라.',
      '규칙: (1) 제공된 CONTEXT에 없는 정보는 추측하지 마라. (2) 확실하지 않으면 "기록에 없습니다"라고 말해라. (3) 답변에 출처 노트 제목을 인용해라.',
      '',
      `CONTEXT:\n${context}`,
      '',
      `질문: ${safeQuestion}`,
    ].join('\n');

    const gemRes = await fetch(getGeminiApiUrl('pro'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (!gemRes.ok) throw new Error(`Gemini HTTP ${gemRes.status}`);
    const gemData = await gemRes.json();
    const answer = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || '정보를 찾을 수 없습니다.';

    res.json({ answer, sources: sourceMeta, confidence });
  } catch (e) {
    console.warn('[VaultAsk] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Phase 4: Google Calendar Integration
// ============================================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/auth/google/callback`;
const GOOGLE_TOKEN_FILE = path.join(VAULT_PATH, '.google-token.json');

// Check authentication status (with actual token validation)
app.get('/api/calendar/status', async (req, res) => {
  const hasEnv = !!GOOGLE_CLIENT_ID && !!GOOGLE_CLIENT_SECRET;
  if (!fs.existsSync(GOOGLE_TOKEN_FILE)) {
    return res.json({ connected: false, hasEnv, reason: 'no_token' });
  }
  try {
    const token = await getAccessToken();
    if (!token) {
      return res.json({ connected: false, hasEnv, reason: 'token_expired' });
    }
    // Quick validation: hit a lightweight Calendar API endpoint
    const testRes = await fetch('https://www.googleapis.com/calendar/v3/colors', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (testRes.ok) {
      return res.json({ connected: true, hasEnv });
    }
    return res.json({ connected: false, hasEnv, reason: 'token_invalid' });
  } catch (e) {
    return res.json({ connected: false, hasEnv, reason: 'error' });
  }
});

// Start OAuth flow
app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.send(`
      <h1>설정 오류</h1>
      <p>GOOGLE_CLIENT_ID가 설정되지 않았습니다.</p>
      <p>.env 파일에 구글 클라우드 콘솔에서 발급받은 ID와 Secret을 입력해주세요.</p>
      <pre>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
      </pre>
    `);
  }
  
  const scope = 'https://www.googleapis.com/auth/calendar';
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;
  
  res.redirect(url);
});

// OAuth callback
app.get('/api/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    
    if (!tokenRes.ok) throw new Error(await tokenRes.text());
    
    const tokens = await tokenRes.json();
    // Save tokens with expiry timestamp
    tokens.expiry_date = Date.now() + (tokens.expires_in * 1000);
    fs.writeFileSync(GOOGLE_TOKEN_FILE, JSON.stringify(tokens), 'utf-8');
    
    res.send('<h1>Google Calendar Connected!</h1><p>You can close this window now.</p><script>setTimeout(() => window.close(), 3000);</script>');
  } catch (e) {
    console.error('OAuth error:', e);
    res.status(500).send('Authentication failed: ' + e.message);
  }
});

// Helper: Get valid access token (with refresh)
async function getAccessToken() {
  if (!fs.existsSync(GOOGLE_TOKEN_FILE)) return null;

  let tokens = JSON.parse(fs.readFileSync(GOOGLE_TOKEN_FILE, 'utf-8'));

  // Check if token is expired (with 5 min buffer)
  const isExpired = tokens.expiry_date && Date.now() > (tokens.expiry_date - 300000);

  if (isExpired && tokens.refresh_token) {
    try {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: tokens.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      if (refreshRes.ok) {
        const newTokens = await refreshRes.json();
        tokens.access_token = newTokens.access_token;
        tokens.expiry_date = Date.now() + (newTokens.expires_in * 1000);
        fs.writeFileSync(GOOGLE_TOKEN_FILE, JSON.stringify(tokens), 'utf-8');
        console.log('[Calendar] Token refreshed');
      } else {
        const errText = await refreshRes.text();
        console.error('[Calendar] Token refresh failed:', errText);
        // Detect revoked or invalid grant — delete stale token file
        if (errText.includes('invalid_grant') || errText.includes('Token has been revoked')) {
          console.log('[Calendar] Token revoked — removing token file');
          try { fs.unlinkSync(GOOGLE_TOKEN_FILE); } catch (_) {}
        }
        return null;
      }
    } catch (e) {
      console.error('[Calendar] Token refresh error:', e.message);
      return null;
    }
  }

  return tokens.access_token;
}

// Get Events
app.get('/api/calendar/events', async (req, res) => {
  const token = await getAccessToken();
  if (!token) return res.status(401).json({ error: 'Not connected' });
  
  const start = req.query.start || new Date().toISOString();
  const end = req.query.end || new Date(Date.now() + 7 * 86400000).toISOString(); // Default next 7 days

  try {
    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${start}&timeMax=${end}&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    if (!calRes.ok) {
      // If 401, maybe token expired. For now just fail.
      return res.status(calRes.status).json({ error: await calRes.text() });
    }
    
    const data = await calRes.json();
    const events = (data.items || []).map(ev => ({
      summary: ev.summary,
      start: ev.start.dateTime || ev.start.date,
      end: ev.end.dateTime || ev.end.date,
      id: ev.id
    }));
    
    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add Event
app.post('/api/calendar/add', async (req, res) => {
  const token = await getAccessToken();
  if (!token) return res.status(401).json({ error: 'Not connected' });

  const { summary, start, end, isAllDay } = req.body;

  try {
    let startObj, endObj;
    if (isAllDay) {
      startObj = { date: start };
      // Google Calendar all-day end date must be strictly after start date
      if (start === end) {
        const d = new Date(start + 'T00:00:00');
        d.setDate(d.getDate() + 1);
        endObj = { date: d.toISOString().slice(0, 10) };
      } else {
        endObj = { date: end };
      }
    } else {
      startObj = { dateTime: start };
      endObj = { dateTime: end };
    }

    const calRes = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          summary,
          start: startObj,
          end: endObj,
          description: 'VaultVoice에서 등록된 일정입니다.'
        })
      }
    );

    if (!calRes.ok) return res.status(calRes.status).json({ error: await calRes.text() });
    
    const data = await calRes.json();
    res.json({ success: true, event: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Full-text search across entire vault
// ============================================================

// ---- File index cache (5-minute TTL) ----
let _mdFileCache = null;
let _mdFileCacheTime = 0;
const MD_FILE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getAllMdFilesCached() {
  const now = Date.now();
  if (_mdFileCache && (now - _mdFileCacheTime) < MD_FILE_CACHE_TTL) {
    console.log('[CACHE] File index cache hit (%d files)', _mdFileCache.length);
    return _mdFileCache;
  }
  console.log('[CACHE] File index cache miss — scanning vault...');
  _mdFileCache = getAllMdFiles(VAULT_PATH);
  _mdFileCacheTime = now;
  console.log('[CACHE] Indexed %d .md files', _mdFileCache.length);
  return _mdFileCache;
}

function invalidateFileCache() {
  _mdFileCache = null;
  _mdFileCacheTime = 0;
}

function getAllMdFiles(dir, fileList) {
  fileList = fileList || [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    // Skip hidden folders, node_modules, .git, etc.
    if (item.startsWith('.') || item === 'node_modules' || item === '00_Claude_Control') continue;
    const fullPath = path.join(dir, item);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        getAllMdFiles(fullPath, fileList);
      } else if (item.endsWith('.md')) {
        fileList.push(fullPath);
      }
    } catch (e) { /* skip inaccessible */ }
  }
  return fileList;
}

// filterType: '_voice.md' | '_image.md' | '_url.md' | '_memo.md' | '_todo.md'
// filterDate: 7 | 30 | 90 (days)
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const scope = req.query.scope || 'daily'; // 'daily' or 'all'
  const filterType = req.query.filterType || '';
  const filterDate = parseInt(req.query.filterDate) || 0;
  if (!q) return res.status(400).json({ error: 'Query required' });

  let allFiles;
  if (scope === 'all') {
    allFiles = getAllMdFilesCached();
  } else {
    if (!fs.existsSync(NOTES_DIR)) return res.json({ results: [], query: q, total: 0 });
    allFiles = fs.readdirSync(NOTES_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(NOTES_DIR, f));
  }

  // Apply filterDate: keep only files whose filename date is within N days
  if (filterDate > 0) {
    const cutoff = new Date(Date.now() - filterDate * 86400000).toISOString().slice(0, 10);
    allFiles = allFiles.filter(f => {
      const m = path.basename(f).match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] >= cutoff : true;
    });
  }

  // Apply filterType: keep only files matching _type.md or type.md suffix
  if (filterType) {
    const suffix1 = `_${filterType}.md`;
    const suffix2 = `${filterType}.md`;
    allFiles = allFiles.filter(f => {
      const base = path.basename(f);
      return base.endsWith(suffix1) || base.endsWith(suffix2);
    });
  }

  const results = [];
  const MAX_RESULTS = 50;

  // Read files in parallel batches (non-blocking event loop)
  const BATCH_SIZE = 20;
  for (let i = 0; i < allFiles.length && results.length < MAX_RESULTS; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const reads = await Promise.allSettled(
      batch.map(fp => fs.promises.readFile(fp, 'utf-8').then(raw => ({ fp, raw })))
    );
    for (const r of reads) {
      if (results.length >= MAX_RESULTS) break;
      if (r.status !== 'fulfilled') continue;
      const { fp, raw } = r.value;
      if (raw.toLowerCase().indexOf(q) === -1) continue;

      const lines = raw.split('\n');
      const matches = [];
      for (let j = 0; j < lines.length; j++) {
        if (lines[j].toLowerCase().indexOf(q) >= 0) {
          matches.push({ line: j, text: lines[j].trim() });
          if (matches.length >= 3) break;
        }
      }
      if (matches.length > 0) {
        const relPath = path.relative(VAULT_PATH, fp).replace(/\\/g, '/');
        const name = path.basename(fp, '.md');
        results.push({ date: name, path: relPath, matches });
      }
    }
  }

  res.json({ results, query: q, total: results.length });
});

// ============================================================
// AI-powered semantic search
// ============================================================
app.get('/api/search/ai', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query required' });

  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') {
    return res.status(503).json({ error: 'Gemini API key not configured' });
  }

  if (!fs.existsSync(NOTES_DIR)) {
    return res.json({ results: [], query: q });
  }

  // Step 1: Ask Gemini to expand search keywords
  try {
    const geminiRes = await fetch(getGeminiApiUrl('lite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `사용자가 일일노트에서 "${q}"를 검색하려 합니다. 이 의도와 관련된 한국어 검색 키워드를 10~20개 생성하세요. 유의어, 관련어, 줄임말, 비슷한 표현을 포함하세요. JSON 배열로만 답변하세요. 예: ["키워드1", "키워드2"]` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 256 }
      })
    });

    let keywords = [q];
    if (geminiRes.ok) {
      const data = await geminiRes.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          keywords = [...new Set([q, ...parsed.map(k => k.toLowerCase())])];
        }
      } catch (e) { /* use original query */ }
    }

    // Step 2: Search with expanded keywords
    const scope = req.query.scope || 'daily';
    let allFiles;
    if (scope === 'all') {
      allFiles = getAllMdFilesCached();
    } else {
      if (!fs.existsSync(NOTES_DIR)) return res.json({ results: [], query: q, keywords, total: 0 });
      allFiles = fs.readdirSync(NOTES_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => path.join(NOTES_DIR, f));
    }
    const MAX_RESULTS = 50;
    const BATCH_SIZE = 20;

    async function processFileBatch(batch) {
      return Promise.allSettled(batch.map(async filePath => {
        let raw;
        try { raw = await fs.promises.readFile(filePath, 'utf-8'); } catch (e) { return null; }
        const lower = raw.toLowerCase();
        const matchedKeywords = keywords.filter(k => lower.indexOf(k.toLowerCase()) >= 0);
        if (matchedKeywords.length === 0) return null;
        const lines = raw.split('\n');
        const matches = [];
        for (let i = 0; i < lines.length; i++) {
          const lineLower = lines[i].toLowerCase();
          const lineMatches = matchedKeywords.filter(k => lineLower.indexOf(k.toLowerCase()) >= 0);
          if (lineMatches.length > 0) {
            matches.push({ line: i, text: lines[i].trim(), keywords: lineMatches });
            if (matches.length >= 5) break;
          }
        }
        if (matches.length === 0) return null;
        const relPath = path.relative(VAULT_PATH, filePath).replace(/\\/g, '/');
        const name = path.basename(filePath, '.md');
        return { date: name, path: relPath, matches, relevance: matchedKeywords.length };
      }));
    }

    const results = [];
    for (let i = 0; i < allFiles.length && results.length < MAX_RESULTS; i += BATCH_SIZE) {
      const batch = allFiles.slice(i, i + BATCH_SIZE);
      const settled = await processFileBatch(batch);
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
        if (results.length >= MAX_RESULTS) break;
      }
    }

    // Sort by relevance (more keyword matches = more relevant)
    results.sort((a, b) => b.relevance - a.relevance);

    res.json({ results, query: q, keywords, total: results.length });
  } catch (e) {
    console.error('AI search error:', e);
    res.status(500).json({ error: 'AI search failed: ' + e.message });
  }
});

// ============================================================
// Get tag list (frequency sorted)
// ============================================================
app.get('/api/tags', (req, res) => {
  const hit = noteCache.getTagCount();
  if (hit) return res.json({ tags: Object.entries(hit).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })) });

  if (!fs.existsSync(NOTES_DIR)) {
    return res.json({ tags: [] });
  }

  const tagCount = {};
  const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 100);

  for (const file of files) {
    const raw = fs.readFileSync(path.join(NOTES_DIR, file), 'utf-8');
    const { frontmatter } = parseFrontmatter(raw);
    if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
      for (const tag of frontmatter.tags) {
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      }
    }
  }

  noteCache.setTagCount(tagCount);
  const tags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  res.json({ tags });
});

// ============================================================
// Recent notes (last 7 days)
// ============================================================
app.get('/api/notes/recent', (req, res) => {
  if (!fs.existsSync(NOTES_DIR)) {
    return res.json({ notes: [] });
  }

  // Single scan: group filenames by date prefix
  const dateMap = {};
  for (const f of fs.readdirSync(NOTES_DIR)) {
    if (!f.endsWith('.md')) continue;
    const m = f.match(/^(\d{4}-\d{2}-\d{2})_/);
    if (m) {
      const date = m[1];
      if (!dateMap[date]) dateMap[date] = [];
      dateMap[date].push(f);
    }
  }

  const notes = Object.entries(dateMap)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 7)
    .map(([date, dateFiles]) => {
      // Use cached notes for this date if available
      const cached = noteCache.getNotesForDate(date);
      if (cached) {
        const allTags = new Set();
        const previews = [];
        for (const note of cached) {
          (note.frontmatter.tags || []).forEach(t => allTags.add(t));
          const lines = note.body.split('\n').filter(l => l.trim());
          if (lines.length > 0) previews.push(lines[0]);
        }
        return { date, tags: [...allTags], preview: previews.join(' ').slice(0, 120), noteCount: cached.length };
      }
      const allTags = new Set();
      const previews = [];
      for (const file of dateFiles.sort()) {
        const raw = fs.readFileSync(path.join(NOTES_DIR, file), 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        (frontmatter.tags || []).forEach(t => allTags.add(t));
        const lines = body.split('\n').filter(l => l.trim());
        if (lines.length > 0) previews.push(lines[0]);
      }
      return { date, tags: [...allTags], preview: previews.join(' ').slice(0, 120), noteCount: dateFiles.length };
    });

  res.json({ notes });
});

// ============================================================
// Helpers
// ============================================================
function parseFrontmatter(content) {
  try {
    const file = matter(content);
    return { frontmatter: file.data, body: file.content };
  } catch (e) {
    return { frontmatter: {}, body: content };
  }
}

function serializeFrontmatter(fm) {
  // Remove undefined/null values; keep empty strings and arrays
  const clean = Object.fromEntries(
    Object.entries(fm).filter(([, v]) => v !== undefined && v !== null)
  );
  // matter.stringify('', ...) may append extra trailing newline on empty body
  // Normalize to single trailing newline so body concatenation produces one blank line
  return matter.stringify('', clean).replace(/\n+$/, '\n');
}

// ============================================================
// Pipeline Queue — filePath-scoped serialization via p-queue
// ============================================================
const _pipelineQueues = new Map();

function getPipelineQueue(filePath) {
  if (!_pipelineQueues.has(filePath)) {
    const q = new PQueue({ concurrency: 1 });
    q.on('idle', () => _pipelineQueues.delete(filePath));
    _pipelineQueues.set(filePath, q);
  }
  return _pipelineQueues.get(filePath);
}

async function runPipeline(filePath, stages) {
  return getPipelineQueue(filePath).add(async () => {
    for (const stage of stages) {
      try { await stage(filePath); }
      catch (e) { console.warn(`[Pipeline] ${stage.name} failed:`, e.message); }
    }
  });
}

/**
 * Ensures metadata from AI has all required fields with safe defaults, preserving other fields.
 */
function sanitizeMetadata(raw) {
  if (!raw) return { category: '미분류', topic: [], tasks: [] };
  return {
    ...raw,
    category: raw.category || '미분류',
    topic: Array.isArray(raw.topic) ? raw.topic : [],
    tasks: Array.isArray(raw.tasks) ? raw.tasks : []
  };
}

function getDayName(dateStr) {
  const days = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const d = new Date(dateStr + 'T00:00:00');
  return days[d.getDay()];
}

// Create an atomic note file (one entry = one file)
// type: voice|image|url|memo|todo (replaces old 'section' param)
// extraFrontmatter: additional key-value pairs to merge into frontmatter
function createAtomicNote(date, type, entry, tags, extraFrontmatter = {}) {
  if (!fs.existsSync(NOTES_DIR)) {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
  }

  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const timeDisplay = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const filename = `${date}_${timeStr}_${type}.md`;
  const filePath = path.join(NOTES_DIR, filename);

  const allTags = ['vaultvoice', ...tags.filter(t => t !== 'vaultvoice')];
  const unique = [...new Set(allTags)];

  // Insert wiki-links into body using title cache
  const linkedEntry = insertWikiLinks(entry, filename);

  const todayISO = now.toISOString().slice(0, 10);
  const fm = {
    '날짜': date,
    '시간': timeDisplay,
    'source_type': type,
    '유형': type,
    'category': '',
    'status': 'fleeting',
    'tags': unique,
    'topic': [],
    'title': '',
    'aliases': [],
    'summary': '',
    'type': '',
    'mood': '',
    'priority': '',
    'area': '',
    'project': '',
    'analyzed_lenses': [],
    'created': todayISO,
    'updated': todayISO,
    'attendees': [],
    'participants': [],
    'projects': [],
    'places': [],
    ...extraFrontmatter
  };
  const body = `\n${linkedEntry}\n`;

  const content = serializeFrontmatter(fm) + body;
  fs.writeFileSync(filePath, content, 'utf-8');
  invalidateFileCache();
  noteCache.invalidate(filename);

  // Async AI pipeline — each stage independent, no cascade failures
  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'your_key_here') {
    let nerResultForContext = null; // Sub 2-3: closure — nerStage → contextStage 공유
    runPipeline(filePath, [
      async function generateMeta(fp) {
        // Use closure `content` (just written) — skip re-read
        const { frontmatter: fm2 } = parseFrontmatter(content);
        if (fm2.title) return;
        const meta = await generateNoteMeta(content);
        if (meta) {
          injectMetaToFrontmatter(fp, meta);
          if (meta.title) { titleCache[filename] = meta.title; _compiledRegexMap.set(filename, _buildRegex(meta.title)); }
          console.log(`[Meta] Generated for ${filename}: ${meta.title}`);
        }
      },
      async function nerStage(fp) {
        // SR 지시: linkedEntry(원본 body)를 클로저 캡처 — 파일 재읽기 금지
        const result = await indexNote(fp, linkedEntry);
        if (result && result.nerResult && result.nerResult.entities) {
          updateEntityFrontmatter(fp, result.nerResult.entities);
          nerResultForContext = result.nerResult; // Sub 2-3: contextStage에서 사용
        }
      },
      async function contextStage(fp) {
        if (!nerResultForContext?.entities) return;
        // SR R1: 80자 미만 짧은 메모 → AI 호출 방지
        if (linkedEntry.trim().length < 80) return;
        const facts = await extractEntityContext(linkedEntry, nerResultForContext.entities);
        for (const { entity, fact, category } of facts) {
          await appendEntityContext(entity, fact, category, VAULT_PATH);
        }
      },
      async function perspectiveStage(fp) {
        const raw = fs.readFileSync(fp, 'utf-8');
        await applyPerspectiveFilters(fp, raw);
      },
      async function actionItemsStage(fp) {
        const raw = fs.readFileSync(fp, 'utf-8');
        const tasks = await extractActionItems(fp, raw);
        if (tasks && tasks.length > 0) {
          syncToCalendarDraft(tasks).catch(e => console.warn('[Calendar] Sync failed:', e.message));
          const PRIORITY_ORDER = { P1: 0, High: 0, P2: 1, Medium: 1, P3: 2, Low: 2 };
          const topTask = tasks.reduce((best, t) =>
            t.priority && (PRIORITY_ORDER[t.priority] ?? 99) < (PRIORITY_ORDER[best?.priority] ?? 99) ? t : best, null);
          if (topTask?.priority) {
            const priorityLabel = { P1: 'High', P2: 'Medium', P3: 'Low' }[topTask.priority] || topTask.priority;
            const cur = fs.readFileSync(fp, 'utf-8');
            const { frontmatter: fm2, body: b2 } = parseFrontmatter(cur);
            fm2.priority = priorityLabel;
            fs.writeFileSync(fp, serializeFrontmatter(fm2) + b2, 'utf-8');
          }
        }
      },
      async function consistencyStage(fp) {
        const raw = fs.readFileSync(fp, 'utf-8');
        await checkConsistency(fp, raw);
      },
      async function tldrStage(fp) {
        // 원본 본문 길이 판정: linkedEntry 클로저 (AI 섹션 오염 없음)
        if (linkedEntry.trim().length < 100) return;
        const raw = fs.readFileSync(fp, 'utf-8');
        const { frontmatter: fm, body } = parseFrontmatter(raw);
        if (!fm.summary?.trim()) return;
        if (body.includes('> [!abstract]')) return; // 재삽입 루프 방지
        const callout = `\n> [!abstract] 요약\n> ${fm.summary}\n\n`;
        fs.writeFileSync(fp, serializeFrontmatter(fm) + callout + body.trimStart(), 'utf-8');
      },
      async function ragStage(fp) {
        const raw = fs.readFileSync(fp, 'utf-8');
        const { frontmatter: fm, body: finalBody } = parseFrontmatter(raw);
        fm.updated = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(fp, serializeFrontmatter(fm) + finalBody, 'utf-8');
        await updateVectorIndex(fp, finalBody);
        noteCache.invalidate(path.basename(fp));
      }
    ]).catch(e => console.warn('[Pipeline] Unexpected error:', e.message));

    // Sub 4-3: Date Conflict — setImmediate, 파이프라인 외부 비동기 실행
    setImmediate(() => detectDateConflicts(filePath, linkedEntry)
      .catch(e => console.warn('[DateConflict]', e.message)));
  }

  // Step 8: DAILY_NOTE_EMBED opt-in — append ![[embed]] to daily note
  if (DAILY_NOTE_EMBED && DAILY_NOTE_PATH) {
    setImmediate(() => {
      try {
        const dailyFile = path.join(DAILY_NOTE_PATH, `${date}.md`);
        const embedLine = `\n![[${filename}]]`;
        if (fs.existsSync(dailyFile)) {
          fs.appendFileSync(dailyFile, embedLine, 'utf-8');
        } else {
          fs.mkdirSync(DAILY_NOTE_PATH, { recursive: true });
          fs.writeFileSync(dailyFile, `# ${date}${embedLine}`, 'utf-8');
        }
      } catch (e) { console.warn('[Embed] Daily note embed failed:', e.message); }
    });
  }

  return { created: true, filename, filePath };
}

// Task emoji helpers (Obsidian Tasks plugin compatibility)
const PRIORITY_EMOJI = { P1: '⏫', High: '⏫', P2: '🔼', Medium: '🔼', P3: '🔽', Low: '🔽' };

function formatTaskToMarkdown(task) {
  let line = `- [ ] ${task.title}`;
  if (task.due) line += ` 📅${task.due}`;
  if (task.priority && PRIORITY_EMOJI[task.priority]) line += ` ${PRIORITY_EMOJI[task.priority]}`;
  return line;
}

// Parse task from markdown — supports emoji format and legacy [due:: date] format
function parseTaskFromMarkdown(line) {
  const emojiDue = line.match(/📅(\d{4}-\d{2}-\d{2})/);
  const emojiSched = line.match(/⏳(\d{4}-\d{2}-\d{2})/);
  const legacyDue = line.match(/\[due::\s*(\d{4}-\d{2}-\d{2})\]/);
  const due = (emojiDue || emojiSched || legacyDue)?.[1] || null;
  const priority = line.includes('⏫') ? 'High' : line.includes('🔼') ? 'Medium' : line.includes('🔽') ? 'Low' : null;
  const titleMatch = line.match(/^-\s+\[[ x]\]\s+(.+?)(?:\s+(?:📅|⏳)\d{4}|$)/);
  const title = titleMatch ? titleMatch[1].replace(/\[(?:due|priority)::[^\]]+\]/g, '').trim() : null;
  if (!title) return null;
  return { title, due, priority };
}

async function syncToCalendarDraft(tasks) {
  const token = await getAccessToken();
  if (!token) return;

  for (const task of tasks) {
    if (!task.due) continue;
    
    // Check if task has time (e.g. "14:00" or "오후 2시")
    let startTime = '';
    let endTime = '';
    let isAllDay = true;

    // Simple heuristic: if title contains time-like string
    const timeMatch = task.title.match(/(\d{1,2})시(\d{1,2})?분?|(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      let h, m;
      if (timeMatch[3]) { h = parseInt(timeMatch[3]); m = parseInt(timeMatch[4]); }
      else { h = parseInt(timeMatch[1]); m = parseInt(timeMatch[2] || '0'); }
      
      // Afternoon adjustment
      if (task.title.includes('오후') && h < 12) h += 12;
      
      const start = new Date(task.due + 'T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00+09:00');
      startTime = start.toISOString();
      const end = new Date(start.getTime() + 3600000); // +1 hour
      endTime = end.toISOString();
      isAllDay = false;
    } else {
      // For all-day events, end date must be the next day
      const d = new Date(task.due + 'T00:00:00');
      startTime = task.due;
      d.setDate(d.getDate() + 1);
      endTime = d.toISOString().slice(0, 10);
      isAllDay = true;
    }

    try {
      const startObj = isAllDay ? { date: startTime } : { dateTime: startTime };
      const endObj = isAllDay ? { date: endTime } : { dateTime: endTime };
      
      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: `[PIE 초안] ${task.title}`,
          description: `VaultVoice에서 자동으로 추출된 일정 초안입니다.\n원문: ${task.title}`,
          start: startObj,
          end: endObj,
          status: 'tentative', // Draft state
          colorId: '5' // Yellow/Banana color for drafts
        })
      });
      if (res.ok) console.log(`[Calendar] Draft synced: ${task.title}`);
    } catch (e) { console.warn(`[Calendar] Failed to sync task: ${task.title}`, e.message); }
  }
}

async function updateVectorIndex(filePath, body) {
  if (!GEMINI_API_KEY || body.length < 10) return;
  try {
    const embedding = await getEmbedding(body);
    if (!embedding) return;

    const relPath = path.relative(VAULT_PATH, filePath).replace(/\\/g, '/');
    const mtime = fs.statSync(filePath).mtime.getTime();

    await _vectorQueue.add(() => {
      let vectors;
      if (_vectorCache !== null) {
        vectors = _vectorCache; // use in-memory cache — skip readFileSync
      } else if (fs.existsSync(VECTOR_FILE)) {
        try { vectors = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf-8')); } catch (e) { vectors = []; }
      } else {
        vectors = [];
      }
      const entry = { path: relPath, mtime, vec: embedding };
      const idx = vectors.findIndex(v => v.path === relPath);
      if (idx >= 0) vectors[idx] = entry;
      else vectors.push(entry);
      if (vectors.length > 1000) vectors = vectors.slice(-1000);
      fs.mkdirSync(path.dirname(VECTOR_FILE), { recursive: true });
      fs.writeFileSync(VECTOR_FILE, JSON.stringify(vectors), 'utf-8');
      _vectorCache = vectors; // 캐시 갱신
    });
    console.log(`[RAG] Indexed ${path.basename(filePath)}`);
  } catch (e) {
    console.error('[RAG] Index update failed:', e.message);
  }
}

const PRIVACY_KEYWORDS = (process.env.PRIVACY_KEYWORDS || '').split(',').map(k => k.trim()).filter(Boolean);
const PRIVACY_REGEXES = PRIVACY_KEYWORDS.map(kw => new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));

function applyPrivacyShield(text) {
  if (!text || !PRIVACY_REGEXES.length) return text;
  let masked = text;
  for (const regex of PRIVACY_REGEXES) {
    masked = masked.replace(regex, '***');
  }
  return masked;
}

async function checkConsistency(filePath, raw) {
  const { frontmatter, body } = parseFrontmatter(raw);
  if (body.length < 30 || body.includes('## ⚠️ Collision Check')) return;

  // 1. Find related context via RAG
  let context = '';
  try {
    const queryVec = await getEmbedding(body);
    const vectorData = _vectorCache !== null ? _vectorCache
      : (fs.existsSync(VECTOR_FILE) ? JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf-8')) : null);
    if (queryVec && vectorData) {
      const related = vectorData
        .map(item => ({ path: item.path, score: cosineSimilarity(queryVec, item.vec) }))
        .filter(item => !filePath.includes(item.path)) // exclude current file
        .filter(r => r.score > 0.65) // Sub 4-4 보너스: 임계값 — Gemini 호출 50% 절감
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      
      for (const item of related) {
        try {
          const fullPath = path.join(VAULT_PATH, item.path);
          const content = fs.readFileSync(fullPath, 'utf-8');
          context += `\n[관련 과거 기록: ${item.path}]\n${content.slice(0, 1000)}\n`;
        } catch (e) {}
      }
    }
  } catch (e) { console.warn('[Consistency] RAG search failed:', e.message); }

  if (!context) return;

  // 2. Apply Privacy Shield
  const maskedBody = applyPrivacyShield(body);
  const maskedContext = applyPrivacyShield(context);

  // 3. Detect Contradictions via Gemini
  const prompt = `당신은 사용자의 기록 일관성과 삶의 균형을 감시하는 **'PIE Consistency Auditor v2.0'**입니다.
당신의 페르소나는 **'재무 전문가급의 논리력과 두 아이 아빠의 세심함을 가진 비서'**입니다.

새로 작성된 메모와 과거의 관련 기록들을 비교하여 다음 사항들을 분석하세요:

1. **의사결정 모순**: 새로운 결정이 과거의 원칙이나 확정된 방침(예: 채용 중단, 예산 삭감 등)과 정면으로 배치되는가?
2. **복합 일정 충돌 (Collision)**: 
   - 단순 시간 중복뿐만 아니라, 물리적 이동 가능성이나 에너지 레벨을 고려하세요.
   - 특히 **'생활 맥락(아파트 정전, 아이 하원, 와이프 부탁 등)'**이 업무 일정과 충돌하여 사용자가 곤란해질 상황을 먼저 찾아내세요.
3. **재무적 리스크**: 과거에 언급된 지표(CM1 마진 등)나 계약 조건이 이번 메모의 내용으로 인해 위협받는가?
4. **크로스 도메인 체크**: 과거에 효과적이라고 메모했던 전략(예: 게임에서의 리소스 배분 등)과 상충되는 비효율적 계획이 있는가?

출력 형식:
- 모순이나 충돌이 발견된 경우에만 '## ⚠️ Collision Check' 섹션을 생성하여 내용을 설명하세요.
- 발견되지 않았다면 "NONE"이라고만 답하세요.
- **재무 전문가답게 날카롭고, 아빠답게 사려 깊은 조언**을 한국어로 작성하세요.
- 단순히 "충돌입니다"라고 하지 말고, "XX일 XX시의 YY 일정과 충돌하여 ZZ 문제가 예상됩니다"와 같이 구체적으로 지적하세요.

새 메모:
${maskedBody}

과거 관련 기록:
${maskedContext}`;

  try {
    const geminiRes = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (!geminiRes.ok) return;
    const data = await geminiRes.json();
    const alert = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    if (alert && alert !== 'NONE' && alert.includes('Collision Check')) {
      const currentRaw = fs.readFileSync(filePath, 'utf-8');
      if (!currentRaw.includes('## ⚠️ Collision Check')) {
        const updated = currentRaw.trim() + '\n\n' + alert + '\n';
        fs.writeFileSync(filePath, updated, 'utf-8');
        console.log(`[Consistency] Collision detected in ${path.basename(filePath)}`);
      }
    }
  } catch (e) {
    console.error('[Consistency] Audit failed:', e.message);
  }
}

// ============================================================
// Date Conflict Detector (Sub 4-1 / Sub 4-2)
// ============================================================

let _dateIndex = null;
let _dateIndexMtime = 0;
let _dateIndexBuilding = false; // stale-while-revalidate 중복 방지
const DATE_INDEX_CACHE_TTL = 6 * 3600 * 1000; // 6h — BUG-5 패턴 동일

function saveDateIndex(index) {
  fs.mkdirSync(path.dirname(DATE_INDEX_FILE), { recursive: true });
  fs.writeFileSync(DATE_INDEX_FILE, JSON.stringify(index), 'utf-8');
}

function buildDateIndexFromVault() {
  const index = {};
  const DATE_RE = /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|\d{1,2}월\s*\d{1,2}일)/g;
  try {
    const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const relPath = `99_vaultvoice/${f}`;
      try {
        const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
        const matches = raw.match(DATE_RE) || [];
        for (const d of matches) {
          const norm = normalizeDateStr(d);
          if (!norm) continue;
          if (!index[norm]) index[norm] = [];
          if (!index[norm].includes(relPath)) index[norm].push(relPath);
        }
      } catch (_) {}
    }
  } catch (e) { console.warn('[DateIndex] build failed:', e.message); }
  return index;
}

function loadDateIndex() {
  const now = Date.now();
  if (_dateIndex && (now - _dateIndexMtime) < DATE_INDEX_CACHE_TTL) return _dateIndex;

  try {
    if (fs.existsSync(DATE_INDEX_FILE)) {
      const stat = fs.statSync(DATE_INDEX_FILE);
      const age = now - stat.mtimeMs;
      if (age < DATE_INDEX_CACHE_TTL) {
        _dateIndex = JSON.parse(fs.readFileSync(DATE_INDEX_FILE, 'utf-8'));
        _dateIndexMtime = now;
        return _dateIndex;
      }
    }
  } catch (_) {}

  // Cache miss / stale → stale-while-revalidate: return existing cache, rebuild async
  if (_dateIndex && !_dateIndexBuilding) {
    _dateIndexBuilding = true;
    setImmediate(async () => {
      try {
        const fresh = buildDateIndexFromVault();
        _dateIndex = fresh;
        _dateIndexMtime = Date.now();
        saveDateIndex(fresh);
      } catch (e) { console.warn('[DateIndex] async rebuild failed:', e.message); }
      finally { _dateIndexBuilding = false; }
    });
    return _dateIndex; // return stale cache immediately
  }

  // No cache at all → sync build (cold start only)
  _dateIndex = buildDateIndexFromVault();
  _dateIndexMtime = now;
  saveDateIndex(_dateIndex);
  return _dateIndex;
}

function normalizeDateStr(raw) {
  // YYYY-MM-DD or YYYY/MM/DD → YYYY-MM-DD
  const isoMatch = raw.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // M월 D일 → 올해 기준 YYYY-MM-DD
  const koMatch = raw.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (koMatch) {
    const year = new Date().getFullYear();
    const [, m, d] = koMatch;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

const EVENT_KEYWORDS = ['회의', '보고', '마감', '약속', '예약', '검진', '접종', '일정', '미팅', '면담'];

async function detectDateConflicts(filePath, body) {
  // Strip AI sections inline (ref: entityIndexer.stripAiSections)
  const cleanBody = body
    .replace(/\n##\s+🧠[\s\S]*$/, '')
    .replace(/\n##\s+⚠️[\s\S]*$/, '')
    .trim();

  // 이벤트 키워드 체크 — false positive 방지
  const hasEventKeyword = EVENT_KEYWORDS.some(kw => cleanBody.includes(kw));
  if (!hasEventKeyword) return;

  // 날짜 추출 + 정규화
  const DATE_RE = /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|\d{1,2}월\s*\d{1,2}일)/g;
  const rawDates = cleanBody.match(DATE_RE) || [];
  const dates = [...new Set(rawDates.map(normalizeDateStr).filter(Boolean))];
  if (!dates.length) return;

  const relPath = `99_vaultvoice/${path.basename(filePath)}`;
  const dateIndex = loadDateIndex();
  const conflictLines = [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    for (const date of dates) {
      const conflicts = (dateIndex[date] || []).filter(f => f !== relPath);
      for (const cf of conflicts) {
        try {
          const cfFp = path.join(VAULT_PATH, cf);
          const cfRaw = fs.readFileSync(cfFp, 'utf-8');
          const { frontmatter: cfFm } = parseFrontmatter(cfRaw);
          const title = cfFm.title || path.basename(cf, '.md');
          conflictLines.push(`- ${date}: ${title} (${cf})`);
        } catch (_) {}
      }
      // 현재 파일을 인덱스에 추가
      if (!dateIndex[date]) dateIndex[date] = [];
      if (!dateIndex[date].includes(relPath)) dateIndex[date].push(relPath);
    }
  } finally {
    clearTimeout(timer);
  }

  // 충돌 있으면 노트에 append
  if (conflictLines.length > 0) {
    try {
      const current = fs.readFileSync(filePath, 'utf-8');
      if (!current.includes('## ⚡ 날짜 충돌')) {
        const section = '\n\n## ⚡ 날짜 충돌\n' + conflictLines.join('\n') + '\n';
        fs.writeFileSync(filePath, current.trim() + section, 'utf-8');
        console.log(`[DateConflict] ${conflictLines.length}건 감지: ${path.basename(filePath)}`);
      }
    } catch (e) { console.warn('[DateConflict] append failed:', e.message); }
  }

  // 인덱스 저장 (증분 업데이트)
  saveDateIndex(dateIndex);
}

// ============================================================
// Entity Context Extractor (Sub 2-1 / Sub 2-2)
// ============================================================

/**
 * Extract entity-related facts from memo body using Gemini lite.
 * @param {string} body  - original memo body (linkedEntry, pre-AI)
 * @param {object} entities - { persons[], projects[], places[] }
 * @returns {Promise<Array<{entity:string, fact:string, category:string}>>}
 */
async function extractEntityContext(body, entities) {
  const { persons = [], projects = [], places = [] } = entities;
  const allEntities = [
    ...persons.map(n => ({ name: n, category: 'person' })),
    ...projects.map(n => ({ name: n, category: 'project' })),
    ...places.map(n => ({ name: n, category: 'place' }))
  ];
  if (!allEntities.length || body.trim().length < 10) return [];

  const maskedBody = applyPrivacyShield(body);
  const entityList = allEntities.map(e => `${e.name}(${e.category})`).join(', ');
  const prompt = `이 메모에서 언급된 인물/프로젝트/장소와 관련된 구체적 사실을 추출하라.
대상 entity 목록: ${entityList}
메모 내용:
${maskedBody}

각 entity에 대해 메모에서 언급된 구체적 사실 1문장을 추출하라.
entity가 메모에 없거나 사실이 없으면 해당 entity는 포함하지 마라.
JSON 배열로만 답변하라: [{"entity":"이름","fact":"구체적 사실 1문장","category":"person|project|place"}]
사실이 없으면 빈 배열 []로 답변하라.`;

  try {
    const res = await fetch(getGeminiApiUrl('lite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed)
      ? parsed.filter(e => e.entity && e.fact && e.category)
      : [];
  } catch (e) {
    console.warn('[EntityContext] extractEntityContext failed:', e.message);
    return [];
  }
}

/**
 * Append an entity-related fact to the entity note's "## 맥락 기록" section.
 * Serialized per entityFp via getPipelineQueue. TTL=30d, max=20 entries.
 */
async function appendEntityContext(entityName, fact, category, vaultPath) {
  const safeFilename = entityName.replace(/[\\/:*?"<>|]/g, '_') + '.md';
  const entityFp = path.join(vaultPath, '99_vaultvoice', safeFilename);
  if (!fs.existsSync(entityFp)) {
    console.warn(`[EntityContext] Entity note not found: ${entityName}`);
    return;
  }

  return getPipelineQueue(entityFp).add(async () => {
    try {
      const raw = fs.readFileSync(entityFp, 'utf-8');
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10);
      const newEntry = `- ${dateStr} [30d] [${category}]: ${fact}`;
      const SECTION = '## 맥락 기록';
      const TTL_DAYS = 30;

      let newContent;
      if (raw.includes(SECTION)) {
        const sectionStart = raw.indexOf(SECTION);
        const beforeSection = raw.slice(0, sectionStart);
        const afterSectionContent = raw.slice(sectionStart + SECTION.length);

        // Find start of next ## section (if any)
        const nextSecMatch = afterSectionContent.match(/\n## /);
        const sectionBody = nextSecMatch
          ? afterSectionContent.slice(0, nextSecMatch.index)
          : afterSectionContent;
        const afterSection = nextSecMatch
          ? afterSectionContent.slice(nextSecMatch.index)
          : '';

        // Extract & TTL-filter existing entries
        const existingEntries = sectionBody
          .split('\n')
          .filter(l => /^- \d{4}-\d{2}-\d{2}/.test(l))
          .filter(line => {
            const m = line.match(/^- (\d{4}-\d{2}-\d{2})/);
            if (!m) return true;
            const diffDays = (today - new Date(m[1])) / 86400000;
            return diffDays <= TTL_DAYS;
          });

        // Prepend + cap at 20
        const entries = [newEntry, ...existingEntries].slice(0, 20);
        newContent = beforeSection + SECTION + '\n' + entries.join('\n') + '\n' + afterSection;
      } else {
        newContent = raw.trimEnd() + '\n\n' + SECTION + '\n' + newEntry + '\n';
      }

      fs.writeFileSync(entityFp, newContent, 'utf-8');
      console.log(`[EntityContext] Appended to ${entityName}: ${fact.slice(0, 40)}`);
    } catch (e) {
      console.warn('[EntityContext] appendEntityContext failed:', e.message);
    }
  });
}

async function extractActionItems(filePath, raw) {
  const { frontmatter, body } = parseFrontmatter(raw);

  // Skip if already has Tasks or too short
  if (body.includes('## Tasks') || body.length < 10) return [];

  // Apply Privacy Shield before sending to external API
  const maskedBody = applyPrivacyShield(body);

  const today = frontmatter['날짜'] || new Date().toISOString().slice(0, 10);
  
  const taskSchema = {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            due: { type: 'string', description: 'YYYY-MM-DD format' },
            priority: { type: 'string', enum: ['P1', 'P2', 'P3'] }
          },
          required: ['title']
        }
      }
    },
    required: ['tasks']
  };

  const prompt = `당신은 사용자의 메모에서 실행 가능한 과제(Task)를 추출하고 시간을 정규화하는 전문 어시스턴트입니다.
기준 날짜(오늘): ${today}

다음 메모에서 할 일이나 일정을 찾아 추출하세요.
- "내일", "다음주 화요일" 등 상대적인 날짜는 기준 날짜(${today})를 바탕으로 정확한 YYYY-MM-DD 형식으로 변환하세요.
- 구체적인 날짜가 없으면 due 필드를 생략하거나 빈 문자열로 두세요.

노트 내용:
${maskedBody.slice(0, 3000)}`;

  try {
    const geminiRes = await fetch(getGeminiApiUrl('lite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        contents: [{ parts: [{ text: prompt }] }], 
        generationConfig: { 
          responseMimeType: 'application/json',
          responseSchema: taskSchema,
          temperature: 0.1, 
          maxOutputTokens: 1024 
        } 
      }),
      signal: AbortSignal.timeout(15000)
    });
    
    if (!geminiRes.ok) return [];
    const data = await geminiRes.json();
    const tasks = data.tasks || [];
    
    if (tasks.length > 0) {
      const currentRaw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter: currentFm, body: currentBody } = parseFrontmatter(currentRaw);
      
      if (!currentBody.includes('## Tasks')) {
        const taskListMd = tasks.map(t => formatTaskToMarkdown(t)).join('\n') + '\n';
        const updatedBody = currentBody.trim() + '\n\n## Tasks\n\n' + taskListMd + '\n';
        fs.writeFileSync(filePath, serializeFrontmatter(currentFm) + updatedBody, 'utf-8');
        console.log(`[Tasks] Action items added to ${path.basename(filePath)}`);
      }
      return tasks;
    }
  } catch (e) {
    console.error('[Tasks] Extraction failed:', e.message);
  }
  return [];
}

// Multi-Lens config — area-based lens selection
// 렌즈 추가/수정 시 server.js 수정 없이 config/lenses.json만 편집하면 됩니다.
const PERSPECTIVE_LENSES = (() => {
  try { return require('./config/lenses.json'); }
  catch (e) { console.warn('[PIE] config/lenses.json 로드 실패, 기본값 사용:', e.message); return {}; }
})();

function buildPerspectivePrompt(lens, lensName, maskedBody) {
  if (lens) {
    const sectionList = lens.sections.map(s => `- ${s}`).join('\n');
    return `당신은 다음 노트를 **${lensName}** 관점으로 분석하는 전문가입니다.

다음 섹션들에 집중하여 분석하세요:
${sectionList}

출력 형식:
- 반드시 '## 🧠 ${lensName}' 섹션 제목 아래에 작성하세요.
- 각 섹션을 마크다운 서브헤딩으로 구분하세요.
- 한국어로 전문적이고 실용적인 톤을 유지하세요.
- 각 항목 끝에 핵심 질문(Dominant Question)을 하나 포함하세요.

노트 내용:
${maskedBody.slice(0, 6000)}`;
  }
  return `당신은 사용자의 **전략적 지배자이자 전문 FP&A 파트너인 PIE Engine v2.0**입니다.
당신의 페르소나는 **'11년 차 대기업 재무팀 매니저이자, 두 아이를 키우며 삶의 균형을 치열하게 고민하는 아빠'**입니다.

다음 5가지 전략 필터로 분석을 수행하세요:
1. **이해관계자 (#stakeholder)**: 숨은 의도, KPI 충돌 지점 및 협상 우위 분석.
2. **미래 시그널 (#forecast)**: 기록이 암시하는 연쇄 반응 추론 및 리스크/기회 예고.
3. **의사결정 내러티브 (#decision)**: 선택의 근거, 기회비용(ROI), 과거 원칙과의 일치 여부.
4. **비판적 검토 (#devils_advocates)**: 반론, 치명적 약점, 방어 논리 구축.
5. **라이프-워크 링크 (#lifework)**: 개인적 맥락이 업무 효율과 멘탈에 미치는 영향.

출력 형식:
- 반드시 '## 🧠 PIE Perspective' 섹션 제목 아래에 작성하세요.
- 가장 가치 있는 2~3가지 항목에 집중하여 깊이 있게 서술하세요.
- 재무 전문 용어(CM1 마진, ROI 등)를 정확하게 사용하세요.
- 각 항목 끝에 '지배적 질문(Dominant Question)'을 하나씩 포함하세요.
- 한국어로 냉철하고 신뢰감 있는 톤을 유지하세요.

노트 내용:
${maskedBody.slice(0, 6000)}`;
}

async function applyPerspectiveFilters(filePath, raw) {
  const { frontmatter, body } = parseFrontmatter(raw);

  // Skip check: use analyzed_lenses instead of body content
  const analyzedLenses = Array.isArray(frontmatter.analyzed_lenses) ? frontmatter.analyzed_lenses : [];
  if (analyzedLenses.length > 0 || body.length < 20) return;

  const area = frontmatter.area || '';
  const lens = PERSPECTIVE_LENSES[area] || null;
  const lensKey = lens ? area : 'default';
  const lensName = lens ? lens.name : 'PIE Perspective';

  const maskedBody = applyPrivacyShield(body);
  const prompt = buildPerspectivePrompt(lens, lensName, maskedBody);

  try {
    const geminiRes = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } }),
      signal: AbortSignal.timeout(20000)
    });

    if (!geminiRes.ok) return;
    const data = await geminiRes.json();
    const perspective = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    if (!perspective || (!perspective.includes(lensName) && !perspective.includes('PIE Perspective'))) return;

    // Re-read to avoid race condition
    const currentRaw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter: currentFm, body: currentBody } = parseFrontmatter(currentRaw);

    const currentLenses = Array.isArray(currentFm.analyzed_lenses) ? currentFm.analyzed_lenses : [];
    if (currentLenses.length > 0) return;

    if (!lens) {
      const PIE_TAGS = ['forecast', 'stakeholder', 'decision', 'devils_advocates', 'lifework'];
      const foundTags = PIE_TAGS.filter(tag => perspective.includes(`#${tag}`));
      if (foundTags.length > 0) {
        const existingTags = Array.isArray(currentFm.tags) ? currentFm.tags : (currentFm.tags ? [currentFm.tags] : []);
        currentFm.tags = [...new Set([...existingTags, ...foundTags])];
        console.log(`[PIE] Tags injected: ${foundTags.join(', ')}`);
      }
    }

    currentFm.analyzed_lenses = [lensKey];
    const updatedBody = currentBody.trim() + '\n\n' + perspective + '\n';
    fs.writeFileSync(filePath, serializeFrontmatter(currentFm) + updatedBody, 'utf-8');
    console.log(`[PIE] ${lensName} added to ${path.basename(filePath)}`);
  } catch (e) {
    console.error('[PIE] Analysis failed:', e.message);
  }
}

// ============================================================
// Unified VV Note Finder (3-tier: 99_vv → user folders → skip Claude Control)
// ============================================================
const VV_SEARCH_EXCLUDE = new Set(['.obsidian', '.claude', '90_Attachments', 'node_modules', '00_Claude_Control']);

function findVVNote(filename) {
  // Tier 1: 99_vaultvoice/
  const t1 = path.join(NOTES_DIR, filename);
  if (fs.existsSync(t1)) return t1;
  // Tier 2: other user folders (use cached file list for speed)
  const cached = getAllMdFilesCached();
  const match = cached.find(fp => path.basename(fp) === filename && !fp.includes(NOTES_DIR));
  if (match) return match;
  return null;
}

function getVVNotesForDate(date) {
  const cached = noteCache.getNotesForDate(date);
  if (cached) return cached;

  const prefix = `${date}_`;
  const results = new Map(); // filename → fullPath (dedup)
  // Tier 1: 99_vaultvoice/
  if (fs.existsSync(NOTES_DIR)) {
    for (const f of fs.readdirSync(NOTES_DIR)) {
      if (f.startsWith(prefix) && f.endsWith('.md')) results.set(f, path.join(NOTES_DIR, f));
    }
  }
  // Tier 2: other user folders (1-depth only — avoids full recursive vault scan)
  try {
    for (const d of fs.readdirSync(VAULT_PATH)) {
      if (VV_SEARCH_EXCLUDE.has(d) || d === VV_BASE || d.startsWith('.')) continue;
      const fullDir = path.join(VAULT_PATH, d);
      try { if (!fs.statSync(fullDir).isDirectory()) continue; } catch (e) { continue; }
      try {
        for (const f of fs.readdirSync(fullDir)) {
          if (f.startsWith(prefix) && f.endsWith('.md') && !results.has(f)) {
            results.set(f, path.join(fullDir, f));
          }
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip */ }
  // Sort by filename (= chronological) and read content
  const sorted = [...results.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const notes = sorted.map(([filename, fullPath]) => {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    return { filename, fullPath, frontmatter, body: body.trim(), raw };
  });
  noteCache.setNotesForDate(date, notes);
  return notes;
}

// Read all atomic notes for a given date (delegates to unified finder)
function getNotesForDate(date) {
  return getVVNotesForDate(date);
}

// Combine notes into a single body grouped by 유형 (type) for display
function combineNotes(notes) {
  const groups = {};
  for (const note of notes) {
    // Support both new '유형' field and legacy '섹션' field
    const type = note.frontmatter['유형'] || note.frontmatter['섹션'] || 'memo';
    if (!groups[type]) groups[type] = [];
    groups[type].push(note.body);
  }

  let combined = '';
  const order = ['memo', 'todo', 'voice', 'image', 'url'];
  const keys = [...new Set([...order.filter(k => groups[k]), ...Object.keys(groups)])];
  for (const type of keys) {
    combined += `## ${type}\n\n${groups[type].join('\n')}\n\n`;
  }
  return combined.trim();
}

// ============================================================
// Vault Manager - /vault route + /api/vm/* proxy endpoints
// ============================================================

app.get('/vault', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vault.html'));
});

// VM: Browse folder
app.get('/api/vm/browse', async (req, res) => {
  try {
    const folder = (req.query.folder || '').replace(/\.\./g, '');
    const encoded = folder ? encodeURIComponent(folder).replace(/%2F/g, '/') + '/' : '';
    const r = await obsidianApi('GET', `/vault/${encoded}`);
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    // Fallback to filesystem
    try {
      const folder = (req.query.folder || '').replace(/\.\./g, '');
      const dirPath = path.join(VAULT_PATH, folder);
      if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Not found' });
      const items = fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));
      const files = items.map(f => {
        const full = path.join(dirPath, f);
        const isDir = fs.statSync(full).isDirectory();
        return isDir ? f + '/' : f;
      });
      res.json({ files });
    } catch (e2) {
      res.status(500).json({ error: e.message });
    }
  }
});

// VM: Read note (unlimited)
app.get('/api/vm/read', async (req, res) => {
  try {
    const p = (req.query.path || '').replace(/\.\./g, '');
    if (!p) return res.status(400).json({ error: 'path required' });
    const encoded = encodeURIComponent(p).replace(/%2F/g, '/');
    const r = await obsidianApi('GET', `/vault/${encoded}`);
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
    const content = await r.text();
    res.json({ content, path: p });
  } catch (e) {
    try {
      const p = (req.query.path || '').replace(/\.\./g, '');
      const fullPath = path.join(VAULT_PATH, p);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        return res.json({ content, path: p });
      }
    } catch (e2) { /* ignore */ }
    res.status(500).json({ error: e.message });
  }
});

// VM: Write note
app.put('/api/vm/write', async (req, res) => {
  try {
    const { path: notePath, content } = req.body;
    if (!notePath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const safePath = notePath.replace(/\.\./g, '');
    const encoded = encodeURIComponent(safePath).replace(/%2F/g, '/');
    const r = await obsidianApi('PUT', `/vault/${encoded}`, content);
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
    res.json({ ok: true });
  } catch (e) {
    try {
      const safePath = (req.body.path || '').replace(/\.\./g, '');
      const fullPath = path.join(VAULT_PATH, safePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, req.body.content, 'utf-8');
      return res.json({ ok: true });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// VM: Delete note
app.delete('/api/vm/delete', async (req, res) => {
  try {
    const p = (req.query.path || '').replace(/\.\./g, '');
    if (!p) return res.status(400).json({ error: 'path required' });
    const encoded = encodeURIComponent(p).replace(/%2F/g, '/');
    const r = await obsidianApi('DELETE', `/vault/${encoded}`);
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
    invalidateFileCache();
    res.json({ ok: true });
  } catch (e) {
    // Filesystem fallback
    try {
      const safePath = (req.query.path || '').replace(/\.\./g, '');
      const fullPath = path.join(VAULT_PATH, safePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        invalidateFileCache();
        return res.json({ ok: true });
      }
      return res.status(404).json({ error: 'File not found' });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// VM: Move/rename note (read → write → delete)
app.post('/api/vm/move', async (req, res) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const safeFrom = from.replace(/\.\./g, '');
    const safeTo = to.replace(/\.\./g, '');
    // Read source
    const encFrom = encodeURIComponent(safeFrom).replace(/%2F/g, '/');
    const readRes = await obsidianApi('GET', `/vault/${encFrom}`);
    if (!readRes.ok) return res.status(readRes.status).json({ error: 'Source not found' });
    const content = await readRes.text();
    // Write destination
    const encTo = encodeURIComponent(safeTo).replace(/%2F/g, '/');
    const writeRes = await obsidianApi('PUT', `/vault/${encTo}`, content);
    if (!writeRes.ok) return res.status(writeRes.status).json({ error: 'Write failed' });
    // Delete source
    await obsidianApi('DELETE', `/vault/${encFrom}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// VM: Search vault
app.get('/api/vm/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) return res.status(400).json({ error: 'q required' });
    const ctx = parseInt(req.query.ctx) || 100;
    const r = await obsidianApi('POST',
      `/search/simple/?query=${encodeURIComponent(q)}&contextLength=${ctx}`, q);
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
    const results = await r.json();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// VM: Backlinks (search for [[name]])
app.get('/api/vm/backlinks', async (req, res) => {
  try {
    const name = req.query.name || '';
    if (!name) return res.status(400).json({ error: 'name required' });
    const q = `[[${name}]]`;
    const r = await obsidianApi('POST',
      `/search/simple/?query=${encodeURIComponent(q)}&contextLength=100`, q);
    if (!r.ok) return res.json([]);
    const results = await r.json();
    res.json(results);
  } catch (e) {
    res.json([]);
  }
});

// VM: Recent files (uses shared file cache)
app.get('/api/vm/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const allFiles = getAllMdFilesCached();
    const files = allFiles.map(fp => {
      try {
        const stat = fs.statSync(fp);
        return { path: path.relative(VAULT_PATH, fp).replace(/\\/g, '/'), mtime: stat.mtimeMs, size: stat.size };
      } catch (e) { return null; }
    }).filter(Boolean);
    files.sort((a, b) => b.mtime - a.mtime);
    res.json(files.slice(0, limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// VM: List commands
app.get('/api/vm/commands', async (req, res) => {
  try {
    const r = await obsidianApi('GET', '/commands/');
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// VM: Execute command
app.post('/api/vm/command', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const r = await obsidianApi('POST', `/commands/${encodeURIComponent(id)}/`);
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// VM: Get tags (read + parse frontmatter)
app.get('/api/vm/tags', async (req, res) => {
  try {
    const p = (req.query.path || '').replace(/\.\./g, '');
    if (!p) return res.status(400).json({ error: 'path required' });
    const encoded = encodeURIComponent(p).replace(/%2F/g, '/');
    const r = await obsidianApi('GET', `/vault/${encoded}`);
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
    const content = await r.text();
    // Parse frontmatter tags
    let tags = [];
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      // YAML array format: tags:\n  - a\n  - b
      const tagArrayMatch = fmMatch[1].match(/^tags:\s*\n((?:\s*-\s*.+\n?)*)/m);
      if (tagArrayMatch) {
        tags = tagArrayMatch[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
      }
      // Inline format: tags: [a, b] or tags: a, b
      if (tags.length === 0) {
        const tagLine = fmMatch[1].match(/^tags:\s*\[?(.*?)\]?\s*$/m);
        if (tagLine && tagLine[1].trim()) {
          tags = tagLine[1].split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        }
      }
    }
    // Also collect inline #tags
    const bodyContent = fmMatch ? content.slice(fmMatch[0].length) : content;
    const inlineTags = [...bodyContent.matchAll(/#([a-zA-Z0-9가-힣_/\-]+)/g)].map(m => m[1]);
    const allTags = [...new Set([...tags, ...inlineTags])];
    res.json({ tags: allTags, frontmatterTags: tags, inlineTags });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// VM: Update tags (read → update frontmatter → write)
app.put('/api/vm/tags', async (req, res) => {
  try {
    const { path: notePath, tags } = req.body;
    if (!notePath || !Array.isArray(tags)) return res.status(400).json({ error: 'path and tags[] required' });
    const safePath = notePath.replace(/\.\./g, '');
    const encoded = encodeURIComponent(safePath).replace(/%2F/g, '/');
    // Read current content
    const readRes = await obsidianApi('GET', `/vault/${encoded}`);
    if (!readRes.ok) return res.status(readRes.status).json({ error: 'File not found' });
    let content = await readRes.text();
    // Update frontmatter tags
    const tagStr = tags.length > 0 ? `tags: [${tags.join(', ')}]` : '';
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      let fm = fmMatch[1];
      // Remove existing tags line(s)
      fm = fm.replace(/^tags:.*(\n\s*-\s*.+)*/gm, '').replace(/\n{2,}/g, '\n').trim();
      if (tagStr) fm = fm + '\n' + tagStr;
      content = `---\n${fm}\n---` + content.slice(fmMatch[0].length);
    } else if (tagStr) {
      content = `---\n${tagStr}\n---\n` + content;
    }
    // Write back
    const writeRes = await obsidianApi('PUT', `/vault/${encoded}`, content);
    if (!writeRes.ok) return res.status(writeRes.status).json({ error: 'Write failed' });
    res.json({ ok: true, tags });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Process pipelines (stubs — to be implemented by other coders)
// ============================================================

// ============================================================
// Audio Processing Pipeline — Gemini transcription + Whisper fallback
// ============================================================

// Parse "MM:SS" or "HH:MM:SS" timestamp string to seconds
function parseTimestamp(ts) {
  if (!ts) return 0;
  const parts = String(ts).split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(ts) || 0;
}

// Format seconds to "Xm Ys" display string
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '알 수 없음';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}초`;
  return `${m}분 ${s}초`;
}

// Decide whether Whisper fallback is needed based on quality indicators
function needsWhisperFallback(qualityCheck, audioSeconds, textLength) {
  let failCount = 0;
  if (qualityCheck.broken_sentences && qualityCheck.broken_sentences.length >= 3) failCount++;
  if (qualityCheck.unclear_ratio >= 0.2) failCount++;
  if (qualityCheck.repetition_detected) failCount++;
  if (qualityCheck.insufficient_content) failCount++;
  // Code-based check: less than 50 chars per minute
  const charsPerMin = audioSeconds > 0 ? (textLength / audioSeconds) * 60 : 0;
  if (charsPerMin < 50 && audioSeconds > 30) failCount++; // only penalise if clip is long enough
  return failCount >= 2;
}

// Temporal Overlap merge: assign Gemini speaker labels to Whisper segments
function mergeTranscripts(whisperSegments, geminiTranscript) {
  return whisperSegments.map(seg => {
    let bestSpeaker = 'Unknown';
    let maxOverlap = 0;
    for (const g of geminiTranscript) {
      const gStart = parseTimestamp(g.timestamp);
      // Assume each Gemini segment spans ~30 seconds for overlap calculation
      const overlap = Math.max(0, Math.min(seg.end, gStart + 30) - Math.max(seg.start, gStart));
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        bestSpeaker = g.speaker;
      }
    }
    return { speaker: bestSpeaker, text: seg.text, start: seg.start, end: seg.end };
  });
}

app.post('/api/process/audio', auth, uploadLimiter, upload.single('file'), async (req, res) => {
  // Guard: Gemini SDK required
  if (!GoogleGenerativeAI || !GoogleAIFileManager) {
    return res.status(503).json({ error: 'Gemini SDK not installed. Run: npm install @google/generative-ai' });
  }
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') {
    return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const date = req.body.date || new Date().toISOString().split('T')[0];
  const audioFilename = file.filename;
  const audioFilePath = file.path;
  const audioSizeBytes = file.size;

  let geminiFile = null;
  const fileManager = new GoogleAIFileManager(GEMINI_API_KEY);

  try {
    // ── Step 1: Upload audio to Gemini Files API ──────────────────────────
    console.log('[Audio] Uploading to Gemini Files API:', audioFilename, audioSizeBytes, 'bytes');
    geminiFile = await fileManager.uploadFile(audioFilePath, {
      mimeType: file.mimetype || 'audio/mpeg',
      displayName: audioFilename
    });
    const fileUri = geminiFile.file.uri;
    console.log('[Audio] Gemini file URI:', fileUri, '| state:', geminiFile.file.state);

    // Wait for file to become ACTIVE (large files stay PROCESSING briefly)
    let fileState = geminiFile.file.state;
    let waitMs = 0;
    while (fileState !== 'ACTIVE' && waitMs < 60000) {
      await new Promise(r => setTimeout(r, 2000));
      waitMs += 2000;
      const fileInfo = await fileManager.getFile(geminiFile.file.name);
      fileState = fileInfo.state;
      console.log(`[Audio] File state: ${fileState} (waited ${waitMs}ms)`);
      if (fileState === 'FAILED') throw new Error('Gemini file processing failed');
    }
    if (fileState !== 'ACTIVE') throw new Error('Gemini file not ACTIVE after 60s');

    // ── Step 2: Gemini transcription with structured output ───────────────
    const model = getGeminiModel('flash');

    const transcriptionSchema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        participants: { type: 'array', items: { type: 'string' } },
        transcript: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              timestamp: { type: 'string' },
              speaker: { type: 'string' },
              text: { type: 'string' }
            },
            required: ['timestamp', 'speaker', 'text']
          }
        },
        quality_check: {
          type: 'object',
          properties: {
            broken_sentences: { type: 'array', items: { type: 'string' } },
            unclear_ratio: { type: 'number' },
            repetition_detected: { type: 'boolean' },
            insufficient_content: { type: 'boolean' }
          },
          required: ['broken_sentences', 'unclear_ratio', 'repetition_detected', 'insufficient_content']
        },
        language: { type: 'string' }
      },
      required: ['summary', 'participants', 'transcript', 'quality_check']
    };

    const prompt = `Transcribe this audio file. Auto-detect the language (Korean, English, or mixed).

Return JSON with:
1. summary: 2-3 sentence summary of the conversation (in the detected language)
2. participants: speaker list (e.g. ["화자1", "화자2"] for Korean, ["Speaker1", "Speaker2"] for English)
3. transcript: timestamp(MM:SS), speaker, text in order
4. quality_check:
   - broken_sentences: list of incomplete sentences (max 10)
   - unclear_ratio: ratio of unclear speech (0.0~1.0)
   - repetition_detected: whether same content repeats
   - insufficient_content: whether meaningful content is too little
5. language: detected language code ("ko", "en", or "mixed")

If multiple speakers, distinguish by voice/tone/content and label as "화자1","화자2" (Korean) or "Speaker1","Speaker2" (English).`;

    let geminiResult = null;
    let geminiError = null;

    // Retry up to 3 times with exponential backoff for transient fetch errors
    for (let attempt = 1; attempt <= 3; attempt++) {
      let rawText = '';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000); // 2 min per attempt
      try {
        const result = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { fileData: { mimeType: file.mimetype || 'audio/mpeg', fileUri } }
            ]
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: transcriptionSchema,
            temperature: 0.1,
            maxOutputTokens: 65536
          }
        });
        rawText = result.response.text();
        geminiResult = JSON.parse(rawText);
        console.log(`[Audio] Gemini transcription OK (attempt ${attempt}), segments:`, geminiResult.transcript?.length);
        clearTimeout(timeout);
        break; // success
      } catch (e) {
        clearTimeout(timeout);
        // Try partial JSON recovery for truncated responses
        if (e.message && e.message.includes('JSON') && typeof rawText === 'string' && rawText.length > 0) {
          try {
            let fixed = rawText;
            if (!fixed.endsWith('}')) {
              const lastBrace = fixed.lastIndexOf('}');
              if (lastBrace > 0) fixed = fixed.substring(0, lastBrace + 1);
              const opens = (fixed.match(/\[/g) || []).length;
              const closes = (fixed.match(/\]/g) || []).length;
              for (let i = 0; i < opens - closes; i++) fixed += ']';
              if (!fixed.endsWith('}')) fixed += '}';
            }
            geminiResult = JSON.parse(fixed);
            console.log(`[Audio] Gemini JSON recovered after truncation (attempt ${attempt}), segments:`, geminiResult.transcript?.length);
            break; // recovered
          } catch (e2) {
            console.error(`[Audio] Gemini JSON recovery also failed (attempt ${attempt}):`, e2.message);
          }
        }
        geminiError = e;
        console.error(`[Audio] Gemini transcription failed (attempt ${attempt}/3):`, e.message);
        if (attempt < 3) {
          const delay = attempt * 3000; // 3s, 6s
          console.log(`[Audio] Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (geminiResult) {
      geminiResult = sanitizeMetadata(geminiResult);
    }

    // ── Step 3: Quality check → decide Whisper fallback ──────────────────
    let usedWhisper = false;
    let finalTranscript = [];
    let summary = '';
    let participants = [];
    let suggestedTags = ['voice'];

    // Estimate audio duration from file size heuristic if not available (~128kbps mp3)
    const audioSeconds = Math.round((audioSizeBytes / 1024) / 16); // rough: 16KB/s at 128kbps

    if (geminiResult) {
      summary = geminiResult.summary || '';
      participants = geminiResult.participants || [];
      const geminiTranscript = geminiResult.transcript || [];
      const qc = geminiResult.quality_check || {};
      const totalText = geminiTranscript.map(s => s.text).join('');

      const useWhisper = needsWhisperFallback(qc, audioSeconds, totalText.length);
      console.log('[Audio] Quality check — needsWhisper:', useWhisper, 'qc:', JSON.stringify(qc));

      if (useWhisper && OPENAI_API_KEY && OpenAI && audioSizeBytes <= 25 * 1024 * 1024) {
        // ── Whisper fallback ──────────────────────────────────────────────
        try {
          console.log('[Audio] Calling Whisper API for fallback...');
          const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
          const whisperRes = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioFilePath),
            model: 'whisper-1',
            response_format: 'verbose_json',
            language: 'ko'
          });
          const whisperSegments = whisperRes.segments || [];
          if (whisperSegments.length > 0) {
            finalTranscript = mergeTranscripts(whisperSegments, geminiTranscript);
            usedWhisper = true;
            console.log('[Audio] Whisper merge OK, segments:', finalTranscript.length);
          } else {
            // Whisper returned no segments — fall back to Gemini
            finalTranscript = geminiTranscript.map(s => ({
              speaker: s.speaker,
              text: s.text,
              start: parseTimestamp(s.timestamp),
              end: parseTimestamp(s.timestamp) + 30
            }));
          }
        } catch (whisperErr) {
          console.error('[Audio] Whisper fallback failed:', whisperErr.message);
          // Use Gemini result anyway
          finalTranscript = geminiTranscript.map(s => ({
            speaker: s.speaker,
            text: s.text,
            start: parseTimestamp(s.timestamp),
            end: parseTimestamp(s.timestamp) + 30
          }));
        }
      } else {
        // Use Gemini result directly
        finalTranscript = geminiTranscript.map(s => ({
          speaker: s.speaker,
          text: s.text,
          start: parseTimestamp(s.timestamp),
          end: parseTimestamp(s.timestamp) + 30
        }));
        if (useWhisper && audioSizeBytes > 25 * 1024 * 1024) {
          console.log('[Audio] Skipping Whisper — file > 25MB');
        }
      }

      // Generate tags from participants count
      if (participants.length > 1) suggestedTags.push('회의');
    } else {
      // Gemini failed entirely — try Whisper directly if available
      if (OPENAI_API_KEY && OpenAI && audioSizeBytes <= 25 * 1024 * 1024) {
        try {
          console.log('[Audio] Gemini failed, trying Whisper directly...');
          const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
          const whisperRes = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioFilePath),
            model: 'whisper-1',
            response_format: 'verbose_json',
            language: 'ko'
          });
          const whisperSegments = whisperRes.segments || [];
          finalTranscript = whisperSegments.map(seg => ({
            speaker: '화자1',
            text: seg.text,
            start: seg.start,
            end: seg.end
          }));
          summary = whisperRes.text ? whisperRes.text.slice(0, 200) : '음성 전사 완료';
          participants = ['화자1'];
          usedWhisper = true;
          console.log('[Audio] Whisper direct transcription OK, segments:', finalTranscript.length);
        } catch (whisperErr) {
          console.error('[Audio] Whisper direct transcription failed:', whisperErr.message);
          // Both failed — save error note
          const errBody = `## 전사 오류\n\nGemini: ${geminiError?.message || '알 수 없는 오류'}\nWhisper: ${whisperErr.message}`;
          const result = createAtomicNote(date, 'voice', errBody, ['voice', 'error'], {
            전사방식: 'error',
            source: `[[assets/audio/${audioFilename}]]`
          });
          return res.status(500).json({
            ok: false,
            error: '음성 전사 실패',
            geminiError: geminiError?.message,
            whisperError: whisperErr.message,
            filename: result.filename
          });
        }
      } else {
        // No fallback available
        const errBody = `## 전사 오류\n\n${geminiError?.message || '알 수 없는 오류'}`;
        const result = createAtomicNote(date, 'voice', errBody, ['voice', 'error'], {
          전사방식: 'error',
          source: `[[assets/audio/${audioFilename}]]`
        });
        return res.status(500).json({
          ok: false,
          error: '음성 전사 실패: ' + (geminiError?.message || '알 수 없는 오류'),
          filename: result.filename
        });
      }
    }

    // ── Step 3.5: Transcript refinement + structured summary (2nd pass) ────
    let refinedTranscript = null;
    let structuredSummary = null;
    const detectedLang = geminiResult?.language || 'ko';
    if (finalTranscript.length > 0) {
      try {
        const isKorean = detectedLang === 'ko' || detectedLang === 'mixed';
        const isMeeting = participants.length > 1;
        const toneRule = isKorean
          ? (isMeeting ? "존댓말 '~습니다/ㅂ니다'체로 통일" : "원문의 말투와 톤을 유지하되 필러만 제거")
          : (isMeeting ? "Use professional, formal tone" : "Maintain the original tone, only remove fillers");

        const transcriptInput = JSON.stringify(finalTranscript.map(s => ({ speaker: s.speaker, text: s.text })));

        const refinePrompt = isKorean
          ? (isMeeting
            ? `# 역할
당신은 전문적인 회의록 작성 전문가이자 전사 정리가입니다.

# 목표
1. 구어체로 전사된 내용을 읽기 좋은 문어체로 정제
2. 회의록에서 바로 사용 가능한 구조화된 요약 작성

# 전사 정제 지침
1. 필러("어", "음", "그", "이제", "그러니까") 및 군말 제거
2. 반복된 어구 통합
3. 끊어진 문장을 문법에 맞게 자연스럽게 연결
4. 문맥에 맞는 구두점 추가
5. ${toneRule}

# 요약 작성 지침 (반드시 한국어로 작성)
1. 주요 안건: 논의된 각 안건별 핵심 내용 정리
2. 결정 사항: 회의에서 최종 결정된 사항
3. 실행 과제(Action Items): 담당자와 기한 포함 (언급된 경우)
4. 스크립트에 없는 내용은 추측하지 말 것

# 제약 조건
- 원문에 없는 새로운 정보를 추가 금지
- 발언의 핵심 의미나 뉘앙스 왜곡 금지
- 화자 정보 변경 금지
- 출력 언어는 반드시 한국어

# 원문
${transcriptInput}`
            : `# 역할
당신은 전문적인 메모 정리가입니다.

# 목표
1. 구어체로 전사된 내용을 읽기 좋게 정제
2. 핵심 아이디어와 할 일을 정리한 요약 작성

# 전사 정제 지침
1. 필러("어", "음", "그", "이제", "그러니까") 및 군말 제거
2. 반복된 어구 통합
3. 끊어진 문장을 문법에 맞게 자연스럽게 연결
4. ${toneRule}

# 요약 작성 지침 (반드시 한국어로 작성)
1. 핵심 아이디어: 메모의 주요 내용/컨셉 요약
2. 할 일 목록: 실행 가능한 태스크 (있을 경우)
3. 스크립트에 없는 내용은 추측하지 말 것

# 제약 조건
- 원문에 없는 새로운 정보를 추가 금지
- 출력 언어는 반드시 한국어

# 원문
${transcriptInput}`)
          : (isMeeting
            ? `# Role
You are a professional meeting secretary and transcript editor.

# Goal
1. Refine the raw transcript into clean, readable text
2. Generate a structured meeting summary ready for immediate use

# Transcript Refinement
1. Remove fillers ("um", "uh", "like", "you know", "so")
2. Merge repeated phrases
3. Connect broken sentences naturally
4. Add proper punctuation
5. ${toneRule}

# Summary Guidelines (MUST be in English)
1. Key Agenda Items: core discussion points per topic
2. Decisions Made: final decisions from the meeting
3. Action Items: with owner and due date if mentioned
4. Do NOT assume information not in the transcript

# Constraints
- Do NOT add information not in the original
- Do NOT change the meaning or nuance
- Do NOT change speaker labels
- Output language MUST be English

# Transcript
${transcriptInput}`
            : `# Role
You are a professional memo editor.

# Goal
1. Refine the raw transcript into clean, readable text
2. Summarize key ideas and action items

# Transcript Refinement
1. Remove fillers ("um", "uh", "like", "you know", "so")
2. Merge repeated phrases and connect broken sentences
3. ${toneRule}

# Summary Guidelines (MUST be in English)
1. Key Ideas: main concepts from the memo
2. To-Do: actionable tasks if any
3. Do NOT assume information not in the transcript

# Constraints
- Do NOT add information not in the original
- Output language MUST be English

# Transcript
${transcriptInput}`);

        const refineSchema = {
          type: 'object',
          properties: {
            refined: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  speaker: { type: 'string' },
                  text: { type: 'string' }
                },
                required: ['speaker', 'text']
              }
            },
            summary: { type: 'string' }
          },
          required: ['refined', 'summary']
        };

        const refineResult = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: refinePrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: refineSchema,
            temperature: 0.3,
            maxOutputTokens: 65536
          }
        });
        const refineData = JSON.parse(refineResult.response.text());
        if (refineData.refined && refineData.refined.length > 0) {
          refinedTranscript = refineData.refined;
          console.log('[Audio] Transcript refined OK, segments:', refinedTranscript.length);
        }
        if (refineData.summary) {
          structuredSummary = refineData.summary;
          console.log('[Audio] Structured summary generated, length:', structuredSummary.length);
        }
      } catch (refineErr) {
        console.warn('[Audio] Transcript refinement failed (using original):', refineErr.message);
      }
    }

    // ── Step 4: Build note body and save atomic note ──────────────────────
    const finalSummary = structuredSummary || summary;
    const originalText = finalTranscript
      .map(s => `**${s.speaker}**: ${s.text}`)
      .join('\n\n');

    let body;
    if (refinedTranscript) {
      const refinedText = refinedTranscript
        .map(s => `**${s.speaker}**: ${s.text}`)
        .join('\n\n');
      body = `## 요약\n\n${finalSummary}\n\n## 전사 (정리)\n\n${refinedText}\n\n<details><summary>원본 전사 확인</summary>\n\n${originalText}\n\n</details>`;
    } else {
      body = `## 요약\n\n${finalSummary}\n\n## 전사\n\n${originalText}`;
    }

    // Add extracted tasks to body
    if (geminiResult && geminiResult.tasks && geminiResult.tasks.length > 0) {
      body += `\n\n## Tasks\n\n` + geminiResult.tasks.map(t => formatTaskToMarkdown(t)).join('\n') + '\n';
    }

    const extraFrontmatter = {
      전사방식: usedWhisper ? 'gemini+whisper' : 'gemini',
      리파인: refinedTranscript ? true : false,
      language: detectedLang,
      화자수: participants.length || 'unknown',
      녹음시간: formatDuration(audioSeconds),
      speakers: participants,
      source: `[[assets/audio/${audioFilename}]]`,
      category: geminiResult?.category || '""',
      topic: geminiResult?.topic || []
    };

    const noteResult = createAtomicNote(date, 'voice', body, [...suggestedTags, 'voice', ...(geminiResult?.topic || [])], extraFrontmatter);
    console.log('[Audio] Atomic note created:', noteResult.filename);

    res.json({
      ok: true,
      filename: noteResult.filename,
      transcription: usedWhisper ? 'gemini+whisper' : 'gemini',
      summary: finalSummary,
      speakers: participants
    });

  } catch (e) {
    console.error('[Audio] Unexpected error:', e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    // Clean up Gemini file after processing
    if (geminiFile) {
      try {
        await fileManager.deleteFile(geminiFile.file.name);
        console.log('[Audio] Gemini file cleaned up:', geminiFile.file.name);
      } catch (cleanupErr) {
        console.warn('[Audio] Failed to delete Gemini file:', cleanupErr.message);
      }
    }
  }
});

app.post('/api/process/image', auth, aiLimiter, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!GoogleGenerativeAI) return res.status(503).json({ error: 'Gemini SDK not installed' });
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No image file provided' });

  const date = req.body.date || new Date().toISOString().split('T')[0];
  const imageFilename = file.filename;

  try {
    const imageData = fs.readFileSync(file.path);
    const base64 = imageData.toString('base64');
    const mimeType = file.mimetype || 'image/jpeg';

    const model = getGeminiModel('pro');

    const imageSchema = {
      type: 'object',
      properties: {
        image_type: { type: 'string', enum: ['명함', '영수증', '화이트보드', '손글씨', '도표', '사진', '스크린샷'] },
        ocr_text: { type: 'string' },
        structured_data: { type: 'object' },
        summary: { type: 'string' },
        suggested_tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['image_type', 'ocr_text', 'summary', 'suggested_tags']
    };

    const prompt = `이 이미지를 분석해주세요.

다음 정보를 JSON으로 반환하세요:
1. image_type: 이미지 유형 (명함, 영수증, 화이트보드, 손글씨, 도표, 사진, 스크린샷 중 하나)
2. ocr_text: 이미지에서 추출한 모든 텍스트 (없으면 빈 문자열)
   - 중요: 이미지에 표/테이블이 포함된 경우, 반드시 Markdown 테이블 형식(| 열1 | 열2 | ... |)으로 변환하여 ocr_text에 포함하세요.
   - 세로로 병합된 셀(rowspan)이 있으면 각 행마다 해당 값을 반복 기입하세요. 빈 셀로 두지 마세요.
   - 예: "스포츠강좌" 카테고리에 3개 항목이 있으면, 3행 모두 첫 열에 "스포츠강좌"를 넣으세요.
   - 표 앞뒤의 일반 텍스트는 그대로 유지하세요.
3. structured_data: 유형별 구조화 데이터
   - 명함: { name, company, phone, email, position }
   - 영수증: { date, total, items: [{name, price}], store }
   - 화이트보드/손글씨: { lines: ["정리된 텍스트 줄"] }
   - 도표/차트: { description, data_points: [{label, value}] }
   - 사진: { scene, objects: ["주요 객체"], context }
   - 스크린샷: { app_or_site, ui_elements: ["설명"], extracted_text }
4. summary: 이미지에 대한 한줄 설명
5. suggested_tags: 관련 태그 2~3개 (한국어)`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: imageSchema, temperature: 0.1 }
    });

    let analysis = JSON.parse(result.response.text());
    analysis = sanitizeMetadata(analysis);
    
    let body = buildImageNoteBody(analysis, imageFilename);

    // Add extracted tasks to body
    const tags = ['image', ...(analysis.suggested_tags || [])];
    const extraFrontmatter = {
      이미지유형: analysis.image_type,
      summary: analysis.summary ? `"${analysis.summary}"` : '""',
      source: `[[assets/images/${imageFilename}]]`,
      status: 'transcribed'
    };

    const noteResult = createAtomicNote(date, 'image', body, tags, extraFrontmatter);
    console.log('[Image] Atomic note created:', noteResult.filename);
    res.json({ ok: true, filename: noteResult.filename, image_type: analysis.image_type, summary: analysis.summary, tags: analysis.suggested_tags });
  } catch (e) {
    console.error('[Image] Processing error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

function buildImageNoteBody(analysis, imageFilename) {
  let body = `## 요약\n\n${analysis.summary}\n\n`;
  if (analysis.ocr_text) body += `## 추출 텍스트\n\n${analysis.ocr_text}\n\n`;
  const sd = analysis.structured_data || {};
  body += buildStructuredSection(analysis.image_type, sd);
  body += `\n## 원본\n\n![[${IMAGES_DIR_NAME}/${imageFilename}]]`;
  return body;
}

function buildStructuredSection(imageType, sd) {
  if (imageType === '명함' && sd.name) {
    let s = '## 명함 정보\n\n';
    if (sd.name) s += `- **이름**: ${sd.name}\n`;
    if (sd.company) s += `- **회사**: ${sd.company}\n`;
    if (sd.position) s += `- **직책**: ${sd.position}\n`;
    if (sd.phone) s += `- **전화**: ${sd.phone}\n`;
    if (sd.email) s += `- **이메일**: ${sd.email}\n`;
    return s;
  }
  if (imageType === '영수증' && sd.store) {
    let s = '## 영수증 정보\n\n';
    if (sd.store) s += `- **매장**: ${sd.store}\n`;
    if (sd.date) s += `- **날짜**: ${sd.date}\n`;
    if (sd.total) s += `- **합계**: ${sd.total}\n`;
    if (sd.items && sd.items.length) {
      s += '\n| 항목 | 금액 |\n|------|------|\n';
      for (const item of sd.items) s += `| ${item.name || ''} | ${item.price || ''} |\n`;
    }
    return s;
  }
  if ((imageType === '화이트보드' || imageType === '손글씨') && sd.lines) {
    return '## 정리된 내용\n\n' + sd.lines.map(l => `- ${l}`).join('\n') + '\n';
  }
  if (imageType === '도표' && sd.description) {
    let s = `## 도표 분석\n\n${sd.description}\n`;
    if (sd.data_points && sd.data_points.length) {
      s += '\n| 항목 | 값 |\n|------|----|\n';
      for (const dp of sd.data_points) s += `| ${dp.label || ''} | ${dp.value || ''} |\n`;
    }
    return s;
  }
  if (imageType === '스크린샷' && sd.app_or_site) {
    let s = `## 스크린샷 분석\n\n- **앱/사이트**: ${sd.app_or_site}\n`;
    if (sd.extracted_text) s += `- **텍스트**: ${sd.extracted_text}\n`;
    return s;
  }
  if (sd.scene) {
    let s = `## 장면 설명\n\n${sd.scene}\n`;
    if (sd.objects && sd.objects.length) s += `- **주요 객체**: ${sd.objects.join(', ')}\n`;
    return s;
  }
  return '';
}

app.post('/api/process/url', auth, aiLimiter, async (req, res) => {
  if (!GoogleGenerativeAI) return res.status(503).json({ error: 'Gemini SDK not installed' });
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });

  const { url, date, tags: extraTags = [] } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const noteDate = date || new Date().toISOString().split('T')[0];

  try {
    const { text, meta } = await extractUrlContent(url);
    const summary = await summarizeWithGemini(text, url, meta);
    const domain = new URL(url).hostname.replace(/^www\./, '');
    const tags = ['url', domain, ...(summary.keywords || []), ...extraTags];
    const body = buildUrlNoteBody(summary, meta, url);
    const extraFrontmatter = {
      url,
      domain,
      og_title: meta.title || '',
      og_image: meta.image || '',
      summary: summary.summary ? `"${summary.summary.slice(0, 100)}..."` : '""',
      status: 'summarized'
    };

    const noteResult = createAtomicNote(noteDate, 'url', body, tags, extraFrontmatter);
    console.log('[URL] Atomic note created:', noteResult.filename);
    res.json({ ok: true, filename: noteResult.filename, title: summary.title, summary: summary.summary });
  } catch (e) {
    console.error('[URL] Processing error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function extractUrlContent(url) {
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return extractYouTubeContent(url, ytMatch[1]);
  return extractWebContent(url);
}

async function extractYouTubeContent(url, videoId) {
  let captionText = '';
  if (getSubtitles) {
    try {
      const captions = await getSubtitles({ videoID: videoId, lang: 'ko' })
        .catch(() => getSubtitles({ videoID: videoId, lang: 'en' }));
      captionText = captions.map(c => c.text).join(' ').slice(0, 10000);
    } catch (e) { console.warn('[URL] Caption fetch failed:', e.message); }
  }
  const html = await fetchHtml(url);
  const meta = extractOgMeta(html);
  return { text: captionText || meta.title || url, meta };
}

async function extractWebContent(url) {
  const html = await fetchHtml(url);
  const meta = extractOgMeta(html);
  let text = '';
  if (Readability && JSDOM) {
    try {
      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();
      text = article ? article.textContent.slice(0, 10000) : '';
    } catch (e) { console.warn('[URL] Readability failed:', e.message); }
  }
  if (!text) text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
  return { text, meta };
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultVoice/1.0)' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function extractOgMeta(html) {
  const get = (prop) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i')); return m ? m[1] : ''; };
  const title = get('og:title') || get('twitter:title') || (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '';
  return { title: title.trim(), description: get('og:description').trim(), image: get('og:image').trim() };
}

async function summarizeWithGemini(text, url, meta) {
  const model = getGeminiModel('pro');

  // Apply Privacy Shield before sending to external API
  const maskedText = applyPrivacyShield(text);

  const isYouTube = /youtu\.?be/.test(url);
  const urlSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      key_points: { type: 'array', items: { type: 'string' } },
      keywords: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'summary', 'key_points', 'keywords']
  };
  const prompt = isYouTube
    ? `다음은 YouTube 영상의 자막입니다. 영상 내용을 깊이 있게 한국어로 요약해주세요.

## 요약 원칙
1. 자막을 그대로 옮기지 말고, 영상에서 설명하는 **구체적인 방법론, 프로세스, 도구, 사례**를 빠짐없이 정리하라
2. "~에 대해 이야기했다" 같은 메타 설명 금지 → 실제 내용을 직접 서술하라
3. 핵심 개념이 등장하면 그 개념이 **무엇이고, 어떻게 작동하는지**를 포함하라
4. 숫자, 비교, 구체적 예시가 있으면 반드시 포함하라

제목: ${meta.title || '(없음)'}
URL: ${url}

자막:
${maskedText}

반환:
- title: 영상 핵심을 담은 구체적인 한국어 제목
- summary: 영상의 핵심 내용을 8~15문장으로 구체적으로 요약 (방법론/프로세스/사례 포함, 자막 복붙 금지)
- key_points: 핵심 포인트/방법론/인사이트 5~8개 (각 1~2문장, 구체적으로)
- keywords: 핵심 키워드 3~5개 (한국어)`
    : `다음 웹페이지 내용을 한국어로 요약해주세요. 구체적인 방법론, 수치, 사례를 빠뜨리지 마세요.\nURL: ${url}\n제목: ${meta.title || '(없음)'}\n\n내용:\n${maskedText}\n\n반환:\n- title: 한국어 제목\n- summary: 핵심 내용 8~15문장 요약 (구체적 방법론/사례 포함)\n- key_points: 핵심 포인트 5~8개 (각 1~2문장)\n- keywords: 핵심 키워드 3~5개 (한국어)`;
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: urlSchema, temperature: 0.2, maxOutputTokens: 8192 }
  });
  let summaryObj = JSON.parse(result.response.text());
  return sanitizeMetadata(summaryObj);
}

function buildUrlNoteBody(summary, meta, url) {
  let body = `## 요약\n\n${summary.summary}\n\n`;
  if (summary.key_points && summary.key_points.length) {
    body += `## 핵심 포인트\n\n`;
    for (const pt of summary.key_points) body += `- ${pt}\n`;
    body += '\n';
  }

  if (summary.keywords && summary.keywords.length) body += `**키워드**: ${summary.keywords.join(', ')}\n\n`;
  body += `## 출처\n\n- **URL**: ${url}\n`;
  if (meta.title) body += `- **원제**: ${meta.title}\n`;
  if (meta.image) body += `- **썸네일**: ![thumbnail](${meta.image})\n`;
  return body;
}

// Feed endpoint: returns individual notes with metadata for a date
app.get('/api/feed/:date', auth, (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }
  const notes = getNotesForDate(date);
  res.json({ date, notes });
});

// Get individual note by filename
app.get('/api/note/:filename', auth, (req, res) => {
  const { filename } = req.params;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(NOTES_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Note not found' });
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  res.json({ filename, frontmatter, body: body.trim() });
});

// Process text: simple text memo (replaces POST /api/daily/:date for plain memos)
app.post('/api/process/text', auth, (req, res) => {
  const { content, tags = [], date } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const noteDate = date || new Date().toISOString().split('T')[0];
  const result = createAtomicNote(noteDate, 'memo', content, tags);
  res.json({ ok: true, ...result });
});

// Todo endpoint: create a todo atomic note
app.post('/api/todo', auth, (req, res) => {
  const { text, date } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const noteDate = date || new Date().toISOString().split('T')[0];
  const entry = formatTaskToMarkdown({ title: text });
  const result = createAtomicNote(noteDate, 'todo', entry, ['todo']);
  res.json({ ok: true, ...result });
});

// ============================================================
// Note: Summarize
// ============================================================
app.post('/api/note/summarize', auth, async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) return res.status(400).json({ error: 'Invalid filename' });
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') return res.status(503).json({ error: 'Gemini API key not configured' });

  const filePath = findVVNote(filename);
  if (!filePath) return res.status(404).json({ error: 'Note not found' });

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { body } = parseFrontmatter(raw);
    const maskedBody = applyPrivacyShield(body);
    const prompt = `다음 노트 내용을 3~5문장으로 한국어로 핵심 요약해주세요. 마크다운 없이 일반 텍스트로 답변하세요.\n\n${maskedBody.slice(0, 8000)}`;
    const geminiRes = await fetch(getGeminiApiUrl('pro'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 4096 } })
    });
    if (!geminiRes.ok) return res.status(502).json({ error: 'Gemini API error' });
    const data = await geminiRes.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Note: Delete
// ============================================================
app.post('/api/note/delete', auth, (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) return res.status(400).json({ error: 'Invalid filename' });

  const filePath = findVVNote(filename);
  if (!filePath) return res.status(404).json({ error: 'Note not found' });

  try {
    fs.unlinkSync(filePath);
    invalidateFileCache();
    _vectorCache = null;
    delete titleCache[filename];
    _compiledRegexMap.delete(filename);
    noteCache.invalidate(filename);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Note: Add Comment
// ============================================================
app.post('/api/note/comment', auth, async (req, res) => {
  const { filename, comment } = req.body;
  if (!filename || !comment) return res.status(400).json({ error: 'filename and comment required' });
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) return res.status(400).json({ error: 'Invalid filename' });
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') return res.status(503).json({ error: 'Gemini API key not configured' });

  const filePath = findVVNote(filename);
  if (!filePath) return res.status(404).json({ error: 'Note not found' });

  try {
    const refined = await refineComment(comment);
    appendCommentToNote(filePath, refined);
    res.json({ success: true, refined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function refineComment(comment) {
  // Apply Privacy Shield before sending to external API
  const maskedComment = applyPrivacyShield(comment);
  const prompt = `다음 사용자 코멘트를 맞춤법과 문장을 자연스럽게 다듬어줘. 의미는 절대 변경하지 마. 다듬은 텍스트만 출력하고 설명은 하지 마. 원문: ${maskedComment}`;
  const geminiRes = await fetch(getGeminiApiUrl('lite'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 256 } })
  });
  if (!geminiRes.ok) return comment; // fallback to original
  const data = await geminiRes.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || comment;
}

function appendCommentToNote(filePath, refined) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace('T', ' ');
  const line = `- ${dateStr} — ${refined}`;
  const hasSection = raw.includes('\n## 코멘트');
  const updated = hasSection
    ? raw + '\n' + line
    : raw.trimEnd() + '\n\n## 코멘트\n\n' + line + '\n';
  fs.writeFileSync(filePath, updated, 'utf-8');
}

// ============================================================
// Note: Related
// ============================================================
app.post('/api/note/related', auth, async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) return res.status(400).json({ error: 'Invalid filename' });
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') return res.status(503).json({ error: 'Gemini API key not configured' });

  const filePath = findVVNote(filename);
  if (!filePath) return res.status(404).json({ error: 'Note not found' });

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { body } = parseFrontmatter(raw);
    const keywords = await extractKeywords(body.slice(0, 3000));
    if (!keywords.length) return res.json({ notes: [] });

    const query = keywords.join(' ');
    // 3-tier search: 99_vaultvoice → other user folders → Claude Control (keyword-gated)
    const scored = [];
    function scoreRelated(fp) {
      const base = path.basename(fp);
      if (base === filename) return;
      try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const content = raw.toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (kw.length < 2) continue;
          const regex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          const hits = (content.match(regex) || []).length;
          if (hits > 0) score += Math.min(hits, 5);
        }
        if (score >= 3) { // minimum threshold to avoid garbage matches
          const { frontmatter } = parseFrontmatter(raw);
          scored.push({ filename: base, title: frontmatter.title || base.replace(/\.md$/, ''), score });
        }
      } catch (e) { /* skip */ }
    }
    // Tier 1: VaultVoice notes
    if (fs.existsSync(NOTES_DIR)) getAllMdFiles(NOTES_DIR).forEach(scoreRelated);
    // Tier 2: Other user folders (exclude Claude Control, .obsidian, etc.)
    try {
      for (const d of fs.readdirSync(VAULT_PATH)) {
        if (SEARCH_EXCLUDE_DIRS.has(d) || d === SYSTEM_FOLDER || d === VV_BASE || d.startsWith('.')) continue;
        const fullDir = path.join(VAULT_PATH, d);
        try { if (!fs.statSync(fullDir).isDirectory()) continue; } catch (e) { continue; }
        getAllMdFiles(fullDir).forEach(scoreRelated);
      }
    } catch (e) { /* skip */ }
    // Tier 3: Claude Control (only if keywords match system terms)
    if (SYSTEM_KEYWORDS.test(query)) {
      const sysDir = path.join(VAULT_PATH, SYSTEM_FOLDER);
      if (fs.existsSync(sysDir)) getAllMdFiles(sysDir).forEach(scoreRelated);
    }
    scored.sort((a, b) => b.score - a.score);
    const notes = scored.slice(0, 3).map(s => ({ filename: s.filename, title: s.title, snippet: '' }));
    res.json({ notes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function extractKeywords(text) {
  try {
    // Apply Privacy Shield before sending to external API
    const maskedText = applyPrivacyShield(text);
    const prompt = `다음 텍스트에서 핵심 키워드 3~5개를 추출해줘. 쉼표로 구분된 키워드만 출력하고 설명은 하지 마.\n\n${maskedText}`;
    const geminiRes = await fetch(getGeminiApiUrl('lite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 80 } }),
      signal: AbortSignal.timeout(5000)
    });
    if (!geminiRes.ok) return [];
    const data = await geminiRes.json();
    const t = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return t.split(/[,，\n]+/).map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 20);
  } catch (e) {
    return [];
  }
}

// ============================================================
// Notes: Backfill Titles
// ============================================================
app.post('/api/notes/backfill-titles', auth, async (req, res) => {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_key_here') return res.status(503).json({ error: 'Gemini API key not configured' });
  if (!fs.existsSync(NOTES_DIR)) return res.json({ updated: 0 });

  try {
    const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
    let updated = 0;
    const targets = [];

    for (const f of files) {
      const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
      const { frontmatter } = parseFrontmatter(raw);
      if (!frontmatter.title) targets.push(f);
    }

    const batch = targets.slice(0, 20);
    for (const f of batch) {
      try {
        const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
        const meta = await generateNoteMeta(raw);
        if (meta) {
          injectMetaToFrontmatter(path.join(NOTES_DIR, f), meta);
          if (meta.title) { titleCache[f] = meta.title; _compiledRegexMap.set(f, _buildRegex(meta.title)); }
          updated++;
        }
        await new Promise(r => setTimeout(r, 300)); // rate limit
      } catch (e) { console.warn('[Backfill] Skip', f, e.message); }
    }

    res.json({ updated, remaining: targets.length - updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const NOTE_META_SCHEMA = {
  type: 'object',
  properties: {
    title:    { type: 'string', description: '10~30자 한줄 제목' },
    summary:  { type: 'string', description: '3줄 이내 핵심 요약' },
    type:     { type: 'string', enum: ['meeting-note', 'idea', 'task-list', 'quote', 'voice-memo'] },
    mood:     { type: 'string', enum: ['Positive', 'Neutral', 'Negative'] },
    priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
    area:     { type: 'string', enum: ['Career', 'Health', 'Finance', 'Family', 'Personal'] },
    project:  { type: 'string', description: '프로젝트명 (없으면 빈 문자열)' }
  },
  required: ['title', 'summary', 'type', 'mood', 'priority']
};

async function generateNoteMeta(rawOrBody) {
  const body = rawOrBody.startsWith('---') ? parseFrontmatter(rawOrBody).body : rawOrBody;
  const maskedBody = applyPrivacyShield(body);
  const prompt = `다음 노트를 분석하여 메타데이터를 JSON으로 반환하세요.
- title: 10~30자 한줄 제목
- summary: 3줄 이내 핵심 요약
- type: meeting-note|idea|task-list|quote|voice-memo
- mood: Positive|Neutral|Negative
- priority: High|Medium|Low
- area: Career|Health|Finance|Family|Personal (가장 관련도 높은 단일값, 없으면 생략)
- project: 프로젝트명 (없으면 생략)

노트 내용:
${maskedBody.slice(0, 1500)}`;
  try {
    const geminiRes = await fetch(getGeminiApiUrl('lite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: NOTE_META_SCHEMA, temperature: 0.3, maxOutputTokens: 256 }
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!geminiRes.ok) return null;
    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const meta = JSON.parse(text);
    // Field-level privacy shield on output (defensive)
    if (meta.title)   meta.title   = applyPrivacyShield(meta.title);
    if (meta.summary) meta.summary = applyPrivacyShield(meta.summary);
    if (meta.project) meta.project = applyPrivacyShield(meta.project);
    return meta;
  } catch (e) {
    return null;
  }
}

// Kept for backfill backward-compat
async function generateNoteTitle(rawOrBody) {
  const meta = await generateNoteMeta(rawOrBody);
  return meta ? meta.title : null;
}

function injectMetaToFrontmatter(filePath, meta) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter: fm, body } = parseFrontmatter(raw);
  if (meta.title) {
    fm.title = meta.title;
    if (!Array.isArray(fm.aliases)) fm.aliases = [];
    if (!fm.aliases.includes(meta.title)) fm.aliases.push(meta.title);
  }
  if (meta.summary)  fm.summary  = meta.summary;
  if (meta.type)     fm.type     = meta.type;
  if (meta.mood)     fm.mood     = meta.mood;
  if (meta.priority) fm.priority = meta.priority;
  if (meta.area)     fm.area     = meta.area;
  if (meta.project)  fm.project  = meta.project;
  fs.writeFileSync(filePath, serializeFrontmatter(fm) + body, 'utf-8');
}

function injectTitleToFrontmatter(filePath, raw, title) {
  injectMetaToFrontmatter(filePath, { title });
}

function updateEntityFrontmatter(filePath, entities) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter: fm, body } = parseFrontmatter(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (entities.persons  && entities.persons.length) {
      const wikiPersons = entities.persons.map(n => `[[${n}]]`);
      fm.participants = wikiPersons;
      fm.attendees    = wikiPersons;
      fm.lastContact  = today;
      if (!Array.isArray(fm.tags)) fm.tags = [];
      if (!fm.tags.includes('crm/interaction')) fm.tags.push('crm/interaction');
    }
    if (entities.projects && entities.projects.length) fm.projects = entities.projects.map(n => `[[${n}]]`);
    if (entities.places   && entities.places.length)   fm.places   = entities.places.map(n => `[[${n}]]`);
    fs.writeFileSync(filePath, serializeFrontmatter(fm) + body, 'utf-8');
  } catch (e) {
    console.warn('[NER] updateEntityFrontmatter failed:', e.message);
  }
}

// ============================================================
// Note: Reanalyze (reset analyzed_lenses + re-run perspective)
// ============================================================
app.post('/api/note/reanalyze', auth, async (req, res) => {
  const { filename, lens } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = findVVNote(filename);
  if (!filePath) return res.status(404).json({ error: 'Note not found' });

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter: fm, body } = parseFrontmatter(raw);
  fm.analyzed_lenses = [];
  if (lens) fm.area = lens;
  fs.writeFileSync(filePath, serializeFrontmatter(fm) + body, 'utf-8');

  const freshRaw = fs.readFileSync(filePath, 'utf-8');
  await applyPerspectiveFilters(filePath, freshRaw);
  res.json({ ok: true, filename });
});

// ============================================================
// F7 — Push Subscription endpoints (Sub 2-2)
// ============================================================
app.get('/api/push/vapid-public-key', auth, (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'VAPID not initialized' });
  res.json({ publicKey: key });
});

app.post('/api/push/subscribe', auth, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  await _subQueue.add(() => {
    const subs = loadSubscriptions();
    if (!subs.find(s => s.endpoint === sub.endpoint)) {
      subs.push(sub);
      saveSubscriptions(subs);
    }
  });
  res.status(201).json({ ok: true });
});

app.delete('/api/push/unsubscribe', auth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  await _subQueue.add(() => {
    const subs = loadSubscriptions().filter(s => s.endpoint !== endpoint);
    saveSubscriptions(subs);
  });
  res.json({ ok: true });
});

// ============================================================
// Entity Indexer — resync endpoint
// ============================================================
app.get('/api/entity/resync', auth, (req, res) => {
  resyncEntityMap().catch(e => console.warn('[EntityIndexer] resync error:', e.message));
  res.json({ status: 'ok', counts: { persons: 0, projects: 0, places: 0 } });
});

// ============================================================
// F7 — Daily Briefing helpers (Sub 2-3)
// ============================================================
const BRIEFING_LOG_PATH = path.join(__dirname, 'briefing-log.json');

function getTodayKST() {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, '0');
  const d = String(kst.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getBriefingSentPath(dateKey) {
  return path.join(__dirname, `.briefing-sent-${dateKey}`);
}

async function gatherCalendarEvents(dateKey) {
  try {
    const token = await getAccessToken();
    if (!token) return { events: [], attendees: [] };
    const start = new Date(dateKey + 'T00:00:00+09:00').toISOString();
    const end   = new Date(dateKey + 'T23:59:59+09:00').toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&singleEvents=true&orderBy=startTime`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { events: [], attendees: [] };
    const data = await res.json();
    const events = data.items || [];
    const attendees = [...new Set(events.flatMap(e =>
      (e.attendees || []).map(a => a.displayName || a.email).filter(Boolean)
    ))];
    return { events, attendees };
  } catch (e) {
    console.warn('[Briefing] Calendar fetch failed:', e.message);
    return { events: [], attendees: [] };
  }
}

async function gatherPendingTasks() {
  try {
    const today = getTodayKST();
    const files = (await fs.promises.readdir(NOTES_DIR)).filter(f => f.endsWith('.md'));
    const results = await Promise.all(files.map(async f => {
      try {
        const content = await fs.promises.readFile(path.join(NOTES_DIR, f), 'utf-8');
        return content.split('\n').filter(line => {
          if (!line.match(/^- \[ \]/)) return false;
          const dateStr = (line.match(/📅(\d{4}-\d{2}-\d{2})/) || line.match(/⏳(\d{4}-\d{2}-\d{2})/))?.[ 1];
          return !dateStr || dateStr <= today;
        }).map(l => l.trim());
      } catch (_) { return []; }
    }));
    return results.flat().slice(0, 10);
  } catch (e) {
    console.warn('[Briefing] Task gather failed:', e.message);
    return [];
  }
}

// ============================================================
// Entity-aware Briefing Helpers (Sub 3-1 / Sub 3-2 / SR #2)

/** SR #2: Calendar attendee name에서 직급/호칭 strip */
function normalizeAttendeeName(name) {
  return name.replace(/\s*(?:대표|사장|전무|상무|이사|부장|차장|과장|대리|주임|팀장|님|씨)$/g, '').trim();
}
// ============================================================

/**
 * Levenshtein distance — no external dependency.
 * 📐 임계값: NER dedup ≤ 2 (관대) vs Briefing match ≤ 1 (엄격, 오매칭 방지)
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0).map((_, j) => j === 0 ? i : 0));
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

// hangul-js Jamo fuzzy matching (Step 10)
let Hangul;
try { Hangul = require('hangul-js'); } catch (e) { console.warn('[Hangul] hangul-js not available, falling back to levenshtein'); }

function toJamo(str) {
  if (!Hangul) return str;
  try { return Hangul.disassemble(str).join(''); } catch (e) { return str; }
}

function jamoLevenshtein(a, b) {
  return levenshtein(toJamo(a), toJamo(b));
}

function jamoThreshold(name) {
  return Math.max(1, Math.floor(name.length * 0.3));
}

/**
 * Parse "## 맥락 기록" section from an entity note.
 * Returns array of fact strings, filtered by TTL.
 */
function parseContextSection(raw, ttlDays = 30) {
  if (!raw.includes('## 맥락 기록')) return [];
  const sectionStart = raw.indexOf('## 맥락 기록');
  const afterSection = raw.slice(sectionStart + '## 맥락 기록'.length);
  const nextSecMatch = afterSection.match(/\n## /);
  const sectionBody = nextSecMatch ? afterSection.slice(0, nextSecMatch.index) : afterSection;

  const today = new Date();
  return sectionBody
    .split('\n')
    .filter(l => /^- \d{4}-\d{2}-\d{2}/.test(l))
    .filter(line => {
      const m = line.match(/^- (\d{4}-\d{2}-\d{2})/);
      if (!m) return true;
      return (today - new Date(m[1])) / 86400000 <= ttlDays;
    })
    .map(line => {
      const factMatch = line.match(/^- \d{4}-\d{2}-\d{2} \[30d\] \[\w+\]: (.+)/);
      return factMatch ? factMatch[1].trim() : line.replace(/^- \d{4}-\d{2}-\d{2}[^:]*:\s*/, '').trim();
    })
    .filter(Boolean);
}

/**
 * Find entity note via Levenshtein ≤ 1 match and return context facts.
 * Stricter threshold (1) than NER dedup (2) — briefing 오매칭 방지.
 */
async function getEntityContextForBriefing(attendeeName, ttlDays = 30) {
  try {
    const cleanName = attendeeName.replace(/\[\[|\]\]/g, '').trim();
    const files = (await fs.promises.readdir(NOTES_DIR)).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const entityName = f.replace(/\.md$/, '');
      if (jamoLevenshtein(cleanName, entityName) > jamoThreshold(cleanName)) continue;
      try {
        const raw = await fs.promises.readFile(path.join(NOTES_DIR, f), 'utf-8');
        const facts = parseContextSection(raw, ttlDays);
        if (facts.length) return facts;
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[Briefing] getEntityContextForBriefing failed:', e.message);
  }
  return [];
}

async function generateBriefingText({ events, attendees, tasks, entityContexts = [], followUps = [] }) {
  try {
    // 일정 섹션: 각 일정에 참석자 CRM 맥락 인라인 통합
    const contextByName = Object.fromEntries(entityContexts.map(ec => [ec.name, ec.facts]));
    const evLines = events.length
      ? events.map(e => {
          const time = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
          const parts = [`- ${time} ${(e.summary || '(무제)').slice(0, 200)}`.trim()];
          for (const att of (e.attendees || attendees)) {
            const name = att.displayName || att;
            const facts = contextByName[name];
            if (facts?.length) parts.push(`  → ${name}: ${facts.slice(0, 2).join(' / ')}`);
          }
          return parts.join('\n');
        }).join('\n')
      : '일정 없음';
    const taskText = (tasks.length ? tasks.map(t => `- ${t}`).join('\n') : '없음').slice(0, 500);
    const followUpText = (followUps.length ? followUps.map(f => `- ${f.name} (마지막 연락: ${f.lastContact})`).join('\n') : '없음').slice(0, 500);

    const prompt = [
      '아래 데이터를 바탕으로 오늘의 브리핑을 한국어로 작성해라.',
      '반드시 다음 4개 섹션 헤더를 순서대로 포함해라:',
      '## 📅 오늘 일정',
      '## ✅ 할일',
      '## 👥 팔로우업',
      '## 💬 총평',
      '',
      '각 섹션은 불릿 리스트 또는 1~3문장으로 간결하게 작성해라.',
      '',
      `[오늘 일정 + 참석자 맥락]\n${evLines}`,
      `[마감 임박 할일]\n${taskText}`,
      `[팔로우업 필요]\n${followUpText}`,
    ].join('\n');

    const res = await fetch(getGeminiApiUrl('flash'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (e) {
    console.warn('[Briefing] Gemini failed:', e.message);
    return '';
  }
}

async function prependToBriefingNote(dateKey, content) {
  const filename = `${dateKey}_000000_briefing.md`;
  const filePath = path.join(NOTES_DIR, filename);
  return getPipelineQueue(filePath).add(() => {
    const callout = `> [!info] 📋 데일리 브리핑\n${content.split('\n').map(l => '> ' + l).join('\n')}\n\n`;
    if (fs.existsSync(filePath)) {
      const { frontmatter: fm, body } = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'));
      fs.writeFileSync(filePath, serializeFrontmatter(fm) + '\n' + callout + body.trimStart(), 'utf-8');
    } else {
      const fm = { '날짜': dateKey, 'source_type': 'briefing', '유형': 'briefing', 'tags': ['vaultvoice', 'briefing'], 'title': `${dateKey} 데일리 브리핑` };
      fs.writeFileSync(filePath, serializeFrontmatter(fm) + '\n' + callout, 'utf-8');
    }
  });
}

async function sendPushToAll(payload) {
  if (!webpush) return { pushedCount: 0 };
  const subs = loadSubscriptions();
  let pushedCount = 0;
  const stale = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      pushedCount++;
    } catch (e) {
      // SR #6: 410 Gone / 404 → auto-remove stale subscriptions
      if (e.statusCode === 410 || e.statusCode === 404) stale.push(sub.endpoint);
      else console.warn('[Push] Send failed:', e.message);
    }
  }
  if (stale.length) {
    await _subQueue.add(() => saveSubscriptions(loadSubscriptions().filter(s => !stale.includes(s.endpoint))));
    console.log(`[Push] Removed ${stale.length} stale subscriptions`);
  }
  return { pushedCount };
}

async function gatherFollowUps() {
  try {
    const today = new Date();
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - FOLLOW_UP_DAYS);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    const files = await fs.promises.readdir(NOTES_DIR);
    const followUps = [];
    await Promise.all(files.filter(f => f.endsWith('.md')).map(async f => {
      try {
        const raw = await fs.promises.readFile(path.join(NOTES_DIR, f), 'utf-8');
        const { frontmatter: fm } = parseFrontmatter(raw);
        if (!fm.topic || !Array.isArray(fm.topic) || !fm.topic.includes('person')) return;
        const lc = fm.lastContact;
        if (lc && lc < cutoffISO) followUps.push({ name: fm.name || fm.title || f.replace('.md',''), lastContact: lc });
      } catch (_) {}
    }));
    return followUps;
  } catch (e) {
    console.warn('[Briefing] gatherFollowUps failed:', e.message);
    return [];
  }
}

async function runDailyBriefing() {
  const dateKey  = getTodayKST();
  const sentPath = getBriefingSentPath(dateKey);
  if (fs.existsSync(sentPath)) return { alreadySent: true, dateKey };

  // 1. Calendar (independent try/catch)
  let calData = { events: [], attendees: [] };
  try { calData = await gatherCalendarEvents(dateKey); } catch (e) { console.warn('[Briefing] Step1:', e.message); }

  // 2. Fuzzy match attendees → entity context snippets (Sub 3-3)
  // exact match 제거 → Levenshtein ≤ 1 fuzzy match + entityContextSnippets 수집
  let attendees = [];
  let entityContextSnippets = [];
  try {
    for (const name of calData.attendees) {
      attendees.push(name);
      const facts = await getEntityContextForBriefing(normalizeAttendeeName(name));
      if (facts.length) entityContextSnippets.push({ name, facts });
    }
  } catch (e) { console.warn('[Briefing] Step2:', e.message); }

  // 3. Pending tasks (independent try/catch)
  let tasks = [];
  try { tasks = await gatherPendingTasks(); } catch (e) { console.warn('[Briefing] Step3:', e.message); }

  // 3-5. Follow-up (independent try/catch)
  let followUps = [];
  try { followUps = await gatherFollowUps(); } catch (e) { console.warn('[Briefing] FollowUp:', e.message); }

  // 4. Gemini briefing (independent try/catch)
  let briefing = '';
  try { briefing = await generateBriefingText({ events: calData.events, attendees, tasks, entityContexts: entityContextSnippets, followUps }); } catch (e) { console.warn('[Briefing] Step4:', e.message); }

  // 5. Prepend to daily note (independent try/catch)
  try { await prependToBriefingNote(dateKey, briefing || '데이터를 가져오지 못했습니다.'); } catch (e) { console.warn('[Briefing] Step5:', e.message); }

  // 6. Web Push (independent try/catch)
  let pushResult = { pushedCount: 0 };
  try {
    pushResult = await sendPushToAll({ title: `📋 ${dateKey} 브리핑`, body: (briefing || '').slice(0, 120), icon: '/icon-192.png' });
  } catch (e) { console.warn('[Briefing] Step6:', e.message); }

  // Mark sent only if briefing content was generated (prevent blocking same-day retry on Step4/5 failure)
  if (!briefing) return { briefing: '', pushedCount: 0, dateKey };
  fs.writeFileSync(sentPath, new Date().toISOString(), 'utf-8');
  try {
    const logs = fs.existsSync(BRIEFING_LOG_PATH) ? JSON.parse(fs.readFileSync(BRIEFING_LOG_PATH, 'utf-8')) : [];
    logs.push({ dateKey, sentAt: new Date().toISOString(), pushedCount: pushResult.pushedCount, events: calData.events.length, tasks: tasks.length });
    fs.writeFileSync(BRIEFING_LOG_PATH, JSON.stringify(logs.slice(-30), null, 2), 'utf-8');
  } catch (e) { console.warn('[Briefing] Log failed:', e.message); }

  return { briefing, pushedCount: pushResult.pushedCount, dateKey };
}

// ============================================================
// Pi UI: Note Tags — get current + AI suggestions
// ============================================================
function findNoteFile(filename) {
  const flat = path.join(NOTES_DIR, filename);
  if (fs.existsSync(flat)) return flat;
  try {
    const subdirs = fs.readdirSync(NOTES_DIR).filter(d => {
      try { return fs.statSync(path.join(NOTES_DIR, d)).isDirectory(); } catch (e) { return false; }
    });
    for (const sub of subdirs) {
      const full = path.join(NOTES_DIR, sub, filename);
      if (fs.existsSync(full)) return full;
    }
  } catch (e) {}
  return null;
}

app.post('/api/note/tags', auth, async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const filePath = findNoteFile(filename);
  if (!filePath) return res.status(404).json({ error: 'Note not found' });

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const currentTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.filter(t => t !== 'vaultvoice') : [];

  let suggestions = [];
  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'your_key_here') {
    try {
      const contentForTags = body.replace(/```[\s\S]*?```/g, '').trim().slice(0, 1000);
      const existingStr = currentTags.length ? ` 제외:${currentTags.join(',')}` : '';
      const tagPrompt = `한줄 JSON 배열로 태그 10개.${existingStr} 한국어(약어영어OK). 구체명사우선. 범용금지.\n["태그1","태그2",...] 형식만.\n${contentForTags}`;
      const geminiRes = await fetch(getGeminiApiUrl('flash'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: tagPrompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 512 } }),
        signal: AbortSignal.timeout(10000)
      });
      if (geminiRes.ok) {
        const data = await geminiRes.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        let jsonMatch = cleaned.match(/\[[\s\S]*?\]/);
        if (!jsonMatch && cleaned.includes('[')) {
          let partial = cleaned.slice(cleaned.indexOf('['));
          partial = partial.replace(/,\s*"[^"]*$/, '').replace(/,\s*$/, '');
          if (!partial.endsWith(']')) partial += ']';
          try { JSON.parse(partial); jsonMatch = [partial]; } catch (_) {}
        }
        if (jsonMatch) {
          const rawSugs = JSON.parse(jsonMatch[0]).map(t => String(t).trim()).filter(Boolean);
          const norm = s => s.replace(/\s+/g, '').toLowerCase();
          const currentNorms = new Set(currentTags.map(norm));
          suggestions = rawSugs.filter(t => !currentNorms.has(norm(t)));
        }
      }
    } catch (e) {
      console.error('[Tags] AI suggestion error:', e.message);
    }
  }
  res.json({ currentTags, suggestions });
});

// ============================================================
// Pi UI: Note Tags Save
// ============================================================
app.post('/api/note/tags/save', auth, (req, res) => {
  const { filename, tags } = req.body;
  if (!filename || !Array.isArray(tags)) return res.status(400).json({ error: 'filename and tags array required' });
  const filePath = findNoteFile(filename);
  if (!filePath) return res.status(404).json({ error: 'Note not found' });
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const allTags = tags.includes('vaultvoice') ? tags : ['vaultvoice', ...tags];
    const systemTags = new Set(['vaultvoice', 'voice', 'image', 'memo', 'url', 'file', 'text']);
    frontmatter.tags = allTags;
    frontmatter.user_tags = allTags.filter(t => !systemTags.has(t));
    fs.writeFileSync(filePath, serializeFrontmatter(frontmatter) + body, 'utf-8');
    invalidateFileCache();
    res.json({ success: true, tags: allTags });
  } catch (e) {
    console.error('[Tags Save] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Pi UI: Vault Stats
// ============================================================
app.get('/api/vault/stats', auth, (req, res) => {
  const allFiles = getAllMdFilesCached();
  const stats = { total: allFiles.length, types: {}, tags: {} };
  for (const fp of allFiles) {
    const base = path.basename(fp);
    const typeMatch = base.match(/_([a-z]+)\.md$/);
    const type = typeMatch ? typeMatch[1] : 'other';
    stats.types[type] = (stats.types[type] || 0) + 1;
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const { frontmatter } = parseFrontmatter(raw);
      if (Array.isArray(frontmatter.tags)) {
        for (const t of frontmatter.tags) {
          if (t !== 'vaultvoice') stats.tags[t] = (stats.tags[t] || 0) + 1;
        }
      }
    } catch (e) {}
  }
  res.json(stats);
});

// ============================================================
// Pi UI: Vault Browse
// ============================================================
app.get('/api/vault/browse', auth, (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const filterType = req.query.type || '';
  const filterTag = req.query.tag || '';

  let allFiles = getAllMdFilesCached().slice().sort((a, b) => {
    const da = (path.basename(a).match(/^(\d{4}-\d{2}-\d{2})/) || ['', ''])[1];
    const db = (path.basename(b).match(/^(\d{4}-\d{2}-\d{2})/) || ['', ''])[1];
    if (da && db) return db.localeCompare(da);
    if (da) return -1;
    if (db) return 1;
    return path.basename(b).localeCompare(path.basename(a));
  });

  if (filterType) {
    allFiles = allFiles.filter(f => path.basename(f).endsWith(`_${filterType}.md`));
  }

  const results = [];
  let scanned = 0;
  for (const fp of allFiles) {
    if (filterTag) {
      try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const { frontmatter } = parseFrontmatter(raw);
        if (!Array.isArray(frontmatter.tags) || !frontmatter.tags.includes(filterTag)) continue;
      } catch (e) { continue; }
    }
    scanned++;
    if (scanned <= offset) continue;
    if (results.length >= limit) break;

    const base = path.basename(fp);
    const typeMatch = base.match(/_([a-z]+)\.md$/);
    const type = typeMatch ? typeMatch[1] : 'other';
    const dateMatch = base.match(/^(\d{4}-\d{2}-\d{2})/);
    let date = dateMatch ? dateMatch[1] : '';
    if (!date) { try { date = fs.statSync(fp).mtime.toISOString().slice(0, 10); } catch (e) {} }
    let title = base;
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      if (frontmatter.title) title = frontmatter.title;
      else if (Array.isArray(frontmatter.aliases) && frontmatter.aliases[0]) title = frontmatter.aliases[0];
      const preview = body.replace(/^#+\s.*/gm, '').replace(/\n/g, ' ').trim().slice(0, 300);
      results.push({ filename: base, type, date, title, preview, frontmatter: { tags: frontmatter.tags, '유형': type, '시간': frontmatter['시간'] || '' } });
    } catch (e) {
      results.push({ filename: base, type, date, title, preview: '', frontmatter: {} });
    }
  }
  res.json({ results, total: scanned, offset, hasMore: results.length >= limit });
});

// ============================================================
// Pi UI: Vault Retag (batch AI re-tag for recent notes)
// ============================================================
app.post('/api/vault/retag', auth, aiLimiter, async (req, res) => {
  const days = Math.min(parseInt(req.body?.days) || 7, 30);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const allFiles = getAllMdFilesCached().filter(fp => {
    try { return fs.statSync(fp).mtime.getTime() > cutoff; } catch (e) { return false; }
  });
  const results = [];
  for (const fp of allFiles.slice(0, 50)) {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const contentForTags = body.replace(/```[\s\S]*?```/g, '').trim().slice(0, 800);
      const tagPrompt = `한줄 JSON 배열로 태그 5개. 한국어(약어영어OK). 구체명사우선. 범용금지.\n["태그1","태그2",...] 형식만.\n${contentForTags}`;
      const geminiRes = await fetch(getGeminiApiUrl('flash'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: tagPrompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 256 } }),
        signal: AbortSignal.timeout(8000)
      });
      if (!geminiRes.ok) { results.push({ filename: path.basename(fp), status: 'skipped' }); continue; }
      const data = await geminiRes.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonMatch = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim().match(/\[[\s\S]*?\]/);
      if (!jsonMatch) { results.push({ filename: path.basename(fp), status: 'skipped' }); continue; }
      const newTags = JSON.parse(jsonMatch[0]).map(t => String(t).trim()).filter(Boolean);
      const existingTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
      const merged = [...new Set(['vaultvoice', ...existingTags.filter(t => ['vaultvoice','memo','voice','image','url','file'].includes(t)), ...newTags])];
      frontmatter.tags = merged;
      fs.writeFileSync(fp, serializeFrontmatter(frontmatter) + body, 'utf-8');
      results.push({ filename: path.basename(fp), status: 'ok', tags: merged });
    } catch (e) {
      results.push({ filename: path.basename(fp), status: 'skipped', error: e.message });
    }
  }
  invalidateFileCache();
  res.json({ results });
});

// ============================================================
// SPA fallback
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// Start server
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  VaultVoice v2.0 server running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Vault:   ${VAULT_PATH}`);
  console.log(`  API Key: ${API_KEY}`);
  console.log(`  Gemini:  ${GEMINI_API_KEY && GEMINI_API_KEY !== 'your_key_here' ? 'configured' : 'not configured'}`);
  console.log(`  Obsidian API: ${OBSIDIAN_REST_API_KEY ? OBSIDIAN_REST_URL : 'not configured'}`);
  console.log(`  Audio:   ${AUDIO_DIR}`);
  console.log(`  Images:  ${IMAGES_DIR}\n`);

  // Check Obsidian REST API connectivity
  if (OBSIDIAN_REST_API_KEY) {
    fetch(`${OBSIDIAN_REST_URL}/`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_REST_API_KEY}` }
    }).then(function (r) {
      if (r.ok) console.log('  Obsidian: connected ✓');
      else console.log('  Obsidian: responded but HTTP ' + r.status + ' (filesystem fallback active)');
    }).catch(function () {
      console.log('  Obsidian: not reachable (filesystem fallback active)');
    });
  } else {
    console.log('  Obsidian: API key not set (filesystem-only mode)');
  }

  // Pre-warm file index cache
  try {
    const cached = getAllMdFilesCached();
    console.log(`  File cache: ${cached.length} .md files indexed`);
  } catch (e) { console.log('  File cache: warm-up failed -', e.message); }

  // Pre-load title cache for wiki-link insertion (async, non-blocking)
  setImmediate(() => {
    try {
      loadTitleCache();
      console.log(`  Title cache: ${Object.keys(titleCache).length} titles loaded`);
    } catch (e) { console.log('  Title cache: warm-up failed -', e.message); }
  });

  // Entity Indexer — F5 background scan (non-blocking)
  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'your_key_here') {
    initEntityIndexer(VAULT_PATH);
    console.log('  Entity Indexer: background scan started');
  }

  // Web Push VAPID — F7
  initVapid();

  // Daily Briefing cron 07:30 KST + catch-up (SR #2)
  if (schedule) {
    schedule.scheduleJob({ hour: 7, minute: 30, tz: 'Asia/Seoul' }, () => {
      runDailyBriefing().catch(e => console.warn('[Briefing] Cron failed:', e.message));
    });
    // Catch-up: if server starts after 07:30 and briefing not yet sent
    const kstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    if ((kstNow.getHours() > 7 || (kstNow.getHours() === 7 && kstNow.getMinutes() >= 30))
        && !fs.existsSync(getBriefingSentPath(getTodayKST()))) {
      setImmediate(() => runDailyBriefing().catch(e => console.warn('[Briefing] Catch-up failed:', e.message)));
    }
    console.log('  Daily Briefing: cron 07:30 KST registered');
  }

  // Show LAN IP
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  Network: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});
