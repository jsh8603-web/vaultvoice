// ============================================================
// VaultVoice v2.0 — Unified Client
// ============================================================

// ---- State ----
var API_KEY = localStorage.getItem('vv_apiKey') || '';
var memoDate = new Date();
var todayViewDate = new Date();
var curSection = localStorage.getItem('vv_sec') || '메모';
var myTags = [];
var allTags = [];
var pendingImages = []; // { file, objectUrl, serverId }
var pendingAudios = []; // { blob, objectUrl, serverId }
var audioRecorder = null;
var audioRecordingTimer = null;
var audioRecordingStart = 0;

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
  updateMemoDate();
  updateTodayDate();
  loadTags();
  initVoiceRecognition();
  initReminders();
  initJarvis();
}

// ============================================================
// Tabs
// ============================================================
function switchTab(name, btn) {
  var titles = { memo: '메모', today: '오늘', hist: '기록', set: '설정' };
  document.getElementById('hdr').textContent = titles[name] || '';
  var panels = document.querySelectorAll('.tab-panel');
  var tabs = document.querySelectorAll('.tab-item');
  for (var i = 0; i < panels.length; i++) panels[i].className = 'tab-panel';
  for (var i = 0; i < tabs.length; i++) tabs[i].className = 'tab-item';
  document.getElementById('p-' + name).className = 'tab-panel active';
  if (btn) btn.className = 'tab-item active';
  if (name === 'today') loadToday();
  if (name === 'hist') loadHistory();
  if (name === 'set') loadSettings();
}

// ============================================================
// Date helpers
// ============================================================
function updateMemoDate() { document.getElementById('memo-date').textContent = fmtDisplay(memoDate); }
function shiftMemoDate(n) { memoDate.setDate(memoDate.getDate() + n); updateMemoDate(); }
function resetMemoDate() { memoDate = new Date(); updateMemoDate(); }

function updateTodayDate() { document.getElementById('today-date').textContent = fmtDisplay(todayViewDate); }
function shiftTodayDate(n) { todayViewDate.setDate(todayViewDate.getDate() + n); updateTodayDate(); loadToday(); }
function resetTodayDate() { todayViewDate = new Date(); updateTodayDate(); loadToday(); }

// ============================================================
// Memo tab — Section chips
// ============================================================
function pickSec(el) {
  var chips = document.querySelectorAll('#sec-chips .chip');
  for (var i = 0; i < chips.length; i++) chips[i].className = 'chip';
  el.className = 'chip on';
  curSection = el.getAttribute('data-s');

  // Show/hide todo options
  var todoOpts = document.getElementById('todo-options');
  if (curSection === '오늘할일') {
    todoOpts.style.display = '';
  } else {
    todoOpts.style.display = 'none';
  }
}

function pickPriority(el) {
  var chips = document.querySelectorAll('#priority-chips .priority-chip');
  for (var i = 0; i < chips.length; i++) chips[i].className = 'chip priority-chip';
  el.className = 'chip priority-chip on';
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
  var el = document.getElementById('tags-display');
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
// Image Attachments (Phase 2)
// ============================================================
function handleImageSelect(files) {
  if (!files || !files.length) return;
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (!file.type.startsWith('image/')) continue;
    var objectUrl = URL.createObjectURL(file);
    pendingImages.push({ file: file, objectUrl: objectUrl, serverId: null });
  }
  renderImagePreviews();
}

function removeImage(idx) {
  if (pendingImages[idx]) {
    URL.revokeObjectURL(pendingImages[idx].objectUrl);
    pendingImages.splice(idx, 1);
    renderImagePreviews();
  }
}

// ============================================================
// Phase 1: Smart Scan (Image Analysis)
// ============================================================
function renderImagePreviews() {
  var el = document.getElementById('image-preview');
  el.innerHTML = pendingImages.map(function (img, idx) {
    return '<div class="image-thumb">' +
      '<img src="' + img.objectUrl + '" alt="">' +
      '<button class="image-thumb-remove" data-idx="' + idx + '">&times;</button>' +
      // AI Scan Button
      '<button class="image-scan-btn" data-idx="' + idx + '" title="AI 분석">🧠</button>' +
      '</div>';
  }).join('');
  
  el.querySelectorAll('.image-thumb-remove').forEach(function (btn) {
    btn.addEventListener('click', function () { removeImage(parseInt(btn.getAttribute('data-idx'))); });
  });

  // Bind Scan Buttons
  el.querySelectorAll('.image-scan-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      doScanImage(parseInt(btn.getAttribute('data-idx')));
    });
  });
}

function doScanImage(idx) {
  var img = pendingImages[idx];
  if (!img) return;

  var scanOverlay = document.getElementById('scan-overlay');
  var scanContent = document.getElementById('scan-content');
  var applyBtn = document.getElementById('scan-apply');
  var cancelBtn = document.getElementById('scan-cancel');

  scanOverlay.style.display = 'flex';
  scanContent.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text2)">이미지 업로드 및 분석 중...<br>잠시만 기다려주세요.</div>';
  applyBtn.disabled = true;

  // 1. Upload first if not uploaded
  var uploadChain = img.serverId ? Promise.resolve(img.serverId) : uploadImages().then(function(ids) { return img.serverId; });

  uploadChain.then(function(filename) {
    if(!filename) throw new Error("이미지 업로드 실패");
    
    // 2. Request Analysis
    return api('/ai/analyze-image', {
      method: 'POST',
      body: JSON.stringify({ filename: filename })
    });
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if(!d.success) throw new Error(d.error || "분석 실패");
    
    // 3. Render Result
    var res = d.result;
    var html = '<div style="margin-bottom:12px;color:var(--blue);font-weight:600">[' + esc(res.category) + ']</div>';
    html += '<div style="font-size:15px;line-height:1.6;margin-bottom:12px">' + esc(res.summary) + '</div>';
    
    // Data Table
    if(res.data && Object.keys(res.data).length > 0) {
      html += '<div style="background:var(--bg);padding:12px;border-radius:8px;font-size:13px;margin-bottom:12px">';
      for(var k in res.data) {
        html += '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
          '<span style="color:var(--text2)">' + esc(k) + '</span>' +
          '<span style="font-weight:500">' + esc(res.data[k]) + '</span></div>';
      }
      html += '</div>';
    }
    
    // Raw Text Toggle
    html += '<details style="font-size:12px;color:var(--text2)"><summary style="cursor:pointer;padding:4px 0">전체 텍스트 보기</summary><div style="white-space:pre-wrap;padding:8px;background:var(--bg);border-radius:4px">' + esc(res.text) + '</div></details>';

    scanContent.innerHTML = html;
    applyBtn.disabled = false;
    
    // Store result for apply
    scanOverlay._scanResult = res;
  })
  .catch(function(e) {
    scanContent.innerHTML = '<div style="color:var(--red);text-align:center;padding:20px">오류: ' + esc(e.message) + '</div>';
  });

  // Events
  cancelBtn.onclick = function() { scanOverlay.style.display = 'none'; };
  document.getElementById('scan-close').onclick = function() { scanOverlay.style.display = 'none'; };
  
  applyBtn.onclick = function() {
    var res = scanOverlay._scanResult;
    if(!res) return;
    
    var memoText = document.getElementById('memo-text');
    var append = '';
    
    // Format: [Category] Summary
    // - key: val
    
    append += `[${res.category}] ${res.summary}\n`;
    if(res.data) {
      for(var k in res.data) {
        append += `- ${k}: ${res.data[k]}\n`;
      }
    }
    
    if(memoText.value) append = '\n\n' + append;
    memoText.value += append;
    
    // Auto add tag based on category
    if(res.category) addTag(res.category.replace(/\s/g, ''));
    
    scanOverlay.style.display = 'none';
    
    // Scroll to bottom
    memoText.scrollTop = memoText.scrollHeight;
  };
}

// Add CSS for scan button
var style = document.createElement('style');
style.textContent = `
.image-scan-btn {
  position: absolute; bottom: 2px; right: 2px;
  width: 24px; height: 24px; border-radius: 50%;
  background: var(--blue); color: #fff; border: none;
  font-size: 14px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
  z-index: 5;
}
.image-thumb-remove {
  top: 2px; right: 2px; bottom: auto;
  background: rgba(0,0,0,0.6); width: 20px; height: 20px;
}
`;
document.head.appendChild(style);

// ============================================================
// Audio Recording
// ============================================================
function toggleAudioRecording() {
  if (audioRecorder && audioRecorder.state === 'recording') {
    stopAudioRecording();
  } else {
    startAudioRecording();
  }
}

function startAudioRecording() {
  var btn = document.getElementById('audio-rec-btn');
  var status = document.getElementById('audio-rec-status');

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(function (stream) {
      var mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/mp4';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
      }
      var options = mimeType ? { mimeType: mimeType } : {};
      audioRecorder = new MediaRecorder(stream, options);
      var chunks = [];

      audioRecorder.ondataavailable = function (e) {
        if (e.data.size > 0) chunks.push(e.data);
      };

      audioRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(chunks, { type: audioRecorder.mimeType || 'audio/webm' });
        var objectUrl = URL.createObjectURL(blob);
        pendingAudios.push({ blob: blob, objectUrl: objectUrl, serverId: null });
        renderAudioPreviews();
        btn.classList.remove('recording');
        btn.title = '녹음 시작';
        status.textContent = '';
        clearInterval(audioRecordingTimer);
      };

      audioRecorder.start();
      audioRecordingStart = Date.now();
      btn.classList.add('recording');
      btn.title = '녹음 중지';
      status.textContent = '0:00';

      audioRecordingTimer = setInterval(function () {
        var elapsed = Math.floor((Date.now() - audioRecordingStart) / 1000);
        var m = Math.floor(elapsed / 60);
        var s = elapsed % 60;
        status.textContent = m + ':' + (s < 10 ? '0' : '') + s;
      }, 500);
    })
    .catch(function (e) {
      showToast('마이크 접근 실패: ' + e.message, 'error');
    });
}

function stopAudioRecording() {
  if (audioRecorder && audioRecorder.state === 'recording') {
    audioRecorder.stop();
  }
}

function removeAudio(idx) {
  if (pendingAudios[idx]) {
    URL.revokeObjectURL(pendingAudios[idx].objectUrl);
    pendingAudios.splice(idx, 1);
    renderAudioPreviews();
  }
}

function renderAudioPreviews() {
  var el = document.getElementById('audio-preview');
  el.innerHTML = pendingAudios.map(function (aud, idx) {
    return '<div class="audio-preview-item">' +
      '<audio controls src="' + aud.objectUrl + '"></audio>' +
      '<button class="audio-remove" data-idx="' + idx + '">&times;</button>' +
      '</div>';
  }).join('');
  el.querySelectorAll('.audio-remove').forEach(function (btn) {
    btn.addEventListener('click', function () { removeAudio(parseInt(btn.getAttribute('data-idx'))); });
  });
}

function uploadAudios() {
  var uploaded = [];
  var chain = Promise.resolve();

  pendingAudios.forEach(function (aud) {
    chain = chain.then(function () {
      if (aud.serverId) {
        uploaded.push(aud.serverId);
        return;
      }
      var ext = '.webm';
      if (aud.blob.type && aud.blob.type.includes('mp4')) ext = '.mp4';
      var fd = new FormData();
      fd.append('audio', aud.blob, 'recording' + ext);
      return apiUpload('/upload', fd).then(function (res) {
        if (res.ok) {
          return res.json().then(function (data) {
            aud.serverId = data.filename;
            uploaded.push(data.filename);
          });
        } else {
          console.error('Audio upload error:', res.status);
        }
      }).catch(function (e) {
        console.error('Audio upload failed:', e);
      });
    });
  });

  return chain.then(function () { return uploaded; });
}

// ============================================================
// Phase 2: Jarvis (Voice Assistant) — Refactored
// ============================================================

// ---- Jarvis State ----
var jarvisChatHistory = []; // { role: 'user'|'model', text: string }
var jarvisIsSending = false;
var jarvisTTSActive = false;
var jarvisRecog = null;

// ---- Jarvis History Persistence (localStorage) ----
var JARVIS_STORAGE_KEY = 'vv_jarvis_history';
var JARVIS_STORAGE_MAX = 200 * 1024; // 200KB

function saveJarvisHistory() {
  try {
    var json = JSON.stringify(jarvisChatHistory);
    if (json.length > JARVIS_STORAGE_MAX) {
      // Trim oldest entries until under limit
      var trimmed = jarvisChatHistory.slice(-40);
      json = JSON.stringify(trimmed);
    }
    localStorage.setItem(JARVIS_STORAGE_KEY, json);
  } catch (e) { /* storage full — ignore */ }
}

function loadJarvisHistory() {
  try {
    var raw = localStorage.getItem(JARVIS_STORAGE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { /* corrupt — ignore */ }
  return [];
}

function clearJarvisHistory() {
  localStorage.removeItem(JARVIS_STORAGE_KEY);
}

function exportJarvisHistory() {
  if (!jarvisChatHistory.length) return;
  var lines = jarvisChatHistory.map(function (item) {
    var label = item.role === 'user' ? '나' : 'Jarvis';
    return '[' + label + '] ' + item.text;
  });
  var text = 'Jarvis 대화 내보내기 (' + new Date().toLocaleString('ko-KR') + ')\n' +
    '='.repeat(40) + '\n\n' + lines.join('\n\n');
  var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'jarvis-chat-' + new Date().toISOString().slice(0, 10) + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

// Jarvis Floating Button (created dynamically)
var jarvisBtn = document.createElement('button');
jarvisBtn.id = 'jarvis-btn';
jarvisBtn.className = 'jarvis-fab';
jarvisBtn.innerHTML = '🤖';
jarvisBtn.onclick = openJarvis;
document.body.appendChild(jarvisBtn);

// Jarvis DOM refs (deferred until DOMContentLoaded via init)
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

  // Close
  document.getElementById('jarvis-close').onclick = closeJarvis;

  // Send button
  jarvisSend.onclick = function () { sendJarvis(jarvisInput.value.trim()); };

  // Enter key
  jarvisInput.onkeydown = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendJarvis(jarvisInput.value.trim());
    }
  };

  // Reset conversation
  jarvisReset.onclick = function () {
    jarvisChatHistory = [];
    clearJarvisHistory();
    jarvisChat.innerHTML = '';
    addJarvisWelcome();
    setJarvisStatus('');
  };

  // Export button
  var jarvisExport = document.getElementById('jarvis-export');
  if (jarvisExport) {
    jarvisExport.onclick = exportJarvisHistory;
  }

  // Restore saved history
  var saved = loadJarvisHistory();
  if (saved.length > 0) {
    jarvisChatHistory = saved;
    // Remove welcome and re-render bubbles
    jarvisChat.innerHTML = '';
    for (var i = 0; i < saved.length; i++) {
      var item = saved[i];
      var type = item.role === 'user' ? 'user' : 'bot';
      addJarvisBubble(item.text, type);
    }
  }

  // Mic
  jarvisMic.onclick = toggleJarvisMic;

  // Hint buttons
  jarvisChat.addEventListener('click', function (e) {
    var hint = e.target.closest('.jarvis-hint');
    if (hint) {
      var msg = hint.getAttribute('data-msg');
      if (msg) sendJarvis(msg);
    }
    // Click on bot bubble to stop TTS
    var bubble = e.target.closest('.jarvis-bubble-bot');
    if (bubble && jarvisTTSActive) {
      stopTTS();
    }
  });
}

function openJarvis() {
  if (!jarvisOverlay) return;
  jarvisOverlay.style.display = 'flex';
  jarvisInput.focus();
}

function closeJarvis() {
  if (!jarvisOverlay) return;
  jarvisOverlay.style.display = 'none';
  stopTTS();
}

// ---- Chat History Management ----
function addToJarvisHistory(role, text) {
  jarvisChatHistory.push({ role: role, text: text });
  // Keep max 30 turns (60 items)
  if (jarvisChatHistory.length > 60) {
    jarvisChatHistory = jarvisChatHistory.slice(-60);
  }
  saveJarvisHistory();
}

// ---- Sending Messages ----
function sendJarvis(text) {
  if (!text || jarvisIsSending) return;
  jarvisIsSending = true;
  stopTTS();

  // Remove welcome if present
  var welcome = jarvisChat.querySelector('.jarvis-welcome');
  if (welcome) welcome.remove();

  // Add user bubble
  addJarvisBubble(text, 'user');
  addToJarvisHistory('user', text);
  jarvisInput.value = '';

  // Show typing indicator
  var typingEl = addJarvisTyping();
  setJarvisStatus('응답 대기 중...');

  api('/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ message: text, history: jarvisChatHistory.slice(0, -1) })
  })
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
    addJarvisBubble('오류가 발생했습니다: ' + e.message, 'error');
    setJarvisStatus('');
  })
  .then(function () {
    jarvisIsSending = false;
  });
}

// ---- Bubble Rendering ----
function addJarvisBubble(text, type) {
  var div = document.createElement('div');
  div.className = 'jarvis-bubble jarvis-bubble-' + type;

  if (type === 'bot') {
    div.innerHTML = renderJarvisMd(text);
    div.title = 'TTS 중단하려면 클릭';
  } else if (type === 'error') {
    div.className = 'jarvis-bubble jarvis-bubble-error';
    div.textContent = text;
  } else {
    div.textContent = text;
  }

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
  div.innerHTML = '<div class="jarvis-welcome-icon">🤖</div>' +
    '<div class="jarvis-welcome-text">안녕하세요! Jarvis입니다.<br>무엇을 도와드릴까요?</div>' +
    '<div class="jarvis-welcome-hints">' +
    '<button class="jarvis-hint" data-msg="오늘 메모 보여줘">📋 오늘 메모 보기</button>' +
    '<button class="jarvis-hint" data-msg="할일 추가: 보고서 작성">✅ 할일 추가</button>' +
    '<button class="jarvis-hint" data-msg="이번 주 일정 알려줘">📅 이번 주 일정</button>' +
    '</div>';
  jarvisChat.appendChild(div);
}

// ---- Simple markdown for bot replies ----
function renderJarvisMd(text) {
  if (!text) return '';
  var h = esc(text);
  // Bold
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline code
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Unordered list
  h = h.replace(/^[-•] (.+)$/gm, '<li>$1</li>');
  // Ordered list
  h = h.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  // Line breaks
  h = h.replace(/\n/g, '<br>');
  return h;
}

// ---- Status ----
function setJarvisStatus(msg) {
  if (jarvisStatus) jarvisStatus.textContent = msg;
}

// ---- TTS ----
function speak(text) {
  if (!text || !window.speechSynthesis) return;
  stopTTS();

  // Split long text into sentences for better TTS
  var sentences = text.match(/[^.!?。！？\n]+[.!?。！？]?/g) || [text];
  jarvisTTSActive = true;
  setJarvisStatus('🔊 TTS 재생 중 (클릭으로 중단)');

  // Disable mic during TTS
  if (jarvisMic) jarvisMic.disabled = true;

  var idx = 0;
  function speakNext() {
    if (idx >= sentences.length || !jarvisTTSActive) {
      jarvisTTSActive = false;
      setJarvisStatus('');
      if (jarvisMic) jarvisMic.disabled = false;
      return;
    }
    var sentence = sentences[idx].trim();
    idx++;
    if (!sentence) { speakNext(); return; }

    var u = new SpeechSynthesisUtterance(sentence);
    u.lang = 'ko-KR';
    u.onend = speakNext;
    u.onerror = function () {
      jarvisTTSActive = false;
      setJarvisStatus('');
      if (jarvisMic) jarvisMic.disabled = false;
    };
    window.speechSynthesis.speak(u);
  }
  speakNext();
}

function stopTTS() {
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  jarvisTTSActive = false;
  setJarvisStatus('');
  if (jarvisMic) jarvisMic.disabled = false;
}

// ---- Mic ----
function toggleJarvisMic() {
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    addJarvisBubble('이 브라우저에서는 음성 인식이 지원되지 않습니다.', 'error');
    return;
  }

  // Stop if already recording
  if (jarvisRecog) {
    jarvisRecog.stop();
    jarvisRecog = null;
    jarvisMic.classList.remove('recording');
    setJarvisStatus('');
    return;
  }

  stopTTS();
  jarvisRecog = new SpeechRecognition();
  jarvisRecog.lang = 'ko-KR';
  jarvisRecog.continuous = true;
  jarvisRecog.interimResults = true;

  jarvisRecog.start();
  jarvisMic.classList.add('recording');
  setJarvisStatus('🎤 듣는 중...');

  var finalTranscript = '';

  jarvisRecog.onresult = function (e) {
    var interim = '';
    for (var i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    jarvisInput.value = finalTranscript + interim;
    if (interim) {
      setJarvisStatus('🎤 ' + interim);
    }
  };

  jarvisRecog.onend = function () {
    jarvisRecog = null;
    jarvisMic.classList.remove('recording');
    setJarvisStatus('');

    // Auto-send if we got text
    var text = (finalTranscript || jarvisInput.value).trim();
    if (text) {
      sendJarvis(text);
    }
  };

  jarvisRecog.onerror = function (e) {
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      setJarvisStatus('음성 인식 오류: ' + e.error);
      setTimeout(function () { setJarvisStatus(''); }, 3000);
    }
    jarvisRecog = null;
    jarvisMic.classList.remove('recording');
  };
}


function uploadImages() {
  var uploaded = [];
  var chain = Promise.resolve();

  pendingImages.forEach(function (img) {
    chain = chain.then(function () {
      if (img.serverId) {
        uploaded.push(img.serverId);
        return;
      }
      var fd = new FormData();
      fd.append('image', img.file, img.file.name || 'photo.jpg');
      return apiUpload('/upload', fd).then(function (res) {
        if (res.ok) {
          return res.json().then(function (data) {
            img.serverId = data.filename;
            uploaded.push(data.filename);
          });
        } else {
          console.error('Upload error:', res.status);
        }
      }).catch(function (e) {
        console.error('Upload failed:', e);
      });
    });
  });

  return chain.then(function () { return uploaded; });
}

// ============================================================
// Save
// ============================================================
function doSave() {
  var text = document.getElementById('memo-text').value.trim();
  var fb = document.getElementById('save-fb');
  if (!text && pendingImages.length === 0 && pendingAudios.length === 0) { document.getElementById('memo-text').focus(); return; }
  if (!text) text = pendingAudios.length > 0 ? '(음성 녹음)' : '(이미지)';

  var saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;

  // 태그가 없고 텍스트가 충분하면 자동 태그 생성 후 저장
  if (myTags.length === 0 && text.length >= 15 && text !== '(이미지)') {
    saveBtn.textContent = '태그 생성 중...';
    api('/ai/summarize', {
      method: 'POST',
      body: JSON.stringify({ action: 'auto-tags', content: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.success && d.result) {
          var tags = d.result;
          if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch (e) { tags = []; } }
          if (Array.isArray(tags)) {
            tags.slice(0, 2).forEach(function (t) {
              t = t.trim().replace(/^#/, '');
              if (t) addTag(t);
            });
          }
        }
      })
      .catch(function () {})
      .then(function () { proceedSave(text, saveBtn, fb); });
    return;
  }

  proceedSave(text, saveBtn, fb);
}

function proceedSave(text, saveBtn, fb) {
  saveBtn.textContent = '저장 중...';

  // Step 1: upload images if any
  var uploadPromise;
  if (pendingImages.length > 0) {
    saveBtn.textContent = '이미지 업로드 중...';
    uploadPromise = uploadImages().catch(function (e) {
      console.error('Image upload error:', e);
      return [];
    });
  } else {
    uploadPromise = Promise.resolve([]);
  }

  // Step 2: upload audios if any
  var audioUploadPromise;
  if (pendingAudios.length > 0) {
    audioUploadPromise = uploadAudios().catch(function (e) {
      console.error('Audio upload error:', e);
      return [];
    });
  } else {
    audioUploadPromise = Promise.resolve([]);
  }

  Promise.all([uploadPromise, audioUploadPromise]).then(function (results) {
    var imageFiles = results[0];
    var audioFiles = results[1];
    saveBtn.textContent = '저장 중...';

    var body = {
      content: text,
      tags: myTags,
      section: curSection,
      images: imageFiles,
      audios: audioFiles
    };

    if (curSection === '오늘할일') {
      var activeP = document.querySelector('#priority-chips .priority-chip.on');
      body.priority = activeP ? activeP.getAttribute('data-p') : '보통';
      body.due = document.getElementById('todo-due').value;
    }

    return api('/daily/' + fmt(memoDate), {
      method: 'POST',
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.ok) {
        var msg = '저장 완료!';
        if (pendingImages.length > 0 && imageFiles.length === 0) msg += ' (이미지 업로드 실패)';
        else if (imageFiles.length > 0) msg += ' (이미지 ' + imageFiles.length + '개 포함)';
        if (audioFiles.length > 0) msg += ' (음성 ' + audioFiles.length + '개 포함)';
        fb.textContent = msg;
        fb.className = 'feedback ok';
        fb.style.display = '';
        document.getElementById('memo-text').value = '';
        myTags = []; renderTags(); lastAutoTagText = '';
        pendingImages.forEach(function (img) { URL.revokeObjectURL(img.objectUrl); });
        pendingImages = [];
        renderImagePreviews();
        pendingAudios.forEach(function (aud) { URL.revokeObjectURL(aud.objectUrl); });
        pendingAudios = [];
        renderAudioPreviews();
        document.getElementById('todo-due').value = '';
        if (navigator.vibrate) navigator.vibrate(50);
      } else {
        return res.json().then(function (d) {
          fb.textContent = '실패: ' + (d.error || res.status);
          fb.className = 'feedback fail';
          fb.style.display = '';
        });
      }
    });
  }).catch(function (e) {
    fb.textContent = '실패: ' + e.message;
    fb.className = 'feedback fail';
    fb.style.display = '';
  }).then(function () {
    saveBtn.disabled = false;
    saveBtn.textContent = '저장';
    setTimeout(function () { fb.style.display = 'none'; }, 5000);
  });
}

// ============================================================
// Today tab
// ============================================================
function loadToday() {
  var el = document.getElementById('today-body');
  var todoSection = document.getElementById('todo-list-section');
  api('/daily/' + fmt(todayViewDate))
    .then(function (r) {
      if (r.status === 404) {
        el.innerHTML = '<div class="empty">이 날 일일노트가 없습니다</div>';
        todoSection.style.display = 'none';
        return;
      }
      return r.json().then(function (d) {
        el.innerHTML = renderMd(d.body);
      });
    })
    .catch(function (e) { el.innerHTML = '<div class="empty">오류: ' + e.message + '</div>'; });

  // Load todos
  loadTodos();
}

function loadTodos() {
  var todoSection = document.getElementById('todo-list-section');
  var todoList = document.getElementById('todo-list');

  api('/daily/' + fmt(todayViewDate) + '/todos')
    .then(function (r) {
      if (!r.ok) { todoSection.style.display = 'none'; return; }
      return r.json();
    })
    .then(function (d) {
      if (!d || !d.todos || d.todos.length === 0) {
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

        var hasReminder = hasReminderForTodo(fmt(todayViewDate), todo.lineIndex);
        var bellClass = hasReminder ? ' has-reminder' : '';

        return '<div class="todo-item' + pClass + doneClass + '">' +
          '<button class="todo-check' + checkClass + '" data-line="' + todo.lineIndex + '" data-date="' + fmt(todayViewDate) + '">' + (todo.done ? '✓' : '') + '</button>' +
          '<span class="todo-text">' + esc(todo.text) + '</span>' +
          (meta.length ? '<span class="todo-meta">' + esc(meta.join(' · ')) + '</span>' : '') +
          '<button class="todo-bell' + bellClass + '" data-line="' + todo.lineIndex + '" data-text="' + esc(todo.text) + '" title="알림 설정">🔔</button>' +
          '</div>';
      }).join('');

      // Bind toggle handlers
      todoList.querySelectorAll('.todo-check').forEach(function (btn) {
        btn.addEventListener('click', function () {
          toggleTodo(btn.getAttribute('data-date'), parseInt(btn.getAttribute('data-line')));
        });
      });

      // Bind bell handlers
      todoList.querySelectorAll('.todo-bell').forEach(function (btn) {
        btn.addEventListener('click', function () {
          openReminderDialog(
            btn.getAttribute('data-text'),
            fmt(todayViewDate),
            parseInt(btn.closest('.todo-item').querySelector('.todo-check').getAttribute('data-line'))
          );
        });
      });
    })
    .catch(function () { todoSection.style.display = 'none'; });
}

function toggleTodo(date, lineIndex) {
  api('/todo/toggle', {
    method: 'POST',
    body: JSON.stringify({ date: date, lineIndex: lineIndex })
  }).then(function (r) {
    if (r.ok) loadToday();
  }).catch(function () { });
}

// ============================================================
// History tab
// ============================================================
function loadHistory() {
  var el = document.getElementById('hist-list');
  api('/notes/recent')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.notes || !d.notes.length) { el.innerHTML = '<div class="empty">최근 기록 없음</div>'; return; }
      el.innerHTML = d.notes.map(function (n) {
        return '<div class="hist-item" data-date="' + n.date + '"><div class="hist-date">' + n.date + '</div><div class="hist-preview">' + esc(n.preview) + '</div></div>';
      }).join('');
      el.querySelectorAll('.hist-item').forEach(function (item) {
        item.addEventListener('click', function () { openPreview(item.getAttribute('data-date')); });
      });
    })
    .catch(function () { el.innerHTML = '<div class="empty">로딩 실패</div>'; });
}

function filterHist() {
  // Now handled by doSearch()
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

  // Render reminders
  renderReminderList();

  // QR code
  loadQRCode();
  
  // Phase 4: Calendar Status
  checkCalendarStatus();
}

var _calWasConnected = false;

function checkCalendarStatus(silent) {
  api('/calendar/status')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var st = document.getElementById('cal-status');
      var btn = document.getElementById('cal-connect-btn');
      var msg = document.getElementById('cal-msg');

      if(d.connected) {
        st.textContent = '연결됨';
        st.className = 'badge ok';
        st.style.background = 'var(--green)';
        st.style.color = '#fff';
        btn.textContent = '재연결';
        msg.style.display = 'none';
        _calWasConnected = true;
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
        // Show toast if token was previously connected but now expired/revoked
        if (_calWasConnected && !silent) {
          showToast('캘린더 연결이 만료되었습니다. 재연결이 필요합니다.', 'warn');
        }
        if (d.reason === 'token_expired' || d.reason === 'token_invalid') {
          msg.textContent = '토큰이 만료/무효화되었습니다. 재연결해주세요.';
          msg.style.display = '';
        } else {
          msg.style.display = 'none';
        }
        _calWasConnected = false;
      }
    })
    .catch(function() {});
}

document.getElementById('cal-connect-btn').addEventListener('click', function() {
  window.open('/api/auth/google', '_blank', 'width=500,height=600');
});

// Auto-check calendar status every 10 minutes
setInterval(function () { checkCalendarStatus(); }, 10 * 60 * 1000);

// ============================================================
// Markdown renderer
// ============================================================
function renderMd(md) {
  if (!md) return '';
  var h = esc(md);
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Checkboxes
  h = h.replace(/- \[x\] (.+)/g, '<li style="list-style:none"><input type="checkbox" checked disabled> <s>$1</s></li>');
  h = h.replace(/- \[ \] (.+)/g, '<li style="list-style:none"><input type="checkbox" disabled> $1</li>');
  // Regular list items
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
  // Audio embeds: ![[file.webm]] or .mp3, .wav, .m4a, .ogg, .mp4
  h = h.replace(/!\[\[([^\]]+\.(webm|mp3|wav|m4a|ogg|mp4))\]\]/gi, function (match, p) {
    var fname = p.split('/').pop();
    return '<audio controls style="width:100%;margin:4px 0"><source src="/api/attachments/' + encodeURIComponent(fname) + '"></audio>';
  });
  // Image embeds
  h = h.replace(/!\[\[([^\]]+)\]\]/g, function (match, p) {
    var fname = p.split('/').pop();
    return '<img src="/api/attachments/' + encodeURIComponent(fname) + '" style="max-width:100%;border-radius:8px;margin:4px 0" alt="' + esc(fname) + '">';
  });
  h = h.replace(/\n\n+/g, '<br><br>');
  return h;
}

// ============================================================
// Phase 1: Voice Recognition (Enhanced v2)
// ============================================================

// 한국어 음성 인식 후처리 교정 사전
var voiceCorrectionDict = {
  // Obsidian/VaultVoice 관련
  '옵시 디언': '옵시디안',
  '옵시 티언': '옵시디안',
  '옵시디 안': '옵시디안',
  '압시디안': '옵시디안',
  '옵시디앙': '옵시디안',
  '볼트 보이스': '볼트보이스',
  '볼트 voice': '볼트보이스',
  '폴트 보이스': '볼트보이스',
  '보르트': '볼트',
  
  // 일반적인 오인식
  '하루 일과': '하루일과',
  '투 두': '투두',
  '투두 리스트': '투두리스트',
  '체크 리스트': '체크리스트',
  '메모리': '메모',  // "메모해" → "메모리해" 오인식
  
  // 숫자/시간 관련
  '열 시': '10시',
  '열한 시': '11시',
  '열두 시': '12시',
  '한 시': '1시',
  '두 시': '2시',
  '세 시': '3시',
  '네 시': '4시',
  '다섯 시': '5시',
  '여섯 시': '6시',
  '일곱 시': '7시',
  '여덟 시': '8시',
  '아홉 시': '9시',
  
  // 약어/영어 발음
  'ㅇㅋ': 'OK',
  '오케이': 'OK',
  '에이 아이': 'AI',
  '피 티 에이': 'PWA',
  
  // 문장 부호 관련
  '마침표': '.',
  '쉼표': ',',
  '물음표': '?',
  '느낌표': '!',
  '줄 바꿈': '\n',
  '엔터': '\n',
  '새 줄': '\n'
};

// 설정 (localStorage에서 불러오기)
var voiceSettings = {
  restartDelay: parseInt(localStorage.getItem('vv_voice_restartDelay')) || 300,
  noSpeechDelay: parseInt(localStorage.getItem('vv_voice_noSpeechDelay')) || 1000,
  minConfidence: parseFloat(localStorage.getItem('vv_voice_minConfidence')) || 0.3,
  enableCorrection: localStorage.getItem('vv_voice_enableCorrection') !== 'false'
};

// 후처리 교정 함수
function correctVoiceText(text) {
  if (!voiceSettings.enableCorrection) return text;
  
  var corrected = text;
  for (var wrong in voiceCorrectionDict) {
    if (voiceCorrectionDict.hasOwnProperty(wrong)) {
      var regex = new RegExp(wrong, 'gi');
      corrected = corrected.replace(regex, voiceCorrectionDict[wrong]);
    }
  }
  return corrected;
}

// 사용자 정의 교정 규칙 추가
function addCorrectionRule(wrong, correct) {
  voiceCorrectionDict[wrong] = correct;
  // localStorage에 저장
  var custom = JSON.parse(localStorage.getItem('vv_voice_customDict') || '{}');
  custom[wrong] = correct;
  localStorage.setItem('vv_voice_customDict', JSON.stringify(custom));
}

// 사용자 정의 규칙 로드
(function loadCustomDict() {
  try {
    var custom = JSON.parse(localStorage.getItem('vv_voice_customDict') || '{}');
    for (var k in custom) {
      if (custom.hasOwnProperty(k)) {
        voiceCorrectionDict[k] = custom[k];
      }
    }
  } catch (e) {}
})();

function initVoiceRecognition() {
  var micBtn = document.getElementById('mic-btn');
  var textarea = document.getElementById('memo-text');
  
  // Check if Web Speech API is available (Chrome, not iOS Safari)
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    // iOS Safari or unsupported browser — hide mic button
    micBtn.style.display = 'none';
    return;
  }

  micBtn.style.display = 'flex';
  var recognition = new SpeechRecognition();
  recognition.lang = 'ko-KR';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  
  var isRecording = false;
  var baseText = '';
  var accumulatedFinal = '';
  var shouldRestart = false;
  var recordingStartTime = 0;
  
  // 개선된 상태 표시 UI
  var statusEl = document.getElementById('voice-status');
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.id = 'voice-status';
    document.body.appendChild(statusEl);
  }
  
  // 스타일 동적 추가
  if (!document.getElementById('voice-status-style')) {
    var style = document.createElement('style');
    style.id = 'voice-status-style';
    style.textContent = `
      #voice-status {
        position: fixed;
        top: 70px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 20px;
        border-radius: 25px;
        font-size: 14px;
        font-weight: 500;
        z-index: 9999;
        display: none;
        max-width: 85%;
        text-align: center;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        backdrop-filter: blur(10px);
        transition: all 0.3s ease;
        animation: voiceStatusSlide 0.3s ease;
      }
      @keyframes voiceStatusSlide {
        from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      #voice-status.listening {
        background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%);
        color: white;
      }
      #voice-status.listening::before {
        content: '';
        position: absolute;
        top: -3px; left: -3px; right: -3px; bottom: -3px;
        border-radius: 28px;
        background: linear-gradient(135deg, #2196F3, #64B5F6, #2196F3);
        z-index: -1;
        animation: voicePulse 1.5s ease-in-out infinite;
      }
      @keyframes voicePulse {
        0%, 100% { opacity: 0.5; transform: scale(1); }
        50% { opacity: 0.8; transform: scale(1.02); }
      }
      #voice-status.success {
        background: linear-gradient(135deg, #4CAF50 0%, #388E3C 100%);
        color: white;
      }
      #voice-status.error {
        background: linear-gradient(135deg, #f44336 0%, #d32f2f 100%);
        color: white;
      }
      #voice-status.warning {
        background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%);
        color: white;
      }
      #voice-status .duration {
        font-size: 11px;
        opacity: 0.8;
        margin-left: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  function showStatus(msg, type, showDuration) {
    statusEl.textContent = msg;
    statusEl.className = type || 'listening';
    statusEl.style.display = '';
    
    if (showDuration && recordingStartTime) {
      var elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      var durSpan = document.createElement('span');
      durSpan.className = 'duration';
      durSpan.textContent = elapsed + '초';
      statusEl.appendChild(durSpan);
    }
  }
  
  function hideStatus() {
    statusEl.style.display = 'none';
  }

  micBtn.addEventListener('click', function () {
    if (isRecording) {
      shouldRestart = false;
      recognition.stop();
      return;
    }
    baseText = textarea.value;
    accumulatedFinal = '';
    shouldRestart = true;
    recordingStartTime = Date.now();
    try {
      recognition.start();
    } catch (e) {}
  });

  recognition.onstart = function () {
    isRecording = true;
    micBtn.classList.add('recording');
    showStatus('🎤 듣는 중...', 'listening', true);
  };

  recognition.onresult = function (e) {
    var interimTranscript = '';
    var newFinal = '';
    
    for (var i = e.resultIndex; i < e.results.length; i++) {
      var transcript = e.results[i][0].transcript;
      var confidence = e.results[i][0].confidence;
      
      if (e.results[i].isFinal) {
        if (confidence < voiceSettings.minConfidence) {
          console.log('Low confidence ignored:', transcript, confidence);
          continue;
        }
        // 후처리 교정 적용
        newFinal += correctVoiceText(transcript);
      } else {
        interimTranscript += transcript;
      }
    }
    
    if (newFinal) {
      accumulatedFinal += newFinal;
    }
    
    var separator = (baseText && !baseText.endsWith('\n') && !baseText.endsWith(' ')) ? ' ' : '';
    var displayText = baseText + separator + accumulatedFinal;
    
    if (interimTranscript) {
      textarea.value = displayText + interimTranscript;
      showStatus('🎤 ' + interimTranscript, 'listening', true);
    } else if (accumulatedFinal) {
      textarea.value = displayText;
      showStatus('✓ ' + accumulatedFinal.slice(-40), 'success', true);
    }
    
    textarea.scrollTop = textarea.scrollHeight;
  };

  recognition.onend = function () {
    isRecording = false;
    micBtn.classList.remove('recording');
    
    if (accumulatedFinal) {
      var separator = (baseText && !baseText.endsWith('\n') && !baseText.endsWith(' ')) ? ' ' : '';
      textarea.value = baseText + separator + accumulatedFinal;
    }
    
    if (shouldRestart && accumulatedFinal) {
      setTimeout(function () {
        if (shouldRestart) {
          baseText = textarea.value;
          accumulatedFinal = '';
          try {
            recognition.start();
          } catch (e) {
            console.log('Cannot restart:', e);
            shouldRestart = false;
            hideStatus();
          }
        }
      }, voiceSettings.restartDelay);
    } else {
      setTimeout(hideStatus, 1500);
    }
  };

  recognition.onerror = function (e) {
    console.error('Speech error:', e.error);
    
    if (e.error === 'no-speech') {
      showStatus('🔇 말씀해 주세요...', 'warning');
      if (shouldRestart) {
        setTimeout(function () {
          if (shouldRestart) {
            try { recognition.start(); } catch (err) {
              isRecording = false;
              micBtn.classList.remove('recording');
              shouldRestart = false;
              hideStatus();
            }
          }
        }, voiceSettings.noSpeechDelay);
      }
      return;
    }
    
    if (e.error === 'aborted') {
      isRecording = false;
      micBtn.classList.remove('recording');
      shouldRestart = false;
      hideStatus();
      return;
    }
    
    var errorMsg = {
      'network': '⚠️ 네트워크 오류',
      'not-allowed': '⚠️ 마이크 권한 필요',
      'audio-capture': '⚠️ 마이크 사용 불가'
    }[e.error] || ('⚠️ 오류: ' + e.error);
    
    showStatus(errorMsg, 'error');
    isRecording = false;
    micBtn.classList.remove('recording');
    shouldRestart = false;
    setTimeout(hideStatus, 3000);
  };
  
  console.log('Voice Recognition v2 initialized with settings:', voiceSettings);
}

// ============================================================
// Phase 4: AI Summarization
// ============================================================
function doAI(action) {
  var resultEl = document.getElementById('ai-result');
  var buttons = document.querySelectorAll('.ai-btn');
  buttons.forEach(function (b) { b.disabled = true; });
  resultEl.style.display = '';
  resultEl.innerHTML = '<div style="text-align:center;color:var(--text2)">AI 처리 중...</div>';

  // Get today's note content
  api('/daily/' + fmt(todayViewDate))
    .then(function (r) {
      if (!r.ok) throw new Error('노트를 찾을 수 없습니다');
      return r.json();
    })
    .then(function (d) {
      return api('/ai/summarize', {
        method: 'POST',
        body: JSON.stringify({ action: action, content: d.body, date: fmt(todayViewDate) })
      });
    })
    .then(function (r) {
      if (!r.ok) throw new Error('AI 요청 실패');
      return r.json();
    })
    .then(function (d) {
      if (action === 'suggest-tags') {
        var tags = d.result;
        if (typeof tags === 'string') {
          try { tags = JSON.parse(tags); } catch (e) { tags = [tags]; }
        }
        if (!Array.isArray(tags)) tags = [tags];
        resultEl.innerHTML = '<h3>추천 태그</h3>' +
          tags.map(function (t) {
            return '<span class="ai-tag-chip" data-tag="' + esc(t) + '">' + esc(t) + '</span>';
          }).join('');
        // Click to add tag
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
// Phase 5: Reminders
// ============================================================
var reminderCheckInterval = null;

function getReminders() {
  try { return JSON.parse(localStorage.getItem('vv_reminders') || '[]'); } catch (e) { return []; }
}
function saveReminders(list) { localStorage.setItem('vv_reminders', JSON.stringify(list)); }

function hasReminderForTodo(date, lineIndex) {
  var reminders = getReminders();
  return reminders.some(function (r) { return r.date === date && r.lineIndex === lineIndex && !r.fired; });
}

function openReminderDialog(text, date, lineIndex) {
  var dialog = document.getElementById('reminder-dialog');
  var dialogText = document.getElementById('reminder-dialog-text');
  var datetimeInput = document.getElementById('reminder-datetime');

  dialogText.textContent = text;
  // Default: 1 hour from now
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
  var datetimeInput = document.getElementById('reminder-datetime');
  var dt = datetimeInput.value;
  if (!dt) return;

  var reminders = getReminders();
  // Remove existing reminder for this todo
  reminders = reminders.filter(function (r) {
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
  // Refresh todo list to show bell state
  loadTodos();
}

function checkReminders() {
  var reminders = getReminders();
  var now = Date.now();
  var changed = false;

  reminders.forEach(function (r) {
    if (!r.fired && r.remindAt <= now) {
      r.fired = true;
      changed = true;
      showReminderBanner(r.text);
    }
  });

  // Clean up: remove reminders fired more than 24h ago
  var dayAgo = now - 86400000;
  var cleaned = reminders.filter(function (r) {
    return !(r.fired && r.remindAt < dayAgo);
  });
  if (cleaned.length !== reminders.length) changed = true;

  if (changed) saveReminders(cleaned.length !== reminders.length ? cleaned : reminders);
}

function showReminderBanner(text) {
  var banner = document.getElementById('reminder-banner');
  var bannerText = document.getElementById('reminder-banner-text');
  bannerText.textContent = '🔔 ' + text;
  banner.style.display = '';

  // Vibrate if supported (Android)
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

  // Beep sound via Web Audio API
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch (e) { }

  // Auto close after 10s
  setTimeout(function () {
    banner.style.display = 'none';
  }, 10000);
}

function closeReminderBanner() {
  document.getElementById('reminder-banner').style.display = 'none';
}

function renderReminderList() {
  var el = document.getElementById('reminder-list');
  var reminders = getReminders().filter(function (r) { return !r.fired; });
  if (reminders.length === 0) {
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
      var reminders = getReminders().filter(function (r) { return r.id !== btn.getAttribute('data-id'); });
      saveReminders(reminders);
      renderReminderList();
    });
  });
}

function initReminders() {
  // Check every 30 seconds
  if (reminderCheckInterval) clearInterval(reminderCheckInterval);
  reminderCheckInterval = setInterval(checkReminders, 30000);
  checkReminders(); // Check immediately
}

// ============================================================
// Phase 3: RAG (Knowledge Base)
// ============================================================
document.getElementById('reindex-btn').addEventListener('click', function() {
  var status = document.getElementById('reindex-status');
  var btn = document.getElementById('reindex-btn');
  
  if(!confirm('최근 50개 노트를 AI 지식 베이스에 추가하시겠습니까? (1~2분 소요)')) return;
  
  btn.disabled = true;
  btn.textContent = '구축 중... (잠시만 기다려주세요)';
  status.textContent = '노트 분석 및 임베딩 생성 중...';
  
  api('/rag/reindex', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if(d.success) {
        status.textContent = '완료! ' + d.message;
        status.style.color = 'var(--green)';
      } else {
        throw new Error(d.error || '실패');
      }
    })
    .catch(function(e) {
      status.textContent = '오류: ' + e.message;
      status.style.color = 'var(--red)';
    })
    .finally(function() {
      btn.disabled = false;
      btn.textContent = '지식 베이스 구축 (최근 50개)';
    });
});

document.addEventListener('DOMContentLoaded', function () {
  // Auth
  document.getElementById('auth-btn').addEventListener('click', doAuth);
  document.getElementById('key-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doAuth();
  });

  // Tabs
  document.querySelectorAll('.tab-item').forEach(function (tab) {
    tab.addEventListener('click', function () {
      switchTab(tab.getAttribute('data-tab'), tab);
    });
  });

  // Memo date nav
  document.getElementById('memo-prev').addEventListener('click', function () { shiftMemoDate(-1); });
  document.getElementById('memo-next').addEventListener('click', function () { shiftMemoDate(1); });
  document.getElementById('memo-date').addEventListener('click', function () { resetMemoDate(); });

  // Today date nav
  document.getElementById('today-prev').addEventListener('click', function () { shiftTodayDate(-1); });
  document.getElementById('today-next').addEventListener('click', function () { shiftTodayDate(1); });
  document.getElementById('today-date').addEventListener('click', function () { resetTodayDate(); });

  // Section chips
  document.querySelectorAll('#sec-chips .chip').forEach(function (chip) {
    chip.addEventListener('click', function () { pickSec(chip); });
  });

  // Priority chips
  document.querySelectorAll('#priority-chips .priority-chip').forEach(function (chip) {
    chip.addEventListener('click', function () { pickPriority(chip); });
  });

  // Tag input
  var tagIn = document.getElementById('tag-in');
  var tagSug = document.getElementById('tag-sug');
  tagIn.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addTag(tagIn.value); tagIn.value = ''; tagSug.style.display = 'none'; }
  });
  tagIn.addEventListener('input', function () {
    var q = tagIn.value.trim().toLowerCase();
    if (!q) { tagSug.style.display = 'none'; return; }
    var m = allTags.filter(function (t) { return t.tag.toLowerCase().indexOf(q) >= 0 && myTags.indexOf(t.tag) < 0; }).slice(0, 5);
    if (!m.length) { tagSug.style.display = 'none'; return; }
    tagSug.innerHTML = m.map(function (t) {
      return '<div class="sug-item" data-tag="' + esc(t.tag) + '">' + esc(t.tag) + ' (' + t.count + ')</div>';
    }).join('');
    tagSug.style.display = '';
  });
  tagSug.addEventListener('click', function (e) {
    var item = e.target.closest('.sug-item');
    if (item) {
      addTag(item.getAttribute('data-tag'));
      tagIn.value = '';
      tagSug.style.display = 'none';
    }
  });

  // Auto-tag on memo input (debounced 3s)
  document.getElementById('memo-text').addEventListener('input', function () {
    if (autoTagTimer) clearTimeout(autoTagTimer);
    autoTagTimer = setTimeout(triggerAutoTag, 3000);
  });

  // Newline button
  document.getElementById('newline-btn').addEventListener('click', function () {
    var ta = document.getElementById('memo-text');
    var pos = ta.selectionStart;
    var val = ta.value;
    ta.value = val.substring(0, pos) + '\n' + val.substring(pos);
    ta.selectionStart = ta.selectionEnd = pos + 1;
    ta.focus();
  });

  // Save button
  document.getElementById('save-btn').addEventListener('click', doSave);

  // Image inputs
  document.getElementById('image-input').addEventListener('change', function (e) {
    handleImageSelect(e.target.files);
    e.target.value = '';
  });
  document.getElementById('gallery-input').addEventListener('change', function (e) {
    handleImageSelect(e.target.files);
    e.target.value = '';
  });

  // Audio recording button
  document.getElementById('audio-rec-btn').addEventListener('click', toggleAudioRecording);

  // History search — full text + AI
  document.getElementById('search-btn').addEventListener('click', doSearch);
  document.getElementById('search-ai-btn').addEventListener('click', doAISearch);
  var searchInput = document.getElementById('hist-search');
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });
  // iOS 키보드 마이크 음성 입력 후 자동 검색 (1.5초 타이핑 멈추면)
  var searchTimer = null;
  searchInput.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      if (searchInput.value.trim()) doSearch();
    }, 1500);
  });
  document.getElementById('hist-close').addEventListener('click', closePreview);
  initSearchMic();

  // Settings
  var defSec = document.getElementById('def-sec');
  defSec.value = localStorage.getItem('vv_sec') || '메모';
  defSec.addEventListener('change', function () { localStorage.setItem('vv_sec', defSec.value); });
  document.getElementById('logout-btn').addEventListener('click', doLogout);

  // AI buttons
  document.querySelectorAll('.ai-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      doAI(btn.getAttribute('data-action'));
    });
  });

  // Reminder dialog
  document.getElementById('reminder-save').addEventListener('click', saveReminderFromDialog);
  document.getElementById('reminder-cancel').addEventListener('click', function () {
    document.getElementById('reminder-dialog').style.display = 'none';
  });
  document.getElementById('reminder-banner-close').addEventListener('click', closeReminderBanner);

  // Clipboard sync
  document.getElementById('clip-send').addEventListener('click', clipSend);
  document.getElementById('clip-recv').addEventListener('click', clipRecv);

  // Feature test
  document.getElementById('run-test').addEventListener('click', runFeatureTest);

  // Boot
  if (API_KEY) {
    showApp();
  } else {
    document.getElementById('auth').style.display = '';
  }
});

// ============================================================
// Auto-tag generation
// ============================================================
var autoTagTimer = null;
var lastAutoTagText = '';
var autoTagInFlight = false;

function triggerAutoTag() {
  var text = document.getElementById('memo-text').value.trim();
  if (text.length < 15 || text === lastAutoTagText || autoTagInFlight) return;

  autoTagInFlight = true;
  lastAutoTagText = text;

  api('/ai/summarize', {
    method: 'POST',
    body: JSON.stringify({ action: 'auto-tags', content: text })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.success || !d.result) return;
      var tags = d.result;
      if (typeof tags === 'string') {
        try { tags = JSON.parse(tags); } catch (e) { return; }
      }
      if (!Array.isArray(tags)) return;
      tags.slice(0, 2).forEach(function (t) {
        t = t.trim().replace(/^#/, '');
        if (t) addTag(t);
      });
    })
    .catch(function () {})
    .then(function () { autoTagInFlight = false; });
}

// ============================================================
// Full-text Search
// ============================================================
function doSearch() {
  var q = document.getElementById('hist-search').value.trim();
  var resultsEl = document.getElementById('search-results');
  var histList = document.getElementById('hist-list');

  if (!q) {
    resultsEl.style.display = 'none';
    histList.style.display = '';
    loadHistory();
    return;
  }

  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div class="empty" style="padding:16px">검색 중...</div>';
  histList.style.display = 'none';

  var scope = document.getElementById('search-all-vault').checked ? 'all' : 'daily';
  api('/search?q=' + encodeURIComponent(q) + '&scope=' + scope)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.results || d.results.length === 0) {
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
        item.addEventListener('click', function () {
          openPreview(item.getAttribute('data-date'));
        });
      });
    })
    .catch(function (e) {
      resultsEl.innerHTML = '<div class="empty" style="padding:20px">검색 실패: ' + esc(e.message) + '</div>';
    });
}

function doAISearch() {
  var q = document.getElementById('hist-search').value.trim();
  var resultsEl = document.getElementById('search-results');
  var histList = document.getElementById('hist-list');
  var aiBtn = document.getElementById('search-ai-btn');

  if (!q) return;

  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div class="empty" style="padding:16px">AI가 관련 키워드 확장 중...</div>';
  histList.style.display = 'none';
  aiBtn.disabled = true;
  aiBtn.textContent = 'AI 검색 중...';

  var scope = document.getElementById('search-all-vault').checked ? 'all' : 'daily';
  api('/search/ai?q=' + encodeURIComponent(q) + '&scope=' + scope)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) {
        resultsEl.innerHTML = '<div class="empty" style="padding:20px">' + esc(d.error) + '</div>';
        return;
      }
      if (!d.results || d.results.length === 0) {
        resultsEl.innerHTML = '<div class="empty" style="padding:20px">"' + esc(q) + '" AI 검색 결과 없음</div>';
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
          // Highlight all matched keywords
          (m.keywords || []).forEach(function (k) {
            var re = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
            text = text.replace(re, '<mark>$1</mark>');
          });
          return '<div class="search-result-match">' + text + '</div>';
        }).join('');
        var pathHtml2 = r.path ? '<div style="font-size:11px;color:var(--text2);margin-top:2px">' + esc(r.path) + '</div>' : '';
        return '<div class="search-result-item" data-date="' + r.date + '">' +
          '<div class="search-result-date">' + esc(r.date) + '</div>' +
          pathHtml2 + matchHtml + '</div>';
      }).join('');

      resultsEl.innerHTML = html;
      resultsEl.querySelectorAll('.search-result-item').forEach(function (item) {
        item.addEventListener('click', function () {
          openPreview(item.getAttribute('data-date'));
        });
      });
    })
    .catch(function (e) {
      resultsEl.innerHTML = '<div class="empty" style="padding:20px">AI 검색 실패: ' + esc(e.message) + '</div>';
    })
    .then(function () {
      aiBtn.disabled = false;
      aiBtn.textContent = 'AI 검색';
    });
}

function initSearchMic() {
  var micBtn = document.getElementById('search-mic-btn');
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.style.display = 'none';
    return;
  }

  micBtn.style.display = 'flex';
  var recognition = new SpeechRecognition();
  recognition.lang = 'ko-KR';
  recognition.continuous = false;
  recognition.interimResults = false;
  var isRecording = false;

  micBtn.addEventListener('click', function () {
    if (isRecording) { recognition.stop(); return; }
    try { recognition.start(); } catch (e) { }
  });

  recognition.onstart = function () {
    isRecording = true;
    micBtn.classList.add('recording');
  };

  recognition.onresult = function (e) {
    var text = e.results[0][0].transcript;
    document.getElementById('hist-search').value = text;
    doSearch();
  };

  recognition.onend = function () {
    isRecording = false;
    micBtn.classList.remove('recording');
  };

  recognition.onerror = function () {
    isRecording = false;
    micBtn.classList.remove('recording');
  };
}

// ============================================================
// QR Code (설정탭 진입 시 현재 URL 표시)
// ============================================================
function loadQRCode() {
  var input = document.getElementById('qr-url-input');
  var saved = localStorage.getItem('vv_tunnelUrl') || '';

  // 현재 접속이 터널(localhost 아닌)이면 자동 감지
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
// Clipboard Sync (PC ↔ 아이폰)
// ============================================================
function clipSend() {
  var text = document.getElementById('clip-text').value.trim();
  var status = document.getElementById('clip-status');
  if (!text) { status.textContent = '텍스트를 입력하세요'; return; }
  api('/clipboard', {
    method: 'POST',
    body: JSON.stringify({ text: text })
  }).then(function (r) {
    if (r.ok) {
      status.textContent = '전송 완료! 다른 기기에서 "받기" 누르세요';
      status.style.color = 'var(--green)';
    }
  }).catch(function (e) {
    status.textContent = '전송 실패: ' + e.message;
    status.style.color = 'var(--red)';
  });
}

function clipRecv() {
  var textArea = document.getElementById('clip-text');
  var status = document.getElementById('clip-status');
  api('/clipboard').then(function (r) { return r.json(); }).then(function (d) {
    if (d.text) {
      textArea.value = d.text;
      // 클립보드에도 복사 시도
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(d.text).then(function () {
          status.textContent = '받기 완료! 클립보드에도 복사됨';
        }).catch(function () {
          status.textContent = '받기 완료! (클립보드 복사는 수동으로)';
        });
      } else {
        status.textContent = '받기 완료! 위 텍스트를 복사하세요';
      }
      status.style.color = 'var(--green)';
      var ago = Date.now() - d.updatedAt;
      if (ago < 60000) status.textContent += ' (' + Math.round(ago / 1000) + '초 전)';
      else if (ago < 3600000) status.textContent += ' (' + Math.round(ago / 60000) + '분 전)';
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
// Feature Test (전체 기능 자동 점검)
// ============================================================
function runFeatureTest() {
  var el = document.getElementById('test-results');
  var btn = document.getElementById('run-test');
  btn.disabled = true;
  btn.textContent = '점검 중...';
  el.innerHTML = '';

  var checks = [];

  // 클라이언트 체크
  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad/.test(ua);
  var hasSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  checks.push({ name: '브라우저', ok: true, detail: isIOS ? 'iOS Safari' : 'Desktop' });
  checks.push({ name: '음성인식', ok: hasSpeech, detail: hasSpeech ? '지원됨' : (isIOS ? 'iOS는 키보드 마이크 사용' : '미지원') });
  checks.push({ name: '카메라', ok: true, detail: 'input[capture] 사용' });
  checks.push({ name: '알림 저장소', ok: !!localStorage, detail: localStorage ? 'localStorage OK' : '미지원' });

  // 서버 체크
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
    var icon = c.ok ? '✅' : '❌';
    var color = c.ok ? 'var(--green)' : 'var(--red)';
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:0.5px solid var(--sep)">' +
      '<span>' + icon + '</span>' +
      '<span style="flex:1;font-size:14px">' + esc(c.name) + '</span>' +
      '<span style="font-size:12px;color:' + color + '">' + esc(c.detail) + '</span>' +
      '</div>';
  }).join('');
}

// ============================================================
// Service Worker
// ============================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(function (reg) {
    // Check for updates every 30 minutes
    setInterval(function () {
      reg.update().catch(function () { });
    }, 30 * 60 * 1000);
  }).catch(function () { });
}
