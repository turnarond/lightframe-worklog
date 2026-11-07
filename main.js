// main —— Electron 主进程：窗口、托盘、全局快捷键、提醒、数据 IPC
'use strict';

const path = require('node:path');
const fs = require('node:fs');
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
  net
} = require('electron');

const { createTaskStore, createLogStore, createSettingsStore, createSyncMetaStore, DEFAULT_SETTINGS } =
  require('./src/store.js');
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

function persistSettings() {
  if (!stores) return Promise.resolve();
  return stores.settings.save(settings).catch(function (err) {
    console.warn('[settings] 保存失败：', err && err.message);
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

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('tasks:load', function () {
    return tasksCache;
  });

  ipcMain.handle('tasks:save', async function (_event, tasks) {
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
    logsCache = logs && typeof logs === 'object' ? logs : {};
    await stores.logs.save(logsCache);
    if (syncBridge) syncBridge.markDirty('daily_logs');
    return true;
  });

  ipcMain.handle('settings:load', function () {
    return settings;
  });

  ipcMain.handle('settings:save', async function (_event, next) {
    const merged = Object.assign({}, settings, next || {});
    // 壁纸穿透态已移除：清理历史 settings.json 里可能残留的废弃字段
    merged.widget = Object.assign({}, merged.widget || {});
    delete merged.widget.clickThrough;
    settings = merged;
    await persistSettings();
    applyAllSettings();
    if (syncBridge) syncBridge.markDirty('prefs');
    return settings;
  });

  // ---------- 多设备同步（同步码） ----------
  async function runSync() {
    if (!syncBridge || !settings.syncCode || !settings.serverUrl) return;
    try {
      if (typeof net.isOnline === 'function' && !net.isOnline()) return;
      await syncBridge.syncNow();
      sendToMain('sync:status', { ok: true });
    } catch (err) {
      sendToMain('sync:status', { ok: false, error: (err && err.message) || '同步失败' });
    }
  }

  ipcMain.handle('sync:apply', async function (_event, payload) {
    const code = SyncCode.normalizeSyncCode(payload && payload.code);
    const serverUrl = String((payload && payload.serverUrl) || '').trim().replace(/\/$/, '');
    if (!SyncCode.isValidSyncCode(code)) return { ok: false, error: '同步码格式不正确' };
    if (!serverUrl) return { ok: false, error: '请填写服务器地址' };
    settings.syncCode = code;
    settings.serverUrl = serverUrl;
    await persistSettings();
    if (syncBridge) {
      syncBridge.setAuth(serverUrl, code);
      try { await syncBridge.seedIfFirstSync(); } catch (e) { console.warn('[sync] 首次同步：', e && e.message); }
      await runSync();
    }
    return { ok: true };
  });

  ipcMain.handle('sync:clear', async function () {
    settings.syncCode = '';
    await persistSettings();
    if (syncBridge) syncBridge.setAuth('', null);
    sendToMain('sync:status', { ok: true });
    return { ok: true };
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

  stores = {
    tasks: createTaskStore(path.join(userData, 'tasks.json')),
    logs: createLogStore(path.join(userData, 'dailyLogs.json')),
    settings: createSettingsStore(path.join(userData, 'settings.json'))
  };

  // v3.0：本地 store 不变，新增 SyncEngine 桥接；登录后置 baseUrl/token 才会真正推送
  syncBridge = createSyncBridge({
    tasksStore: stores.tasks,
    logsStore: stores.logs,
    settingsStore: stores.settings,
    syncMetaStore: createSyncMetaStore(path.join(userData, 'syncmeta.json')),
    onError: function (msg) { sendToMain('sync:status', { ok: false, error: msg }); }
  });

  try {
    settings = await stores.settings.load();
  } catch (err) {
    console.warn('[settings] 读取失败，使用默认值：', err && err.message);
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  // 清理历史 settings.json 中已废弃的壁纸穿透字段；窗口始终以普通可交互形态启动。
  settings = normalizeStartupSettings(settings);

  // 同步码：启动即恢复，使重启后本地改动继续自动同步
  if (settings.syncCode && settings.serverUrl && syncBridge) {
    syncBridge.setAuth(settings.serverUrl, settings.syncCode);
  }
  try {
    tasksCache = await stores.tasks.load();
  } catch (err) {
    console.warn('[tasks] 读取失败：', err && err.message);
    tasksCache = [];
  }
  try {
    logsCache = await stores.logs.load();
  } catch (err) {
    console.warn('[logs] 读取失败：', err && err.message);
    logsCache = {};
  }

  ready = true;

  registerIpc();
  createMainWindow();
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
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    /* 忽略 */
  }
});
