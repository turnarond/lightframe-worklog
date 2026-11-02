// editor 单元测试 —— 详情编辑的纯逻辑
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./editor.js');

test('autoBulletOnEnter: 首行空 → 直接插入 “· ”', () => {
  const r = E.autoBulletOnEnter('', 0);
  assert.equal(r.value, '· ');
  assert.equal(r.caret, 2);
});

test('autoBulletOnEnter: 普通行尾回车 → 新行加圆点', () => {
  const r = E.autoBulletOnEnter('买菜', 2);
  assert.equal(r.value, '买菜\n· ');
  assert.equal(r.caret, 5);
});

test('autoBulletOnEnter: 空圆点行再次回车 → 结束列表', () => {
  assert.deepEqual(E.autoBulletOnEnter('· ', 2), { value: '', caret: 0 });
  assert.deepEqual(E.autoBulletOnEnter('A\n· ', 4), { value: 'A', caret: 1 });
});

test('autoBulletOnEnter: 行中回车在原位插入圆点', () => {
  const r = E.autoBulletOnEnter('abc', 1);
  assert.equal(r.value, 'a\n· bc');
  assert.equal(r.caret, 4);
});

test('autoBulletOnEnter: caret 越界兜底到末尾', () => {
  const r = E.autoBulletOnEnter('hi', 99);
  assert.equal(r.value, 'hi\n· ');
  assert.equal(r.caret, 5);
});

test('cleanDetails: 去除空圆点行与首尾空白', () => {
  assert.equal(E.cleanDetails(''), '');
  assert.equal(E.cleanDetails('· 任务一\n· 任务二\n· '), '· 任务一\n· 任务二');
  assert.equal(E.cleanDetails('  \n· 有内容\n  '), '· 有内容');
  assert.equal(E.cleanDetails('· \n· '), '');
});
