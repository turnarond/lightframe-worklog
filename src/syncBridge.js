// syncBridge.js —— 把本地 store（任务/日志/设置）接成 SyncEngine 的适配器
'use strict';

const Sync = require('./sync.js');

// 仅这些偏好上云；挂件坐标/透明度/穿透/快捷键/开机自启等本机专属不同步
const SYNCABLE_PREFS = ['categories', 'defaultPriority', 'defaultView', 'theme'];

function prefsToRows(settings) {
  return SYNCABLE_PREFS.map(function (k) {
    return { key: k, value: settings ? settings[k] : undefined, updatedAt: Date.now() };
  });
}

function applyPrefsRows(settings, rows) {
  (rows || []).forEach(function (r) {
    if (r && SYNCABLE_PREFS.indexOf(r.key) >= 0) settings[r.key] = r.value;
  });
  return settings;
}

/**
 * 创建同步桥：持有 SyncEngine 与本地 store 适配器。
 * @param {object} opts
 *   tasksStore / logsStore / settingsStore / syncMetaStore （来自 store.js）
 *   fetchImpl / debounceMs （可选，传给 SyncEngine）
 *   engine （可选，测试可注入假引擎）
 * @returns {{ engine, markDirty, setAuth, syncNow, onOnline }}
 */
function createSyncBridge(opts) {
  opts = opts || {};
  const tasksStore = opts.tasksStore;
  const logsStore = opts.logsStore;
  const settingsStore = opts.settingsStore;
  const syncMetaStore = opts.syncMetaStore;

  const getLocal = async function (type) {
    if (type === 'tasks') return tasksStore.load();
    if (type === 'daily_logs') return Object.values(await logsStore.load());
    if (type === 'prefs') return prefsToRows(await settingsStore.load());
    return [];
  };

  const putLocal = async function (type, rows) {
    if (type === 'tasks') return tasksStore.save(rows);
    if (type === 'daily_logs') {
      const map = {};
      (rows || []).forEach(function (r) { if (r && r.date) map[r.date] = r; });
      return logsStore.save(map);
    }
    if (type === 'prefs') {
      const s = await settingsStore.load();
      return settingsStore.save(applyPrefsRows(s, rows));
    }
    return undefined;
  };

  const engine = opts.engine || new Sync.SyncEngine({
    getLocal: getLocal,
    putLocal: putLocal,
    getMeta: () => syncMetaStore.load(),
    setMeta: (m) => syncMetaStore.save(m),
    fetchImpl: opts.fetchImpl,
    debounceMs: opts.debounceMs
  });

  function markDirty(type) {
    // 未登录（无 baseUrl / token）不同步，避免后台报错
    if (!engine.baseUrl || !engine.token) return;
    engine.markDirty(type);
  }

  function setAuth(baseUrl, token) {
    engine.baseUrl = (baseUrl || '').replace(/\/$/, '');
    engine.setToken(token);
  }

  return {
    engine: engine,
    markDirty: markDirty,
    setAuth: setAuth,
    syncNow: function () { return engine.syncNow(); },
    onOnline: function () { return engine.onOnline(); }
  };
}

module.exports = {
  createSyncBridge: createSyncBridge,
  SYNCABLE_PREFS: SYNCABLE_PREFS
};
