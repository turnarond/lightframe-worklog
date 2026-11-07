'use strict';

const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('./server.js');

const CODE = 'ABCDEFGHJKMNPQRS';
const CODE2 = '123456789ABCDEFG';
const NOW = 1700000000000;

async function withApp(fn, opts) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-sync-'));
  const app = createApp(Object.assign({ dataDir: dataDir, now: () => NOW }, opts || {}));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { return await fn(base, dataDir); }
  finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function call(base, method, pathname, body, code) {
  const headers = { 'Content-Type': 'application/json' };
  if (code !== undefined) headers.Authorization = 'Bearer ' + code;
  const res = await fetch(base + pathname, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json() };
}

const pull = (base, type, since, code) =>
  call(base, 'GET', '/api/sync/pull?since=' + since + '&types=' + type, null, code === undefined ? CODE : code);
const push = (base, changes, code) =>
  call(base, 'POST', '/api/sync/push', { changes: changes }, code === undefined ? CODE : code);

test('健康检查可用', async function () {
  await withApp(async (base) => {
    const r = await call(base, 'GET', '/api/health', null, undefined);
    if (r.status !== 200 || !r.json.ok) throw new Error('health 失败: ' + JSON.stringify(r));
  });
});

test('缺少 Bearer 同步码返回 401，非法格式返回 400', async function () {
  await withApp(async (base) => {
    const noAuth = await call(base, 'GET', '/api/sync/pull?since=0&types=tasks', null, undefined);
    if (noAuth.status !== 401) throw new Error('应 401，实际 ' + noAuth.status);
    const bad = await pull(base, 'tasks', 0, 'BAD');
    if (bad.status !== 400) throw new Error('应 400，实际 ' + bad.status);
  });
});

test('push 后 pull 能取回记录，且带 type 与 server_time', async function () {
  await withApp(async (base) => {
    const p = await push(base, [{ type: 'tasks', id: 't1', title: '任务一', updatedAt: 100 }]);
    if (p.status !== 200 || p.json.applied !== 1) throw new Error('push 失败: ' + JSON.stringify(p));
    if (typeof p.json.server_time !== 'number' || p.json.server_time < NOW) {
      throw new Error('push 必须返回数值 server_time');
    }
    const r = await pull(base, 'tasks', 0);
    if (typeof r.json.server_time !== 'number' || r.json.server_time <= p.json.server_time) {
      throw new Error('pull 的 server_time 必须单调递增');
    }
    const hit = r.json.changes.find((c) => c.id === 't1');
    if (!hit || hit.title !== '任务一' || hit.type !== 'tasks') {
      throw new Error('pull 内容不对: ' + JSON.stringify(r.json));
    }
  });
});

test('pull 按服务端游标增量过滤，不混用客户端 updatedAt 时钟', async function () {
  await withApp(async (base) => {
    // 客户端 updatedAt 故意远小于服务端时间：旧实现用 updatedAt > since 会永远拉不到
    const first = await push(base, [{ type: 'tasks', id: 'old', updatedAt: 100 }]);
    const since = first.json.server_time;
    await push(base, [{ type: 'tasks', id: 'new', updatedAt: 300 }]);
    const r = await pull(base, 'tasks', since);
    if (r.json.changes.length !== 1 || r.json.changes[0].id !== 'new') {
      throw new Error('应只返回游标之后写入的记录: ' + JSON.stringify(r.json));
    }
    if (r.json.changes[0]._storedAt !== undefined) {
      throw new Error('内部游标字段不应泄漏到 wire 协议');
    }
  });
});

test('LWW：旧版本不覆盖新版本，新版本覆盖旧版本', async function () {
  await withApp(async (base) => {
    await push(base, [{ type: 'tasks', id: 't1', title: '新版', updatedAt: 200 }]);
    const stale = await push(base, [{ type: 'tasks', id: 't1', title: '旧版', updatedAt: 100 }]);
    if (stale.json.conflicts !== 1) throw new Error('旧版本应计为 conflict: ' + JSON.stringify(stale.json));
    let r = await pull(base, 'tasks', 0);
    if (r.json.changes.find((c) => c.id === 't1').title !== '新版') throw new Error('旧版本覆盖了新版本');

    const fresh = await push(base, [{ type: 'tasks', id: 't1', title: '更新', updatedAt: 300 }]);
    if (fresh.json.applied !== 1) throw new Error('新版本应被应用: ' + JSON.stringify(fresh.json));
    r = await pull(base, 'tasks', 0);
    if (r.json.changes.find((c) => c.id === 't1').title !== '更新') throw new Error('新版本未生效');
  });
});

test('不同同步码的空间互相隔离', async function () {
  await withApp(async (base) => {
    await push(base, [{ type: 'tasks', id: 't1', updatedAt: 100 }]);
    const r = await pull(base, 'tasks', 0, CODE2);
    if (r.status !== 200 || r.json.changes.length !== 0) {
      throw new Error('另一个空间不应看到数据: ' + JSON.stringify(r));
    }
  });
});

test('软删墓碑按普通记录保存，不物理删除', async function () {
  await withApp(async (base) => {
    await push(base, [{ type: 'tasks', id: 't1', updatedAt: 100 }]);
    await push(base, [{ type: 'tasks', id: 't1', updatedAt: 200, deletedAt: 200 }]);
    const r = await pull(base, 'tasks', 0);
    const hit = r.json.changes.find((c) => c.id === 't1');
    if (!hit || hit.deletedAt !== 200) throw new Error('墓碑应保留: ' + JSON.stringify(r.json));
  });
});

test('三类记录主键分别为 id / date / key', async function () {
  await withApp(async (base) => {
    const r = await push(base, [
      { type: 'tasks', id: 't1', updatedAt: 100 },
      { type: 'daily_logs', date: '2026-11-06', progress: 'x', updatedAt: 100 },
      { type: 'prefs', key: 'categories', value: ['工作'], updatedAt: 100 }
    ]);
    if (r.json.applied !== 3) throw new Error('三类记录都应被接受: ' + JSON.stringify(r.json));
    for (const type of ['tasks', 'daily_logs', 'prefs']) {
      const p = await pull(base, type, 0);
      if (p.json.changes.length !== 1) throw new Error(type + ' 拉取失败: ' + JSON.stringify(p.json));
    }
  });
});

test('请求体超过上限返回 413', async function () {
  await withApp(async (base) => {
    const big = [{ type: 'tasks', id: 'x', blob: 'a'.repeat(2000), updatedAt: 100 }];
    const r = await push(base, big);
    if (r.status !== 413) throw new Error('应 413，实际 ' + r.status);
  }, { maxBody: 512 });
});

test('损坏的数据文件被隔离，服务仍可用', async function () {
  await withApp(async (base, dataDir) => {
    const space = crypto.createHash('sha256').update(CODE).digest('hex').slice(0, 32);
    fs.writeFileSync(path.join(dataDir, space + '.json'), '{ broken json');
    const r = await pull(base, 'tasks', 0);
    if (r.status !== 200 || r.json.changes.length !== 0) {
      throw new Error('损坏文件应返回空空间: ' + JSON.stringify(r));
    }
    if (!fs.existsSync(path.join(dataDir, space + '.json.bad'))) {
      throw new Error('损坏文件应被隔离为 .bad');
    }
  });
});
