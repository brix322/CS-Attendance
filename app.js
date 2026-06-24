/* ═══════════════════════════════════════════════════════
   CSLTC Attendance Tracker — Main Application Logic
   
   Sections:
   1.  Configuration
   2.  State
   3.  IndexedDB
   4.  Utility Helpers
   5.  Audio / Haptic Feedback
   6.  Screen Router
   7.  Online / Offline Detection
   8.  Login Module
   9.  Unit Selection Module
   10. QR Scanner Module
   11. Attendance Recording
   12. Sync Engine
   13. President Dashboard
   14. Confirm Modal
   15. Service Worker Registration
   16. Init
════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────────────────
   1. CONFIGURATION
   ──────────────────────────────────────────────────── */
const CONFIG = {
  // ⚠  Replace with your deployed Apps Script Web App URL
  APPS_SCRIPT_URL: '[script.google.com](https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec)',

  // Passwords (for production, use a server-side auth layer)
  PASSWORD_OFFICER:   'csltc2025officer',
  PASSWORD_PRESIDENT: 'csltcPRES#2025!',

  // Anti-duplicate window (12 hours in ms)
  DUPLICATE_WINDOW_MS: 12 * 60 * 60 * 1000,

  // IndexedDB
  DB_NAME:    'csltc_attendance',
  DB_VERSION: 1,
  STORE_QUEUE: 'sync_queue',
  STORE_SCANS: 'scanned_ids',

  // Toast duration
  TOAST_DURATION_MS: 3000,

  // Sync retry interval when online (ms)
  SYNC_RETRY_INTERVAL_MS: 30000,
};

/* ──────────────────────────────────────────────────────
   2. STATE
   ──────────────────────────────────────────────────── */
const State = {
  role:          null,   // 'officer' | 'president'
  selectedUnit:  null,
  isOnline:      navigator.onLine,
  db:            null,
  qrScanner:     null,
  scannerActive: false,
  sessionScans:  [],     // [{id, name, unit, timestamp}] — in-memory for recent list
  syncTimer:     null,
};

/* ──────────────────────────────────────────────────────
   3. INDEXEDDB
   ──────────────────────────────────────────────────── */
const DB = {
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Queue of scans waiting to be synced
        if (!db.objectStoreNames.contains(CONFIG.STORE_QUEUE)) {
          const qStore = db.createObjectStore(CONFIG.STORE_QUEUE, {
            keyPath: 'localId',
            autoIncrement: true,
          });
          qStore.createIndex('memberId', 'memberId', { unique: false });
        }

        // Record of all scans (for duplicate detection)
        if (!db.objectStoreNames.contains(CONFIG.STORE_SCANS)) {
          const sStore = db.createObjectStore(CONFIG.STORE_SCANS, {
            keyPath: 'memberId',
          });
          sStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  },

  // ── Queue operations ────────────────────────────────

  addToQueue(payload) {
    return new Promise((resolve, reject) => {
      const tx  = State.db.transaction(CONFIG.STORE_QUEUE, 'readwrite');
      const req = tx.objectStore(CONFIG.STORE_QUEUE).add(payload);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  getAllQueued() {
    return new Promise((resolve, reject) => {
      const tx  = State.db.transaction(CONFIG.STORE_QUEUE, 'readonly');
      const req = tx.objectStore(CONFIG.STORE_QUEUE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  clearQueuedItem(localId) {
    return new Promise((resolve, reject) => {
      const tx  = State.db.transaction(CONFIG.STORE_QUEUE, 'readwrite');
      const req = tx.objectStore(CONFIG.STORE_QUEUE).delete(localId);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  clearAllQueued() {
    return new Promise((resolve, reject) => {
      const tx  = State.db.transaction(CONFIG.STORE_QUEUE, 'readwrite');
      const req = tx.objectStore(CONFIG.STORE_QUEUE).clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  // ── Scan record operations (duplicate detection) ────

  recordScan(memberId, timestamp) {
    return new Promise((resolve, reject) => {
      const tx  = State.db.transaction(CONFIG.STORE_SCANS, 'readwrite');
      const req = tx.objectStore(CONFIG.STORE_SCANS).put({ memberId, timestamp });
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  getScanRecord(memberId) {
    return new Promise((resolve, reject) => {
      const tx  = State.db.transaction(CONFIG.STORE_SCANS, 'readonly');
      const req = tx.objectStore(CONFIG.STORE_SCANS).get(memberId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  },

  getQueueCount() {
    return new Promise((resolve, reject) => {
      const tx  = State.db.transaction(CONFIG.STORE_QUEUE, 'readonly');
      const req = tx.objectStore(CONFIG.STORE_QUEUE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },
};

/* ──────────────────────────────────────────────────────
   4. UTILITY HELPERS
   ──────────────────────────────────────────────────── */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function formatTimestamp(date = new Date()) {
  return date.toLocaleString('en-PH', {
    year:   'numeric',
    month:  '2-digit',
    day:    '2-digit',
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-PH', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function generateLocalId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/* ──────────────────────────────────────────────────────
   5. AUDIO / HAPTIC FEEDBACK
   ──────────────────────────────────────────────────── */
const Feedback = {
  _ctx: null,

  _getCtx() {
    if (!this._ctx) {
      try {
        this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        return null;
      }
    }
    return this._ctx;
  },

  beep(frequency = 880, duration = 0.12, type = 'sine') {
    const ctx = this._getCtx();
    if (!ctx) return;

    const oscillator = ctx.createOscillator();
    const gainNode   = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type      = type;
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);
  },

  success() {
    this.beep(880, 0.1);
    setTimeout(() => this.beep(1174, 0.12), 100);
    if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
  },

  warning() {
    this.beep(440, 0.2, 'square');
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  },

  error() {
    this.beep(220, 0.3, 'sawtooth');
    if (navigator.vibrate) navigator.vibrate([200]);
  },
};

/* ──────────────────────────────────────────────────────
   6. SCREEN ROUTER
   ──────────────────────────────────────────────────── */
const Router = {
  screens: {
    login:       '#screen-login',
    unitSelect:  '#screen-unit-select',
    scanner:     '#screen-scanner',
    president:   '#screen-president',
  },

  navigate(screenKey) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    const target = $(this.screens[screenKey]);
    if (target) target.classList.add('active');

    // Side effects on navigation
    if (screenKey !== 'scanner') {
      Scanner.stop();
    }
    if (screenKey === 'president') {
      Dashboard.load();
    }
  },
};

/* ──────────────────────────────────────────────────────
   7. ONLINE / OFFLINE DETECTION
   ──────────────────────────────────────────────────── */
const Network = {
  init() {
    window.addEventListener('online',  () => this._handleOnline());
    window.addEventListener('offline', () => this._handleOffline());
    this._updateUI(navigator.onLine);
  },

  _handleOnline() {
    State.isOnline = true;
    this._updateUI(true);
    SyncEngine.syncAll();
  },

  _handleOffline() {
    State.isOnline = false;
    this._updateUI(false);
  },

  _updateUI(online) {
    const dots   = $$('.status-dot');
    const labels = $$('#sync-status-label');

    dots.forEach(dot => {
      dot.classList.toggle('online',  online);
      dot.classList.toggle('offline', !online);
      dot.title = online ? 'Online' : 'Offline';
    });

    labels.forEach(el => {
      el.textContent = online ? 'Online' : 'Offline';
    });
  },
};

/* ──────────────────────────────────────────────────────
   8. LOGIN MODULE
   ──────────────────────────────────────────────────── */
const Auth = {
  init() {
    $('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleLogin();
    });

    $('#btn-logout-officer').addEventListener('click',   () => this.logout());
    $('#btn-logout-president').addEventListener('click', () => this.logout());
  },

  _handleLogin() {
    const pw    = $('#login-password').value.trim();
    const error = $('#login-error');

    if (pw === CONFIG.PASSWORD_PRESIDENT) {
      error.classList.add('hidden');
      State.role = 'president';
      $('#login-password').value = '';
      Router.navigate('president');

    } else if (pw === CONFIG.PASSWORD_OFFICER) {
      error.classList.add('hidden');
      State.role = 'officer';
      $('#login-password').value = '';
      Router.navigate('unitSelect');

    } else {
      error.classList.remove('hidden');
      $('#login-password').value = '';
      $('#login-password').focus();
      Feedback.error();
    }
  },

  logout() {
    Scanner.stop();
    State.role         = null;
    State.selectedUnit = null;
    State.sessionScans = [];

    // Reset unit buttons
    $$('.unit-btn').forEach(b => {
      b.classList.remove('selected');
      b.setAttribute('aria-checked', 'false');
    });
    $('#btn-proceed-scan').disabled = true;

    Router.navigate('login');
    $('#login-password').focus();
  },
};

/* ──────────────────────────────────────────────────────
   9. UNIT SELECTION MODULE
   ──────────────────────────────────────────────────── */
const UnitSelector = {
  init() {
    $$('.unit-btn').forEach(btn => {
      btn.addEventListener('click', () => this._selectUnit(btn));
    });

    $('#btn-proceed-scan').addEventListener('click', () => {
      if (State.selectedUnit) {
        Scanner.start();
        Router.navigate('scanner');
      }
    });
  },

  _selectUnit(btn) {
    $$('.unit-btn').forEach(b => {
      b.classList.remove('selected');
      b.setAttribute('aria-checked', 'false');
    });

    btn.classList.add('selected');
    btn.setAttribute('aria-checked', 'true');
    State.selectedUnit = btn.dataset.unit;

    $('#btn-proceed-scan').disabled = false;
    $('#active-unit-badge').textContent = State.selectedUnit;

    Feedback.beep(660, 0.08);
  },
};

/* ──────────────────────────────────────────────────────
   10. QR SCANNER MODULE
   ──────────────────────────────────────────────────── */
const Scanner = {
  _instance: null,

  start() {
    if (State.scannerActive) return;

    const config = {
      fps:              15,
      qrbox:            { width: 240, height: 240 },
      aspectRatio:      1.0,
      disableFlip:      false,
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    };

    this._instance = new Html5Qrcode('qr-reader', { verbose: false });

    this._instance
      .start(
        { facingMode: 'environment' },
        config,
        (decodedText) => this._onScanSuccess(decodedText),
        () => {} // ignore per-frame errors silently
      )
      .then(() => {
        State.scannerActive = true;
      })
      .catch((err) => {
        console.warn('Camera start failed:', err);
        // Silently fall back — user can use manual entry
        UI.showToast('Camera unavailable. Use Manual Entry.', 'warning');
      });
  },

  stop() {
    if (!State.scannerActive || !this._instance) return;

    this._instance
      .stop()
      .catch(() => {})
      .finally(() => {
        State.scannerActive = false;
        this._instance = null;
      });
  },

  _onScanSuccess(rawText) {
    // Debounce: prevent rapid re-fires
    if (this._lastScanText === rawText && this._lastScanTime &&
        Date.now() - this._lastScanTime < 2000) {
      return;
    }
    this._lastScanText = rawText;
    this._lastScanTime = Date.now();

    let payload;

    try {
      payload = JSON.parse(rawText);
      if (!payload.id) throw new Error('Missing id field');
    } catch {
      // Not JSON — treat the raw string as a plain ID
      payload = { id: rawText.trim(), name: 'Unknown' };
    }

    Attendance.record(payload.id, payload.name || 'Unknown');
  },
};

/* ──────────────────────────────────────────────────────
   11. ATTENDANCE RECORDING
   ──────────────────────────────────────────────────── */
const Attendance = {
  async record(memberId, memberName = 'Unknown') {
    memberId = String(memberId).trim().toUpperCase();

    if (!memberId) {
      UI.showToast('Invalid Member ID.', 'error');
      Feedback.error();
      return;
    }

    // ── Duplicate check ─────────────────────────────
    const existing = await DB.getScanRecord(memberId);
    if (existing) {
      const elapsed = Date.now() - existing.timestamp;
      if (elapsed < CONFIG.DUPLICATE_WINDOW_MS) {
        const scannedAt = formatTime(existing.timestamp);
        UI.showToast(
          `⚠ Already scanned at ${scannedAt}`,
          'warning'
        );
        Feedback.warning();
        return;
      }
    }

    // ── Build payload ────────────────────────────────
    const now = new Date();
    const entry = {
      memberId,
      memberName: String(memberName).trim() || 'Unknown',
      unit:       State.selectedUnit,
      timestamp:  now.toISOString(),
      localId:    generateLocalId(),
    };

    // ── Store duplicate-check record ─────────────────
    await DB.recordScan(memberId, now.getTime());

    // ── Try to sync immediately; queue if offline ────
    const synced = await SyncEngine.syncOne(entry);

    if (!synced) {
      await DB.addToQueue(entry);
    }

    // ── Update UI ────────────────────────────────────
    State.sessionScans.unshift(entry);
    UI.addRecentScan(entry, !synced);
    UI.showToast(
      synced
        ? `✔ ${entry.memberName} recorded`
        : `✔ Saved offline — will sync`,
      'success'
    );
    Feedback.success();

    await UI.updatePendingCount();
  },
};

/* ──────────────────────────────────────────────────────
   12. SYNC ENGINE
   ──────────────────────────────────────────────────── */
const SyncEngine = {
  // Attempt to sync a single entry; returns true on success
  async syncOne(entry) {
    if (!navigator.onLine) return false;

    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        // Apps Script requires no-cors OR CORS must be enabled via webapp config
        // Using text/plain to avoid CORS preflight with Apps Script
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action:     'log',
          memberId:   entry.memberId,
          memberName: entry.memberName,
          unit:       entry.unit,
          timestamp:  entry.timestamp,
        }),
      });

      if (res.ok) return true;
      return false;
    } catch {
      return false;
    }
  },

  // Sync everything in the IndexedDB queue
  async syncAll() {
    if (!navigator.onLine || !State.db) return;

    let queued;
    try {
      queued = await DB.getAllQueued();
    } catch {
      return;
    }

    if (!queued.length) return;

    let successCount = 0;

    for (const entry of queued) {
      const ok = await this.syncOne(entry);
      if (ok) {
        try {
          await DB.clearQueuedItem(entry.localId);
          successCount++;
        } catch {
          // continue with other entries
        }
      }
    }

    if (successCount > 0) {
      await UI.updatePendingCount();
      console.log(`[Sync] ${successCount}/${queued.length} entries synced.`);
    }
  },

  startPeriodicSync() {
    if (State.syncTimer) clearInterval(State.syncTimer);
    State.syncTimer = setInterval(() => {
      if (navigator.onLine) this.syncAll();
    }, CONFIG.SYNC_RETRY_INTERVAL_MS);
  },
};

/* ──────────────────────────────────────────────────────
   13. UI HELPERS
   ──────────────────────────────────────────────────── */
const UI = {
  _toastTimer: null,

  showToast(message, type = 'success') {
    const toast = $('#scan-toast');
    if (!toast) return;

    toast.textContent = message;
    toast.className   = `scan-toast toast-${type}`;
    toast.classList.remove('hidden');

    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, CONFIG.TOAST_DURATION_MS);
  },

  addRecentScan(entry, isOffline = false) {
    const list = $('#recent-scans-list');
    if (!list) return;

    // Remove empty placeholder
    const empty = list.querySelector('.recent-empty');
    if (empty) empty.remove();

    const time = formatTime(entry.timestamp);

    const li = document.createElement('li');
    li.className = 'recent-item';
    li.innerHTML = `
      <div class="recent-item-icon ${isOffline ? 'recent-item-offline' : ''}">
        ${isOffline ? '⏳' : '✔'}
      </div>
      <div class="recent-item-info">
        <div class="recent-item-name">${this._escape(entry.memberName)}</div>
        <div class="recent-item-id">${this._escape(entry.memberId)} · ${entry.unit}</div>
      </div>
      <div class="recent-item-time">${time}</div>
    `;

    list.insertBefore(li, list.firstChild);

    // Keep list manageable
    const items = list.querySelectorAll('.recent-item');
    if (items.length > 50) items[items.length - 1].remove();

    // Update scan count badge
    const badge = $('#scan-count-badge');
    if (badge) badge.textContent = State.sessionScans.length;
  },

  async updatePendingCount() {
    if (!State.db) return;

    let count = 0;
    try {
      count = await DB.getQueueCount();
    } catch {
      return;
    }

    const label    = $('#scanner-pending-label');
    const countEl  = $('#pending-count');

    if (label && countEl) {
      countEl.textContent = count;
      label.classList.toggle('hidden', count === 0);
    }
  },

  _escape(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },
};

/* ──────────────────────────────────────────────────────
   13B. SCANNER TAB TOGGLE
   ──────────────────────────────────────────────────── */
const ScannerTabs = {
  init() {
    $('#tab-camera').addEventListener('click', () => this._show('camera'));
    $('#tab-manual').addEventListener('click', () => this._show('manual'));

    $('#manual-entry-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this._submitManual();
    });

    $('#btn-back-unit').addEventListener('click', () => {
      Router.navigate('unitSelect');
    });
  },

  _show(tab) {
    const cameraTab = $('#tab-camera');
    const manualTab = $('#tab-manual');
    const manualPanel = $('#panel-manual');
    const qrReader  = $('#qr-reader');

    if (tab === 'camera') {
      cameraTab.classList.add('active');
      cameraTab.setAttribute('aria-selected', 'true');
      manualTab.classList.remove('active');
      manualTab.setAttribute('aria-selected', 'false');
      manualPanel.classList.add('hidden');
      qrReader.style.display = '';
      Scanner.start();
    } else {
      manualTab.classList.add('active');
      manualTab.setAttribute('aria-selected', 'true');
      cameraTab.classList.remove('active');
      cameraTab.setAttribute('aria-selected', 'false');
      manualPanel.classList.remove('hidden');
      qrReader.style.display = 'none';
      Scanner.stop();
      $('#manual-id').focus();
    }
  },

  _submitManual() {
    const idInput   = $('#manual-id');
    const nameInput = $('#manual-name');
    const id        = idInput.value.trim();
    const name      = nameInput.value.trim() || 'Unknown';

    if (!id) {
      UI.showToast('Please enter a Member ID.', 'error');
      Feedback.error();
      return;
    }

    Attendance.record(id, name);
    idInput.value   = '';
    nameInput.value = '';
    idInput.focus();
  },
};

/* ──────────────────────────────────────────────────────
   13. PRESIDENT DASHBOARD
   ──────────────────────────────────────────────────── */
const Dashboard = {
  async load() {
    const loading  = $('#dashboard-loading');
    const errorEl  = $('#dashboard-error');
    const totalRow = $('#total-row');

    loading.classList.remove('hidden');
    errorEl.classList.add('hidden');
    totalRow.classList.add('hidden');

    if (!navigator.onLine) {
      loading.classList.add('hidden');
      errorEl.textContent = 'Device is offline. Connect to the internet to view dashboard data.';
      errorEl.classList.remove('hidden');
      return;
    }

    try {
      const url = `${CONFIG.APPS_SCRIPT_URL}?action=getDashboard`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const data = await res.json();
      this._render(data);

    } catch (err) {
      loading.classList.add('hidden');
      errorEl.textContent = `Failed to load dashboard: ${err.message}`;
      errorEl.classList.remove('hidden');
    }
  },

  _render(data) {
    const loading   = $('#dashboard-loading');
    const totalRow  = $('#total-row');
    const summaryEl = $('#unit-summary-grid');
    const tableBody = $('#audit-table-body');

    loading.classList.add('hidden');

    // ── Unit summary cards ───────────────────────────
    const units  = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
    const counts = data.unitCounts || {};
    let total    = 0;

    summaryEl.innerHTML = units.map(unit => {
      const count = counts[unit] || 0;
      total += count;
      return `
        <div class="unit-summary-card">
          <div class="unit-summary-name">${unit}</div>
          <div class="unit-summary-count">${count}</div>
        </div>
      `;
    }).join('');

    $('#total-count').textContent = total;
    totalRow.classList.remove('hidden');

    // ── Audit trail table ────────────────────────────
    const rows = data.rows || [];
    if (!rows.length) {
      tableBody.innerHTML = '<tr><td colspan="4" class="table-empty">No records found.</td></tr>';
      return;
    }

    tableBody.innerHTML = rows.slice(0, 50).map(row => `
      <tr>
        <td>${UI._escape(row.timestamp || '')}</td>
        <td>${UI._escape(row.memberId  || '')}</td>
        <td>${UI._escape(row.memberName|| '')}</td>
        <td>${UI._escape(row.unit      || '')}</td>
      </tr>
    `).join('');
  },

  init() {
    $('#btn-refresh-dashboard').addEventListener('click', () => this.load());
    $('#btn-archive').addEventListener('click', () => ConfirmModal.open());
  },

  async archive() {
    const loading = $('#dashboard-loading');
    loading.classList.remove('hidden');

    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body:    JSON.stringify({ action: 'archive' }),
      });

      if (!res.ok) throw new Error(`Server responded ${res.status}`);

      loading.classList.add('hidden');
      UI.showToast('✔ Archive complete. Roster has been reset.', 'success');
      await this.load();

    } catch (err) {
      loading.classList.add('hidden');
      const errorEl = $('#dashboard-error');
      errorEl.textContent = `Archive failed: ${err.message}`;
      errorEl.classList.remove('hidden');
    }
  },
};

/* ──────────────────────────────────────────────────────
   14. CONFIRM MODAL
   ──────────────────────────────────────────────────── */
const ConfirmModal = {
  init() {
    $('#confirm-input').addEventListener('input', (e) => {
      const valid = e.target.value.trim().toUpperCase() === 'RESET';
      $('#btn-modal-confirm').disabled = !valid;
    });

    $('#btn-modal-cancel').addEventListener('click', () => this.close());
    $('#btn-modal-confirm').addEventListener('click', async () => {
      this.close();
      await Dashboard.archive();
    });

    // Close on backdrop click
    $('#modal-confirm').addEventListener('click', (e) => {
      if (e.target === $('#modal-confirm')) this.close();
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  },

  open() {
    const modal = $('#modal-confirm');
    const input = $('#confirm-input');
    input.value = '';
    $('#btn-modal-confirm').disabled = true;
    modal.classList.remove('hidden');
    input.focus();
  },

  close() {
    $('#modal-confirm').classList.add('hidden');
    $('#confirm-input').value = '';
    $('#btn-modal-confirm').disabled = true;
  },
};

/* ──────────────────────────────────────────────────────
   15. SERVICE WORKER REGISTRATION
   ──────────────────────────────────────────────────── */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        console.log('[SW] Registered, scope:', reg.scope);
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[SW] New version available — reload to update.');
            }
          });
        });
      })
      .catch((err) => console.warn('[SW] Registration failed:', err));
  }
}

/* ──────────────────────────────────────────────────────
   16. INIT
   ──────────────────────────────────────────────────── */
async function init() {
  try {
    State.db = await DB.open();
    console.log('[DB] IndexedDB ready.');
  } catch (err) {
    console.error('[DB] Failed to open IndexedDB:', err);
  }

  // Boot all modules
  Network.init();
  Auth.init();
  UnitSelector.init();
  ScannerTabs.init();
  Dashboard.init();
  ConfirmModal.init();

  // Service worker
  registerServiceWorker();

  // Periodic sync (belt-and-suspenders)
  SyncEngine.startPeriodicSync();

  // Sync anything already queued on load
  if (navigator.onLine) {
    SyncEngine.syncAll();
  }

  // Update pending badge
  await UI.updatePendingCount();

  console.log('[CSLTC] Attendance Tracker initialised.');
}

document.addEventListener('DOMContentLoaded', init);
