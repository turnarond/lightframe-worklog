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
      let id = idFor(ts);
      let suffix = 0;
      while (fs.existsSync(path.join(backupDir, id))) {
        suffix += 1;
        id = idFor(ts) + '-' + suffix;
      }
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

  async function writeAtomic(file, text) {
    const tmp = file + '.tmp';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
  }

  function checksumOf(value) {
    return sha256(JSON.stringify(value));
  }

  function maskSettings(text, includeSecrets) {
    const s = JSON.parse(text);
    if (!includeSecrets) {
      s.syncCode = '';
      s.serverUrl = '';
    }
    return s;
  }

  async function restoreSet(id) {
    const dir = path.join(backupDir, id);
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) throw new Error('恢复点不存在');
    const pre = await beforeWrite('pre-restore');
    const files = ['tasks.json', 'dailyLogs.json', 'settings.json'];
    const originals = {};
    const restored = [];
    try {
      for (const name of files) {
        const text = await fsp.readFile(path.join(dir, name), 'utf8');
        JSON.parse(text); // 恢复点损坏时先失败，不覆盖现有数据
        const target = path.join(dataDir, name);
        originals[name] = await fsp.readFile(target, 'utf8').catch(() => null);
        await writeAtomic(target, text);
        restored.push(name);
      }
      return { preRestoreId: pre.id || '', restoredFiles: restored };
    } catch (err) {
      for (const name of restored) {
        const target = path.join(dataDir, name);
        if (originals[name] === null) await fsp.rm(target, { force: true });
        else await writeAtomic(target, originals[name]);
      }
      throw err;
    }
  }

  async function exportBundle(id, opts) {
    const includeSecrets = !!(opts && opts.includeSecrets);
    const dir = path.join(backupDir, id);
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
    const files = {
      tasks: JSON.parse(await fsp.readFile(path.join(dir, 'tasks.json'), 'utf8')),
      dailyLogs: JSON.parse(await fsp.readFile(path.join(dir, 'dailyLogs.json'), 'utf8')),
      settings: maskSettings(await fsp.readFile(path.join(dir, 'settings.json'), 'utf8'), includeSecrets),
      syncmeta: JSON.parse(await fsp.readFile(path.join(dir, 'syncmeta.json'), 'utf8'))
    };
    const checksums = {};
    Object.keys(files).forEach((key) => { checksums[key] = checksumOf(files[key]); });
    return {
      text: JSON.stringify({
        format: 'lightframe-backup',
        formatVersion: 1,
        exportedAt: new Date(now()).toISOString(),
        appVersion,
        files,
        checksums
      }, null, 2),
      filename: 'lightframe-backup-' + meta.id + '.json'
    };
  }

  function assertBundleShape(bundle) {
    if (!bundle || bundle.format !== 'lightframe-backup' || bundle.formatVersion !== 1) {
      throw new Error('不是受支持的备份文件');
    }
    if (!bundle.files || typeof bundle.files !== 'object') throw new Error('备份文件缺少 files');
    if (!Array.isArray(bundle.files.tasks)) throw new Error('tasks 必须是数组');
    for (const key of ['dailyLogs', 'settings', 'syncmeta']) {
      if (!bundle.files[key] || typeof bundle.files[key] !== 'object' || Array.isArray(bundle.files[key])) {
        throw new Error(key + ' 必须是对象');
      }
    }
    if (!bundle.checksums || typeof bundle.checksums !== 'object') throw new Error('备份缺少 checksums');
  }

  async function importBundle(text) {
    const bundle = JSON.parse(text);
    assertBundleShape(bundle);
    for (const key of ['tasks', 'dailyLogs', 'settings', 'syncmeta']) {
      if (!(key in bundle.files)) throw new Error('备份缺少 ' + key);
      if (checksumOf(bundle.files[key]) !== bundle.checksums[key]) {
        throw new Error(key + ' 校验失败');
      }
    }
    return {
      bundle,
      summary: {
        taskCount: Array.isArray(bundle.files.tasks) ? bundle.files.tasks.length : 0,
        logDays: Object.keys(bundle.files.dailyLogs || {}).length,
        hasSyncCode: !!(bundle.files.settings && bundle.files.settings.syncCode)
      }
    };
  }

  async function restoreBundle(bundle) {
    assertBundleShape(bundle);
    const pre = await beforeWrite('pre-restore');
    const writes = [
      ['tasks.json', bundle.files.tasks],
      ['dailyLogs.json', bundle.files.dailyLogs],
      ['settings.json', bundle.files.settings]
    ];
    const originals = {};
    const done = [];
    try {
      for (const [name, value] of writes) {
        const target = path.join(dataDir, name);
        originals[name] = await fsp.readFile(target, 'utf8').catch(() => null);
        await writeAtomic(target, JSON.stringify(value, null, 2));
        done.push(name);
      }
      return { preRestoreId: pre.id || '', restoredFiles: done };
    } catch (err) {
      for (const name of done) {
        const target = path.join(dataDir, name);
        if (originals[name] === null) await fsp.rm(target, { force: true });
        else await writeAtomic(target, originals[name]);
      }
      throw err;
    }
  }

  return {
    beforeWrite, list, prune, spaceUsage,
    restore: restoreSet, exportBundle, importBundle, restoreBundle, checksumOf
  };
}

module.exports = {
  DATA_FILES,
  createBackupManager,
  sha256,
  localDay
};
