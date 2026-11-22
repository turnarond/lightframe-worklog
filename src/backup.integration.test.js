'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { createBackupManager } = require('./backup.js');
const { createTaskStore, createLogStore, createSettingsStore } = require('./store.js');

test('存储 + 备份：JSON 损坏后可从恢复点整份恢复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-backup-int-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fsp.mkdir(dataDir, { recursive: true });

  const manager = createBackupManager({ dataDir, backupDir, appVersion: '2.11.0' });
  const beforeWrite = function () { return manager.beforeWrite('write'); };
  const tasks = createTaskStore(path.join(dataDir, 'tasks.json'), { beforeWrite });
  const logs = createLogStore(path.join(dataDir, 'dailyLogs.json'), { beforeWrite });
  const settings = createSettingsStore(path.join(dataDir, 'settings.json'), { beforeWrite });

  await tasks.save([{ id: 't1', title: '原始任务', category: '工作', priority: 'mid' }]);
  await logs.save({ '2026-11-21': { date: '2026-11-21', progress: '原始进展' } });
  await settings.save({ categories: ['工作'], lastCategory: '工作' });

  const point = await manager.beforeWrite('manual');
  assert.equal(point.created, true);

  await tasks.save([{ id: 't2', title: '后来写入', category: '工作', priority: 'mid' }]);
  const tasksFile = path.join(dataDir, 'tasks.json');
  await fsp.writeFile(tasksFile, '{bad json', 'utf8');

  const corrupt = await tasks.loadWithStatus();
  assert.equal(corrupt.corrupt, true);
  assert.deepEqual(corrupt.data, []);

  const restored = await manager.restore(point.id);
  assert.ok(restored.preRestoreId);
  const good = await tasks.loadWithStatus();
  assert.equal(good.corrupt, false);
  assert.equal(good.data.length, 1);
  assert.equal(good.data[0].id, 't1');
  const logData = await logs.loadWithStatus();
  assert.equal(logData.data['2026-11-21'].progress, '原始进展');

  fs.rmSync(root, { recursive: true, force: true });
});
