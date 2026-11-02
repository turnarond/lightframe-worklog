// report —— 日报 / 周报聚合与格式化（UMD：Node 与浏览器共用）
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Report = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const UNCATEGORIZED = '未分类';

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function parse(dateStr) {
    if (typeof dateStr !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { y: y, mo: mo, d: d, dt: dt };
  }

  function formatUTC(dt) {
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }

  function md(dateStr) {
    const p = parse(dateStr);
    return p ? pad2(p.mo) + '/' + pad2(p.d) : '';
  }

  function weekdayCN(dateStr) {
    const p = parse(dateStr);
    return p ? WEEKDAYS_CN[p.dt.getUTCDay()] : '';
  }

  function addDays(dateStr, n) {
    const p = parse(dateStr);
    if (!p) return '';
    const dt = new Date(p.dt.getTime() + Number(n || 0) * DAY_MS);
    return formatUTC(dt);
  }

  /** 所在 ISO 周的周一 */
  function weekStartOf(dateStr) {
    const p = parse(dateStr);
    if (!p) return '';
    const offset = (p.dt.getUTCDay() + 6) % 7; // 周一 = 0
    return formatUTC(new Date(p.dt.getTime() - offset * DAY_MS));
  }

  /** ISO 8601 周编号：YYYY-Www，周一为起始，第 1 周含首个周四 */
  function isoWeekKey(dateStr) {
    const p = parse(dateStr);
    if (!p) return '';
    const target = new Date(p.dt.getTime());
    const dayNum = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNum + 3); // 本周四
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
    const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
    return target.getUTCFullYear() + '-W' + pad2(week);
  }

  function weekRangeText(weekStart) {
    return md(weekStart) + ' - ' + md(addDays(weekStart, 6));
  }

  function compareStr(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  function groupByCategory(tasks) {
    const map = new Map();
    (tasks || []).forEach(function (task) {
      if (!task) return;
      const category = task.category && String(task.category).trim() || UNCATEGORIZED;
      if (!map.has(category)) map.set(category, []);
      map.get(category).push(task);
    });
    return Array.from(map.keys())
      .map(function (category) {
        return { category: category, tasks: map.get(category) };
      })
      .sort(function (a, b) {
        return (b.tasks.length - a.tasks.length) || compareStr(a.category, b.category);
      });
  }

  function textOf(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function buildDaily(tasks, log, date) {
    const completed = (tasks || []).filter(function (task) {
      return task && task.done === true && !task.deletedAt && task.completedOn === date;
    });
    return {
      date: date,
      completedByCategory: groupByCategory(completed),
      total: completed.length,
      log: {
        progress: textOf(log && log.progress),
        issues: textOf(log && log.issues),
        plan: textOf(log && log.plan)
      }
    };
  }

  function formatDaily(daily) {
    const date = daily.date;
    const lines = [];
    lines.push('【日报】' + date + ' ' + weekdayCN(date));
    lines.push('一、今日完成');

    const groups = daily.completedByCategory || [];
    if (!groups.length) {
      lines.push('（无）');
    } else {
      groups.forEach(function (group) {
        group.tasks.forEach(function (task) {
          lines.push('· [' + group.category + '] ' + task.title);
        });
      });
    }

    const log = daily.log || {};
    lines.push('二、今日进展');
    lines.push(textOf(log.progress));
    lines.push('三、问题与风险');
    lines.push(textOf(log.issues));
    lines.push('四、明日计划');
    lines.push(textOf(log.plan));

    return lines.join('\n');
  }

  function buildWeekly(tasks, logs, weekStart, nextPlanOverride) {
    const start = weekStartOf(weekStart) || weekStart;
    const end = addDays(start, 6);
    const allLogs = logs || {};

    const completed = (tasks || []).filter(function (task) {
      if (!task || task.done !== true || task.deletedAt) return false;
      const on = task.completedOn;
      return typeof on === 'string' && on >= start && on <= end;
    });

    const progress = [];
    const issues = [];
    let nextPlan = '';

    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const entry = allLogs[date];
      if (!entry) continue;
      const p = textOf(entry.progress);
      const s = textOf(entry.issues);
      if (p) progress.push({ date: date, text: p });
      if (s) issues.push({ date: date, text: s });
    }

    const override = textOf(nextPlanOverride);
    if (override) {
      nextPlan = override;
    } else {
      for (let i = 6; i >= 0; i--) {
        const entry = allLogs[addDays(start, i)];
        const plan = textOf(entry && entry.plan);
        if (plan) {
          nextPlan = plan;
          break;
        }
      }
    }

    const completedByCategory = groupByCategory(completed);
    const distribution = completedByCategory.map(function (group) {
      return { category: group.category, count: group.tasks.length };
    });

    return {
      weekStart: start,
      weekKey: isoWeekKey(start),
      rangeText: weekRangeText(start),
      completedByCategory: completedByCategory,
      total: completed.length,
      progress: progress,
      issues: issues,
      nextPlan: nextPlan,
      distribution: distribution
    };
  }

  function formatWeekly(weekly) {
    const lines = [];
    lines.push('【周报】' + weekly.weekKey + '（' + weekly.rangeText + '）');
    lines.push('一、本周完成（共 ' + weekly.total + ' 项）');

    const groups = weekly.completedByCategory || [];
    if (!groups.length) {
      lines.push('（无）');
    } else {
      groups.forEach(function (group) {
        lines.push('· [' + group.category + '] 共 ' + group.tasks.length + ' 项');
        group.tasks.forEach(function (task) {
          lines.push('  · ' + task.title);
        });
      });
    }

    lines.push('二、本周进展');
    if (!weekly.progress.length) lines.push('（无）');
    else {
      weekly.progress.forEach(function (item) {
        lines.push('【' + md(item.date) + '】' + item.text);
      });
    }

    lines.push('三、问题与风险');
    if (!weekly.issues.length) lines.push('（无）');
    else {
      weekly.issues.forEach(function (item) {
        lines.push('【' + md(item.date) + '】' + item.text);
      });
    }

    lines.push('四、下周计划');
    lines.push(weekly.nextPlan || '（无）');

    lines.push('五、数据概览');
    const dist = weekly.distribution || [];
    if (!dist.length) {
      lines.push('完成 ' + weekly.total + ' 项');
    } else {
      const parts = dist.map(function (item) {
        return item.category + ' ' + item.count;
      });
      lines.push('完成 ' + weekly.total + ' 项 ｜ ' + parts.join(' · '));
    }

    return lines.join('\n');
  }

  /* ============ 离线启发式摘要（#3：不联网、零依赖） ============
     仅用「已完成任务 + 日志」做确定性拼装，无随机、无外部调用。 */

  function buildDailySummary(tasks, log, date) {
    const daily = buildDaily(tasks, log, date);
    const groups = (daily.completedByCategory || []).filter(function (g) { return g.tasks.length; });
    const total = daily.total;
    const parts = [];

    if (total === 0) {
      parts.push('今日无标记完成的任务。');
    } else {
      parts.push('今日共完成 ' + total + ' 项任务。');
    }

    if (groups.length) {
      const top = groups.slice(0, 3).map(function (g) { return g.category + ' ' + g.tasks.length + ' 项'; }).join('、');
      parts.push('主要集中在' + top + (groups.length > 3 ? '等方向' : '方向') + '。');
    }

    const high = [];
    groups.forEach(function (g) {
      g.tasks.forEach(function (t) { if (t.priority === 'high') high.push(t.title); });
    });
    if (high.length) {
      parts.push('其中重点推进了' + high.slice(0, 3).join('、') + '。');
    }

    const progress = textOf(daily.log && daily.log.progress);
    if (progress) parts.push('进展方面，' + progress);

    const issues = textOf(daily.log && daily.log.issues);
    if (issues) parts.push('需要关注的风险：' + issues);

    const plan = textOf(daily.log && daily.log.plan);
    if (plan) parts.push('下一步计划：' + plan + '。');

    return parts.join('');
  }

  function buildWeeklySummary(tasks, logs, weekStart, nextPlanOverride) {
    const weekly = buildWeekly(tasks, logs, weekStart, nextPlanOverride);
    const total = weekly.total;
    const parts = [];

    if (total === 0) {
      parts.push('本周暂无标记完成的任务。');
    } else {
      parts.push('本周共完成 ' + total + ' 项任务。');
    }

    const dist = (weekly.distribution || []).filter(function (d) { return d.count > 0; });
    if (dist.length) {
      const top = dist.slice(0, 3).map(function (d) { return d.category + ' ' + d.count + ' 项'; }).join('、');
      parts.push('主要投入在' + top + (dist.length > 3 ? '等方向' : '方向') + '。');
    }

    const issues = weekly.issues || [];
    if (issues.length) {
      parts.push('期间出现 ' + issues.length + ' 处疑点，需跟进。');
    }

    const plan = textOf(weekly.nextPlan);
    if (plan) parts.push('下周计划：' + plan + '。');

    return parts.join('');
  }

  return {
    weekStartOf: weekStartOf,
    addDays: addDays,
    isoWeekKey: isoWeekKey,
    weekRangeText: weekRangeText,
    buildDaily: buildDaily,
    formatDaily: formatDaily,
    buildWeekly: buildWeekly,
    formatWeekly: formatWeekly,
    buildDailySummary: buildDailySummary,
    buildWeeklySummary: buildWeeklySummary
  };
});
