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

function linkifyUrls(html) {
  return html.replace(/(https?:\/\/[^\s<"'&]+(?:&amp;[^\s<"'&]+)*)/g, function (url) {
    var href = url.replace(/&amp;/g, '&');
    return '<a href="' + href + '" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all">' + url + '</a>';
  });
}

function showToast(message, type) {
  type = type || 'info';
  var el = document.createElement('div');
  el.className = 'vv-toast ' + type;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
}

// E6: 한국어 에러 메시지 + 재시도 버튼
var _errorMessages = {
  401: '인증이 필요합니다. API 키를 확인하세요.',
  403: '접근이 거부되었습니다.',
  404: '요청한 리소스를 찾을 수 없습니다.',
  413: '파일이 너무 큽니다.',
  429: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
  500: '서버 오류가 발생했습니다. 잠시 후 재시도하세요.',
  503: '서비스를 일시적으로 사용할 수 없습니다.',
  offline: '네트워크 연결을 확인하세요.',
  timeout: '요청 시간이 초과되었습니다.'
};

function getKoreanError(err, status) {
  if (!navigator.onLine) return _errorMessages.offline;
  if (status && _errorMessages[status]) return _errorMessages[status];
  if (err && (err.message || '').includes('timeout')) return _errorMessages.timeout;
  return err && err.message ? '오류: ' + err.message : '알 수 없는 오류가 발생했습니다.';
}

function showErrorWithRetry(msg, retryFn) {
  var el = document.createElement('div');
  el.className = 'vv-toast error';
  el.style.maxWidth = '300px';
  var txt = document.createElement('span');
  txt.textContent = msg;
  el.appendChild(txt);
  if (retryFn) {
    var btn = document.createElement('button');
    btn.textContent = ' 재시도';
    btn.style.cssText = 'margin-left:8px;background:rgba(255,255,255,.2);border:none;color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer';
    btn.onclick = function () { if (el.parentNode) el.parentNode.removeChild(el); retryFn(); };
    el.appendChild(btn);
  }
  document.body.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
}

function fmt(d) { var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate(); return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day); }

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

function apiUploadWithProgress(path, formData, onProgress) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    var prog = document.getElementById('upload-progress');
    var bar  = document.getElementById('upload-progress-bar');
    var lbl  = document.getElementById('upload-progress-label');
    if (prog) prog.style.display = '';
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.round(e.loaded / e.total * 100);
      if (bar) bar.style.width = pct + '%';
      if (lbl) lbl.textContent = pct + '%';
      if (onProgress) onProgress(pct);
    };
    xhr.onload = function () {
      if (prog) prog.style.display = 'none';
      if (bar) bar.style.width = '0%';
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status,
        json: function () { return Promise.resolve(JSON.parse(xhr.responseText)); } });
    };
    xhr.onerror = function () { if (prog) prog.style.display = 'none'; reject(new Error('Upload failed')); };
    xhr.open('POST', '/api' + path);
    xhr.setRequestHeader('Authorization', 'Bearer ' + API_KEY);
    xhr.send(formData);
  });
}

// ---- Offline Queue helpers ----
function showOfflineBanner(msg) {
  var el = document.getElementById('offline-banner');
  if (!el) return;
  el.textContent = msg || '오프라인 — 연결 복귀 시 자동 전송됩니다';
  el.style.display = 'block';
  setTimeout(function () { el.style.display = 'none'; }, 4000);
}

function updateOfflineBadge() {
  if (!window.OfflineDB) return;
  OfflineDB.queueCount().then(function (n) {
    var badge = document.getElementById('offline-badge');
    if (badge) { badge.textContent = n > 0 ? n : ''; badge.style.display = n > 0 ? 'inline' : 'none'; }
  }).catch(function () {});
}

function processOfflineQueue() {
  if (!window.OfflineDB || !navigator.onLine) return;
  OfflineDB.getQueue().then(function (items) {
    items.reduce(function (p, item) {
      return p.then(function () {
        var d = item.data;
        var fd = new FormData();
        Object.keys(d.fields || {}).forEach(function (k) { fd.append(k, d.fields[k]); });
        if (d.fileBlob && d.fileName) fd.append('file', d.fileBlob, d.fileName);
        return fetch('/api' + d.url, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + API_KEY },
          body: fd
        }).then(function (r) {
          if (r.ok) return OfflineDB.removeFromQueue(item.id);
        }).catch(function () {});
      });
    }, Promise.resolve()).then(updateOfflineBadge);
  }).catch(function () {});
}

window.addEventListener('online', processOfflineQueue);
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') processOfflineQueue(); });

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
  // Verify server connection before loading data
  fetch('/api/health').then(function (r) {
    if (!r.ok) throw new Error('health check failed');
    updateFeedDate();
    loadTags();
    initReminders();
    initJarvis();
    checkCalendarStatus();
    loadQuickTodos();
  }).catch(function () {
    // Server unreachable — show app shell with retry
    updateFeedDate();
    initJarvis();
    showToast('서버 연결 실패 — 재시도 중...', 'warning');
    var retryCount = 0;
    var retryInterval = setInterval(function () {
      retryCount++;
      fetch('/api/health').then(function (r) {
        if (r.ok) {
          clearInterval(retryInterval);
          loadTags();
          initReminders();
          checkCalendarStatus();
          loadQuickTodos();
          loadFeed();
          showToast('서버 연결됨', 'success');
        }
      }).catch(function () {
        if (retryCount >= 30) { clearInterval(retryInterval); showToast('서버에 연결할 수 없습니다', 'error'); }
      });
    }, 3000);
  });
}

// ============================================================
// Tabs (5-tab: input / feed / search / settings / vault)
// ============================================================
var tabTitles = {
  input: '입력',
  feed: '피드',
  search: '검색',
  ai: 'AI',
  settings: '설정',
  vault: '브라우저'
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
  if (name === 'ai') { if (jarvisInput) jarvisInput.focus(); showOnboarding(); }
  if (name === 'settings') loadSettings();
  if (name === 'vault') loadVaultBrowser();
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

var _waveAnimId = null;

function startWaveform(stream) {
  var canvas = document.getElementById('rec-waveform');
  var recUi = document.getElementById('rec-ui');
  if (!canvas || !recUi) return;
  recUi.style.display = '';
  var ctx = canvas.getContext('2d');
  var ac = new (window.AudioContext || window.webkitAudioContext)();
  var src = ac.createMediaStreamSource(stream);
  var analyser = ac.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  var buf = new Uint8Array(analyser.frequencyBinCount);
  function draw() {
    _waveAnimId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(buf);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.strokeStyle = '#7c5cbf';
    ctx.lineWidth = 2;
    var sliceW = canvas.width / buf.length;
    var x = 0;
    for (var i = 0; i < buf.length; i++) {
      var v = buf[i] / 128.0;
      var y = (v * canvas.height) / 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      x += sliceW;
    }
    ctx.stroke();
  }
  draw();
  return function () { if (_waveAnimId) cancelAnimationFrame(_waveAnimId); ac.close(); };
}

function stopWaveform() {
  if (_waveAnimId) { cancelAnimationFrame(_waveAnimId); _waveAnimId = null; }
  var recUi = document.getElementById('rec-ui');
  if (recUi) recUi.style.display = 'none';
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
      var stopWave = startWaveform(stream);

      audioRecorder.ondataavailable = function (e) {
        if (e.data.size > 0) chunks.push(e.data);
      };

      audioRecorder.onstop = function () {
        if (stopWave) stopWave();
        stopWaveform();
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
      var timerEl = document.getElementById('rec-timer');
      audioRecordingTimer = setInterval(function () {
        var elapsed = Math.floor((Date.now() - audioRecordingStart) / 1000);
        var m = Math.floor(elapsed / 60);
        var s = elapsed % 60;
        var btn = document.getElementById('btnRecord');
        if (btn) btn.title = '녹음 중: ' + m + ':' + (s < 10 ? '0' : '') + s;
        if (timerEl) timerEl.textContent = m + ':' + (s < 10 ? '0' : '') + s;
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
// ── Processing Queue ──
var procQueue = [];
var procRunning = false;

function procQueueAdd(item) {
  item.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  item.status = 'uploading';
  procQueue.push(item);
  procQueueRender();
  procQueueRun();
}

function procQueueRender() {
  var el = document.getElementById('proc-queue');
  var active = procQueue.filter(function (q) { return q.status !== 'removed'; });
  if (!active.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = active.map(function (q) {
    var icon = q.type === 'audio' ? '\uD83C\uDFA4' : q.type === 'image' ? '\uD83D\uDCF7' : q.type === 'url' ? '\uD83D\uDD17' : '\uD83D\uDCDD';
    var label = { uploading: '업로드중', processing: '처리중', done: '완료', error: '실패' }[q.status] || '';
    return '<div class="proc-item" data-id="' + q.id + '">' +
      '<span class="proc-icon">' + icon + '</span>' +
      '<span class="proc-name">' + esc(q.name) + '</span>' +
      '<span class="proc-status ' + q.status + '">' + label + '</span>' +
      '</div>';
  }).join('');
}

function procQueueRun() {
  if (procRunning) return;
  var next = procQueue.find(function (q) { return q.status === 'uploading'; });
  if (!next) return;
  procRunning = true;
  next.status = 'processing';
  procQueueRender();

  next.sendFn().then(function (d) {
    if (d && (d.success || d.filename || d.ok !== false)) {
      next.status = 'done';
      if (navigator.vibrate) navigator.vibrate(50);
      feedDate = new Date();
      // E10: subscribe to pipeline SSE for progress toasts
      if (d.pipelineId) subscribeToProgress(d.pipelineId);
      // 음성/회의 전사 완료 후 일정 감지
      if (next.type === 'audio' && d.transcription) {
        detectCalendarEvent(d.transcription, new Date());
      }
    } else {
      next.status = 'error';
      next.name += ' - ' + (d && d.error ? d.error : '오류');
      showErrorWithRetry(getKoreanError(null, d && d.status), null);
    }
  }).catch(function (e) {
    next.status = 'error';
    next.name += ' - ' + e.message;
    showErrorWithRetry(getKoreanError(e, null), null);
  }).then(function () {
    procRunning = false;
    procQueueRender();
    // Auto-remove done items after 4s
    if (next.status === 'done') {
      setTimeout(function () {
        next.status = 'removed';
        procQueueRender();
      }, 4000);
    }
    // Process next in queue
    procQueueRun();
  });
}

// E10: SSE pipeline progress subscription
var _pipelineStageLabels = { meta: '제목/분류 생성 중', perspective: 'AI 관점 분석 중', all: '파이프라인 완료' };
function subscribeToProgress(pipelineId) {
  if (!window.EventSource) return;
  var es = new EventSource('/api/pipeline/progress?id=' + encodeURIComponent(pipelineId) + '&key=' + encodeURIComponent(API_KEY));
  es.onmessage = function (e) {
    try {
      var d = JSON.parse(e.data);
      var label = _pipelineStageLabels[d.stage] || d.stage;
      if (d.status === 'done') showToast(label, 'success');
      if (d.stage === 'all') es.close();
    } catch (ex) {}
  };
  es.onerror = function () { es.close(); };
  setTimeout(function () { es.close(); }, 120000); // max 2min
}

function handleSave() {
  var text = (document.getElementById('mainInput').value || '').trim();
  var tags = myTags.slice();
  var fb = document.getElementById('inputFeedback');

  if (!text && !pendingImageFile && !pendingAudioBlob) {
    document.getElementById('mainInput').focus();
    return;
  }

  var queueItem;

  if (pendingAudioBlob) {
    var ext = '.webm';
    if (pendingAudioBlob.type && pendingAudioBlob.type.includes('mp4')) ext = '.mp4';
    var fd = new FormData();
    fd.append('file', pendingAudioBlob, 'recording' + ext);
    fd.append('tags', JSON.stringify(tags));
    fd.append('type', audioType);
    if (text) fd.append('memo', text);
    var blob = pendingAudioBlob; // capture ref
    queueItem = {
      type: 'audio', name: audioType === 'meeting' ? '회의 녹음' : '음성 메모',
      sendFn: function () { return apiUploadWithProgress('/process/audio', fd).then(function (r) { return r.json(); }); }
    };
  } else if (pendingImageFile) {
    var fd2 = new FormData();
    fd2.append('file', pendingImageFile.file, pendingImageFile.file.name || 'photo.jpg');
    fd2.append('tags', JSON.stringify(tags));
    if (text) fd2.append('memo', text);
    queueItem = {
      type: 'image', name: pendingImageFile.file.name || '사진',
      sendFn: function () { return apiUploadWithProgress('/process/image', fd2).then(function (r) { return r.json(); }); }
    };
  } else {
    var detectedUrl = detectUrl();
    if (detectedUrl) {
      var urlText = text, urlTags = tags, urlDetected = detectedUrl;
      queueItem = {
        type: 'url', name: detectedUrl.substring(0, 40),
        sendFn: function () {
          return api('/process/url', {
            method: 'POST',
            body: JSON.stringify({ url: urlDetected, tags: urlTags, memo: urlText !== urlDetected ? urlText : '' })
          }).then(function (r) { return r.json(); });
        }
      };
    } else {
      // Text notes are fast — process inline (no queue needed)
      var btn = document.getElementById('btnSave');
      btn.disabled = true;
      btn.textContent = '저장 중...';
      api('/process/text', {
        method: 'POST',
        body: JSON.stringify({ content: text, tags: tags })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && (d.success || d.filename || d.ok !== false)) {
          fb.textContent = '저장 완료!';
          fb.className = 'feedback ok';
          fb.style.display = '';
          if (navigator.vibrate) navigator.vibrate(50);
          var savedText = text;
          clearInput();
          detectCalendarEvent(savedText, new Date());
          feedDate = new Date();
          setTimeout(function () { fb.style.display = 'none'; }, 3000);
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
      return;
    }
  }

  // Queue the item and immediately clear input
  procQueueAdd(queueItem);
  var savedText = text;
  clearInput();
  detectCalendarEvent(savedText, new Date());
  fb.textContent = '전송 대기열에 추가됨';
  fb.className = 'feedback ok';
  fb.style.display = '';
  setTimeout(function () { fb.style.display = 'none'; }, 2000);
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

// E3+E11: Mini calendar popup with note-dot indicators
var _calDates = [];
var _calViewYear = 0;
var _calViewMonth = 0;

function openMiniCalendar() {
  var modal = document.getElementById('mini-cal-modal');
  if (!modal) return;
  _calViewYear  = feedDate.getFullYear();
  _calViewMonth = feedDate.getMonth();
  fetchCalDates(_calViewYear, _calViewMonth, function () { renderMiniCal(modal); });
  modal.style.display = 'flex';
}

function fetchCalDates(y, m, cb) {
  var ym = y + '-' + String(m + 1).padStart(2, '0');
  api('/feed/month/' + ym).then(function (r) { return r.json(); }).then(function (d) {
    _calDates = d.dates || [];
    cb();
  }).catch(function () { _calDates = []; cb(); });
}

function renderMiniCal(modal) {
  var days = ['일', '월', '화', '수', '목', '금', '토'];
  var first = new Date(_calViewYear, _calViewMonth, 1);
  var lastDay = new Date(_calViewYear, _calViewMonth + 1, 0).getDate();
  var startDow = first.getDay();
  var header = '<div class="mcal-header">' +
    '<button id="mcal-prev">&#9665;</button>' +
    '<span>' + _calViewYear + '년 ' + (_calViewMonth + 1) + '월</span>' +
    '<button id="mcal-next">&#9655;</button>' +
    '</div>';
  var grid = '<div class="mcal-grid">';
  days.forEach(function (d) { grid += '<div class="mcal-dow">' + d + '</div>'; });
  for (var i = 0; i < startDow; i++) grid += '<div></div>';
  for (var d = 1; d <= lastDay; d++) {
    var dateStr = _calViewYear + '-' + String(_calViewMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    var hasDot = _calDates.indexOf(dateStr) >= 0;
    var isToday = dateStr === fmt(new Date());
    var isCur  = dateStr === fmt(feedDate);
    var cls = 'mcal-day' + (isCur ? ' mcal-active' : '') + (isToday ? ' mcal-today' : '');
    grid += '<div class="' + cls + '" data-date="' + dateStr + '">' + d + (hasDot ? '<span class="mcal-dot"></span>' : '') + '</div>';
  }
  grid += '</div>';
  modal.querySelector('.mcal-body').innerHTML = header + grid;
  modal.querySelectorAll('.mcal-day').forEach(function (el) {
    el.addEventListener('click', function () {
      feedDate = new Date(this.getAttribute('data-date') + 'T12:00:00');
      modal.style.display = 'none';
      updateFeedDate(); loadFeed();
    });
  });
  document.getElementById('mcal-prev').addEventListener('click', function (e) {
    e.stopPropagation();
    _calViewMonth--; if (_calViewMonth < 0) { _calViewMonth = 11; _calViewYear--; }
    fetchCalDates(_calViewYear, _calViewMonth, function () { renderMiniCal(modal); });
  });
  document.getElementById('mcal-next').addEventListener('click', function (e) {
    e.stopPropagation();
    _calViewMonth++; if (_calViewMonth > 11) { _calViewMonth = 0; _calViewYear++; }
    fetchCalDates(_calViewYear, _calViewMonth, function () { renderMiniCal(modal); });
  });
}

function loadFeed() {
  updateFeedDate();
  var el = document.getElementById('feedCards');
  var todoSection = document.getElementById('todo-list-section');

  el.innerHTML = '<div class="empty">로딩 중...</div>';

  // Fire both requests in parallel
  var todosPromise = api('/daily/' + fmt(feedDate) + '/todos');

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
      // Attach click events (event delegation for action buttons)
      el.querySelectorAll('.feed-card').forEach(function (card) {
        card.style.cursor = 'pointer';
        card.addEventListener('click', function (e) {
          if (e.target.closest('a')) return;
          // Check if tag editor is interacted with
          if (e.target.closest('.card-tag-editor')) return;
          // Sub 3-3: entity chip clicked → inline editor
          var entityChip = e.target.closest('.entity-chip');
          if (entityChip && !e.target.closest('.card-entity-editor')) {
            e.stopPropagation();
            handleEntityChipClick(entityChip, card);
            return;
          }
          // Ignore clicks inside the entity editor itself (let it handle internally)
          if (e.target.closest('.card-entity-editor')) { e.stopPropagation(); return; }
          // Check if tag area was clicked
          if (e.target.closest('.card-tags')) {
            e.stopPropagation();
            var editor = card.querySelector('.card-tag-editor');
            var tagFile = editor && editor.getAttribute('data-file');
            if (tagFile) handleCardTags(tagFile, card);
            return;
          }
          // Check if action button was clicked
          var actionBtn = e.target.closest('.card-action-btn');
          var commentSubmit = e.target.closest('[data-action="comment-submit"]');
          var relatedLink = e.target.closest('.related-link');
          if (actionBtn) {
            e.stopPropagation();
            var action = actionBtn.getAttribute('data-action');
            var file = actionBtn.getAttribute('data-file');
            if (action === 'summarize') {
              handleCardSummarize(file, card);
              var relatedEl = card.querySelector('.card-related');
              if (relatedEl && !relatedEl.innerHTML) loadRelatedNotes(file, relatedEl);
            } else if (action === 'comment') {
              handleCardComment(file, card);
            } else if (action === 'tags') {
              handleCardTags(file, card);
            } else if (action === 'jarvis') {
              handleCardJarvis(file);
            } else if (action === 'delete') {
              handleCardDelete(file);
            }
            return;
          }
          if (commentSubmit) {
            e.stopPropagation();
            var file2 = commentSubmit.getAttribute('data-file');
            var textarea = card.querySelector('.card-comment-input textarea');
            if (textarea) submitCardComment(file2, textarea.value, card);
            return;
          }
          if (relatedLink) {
            e.stopPropagation();
            var relFile = relatedLink.getAttribute('data-file');
            if (relFile) openNoteDetail(relFile, window._feedNotes);
            return;
          }
          // Default: open note detail
          var fn = card.getAttribute('data-filename');
          if (fn) openNoteDetail(fn, window._feedNotes);
        });
      });
    })
    .catch(function (e) { el.innerHTML = '<div class="empty">오류: ' + e.message + '</div>'; });

  loadTodosForFeed(todosPromise);
}

// Sub 3-1/3-2: strip [[wiki]] links for display
function stripWikiLinks(arr) {
  return (arr || []).map(function (s) { return String(s).replace(/^\[\[|\]\]$/g, ''); });
}

function renderEntityChips(fm, filename) {
  var persons = stripWikiLinks(fm.participants || []);
  var places = stripWikiLinks(fm.places || []);
  var projects = stripWikiLinks(fm.projects || []);
  var speakers = fm.speakers || [];
  var chips = '';
  persons.forEach(function (p) {
    chips += '<span class="entity-chip chip-person" data-type="person" data-name="' + esc(p) + '" data-file="' + esc(filename) + '">👤 ' + esc(p) + '</span>';
  });
  places.forEach(function (p) {
    chips += '<span class="entity-chip chip-place" data-type="place" data-name="' + esc(p) + '" data-file="' + esc(filename) + '">📍 ' + esc(p) + '</span>';
  });
  projects.forEach(function (p) {
    chips += '<span class="entity-chip chip-project" data-type="project" data-name="' + esc(p) + '" data-file="' + esc(filename) + '">📂 ' + esc(p) + '</span>';
  });
  // Sub 3-2: speaker badges (voice cards)
  speakers.forEach(function (s) {
    chips += '<span class="entity-chip chip-speaker" data-type="speaker" data-name="' + esc(String(s)) + '" data-file="' + esc(filename) + '">🎤 ' + esc(String(s)) + '</span>';
  });
  return chips ? '<div class="card-entity-chips">' + chips + '</div>' : '';
}

function truncateToSentence(text, max) {
  if (text.length <= max) return text;
  var extended = text.substring(0, max);
  var last = extended.search(/[.!?。][^.!?。]*$/);
  if (last > 0) extended = extended.substring(0, last + 1);
  return extended + (extended.length < text.length ? '...' : '');
}

function renderFeedCards(notes, query) {
  return notes.map(function (note) {
    var fm = note.frontmatter || {};
    var cardType = fm['유형'] || 'memo';
    var time = fm['시간'] || '';
    var tags = fm.tags || [];
    var body = (note.body || '').replace(/^#{1,3}\s+.+\n*/gm, '').trim();
    var preview = truncateToSentence(body, 400);
    var tagHtml = tags.filter(function (t) { return t !== 'vaultvoice'; }).map(function (t) {
      return '<span class="card-tag">#' + esc(t) + '</span>';
    }).join('');
    var filename = esc(note.filename || '');
    var title = fm.title || fm['제목'] || (fm.aliases && fm.aliases[0]) || '';
    if (!title) { title = (note.filename || '').replace(/\.md$/, ''); }
    var fdMatch = (note.filename || '').match(/^(\d{4}-\d{2}-\d{2})/);
    var feedDate2 = fdMatch ? fdMatch[1] : '';

    // E1: image thumbnail
    var thumbnailHtml = '';
    if (cardType === 'image' && fm.original_image) {
      thumbnailHtml = '<div class="card-thumbnail"><img src="' + esc(fm.original_image) + '" alt="thumbnail" style="max-width:100%;max-height:120px;border-radius:6px;margin-bottom:6px"></div>';
    }

    // E9: search query highlight
    var previewHtml;
    var activeQuery = query || note._query || '';
    if (activeQuery) {
      var safeQ = activeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      previewHtml = renderMd(preview).replace(new RegExp('(' + safeQ + ')', 'gi'), '<mark>$1</mark>');
    } else {
      previewHtml = renderMd(preview);
    }

    // E12: URL source link button
    var urlLinkHtml = '';
    if (cardType === 'url' && fm.source_url) {
      urlLinkHtml = '<div class="card-url-link"><a href="' + esc(fm.source_url) + '" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent)">원본 보기 →</a></div>';
    }

    return '<div class="feed-card card-' + cardType + '" data-filename="' + filename + '">' +
      '<div class="card-header">' +
      '<span class="card-icon">' + typeIcon(cardType) + '</span>' +
      '<span class="card-type-label">' + typeLabel(cardType) + '</span>' +
      '<span class="card-time">' + esc(feedDate2 || time) + '</span>' +
      '</div>' +
      thumbnailHtml +
      '<div class="card-title">\u300C' + esc(title) + '\u300D</div>' +
      '<div class="card-body">' + previewHtml + '</div>' +
      urlLinkHtml +
      (tagHtml ? '<div class="card-tags">' + tagHtml + '</div>' : '') +
      renderEntityChips(fm, note.filename || '') +
      '<div class="card-entity-editor" style="display:none"></div>' +
      renderCardActions(filename) +
      '<div class="card-related"></div>' +
      '</div>';
  }).join('');
}

var _typeSvgPaths = {
  voice: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  url: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  memo: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  todo: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'
};
var _defaultSvgPath = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';

function typeIcon(type, size) {
  var s = size || 16;
  var paths = _typeSvgPaths[type] || _defaultSvgPath;
  return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
}

function typeLabel(type) {
  var labels = { voice: '음성', image: '이미지', url: 'URL', memo: '메모', todo: '할일', other: '기타' };
  return labels[type] || type;
}

function renderTagsHtml(tags) {
  if (!tags || !tags.length) return '';
  return '<div class="card-tags">' + tags.map(function (t) {
    return '<span class="card-tag">#' + esc(t) + '</span>';
  }).join('') + '</div>';
}

function renderCardActions(filename) {
  var svgAttr = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  var svgSummarize = '<svg ' + svgAttr + '><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  var svgComment = '<svg ' + svgAttr + '><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var svgJarvis = '<svg ' + svgAttr + '><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.17A7 7 0 0 1 14 23h-4a7 7 0 0 1-6.83-4H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/></svg>';
  var svgDelete = '<svg ' + svgAttr + '><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
  var svgTag = '<svg ' + svgAttr + '><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
  return '<div class="card-actions">' +
    '<button class="card-action-btn" data-action="summarize" data-file="' + filename + '">' + svgSummarize + '</button>' +
    '<button class="card-action-btn" data-action="comment" data-file="' + filename + '">' + svgComment + '</button>' +
    '<button class="card-action-btn" data-action="tags" data-file="' + filename + '">' + svgTag + '</button>' +
    '<button class="card-action-btn" data-action="jarvis" data-file="' + filename + '">' + svgJarvis + '</button>' +
    '<button class="card-action-btn card-action-delete" data-action="delete" data-file="' + filename + '">' + svgDelete + '</button>' +
    '</div>' +
    '<div class="card-summary" style="display:none"></div>' +
    '<div class="card-comment-input" style="display:none">' +
    '<textarea placeholder="이 노트에 대한 소감..." rows="2"></textarea>' +
    '<button class="btn-sm" data-action="comment-submit" data-file="' + filename + '">코멘트 추가</button>' +
    '</div>' +
    '<div class="card-tag-editor" style="display:none" data-file="' + filename + '">' +
    '<div class="tag-editor-current"></div>' +
    '<div class="tag-editor-suggestions"></div>' +
    '<div class="tag-editor-input-row">' +
    '<input type="text" class="tag-manual-input" placeholder="태그 입력 후 Enter">' +
    '<button class="btn-sm" data-action="tag-save" data-file="' + filename + '">저장</button>' +
    '</div>' +
    '</div>';
}

function loadTodosForFeed(prefetchedPromise) {
  var todoSection = document.getElementById('todo-list-section');
  var todoList = document.getElementById('todo-list');
  if (!todoSection || !todoList) return;

  (prefetchedPromise || api('/daily/' + fmt(feedDate) + '/todos'))
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
          (todo.done ? '<button class="todo-delete" data-line="' + todo.lineIndex + '" data-date="' + fmt(feedDate) + '" data-file="' + (todo.filename || '') + '" title="삭제"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>' : '') +
          '</div>';
      }).join('');

      todoList.querySelectorAll('.todo-check').forEach(function (btn) {
        btn.addEventListener('click', function () {
          toggleTodo(btn.getAttribute('data-date'), parseInt(btn.getAttribute('data-line')), btn.getAttribute('data-file'));
        });
      });
      todoList.querySelectorAll('.todo-delete').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (confirm('이 할일을 삭제하시겠습니까?')) {
            deleteTodo(btn.getAttribute('data-date'), parseInt(btn.getAttribute('data-line')), btn.getAttribute('data-file'));
          }
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

function deleteTodo(date, lineIndex, filename) {
  var body = { date: date, lineIndex: lineIndex };
  if (filename) body.filename = filename;
  api('/todo/delete', {
    method: 'POST',
    body: JSON.stringify(body)
  }).then(function (r) {
    if (r.ok) { showToast('삭제됨', 'success'); loadFeed(); }
  }).catch(function () {});
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
// Card-level Actions (Feed tab)
// ============================================================
function handleCardSummarize(filename, cardEl) {
  var summaryDiv = cardEl.querySelector('.card-summary');
  summaryDiv.style.display = 'block';
  summaryDiv.textContent = '요약 중...';
  api('/note/summarize', { method: 'POST', body: JSON.stringify({ filename: filename }) })
    .then(function (r) { return r.json(); })
    .then(function (data) { summaryDiv.textContent = data.summary || '요약 실패'; })
    .catch(function () { summaryDiv.textContent = '요약 실패'; });
}

function handleCardDelete(filename) {
  if (!confirm('이 노트를 삭제하시겠습니까?')) return;
  api('/note/delete', { method: 'POST', body: JSON.stringify({ filename: filename }) })
    .then(function (r) { if (r.ok) { showToast('노트가 삭제되었습니다', 'success'); loadFeed(); } })
    .catch(function () { showToast('삭제 실패', 'error'); });
}

// Sub 3-7/3-8: Save note body via PUT /api/note/content
function saveNoteContent(filename, body, silent) {
  api('/note/content', { method: 'PUT', body: JSON.stringify({ filename: filename, body: body }) })
    .then(function (r) { return r.json(); })
    .then(function () { if (!silent) showToast('저장 완료', 'success'); })
    .catch(function () { if (!silent) showToast('저장 실패', 'error'); });
}

// Sub 3-3: Entity chip inline editor
var _entityMapCache = null;
function fetchEntityMap(cb) {
  if (_entityMapCache) { cb(_entityMapCache); return; }
  api('/entities')
    .then(function (r) { return r.json(); })
    .then(function (d) { _entityMapCache = d; cb(d); })
    .catch(function () { cb({}); });
}

function handleEntityChipClick(chipEl, cardEl) {
  var editorEl = cardEl.querySelector('.card-entity-editor');
  var type = chipEl.getAttribute('data-type');
  var name = chipEl.getAttribute('data-name');
  var filename = chipEl.getAttribute('data-file');

  // Toggle: close if same chip already open
  if (editorEl.style.display !== 'none' && editorEl.getAttribute('data-editing') === name) {
    editorEl.style.display = 'none';
    return;
  }

  editorEl.setAttribute('data-editing', name);
  editorEl.style.display = 'block';
  editorEl.innerHTML =
    '<div class="entity-editor-inner">' +
    '<span class="entity-editor-label">' + (type === 'speaker' ? '🎤 화자 이름' : (type === 'person' ? '👤' : type === 'place' ? '📍' : '📂')) + ' </span>' +
    '<input class="entity-editor-input" value="' + esc(name) + '" placeholder="이름 입력">' +
    '<div class="entity-autocomplete"></div>' +
    '<button class="btn-sm entity-editor-save">저장</button>' +
    '<button class="btn-sm entity-editor-cancel" style="margin-left:4px">취소</button>' +
    '</div>';

  var input = editorEl.querySelector('.entity-editor-input');
  var acDiv = editorEl.querySelector('.entity-autocomplete');
  input.focus();

  // Autocomplete on input
  fetchEntityMap(function (entityMap) {
    var candidates = [];
    if (type === 'person' || type === 'speaker') candidates = Object.keys(entityMap.persons || {});
    else if (type === 'place') candidates = Object.keys(entityMap.places || {});
    else if (type === 'project') candidates = Object.keys(entityMap.projects || {});

    input.oninput = function () {
      var q = input.value.toLowerCase();
      var matches = q.length < 1 ? [] : candidates.filter(function (c) { return c.toLowerCase().includes(q); }).slice(0, 5);
      acDiv.innerHTML = matches.map(function (m) {
        return '<span class="ac-item" data-val="' + esc(m) + '">' + esc(m) + '</span>';
      }).join('');
      acDiv.querySelectorAll('.ac-item').forEach(function (item) {
        item.onclick = function () { input.value = item.getAttribute('data-val'); acDiv.innerHTML = ''; };
      });
    };
  });

  editorEl.querySelector('.entity-editor-cancel').onclick = function () {
    editorEl.style.display = 'none';
  };

  editorEl.querySelector('.entity-editor-save').onclick = function () {
    var newName = input.value.trim();
    if (!newName) return;
    var endpoint = type === 'speaker' ? '/note/speakers/save' : '/note/entities/save';
    var body = type === 'speaker'
      ? { filename: filename, originalSpeaker: name, resolvedName: newName }
      : { filename: filename, type: type, original: name, corrected: newName };
    api(endpoint, { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function () {
        showToast('저장 완료', 'success');
        editorEl.style.display = 'none';
        _entityMapCache = null; // invalidate
        // Update chip text in place
        chipEl.textContent = (type === 'speaker' ? '🎤 ' : type === 'person' ? '👤 ' : type === 'place' ? '📍 ' : '📂 ') + newName;
        chipEl.setAttribute('data-name', newName);
      })
      .catch(function () { showToast('저장 실패', 'error'); });
  };
}

function handleCardComment(filename, cardEl) {
  var inputDiv = cardEl.querySelector('.card-comment-input');
  inputDiv.style.display = inputDiv.style.display === 'none' ? 'block' : 'none';
}

function handleCardTags(filename, cardEl) {
  var editor = cardEl.querySelector('.card-tag-editor');
  if (!editor) return;
  if (editor.style.display !== 'none') { editor.style.display = 'none'; return; }
  editor.style.display = 'block';

  var currentDiv = editor.querySelector('.tag-editor-current');
  var sugDiv = editor.querySelector('.tag-editor-suggestions');
  currentDiv.innerHTML = '<span style="color:var(--text2);font-size:12px">태그 로딩중...</span>';
  sugDiv.innerHTML = '';

  // Load current note tags and AI suggestions
  api('/note/tags', { method: 'POST', body: JSON.stringify({ filename: filename }) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      // Show current tags (removable)
      var tags = data.currentTags || [];
      currentDiv.innerHTML = '<div class="tag-editor-label">현재 태그:</div><div class="tag-editor-chips">' +
        tags.map(function (t) {
          return '<span class="tag-chip tag-chip-active" data-tag="' + esc(t) + '">#' + esc(t) + ' <span class="tag-remove">×</span></span>';
        }).join('') + '</div>';

      // Show AI suggestions (clickable to add)
      var suggestions = data.suggestions || [];
      if (suggestions.length) {
        sugDiv.innerHTML = '<div class="tag-editor-label">AI 추천:</div><div class="tag-editor-chips">' +
          suggestions.map(function (t) {
            var isActive = tags.indexOf(t) !== -1;
            return '<span class="tag-chip' + (isActive ? ' tag-chip-active' : ' tag-chip-suggestion') + '" data-tag="' + esc(t) + '">#' + esc(t) + '</span>';
          }).join('') + '</div>';
      }

      // Bind chip clicks
      bindTagChipEvents(editor);
    })
    .catch(function () {
      currentDiv.innerHTML = '<span style="color:var(--red);font-size:12px">태그 로딩 실패</span>';
    });
}

function bindTagChipEvents(editor) {
  editor.querySelectorAll('.tag-chip').forEach(function (chip) {
    chip.onclick = function (e) {
      e.stopPropagation();
      var removeBtn = e.target.closest('.tag-remove');
      if (removeBtn) {
        chip.remove();
        return;
      }
      if (chip.classList.contains('tag-chip-suggestion')) {
        chip.classList.remove('tag-chip-suggestion');
        chip.classList.add('tag-chip-active');
        // Move to current tags section
        var currentChips = editor.querySelector('.tag-editor-current .tag-editor-chips');
        if (currentChips) {
          var clone = chip.cloneNode(false);
          clone.innerHTML = '#' + esc(chip.getAttribute('data-tag')) + ' <span class="tag-remove">×</span>';
          clone.classList.remove('tag-chip-suggestion');
          clone.classList.add('tag-chip-active');
          currentChips.appendChild(clone);
          bindTagChipEvents(editor);
        }
      }
    };
  });
}

function addTagToEditor(editor, tag) {
  var currentChips = editor.querySelector('.tag-editor-current .tag-editor-chips');
  if (!currentChips) return;
  // Check duplicate
  var existing = currentChips.querySelectorAll('.tag-chip-active');
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getAttribute('data-tag') === tag) return;
  }
  var span = document.createElement('span');
  span.className = 'tag-chip tag-chip-active';
  span.setAttribute('data-tag', tag);
  span.innerHTML = '#' + esc(tag) + ' <span class="tag-remove">×</span>';
  currentChips.appendChild(span);
  bindTagChipEvents(editor);
}

function saveCardTags(filename, editor) {
  var chips = editor.querySelectorAll('.tag-editor-current .tag-chip-active');
  var tags = [];
  chips.forEach(function (c) { tags.push(c.getAttribute('data-tag')); });

  api('/note/tags/save', { method: 'POST', body: JSON.stringify({ filename: filename, tags: tags }) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.success) {
        editor.style.display = 'none';
        showToast('태그가 저장되었습니다', 'success');
        // Update card tags display
        var card = editor.closest('.search-result-item, .vault-item, .feed-card');
        if (card) {
          var tagDiv = card.querySelector('.card-tags');
          if (tagDiv) {
            tagDiv.innerHTML = tags.filter(function (t) { return t !== 'vaultvoice'; }).map(function (t) {
              return '<span class="card-tag">#' + esc(t) + '</span>';
            }).join('');
          }
        }
      } else {
        showToast('태그 저장 실패: ' + (data.error || ''), 'error');
      }
    })
    .catch(function () { showToast('태그 저장 실패', 'error'); });
}

function submitCardComment(filename, comment, cardEl) {
  if (!comment.trim()) return;
  api('/note/comment', { method: 'POST', body: JSON.stringify({ filename: filename, comment: comment }) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.success) {
        var inputDiv = cardEl.querySelector('.card-comment-input');
        inputDiv.style.display = 'none';
        inputDiv.querySelector('textarea').value = '';
        showToast('코멘트가 추가되었습니다', 'success');
      } else {
        showToast('코멘트 추가 실패', 'error');
      }
    })
    .catch(function () { showToast('코멘트 추가 실패', 'error'); });
}

function handleCardJarvis(filename) {
  switchTab('ai', document.querySelector('.tab-btn[data-tab="ai"]'));
  var msg = '노트 ' + filename + ' 에 대해 알려줘';
  var jarvisInputEl = document.getElementById('jarvis-input');
  if (jarvisInputEl) jarvisInputEl.value = '';
  sendJarvis(msg);
}

function loadRelatedNotes(filename, containerEl) {
  api('/note/related', { method: 'POST', body: JSON.stringify({ filename: filename }) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.notes && data.notes.length > 0) {
        containerEl.innerHTML = '<div class="related-notes"><span class="related-label">관련 노트</span>' +
          data.notes.map(function (n) {
            return '<a class="related-link" data-file="' + esc(n.filename) + '">' + esc(n.title || n.filename) + '</a>';
          }).join('') + '</div>';
      }
    })
    .catch(function () {});
}

// ---- Shared card action event delegation ----
function bindCardActionEvents(container) {
  // Clicking on .card-tags area opens tag editor
  container.querySelectorAll('.card-tags:not([data-bound])').forEach(function (tagDiv) {
    tagDiv.setAttribute('data-bound', '1');
    tagDiv.addEventListener('click', function (e) {
      e.stopPropagation();
      var card = tagDiv.closest('.search-result-item, .vault-item, .feed-card');
      if (!card) return;
      var editor = card.querySelector('.card-tag-editor');
      var file = editor && editor.getAttribute('data-file');
      if (file) handleCardTags(file, card);
    });
  });
  container.querySelectorAll('.card-action-btn:not([data-bound])').forEach(function (btn) {
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var action = btn.getAttribute('data-action');
      var file = btn.getAttribute('data-file');
      var card = btn.closest('.search-result-item, .vault-item, .feed-card');
      if (!card) return;
      if (action === 'summarize') handleCardSummarize(file, card);
      else if (action === 'comment') handleCardComment(file, card);
      else if (action === 'tags') handleCardTags(file, card);
      else if (action === 'jarvis') handleCardJarvis(file);
      else if (action === 'delete') handleCardDelete(file);
    });
  });
  container.querySelectorAll('[data-action="comment-submit"]:not([data-bound])').forEach(function (btn) {
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var file = btn.getAttribute('data-file');
      var card = btn.closest('.search-result-item, .vault-item, .feed-card');
      var textarea = card && card.querySelector('.card-comment-input textarea');
      if (textarea) submitCardComment(file, textarea.value, card);
    });
  });
  container.querySelectorAll('[data-action="tag-save"]:not([data-bound])').forEach(function (btn) {
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var file = btn.getAttribute('data-file');
      var editor = btn.closest('.card-tag-editor');
      if (editor) saveCardTags(file, editor);
    });
  });
  container.querySelectorAll('.tag-manual-input:not([data-bound])').forEach(function (inp) {
    inp.setAttribute('data-bound', '1');
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        var tag = inp.value.trim();
        if (!tag) return;
        var editor = inp.closest('.card-tag-editor');
        if (editor) {
          addTagToEditor(editor, tag);
          inp.value = '';
        }
      }
    });
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
  });
}

// ============================================================
// Search Tab
// ============================================================
function loadHistoryFallback() {
  var histList = document.getElementById('hist-list');
  if (!histList) return;
  histList.style.display = 'none';
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
function openNoteDetail(filename, noteList, currentIndex) {
  var overlay = document.getElementById('note-detail-overlay');
  var card = document.getElementById('note-detail-card');
  var bodyEl = document.getElementById('note-detail-body');
  var typeEl = document.getElementById('note-detail-type');
  var timeEl = document.getElementById('note-detail-time');
  var tagsEl = document.getElementById('note-detail-tags');
  var indEl = document.getElementById('note-detail-indicator');
  var prevBtn = document.getElementById('note-nav-prev');
  var nextBtn = document.getElementById('note-nav-next');
  var closeBtn = document.getElementById('note-detail-close');

  // Resolve note list context
  var notes = noteList || window._feedNotes || [];
  var idx = typeof currentIndex === 'number' ? currentIndex :
    notes.findIndex(function (n) { return n.filename === filename; });
  window._noteDetailList = notes;
  window._noteDetailIdx = idx;

  overlay.style.display = '';
  card.style.transform = '';
  card.style.opacity = '1';
  card.style.transition = '';
  card.scrollTop = 0;

  // Indicator + nav buttons
  if (notes.length > 1 && idx >= 0) {
    indEl.textContent = (idx + 1) + ' / ' + notes.length;
    indEl.style.display = '';
    prevBtn.style.display = '';
    nextBtn.style.display = '';
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= notes.length - 1;
  } else {
    indEl.style.display = 'none';
    prevBtn.style.display = 'none';
    nextBtn.style.display = 'none';
  }

  // Show cached preview first, then always fetch full note from API
  var cached = idx >= 0 ? notes[idx] : null;
  if (cached) {
    var fm = cached.frontmatter || {};
    typeEl.innerHTML = typeIcon(fm['유형'] || 'memo');
    timeEl.textContent = fm['시간'] || '';
    bodyEl.innerHTML = renderMd(cached.body || '');
    var tags = (fm.tags || []).filter(function (t) { return t !== 'vaultvoice'; });
    tagsEl.innerHTML = tags.map(function (t) {
      return '<span class="card-tag">#' + esc(t) + '</span>';
    }).join('');
  } else {
    typeEl.textContent = '';
    timeEl.textContent = '';
    tagsEl.innerHTML = '';
    bodyEl.innerHTML = '<div class="empty">로딩 중...</div>';
  }
  // Sub 3-6: ensure edit controls exist in note-detail-card
  if (!card.querySelector('.note-edit-bar')) {
    var editBar = document.createElement('div');
    editBar.className = 'note-edit-bar';
    editBar.style.cssText = 'display:flex;gap:6px;padding:8px 16px 0;';
    editBar.innerHTML =
      '<button class="btn-sm note-edit-btn" id="note-btn-edit">편집</button>' +
      '<button class="btn-sm note-edit-btn" id="note-btn-preview" style="display:none">미리보기</button>' +
      '<button class="btn-sm note-edit-btn" id="note-btn-save" style="display:none">저장</button>';
    var bodyRef = document.getElementById('note-detail-body');
    card.insertBefore(editBar, bodyRef);

    // Sub 3-9: edit/preview toggle + Sub 3-8: debounce autosave
    var _editDebounceTimer = null;
    var _editFilename = null;

    function enterEditMode(body) {
      bodyEl.style.display = 'none';
      var ta = document.getElementById('note-edit-textarea');
      if (!ta) {
        ta = document.createElement('textarea');
        ta.id = 'note-edit-textarea';
        ta.style.cssText = 'width:100%;min-height:200px;background:transparent;color:inherit;border:1px solid var(--border,#333);border-radius:8px;padding:10px;font-size:14px;line-height:1.6;resize:none;box-sizing:border-box;';
        ta.oninput = function () {
          // auto-resize
          ta.style.height = 'auto';
          ta.style.height = ta.scrollHeight + 'px';
          // debounce autosave — Sub 3-8
          clearTimeout(_editDebounceTimer);
          _editDebounceTimer = setTimeout(function () { saveNoteContent(_editFilename, ta.value, true); }, 1000);
        };
        bodyRef.parentNode.insertBefore(ta, bodyRef);
      }
      ta.value = body;
      ta.style.display = 'block';
      setTimeout(function () { ta.style.height = ta.scrollHeight + 'px'; }, 0);
      document.getElementById('note-btn-edit').style.display = 'none';
      document.getElementById('note-btn-preview').style.display = '';
      document.getElementById('note-btn-save').style.display = '';
    }

    document.getElementById('note-btn-edit').onclick = function () {
      var ta = document.getElementById('note-edit-textarea');
      if (ta && ta.style.display !== 'none') return; // already editing
      // fetch current body
      api('/note/' + encodeURIComponent(_editFilename || filename))
        .then(function (r) { return r.json(); })
        .then(function (d) { enterEditMode(d.body || ''); });
    };

    document.getElementById('note-btn-preview').onclick = function () {
      var ta = document.getElementById('note-edit-textarea');
      if (!ta) return;
      // Sub 3-9: toggle to preview
      if (ta.style.display !== 'none') {
        bodyEl.innerHTML = (typeof marked !== 'undefined') ? marked.parse(ta.value) : renderMd(ta.value);
        bodyEl.style.display = '';
        ta.style.display = 'none';
        document.getElementById('note-btn-preview').textContent = '편집';
        document.getElementById('note-btn-edit').style.display = 'none';
      } else {
        bodyEl.style.display = 'none';
        ta.style.display = 'block';
        document.getElementById('note-btn-preview').textContent = '미리보기';
        document.getElementById('note-btn-edit').style.display = 'none';
      }
    };

    document.getElementById('note-btn-save').onclick = function () {
      var ta = document.getElementById('note-edit-textarea');
      if (!ta) return;
      clearTimeout(_editDebounceTimer);
      saveNoteContent(_editFilename || filename, ta.value, false);
    };
  }

  // Always fetch full note (cached body may be truncated)
  api('/note/' + encodeURIComponent(filename))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var fm = d.frontmatter || {};
      typeEl.innerHTML = typeIcon(fm['유형'] || 'memo');
      timeEl.textContent = fm['시간'] || '';
      bodyEl.innerHTML = renderMd(d.body || '');
      // Sub 3-6: reset edit mode on note change
      var ta = document.getElementById('note-edit-textarea');
      if (ta) { ta.style.display = 'none'; bodyEl.style.display = ''; }
      var editBtn = document.getElementById('note-btn-edit');
      var previewBtn = document.getElementById('note-btn-preview');
      var saveBtn = document.getElementById('note-btn-save');
      if (editBtn) editBtn.style.display = '';
      if (previewBtn) { previewBtn.style.display = 'none'; previewBtn.textContent = '미리보기'; }
      if (saveBtn) saveBtn.style.display = 'none';
      // store filename for edit actions
      var bar = card.querySelector('.note-edit-bar');
      if (bar) bar._filename = filename;
      var tags = (fm.tags || []).filter(function (t) { return t !== 'vaultvoice'; });
      tagsEl.innerHTML = tags.map(function (t) {
        return '<span class="card-tag">#' + esc(t) + '</span>';
      }).join('');
    })
    .catch(function () { if (!cached) bodyEl.innerHTML = '<div class="empty">노트를 불러올 수 없습니다</div>'; });

  // track current filename for edit actions
  var bar = card.querySelector('.note-edit-bar');
  if (bar) { bar._filename = filename; }
  // Use closure variable in event handlers
  var saveFilename = filename;
  // patch save/edit onclick to use current filename
  var editBtn2 = document.getElementById('note-btn-edit');
  if (editBtn2) {
    editBtn2.onclick = function () {
      var ta = document.getElementById('note-edit-textarea');
      if (ta && ta.style.display !== 'none') return;
      api('/note/' + encodeURIComponent(saveFilename))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          bodyEl.style.display = 'none';
          var ta2 = document.getElementById('note-edit-textarea');
          if (!ta2) {
            ta2 = document.createElement('textarea');
            ta2.id = 'note-edit-textarea';
            ta2.style.cssText = 'width:100%;min-height:200px;background:transparent;color:inherit;border:1px solid var(--border,#333);border-radius:8px;padding:10px;font-size:14px;line-height:1.6;resize:none;box-sizing:border-box;';
            var br2 = document.getElementById('note-detail-body');
            br2.parentNode.insertBefore(ta2, br2);
          }
          ta2.value = d.body || '';
          ta2.style.display = 'block';
          ta2.style.height = 'auto';
          ta2.style.height = ta2.scrollHeight + 'px';
          var _debounce2 = null;
          ta2.oninput = function () {
            ta2.style.height = 'auto';
            ta2.style.height = ta2.scrollHeight + 'px';
            clearTimeout(_debounce2);
            _debounce2 = setTimeout(function () { saveNoteContent(saveFilename, ta2.value, true); }, 1000);
          };
          document.getElementById('note-btn-edit').style.display = 'none';
          document.getElementById('note-btn-preview').style.display = '';
          document.getElementById('note-btn-save').style.display = '';
          document.getElementById('note-btn-preview').onclick = function () {
            if (ta2.style.display !== 'none') {
              bodyEl.innerHTML = (typeof marked !== 'undefined') ? marked.parse(ta2.value) : renderMd(ta2.value);
              bodyEl.style.display = '';
              ta2.style.display = 'none';
              this.textContent = '편집';
            } else {
              bodyEl.style.display = 'none';
              ta2.style.display = 'block';
              this.textContent = '미리보기';
            }
          };
          document.getElementById('note-btn-save').onclick = function () {
            clearTimeout(_debounce2);
            saveNoteContent(saveFilename, ta2.value, false);
          };
        });
    };
  }

  // Swipe gesture setup
  setupNoteSwipe(card, overlay);

  // Nav button handlers (replace old ones)
  prevBtn.onclick = function () { noteNavGo(-1); };
  nextBtn.onclick = function () { noteNavGo(1); };
  closeBtn.onclick = function () { closeNoteDetail(); };
}

function noteNavGo(dir) {
  var notes = window._noteDetailList || [];
  var idx = window._noteDetailIdx;
  var next = idx + dir;
  if (next < 0 || next >= notes.length) return;
  var card = document.getElementById('note-detail-card');
  card.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
  card.style.transform = 'translateX(' + (dir < 0 ? '60px' : '-60px') + ')';
  card.style.opacity = '0.3';
  setTimeout(function () {
    openNoteDetail(notes[next].filename, notes, next);
  }, 200);
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

    if (Math.abs(dx) > threshold) {
      // Left swipe → next, Right swipe → prev
      var dir = dx < 0 ? 1 : -1;
      var notes = window._noteDetailList || [];
      var curIdx = window._noteDetailIdx;
      var targetIdx = curIdx + dir;
      if (targetIdx >= 0 && targetIdx < notes.length) {
        card.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
        card.style.transform = 'translateX(' + (dx < 0 ? '-120%' : '120%') + ')';
        card.style.opacity = '0';
        setTimeout(function () {
          openNoteDetail(notes[targetIdx].filename, notes, targetIdx);
        }, 250);
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

// Close on background tap (not on card or close button)
document.addEventListener('DOMContentLoaded', function () {
  var overlay = document.getElementById('note-detail-overlay');
  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeNoteDetail();
    });
  }
});

function doSearch(signal) {
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
  var filterType = (document.getElementById('filterType') && document.getElementById('filterType').value) || '';
  var filterDate = (document.getElementById('filterDate') && document.getElementById('filterDate').value) || '';
  var params = new URLSearchParams({ q: q, scope: scope });
  if (filterType) params.append('filterType', filterType);
  if (filterDate) params.append('filterDate', filterDate);
  api('/search?' + params.toString(), signal ? { signal: signal } : undefined)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.results || !d.results.length) {
        resultsEl.innerHTML = '<div class="empty" style="padding:20px">"' + esc(q) + '" 검색 결과 없음</div>';
        return;
      }
      // Build search result note list for swipe navigation
      window._searchResults = d.results.map(function (r) {
        return { filename: r.filename, body: r.matches.map(function (m) { return m.text; }).join('\n'), frontmatter: {} };
      });
      var html = '<div class="search-summary">' + d.total + '개 노트에서 발견</div>';
      html += d.results.map(function (r, i) {
        var typeMatch = (r.filename || '').match(/_([a-z]+)\.md$/);
        var type = typeMatch ? typeMatch[1] : 'memo';
        var dateMatch = (r.filename || '').match(/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})/);
        var timeStr = dateMatch ? dateMatch[2] + ':' + dateMatch[3] : '';
        // Body preview (always shown)
        var previewText = r.preview || '';
        var previewTrimmed = previewText.length > 300 ? previewText.substring(0, 300) + '...' : previewText;
        var previewHighlighted = esc(previewTrimmed).replace(
          new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'),
          '<mark>$1</mark>'
        );
        var matchHtml = previewHighlighted ? '<div class="card-body">' + linkifyUrls(previewHighlighted) + '</div>' : '';
        var displayTitle = r.title || (r.filename || '').replace(/\.md$/, '');
        var dateStr2 = r.dateStr || '';
        return '<div class="search-result-item" data-filename="' + esc(r.filename || '') + '" data-idx="' + i + '">' +
          '<div class="search-result-header">' +
            '<span class="card-icon">' + typeIcon(type) + '</span>' +
            '<span class="card-type-label">' + typeLabel(type) + '</span>' +
            '<span class="search-result-title">\u300C' + esc(displayTitle) + '\u300D</span>' +
            '<span class="card-time">' + (dateStr2 || timeStr) + '</span>' +
          '</div>' +
          matchHtml +
          renderTagsHtml(r.tags) +
          renderCardActions(esc(r.filename || '')) + '</div>';
      }).join('');
      resultsEl.innerHTML = html;
      bindCardActionEvents(resultsEl);
      resultsEl.querySelectorAll('.search-result-item').forEach(function (item) {
        var fn = item.getAttribute('data-filename');
        var idx = parseInt(item.getAttribute('data-idx'));
        item.addEventListener('click', function (e) {
          if (e.target.closest('a') || e.target.closest('.card-action-btn') || e.target.closest('.card-comment-input') || e.target.closest('.card-tags') || e.target.closest('.card-tag-editor')) return;
          if (fn) openNoteDetail(fn, window._searchResults, idx);
          else openPreview(item.getAttribute('data-date'));
        });
      });
    })
    .catch(function (e) {
      if (e.name === 'AbortError') return;
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
      // Build AI search result note list for swipe navigation
      window._searchResults = d.results.map(function (r) {
        return { filename: r.filename, body: r.matches.map(function (m) { return m.text; }).join('\n'), frontmatter: {} };
      });
      var html = keywordsHtml + '<div class="search-summary">' + d.total + '개 노트에서 발견</div>';
      html += d.results.map(function (r, i) {
        var typeMatch = (r.filename || '').match(/_([a-z]+)\.md$/);
        var type = typeMatch ? typeMatch[1] : 'memo';
        var dateMatch = (r.filename || '').match(/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})/);
        var timeStr = dateMatch ? dateMatch[2] + ':' + dateMatch[3] : '';
        var previewText2 = r.preview || '';
        var previewTrimmed2 = previewText2.length > 300 ? previewText2.substring(0, 300) + '...' : previewText2;
        var matchText = esc(previewTrimmed2);
        (r.matches[0] && r.matches[0].keywords || []).forEach(function (k) {
          var re = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
          matchText = matchText.replace(re, '<mark>$1</mark>');
        });
        var matchHtml = matchText ? '<div class="card-body">' + linkifyUrls(matchText) + '</div>' : '';
        var displayTitle = r.title || (r.filename || '').replace(/\.md$/, '');
        var dateStr2 = r.dateStr || '';
        return '<div class="search-result-item" data-filename="' + esc(r.filename || '') + '" data-idx="' + i + '">' +
          '<div class="search-result-header">' +
            '<span class="card-icon">' + typeIcon(type) + '</span>' +
            '<span class="card-type-label">' + typeLabel(type) + '</span>' +
            '<span class="search-result-title">\u300C' + esc(displayTitle) + '\u300D</span>' +
            '<span class="card-time">' + (dateStr2 || timeStr) + '</span>' +
          '</div>' +
          matchHtml +
          renderTagsHtml(r.tags) +
          renderCardActions(esc(r.filename || '')) + '</div>';
      }).join('');
      resultsEl.innerHTML = html;
      bindCardActionEvents(resultsEl);
      resultsEl.querySelectorAll('.search-result-item').forEach(function (item) {
        var fn = item.getAttribute('data-filename');
        var idx = parseInt(item.getAttribute('data-idx'));
        item.addEventListener('click', function (e) {
          if (e.target.closest('a') || e.target.closest('.card-action-btn') || e.target.closest('.card-comment-input') || e.target.closest('.card-tags') || e.target.closest('.card-tag-editor')) return;
          if (fn) openNoteDetail(fn, window._searchResults, idx);
          else openPreview(item.getAttribute('data-date'));
        });
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
var _calCheckPending = false;

function checkCalendarStatus(silent) {
  if (_calCheckPending) return;
  _calCheckPending = true;
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
    .catch(function () {})
    .finally(function () { _calCheckPending = false; });
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

  // 1. Extract tables and <details> blocks from raw md before processing
  //    Replace them with placeholders, process the rest, then reinsert
  var placeholders = [];
  var ph = function (content) {
    var idx = placeholders.length;
    placeholders.push(content);
    return '\x00PH' + idx + '\x00';
  };

  // Extract <details>...</details> blocks
  var processed = md.replace(/<details[\s\S]*?<\/details>/gi, function (m) {
    return ph(m);
  });

  // Extract markdown tables (line-by-line scan)
  var lines = processed.split('\n');
  var result = [];
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    // Detect table header: starts with | and next line is separator |---|
    if (line.trim().charAt(0) === '|' && i + 1 < lines.length && lines[i + 1].trim().match(/^\|[\s:|-]+\|/)) {
      var tableLines = [line];
      i++;
      // Collect separator + data rows
      while (i < lines.length && lines[i].trim().charAt(0) === '|') {
        tableLines.push(lines[i]);
        i++;
      }
      result.push(ph(renderMdTable(tableLines)));
    } else {
      result.push(line);
      i++;
    }
  }
  processed = result.join('\n');

  // 2. Now process the rest as normal markdown
  var h = esc(processed);
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/- \[x\] (.+)/g, '<li style="list-style:none"><input type="checkbox" checked disabled> <s>$1</s></li>');
  h = h.replace(/- \[ \] (.+)/g, '<li style="list-style:none"><input type="checkbox" disabled> $1</li>');
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
  h = h.replace(/!\[\[([^\]]+\.(webm|mp3|wav|m4a|ogg|mp4))\]\]/gi, function (match, p) {
    var fname = p.split('/').pop();
    return '<audio controls style="width:100%;margin:4px 0"><source src="/api/attachments/' + encodeURIComponent(fname) + '"></audio>';
  });
  h = h.replace(/!\[\[([^\]]+)\]\]/g, function (match, p) {
    var fname = p.split('/').pop();
    return '<img src="/api/attachments/' + encodeURIComponent(fname) + '" style="max-width:100%;border-radius:8px;margin:4px 0" alt="' + esc(fname) + '">';
  });
  h = h.replace(/\n\n+/g, '<br><br>');
  h = linkifyUrls(h);

  // 3. Reinsert placeholders
  h = h.replace(/\x00PH(\d+)\x00/g, function (m, idx) {
    return placeholders[parseInt(idx)];
  });
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
    // Pick best title: first non-empty column with 2+ chars, fallback to first non-empty
    var titleIdx = 0;
    var titleText = row[0] || '';
    if (titleText.length < 2) {
      for (var t = 1; t < row.length; t++) {
        if (row[t] && row[t].length >= 2) { titleIdx = t; titleText = row[t]; break; }
      }
    }
    html += '<div class="md-table-card-title">' + esc(titleText) + '</div>';
    html += '<div class="md-table-card-meta">';
    for (var j = 0; j < row.length && j < headers.length; j++) {
      if (j === titleIdx || !row[j]) continue;
      html += '<span class="md-table-card-field"><span class="md-table-card-label">' + esc(headers[j]) + '</span> ' + esc(row[j]) + '</span>';
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
    if (d.geminiPro) checks.push({ name: 'Gemini Pro', ok: d.geminiPro.ok, detail: d.geminiPro.ok ? 'API 연결 OK' : (d.geminiPro.error || '실패') });
    if (d.noteSummarize) checks.push({ name: '노트 요약 API', ok: d.noteSummarize.ok, detail: d.noteSummarize.ok ? 'OK' : '실패' });
    if (d.noteComment) checks.push({ name: '노트 코멘트 API', ok: d.noteComment.ok, detail: d.noteComment.ok ? 'OK' : '실패' });
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

var jarvisInput, jarvisMic, jarvisSend, jarvisChat, jarvisReset, jarvisStatus;

function initJarvis() {
  jarvisInput = document.getElementById('jarvis-input');
  jarvisMic = document.getElementById('jarvis-mic');
  jarvisSend = document.getElementById('jarvis-send');
  jarvisChat = document.getElementById('jarvis-chat');
  jarvisReset = document.getElementById('jarvis-reset');
  jarvisStatus = document.getElementById('jarvis-status');
  if (!jarvisChat) return;
  jarvisSend.onclick = function () { sendJarvis(jarvisInput.value.trim()); };
  jarvisInput.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendJarvis(jarvisInput.value.trim()); } };
  document.getElementById('jarvis-cancel').onclick = cancelJarvis;
  jarvisReset.onclick = function () { cancelJarvis(); jarvisChatHistory = []; clearJarvisHistory(); jarvisChat.innerHTML = ''; addJarvisWelcome(); setJarvisStatus(''); };
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
    var noteLink = e.target.closest('.jarvis-note-link');
    if (noteLink) { e.preventDefault(); openNoteDetail(noteLink.getAttribute('data-note')); return; }
    var hint = e.target.closest('.jarvis-hint');
    if (hint) { var msg = hint.getAttribute('data-msg'); if (msg) sendJarvis(msg); }
    var bubble = e.target.closest('.jarvis-bubble-bot');
    if (bubble && jarvisTTSActive) stopTTS();
  });
  // Onboarding buttons
  document.querySelectorAll('.onboarding-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var prompt = this.getAttribute('data-prompt');
      var input = document.getElementById('jarvis-input');
      if (!input) return;
      input.value = prompt;
      input.focus();
      hideOnboarding();
      // URL 버튼은 자동 전송하지 않고 사용자가 URL 입력하게 함
      if (!prompt.endsWith(': ')) {
        sendJarvis(prompt);
      } else {
        input.setSelectionRange(prompt.length, prompt.length);
      }
    });
  });
  // Reset 시 온보딩 다시 표시
  var origReset = jarvisReset.onclick;
  jarvisReset.onclick = function () {
    if (origReset) origReset();
    showOnboarding();
  };
  // 초기 온보딩 상태
  showOnboarding();
}

function hideOnboarding() {
  var el = document.getElementById('jarvis-onboarding');
  if (el) el.style.display = 'none';
}

function showOnboarding() {
  var el = document.getElementById('jarvis-onboarding');
  if (!el) return;
  var chatMessages = document.querySelectorAll('.jarvis-bubble-user, .jarvis-bubble-bot');
  if (chatMessages.length === 0) el.style.display = 'block';
  else el.style.display = 'none';
}

function openJarvis() { switchTab('ai', document.querySelector('.tab-btn[data-tab="ai"]')); }
function closeJarvis() { stopTTS(); }

function addToJarvisHistory(role, text) {
  jarvisChatHistory.push({ role: role, text: text });
  if (jarvisChatHistory.length > 60) jarvisChatHistory = jarvisChatHistory.slice(-60);
  saveJarvisHistory();
}

var jarvisAbortController = null;

function cancelJarvis() {
  if (jarvisAbortController) { jarvisAbortController.abort(); jarvisAbortController = null; }
}

function setJarvisSendingUI(sending) {
  var sendBtn = document.getElementById('jarvis-send');
  var cancelBtn = document.getElementById('jarvis-cancel');
  if (sendBtn) sendBtn.style.display = sending ? 'none' : '';
  if (cancelBtn) cancelBtn.style.display = sending ? '' : 'none';
}

function sendJarvis(text) {
  if (!text || jarvisIsSending) return;
  jarvisIsSending = true;
  jarvisAbortController = new AbortController();
  setJarvisSendingUI(true);
  stopTTS();
  hideOnboarding();
  var welcome = jarvisChat.querySelector('.jarvis-welcome');
  if (welcome) welcome.remove();
  addJarvisBubble(text, 'user');
  addToJarvisHistory('user', text);
  jarvisInput.value = '';
  var typingEl = addJarvisTyping();
  setJarvisStatus('응답 대기 중...');
  api('/ai/chat', { method: 'POST', body: JSON.stringify({ message: text, history: jarvisChatHistory.slice(0, -1) }), signal: jarvisAbortController.signal })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      typingEl.remove();
      var reply = d.reply || d.error || '이해하지 못했습니다.';
      addJarvisBubble(reply, 'bot');
      addToJarvisHistory('model', reply);
      setJarvisStatus('');
      speak(reply);
    })
    .catch(function (e) {
      typingEl.remove();
      if (e.name === 'AbortError') { addJarvisBubble('취소됨', 'error'); setJarvisStatus(''); }
      else { addJarvisBubble('오류: ' + e.message, 'error'); setJarvisStatus(''); }
    })
    .then(function () { jarvisIsSending = false; jarvisAbortController = null; setJarvisSendingUI(false); });
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
  // [노트: filename.md] pattern → clickable card link
  h = h.replace(/\[노트:\s*([^\]]+\.md)\]/g, function (m, fn) {
    return '<a href="#" class="jarvis-note-link" data-note="' + fn.trim() + '" style="display:inline-block;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin:4px 0;color:var(--accent);text-decoration:none">📄 ' + fn.trim() + '</a>';
  });
  // Make note filenames clickable (e.g. 2026-04-01_013228_voice.md)
  h = h.replace(/(?<!")(\d{4}-\d{2}-\d{2}_\d{6}_\w+\.md)(?!")/g, '<a href="#" class="jarvis-note-link" data-note="$1">$1</a>');
  h = h.replace(/^[-•] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  h = linkifyUrls(h);
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
  // If already recording, stop and process
  if (jarvisRecog) {
    jarvisRecog.stop();
    return;
  }
  stopTTS();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    addJarvisBubble('이 브라우저에서는 마이크를 사용할 수 없습니다.', 'error');
    return;
  }

  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    var mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    var options = mimeType ? { mimeType: mimeType } : {};
    var recorder = new MediaRecorder(stream, options);
    var chunks = [];
    jarvisRecog = recorder;

    recorder.ondataavailable = function (e) { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstart = function () {
      jarvisMic.classList.add('recording');
      setJarvisStatus('듣는 중... (탭하면 전송)');
    };
    recorder.onstop = function () {
      jarvisRecog = null;
      jarvisMic.classList.remove('recording');
      stream.getTracks().forEach(function (t) { t.stop(); });

      if (chunks.length === 0) { setJarvisStatus(''); return; }

      var blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      setJarvisStatus('음성 변환 중...');
      jarvisMic.disabled = true;

      var formData = new FormData();
      var ext = (mimeType || '').indexOf('mp4') !== -1 ? 'mp4' : 'webm';
      formData.append('audio', blob, 'jarvis_voice.' + ext);

      apiUpload('/ai/transcribe', formData)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          jarvisMic.disabled = false;
          if (data.text) {
            setJarvisStatus('');
            sendJarvis(data.text);
          } else {
            setJarvisStatus('음성을 인식하지 못했습니다');
            setTimeout(function () { setJarvisStatus(''); }, 2000);
          }
        })
        .catch(function (e) {
          jarvisMic.disabled = false;
          setJarvisStatus('음성 변환 오류');
          setTimeout(function () { setJarvisStatus(''); }, 2000);
        });
    };

    recorder.start();
  }).catch(function (err) {
    addJarvisBubble('마이크 권한이 필요합니다: ' + err.message, 'error');
  });
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

  // ---- Retag ----
  var retagBtn = document.getElementById('retag-btn');
  if (retagBtn) {
    retagBtn.addEventListener('click', function () {
      var status = document.getElementById('retag-status');
      if (!confirm('최근 7일 노트의 태그를 AI로 재생성하시겠습니까?')) return;
      retagBtn.disabled = true;
      retagBtn.textContent = '태그 재생성 중...';
      status.textContent = '노트를 분석하고 있습니다...';
      status.style.color = 'var(--text2)';
      api('/vault/retag', { method: 'POST', body: JSON.stringify({ days: 7 }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var ok = d.results ? d.results.filter(function (r) { return r.status === 'ok'; }).length : 0;
          var skip = d.results ? d.results.filter(function (r) { return r.status === 'skipped'; }).length : 0;
          status.textContent = '완료! ' + ok + '개 업데이트, ' + skip + '개 건너뜀';
          status.style.color = 'var(--green)';
        })
        .catch(function (e) { status.textContent = '오류: ' + e.message; status.style.color = 'var(--red)'; })
        .finally(function () { retagBtn.disabled = false; retagBtn.textContent = '최근 7일 태그 재생성'; });
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
    openMiniCalendar();
  });

  // ---- Search tab ----
  document.getElementById('btnSearch').addEventListener('click', doSearch);
  document.getElementById('btnAiSearch').addEventListener('click', doAISearch);
  var searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  var searchTimer = null;
  var searchAbortController = null;
  searchInput.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    if (searchAbortController) { searchAbortController.abort(); searchAbortController = null; }
    searchTimer = setTimeout(function () {
      if (searchInput.value.trim()) {
        searchAbortController = new AbortController();
        doSearch(searchAbortController.signal);
      }
    }, 500);
  });
  document.getElementById('hist-close').addEventListener('click', closePreview);

  // ---- Settings tab ----
  document.getElementById('logout-btn').addEventListener('click', doLogout);
  initPushUI();
  document.getElementById('push-subscribe-btn').addEventListener('click', function () {
    var btn = document.getElementById('push-subscribe-btn');
    if (btn.dataset.state === 'subscribed') {
      teardownPushNotification();
    } else {
      setupPushNotification();
    }
  });
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
// Push Notification
// ============================================================
function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var rawData = atob(base64);
  var out = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

function initPushUI() {
  var btn = document.getElementById('push-subscribe-btn');
  var statusEl = document.getElementById('push-status');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusEl.textContent = '이 브라우저는 푸시 알림을 지원하지 않습니다.';
    btn.disabled = true;
    return;
  }
  navigator.serviceWorker.ready.then(function (reg) {
    return reg.pushManager.getSubscription();
  }).then(function (sub) {
    if (sub) {
      statusEl.textContent = '구독 중';
      btn.textContent = '구독 해제';
      btn.dataset.state = 'subscribed';
    } else {
      statusEl.textContent = '미구독';
      btn.textContent = '구독';
      btn.dataset.state = 'unsubscribed';
    }
  }).catch(function () {
    statusEl.textContent = '상태 확인 실패';
  });
}

function setupPushNotification() {
  var btn = document.getElementById('push-subscribe-btn');
  var statusEl = document.getElementById('push-status');
  btn.disabled = true;
  statusEl.textContent = '구독 중...';
  api('/push/vapid-public-key').then(function (r) { return r.json(); }).then(function (d) {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(d.publicKey)
      });
    });
  }).then(function (sub) {
    return api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
  }).then(function () {
    statusEl.textContent = '구독 중';
    btn.textContent = '구독 해제';
    btn.dataset.state = 'subscribed';
    btn.disabled = false;
  }).catch(function (e) {
    statusEl.textContent = '구독 실패: ' + (e.message || '알 수 없는 오류');
    btn.disabled = false;
  });
}

function teardownPushNotification() {
  var btn = document.getElementById('push-subscribe-btn');
  var statusEl = document.getElementById('push-status');
  btn.disabled = true;
  statusEl.textContent = '해제 중...';
  navigator.serviceWorker.ready.then(function (reg) {
    return reg.pushManager.getSubscription();
  }).then(function (sub) {
    if (!sub) return;
    return api('/push/unsubscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: sub.endpoint })
    }).then(function () { return sub.unsubscribe(); });
  }).then(function () {
    statusEl.textContent = '미구독';
    btn.textContent = '구독';
    btn.dataset.state = 'unsubscribed';
    btn.disabled = false;
  }).catch(function (e) {
    statusEl.textContent = '해제 실패: ' + (e.message || '알 수 없는 오류');
    btn.disabled = false;
  });
}

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
  navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'PROCESS_QUEUE') processOfflineQueue();
  });
}

// ============================================================
// Vault Browser
// ============================================================
var _vaultOffset = 0;
var _vaultHasMore = false;
var _vaultStatsLoaded = false;
var _vaultFilterType = '';
var _vaultFilterTags = [];

function loadVaultBrowser() {
  if (!_vaultStatsLoaded) {
    _vaultStatsLoaded = true;
    loadVaultStats();
    // Stats toggle
    document.getElementById('vault-stats-toggle').onclick = function () {
      var statsEl = document.getElementById('vault-stats');
      var arrow = this.querySelector('.vault-stats-arrow');
      var open = statsEl.style.display !== 'none';
      statsEl.style.display = open ? 'none' : '';
      arrow.classList.toggle('open', !open);
    };
  }
  _vaultOffset = 0;
  loadVaultList(false);
  document.getElementById('vault-load-more').onclick = function () { loadVaultList(true); };
}

function loadVaultStats() {
  api('/vault/stats')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      // Total count
      document.getElementById('vault-stats-total').textContent = d.total + '개 노트';

      // Stats detail (hidden by default)
      var el = document.getElementById('vault-stats');
      var known = ['voice', 'image', 'url', 'memo', 'todo', 'other'];
      var types = Object.entries(d.types || {}).sort(function (a, b) { return b[1] - a[1]; });
      var maxCount = types.length ? types[0][1] : 1;
      el.innerHTML = types.map(function (t) {
        var pct = Math.round(t[1] / maxCount * 100);
        var label = known.indexOf(t[0]) >= 0 ? typeLabel(t[0]) : t[0];
        return '<div class="vault-stat-row">' +
          '<span class="vault-stat-icon">' + typeIcon(t[0]) + '</span>' +
          '<span class="vault-stat-label">' + esc(label) + '</span>' +
          '<div class="vault-stat-bar"><div class="vault-stat-fill" style="width:' + pct + '%"></div></div>' +
          '<span class="vault-stat-count">' + t[1] + '</span>' +
          '</div>';
      }).join('');

      // Type chips (SVG icons)
      var typeChips = document.getElementById('vault-type-chips');
      var chipHtml = '<button class="chip active" data-type="">' + typeIcon('other', 14) + ' 전체</button>';
      known.forEach(function (k) {
        if (d.types[k]) chipHtml += '<button class="chip" data-type="' + k + '">' + typeIcon(k, 14) + ' ' + typeLabel(k) + ' ' + d.types[k] + '</button>';
      });
      typeChips.innerHTML = chipHtml;
      typeChips.querySelectorAll('.chip').forEach(function (chip) {
        chip.onclick = function () {
          typeChips.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
          chip.classList.add('active');
          _vaultFilterType = chip.getAttribute('data-type');
          _vaultOffset = 0;
          loadVaultList(false);
        };
      });

      // Tag grid (A+C: 2-row grid + expand, exclude type-duplicate tags)
      var tagChips = document.getElementById('vault-tag-chips');
      var typeDupes = ['voice', 'image', 'url', 'memo', 'todo', 'other', 'error'];
      var tags = Object.entries(d.tags || {})
        .filter(function (t) { return typeDupes.indexOf(t[0]) < 0; })
        .sort(function (a, b) { return b[1] - a[1]; });
      if (tags.length) {
        var visibleCount = 8;
        var tagHtml = '<button class="chip active" data-tag="">전체</button>';
        tags.forEach(function (t, i) {
          var hiddenClass = i >= visibleCount ? ' tag-hidden' : '';
          tagHtml += '<button class="chip' + hiddenClass + '" data-tag="' + esc(t[0]) + '">' + esc(t[0]) + ' <span class="chip-count">' + t[1] + '</span></button>';
        });
        if (tags.length > visibleCount) {
          tagHtml += '<button class="chip chip-more" id="vault-tag-more">+ ' + (tags.length - visibleCount) + '개</button>';
        }
        tagChips.innerHTML = tagHtml;
        // Expand button
        var moreBtn = document.getElementById('vault-tag-more');
        if (moreBtn) {
          moreBtn.onclick = function () {
            var isExpanded = moreBtn.getAttribute('data-expanded') === '1';
            if (isExpanded) {
              tagChips.querySelectorAll('.chip[data-tag]').forEach(function (el, i) { if (i >= visibleCount + 1) el.classList.add('tag-hidden'); });
              moreBtn.textContent = '+ ' + (tags.length - visibleCount) + '개';
              moreBtn.setAttribute('data-expanded', '0');
            } else {
              tagChips.querySelectorAll('.tag-hidden').forEach(function (el) { el.classList.remove('tag-hidden'); });
              moreBtn.textContent = '접기';
              moreBtn.setAttribute('data-expanded', '1');
            }
          };
        }
        tagChips.querySelectorAll('.chip:not(.chip-more)').forEach(function (chip) {
          chip.onclick = function () {
            var tag = chip.getAttribute('data-tag');
            if (!tag) {
              // "전체" chip — clear all
              _vaultFilterTags = [];
              tagChips.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
              chip.classList.add('active');
            } else {
              tagChips.querySelectorAll('.chip[data-type=""]').forEach(function (c) { c.classList.remove('active'); });
              var idx = _vaultFilterTags.indexOf(tag);
              if (idx >= 0) { _vaultFilterTags.splice(idx, 1); chip.classList.remove('active'); }
              else { _vaultFilterTags.push(tag); chip.classList.add('active'); }
              if (_vaultFilterTags.length === 0) {
                tagChips.querySelectorAll('.chip[data-type=""]').forEach(function (c) { c.classList.add('active'); });
              }
            }
            _vaultOffset = 0;
            loadVaultList(false);
          };
        });
      }
    })
    .catch(function () {});
}

function loadVaultList(append) {
  var listEl = document.getElementById('vault-list');
  var loadMore = document.getElementById('vault-load-more');
  var filterType = _vaultFilterType || '';

  if (!append) {
    listEl.innerHTML = '<div class="empty" style="padding:16px">로딩 중...</div>';
  }

  var params = new URLSearchParams({ offset: _vaultOffset, limit: 30 });
  if (filterType) params.append('type', filterType);
  _vaultFilterTags.forEach(function (t) { params.append('tag', t); });

  api('/vault/browse?' + params.toString())
    .then(function (r) { return r.json(); })
    .then(function (d) {
      window._browseResults = window._browseResults || [];
      if (!append) window._browseResults = [];

      var startIdx = window._browseResults.length;
      var newNotes = d.results.map(function (r) {
        return { filename: r.filename, body: r.preview || '', frontmatter: r.frontmatter || {} };
      });
      window._browseResults = window._browseResults.concat(newNotes);

      var html = d.results.map(function (r, i) {
        var idx = startIdx + i;
        return '<div class="vault-item" data-filename="' + esc(r.filename) + '" data-idx="' + idx + '">' +
          '<div class="vault-item-header">' +
            '<span class="card-icon">' + typeIcon(r.type) + '</span>' +
            '<span class="card-type-label">' + typeLabel(r.type) + '</span>' +
            '<span class="vault-item-title">\u300C' + esc(r.title || r.filename) + '\u300D</span>' +
            '<span class="card-time">' + esc(r.date || '') + '</span>' +
          '</div>' +
          (r.preview ? '<div class="vault-item-preview">' + linkifyUrls(esc(r.preview.length > 300 ? r.preview.substring(0, 300) + '...' : r.preview)) + '</div>' : '') +
          renderTagsHtml(r.frontmatter && Array.isArray(r.frontmatter.tags) ? r.frontmatter.tags.filter(function(t) { return t !== 'vaultvoice'; }) : []) +
          renderCardActions(esc(r.filename)) +
          '</div>';
      }).join('');

      if (append) {
        listEl.insertAdjacentHTML('beforeend', html);
      } else {
        listEl.innerHTML = d.results.length ? html : '<div class="empty" style="padding:20px">노트 없음</div>';
      }

      _vaultOffset += d.results.length;
      _vaultHasMore = d.hasMore;
      loadMore.style.display = d.hasMore ? '' : 'none';

      bindCardActionEvents(listEl);

      // Click handlers for new items
      listEl.querySelectorAll('.vault-item:not([data-bound])').forEach(function (item) {
        item.setAttribute('data-bound', '1');
        item.addEventListener('click', function (e) {
          if (e.target.closest('a') || e.target.closest('.card-action-btn') || e.target.closest('.card-comment-input') || e.target.closest('.card-tags') || e.target.closest('.card-tag-editor')) return;
          var fn = item.getAttribute('data-filename');
          var idx = parseInt(item.getAttribute('data-idx'));
          if (fn) openNoteDetail(fn, window._browseResults, idx);
        });
      });
    })
    .catch(function (e) {
      if (!append) listEl.innerHTML = '<div class="empty">오류: ' + esc(e.message) + '</div>';
    });
}
