'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findCachedElectron } = require('./release-lib.js');

function ensureElectron({ version, distDir, cacheRoot }) {
  const versionFile = path.join(distDir, 'version');
  if (fs.existsSync(versionFile) && fs.readFileSync(versionFile, 'utf8').trim() === version) return;
  const zip = findCachedElectron(version, cacheRoot);
  if (!zip) throw new Error('未找到 Electron 缓存；请联网安装或传入 --electron-dist');
  fs.mkdirSync(distDir, { recursive: true });
  execFileSync('powershell', ['-NoProfile', '-Command',
    'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + distDir + '" -Force'], { stdio: 'inherit' });
  fs.writeFileSync(path.join(distDir, '..', 'path.txt'), 'electron.exe');
}
module.exports = { ensureElectron };
