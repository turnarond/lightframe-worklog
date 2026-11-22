'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_FILES = ['tasks.json', 'dailyLogs.json', 'settings.json', 'syncmeta.json'];

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function localDay(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
}

function idFor(ts) {
  const d = new Date(ts);
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3);
}

async function readIfExists(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function countTasks(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.length : 0;
  } catch (e) {
    return 0;
  }
}

function countLogs(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).length : 0;
  } catch (e) {
    return 0;
  }
}

function hasSyncCode(text) {
  try {
    const v = JSON.parse(text);
    return !!(v && v.syncCode);
  } catch (e) {
    return false;
  }
}

function createBackupManager(options) {
  const dataDir = options.dataDir;
  const backupDir = options.backupDir;
  const appVersion = options.appVersion || '';
  const recentLimit = options.recentLimit || 10;
  const dailyDays = options.dailyDays || 7;
  const now = options.now || Date.now;
  let queue = Promise.resolve();

  async function list() {
    let entries = [];
    try {
      entries = await fsp.readdir(backupDir);
    } catch (e) {
      return [];
    }
    const out = [];
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(backupDir, name, 'meta.json'), 'utf8'));
        if (meta && meta.id === name) out.push(meta);
      } catch (e) {
        // 未完成或损坏的恢复点忽略
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function prune() {
    const all = await list();
    const keep = new Set(all.slice(0, recentLimit).map((m) => m.id));
    const seen = new Set();
    for (const meta of all) {
      const day = localDay(meta.createdAt);
      if (seen.has(day) || seen.size >= dailyDays) continue;
      if (now() - meta.createdAt > dailyDays * 86400000) continue;
      seen.add(day);
      keep.add(meta.id);
    }
    for (const meta of all) {
      if (keep.has(meta.id)) continue;
      try {
        await fsp.rm(path.join(backupDir, meta.id), { recursive: true, force: true });
      } catch (e) {
        // 删除失败下次轮转重试
      }
    }
  }

  async function beforeWrite(reason) {
    const run = async () => {
      const contents = {};
      let any = false;
      for (const name of DATA_FILES) {
        const text = await readIfExists(path.join(dataDir, name));
        if (text !== null) any = true;
        contents[name] = text === null ? 'null' : text;
      }
      if (!any) return { created: false, skipped: 'empty' };
      const setHash = sha256(DATA_FILES.map((name) => sha256(contents[name])).join(''));
      const existing = await list();
      if (existing.length && existing[0].setHash === setHash) {
        return { created: false, setHash, skipped: 'unchanged' };
      }

      const ts = now();
      const id = idFor(ts);
      const tmpDir = path.join(backupDir, '.tmp-' + id);
      const finalDir = path.join(backupDir, id);
      await fsp.mkdir(tmpDir, { recursive: true });
      const files = {};
      for (const name of DATA_FILES) {
        await fsp.writeFile(path.join(tmpDir, name), contents[name], 'utf8');
        files[name] = { sha256: sha256(contents[name]), size: Buffer.byteLength(contents[name]) };
      }
      const meta = {
        id,
        createdAt: ts,
        reason: reason || 'write',
        appVersion,
        setHash,
        files,
        taskCount: countTasks(contents['tasks.json']),
        logDays: countLogs(contents['dailyLogs.json']),
        hasSyncCode: hasSyncCode(contents['settings.json'])
      };
      await fsp.writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      await fsp.rename(tmpDir, finalDir);
      await prune();
      return { created: true, id, setHash };
    };
    const result = queue.then(run, run);
    queue = result.then(() => {}, () => {});
    return result;
  }

  async function spaceUsage() {
    let total = 0;
    let entries = [];
    try {
      entries = await fsp.readdir(backupDir);
    } catch (e) {
      return 0;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const dir = path.join(backupDir, name);
      try {
        for (const file of await fsp.readdir(dir)) {
          total += (await fsp.stat(path.join(dir, file))).size;
        }
      } catch (e) {
        // 未完成恢复点忽略
      }
    }
    return total;
  }

  return { beforeWrite, list, prune, spaceUsage };
}

module.exports = {
  DATA_FILES,
  createBackupManager,
  sha256,
  localDay
};
