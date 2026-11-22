'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

function parseReleaseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq >= 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { out[key] = argv[++i]; }
    else out[key] = true;
  }
  return out;
}

function validateVersionTrio(v, expected) {
  const errs = [];
  if (v.packageVersion !== expected) errs.push('package.json version 不等于 ' + expected);
  if (String(v.versionText).trim() !== expected) errs.push('VERSION 不等于 ' + expected);
  if (!v.changelog.includes('## [' + expected + ']')) errs.push('CHANGELOG 缺少 ' + expected + ' 段');
  return errs;
}

function isCleanStatus(text) { return text.trim() === ''; }

function hashFile(file, algo) {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
}
function sha256File(f) { return hashFile(f, 'sha256'); }
function sha512File(f) { return hashFile(f, 'sha512'); }
function md5File(f) { return hashFile(f, 'md5'); }

function renderReleaseNotes({ version, changeSummary, assets }) {
  const lines = ['## 变更', changeSummary || '- 发布可信度与门禁收口。', '', '## 资产'];
  for (const a of assets || []) lines.push('- `' + a.name + '` — ' + a.size + ' 字节 — sha256 `' + a.sha256 + '`');
  return '# v' + version + '\n\n' + lines.join('\n') + '\n';
}

function releaseCommands(version, assets) {
  const files = assets && assets.length ? assets : [
    'dist/lightframe-worklog-setup-' + version + '.exe',
    'dist/lightframe-worklog-setup-' + version + '.exe.blockmap',
    'dist/latest.yml'
  ];
  return [
    'git push origin main',
    'git tag -a v' + version + ' -m "v' + version + ' · 2026-11-22"',
    'git push origin v' + version,
    'gh release create v' + version + ' ' + files.join(' ') + ' --notes-file dist/release-notes-' + version + '.md'
  ];
}

function runCheck(input) {
  const errors = [];
  if (!isCleanStatus(input.statusText || '')) errors.push('工作区不干净');
  errors.push(...validateVersionTrio({
    packageVersion: input.packageVersion,
    versionText: fs.readFileSync(require('node:path').join(input.cwd, 'VERSION'), 'utf8'),
    changelog: input.changelog || ''
  }, input.version));
  if (input.readmeText && !input.readmeText.includes('当前版本：**v' + input.version + '**')) {
    errors.push('README 当前版本不是 v' + input.version);
  }
  if (!input.allowExistingTag && (input.tags || []).includes('v' + input.version)) {
    errors.push('tag v' + input.version + ' 已存在');
  }
  return { ok: errors.length === 0, errors };
}

function findCachedElectron(version, cacheRoot) {
  const path = require('node:path');
  const target = 'electron-v' + version + '-win32-x64.zip';
  if (!fs.existsSync(cacheRoot)) return null;
  const dirs = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const hit = path.join(cacheRoot, d.name, target);
    if (fs.existsSync(hit)) return hit;
  }
  return null;
}

module.exports = { parseReleaseArgs, validateVersionTrio, isCleanStatus, runCheck, renderReleaseNotes, releaseCommands, sha256File, sha512File, md5File, findCachedElectron };
