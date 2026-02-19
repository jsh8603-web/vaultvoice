require('dotenv').config({ override: true });
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3939;
const VAULT_PATH = process.env.VAULT_PATH;
const API_KEY = process.env.API_KEY;
const DAILY_DIR = path.join(VAULT_PATH, '02. Areas/Daily Notes');
const ATTACHMENT_DIR_NAME = process.env.ATTACHMENT_DIR || '99.Attachments';
const ATTACHMENT_DIR = path.join(VAULT_PATH, ATTACHMENT_DIR_NAME);

// File-type specific directories
const PHOTO_DIR_NAME = '02. Areas/Daily Media/Daily Photos';
const SCREENSHOT_DIR_NAME = '02. Areas/Daily Media/Screenshots';
const VOICE_DIR_NAME = '02. Areas/Voice Notes';
const MEETING_DIR_NAME = '02. Areas/Meetings/Meeting Recordings';
const PHOTO_DIR = path.join(VAULT_PATH, PHOTO_DIR_NAME);
const SCREENSHOT_DIR = path.join(VAULT_PATH, SCREENSHOT_DIR_NAME);
const VOICE_DIR = path.join(VAULT_PATH, VOICE_DIR_NAME);
const MEETING_DIR = path.join(VAULT_PATH, MEETING_DIR_NAME);

const MEDIA_DIRS = {
  photo: { name: PHOTO_DIR_NAME, path: PHOTO_DIR },
  screenshot: { name: SCREENSHOT_DIR_NAME, path: SCREENSHOT_DIR },
  voice: { name: VOICE_DIR_NAME, path: VOICE_DIR },
  meeting: { name: MEETING_DIR_NAME, path: MEETING_DIR },
  default: { name: ATTACHMENT_DIR_NAME, path: ATTACHMENT_DIR }
};

const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '10') * 1024 * 1024; // MB to bytes
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
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

// ---- Ensure media directories exist ----
Object.values(MEDIA_DIRS).forEach(d => {
  if (!fs.existsSync(d.path)) fs.mkdirSync(d.path, { recursive: true });
});

// ---- Multer setup for file upload ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.query.type || 'default';
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

  // 3. Daily dir
  results.dailyDir = { ok: fs.existsSync(DAILY_DIR) };

  // 4. Attachment dir
  results.attachmentDir = { ok: fs.existsSync(ATTACHMENT_DIR), path: ATTACHMENT_DIR };

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
  if (fs.existsSync(DAILY_DIR)) {
    const files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.md'));
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
  const dailyExists = fs.existsSync(DAILY_DIR);
  res.json({
    status: 'ok',
    vault: vaultExists,
    dailyDir: dailyExists,
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

  const filePath = path.join(DAILY_DIR, `${date}.md`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Note not found', date });
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);
  res.json({ date, frontmatter, body, raw: content });
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

  // Ensure daily dir exists
  if (!fs.existsSync(DAILY_DIR)) {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
  }

  const filePath = path.join(DAILY_DIR, `${date}.md`);
  const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

  let newEntry;
  if (section === '오늘할일') {
    // Todo format with Dataview-compatible inline metadata
    let meta = '';
    if (priority) meta += ` [priority::${priority}]`;
    if (due) meta += ` [due::${due}]`;
    newEntry = `- [ ] ${content.trim()}${meta}`;
  } else {
    newEntry = `- ${content.trim()} *(${timestamp})*`;
  }

  // Add image sub-items (supports both string and {filename, dirName} object)
  if (images && images.length > 0) {
    for (const img of images) {
      const filename = typeof img === 'string' ? img : img.filename;
      const dir = typeof img === 'string' ? ATTACHMENT_DIR_NAME : (img.dirName || ATTACHMENT_DIR_NAME);
      newEntry += `\n  - ![[${dir}/${filename}]]`;
    }
  }

  // Add audio sub-items (supports both string and {filename, dirName} object)
  if (audios && audios.length > 0) {
    for (const aud of audios) {
      const filename = typeof aud === 'string' ? aud : aud.filename;
      const dir = typeof aud === 'string' ? ATTACHMENT_DIR_NAME : (aud.dirName || ATTACHMENT_DIR_NAME);
      newEntry += `\n  - 🎙️ ![[${dir}/${filename}]]`;
    }
  }

  let result;
  if (fs.existsSync(filePath)) {
    result = appendToExisting(filePath, section, newEntry, tags);
  } else {
    result = createNewNote(filePath, date, section, newEntry, tags);
    invalidateFileCache();
  }

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

  const filePath = path.join(DAILY_DIR, `${date}.md`);
  if (!fs.existsSync(filePath)) {
    return res.json({ todos: [] });
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const todos = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const todoMatch = line.match(/^- \[([ x])\] (.+)$/);
    if (todoMatch) {
      const done = todoMatch[1] === 'x';
      let text = todoMatch[2];

      // Parse inline metadata
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

      todos.push({ lineIndex: i, done, text, priority, due });
    }
  }

  res.json({ todos });
});

// ============================================================
// Toggle todo checkbox
// ============================================================
app.post('/api/todo/toggle', (req, res) => {
  const { date, lineIndex } = req.body;
  if (!date || lineIndex === undefined) {
    return res.status(400).json({ error: 'date and lineIndex are required' });
  }

  const filePath = path.join(DAILY_DIR, `${date}.md`);
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
  const f = path.join(DAILY_DIR, `${date}.md`);
  if (fs.existsSync(f)) {
    return { result: fs.readFileSync(f, 'utf-8').slice(0, 1500) };
  }
  return { result: `${date} 날짜의 노트가 없습니다.` };
}

function executeAddTodo(args) {
  const date = resolveDate(args.date);
  const f = path.join(DAILY_DIR, `${date}.md`);
  const entry = `- [ ] ${args.task} [priority::${args.priority || '보통'}]`;
  if (fs.existsSync(f)) {
    appendToExisting(f, '오늘할일', entry, []);
  } else {
    createNewNote(f, date, '오늘할일', entry, []);
  }
  return { result: `"${args.task}" 할일을 ${date}에 추가했습니다.` };
}

function executeAddMemo(args) {
  const date = resolveDate(args.date);
  const f = path.join(DAILY_DIR, `${date}.md`);
  const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const entry = `- ${args.content.trim()} *(${timestamp})*`;
  if (fs.existsSync(f)) {
    appendToExisting(f, '메모', entry, []);
  } else {
    createNewNote(f, date, '메모', entry, []);
  }
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
          start: { dateTime: args.startTime },
          end: { dateTime: args.endTime }
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
  
  const { summary, start, end } = req.body;
  
  try {
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
          start: { dateTime: start }, // Assume ISO string
          end: { dateTime: end }
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
    // Daily notes only
    if (!fs.existsSync(DAILY_DIR)) return res.json({ results: [], query: q, total: 0 });
    allFiles = fs.readdirSync(DAILY_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(DAILY_DIR, f));
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

  if (!fs.existsSync(DAILY_DIR)) {
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
      if (!fs.existsSync(DAILY_DIR)) return res.json({ results: [], query: q, keywords, total: 0 });
      allFiles = fs.readdirSync(DAILY_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => path.join(DAILY_DIR, f));
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

  if (!fs.existsSync(DAILY_DIR)) {
    return res.json({ tags: [] });
  }

  const files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.md'));
  const recent = files.sort().reverse().slice(0, 30);

  for (const file of recent) {
    const raw = fs.readFileSync(path.join(DAILY_DIR, file), 'utf-8');
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
  if (!fs.existsSync(DAILY_DIR)) {
    return res.json({ notes: [] });
  }

  const files = fs.readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  const notes = files
    .sort()
    .reverse()
    .slice(0, 7)
    .map(file => {
      const date = file.replace('.md', '');
      const raw = fs.readFileSync(path.join(DAILY_DIR, file), 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const preview = body.split('\n').filter(l => l.trim()).slice(0, 3).join(' ').slice(0, 120);
      return { date, tags: frontmatter.tags || [], preview };
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

function createNewNote(filePath, date, section, entry, tags) {
  const allTags = ['daily', ...tags.filter(t => t !== 'daily')];
  const unique = [...new Set(allTags)];

  const fm = { '날짜': date, tags: unique };
  const dayName = getDayName(date);

  let body = `\n# ${date} (${dayName})\n\n`;

  if (section === '오늘할일') {
    body += `## 오늘할일\n\n${entry}\n\n`;
    body += `## 오늘 회고\n\n`;
  } else if (section !== '오늘 회고') {
    body += `## ${section}\n\n${entry}\n\n`;
    body += `## 오늘 회고\n\n`;
  } else {
    body += `## 오늘 회고\n\n${entry}\n\n`;
  }

  const content = serializeFrontmatter(fm) + body;
  fs.writeFileSync(filePath, content, 'utf-8');
  return { created: true };
}

function appendToExisting(filePath, section, entry, tags) {
  let raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);

  // Merge tags
  const existingTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  const allTags = [...new Set([...existingTags, ...tags])];
  frontmatter.tags = allTags;

  // Find section in body
  const sectionHeader = `## ${section}`;
  const sectionIdx = body.indexOf(sectionHeader);

  let newBody;
  if (sectionIdx !== -1) {
    const afterHeader = sectionIdx + sectionHeader.length;
    const nextSection = body.indexOf('\n## ', afterHeader);
    if (nextSection !== -1) {
      const beforeNext = body.substring(0, nextSection);
      const afterNext = body.substring(nextSection);
      newBody = beforeNext.trimEnd() + '\n' + entry + '\n\n' + afterNext.trimStart();
    } else {
      newBody = body.trimEnd() + '\n' + entry + '\n\n';
    }
  } else {
    const reviewIdx = body.indexOf('## 오늘 회고');
    if (reviewIdx !== -1) {
      const before = body.substring(0, reviewIdx);
      const after = body.substring(reviewIdx);
      newBody = before.trimEnd() + '\n\n' + sectionHeader + '\n\n' + entry + '\n\n' + after;
    } else {
      newBody = body.trimEnd() + '\n\n' + sectionHeader + '\n\n' + entry + '\n\n';
    }
  }

  const content = serializeFrontmatter(frontmatter) + newBody;
  fs.writeFileSync(filePath, content, 'utf-8');
  return { updated: true, tagsAdded: tags.filter(t => !existingTags.includes(t)) };
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
  console.log(`  Uploads: ${ATTACHMENT_DIR}\n`);

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
