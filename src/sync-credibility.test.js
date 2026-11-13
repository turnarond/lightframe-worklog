// sync-credibility.test.js —— 同步可信度增强：冲突检测 + 待推送条数
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Sync = require('./sync.js');

// 内存适配器构建器：返回 engine 与可变的 local/meta/conflicts
function makeEngine(opts) {
  opts = opts || {};
  const local = opts.local || { tasks: [], daily_logs: [], prefs: [] };
  const meta = {
    tasks: Object.assign({ lastPull: 0, pushCursor: 0 }, (opts.meta && opts.meta.tasks) || {}),
    daily_logs: Object.assign({ lastPull: 0, pushCursor: 0 }, (opts.meta && opts.meta.daily_logs) || {}),
    prefs: Object.assign({ lastPull: 0, pushCursor: 0 }, (opts.meta && opts.meta.prefs) || {})
  };
  const conflicts = [];
  // tasks 类型的拉取响应由测试用例提供
  const tasksChanges = opts.tasksChanges || [];
  const serverTime = opts.serverTime || 120;
  const engine = new Sync.SyncEngine({
    getLocal: async function (t) { return local[t]; },
    putLocal: async function (t, rows) { local[t] = rows; },
    getMeta: async function () { return JSON.parse(JSON.stringify(meta)); },
    setMeta: async function (m) { Object.assign(meta, JSON.parse(JSON.stringify(m))); },
    fetchImpl: async function (method, url) {
      const m = /types=(\w+)/.exec(url);
      const t = m ? m[1] : '';
      if (t === 'tasks') return { ok: true, status: 200, json: { changes: tasksChanges, server_time: serverTime } };
      return { ok: true, status: 200, json: { changes: [], server_time: serverTime } };
    },
    onConflict: function (c) { conflicts.push(c); }
  });
  return { engine: engine, local: local, meta: meta, conflicts: conflicts };
}

test('冲突检测：本地未确认改动被服务端较新版本覆盖 → 触发冲突，标题为本地原值', async function () {
  const ctx = makeEngine({
    local: { tasks: [{ id: 't1', title: 'B 的改动', updatedAt: 115 }] },
    meta: { tasks: { lastPull: 0, pushCursor: 110 } }, // 115>110 → t1 为未确认改动
    tasksChanges: [{ type: 'tasks', id: 't1', title: 'A 的改动', updatedAt: 120 }]
  });
  await ctx.engine.pull();
  assert.strictEqual(ctx.conflicts.length, 1);
  assert.strictEqual(ctx.conflicts[0].type, 'tasks');
  assert.strictEqual(ctx.conflicts[0].key, 't1');
  assert.strictEqual(ctx.conflicts[0].title, 'B 的改动');
});

test('冲突检测：本地改动更新（LWW 胜出，服务端版本更旧）→ 不触发冲突', async function () {
  const ctx = makeEngine({
    local: { tasks: [{ id: 't1', title: 'B 新', updatedAt: 130 }] },
    meta: { tasks: { lastPull: 0, pushCursor: 110 } },
    tasksChanges: [{ type: 'tasks', id: 't1', title: 'A 旧', updatedAt: 120 }]
  });
  await ctx.engine.pull();
  assert.strictEqual(ctx.conflicts.length, 0);
});

test('冲突检测：服务端软删（deletedAt 更新）→ 本地未确认改动被删，触发冲突', async function () {
  const ctx = makeEngine({
    local: { tasks: [{ id: 't1', title: 'B', deletedAt: 0, updatedAt: 115 }] },
    meta: { tasks: { lastPull: 0, pushCursor: 110 } },
    tasksChanges: [{ type: 'tasks', id: 't1', deletedAt: 120, updatedAt: 120 }]
  });
  await ctx.engine.pull();
  assert.strictEqual(ctx.conflicts.length, 1);
  assert.strictEqual(ctx.conflicts[0].title, 'B');
});

test('冲突检测：语义字段相同（仅 updatedAt 不同）→ 不误报冲突', async function () {
  const ctx = makeEngine({
    local: { tasks: [{ id: 't1', title: '相同', updatedAt: 115 }] },
    meta: { tasks: { lastPull: 0, pushCursor: 110 } },
    tasksChanges: [{ type: 'tasks', id: 't1', title: '相同', updatedAt: 120 }]
  });
  await ctx.engine.pull();
  assert.strictEqual(ctx.conflicts.length, 0);
});

test('pendingCount：统计三类未确认本地改动（updatedAt > pushCursor）', async function () {
  const ctx = makeEngine({
    local: {
      tasks: [{ id: 'a', updatedAt: 110 }, { id: 'b', updatedAt: 90 }],
      daily_logs: [{ date: '2026-11-01', updatedAt: 50 }],
      prefs: [{ key: 'theme', value: 'dark', updatedAt: 10 }]
    },
    meta: {
      tasks: { lastPull: 0, pushCursor: 100 }, // a(110)>100 → 1
      daily_logs: { lastPull: 0, pushCursor: 0 }, // 50>0 → 1
      prefs: { lastPull: 0, pushCursor: 0 } // 10>0 → 1
    }
  });
  const n = await ctx.engine.pendingCount();
  assert.strictEqual(n, 3);
});

test('pendingCount：已确认（updatedAt <= pushCursor）不计入', async function () {
  const ctx = makeEngine({
    local: { tasks: [{ id: 'a', updatedAt: 110 }], daily_logs: [], prefs: [] },
    meta: { tasks: { lastPull: 0, pushCursor: 110 } }
  });
  const n = await ctx.engine.pendingCount();
  assert.strictEqual(n, 0);
});
