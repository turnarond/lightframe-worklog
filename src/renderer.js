/* 光影工作志 · 渲染层
   纯原生 JS，无框架。所有 IPC 调用都包在 try/catch 里：
   任何一步失败只弹一条短提示，界面本身不崩。 */
(function () {
  'use strict';

  var TM = window.TaskModel;
  var RP = window.Report;
  var Editor = window.Editor || { autoBulletOnEnter: function (v, c) { return { value: v, caret: c }; }, cleanDetails: function (t) { return (t || '').trim(); } };
  var bridge = window.api || {};

  if (!TM || !RP) {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.textContent = '核心模块加载失败，请检查 src/taskModel.js 与 src/report.js。';
    });
    return;
  }

  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  // 分组顺序与圆点样式（与 SPEC §4 一致）
  var GROUP_DEFS = [
    { key: 'overdue', name: '逾期', dot: 'over' },
    { key: 'today', name: '今天', dot: 'today' },
    { key: 'upcoming', name: '即将到来', dot: 'soon' },
    { key: 'unscheduled', name: '未安排', dot: 'none' },
    { key: 'done', name: '已完成', dot: 'done' }
  ];

  // 设置读取失败时的兜底（与 SPEC §3 默认值一致）
  var DEFAULT_SETTINGS = {
    categories: ['光影集', '标准编写', '会议'],
    lastCategory: '光影集',
    launchAtLogin: true,
    alwaysOnTop: true,
    closeToTray: true,
    hotkey: 'Ctrl+Shift+Space',
    weeklyPlans: {},
    widget: {
      opacity: 0.9,
      blur: 14,
      clickThrough: false,
      expanded: false,
      rect: null
    }
  };

  var API_LABEL = {
    loadSettings: '读取设置',
    saveSettings: '保存设置',
    loadTasks: '读取任务',
    saveTasks: '保存任务',
    loadLogs: '读取日志',
    saveLogs: '保存日志',
    copyText: '复制',
    quit: '退出',
    setAlwaysOnTop: '置顶',
    setLaunchAtLogin: '开机自启'
  };

  var state = {
    settings: null,
    account: null,
    tasks: [],
    logs: {},
    today: TM.todayString(),
    tab: 'task',
    filterDate: null,
    calYear: 0,
    calMonth: 0,
    dailyDate: '',
    weekStart: '',
    addPriority: 'mid',
    viewDay: '',          // 挂件列表当前展示的日期（收起态点日期即切换）
    weekAnchor: ''        // 收起态周视图的锚点（周一所在那周）
  };

  var D = {};            // DOM 缓存
  var tabs = [];
  var sections = {};

  /* ============ 小工具 ============ */

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'value') node.value = value;
        else node.setAttribute(key, value);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // '2026-10-31' -> '10/31'
  function mmdd(dateStr) {
    var parts = String(dateStr || '').split('-');
    return parts.length === 3 ? parts[1] + '/' + parts[2] : '';
  }

  function weekdayOf(dateStr) {
    var parts = String(dateStr || '').split('-');
    if (parts.length !== 3) return '';
    return WEEKDAYS[new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getDay()];
  }

  // '2026-10-31' -> '2026年10月31日 周六'
  function dateLongCN(dateStr) {
    var parts = String(dateStr || '').split('-');
    if (parts.length !== 3) return '';
    return parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日 ' + weekdayOf(dateStr);
  }

  function findIndex(id) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) return i;
    }
    return -1;
  }

  /* ============ 提示 ============ */

  var toastTimer = null;
  function showToast(message, kind) {
    var node = D.toast;
    if (!node) return;
    node.textContent = message;
    node.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.className = 'toast' + (kind ? ' ' + kind : '');
      toastTimer = null;
    }, 2200);
  }

  /* ============ IPC 包装 ============ */

  async function apiCall(method, fallback) {
    var fn = bridge[method];
    if (typeof fn !== 'function') return fallback;
    var args = Array.prototype.slice.call(arguments, 2);
    try {
      var out = await fn.apply(bridge, args);
      return out === undefined ? fallback : out;
    } catch (err) {
      console.error('[光影] ' + method + ' 调用失败', err);
      showToast((API_LABEL[method] || '操作') + '失败', 'error');
      return fallback;
    }
  }

  async function copyText(text, okMessage) {
    if (typeof bridge.copyText !== 'function') {
      showToast('当前环境不支持复制', 'error');
      return;
    }
    try {
      await bridge.copyText(text);
      showToast(okMessage || '已复制', 'ok');
    } catch (err) {
      console.error('[光影] 复制失败', err);
      showToast('复制失败', 'error');
    }
  }

  /* ============ 设置读写 ============ */

  function mergeSettings(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var defaults = DEFAULT_SETTINGS;

    var categories = Array.isArray(source.categories)
      ? source.categories.filter(function (c) { return typeof c === 'string' && c.trim(); })
        .map(function (c) { return c.trim(); })
      : [];
    if (!categories.length) categories = defaults.categories.slice();

    var last = typeof source.lastCategory === 'string' && categories.indexOf(source.lastCategory) >= 0
      ? source.lastCategory
      : categories[0];

    var sw = source.widget && typeof source.widget === 'object' ? source.widget : {};
    var dw = defaults.widget;
    var widget = {
      opacity: typeof sw.opacity === 'number' ? sw.opacity : dw.opacity,
      blur: typeof sw.blur === 'number' ? sw.blur : dw.blur,
      clickThrough: typeof sw.clickThrough === 'boolean' ? sw.clickThrough : dw.clickThrough,
      expanded: typeof sw.expanded === 'boolean' ? sw.expanded : dw.expanded,
      rect: (sw.rect && typeof sw.rect.x === 'number' && typeof sw.rect.y === 'number') ? sw.rect : null
    };

    return {
      categories: categories,
      lastCategory: last,
      launchAtLogin: typeof source.launchAtLogin === 'boolean' ? source.launchAtLogin : defaults.launchAtLogin,
      alwaysOnTop: typeof source.alwaysOnTop === 'boolean' ? source.alwaysOnTop : defaults.alwaysOnTop,
      closeToTray: typeof source.closeToTray === 'boolean' ? source.closeToTray : defaults.closeToTray,
      hotkey: source.hotkey || defaults.hotkey,
      lastReminded: source.lastReminded && typeof source.lastReminded === 'object' ? source.lastReminded : {},
      weeklyPlans: source.weeklyPlans && typeof source.weeklyPlans === 'object' && !Array.isArray(source.weeklyPlans)
        ? source.weeklyPlans : {},
      widget: widget
    };
  }

  async function persistSettings() {
    await apiCall('saveSettings', null, state.settings);
  }

  async function patchSettings(partial) {
    state.settings = Object.assign({}, state.settings, partial);
    await persistSettings();
  }

  /* ============ 渲染 · 顶栏与 Tab ============ */

  function renderHeader() {
    state.today = TM.todayString();
    if (D['head-date']) D['head-date'].textContent = mmdd(state.today) + ' ' + weekdayOf(state.today);
  }

  // 顶栏实时时钟（HH:MM），每秒刷新一次
  function tickClock() {
    var now = new Date();
    var text = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    if (D['head-clock']) D['head-clock'].textContent = text;
    if (D['w-clock']) D['w-clock'].textContent = text;
  }

  function startClock() {
    tickClock();
    setInterval(tickClock, 1000);
  }

  function renderPinButton() {
    if (!D['btn-pin']) return;
    var on = !!state.settings.alwaysOnTop;
    D['btn-pin'].setAttribute('aria-pressed', String(on));
    D['btn-pin'].setAttribute('title', on ? '取消窗口置顶' : '窗口置顶');
  }

  async function togglePin() {
    if (!D['btn-pin']) return;
    var next = !state.settings.alwaysOnTop;
    state.settings.alwaysOnTop = next;
    await apiCall('setAlwaysOnTop', null, next);
    await persistSettings();
    renderPinButton();
    showToast(next ? '窗口已置顶' : '已取消置顶');
  }

  function applyTabUI() {
    tabs.forEach(function (btn) {
      var on = btn.getAttribute('data-tab') === state.tab;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
    Object.keys(sections).forEach(function (key) {
      sections[key].hidden = key !== state.tab;
    });
  }

  async function switchTab(name) {
    if (['task', 'daily', 'weekly'].indexOf(name) < 0) return;
    // 切走之前先把待保存的输入落盘，避免丢字
    await flushDailySave();
    await flushWeeklyPlan();
    state.tab = name;
    applyTabUI();
    if (name === 'task') {
      renderTasks();
      renderWidget();
    } else if (name === 'daily') {
      renderDaily();
    } else {
      renderWeekly();
    }
    D['app-main'].scrollTop = 0;
  }

  /* ============ 渲染 · 速记条 ============ */

  function renderCategorySelect() {
    var select = D['qa-category'];
    clear(select);
    state.settings.categories.forEach(function (name) {
      select.appendChild(el('option', { value: name, text: name }));
    });
    select.value = state.settings.lastCategory;
  }

  function renderPriorityButtons() {
    var buttons = D['qa-priority'].querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-p') === state.addPriority));
    });
  }

  function onPriorityClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    var btn = target.closest('button[data-p]');
    if (!btn) return;
    state.addPriority = btn.getAttribute('data-p');
    renderPriorityButtons();
  }

  // 收起态让速记的日期框跟「当前查看日」保持一致，避免用户以为没记上
  function syncQuickDate() {
    if (!D['qa-date']) return;
    if (state.settings.widget.expanded) return;
    D['qa-date'].value = state.viewDay || state.today;
  }

  async function handleAdd(event) {
    if (event) event.preventDefault();
    var titleInput = D['qa-title'];
    var title = titleInput.value.trim();
    if (!title) {
      showToast('先写点内容吧');
      titleInput.focus();
      return;
    }

    var category = D['qa-category'].value || state.settings.categories[0] || '未分类';
    // 收起态速记默认记在「当前查看的那一天」，避免新任务无截止日而从挂件消失
    var due = D['qa-date'].value;
    if (!due && !state.settings.widget.expanded) due = state.viewDay || state.today;
    var task = TM.createTask({
      title: title,
      category: category,
      priority: state.addPriority,
      dueDate: due || null
    });
    if (!task) return;

    state.tasks.push(task);
    state.settings.lastCategory = category;

    titleInput.value = '';
    if (state.settings.widget.expanded) D['qa-date'].value = '';
    else syncQuickDate();
    state.addPriority = 'mid';
    renderPriorityButtons();

    renderTasks();
    renderWidget();
    await apiCall('saveTasks', null, state.tasks);
    await persistSettings();
    showToast('已记下');
    titleInput.focus();
  }

  /* ============ 渲染 · 任务列表 ============ */

  function renderFilterBar() {
    var bar = D['filter-bar'];
    if (!state.filterDate) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    D['filter-text'].textContent = '筛选：' + TM.formatDateCN(state.filterDate);
  }

  function setFilter(dateStr) {
    state.filterDate = dateStr || null;
    renderTasks();
    renderWidget();
  }

  function buildTaskRow(task) {
    var row = el('div', { class: 'task' + (task.done ? ' done' : '') });
    row.setAttribute('data-id', task.id);

    var check = el('button', { type: 'button', class: 'check' });
    check.setAttribute('aria-label', task.done ? '标记为未完成' : '标记完成');
    check.setAttribute('aria-pressed', String(!!task.done));
    check.addEventListener('click', function () { toggleTask(task.id); });

    var body = el('div', { class: 'body' });
    body.appendChild(el('div', { class: 't', text: task.title }));

    // 详细信息预览：只展示首行非空内容，完整内容在详情弹窗里看
    if (task.details && task.details.trim()) {
      var firstLine = task.details.split('\n').filter(function (l) { return l.trim(); })[0] || '';
      body.appendChild(el('div', { class: 'note', text: firstLine.replace(/^\s*·\s*/, '') }));
    }

    var meta = el('div', { class: 'meta' });
    meta.appendChild(el('span', { class: 'cat', text: task.category }));

    // 截止日：行内可直接改
    var dateInput = el('input', { type: 'date', class: 'date-mini' });
    dateInput.value = task.dueDate || '';
    dateInput.setAttribute('aria-label', '截止日期');
    if (TM.isOverdue(task, state.today)) dateInput.classList.add('overdue');
    dateInput.addEventListener('change', function () {
      updateTask(task.id, { dueDate: dateInput.value || null });
    });

    // 优先级：行内可直接改
    var prio = el('select', { class: 'prio-mini' });
    prio.setAttribute('aria-label', '优先级');
    prio.setAttribute('data-p', task.priority);
    TM.PRIORITIES.forEach(function (p) {
      var option = el('option', { value: p, text: TM.PRIORITY_LABEL[p] });
      if (p === task.priority) option.selected = true;
      prio.appendChild(option);
    });
    prio.addEventListener('change', function () {
      updateTask(task.id, { priority: prio.value });
    });

    meta.appendChild(dateInput);
    meta.appendChild(prio);
    body.appendChild(meta);

    var del = el('button', { type: 'button', class: 'del', text: '✕' });
    del.setAttribute('aria-label', '删除任务');
    del.addEventListener('click', function () { deleteTask(task.id); });

    var edit = el('button', { type: 'button', class: 'edit', text: '✎' });
    edit.setAttribute('aria-label', '编辑任务详情');
    edit.addEventListener('click', function () { openEditor(task.id); });

    row.appendChild(check);
    row.appendChild(body);
    row.appendChild(edit);
    row.appendChild(del);

    // 双击任务（非交互按钮区域）即打开详情编辑；保留 ✎ 按钮作为显式入口
    row.addEventListener('dblclick', function (event) {
      if (event.target.closest('.del, .edit, .check')) return;
      openEditor(task.id);
    });

    return row;
  }

  function renderTasks() {
    state.today = TM.todayString();
    renderHeader();          // 跨天时顺手把顶栏日期也刷新
    renderFilterBar();

    var list = state.tasks.filter(function (task) { return !task.deletedAt; });
    if (state.filterDate) {
      list = list.filter(function (task) { return task.dueDate === state.filterDate; });
    }

    var groups = TM.groupTasks(list, state.today);
    var wrap = D['task-groups'];
    clear(wrap);

    var shown = 0;
    GROUP_DEFS.forEach(function (def) {
      var items = groups[def.key] || [];
      if (!items.length) return;                 // 空分组不占地方
      items = def.key === 'done' ? TM.sortCompleted(items) : TM.sortTasks(items);
      shown += items.length;

      var group = el('div', { class: 'group' });
      group.appendChild(el('div', { class: 'group-head' }, [
        el('span', { class: 'mk ' + def.dot }),
        el('h2', { text: def.name }),
        el('span', { class: 'group-line' }),
        el('span', { class: 'group-count', text: String(items.length) })
      ]));
      items.forEach(function (task) { group.appendChild(buildTaskRow(task)); });
      wrap.appendChild(group);
    });

    if (!shown) {
      wrap.appendChild(el('p', {
        class: 'empty',
        text: state.filterDate ? '这一天没有任务' : '还没有任务，随手记一笔吧'
      }));
    }
  }

  function toggleTask(id) {
    var index = findIndex(id);
    if (index < 0) return;
    var task = state.tasks[index];
    // 完成时写入 completedOn（日报按它统计），不是 dueDate
    state.tasks[index] = task.done
      ? TM.uncompleteTask(task)
      : TM.completeTask(task, state.today);
    renderTasks();
    renderWidget();
    if (state.tab === 'daily') renderDailySummary();
    if (state.tab === 'weekly') renderWeekly();
    apiCall('saveTasks', null, state.tasks);
  }

  function updateTask(id, patch) {
    var index = findIndex(id);
    if (index < 0) return;
    var merged = TM.normalizeTask(Object.assign({}, state.tasks[index], patch));
    if (!merged) return;
    state.tasks[index] = merged;
    renderTasks();
    renderWidget();
    if (state.tab === 'weekly') renderWeekly();
    apiCall('saveTasks', null, state.tasks);
  }

  function deleteTask(id) {
    var index = findIndex(id);
    if (index < 0) return;
    var task = state.tasks[index];
    // 软删：保留墓碑行（deletedAt），让 SyncEngine 把删除同步到云端；UI 通过 deletedAt 过滤隐藏
    state.tasks = TM.deleteTask(state.tasks, id);
    renderTasks();
    renderWidget();
    if (state.tab === 'daily') renderDailySummary();
    if (state.tab === 'weekly') renderWeekly();
    apiCall('saveTasks', null, state.tasks);
    showToast('已删除「' + (task ? task.title : '') + '」');
  }

  /* ============ 任务详情编辑 ============ */

  function openEditor(id) {
    var index = findIndex(id);
    if (index < 0) return;
    var task = state.tasks[index];
    D['task-editor'].removeAttribute('data-new');   // 非新建流程

    var cat = D['te-category'];
    clear(cat);
    state.settings.categories.forEach(function (name) {
      cat.appendChild(el('option', { value: name, text: name }));
    });

    D['te-title'].value = task.title;
    D['te-category'].value = task.category;
    D['te-priority'].value = task.priority;
    D['te-date'].value = task.dueDate || '';
    // 有详情则展示；空白则预置一个圆点，省得每次自己打
    D['te-details'].value = (task.details && task.details.trim()) ? task.details : '· ';

    var len = D['te-details'].value.length;
    try { D['te-details'].setSelectionRange(len, len); } catch (e) { /* 某些浏览器对 setRangeText 不支持 */ }

    D['task-editor'].setAttribute('data-editing', id);
    D['task-editor'].hidden = false;
    D['te-title'].focus();
    D['te-title'].select();
  }

  function closeEditor() {
    // 新建草稿：若取消且尚未填写标题，直接丢弃
    if (D['task-editor'].getAttribute('data-new')) {
      var newId = D['task-editor'].getAttribute('data-editing');
      var idx = findIndex(newId);
      if (idx >= 0 && !state.tasks[idx].title.trim()) {
        state.tasks.splice(idx, 1);
        renderTasks();
        renderWidget();
        renderWidget();
      }
      D['task-editor'].removeAttribute('data-new');
    }
    D['task-editor'].hidden = true;
    D['task-editor'].removeAttribute('data-editing');
  }

  async function saveEditor() {
    var id = D['task-editor'].getAttribute('data-editing');
    if (!id) return;
    var title = D['te-title'].value.trim();
    if (!title) {
      showToast('标题不能为空');
      D['te-title'].focus();
      return;
    }
    var patch = {
      title: title,
      category: D['te-category'].value || state.settings.categories[0] || '未分类',
      priority: D['te-priority'].value,
      dueDate: D['te-date'].value || null,
      details: Editor.cleanDetails(D['te-details'].value)
    };
    state.tasks = TM.updateTask(state.tasks, id, patch);
    D['task-editor'].removeAttribute('data-new');
    closeEditor();
    renderTasks();
    renderWidget();
    if (state.tab === 'daily') renderDailySummary();
    if (state.tab === 'weekly') renderWeekly();
    await apiCall('saveTasks', null, state.tasks);
    showToast('已保存');
  }

  async function deleteFromEditor() {
    var id = D['task-editor'].getAttribute('data-editing');
    if (!id) return;
    closeEditor();
    deleteTask(id);
  }

  // 详情框：回车换行自动在行首加 “· ”
  function onDetailsKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    var ta = D['te-details'];
    var result = Editor.autoBulletOnEnter(ta.value, ta.selectionStart);
    ta.value = result.value;
    try { ta.setSelectionRange(result.caret, result.caret); } catch (e) { /* noop */ }
  }

  /* ============ 渲染 · 迷你月历（挂件唯一月历） ============ */

  function shiftMonth(delta) {
    var month = state.calMonth + delta;
    var year = state.calYear;
    if (month < 1) { month = 12; year -= 1; }
    if (month > 12) { month = 1; year += 1; }
    state.calMonth = month;
    state.calYear = year;
    renderWidget();
  }

  /* ============ 桌面挂件：迷你月历 + 今日任务 ============ */

  // 周一为首的 7 天（含 anchor 所在周）
  function weekDates(anchorStr) {
    var parts = String(anchorStr).split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var dow = (d.getDay() + 6) % 7; // 0=周一
    var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
    var out = [];
    for (var i = 0; i < 7; i++) {
      var x = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      out.push(x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate()));
    }
    return out;
  }

  function shiftWeek(delta) {
    var first = weekDates(state.weekAnchor)[0].split('-');
    var d = new Date(Number(first[0]), Number(first[1]) - 1, Number(first[2]));
    d.setDate(d.getDate() + delta * 7);
    state.weekAnchor = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    renderWidget();
  }

  // 周一起的 42 格（直接按周一为首生成，避免「行内旋转」在 1 号为周日时错位）
  function monthCellsMonFirst(year, month) {
    return (TM.monthGridMon ? TM.monthGridMon(year, month, state.today) : TM.monthGrid(year, month, state.today));
  }

  function renderWidgetCalendar() {
    var expanded = !!state.settings.widget.expanded;
    var grid = D['w-cal-grid'];
    if (!grid) return;
    if (D['w-calTitle']) {
      if (expanded) {
        D['w-calTitle'].textContent = state.calYear + ' 年 ' + state.calMonth + ' 月';
      } else {
        var wk = weekDates(state.weekAnchor);
        D['w-calTitle'].textContent = mmdd(wk[0]) + ' – ' + mmdd(wk[6]);
      }
    }
    clear(grid);

    var countsCache = {};
    function countsFor(dateStr) {
      var p = dateStr.split('-');
      var key = p[0] + '-' + p[1];
      if (!countsCache[key]) countsCache[key] = TM.countsByDate(state.tasks, Number(p[0]), Number(p[1]));
      return countsCache[key];
    }

    function buildCell(dateStr, opts) {
      var p = dateStr.split('-');
      var count = countsFor(dateStr)[dateStr] || 0;
      var cell = el('button', {
        type: 'button',
        class: 'w-cell' + (opts.muted ? ' muted' : '') + (opts.today ? ' today' : '') + (opts.sel ? ' sel' : '')
      });
      cell.textContent = opts.day;
      cell.setAttribute('aria-label',
        Number(p[1]) + '月' + Number(p[2]) + '日' + (count ? '，' + count + ' 项待办' : ''));
      if (count) cell.appendChild(el('span', { class: 'w-dot' }));
      cell.addEventListener('click', function () { onWidgetDayClick(dateStr); });
      cell.addEventListener('dblclick', function (event) { event.stopPropagation(); openNewTask(dateStr); });
      return cell;
    }

    if (expanded) {
      monthCellsMonFirst(state.calYear, state.calMonth).forEach(function (c) {
        grid.appendChild(buildCell(c.dateStr, {
          muted: !c.inMonth, today: c.isToday, sel: c.dateStr === state.filterDate, day: c.day
        }));
      });
    } else {
      weekDates(state.weekAnchor).forEach(function (dateStr) {
        var p = dateStr.split('-');
        grid.appendChild(buildCell(dateStr, {
          muted: false, today: dateStr === state.today, sel: dateStr === state.viewDay, day: Number(p[2])
        }));
      });
    }
  }

  function onWidgetDayClick(dateStr) {
    if (state.settings.widget.expanded) {
      // 展开态：点击相邻月灰格时自动跳到该月，再按日期筛选「任务」Tab
      var p = dateStr.split('-');
      state.calYear = Number(p[0]);
      state.calMonth = Number(p[1]);
      state.viewDay = dateStr;
      setFilter(dateStr === state.filterDate ? null : dateStr);
      if (state.tab !== 'task') switchTab('task');
    } else {
      // 收起态：就地切换下方列表到该天，不弹面板
      state.viewDay = dateStr;
      syncQuickDate();
      renderWidget();
    }
  }

  function renderWidgetToday() {
    var box = D['w-tlist'];
    if (!box) return;
    clear(box);
    var day = state.viewDay || state.today;
    var list = TM.sortTasks(state.tasks.filter(function (t) {
      return !t.done && !t.deletedAt && t.dueDate === day;
    }));
    if (D['w-todayLabel']) {
      D['w-todayLabel'].textContent = (day === state.today) ? '今日任务' : (mmdd(day) + ' ' + weekdayOf(day) + ' 任务');
    }
    D['w-todayCount'].textContent = list.length ? '(' + list.length + ')' : '';
    if (!list.length) {
      box.appendChild(el('p', { class: 'empty', text: (day === state.today) ? '今日暂无到期任务' : (mmdd(day) + ' 暂无到期任务') }));
      return;
    }
    list.forEach(function (task) {
      var row = el('div', { class: 'w-task' });
      row.appendChild(el('span', { class: 'dot ' + task.priority }));
      row.appendChild(el('span', { class: 'wt', text: task.title }));
      if (task.details && task.details.trim()) row.appendChild(el('span', { class: 'w-note', text: '📝' }));
      row.addEventListener('dblclick', function () { openEditor(task.id); });
      box.appendChild(row);
    });
  }

  function renderWidget() {
    renderWidgetCalendar();
    renderWidgetToday();
    fitWidgetHeight();
  }

  // 透明/模糊/穿透/展开 的视觉应用
  function applyWidgetStyle() {
    var w = state.settings.widget;
    var root = document.documentElement;
    root.style.setProperty('--w-opacity', String(w.opacity));
    root.style.setProperty('--w-blur', w.blur + 'px');
    document.body.classList.toggle('ct-mode', !!w.clickThrough);
    document.body.classList.toggle('expanded', !!w.expanded);
    if (D['w-ct']) {
      D['w-ct'].setAttribute('aria-pressed', String(!!w.clickThrough));
      D['w-ct'].textContent = w.clickThrough ? '👁' : '✋';
      D['w-ct'].title = w.clickThrough ? '鼠标穿透中（闲置壁纸态，仅手柄可拖）' : '当前可点击交互';
    }
    if (D['w-expand']) D['w-expand'].setAttribute('aria-pressed', String(!!w.expanded));
  }

  async function toggleExpand() {
    var next = !state.settings.widget.expanded;
    state.settings.widget.expanded = next;
    if (!next) state.weekAnchor = state.viewDay || state.today;
    // 展开：月历下沉到面板底部（任务列表之后），避免大月历压顶
    if (D['w-cal']) {
      if (next && D['panel-cal-slot']) D['panel-cal-slot'].appendChild(D['w-cal']);
      else if (!next && D['w-body']) D['w-body'].appendChild(D['w-cal']);
    }
    D['w-panel'].hidden = !next;
    applyWidgetStyle();
    applyClickThrough(state.settings.widget.clickThrough);
    if (next) { if (D['qa-date']) D['qa-date'].value = ''; }
    else syncQuickDate();
    renderWidget();
    // P1-#3：展开时把收起态选中的日期带入「任务」Tab 筛选，保持上下文连贯
    if (next && state.viewDay && state.viewDay !== state.today) {
      setFilter(state.viewDay);
      if (state.tab !== 'task') switchTab('task');
    }
    if (typeof bridge.setWidgetExpanded === 'function') {
      try { await bridge.setWidgetExpanded(next); } catch (e) { /* 忽略 */ }
    }
    await apiCall('saveSettings', null, state.settings);
  }

  async function toggleClickThrough() {
    var next = !state.settings.widget.clickThrough;
    state.settings.widget.clickThrough = next;
    applyWidgetStyle();
    applyClickThrough(next);
    await apiCall('saveSettings', null, state.settings);
  }

  // 2.5.1：OS 级鼠标穿透 + 命中手柄/按钮时临时恢复可交互
  var ctOsActive = false;
  var ctMoveHandler = null;
  function applyClickThrough(flag) {
    if (typeof bridge.setClickThrough !== 'function') return;
    if (ctMoveHandler) {
      document.removeEventListener('mousemove', ctMoveHandler, true);
      ctMoveHandler = null;
    }
    if (flag) {
      ctOsActive = true;
      bridge.setClickThrough(true);
      ctMoveHandler = function (e) {
        var interactive = e.target && e.target.closest &&
          e.target.closest('.w-handle, button, .modal, input, textarea, a[href], [role="button"]');
        var wantOs = !interactive; // 命中可交互元素则临时关闭穿透
        if (wantOs !== ctOsActive) {
          ctOsActive = wantOs;
          bridge.setClickThrough(wantOs);
        }
      };
      document.addEventListener('mousemove', ctMoveHandler, true);
    } else {
      ctOsActive = false;
      bridge.setClickThrough(false);
    }
  }

  // 2.5.1：按内容高度自适应窗口（临时放开 body 高度量出真实内容高度）
  function fitWidgetHeight() {
    if (typeof bridge.setHeight !== 'function' || !document.body) return;
    var body = document.body;
    var prev = body.style.height;
    body.style.height = 'auto';
    var h = body.scrollHeight;
    body.style.height = prev;
    if (h > 0) bridge.setHeight(h);
  }

  // 以某天为截止日新建任务（草稿态，取消且未填写则丢弃）
  function openNewTask(dueDate) {
    var t = {
      id: TM.makeId(),
      title: '',
      category: state.settings.lastCategory,
      priority: state.addPriority,
      dueDate: dueDate || null,
      details: '',
      done: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
      completedOn: null
    };
    state.tasks.push(t);
    openEditor(t.id);
    D['task-editor'].setAttribute('data-new', '1');   // 须在 openEditor 之后（它会先清掉该标记）
  }

  /* ============ 渲染 · 日报 ============ */

  var dailyTimer = null;
  var dailyDirty = false;
  var dailyHintTimer = null;

  function setSaveHint(node, text, saved) {
    node.textContent = text;
    node.classList.toggle('saved', !!saved);
  }

  function renderDailySummary() {
    var data = RP.buildDaily(state.tasks, state.logs[state.dailyDate], state.dailyDate);
    D['daily-total'].textContent = String(data.total);
    D['daily-ai'].textContent = RP.buildDailySummary(state.tasks, state.logs[state.dailyDate], state.dailyDate);

    var box = D['daily-summary'];
    clear(box);

    if (!data.completedByCategory.length) {
      box.appendChild(el('p', { class: 'empty', text: '今天还没有完成的任务' }));
      return;
    }
    data.completedByCategory.forEach(function (group) {
      group.tasks.forEach(function (task) {
        box.appendChild(el('div', { class: 'sum-line' }, [
          el('span', { class: 'sum-dot', text: '·' }),
          el('span', { class: 'sum-cat', text: '[' + group.category + ']' }),
          el('span', { class: 'sum-title', text: task.title })
        ]));
      });
    });
  }

  function renderDaily() {
    D['daily-label'].textContent = dateLongCN(state.dailyDate);
    var entry = state.logs[state.dailyDate] || {};

    // 正在输入的框不回写，避免光标跳动
    if (document.activeElement !== D['daily-progress']) D['daily-progress'].value = entry.progress || '';
    if (document.activeElement !== D['daily-issues']) D['daily-issues'].value = entry.issues || '';
    if (document.activeElement !== D['daily-plan']) D['daily-plan'].value = entry.plan || '';

    renderDailySummary();
    setSaveHint(D['daily-hint'], '输入后自动保存', false);
  }

  function scheduleDailySave() {
    dailyDirty = true;
    if (dailyTimer) clearTimeout(dailyTimer);
    dailyTimer = setTimeout(function () {
      dailyTimer = null;
      flushDailySave();
    }, 600);
  }

  async function flushDailySave() {
    if (dailyTimer) {
      clearTimeout(dailyTimer);
      dailyTimer = null;
    }
    if (!dailyDirty) return;
    dailyDirty = false;

    var date = state.dailyDate;
    var entry = {
      date: date,
      progress: D['daily-progress'].value,
      issues: D['daily-issues'].value,
      plan: D['daily-plan'].value,
      updatedAt: new Date().toISOString()
    };

    // 三栏全空且此前没有记录 -> 不制造空日志
    var blank = !entry.progress.trim() && !entry.issues.trim() && !entry.plan.trim();
    if (blank && !state.logs[date]) return;

    state.logs[date] = entry;
    await apiCall('saveLogs', null, state.logs);

    setSaveHint(D['daily-hint'], '已自动保存', true);
    if (dailyHintTimer) clearTimeout(dailyHintTimer);
    dailyHintTimer = setTimeout(function () {
      setSaveHint(D['daily-hint'], '输入后自动保存', false);
      dailyHintTimer = null;
    }, 2000);
  }

  async function goDaily(dateStr) {
    if (!dateStr || dateStr === state.dailyDate) return;
    await flushDailySave();
    state.dailyDate = dateStr;
    renderDaily();
  }

  async function copyDaily() {
    await flushDailySave();
    try {
      var data = RP.buildDaily(state.tasks, state.logs[state.dailyDate], state.dailyDate);
      var summary = RP.buildDailySummary(state.tasks, state.logs[state.dailyDate], state.dailyDate);
      await copyText(summary + '\n\n' + RP.formatDaily(data), '已复制日报');
    } catch (err) {
      console.error('[光影] 生成日报失败', err);
      showToast('生成日报失败', 'error');
    }
  }

  /* ============ 渲染 · 周报 ============ */

  var weeklyTimer = null;
  var weeklyDirty = false;

  function renderWeekly() {
    var start = state.weekStart || RP.weekStartOf(TM.todayString());
    state.weekStart = start;

    var key = RP.isoWeekKey(start);
    var plans = state.settings.weeklyPlans || {};
    var override = typeof plans[key] === 'string' ? plans[key] : '';
    var data = RP.buildWeekly(state.tasks, state.logs, start, override);

    D['weekly-label'].textContent = data.weekKey + ' · ' + data.rangeText;
    D['weekly-total'].textContent = String(data.total);
    D['weekly-ai'].textContent = RP.buildWeeklySummary(state.tasks, state.logs, start, override);

    // 一、本周完成
    var doneBox = D['weekly-completed'];
    clear(doneBox);
    if (!data.completedByCategory.length) {
      doneBox.appendChild(el('p', { class: 'empty', text: '本周还没有完成的任务' }));
    } else {
      data.completedByCategory.forEach(function (group) {
        var block = el('div', { class: 'wk-group' });
        block.appendChild(el('div', { class: 'wk-cat' }, [
          el('span', { text: group.category }),
          el('span', { class: 'n', text: group.tasks.length + ' 项' })
        ]));
        group.tasks.forEach(function (task) {
          block.appendChild(el('div', { class: 'wk-item', text: task.title }));
        });
        doneBox.appendChild(block);
      });
    }

    // 二、本周进展
    var progressBox = D['weekly-progress'];
    clear(progressBox);
    if (!data.progress.length) {
      progressBox.appendChild(el('p', { class: 'empty', text: '这一周没有填写进展' }));
    } else {
      data.progress.forEach(function (item) {
        progressBox.appendChild(el('div', { class: 'wk-entry' }, [
          el('span', { class: 'wk-date', text: '【' + mmdd(item.date) + '】' }),
          item.text
        ]));
      });
    }

    // 三、问题与风险
    var issuesBox = D['weekly-issues'];
    clear(issuesBox);
    if (!data.issues.length) {
      issuesBox.appendChild(el('p', { class: 'empty', text: '这一周没有记录问题' }));
    } else {
      data.issues.forEach(function (item) {
        issuesBox.appendChild(el('div', { class: 'wk-entry' }, [
          el('span', { class: 'wk-date', text: '【' + mmdd(item.date) + '】' }),
          item.text
        ]));
      });
    }

    // 四、下周计划（预填最后一天的「明日计划」，可改）
    if (document.activeElement !== D['weekly-plan']) {
      D['weekly-plan'].value = data.nextPlan || '';
    }

    // 五、数据概览
    var overview = D['weekly-overview'];
    clear(overview);
    overview.appendChild(el('div', { class: 'ov-total' }, [
      el('span', { class: 'n', text: String(data.total) }),
      el('span', { class: 'l', text: '项完成' })
    ]));

    if (!data.distribution.length) {
      overview.appendChild(el('p', { class: 'empty', text: '这一周还没有完成记录' }));
    } else {
      var max = data.distribution.reduce(function (m, item) { return Math.max(m, item.count); }, 1);
      data.distribution.forEach(function (item) {
        var row = el('div', { class: 'dist-row' });
        row.appendChild(el('span', { class: 'name', text: item.category }));
        var bar = el('div', { class: 'dist-bar' });
        var fill = el('i');
        fill.style.width = Math.round((item.count / max) * 100) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el('span', { class: 'num', text: String(item.count) }));
        overview.appendChild(row);
      });
    }
  }

  function scheduleWeeklyPlanSave() {
    weeklyDirty = true;
    if (weeklyTimer) clearTimeout(weeklyTimer);
    weeklyTimer = setTimeout(function () {
      weeklyTimer = null;
      flushWeeklyPlan();
    }, 600);
  }

  async function flushWeeklyPlan() {
    if (weeklyTimer) {
      clearTimeout(weeklyTimer);
      weeklyTimer = null;
    }
    if (!weeklyDirty) return;
    weeklyDirty = false;

    var key = RP.isoWeekKey(state.weekStart);
    if (!state.settings.weeklyPlans || typeof state.settings.weeklyPlans !== 'object') {
      state.settings.weeklyPlans = {};
    }
    state.settings.weeklyPlans[key] = D['weekly-plan'].value;
    await persistSettings();
    setSaveHint(D['weekly-hint'], '已保存', true);
    setTimeout(function () { setSaveHint(D['weekly-hint'], '计划改动自动保存', false); }, 2000);
  }

  async function goWeek(delta) {
    await flushWeeklyPlan();
    state.weekStart = RP.addDays(state.weekStart, delta);
    renderWeekly();
  }

  async function copyWeekly() {
    await flushWeeklyPlan();
    try {
      var key = RP.isoWeekKey(state.weekStart);
      var plans = state.settings.weeklyPlans || {};
      var override = typeof plans[key] === 'string' ? plans[key] : '';
      var data = RP.buildWeekly(state.tasks, state.logs, state.weekStart, override);
      var summary = RP.buildWeeklySummary(state.tasks, state.logs, state.weekStart, override);
      await copyText(summary + '\n\n' + RP.formatWeekly(data), '已复制周报');
    } catch (err) {
      console.error('[光影] 生成周报失败', err);
      showToast('生成周报失败', 'error');
    }
  }

  /* ============ 设置弹窗 ============ */

  function renderSettings() {
    var settings = state.settings;

    var chips = D['cat-chips'];
    clear(chips);
    settings.categories.forEach(function (name) {
      var chip = el('span', { class: 'cat-chip' }, [name]);
      var btn = el('button', { type: 'button', text: '✕' });
      btn.setAttribute('aria-label', '删除分类 ' + name);
      btn.addEventListener('click', function () { removeCategory(name); });
      chip.appendChild(btn);
      chips.appendChild(chip);
    });

    D['set-launch'].checked = !!settings.launchAtLogin;
    D['set-tray'].checked = !!settings.closeToTray;
    D['set-hotkey'].value = settings.hotkey || 'Ctrl+Shift+Space';
    if (D['set-opacity']) {
      D['set-opacity'].value = settings.widget.opacity;
      if (D['set-opacity-val']) D['set-opacity-val'].textContent = Math.round(settings.widget.opacity * 100) + '%';
    }
    renderAccountArea();
  }

  // ---------- 账号与同步（v3.0） ----------
  var accMode = 'login';

  function renderAccountArea() {
    if (!D['acc-server']) return;
    if (state.settings.serverUrl) D['acc-server'].value = state.settings.serverUrl;
    var logged = !!(state.account && state.account.email);
    D['acc-status'].textContent = logged ? ('已登录：' + state.account.email) : '未登录';
    D['acc-form'].hidden = logged;
    D['acc-logout-row'].hidden = !logged;
    D['acc-submit'].textContent = accMode === 'register' ? '注册' : '登录';
    D['acc-confirm-row'].hidden = accMode !== 'register';
    D['acc-toggle'].textContent = accMode === 'register' ? '已有账号？登录' : '没有账号？注册';
    updateSyncIndicator();
  }

  function updateSyncIndicator() {
    var btn = D['w-sync'];
    if (!btn) return;
    var logged = !!(state.account && state.account.email);
    btn.classList.toggle('is-on', logged);
    btn.title = logged ? ('已登录：' + state.account.email + '（点击设置）') : '账号与同步';
  }

  function emailOk(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || ''); }

  async function handleAuthSubmit() {
    var serverUrl = (D['acc-server'].value || '').trim();
    var email = (D['acc-email'].value || '').trim();
    var password = D['acc-password'].value || '';
    var confirm = D['acc-confirm'].value || '';
    if (!serverUrl) { showToast('请填写服务器地址', 'error'); return; }
    if (!emailOk(email)) { showToast('邮箱格式不正确', 'error'); return; }
    if (!password) { showToast('请输入密码', 'error'); return; }
    if (accMode === 'register') {
      if (password.length < 6) { showToast('密码至少 6 位', 'error'); return; }
      if (password !== confirm) { showToast('两次密码不一致', 'error'); return; }
    }
    state.settings.serverUrl = serverUrl;
    await persistSettings();
    D['acc-submit'].disabled = true;
    try {
      var method = accMode === 'register' ? 'authRegister' : 'authLogin';
      var result = await apiCall(method, { ok: false }, { email: email, password: password, serverUrl: serverUrl });
      if (result && result.ok) {
        state.account = { email: result.email };
        renderAccountArea();
        showToast(accMode === 'register' ? '注册成功，已登录' : '已登录 ' + result.email, 'ok');
        D['acc-password'].value = '';
        D['acc-confirm'].value = '';
      } else {
        showToast((result && result.error) || '操作失败', 'error');
      }
    } finally {
      D['acc-submit'].disabled = false;
    }
  }

  function switchAccMode() {
    accMode = accMode === 'login' ? 'register' : 'login';
    renderAccountArea();
    D['acc-password'].value = '';
    D['acc-confirm'].value = '';
    if (D['acc-email']) D['acc-email'].focus();
  }

  async function handleForgot() {
    var serverUrl = (D['acc-server'].value || '').trim();
    var email = (D['acc-email'].value || '').trim();
    if (!serverUrl) { showToast('请填写服务器地址', 'error'); return; }
    if (!emailOk(email)) { showToast('邮箱格式不正确', 'error'); return; }
    var result = await apiCall('authForgot', { ok: false }, { email: email, serverUrl: serverUrl });
    if (result && result.ok) showToast('若邮箱存在，重置链接已发送到邮箱', 'ok');
    else showToast((result && result.error) || '请求失败', 'error');
  }

  async function handleLogout() {
    var result = await apiCall('authLogout', { ok: false });
    if (result && result.ok) {
      state.account = null;
      renderAccountArea();
      showToast('已退出登录');
    } else {
      showToast('退出失败', 'error');
    }
  }

  function openSettings() {
    renderSettings();
    D['settings-modal'].hidden = false;
    D['cat-input'].value = '';
    D['settings-close'].focus();
  }

  function closeSettings() {
    D['settings-modal'].hidden = true;
    if (D['w-settings']) D['w-settings'].focus();
  }

  async function addCategory() {
    var input = D['cat-input'];
    var name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    if (state.settings.categories.indexOf(name) >= 0) {
      showToast('这个分类已经存在');
      input.select();
      return;
    }
    state.settings.categories.push(name);
    input.value = '';
    await persistSettings();
    renderSettings();
    renderCategorySelect();
    showToast('已添加分类「' + name + '」');
    input.focus();
  }

  async function removeCategory(name) {
    if (state.settings.categories.length <= 1) {
      showToast('至少保留一个分类');
      return;
    }
    state.settings.categories = state.settings.categories.filter(function (c) { return c !== name; });
    if (state.settings.lastCategory === name) {
      state.settings.lastCategory = state.settings.categories[0];
    }
    await persistSettings();
    renderSettings();
    renderCategorySelect();
    showToast('已删除分类「' + name + '」');
  }

  // 修改全局快捷键：主进程注册失败会回退默认键，这里按实际生效值回写输入框
  async function applyHotkey(rawValue) {
    var value = String(rawValue || '').trim();
    var current = state.settings.hotkey || DEFAULT_SETTINGS.hotkey;
    if (!value || value === current) {
      D['set-hotkey'].value = current;
      return;
    }
    var result = await apiCall('setHotkey', { key: current, ok: false }, value);
    var applied = result && typeof result.key === 'string' ? result.key : current;
    state.settings.hotkey = applied;
    D['set-hotkey'].value = applied;
    if (result && result.ok) showToast('快捷键已更新：' + applied, 'ok');
    else showToast('该组合键无效或被占用，已退回 ' + applied, 'error');
  }

  /* ============ 事件绑定 ============ */

  function bindEvents() {
    // 速记
    D['quickadd'].addEventListener('submit', handleAdd);
    D['qa-priority'].addEventListener('click', onPriorityClick);
    D['qa-category'].addEventListener('change', function () {
      state.settings.lastCategory = D['qa-category'].value;
      persistSettings();
    });

    // Tab
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });
    D.tabs.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      var order = tabs.map(function (b) { return b.getAttribute('data-tab'); });
      var current = order.indexOf(state.tab);
      var next = (current + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length;
      switchTab(order[next]);
      tabs[next].focus();
    });

    // 顶栏（已并入手柄：置顶按钮随 app-head 移除，挂件默认常驻最前）

    // 任务详情编辑弹窗
    D['te-save'].addEventListener('click', saveEditor);
    D['te-cancel'].addEventListener('click', closeEditor);
    D['te-close'].addEventListener('click', closeEditor);
    D['te-backdrop'].addEventListener('click', closeEditor);
    D['te-delete'].addEventListener('click', deleteFromEditor);
    D['te-details'].addEventListener('keydown', onDetailsKeydown);
    D['te-title'].addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveEditor();
      }
    });

    // 桌面挂件：手柄控件
    D['w-ct'].addEventListener('click', toggleClickThrough);
    D['w-expand'].addEventListener('click', toggleExpand);
    D['w-hide'].addEventListener('click', function () {
      if (typeof bridge.hideWindow === 'function') { try { bridge.hideWindow(); } catch (e) { /* 忽略 */ } }
      // P2-#12：明确告知「还在跑，只是收进托盘」
      showToast('已隐藏到托盘，点托盘图标可唤回');
    });
    D['w-quit'].addEventListener('click', function () {
      if (!window.confirm('确定退出 光影工作志？')) return;
      if (typeof bridge.quit === 'function') { try { bridge.quit(); } catch (e) { /* 忽略 */ } }
    });
    D['w-settings'].addEventListener('click', openSettings);
    if (D['w-sync']) D['w-sync'].addEventListener('click', function () {
      openSettings();
      if (D['acc-server']) D['acc-server'].focus();
    });
    if (D['acc-submit']) D['acc-submit'].addEventListener('click', handleAuthSubmit);
    if (D['acc-toggle']) D['acc-toggle'].addEventListener('click', switchAccMode);
    if (D['acc-forgot']) D['acc-forgot'].addEventListener('click', handleForgot);
    if (D['acc-logout']) D['acc-logout'].addEventListener('click', handleLogout);
    D['w-prev'].addEventListener('click', function () {
      if (state.settings.widget.expanded) shiftMonth(-1); else shiftWeek(-1);
    });
    D['w-next'].addEventListener('click', function () {
      if (state.settings.widget.expanded) shiftMonth(1); else shiftWeek(1);
    });
    // P2-#13：回到今天（展开态回本月、收起态回本周，并选中今天）
    D['w-today'].addEventListener('click', function () {
      var today = TM.todayString();
      var parts = today.split('-');
      state.today = today;
      state.calYear = Number(parts[0]);
      state.calMonth = Number(parts[1]);
      state.weekAnchor = today;
      state.viewDay = today;
      syncQuickDate();
      renderWidget();
    });

    // 筛选
    D['filter-clear'].addEventListener('click', function () { setFilter(null); });

    // 月历（任务 Tab 内的旧月历已移除，单一月历即挂件主区月历）

    // 日报
    D['daily-prev'].addEventListener('click', function () { goDaily(RP.addDays(state.dailyDate, -1)); });
    D['daily-next'].addEventListener('click', function () { goDaily(RP.addDays(state.dailyDate, 1)); });
    D['daily-today'].addEventListener('click', function () { goDaily(TM.todayString()); });
    D['daily-copy'].addEventListener('click', copyDaily);
    [D['daily-progress'], D['daily-issues'], D['daily-plan']].forEach(function (box) {
      box.addEventListener('input', scheduleDailySave);
      box.addEventListener('blur', function () { flushDailySave(); });
    });

    // 周报
    D['weekly-prev'].addEventListener('click', function () { goWeek(-7); });
    D['weekly-next'].addEventListener('click', function () { goWeek(7); });
    D['weekly-this'].addEventListener('click', async function () {
      await flushWeeklyPlan();
      state.weekStart = RP.weekStartOf(TM.todayString());
      renderWeekly();
    });
    D['weekly-copy'].addEventListener('click', copyWeekly);
    D['weekly-plan'].addEventListener('input', scheduleWeeklyPlanSave);
    D['weekly-plan'].addEventListener('blur', function () { flushWeeklyPlan(); });

    // 设置
    D['settings-close'].addEventListener('click', closeSettings);
    D['settings-backdrop'].addEventListener('click', closeSettings);
    D['cat-add'].addEventListener('click', addCategory);
    D['cat-input'].addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        addCategory();
      }
    });

    D['set-launch'].addEventListener('change', function () {
      var next = this.checked;
      state.settings.launchAtLogin = next;
      apiCall('setLaunchAtLogin', null, next);
      persistSettings();
    });
    D['set-tray'].addEventListener('change', function () {
      patchSettings({ closeToTray: this.checked });
    });
    if (D['set-opacity']) {
      D['set-opacity'].addEventListener('input', function () {
        var v = parseFloat(this.value);
        if (!(v > 0)) v = 0.55;
        state.settings.widget.opacity = v;
        if (D['set-opacity-val']) D['set-opacity-val'].textContent = Math.round(v * 100) + '%';
        applyWidgetStyle();
      });
      D['set-opacity'].addEventListener('change', function () {
        apiCall('saveSettings', null, state.settings);
      });
    }
    var hotkeyInput = D['set-hotkey'];
    hotkeyInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyHotkey(this.value);
      }
    });
    hotkeyInput.addEventListener('blur', function () { applyHotkey(this.value); });
    D['btn-quit'].addEventListener('click', function () {
      if (!window.confirm('确定退出 光影工作志？')) return;
      apiCall('quit', null);
    });
    D['set-reset-pos'].addEventListener('click', async function () {
      if (typeof bridge.resetWidgetPosition === 'function') {
        try { await bridge.resetWidgetPosition(); } catch (e) { /* 忽略 */ }
      }
      showToast('已复位挂件位置');
    });

    // Esc 关弹窗
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!D['task-editor'].hidden) {
        closeEditor();
      } else if (!D['settings-modal'].hidden) {
        closeSettings();
      }
    });

    // 离开前尽量落盘
    window.addEventListener('blur', function () {
      flushDailySave();
      flushWeeklyPlan();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        flushDailySave();
        flushWeeklyPlan();
      }
    });
  }

  /* ============ 启动 ============ */

  function cacheDom() {
    [
      'view-task', 'view-daily', 'view-weekly', 'app-main',
      'quickadd', 'qa-title', 'qa-category', 'qa-date', 'qa-priority',
      'filter-bar', 'filter-text', 'filter-clear',
      'task-groups',
      'daily-prev', 'daily-next', 'daily-today', 'daily-label',
      'daily-total', 'daily-summary', 'daily-ai', 'daily-progress', 'daily-issues', 'daily-plan',
      'daily-copy', 'daily-hint',
      'weekly-prev', 'weekly-next', 'weekly-this', 'weekly-label', 'weekly-total',
      'weekly-completed', 'weekly-progress', 'weekly-issues', 'weekly-plan',
      'weekly-overview', 'weekly-ai', 'weekly-copy', 'weekly-hint',
      'settings-modal', 'settings-close', 'settings-backdrop', 'settings-title',
      'cat-chips', 'cat-input', 'cat-add',
      'task-editor', 'te-title', 'te-category', 'te-priority', 'te-date', 'te-details',
      'te-save', 'te-cancel', 'te-delete', 'te-close', 'te-backdrop',
      'w-handle', 'w-clock', 'w-ct', 'w-expand', 'w-hide', 'w-quit', 'w-settings',
      'w-body', 'w-cal', 'panel-cal-slot', 'w-calTitle', 'w-prev', 'w-next', 'w-today', 'w-cal-grid', 'w-todayLabel',
      'w-todayCount', 'w-tlist', 'w-panel',
      'set-launch', 'set-tray', 'set-hotkey', 'set-reset-pos', 'set-opacity', 'set-opacity-val', 'btn-quit', 'toast',
      'w-sync',
      'acc-block', 'acc-server', 'acc-status', 'acc-form', 'acc-email', 'acc-password',
      'acc-confirm', 'acc-confirm-row', 'acc-submit', 'acc-toggle', 'acc-forgot',
      'acc-logout', 'acc-logout-row'
    ].forEach(function (id) {
      D[id] = $(id);
    });

    tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    sections = {
      task: D['view-task'],
      daily: D['view-daily'],
      weekly: D['view-weekly']
    };
    D.tabs = document.querySelector('.tabs');
  }

  function initDates() {
    state.today = TM.todayString();
    var parts = state.today.split('-');
    state.calYear = Number(parts[0]);
    state.calMonth = Number(parts[1]);
    state.viewDay = state.today;
    state.weekAnchor = state.today;
    state.dailyDate = state.today;
    state.weekStart = RP.weekStartOf(state.today);
  }

  function normalizeTasks(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(TM.normalizeTask).filter(Boolean);
  }

  async function loadAll() {
    var results = await Promise.all([
      apiCall('loadSettings', null),
      apiCall('loadTasks', null),
      apiCall('loadLogs', null)
    ]);

    state.settings = mergeSettings(results[0]);
    state.account = (state.settings && state.settings.account) || null;
    state.tasks = normalizeTasks(results[1]);
    state.logs = results[2] && typeof results[2] === 'object' && !Array.isArray(results[2])
      ? results[2]
      : {};

    // 分类兜底：lastCategory 必须落在枚举内
    if (state.settings.categories.indexOf(state.settings.lastCategory) < 0) {
      state.settings.lastCategory = state.settings.categories[0];
    }
  }

  function subscribeBridge() {
    if (typeof bridge.onRefresh === 'function') {
      bridge.onRefresh(async function () {
        try {
          state.tasks = normalizeTasks(await apiCall('loadTasks', state.tasks));
          state.today = TM.todayString();
          renderHeader();
          renderTasks();
          renderWidget();
          if (state.tab === 'daily') renderDailySummary();
          if (state.tab === 'weekly') renderWeekly();
        } catch (err) {
          console.error('[光影] 刷新失败', err);
        }
      });
    }
    if (typeof bridge.onOpenTab === 'function') {
      bridge.onOpenTab(function (tab) {
        if (typeof tab === 'string') switchTab(tab);
      });
    }
  }

  async function init() {
    cacheDom();
    initDates();
    await loadAll();

    bindEvents();
    subscribeBridge();

    renderHeader();
    startClock();
    renderPinButton();
    renderCategorySelect();
    renderPriorityButtons();
    renderTasks();
    renderWidget();
    renderDaily();
    renderWeekly();
    renderSettings();
    updateSyncIndicator();
    applyTabUI();

    // 桌面挂件：应用形态（透明/穿透/折叠）+ 初次渲染迷你月历与今日任务
    applyWidgetStyle();
    applyClickThrough(state.settings.widget.clickThrough);
    D['w-panel'].hidden = !state.settings.widget.expanded;
    // 若以展开态启动，月历应已在面板底部，避免被隐藏的挂件主区带走
    if (state.settings.widget.expanded && D['w-cal'] && D['panel-cal-slot']) {
      D['panel-cal-slot'].appendChild(D['w-cal']);
    }
    syncQuickDate();
    renderWidget();

    // P0-#1：若当前处于「穿透（壁纸）态」，给一次提示，避免「点不动以为坏了」
    if (state.settings.widget.clickThrough) {
      showToast('当前为穿透（壁纸）态：点手柄 👁 切回可交互', 'ok');
    }

    // 让入场动画在首屏渲染后启动
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { document.body.classList.add('ready'); });
    });

    // 主进程若未在启动时恢复置顶状态，这里补一次（失败也不影响使用）
    if (state.settings.alwaysOnTop) apiCall('setAlwaysOnTop', null, true);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
