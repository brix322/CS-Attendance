/* ═══════════════════════════════════════════════════════
   CSLTC Attendance Tracker — Main Application Logic
════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────────────────
   1. CONFIGURATION
   ──────────────────────────────────────────────────── */
const CONFIG = {
  // ⚠ Cleaned URL - Replace YOUR_DEPLOYMENT_ID later when you setup Google Sheets
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',

  PASSWORD_OFFICER:   'csltc2025officer',
  PASSWORD_PRESIDENT: 'csltcPRES#2025!',
  DUPLICATE_WINDOW_MS: 12 * 60 * 60 * 1000,
  DB_NAME:    'csltc_attendance',
  DB_VERSION: 1,
  STORE_QUEUE: 'sync_queue',
  STORE_SCANS: 'scanned_ids',
  TOAST_DURATION_MS: 3000,
  SYNC_RETRY_INTERVAL_MS: 30000,
};

/* ──────────────────────────────────────────────────────
   2. STATE
   ──────────────────────────────────────────────────── */
const State = {
  role:          null,
  selectedUnit:  null,
  isOnline:      navigator.onLine,
  db:            null,
  qrScanner:     null,
  scannerActive: false,
  sessionScans:  [],
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
        if (!db.objectStoreNames.contains(CONFIG.STORE_QUEUE)) {
          const qStore = db.createObjectStore(CONFIG.STORE_QUEUE, { keyPath: 'localId', autoIncrement: true });
          qStore.createIndex('memberId', 'memberId', { unique: false });
        }
        if (!db.objectStoreNames.contains(CONFIG.STORE_SCANS)) {
          const sStore = db.createObjectStore(CONFIG.STORE_SCANS, { keyPath: 'memberId' });
          sStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  },
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

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
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
      try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); } 
      catch { return null; }
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
    oscillator.type = type;
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
    if (screenKey !== 'scanner') Scanner.stop();
    if (screenKey === 'president') Dashboard.load();
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
    $$('.status-dot').forEach(dot => {
      dot.classList.toggle('online',  online);
      dot.classList.toggle('offline', !online);
      dot.title = online ? 'Online' : 'Offline';
    });
    $$('#sync-status-label').forEach(el => el.textContent = online ? 'Online' : 'Offline');
  },
};

/* ──────────────────────────────────────────────────────
   8. LOGIN MODULE
   ──────────────────────────────────────────────────── */
const Auth = {
  init() {
    $('#login-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleLogin();
    });
    $('#btn-logout-officer')?.addEventListener('click', () => this.logout());
    $('#btn-logout-president')?.addEventListener('click', () => this.logout());
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
    State.role = null;
    State.selectedUnit = null;
    State.sessionScans = [];
    $$('.unit-btn').forEach(b => {
      b.classList.remove('selected');
      b.setAttribute('aria-checked', 'false');
    });
    if ($('#btn-proceed-scan')) $('#btn-proceed-scan').disabled = true;
    Router.navigate('login');
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
    $('#btn-proceed-scan')?.addEventListener('click', () => {
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
    
    if ($('#btn-proceed-scan')) $('#btn-proceed-scan').disabled = false;
    if ($('#active-unit-badge')) $('#active-unit-badge').textContent = State.selectedUnit;
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
    const config = { fps: 15, qrbox: { width: 240, height: 240 }, aspectRatio: 1.0, disableFlip: false };
    
    // Safety check to ensure library loaded
    if (typeof Html5Qrcode === 'undefined') {
        UI.showToast('Scanner library still loading. Please wait or check internet.', 'warning');
        return;
    }

    this._instance = new Html5Qrcode('qr-reader', { verbose: false });
    this._instance.start(
        { facingMode: 'environment' },
        config,
        (decodedText) => this._onScanSuccess(decodedText),
        () => {} 
      )
      .then(() => { State.scannerActive = true; })
      .catch((err) => {
        console.warn('Camera start failed:', err);
        UI.showToast('Camera unavailable. Use Manual Entry.', 'warning');
      });
  },
  stop() {
    if (!State.scannerActive || !this._instance) return;
    this._instance.stop().catch(() => {}).finally(() => {
        State.scannerActive = false;
        this._instance = null;
      });
  },
  _onScanSuccess(rawText) {
    if (this._lastScanText === rawText && this._lastScanTime && Date.now() - this._lastScanTime < 2000) return;
    this._lastScanText = rawText;
    this._lastScanTime = Date.now();

    let payload;
    try {
      payload = JSON.parse(rawText);
      if (!payload.id) throw new Error('Missing id field');
    } catch {
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

    const existing = await DB.getScanRecord(memberId);
    if (existing && (Date.now() - existing.timestamp < CONFIG.DUPLICATE_WINDOW_MS)) {
      UI.showToast(`⚠ Already scanned at ${formatTime(existing.timestamp)}`, 'warning');
      Feedback.warning();
      return;
    }

    const now = new Date();
    const entry = {
      memberId,
      memberName: String(memberName).trim() || 'Unknown',
      unit:       State.selectedUnit,
      timestamp:  now.toISOString(),
      localId:    generateLocalId(),
    };

    await DB.recordScan(memberId, now.getTime());
    const synced = await SyncEngine.syncOne(entry);
    if (!synced) await DB.addToQueue(entry);

    State.sessionScans.unshift(entry);
    UI.addRecentScan(entry, !synced);
    UI.showToast(synced ? `✔ ${entry.memberName} recorded` : `✔ Saved offline — will sync`, 'success');
    Feedback.success();
    await UI.updatePendingCount();
  },
};

/* ──────────────────────────────────────────────────────
   12. SYNC ENGINE
   ──────────────────────────────────────────────────── */
const SyncEngine = {
  async syncOne(entry) {
    if (!navigator.onLine || CONFIG.APPS_SCRIPT_URL.includes('YOUR_DEPLOYMENT_ID')) return false;
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'log', ...entry }),
      });
      return res.ok;
    } catch { return false; }
  },
  async syncAll() {
    if (!navigator.onLine || !State.db) return;
    try {
      const queued = await DB.getAllQueued();
      if (!queued.length) return;
      let successCount = 0;
      for (const entry of queued) {
        if (await this.syncOne(entry)) {
          await DB.clearQueuedItem(entry.localId);
          successCount++;
        }
      }
      if (successCount > 0) await UI.updatePendingCount();
    } catch {}
  },
  startPeriodicSync() {
    if (State.syncTimer) clearInterval(State.syncTimer);
    State.syncTimer = setInterval(() => { if (navigator.onLine) this.syncAll(); }, CONFIG.SYNC_RETRY_INTERVAL_MS);
  },
};

/* ──────────────────────────────────────────────────────
   13. UI HELPERS & TAB TOGGLE
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
    this._toastTimer = setTimeout(() => toast.classList.add('hidden'), CONFIG.TOAST_DURATION_MS);
  },
  addRecentScan(entry, isOffline = false) {
    const list = $('#recent-scans-list');
    if (!list) return;
    const empty = list.querySelector('.recent-empty');
    if (empty) empty.remove();

    const li = document.createElement('li');
    li.className = 'recent-item';
    li.innerHTML = `
      <div class="recent-item-icon ${isOffline ? 'recent-item-offline' : ''}">${isOffline ? '⏳' : '✔'}</div>
      <div class="recent-item-info">
        <div class="recent-item-name">${this._escape(entry.memberName)}</div>
        <div class="recent-item-id">${this._escape(entry.memberId)} · ${entry.unit}</div>
      </div>
      <div class="recent-item-time">${formatTime(entry.timestamp)}</div>
    `;
    list.insertBefore(li, list.firstChild);
    
    const items = list.querySelectorAll('.recent-item');
    if (items.length > 50) items[items.length - 1].remove();
    if ($('#scan-count-badge')) $('#scan-count-badge').textContent = State.sessionScans.length;
  },
  async updatePendingCount() {
    if (!State.db) return;
    try {
      const count = await DB.getQueueCount();
      if ($('#pending-count')) $('#pending-count').textContent = count;
      if ($('#scanner-pending-label')) $('#scanner-pending-label').classList.toggle('hidden', count === 0);
    } catch {}
  },
  _escape(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
};

const ScannerTabs = {
  init() {
    $('#tab-camera')?.addEventListener('click', () => this._show('camera'));
    $('#tab-manual')?.addEventListener('click', () => this._show('manual'));
    $('#manual-entry-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._submitManual();
    });
    $('#btn-back-unit')?.addEventListener('click', () => Router.navigate('unitSelect'));
  },
  _show(tab) {
    if (tab === 'camera') {
      $('#tab-camera')?.classList.add('active');
      $('#tab-manual')?.classList.remove('active');
      $('#panel-manual')?.classList.add('hidden');
      if ($('#qr-reader')) $('#qr-reader').style.display = '';
      Scanner.start();
    } else {
      $('#tab-manual')?.classList.add('active');
      $('#tab-camera')?.classList.remove('active');
      $('#panel-manual')?.classList.remove('hidden');
      if ($('#qr-reader')) $('#qr-reader').style.display = 'none';
      Scanner.stop();
      $('#manual-id')?.focus();
    }
  },
  _submitManual() {
    const idInput   = $('#manual-id');
    const nameInput = $('#manual-name');
    const id        = idInput.value.trim();
    if (!id) {
      UI.showToast('Please enter a Member ID.', 'error');
      Feedback.error();
      return;
    }
    Attendance.record(id, nameInput.value.trim() || 'Unknown');
    idInput.value = '';
    nameInput.value = '';
    idInput.focus();
  },
};

/* ──────────────────────────────────────────────────────
   14. PRESIDENT DASHBOARD
   ──────────────────────────────────────────────────── */
const Dashboard = {
  init() {
    $('#btn-refresh-dashboard')?.addEventListener('click', () => this.load());
    $('#btn-archive')?.addEventListener('click', () => ConfirmModal.open());
  },
  async load() {
    if (!$('#dashboard-loading')) return;
    $('#dashboard-loading').classList.remove('hidden');
    $('#dashboard-error')?.classList.add('hidden');
    $('#total-row')?.classList.add('hidden');

    if (!navigator.onLine) {
      $('#dashboard-loading').classList.add('hidden');
      $('#dashboard-error').textContent = 'Device is offline.';
      $('#dashboard-error').classList.remove('hidden');
      return;
    }
    try {
      const res  = await fetch(`${CONFIG.APPS_SCRIPT_URL}?action=getDashboard`);
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      this._render(await res.json());
    } catch (err) {
      $('#dashboard-loading').classList.add('hidden');
      $('#dashboard-error').textContent = `Failed to load: ${err.message}`;
      $('#dashboard-error').classList.remove('hidden');
    }
  },
  _render(data) {
    $('#dashboard-loading')?.classList.add('hidden');
    let total = 0;
    if ($('#unit-summary-grid')) {
      $('#unit-summary-grid').innerHTML = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map(unit => {
        const count = (data.unitCounts || {})[unit] || 0;
        total += count;
        return `<div class="unit-summary-card"><div class="unit-summary-name">${unit}</div><div class="unit-summary-count">${count}</div></div>`;
      }).join('');
    }
    if ($('#total-count')) $('#total-count').textContent = total;
    $('#total-row')?.classList.remove('hidden');

    if ($('#audit-table-body')) {
      const rows = data.rows || [];
      $('#audit-table-body').innerHTML = rows.length ? rows.slice(0, 50).map(r => `<tr><td>${UI._escape(r.timestamp)}</td><td>${UI._escape(r.memberId)}</td><td>${UI._escape(r.memberName)}</td><td>${UI._escape(r.unit)}</td></tr>`).join('') : '<tr><td colspan="4">No records found.</td></tr>';
    }
  },
  async archive() {
    $('#dashboard-loading')?.classList.remove('hidden');
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'archive' }) });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      $('#dashboard-loading')?.classList.add('hidden');
      UI.showToast('✔ Archive complete.', 'success');
      await this.load();
    } catch (err) {
      $('#dashboard-loading')?.classList.add('hidden');
      if ($('#dashboard-error')) {
        $('#dashboard-error').textContent = `Archive failed: ${err.message}`;
        $('#dashboard-error').classList.remove('hidden');
      }
    }
  },
};

/* ──────────────────────────────────────────────────────
   15. CONFIRM MODAL
   ──────────────────────────────────────────────────── */
const ConfirmModal = {
  init() {
    $('#confirm-input')?.addEventListener('input', (e) => {
      if ($('#btn-modal-confirm')) $('#btn-modal-confirm').disabled = (e.target.value.trim().toUpperCase() !== 'RESET');
    });
    $('#btn-modal-cancel')?.addEventListener('click', () => this.close());
    $('#btn-modal-confirm')?.addEventListener('click', async () => { this.close(); await Dashboard.archive(); });
    $('#modal-confirm')?.addEventListener('click', (e) => { if (e.target === $('#modal-confirm')) this.close(); });
  },
  open() {
    if ($('#confirm-input')) $('#confirm-input').value = '';
    if ($('#btn-modal-confirm')) $('#btn-modal-confirm').disabled = true;
    $('#modal-confirm')?.classList.remove('hidden');
    $('#confirm-input')?.focus();
  },
  close() {
    $('#modal-confirm')?.classList.add('hidden');
    if ($('#confirm-input')) $('#confirm-input').value = '';
  },
};

/* ──────────────────────────────────────────────────────
   16. INIT
   ──────────────────────────────────────────────────── */
async function init() {
  try { State.db = await DB.open(); } catch (err) { console.error('[DB] Failed:', err); }
  Network.init();
  Auth.init();
  UnitSelector.init();
  ScannerTabs.init();
  Dashboard.init();
  ConfirmModal.init();
  SyncEngine.startPeriodicSync();
  if (navigator.onLine) SyncEngine.syncAll();
  await UI.updatePendingCount();
}

document.addEventListener('DOMContentLoaded', init);
