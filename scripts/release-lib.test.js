'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('findCachedElectron 找到 electron-v45.4.1 zip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-cache-'));
  const dir = path.join(root, 'abc');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'electron-v45.4.1-win32-x64.zip'), 'x');
  assert.match(lib.findCachedElectron('45.4.1', root), /electron-v45\.4\.1-win32-x64\.zip$/);
  assert.strictEqual(lib.findCachedElectron('45.4.2', root), null);
});

test('runCheck 识别版本不一致与脏工作区', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-check-'));
  fs.writeFileSync(path.join(dir, 'VERSION'), '2.11.1\n');
  const r = lib.runCheck({
    cwd: dir,
    version: '2.12.0',
    packageVersion: '2.12.0',
    changelog: '## [2.12.0]',
    statusText: ' M README.md',
    tags: []
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('VERSION')));
  assert.ok(r.errors.some((e) => e.includes('工作区')));
});
