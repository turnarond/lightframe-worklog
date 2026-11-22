'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { createBackupManager, DATA_FILES } = require('./backup.js');

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-backup-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'tasks.json'),
    JSON.stringify([{ id: 't1', title: '任务一' }]));
  await fsp.writeFile(path.join(dataDir, 'dailyLogs.json'),
    JSON.stringify({ '2026-11-21': { date: '2026-11-21', progress: '进展' } }));
  await fsp.writeFile(path.join(dataDir, 'settings.json'),
    JSON.stringify({ syncCode: 'ABCD-EFGH-JKLM-NPQR', serverUrl: 'https://sync.example.com' }));
  await fsp.writeFile(path.join(dataDir, 'syncmeta.json'), '{}');
  return { root, dataDir, backupDir };
}

test('beforeWrite 生成一致恢复点并可列出', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({
    dataDir, backupDir, appVersion: '2.11.0', now: () => 1700000000000
  });
  const result = await manager.beforeWrite('test');
  assert.equal(result.created, true);
  const list = await manager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].taskCount, 1);
  assert.equal(list[0].logDays, 1);
  assert.equal(list[0].hasSyncCode, true);
  for (const name of DATA_FILES) {
    assert.ok(fs.existsSync(path.join(backupDir, list[0].id, name)));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('相同内容不重复生成恢复点', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({
    dataDir, backupDir, appVersion: '2.11.0', now: () => 1700000000000
  });
  const first = await manager.beforeWrite('first');
  assert.equal(first.created, true);
  const second = await manager.beforeWrite('second');
  assert.equal(second.created, false);
  assert.equal(second.skipped, 'unchanged');
  assert.equal((await manager.list()).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('轮转保留最近 10 份与每日代表', async () => {
  const { root, dataDir, backupDir } = await setup();
  let clock = 1700000000000;
  const manager = createBackupManager({
    dataDir, backupDir, appVersion: '2.11.0', now: () => clock
  });
  for (let i = 0; i < 17; i++) {
    await fsp.writeFile(path.join(dataDir, 'tasks.json'),
      JSON.stringify([{ id: 't' + i, title: '任务' + i }]));
    clock += 86400000;
    await manager.beforeWrite('rotate');
  }
  const list = await manager.list();
  assert.ok(list.length >= 10, '至少保留最近 10 份，实际 ' + list.length);
  assert.ok(list.length <= 17, '最多保留 10 + 7，实际 ' + list.length);
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore 写回三份文件并生成 pre-restore', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({ dataDir, backupDir, appVersion: '2.11.0' });
  const first = await manager.beforeWrite('first');
  await fsp.writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify([{ id: 'new', title: '新任务' }]));
  const restored = await manager.restore(first.id);
  assert.ok(restored.preRestoreId);
  const tasks = JSON.parse(await fsp.readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.equal(tasks[0].id, 't1');
  const list = await manager.list();
  assert.ok(list.some((m) => m.reason === 'pre-restore'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('export 默认脱敏同步码', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({ dataDir, backupDir, appVersion: '2.11.0' });
  const first = await manager.beforeWrite('first');
  const out = await manager.exportBundle(first.id, { includeSecrets: false });
  const bundle = JSON.parse(out.text);
  assert.equal(bundle.files.settings.syncCode, '');
  assert.equal(bundle.files.settings.serverUrl, '');
  const raw = await manager.exportBundle(first.id, { includeSecrets: true });
  assert.equal(JSON.parse(raw.text).files.settings.syncCode, 'ABCD-EFGH-JKLM-NPQR');
  fs.rmSync(root, { recursive: true, force: true });
});

test('import 校验失败时不写盘', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({ dataDir, backupDir, appVersion: '2.11.0' });
  const bad = JSON.stringify({ format: 'lightframe-backup', formatVersion: 1, files: {}, checksums: {} });
  await assert.rejects(() => manager.importBundle(bad));
  fs.rmSync(root, { recursive: true, force: true });
});
