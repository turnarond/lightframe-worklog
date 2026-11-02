// report 单元测试 —— 日报 / 周报聚合纯逻辑
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./report.js');

function t(over) {
  return Object.assign(
    {
      id: 'x', title: '任务', category: '工作', priority: 'mid', dueDate: null,
      done: true, createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-10-28T02:00:00.000Z', completedOn: '2026-10-28'
    },
    over
  );
}

function log(date, over) {
  return Object.assign(
    { date, progress: '', issues: '', plan: '', updatedAt: '2026-10-28T10:00:00.000Z' },
    over
  );
}

// ---------- 周计算 ----------

test('weekStartOf: 返回所在 ISO 周的周一（2026-10-31 是周六）', () => {
  assert.equal(R.weekStartOf('2026-10-31'), '2026-10-26');
  assert.equal(R.weekStartOf('2026-10-26'), '2026-10-26', '周一返回自己');
  assert.equal(R.weekStartOf('2026-11-01'), '2026-10-26', '周日归属同一周');
  assert.equal(R.weekStartOf('2026-01-01'), '2025-12-29', '跨年周归属上一年周一');
});

test('addDays: 跨月 / 跨年的日期加减', () => {
  assert.equal(R.addDays('2026-10-26', 6), '2026-11-01');
  assert.equal(R.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(R.addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(R.addDays('2026-10-26', 0), '2026-10-26');
});

test('isoWeekKey: ISO 8601 周编号（含跨年周）', () => {
  assert.equal(R.isoWeekKey('2026-10-31'), '2026-W44');
  assert.equal(R.isoWeekKey('2026-10-26'), '2026-W44');
  assert.equal(R.isoWeekKey('2026-01-01'), '2026-W01', '2026-01-01 是周四，属第 1 周');
  assert.equal(R.isoWeekKey('2025-12-29'), '2026-W01', '周一属下一年的第 1 周');
  assert.equal(R.isoWeekKey('2027-01-01'), '2026-W53', '周五属上一年的第 53 周');
});

test('weekRangeText: MM/DD - MM/DD（周一 .. 周日）', () => {
  assert.equal(R.weekRangeText('2026-10-26'), '10/26 - 11/01');
  assert.equal(R.weekRangeText('2026-12-28'), '12/28 - 01/03');
});

// ---------- 日报 ----------

test('buildDaily: 按 completedOn 统计并分组，组按数量降序', () => {
  const tasks = [
    t({ id: '1', title: '修图', category: '光影集', completedOn: '2026-10-28' }),
    t({ id: '2', title: '调色', category: '光影集', completedOn: '2026-10-28' }),
    t({ id: '3', title: '周会', category: '会议', completedOn: '2026-10-28' }),
    t({ id: '4', title: '昨天的事', category: '光影集', completedOn: '2026-10-27' }),
    t({ id: '5', title: '还没做', category: '会议', done: false, completedOn: '2026-10-28' })
  ];
  const daily = R.buildDaily(tasks, log('2026-10-28', { progress: '写了点' }), '2026-10-28');
  assert.equal(daily.date, '2026-10-28');
  assert.equal(daily.total, 3);
  assert.deepEqual(daily.completedByCategory.map(g => g.category), ['光影集', '会议']);
  assert.deepEqual(daily.completedByCategory[0].tasks.map(x => x.id), ['1', '2']);
  assert.equal(daily.log.progress, '写了点');
});

test('buildDaily: 按 dueDate 不能计入（关键：completedOn 与 dueDate 分离）', () => {
  const tasks = [t({ id: '1', title: '上周到期今天做完', dueDate: '2026-10-20', completedOn: '2026-10-28' })];
  const daily = R.buildDaily(tasks, null, '2026-10-28');
  assert.equal(daily.total, 1);
  assert.equal(daily.log.progress, '');
});

test('buildDaily: 同数量分类按名称稳定排序', () => {
  const tasks = [
    t({ id: '1', category: 'BBB', completedOn: '2026-10-28' }),
    t({ id: '2', category: 'AAA', completedOn: '2026-10-28' })
  ];
  const daily = R.buildDaily(tasks, log('2026-10-28'), '2026-10-28');
  assert.deepEqual(daily.completedByCategory.map(g => g.category), ['AAA', 'BBB']);
});

// ---------- 格式：日报 ----------

test('formatDaily: 含标题与四个小节，完成项带 [分类]', () => {
  const daily = R.buildDaily(
    [t({ id: '1', title: '修复图片比例', category: '光影集', completedOn: '2026-10-28' })],
    log('2026-10-28', { progress: '推进了 A', issues: '无', plan: '明天继续' }),
    '2026-10-28'
  );
  const text = R.formatDaily(daily);
  assert.match(text, /^【日报】2026-10-28 周三/);
  assert.ok(text.includes('一、今日完成'));
  assert.ok(text.includes('· [光影集] 修复图片比例'));
  assert.ok(text.includes('二、今日进展'));
  assert.ok(text.includes('推进了 A'));
  assert.ok(text.includes('三、问题与风险'));
  assert.ok(text.includes('四、明日计划'));
  assert.ok(text.includes('明天继续'));
});

test('formatDaily: 无完成项写“（无）”，空栏目保持空行', () => {
  const text = R.formatDaily(R.buildDaily([], log('2026-10-28'), '2026-10-28'));
  assert.ok(text.includes('（无）'));
  assert.ok(text.includes('二、今日进展'));
  const lines = text.split('\n');
  const idx = lines.indexOf('二、今日进展');
  assert.ok(idx >= 0);
  assert.equal(lines[idx + 1], '', '空栏目下面直接空行');
});

// ---------- 周报 ----------

test('buildWeekly: 跨周边界 —— 上周到期、本周完成的任务必须计入本周', () => {
  const tasks = [
    t({ id: 'prev', title: '上周到期本周做完', dueDate: '2026-10-20', completedOn: '2026-10-28' }),
    t({ id: 'mon', title: '周一完成', dueDate: null, completedOn: '2026-10-26' }),
    t({ id: 'sun', title: '周日完成', dueDate: null, completedOn: '2026-11-01' }),
    t({ id: 'before', title: '上周日完成', completedOn: '2026-10-25' }),
    t({ id: 'after', title: '下周一完成', completedOn: '2026-11-02' })
  ];
  const weekly = R.buildWeekly(tasks, {}, '2026-10-26');
  assert.equal(weekly.weekStart, '2026-10-26');
  assert.equal(weekly.weekKey, '2026-W44');
  assert.equal(weekly.rangeText, '10/26 - 11/01');
  assert.equal(weekly.total, 3);
  const ids = weekly.completedByCategory.flatMap(g => g.tasks.map(x => x.id)).sort();
  assert.deepEqual(ids, ['mon', 'prev', 'sun']);
});

test('buildWeekly: 聚合本周 7 天的进展 / 问题，按日期升序且跳过空值', () => {
  const logs = {
    '2026-10-28': log('2026-10-28', { progress: '周三进展', issues: '' }),
    '2026-10-26': log('2026-10-26', { progress: '周一进展', issues: '周一风险' }),
    '2026-10-30': log('2026-10-30', { progress: '   ', issues: '周五风险' }),
    '2026-10-25': log('2026-10-25', { progress: '上周日进展' })
  };
  const weekly = R.buildWeekly([], logs, '2026-10-26');
  assert.deepEqual(weekly.progress, [
    { date: '2026-10-26', text: '周一进展' },
    { date: '2026-10-28', text: '周三进展' }
  ]);
  assert.deepEqual(weekly.issues, [
    { date: '2026-10-26', text: '周一风险' },
    { date: '2026-10-30', text: '周五风险' }
  ]);
});

test('buildWeekly: 下周计划预填本周最后一个有计划的日期', () => {
  const logs = {
    '2026-10-27': log('2026-10-27', { plan: '周二计划的想法' }),
    '2026-10-30': log('2026-10-30', { plan: '周五计划的想法' }),
    '2026-10-29': log('2026-10-29', { plan: '   ' })
  };
  assert.equal(R.buildWeekly([], logs, '2026-10-26').nextPlan, '周五计划的想法');
});

test('buildWeekly: nextPlanOverride 非空时优先；空串/空白的 override 不覆盖', () => {
  const logs = { '2026-10-30': log('2026-10-30', { plan: '预填的计划' }) };
  assert.equal(R.buildWeekly([], logs, '2026-10-26', '手动写的计划').nextPlan, '手动写的计划');
  assert.equal(R.buildWeekly([], logs, '2026-10-26', '   ').nextPlan, '预填的计划');
  assert.equal(R.buildWeekly([], logs, '2026-10-26', '').nextPlan, '预填的计划');
  assert.equal(R.buildWeekly([], {}, '2026-10-26').nextPlan, '');
});

test('buildWeekly: distribution 按分类计数降序', () => {
  const tasks = [
    t({ id: '1', category: '光影集', completedOn: '2026-10-26' }),
    t({ id: '2', category: '光影集', completedOn: '2026-10-27' }),
    t({ id: '3', category: '会议', completedOn: '2026-10-28' }),
    t({ id: '4', category: '光影集', completedOn: '2026-10-29' })
  ];
  const weekly = R.buildWeekly(tasks, {}, '2026-10-26');
  assert.deepEqual(weekly.distribution, [
    { category: '光影集', count: 3 },
    { category: '会议', count: 1 }
  ]);
  assert.deepEqual(weekly.completedByCategory.map(g => g.category), ['光影集', '会议']);
});

// ---------- 格式：周报 ----------

test('formatWeekly: 含标题、五个小节与数据概览', () => {
  const tasks = [
    t({ id: '1', title: '修图', category: '光影集', completedOn: '2026-10-27' }),
    t({ id: '2', title: '调色', category: '光影集', completedOn: '2026-10-28' }),
    t({ id: '3', title: '周会', category: '会议', completedOn: '2026-10-28' })
  ];
  const logs = {
    '2026-10-27': log('2026-10-27', { progress: '推进修图', issues: '带宽风险', plan: '下周继续' })
  };
  const weekly = R.buildWeekly(tasks, logs, '2026-10-26');
  const text = R.formatWeekly(weekly);
  assert.match(text, /^【周报】2026-W44（10\/26 - 11\/01）/);
  assert.ok(text.includes('一、本周完成（共 3 项）'));
  assert.ok(text.includes('[光影集]'));
  assert.ok(text.includes('二、本周进展'));
  assert.ok(text.includes('【10/27】推进修图'));
  assert.ok(text.includes('三、问题与风险'));
  assert.ok(text.includes('【10/27】带宽风险'));
  assert.ok(text.includes('四、下周计划'));
  assert.ok(text.includes('下周继续'));
  assert.ok(text.includes('五、数据概览'));
  assert.ok(text.includes('完成 3 项 ｜ 光影集 2 · 会议 1'));
});

test('formatWeekly: 空周仍输出完整骨架', () => {
  const text = R.formatWeekly(R.buildWeekly([], {}, '2026-10-26'));
  assert.ok(text.includes('一、本周完成（共 0 项）'));
  assert.ok(text.includes('（无）'));
  assert.ok(text.includes('五、数据概览'));
  assert.ok(text.includes('完成 0 项'));
});

// ---------- 离线启发式摘要（#3：不联网、零依赖） ----------

test('buildDailySummary: 无完成项给出空态文案', () => {
  const s = R.buildDailySummary([], log('2026-10-28'), '2026-10-28');
  assert.ok(s.includes('今日无标记完成的任务'));
});

test('buildDailySummary: 汇总完成数、类目、高优先级与日志', () => {
  const tasks = [
    t({ id: '1', title: '修复图片比例', category: '光影集', priority: 'high', completedOn: '2026-10-28' }),
    t({ id: '2', title: '周会纪要', category: '会议', completedOn: '2026-10-28' }),
    t({ id: '3', title: '写日报', category: '光影集', completedOn: '2026-10-28' })
  ];
  const l = log('2026-10-28', { progress: '推进了 A', issues: '缺素材', plan: '明天继续' });
  const s = R.buildDailySummary(tasks, l, '2026-10-28');
  assert.ok(s.includes('今日共完成 3 项任务'), '统计完成数');
  assert.ok(s.includes('光影集 2 项'), '聚合类目计数');
  assert.ok(s.includes('重点推进了修复图片比例'), '高优先级点名');
  assert.ok(s.includes('进展方面，推进了 A'), '拼接进展');
  assert.ok(s.includes('需要关注的风险：缺素材'), '拼接风险');
  assert.ok(s.includes('下一步计划：明天继续'), '拼接明日计划');
});

test('buildDailySummary: 多类目只取前三、且不越界', () => {
  const cats = ['A', 'B', 'C', 'D', 'E'];
  const tasks = cats.map(function (c, i) {
    return t({ id: String(i), title: 'T' + i, category: c, completedOn: '2026-10-28' });
  });
  const s = R.buildDailySummary(tasks, log('2026-10-28'), '2026-10-28');
  assert.ok(s.includes('等方向'), '超过 3 个类目时收敛为“等方向”');
});

test('buildWeeklySummary: 汇总完成数、分布与待跟进疑点', () => {
  const tasks = [
    t({ id: '1', title: '修图', category: '光影集', completedOn: '2026-10-27' }),
    t({ id: '2', title: '调色', category: '光影集', completedOn: '2026-10-28' }),
    t({ id: '3', title: '周会', category: '会议', completedOn: '2026-10-28' })
  ];
  const logs = {
    '2026-10-27': log('2026-10-27', { issues: '带宽风险' }),
    '2026-10-29': log('2026-10-29', { issues: '素材缺失' })
  };
  const s = R.buildWeeklySummary(tasks, logs, '2026-10-26', '下周主攻上线');
  assert.ok(s.includes('本周共完成 3 项任务'), '统计完成数');
  assert.ok(s.includes('光影集 2 项'), '聚合分布');
  assert.ok(s.includes('出现 2 处疑点'), '累计问题数量');
  assert.ok(s.includes('下周计划：下周主攻上线'), '采用 override 计划');
});

test('buildWeeklySummary: 空周给出空态文案', () => {
  const s = R.buildWeeklySummary([], {}, '2026-10-26');
  assert.ok(s.includes('本周暂无标记完成的任务'));
});
