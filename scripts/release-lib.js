'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

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
function sha512Base64File(f) { return crypto.createHash('sha512').update(fs.readFileSync(f)).digest('base64'); }
function md5File(f) { return hashFile(f, 'md5'); }

function renderReleaseNotes({ version, changeSummary, assets }) {
  const lines = ['## 变更', changeSummary || '- 发布可信度与门禁收口。', '', '## 资产'];
  for (const a of assets || []) {
    lines.push('- `' + a.name + '` — ' + a.size + ' 字节 — sha256 `' + a.sha256 + '` — sha512 `' + a.sha512 + '`');
  }
  return '# v' + version + '\n\n' + lines.join('\n') + '\n';
}

function updateOptionsErrors(opts) {
  const o = opts || {};
  if (o['skip-update'] === true) return [];
  if (!o['old-app-dir'] || o['old-app-dir'] === true) {
    return ['未提供 --old-app-dir：完整模式默认执行更新下载验证；确需跳过请显式传 --skip-update'];
  }
  return [];
}

function rewriteLatestArtifact(text, fileName) {
  const src = String(text == null ? '' : text);
  if (!fileName || /[\r\n]/.test(fileName)) throw new Error('产物文件名不合法: ' + fileName);
  if (!/^path:[ \t]*\S.*$/m.test(src)) throw new Error('latest.yml 缺少 path 行');
  if (!/^[ \t]*-[ \t]+url:[ \t]*\S.*$/m.test(src)) throw new Error('latest.yml 缺少 files.url 行');
  return src
    .replace(/^path:[^\r\n]*$/m, 'path: ' + fileName)
    .replace(/^([ \t]*-[ \t]+url:)[^\r\n]*$/gm, '$1 ' + fileName);
}

function reconcileLatest({ latest, version, size, sha512 }) {
  const errs = [];
  if (!latest) return ['latest.yml 无法解析'];
  if (latest.version !== version) {
    errs.push('latest.yml version 与发布版本不一致: ' + latest.version + ' != ' + version);
  }
  if (latest.size == null) errs.push('latest.yml 缺少 size');
  else if (latest.size !== size) errs.push('latest.yml size 与安装包不一致: ' + latest.size + ' != ' + size);
  if (!latest.sha512) errs.push('latest.yml 缺少 sha512');
  else if (latest.sha512 !== sha512) errs.push('latest.yml sha512 与安装包不一致');
  return errs;
}

function verifyUpdateArgs({ oldAppDir, newDir, testRoot, logFile }) {
  const args = ['tools/verify-update.js', '--old-app-dir', String(oldAppDir),
    '--new-dir', String(newDir), '--test-root', String(testRoot)];
  if (logFile) args.push('--log-file', String(logFile));
  return args;
}

function verifyRuntimePayload(payloadDir, options) {
  const minDllBytes = options && options.minDllBytes != null ? options.minDllBytes : 1000000;
  const errs = [];
  for (const dll of ['ffmpeg.dll', 'dxcompiler.dll']) {
    const file = path.join(payloadDir, dll);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      errs.push('缺少运行时 DLL: ' + dll);
      continue;
    }
    const size = fs.statSync(file).size;
    if (size < minDllBytes) errs.push('运行时 DLL 过小或为空: ' + dll + ' (' + size + ')');
  }
  if (fs.existsSync(path.join(payloadDir, 'resources', 'default_app.asar'))) {
    errs.push('运行时载荷不应包含 resources/default_app.asar');
  }
  return errs;
}

function collectSyntaxTargets(root) {
  const targets = ['main.js', 'preload.js'];
  for (const dir of ['src', 'tools', 'server-lite', 'scripts']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js')) targets.push(path.join(dir, e.name));
    }
  }
  return targets;
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
    versionText: fs.readFileSync(path.join(input.cwd, 'VERSION'), 'utf8'),
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
  const target = 'electron-v' + version + '-win32-x64.zip';
  if (!fs.existsSync(cacheRoot)) return null;
  const dirs = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const hit = path.join(cacheRoot, d.name, target);
    if (fs.existsSync(hit)) return hit;
  }
  return null;
}

function resolveAbsentMarker({ version, previousVersion, explicit }) {
  const marker = '"version": "' + version + '"';
  if (explicit) {
    if (explicit === marker) throw new Error('absent-marker 与当前版本 marker 相同：' + explicit);
    return explicit;
  }
  const prev = String(previousVersion || '').trim().replace(/^v/i, '');
  if (!prev) throw new Error('缺少 previous-version，无法生成 absent-marker');
  const absent = '"version": "' + prev + '"';
  if (absent === marker) throw new Error('absent-marker 与 marker 相同（previous-version=' + prev + '）');
  return absent;
}

module.exports = {
  parseReleaseArgs, validateVersionTrio, isCleanStatus, runCheck, renderReleaseNotes, releaseCommands,
  sha256File, sha512File, sha512Base64File, md5File, findCachedElectron, resolveAbsentMarker,
  updateOptionsErrors, rewriteLatestArtifact, reconcileLatest, verifyUpdateArgs,
  verifyRuntimePayload, collectSyntaxTargets
};
