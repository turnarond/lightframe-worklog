#!/usr/bin/env node
// 本地端到端更新验证：复制旧版解包目录到临时 test-root，注入本地 generic feed，
// 经 CDP 触发 check → download，并校验缓存安装包哈希。
// 不运行任何 NSIS 安装/卸载，不触碰日常安装与用户数据。
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
const DAILY_INSTALL = 'C:\\Program Files\\lightframe-worklog';
const DAILY_USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'lightframe-worklog');
const CONNECT_TIMEOUT_MS = 60000;
const DOWNLOAD_TIMEOUT_MS = 240000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let logStream = null;
const appLog = [];

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

function rewriteLatestVersion(text, version) {
  const src = String(text == null ? '' : text);
  if (!/^version:\s*\S+\s*$/m.test(src)) throw new Error('latest.yml 缺少 version 行');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version))) {
    throw new Error('目标版本格式不合法: ' + version);
  }
  return src.replace(/^version:\s*\S+\s*$/m, 'version: ' + version);
}

function isInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (process.platform === 'win32') {
    const rl = r.toLowerCase();
    const tl = t.toLowerCase();
    return tl === rl || tl.startsWith(rl + path.sep);
  }
  return t === r || t.startsWith(r + path.sep);
}

function resolveFeedFile(root, requestUrl) {
  let rel;
  try {
    rel = decodeURIComponent(String(requestUrl || '/').split('?')[0]);
  } catch (e) {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (!rel) return null;
  const file = path.resolve(root, rel);
  if (!isInside(root, file) || path.resolve(file) === path.resolve(root)) return null;
  return file;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha512File(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function inspectFeed(newDir) {
  const ymlPath = path.join(newDir, 'latest.yml');
  if (!fs.existsSync(ymlPath)) throw new Error('new-dir 缺少 latest.yml: ' + ymlPath);
  const info = lib.parseLatestYml(fs.readFileSync(ymlPath, 'utf8'));
  const installer = path.resolve(newDir, info.path);
  if (!isInside(newDir, installer)) throw new Error('latest.yml 指向 feed 目录之外: ' + installer);
  if (!fs.existsSync(installer) || !fs.statSync(installer).isFile()) {
    throw new Error('latest.yml 指向的安装包不存在: ' + installer);
  }
  const size = fs.statSync(installer).size;
  if (info.size != null && size !== info.size) {
    throw new Error('安装包 size 与 latest.yml 不一致: ' + size + ' != ' + info.size);
  }
  const sha512 = sha512File(installer);
  if (info.sha512 && sha512 !== info.sha512) {
    throw new Error('安装包 sha512 与 latest.yml 不一致');
  }
  return { info, installer, size, sha256: sha256File(installer), sha512 };
}

function pickPort(exclude) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        srv.close(() => {
          if (port === exclude) attempt();
          else resolve(port);
        });
      });
    };
    attempt();
  });
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || ''));
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : size - 1;
  if (!m[1] && m[2]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function startFeed(distDir) {
  const root = path.resolve(distDir);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.method + ' ' + req.url);
    log('HTTP ' + req.method + ' ' + req.url);
    const file = resolveFeedFile(root, req.url);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const stat = fs.statSync(file);
    res.setHeader('Content-Type', /\.ya?ml$/i.test(file) ? 'text/yaml' : 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = parseRange(req.headers.range, stat.size);
    if (range) {
      res.statusCode = 206;
      res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + stat.size);
      res.setHeader('Content-Length', range.end - range.start + 1);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, range).pipe(res);
      return;
    }
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

function patchFeed(appDir, url) {
  const yml = path.join(appDir, 'resources', 'app-update.yml');
  if (!fs.existsSync(yml)) throw new Error('缺少 app-update.yml: ' + yml);
  fs.writeFileSync(yml, lib.renderAppUpdateYml({ url, cacheName: CACHE_NAME }));
  return yml;
}

function prepareOldApp(srcDir, testRoot) {
  const dest = path.join(testRoot, 'app');
  log('复制旧版解包目录: ' + srcDir + ' -> ' + dest);
  fs.cpSync(srcDir, dest, { recursive: true });
  const exe = path.join(dest, APP_EXE);
  if (!fs.existsSync(exe)) throw new Error('未找到旧版 exe: ' + exe);
  return exe;
}

function launchApp(exe, dirs, port) {
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: dirs.localAppData,
    APPDATA: dirs.appData
  });
  log('启动旧版: ' + exe + ' cdp=' + port + ' userData=' + dirs.userData);
  const child = spawn(exe, [
    '--user-data-dir=' + dirs.userData,
    '--remote-debugging-port=' + port
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const collect = (prefix) => (d) => {
    String(d).split(/\r?\n/).filter(Boolean).forEach((line) => {
      appLog.push(prefix + line);
      if (appLog.length > 200) appLog.shift();
    });
  };
  child.stdout.on('data', collect('[app:out] '));
  child.stderr.on('data', collect('[app:err] '));
  return child;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  } catch (e) { /* 已退出 */ }
}

async function rmrf(dir) {
  for (let i = 0; i < 30; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return true;
    } catch (e) { /* 文件占用，重试 */ }
    await sleep(500);
  }
  return !fs.existsSync(dir);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('超时: ' + label)), ms);
    })
  ]);
}

async function connectCdp(port, child) {
  let page = null;
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('应用提前退出，exitCode=' + child.exitCode);
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
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  }), 15000, 'CDP ' + method);
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error('CDP ' + (r.error.message || JSON.stringify(r.error)));
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      const desc = d.exception && (d.exception.description || d.exception.value);
      throw new Error(desc || d.text || JSON.stringify(d));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ws, send, ev };
}

function listTree(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      out.push(path.relative(dir, p) + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) stack.push(p);
    }
  }
  return out;
}

async function waitForDownload(ev, child) {
  await ev('window.__lwUpdateEvents = []; window.api.onUpdate(function (s) { window.__lwUpdateEvents.push(s); }); window.api.checkUpdate(); true');
  const events = [];
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const raw = await ev('JSON.stringify(window.__lwUpdateEvents || [])');
    const list = JSON.parse(raw || '[]');
    for (let i = events.length; i < list.length; i++) log('更新事件: ' + JSON.stringify(list[i]));
    events.length = 0;
    events.push.apply(events, list);
    if (events.some((s) => /更新已下载/.test((s && s.message) || ''))) return events;
    const bad = events.find((s) => /检查更新失败|已是最新版本/.test((s && s.message) || ''));
    if (bad) throw new Error(bad.message);
    if (child.exitCode !== null) throw new Error('应用提前退出，exitCode=' + child.exitCode);
    await sleep(500);
  }
  throw new Error('等待更新下载超时（' + DOWNLOAD_TIMEOUT_MS + 'ms），事件: ' + JSON.stringify(events));
}

async function main() {
  const opts = lib.parseVerifyUpdateArgs(process.argv.slice(2));
  const testRoot = path.resolve(opts.testRoot);
  const newDir = path.resolve(opts.newDir);
  const oldAppDir = path.resolve(opts.oldAppDir);

  const errs = lib.assertSafeTestRoot({
    testRoot,
    dailyInstallPath: DAILY_INSTALL,
    dailyUserDataPath: DAILY_USER_DATA
  });
  if (errs.length) throw new Error(errs.join('; '));
  if (!fs.existsSync(path.join(oldAppDir, APP_EXE))) {
    throw new Error('--old-app-dir 必须是已解包目录（缺少 ' + APP_EXE + '）: ' + oldAppDir);
  }
  const feed = inspectFeed(newDir);
  if (fs.existsSync(testRoot) && fs.readdirSync(testRoot).length) {
    throw new Error('test-root 已存在且非空，请先清理: ' + testRoot);
  }

  fs.mkdirSync(testRoot, { recursive: true });
  logStream = fs.createWriteStream(path.join(testRoot, 'verify-update.log'), { flags: 'a' });
  log('参数: old-app-dir=' + oldAppDir + ' new-dir=' + newDir + ' test-root=' + testRoot);
  log('FEED version=' + feed.info.version + ' installer=' + feed.info.path +
    ' size=' + feed.size + ' sha256=' + feed.sha256);

  const dirs = {
    localAppData: path.join(testRoot, 'localappdata'),
    appData: path.join(testRoot, 'appdata'),
    userData: path.join(testRoot, 'userdata')
  };
  Object.keys(dirs).forEach((k) => fs.mkdirSync(dirs[k], { recursive: true }));

  let child = null;
  let server = null;
  let session = null;
  let ok = false;

  try {
    const appExe = prepareOldApp(oldAppDir, testRoot);
    const feedHandle = await startFeed(newDir);
    server = feedHandle.server;
    patchFeed(path.dirname(appExe), 'http://127.0.0.1:' + feedHandle.port + '/');
    log('feed 端口=' + feedHandle.port + '，CDP 端口另行分配');

    const debugPort = await pickPort(feedHandle.port);
    log('CDP 端口=' + debugPort);
    child = launchApp(appExe, dirs, debugPort);
    session = await connectCdp(debugPort, child);
    const oldVersion = await session.ev('window.api.getVersion()');
    log('OLD_APP version=' + oldVersion + ' feedVersion=' + feed.info.version);

    await waitForDownload(session.ev, child);
    log('收到 update-downloaded 事件');

    const cacheDir = path.join(dirs.localAppData, CACHE_NAME);
    const hit = lib.findDownloadedInstaller(cacheDir, feed.sha256);
    if (!hit) {
      let listing = '(缓存目录不存在)';
      if (fs.existsSync(cacheDir)) listing = listTree(cacheDir).join(', ');
      throw new Error('未在更新缓存中找到 sha256 匹配的安装包: ' + cacheDir + ' 内容: ' + listing);
    }
    const gotSize = fs.statSync(hit).size;
    const gotSha512 = sha512File(hit);
    if (feed.info.size != null && gotSize !== feed.info.size) {
      throw new Error('下载文件 size 不匹配: ' + gotSize + ' != ' + feed.info.size);
    }
    if (feed.info.sha512 && gotSha512 !== feed.info.sha512) throw new Error('下载文件 sha512 不匹配');
    log('UPDATE_DOWNLOADED path=' + hit + ' version=' + feed.info.version +
      ' sha256=' + feed.sha256 + ' sha512=' + gotSha512 + ' size=' + gotSize);
    log('feed 请求: ' + feedHandle.requests.join(' | '));
    log('完整安装不在脚本内执行；升级安装与 asar 版本核对见发布检查单（Windows Sandbox/测试用户）');
    log('RESULT PASS');
    ok = true;
  } catch (e) {
    log('RESULT FAIL: ' + (e && e.message ? e.message : e));
    if (appLog.length) log('应用日志尾:\n' + appLog.slice(-60).join('\n'));
    throw e;
  } finally {
    if (session) { try { session.ws.close(); } catch (e) { /* 忽略 */ } }
    killTree(child);
    if (server) await new Promise((resolve) => server.close(resolve));
    if (logStream) {
      const stream = logStream;
      logStream = null;
      await new Promise((resolve) => stream.end(resolve));
    }
    if (ok) {
      const removed = await rmrf(testRoot);
      console.log('已清理 test-root=' + testRoot + ' removed=' + removed);
    } else {
      console.log('失败现场已保留: ' + testRoot);
    }
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('verify-update 失败:', e && e.message);
    process.exit(1);
  });
}

module.exports = { rewriteLatestVersion, resolveFeedFile };
