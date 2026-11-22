'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { rewriteLatestVersion, resolveFeedFile } = require('./verify-update.js');

const SAMPLE = [
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

test('rewriteLatestVersion 只改 version，保留安装包哈希与大小', () => {
  const out = rewriteLatestVersion(SAMPLE, '2.12.0');
  assert.match(out, /^version: 2\.12\.0$/m);
  assert.strictEqual((out.match(/^version:/gm) || []).length, 1);
  assert.match(out, /sha512: xSe3Tt3R8FF0/);
  assert.match(out, /size: 113867632/);
  assert.match(out, /path: lightframe-worklog-setup-2\.11\.1\.exe/);
});

test('rewriteLatestVersion 拒绝缺 version 与非法目标版本', () => {
  assert.throws(() => rewriteLatestVersion('sha512: abc\n', '2.12.0'), /version/);
  assert.throws(() => rewriteLatestVersion(SAMPLE, 'vNext'), /目标版本/);
});

test('resolveFeedFile 解析 feed 内相对路径并解码', () => {
  const root = path.resolve('feed');
  assert.strictEqual(resolveFeedFile(root, '/latest.yml'), path.join(root, 'latest.yml'));
  assert.strictEqual(
    resolveFeedFile(root, '/%E5%85%89%E5%BD%B1%20Setup.exe?noCache=1'),
    path.join(root, '光影 Setup.exe')
  );
});

test('resolveFeedFile 拒绝目录、空路径与上跳', () => {
  const root = path.resolve('feed');
  assert.strictEqual(resolveFeedFile(root, '/'), null);
  assert.strictEqual(resolveFeedFile(root, ''), null);
  assert.strictEqual(resolveFeedFile(root, '/../secret.exe'), null);
  assert.strictEqual(resolveFeedFile(root, '/..%2Fsecret.exe'), null);
  assert.strictEqual(resolveFeedFile(root, '/%2e%2e%2fsecret.exe'), null);
});
