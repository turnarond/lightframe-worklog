// taskModel —— 任务数据模型的纯函数层（UMD：Node 与浏览器共用）
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TaskModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PRIORITIES = ['high', 'mid', 'low'];
  const PRIORITY_LABEL = { high: '高', mid: '中', low: '低' };
  const UNCATEGORIZED = '未分类';

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function isValidDateStr(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    const parts = s.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function isValidIsoString(s) {
    return typeof s === 'string' && s.length > 0 && !Number.isNaN(Date.parse(s));
  }

  // 同步字段统一用「毫秒时间戳」做 LWW 比较；兼容历史 ISO 字符串
  function toMs(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v) {
      const n = Date.parse(v);
      if (!Number.isNaN(n)) return n;
    }
    return 0;
  }
  function toMsOrNull(v) {
    if (v === null || v === undefined) return null;
    const n = toMs(v);
    return n ? n : null;
  }

  function normalizePriority(p) {
    return PRIORITIES.indexOf(p) >= 0 ? p : 'mid';
  }

  function priorityRank(p) {
    const i = PRIORITIES.indexOf(p);
    return i >= 0 ? i : 1;
  }

  function todayString(date) {
    const d = date instanceof Date ? date : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function makeId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function createTask(input) {
    const raw = input || {};
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) return null;

    const category = typeof raw.category === 'string' ? raw.category.trim() : '';
    return {
      id: makeId(),
      title: title,
      category: category || UNCATEGORIZED,
      priority: normalizePriority(raw.priority),
      dueDate: isValidDateStr(raw.dueDate) ? raw.dueDate : null,
      details: typeof raw.details === 'string' ? raw.details : '',
      done: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
      completedOn: null,
      updatedAt: Date.now(),
      deletedAt: null
    };
  }

  function normalizeTask(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) return null;

    const category = typeof raw.category === 'string' ? raw.category.trim() : '';
    const id = typeof raw.id === 'string' && raw.id ? raw.id : makeId();

    return {
      id: id,
      title: title,
      category: category || UNCATEGORIZED,
      priority: normalizePriority(raw.priority),
      dueDate: isValidDateStr(raw.dueDate) ? raw.dueDate : null,
      details: typeof raw.details === 'string' ? raw.details : '',
      done: raw.done === true,
      createdAt: isValidIsoString(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
      completedAt: isValidIsoString(raw.completedAt) ? raw.completedAt : null,
      completedOn: isValidDateStr(raw.completedOn) ? raw.completedOn : null,
      updatedAt: toMs(raw.updatedAt),
      deletedAt: toMsOrNull(raw.deletedAt)
    };
  }

  /**
   * 不可变地更新某条任务：返回新数组，原数组与待更新对象都不被改动。
   * 不会覆盖其 id，并补上 updatedAt。
   */
  function updateTask(tasks, id, patch) {
    if (!Array.isArray(tasks) || !id) return tasks;
    var idx = -1;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i] && tasks[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return tasks;
    var updated = {};
    for (var k in tasks[idx]) { if (tasks[idx].hasOwnProperty(k)) updated[k] = tasks[idx][k]; }
    if (patch && typeof patch === 'object') {
      for (var p in patch) { if (patch.hasOwnProperty(p)) updated[p] = patch[p]; }
    }
    updated.id = tasks[idx].id;
    updated.updatedAt = Date.now();
    var copy = tasks.slice();
    copy[idx] = updated;
    return copy;
  }

  function completeTask(task, dateStr) {
    return Object.assign({}, task, {
      done: true,
      completedAt: new Date().toISOString(),
      completedOn: isValidDateStr(dateStr) ? dateStr : todayString(),
      updatedAt: Date.now()
    });
  }

  function uncompleteTask(task) {
    return Object.assign({}, task, {
      done: false,
      completedAt: null,
      completedOn: null,
      updatedAt: Date.now()
    });
  }

  /**
   * 软删：不移除对象，仅置 deletedAt（毫秒时间戳）；同时 bump updatedAt，
   * 这样删除作为一次「更新」参与 LWW，能被正确推送到云端并在多端传播。
   * 返回新数组，原数组不被改动。
   */
  function deleteTask(tasks, id) {
    if (!Array.isArray(tasks) || !id) return tasks;
    return tasks.map(function (t) {
      if (t && t.id === id) {
        const ts = Date.now();
        return Object.assign({}, t, { updatedAt: ts, deletedAt: ts });
      }
      return t;
    });
  }

  function isOverdue(task, today) {
    if (!task || task.done) return false;
    if (!isValidDateStr(task.dueDate)) return false;
    return task.dueDate < today;
  }

  function isDueToday(task, today) {
    if (!task || task.done) return false;
    return task.dueDate === today;
  }

  function groupTasks(tasks, today) {
    const groups = { overdue: [], today: [], upcoming: [], unscheduled: [], done: [] };
    (tasks || []).forEach(function (task) {
      if (!task) return;
      if (task.done) groups.done.push(task);
      else if (!isValidDateStr(task.dueDate)) groups.unscheduled.push(task);
      else if (task.dueDate < today) groups.overdue.push(task);
      else if (task.dueDate === today) groups.today.push(task);
      else groups.upcoming.push(task);
    });
    return groups;
  }

  function compareStr(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  function sortTasks(tasks) {
    return (tasks || []).slice().sort(function (a, b) {
      const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
      if (byPriority !== 0) return byPriority;

      const da = isValidDateStr(a.dueDate) ? a.dueDate : null;
      const db = isValidDateStr(b.dueDate) ? b.dueDate : null;
      if (da !== db) {
        if (da === null) return 1;
        if (db === null) return -1;
        return da < db ? -1 : 1;
      }
      return compareStr(a.createdAt || '', b.createdAt || '');
    });
  }

  function sortCompleted(tasks) {
    return (tasks || []).slice().sort(function (a, b) {
      const ca = a.completedAt || '';
      const cb = b.completedAt || '';
      if (ca === cb) return 0;
      if (!ca) return 1;
      if (!cb) return -1;
      return ca < cb ? 1 : -1;
    });
  }

  function countsByDate(tasks, year, month) {
    const prefix = year + '-' + pad2(month) + '-';
    const counts = {};
    (tasks || []).forEach(function (task) {
      if (!task || task.done) return;
      if (!isValidDateStr(task.dueDate)) return;
      if (task.dueDate.indexOf(prefix) !== 0) return;
      counts[task.dueDate] = (counts[task.dueDate] || 0) + 1;
    });
    return counts;
  }

  function searchTasks(tasks, q) {
    const list = tasks || [];
    const keyword = typeof q === 'string' ? q.trim().toLowerCase() : '';
    if (!keyword) return list.slice();
    return list.filter(function (task) {
      return task && typeof task.title === 'string' &&
        task.title.toLowerCase().indexOf(keyword) >= 0;
    });
  }

  function formatDateCN(dateStr) {
    if (!isValidDateStr(dateStr)) return '';
    const parts = dateStr.split('-');
    return Number(parts[1]) + '月' + Number(parts[2]) + '日';
  }

  /**
   * 生成某月的 6×7 日期网格（42 格），供桌面挂件的迷你月历使用。
   * @param {number} year
   * @param {number} month 1–12
   * @param {string} todayStr 形如 'YYYY-MM-DD'，用于标记今日
   * @returns {Array<{day:number,dateStr:string,inMonth:boolean,isToday:boolean}>}
   */
  function monthGrid(year, month, todayStr) {
    const first = new Date(year, month - 1, 1);
    const startDow = first.getDay();                 // 0=周日
    const daysInMonth = new Date(year, month, 0).getDate();
    const prevDays = new Date(year, month - 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      let d, m, y, inMonth;
      if (i < startDow) {
        d = prevDays - startDow + 1 + i; m = month - 1; y = year;
        if (m < 1) { m = 12; y = year - 1; }
        inMonth = false;
      } else if (i >= startDow + daysInMonth) {
        d = i - (startDow + daysInMonth) + 1; m = month + 1; y = year;
        if (m > 12) { m = 1; y = year + 1; }
        inMonth = false;
      } else {
        d = i - startDow + 1; m = month; y = year;
        inMonth = true;
      }
      const dateStr = y + '-' + pad2(m) + '-' + pad2(d);
      cells.push({ day: d, dateStr: dateStr, inMonth: inMonth, isToday: dateStr === todayStr });
    }
    return cells;
  }

  /**
   * 生成「周一为首」的 6×7 日期网格（42 格）。
   * 与 monthGrid 的区别仅在首列口径（0=周一），避免用「行内旋转」把 1 号为周日的月份排错。
   */
  function monthGridMon(year, month, todayStr) {
    const first = new Date(year, month - 1, 1);
    const startDow = (first.getDay() + 6) % 7;       // 0=周一
    const daysInMonth = new Date(year, month, 0).getDate();
    const prevDays = new Date(year, month - 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      let d, m, y, inMonth;
      if (i < startDow) {
        d = prevDays - startDow + 1 + i; m = month - 1; y = year;
        if (m < 1) { m = 12; y = year - 1; }
        inMonth = false;
      } else if (i >= startDow + daysInMonth) {
        d = i - (startDow + daysInMonth) + 1; m = month + 1; y = year;
        if (m > 12) { m = 1; y = year + 1; }
        inMonth = false;
      } else {
        d = i - startDow + 1; m = month; y = year;
        inMonth = true;
      }
      const dateStr = y + '-' + pad2(m) + '-' + pad2(d);
      cells.push({ day: d, dateStr: dateStr, inMonth: inMonth, isToday: dateStr === todayStr });
    }
    return cells;
  }

  return {
    PRIORITIES: PRIORITIES,
    PRIORITY_LABEL: PRIORITY_LABEL,
    UNCATEGORIZED: UNCATEGORIZED,
    isValidDateStr: isValidDateStr,
    priorityRank: priorityRank,
    todayString: todayString,
    makeId: makeId,
    createTask: createTask,
    normalizeTask: normalizeTask,
    updateTask: updateTask,
    completeTask: completeTask,
    uncompleteTask: uncompleteTask,
    deleteTask: deleteTask,
    isOverdue: isOverdue,
    isDueToday: isDueToday,
    groupTasks: groupTasks,
    sortTasks: sortTasks,
    sortCompleted: sortCompleted,
    countsByDate: countsByDate,
    searchTasks: searchTasks,
    formatDateCN: formatDateCN,
    monthGrid: monthGrid,
    monthGridMon: monthGridMon
  };
});
