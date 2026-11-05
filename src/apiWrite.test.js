'use strict';

const { test } = require('node:test');
const { createWriter } = require('./apiWrite.js');

test('写操作成功返回 true，并原样传递参数', async function () {
  let got = null;
  const bridge = { saveTasks: async function (v) { got = v; return { ok: true }; } };
  const write = createWriter(bridge, { onError: function () { throw new Error('不应上报错误'); } });
  const ok = await write('saveTasks', [1, 2]);
  if (ok !== true) throw new Error('成功应返回 true');
  if (JSON.stringify(got) !== '[1,2]') throw new Error('参数未原样传递: ' + JSON.stringify(got));
});

test('写操作抛错返回 false 并上报，绝不谎报成功', async function () {
  let reported = null;
  const bridge = { saveTasks: async function () { throw new Error('EACCES'); } };
  const write = createWriter(bridge, {
    onError: function (m, e) { reported = [m, e.message]; }
  });
  const ok = await write('saveTasks', []);
  if (ok !== false) throw new Error('失败应返回 false，而非 undefined/fallback');
  if (!reported || reported[0] !== 'saveTasks' || reported[1] !== 'EACCES') {
    throw new Error('应上报方法与错误: ' + JSON.stringify(reported));
  }
});

test('接口缺失时安全返回 false 并上报', async function () {
  let reported = null;
  const write = createWriter({}, { onError: function (m) { reported = m; } });
  const ok = await write('saveLogs', {});
  if (ok !== false) throw new Error('接口缺失应返回 false');
  if (reported !== 'saveLogs') throw new Error('应上报缺失的方法名');
});

test('bridge 为空时不崩溃', async function () {
  const write = createWriter(null, {});
  if (await write('saveTasks', []) !== false) throw new Error('应安全返回 false');
});

test('写操作返回 undefined 仍视为成功（IPC 常无返回值）', async function () {
  const bridge = { saveSettings: async function () { return undefined; } };
  const ok = await createWriter(bridge, {})('saveSettings', {});
  if (ok !== true) throw new Error('无返回值不应被误判为失败');
});
