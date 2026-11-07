// 端到端联调：真实 server-lite + 两个独立 SyncEngine（模拟两台设备）
// 验证 wire 协议、LWW 合并、游标推进与离线补传确实可用。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./server.js');
const Sync = require('../src/sync.js');

const CODE = 'ABCDEFGHJKMNPQRS';

function makeDevice(initialTasks) {
  const local = { tasks: initialTasks || [], daily_logs: [], prefs: [] };
  const meta = {
    tasks: { lastPull: 0, pushCursor: 0 },
    daily_logs: { lastPull: 0, pushCursor: 0 },
    prefs: { lastPull: 0, pushCursor: 0 }
  };
  const errors = [];
  const engine = new Sync.SyncEngine({
    token: CODE,
    getLocal: async (t) => local[t],
    putLocal: async (t, rows) => { local[t] = rows; },
    getMeta: async () => meta,
    setMeta: async (m) => Object.assign(meta, m),
    onError: (msg) => errors.push(msg),
    debounceMs: 0
  });
  return { engine, local, meta, errors };
}

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-e2e-'));
  const server = http.createServer(createApp({ dataDir }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { return await fn(base); }
  finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function connect(device, base) {
  device.engine.baseUrl = base;
  device.engine.setToken(CODE);
}

test('两台设备通过同一同步码双向同步，冲突取较新版本', async function () {
  await withServer(async (base) => {
    const a = makeDevice([{ id: 't1', title: '来自A', updatedAt: 100 }]);
    const b = makeDevice([]);
    connect(a, base); connect(b, base);

    await a.engine.syncNow();
    await b.engine.syncNow();
    let onB = b.local.tasks.find((t) => t.id === 't1');
    assert.ok(onB, 'B 应拉到 A 的任务');
    assert.equal(onB.title, '来自A');

    // B 改成较新版本，A 再次同步应取到新版本
    b.local.tasks = [{ id: 't1', title: 'B改过', updatedAt: 200 }];
    await b.engine.syncNow();
    await a.engine.syncNow();
    const onA = a.local.tasks.find((t) => t.id === 't1');
    assert.equal(onA.title, 'B改过', 'LWW 应让 updatedAt 更大的版本胜出');

    // 较旧的写入不能回退服务端
    a.local.tasks = [{ id: 't1', title: '旧版本', updatedAt: 150 }];
    a.meta.tasks.pushCursor = 0;
    await a.engine.syncNow();
    const c = makeDevice([]);
    connect(c, base);
    await c.engine.syncNow();
    assert.equal(c.local.tasks.find((t) => t.id === 't1').title, 'B改过');
  });
});

test('离线期间的本地改动在恢复后自动补传', async function () {
  await withServer(async (base) => {
    const a = makeDevice([{ id: 'offline-1', title: '离线写的', updatedAt: 100 }]);
    connect(a, base);
    // 先指向不可达端口，模拟离线
    a.engine.baseUrl = 'http://127.0.0.1:1';
    await a.engine.syncNow();
    assert.ok(a.errors.length > 0, '离线应产生可上报的错误，而不是静默');

    a.engine.baseUrl = base;
    const b = makeDevice([]);
    connect(b, base);
    await a.engine.syncNow();
    await b.engine.syncNow();
    assert.ok(b.local.tasks.some((t) => t.id === 'offline-1'), '恢复后应补传离线改动');
  });
});

test('第三台设备用不同同步码看不到同一空间的数据', async function () {
  await withServer(async (base) => {
    const a = makeDevice([{ id: 'secret', title: '私有', updatedAt: 100 }]);
    connect(a, base);
    await a.engine.syncNow();

    const c = makeDevice([]);
    c.engine.baseUrl = base;
    c.engine.setToken('123456789ABCDEFG');
    await c.engine.syncNow();
    assert.equal(c.local.tasks.length, 0, '不同同步码的空间必须隔离');
  });
});
