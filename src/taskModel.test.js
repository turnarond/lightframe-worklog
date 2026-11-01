// taskModel 单元测试 —— 纯逻辑，不依赖 Electron / DOM
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./taskModel.js');

// 造数据辅助：固定 createdAt，避免依赖运行时
function t(over) {
  return Object.assign(
    {
      id: 'x', title: '任务', category: '工作', priority: 'mid', dueDate: null,
      done: false, createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: null, completedOn: null
    },
    over
  );
}

test('常量：PRIORITIES / PRIORITY_LABEL / priorityRank', () => {
  assert.deepEqual(M.PRIORITIES, ['high', 'mid', 'low']);
  assert.deepEqual(M.PRIORITY_LABEL, { high: '高', mid: '中', low: '低' });
  assert.equal(M.priorityRank('high'), 0);
  assert.equal(M.priorityRank('mid'), 1);
  assert.equal(M.priorityRank('low'), 2);
  assert.equal(M.priorityRank('URGENT'), 1, '未知优先级按“中”处理');
});

test('createTask: 去空格并填充默认值', () => {
  const task = M.createTask({ title: '  买咖啡  ', category: '  会议 ', priority: 'high' });
  assert.equal(task.title, '买咖啡');
  assert.equal(task.category, '会议');
  assert.equal(task.priority, 'high');
  assert.equal(task.done, false);
  assert.equal(task.dueDate, null);
  assert.equal(task.completedAt, null);
  assert.equal(task.completedOn, null);
  assert.ok(task.id && typeof task.id === 'string');
  assert.ok(!Number.isNaN(Date.parse(task.createdAt)), 'createdAt 是合法 ISO');
});

test('createTask: 分类留空兜底为“未分类”，标题留空返回 null', () => {
  assert.equal(M.createTask({ title: '只写标题' }).category, '未分类');
  assert.equal(M.createTask({ title: '只写标题', category: '   ' }).category, '未分类');
  assert.equal(M.createTask({ title: '   ' }), null);
  assert.equal(M.createTask({}), null);
  assert.equal(M.createTask(null), null);
});

test('createTask: 非法优先级兜底 mid，非法截止日兜底 null', () => {
  assert.equal(M.createTask({ title: 'a', priority: 'URGENT' }).priority, 'mid');
  assert.equal(M.createTask({ title: 'a', priority: undefined }).priority, 'mid');
  assert.equal(M.createTask({ title: 'b', dueDate: '明天' }).dueDate, null);
  assert.equal(M.createTask({ title: 'b', dueDate: '2026-13-01' }).dueDate, null);
  assert.equal(M.createTask({ title: 'c', dueDate: '2026-11-03' }).dueDate, '2026-11-03');
});

test('todayString: 返回本地 YYYY-MM-DD（不是 UTC）', () => {
  assert.equal(M.todayString(new Date(2026, 9, 31)), '2026-10-31');
  assert.equal(M.todayString(new Date(2026, 0, 5)), '2026-01-05');
  assert.match(M.todayString(), /^\d{4}-\d{2}-\d{2}$/);
});

test('makeId: 返回字符串且每次不同', () => {
  const a = M.makeId();
  const b = M.makeId();
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

test('isOverdue: 截止日早于今天且未完成才算逾期', () => {
  assert.equal(M.isOverdue(t({ dueDate: '2026-10-30' }), '2026-10-31'), true);
  assert.equal(M.isOverdue(t({ dueDate: '2026-10-31' }), '2026-10-31'), false);
  assert.equal(M.isOverdue(t({ dueDate: '2026-11-01' }), '2026-10-31'), false);
  assert.equal(M.isOverdue(t({ dueDate: '2026-10-30', done: true }), '2026-10-31'), false);
  assert.equal(M.isOverdue(t({ dueDate: null }), '2026-10-31'), false);
});

test('isDueToday: 今天到期且未完成', () => {
  assert.equal(M.isDueToday(t({ dueDate: '2026-10-31' }), '2026-10-31'), true);
  assert.equal(M.isDueToday(t({ dueDate: '2026-10-31', done: true }), '2026-10-31'), false);
  assert.equal(M.isDueToday(t({ dueDate: '2026-11-01' }), '2026-10-31'), false);
  assert.equal(M.isDueToday(t({ dueDate: null }), '2026-10-31'), false);
});

test('groupTasks: 五个分桶归类正确（已完成优先判定）', () => {
  const today = '2026-10-31';
  const g = M.groupTasks([
    t({ id: '1', dueDate: '2026-10-30' }),              // 逾期
    t({ id: '2', dueDate: '2026-10-31' }),              // 今天
    t({ id: '3', dueDate: '2026-11-05' }),              // 即将
    t({ id: '4', dueDate: null }),                      // 未安排
    t({ id: '5', done: true, dueDate: '2026-10-29' })   // 已完成（逾期但已办完）
  ], today);
  assert.deepEqual(g.overdue.map(x => x.id), ['1']);
  assert.deepEqual(g.today.map(x => x.id), ['2']);
  assert.deepEqual(g.upcoming.map(x => x.id), ['3']);
  assert.deepEqual(g.unscheduled.map(x => x.id), ['4']);
  assert.deepEqual(g.done.map(x => x.id), ['5']);
});

test('sortTasks: 优先级 → 截止日升序（null 最后）→ createdAt 升序', () => {
  const sorted = M.sortTasks([
    t({ id: 'a', priority: 'low', dueDate: '2026-11-01' }),
    t({ id: 'b', priority: 'high', dueDate: '2026-11-09' }),
    t({ id: 'c', priority: 'high', dueDate: '2026-11-03' }),
    t({ id: 'd', priority: 'mid', dueDate: null }),
    t({ id: 'e', priority: 'mid', dueDate: '2026-11-05', createdAt: '2026-01-02T00:00:00.000Z' }),
    t({ id: 'f', priority: 'mid', dueDate: '2026-11-05', createdAt: '2026-01-01T00:00:00.000Z' })
  ]);
  // high: c(11-03) b(11-09) → mid: f,e(11-05 按 createdAt) d(无日期排最后) → low: a
  assert.deepEqual(sorted.map(x => x.id), ['c', 'b', 'f', 'e', 'd', 'a']);
});

test('sortTasks: 不改动入参数组', () => {
  const input = [t({ id: '1', priority: 'low' }), t({ id: '2', priority: 'high' })];
  const sorted = M.sortTasks(input);
  assert.deepEqual(input.map(x => x.id), ['1', '2']);
  assert.notEqual(sorted, input);
});

test('sortCompleted: 按 completedAt 倒序，缺失排最后', () => {
  const sorted = M.sortCompleted([
    t({ id: '1', done: true, completedAt: '2026-10-01T00:00:00.000Z' }),
    t({ id: '2', done: true, completedAt: '2026-10-30T00:00:00.000Z' }),
    t({ id: '3', done: true, completedAt: null }),
    t({ id: '4', done: true, completedAt: '2026-10-15T00:00:00.000Z' })
  ]);
  assert.deepEqual(sorted.map(x => x.id), ['2', '4', '1', '3']);
});

test('countsByDate: 只统计当月未完成任务', () => {
  const counts = M.countsByDate([
    t({ dueDate: '2026-10-31' }),
    t({ dueDate: '2026-10-31' }),
    t({ dueDate: '2026-10-31', done: true }),
    t({ dueDate: '2026-11-02' }),
    t({ dueDate: '2026-09-30' }),
    t({ dueDate: null })
  ], 2026, 10);
  assert.equal(counts['2026-10-31'], 2);
  assert.equal(counts['2026-11-02'], undefined, '11 月的任务不属于 10 月');
  assert.equal(counts['2026-09-30'], undefined);
});

test('countsByDate: 月份为 1 基，其他月份不计入', () => {
  const counts = M.countsByDate([
    t({ dueDate: '2026-09-30' }),
    t({ dueDate: '2026-10-01' }),
    t({ dueDate: '2026-10-31' }),
    t({ dueDate: '2026-12-31' })
  ], 2026, 10);
  assert.deepEqual(counts, { '2026-10-01': 1, '2026-10-31': 1 });
});

test('completeTask: 写入 completedAt / completedOn，返回新对象', () => {
  const task = t({ id: '1', title: '收尾' });
  const done = M.completeTask(task, '2026-10-31');
  assert.equal(done.done, true);
  assert.equal(done.completedOn, '2026-10-31');
  assert.ok(!Number.isNaN(Date.parse(done.completedAt)));
  assert.equal(task.done, false, '原对象不变');
  assert.equal(task.completedOn, null);
  assert.equal(done.id, '1');
});

test('completeTask: 不传日期时用今天', () => {
  const done = M.completeTask(t({}), M.todayString());
  assert.equal(done.completedOn, M.todayString());
});

test('uncompleteTask: 清空完成标记', () => {
  const back = M.uncompleteTask(M.completeTask(t({}), '2026-10-31'));
  assert.equal(back.done, false);
  assert.equal(back.completedAt, null);
  assert.equal(back.completedOn, null);
});

test('searchTasks: 标题不区分大小写，空查询返回全部', () => {
  const tasks = [t({ id: '1', title: 'Buy Milk' }), t({ id: '2', title: '买菜' })];
  assert.deepEqual(M.searchTasks(tasks, 'milk').map(x => x.id), ['1']);
  assert.deepEqual(M.searchTasks(tasks, 'MILK').map(x => x.id), ['1']);
  assert.deepEqual(M.searchTasks(tasks, '  ').map(x => x.id), ['1', '2']);
  assert.deepEqual(M.searchTasks(tasks, '').map(x => x.id), ['1', '2']);
  assert.deepEqual(M.searchTasks(tasks, 'zzz').map(x => x.id), []);
});

test('normalizeTask: 丢弃无标题脏数据，补全缺失字段', () => {
  assert.equal(M.normalizeTask(null), null);
  assert.equal(M.normalizeTask(undefined), null);
  assert.equal(M.normalizeTask('字符串'), null);
  assert.equal(M.normalizeTask({ title: '  ' }), null);

  const n = M.normalizeTask({ title: '  保留我  ', priority: 'nope' });
  assert.equal(n.title, '保留我');
  assert.equal(n.category, '未分类');
  assert.equal(n.priority, 'mid');
  assert.equal(n.done, false);
  assert.equal(n.dueDate, null);
  assert.equal(n.completedAt, null);
  assert.equal(n.completedOn, null);
  assert.ok(n.id);
  assert.ok(n.createdAt);
});

test('normalizeTask: 保留合法的完成信息与分类', () => {
  const raw = {
    id: 'k1', title: '已完成', category: '光影集', priority: 'high',
    dueDate: '2026-10-20', done: true,
    createdAt: '2026-10-19T02:00:00.000Z',
    completedAt: '2026-10-21T03:00:00.000Z', completedOn: '2026-10-21'
  };
  const n = M.normalizeTask(raw);
  assert.equal(n.id, 'k1');
  assert.equal(n.category, '光影集');
  assert.equal(n.priority, 'high');
  assert.equal(n.dueDate, '2026-10-20');
  assert.equal(n.done, true);
  assert.equal(n.completedOn, '2026-10-21');
  assert.equal(n.completedAt, '2026-10-21T03:00:00.000Z');
});

test('normalizeTask: 非法 completedOn 被清空', () => {
  const n = M.normalizeTask({ title: 'x', done: true, completedOn: '昨天' });
  assert.equal(n.completedOn, null);
});

test('createTask / normalizeTask: 携带并兜底 details 字段', () => {
  assert.equal(M.createTask({ title: 'a', details: '第一行\n第二行' }).details, '第一行\n第二行');
  assert.equal(M.createTask({ title: 'a' }).details, '', '无 details 时默认空串');
  const n = M.normalizeTask({ title: 'b', details: 123 });
  assert.equal(n.details, '', '非字符串 details 兜底空串');
  assert.equal(M.normalizeTask({ title: 'c', details: '草稿' }).details, '草稿');
});

test('updateTask: 不可变更新，保留 id 并补 updatedAt', () => {
  const tasks = [t({ id: '1', title: '旧' }), t({ id: '2', title: '不变' })];
  const updated = M.updateTask(tasks, '1', { title: '新', priority: 'high' });
  assert.equal(updated.length, 2);
  assert.equal(updated[0].title, '新');
  assert.equal(updated[0].priority, 'high');
  assert.equal(updated[0].id, '1', 'id 不被 patch 覆盖');
  assert.ok(typeof updated[0].updatedAt === 'number' && updated[0].updatedAt > 0, 'updatedAt 为数字毫秒');
  assert.equal(updated[1].title, '不变', '其他条目不受影响');
  assert.equal(tasks[0].title, '旧', '原数组不被改动');
  assert.notEqual(updated, tasks);
});

test('updateTask: id 不存在 / 非法入参时原样返回', () => {
  const tasks = [t({ id: '1' })];
  assert.equal(M.updateTask(tasks, 'x', { title: 'y' }), tasks);
  assert.equal(M.updateTask(null, '1', {}), null);
});

test('monthGrid: 生成 42 格且今日标记正确', () => {
  // 2026-11-15 是周日，应出现在首行第 1 格
  const grid = M.monthGrid(2026, 11, '2026-11-15');
  assert.equal(grid.length, 42);
  assert.equal(grid[0].dateStr, '2026-11-01');           // 11-01 是周日，startDow=0
  assert.equal(grid[0].inMonth, true);
  const today = grid.find((c) => c.isToday);
  assert.ok(today && today.dateStr === '2026-11-15');
});

test('monthGrid: 跨月补位正确（含上月/下月溢出）', () => {
  // 2026-06 有 30 天，1 日为周一(startDow=1)：首格属 5 月
  const grid = M.monthGrid(2026, 6, '2026-06-15');
  assert.equal(grid[0].dateStr, '2026-05-31');
  assert.equal(grid[0].inMonth, false);
  assert.equal(grid[1].dateStr, '2026-06-01');   // 6 月首日
  assert.equal(grid[1].inMonth, true);
  assert.ok(grid.find((c) => c.isToday && c.dateStr === '2026-06-15'));
  // 末格为 7 月溢出
  const tail = grid[grid.length - 1];
  assert.equal(tail.dateStr, '2026-07-11');
  assert.equal(tail.inMonth, false);
});

test('monthGrid: 年末跨年补位', () => {
  const grid = M.monthGrid(2026, 12, '2026-12-31');
  assert.equal(grid[grid.length - 1].dateStr, '2027-01-09');
});

test('monthGridMon: 周一为首，1 号为周日时首行以周日收尾', () => {
  // 2026-11-01 是周日：首行 = 10/26(一) … 10/31(六), 11/01(日)
  const grid = M.monthGridMon(2026, 11, '2026-11-15');
  assert.equal(grid.length, 42);
  assert.equal(grid[0].dateStr, '2026-10-26');
  assert.equal(grid[0].inMonth, false);
  assert.equal(grid[6].dateStr, '2026-11-01');
  assert.equal(grid[6].inMonth, true);
  // 11-02（周一）应落在第二行首列，而不是被塞进 11-01 前面
  assert.equal(grid[7].dateStr, '2026-11-02');
  assert.equal(grid[7].inMonth, true);
});

test('monthGridMon: 1 号为周一则首格即当月 1 日', () => {
  const grid = M.monthGridMon(2026, 6, '2026-06-15');
  assert.equal(grid[0].dateStr, '2026-06-01');
  assert.equal(grid[0].inMonth, true);
});

test('formatDateCN: 短中文日期', () => {
  assert.equal(M.formatDateCN('2026-10-31'), '10月31日');
  assert.equal(M.formatDateCN('2026-01-05'), '1月5日');
  assert.equal(M.formatDateCN(null), '');
  assert.equal(M.formatDateCN('乱码'), '');
});
