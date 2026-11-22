'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { createBackupManager, DATA_FILES, shouldAutoBackup } = require('./backup.js');

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

test('syncmeta 心跳不生成新恢复点', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({ dataDir, backupDir, appVersion: '2.11.0' });
  const first = await manager.beforeWrite('first');
  assert.equal(first.created, true);
  await fsp.writeFile(path.join(dataDir, 'syncmeta.json'), JSON.stringify({ lastSyncAt: Date.now() }));
  const second = await manager.beforeWrite('heartbeat');
  assert.equal(second.created, false);
  assert.equal((await manager.list()).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('同毫秒多次写入生成不同恢复点', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({
    dataDir, backupDir, appVersion: '2.11.0', now: () => 1700000000000
  });
  await manager.beforeWrite('first');
  await fsp.writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify([{ id: 't2', title: '任务二' }]));
  await manager.beforeWrite('second');
  const list = await manager.list();
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id);
  fs.rmSync(root, { recursive: true, force: true });
});

test('恢复点文件被篡改时拒绝恢复', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({ dataDir, backupDir, appVersion: '2.11.0' });
  const point = await manager.beforeWrite('first');
  await fsp.appendFile(path.join(backupDir, point.id, 'tasks.json'), ' ');
  await assert.rejects(() => manager.restore(point.id), /恢复点校验失败/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('导出→导入→恢复 roundtrip', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({ dataDir, backupDir, appVersion: '2.11.0' });
  const point = await manager.beforeWrite('first');
  const out = await manager.exportBundle(point.id, { includeSecrets: true });
  await fsp.writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify([{ id: 'other', title: '其他' }]));
  const parsed = await manager.importBundle(out.text);
  await manager.restoreBundle(parsed.bundle);
  const tasks = JSON.parse(await fsp.readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.equal(tasks[0].id, 't1');
  fs.rmSync(root, { recursive: true, force: true });
});

test('自动备份开关默认开，显式 false 才关闭', () => {
  assert.equal(shouldAutoBackup({}), true);
  assert.equal(shouldAutoBackup({ backup: { enabled: true } }), true);
  assert.equal(shouldAutoBackup({ backup: { enabled: false } }), false);
});

test('仅挂件位置与提醒去重变化不生成恢复点', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({ dataDir, backupDir, appVersion: '2.11.0' });
  await manager.beforeWrite('first');
  const settingsPath = path.join(dataDir, 'settings.json');
  const settings = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  settings.lastReminded = { todoHour: '2026-11-22-18' };
  settings.widget = { rect: { x: 10, y: 20 } };
  await fsp.writeFile(settingsPath, JSON.stringify(settings));
  const second = await manager.beforeWrite('layout');
  assert.equal(second.created, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('非法恢复点 ID 被拒绝', async () => {
  const { root, dataDir, backupDir } = await setup();
  const manager = createBackupManager({ dataDir, backupDir, appVersion: '2.11.0' });
  await assert.rejects(() => manager.restore('../outside'), /恢复点 ID 非法/);
  fs.rmSync(root, { recursive: true, force: true });
});
