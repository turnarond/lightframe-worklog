// syncBridge.js —— 把本地 store（任务/日志/设置）接成 SyncEngine 的适配器
'use strict';

const Sync = require('./sync.js');

// 仅这些偏好上云；挂件坐标/透明度/穿透/快捷键/开机自启等本机专属不同步
const SYNCABLE_PREFS = ['categories', 'defaultPriority', 'defaultView', 'theme'];

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

  // 每个同步偏好键的真实改动时间戳（LWW 用）。持久化在 sync meta 的 prefsTs 中，
  // 这样 pull 时本地偏好按"真实改动时间"比较，云端较新的偏好才不会被丢弃。
  let prefsTs = {};

  function prefsToRows(settings) {
    return SYNCABLE_PREFS.map(function (k) {
      return { key: k, value: settings ? settings[k] : undefined, updatedAt: prefsTs[k] || 0 };
    });
  }

  function applyPrefsRows(settings, rows) {
    (rows || []).forEach(function (r) {
      if (r && SYNCABLE_PREFS.indexOf(r.key) >= 0 && r.value !== undefined) settings[r.key] = r.value;
    });
    return settings;
  }

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

  // 包装 meta 读写，额外持久化 prefsTs
  const getMeta = async function () {
    const m = await syncMetaStore.load();
    if (m && m.prefsTs) prefsTs = m.prefsTs;
    return m;
  };
  const setMeta = async function (m) {
    m.prefsTs = prefsTs;
    return syncMetaStore.save(m);
  };

  const engine = opts.engine || new Sync.SyncEngine({
    getLocal: getLocal,
    putLocal: putLocal,
    getMeta: getMeta,
    setMeta: setMeta,
    fetchImpl: opts.fetchImpl,
    debounceMs: opts.debounceMs
  });

  // 记录当前同步偏好键的改动时间戳（仅当用户真实改了偏好时）
  async function recordPrefsTs() {
    const s = await settingsStore.load();
    const now = Date.now();
    SYNCABLE_PREFS.forEach(function (k) {
      if (s && s[k] !== undefined) prefsTs[k] = now;
    });
  }

  function markDirty(type) {
    // 未登录（无 baseUrl / token）不同步，避免后台报错
    if (!engine.baseUrl || !engine.token) return;
    if (type === 'prefs') {
      // 先打真实时间戳，再委托引擎调度
      recordPrefsTs().then(function () { engine.markDirty(type); });
      return;
    }
    engine.markDirty(type);
  }

  function setAuth(baseUrl, token) {
    engine.baseUrl = (baseUrl || '').replace(/\/$/, '');
    engine.setToken(token);
  }

  // 是否已「从未同步过」：所有类型的游标都还是 0
  async function isNeverSynced() {
    const meta = await getMeta();
    return Sync.TYPES.every(function (t) {
      const m = meta[t];
      return !m || (!m.lastPull && !m.pushCursor);
    });
  }

  // 首次登录：清空游标让全量本地数据被推送，再拉一次云端（获取已有数据）
  async function seedIfFirstSync() {
    if (!(await isNeverSynced())) return false;
    const meta = await getMeta();
    Sync.TYPES.forEach(function (t) { meta[t] = { lastPull: 0, pushCursor: 0 }; });
    await setMeta(meta);
    // 首次 seed 需把偏好也纳入推送：打上真实改动时间戳（否则 prefs updatedAt=0 会被 dirtyDiff 排除）
    await recordPrefsTs();
    await engine.syncNow();
    return true;
  }

  return {
    engine: engine,
    markDirty: markDirty,
    setAuth: setAuth,
    seedIfFirstSync: seedIfFirstSync,
    syncNow: function () { return engine.syncNow(); },
    onOnline: function () { return engine.onOnline(); }
  };
}

module.exports = {
  createSyncBridge: createSyncBridge,
  SYNCABLE_PREFS: SYNCABLE_PREFS
};
