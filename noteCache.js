'use strict';

const TTL = parseInt(process.env.CACHE_TTL_NOTES) || 60000;

class NoteCache {
  constructor() {
    this._byDate = new Map();  // date string -> { data: Note[], ts: number }
    this._tagCount = null;     // { data: {tag:count}, ts: number } | null
    this._allFiles = null;     // { data: string[], ts: number } | null
  }

  getNotesForDate(date) {
    const entry = this._byDate.get(date);
    if (!entry) return null;
    if (Date.now() - entry.ts > TTL) { this._byDate.delete(date); return null; }
    return entry.data;
  }

  setNotesForDate(date, notes) {
    this._byDate.set(date, { data: notes, ts: Date.now() });
  }

  getTagCount() {
    if (!this._tagCount || Date.now() - this._tagCount.ts > TTL) return null;
    return this._tagCount.data;
  }

  setTagCount(data) {
    this._tagCount = { data, ts: Date.now() };
  }

  getAllFiles() {
    if (!this._allFiles || Date.now() - this._allFiles.ts > TTL) return null;
    return this._allFiles.data;
  }

  setAllFiles(files) {
    this._allFiles = { data: files, ts: Date.now() };
  }

  // filename에서 날짜 추출 -> 해당 date 캐시 삭제 + tagCount + allFiles 리셋
  invalidate(filename) {
    if (filename) {
      const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) this._byDate.delete(m[1]);
    }
    this._tagCount = null;
    this._allFiles = null;
  }

  invalidateAll() {
    this._byDate.clear();
    this._tagCount = null;
    this._allFiles = null;
  }
}

module.exports = new NoteCache();
