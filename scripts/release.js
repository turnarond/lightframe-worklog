'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./release-lib.js');

function git(args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
function preflight(opts) {
  const version = opts.version || require('../package.json').version;
  const result = lib.runCheck({
    cwd: process.cwd(),
    version,
    packageVersion: require('../package.json').version,
    changelog: fs.readFileSync('CHANGELOG.md', 'utf8'),
    readmeText: fs.readFileSync('README.md', 'utf8'),
    statusText: git(['status', '--porcelain']),
    tags: git(['tag', '--list']).split(/\r?\n/).filter(Boolean),
    allowExistingTag: !!opts.check || !!opts['allow-existing-tag']
  });
  if (!result.ok) { console.error(result.errors.join('\n')); process.exit(1); }
  // 发布文档检查仅在完整模式执行；--check 只做代码/版本预检
  if (!opts.check) {
    for (const key of ['change-card', 'review-evidence']) {
      if (!opts[key] || !fs.existsSync(opts[key])) { console.error('缺少 --' + key); process.exit(1); }
    }
    execFileSync('python', ['scripts/check_change_card.py', opts['change-card'], '--json'], { stdio: 'inherit' });
    execFileSync('python', ['scripts/check_review_evidence.py', opts['review-evidence'], '--json', '--require-second'], { stdio: 'inherit' });
  }
  console.log('release preflight OK: v' + version);
  return version;
}

function run(cmd, args, opts) { execFileSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts)); }

// Node 20+ 禁止 execFile 直接 spawn .cmd；用 node 调 npm 自身的 CLI 入口
function runNpm(args, opts) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return run(process.execPath, [cli].concat(args), opts);
  return run('npm.cmd', args, Object.assign({ shell: true }, opts));
}

function runElectronBuilder(worktree, args) {
  const cli = path.join(worktree, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  run(process.execPath, [cli].concat(args), { cwd: worktree });
}

function buildAndVerify(opts, version) {
  const { ensureElectron } = require('./ensure-electron.js');
  const wt = path.resolve(opts.worktree || '../lightframe-worklog-clean');
  const out = path.join(wt, 'dist-release-' + version);
  const card = path.resolve(opts['change-card']);
  const evidence = path.resolve(opts['review-evidence']);
  run('git', ['-C', wt, 'checkout', '--detach', git(['rev-parse', 'HEAD'])]);
  runNpm(['ci'], { cwd: wt });
  const electronPkg = require(path.join(wt, 'node_modules', 'electron', 'package.json')).version;
  ensureElectron({
    version: electronPkg,
    distDir: path.join(wt, 'node_modules', 'electron', 'dist'),
    cacheRoot: path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
  });
  runNpm(['test'], { cwd: wt });
  runNpm(['run', 'test:release'], { cwd: wt });
  run(process.execPath, ['tools/smoke-boot.js'], { cwd: wt });
  run(process.execPath, ['tools/verify-lan.js', '--self-host'], { cwd: wt });
  const buildArgs = ['--win', 'nsis', '--config.directories.output=' + out];
  if (opts['electron-dist']) buildArgs.push('--config.electronDist=' + path.resolve(opts['electron-dist']));
  runElectronBuilder(wt, buildArgs);
  const exe = fs.readdirSync(out).find((f) => / Setup .*\.exe$/i.test(f) && !/uninstaller/i.test(f));
  if (!exe) throw new Error('未找到 NSIS 安装器: ' + out);
  const appExe = path.join(out, 'win-unpacked', '光影工作志.exe');
  run(process.execPath, ['tools/smoke-ui.js'], { cwd: wt, env: Object.assign({}, process.env, { SMOKE_EXE: appExe, SMOKE_PORT: '9761' }) });
  run(process.execPath, ['tools/smoke-ui.js'], { cwd: wt, env: Object.assign({}, process.env, { SMOKE_EXE: appExe, SMOKE_PORT: '9762' }) });
  run(process.execPath, ['tools/smoke-ui.js'], { cwd: wt, env: Object.assign({}, process.env, { SMOKE_EXE: appExe, SMOKE_PORT: '9763' }) });
  const installer = path.join(out, exe);
  const md5 = lib.md5File(installer);
  run('python', ['scripts/release_gate.py', path.join(out, 'win-unpacked', 'resources', 'app.asar'),
    '--marker', '"version": "' + version + '"', '--absent-marker', opts['absent-marker'] || '"version": "2.11.1"',
    '--change-card', card, '--review-evidence', evidence, '--json'], { cwd: wt });
  run('python', ['scripts/release_gate.py', installer, '--md5', md5,
    '--change-card', card, '--review-evidence', evidence, '--json'], { cwd: wt });
  return { wt, out, installer };
}

function collectMaterials(opts, version, installer, out) {
  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });
  const setup = path.join(distDir, 'lightframe-worklog-setup-' + version + '.exe');
  fs.copyFileSync(installer, setup);
  const blockmap = installer + '.blockmap';
  if (fs.existsSync(blockmap)) fs.copyFileSync(blockmap, setup + '.blockmap');
  const latest = path.join(out, 'latest.yml');
  if (fs.existsSync(latest)) fs.copyFileSync(latest, path.join(distDir, 'latest.yml'));
  const assets = [setup, setup + '.blockmap', path.join(distDir, 'latest.yml')]
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ name: path.basename(f), size: fs.statSync(f).size, sha256: lib.sha256File(f) }));
  fs.writeFileSync(path.join(distDir, 'release-notes-' + version + '.md'),
    lib.renderReleaseNotes({ version, changeSummary: opts['change-summary'], assets }));
  const files = assets.map((a) => 'dist/' + a.name);
  console.log(lib.releaseCommands(version, files).join('\n'));
}

if (require.main === module) {
  const opts = lib.parseReleaseArgs(process.argv.slice(2));
  const version = preflight(opts);
  if (!opts.check) {
    const { out, installer } = buildAndVerify(opts, version);
    collectMaterials(opts, version, installer, out);
  }
}
module.exports = { preflight, buildAndVerify, collectMaterials };
