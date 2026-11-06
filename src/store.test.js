// store 单元测试 —— 真实文件读写（os.tmpdir），不依赖 Electron
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('./store.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-'));
}

function writeRaw(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

test('DEFAULT_SETTINGS: 与 SPEC §3 一致', () => {
  assert.deepEqual(S.DEFAULT_SETTINGS.categories, ['工作', '会议', '其他']);
  assert.equal(S.DEFAULT_SETTINGS.lastCategory, '工作');
  assert.equal(S.DEFAULT_SETTINGS.launchAtLogin, true);
  assert.equal(S.DEFAULT_SETTINGS.alwaysOnTop, true);
  assert.equal(S.DEFAULT_SETTINGS.closeToTray, true);
  assert.equal(S.DEFAULT_SETTINGS.hotkey, 'Ctrl+Shift+Space');
  assert.deepEqual(S.DEFAULT_SETTINGS.lastReminded, {});
  assert.deepEqual(S.DEFAULT_SETTINGS.weeklyPlans, {});
  assert.deepEqual(S.DEFAULT_SETTINGS.widget, {
    opacity: 0.9,
    blur: 14,
    expanded: false,
    rect: null,
    scale: 1
  });
});

// ---------- 缺失文件 ----------

test('任务 store: 文件不存在 → 空数组', async () => {
  const store = S.createTaskStore(path.join(tmpDir(), 'tasks.json'));
  assert.deepEqual(await store.load(), []);
});

test('日志 store: 文件不存在 → 空对象', async () => {
  const store = S.createLogStore(path.join(tmpDir(), 'daily-logs.json'));
  assert.deepEqual(await store.load(), {});
});

test('设置 store: 文件不存在 → 默认设置（深拷贝，不共享引用）', async () => {
  const store = S.createSettingsStore(path.join(tmpDir(), 'settings.json'));
  const settings = await store.load();
  assert.deepEqual(settings, S.DEFAULT_SETTINGS);
  settings.categories.push('被污染');
  assert.deepEqual(S.DEFAULT_SETTINGS.categories, ['工作', '会议', '其他']);
});

// ---------- 存取往返 ----------

test('任务 store: 保存后可原样读回（含自动建目录）', async () => {
  const file = path.join(tmpDir(), 'deep', 'nested', 'tasks.json');
  const store = S.createTaskStore(file);
  const tasks = [
    {
      id: 'a1', title: '写日报', category: '工作', priority: 'high', dueDate: '2026-10-31',
      done: false, createdAt: '2026-10-30T01:00:00.000Z', completedAt: null, completedOn: null
    }
  ];
  await store.save(tasks);
  assert.ok(fs.existsSync(file), '父目录被递归创建');
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].title, '写日报');
  assert.equal(loaded[0].category, '工作');
  assert.equal(loaded[0].dueDate, '2026-10-31');
});

test('任务 store: 保存为 2 空格缩进的 JSON', async () => {
  const file = path.join(tmpDir(), 'tasks.json');
  await S.createTaskStore(file).save([{ title: '缩进' }]);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('\n  {\n'), '带缩进的排版');
});

test('任务 store: 再次保存覆盖旧内容', async () => {
  const file = path.join(tmpDir(), 'tasks.json');
  const store = S.createTaskStore(file);
  await store.save([{ title: '旧的' }]);
  await store.save([{ title: '新的' }]);
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].title, '新的');
});

test('日志 store: 保存后可原样读回', async () => {
  const file = path.join(tmpDir(), 'logs', 'daily-logs.json');
  const store = S.createLogStore(file);
  const logs = {
    '2026-10-31': {
      date: '2026-10-31', progress: '推进', issues: '无', plan: '明天',
      updatedAt: '2026-10-31T09:00:00.000Z'
    }
  };
  await store.save(logs);
  const loaded = await store.load();
  assert.equal(loaded['2026-10-31'].updatedAt, Date.parse('2026-10-31T09:00:00.000Z'), 'updatedAt 兼容 ISO 并转为毫秒');
});

test('设置 store: 保存后可原样读回', async () => {
  const file = path.join(tmpDir(), 'settings.json');
  const store = S.createSettingsStore(file);
  const next = Object.assign({}, S.DEFAULT_SETTINGS, { alwaysOnTop: true, hotkey: 'Alt+Space' });
  await store.save(next);
  const loaded = await store.load();
  assert.equal(loaded.alwaysOnTop, true);
  assert.equal(loaded.hotkey, 'Alt+Space');
});

// ---------- 容错 ----------

test('损坏 JSON → 各自安全默认，不抛错', async () => {
  const dir = tmpDir();
  const tasksFile = path.join(dir, 'tasks.json');
  const logsFile = path.join(dir, 'logs.json');
  const settingsFile = path.join(dir, 'settings.json');
  writeRaw(tasksFile, '{ 这不是 JSON');
  writeRaw(logsFile, '[1,2,3');
  writeRaw(settingsFile, 'null');

  assert.deepEqual(await S.createTaskStore(tasksFile).load(), []);
  assert.deepEqual(await S.createLogStore(logsFile).load(), {});
  assert.deepEqual(await S.createSettingsStore(settingsFile).load(), S.DEFAULT_SETTINGS);
});

test('顶层类型不对 → 安全默认', async () => {
  const dir = tmpDir();
  const tasksFile = path.join(dir, 'tasks.json');
  const logsFile = path.join(dir, 'logs.json');
  const settingsFile = path.join(dir, 'settings.json');
  writeRaw(tasksFile, '{"a":1}');
  writeRaw(logsFile, '[1,2,3]');
  writeRaw(settingsFile, '["数组"]');

  assert.deepEqual(await S.createTaskStore(tasksFile).load(), []);
  assert.deepEqual(await S.createLogStore(logsFile).load(), {});
  assert.deepEqual(await S.createSettingsStore(settingsFile).load(), S.DEFAULT_SETTINGS);
});

test('任务 store: 读取时过滤脏数据并补全字段', async () => {
  const file = path.join(tmpDir(), 'tasks.json');
  writeRaw(file, JSON.stringify([
    { title: '正常', priority: 'high' },
    { title: '   ' },
    null,
    'garbage',
    { id: 'ok', title: '也正常', category: '会议', done: true, completedOn: '2026-10-31' }
  ]));
  const loaded = await S.createTaskStore(file).load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].title, '正常');
  assert.equal(loaded[0].category, '未分类');
  assert.ok(loaded[0].id);
  assert.equal(loaded[1].category, '会议');
  assert.equal(loaded[1].completedOn, '2026-10-31');
});

// ---------- 设置合并 ----------

test('设置 store: 旧文件缺字段时保留默认值（浅层 + 嵌套）', async () => {
  const file = path.join(tmpDir(), 'settings.json');
  writeRaw(file, JSON.stringify({
    categories: ['只改这个'],
    lastReminded: { daily: '2026-10-30' }
  }));
  const s = await S.createSettingsStore(file).load();
  assert.deepEqual(s.categories, ['只改这个']);
  assert.deepEqual(s.lastReminded, { daily: '2026-10-30' });
  assert.deepEqual(s.weeklyPlans, {});
  assert.equal(s.hotkey, 'Ctrl+Shift+Space');
});

// ---------- Task 7: 同步字段 (updatedAt/deletedAt) + SyncMeta ----------

const TM = require('./taskModel.js');

test('createTask: 带数字毫秒 updatedAt + deletedAt:null', () => {
  const t = TM.createTask({ title: 'x' });
  assert.equal(typeof t.updatedAt, 'number');
  assert.ok(t.updatedAt > 0);
  assert.equal(t.deletedAt, null);
});

test('任务 store: save→load 产出数字 updatedAt 且默认 deletedAt:null（同步边界兜底）', async () => {
  const file = path.join(tmpDir(), 'tasks.json');
  const store = S.createTaskStore(file);
  await store.save([{ title: 'x' }]);          // 不显式给 updatedAt
  const [t] = await store.load();
  assert.equal(typeof t.updatedAt, 'number');
  assert.ok(t.updatedAt > 0, '缺省 updatedAt 在保存时被补上');
  assert.equal(t.deletedAt, null);
});

test('normalizeTask: updatedAt 兼容 ISO，deletedAt 缺省为 null', () => {
  const t = TM.normalizeTask({ title: 'y', updatedAt: '2026-11-01T00:00:00.000Z', deletedAt: null });
  assert.equal(t.updatedAt, Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal(t.deletedAt, null);
  const t2 = TM.normalizeTask({ title: 'z' });
  assert.equal(typeof t2.updatedAt, 'number');
  assert.equal(t2.deletedAt, null);
});

test('deleteTask: 软删——保留对象并置数字 deletedAt', () => {
  const list = [TM.createTask({ title: 'a' }), TM.createTask({ title: 'b' })];
  const id = list[0].id;
  const out = TM.deleteTask(list, id);
  assert.equal(out.length, 2, '不移除对象');
  assert.equal(out[0].id, id);
  assert.ok(typeof out[0].deletedAt === 'number' && out[0].deletedAt > 0);
  assert.equal(list[0].deletedAt, null, '原数组不被改动');
});

test('任务 store: 软删墓碑 save→load 保留 deletedAt（同步删除跨端传播）', async () => {
  const file = path.join(tmpDir(), 'tasks.json');
  const store = S.createTaskStore(file);
  await store.save([{ id: 'k1', title: 'x', updatedAt: 100, deletedAt: 200 }]);
  const [t] = await store.load();
  assert.equal(t.deletedAt, 200, '墓碑 deletedAt 被持久化');
  assert.equal(t.updatedAt, 100);
});

test('SyncMeta store: 默认值 + 持久化往返', async () => {
  const file = path.join(tmpDir(), 'syncmeta.json');
  const store = S.createSyncMetaStore(file);
  const fresh = await store.load();
  assert.deepEqual(fresh.tasks, { lastPull: 0, pushCursor: 0 });
  fresh.tasks.pushCursor = 123;
  await store.save(fresh);
  const reloaded = await store.load();
  assert.equal(reloaded.tasks.pushCursor, 123);
  assert.deepEqual(reloaded.daily_logs, { lastPull: 0, pushCursor: 0 });
});

test('SyncMeta store: 忽略未知类型，保留已知类型', async () => {
  const file = path.join(tmpDir(), 'syncmeta2.json');
  writeRaw(file, JSON.stringify({ tasks: { lastPull: 5, pushCursor: 9 }, bogus: { x: 1 } }));
  const m = await S.createSyncMetaStore(file).load();
  assert.equal(m.tasks.lastPull, 5);
  assert.equal(m.tasks.pushCursor, 9);
  assert.equal(m.prefs.pushCursor, 0);
});

