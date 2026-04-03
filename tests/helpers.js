/**
 * Shared test helpers — used by api-unit.spec.js and phase3-scenarios.spec.js
 */
const fs = require('fs');

/** Poll file until predicate is true or timeout (ms) */
async function pollFile(filePath, predicate, maxWait = 10000) {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (predicate(content)) return content;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
}

/** Extract frontmatter block (between first --- and second ---) */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : '';
}

module.exports = { pollFile, parseFrontmatter };
