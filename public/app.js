// ============================================================
// VaultVoice v3.0 — Unified Client (Dark Theme)
// ============================================================

// ---- State ----
var API_KEY = localStorage.getItem('vv_apiKey') || '';
var feedDate = new Date();
var myTags = [];
var allTags = [];
var pendingImageFile = null;   // { file, objectUrl, type }
var pendingAudioBlob = null;   // Blob
var pendingAudioUrl = null;    // objectURL
var audioType = 'voice';
var audioRecorder = null;
var audioRecordingTimer = null;
var audioRecordingStart = 0;
var isRecordingNow = false;

// Legacy state for backward-compat functions
var pendingImages = [];
var pendingAudios = [];

// ---- URL key param auto-login ----
(function () {
  var p = new URLSearchParams(location.search);
  var k = p.get('key');
  if (k) {
    localStorage.setItem('vv_apiKey', k);
    API_KEY = k;
    history.replaceState(null, '', '/');
  }
})();

// ============================================================
// Utilities
// ============================================================
function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function showToast(message, type) {
  type = type || 'info';
  var el = document.createElement('div');
  el.className = 'vv-toast ' + type;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
}

function fmt(d) { return d.toISOString().slice(0, 10); }

function fmtDisplay(d) {
  var days = ['일', '월', '화', '수', '목', '금', '토'];
  var t = new Date(); var m = d.getMonth() + 1; var day = d.getDate();
  if (fmt(d) === fmt(t)) return '오늘 (' + m + '/' + day + ' ' + days[d.getDay()] + ')';
  return m + '/' + day + ' (' + days[d.getDay()] + ')';
}

// ---- API helper ----
function api(path, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['Authorization'] = 'Bearer ' + API_KEY;
  if (!opts.headers['Content-Type'] && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
  }
  return fetch('/api' + path, opts);
}

function apiUpload(path, formData) {
  return fetch('/api' + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + API_KEY },
    body: formData
  });
}

// ============================================================
// Auth
// ============================================================
function doAuth() {
  var input = document.getElementById('key-input');
  var err = document.getElementById('auth-err');
  var key = input.value.trim();
  if (!key) { err.textContent = '키를 입력하세요'; err.style.display = ''; return; }
  err.style.display = 'none';
  fetch('/api/tags', { headers: { 'Authorization': 'Bearer ' + key } })
    .then(function (r) {
      if (r.ok) {
        localStorage.setItem('vv_apiKey', key);
        API_KEY = key;
        showApp();
      } else {
        err.textContent = '키 오류 (' + r.status + ')';
        err.style.display = '';
      }
    })
    .catch(function (e) {
      err.textContent = '연결 실패: ' + e.message;
      err.style.display = '';
    });
}

function doLogout() {
  localStorage.removeItem('vv_apiKey');
  API_KEY = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth').style.display = '';
}

function showApp() {
  document.getElementById('auth').style.display = 'none';
  document.getElementById('app').style.display = '';
  updateFeedDate();
  loadTags();
  initReminders();
  initJarvis();
  checkCalendarStatus();
  loadQuickTodos();
}

// ============================================================
// Tabs (5-tab: input / feed / search / settings / vault)
// ============================================================
var tabTitles = {
  input: '입력',
  feed: '피드',
  search: '검색',
  settings: '설정',
  vault: '관리'
};

function switchTab(name, btn) {
  document.getElementById('hdr').textContent = tabTitles[name] || name;
  document.querySelectorAll('.tab-panel').forEach(function (p) { p.className = 'tab-panel'; });
  document.querySelectorAll('.tab-btn').forEach(function (t) { t.className = 'tab-btn'; });
  var panel = document.getElementById('p-' + name);
  if (panel) panel.className = 'tab-panel active';
  if (btn) btn.className = 'tab-btn active';

  if (name === 'feed') loadFeed();
  if (name === 'search') { loadHistoryFallback(); }
  if (name === 'settings') loadSettings();
}

// ============================================================
// Tags
// ============================================================
function addTag(t) {
  t = t.trim();
  if (!t || myTags.indexOf(t) >= 0) return;
  myTags.push(t);
  renderTags();
}
function removeTag(t) {
  myTags = myTags.filter(function (x) { return x !== t; });
  renderTags();
}
function renderTags() {
  var el = document.getElementById('tagList');
  if (!el) return;
  el.innerHTML = myTags.map(function (t) {
    return '<span class="tag">' + esc(t) + '<span class="tag-x" data-tag="' + esc(t) + '">&times;</span></span>';
  }).join('');
  el.querySelectorAll('.tag-x').forEach(function (x) {
    x.addEventListener('click', function () { removeTag(x.getAttribute('data-tag')); });
  });
}

function loadTags() {
  api('/tags').then(function (r) { return r.json(); }).then(function (d) { allTags = d.tags || []; }).catch(function () { });
}

// ============================================================
// Input Hub
// ============================================================
function clearInput() {
  document.getElementById('mainInput').value = '';
  myTags = [];
  renderTags();
  clearPendingFiles();
}

function clearPendingFiles() {
  if (pendingAudioUrl) { URL.revokeObjectURL(pendingAudioUrl); pendingAudioUrl = null; }
  if (pendingImageFile && pendingImageFile.objectUrl) { URL.revokeObjectURL(pendingImageFile.objectUrl); }
  pendingImageFile = null;
  pendingAudioBlob = null;
  // Also clear legacy state
  pendingImages.forEach(function (img) { URL.revokeObjectURL(img.objectUrl); });
  pendingImages = [];
  pendingAudios.forEach(function (a) { URL.revokeObjectURL(a.objectUrl); });
  pendingAudios = [];
  updatePreviewArea();
  // Reset action btn states
  document.querySelectorAll('.action-btn').forEach(function (b) { b.classList.remove('active'); });
}

function updatePreviewArea() {
  var area = document.getElementById('previewArea');
  if (!area) return;
  if (pendingImageFile) {
    area.style.display = '';
    area.innerHTML = '<div style="position:relative;display:inline-block">' +
      '<img src="' + pendingImageFile.objectUrl + '" style="max-width:100%;max-height:120px;border-radius:8px;object-fit:cover" alt="preview">' +
      '<button onclick="clearPendingFiles()" style="position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,0.7);color:#fff;border:none;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center">&times;</button>' +
      '</div>';
  } else if (pendingAudioBlob) {
    area.style.display = '';
    area.innerHTML = '<div style="display:flex;align-items:center;gap:8px">' +
      '<audio controls src="' + pendingAudioUrl + '" style="flex:1;height:36px"></audio>' +
      '<button onclick="clearPendingFiles()" style="width:28px;height:28px;border-radius:50%;background:none;border:1px solid var(--sep);color:var(--red);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">&times;</button>' +
      '</div>';
  } else {
    area.style.display = 'none';
    area.innerHTML = '';
  }
}

// Camera / Gallery
function handleImageCapture(file, type) {
  if (!file) return;
  if (pendingImageFile && pendingImageFile.objectUrl) URL.revokeObjectURL(pendingImageFile.objectUrl);
  var objectUrl = URL.createObjectURL(file);
  pendingImageFile = { file: file, objectUrl: objectUrl, type: type || 'photo' };
  // Also push to legacy pendingImages for backward compat
  pendingImages = [{ file: file, objectUrl: objectUrl, serverId: null, dirName: null, type: type || 'photo' }];
  updatePreviewArea();
}

// Record button — toggle recording
function toggleRecording() {
  var btn = document.getElementById('btnRecord');
  if (isRecordingNow) {
    stopRecording();
    btn.classList.remove('active', 'recording');
  } else {
    startRecording();
    btn.classList.add('active', 'recording');
  }
}

function startRecording() {
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(function (stream) {
      var mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/mp4';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
      }
      var opts = mimeType ? { mimeType: mimeType } : {};
      audioRecorder = new MediaRecorder(stream, opts);
      var chunks = [];
      isRecordingNow = true;

      audioRecorder.ondataavailable = function (e) {
        if (e.data.size > 0) chunks.push(e.data);
      };

      audioRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        isRecordingNow = false;
        clearInterval(audioRecordingTimer);
        var blob = new Blob(chunks, { type: audioRecorder.mimeType || 'audio/webm' });
        pendingAudioBlob = blob;
        if (pendingAudioUrl) URL.revokeObjectURL(pendingAudioUrl);
        pendingAudioUrl = URL.createObjectURL(blob);
        // Also push to legacy pendingAudios
        pendingAudios = [{ blob: blob, objectUrl: pendingAudioUrl, serverId: null, dirName: null, type: audioType }];
        updatePreviewArea();
        showToast('녹음 완료!', 'success');
      };

      audioRecorder.start(5000); // 5s timeslice for iOS
      audioRecordingStart = Date.now();
      audioRecordingTimer = setInterval(function () {
        var elapsed = Math.floor((Date.now() - audioRecordingStart) / 1000);
        var m = Math.floor(elapsed / 60);
        var s = elapsed % 60;
        var btn = document.getElementById('btnRecord');
        if (btn) btn.title = '녹음 중: ' + m + ':' + (s < 10 ? '0' : '') + s;
      }, 500);
    })
    .catch(function (e) { showToast('마이크 접근 실패: ' + e.message, 'error'); });
}

function stopRecording() {
  if (audioRecorder && audioRecorder.state === 'recording') {
    audioRecorder.stop();
  }
  isRecordingNow = false;
  clearInterval(audioRecordingTimer);
}

// URL detection
function detectUrl() {
  var text = (document.getElementById('mainInput').value || '').trim();
  if (text.match(/^https?:\/\//)) return text;
  return null;
}

// Save
function handleSave() {
  var text = (document.getElementById('mainInput').value || '').trim();
  var tags = myTags.slice();
  var fb = document.getElementById('inputFeedback');
  var btn = document.getElementById('btnSave');

  if (!text && !pendingImageFile && !pendingAudioBlob) {
    document.getElementById('mainInput').focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = '저장 중...';
  fb.style.display = 'none';

  var promise;

  if (pendingAudioBlob) {
    // Atomic: POST /api/process/audio
    var ext = '.webm';
    if (pendingAudioBlob.type && pendingAudioBlob.type.includes('mp4')) ext = '.mp4';
    var fd = new FormData();
    fd.append('file', pendingAudioBlob, 'recording' + ext);
    fd.append('tags', JSON.stringify(tags));
    fd.append('type', audioType);
    if (text) fd.append('memo', text);
    promise = apiUpload('/process/audio', fd).then(function (r) { return r.json(); });
  } else if (pendingImageFile) {
    // Atomic: POST /api/process/image
    var fd2 = new FormData();
    fd2.append('file', pendingImageFile.file, pendingImageFile.file.name || 'photo.jpg');
    fd2.append('tags', JSON.stringify(tags));
    if (text) fd2.append('memo', text);
    promise = apiUpload('/process/image', fd2).then(function (r) { return r.json(); });
  } else {
    var detectedUrl = detectUrl();
    if (detectedUrl) {
      // Atomic: POST /api/process/url
      promise = api('/process/url', {
        method: 'POST',
        body: JSON.stringify({ url: detectedUrl, tags: tags, memo: text !== detectedUrl ? text : '' })
      }).then(function (r) { return r.json(); });
    } else {
      // Atomic: POST /api/process/text
      promise = api('/process/text', {
        method: 'POST',
        body: JSON.stringify({ content: text, tags: tags })
      }).then(function (r) { return r.json(); });
    }
  }

  promise.then(function (d) {
    if (d && (d.success || d.filename || d.ok !== false)) {
      fb.textContent = '저장 완료!';
      fb.className = 'feedback ok';
      fb.style.display = '';
      if (navigator.vibrate) navigator.vibrate(50);
      var savedText = text;
      clearInput();
      detectCalendarEvent(savedText, new Date());
      setTimeout(function () { fb.style.display = 'none'; }, 3000);
      // Refresh feed if on feed tab
      feedDate = new Date();
    } else {
      fb.textContent = '저장 실패: ' + (d && d.error ? d.error : '알 수 없는 오류');
      fb.className = 'feedback fail';
      fb.style.display = '';
    }
  }).catch(function (e) {
    fb.textContent = '실패: ' + e.message;
    fb.className = 'feedback fail';
    fb.style.display = '';
  }).then(function () {
    btn.disabled = false;
    btn.textContent = '저장';
  });
}

// ============================================================
// Quick Todo (Input tab)
// ============================================================
var quickTodos = [];

function loadQuickTodos() {
  api('/daily/' + fmt(new Date()) + '/todos')
    .then(function (r) { if (!r.ok) return; return r.json(); })
    .then(function (d) {
      if (!d || !d.todos) return;
      quickTodos = d.todos;
      renderQuickTodos();
    })
    .catch(function () {});
}

function addQuickTodo() {
  var input = document.getElementById('todoInput');
  var text = (input.value || '').trim();
  if (!text) return;
  input.value = '';

  api('/todo', {
    method: 'POST',
    body: JSON.stringify({ text: text, date: fmt(new Date()) })
  }).then(function (r) {
    if (r.ok) {
      showToast('할일 추가!', 'success');
      loadQuickTodos();
    }
  }).catch(function () {});
}

function renderQuickTodos() {
  var el = document.getElementById('quickTodoList');
  if (!el || !quickTodos.length) { if (el) el.innerHTML = ''; return; }
  el.innerHTML = quickTodos.slice(0, 5).map(function (todo) {
    var doneClass = todo.done ? ' done' : '';
    var checkClass = todo.done ? ' checked' : '';
    return '<div class="todo-item' + doneClass + '">' +
      '<button class="todo-check' + checkClass + '" data-line="' + todo.lineIndex + '" data-date="' + fmt(new Date()) + '">' + (todo.done ? '✓' : '') + '</button>' +
      '<span class="todo-text">' + esc(todo.text) + '</span>' +
      '</div>';
  }).join('');
  el.querySelectorAll('.todo-check').forEach(function (btn) {
    btn.addEventListener('click', function () {
      toggleTodo(btn.getAttribute('data-date'), parseInt(btn.getAttribute('data-line')), '');
      setTimeout(loadQuickTodos, 500);
    });
  });
}

// ============================================================
// Feed Tab (replaces Today tab)
// ============================================================
function updateFeedDate() {
  var el = document.getElementById('feedDate');
  if (el) el.textContent = fmtDisplay(feedDate);
}

function shiftFeedDate(n) {
  feedDate.setDate(feedDate.getDate() + n);
  updateFeedDate();
  loadFeed();
}

function loadFeed() {
  updateFeedDate();
  var el = document.getElementById('feedCards');
  var todoSection = document.getElementById('todo-list-section');

  el.innerHTML = '<div class="empty">로딩 중...</div>';

  api('/feed/' + fmt(feedDate))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var notes = d.notes || [];
      if (!notes.length) {
        el.innerHTML = '<div class="empty">이 날 기록이 없습니다</div>';
        if (todoSection) todoSection.style.display = 'none';
        return;
      }
      el.innerHTML = renderFeedCards(notes);
      // Store notes for swipe navigation
      window._feedNotes = notes;
      // Attach click events
      el.querySelectorAll('.feed-card').forEach(function (card) {
        card.style.cursor = 'pointer';
        card.addEventListener('click', function () {
          var fn = card.getAttribute('data-filename');
          if (fn) openNoteDetail(fn);
        });
      });
    })
    .catch(function (e) { el.innerHTML = '<div class="empty">오류: ' + e.message + '</div>'; });

  loadTodosForFeed();
}

function renderFeedCards(notes) {
  return notes.map(function (note) {
    var fm = note.frontmatter || {};
    var cardType = fm['유형'] || 'memo';
    var time = fm['시간'] || '';
    var tags = fm.tags || [];
    var body = note.body || '';
    var preview = body.length > 200 ? body.substring(0, 200) + '...' : body;
    var tagHtml = tags.filter(function (t) { return t !== 'vaultvoice'; }).map(function (t) {
      return '<span class="card-tag">#' + esc(t) + '</span>';
    }).join('');
    return '<div class="feed-card card-' + cardType + '" data-filename="' + esc(note.filename || '') + '">' +
      '<div class="card-header">' +
      '<span class="card-icon">' + typeIcon(cardType) + '</span>' +
      '<span style="font-size:14px;font-weight:600;color:var(--text)">' + esc(cardType) + '</span>' +
      (time ? '<span class="card-time">' + esc(time) + '</span>' : '') +
      '</div>' +
      '<div class="card-body">' + renderMd(preview) + '</div>' +
      (tagHtml ? '<div class="card-tags">' + tagHtml + '</div>' : '') +
      '</div>';
  }).join('');
}

function typeIcon(type) {
  var icons = { voice: 'Voice', image: 'Image', url: 'URL', memo: 'Memo', todo: 'Todo' };
  return icons[type] || 'Note';
}

function loadTodosForFeed() {
  var todoSection = document.getElementById('todo-list-section');
  var todoList = document.getElementById('todo-list');
  if (!todoSection || !todoList) return;

  api('/daily/' + fmt(feedDate) + '/todos')
    .then(function (r) {
      if (!r.ok) { todoSection.style.display = 'none'; return; }
      return r.json();
    })
    .then(function (d) {
      if (!d || !d.todos || !d.todos.length) {
        todoSection.style.display = 'none';
        return;
      }
      todoSection.style.display = '';
      todoList.innerHTML = d.todos.map(function (todo) {
        var pClass = '';
        if (todo.priority === '높음') pClass = ' priority-high';
        else if (todo.priority === '낮음') pClass = ' priority-low';
        var doneClass = todo.done ? ' done' : '';
        var checkClass = todo.done ? ' checked' : '';
        var meta = [];
        if (todo.priority) meta.push(todo.priority);
        if (todo.due) meta.push('~' + todo.due);
        var hasReminder = hasReminderForTodo(fmt(feedDate), todo.lineIndex);
        var bellClass = hasReminder ? ' has-reminder' : '';
        return '<div class="todo-item' + pClass + doneClass + '">' +
          '<button class="todo-check' + checkClass + '" data-line="' + todo.lineIndex + '" data-date="' + fmt(feedDate) + '" data-file="' + (todo.filename || '') + '">' + (todo.done ? '✓' : '') + '</button>' +
          '<span class="todo-text">' + esc(todo.text) + '</span>' +
          (meta.length ? '<span class="todo-meta">' + esc(meta.join(' · ')) + '</span>' : '') +
          '<button class="todo-bell' + bellClass + '" data-line="' + todo.lineIndex + '" data-text="' + esc(todo.text) + '" title="알림 설정"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></button>' +
          '</div>';
      }).join('');

      todoList.querySelectorAll('.todo-check').forEach(function (btn) {
        btn.addEventListener('click', function () {
          toggleTodo(btn.getAttribute('data-date'), parseInt(btn.getAttribute('data-line')), btn.getAttribute('data-file'));
        });
      });
      todoList.querySelectorAll('.todo-bell').forEach(function (btn) {
        btn.addEventListener('click', function () {
          openReminderDialog(
            btn.getAttribute('data-text'),
            fmt(feedDate),
            parseInt(btn.closest('.todo-item').querySelector('.todo-check').getAttribute('data-line'))
          );
        });
      });
    })
    .catch(function () { if (todoSection) todoSection.style.display = 'none'; });
}

function toggleTodo(date, lineIndex, filename) {
  var body = { date: date, lineIndex: lineIndex };
  if (filename) body.filename = filename;
  api('/todo/toggle', {
    method: 'POST',
    body: JSON.stringify(body)
  }).then(function (r) {
    if (r.ok) loadFeed();
  }).catch(function () {});
}

// ============================================================
// AI Summarization (Feed tab)
// ============================================================
function doAI(action) {
  var resultEl = document.getElementById('ai-result');
  var buttons = document.querySelectorAll('.ai-btn');
  buttons.forEach(function (b) { b.disabled = true; });
  resultEl.style.display = '';
  resultEl.innerHTML = '<div style="text-align:center;color:var(--text2)">AI 처리 중...</div>';

  api('/feed/' + fmt(feedDate))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var notes = d.notes || [];
      if (!notes.length) throw new Error('이 날 기록이 없습니다');
      var combined = notes.map(function (n) { return n.body || ''; }).join('\n\n');
      return api('/ai/summarize', {
        method: 'POST',
        body: JSON.stringify({ action: action, content: combined, date: fmt(feedDate) })
      });
    })
    .then(function (r) {
      if (!r.ok) throw new Error('AI 요청 실패');
      return r.json();
    })
    .then(function (d) {
      if (action === 'suggest-tags') {
        var tags = d.result;
        if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch (e) { tags = [tags]; } }
        if (!Array.isArray(tags)) tags = [tags];
        resultEl.innerHTML = '<h3>추천 태그</h3>' +
          tags.map(function (t) {
            return '<span class="ai-tag-chip" data-tag="' + esc(t) + '">' + esc(t) + '</span>';
          }).join('');
        resultEl.querySelectorAll('.ai-tag-chip').forEach(function (chip) {
          chip.addEventListener('click', function () {
            addTag(chip.getAttribute('data-tag'));
            chip.style.background = 'var(--blue)';
            chip.style.color = '#fff';
          });
        });
      } else {
        var text = d.result || '';
        resultEl.innerHTML = '<h3>' + (action === 'summarize' ? 'AI 요약' : '주제별 분류') + '</h3>' +
          '<div style="white-space:pre-wrap">' + esc(text) + '</div>';
      }
    })
    .catch(function (e) {
      resultEl.innerHTML = '<div style="color:var(--red)">' + esc(e.message) + '</div>';
    })
    .finally(function () {
      buttons.forEach(function (b) { b.disabled = false; });
    });
}

// ============================================================
// Search Tab
// ============================================================
function loadHistoryFallback() {
  var histList = document.getElementById('hist-list');
  var searchResults = document.getElementById('searchResults');
  if (!histList) return;
  // Show recent notes as default
  if (!searchResults.children.length) {
    api('/notes/recent')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.notes || !d.notes.length) {
          histList.innerHTML = '<div class="empty">최근 기록 없음</div>';
          histList.style.display = '';
          return;
        }
        histList.innerHTML = d.notes.map(function (n) {
          return '<div class="hist-item" data-date="' + n.date + '">' +
            '<div class="hist-date">' + n.date + '</div>' +
            '<div class="hist-preview">' + esc(n.preview) + '</div></div>';
        }).join('');
        histList.style.display = '';
        histList.querySelectorAll('.hist-item').forEach(function (item) {
          item.addEventListener('click', function () { openPreview(item.getAttribute('data-date')); });
        });
      })
      .catch(function () { histList.innerHTML = '<div class="empty">로딩 실패</div>'; histList.style.display = ''; });
  }
}

function openPreview(date) {
  var el = document.getElementById('hist-detail');
  var ov = document.getElementById('hist-overlay');
  api('/daily/' + date)
    .then(function (r) { return r.json(); })
    .then(function (d) { el.innerHTML = renderMd(d.body); ov.style.display = ''; })
    .catch(function () { el.innerHTML = '<div class="empty">오류</div>'; ov.style.display = ''; });
}

function closePreview() { document.getElementById('hist-overlay').style.display = 'none'; }

// ── Note Detail: swipeable card view ──
function openNoteDetail(filename) {
  var overlay = document.getElementById('note-detail-overlay');
  var card = document.getElementById('note-detail-card');
  var bodyEl = document.getElementById('note-detail-body');
  var typeEl = document.getElementById('note-detail-type');
  var timeEl = document.getElementById('note-detail-time');
  var tagsEl = document.getElementById('note-detail-tags');
  var indEl = document.getElementById('note-detail-indicator');

  overlay.style.display = '';
  card.style.transform = '';
  card.style.opacity = '1';
  card.style.transition = '';

  // Find current index in feed notes
  var notes = window._feedNotes || [];
  var idx = notes.findIndex(function (n) { return n.filename === filename; });
  window._noteDetailIdx = idx;

  // Show indicator
  if (notes.length > 1 && idx >= 0) {
    indEl.textContent = (idx + 1) + ' / ' + notes.length;
    indEl.style.display = '';
  } else {
    indEl.style.display = 'none';
  }

  // Use cached data from feed if available (instant load)
  var cached = idx >= 0 ? notes[idx] : null;
  if (cached && cached.body) {
    var fm = cached.frontmatter || {};
    typeEl.textContent = typeIcon(fm['유형'] || 'memo');
    timeEl.textContent = fm['시간'] || '';
    bodyEl.innerHTML = renderMd(cached.body);
    var tags = (fm.tags || []).filter(function (t) { return t !== 'vaultvoice'; });
    tagsEl.innerHTML = tags.map(function (t) {
      return '<span class="card-tag">#' + esc(t) + '</span>';
    }).join('');
  } else {
    bodyEl.innerHTML = '<div class="empty">로딩 중...</div>';
    api('/note/' + encodeURIComponent(filename))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var fm = d.frontmatter || {};
        typeEl.textContent = typeIcon(fm['유형'] || 'memo');
        timeEl.textContent = fm['시간'] || '';
        bodyEl.innerHTML = renderMd(d.body || '');
        var tags = (fm.tags || []).filter(function (t) { return t !== 'vaultvoice'; });
        tagsEl.innerHTML = tags.map(function (t) {
          return '<span class="card-tag">#' + esc(t) + '</span>';
        }).join('');
      })
      .catch(function () { bodyEl.innerHTML = '<div class="empty">오류</div>'; });
  }

  // Swipe gesture setup
  setupNoteSwipe(card, overlay);
}

function setupNoteSwipe(card, overlay) {
  var startX = 0, startY = 0, dx = 0, swiping = false;

  function onStart(e) {
    var touch = e.touches ? e.touches[0] : e;
    startX = touch.clientX;
    startY = touch.clientY;
    dx = 0;
    swiping = true;
    card.style.transition = 'none';
  }
  function onMove(e) {
    if (!swiping) return;
    var touch = e.touches ? e.touches[0] : e;
    dx = touch.clientX - startX;
    var dy = Math.abs(touch.clientY - startY);
    if (dy > Math.abs(dx) * 1.5) { swiping = false; card.style.transform = ''; return; }
    if (Math.abs(dx) > 10) e.preventDefault();
    card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx * 0.03) + 'deg)';
    card.style.opacity = Math.max(0.3, 1 - Math.abs(dx) / 400);
  }
  function onEnd() {
    if (!swiping) return;
    swiping = false;
    var threshold = 100;

    if (dx < -threshold) {
      // Left swipe → close
      card.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      card.style.transform = 'translateX(-120%) rotate(-10deg)';
      card.style.opacity = '0';
      setTimeout(function () { closeNoteDetail(); }, 300);
    } else if (dx > threshold) {
      // Right swipe → next card
      var notes = window._feedNotes || [];
      var nextIdx = (window._noteDetailIdx || 0) + 1;
      if (nextIdx < notes.length) {
        card.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
        card.style.transform = 'translateX(120%) rotate(10deg)';
        card.style.opacity = '0';
        setTimeout(function () {
          openNoteDetail(notes[nextIdx].filename);
        }, 300);
      } else {
        // Bounce back — no more cards
        card.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
        card.style.transform = '';
        card.style.opacity = '1';
      }
    } else {
      // Bounce back
      card.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      card.style.transform = '';
      card.style.opacity = '1';
    }
  }

  // Remove old listeners
  card._noteSwipeClean && card._noteSwipeClean();
  card.addEventListener('touchstart', onStart, { passive: true });
  card.addEventListener('touchmove', onMove, { passive: false });
  card.addEventListener('touchend', onEnd);
  card.addEventListener('mousedown', onStart);
  card.addEventListener('mousemove', onMove);
  card.addEventListener('mouseup', onEnd);
  card._noteSwipeClean = function () {
    card.removeEventListener('touchstart', onStart);
    card.removeEventListener('touchmove', onMove);
    card.removeEventListener('touchend', onEnd);
    card.removeEventListener('mousedown', onStart);
    card.removeEventListener('mousemove', onMove);
    card.removeEventListener('mouseup', onEnd);
  };
}

function closeNoteDetail() {
  var overlay = document.getElementById('note-detail-overlay');
  overlay.style.display = 'none';
  var card = document.getElementById('note-detail-card');
  card._noteSwipeClean && card._noteSwipeClean();
}

// Close on background tap
document.addEventListener('DOMContentLoaded', function () {
  var overlay = document.getElementById('note-detail-overlay');
  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeNoteDetail();
    });
  }
});

function doSearch() {
  var q = (document.getElementById('searchInput').value || '').trim();
  var resultsEl = document.getElementById('searchResults');
  var histList = document.getElementById('hist-list');

  if (!q) {
    resultsEl.innerHTML = '';
    histList.style.display = '';
    loadHistoryFallback();
    return;
  }

  histList.style.display = 'none';
  resultsEl.innerHTML = '<div class="empty" style="padding:16px">검색 중...</div>';

  var scope = document.getElementById('search-all-vault').checked ? 'all' : 'daily';
  api('/search?q=' + encodeURIComponent(q) + '&scope=' + scope)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.results || !d.results.length) {
        resultsEl.innerHTML = '<div class="empty" style="padding:20px">"' + esc(q) + '" 검색 결과 없음</div>';
        return;
      }
      var html = '<div class="search-summary">' + d.total + '개 노트에서 발견</div>';
      html += d.results.map(function (r) {
        var matchHtml = r.matches.map(function (m) {
          var highlighted = esc(m.text).replace(
            new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'),
            '<mark>$1</mark>'
          );
          return '<div class="search-result-match">' + highlighted + '</div>';
        }).join('');
        var pathHtml = r.path ? '<div style="font-size:11px;color:var(--text2);margin-top:2px">' + esc(r.path) + '</div>' : '';
        return '<div class="search-result-item" data-date="' + r.date + '">' +
          '<div class="search-result-date">' + esc(r.date) + '</div>' +
          pathHtml + matchHtml + '</div>';
      }).join('');
      resultsEl.innerHTML = html;
      resultsEl.querySelectorAll('.search-result-item').forEach(function (item) {
        item.addEventListener('click', function () { openPreview(item.getAttribute('data-date')); });
      });
    })
    .catch(function (e) {
      resultsEl.innerHTML = '<div class="empty" style="padding:20px">검색 실패: ' + esc(e.message) + '</div>';
    });
}

function doAISearch() {
  var q = (document.getElementById('searchInput').value || '').trim();
  var resultsEl = document.getElementById('searchResults');
  var histList = document.getElementById('hist-list');
  var aiBtn = document.getElementById('btnAiSearch');

  if (!q) return;

  histList.style.display = 'none';
  resultsEl.innerHTML = '<div class="empty" style="padding:16px">AI가 관련 키워드 확장 중...</div>';
  aiBtn.disabled = true;
  aiBtn.textContent = '검색 중...';

  var scope = document.getElementById('search-all-vault').checked ? 'all' : 'daily';
  api('/search/ai?q=' + encodeURIComponent(q) + '&scope=' + scope)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { resultsEl.innerHTML = '<div class="empty" style="padding:20px">' + esc(d.error) + '</div>'; return; }
      if (!d.results || !d.results.length) {
        resultsEl.innerHTML = '<div class="empty" style="padding:20px">AI 검색 결과 없음</div>';
        return;
      }
      var keywordsHtml = '';
      if (d.keywords && d.keywords.length > 1) {
        keywordsHtml = '<div style="margin-bottom:8px;font-size:12px;color:var(--text2)">확장 키워드: ' +
          d.keywords.slice(0, 15).map(function (k) {
            return '<span style="background:rgba(0,122,255,0.1);padding:2px 6px;border-radius:8px;margin:2px">' + esc(k) + '</span>';
          }).join(' ') + '</div>';
      }
      var html = keywordsHtml + '<div class="search-summary">' + d.total + '개 노트에서 발견</div>';
      html += d.results.map(function (r) {
        var matchHtml = r.matches.map(function (m) {
          var text = esc(m.text);
          (m.keywords || []).forEach(function (k) {
            var re = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
            text = text.replace(re, '<mark>$1</mark>');
          });
          return '<div class="search-result-match">' + text + '</div>';
        }).join('');
        var pathHtml = r.path ? '<div style="font-size:11px;color:var(--text2);margin-top:2px">' + esc(r.path) + '</div>' : '';
        return '<div class="search-result-item" data-date="' + r.date + '">' +
          '<div class="search-result-date">' + esc(r.date) + '</div>' +
          pathHtml + matchHtml + '</div>';
      }).join('');
      resultsEl.innerHTML = html;
      resultsEl.querySelectorAll('.search-result-item').forEach(function (item) {
        item.addEventListener('click', function () { openPreview(item.getAttribute('data-date')); });
      });
    })
    .catch(function (e) {
      resultsEl.innerHTML = '<div class="empty" style="padding:20px">AI 검색 실패: ' + esc(e.message) + '</div>';
    })
    .then(function () {
      aiBtn.disabled = false;
      aiBtn.textContent = 'AI';
    });
}

// ============================================================
// Settings tab
// ============================================================
function loadSettings() {
  fetch('/api/health')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var c = document.getElementById('st-conn');
      c.textContent = d.vault ? '연결됨' : '볼트없음';
      c.className = 'badge ' + (d.vault ? 'ok' : 'err');
      document.getElementById('st-vault').textContent = d.vaultPath || '-';
    })
    .catch(function () {
      var c = document.getElementById('st-conn');
      c.textContent = '오프라인'; c.className = 'badge err';
    });

  renderReminderList();
  loadQRCode();
  checkCalendarStatus();
}

var _calWasConnected = false;
var _calConnected = false;

function checkCalendarStatus(silent) {
  api('/calendar/status')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var st = document.getElementById('cal-status');
      var btn = document.getElementById('cal-connect-btn');
      var msg = document.getElementById('cal-msg');
      if (!st) return;

      if (d.connected) {
        st.textContent = '연결됨';
        st.className = 'badge ok';
        st.style.background = 'var(--green)';
        st.style.color = '#fff';
        btn.textContent = '재연결';
        msg.style.display = 'none';
        _calWasConnected = true;
        _calConnected = true;
      } else if (!d.hasEnv) {
        st.textContent = '설정 필요';
        st.className = 'badge err';
        btn.disabled = true;
        msg.textContent = '.env 파일에 GOOGLE_CLIENT_ID 설정이 필요합니다.';
        msg.style.display = '';
      } else {
        st.textContent = '미연결';
        st.className = 'badge';
        st.style.background = 'var(--bg-card)';
        st.style.color = 'var(--text2)';
        btn.textContent = '계정 연결';
        btn.disabled = false;
        if (_calWasConnected && !silent) showToast('캘린더 연결이 만료되었습니다.', 'warn');
        if (d.reason === 'token_expired' || d.reason === 'token_invalid') {
          msg.textContent = '토큰이 만료/무효화되었습니다. 재연결해주세요.';
          msg.style.display = '';
        } else {
          msg.style.display = 'none';
        }
        _calWasConnected = false;
        _calConnected = false;
      }
    })
    .catch(function () {});
}

// Auto-check calendar every 10 minutes
setInterval(function () { checkCalendarStatus(); }, 10 * 60 * 1000);

// ============================================================
// Calendar Event Detection
// ============================================================
var _pendingEvent = null;

function detectCalendarEvent(text, date) {
  if (!text || text.length < 10) return;
  if (localStorage.getItem('vv_calAutoDetect') === 'off') return;

  api('/ai/detect-event', {
    method: 'POST',
    body: JSON.stringify({ content: text, referenceDate: fmt(date) })
  })
  .then(function (r) { return r.json(); })
  .then(function (d) {
    if (d.success && d.detected && d.event) showEventBanner(d.event);
  })
  .catch(function () {});
}

function showEventBanner(event) {
  _pendingEvent = event;
  var days = ['일', '월', '화', '수', '목', '금', '토'];
  var d = new Date(event.date + 'T00:00:00');
  var dayName = days[d.getDay()];
  var month = d.getMonth() + 1;
  var day = d.getDate();
  document.getElementById('event-detect-title').textContent = event.title;
  var detail = month + '/' + day + ' (' + dayName + ')';
  if (event.isAllDay) {
    detail += ' 종일';
  } else {
    detail += ' ' + event.startTime + '~' + event.endTime;
  }
  document.getElementById('event-detect-detail').textContent = detail;
  document.getElementById('event-detect-banner').style.display = '';
}

function registerDetectedEvent() {
  if (!_pendingEvent) return;
  if (!_calConnected) { showToast('캘린더가 연결되지 않았습니다.', 'warn'); return; }
  var ev = _pendingEvent;
  var body;
  if (ev.isAllDay) {
    var endDate = new Date(ev.date + 'T00:00:00');
    endDate.setDate(endDate.getDate() + 1);
    body = { summary: ev.title, start: ev.date, end: endDate.toISOString().slice(0, 10), isAllDay: true };
  } else {
    body = { summary: ev.title, start: ev.date + 'T' + ev.startTime + ':00+09:00', end: ev.date + 'T' + ev.endTime + ':00+09:00', isAllDay: false };
  }
  api('/calendar/add', { method: 'POST', body: JSON.stringify(body) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      showToast(d.success ? '일정 등록 완료!' : '일정 등록 실패: ' + (d.error || ''), d.success ? 'success' : 'warn');
      dismissEventBanner();
    })
    .catch(function (e) { showToast('일정 등록 실패: ' + e.message, 'warn'); dismissEventBanner(); });
}

function dismissEventBanner() {
  document.getElementById('event-detect-banner').style.display = 'none';
  _pendingEvent = null;
}

// ============================================================
// Markdown renderer
// ============================================================
function renderMd(md) {
  if (!md) return '';
  // Process markdown tables before escaping (they contain | which we need)
  var parts = md.split(/\n\n+/);
  var processed = parts.map(function (block) {
    var lines = block.trim().split('\n');
    // Detect markdown table: at least 2 lines starting with |
    if (lines.length >= 2 && lines[0].trim().charAt(0) === '|' && lines[1].trim().match(/^\|[\s:|-]+\|/)) {
      return renderMdTable(lines);
    }
    // Detect details/summary HTML blocks — pass through without escaping
    if (block.trim().match(/^<details/i)) {
      return block.trim();
    }
    return null; // process normally
  });

  var h = '';
  var blockIdx = 0;
  var splitBlocks = md.split(/\n\n+/);
  for (var i = 0; i < splitBlocks.length; i++) {
    if (processed[i] !== null) {
      h += processed[i];
    } else {
      var seg = esc(splitBlocks[i]);
      seg = seg.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      seg = seg.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      seg = seg.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      seg = seg.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      seg = seg.replace(/\*(.+?)\*/g, '<em>$1</em>');
      seg = seg.replace(/- \[x\] (.+)/g, '<li style="list-style:none"><input type="checkbox" checked disabled> <s>$1</s></li>');
      seg = seg.replace(/- \[ \] (.+)/g, '<li style="list-style:none"><input type="checkbox" disabled> $1</li>');
      seg = seg.replace(/^- (.+)$/gm, '<li>$1</li>');
      seg = seg.replace(/!\[\[([^\]]+\.(webm|mp3|wav|m4a|ogg|mp4))\]\]/gi, function (match, p) {
        var fname = p.split('/').pop();
        return '<audio controls style="width:100%;margin:4px 0"><source src="/api/attachments/' + encodeURIComponent(fname) + '"></audio>';
      });
      seg = seg.replace(/!\[\[([^\]]+)\]\]/g, function (match, p) {
        var fname = p.split('/').pop();
        return '<img src="/api/attachments/' + encodeURIComponent(fname) + '" style="max-width:100%;border-radius:8px;margin:4px 0" alt="' + esc(fname) + '">';
      });
      h += seg;
    }
    if (i < splitBlocks.length - 1) h += '<br><br>';
  }
  return h;
}

function renderMdTable(lines) {
  // Parse header
  var headers = lines[0].split('|').map(function (c) { return c.trim(); }).filter(Boolean);
  // Skip separator line (line[1])
  var rows = [];
  for (var i = 2; i < lines.length; i++) {
    if (!lines[i].trim() || lines[i].trim().charAt(0) !== '|') break;
    var cells = lines[i].split('|').map(function (c) { return c.trim(); }).filter(Boolean);
    rows.push(cells);
  }
  if (rows.length === 0) return esc(lines.join('\n'));

  // Render as mobile-friendly card list
  var html = '<div class="md-table-cards">';
  rows.forEach(function (row) {
    html += '<div class="md-table-card">';
    // First column as card title
    html += '<div class="md-table-card-title">' + esc(row[0] || '') + '</div>';
    html += '<div class="md-table-card-meta">';
    for (var j = 1; j < row.length && j < headers.length; j++) {
      if (row[j]) {
        html += '<span class="md-table-card-field"><span class="md-table-card-label">' + esc(headers[j]) + '</span> ' + esc(row[j]) + '</span>';
      }
    }
    html += '</div></div>';
  });
  html += '</div>';
  return html;
}

// ============================================================
// Reminders
// ============================================================
var reminderCheckInterval = null;

function getReminders() {
  try { return JSON.parse(localStorage.getItem('vv_reminders') || '[]'); } catch (e) { return []; }
}
function saveReminders(list) { localStorage.setItem('vv_reminders', JSON.stringify(list)); }

function hasReminderForTodo(date, lineIndex) {
  return getReminders().some(function (r) { return r.date === date && r.lineIndex === lineIndex && !r.fired; });
}

function openReminderDialog(text, date, lineIndex) {
  var dialog = document.getElementById('reminder-dialog');
  var dialogText = document.getElementById('reminder-dialog-text');
  var datetimeInput = document.getElementById('reminder-datetime');
  dialogText.textContent = text;
  var def = new Date();
  def.setHours(def.getHours() + 1);
  def.setMinutes(0, 0, 0);
  datetimeInput.value = def.toISOString().slice(0, 16);
  dialog.style.display = '';
  dialog._todoDate = date;
  dialog._todoLine = lineIndex;
  dialog._todoText = text;
}

function saveReminderFromDialog() {
  var dialog = document.getElementById('reminder-dialog');
  var dt = document.getElementById('reminder-datetime').value;
  if (!dt) return;
  var reminders = getReminders().filter(function (r) {
    return !(r.date === dialog._todoDate && r.lineIndex === dialog._todoLine);
  });
  reminders.push({
    id: Date.now().toString(),
    text: dialog._todoText,
    date: dialog._todoDate,
    lineIndex: dialog._todoLine,
    remindAt: new Date(dt).getTime(),
    fired: false
  });
  saveReminders(reminders);
  dialog.style.display = 'none';
  loadTodosForFeed();
}

function checkReminders() {
  var reminders = getReminders();
  var now = Date.now();
  var changed = false;
  reminders.forEach(function (r) {
    if (!r.fired && r.remindAt <= now) { r.fired = true; changed = true; showReminderBanner(r.text); }
  });
  var dayAgo = now - 86400000;
  var cleaned = reminders.filter(function (r) { return !(r.fired && r.remindAt < dayAgo); });
  if (cleaned.length !== reminders.length) changed = true;
  if (changed) saveReminders(cleaned.length !== reminders.length ? cleaned : reminders);
}

function showReminderBanner(text) {
  var banner = document.getElementById('reminder-banner');
  var bannerText = document.getElementById('reminder-banner-text');
  bannerText.textContent = text;
  banner.style.display = '';
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; gain.gain.value = 0.3;
    osc.start(); osc.stop(ctx.currentTime + 0.2);
  } catch (e) {}
  setTimeout(function () { banner.style.display = 'none'; }, 10000);
}

function closeReminderBanner() { document.getElementById('reminder-banner').style.display = 'none'; }

function renderReminderList() {
  var el = document.getElementById('reminder-list');
  var reminders = getReminders().filter(function (r) { return !r.fired; });
  if (!reminders.length) {
    el.innerHTML = '<div class="empty" style="padding:12px;font-size:13px">설정된 알림 없음</div>';
    return;
  }
  el.innerHTML = reminders.map(function (r) {
    var dt = new Date(r.remindAt);
    var timeStr = (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' +
      dt.getHours().toString().padStart(2, '0') + ':' + dt.getMinutes().toString().padStart(2, '0');
    return '<div class="reminder-item">' +
      '<span class="reminder-item-text">' + esc(r.text) + '</span>' +
      '<span class="reminder-item-time">' + timeStr + '</span>' +
      '<button class="reminder-item-del" data-id="' + r.id + '">&times;</button>' +
      '</div>';
  }).join('');
  el.querySelectorAll('.reminder-item-del').forEach(function (btn) {
    btn.addEventListener('click', function () {
      saveReminders(getReminders().filter(function (r) { return r.id !== btn.getAttribute('data-id'); }));
      renderReminderList();
    });
  });
}

function initReminders() {
  if (reminderCheckInterval) clearInterval(reminderCheckInterval);
  reminderCheckInterval = setInterval(checkReminders, 30000);
  checkReminders();
}

// ============================================================
// QR Code
// ============================================================
function loadQRCode() {
  var input = document.getElementById('qr-url-input');
  var saved = localStorage.getItem('vv_tunnelUrl') || '';
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    saved = location.origin;
    localStorage.setItem('vv_tunnelUrl', saved);
  }
  if (saved) input.value = saved;
  updateQR();
  input.addEventListener('input', function () {
    var val = input.value.trim();
    if (val) localStorage.setItem('vv_tunnelUrl', val);
    updateQR();
  });
}

function updateQR() {
  var input = document.getElementById('qr-url-input');
  var qrImg = document.getElementById('qr-img');
  var qrUrl = document.getElementById('qr-url');
  var base = input.value.trim() || location.origin;
  var url = base.replace(/\/$/, '') + '/?key=' + API_KEY;
  qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(url);
  qrUrl.textContent = url;
}

// ============================================================
// Clipboard Sync
// ============================================================
function clipSend() {
  var text = document.getElementById('clip-text').value.trim();
  var status = document.getElementById('clip-status');
  if (!text) { status.textContent = '텍스트를 입력하세요'; return; }
  api('/clipboard', { method: 'POST', body: JSON.stringify({ text: text }) })
    .then(function (r) {
      if (r.ok) { status.textContent = '전송 완료!'; status.style.color = 'var(--green)'; }
    })
    .catch(function (e) { status.textContent = '전송 실패: ' + e.message; status.style.color = 'var(--red)'; });
}

function clipRecv() {
  var textArea = document.getElementById('clip-text');
  var status = document.getElementById('clip-status');
  api('/clipboard').then(function (r) { return r.json(); }).then(function (d) {
    if (d.text) {
      textArea.value = d.text;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(d.text).then(function () {
          status.textContent = '받기 완료! 클립보드에도 복사됨';
        }).catch(function () {
          status.textContent = '받기 완료!';
        });
      } else {
        status.textContent = '받기 완료!';
      }
      status.style.color = 'var(--green)';
    } else {
      status.textContent = '공유된 텍스트 없음';
      status.style.color = 'var(--text2)';
    }
  }).catch(function () {
    status.textContent = '받기 실패';
    status.style.color = 'var(--red)';
  });
}

// ============================================================
// Feature Test
// ============================================================
function runFeatureTest() {
  var el = document.getElementById('test-results');
  var btn = document.getElementById('run-test');
  btn.disabled = true;
  btn.textContent = '점검 중...';
  el.innerHTML = '';
  var checks = [];
  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad/.test(ua);
  var hasSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  checks.push({ name: '브라우저', ok: true, detail: isIOS ? 'iOS Safari' : 'Desktop' });
  checks.push({ name: '음성인식', ok: hasSpeech, detail: hasSpeech ? '지원됨' : (isIOS ? 'iOS는 키보드 마이크 사용' : '미지원') });
  checks.push({ name: '카메라', ok: true, detail: 'input[file] 사용' });
  checks.push({ name: '알림 저장소', ok: !!localStorage, detail: localStorage ? 'localStorage OK' : '미지원' });
  api('/test').then(function (r) { return r.json(); }).then(function (d) {
    checks.push({ name: '서버', ok: d.server.ok, detail: '포트 ' + d.server.port });
    checks.push({ name: '볼트 경로', ok: d.vault.ok, detail: d.vault.ok ? 'OK' : '없음' });
    checks.push({ name: '일일노트 폴더', ok: d.dailyDir.ok, detail: d.dailyDir.ok ? 'OK' : '없음' });
    checks.push({ name: '첨부파일 폴더', ok: d.attachmentDir.ok, detail: d.attachmentDir.ok ? 'OK' : '없음' });
    checks.push({ name: 'Gemini AI', ok: d.gemini.ok, detail: d.gemini.ok ? 'API 연결 OK' : (d.gemini.error || '실패') });
    checks.push({ name: '기존 노트', ok: d.notes.ok, detail: d.notes.count + '개 발견' });
    renderTestResults(checks);
    btn.disabled = false;
    btn.textContent = '전체 기능 점검';
  }).catch(function (e) {
    checks.push({ name: '서버 연결', ok: false, detail: e.message });
    renderTestResults(checks);
    btn.disabled = false;
    btn.textContent = '전체 기능 점검';
  });
}

function renderTestResults(checks) {
  var el = document.getElementById('test-results');
  el.innerHTML = checks.map(function (c) {
    var icon = c.ok ? '\u2714' : '\u2716';
    var color = c.ok ? 'var(--green)' : 'var(--red)';
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--sep)">' +
      '<span>' + icon + '</span>' +
      '<span style="flex:1;font-size:14px">' + esc(c.name) + '</span>' +
      '<span style="font-size:12px;color:' + color + '">' + esc(c.detail) + '</span>' +
      '</div>';
  }).join('');
}

// ============================================================
// Jarvis (Voice Assistant)
// ============================================================
var jarvisChatHistory = [];
var jarvisIsSending = false;
var jarvisTTSActive = false;
var jarvisRecog = null;
var JARVIS_STORAGE_KEY = 'vv_jarvis_history';
var JARVIS_STORAGE_MAX = 200 * 1024;

function saveJarvisHistory() {
  try {
    var json = JSON.stringify(jarvisChatHistory);
    if (json.length > JARVIS_STORAGE_MAX) json = JSON.stringify(jarvisChatHistory.slice(-40));
    localStorage.setItem(JARVIS_STORAGE_KEY, json);
  } catch (e) {}
}
function loadJarvisHistory() {
  try { var raw = localStorage.getItem(JARVIS_STORAGE_KEY); if (raw) { var p = JSON.parse(raw); if (Array.isArray(p)) return p; } } catch (e) {}
  return [];
}
function clearJarvisHistory() { localStorage.removeItem(JARVIS_STORAGE_KEY); }
function exportJarvisHistory() {
  if (!jarvisChatHistory.length) return;
  var lines = jarvisChatHistory.map(function (item) { return '[' + (item.role === 'user' ? '나' : 'Jarvis') + '] ' + item.text; });
  var text = 'Jarvis 대화 내보내기 (' + new Date().toLocaleString('ko-KR') + ')\n' + '='.repeat(40) + '\n\n' + lines.join('\n\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = 'jarvis-chat-' + new Date().toISOString().slice(0, 10) + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

var jarvisBtn = document.createElement('button');
jarvisBtn.id = 'jarvis-btn';
jarvisBtn.className = 'jarvis-fab';
jarvisBtn.innerHTML = 'J';
jarvisBtn.onclick = openJarvis;
document.body.appendChild(jarvisBtn);

var jarvisOverlay, jarvisInput, jarvisMic, jarvisSend, jarvisChat, jarvisReset, jarvisStatus;

function initJarvis() {
  jarvisOverlay = document.getElementById('jarvis-overlay');
  jarvisInput = document.getElementById('jarvis-input');
  jarvisMic = document.getElementById('jarvis-mic');
  jarvisSend = document.getElementById('jarvis-send');
  jarvisChat = document.getElementById('jarvis-chat');
  jarvisReset = document.getElementById('jarvis-reset');
  jarvisStatus = document.getElementById('jarvis-status');
  if (!jarvisOverlay) return;
  document.getElementById('jarvis-close').onclick = closeJarvis;
  jarvisSend.onclick = function () { sendJarvis(jarvisInput.value.trim()); };
  jarvisInput.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendJarvis(jarvisInput.value.trim()); } };
  jarvisReset.onclick = function () { jarvisChatHistory = []; clearJarvisHistory(); jarvisChat.innerHTML = ''; addJarvisWelcome(); setJarvisStatus(''); };
  var jarvisExport = document.getElementById('jarvis-export');
  if (jarvisExport) jarvisExport.onclick = exportJarvisHistory;
  var saved = loadJarvisHistory();
  if (saved.length > 0) {
    jarvisChatHistory = saved;
    jarvisChat.innerHTML = '';
    for (var i = 0; i < saved.length; i++) addJarvisBubble(saved[i].text, saved[i].role === 'user' ? 'user' : 'bot');
  }
  jarvisMic.onclick = toggleJarvisMic;
  jarvisChat.addEventListener('click', function (e) {
    var hint = e.target.closest('.jarvis-hint');
    if (hint) { var msg = hint.getAttribute('data-msg'); if (msg) sendJarvis(msg); }
    var bubble = e.target.closest('.jarvis-bubble-bot');
    if (bubble && jarvisTTSActive) stopTTS();
  });
}

function openJarvis() { if (jarvisOverlay) { jarvisOverlay.style.display = 'flex'; jarvisInput.focus(); } }
function closeJarvis() { if (jarvisOverlay) { jarvisOverlay.style.display = 'none'; stopTTS(); } }

function addToJarvisHistory(role, text) {
  jarvisChatHistory.push({ role: role, text: text });
  if (jarvisChatHistory.length > 60) jarvisChatHistory = jarvisChatHistory.slice(-60);
  saveJarvisHistory();
}

function sendJarvis(text) {
  if (!text || jarvisIsSending) return;
  jarvisIsSending = true;
  stopTTS();
  var welcome = jarvisChat.querySelector('.jarvis-welcome');
  if (welcome) welcome.remove();
  addJarvisBubble(text, 'user');
  addToJarvisHistory('user', text);
  jarvisInput.value = '';
  var typingEl = addJarvisTyping();
  setJarvisStatus('응답 대기 중...');
  api('/ai/chat', { method: 'POST', body: JSON.stringify({ message: text, history: jarvisChatHistory.slice(0, -1) }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      typingEl.remove();
      var reply = d.reply || d.error || '이해하지 못했습니다.';
      addJarvisBubble(reply, 'bot');
      addToJarvisHistory('model', reply);
      setJarvisStatus('');
      speak(reply);
    })
    .catch(function (e) { typingEl.remove(); addJarvisBubble('오류: ' + e.message, 'error'); setJarvisStatus(''); })
    .then(function () { jarvisIsSending = false; });
}

function addJarvisBubble(text, type) {
  var div = document.createElement('div');
  div.className = 'jarvis-bubble jarvis-bubble-' + type;
  if (type === 'bot') { div.innerHTML = renderJarvisMd(text); div.title = 'TTS 중단하려면 클릭'; }
  else if (type === 'error') { div.className = 'jarvis-bubble jarvis-bubble-error'; div.textContent = text; }
  else { div.textContent = text; }
  jarvisChat.appendChild(div);
  jarvisChat.scrollTop = jarvisChat.scrollHeight;
  return div;
}
function addJarvisTyping() {
  var div = document.createElement('div');
  div.className = 'jarvis-typing';
  div.innerHTML = '<span></span><span></span><span></span> Jarvis가 생각 중...';
  jarvisChat.appendChild(div);
  jarvisChat.scrollTop = jarvisChat.scrollHeight;
  return div;
}
function addJarvisWelcome() {
  var div = document.createElement('div');
  div.className = 'jarvis-welcome';
  div.innerHTML = '<div class="jarvis-welcome-icon">J</div><div class="jarvis-welcome-text">안녕하세요! Jarvis입니다.<br>무엇을 도와드릴까요?</div>' +
    '<div class="jarvis-welcome-hints"><button class="jarvis-hint" data-msg="오늘 메모 보여줘">오늘 메모 보기</button><button class="jarvis-hint" data-msg="할일 추가: 보고서 작성">할일 추가</button><button class="jarvis-hint" data-msg="이번 주 일정 알려줘">이번 주 일정</button></div>';
  jarvisChat.appendChild(div);
}
function renderJarvisMd(text) {
  if (!text) return '';
  var h = esc(text);
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/^[-•] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  h = h.replace(/\n/g, '<br>');
  return h;
}
function setJarvisStatus(msg) { if (jarvisStatus) jarvisStatus.textContent = msg; }
function speak(text) {
  if (!text || !window.speechSynthesis) return;
  stopTTS();
  var sentences = text.match(/[^.!?。！？\n]+[.!?。！？]?/g) || [text];
  jarvisTTSActive = true;
  setJarvisStatus('TTS 재생 중 (클릭으로 중단)');
  if (jarvisMic) jarvisMic.disabled = true;
  var idx = 0;
  function speakNext() {
    if (idx >= sentences.length || !jarvisTTSActive) { jarvisTTSActive = false; setJarvisStatus(''); if (jarvisMic) jarvisMic.disabled = false; return; }
    var sentence = sentences[idx].trim(); idx++;
    if (!sentence) { speakNext(); return; }
    var u = new SpeechSynthesisUtterance(sentence);
    u.lang = 'ko-KR'; u.onend = speakNext;
    u.onerror = function () { jarvisTTSActive = false; setJarvisStatus(''); if (jarvisMic) jarvisMic.disabled = false; };
    window.speechSynthesis.speak(u);
  }
  speakNext();
}
function stopTTS() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  jarvisTTSActive = false; setJarvisStatus('');
  if (jarvisMic) jarvisMic.disabled = false;
}
function toggleJarvisMic() {
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { addJarvisBubble('이 브라우저에서는 음성 인식이 지원되지 않습니다.', 'error'); return; }
  if (jarvisRecog) { jarvisRecog.stop(); jarvisRecog = null; jarvisMic.classList.remove('recording'); setJarvisStatus(''); return; }
  stopTTS();
  jarvisRecog = new SpeechRecognition();
  jarvisRecog.lang = 'ko-KR'; jarvisRecog.continuous = true; jarvisRecog.interimResults = true;
  jarvisRecog.start();
  jarvisMic.classList.add('recording'); setJarvisStatus('듣는 중...');
  var finalTranscript = '';
  jarvisRecog.onresult = function (e) {
    var interim = '';
    for (var i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    jarvisInput.value = finalTranscript + interim;
    if (interim) setJarvisStatus(interim);
  };
  jarvisRecog.onend = function () {
    jarvisRecog = null; jarvisMic.classList.remove('recording'); setJarvisStatus('');
    var text = (finalTranscript || jarvisInput.value).trim();
    if (text) sendJarvis(text);
  };
  jarvisRecog.onerror = function (e) {
    if (e.error !== 'no-speech' && e.error !== 'aborted') { setJarvisStatus('음성 인식 오류: ' + e.error); setTimeout(function () { setJarvisStatus(''); }, 3000); }
    jarvisRecog = null; jarvisMic.classList.remove('recording');
  };
}

// ============================================================
// RAG
// ============================================================
document.addEventListener('DOMContentLoaded', function () {
  var reindexBtn = document.getElementById('reindex-btn');
  if (reindexBtn) {
    reindexBtn.addEventListener('click', function () {
      var status = document.getElementById('reindex-status');
      if (!confirm('최근 50개 노트를 AI 지식 베이스에 추가하시겠습니까? (1~2분 소요)')) return;
      reindexBtn.disabled = true;
      reindexBtn.textContent = '구축 중...';
      status.textContent = '노트 분석 및 임베딩 생성 중...';
      api('/rag/reindex', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.success) { status.textContent = '완료! ' + d.message; status.style.color = 'var(--green)'; }
          else throw new Error(d.error || '실패');
        })
        .catch(function (e) { status.textContent = '오류: ' + e.message; status.style.color = 'var(--red)'; })
        .finally(function () { reindexBtn.disabled = false; reindexBtn.textContent = '지식 베이스 구축 (최근 50개)'; });
    });
  }

  // ---- Auth ----
  document.getElementById('auth-btn').addEventListener('click', doAuth);
  document.getElementById('key-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') doAuth(); });

  // ---- Tabs ----
  document.querySelectorAll('.tab-btn').forEach(function (tab) {
    tab.addEventListener('click', function () { switchTab(tab.getAttribute('data-tab'), tab); });
  });

  // ---- Input Hub ----
  // Photo (camera/gallery auto-switch on mobile)
  var photoInput = document.getElementById('photoInput');
  document.getElementById('btnPhoto').addEventListener('click', function () { photoInput.click(); });
  photoInput.addEventListener('change', function (e) {
    handleImageCapture(e.target.files[0], 'photo');
    e.target.value = '';
  });

  // Record
  document.getElementById('btnRecord').addEventListener('click', toggleRecording);

  // File upload
  var fileInput = document.getElementById('fileInput');
  document.getElementById('btnFile').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    pendingAudioBlob = file;
    if (pendingAudioUrl) URL.revokeObjectURL(pendingAudioUrl);
    pendingAudioUrl = URL.createObjectURL(file);
    pendingAudios = [{ blob: file, objectUrl: pendingAudioUrl, serverId: null, dirName: null, type: 'voice' }];
    updatePreviewArea();
    e.target.value = '';
  });

  // URL button
  document.getElementById('btnUrl').addEventListener('click', function () {
    var text = document.getElementById('mainInput').value.trim();
    if (!text.match(/^https?:\/\//)) {
      var url = prompt('URL을 입력하세요:');
      if (url) document.getElementById('mainInput').value = url;
    } else {
      showToast('URL이 감지되었습니다. 저장 시 처리됩니다.', 'info');
    }
  });

  // Tag input
  var tagInput = document.getElementById('tagInput');
  tagInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput.value); tagInput.value = ''; }
  });

  // Save
  document.getElementById('btnSave').addEventListener('click', handleSave);

  // Quick todo
  document.getElementById('btnAddTodo').addEventListener('click', addQuickTodo);
  document.getElementById('todoInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addQuickTodo(); }
  });

  // ---- Feed tab ----
  document.getElementById('feedPrev').addEventListener('click', function () { shiftFeedDate(-1); });
  document.getElementById('feedNext').addEventListener('click', function () { shiftFeedDate(1); });
  document.getElementById('feedDate').addEventListener('click', function () {
    feedDate = new Date(); updateFeedDate(); loadFeed();
  });

  // AI buttons
  document.querySelectorAll('.ai-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { doAI(btn.getAttribute('data-action')); });
  });

  // ---- Search tab ----
  document.getElementById('btnSearch').addEventListener('click', doSearch);
  document.getElementById('btnAiSearch').addEventListener('click', doAISearch);
  var searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  var searchTimer = null;
  searchInput.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { if (searchInput.value.trim()) doSearch(); }, 1500);
  });
  document.getElementById('hist-close').addEventListener('click', closePreview);

  // ---- Settings tab ----
  document.getElementById('logout-btn').addEventListener('click', doLogout);
  document.getElementById('cal-connect-btn').addEventListener('click', function () {
    window.open('/api/auth/google', '_blank', 'width=500,height=600');
  });
  var calDetectToggle = document.getElementById('cal-auto-detect');
  calDetectToggle.checked = localStorage.getItem('vv_calAutoDetect') !== 'off';
  calDetectToggle.addEventListener('change', function () {
    localStorage.setItem('vv_calAutoDetect', calDetectToggle.checked ? 'on' : 'off');
  });
  document.getElementById('clip-send').addEventListener('click', clipSend);
  document.getElementById('clip-recv').addEventListener('click', clipRecv);
  document.getElementById('run-test').addEventListener('click', runFeatureTest);

  // ---- Calendar event detection ----
  document.getElementById('event-detect-add').addEventListener('click', registerDetectedEvent);
  document.getElementById('event-detect-dismiss').addEventListener('click', dismissEventBanner);

  // ---- Reminders ----
  document.getElementById('reminder-save').addEventListener('click', saveReminderFromDialog);
  document.getElementById('reminder-cancel').addEventListener('click', function () {
    document.getElementById('reminder-dialog').style.display = 'none';
  });
  document.getElementById('reminder-banner-close').addEventListener('click', closeReminderBanner);

  // ---- Boot ----
  if (API_KEY) {
    showApp();
  } else {
    document.getElementById('auth').style.display = '';
  }
});

// ============================================================
// Service Worker
// ============================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(function (reg) {
    reg.update().catch(function () {});
    setInterval(function () { reg.update().catch(function () {}); }, 10 * 60 * 1000);
    var refreshing = false;
    reg.addEventListener('updatefound', function () {
      var newWorker = reg.installing;
      if (newWorker) {
        newWorker.addEventListener('statechange', function () {
          if (newWorker.state === 'activated' && navigator.serviceWorker.controller && !refreshing) {
            refreshing = true;
            console.log('[SW] Updated — reloading');
            location.reload();
          }
        });
      }
    });
  }).catch(function () {});
}
