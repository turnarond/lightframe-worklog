// syncBridge 单元测试：markDirty 委托 + 三类适配器（tasks/daily_logs/prefs）往返
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('./store.js');
const SB = require('./syncBridge.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'syncbridge-'));
}
function fakeEngine() {
  return {
    baseUrl: '', token: null, calls: [],
    markDirty(t) { this.calls.push(t); },
    setToken(t) { this.token = t; },
    syncNow() { return Promise.resolve(); }
  };
}
function noopFetch() { return Promise.resolve({ ok: false, status: 0, json: {} }); }

function buildBridge(dir, engine) {
  return SB.createSyncBridge({
    tasksStore: Store.createTaskStore(path.join(dir, 'tasks.json')),
    logsStore: Store.createLogStore(path.join(dir, 'logs.json')),
    settingsStore: Store.createSettingsStore(path.join(dir, 'settings.json')),
    syncMetaStore: Store.createSyncMetaStore(path.join(dir, 'meta.json')),
    engine: engine,
    fetchImpl: noopFetch
  });
}

test('未登录时 markDirty 不触发引擎', () => {
  const e = fakeEngine();
  buildBridge(tmpDir(), e).markDirty('tasks');
  assert.equal(e.calls.length, 0);
});

test('设置 auth 后 markDirty 委托给引擎', () => {
  const e = fakeEngine();
  const bridge = buildBridge(tmpDir(), e);
  bridge.setAuth('https://s.example', 'TK');
  bridge.markDirty('tasks');
  assert.deepEqual(e.calls, ['tasks']);
  assert.equal(bridge.engine.baseUrl, 'https://s.example');
  assert.equal(bridge.engine.token, 'TK');
});

test('tasks 适配器: getLocal/putLocal 往返', async () => {
  const bridge = buildBridge(tmpDir());
  await bridge.engine.putLocal('tasks', [{ id: 'a', title: 'x', updatedAt: 10, deletedAt: null }]);
  const rows = await bridge.engine.getLocal('tasks');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'a');
});

test('daily_logs 适配器: 写入为对象 map，读出为数组', async () => {
  const dir = tmpDir();
  const logsStore = Store.createLogStore(path.join(dir, 'logs.json'));
  const bridge = SB.createSyncBridge({
    tasksStore: Store.createTaskStore(path.join(dir, 'tasks.json')),
    logsStore: logsStore,
    settingsStore: Store.createSettingsStore(path.join(dir, 'settings.json')),
    syncMetaStore: Store.createSyncMetaStore(path.join(dir, 'meta.json')),
    fetchImpl: noopFetch
  });
  await bridge.engine.putLocal('daily_logs', [{ date: '2026-11-01', progress: 'p', updatedAt: 10, deletedAt: null }]);
  const map = await logsStore.load();
  assert.equal(typeof map['2026-11-01'], 'object', '底层以日期为键的对象存储');
  const rows = await bridge.engine.getLocal('daily_logs');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-11-01');
});

test('prefs 适配器: 仅同步内容子集，回写不污染本机项', async () => {
  const dir = tmpDir();
  const settingsStore = Store.createSettingsStore(path.join(dir, 'settings.json'));
  await settingsStore.save({ categories: ['工作', '生活'], defaultPriority: 'high', rect: { x: 1 }, opacity: 0.9 });
  const bridge = SB.createSyncBridge({
    tasksStore: Store.createTaskStore(path.join(dir, 'tasks.json')),
    logsStore: Store.createLogStore(path.join(dir, 'logs.json')),
    settingsStore: settingsStore,
    syncMetaStore: Store.createSyncMetaStore(path.join(dir, 'meta.json')),
    fetchImpl: noopFetch
  });
  const rows = await bridge.engine.getLocal('prefs');
  const keys = rows.map(function (r) { return r.key; });
  assert.ok(keys.indexOf('categories') >= 0, 'categories 应同步');
  assert.ok(keys.indexOf('defaultPriority') >= 0, 'defaultPriority 应同步');
  assert.ok(keys.indexOf('rect') < 0, '本机项 rect 不同步');
  assert.ok(keys.indexOf('opacity') < 0, '本机项 opacity 不同步');

  await bridge.engine.putLocal('prefs', [{ key: 'categories', value: ['会议'], updatedAt: 1 }]);
  const s = await settingsStore.load();
  assert.deepEqual(s.categories, ['会议'], '云端 categories 回写生效');
  assert.equal(s.rect.x, 1, '本机项 rect 不受影响');
});

test('SYNCABLE_PREFS 不含本机专属键', () => {
  const bad = ['rect', 'opacity', 'blur', 'clickThrough', 'expanded'];
  bad.forEach(function (k) {
    assert.ok(SB.SYNCABLE_PREFS.indexOf(k) < 0, k + ' 不应上云');
  });
});

test('prefs LWW 回归: 远端较新的偏好在 pull 时被采纳', async () => {
  const dir = tmpDir();
  const settingsStore = Store.createSettingsStore(path.join(dir, 'settings.json'));
  await settingsStore.save({ categories: ['本地'], defaultPriority: 'mid' });
  const bridge = SB.createSyncBridge({
    tasksStore: Store.createTaskStore(path.join(dir, 'tasks.json')),
    logsStore: Store.createLogStore(path.join(dir, 'logs.json')),
    settingsStore: settingsStore,
    syncMetaStore: Store.createSyncMetaStore(path.join(dir, 'meta.json')),
    fetchImpl: async function (method, url) {
      if (method === 'GET' && url.indexOf('/pull') >= 0) {
        return {
          ok: true, status: 200,
          json: { server_time: 5000, changes: [
            { type: 'prefs', key: 'categories', value: ['云端'], updatedAt: 4000, deletedAt: null }
          ] }
        };
      }
      return { ok: true, status: 200, json: { server_time: 5000 } };
    }
  });
  bridge.setAuth('https://s.example', 'TK');
  await bridge.syncNow();
  const s = await settingsStore.load();
  assert.deepEqual(s.categories, ['云端'], '远端较新偏好应被 pull 采纳（修复前会被本机值覆盖）');
});

test('seedIfFirstSync: 首次登录清空游标并全量推送，之后不再 seed（Task 11）', async () => {
  const dir = tmpDir();
  const tasksStore = Store.createTaskStore(path.join(dir, 'tasks.json'));
  await tasksStore.save([{ id: 'a', title: 'x', updatedAt: 50, deletedAt: null }]);
  let pushBody = null;
  const fetchImpl = async function (method, url, body) {
    if (method === 'GET' && url.indexOf('/pull') >= 0) {
      return { ok: true, status: 200, json: { server_time: 100, changes: [] } };
    }
    if (method === 'POST' && url.indexOf('/push') >= 0) { pushBody = body; return { ok: true, status: 200, json: { server_time: 100 } }; }
    return { ok: true, status: 200, json: {} };
  };
  const bridge = SB.createSyncBridge({
    tasksStore: tasksStore,
    logsStore: Store.createLogStore(path.join(dir, 'logs.json')),
    settingsStore: Store.createSettingsStore(path.join(dir, 'settings.json')),
    syncMetaStore: Store.createSyncMetaStore(path.join(dir, 'meta.json')),
    fetchImpl: fetchImpl
  });
  const first = await bridge.seedIfFirstSync();
  assert.equal(first, true, '首次应触发 seed');
  assert.ok(pushBody, '应推送本地数据');
  assert.equal(pushBody.changes[0].id, 'a', '全量推送包含本地任务');
  const meta = await bridge.engine.getMeta();
  assert.equal(meta.tasks.pushCursor, 100, '推送后游标推进');
  const second = await bridge.seedIfFirstSync();
  assert.equal(second, false, '已同步过，不再 seed');
});
