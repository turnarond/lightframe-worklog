// store —— 三个 JSON 文件的读写层（仅 CommonJS，主进程使用）
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const TaskModel = require('./taskModel.js');

const DEFAULT_SETTINGS = {
  categories: ['工作', '会议', '其他'],
  lastCategory: '工作',
  dailyReminder: { enabled: true, at: '17:30' },
  dueReminder: { enabled: true, at: '09:00' },
  launchAtLogin: true,
  alwaysOnTop: true,
  closeToTray: true,
  hotkey: 'Ctrl+Shift+Space',
  lastReminded: { daily: null, due: null },
  weeklyPlans: {},
  widget: {
    opacity: 0.9,
    blur: 14,
    clickThrough: false,
    expanded: false,
    rect: null
  }
};

const NESTED_SETTINGS = ['dailyReminder', 'dueReminder', 'lastReminded', 'weeklyPlans', 'widget'];
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

// 同步字段统一用毫秒时间戳；兼容历史 ISO 字符串
function toMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value) {
    const n = Date.parse(value);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/** 读取并解析 JSON；缺失 / 损坏 / 空文件一律返回 undefined，不抛错 */
async function readJson(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    return undefined;
  }
}

/** 递归建目录后写入 2 空格缩进的 JSON */
async function writeJson(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function createTaskStore(filePath) {
  return {
    async load() {
      const raw = await readJson(filePath);
      if (!Array.isArray(raw)) return [];
      return raw.map(function (item) {
        return TaskModel.normalizeTask(item);
      }).filter(Boolean);
    },
    async save(tasks) {
      const list = Array.isArray(tasks) ? tasks.map(function (item) {
        return TaskModel.normalizeTask(item);
      }).filter(Boolean) : [];
      await writeJson(filePath, list);
    }
  };
}

function createLogStore(filePath) {
  return {
    async load() {
      const raw = await readJson(filePath);
      if (!isPlainObject(raw)) return {};
      const out = {};
      Object.keys(raw).forEach(function (key) {
        if (!DATE_KEY_RE.test(key)) return;
        const entry = raw[key];
        if (!isPlainObject(entry)) return;
        out[key] = {
          date: key,
          progress: str(entry.progress),
          issues: str(entry.issues),
          plan: str(entry.plan),
          updatedAt: toMs(entry.updatedAt),
          deletedAt: entry.deletedAt ? toMs(entry.deletedAt) : null
        };
      });
      return out;
    },
    async save(logs) {
      const out = isPlainObject(logs) ? logs : {};
      await writeJson(filePath, out);
    }
  };
}

function mergeSettings(stored) {
  const defaults = clone(DEFAULT_SETTINGS);
  if (!isPlainObject(stored)) return defaults;

  const merged = Object.assign({}, defaults, stored);
  NESTED_SETTINGS.forEach(function (key) {
    merged[key] = Object.assign({}, defaults[key], isPlainObject(stored[key]) ? stored[key] : {});
  });
  const categories = Array.isArray(merged.categories) ? merged.categories.filter(function (c) {
    return typeof c === 'string' && c.length > 0;
  }) : [];
  merged.categories = categories.length ? categories : defaults.categories;
  return merged;
}

function createSettingsStore(filePath) {
  return {
    async load() {
      return mergeSettings(await readJson(filePath));
    },
    async save(settings) {
      await writeJson(filePath, mergeSettings(settings));
    }
  };
}

/**
 * 同步游标存储：记录每类内容的 lastPull 与 pushCursor（毫秒时间戳）。
 * 用于 SyncEngine 的增量拉/推，不入云、纯本机。
 */
function defaultSyncMeta() {
  return {
    tasks: { lastPull: 0, pushCursor: 0 },
    daily_logs: { lastPull: 0, pushCursor: 0 },
    prefs: { lastPull: 0, pushCursor: 0 }
  };
}

function createSyncMetaStore(filePath) {
  const TYPES = ['tasks', 'daily_logs', 'prefs'];
  return {
    async load() {
      const raw = await readJson(filePath);
      const out = defaultSyncMeta();
      if (isPlainObject(raw)) {
        TYPES.forEach(function (t) {
          if (isPlainObject(raw[t])) {
            out[t].lastPull = Number(raw[t].lastPull) || 0;
            out[t].pushCursor = Number(raw[t].pushCursor) || 0;
          }
        });
      }
      return out;
    },
    async save(meta) {
      await writeJson(filePath, meta);
    }
  };
}

module.exports = {
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  createTaskStore: createTaskStore,
  createLogStore: createLogStore,
  createSettingsStore: createSettingsStore,
  createSyncMetaStore: createSyncMetaStore
};
