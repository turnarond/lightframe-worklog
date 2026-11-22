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

test('resolveAbsentMarker 生成旧版本标记并拒绝同值', () => {
  assert.strictEqual(lib.resolveAbsentMarker({ version: '2.12.0', previousVersion: 'v2.11.1' }), '"version": "2.11.1"');
  assert.throws(() => lib.resolveAbsentMarker({ version: '2.11.1', previousVersion: '2.11.1' }), /相同/);
  assert.throws(() => lib.resolveAbsentMarker({
    version: '2.11.1', previousVersion: '2.11.0', explicit: '"version": "2.11.1"'
  }), /相同/);
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

test('updateOptionsErrors 未显式 skip 时强制 --old-app-dir', () => {
  assert.deepStrictEqual(lib.updateOptionsErrors({ 'skip-update': true }), []);
  assert.deepStrictEqual(lib.updateOptionsErrors({ 'old-app-dir': 'unpacked' }), []);
  const errs = lib.updateOptionsErrors({});
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /--old-app-dir/);
  assert.match(lib.updateOptionsErrors({ 'old-app-dir': true })[0], /--old-app-dir/);
});

const LATEST_YML = [
  'version: 2.12.0',
  'files:',
  '  - url: 光影工作志 Setup 2.12.0.exe',
  '    sha512: abc123==',
  '    size: 456',
  'path: 光影工作志 Setup 2.12.0.exe',
  'sha512: abc123==',
  "releaseDate: '2026-11-22T12:00:00.000Z'",
  ''
].join('\n');

test('rewriteLatestArtifact 同步改 path 与 files.url，保留哈希与大小', () => {
  const out = lib.rewriteLatestArtifact(LATEST_YML, 'lightframe-worklog-setup-2.12.0.exe');
  assert.match(out, /^path: lightframe-worklog-setup-2\.12\.0\.exe$/m);
  assert.match(out, /^\s*- url: lightframe-worklog-setup-2\.12\.0\.exe$/m);
  assert.match(out, /sha512: abc123==/);
  assert.match(out, /size: 456/);
  assert.doesNotMatch(out, /光影工作志 Setup/);
});

test('rewriteLatestArtifact 拒绝缺 path/url 与含换行的文件名', () => {
  assert.throws(() => lib.rewriteLatestArtifact('version: 2.12.0\n', 'a.exe'), /path/);
  assert.throws(() => lib.rewriteLatestArtifact('version: 2.12.0\npath: a.exe\n', 'b.exe'), /url/);
  assert.throws(() => lib.rewriteLatestArtifact(LATEST_YML, 'a\nb.exe'), /文件名/);
});

test('reconcileLatest 对账 version/size/sha512', () => {
  const latest = { version: '2.12.0', size: 456, sha512: 'abc123==' };
  assert.deepStrictEqual(lib.reconcileLatest({ latest, version: '2.12.0', size: 456, sha512: 'abc123==' }), []);
  assert.match(lib.reconcileLatest({ latest, version: '2.11.1', size: 456, sha512: 'abc123==' })[0], /version/);
  assert.match(lib.reconcileLatest({ latest, version: '2.12.0', size: 457, sha512: 'abc123==' })[0], /size/);
  assert.match(lib.reconcileLatest({ latest, version: '2.12.0', size: 456, sha512: 'dead' })[0], /sha512/);
  assert.match(lib.reconcileLatest({ latest: { version: '2.12.0' }, version: '2.12.0', size: 456, sha512: 'x' }).join(' '), /size.*sha512/);
});

test('verifyUpdateArgs 组装稳定的 verify-update 命令', () => {
  assert.deepStrictEqual(lib.verifyUpdateArgs({
    oldAppDir: 'C:\\old', newDir: 'dist', testRoot: 'C:\\tmp', logFile: 'C:\\logs\\drill.log'
  }), [
    'tools/verify-update.js',
    '--old-app-dir', 'C:\\old',
    '--new-dir', 'dist',
    '--test-root', 'C:\\tmp',
    '--log-file', 'C:\\logs\\drill.log'
  ]);
  assert.deepStrictEqual(lib.verifyUpdateArgs({
    oldAppDir: 'old', newDir: 'dist', testRoot: 'tmp'
  }), ['tools/verify-update.js', '--old-app-dir', 'old', '--new-dir', 'dist', '--test-root', 'tmp']);
});

test('verifyRuntimePayload 正断言 DLL 非空且 default_app.asar 缺席', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-payload-'));
  try {
    assert.match(lib.verifyRuntimePayload(dir).join(' '), /ffmpeg\.dll/);
    fs.mkdirSync(path.join(dir, 'resources'));
    fs.writeFileSync(path.join(dir, 'ffmpeg.dll'), '');
    fs.writeFileSync(path.join(dir, 'dxcompiler.dll'), 'tiny');
    assert.match(lib.verifyRuntimePayload(dir).join(' '), /ffmpeg\.dll/);
    fs.writeFileSync(path.join(dir, 'ffmpeg.dll'), 'x'.repeat(1000001));
    fs.writeFileSync(path.join(dir, 'dxcompiler.dll'), 'y'.repeat(1000001));
    fs.writeFileSync(path.join(dir, 'resources', 'default_app.asar'), 'stray');
    assert.match(lib.verifyRuntimePayload(dir).join(' '), /default_app\.asar/);
    fs.rmSync(path.join(dir, 'resources', 'default_app.asar'));
    assert.deepStrictEqual(lib.verifyRuntimePayload(dir), []);
    assert.deepStrictEqual(lib.verifyRuntimePayload(dir, { minDllBytes: 1000002 }), [
      '运行时 DLL 过小或为空: ffmpeg.dll (1000001)',
      '运行时 DLL 过小或为空: dxcompiler.dll (1000001)'
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectSyntaxTargets 覆盖顶层与四个脚本目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-syntax-'));
  try {
    fs.writeFileSync(path.join(root, 'main.js'), '');
    fs.writeFileSync(path.join(root, 'preload.js'), '');
    fs.writeFileSync(path.join(root, 'index.html'), '');
    for (const dir of ['src', 'tools', 'server-lite', 'scripts']) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, dir + '.js'), '');
      fs.writeFileSync(path.join(root, dir, 'ignore.txt'), '');
    }
    assert.deepStrictEqual(lib.collectSyntaxTargets(root).sort(), [
      'main.js',
      path.join('preload.js'),
      path.join('scripts', 'scripts.js'),
      path.join('server-lite', 'server-lite.js'),
      path.join('src', 'src.js'),
      path.join('tools', 'tools.js')
    ].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderReleaseNotes 输出 sha256、sha512 与 size', () => {
  const text = lib.renderReleaseNotes({
    version: '2.12.0',
    changeSummary: '摘要',
    assets: [{ name: 'a.exe', size: 456, sha256: 'aa', sha512: 'bb' }]
  });
  assert.match(text, /456 字节/);
  assert.match(text, /sha256 `aa`/);
  assert.match(text, /sha512 `bb`/);
});

test('sha512Base64File 与 latest.yml 的 base64 口径一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-sha-'));
  try {
    const file = path.join(dir, 'a.bin');
    fs.writeFileSync(file, 'installer-bytes');
    const expected = require('node:crypto').createHash('sha512').update('installer-bytes').digest('base64');
    assert.strictEqual(lib.sha512Base64File(file), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
