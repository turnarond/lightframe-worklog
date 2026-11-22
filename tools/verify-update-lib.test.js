'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('./verify-update-lib.js');

test('renderAppUpdateYml 使用本地 generic feed', () => {
  const y = lib.renderAppUpdateYml({ url: 'http://127.0.0.1:8787', cacheName: 'lw-e2e' });
  assert.match(y, /provider: generic/);
  assert.match(y, /url: http:\/\/127\.0\.0\.1:8787/);
  assert.match(y, /updaterCacheDirName: lw-e2e/);
});

test('installerArgs 的 /D 必须是最后参数', () => {
  const expected = require('node:path').win32.join('C:\\Temp', 'lw-update', 'app');
  assert.deepStrictEqual(lib.installerArgs('C:\\Temp\\lw-update'), ['/S', '/D=' + expected]);
});

test('assertSafeTestRoot 拒绝日常安装', () => {
  const errs = lib.assertSafeTestRoot({
    testRoot: 'C:\\Program Files\\lightframe-worklog',
    dailyInstallPath: 'C:\\Program Files\\lightframe-worklog',
    dailyUserDataPath: 'C:\\Users\\x\\AppData\\Roaming\\lightframe-worklog'
  });
  assert.ok(errs.length >= 1);
  assert.match(errs.join(' '), /Program Files/);
});

test('assertSafeTestRoot 接受临时目录', () => {
  const testRoot = path.join(os.tmpdir(), 'lw-update-safe-' + process.pid);
  const errs = lib.assertSafeTestRoot({
    testRoot,
    dailyInstallPath: 'C:\\Program Files\\lightframe-worklog',
    dailyUserDataPath: 'C:\\Users\\x\\AppData\\Roaming\\lightframe-worklog'
  });
  assert.deepStrictEqual(errs, []);
});

test('findDownloadedInstaller 按 sha256 命中并忽略非 exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-update-cache-'));
  try {
    const nested = path.join(dir, 'pending');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'noise');
    const exe = path.join(nested, 'Lightframe-Setup-2.11.1.exe');
    fs.writeFileSync(exe, 'installer-bytes');
    const sha = crypto.createHash('sha256').update('installer-bytes').digest('hex');
    assert.strictEqual(lib.findDownloadedInstaller(dir, sha), exe);
    assert.strictEqual(lib.findDownloadedInstaller(dir, 'deadbeef'), null);
    assert.strictEqual(lib.findDownloadedInstaller(path.join(dir, 'missing'), sha), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
