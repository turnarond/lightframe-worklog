'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REMOVE = [
  path.join('resources', 'default_app.asar')
];

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const removed = [];
  for (const rel of REMOVE) {
    const target = path.join(context.appOutDir, rel);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { force: true });
    removed.push(rel);
  }
  console.log('[afterPack] slim removed:', removed.length ? removed.join(', ') : 'none');
};
