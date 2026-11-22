'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('./verify-update-lib.js');

const winOnly = { skip: process.platform !== 'win32' ? 'Windows-only' : false };

test('renderAppUpdateYml 使用本地 generic feed', () => {
  const y = lib.renderAppUpdateYml({ url: 'http://127.0.0.1:8787', cacheName: 'lw-e2e' });
  assert.match(y, /provider: generic/);
  assert.match(y, /url: http:\/\/127\.0\.0\.1:8787/);
  assert.match(y, /updaterCacheDirName: lw-e2e/);
});

test('assertSafeTestRoot 拒绝日常安装（Windows-only）', winOnly, () => {
  const errs = lib.assertSafeTestRoot({
    testRoot: 'C:\\Program Files\\lightframe-worklog',
    dailyInstallPath: 'C:\\Program Files\\lightframe-worklog',
    dailyUserDataPath: 'C:\\Users\\x\\AppData\\Roaming\\lightframe-worklog'
  });
  assert.ok(errs.length >= 1);
  assert.match(errs.join(' '), /Program Files/);
});

test('assertSafeTestRoot 接受临时目录（Windows-only）', winOnly, () => {
  const testRoot = path.join(os.tmpdir(), 'lw-update-safe-' + process.pid);
  const errs = lib.assertSafeTestRoot({
    testRoot,
    dailyInstallPath: 'C:\\Program Files\\lightframe-worklog',
    dailyUserDataPath: 'C:\\Users\\x\\AppData\\Roaming\\lightframe-worklog'
  });
  assert.deepStrictEqual(errs, []);
});

test('assertSafeTestRoot 拒绝非临时目录（Windows-only）', winOnly, () => {
  const errs = lib.assertSafeTestRoot({
    testRoot: 'C:\\work\\lw-update',
    dailyInstallPath: 'C:\\Program Files\\lightframe-worklog',
    dailyUserDataPath: 'C:\\Users\\x\\AppData\\Roaming\\lightframe-worklog'
  });
  const joined = errs.join(' ');
  assert.match(joined, /临时目录/);
  assert.doesNotMatch(joined, /日常/);
});

test('assertSafeTestRoot 拒绝日常安装子目录（Windows-only）', winOnly, () => {
  const errs = lib.assertSafeTestRoot({
    testRoot: 'C:\\Program Files\\lightframe-worklog\\sub',
    dailyInstallPath: 'C:\\Program Files\\lightframe-worklog',
    dailyUserDataPath: 'C:\\Users\\x\\AppData\\Roaming\\lightframe-worklog'
  });
  assert.match(errs.join(' '), /拒绝触碰/);
});

const SAMPLE_LATEST = [
  'version: 2.11.1',
  'files:',
  '  - url: lightframe-worklog-setup-2.11.1.exe',
  '    sha512: xSe3Tt3R8FF0+h0DxMYyLXvzvpJr3GQwOKpwWNh9lBHDRDvhY+hENyiwRo169NTeSyPh/Cv2c3gNYTvObndrwA==',
  '    size: 113867632',
  'path: lightframe-worklog-setup-2.11.1.exe',
  'sha512: xSe3Tt3R8FF0+h0DxMYyLXvzvpJr3GQwOKpwWNh9lBHDRDvhY+hENyiwRo169NTeSyPh/Cv2c3gNYTvObndrwA==',
  "releaseDate: '2026-11-22T12:17:21.572Z'",
  ''
].join('\n');

test('parseLatestYml 提取版本、安装包路径、sha512 与大小', () => {
  const info = lib.parseLatestYml(SAMPLE_LATEST);
  assert.strictEqual(info.version, '2.11.1');
  assert.strictEqual(info.path, 'lightframe-worklog-setup-2.11.1.exe');
  assert.strictEqual(info.size, 113867632);
  assert.match(info.sha512, /^xSe3Tt3R8FF0/);
});

test('parseLatestYml 缺少 version/path 时报错', () => {
  assert.throws(() => lib.parseLatestYml('sha512: abc\n'), /version/);
  assert.throws(() => lib.parseLatestYml('version: 2.12.0\n'), /path/);
});

test('parseLatestYml 拒绝绝对路径与上跳路径', () => {
  const abs = SAMPLE_LATEST.replace('path: lightframe-worklog-setup-2.11.1.exe', 'path: C:\\evil\\setup.exe');
  assert.throws(() => lib.parseLatestYml(abs), /相对路径/);
  const up = SAMPLE_LATEST.replace('path: lightframe-worklog-setup-2.11.1.exe', 'path: ../setup.exe');
  assert.throws(() => lib.parseLatestYml(up), /相对路径/);
});

test('parseVerifyUpdateArgs 解析三个必填参数', () => {
  const opts = lib.parseVerifyUpdateArgs([
    '--old-app-dir', 'unpacked',
    '--new-dir', 'dist',
    '--test-root', 'tmp/root'
  ]);
  assert.deepStrictEqual(opts, {
    oldAppDir: 'unpacked',
    newDir: 'dist',
    testRoot: 'tmp/root'
  });
});

test('parseVerifyUpdateArgs 缺参或未知参数时报错', () => {
  assert.throws(() => lib.parseVerifyUpdateArgs(['--old-app-dir', 'unpacked', '--new-dir', 'dist']), /test-root/);
  assert.throws(() => lib.parseVerifyUpdateArgs(['--old-app-dir', 'unpacked', '--new-dir', 'dist', '--test-root', 'tmp', '--bogus']), /未知参数/);
  assert.throws(() => lib.parseVerifyUpdateArgs(['--old-app-dir']), /缺少参数/);
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
