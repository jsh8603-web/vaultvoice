/**
 * Shared test helpers — used by api-unit.spec.js and phase3-scenarios.spec.js
 */
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

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

/** SSH connection base command */
const SSH_KEY = `${os.homedir()}/.ssh/google_compute_engine`;
// ConnectTimeout=15: Windows SSH hang/ETIMEDOUT 방지
const SSH_BASE = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -i "${SSH_KEY}" jsh86@35.233.232.24`;

/**
 * Poll a remote file over SSH until predicate is true or maxWait (ms) exceeded.
 * Designed for GCP vault — replaces local pollFile for e2e-realenv tests.
 * @param {string} remotePath  Absolute path on GCP server
 * @param {function} predicate (content: string) => boolean
 * @param {number} maxWait     Max wait in ms (default 60s — AI pipeline takes 5~15s)
 * @returns {string|null}      File content when predicate passed, or last content, or null
 */
async function sshPollFile(remotePath, predicate, maxWait = 60000) {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const content = execSync(`${SSH_BASE} "cat '${remotePath}'"`, {
        timeout: 10000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (predicate(content)) return content;
    } catch (_) {
      // file not yet created or SSH transient error — continue polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // final read attempt regardless of predicate
  try {
    return execSync(`${SSH_BASE} "cat '${remotePath}'"`, {
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (_) {
    return null;
  }
}

module.exports = { pollFile, parseFrontmatter, sshPollFile, SSH_BASE };
