require('dotenv').config({ override: true });
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3939;
const VAULT_PATH = process.env.VAULT_PATH;
const API_KEY = process.env.API_KEY;
const DAILY_DIR = path.join(VAULT_PATH, '10.Daily Notes');
const ATTACHMENT_DIR_NAME = process.env.ATTACHMENT_DIR || '99.Attachments';
const ATTACHMENT_DIR = path.join(VAULT_PATH, ATTACHMENT_DIR_NAME);
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '10') * 1024 * 1024; // MB to bytes
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

app.use(express.json());

// No cache for all static files
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

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
  if (req.path === '/health') return next();
  auth(req, res, next);
});

// ---- Multer setup for image upload ----
if (!fs.existsSync(ATTACHMENT_DIR)) {
  fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ATTACHMENT_DIR),
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
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
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

  // 6. Recent notes count
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
app.get('/api/health', (req, res) => {
  const vaultExists = fs.existsSync(VAULT_PATH);
  const dailyExists = fs.existsSync(DAILY_DIR);
  res.json({
    status: 'ok',
    vault: vaultExists,
    dailyDir: dailyExists,
    vaultPath: VAULT_PATH
  });
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

  const { content, tags = [], section = '메모', images = [], priority, due } = req.body;
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

  // Add image sub-items
  if (images && images.length > 0) {
    for (const img of images) {
      newEntry += `\n  - ![[${ATTACHMENT_DIR_NAME}/${img}]]`;
    }
  }

  let result;
  if (fs.existsSync(filePath)) {
    result = appendToExisting(filePath, section, newEntry, tags);
  } else {
    result = createNewNote(filePath, date, section, newEntry, tags);
  }

  res.json({ success: true, date, section, ...result });
});

// ============================================================
// Image upload
// ============================================================
app.post('/api/upload', (req, res, next) => {
  console.log('[UPLOAD] Request received, content-type:', req.headers['content-type']);
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('[UPLOAD] Multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      console.error('[UPLOAD] No file in request');
      return res.status(400).json({ error: 'No image file provided' });
    }
    console.log('[UPLOAD] Success:', req.file.filename, req.file.size, 'bytes');
    res.json({
      success: true,
      filename: req.file.filename,
      path: `${ATTACHMENT_DIR_NAME}/${req.file.filename}`
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
  const filePath = path.join(ATTACHMENT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.sendFile(filePath);
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
// Full-text search across entire vault
// ============================================================
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
    allFiles = getAllMdFiles(VAULT_PATH);
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
      allFiles = getAllMdFiles(VAULT_PATH);
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
  console.log(`  Uploads: ${ATTACHMENT_DIR}\n`);

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
