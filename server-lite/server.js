// server-lite —— 同步码多设备同步服务端
// 零 npm 依赖，Node 原生 http + fs；单文件 JSON 存储，temp + rename 原子写。
// 协议严格兼容 src/sync.js 的 SyncEngine（Bearer / pull / push / LWW / server_time）。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const SyncCode = require('../src/syncCode.js');

const TYPES = ['tasks', 'daily_logs', 'prefs'];
const KEY_OF = { tasks: 'id', daily_logs: 'date', prefs: 'key' };

function emptySpace() {
  return { version: 1, records: { tasks: {}, daily_logs: {}, prefs: {} } };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function fail(status, message) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) { tooBig = true; return; }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (tooBig) return reject(fail(413, 'request body too large'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function createApp(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  const now = opts.now || Date.now;
  const maxBody = opts.maxBody || 1024 * 1024;
  const maxRecords = opts.maxRecords || 20000;
  const log = opts.log || function () {};
  fs.mkdirSync(dataDir, { recursive: true });

  // 所有写操作串行化，避免多设备并发覆盖同一文件
  let writeChain = Promise.resolve();

  // 单调递增的服务端逻辑时钟：pull 用它做增量游标，避免混用客户端 updatedAt 与服务端时间
  let lastTime = 0;
  function tick() {
    lastTime = Math.max(now(), lastTime + 1);
    return lastTime;
  }

  function spaceFile(code) {
    const id = crypto.createHash('sha256').update(code).digest('hex').slice(0, 32);
    return path.join(dataDir, id + '.json');
  }

  async function loadSpace(file) {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!parsed || !parsed.records || typeof parsed.records !== 'object') throw new Error('bad shape');
      const data = emptySpace();
      TYPES.forEach(function (t) {
        if (parsed.records[t] && typeof parsed.records[t] === 'object') data.records[t] = parsed.records[t];
      });
      return data;
    } catch (err) {
      if (err.code === 'ENOENT') return emptySpace();
      // 损坏文件隔离，返回空空间；客户端下一轮 push 会用本地数据补齐
      try { await fsp.rename(file, file + '.bad'); } catch (e) { /* 忽略 */ }
      log('warn', 'corrupt space isolated: ' + path.basename(file));
      return emptySpace();
    }
  }

  async function saveSpace(file, data) {
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, file);
  }

  function withSpace(file, mutate) {
    const job = writeChain.then(async function () {
      const data = await loadSpace(file);
      await mutate(data);
      await saveSpace(file, data);
    });
    writeChain = job.catch(function () {});
    return job;
  }

  function codeFrom(req) {
    const raw = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(raw);
    if (!m) throw fail(401, 'missing sync code');
    const code = SyncCode.normalizeSyncCode(m[1]);
    if (!SyncCode.isValidSyncCode(code)) throw fail(400, 'invalid sync code');
    return code;
  }

  async function handlePull(req, res, url, file) {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const asked = (url.searchParams.get('types') || '').split(',').filter(Boolean);
    const types = asked.length ? asked.filter((t) => TYPES.indexOf(t) >= 0) : TYPES.slice();
    const data = await loadSpace(file);
    const changes = [];
    types.forEach(function (typeName) {
      Object.keys(data.records[typeName]).forEach(function (key) {
        const row = data.records[typeName][key];
        if (!row) return;
        const stored = Number(row._storedAt !== undefined ? row._storedAt : row.updatedAt);
        if (stored > since) {
          const out = Object.assign({}, row, { type: typeName });
          delete out._storedAt;
          changes.push(out);
        }
      });
    });
    send(res, 200, { changes: changes, server_time: tick() });
  }

  async function handlePush(req, res, file) {
    const contentType = req.headers['content-type'] || '';
    if (contentType && contentType.indexOf('application/json') < 0) throw fail(415, 'content-type must be application/json');
    const raw = await readBody(req, maxBody);
    let body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { throw fail(400, 'invalid json'); }
    if (!body || !Array.isArray(body.changes)) throw fail(400, 'changes must be an array');

    const valid = body.changes.filter(function (c) {
      return c && typeof c === 'object' && TYPES.indexOf(c.type) >= 0 &&
        c[KEY_OF[c.type]] !== undefined && c[KEY_OF[c.type]] !== null &&
        Number.isFinite(Number(c.updatedAt));
    });

    let applied = 0;
    let conflicts = 0;
    let overflow = false;
    const stamp = tick();
    await withSpace(file, async function (data) {
      let total = TYPES.reduce((n, t) => n + Object.keys(data.records[t]).length, 0);
      valid.forEach(function (c) {
        const t = c.type;
        const key = String(c[KEY_OF[t]]);
        const store = data.records[t];
        const current = store[key];
        const incoming = Number(c.updatedAt);
        if (current && Number(current.updatedAt) >= incoming) { conflicts++; return; }
        if (!current) {
          if (total >= maxRecords) { overflow = true; return; }
          total++;
        }
        const row = Object.assign({}, c);
        delete row.type;
        row._storedAt = stamp;
        store[key] = row;
        applied++;
      });
    });
    if (overflow) throw fail(413, 'space record limit exceeded');
    send(res, 200, { applied: applied, conflicts: conflicts, server_time: stamp });
  }

  return function app(req, res) {
    (async function () {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return send(res, 200, { ok: true, service: 'lightframe-sync' });
      }
      const isPull = req.method === 'GET' && url.pathname === '/api/sync/pull';
      const isPush = req.method === 'POST' && url.pathname === '/api/sync/push';
      if (!isPull && !isPush) throw fail(404, 'not found');

      const file = spaceFile(codeFrom(req));
      log('info', req.method + ' ' + url.pathname + ' ' + path.basename(file).slice(0, 8));
      if (isPull) return await handlePull(req, res, url, file);
      return await handlePush(req, res, file);
    })().catch(function (err) {
      if (err && err.httpStatus) return send(res, err.httpStatus, { error: err.message });
      log('error', 'unhandled: ' + (err && err.message));
      send(res, 500, { error: 'internal error' });
    });
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const app = createApp({
    dataDir: dataDir,
    maxBody: Number(process.env.MAX_BODY || 1024 * 1024),
    log: function (level, msg) { console.log('[' + level + '] ' + msg); }
  });
  http.createServer(app).listen(port, function () {
    console.log('lightframe-sync listening on ' + port + ', data=' + dataDir);
  });
}

module.exports = { createApp: createApp };
