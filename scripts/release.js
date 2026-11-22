'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('./release-lib.js');
const updateLib = require('../tools/verify-update-lib.js');

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
  if (!result.ok) throw new Error(result.errors.join('\n'));
  // 发布文档检查仅在完整模式执行；--check 只做代码/版本预检
  if (!opts.check) {
    for (const key of ['change-card', 'review-evidence']) {
      if (!opts[key] || opts[key] === true || !fs.existsSync(opts[key])) throw new Error('缺少 --' + key);
    }
    execFileSync('python', ['scripts/check_change_card.py', opts['change-card'], '--json'], { stdio: 'inherit' });
    execFileSync('python', ['scripts/check_review_evidence.py', opts['review-evidence'], '--json', '--require-second'], { stdio: 'inherit' });
  }
  console.log('release preflight OK: v' + version);
  return version;
}

function noopLog() { return { file: null, log() {} }; }

function makeLogger(version) {
  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });
  const file = path.join(distDir, 'release-' + version + '.log');
  fs.writeFileSync(file, '');
  return {
    file,
    log(msg) {
      const line = '[' + new Date().toISOString() + '] ' + msg;
      console.log(line);
      fs.appendFileSync(file, line + '\n');
    }
  };
}

function run(cmd, args, opts) { execFileSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts)); }

// Node 20+ 禁止 execFile 直接 spawn .cmd；用 node 调 npm 自身的 CLI 入口
function runNpm(args, opts) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return run(process.execPath, [cli].concat(args), opts);
  return run('npm.cmd', args, Object.assign({ shell: true }, opts));
}

function runLogged(log, label, cmd, args, opts) {
  log.log('CMD ' + label + ': ' + cmd + ' ' + args.join(' '));
  try {
    run(cmd, args, opts);
  } catch (e) {
    log.log('FAIL ' + label + ': ' + (e && e.message ? e.message : e));
    throw e;
  }
  log.log('OK ' + label);
}

function runNpmLogged(log, label, args, opts) {
  log.log('CMD ' + label + ': npm ' + args.join(' '));
  try {
    runNpm(args, opts);
  } catch (e) {
    log.log('FAIL ' + label + ': ' + (e && e.message ? e.message : e));
    throw e;
  }
  log.log('OK ' + label);
}

function runElectronBuilder(worktree, args) {
  const cli = path.join(worktree, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  run(process.execPath, [cli].concat(args), { cwd: worktree });
}

function resolvePreviousTag(version) {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--exclude', 'v' + version]);
  } catch (e) {
    throw new Error('无法从 git describe 推导 previous-version，请显式传 --previous-version');
  }
}

function buildAndVerify(opts, version, absentMarker, log) {
  log = log || noopLog();
  const { ensureElectron } = require('./ensure-electron.js');
  const wt = path.resolve(opts.worktree || '../lightframe-worklog-clean');
  const out = path.join(wt, 'dist-release-' + version);
  const card = path.resolve(opts['change-card']);
  const evidence = path.resolve(opts['review-evidence']);
  runLogged(log, 'worktree 切到当前 HEAD', 'git', ['-C', wt, 'checkout', '--detach', git(['rev-parse', 'HEAD'])]);
  const wtStatus = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' });
  if (!lib.isCleanStatus(wtStatus)) throw new Error('构建 worktree 不干净：\n' + wtStatus.trim());
  log.log('OK 构建 worktree 干净: ' + wt);
  for (const rel of lib.collectSyntaxTargets(wt)) {
    runLogged(log, '语法 ' + rel, process.execPath, ['--check', rel], { cwd: wt });
  }
  runNpmLogged(log, 'npm ci', ['ci'], { cwd: wt });
  const electronPkg = require(path.join(wt, 'node_modules', 'electron', 'package.json')).version;
  ensureElectron({
    version: electronPkg,
    distDir: path.join(wt, 'node_modules', 'electron', 'dist'),
    cacheRoot: path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
  });
  log.log('OK Electron ' + electronPkg);
  runNpmLogged(log, 'npm test', ['test'], { cwd: wt });
  runNpmLogged(log, 'npm run test:release', ['run', 'test:release'], { cwd: wt });
  runLogged(log, 'smoke:boot', process.execPath, ['tools/smoke-boot.js'], { cwd: wt });
  runLogged(log, 'verify-lan --self-host', process.execPath, ['tools/verify-lan.js', '--self-host'], { cwd: wt });
  const buildArgs = ['--win', 'nsis', '--publish', 'never', '--config.directories.output=' + out];
  if (opts['electron-dist']) buildArgs.push('--config.electronDist=' + path.resolve(opts['electron-dist']));
  log.log('CMD electron-builder: ' + buildArgs.join(' '));
  runElectronBuilder(wt, buildArgs);
  log.log('OK electron-builder');
  const exe = fs.readdirSync(out).find((f) => / Setup .*\.exe$/i.test(f) && !/uninstaller/i.test(f));
  if (!exe) throw new Error('未找到 NSIS 安装器: ' + out);
  log.log('OK 安装器: ' + exe);
  const payloadDir = path.join(out, 'win-unpacked');
  const payloadErrs = lib.verifyRuntimePayload(payloadDir);
  if (payloadErrs.length) throw new Error('运行时载荷断言失败:\n' + payloadErrs.join('\n'));
  log.log('OK 运行时载荷: ffmpeg.dll/dxcompiler.dll 非空，default_app.asar 缺席');
  const appExe = path.join(payloadDir, '光影工作志.exe');
  runLogged(log, 'UI 烟测 9761', process.execPath, ['tools/smoke-ui.js'], { cwd: wt, env: Object.assign({}, process.env, { SMOKE_EXE: appExe, SMOKE_PORT: '9761' }) });
  runLogged(log, 'UI 烟测 9762', process.execPath, ['tools/smoke-ui.js'], { cwd: wt, env: Object.assign({}, process.env, { SMOKE_EXE: appExe, SMOKE_PORT: '9762' }) });
  runLogged(log, 'UI 烟测 9763', process.execPath, ['tools/smoke-ui.js'], { cwd: wt, env: Object.assign({}, process.env, { SMOKE_EXE: appExe, SMOKE_PORT: '9763' }) });
  const installer = path.join(out, exe);
  const md5 = lib.md5File(installer);
  runLogged(log, 'release_gate asar', 'python', ['scripts/release_gate.py', path.join(payloadDir, 'resources', 'app.asar'),
    '--marker', '"version": "' + version + '"', '--absent-marker', absentMarker,
    '--change-card', card, '--review-evidence', evidence, '--json'], { cwd: wt });
  runLogged(log, 'release_gate 安装包', 'python', ['scripts/release_gate.py', installer, '--md5', md5,
    '--change-card', card, '--review-evidence', evidence, '--json'], { cwd: wt });
  return { wt, out, installer };
}

function collectMaterials(opts, version, installer, out, log) {
  log = log || noopLog();
  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });
  const outLatest = path.join(out, 'latest.yml');
  const outBlockmap = installer + '.blockmap';
  const missing = [installer, outLatest, outBlockmap].filter((f) => !fs.existsSync(f) || !fs.statSync(f).isFile());
  if (missing.length) throw new Error('构建产物缺少: ' + missing.join(', '));
  log.log('OK 构建产物齐全: 安装包 / latest.yml / blockmap');
  const setupName = 'lightframe-worklog-setup-' + version + '.exe';
  const setup = path.join(distDir, setupName);
  fs.copyFileSync(installer, setup);
  fs.copyFileSync(outBlockmap, setup + '.blockmap');
  const latestText = lib.rewriteLatestArtifact(fs.readFileSync(outLatest, 'utf8'), setupName);
  const latestInfo = updateLib.parseLatestYml(latestText);
  const size = fs.statSync(setup).size;
  const sha512 = lib.sha512Base64File(setup);
  const errs = lib.reconcileLatest({ latest: latestInfo, version, size, sha512 });
  if (errs.length) throw new Error('发布材料对账失败:\n' + errs.join('\n'));
  log.log('OK latest.yml 对账: version=' + version + ' size=' + size + ' sha512=' + sha512);
  fs.writeFileSync(path.join(distDir, 'latest.yml'), latestText);
  const assets = [setup, setup + '.blockmap', path.join(distDir, 'latest.yml')]
    .map((f) => ({
      name: path.basename(f),
      size: fs.statSync(f).size,
      sha256: lib.sha256File(f),
      sha512: lib.sha512Base64File(f)
    }));
  fs.writeFileSync(path.join(distDir, 'release-notes-' + version + '.md'),
    lib.renderReleaseNotes({ version, changeSummary: opts['change-summary'], assets }));
  log.log('OK 发布材料: ' + assets.map((a) => 'dist/' + a.name).join(', '));
  const files = assets.map((a) => 'dist/' + a.name);
  console.log(lib.releaseCommands(version, files).join('\n'));
  return distDir;
}

function verifyUpdate(opts, version, log) {
  log = log || noopLog();
  const oldAppDir = path.resolve(opts['old-app-dir']);
  if (!fs.existsSync(oldAppDir)) throw new Error('--old-app-dir 不存在: ' + oldAppDir);
  const testRoot = opts['test-root'] && opts['test-root'] !== true
    ? path.resolve(opts['test-root'])
    : fs.mkdtempSync(path.join(os.tmpdir(), 'lw-update-e2e-' + version + '-'));
  const logFile = path.resolve('.release-logs', 'release-' + version + '.verify-update.log');
  const args = lib.verifyUpdateArgs({ oldAppDir, newDir: 'dist', testRoot, logFile });
  runLogged(log, 'verify-update', process.execPath, args);
  log.log('OK 更新下载验证通过，日志: ' + logFile);
}

if (require.main === module) {
  const opts = lib.parseReleaseArgs(process.argv.slice(2));
  if (opts.check) {
    try {
      preflight(opts);
    } catch (e) {
      console.error(e && e.message ? e.message : e);
      process.exit(1);
    }
  } else {
    const version = opts.version || require('../package.json').version;
    const log = makeLogger(version);
    try {
      log.log('release v' + version + ' 完整模式开始');
      log.log('参数: ' + JSON.stringify(opts));
      const optErrs = lib.updateOptionsErrors(opts);
      if (optErrs.length) throw new Error(optErrs.join('\n'));
      const v = preflight(opts);
      log.log('OK 预检 v' + v);
      let absentMarker;
      try {
        absentMarker = lib.resolveAbsentMarker({
          version: v,
          previousVersion: opts['previous-version'] || resolvePreviousTag(v),
          explicit: opts['absent-marker']
        });
      } catch (e) { throw new Error(e.message); }
      log.log('absent-marker: ' + absentMarker);
      const { out, installer } = buildAndVerify(opts, v, absentMarker, log);
      collectMaterials(opts, v, installer, out, log);
      if (opts['skip-update'] === true) {
        log.log('SKIP verify-update: 显式 --skip-update');
      } else {
        verifyUpdate(opts, v, log);
      }
      log.log('RESULT PASS');
      console.log('发布日志: ' + log.file);
    } catch (e) {
      log.log('RESULT FAIL: ' + (e && e.message ? e.message : e));
      console.error(e && e.message ? e.message : e);
      process.exit(1);
    }
  }
}
module.exports = { preflight, buildAndVerify, collectMaterials, verifyUpdate, resolvePreviousTag };
