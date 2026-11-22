#!/usr/bin/env node
// 本地端到端更新验证：复制旧版解包目录到临时目录 → 改写其 app-update.yml 指向本地 generic feed
// → 经 CDP 触发检查/下载 → 校验缓存中的安装包哈希。不运行任何安装/卸载程序。
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('./verify-update-lib.js');

const CACHE_NAME = 'lw-update-e2e';
const APP_EXE = '光影工作志.exe';
const LOCAL_BASE = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING_BASE = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DAILY_INSTALLS = [
  'C:\\Program Files\\lightframe-worklog',
  path.join(LOCAL_BASE, 'Programs', 'lightframe-worklog')
];
const DAILY_USER_DATA = path.join(ROAMING_BASE, 'lightframe-worklog');
const CACHE_DIR = path.join(LOCAL_BASE, CACHE_NAME);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('超时: ' + label)), ms);
    })
  ]);
}

let logStream = null;
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha512File(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function startServer(distDir, port) {
  const root = path.resolve(distDir);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    log('HTTP ' + req.method + ' ' + req.url);
    if (!rel || (file !== root && !file.startsWith(root + path.sep)) ||
        !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const stat = fs.statSync(file);
    res.setHeader('Content-Type', /\.ya?ml$/i.test(file) ? 'text/yaml' : 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function prepareOldApp(srcDir, testRoot) {
  const srcExe = path.join(srcDir, APP_EXE);
  if (!fs.existsSync(srcExe)) throw new Error('--old-app-dir 必须是已解包目录，不能传安装器: ' + srcDir);
  const app = path.join(testRoot, 'app');
  log('复制旧版解包目录: ' + srcDir + ' -> ' + app);
  fs.cpSync(srcDir, app, { recursive: true });
  const exe = path.join(app, APP_EXE);
  if (!fs.existsSync(exe)) throw new Error('未找到旧版 exe: ' + exe);
  return exe;
}

function patchFeed(appDir, url) {
  const yml = path.join(appDir, 'resources', 'app-update.yml');
  if (!fs.existsSync(yml)) throw new Error('缺少 app-update.yml: ' + yml);
  fs.writeFileSync(yml, lib.renderAppUpdateYml({ url: url, cacheName: CACHE_NAME }));
  return yml;
}

function launchApp(appExe, userDataDir, port) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const child = spawn(appExe, [
    '--user-data-dir=' + userDataDir,
    '--remote-debugging-port=' + port
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => log('[app:out] ' + l)));
  child.stderr.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => log('[app:err] ' + l)));
  return child;
}

async function connectCdp(port) {
  let page = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) });
      const list = await res.json();
      page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) break;
    } catch (e) { /* 端口未就绪 */ }
  }
  if (!page) throw new Error('CDP 页面未就绪');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await withTimeout(new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  }), 15000, 'WebSocket 打开');

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      log('[page] 异常: ' + (m.params.exceptionDetails && m.params.exceptionDetails.text));
    }
  });
  const send = (method, params) => withTimeout(new Promise((resolve) => {
    id++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  }), 15000, 'CDP ' + method);
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error('CDP ' + (r.error.message || JSON.stringify(r.error)));
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      const desc = d.exception && (d.exception.description || d.exception.value);
      throw new Error(desc || d.text || JSON.stringify(d));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ws: ws, send: send, ev: ev };
}

async function waitForDownload(ev) {
  const raw = await withTimeout(ev('new Promise(function (resolve, reject) {\n' +
    '  var done = false;\n' +
    '  function finish(fn, v) { if (done) return; done = true; fn(v); }\n' +
    '  window.api.onUpdate(function (s) {\n' +
    '    var m = (s && s.message) || "";\n' +
    '    if (m.indexOf("更新已下载") >= 0) finish(resolve, JSON.stringify(s));\n' +
    '    else if (m.indexOf("检查更新失败") >= 0) finish(reject, new Error(m));\n' +
    '    else if (m.indexOf("已是最新版本") >= 0) finish(reject, new Error(m));\n' +
    '  });\n' +
    '  Promise.resolve(window.api.checkUpdate()).catch(function (e) {\n' +
    '    finish(reject, new Error("checkUpdate 失败: " + (e && e.message ? e.message : e)));\n' +
    '  });\n' +
    '})'), 240000, '等待更新下载');
  return JSON.parse(raw);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
}

function rmrf(dir) {
  for (let i = 0; i < 30; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return true;
    } catch (e) { /* 文件占用，重试 */ }
    spawnSync('ping', ['-n', '2', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  }
  log('目录未完全删除: ' + dir);
  return false;
}

async function main() {
  const opts = lib.parseVerifyUpdateArgs(process.argv.slice(2));
  const testRoot = path.resolve(opts.testRoot);
  const newDir = path.resolve(opts.newDir);
  const oldAppDir = path.resolve(opts.oldAppDir);

  const errs = [];
  for (const daily of DAILY_INSTALLS) {
    for (const e of lib.assertSafeTestRoot({ testRoot: testRoot, dailyInstallPath: daily, dailyUserDataPath: DAILY_USER_DATA })) {
      if (errs.indexOf(e) < 0) errs.push(e);
    }
  }
  if (errs.length) throw new Error(errs.join('\n'));
  if (testRoot === CACHE_DIR || testRoot.startsWith(CACHE_DIR + path.sep)) {
    throw new Error('test-root 不得位于更新缓存目录: ' + CACHE_DIR);
  }
  if (!fs.existsSync(path.join(oldAppDir, APP_EXE))) {
    throw new Error('--old-app-dir 必须是已解包目录，不能传安装器: ' + oldAppDir);
  }
  if (!fs.existsSync(path.join(newDir, 'latest.yml'))) throw new Error('new-dir 缺少 latest.yml: ' + newDir);
  if (fs.existsSync(testRoot) && fs.readdirSync(testRoot).length) {
    throw new Error('test-root 已存在且非空，请先清理: ' + testRoot);
  }

  fs.mkdirSync(path.join(testRoot, 'logs'), { recursive: true });
  logStream = fs.createWriteStream(path.join(testRoot, 'logs', 'verify-update.log'), { flags: 'a' });
  log('参数: old-app-dir=' + oldAppDir + ' new-dir=' + newDir + ' test-root=' + testRoot);

  const info = lib.parseLatestYml(fs.readFileSync(path.join(newDir, 'latest.yml'), 'utf8'));
  const newInstaller = path.join(newDir, info.path);
  if (!fs.existsSync(newInstaller)) throw new Error('latest.yml 指向的安装包不存在: ' + newInstaller);
  const newSize = fs.statSync(newInstaller).size;
  if (info.size && newSize !== info.size) throw new Error('安装包 size 与 latest.yml 不一致: ' + newSize + ' != ' + info.size);
  const newSha256 = sha256File(newInstaller);
  const newSha512 = sha512File(newInstaller);
  if (info.sha512 && newSha512 !== info.sha512) throw new Error('安装包 sha512 与 latest.yml 不一致');
  log('新版本: ' + info.version + ' 安装包=' + info.path + ' size=' + newSize + ' sha256=' + newSha256);

  let child = null;
  let server = null;
  let session = null;
  let ok = false;
  try {
    const appExe = prepareOldApp(oldAppDir, testRoot);
    const userDataDir = path.join(testRoot, 'userdata');

    const feedPort = await pickPort();
    let debugPort = await pickPort();
    while (debugPort === feedPort) debugPort = await pickPort();
    server = await startServer(newDir, feedPort);
    const feedUrl = 'http://127.0.0.1:' + feedPort + '/';
    const yml = patchFeed(path.join(testRoot, 'app'), feedUrl);
    log('已改写 app-update.yml: ' + yml + ' -> ' + feedUrl + '（CDP 端口 ' + debugPort + '）');

    child = launchApp(appExe, userDataDir, debugPort);
    session = await connectCdp(debugPort);
    const current = await withTimeout(session.ev('window.api.getVersion()'), 20000, '读取当前版本');
    log('当前安装版本: ' + current);

    await waitForDownload(session.ev);
    log('收到 update-downloaded 事件');

    const hit = lib.findDownloadedInstaller(CACHE_DIR, newSha256);
    if (!hit) {
      let listing = '(缓存目录不存在)';
      if (fs.existsSync(CACHE_DIR)) listing = fs.readdirSync(CACHE_DIR, { withFileTypes: true })
        .map((e) => e.name + (e.isDirectory() ? '/' : '')).join(', ');
      throw new Error('未在更新缓存中找到 sha256 匹配的安装包: ' + CACHE_DIR + ' 内容: ' + listing);
    }
    const gotSha512 = sha512File(hit);
    const gotSize = fs.statSync(hit).size;
    if (info.sha512 && gotSha512 !== info.sha512) throw new Error('下载文件 sha512 不匹配');
    if (info.size && gotSize !== info.size) throw new Error('下载文件 size 不匹配: ' + gotSize);
    log('UPDATE_DOWNLOADED path=' + hit + ' sha256=' + newSha256 + ' sha512=' + gotSha512 + ' size=' + gotSize);
    log('完整安装不在脚本内执行；安装升级与 asar 版本核对见发布检查单（Windows Sandbox/测试用户）');
    log('RESULT PASS');
    ok = true;
  } catch (e) {
    log('RESULT FAIL: ' + (e && e.message ? e.message : e));
    throw e;
  } finally {
    if (session) { try { session.ws.close(); } catch (e) { /* 忽略 */ } }
    killTree(child);
    if (server) await new Promise((resolve) => server.close(resolve));
    rmrf(CACHE_DIR);
    if (ok) {
      rmrf(testRoot);
    } else {
      log('失败保留临时目录与日志: ' + testRoot);
    }
    if (logStream) logStream.end();
    logStream = null;
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('verify-update 失败:', e && e.message);
  process.exit(1);
});
