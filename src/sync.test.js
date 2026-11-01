// sync 单元测试：纯函数 + SyncEngine（注入假 fetch / 内存适配器）
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./sync.js');

const TASK = (id, u) => ({ id, title: 't' + id, updatedAt: u, deletedAt: null });

test('mergeLWW: 远程较新则远程胜', () => {
  assert.deepEqual(S.mergeLWW(TASK('A', 100), TASK('A', 200)), TASK('A', 200));
});
test('mergeLWW: 本地较新则本地胜', () => {
  assert.deepEqual(S.mergeLWW(TASK('A', 300), TASK('A', 200)), TASK('A', 300));
});
test('mergeLWW: updatedAt 相等时远程优先（收敛）', () => {
  const local = TASK('A', 100); const remote = TASK('A', 100);
  remote.title = 'remote';
  assert.equal(S.mergeLWW(local, remote).title, 'remote');
});
test('mergeLWW: 软删远程胜出（携带 deletedAt）', () => {
  const out = S.mergeLWW(TASK('A', 100), { id: 'A', updatedAt: 200, deletedAt: 200 });
  assert.equal(out.deletedAt, 200);
});
test('mergeLWW: 缺一方返回另一方', () => {
  assert.deepEqual(S.mergeLWW(null, TASK('A', 5)), TASK('A', 5));
  assert.deepEqual(S.mergeLWW(TASK('A', 5), null), TASK('A', 5));
});

test('applyPull: 远程较新覆盖，本地较新保留', () => {
  const local = [TASK('A', 100), TASK('B', 500)];
  const remote = [TASK('A', 200), TASK('C', 100)];
  const out = S.applyPull(local, remote);
  const byId = {}; out.forEach(r => { byId[r.id] = r; });
  assert.equal(byId.A.updatedAt, 200, 'A 被远程覆盖');
  assert.equal(byId.B.updatedAt, 500, 'B 本地较新保留');
  assert.equal(byId.C.updatedAt, 100, 'C 为新增');
});
test('applyPull: 远程软删生效', () => {
  const out = S.applyPull([TASK('A', 100)], [{ id: 'A', updatedAt: 200, deletedAt: 200 }]);
  assert.equal(out[0].deletedAt, 200);
});
test('applyPull: 偏好以 key 为键去重', () => {
  const local = [{ key: 'cat', value: '工作', updatedAt: 100 }];
  const remote = [{ key: 'cat', value: '会议', updatedAt: 200 }];
  const out = S.applyPull(local, remote);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, '会议');
});

test('dirtyDiff: 仅取 updatedAt > 游标', () => {
  const rows = [{ id: 'a', updatedAt: 50 }, { id: 'b', updatedAt: 120 }, { id: 'c', updatedAt: 100 }];
  assert.deepEqual(S.dirtyDiff(rows, 100).map(r => r.id), ['b']);
  assert.deepEqual(S.dirtyDiff(rows, 0).map(r => r.id), ['a', 'b', 'c']);
});
test('dirtyDiff: 默认游标 0', () => {
  assert.equal(S.dirtyDiff([{ id: 'x', updatedAt: 0 }], undefined).length, 0);
});

test('toWire/fromWire 往返', () => {
  const rows = [TASK('A', 10)];
  const wire = S.toWire(rows, 'tasks');
  assert.equal(wire[0].type, 'tasks');
  const back = wire.map(S.fromWire);
  assert.equal(back[0].type, undefined);
  assert.equal(back[0].id, 'A');
});

// ---------- SyncEngine 集成（假 fetch + 内存适配器） ----------

function memAdapters(initial) {
  const data = initial || { tasks: [], daily_logs: [], prefs: [] };
  const meta = {
    tasks: { lastPull: 0, pushCursor: 0 },
    daily_logs: { lastPull: 0, pushCursor: 0 },
    prefs: { lastPull: 0, pushCursor: 0 }
  };
  return {
    data, meta,
    getLocal: async (t) => data[t].slice(),
    putLocal: async (t, rows) => { data[t] = rows.slice(); },
    getMeta: async () => JSON.parse(JSON.stringify(meta)),
    setMeta: async (m) => { Object.assign(meta, JSON.parse(JSON.stringify(m))); },
    calls: []
  };
}

test('SyncEngine.pull: 拉取并合并，推进 lastPull 与 pushCursor', async () => {
  const ad = memAdapters({ tasks: [TASK('LOCAL', 10)], daily_logs: [], prefs: [] });
  const engine = new S.SyncEngine({
    baseUrl: 'https://s.example',
    token: 'TK',
    getLocal: ad.getLocal, putLocal: ad.putLocal, getMeta: ad.getMeta, setMeta: ad.setMeta,
    fetchImpl: async (method, url, body) => {
      ad.calls.push({ method, url, body });
      if (method === 'GET' && url.indexOf('/pull') >= 0) {
        return { ok: true, status: 200, json: { server_time: 1000, changes: [
          { type: 'tasks', id: 'REMOTE', title: 'r', updatedAt: 900, deletedAt: null }
        ] } };
      }
      return { ok: true, status: 200, json: {} };
    }
  });
  await engine.pull();
  assert.equal(ad.data.tasks.length, 2, '本地 + 远程合并');
  const remote = ad.data.tasks.find(r => r.id === 'REMOTE');
  assert.ok(remote, '远程行已写入');
  assert.equal(ad.meta.tasks.lastPull, 1000);
  assert.equal(ad.meta.tasks.pushCursor, 900, 'pushCursor 仅推进到拉回行最大 updatedAt，避免慢时钟下编辑丢失');
  assert.equal(ad.calls[0].url, 'https://s.example/api/sync/pull?since=0&types=tasks', '请求 URL 契约正确（origin + /api）');
});

test('SyncEngine.push: 仅推送脏行，推进 pushCursor', async () => {
  const ad = memAdapters({ tasks: [TASK('A', 500), TASK('B', 50)], daily_logs: [], prefs: [] });
  ad.meta.tasks.pushCursor = 100; // 仅 A 为脏
  let pushed = null;
  const engine = new S.SyncEngine({
    baseUrl: 'https://s.example',
    getLocal: ad.getLocal, putLocal: ad.putLocal, getMeta: ad.getMeta, setMeta: ad.setMeta,
    fetchImpl: async (method, url, body) => {
      if (method === 'POST' && url.indexOf('/push') >= 0) { pushed = body; }
      return { ok: true, status: 200, json: { server_time: 999 } };
    }
  });
  await engine.push();
  assert.ok(pushed, '发生了 push');
  assert.equal(pushed.changes.length, 1, '只推送脏行 A');
  assert.equal(pushed.changes[0].id, 'A');
  assert.equal(ad.meta.tasks.pushCursor, 999);
});

test('SyncEngine.syncNow: 先 pull 后 push，且 pull 的远程行不回推', async () => {
  const ad = memAdapters({ tasks: [TASK('LOCAL', 10)], daily_logs: [], prefs: [] });
  let pushBody = null;
  const engine = new S.SyncEngine({
    baseUrl: 'https://s.example',
    getLocal: ad.getLocal, putLocal: ad.putLocal, getMeta: ad.getMeta, setMeta: ad.setMeta,
    fetchImpl: async (method, url, body) => {
      if (method === 'GET') {
        return { ok: true, status: 200, json: { server_time: 500, changes: [
          { type: 'tasks', id: 'REMOTE', title: 'r', updatedAt: 400, deletedAt: null }
        ] } };
      }
      if (method === 'POST') { pushBody = body; }
      return { ok: true, status: 200, json: { server_time: 500 } };
    }
  });
  await engine.syncNow();
  assert.equal(pushBody, null, 'pull 得到的 REMOTE(updatedAt 400) 不应被回推');
});
