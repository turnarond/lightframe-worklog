'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

test('N1 发布命令只在更新验证之后打印', () => {
  const src = fs.readFileSync(path.join(__dirname, 'release.js'), 'utf8');
  const verifyAt = src.indexOf('verifyUpdate(opts, v, log);');
  const printAt = src.indexOf('lib.releaseCommands(v, files)');
  assert.ok(verifyAt > 0, 'main 缺少 verifyUpdate 调用');
  assert.ok(printAt > verifyAt, '发布命令必须在 verifyUpdate 之后打印');

  const collectStart = src.indexOf('function collectMaterials');
  const verifyFn = src.indexOf('function verifyUpdate');
  assert.ok(collectStart > 0 && verifyFn > collectStart, '未找到 collectMaterials/verifyUpdate');
  assert.ok(!src.slice(collectStart, verifyFn).includes('releaseCommands'),
    'collectMaterials 不得打印发布命令');
});
