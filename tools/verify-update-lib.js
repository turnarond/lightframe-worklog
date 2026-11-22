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

module.exports = { renderAppUpdateYml, installerArgs, assertSafeTestRoot, findDownloadedInstaller };
