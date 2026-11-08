// 局域网端到端验证：真实 HTTP + 两个独立 SyncEngine（模拟两台设备）
// 用法：
//   node tools/verify-lan.js --self-host          # 自带临时服务端，经本机局域网 IP 实测
//   node tools/verify-lan.js http://192.168.31.32:8080   # 验证已部署的目标机
// 每次用全新同步码，不污染已有空间。
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server-lite/server.js');
const Sync = require('../src/sync.js');
const SyncCode = require('../src/syncCode.js');

const selfHost = process.argv.indexOf('--self-host') >= 0;
const explicit = process.argv.slice(2).filter((a) => a.indexOf('--') !== 0)[0];
let baseUrl = (explicit || 'http://127.0.0.1:8080').replace(/\/$/, '');
let cleanupHost = null;
const CODE = SyncCode.generateSyncCode();
const OTHER_CODE = SyncCode.generateSyncCode();

function makeDevice(initialTasks) {
  const local = { tasks: initialTasks || [], daily_logs: [], prefs: [] };
  const meta = {
    tasks: { lastPull: 0, pushCursor: 0 },
    daily_logs: { lastPull: 0, pushCursor: 0 },
    prefs: { lastPull: 0, pushCursor: 0 }
  };
  const errors = [];
  const engine = new Sync.SyncEngine({
    baseUrl: baseUrl,
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

function check(ok, label) {
  if (!ok) throw new Error('FAIL: ' + label);
  console.log('PASS ' + label);
}

function lanIps() {
  const out = [];
  Object.keys(os.networkInterfaces()).forEach(function (name) {
    (os.networkInterfaces()[name] || []).forEach(function (i) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    });
  });
  return out;
}

// 无目标机时，在本机 0.0.0.0 起一个临时服务端，并经由局域网 IP（而非 127.0.0.1）访问
async function startSelfHost() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-lan-verify-'));
  const server = http.createServer(createApp({ dataDir: dir }));
  await new Promise(function (resolve) { server.listen(0, '0.0.0.0', resolve); });
  const port = server.address().port;
  const ip = lanIps()[0] || '127.0.0.1';
  return {
    url: 'http://' + ip + ':' + port,
    close: function () {
      return new Promise(function (resolve) { server.close(resolve); }).then(function () {
        fs.rmSync(dir, { recursive: true, force: true });
      });
    }
  };
}

async function main() {
  if (selfHost) {
    const host = await startSelfHost();
    baseUrl = host.url;
    cleanupHost = host.close;
    console.log('模式: 自带临时服务端（经本机局域网 IP，非 loopback）');
  }
  console.log('目标:', baseUrl);
  console.log('本机局域网 IP:', lanIps().join(', ') || '(无)');

  const healthRes = await fetch(baseUrl + '/api/health');
  check(healthRes.ok, 'health 可访问 (HTTP ' + healthRes.status + ')');
  const health = await healthRes.json();
  check(health.ok === true, 'health 返回 ok');

  // 设备 A 写入 → 设备 B 拉取
  const a = makeDevice([{ id: 'lan-verify-1', title: '来自A', updatedAt: Date.now() }]);
  const b = makeDevice([]);
  await a.engine.syncNow();
  await b.engine.syncNow();
  check(b.local.tasks.some((t) => t.id === 'lan-verify-1' && t.title === '来自A'),
    'A 写入的任务能被 B 拉到');

  // B 改成较新版本 → A 拉到新版本（LWW）
  const newer = Date.now() + 1000;
  b.local.tasks = [{ id: 'lan-verify-1', title: 'B改过', updatedAt: newer }];
  await b.engine.syncNow();
  await a.engine.syncNow();
  const onA = a.local.tasks.find((t) => t.id === 'lan-verify-1');
  check(onA && onA.title === 'B改过', 'LWW：较新版本胜出');

  // 旧版本不能回退服务端
  a.local.tasks = [{ id: 'lan-verify-1', title: '旧版本', updatedAt: newer - 500 }];
  a.meta.tasks.pushCursor = 0;
  await a.engine.syncNow();
  const c = makeDevice([]);
  await c.engine.syncNow();
  const onC = c.local.tasks.find((t) => t.id === 'lan-verify-1');
  check(onC && onC.title === 'B改过', '旧版本不覆盖服务端较新记录');

  // 不同同步码空间隔离
  const d = makeDevice([]);
  d.engine.setToken(OTHER_CODE);
  await d.engine.syncNow();
  check(d.local.tasks.length === 0, '不同同步码的空间互相隔离');

  // 三类记录都能往返
  const e = makeDevice([]);
  e.local.daily_logs = [{ date: '2026-11-08', progress: '局域网验证', updatedAt: Date.now() }];
  e.local.prefs = [{ key: 'categories', value: ['工作', '验证'], updatedAt: Date.now() }];
  await e.engine.syncNow();
  const f = makeDevice([]);
  await f.engine.syncNow();
  check(f.local.daily_logs.length === 1, 'daily_logs 可往返');
  check(f.local.prefs.length === 1, 'prefs 可往返');

  check(a.errors.length + b.errors.length === 0, '两台设备无同步错误上报');
  console.log('\n局域网端到端验证通过（本次同步码仅供测试，不会写入客户端设置）');
}

main()
  .catch(function (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async function () {
    if (cleanupHost) await cleanupHost();
  });
