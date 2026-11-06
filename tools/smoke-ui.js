// 打包版 UI 回归烟测：启动 dist/win-unpacked 程序，经 CDP 验证首屏渲染完整性。
// 用法：npm run dist && npm run smoke
// 不改动用户磁盘文件；通过应用自身 IPC 临时写入一条任务，结束后恢复。
'use strict';

const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const PORT = Number(process.env.SMOKE_PORT || 9347);
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', '光影工作志.exe');
const TASK = {
  id: 'smoke-ui-task',
  title: 'UI 冒烟任务',
  category: '工作',
  priority: 'mid',
  dueDate: null,
  details: '',
  done: false,
  createdAt: new Date().toISOString(),
  completedAt: null,
  completedOn: null,
  updatedAt: Date.now(),
  deletedAt: null
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) break;
    } catch (e) { /* 端口未就绪 */ }
  }
  if (!page) throw new Error('CDP 页面未就绪（请先执行 npm run dist）');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('异常: ' + m.params.exceptionDetails.text);
    }
  });
  const send = (method, params) => new Promise((resolve) => {
    id++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression: expression, awaitPromise: true, returnByValue: true
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ws: ws, send: send, ev: ev, consoleErrors: consoleErrors };
}

async function main() {
  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], {
    stdio: 'ignore', windowsHide: true
  });
  let session = null;
  let origTasks = '[]';
  let origSettings = '{}';
  const results = {};

  try {
    session = await connect();
    const { send, ev, consoleErrors } = session;
    await send('Runtime.enable');
    await send('Page.enable');
    // 每次文档加载前注入错误收集：unhandledrejection 不会被 Runtime.exceptionThrown 捕获
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: [
        'window.__smokeErrors = [];',
        "window.addEventListener('error', function (e) { window.__smokeErrors.push('error: ' + e.message); });",
        "window.addEventListener('unhandledrejection', function (e) {",
        "  var r = e.reason; window.__smokeErrors.push('rejection: ' + (r && r.message ? r.message : String(r)));",
        '});'
      ].join('\n')
    });
    await sleep(1200);

    origTasks = await ev('window.api.loadTasks().then(function (t) { return JSON.stringify(t || []); })');
    origSettings = await ev('window.api.loadSettings().then(function (s) { return JSON.stringify(s || {}); })');
    await ev('window.api.saveTasks([' + JSON.stringify(TASK) + ']).then(function () { return true; })');
    // 预置一个非默认字号，验证渲染端合并器不会在重启后把它丢掉
    await ev("(async function(){var s=await window.api.loadSettings();s.widget=s.widget||{};s.widget.scale=1.25;s.widget.expanded=false;await window.api.saveSettings(s);return true;})()");
    await send('Page.reload', { ignoreCache: true });
    // 等新文档 init 落地，而不是固定 sleep（隐藏窗口下 rAF 可能被节流）
    for (let i = 0; i < 24; i++) {
      await sleep(300);
      const done = await ev("document.readyState === 'complete' && !!document.getElementById('cat-chips')");
      if (done) break;
    }
    await sleep(600);

    console.log('诊断:', await ev("JSON.stringify({readyState:document.readyState, bodyClass:document.body.className, taskRows:document.querySelectorAll('#task-groups .task').length, chips:document.querySelectorAll('#cat-chips > *').length, initErr:document.querySelectorAll('.init-error').length, errs:window.__smokeErrors})"));

    results['init 执行完整（body.ready 已添加）'] =
      await ev("document.body.classList.contains('ready')");
    results['有任务时任务列表正常渲染'] =
      await ev("document.querySelectorAll('#task-groups .task').length >= 1");
    results['行内截止日触发器已挂载'] =
      await ev("document.querySelectorAll('#task-groups .task .date-trigger').length >= 1");
    results['首屏 reveal 内容可见（未停在 opacity:0）'] =
      await ev("(function(){var n=document.querySelector('.reveal');return !n || getComputedStyle(n).opacity==='1';})()");
    results['设置页已渲染（分类 chips 非空）'] =
      await ev("document.querySelectorAll('#cat-chips > *').length >= 1");
    results['Markdown 渲染在打包版可用'] =
      await ev("window.api.renderMarkdown('**粗体**').indexOf('<strong>') >= 0");
    results['无未捕获异常 / unhandledrejection'] =
      await ev('window.__smokeErrors.length === 0');
    const injected = await ev('window.__smokeErrors');
    if (Array.isArray(injected) && injected.length) console.log('页面异常:', injected.join(' | '));
    results['设置字段保留：字号缩放重启后不回退'] =
      await ev("document.getElementById('set-scale').value === '1.25'");
    results['手柄有日报/周报快捷入口'] =
      await ev("!!document.getElementById('w-daily') && !!document.getElementById('w-weekly')");
    results['手柄新增入口后无横向溢出'] =
      await ev("(function(){var h=document.getElementById('w-handle');return h.scrollWidth <= h.clientWidth + 1;})()");
    results['收起态速记条默认单行'] =
      await ev("getComputedStyle(document.querySelector('.qa-controls')).display === 'none'");
    await ev("document.getElementById('qa-title').focus(); true");
    results['聚焦速记框后控件展开'] =
      await ev("getComputedStyle(document.querySelector('.qa-controls')).display !== 'none'");
    await ev("document.getElementById('w-daily') && document.getElementById('w-daily').click(); true");
    await sleep(800);
    results['日报快捷入口一键展开并切 Tab'] =
      await ev("!document.getElementById('w-panel').hidden && document.getElementById('tab-daily').getAttribute('aria-selected') === 'true'");
    await ev("document.querySelector('#task-groups .task .del').click(); true");
    await sleep(500);
    results['删除后提供撤销入口'] = await ev("!!document.querySelector('.toast-action')");
    await ev("document.querySelector('.toast-action') && document.querySelector('.toast-action').click(); true");
    await sleep(700);
    results['撤销后任务恢复'] = await ev("document.querySelectorAll('#task-groups .task').length >= 1");
    await ev("window.api.openTab('weekly').then(function () { return true; })");
    await sleep(700);
    results['外部跳转周报自动展开并切换'] =
      await ev("!document.getElementById('w-panel').hidden && document.getElementById('tab-weekly').getAttribute('aria-selected') === 'true'");
    results['无 console.error'] = consoleErrors.length === 0;
    if (consoleErrors.length) console.log('控制台错误:', consoleErrors.join(' | '));
  } finally {
    if (session) {
      try {
        await session.ev('window.api.saveTasks(' + origTasks + ').then(function () { return true; })');
        await session.ev('window.api.saveSettings(' + origSettings + ').then(function () { return true; })');
      } catch (e) { /* 页面可能已卸载 */ }
      try { session.ws.close(); } catch (e) { /* 忽略 */ }
    }
    try { execSync('taskkill /pid ' + child.pid + ' /t /f', { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
  }

  Object.keys(results).forEach((k) => console.log((results[k] ? 'PASS ' : 'FAIL ') + k));
  const ok = Object.keys(results).every((k) => results[k]);
  console.log(ok ? 'UI 烟测通过' : 'UI 烟测失败');
  return ok;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => {
  console.error('UI 烟测异常:', e && e.message);
  process.exit(1);
});
