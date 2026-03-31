if (!process.env.DOTENV_LOADED) require('dotenv').config({ override: true });
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

// Optional AI SDKs (graceful degradation if not installed)
let GoogleGenerativeAI, GoogleAIFileManager, OpenAI;
try {
  ({ GoogleGenerativeAI } = require('@google/generative-ai'));
  ({ GoogleAIFileManager } = require('@google/generative-ai/server'));
} catch (e) { console.warn('[Audio] Gemini SDK not installed:', e.message); }
try {
  ({ default: OpenAI } = require('openai'));
} catch (e) { console.warn('[Audio] OpenAI SDK not installed:', e.message); }

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
const API_KEY = process.env.API_KEY;
// All VaultVoice files go under 99_vaultvoice/ (staging inbox)
const VV_BASE = '99_vaultvoice';
// Atomic notes live flat in VV_BASE (no daily-notes subfolder)
const NOTES_DIR = path.join(VAULT_PATH, VV_BASE);
// Legacy alias kept for backward-compat references inside this file
const DAILY_DIR = NOTES_DIR;
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
const OBSIDIAN_REST_URL = process.env.OBSIDIAN_REST_URL || 'http://localhost:27123';
const OBSIDIAN_REST_API_KEY = process.env.OBSIDIAN_REST_API_KEY || '';

app.set('trust proxy', 1); // Trust first proxy (Cloudflare tunnel)
app.use(express.json());

// No cache for sw.js only (SW manages caching for other assets)
app.use((req, res, next) => {
  if (req.path === '/sw.js') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Request logger (debug)
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
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
  if (req.path === '/health' || req.path === '/reset' || req.path.startsWith('/auth/google')) return next();
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

  // 5. Gemini API
  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'your_key_here') {
    try {
      const testRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'hello' }] }],
            generationConfig: { maxOutputTokens: 10 }
          })
        }
      );
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
    let meta = '';
    if (priority) meta += ` [priority::${priority}]`;
    if (due) meta += ` [due::${due}]`;
    newEntry = `- [ ] ${content.trim()}${meta}`;
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

  let prompt;
  if (action === 'summarize') {
    prompt = `다음은 ${date || '오늘'}의 일일노트 내용입니다. 3~5문장으로 한국어로 핵심을 요약해주세요. 마크다운 없이 일반 텍스트로 답변하세요.\n\n${content}`;
  } else if (action === 'suggest-tags') {
    prompt = `다음 일일노트 내용을 분석해서 적절한 태그를 5~10개 추천해주세요. JSON 배열 형태로만 답변하세요 (예: ["태그1", "태그2"]). 설명 없이 JSON만 출력하세요.\n\n${content}`;
  } else if (action === 'auto-tags') {
    prompt = `다음 메모의 주제/카테고리를 나타내는 태그를 정확히 1~2개 추천하세요. 규칙: 1) 메모의 핵심 주제를 대표하는 명사형 태그 2) 구체적이고 의미있는 단어 (예: 회의, 논문, 진료, 코딩, 운동) 3) "작성", "수정" 같은 동작어 금지. JSON 배열로만 답변. 예: ["회의", "AI프로젝트"]\n\n${content}`;
  } else if (action === 'categorize') {
    prompt = `다음 일일노트 내용을 주제별로 분류해주세요. 각 주제에 관련 메모를 그룹화하고 한국어로 간결하게 정리해주세요. 마크다운 없이 일반 텍스트로 답변하세요.\n\n${content}`;
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error('Gemini API error:', err);
      return res.status(502).json({ error: 'Gemini API error' });
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    let result = text.trim();
    // For suggest-tags, try to parse as JSON
    if (action === 'suggest-tags' || action === 'auto-tags') {
      try {
        // Extract JSON array from response if wrapped in text
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        // Return as-is if parsing fails
      }
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

  const prompt = `당신은 메모에서 일정을 추출하는 어시스턴트입니다.
오늘 날짜: ${referenceDate}

다음 메모를 읽고 일정/약속/미팅/예약이 포함되어 있으면 추출하세요.

날짜 변환: "오늘"=${referenceDate}, "내일"=+1일, "모레"=+2일, "다음주 X요일"=다음주 해당 요일, "이번주 X요일"=이번주 해당 요일(지났으면 다음주), 월/일만 있으면 가장 가까운 미래 날짜
시간 변환: "아침"=09:00~10:00, "점심"=12:00~13:00, "저녁"=18:00~19:00, "오후"=14:00~15:00, 시간 없으면 isAllDay=true, 종료시간 없으면 시작+1시간

반드시 아래 JSON 형식 중 하나만 출력하세요:
일정 있음: {"detected":true,"event":{"title":"제목","date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM","isAllDay":false}}
종일 일정: {"detected":true,"event":{"title":"제목","date":"YYYY-MM-DD","startTime":"","endTime":"","isAllDay":true}}
일정 없음: {"detected":false}

메모: "${content}"`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 512
          }
        })
      }
    );

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

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
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
      }
    );

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
    name: 'search_notes',
    description: 'Search for notes in the vault using keywords.',
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
    description: 'Read the content of a specific daily note (YYYY-MM-DD). Use "today" for current date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Date in YYYY-MM-DD format, or "today"' }
      },
      required: ['date']
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
  // --- New tools: Vault-wide operations via Obsidian REST API ---
  {
    name: 'search_vault',
    description: 'Search the entire Obsidian vault using Obsidian native search. Returns matching notes with context. Use this for finding any note in the vault by content or filename.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search query text' },
        contextLength: { type: 'NUMBER', description: 'Characters of context around matches (default 100)' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_note',
    description: 'Read the content of any note in the vault by its path. Path is relative to vault root (e.g. "50.Work/meeting notes.md").',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'File path relative to vault root (e.g. "folder/note.md")' }
      },
      required: ['path']
    }
  },
  {
    name: 'create_note',
    description: 'Create a new note in the vault. Content should be in Markdown format. Use [[wikilink]] format for links to other notes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'File path relative to vault root (e.g. "00.inbox/new note.md")' },
        content: { type: 'STRING', description: 'Markdown content for the note. Use [[Note Name]] for wikilinks.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'delete_note',
    description: 'Delete a note from the vault. IMPORTANT: Only call this when the user explicitly confirms deletion. Always ask for confirmation first.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'File path relative to vault root' },
        confirmed: { type: 'BOOLEAN', description: 'Must be true to proceed. Always ask user to confirm first.' }
      },
      required: ['path', 'confirmed']
    }
  },
  {
    name: 'append_to_note',
    description: 'Append content to an existing note. Useful for adding links, sections, or content to any note in the vault.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'File path relative to vault root' },
        content: { type: 'STRING', description: 'Content to append. Use [[wikilink]] for links.' },
        heading: { type: 'STRING', description: 'Optional: append under this heading' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_folder',
    description: 'List files and subfolders in a vault folder. Path is relative to vault root (e.g. "50.Work" or "" for root).',
    parameters: {
      type: 'OBJECT',
      properties: {
        folder: { type: 'STRING', description: 'Folder path relative to vault root (e.g. "50.Work"). Use empty string for root.' }
      },
      required: ['folder']
    }
  },
  {
    name: 'run_obsidian_command',
    description: 'Execute an Obsidian command by ID. Use this to trigger plugins like Claudian (Claude AI), templates, etc. Known commands: "claudian:open-view" (open Claude chat), "claudian:new-session" (new Claude session), "claudian:inline-edit" (inline edit).',
    parameters: {
      type: 'OBJECT',
      properties: {
        commandId: { type: 'STRING', description: 'The command ID (e.g. "claudian:open-view", "app:toggle-left-sidebar")' }
      },
      required: ['commandId']
    }
  }
];

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
  if (name === 'search_notes') {
    return await executeSearchNotes(args.query);
  } else if (name === 'read_daily_note') {
    return executeReadDailyNote(args.date);
  } else if (name === 'add_todo') {
    return executeAddTodo(args);
  } else if (name === 'add_memo') {
    return executeAddMemo(args);
  } else if (name === 'get_calendar_events') {
    return await executeGetCalendarEvents(args);
  } else if (name === 'add_calendar_event') {
    return await executeAddCalendarEvent(args);
  // --- New tools ---
  } else if (name === 'search_vault') {
    return await executeSearchVault(args);
  } else if (name === 'read_note') {
    return await executeReadNote(args);
  } else if (name === 'create_note') {
    return await executeCreateNote(args);
  } else if (name === 'delete_note') {
    return await executeDeleteNote(args);
  } else if (name === 'append_to_note') {
    return await executeAppendToNote(args);
  } else if (name === 'list_folder') {
    return await executeListFolder(args);
  } else if (name === 'run_obsidian_command') {
    return await executeObsidianCommand(args);
  }
  return { error: `Unknown tool: ${name}` };
}

async function executeSearchNotes(query) {
  if (!query) return { result: 'No query provided.' };
  const q = query;

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
        .slice(0, 3);

        if (results.length > 0) {
          const snippets = results.map(r => {
            const content = fs.readFileSync(path.join(VAULT_PATH, r.path), 'utf-8');
            return `- [${r.path}] (Score: ${r.score.toFixed(2)})\n${content.slice(0, 300).replace(/\n/g, ' ')}...`;
          });
          return { result: snippets.join('\n\n') };
        }
      }
    } catch (e) {
      console.error('Vector search error:', e.message);
    }
  }

  // Fallback: text search
  const allFiles = getAllMdFiles(VAULT_PATH);
  const matches = [];
  for (const f of allFiles) {
    if (matches.length >= 5) break;
    const content = fs.readFileSync(f, 'utf-8');
    if (content.toLowerCase().includes(q.toLowerCase())) {
      matches.push(`- ${path.basename(f)}: ${content.slice(0, 100).replace(/\n/g, ' ')}...`);
    }
  }
  return { result: matches.length > 0 ? matches.join('\n') : 'No matches found.' };
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
  const entry = `- [ ] ${args.task} [priority::${args.priority || '보통'}]`;
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

// ---- New tool implementations (Obsidian REST API) ----

async function executeSearchVault(args) {
  if (!args.query) return { result: '검색어를 입력해주세요.' };

  try {
    const ctx = args.contextLength || 100;
    const res = await obsidianApi('POST',
      `/search/simple/?query=${encodeURIComponent(args.query)}&contextLength=${ctx}`,
      args.query);
    if (!res.ok) {
      // Fallback to existing text search
      return await executeSearchNotes(args.query);
    }
    const results = await res.json();

    const top = results.slice(0, 5).map(r => {
      const matches = (r.matches || []).slice(0, 2).map(m => {
        const txt = (m.match && m.match.text) || m.context || '';
        return txt.length > ctx ? txt.slice(0, ctx) + '...' : txt;
      });
      return `- [[${r.filename}]]\n  ${matches.join('\n  ')}`;
    });

    return { result: top.length > 0 ? top.join('\n\n') : '검색 결과가 없습니다.' };
  } catch (e) {
    console.error('[Jarvis] search_vault error:', e.message);
    return await executeSearchNotes(args.query);
  }
}

async function executeReadNote(args) {
  if (!args.path) return { result: '파일 경로를 입력해주세요.' };
  if (args.path.includes('..')) return { result: '잘못된 경로입니다.' };

  const MAX_READ = 4000;
  try {
    const encodedPath = encodeURIComponent(args.path).replace(/%2F/g, '/');
    const res = await obsidianApi('GET', `/vault/${encodedPath}`);
    if (!res.ok) {
      if (res.status === 404) return { result: `"${args.path}" 파일을 찾을 수 없습니다.` };
      return { result: `파일 읽기 실패: HTTP ${res.status}` };
    }
    const content = await res.text();
    const truncated = content.length > MAX_READ
      ? content.slice(0, MAX_READ) + `\n\n... (총 ${content.length}자 중 처음 ${MAX_READ}자만 표시)`
      : content;
    return { result: truncated };
  } catch (e) {
    console.error('[Jarvis] read_note error:', e.message);
    // Fallback to filesystem
    try {
      const fullPath = path.join(VAULT_PATH, args.path);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        return { result: content.slice(0, MAX_READ) };
      }
    } catch (e2) { /* ignore */ }
    return { result: '파일을 읽을 수 없습니다: ' + e.message };
  }
}

async function executeCreateNote(args) {
  if (!args.path || !args.content) return { result: '경로와 내용이 필요합니다.' };
  if (args.path.includes('..')) return { result: '잘못된 경로입니다.' };

  const notePath = args.path.endsWith('.md') ? args.path : args.path + '.md';

  try {
    const encodedPath = encodeURIComponent(notePath).replace(/%2F/g, '/');
    const res = await obsidianApi('PUT', `/vault/${encodedPath}`, args.content);
    if (res.ok) {
      return { result: `"${notePath}" 노트를 생성했습니다.` };
    }
    return { result: `노트 생성 실패: HTTP ${res.status}` };
  } catch (e) {
    console.error('[Jarvis] create_note error:', e.message);
    // Fallback to filesystem
    try {
      const fullPath = path.join(VAULT_PATH, notePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, args.content, 'utf-8');
      return { result: `"${notePath}" 노트를 생성했습니다. (파일시스템)` };
    } catch (e2) {
      return { result: '노트 생성 실패: ' + e2.message };
    }
  }
}

async function executeDeleteNote(args) {
  if (!args.path) return { result: '삭제할 파일 경로를 입력해주세요.' };
  if (args.path.includes('..')) return { result: '잘못된 경로입니다.' };

  if (!args.confirmed) {
    return { result: `"${args.path}" 파일을 정말 삭제하시겠습니까? "삭제 확인"이라고 답변해주세요.` };
  }

  try {
    const encodedPath = encodeURIComponent(args.path).replace(/%2F/g, '/');
    const res = await obsidianApi('DELETE', `/vault/${encodedPath}`);
    if (res.ok) {
      invalidateFileCache();
      return { result: `"${args.path}" 파일을 삭제했습니다.` };
    }
    if (res.status === 404) return { result: `"${args.path}" 파일이 존재하지 않습니다.` };
    return { result: `삭제 실패: HTTP ${res.status}` };
  } catch (e) {
    // Filesystem fallback
    try {
      const fullPath = path.join(VAULT_PATH, args.path);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        invalidateFileCache();
        return { result: `"${args.path}" 파일을 삭제했습니다. (파일시스템)` };
      }
      return { result: `"${args.path}" 파일이 존재하지 않습니다.` };
    } catch (e2) {
      return { result: '삭제 실패: ' + e2.message };
    }
  }
}

async function executeAppendToNote(args) {
  if (!args.path || !args.content) return { result: '경로와 내용이 필요합니다.' };
  if (args.path.includes('..')) return { result: '잘못된 경로입니다.' };

  try {
    const encodedPath = encodeURIComponent(args.path).replace(/%2F/g, '/');

    // Read existing content then append
    const readRes = await obsidianApi('GET', `/vault/${encodedPath}`);
    if (!readRes.ok) return { result: `"${args.path}" 파일을 찾을 수 없습니다.` };
    const existing = await readRes.text();
    const updated = existing.trimEnd() + '\n\n' + args.content + '\n';
    const writeRes = await obsidianApi('PUT', `/vault/${encodedPath}`, updated);
    if (writeRes.ok) {
      return { result: `"${args.path}"에 내용을 추가했습니다.` };
    }
    return { result: `내용 추가 실패: HTTP ${writeRes.status}` };
  } catch (e) {
    // Filesystem fallback
    try {
      const fullPath = path.join(VAULT_PATH, args.path);
      if (fs.existsSync(fullPath)) {
        const existing = fs.readFileSync(fullPath, 'utf-8');
        const updated = existing.trimEnd() + '\n\n' + args.content + '\n';
        fs.writeFileSync(fullPath, updated, 'utf-8');
        return { result: `"${args.path}"에 내용을 추가했습니다. (파일시스템)` };
      }
      return { result: `"${args.path}" 파일을 찾을 수 없습니다.` };
    } catch (e2) {
      return { result: '내용 추가 실패: ' + e2.message };
    }
  }
}

async function executeListFolder(args) {
  const folder = (args.folder || '').replace(/\.\./g, '');

  try {
    const encodedPath = folder
      ? encodeURIComponent(folder).replace(/%2F/g, '/') + '/'
      : '';
    const res = await obsidianApi('GET', `/vault/${encodedPath}`);
    if (!res.ok) {
      if (res.status === 404) return { result: `"${folder}" 폴더를 찾을 수 없습니다.` };
      return { result: `폴더 조회 실패: HTTP ${res.status}` };
    }
    const data = await res.json();
    const files = (data.files || []).slice(0, 30);
    if (files.length === 0) return { result: '폴더가 비어있습니다.' };

    const list = files.map(f => `- ${f}`).join('\n');
    const suffix = (data.files || []).length > 30
      ? `\n\n... (총 ${data.files.length}개 중 30개만 표시)`
      : '';
    return { result: list + suffix };
  } catch (e) {
    console.error('[Jarvis] list_folder error:', e.message);
    // Fallback to filesystem
    try {
      const dirPath = path.join(VAULT_PATH, folder);
      if (fs.existsSync(dirPath)) {
        const items = fs.readdirSync(dirPath).filter(f => !f.startsWith('.')).slice(0, 30);
        return { result: items.map(f => `- ${f}`).join('\n') || '폴더가 비어있습니다.' };
      }
    } catch (e2) { /* ignore */ }
    return { result: '폴더 조회 실패: ' + e.message };
  }
}

async function executeObsidianCommand(args) {
  if (!args.commandId) return { result: '명령어 ID를 입력해주세요.' };

  try {
    const res = await obsidianApi('POST', '/commands/' + encodeURIComponent(args.commandId));
    if (res.ok) {
      return { result: `"${args.commandId}" 명령을 실행했습니다.` };
    }
    if (res.status === 404) {
      return { result: `"${args.commandId}" 명령을 찾을 수 없습니다.` };
    }
    return { result: `명령 실행 실패: HTTP ${res.status}` };
  } catch (e) {
    return { result: 'Obsidian 연결 실패. Obsidian이 실행 중인지 확인해주세요: ' + e.message };
  }
}

// Build Gemini conversation history from client history array
function buildContents(history, currentMessage) {
  const contents = [];
  // Include up to 20 recent turns from history
  const trimmed = (history || []).slice(-40); // 40 items = 20 user+model pairs max
  for (const msg of trimmed) {
    if (msg.role === 'user' || msg.role === 'model') {
      contents.push({ role: msg.role, parts: [{ text: msg.text }] });
    }
  }
  // Add current user message
  contents.push({ role: 'user', parts: [{ text: currentMessage }] });
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
  const systemPrompt = `You are Jarvis, a powerful personal assistant for an Obsidian vault.
Current Date: ${todayStr} (${getDayName(todayStr)})

Available tools:
- search_notes: Search notes by keyword (vector + text search, daily notes focused)
- search_vault: Search the ENTIRE vault using Obsidian's native search
- read_daily_note: Read a daily note (use "today" for today)
- read_note: Read ANY note in the vault by path
- create_note: Create a new note with Markdown content. Use [[wikilinks]] for links.
- delete_note: Delete a note (ALWAYS ask for confirmation before deleting)
- append_to_note: Add content to an existing note
- list_folder: List files in a vault folder
- add_todo: Add a todo item to a daily note
- add_memo: Add a general memo to a daily note
- get_calendar_events: Get Google Calendar events
- add_calendar_event: Add a calendar event
- run_obsidian_command: Execute Obsidian commands (e.g. open Claudian AI, templates)

Rules:
- Answer in Korean. Be concise and friendly.
- If the user asks a general question, answer directly without tools.
- When adding items, default to today's date unless specified.
- Use [[wikilink]] format when creating links between notes.
- When creating notes, use proper Obsidian Markdown with frontmatter if appropriate.
- For file deletion, ALWAYS ask for explicit confirmation before proceeding.
- When the user mentions "Claudian" or "Claude", use run_obsidian_command with "claudian:open-view" or "claudian:new-session".
- Use markdown formatting for better readability.
- Keep responses concise. Vault file contents are truncated to 4000 characters.`;

  const contents = buildContents(history, message);
  const MAX_TOOL_ROUNDS = 3;

  try {
    let currentContents = contents;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      let geminiRes;
      try {
        geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents: currentContents,
              tools: [{ function_declarations: JARVIS_TOOLS }],
              generationConfig: { temperature: 0.3 }
            })
          }
        );
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
const VECTOR_FILE = path.join(VAULT_PATH, '.vectors.json');

async function getEmbedding(text) {
  if (!text || !text.trim()) return null;
  // Limit text size for embedding model
  const chunk = text.slice(0, 8000); 
  
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

    fs.writeFileSync(VECTOR_FILE, JSON.stringify(vectors), 'utf-8');
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
    const startObj = isAllDay ? { date: start } : { dateTime: start };
    const endObj = isAllDay ? { date: end } : { dateTime: end };
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
          end: endObj
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
    if (item.startsWith('.') || item === 'node_modules') continue;
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

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const scope = req.query.scope || 'daily'; // 'daily' or 'all'
  if (!q) return res.status(400).json({ error: 'Query required' });

  let allFiles;
  if (scope === 'all') {
    allFiles = getAllMdFilesCached();
  } else {
    // VaultVoice notes only (NOTES_DIR)
    if (!fs.existsSync(NOTES_DIR)) return res.json({ results: [], query: q, total: 0 });
    allFiles = fs.readdirSync(NOTES_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(NOTES_DIR, f));
  }
  const results = [];
  const MAX_RESULTS = 50;

  for (const filePath of allFiles) {
    if (results.length >= MAX_RESULTS) break;
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf-8'); } catch (e) { continue; }

    if (raw.toLowerCase().indexOf(q) === -1) continue;

    const lines = raw.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().indexOf(q) >= 0) {
        matches.push({ line: i, text: lines[i].trim() });
        if (matches.length >= 3) break;
      }
    }

    if (matches.length > 0) {
      // Show relative path from vault root
      const relPath = path.relative(VAULT_PATH, filePath).replace(/\\/g, '/');
      const name = path.basename(filePath, '.md');
      results.push({ date: name, path: relPath, matches });
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
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `사용자가 일일노트에서 "${q}"를 검색하려 합니다. 이 의도와 관련된 한국어 검색 키워드를 10~20개 생성하세요. 유의어, 관련어, 줄임말, 비슷한 표현을 포함하세요. JSON 배열로만 답변하세요. 예: ["키워드1", "키워드2"]` }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 256 }
        })
      }
    );

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
    const results = [];
    const MAX_RESULTS = 50;

    for (const filePath of allFiles) {
      if (results.length >= MAX_RESULTS) break;
      let raw;
      try { raw = fs.readFileSync(filePath, 'utf-8'); } catch (e) { continue; }
      const lower = raw.toLowerCase();

      // Check if any keyword matches
      const matchedKeywords = keywords.filter(k => lower.indexOf(k.toLowerCase()) >= 0);
      if (matchedKeywords.length === 0) continue;

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

      if (matches.length > 0) {
        const relPath = path.relative(VAULT_PATH, filePath).replace(/\\/g, '/');
        const name = path.basename(filePath, '.md');
        results.push({ date: name, path: relPath, matches, relevance: matchedKeywords.length });
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
  const tagCount = {};

  if (!fs.existsSync(NOTES_DIR)) {
    return res.json({ tags: [] });
  }

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

  const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
  // Extract unique dates and sort descending
  const dateMap = {};
  for (const f of files) {
    const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})_/);
    if (dateMatch) {
      const date = dateMatch[1];
      if (!dateMap[date]) dateMap[date] = [];
      dateMap[date].push(f);
    }
  }

  const notes = Object.entries(dateMap)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 7)
    .map(([date, dateFiles]) => {
      const allTags = new Set();
      const previews = [];
      for (const file of dateFiles.sort()) {
        const raw = fs.readFileSync(path.join(NOTES_DIR, file), 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        (frontmatter.tags || []).forEach(t => allTags.add(t));
        const lines = body.split('\n').filter(l => l.trim());
        if (lines.length > 0) previews.push(lines[0]);
      }
      const preview = previews.join(' ').slice(0, 120);
      return { date, tags: [...allTags], preview, noteCount: dateFiles.length };
    });

  res.json({ notes });
});

// ============================================================
// Helpers
// ============================================================
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fm = {};
  const lines = match[1].split('\n');
  let currentKey = null;

  for (const line of lines) {
    const kvMatch = line.match(/^(\w+[\w\s]*?):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1].trim();
      const val = kvMatch[2].trim();
      if (val) {
        fm[currentKey] = val;
      } else {
        fm[currentKey] = [];
      }
    } else if (currentKey && line.match(/^\s+-\s+(.+)$/)) {
      const item = line.match(/^\s+-\s+(.+)$/)[1].trim();
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(item);
    }
  }

  return { frontmatter: fm, body: match[2] };
}

function serializeFrontmatter(fm) {
  let out = '---\n';
  for (const [key, val] of Object.entries(fm)) {
    if (Array.isArray(val)) {
      out += `${key}:\n`;
      for (const item of val) {
        out += `  - ${item}\n`;
      }
    } else {
      out += `${key}: ${val}\n`;
    }
  }
  out += '---\n';
  return out;
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

  const fm = {
    '날짜': date,
    '시간': `"${timeDisplay}"`,
    '유형': type,
    status: 'captured',
    tags: unique,
    summary: '""',
    ...extraFrontmatter
  };
  const body = `\n${entry}\n`;

  const content = serializeFrontmatter(fm) + body;
  fs.writeFileSync(filePath, content, 'utf-8');
  invalidateFileCache();
  return { created: true, filename };
}

// Read all atomic notes for a given date, returns sorted array
function getNotesForDate(date) {
  if (!fs.existsSync(NOTES_DIR)) return [];

  const prefix = `${date}_`;
  const files = fs.readdirSync(NOTES_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.md'))
    .sort();

  return files.map(f => {
    const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    return { filename: f, frontmatter, body: body.trim(), raw };
  });
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

// VM: Recent files (filesystem mtime scan)
app.get('/api/vm/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const files = [];
    const scan = (dir, prefix) => {
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          if (item.startsWith('.')) continue;
          const full = path.join(dir, item);
          const rel = prefix ? prefix + '/' + item : item;
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              scan(full, rel);
            } else if (item.endsWith('.md')) {
              files.push({ path: rel, mtime: stat.mtimeMs, size: stat.size });
            }
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* skip */ }
    };
    scan(VAULT_PATH, '');
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
    console.log('[Audio] Gemini file URI:', fileUri);

    // ── Step 2: Gemini transcription with structured output ───────────────
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    let model;
    try {
      model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    } catch (e) {
      model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    }

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
        }
      },
      required: ['summary', 'participants', 'transcript', 'quality_check']
    };

    const prompt = `이 오디오 파일을 한국어로 전사해주세요.

다음 정보를 JSON으로 반환하세요:
1. summary: 대화/발화의 핵심 내용을 2~3문장으로 요약
2. participants: 화자 목록 (예: ["화자1", "화자2"] 또는 단독 발화면 ["화자1"])
3. transcript: 타임스탬프(MM:SS), 화자, 발화 내용을 순서대로 기록
4. quality_check: 품질 평가
   - broken_sentences: 불완전하게 잘린 문장 목록 (최대 10개)
   - unclear_ratio: 불명확한 발화 비율 (0.0~1.0)
   - repetition_detected: 동일 내용 반복 여부
   - insufficient_content: 의미있는 내용이 너무 적은지 여부

화자가 여럿이면 목소리/톤/내용으로 구분하여 "화자1", "화자2" 등으로 표기하세요.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 min
    let geminiResult = null;
    let geminiError = null;

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
          temperature: 0.1
        }
      });
      const rawText = result.response.text();
      geminiResult = JSON.parse(rawText);
      console.log('[Audio] Gemini transcription OK, segments:', geminiResult.transcript?.length);
    } catch (e) {
      geminiError = e;
      console.error('[Audio] Gemini transcription failed:', e.message);
    } finally {
      clearTimeout(timeout);
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

    // ── Step 4: Build note body and save atomic note ──────────────────────
    const transcriptText = finalTranscript
      .map(s => `**${s.speaker}**: ${s.text}`)
      .join('\n\n');
    const body = `## 요약\n\n${summary}\n\n## 전사\n\n${transcriptText}`;

    const extraFrontmatter = {
      전사방식: usedWhisper ? 'gemini+whisper' : 'gemini',
      화자수: participants.length || 'unknown',
      녹음시간: formatDuration(audioSeconds),
      speakers: participants,
      source: `[[assets/audio/${audioFilename}]]`
    };

    const noteResult = createAtomicNote(date, 'voice', body, [...suggestedTags, 'voice'], extraFrontmatter);
    console.log('[Audio] Atomic note created:', noteResult.filename);

    res.json({
      ok: true,
      filename: noteResult.filename,
      transcription: usedWhisper ? 'gemini+whisper' : 'gemini',
      summary,
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

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    let model;
    try { model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }); }
    catch (e) { model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); }

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

    const analysis = JSON.parse(result.response.text());
    const body = buildImageNoteBody(analysis, imageFilename);
    const tags = ['image', ...(analysis.suggested_tags || [])];
    const extraFrontmatter = {
      이미지유형: analysis.image_type,
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
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  let model;
  try { model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }); }
  catch (e) { model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); }

  const urlSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'summary', 'keywords']
  };
  const prompt = `다음 웹페이지 내용을 한국어로 요약해주세요.\nURL: ${url}\n제목: ${meta.title || '(없음)'}\n\n내용:\n${text}\n\n반환:\n- title: 한국어 제목\n- summary: 핵심 내용 3줄 요약\n- keywords: 핵심 키워드 3개 (한국어)`;
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: urlSchema, temperature: 0.2 }
  });
  return JSON.parse(result.response.text());
}

function buildUrlNoteBody(summary, meta, url) {
  let body = `## 요약\n\n${summary.summary}\n\n`;
  if (meta.description) body += `> ${meta.description}\n\n`;
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
  const entry = `- [ ] ${text}`;
  const result = createAtomicNote(noteDate, 'todo', entry, ['todo']);
  res.json({ ok: true, ...result });
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
