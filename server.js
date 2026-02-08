require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3939;
const VAULT_PATH = process.env.VAULT_PATH;
const API_KEY = process.env.API_KEY;
const DAILY_DIR = path.join(VAULT_PATH, '10.Daily Notes');

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

// Health check
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

// Get daily note
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

// Create or update daily note
app.post('/api/daily/:date', (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  const { content, tags = [], section = '메모' } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }

  // Ensure daily dir exists
  if (!fs.existsSync(DAILY_DIR)) {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
  }

  const filePath = path.join(DAILY_DIR, `${date}.md`);
  const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const newEntry = `- ${content.trim()} *(${timestamp})*`;

  let result;
  if (fs.existsSync(filePath)) {
    result = appendToExisting(filePath, section, newEntry, tags);
  } else {
    result = createNewNote(filePath, date, section, newEntry, tags);
  }

  res.json({ success: true, date, section, ...result });
});

// Get tag list (frequency sorted)
app.get('/api/tags', (req, res) => {
  const tagCount = {};

  if (!fs.existsSync(DAILY_DIR)) {
    return res.json({ tags: [] });
  }

  const files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.md'));
  // Scan last 30 files max for performance
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

// Recent notes (last 7 days)
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

// --- Helpers ---

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

  if (section !== '오늘 회고') {
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
    // Find end of section (next ## or end of file)
    const afterHeader = sectionIdx + sectionHeader.length;
    const nextSection = body.indexOf('\n## ', afterHeader);
    if (nextSection !== -1) {
      // Insert before next section
      const beforeNext = body.substring(0, nextSection);
      const afterNext = body.substring(nextSection);
      newBody = beforeNext.trimEnd() + '\n' + entry + '\n\n' + afterNext.trimStart();
    } else {
      // Append to end of section (end of file)
      newBody = body.trimEnd() + '\n' + entry + '\n\n';
    }
  } else {
    // Section doesn't exist - insert before "## 오늘 회고" or at end
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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  VaultVoice server running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Vault:   ${VAULT_PATH}`);
  console.log(`  API Key: ${API_KEY}\n`);

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
