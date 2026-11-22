'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function renderAppUpdateYml({ url, cacheName }) {
  return 'provider: generic\nurl: ' + url + '\nupdaterCacheDirName: ' + cacheName + '\n';
}

function installerArgs(testRoot) {
  return ['/S', '/D=' + path.win32.join(testRoot, 'app')];
}

function assertSafeTestRoot({ testRoot, dailyInstallPath, dailyUserDataPath }) {
  const errs = [];
  const root = path.resolve(testRoot);
  const tmp = path.resolve(os.tmpdir());
  if (!root.startsWith(tmp + path.sep)) errs.push('test-root 必须位于临时目录');
  for (const p of [dailyInstallPath, dailyUserDataPath]) {
    const r = path.resolve(p);
    if (root === r || root.startsWith(r + path.sep)) errs.push('拒绝触碰日常安装/数据: ' + r);
  }
  return errs;
}

function findDownloadedInstaller(cacheDir, sha256) {
  if (!fs.existsSync(cacheDir)) return null;
  const stack = [cacheDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.exe$/i.test(e.name)) {
        const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        if (h === sha256) return p;
      }
    }
  }
  return null;
}

function parseLatestYml(text) {
  const src = String(text == null ? '' : text);
  const version = /^version:\s*(\S+)\s*$/m.exec(src);
  if (!version) throw new Error('latest.yml 缺少 version');
  const p = /^path:\s*(.+?)\s*$/m.exec(src.replace(/\r/g, ''));
  if (!p) throw new Error('latest.yml 缺少 path');
  const file = p[1].replace(/^['"]|['"]$/g, '');
  if (!file || path.win32.isAbsolute(file) || file.split(/[\\/]/).indexOf('..') >= 0) {
    throw new Error('latest.yml 的 path 必须是相对路径: ' + file);
  }
  const sha512 = /^\s*sha512:\s*(\S+)\s*$/m.exec(src);
  const size = /^\s*size:\s*(\d+)\s*$/m.exec(src);
  return {
    version: version[1],
    path: file,
    sha512: sha512 ? sha512[1] : null,
    size: size ? Number(size[1]) : null
  };
}

function parseVerifyUpdateArgs(argv) {
  const keys = { '--old-app-dir': 'oldAppDir', '--new-dir': 'newDir', '--test-root': 'testRoot' };
  const opts = { oldAppDir: null, newDir: null, testRoot: null };
  const list = argv || [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    const key = keys[arg];
    if (!key) throw new Error('未知参数: ' + arg);
    if (i + 1 >= list.length || list[i + 1].startsWith('--')) throw new Error('缺少参数值: ' + arg);
    opts[key] = list[++i];
  }
  const missing = Object.keys(keys).filter((k) => !opts[keys[k]]);
  if (missing.length) throw new Error('缺少必填参数: ' + missing.join(', '));
  return opts;
}

module.exports = {
  renderAppUpdateYml, installerArgs, assertSafeTestRoot, findDownloadedInstaller,
  parseLatestYml, parseVerifyUpdateArgs
};
