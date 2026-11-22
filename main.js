// main —— Electron 主进程：窗口、托盘、全局快捷键、提醒、数据 IPC
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  Notification,
  globalShortcut,
  clipboard,
  nativeImage,
  screen,
  net,
  dialog,
  shell
} = require('electron');

const {
  createTaskStore, createLogStore, createSettingsStore, createSyncMetaStore,
  defaultSyncMeta, DEFAULT_SETTINGS
} = require('./src/store.js');
const { createBackupManager, shouldAutoBackup } = require('./src/backup.js');
const { createSyncBridge } = require('./src/syncBridge.js');
const { normalizeStartupSettings } = require('./src/startupSettings.js');
const SyncCode = require('./src/syncCode.js');

// v2.6 自动更新：electron-updater 为可选依赖，未安装时优雅降级（检查更新走占位提示）
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { autoUpdater = null; }

function notifyUpdate(message, type) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:update-status', { message: message, type: type || 'info' });
  }
}
if (autoUpdater) {
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', function (info) {
    notifyUpdate('发现新版本 v' + (info && info.version ? info.version : '') + '，正在后台下载…', 'info');
  });
  autoUpdater.on('update-not-available', function () {
    notifyUpdate('已是最新版本 v' + app.getVersion(), 'ok');
  });
  autoUpdater.on('update-downloaded', function () {
    notifyUpdate('更新已下载，重启后生效', 'ok');
  });
  autoUpdater.on('error', function (err) {
    notifyUpdate('检查更新失败：' + (err && err.message ? err.message : '未知错误'), 'error');
  });
}

const APP_ID = 'com.lightframe.worklog';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const QUICK_ADD_SIZE = { width: 420, height: 160 };
const REMINDER_INTERVAL = 60 * 1000;

// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', function () {
  showMainWindow();
});

app.setAppUserModelId(APP_ID);

// ---------- 状态 ----------
let mainWindow = null;
let quickAddWindow = null;
let tray = null;
let reminderTimer = null;
let syncTimer = null;
let stores = null;
let syncBridge = null;
let syncMetaStore = null;
let backupManager = null;
let dataBusy = false;

const dataStatus = { tasks: null, logs: null, settings: null };

let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let tasksCache = [];
let logsCache = {};
let ready = false;

// ---------- 工具函数 ----------
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function hhmmString() {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function loadIcon() {
  try {
    if (fs.existsSync(ICON_PATH)) {
      const img = nativeImage.createFromPath(ICON_PATH);
      if (!img.isEmpty()) return img;
    }
  } catch (err) {
    console.warn('[icon] 读取图标失败：', err && err.message);
  }
  return nativeImage.createEmpty();
}

// ---------- 主窗口（桌面挂件形态） ----------
const WIDGET_SIZE = { collapsed: { width: 420, height: 560 }, expanded: { width: 420, height: 820 } };
let rectSaveTimer = null;

function createMainWindow() {
  const rect = settings && settings.widget && settings.widget.rect;
  const size = (settings && settings.widget && settings.widget.expanded)
    ? WIDGET_SIZE.expanded
    : WIDGET_SIZE.collapsed;

  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 360,
    minHeight: 420,
    title: '光影工作志',
    transparent: true,          // 玻璃拟态：窗口本身透明，由页面 CSS 提供底色
    frame: false,               // 无原生标题栏
    alwaysOnTop: true,          // 桌面挂件：常驻最前
    skipTaskbar: true,          // 不在任务栏占坑，靠托盘/快捷键唤起
    resizable: false,
    backgroundColor: '#00000000',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 20+ 默认沙箱化 preload，受限 require 无法加载 markdown-it / dompurify /
      // ./src/markdown.js，会让 v2.7 的 Markdown 渲染在打包版静默降级为空白。
      // 页面仍受 contextIsolation + nodeIntegration:false 约束，无法访问 Node。
      sandbox: false
    }
  });

  if (rect && typeof rect.x === 'number' && typeof rect.y === 'number') {
    try { mainWindow.setBounds({ x: rect.x, y: rect.y, width: size.width, height: size.height }); } catch (err) { /* 忽略 */ }
  }

  mainWindow.loadFile('index.html');
  mainWindow.setAlwaysOnTop(true);

  // 启动一律为普通可交互窗口；显式复位，防止任何历史路径遗留 OS 级鼠标穿透
  try { mainWindow.setIgnoreMouseEvents(false); } catch (err) { /* 忽略 */ }

  // 位置变化后落盘，下次启动回到原位
  mainWindow.on('moved', function () {
    if (!mainWindow || mainWindow.isDestroyed() || !settings.widget) return;
    const pos = mainWindow.getPosition();
    settings.widget.rect = { x: pos[0], y: pos[1] };
    if (rectSaveTimer) clearTimeout(rectSaveTimer);
    rectSaveTimer = setTimeout(persistSettings, 600);
  });

  mainWindow.on('close', function (e) {
    if (app.isQuitting) return;
    if (settings.closeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------- 速记框 ----------
function showQuickAdd() {
  if (!quickAddWindow || quickAddWindow.isDestroyed()) {
    quickAddWindow = new BrowserWindow({
      width: QUICK_ADD_SIZE.width,
      height: QUICK_ADD_SIZE.height,
      frame: false,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#f3ece0',
      icon: ICON_PATH,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false // 同主窗口：preload 需加载 Markdown 渲染依赖
      }
    });

    quickAddWindow.loadFile('quick-add.html');
    quickAddWindow.setMenu(null);

    quickAddWindow.once('ready-to-show', function () {
      if (!quickAddWindow || quickAddWindow.isDestroyed()) return;
      quickAddWindow.center();
      quickAddWindow.show();
      quickAddWindow.focus();
    });

    // 失焦不在此处处理：由页面判断（原生下拉弹出时会短暂失焦）
    quickAddWindow.on('closed', function () {
      quickAddWindow = null;
    });
  } else {
    if (quickAddWindow.isMinimized()) quickAddWindow.restore();
    quickAddWindow.center();
    quickAddWindow.show();
    quickAddWindow.focus();
  }
}

// ---------- 托盘 ----------
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: function () { showMainWindow(); }
    },
    {
      label: '今天日报',
      click: function () {
        showMainWindow();
        sendToMain('open-tab', 'daily');
      }
    },
    {
      label: '本周周报',
      click: function () {
        showMainWindow();
        sendToMain('open-tab', 'weekly');
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: function () {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  try {
    tray = new Tray(loadIcon());
  } catch (err) {
    console.warn('[tray] 创建托盘失败：', err && err.message);
    return;
  }
  tray.setToolTip('光影工作志');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', function () {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      showMainWindow();
    }
  });
  tray.on('double-click', function () {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });
}

// ---------- 系统设置应用 ----------
function applyAlwaysOnTop(value) {
  const on = !!value;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(on);
}

function applyLoginItem(value) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!value,
      path: process.execPath
    });
  } catch (err) {
    console.warn('[login] 设置开机自启失败：', err && err.message);
  }
}

function registerHotkey(accelerator) {
  try {
    const key = typeof accelerator === 'string' && accelerator.trim()
      ? accelerator.trim()
      : DEFAULT_SETTINGS.hotkey;
    return globalShortcut.register(key, function () { showQuickAdd(); });
  } catch (err) {
    console.warn('[hotkey] 注册异常：', err && err.message);
    return false;
  }
}

/** 应用快捷键；失败则回退默认键，保证速记始终可用。返回 { key, ok } */
function applyHotkey(accelerator) {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    /* 忽略 */
  }
  const key = typeof accelerator === 'string' && accelerator.trim()
    ? accelerator.trim()
    : DEFAULT_SETTINGS.hotkey;
  if (registerHotkey(key)) return { key: key, ok: true };

  console.warn('[hotkey] 注册失败（格式非法或已被占用）：', key);
  const fallback = DEFAULT_SETTINGS.hotkey;
  if (fallback !== key && registerHotkey(fallback)) return { key: fallback, ok: false };
  return { key: key, ok: false };
}

function applyAllSettings() {
  applyAlwaysOnTop(settings.alwaysOnTop);
  applyLoginItem(settings.launchAtLogin);
  const applied = applyHotkey(settings.hotkey);
  settings.hotkey = applied.key;
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
  return applied;
}

async function persistSettingsStrict() {
  if (!stores) throw new Error('存储尚未就绪');
  await stores.settings.save(settings);
}

// 后台设置写入（窗口移动、提醒去重）失败只记录；用户主动的同步/设置写入走 strict
function persistSettings() {
  return persistSettingsStrict().catch(function (err) {
    console.warn('[settings] 保存失败：', err && err.message);
    return false;
  });
}

// ---------- 提醒 ----------
function notify(title, body) {
  try {
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return;
    new Notification({ title: title, body: body, icon: loadIcon() }).show();
  } catch (err) {
    console.warn('[notify] 通知失败：', err && err.message);
  }
}

function completedCountOn(dateStr) {
  return tasksCache.filter(function (task) {
    return task && task.done && task.completedOn === dateStr;
  }).length;
}

function checkReminders() {
  if (!ready) return;

  // 2.5.1：合并为单条「每日待办」，仅 17:00–21:59 每小时提醒一次，22:00 后停
  const now = new Date();
  const hour = now.getHours();
  if (hour < 17 || hour >= 22) return;

  const today = todayString();
  const hourKey = today + '-' + String(hour);
  const last = settings.lastReminded || (settings.lastReminded = {});
  if (last.todoHour === hourKey) return; // 同一小时只提醒一次

  const log = logsCache[today];
  const logBlank = !log ||
    (!String(log.progress || '').trim() &&
      !String(log.issues || '').trim() &&
      !String(log.plan || '').trim());

  let dueToday = 0;
  let highDue = 0;
  let overdue = 0;
  tasksCache.forEach(function (task) {
    if (!task || task.done || task.deletedAt) return;
    if (typeof task.dueDate !== 'string') return;
    if (task.dueDate === today) {
      dueToday += 1;
      if (task.priority === 'high') highDue += 1;
    } else if (task.dueDate < today) {
      overdue += 1;
    }
  });

  if (logBlank || dueToday + overdue > 0) {
    const parts = [];
    if (dueToday + overdue > 0) {
      parts.push('今日到期 ' + dueToday + ' 项（高优 ' + highDue + '），逾期 ' + overdue + ' 项');
    }
    if (logBlank) parts.push('日报还没写');
    notify('每日待办提醒', parts.join('；'));
    last.todoHour = hourKey;
    persistSettings();
  }
}

// ---------- 多设备同步（同步码） ----------
async function updateLastSyncAt(ts) {
  if (!syncMetaStore) return;
  try {
    const m = await syncMetaStore.load();
    m.lastSyncAt = ts;
    await syncMetaStore.save(m);
  } catch (e) { /* 忽略持久化失败 */ }
}

async function runSync() {
  if (settings.syncPaused || dataBusy) {
    sendToMain('sync:status', { state: 'paused' });
    return;
  }
  if (!syncBridge || !settings.syncCode || !settings.serverUrl) return;
  // 离线：不静默清空状态，显式告知并附带待推送条数
  if (typeof net.isOnline === 'function' && !net.isOnline()) {
    let pending = 0;
    try { pending = await syncBridge.pendingCount(); } catch (e) { /* 忽略 */ }
    sendToMain('sync:status', { state: 'offline', pending: pending });
    return;
  }
  sendToMain('sync:status', { state: 'syncing' });
  try {
    await syncBridge.syncNow();
    const ts = Date.now();
    await updateLastSyncAt(ts);
    sendToMain('sync:status', { state: 'synced', lastSyncAt: ts, pending: 0 });
  } catch (err) {
    sendToMain('sync:status', { state: 'error', error: (err && err.message) || '同步失败' });
  }
}

function assertWritable(kind) {
  if (dataBusy) throw new Error('正在恢复数据，请稍候再试');
  const st = dataStatus[kind];
  if (!st || !st.corrupt) return;
  const err = new Error(kind === 'tasks' ? '任务数据损坏，请先从备份恢复'
    : kind === 'logs' ? '日报数据损坏，请先从备份恢复'
      : '设置数据损坏，请先从备份恢复');
  err.corrupt = true;
  throw err;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('tasks:load', function () {
    return tasksCache;
  });

  ipcMain.handle('tasks:save', async function (_event, tasks) {
    assertWritable('tasks');
    const list = Array.isArray(tasks) ? tasks : [];
    tasksCache = list;
    await stores.tasks.save(list);
    if (syncBridge) syncBridge.markDirty('tasks');
    return true;
  });

  ipcMain.handle('logs:load', function () {
    return logsCache;
  });

  ipcMain.handle('logs:save', async function (_event, logs) {
    assertWritable('logs');
    logsCache = logs && typeof logs === 'object' ? logs : {};
    await stores.logs.save(logsCache);
    if (syncBridge) syncBridge.markDirty('daily_logs');
    return true;
  });

  ipcMain.handle('settings:load', function () {
    return settings;
  });

  ipcMain.handle('settings:save', async function (_event, next) {
    assertWritable('settings');
    const previous = settings;
    const merged = Object.assign({}, settings, next || {});
    // 壁纸穿透态已移除：清理历史 settings.json 里可能残留的废弃字段
    merged.widget = Object.assign({}, merged.widget || {});
    delete merged.widget.clickThrough;
    settings = merged;
    try {
      await persistSettingsStrict();
    } catch (err) {
      settings = previous;
      throw err;
    }
    applyAllSettings();
    if (syncBridge) syncBridge.markDirty('prefs');
    return settings;
  });

  ipcMain.handle('sync:apply', async function (_event, payload) {
    assertWritable('settings');
    const code = SyncCode.normalizeSyncCode(payload && payload.code);
    const serverUrl = String((payload && payload.serverUrl) || '').trim().replace(/\/$/, '');
    if (!SyncCode.isValidSyncCode(code)) return { ok: false, error: '同步码格式不正确' };
    if (!serverUrl) return { ok: false, error: '请填写服务器地址' };
    const previous = { syncCode: settings.syncCode, serverUrl: settings.serverUrl, syncPaused: settings.syncPaused };
    settings.syncCode = code;
    settings.serverUrl = serverUrl;
    settings.syncPaused = false;
    try {
      await persistSettingsStrict();
    } catch (err) {
      Object.assign(settings, previous);
      return { ok: false, error: '保存同步设置失败：' + (err && err.message || err) };
    }
    if (syncBridge) {
      syncBridge.setAuth(serverUrl, code);
      try { await syncBridge.seedIfFirstSync(); } catch (e) { console.warn('[sync] 首次同步：', e && e.message); }
      await runSync();
    }
    return { ok: true };
  });

  ipcMain.handle('sync:clear', async function () {
    assertWritable('settings');
    const previous = { syncCode: settings.syncCode, serverUrl: settings.serverUrl };
    settings.syncCode = '';
    try {
      await persistSettingsStrict();
    } catch (err) {
      Object.assign(settings, previous);
      return { ok: false, error: '保存同步设置失败：' + (err && err.message || err) };
    }
    if (syncBridge) syncBridge.setAuth('', null);
    sendToMain('sync:status', { state: 'idle' });
    return { ok: true };
  });

  ipcMain.handle('sync:now', async function () {
    await runSync();
    return { ok: true };
  });

  ipcMain.handle('sync:resume', async function () {
    assertWritable('settings');
    const previous = settings.syncPaused;
    settings.syncPaused = false;
    try {
      await persistSettingsStrict();
    } catch (err) {
      settings.syncPaused = previous;
      return { ok: false, error: '保存同步设置失败：' + (err && err.message || err) };
    }
    runSync();
    return { ok: true };
  });

  // ---------- 数据备份 / 恢复 ----------
  ipcMain.handle('backup:list', async function () {
    return {
      ok: true,
      items: await backupManager.list(),
      usage: await backupManager.spaceUsage()
    };
  });

  ipcMain.handle('backup:create', async function () {
    if (dataBusy) return { ok: false, error: '正在恢复数据，请稍候再试' };
    const r = await backupManager.beforeWrite('manual');
    return { ok: true, created: r.created, id: r.id || null };
  });

  ipcMain.handle('backup:restore', async function (_event, id) {
    if (dataBusy) return { ok: false, error: '正在处理另一个恢复任务' };
    const previousPaused = settings.syncPaused;
    dataBusy = true;
    settings.syncPaused = true;
    try {
      const result = await backupManager.restore(id);
      const s = await stores.settings.loadWithStatus();
      dataStatus.settings = s;
      settings = normalizeStartupSettings(s.data || JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
      settings.syncPaused = true;
      await stores.settings.save(settings);
      await syncMetaStore.save(defaultSyncMeta());
      dataStatus.tasks = await stores.tasks.loadWithStatus();
      dataStatus.logs = await stores.logs.loadWithStatus();
      dataStatus.settings = await stores.settings.loadWithStatus();
      tasksCache = dataStatus.tasks.data;
      logsCache = dataStatus.logs.data;
      sendToMain('refresh');
      sendToMain('data:status', dataStatus);
      sendToMain('sync:status', { state: 'paused' });
      return { ok: true, preRestoreId: result.preRestoreId, restoredFiles: result.restoredFiles, syncPaused: true };
    } catch (err) {
      settings.syncPaused = previousPaused;
      sendToMain('sync:status', { state: previousPaused ? 'paused' : 'idle' });
      throw err;
    } finally {
      dataBusy = false;
    }
  });

  ipcMain.handle('backup:export', async function (_event, id, includeSecrets) {
    const out = await backupManager.exportBundle(id, { includeSecrets: !!includeSecrets });
    const picked = await dialog.showSaveDialog({
      defaultPath: out.filename,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(picked.filePath, out.text, 'utf8');
    return { ok: true, path: picked.filePath };
  });

  ipcMain.handle('backup:previewImport', async function (_event, text) {
    const parsed = await backupManager.importBundle(text);
    return { ok: true, summary: parsed.summary };
  });

  ipcMain.handle('backup:import', async function (_event, text) {
    if (dataBusy) return { ok: false, error: '正在处理另一个恢复任务' };
    const parsed = await backupManager.importBundle(text);
    const previousPaused = settings.syncPaused;
    dataBusy = true;
    settings.syncPaused = true;
    try {
      const result = await backupManager.restoreBundle(parsed.bundle);
      const s = await stores.settings.loadWithStatus();
      dataStatus.settings = s;
      settings = normalizeStartupSettings(s.data || JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
      settings.syncPaused = true;
      await stores.settings.save(settings);
      await syncMetaStore.save(defaultSyncMeta());
      dataStatus.tasks = await stores.tasks.loadWithStatus();
      dataStatus.logs = await stores.logs.loadWithStatus();
      dataStatus.settings = await stores.settings.loadWithStatus();
      tasksCache = dataStatus.tasks.data;
      logsCache = dataStatus.logs.data;
      sendToMain('refresh');
      sendToMain('data:status', dataStatus);
      sendToMain('sync:status', { state: 'paused' });
      return {
        ok: true,
        taskCount: parsed.summary.taskCount,
        logDays: parsed.summary.logDays,
        preRestoreId: result.preRestoreId,
        syncPaused: true
      };
    } catch (err) {
      settings.syncPaused = previousPaused;
      sendToMain('sync:status', { state: previousPaused ? 'paused' : 'idle' });
      throw err;
    } finally {
      dataBusy = false;
    }
  });

  ipcMain.handle('backup:openDir', async function () {
    await shell.openPath(path.join(app.getPath('userData'), 'backups'));
    return true;
  });

  ipcMain.handle('backup:exportCorrupt', async function () {
    const userData = app.getPath('userData');
    const names = { tasks: 'tasks.json', logs: 'dailyLogs.json', settings: 'settings.json' };
    const files = {};
    for (const kind of Object.keys(names)) {
      if (!dataStatus[kind] || !dataStatus[kind].corrupt) continue;
      try {
        files[names[kind]] = await fsp.readFile(path.join(userData, names[kind]), 'utf8');
      } catch (e) {
        files[names[kind]] = '';
      }
    }
    if (!Object.keys(files).length) return { ok: false, error: '没有损坏文件' };
    const picked = await dialog.showSaveDialog({
      defaultPath: 'lightframe-corrupt-' + Date.now() + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(picked.filePath, JSON.stringify({
      format: 'lightframe-corrupt', exportedAt: new Date().toISOString(), files
    }, null, 2), 'utf8');
    return { ok: true, path: picked.filePath };
  });

  ipcMain.handle('data:status', function () {
    return dataStatus;
  });

  ipcMain.handle('app:copy', function (_event, text) {
    clipboard.writeText(typeof text === 'string' ? text : String(text == null ? '' : text));
    return true;
  });

  ipcMain.handle('app:quit', function () {
    app.isQuitting = true;
    app.quit();
    return true;
  });

  ipcMain.handle('window:hide', function (event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.hide();
    return true;
  });

  ipcMain.handle('window:show', function () {
    showMainWindow();
    return true;
  });

  // 挂件折叠 / 展开：高度改由渲染端按内容自适应（widget:setHeight），此处仅作兼容空操作
  ipcMain.handle('widget:setExpanded', function () {
    return true;
  });

  // 2.5.1：按内容高度自适应窗口（绕过 resizable:false 限制）
  ipcMain.handle('widget:setHeight', function (_event, h) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const height = Math.max(360, Math.min(820, Math.round(Number(h) || 360)));
    const [w] = mainWindow.getSize();
    try {
      mainWindow.setResizable(true);
      mainWindow.setSize(w, height, false);
      mainWindow.setResizable(false);
    } catch (err) { /* 忽略 */ }
    return true;
  });

  // 复位挂件位置：居中并清空保存的坐标（高度由渲染端自适应，这里保留当前高度）
  ipcMain.handle('widget:resetPosition', function () {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const [w, h] = mainWindow.getSize();
    const area = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.max(0, Math.round((area.width - w) / 2));
    const y = Math.max(0, Math.round((area.height - h) / 2));
    try { mainWindow.setBounds({ x: x, y: y, width: w, height: h }); } catch (err) { /* 忽略 */ }
    if (settings && settings.widget) {
      settings.widget.rect = null;
      persistSettings();
    }
    return true;
  });

  ipcMain.handle('app:open-tab', function (_event, tab) {
    showMainWindow();
    sendToMain('open-tab', tab);
    return true;
  });

  ipcMain.handle('app:set-always-on-top', async function (_event, value) {
    settings.alwaysOnTop = !!value;
    applyAlwaysOnTop(settings.alwaysOnTop);
    await persistSettings();
    return settings.alwaysOnTop;
  });

  ipcMain.handle('app:set-launch-at-login', async function (_event, value) {
    settings.launchAtLogin = !!value;
    applyLoginItem(settings.launchAtLogin);
    await persistSettings();
    return settings.launchAtLogin;
  });

  // 修改全局速记快捷键：注册失败时回退默认键，并把实际生效值回传界面
  ipcMain.handle('app:set-hotkey', async function (_event, value) {
    const applied = applyHotkey(value);
    settings.hotkey = applied.key;
    await persistSettings();
    return applied;
  });

  // 速记框保存后通知主窗口刷新
  ipcMain.handle('app:refresh', function () {
    sendToMain('refresh');
    return true;
  });

  // 读取当前版本号（来自 package.json 的 version 字段）
  ipcMain.handle('app:getVersion', function () {
    return app.getVersion();
  });

  // 检查更新：已接入 electron-updater（v2.6）；未安装依赖时优雅退回占位提示
  ipcMain.handle('app:checkUpdate', function () {
    var v = app.getVersion();
    if (!autoUpdater) {
      return { version: v, available: false, message: '当前版本 v' + v + '；自动更新组件未安装，暂无法检查更新。' };
    }
    try { autoUpdater.checkForUpdates().catch(function () {}); } catch (e) {}
    return { version: v, available: null, message: '正在检查更新…' };
  });
}

// ---------- 启动 ----------
async function bootstrap() {
  const userData = app.getPath('userData');

  backupManager = createBackupManager({
    dataDir: userData,
    backupDir: path.join(userData, 'backups'),
    appVersion: app.getVersion()
  });
  const beforeWrite = function () {
    if (dataBusy || !shouldAutoBackup(settings)) return Promise.resolve();
    return backupManager.beforeWrite('write');
  };

  stores = {
    tasks: createTaskStore(path.join(userData, 'tasks.json'), { beforeWrite: beforeWrite }),
    logs: createLogStore(path.join(userData, 'dailyLogs.json'), { beforeWrite: beforeWrite }),
    settings: createSettingsStore(path.join(userData, 'settings.json'), { beforeWrite: beforeWrite })
  };

  // v3.0：本地 store 不变，新增 SyncEngine 桥接；登录后置 baseUrl/token 才会真正推送
  syncMetaStore = createSyncMetaStore(path.join(userData, 'syncmeta.json'), { beforeWrite: beforeWrite });
  syncBridge = createSyncBridge({
    tasksStore: stores.tasks,
    logsStore: stores.logs,
    settingsStore: stores.settings,
    syncMetaStore: syncMetaStore,
    onError: function (msg) { sendToMain('sync:status', { state: 'error', error: msg }); },
    onConflict: function (info) { sendToMain('sync:conflict', info); }
  });

  const settingsStatus = await stores.settings.loadWithStatus();
  dataStatus.settings = settingsStatus;
  settings = normalizeStartupSettings(settingsStatus.data || JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));

  // 同步码：启动即恢复，使重启后本地改动继续自动同步
  if (settings.syncCode && settings.serverUrl && syncBridge) {
    syncBridge.setAuth(settings.serverUrl, settings.syncCode);
  }
  const tasksStatus = await stores.tasks.loadWithStatus();
  dataStatus.tasks = tasksStatus;
  tasksCache = tasksStatus.data;
  const logsStatus = await stores.logs.loadWithStatus();
  dataStatus.logs = logsStatus;
  logsCache = logsStatus.data;

  ready = true;

  registerIpc();
  createMainWindow();
  // 渲染层订阅 sync:status 后再推送「上次同步时间」，避免事件在订阅前发出被丢弃
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.once('did-finish-load', function () {
      sendToMain('data:status', dataStatus);
      if (settings.syncPaused) sendToMain('sync:status', { state: 'paused' });
      if (!syncMetaStore) return;
      syncMetaStore.load().then(function (m) {
        if (m && m.lastSyncAt) {
          sendToMain('sync:status', { state: 'synced', lastSyncAt: m.lastSyncAt, restored: true });
        }
      }).catch(function () {});
    });
  }
  createTray();
  applyAllSettings();

  setTimeout(checkReminders, 5000);
  reminderTimer = setInterval(checkReminders, REMINDER_INTERVAL);

  // 同步码：启动后补一次，随后每 30s 周期同步（本地改动另有 5s 防抖触发）
  setTimeout(runSync, 2000);
  syncTimer = setInterval(runSync, 30000);
}

if (gotLock) {
  app.whenReady().then(bootstrap).catch(function (err) {
    console.error('[boot] 启动失败：', err);
  });
}

// 托盘常驻：有窗口关闭不退出
app.on('window-all-closed', function () {
  // 故意留空：靠托盘右键“退出”结束进程
});

app.on('activate', function () {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else showMainWindow();
});

app.on('before-quit', function () {
  app.isQuitting = true;
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    /* 忽略 */
  }
});
