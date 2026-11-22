'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lib = require('./release-lib.js');

test('parseReleaseArgs 支持 --key value 与 --flag', () => {
  const a = lib.parseReleaseArgs(['--version', '2.12.0', '--check', '--skip-update']);
  assert.strictEqual(a.version, '2.12.0');
  assert.strictEqual(a.check, true);
  assert.strictEqual(a['skip-update'], true);
});

test('validateVersionTrio 拒绝不一致', () => {
  const errs = lib.validateVersionTrio({
    packageVersion: '2.12.0', versionText: '2.11.1', changelog: '## [2.12.0] - 2026-11-22'
  }, '2.12.0');
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /VERSION/);
});

test('isCleanStatus 只接受空输出', () => {
  assert.strictEqual(lib.isCleanStatus(''), true);
  assert.strictEqual(lib.isCleanStatus(' M README.md'), false);
});

test('releaseCommands 不含自动执行', () => {
  const cmds = lib.releaseCommands('2.12.0');
  assert.ok(cmds.some((c) => c.startsWith('git push origin main')));
  assert.ok(cmds.some((c) => c.includes('gh release create v2.12.0')));
});
