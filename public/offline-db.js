// VaultVoice Offline Queue — IndexedDB helper
(function (global) {
  var DB_NAME = 'vaultvoice-offline';
  var STORE   = 'post-queue';
  var DB_VER  = 1;

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { autoIncrement: true });
        }
      };
      req.onsuccess  = function (e) { resolve(e.target.result); };
      req.onerror    = function (e) { reject(e.target.error); };
    });
  }

  function addToQueue(url, fields, fileBlob, fileName) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx   = db.transaction(STORE, 'readwrite');
        var item = { url: url, fields: fields, fileBlob: fileBlob || null, fileName: fileName || null, timestamp: Date.now() };
        var req  = tx.objectStore(STORE).add(item);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function getQueue() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx    = db.transaction(STORE, 'readonly');
        var items = [];
        var cur   = tx.objectStore(STORE).openCursor();
        cur.onsuccess = function (e) {
          var cursor = e.target.result;
          if (cursor) { items.push({ id: cursor.key, data: cursor.value }); cursor.continue(); }
          else resolve(items);
        };
        cur.onerror = function () { reject(cur.error); };
      });
    });
  }

  function removeFromQueue(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE, 'readwrite');
        var req = tx.objectStore(STORE).delete(id);
        req.onsuccess = function () { resolve(); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function queueCount() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).count();
        req.onsuccess = function () { resolve(req.result); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  global.OfflineDB = { addToQueue: addToQueue, getQueue: getQueue, removeFromQueue: removeFromQueue, queueCount: queueCount };
})(window);
